// 关注列表：给「只推送已关注作者」模式用。
// 关注关系变得很慢，缓存 12 小时；拉取失败时退回旧缓存（还记得上次的结果）。
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './state.mjs'

const FILE = 'following.json'
const TTL_MS = 12 * 3600 * 1000

export function readFollowing(home) {
  const data = readJson(join(home, FILE), null)
  if (!data || !Array.isArray(data.ids)) return { ids: [], at: 0, userId: 0 }
  return { ids: data.ids, at: Number(data.at) || 0, userId: Number(data.userId) || 0 }
}

export function isFollowed(home, authorId) {
  if (!authorId) return false
  const { ids } = readFollowing(home)
  return ids.includes(Number(authorId))
}

/**
 * 取关注列表（带缓存）。
 * @returns {{ok:boolean, ids:number[], at:number, userId:number, fresh:boolean, error?:string, total:number}}
 */
export async function getFollowing({ home, callPx, maxAgeMs = TTL_MS, force = false, log = () => {} }) {
  const cached = readFollowing(home)
  const fresh = cached.at > 0 && Date.now() - cached.at < maxAgeMs
  if (!force && fresh) {
    return { ok: true, ids: cached.ids, at: cached.at, userId: cached.userId, fresh: false, total: cached.ids.length }
  }
  try {
    const res = await callPx('px_following', { limit: 1000 }, 120000)
    const ids = (res?.users || []).map((u) => Number(u.id)).filter((n) => Number.isFinite(n) && n > 0)
    const at = Date.now()
    writeJsonAtomic(join(home, FILE), { at, userId: Number(res?.userId) || 0, ids })
    log(`[following] 拉到 ${ids.length} 个关注的作者`)
    return { ok: true, ids, at, userId: Number(res?.userId) || 0, fresh: true, total: ids.length }
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 200)
    log(`[following] 拉取失败：${msg}`)
    return {
      ok: false, ids: cached.ids, at: cached.at, userId: cached.userId, fresh: false,
      error: msg, total: cached.ids.length,
    }
  }
}

// 「終末地 / 终末地」「絶区零 / 绝区零」——日文汉字与简体常差一个字。
// 只做两边都需要的常见字形归一，不追求全量繁简表。
const VARIANTS = {
  終: '终', 絶: '绝', 現: '现', 寫: '写', 畫: '画', 樣: '样', 點: '点', 體: '体', 內: '内',
  後: '后', 學: '学', 愛: '爱', 戀: '恋', 雙: '双', 觸: '触', 龍: '龙', 貓: '猫', 絲: '丝',
  襪: '袜', 從: '从', 圓: '圆', 殺: '杀', 達: '达', 陽: '阳', 陰: '阴', 樂: '乐', 遊: '游',
  說: '说', 話: '话', 為: '为', 變: '变', 際: '际', 裝: '装', 服: '服', 飾: '饰', 見: '见',
}

export function normTag(s) {
  const low = String(s || '').trim().toLowerCase()
  let out = ''
  for (const ch of low) out += VARIANTS[ch] || ch
  return out
}

/** 标签权重：喜欢的标签各 +1，不喜欢的按 dislikeWeight 累加。 */
export function tagWeight(cfg, tags) {
  const liked = new Set((cfg.keywords || []).map(normTag).filter(Boolean))
  const disliked = new Set((cfg.dislikeTags || []).map(normTag).filter(Boolean))
  const per = Number(cfg.dislikeWeight ?? -1)
  let weight = 0
  const hit = []
  const seen = new Set()
  for (const t of tags || []) {
    const name = String(t || '').trim()
    if (!name) continue
    const key = normTag(name)
    if (!key || seen.has(key)) continue   // 同一件作品里 name / translated 命中同一个词只算一次
    seen.add(key)
    if (liked.has(key)) { weight += 1; hit.push(name) }
    else if (disliked.has(key)) { weight += per }
  }
  return { weight, hit }
}

/**
 * 推送模式判定。
 * - 不超 mustPushWeight 且不关：权重 > mustPush（必推，不管关注）
 * - 否则要过 minPushWeight 且作者在关注列表里
 * @returns {{ok:boolean, code?:string, weight:number, followed:boolean, why:string}}
 */
export function judgePush({ cfg, tags, authorId, following }) {
  const { weight, hit } = tagWeight(cfg, tags)
  if (!cfg.followedOnly) {
    return { ok: true, weight, followed: false, why: '', matchedTags: hit }
  }
  const followed = following?.ids?.includes(Number(authorId)) || false
  const must = Number(cfg.mustPushWeight ?? 5)
  const min = Number(cfg.minPushWeight ?? 1)
  if (weight > must) {
    return { ok: true, weight, followed, why: `权重 ${weight} > ${must}，必推`, matchedTags: hit }
  }
  if (weight >= min && followed) {
    return { ok: true, weight, followed, why: `权重 ${weight} ≥ ${min} 且已关注该作者`, matchedTags: hit }
  }
  const why = followed
    ? `只在推送模式下推「权重 ≥${min}」的作品，这件是 ${weight}`
    : `只推已关注作者（或权重 >${must}）的作品，这件是 ${weight} 且作者未关注`
  return { ok: false, code: 'PUSH_MODE', weight, followed, why, matchedTags: hit }
}
