/** 限速调节域的初始演示数据：首次打开时播种，之后浏览器里的改动优先。 */
import type { InFlightRequest, PendingRequest, RateLimitConfigV2, RatelimitState } from './types'

const SEED_TIME = '2026-11-17T09:00:00.000Z'

export const RATELIMIT_SEED_CONFIG: RateLimitConfigV2 = {
  id: 1,
  ratelimitKey: 'ratelimit',
  configNo: 'RATE-0003',
  targetSite: '商品列表采集站点',
  rpsLimit: 10,
  previousRpsLimit: 10,
  bucketCapacity: 10,
  cooldownSeconds: 2,
  version: 1,
  status: '已启用',
  effectiveResultId: null,
  updatedAt: SEED_TIME,
}

/** 上限降低瞬间仍在途、已按旧额度分配令牌的请求 */
export const RATELIMIT_SEED_INFLIGHT: InFlightRequest[] = [
  { requestId: 'REQ-I-001', configId: 1, allocatedTokens: 3, quotaBoundary: 'old-quota', issuedAt: SEED_TIME },
  { requestId: 'REQ-I-002', configId: 1, allocatedTokens: 2, quotaBoundary: 'old-quota', issuedAt: SEED_TIME },
  { requestId: 'REQ-I-003', configId: 1, allocatedTokens: 3, quotaBoundary: 'old-quota', issuedAt: SEED_TIME },
]

/** 尚未发出、等待按新上限排期的后续请求 */
export const RATELIMIT_SEED_PENDING: PendingRequest[] = [
  { requestId: 'REQ-P-001', demandTokens: 2 },
  { requestId: 'REQ-P-002', demandTokens: 3 },
  { requestId: 'REQ-P-003', demandTokens: 2 },
  { requestId: 'REQ-P-004', demandTokens: 4 },
  { requestId: 'REQ-P-005', demandTokens: 1 },
  { requestId: 'REQ-P-006', demandTokens: 3 },
]

export const RATELIMIT_SEED_STATE: RatelimitState = {
  effectiveResultId: null,
  sequence: 0,
}
