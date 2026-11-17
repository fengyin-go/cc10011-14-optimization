/**
 * 限速调节 - 额度切换领域类型。
 *
 * 业务主键：限速调节（ratelimitKey）；限速配置与配置编号（configNo）共同描述业务对象。
 * 上限降低时，在途请求已分配的旧令牌不收回，按新上限平滑重算后续批次额度。
 */

/** 旧占用的两条落库路线：计入当前新窗口，或与下一窗口分开计算 */
export type QuotaStrategy = 'carry-in-current' | 'separate-next'

/** 在途请求：已经按旧额度发出、占用旧令牌桶的请求 */
export interface InFlightRequest {
  requestId: string
  configId: number
  /** 旧额度下已分配的令牌数 */
  allocatedTokens: number
  /** 额度边界标记：在途请求固定属于旧额度，刷新后也不得重计为新请求 */
  quotaBoundary: 'old-quota'
  issuedAt: string
}

/** 后续待发请求：尚未占用任何令牌，等待按新上限排期 */
export interface PendingRequest {
  requestId: string
  demandTokens: number
}

/** 重算后的后续批次额度（一个并发窗口对应一个批次） */
export interface BatchQuota {
  batchNo: number
  /** 窗口序号：0 表示上限切换后的当前新窗口 */
  windowIndex: number
  /** 距切换时刻的窗口偏移秒数（每秒一个窗口） */
  windowOffsetSeconds: number
  /** 本窗口新令牌桶实际给出的额度 */
  quotaTokens: number
  allocatedRequestIds: string[]
  /** 额度来源：后续批次一律来自新上限令牌桶 */
  capSource: 'new-bucket'
  /** 冷却秒数加工结果：调节后该批次需要等待的冷却秒数 */
  cooldownSeconds: number
  /** 窗口偏移 + 冷却加工后的总等待秒数 */
  waitSeconds: number
}

/** 在途请求额度重算结果数据（append-only，落本地持久化供复核） */
export interface QuotaRecalcResult {
  resultId: string
  /** 限速调节主键 */
  ratelimitKey: string
  configId: number
  /** 配置编号，回看业务对象用 */
  configNo: string
  /** 生成该结果时依据的配置版本 */
  configVersion: number
  createdAt: string
  strategy: QuotaStrategy
  /** 冲突判定后采用的落库路线（中文口径，供复核） */
  persistenceRoute: string
  /** 路线取舍对本地持久化版本的影响说明 */
  routeImpactNote: string
  /** 复核依据，固定为「旧占用继续计入当前新窗口」 */
  reviewBasis: string
  oldRps: number
  newRps: number
  bucketCapacity: number
  cooldownSeconds: number
  /** 是否为上限降低场景 */
  isReduction: boolean
  /** 旧占用总量（在途请求已分配令牌合计） */
  oldOccupied: number
  inFlightCount: number
  /** 被保留、不打断的在途请求编号 */
  preservedInFlightRequestIds: string[]
  /** 当前新窗口可分配给新请求的额度 */
  currentWindowNewQuota: number
  /** 结转到下一窗口、继续抵扣新桶的旧占用（仅计入当前窗口路线可能大于 0） */
  nextWindowCarry: number
  /** 分开计算路线下单独记账的旧占用 */
  separateBooking: number
  /** 旧额度 / 新上限的额度边界证据 */
  boundary: {
    oldQuotaRequestIds: string[]
    /** 已发出请求不会被重新计为新请求 */
    reCountedAsNew: boolean
    rule: string
  }
  batches: BatchQuota[]
  totalPendingTokens: number
  allocatedTokens: number
  /** 在途请求是否全部保留（可验证结果：不中断） */
  preserved: boolean
}

/** 带版本的限速配置（并发保存用乐观锁，只有一个当前生效版本） */
export interface RateLimitConfigV2 {
  id: number
  /** 限速调节主键 */
  ratelimitKey: string
  /** 配置编号 */
  configNo: string
  targetSite: string
  /** 当前生效的每秒请求上限 */
  rpsLimit: number
  /** 上一版上限，额度切换后即旧额度 */
  previousRpsLimit: number
  bucketCapacity: number
  cooldownSeconds: number
  /** 配置版本号，单调递增 */
  version: number
  status: string
  /** 当前生效的重算结果编号，中断恢复后仍指向同一份结果 */
  effectiveResultId: string | null
  updatedAt: string
}

/** 旧占用继续计入当前新窗口待处理清单项 */
export interface PendingActionItem {
  id: string
  resultId: string
  configId: number
  configNo: string
  /** 复核依据 */
  reviewBasis: string
  kind: 'quota-recalc-review'
  status: 'pending' | 'confirmed'
  createdAt: string
  confirmedAt: string | null
}

/** 重算引擎输入 */
export interface RecalcInput {
  resultId: string
  config: RateLimitConfigV2
  /** 切换后的新上限 */
  newRps: number
  cooldownSeconds: number
  strategy: QuotaStrategy
  inFlight: InFlightRequest[]
  pending: PendingRequest[]
  now: string
}

/** 持久化根状态 */
export interface RatelimitState {
  effectiveResultId: string | null
  /** 结果 / 待办序号计数器，保证刷新后编号不重复 */
  sequence: number
}
