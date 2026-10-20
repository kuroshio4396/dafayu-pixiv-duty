#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
px_search.py —— 搜索 / 详情 / 标签，以及**字段归一化**
============================================================================
App API 在不同端对同一个意思有两种叫法（`type` 与 `illustType`），
下游只认我们自己这套字段，避免每个调用点各写一遍 if。

归一化后的形状（与 JS 侧 pixiv_search / pixiv_inspect 的返回一致）：
    { id, kind, title, artist{id,name,account}, tags[{name,translated}],
      pages, w, h, bookmarks, views, created, rating, caption, url }
============================================================================
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from px_client import PxError, call, get_client

KIND_BY_TYPE = {"illust": "illust", "manga": "manga", "ugoira": "ugoira"}
KIND_BY_INT = {0: "illust", 1: "manga", 2: "ugoira"}


def _kind(raw: dict) -> str:
    k = KIND_BY_TYPE.get(str(raw.get("type") or "").lower())
    if k:
        return k
    if "illustType" in raw:
        return KIND_BY_INT.get(raw.get("illustType"), "illust")
    return "illust"


def _rating(x_restrict: Any) -> str:
    try:
        v = int(x_restrict)
    except Exception:
        return "all"
    return "r18g" if v == 2 else ("r18" if v == 1 else "all")


def _tags(raw: dict) -> list[dict]:
    out = []
    for t in raw.get("tags") or []:
        if isinstance(t, str):
            out.append({"name": t, "translated": None})
        elif isinstance(t, dict):
            out.append({"name": t.get("name") or "", "translated": t.get("translated_name") or None})
    return [t for t in out if t["name"]]


def normalize_illust(raw: dict, *, detail: bool = False) -> dict:
    user = raw.get("user") or {}
    pages = raw.get("page_count") or raw.get("pageCount") or 1
    w = raw.get("width")
    h = raw.get("height")
    item = {
        "id": int(raw.get("id") or 0),
        "kind": _kind(raw),
        "title": raw.get("title") or "",
        "artist": {
            "id": user.get("id"),
            "name": user.get("name") or "",
            "account": user.get("account") or "",
        },
        "tags": _tags(raw),
        "pages": int(pages or 1),
        "w": int(w) if w else None,
        "h": int(h) if h else None,
        "bookmarks": raw.get("total_bookmarks"),
        "views": raw.get("total_view"),
        "created": raw.get("create_date") or "",
        "rating": _rating(raw.get("xRestrict", raw.get("x_restrict", 0))),
        "xRestrict": int(raw.get("xRestrict", raw.get("x_restrict", 0)) or 0),
        "sanity": raw.get("sanity_level"),
        "caption": (raw.get("caption") or "")[:1200] if detail else "",
        "url": f"https://www.pixiv.net/artworks/{raw.get('id')}",
        "series": (raw.get("series") or {}).get("title") if isinstance(raw.get("series"), dict) else None,
    }
    if detail:
        # ⚠️ 原图 URL 只留在 MCP 里，不回给模型（一条 200 字符，纯浪费 token）
        item["_pageUrls"] = _page_urls(raw)
    return item


def _page_urls(raw: dict) -> list[str]:
    urls: list[str] = []
    for p in raw.get("meta_pages") or []:
        u = (p.get("image_urls") or {}).get("original")
        if u:
            urls.append(u)
    if not urls:
        single = (raw.get("meta_single_page") or {}).get("original_image_url")
        if not single:
            single = (raw.get("image_urls") or {}).get("large")
        if single:
            urls.append(single)
    return urls


def normalize_novel(raw: dict, *, detail: bool = False) -> dict:
    user = raw.get("user") or {}
    text_len = raw.get("text_length") or raw.get("character_count") or 0
    return {
        "id": int(raw.get("id") or 0),
        "kind": "novel",
        "title": raw.get("title") or "",
        "artist": {
            "id": user.get("id"),
            "name": user.get("name") or "",
            "account": user.get("account") or "",
        },
        "tags": _tags(raw),
        "pages": 1,
        "w": None,
        "h": None,
        "bookmarks": raw.get("total_bookmarks"),
        "views": raw.get("total_view"),
        "created": raw.get("create_date") or "",
        "rating": _rating(raw.get("xRestrict", raw.get("x_restrict", 0))),
        "xRestrict": int(raw.get("xRestrict", raw.get("x_restrict", 0)) or 0),
        "sanity": raw.get("sanity_level"),
        "caption": (raw.get("caption") or "")[:1200] if detail else "",
        "url": f"https://www.pixiv.net/novel/show.php?id={raw.get('id')}",
        "chars": int(text_len or 0),
        "language": raw.get("language") or "",
        "series": (raw.get("series") or {}).get("title") if isinstance(raw.get("series"), dict) else None,
        "isOriginal": bool(raw.get("is_original")),
    }


def _duration(days: int) -> dict:
    # days <= 0 表示"不限发布时间"（用户把时间窗关掉了）
    if days <= 0:
        return {}
    if days <= 1:
        return {"duration": "within_last_day"}
    if days <= 7:
        return {"duration": "within_last_week"}
    if days <= 30:
        return {"duration": "within_last_month"}
    start = (datetime.now() - timedelta(days=max(1, days))).strftime("%Y-%m-%d")
    return {"start_date": start}


def _novel_window(days: int) -> dict:
    """小说搜索**不支持 duration**（只认 start_date/end_date）——传错会 TypeError。"""
    if days <= 0:
        return {}
    start = (datetime.now() - timedelta(days=max(1, days))).strftime("%Y-%m-%d")
    return {"start_date": start}


def search(queries: list[str], kind: str = "all", days: int = 7, limit: int = 20, sort: str = "date_desc") -> dict:
    api = get_client()
    seen: dict[int, dict] = {}
    by_query = []

    for q in queries[:3]:
        word = (q or "").strip()
        if not word:
            continue
        got = 0
        filtered = 0
        errs: list[dict] = []

        # 两类分开 try：小说挂了不该把插画也一起拖下水
        if kind in ("novel", "all"):
            try:
                res = call(api.search_novel, word, search_target="partial_match_for_tags",
                           sort=sort, **_novel_window(days))
                for raw in (res.get("novels") or []):
                    item = normalize_novel(raw)
                    if item["id"] in seen:
                        continue
                    seen[item["id"]] = item
                    got += 1
                    if got >= limit:
                        break
            except PxError as e:
                if e.code == "RATE_LIMITED":
                    raise
                errs.append({"kind": "novel", "code": e.code, "message": e.message[:160]})

        if kind in ("illust", "manga", "all"):
            try:
                res = call(api.search_illust, word, search_target="partial_match_for_tags",
                           sort=sort, **_duration(days))
                for raw in (res.get("illusts") or []):
                    item = normalize_illust(raw)
                    if item["id"] in seen:
                        continue
                    if kind != "all" and item["kind"] != kind:
                        filtered += 1
                        continue
                    seen[item["id"]] = item
                    got += 1
                    if got >= limit:
                        break
            except PxError as e:
                if e.code == "RATE_LIMITED":
                    raise
                errs.append({"kind": "illust", "code": e.code, "message": e.message[:160]})

        rec = {"q": word, "count": got, "filtered": filtered}
        if errs:
            rec["errors"] = errs
            rec["error"] = errs[0]["code"]
            rec["message"] = errs[0]["message"]
        by_query.append(rec)

    items = sorted(seen.values(), key=lambda x: x["id"], reverse=True)
    return {"ok": True, "items": items, "byQuery": by_query}


def _valid_illust(raw: dict | None, pid: int) -> bool:
    """⚠️ 实测：用小说 id 调 illust_detail，pixiv 会返回一个 id 对得上、
    但 title 为空、没有 image_urls 的**假插画**。不校验就会把小说当插画存。"""
    if not raw:
        return False
    if int(raw.get("id") or 0) != int(pid):
        return False
    if not (raw.get("title") or "").strip():
        return False
    return bool(raw.get("page_count") or raw.get("image_urls") or raw.get("meta_pages"))


def _valid_novel(raw: dict | None, pid: int) -> bool:
    if not raw:
        return False
    return int(raw.get("id") or 0) == int(pid) and bool((raw.get("title") or "").strip())


def _probe_illust(api, pid: int) -> bool:
    """同号 id 在插画库里是否存在（只为把错误说清楚，不影响主判定）"""
    try:
        res = call(api.illust_detail, pid)
        return _valid_illust(res.get("illust"), pid)
    except PxError as e:
        if e.code in ("AUTH_REQUIRED", "RATE_LIMITED"):
            raise
        return False


def _probe_novel(api, pid: int) -> bool:
    try:
        res = call(api.novel_detail, pid)
        return _valid_novel(res.get("novel"), pid)
    except PxError as e:
        if e.code in ("AUTH_REQUIRED", "RATE_LIMITED"):
            raise
        return False


def detail(ids: list[int], kind: str = "auto") -> dict:
    """
    批量详情。
    ⚠️ 插画与小说是**两个 id 命名空间**，会撞号（如 29222785 同时是旧插画与一篇小说）。
    所以调用方声明了类型时，必须只查对应的接口，不能"先查插画再看小说"——
    否则小说永远被识别成同号插画，保存时被 CONTENT_TYPE 拦下。
        kind = 'novel'            → 只查小说接口
        kind = 'illust' / 'manga' → 只查插画接口
        kind = 'auto'             → 旧行为（先插画后小说）
    """
    api = get_client()
    kind = (kind or "auto").lower()
    items = []
    errors = []
    for pid in ids[:12]:
        pid = int(pid)
        try:
            if kind == "novel":
                res = call(api.novel_detail, pid)
                raw = res.get("novel")
                if _valid_novel(raw, pid):
                    item = normalize_novel(raw, detail=True)
                    item["kindSource"] = "novel-endpoint"
                    if _probe_illust(api, pid):
                        item["alsoIllust"] = pid  # 同号插画存在，仅作说明
                    items.append(item)
                else:
                    errors.append({
                        "id": pid, "code": "NOT_FOUND", "namespace": "novel",
                        "collidesWithIllust": _probe_illust(api, pid),
                    })
                continue

            if kind in ("illust", "manga"):
                res = call(api.illust_detail, pid)
                raw = res.get("illust")
                if _valid_illust(raw, pid):
                    item = normalize_illust(raw, detail=True)
                    item["kindSource"] = "illust-endpoint"
                    items.append(item)
                else:
                    errors.append({
                        "id": pid, "code": "NOT_FOUND", "namespace": "illust",
                        "collidesWithNovel": _probe_novel(api, pid),
                    })
                continue

            # auto：先插画后小说（保持旧行为），但标出"两边都有"
            res = call(api.illust_detail, pid)
            raw = res.get("illust")
            if _valid_illust(raw, pid):
                item = normalize_illust(raw, detail=True)
                item["kindSource"] = "illust-endpoint(auto)"
                items.append(item)
                continue
            res = call(api.novel_detail, pid)
            raw = res.get("novel")
            if _valid_novel(raw, pid):
                item = normalize_novel(raw, detail=True)
                item["kindSource"] = "novel-endpoint(auto)"
                items.append(item)
            else:
                errors.append({"id": pid, "code": "NOT_FOUND"})
        except PxError as e:
            if e.code in ("AUTH_REQUIRED", "RATE_LIMITED"):
                raise
            errors.append({"id": pid, "code": e.code})
    return {"ok": True, "items": items, "errors": errors}


def detail_raw(pid: int) -> dict:
    """给内部用：拿原始 dict（含 meta_pages）"""
    api = get_client()
    pid = int(pid)
    try:
        res = call(api.illust_detail, pid)
        if _valid_illust(res.get("illust"), pid):
            return {"kind": "illust", "raw": res["illust"]}
    except PxError as e:
        if e.code in ("AUTH_REQUIRED", "RATE_LIMITED"):
            raise
    res = call(api.novel_detail, pid)
    if _valid_novel(res.get("novel"), pid):
        return {"kind": "novel", "raw": res["novel"]}
    raise PxError("NOT_FOUND", f"作品 {pid} 不存在")


def tag_suggest(seed: str, limit: int = 12) -> dict:
    api = get_client()
    res = call(api.search_illust, seed, search_target="partial_match_for_tags", sort="popular_desc")
    counts: dict[str, int] = {}
    trans: dict[str, str] = {}
    for raw in (res.get("illusts") or [])[:30]:
        for t in _tags(raw):
            name = t["name"]
            counts[name] = counts.get(name, 0) + 1
            if t.get("translated") and name not in trans:
                trans[name] = t["translated"]
    tags = [{"name": k, "translated": trans.get(k), "count": v}
            for k, v in sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:limit]]
    return {"ok": True, "tags": tags}
