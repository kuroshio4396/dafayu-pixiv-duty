#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
px_fetch.py —— 图片下载 / 缩图 / 校验
============================================================================
两条必须记住的事实：

① `i.pximg.net` **必须带 `Referer: https://www.pixiv.net/`**，否则 403。
② 原图常有 8000px / 10MB+，直接给模型看会被宿主二次缩放且极贵。
   所以 `variant='view'` 先在本地缩到长边 ≤1536、JPEG q88，再让 agent 读。

落盘一律 `.part` → rename，字节校验（status / content-type / magic）通过才算成功。
============================================================================
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import requests

from px_client import PxError, _log, call, get_client  # noqa: F401
from px_search import _page_urls, detail_raw, normalize_illust

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
HEADERS = {
    "Referer": "https://www.pixiv.net/",
    "User-Agent": UA,
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
}

MAGIC = [
    (b"\xff\xd8\xff", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
    (b"RIFF", "webp"),
]


def sniff(buf: bytes) -> str | None:
    for magic, ext in MAGIC:
        if buf.startswith(magic):
            return ext
    return None


def download(url: str, dest_stem: Path, *, timeout: int = 60) -> tuple[Path, str, int]:
    """下载一张图；返回 (路径, 扩展名, 字节数)。失败抛 PxError。"""
    dest_stem.parent.mkdir(parents=True, exist_ok=True)
    try:
        with requests.get(url, headers=HEADERS, stream=True, timeout=timeout) as r:
            if r.status_code == 403:
                raise PxError("IMAGE_FORBIDDEN", "图片 403（Referer 无效或作品受限）")
            if r.status_code != 200:
                raise PxError("IMAGE_HTTP", f"图片返回 HTTP {r.status_code}")
            ctype = (r.headers.get("content-type") or "").lower()
            if ctype and not ctype.startswith("image/"):
                raise PxError("IMAGE_BAD", f"返回的不是图片（{ctype}）")
            tmp = dest_stem.with_suffix(dest_stem.suffix + f".part-{os.getpid()}")
            size = 0
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(64 * 1024):
                    if chunk:
                        f.write(chunk)
                        size += len(chunk)
            if size <= 1024:
                tmp.unlink(missing_ok=True)
                raise PxError("IMAGE_BAD", "图片太小，可能是占位图")
            with open(tmp, "rb") as f:
                head = f.read(16)
            ext = sniff(head)
            if not ext:
                tmp.unlink(missing_ok=True)
                raise PxError("IMAGE_BAD", "magic bytes 不是 PNG/JPEG/GIF/WebP")
            final = dest_stem.with_suffix("." + ext)
            os.replace(tmp, final)
            return final, ext, size
    except PxError:
        raise
    except requests.Timeout:
        raise PxError("NETWORK", "图片下载超时")
    except Exception as e:
        raise PxError("NETWORK", f"图片下载失败：{e}")


def _resize(src: Path, dst: Path, max_edge: int) -> tuple[int, int, int]:
    """缩到长边 ≤ max_edge，转 RGB（alpha 铺白），JPEG q88。返回 (w,h,bytes)。"""
    try:
        from PIL import Image
    except Exception as e:  # pragma: no cover
        raise PxError("ENV_NOT_READY", f"没装 Pillow：{e}")
    with Image.open(src) as im:
        if getattr(im, "n_frames", 1) > 1:
            im.seek(0)
        im = im.convert("RGBA") if im.mode in ("RGBA", "LA", "P") else im.convert("RGB")
        if im.mode == "RGBA":
            from PIL import Image as I

            bg = I.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        im.thumbnail((max_edge, max_edge), Image.LANCZOS)
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_suffix(dst.suffix + f".part-{os.getpid()}")
        im.save(tmp, "JPEG", quality=88, optimize=True)
        os.replace(tmp, dst)
        return im.width, im.height, dst.stat().st_size


def fetch(items: list[dict], *, variant: str = "view", max_edge: int = 1536,
          cache_dir: str, default_pages: int = 3) -> dict:
    """
    items: [{ id, pages?: [1,2], maxEdge?: 1536 }]
    返回: { ok, items: [{ id, kind, pageCount, files: [{path,page,w,h,bytes,ext}] }] }
    """
    out = []
    for it in items[:3]:
        pid = int(it.get("id"))
        want = it.get("pages")
        edge = int(it.get("maxEdge") or max_edge)
        try:
            got = detail_raw(pid)
        except PxError as e:
            if e.code in ("AUTH_REQUIRED", "RATE_LIMITED"):
                raise
            out.append({"id": pid, "ok": False, "code": e.code, "message": e.message})
            continue

        kind = got["kind"]
        raw = got["raw"]
        if kind == "illust" and normalize_illust(raw)["kind"] == "ugoira":
            out.append({"id": pid, "ok": False, "code": "UGOIRA_SKIPPED", "message": "动图默认跳过"})
            continue

        urls = _page_urls(raw)
        if not urls:
            out.append({"id": pid, "ok": False, "code": "NO_IMAGE", "message": "拿不到图片地址"})
            continue

        if want:
            idx = [int(p) - 1 for p in want if 1 <= int(p) <= len(urls)]
        else:
            idx = list(range(min(default_pages, len(urls))))

        files = []
        warnings = []
        for i in idx:
            url = urls[i]
            page = i + 1
            try:
                if variant == "original":
                    p, ext, size = download(url, Path(cache_dir) / "orig" / str(pid) / f"p{page:03d}")
                    files.append({"path": str(p), "page": page, "bytes": size, "ext": ext,
                                  "w": raw.get("width"), "h": raw.get("height")})
                else:
                    p, ext, size = download(url, Path(cache_dir) / "orig" / str(pid) / f"p{page:03d}")
                    dst = Path(cache_dir) / "view" / str(pid) / f"p{page:03d}.jpg"
                    w, h, n = _resize(p, dst, edge)
                    files.append({"path": str(dst), "page": page, "bytes": n, "ext": "jpg", "w": w, "h": h})
                    if variant == "view":
                        try:
                            p.unlink(missing_ok=True)   # 缩完就删原图，缓存只留缩图
                        except Exception:
                            pass
            except PxError as e:
                warnings.append({"page": page, "code": e.code, "message": e.message})
            time.sleep(0.4)

        if not files:
            out.append({"id": pid, "ok": False, "code": "IMAGE_FORBIDDEN",
                        "message": "所有页都下载失败", "warnings": warnings})
            continue
        out.append({
            "id": pid,
            "ok": True,
            "kind": kind,
            "title": raw.get("title") or "",
            "pageCount": len(urls),
            "files": files,
            "warnings": warnings,
        })
    return {"ok": True, "items": out}


def verify(paths: list[str]) -> dict:
    """解码校验：能打开、能拿到尺寸才算好文件"""
    files = []
    for p in paths[:60]:
        item = {"path": p, "exists": False, "decodable": False, "bytes": 0, "w": None, "h": None}
        try:
            st = os.stat(p)
            item["exists"] = True
            item["bytes"] = st.st_size
            from PIL import Image

            with Image.open(p) as im:
                im.verify()
            with Image.open(p) as im:
                item["w"], item["h"] = im.size
            item["decodable"] = True
        except Exception as e:
            item["error"] = str(e)[:200]
        files.append(item)
    return {"ok": True, "files": files}
