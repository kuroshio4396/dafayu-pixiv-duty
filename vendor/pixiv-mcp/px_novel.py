#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
px_novel.py —— 小说正文：四通道抓取 + 段落切分 + 选段
============================================================================
正文为什么不能只走一条路：
  · `webview_novel` 在部分作品上返回空（尤其 R-18 / 较长篇）；
  · Web 端 `/webview/v2/novel/{id}` 需要 PHPSESSID（登录时从浏览器上下文导出）；
  · 最后还有老页面 `novel/show.php?id=` 可以正则兜底。

切分口径：`[newpage]` = 分页，空行 = 段落。段落是选段的最小单位，
报告与落盘都记 block 序号，方便回头定位。
============================================================================
"""
from __future__ import annotations

import html
import json
import os
import re
import time
from pathlib import Path

import requests

from px_client import PxError, _log, call, get_client, load_credential

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
CACHE_TTL = 7 * 86400

CHAPTER_RE = re.compile(r"^(第[0-9一二三四五六七八九十百零〇]{1,8}[章話话節节]|序章|楔子|后记|後記|エピローグ|プロローグ)")


def _cache_path(cache_dir: str, pid: int) -> Path:
    return Path(cache_dir) / "novel" / f"{pid}.json"


def _clean(text: str) -> str:
    s = text.replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</p>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return html.unescape(s)


def _blocks(text: str) -> tuple[list[dict], int]:
    pages = text.split("[newpage]")
    blocks: list[dict] = []
    total_chars = 0
    for pi, page in enumerate(pages):
        for raw in re.split(r"\n\s*\n", page):
            s = raw.strip()
            if not s:
                continue
            # 段内的单换行保留为空格（有些作者用单换行排版）
            s = re.sub(r"\n+", "\n", s)
            blocks.append({"index": len(blocks), "page": pi + 1, "text": s, "chars": len(s)})
            total_chars += len(s)
    return blocks, total_chars


def _channels(pid: int) -> list[tuple[str, callable]]:
    api = get_client()
    cred = load_credential()
    cookie = (cred.get("webCookie") or {})

    def ch_app():
        res = call(api.webview_novel, pid) or {}
        # ⚠️ 实测：webview_novel 的返回是**顶层**就带 text（id/title/text/…），
        #    不是 {"novel": {...}}；两种都兼容一下。
        nested = res.get("novel")
        data = nested if isinstance(nested, dict) and nested else res
        return (data.get("text") or "").strip() if isinstance(data, dict) else ""

    def ch_app_api():
        token = getattr(api, "access_token", "") or cred.get("accessToken") or ""
        r = requests.get(
            f"https://app-api.pixiv.net/webview/v2/novel/{pid}",
            headers={
                "User-Agent": "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)",
                "App-OS": "android", "App-OS-Version": "11", "App-Version": "5.0.234",
                "Authorization": f"Bearer {token}",
            },
            timeout=25,
        )
        if r.status_code != 200:
            raise PxError("NOVEL_HTTP", f"app-api 正文 HTTP {r.status_code}")
        return ((r.json() or {}).get("novel") or {}).get("text") or ""

    def ch_web():
        if not cookie.get("PHPSESSID"):
            raise PxError("NOVEL_NO_COOKIE", "没有 PHPSESSID，跳过 Web 通道")
        r = requests.get(
            f"https://www.pixiv.net/webview/v2/novel/{pid}",
            headers={
                "User-Agent": UA,
                "Referer": f"https://www.pixiv.net/novel/show.php?id={pid}",
                "Cookie": f"PHPSESSID={cookie['PHPSESSID']}",
            },
            timeout=25,
        )
        if r.status_code != 200:
            raise PxError("NOVEL_HTTP", f"web 正文 HTTP {r.status_code}")
        return ((r.json() or {}).get("novel") or {}).get("text") or ""

    def ch_legacy():
        r = requests.get(
            f"https://www.pixiv.net/novel/show.php?id={pid}",
            headers={"User-Agent": UA, "Cookie": f"PHPSESSID={cookie.get('PHPSESSID', '')}"},
            timeout=25,
        )
        if r.status_code != 200:
            raise PxError("NOVEL_HTTP", f"legacy HTTP {r.status_code}")
        m = re.search(r'<div[^>]+id="novel_text"[^>]*>(.*?)</div>', r.text, re.S)
        return _clean(m.group(1)) if m else ""

    return [("app", ch_app), ("app-api", ch_app_api), ("web", ch_web), ("legacy", ch_legacy)]


def load_text(pid: int, cache_dir: str) -> dict:
    """四通道依次尝试，成功即缓存并返回。"""
    cache = _cache_path(cache_dir, pid)
    try:
        if cache.exists() and time.time() - cache.stat().st_mtime < CACHE_TTL:
            with open(cache, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("text"):
                data["cached"] = True
                return data
    except Exception:
        pass

    errors = []
    text = ""
    used = ""
    for name, fn in _channels(pid):
        try:
            text = (fn() or "").strip()
            if len(text) >= 40:
                used = name
                break
            errors.append(f"{name}: 正文为空")
            text = ""
        except PxError as e:
            errors.append(f"{name}: {e.code}")
        except Exception as e:
            errors.append(f"{name}: {type(e).__name__}")
        time.sleep(0.5)

    if not text:
        raise PxError("NOVEL_EMPTY", "四通道都拿不到正文：" + " / ".join(errors[:4]))

    blocks, chars = _blocks(_clean(text))
    chapters = [{"title": b["text"][:40], "block": b["index"]}
                for b in blocks if len(b["text"]) < 60 and CHAPTER_RE.match(b["text"])]
    data = {
        "id": pid,
        "via": used,
        "text": "\n\n".join(b["text"] for b in blocks),
        "blocks": blocks,
        "chars": chars,
        "chapters": chapters,
        "language": detect_language("\n".join(b["text"] for b in blocks[:40])),
        "at": time.time(),
    }
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache.with_suffix(f".json.part-{os.getpid()}")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, cache)
    except Exception as e:
        _log(f"正文缓存写失败：{e}")
    data["cached"] = False
    return data


def detect_language(sample: str) -> str:
    """日文/中文粗判：假名占比 > 3% 判 ja，汉字占比 > 20% 判 zh。"""
    if not sample:
        return "unknown"
    kana = len(re.findall(r"[\u3040-\u30ff]", sample))
    han = len(re.findall(r"[\u4e00-\u9fff]", sample))
    total = max(1, len(sample))
    if kana / total > 0.03:
        return "ja"
    if han / total > 0.20:
        return "zh"
    return "unknown"


def outline(pid: int, cache_dir: str) -> dict:
    d = load_text(pid, cache_dir)
    head = "\n\n".join(b["text"] for b in d["blocks"][:6])[:800]
    return {
        "ok": True, "id": pid, "via": d["via"], "cached": d.get("cached", False),
        "chars": d["chars"], "blocks": len(d["blocks"]),
        "chapters": d["chapters"][:40], "language": d["language"], "head": head,
    }


def read(pid: int, cache_dir: str, from_block: int = 0, blocks: int = 20) -> dict:
    d = load_text(cache_dir=cache_dir, pid=pid)
    total = len(d["blocks"])
    lo = max(0, int(from_block))
    hi = min(total, lo + max(1, min(60, int(blocks))))
    chunk = d["blocks"][lo:hi]
    text = "\n\n".join(b["text"] for b in chunk)
    if len(text) > 12000:
        text = text[:12000] + "\n…（已截断，请缩小 blocks 范围）"
    return {"ok": True, "fromBlock": lo, "toBlock": hi - 1, "totalBlocks": total,
            "text": text, "truncated": len(text) >= 12000}


def pick(pid: int, terms: list[str], *, cache_dir: str, blocks: int = 6, context: int = 0) -> dict:
    d = load_text(pid, cache_dir)
    all_blocks = d["blocks"]
    terms = [t.strip().lower() for t in terms if t and t.strip()][:12]
    scored = []
    for b in all_blocks:
        low = b["text"].lower()
        hits = [t for t in terms if t in low]
        if not hits:
            continue
        # 关键词数为主、段落长度为辅（太短的段落信息量低）
        score = len(hits) * 2 + min(1.0, b["chars"] / 400.0)
        scored.append((score, hits, b))
    scored.sort(key=lambda x: (-x[0], x[2]["index"]))
    chosen: list[dict] = []
    used: set[int] = set()
    char_budget = 6000
    for score, hits, b in scored:
        if len(chosen) >= blocks:
            break
        idxs = [i for i in range(max(0, b["index"] - context), min(len(all_blocks), b["index"] + context + 1))]
        if any(i in used for i in idxs):
            continue
        text = "\n\n".join(all_blocks[i]["text"] for i in idxs)
        if char_budget - len(text) < 0 and chosen:
            continue
        char_budget -= len(text)
        used.update(idxs)
        chosen.append({
            "fromBlock": idxs[0], "toBlock": idxs[-1],
            "score": round(min(1.0, score / 6.0), 3),
            "hits": hits, "text": text,
        })
    chosen.sort(key=lambda x: x["fromBlock"])
    return {"ok": True, "picks": chosen, "totalBlocks": len(all_blocks),
            "chars": d["chars"], "language": d["language"]}


def full_text(pid: int, cache_dir: str) -> dict:
    d = load_text(pid, cache_dir)
    return {"ok": True, "text": d["text"], "chars": d["chars"], "blocks": len(d["blocks"]),
            "language": d["language"]}


def block_map(pid: int, cache_dir: str) -> dict:
    d = load_text(pid, cache_dir)
    return {b["index"]: b["text"] for b in d["blocks"]}


# ---------------------------------------------------------------------------
# 正文模糊偏好（自然语言 → 词片 → 命中打分）
# ---------------------------------------------------------------------------

# 只去掉那些"任何小说都会出现"的词，避免把分数灌满
STOP = {
    "一个", "我们", "你们", "他们", "这个", "那个", "什么", "然后", "就是", "还是",
    "可以", "没有", "因为", "所以", "但是", "如果", "已经", "自己", "这样", "那样",
    "时候", "现在", "起来", "出来", "不过", "而且", "以及", "其中", "对于", "关于",
    "通过", "进行", "不是", "不能", "可能", "应该", "需要", "一定", "一直", "一些",
    "这些", "那些", "的人", "的是", "了的", "了一", "是在", "有一", "就会", "就是",
}

PUNCT = re.compile(r"[\s，。！？、；：“”‘’（）《》…—\-·,.!?;:\"'()\[\]{}<>/\\|~`]+")


def extract_terms(text: str, limit: int = 80) -> list[str]:
    """
    中文没有空格，按「连续汉字串」切，再生成 2–4 字滑窗作为词片。
    4 字片最具体，优先保留；英文/数字单词原样保留。
    """
    runs = PUNCT.split(str(text or ""))
    grams4: list[str] = []
    grams3: list[str] = []
    grams2: list[str] = []
    latin: list[str] = []
    for run in runs:
        if not run:
            continue
        if re.fullmatch(r"[A-Za-z0-9_\-]{2,}", run):
            latin.append(run.lower())
            continue
        for seg in re.findall(r"[\u4e00-\u9fff]{2,}", run):
            for n, bucket in ((4, grams4), (3, grams3), (2, grams2)):
                for i in range(len(seg) - n + 1):
                    g = seg[i:i + n]
                    if g in STOP:
                        continue
                    bucket.append(g)
    out: list[str] = []
    seen: set[str] = set()
    for group in (grams4, grams3, grams2, latin):
        for g in group:
            if g in seen:
                continue
            # 被更长且已入选的词包含就跳过（"图书馆" 命中时不必再算 "图书"）
            if group is not grams4 and any(g in longer for longer in out):
                continue
            seen.add(g)
            out.append(g)
            if len(out) >= limit:
                return out
    return out


# 虚词：两个都是虚词的组合不计分（"之间的""和情感"这类不说明内容）
FUNC = set("的了和与之在是有我你他她它们个这那就也都很不没要会能把被让给对从到为以及而且或但如若则其所着过又再还只")


def _bigrams(text: str) -> set[str]:
    s = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", str(text or "").lower())
    out = set()
    for i in range(len(s) - 1):
        g = s[i:i + 2]
        if g[0] in FUNC and g[1] in FUNC:
            continue
        out.add(g)
    return out


def vibe(pid: int, vibe_text: str, cache_dir: str, blocks: int = 6) -> dict:
    """
    粗糙的**词形预筛**：看正文里有没有出现偏好描述中的二字词。
    ⚠️ 它测的是"字面像不像"，不是"意思像不像" —— 所以：
      · 分数高 ⇒ 大概率确实相关，可以直接收
      · 分数低 ⇒ **不代表不相关**（同义改写、意象描写都会漏）
    真正的语义判断由 agent 读返回的段落来做，闸门只要求"低分必须给理由"。
    """
    A = _bigrams(vibe_text)
    if not A:
        raise PxError("BAD_ARGUMENT", "偏好描述里没有可用的二字词（至少写几个实词）")
    d = load_text(pid, cache_dir)
    scored: list[dict] = []
    for b in d["blocks"]:
        B = _bigrams(b["text"])
        inter = A & B
        if not inter:
            continue
        scored.append({
            "index": b["index"],
            "coverage": round(len(inter) / len(A), 3),
            "hits": sorted(inter)[:8],
            "text": b["text"][:400],
        })
    scored.sort(key=lambda x: (-x["coverage"], x["index"]))
    all_hits: set[str] = set()
    for s in scored[:5]:
        all_hits.update(s["hits"])
    score = round(scored[0]["coverage"], 3) if scored else 0.0
    return {
        "ok": True,
        "id": pid,
        "score": score,
        "terms": sorted(A)[:24],
        "hits": sorted(all_hits)[:16],
        "blocks": scored[:max(1, min(12, blocks))],
        "totalBlocks": len(d["blocks"]),
        "chars": d["chars"],
        "language": d["language"],
        "note": "分数只是字面预筛；低分不等于不相关，请读 blocks 里的段落自己判断",
    }
