#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mcp_server.py —— Pixiv MCP（stdio），只被本插件的 JS 以子进程方式挂载
============================================================================
设计口径：
  · 这里只做 **网络 + 字节**：鉴权 / 搜索 / 详情 / 下载 / 正文 / 校验。
  · 命名、目录、额度、去重、metadata 全在 JS 侧（`lib/toolset.mjs` / `lib/save.mjs`）。
  · 白名单 `PIXIV_MCP_TOOLS` 里的工具才注册 —— 名单外的**连名字都不会出现在
    tools/list 里**，这是真闸门，不是提示词劝阻。
  · 任何失败都返回 `{ok:false, code, message}`，**不抛协议异常**。

⚠️ stdout 是 JSON-RPC 通道：任何调试输出都必须走 stderr 或 duty.log。
============================================================================
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).parent))

import px_client  # noqa: E402
import px_fetch as px_fetch_mod  # noqa: E402
import px_novel as px_novel_mod  # noqa: E402
import px_search as px_search_mod  # noqa: E402

HOME = Path(os.environ.get("PIXIV_DUTY_HOME") or Path(__file__).parent)
CACHE_DIR = str(Path(os.environ.get("PIXIV_CACHE_DIR") or (HOME / "cache")))

_ALLOWED = {t.strip() for t in os.environ.get("PIXIV_MCP_TOOLS", "").split(",") if t.strip()}

mcp = FastMCP("pixiv-mcp")


def tool():
    """白名单替身：没在名单里就原样返回、不注册。"""
    def deco(fn):
        if _ALLOWED and fn.__name__ not in _ALLOWED:
            return fn
        return mcp.tool()(fn)
    return deco


def ok(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def fail(e: Exception) -> str:
    if isinstance(e, px_client.PxError):
        return ok(e.as_dict())
    px_client._log(f"未捕获：{type(e).__name__}: {e}\n{traceback.format_exc()[:1200]}")
    return ok({"ok": False, "code": "UNKNOWN", "message": f"{type(e).__name__}: {str(e)[:300]}"})


@tool()
async def px_auth(action: str = "status") -> str:
    """登录状态 / 客户端常量。action: status | client | reset"""
    try:
        if action == "client":
            return ok(px_client.client_constants())
        if action == "reset":
            px_client.reset_client()
            return ok({"ok": True, "reset": True})
        return ok(px_client.status())
    except Exception as e:
        return fail(e)


@tool()
async def px_following(limit: int = 500) -> str:
    """读取当前账号的关注列表（作者 userId 列表）。用于「只推送已关注作者」模式。"""
    try:
        cred = px_client.load_credential()
        uid = int(cred.get("userId") or 0)
        if not uid:
            return ok({"ok": False, "code": "AUTH_REQUIRED", "message": "还没登录"})
        api = px_client.get_client()
        cap = max(1, min(int(limit or 500), 3000))
        out = []
        offset = 0
        while len(out) < cap:
            res = px_client.call(api.user_following, uid, restrict="public", offset=str(offset))
            prevs = res.get("user_previews") or []
            if not prevs:
                break
            for p in prevs:
                u = p.get("user") or {}
                if u.get("id"):
                    out.append({"id": int(u["id"]), "name": u.get("name") or "", "account": u.get("account") or ""})
            offset += len(prevs)
            if len(prevs) < 30:
                break
        return ok({"ok": True, "userId": uid, "total": len(out), "users": out[:cap]})
    except Exception as e:
        return fail(e)

@tool()
async def px_search(queries: str, kind: str = "all", days: int = 7, limit: int = 20, sort: str = "date_desc") -> str:
    """搜索插画/漫画/小说。queries 用 || 分隔（最多 3 个），例如 "原神||厚涂" """
    try:
        qs = [q.strip() for q in str(queries).split("||") if q.strip()][:3]
        if not qs:
            return ok({"ok": False, "code": "BAD_REQUEST", "message": "queries 为空"})
        return ok(px_search_mod.search(qs, kind=kind, days=int(days), limit=int(limit), sort=sort))
    except Exception as e:
        return fail(e)


@tool()
async def px_detail(ids: str, kind: str = "auto") -> str:
    """批量详情。ids 用逗号分隔，最多 12 个；kind = novel | illust | auto（按类型查各自命名空间）"""
    try:
        arr = [int(x) for x in str(ids).replace("，", ",").split(",") if x.strip()][:12]
        if not arr:
            return ok({"ok": False, "code": "BAD_REQUEST", "message": "ids 为空"})
        return ok(px_search_mod.detail(arr, kind=str(kind or "auto")))
    except Exception as e:
        return fail(e)


@tool()
async def px_fetch(items: str, variant: str = "view", maxEdge: int = 1536, defaultPages: int = 3) -> str:
    """下载图片到本地缓存。items 是 JSON 数组字符串：[{"id":123,"pages":[1,2]}]"""
    try:
        arr = json.loads(items) if isinstance(items, str) else items
        if not isinstance(arr, list) or not arr:
            return ok({"ok": False, "code": "BAD_REQUEST", "message": "items 需要非空数组"})
        return ok(px_fetch_mod.fetch(arr, variant=variant, max_edge=int(maxEdge),
                                 cache_dir=CACHE_DIR, default_pages=int(defaultPages)))
    except Exception as e:
        return fail(e)


@tool()
async def px_novel(id: int, action: str = "outline", fromBlock: int = 0, blocks: int = 20,
                   terms: str = "", context: int = 0, vibe: str = "") -> str:
    """小说正文。action: outline | read | pick | full | blocks | vibe"""
    try:
        pid = int(id)
        if action == "outline":
            return ok(px_novel_mod.outline(pid, CACHE_DIR))
        if action == "read":
            return ok(px_novel_mod.read(pid, CACHE_DIR, from_block=int(fromBlock), blocks=int(blocks)))
        if action == "pick":
            ts = [t.strip() for t in str(terms).replace("，", ",").split(",") if t.strip()]
            return ok(px_novel_mod.pick(pid, ts, cache_dir=CACHE_DIR, blocks=int(blocks), context=int(context)))
        if action == "full":
            return ok(px_novel_mod.full_text(pid, CACHE_DIR))
        if action == "blocks":
            return ok({"ok": True, "blocks": px_novel_mod.block_map(pid, CACHE_DIR)})
        if action == "vibe":
            return ok(px_novel_mod.vibe(pid, vibe, CACHE_DIR, blocks=int(blocks)))
        return ok({"ok": False, "code": "BAD_REQUEST", "message": f"未知 action：{action}"})
    except Exception as e:
        return fail(e)


@tool()
async def px_tags(seed: str, limit: int = 12) -> str:
    """按种子词看相邻标签（带翻译与出现次数）"""
    try:
        return ok(px_search_mod.tag_suggest(seed, limit=int(limit)))
    except Exception as e:
        return fail(e)


@tool()
async def px_verify(paths: str) -> str:
    """校验本地图片能解码。paths 用 || 分隔"""
    try:
        arr = [p.strip() for p in str(paths).split("||") if p.strip()]
        return ok(px_fetch_mod.verify(arr))
    except Exception as e:
        return fail(e)


if __name__ == "__main__":
    px_client._log("MCP 启动；白名单=" + (",".join(sorted(_ALLOWED)) if _ALLOWED else "(全部)"))
    mcp.run()
