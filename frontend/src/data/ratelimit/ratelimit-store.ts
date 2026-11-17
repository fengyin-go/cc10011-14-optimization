/**
 * 限速调节域本地持久化。
 *
 * 沿用现有 local-store.ts 的做法：数据落在浏览器 localStorage，刷新、关掉再打开都还在；
 * 使用独立存储键，和通用模块清单（scraper-strategy-studio:entries）互不干扰。
 * 写入按整组原子覆盖，保证刷新页面后额度记录持久一致、仍能区分旧额度请求与新上限请求。
 */
import type {
  InFlightRequest,
  PendingActionItem,
  PendingRequest,
  QuotaRecalcResult,
  RateLimitConfigV2,
  RatelimitState,
} from './types'
import {
  RATELIMIT_SEED_CONFIG,
  RATELIMIT_SEED_INFLIGHT,
  RATELIMIT_SEED_PENDING,
  RATELIMIT_SEED_STATE,
} from './seed'

const KEY_CONFIG = 'scraper-strategy-studio:ratelimit:config'
const KEY_INFLIGHT = 'scraper-strategy-studio:ratelimit:inflight'
const KEY_PENDING = 'scraper-strategy-studio:ratelimit:pending'
const KEY_RESULTS = 'scraper-strategy-studio:ratelimit:results'
const KEY_ACTIONS = 'scraper-strategy-studio:ratelimit:pending-actions'
const KEY_STATE = 'scraper-strategy-studio:ratelimit:state'

export const RATELIMIT_STORAGE_KEYS = [
  KEY_CONFIG,
  KEY_INFLIGHT,
  KEY_PENDING,
  KEY_RESULTS,
  KEY_ACTIONS,
  KEY_STATE,
]

function storage(): Storage | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }
  return null
}

function readJson<T>(key: string, fallback: T): T {
  const ls = storage()
  if (!ls) {
    return fallback
  }
  const raw = ls.getItem(key)
  if (!raw) {
    ls.setItem(key, JSON.stringify(fallback))
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    // 数据损坏时回退种子，避免页面整体崩掉
    ls.setItem(key, JSON.stringify(fallback))
    return fallback
  }
}

function writeJson<T>(key: string, value: T): void {
  const ls = storage()
  if (ls) {
    ls.setItem(key, JSON.stringify(value))
  }
}

/* ---------------- 配置（带版本） ---------------- */

export function loadConfig(): RateLimitConfigV2 {
  return readJson(KEY_CONFIG, RATELIMIT_SEED_CONFIG)
}

export function saveConfig(config: RateLimitConfigV2): void {
  writeJson(KEY_CONFIG, config)
}

/* ---------------- 在途请求（旧额度边界） ---------------- */

export function loadInFlight(): InFlightRequest[] {
  return readJson(KEY_INFLIGHT, RATELIMIT_SEED_INFLIGHT)
}

export function saveInFlight(rows: InFlightRequest[]): void {
  writeJson(KEY_INFLIGHT, rows)
}

/* ---------------- 后续待发请求 ---------------- */

export function loadPendingRequests(): PendingRequest[] {
  return readJson(KEY_PENDING, RATELIMIT_SEED_PENDING)
}

export function savePendingRequests(rows: PendingRequest[]): void {
  writeJson(KEY_PENDING, rows)
}

/* ---------------- 在途请求额度重算结果（append-only） ---------------- */

export function loadResults(): QuotaRecalcResult[] {
  return readJson<QuotaRecalcResult[]>(KEY_RESULTS, [])
}

export function appendResult(result: QuotaRecalcResult): QuotaRecalcResult[] {
  const rows = loadResults()
  // 幂等保护：中断恢复重试时同一结果不重复落库
  if (rows.some((row) => row.resultId === result.resultId)) {
    return rows
  }
  const next = [...rows, result]
  writeJson(KEY_RESULTS, next)
  return next
}

/* ---------------- 旧占用继续计入当前新窗口待处理清单 ---------------- */

export function loadPendingActions(): PendingActionItem[] {
  return readJson<PendingActionItem[]>(KEY_ACTIONS, [])
}

export function savePendingActions(rows: PendingActionItem[]): void {
  writeJson(KEY_ACTIONS, rows)
}

/* ---------------- 域状态（生效结果指针 / 序号） ---------------- */

export function loadState(): RatelimitState {
  return readJson(KEY_STATE, RATELIMIT_SEED_STATE)
}

export function saveState(state: RatelimitState): void {
  writeJson(KEY_STATE, state)
}

/** 回到种子数据：清空限速域全部本地记录 */
export function resetRatelimitDomain(): void {
  writeJson(KEY_CONFIG, RATELIMIT_SEED_CONFIG)
  writeJson(KEY_INFLIGHT, RATELIMIT_SEED_INFLIGHT)
  writeJson(KEY_PENDING, RATELIMIT_SEED_PENDING)
  writeJson(KEY_RESULTS, [])
  writeJson(KEY_ACTIONS, [])
  writeJson(KEY_STATE, RATELIMIT_SEED_STATE)
}

export function ratelimitStorageKeyList(): string[] {
  return RATELIMIT_STORAGE_KEYS
}
