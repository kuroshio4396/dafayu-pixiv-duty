#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
px_client.py —— Pixiv App API 的鉴权 / 限流 / 重试 / 错误码
============================================================================
三条硬约束（都是踩出来的）：

① **refresh_token 每次刷新都会轮换**，旧值立即失效。所以每次调用后都要比对
   `api.refresh_token` 与文件里的值，变了就原子落盘；并且刷新前后加文件锁，
   防止宿主半端与 headless 子进程同时刷新、互相作废。

② **App API 串行 + 最小间隔 1.5s**。这不是客气，是账号级风控：token 被吊销
   是不可恢复的（只能换号重走 OAuth）。

③ **所有错误都归一成 dict**，不向上抛协议异常 —— 上层 JS 永远能拿到
   `{ok:false, code, message}` 并给人话提示。
============================================================================
"""
from __future__ import annotations

import json
import os
import random
import sys
import time
import threading
from pathlib import Path
from typing import Any, Callable

# ---------------------------------------------------------------------------
# 凭证文件
# ---------------------------------------------------------------------------

def credential_file() -> Path:
    p = os.environ.get("PIXIV_CREDENTIAL_FILE")
    if p:
        return Path(p)
    home = os.environ.get("PIXIV_DUTY_HOME")
    if home:
        return Path(home) / "credential.json"
    return Path(__file__).parent / "credential.json"


CRED_FILE = credential_file()
LOG_FILE = Path(os.environ.get("PIXIV_DUTY_HOME", str(Path(__file__).parent))) / "duty.log"

_lock = threading.RLock()


def _log(msg: str) -> None:
    try:
        line = f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] [px] {msg}\n"
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass


def redact(text: str) -> str:
    """日志里永远不出现凭证本体"""
    s = str(text)
    for key in ("refresh_token", "access_token", "code=", "password", "PHPSESSID"):
        if key in s:
            import re

            s = re.sub(rf"({key}[=:\s\"']+)[^\s\"'&,}}]+", r"\1***", s)
    return s


class FileLock:
    """跨进程锁：Windows 用 msvcrt，POSIX 用 fcntl。拿不到就等 5 秒后放行。"""

    def __init__(self, path: Path):
        self.path = path
        self.fh = None

    def __enter__(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.fh = open(self.path, "a+")
            if os.name == "nt":
                import msvcrt

                deadline = time.time() + 5
                while time.time() < deadline:
                    try:
                        msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError:
                        time.sleep(0.1)
            else:
                import fcntl

                fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX)
        except Exception:
            self.fh = None
        return self

    def __exit__(self, *a):
        try:
            if self.fh:
                if os.name == "nt":
                    import msvcrt

                    self.fh.seek(0)
                    msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
                self.fh.close()
        except Exception:
            pass
        self.fh = None


def load_credential() -> dict:
    try:
        with open(CRED_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as e:
        _log(f"凭证读不了（{type(e).__name__}）：{CRED_FILE}")
        return {}


def save_credential(data: dict) -> None:
    """原子写 + 权限收紧。不要在这里打印任何 token。"""
    CRED_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CRED_FILE.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CRED_FILE)
    try:
        if os.name != "nt":
            os.chmod(CRED_FILE, 0o600)
        else:
            import subprocess

            user = os.environ.get("USERNAME", "")
            if user:
                subprocess.run(
                    ["icacls", str(CRED_FILE), "/inheritance:r", "/grant:r", f"{user}:F"],
                    capture_output=True, timeout=10,
                )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 错误码
# ---------------------------------------------------------------------------

class PxError(Exception):
    def __init__(self, code: str, message: str, retry_after: int = 0):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retry_after = retry_after

    def as_dict(self) -> dict:
        d = {"ok": False, "code": self.code, "message": self.message}
        if self.retry_after:
            d["retryAfter"] = self.retry_after
        return d


def classify(exc: Exception) -> PxError:
    text = f"{type(exc).__name__}: {exc}"
    low = text.lower()
    # 参数用错（比如给 search_novel 传了 duration）不该重试 —— 重试三次只是浪费 11 秒
    if isinstance(exc, TypeError) or "unexpected keyword" in low:
        return PxError("BAD_ARGUMENT", text[:300])
    if "429" in text or "-412" in text or "rate" in low:
        return PxError("RATE_LIMITED", "被 Pixiv 限流了，稍后再试", 60)
    if "401" in text or "invalid_grant" in low or "unauthorized" in low:
        return PxError("AUTH_REQUIRED", "登录已失效，需要重新登录")
    if "403" in text or "forbidden" in low:
        return PxError("IMAGE_FORBIDDEN", "资源被拒绝（多半是缺 Referer 或权限不足）")
    if "404" in text or "not found" in low:
        return PxError("NOT_FOUND", "作品不存在或已删除")
    if "timeout" in low or "timed out" in low or "connection" in low:
        return PxError("NETWORK", "网络连接失败")
    if "cloudflare" in low or "<html" in low:
        return PxError("BLOCKED", "Pixiv 返回了风控页（可能 IP 被限制）")
    return PxError("UNKNOWN", text[:400])


# ---------------------------------------------------------------------------
# 客户端
# ---------------------------------------------------------------------------

_client = None
_refresh_stamp = 0.0
_rate_lock = threading.Lock()
_last_call = 0.0
_rate_limited_hits = 0
MIN_INTERVAL = 1.5
MAX_RATE_HITS = 8


def _import_api():
    try:
        from pixivpy3 import AppPixivAPI  # noqa: WPS433
        return AppPixivAPI
    except Exception as e:  # pragma: no cover - 依赖没装时才会走到
        raise PxError("ENV_NOT_READY", f"没装 pixivpy3：{e}")


def get_client():
    """返回已鉴权的 AppPixivAPI；token 变了就落盘（带锁）。"""
    global _client, _refresh_stamp
    with _lock:
        if _client is not None:
            return _client

        AppPixivAPI = _import_api()
        cred = load_credential()
        token = (cred.get("refreshToken") or "").strip()
        if not token:
            raise PxError("AUTH_REQUIRED", "还没有登录：先在设置页扫码/输入账号密码，或手贴 refresh_token")

        api = AppPixivAPI()
        try:
            api.auth(refresh_token=token)
        except Exception as e:
            err = classify(e)
            if err.code == "UNKNOWN":
                err = PxError("AUTH_REQUIRED", f"refresh_token 不可用：{err.message}")
            raise err

        _persist_token(api, cred)
        _client = api
        _refresh_stamp = time.time()
        return api


def _persist_token(api, cred: dict | None = None) -> None:
    """pixivpy3 刷新后会换发新 refresh_token —— 不落盘下次就登不上。"""
    try:
        new_token = getattr(api, "refresh_token", None)
        access = getattr(api, "access_token", None)
        if not new_token:
            return
        cred = cred if cred is not None else load_credential()
        if cred.get("refreshToken") == new_token and cred.get("accessToken") == access:
            return
        with FileLock(CRED_FILE.with_suffix(".lock")):
            disk = load_credential()
            # 磁盘上更新（别的进程刚刷过）就以磁盘为准
            if disk.get("refreshToken") and disk.get("refreshToken") != cred.get("refreshToken"):
                cred = disk
            else:
                cred["refreshToken"] = new_token
            if access:
                cred["accessToken"] = access
            cred["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            save_credential(cred)
    except Exception as e:
        _log(f"token 落盘失败：{redact(str(e))}")


def reset_client() -> None:
    global _client
    with _lock:
        _client = None


def _throttle() -> None:
    global _last_call
    with _rate_lock:
        wait = MIN_INTERVAL - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait + random.uniform(0, 0.4))
        _last_call = time.time()


def call(fn: Callable, *args, **kwargs) -> Any:
    """
    统一的调用入口：限流 → 重试 → 错误归一 → token 落盘。
    成功返回原始结果；失败抛 PxError。
    """
    global _rate_limited_hits
    last: Exception | None = None
    for attempt in range(3):
        _throttle()
        try:
            result = fn(*args, **kwargs)
            _persist_token(get_client())
            return result
        except Exception as e:
            last = e
            err = classify(e)
            if err.code == "AUTH_REQUIRED" and attempt == 0:
                reset_client()
                get_client()
                continue
            if err.code == "RATE_LIMITED":
                _rate_limited_hits += 1
                if _rate_limited_hits >= MAX_RATE_HITS:
                    raise PxError("RATE_LIMITED", "连续被限流，本轮先停", err.retry_after)
                time.sleep(err.retry_after or [30, 90, 180][attempt])
                continue
            if err.code in ("NETWORK", "UNKNOWN") and attempt < 2:
                time.sleep([1, 3, 7][attempt])
                continue
            if err.code == "NOT_FOUND":
                raise err
            raise err
    raise classify(last) if last else PxError("UNKNOWN", "调用失败")


def status() -> dict:
    """登录态：会尝试拿一次 client（拿到就说明 token 还能用）。"""
    cred = load_credential()
    if not cred.get("refreshToken"):
        return {"ok": True, "state": "none", "userId": None, "pixivId": None}
    try:
        api = get_client()
        return {
            "ok": True,
            "state": "ok",
            "userId": str(cred.get("userId") or getattr(api, "user_id", "") or ""),
            "pixivId": cred.get("pixivId") or "",
            "expiresInMin": 60,
        }
    except PxError as e:
        return {"ok": True, "state": "expired", "userId": cred.get("userId"), "message": e.message}


def client_constants() -> dict:
    """给 JS 侧登录流程用的客户端常量（不硬编码在 JS 里）。"""
    try:
        import pixivpy3

        return {
            "ok": True,
            "clientId": getattr(pixivpy3, "client_id", "MOBrBDS8blbauoSck0ZfDbtuzpyT"),
            "clientSecret": getattr(pixivpy3, "client_secret", "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj"),
            "userAgent": "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)",
        }
    except Exception:
        return {
            "ok": True,
            "clientId": "MOBrBDS8blbauoSck0ZfDbtuzpyT",
            "clientSecret": "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj",
            "userAgent": "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)",
        }
