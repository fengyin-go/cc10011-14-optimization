/**
 * 在途请求额度重算引擎（纯函数，不读写 localStorage、不依赖 DOM）。
 *
 * 场景：每秒请求上限降低时，在途请求仍占用旧令牌。引擎读取在途请求的已分配令牌
 * 和新上限，平滑重算后续请求额度：
 *  - 在途请求一律保留，不打断、不收回旧令牌；
 *  - 后续批次只从新上限令牌桶取额度；
 *  - 旧额度请求与新上限令牌桶之间形成明确额度边界，已发出请求不会被重计为新请求。
 *
 * 两条落库路线（业务冲突点）：
 *  carry-in-current 旧占用继续计入当前新窗口：当前新窗口先被旧占用抵扣，
 *    抵扣不完的旧占用结转到下一窗口；后续批次得到更短的等待时间。
 *  separate-next 旧占用与下一窗口分开计算：当前新窗口只消化旧占用、不排新请求，
 *    旧占用单独记账，后续请求全部从下一窗口开始，等待时间更长、边界更清晰。
 */
import type {
  BatchQuota,
  InFlightRequest,
  PendingRequest,
  QuotaRecalcResult,
  QuotaStrategy,
  RecalcInput,
} from './types'

/** 复核依据（固定口径） */
export const REVIEW_BASIS = '旧占用继续计入当前新窗口'

/** 每秒一个并发窗口 */
export const WINDOW_SECONDS = 1

const STRATEGY_ROUTE: Record<QuotaStrategy, string> = {
  'carry-in-current': '旧占用继续计入当前新窗口',
  'separate-next': '旧占用与下一窗口分开计算',
}

export function routeName(strategy: QuotaStrategy): string {
  return STRATEGY_ROUTE[strategy]
}

function sumTokens(items: { allocatedTokens?: number; demandTokens?: number }[]): number {
  return items.reduce((sum, item) => sum + Number(item.allocatedTokens ?? item.demandTokens ?? 0), 0)
}

/**
 * 按新令牌桶逐窗口给后续待发请求分批。不拆分请求：当前窗口剩余额度放不下的请求
 * 顺延到下一窗口；每个窗口的额度不超过新上限（并受桶容量保护）。
 */
function buildBatches(
  pending: PendingRequest[],
  newRps: number,
  bucketCapacity: number,
  /** 第一个可发新请求的窗口序号（0 = 当前新窗口） */
  firstWindow: number,
  /** 每个窗口除旧占用外额外被占走的额度（结转抵扣），按窗口序号给出 */
  carryByWindow: Map<number, number>,
  cooldownSeconds: number,
): BatchQuota[] {
  const perWindowCap = Math.min(newRps, bucketCapacity)
  const batches: BatchQuota[] = []
  let cursor = 0
  let windowIndex = firstWindow

  while (cursor < pending.length) {
    const carry = carryByWindow.get(windowIndex) ?? 0
    const available = Math.max(0, perWindowCap - carry)
    const allocatedRequestIds: string[] = []
    let used = 0
    // 顺序贪心：完整放下一个请求才计入本批次，放不下就顺延
    while (cursor < pending.length) {
      const demand = pending[cursor].demandTokens
      if (used + demand > available) {
        break
      }
      allocatedRequestIds.push(pending[cursor].requestId)
      used += demand
      cursor += 1
    }
    if (allocatedRequestIds.length === 0) {
      // 一个请求都放不下：若头部需求超过新桶容量，任何窗口都无法承接，直接判定输入非法
      if (pending[cursor].demandTokens > perWindowCap) {
        throw new Error(
          `后续请求 ${pending[cursor].requestId} 需要 ${pending[cursor].demandTokens} 令牌，超过新令牌桶单窗口容量 ${perWindowCap}，无法排期`,
        )
      }
      // 仅因旧占用占满当前窗口而空转：跳过空批次，下一窗口再排
      windowIndex += 1
      continue
    }
    const windowOffsetSeconds = windowIndex * WINDOW_SECONDS
    batches.push({
      batchNo: batches.length + 1,
      windowIndex,
      windowOffsetSeconds,
      quotaTokens: available,
      allocatedRequestIds,
      capSource: 'new-bucket',
      // 冷却秒数加工：窗口偏移与冷却秒数取大者，保证冷却未过不提前放行
      cooldownSeconds: Math.max(cooldownSeconds - windowOffsetSeconds, 0),
      waitSeconds: windowOffsetSeconds + Math.max(cooldownSeconds - windowOffsetSeconds, 0),
    })
    windowIndex += 1
  }
  return batches
}

/** 重算在途请求额度，生成在途请求额度重算结果数据 */
export function recalculateInFlightQuota(input: RecalcInput): QuotaRecalcResult {
  const { resultId, config, newRps, cooldownSeconds, strategy, inFlight, pending, now } = input
  const oldRps = config.rpsLimit
  if (newRps <= 0 || !Number.isFinite(newRps)) {
    throw new Error('新的每秒请求上限必须是正整数')
  }
  if (cooldownSeconds < 0) {
    throw new Error('冷却秒数不能为负数')
  }
  const invalidInFlight = inFlight.find((row) => row.allocatedTokens < 0)
  if (invalidInFlight) {
    throw new Error(`在途请求 ${invalidInFlight.requestId} 的已分配令牌不能为负`)
  }

  const oldOccupied = sumTokens(inFlight)
  const totalPendingTokens = sumTokens(pending)
  const perWindowCap = Math.min(newRps, config.bucketCapacity)
  const preservedInFlightRequestIds = inFlight.map((row) => row.requestId)

  let currentWindowNewQuota: number
  let nextWindowCarry = 0
  let separateBooking = 0
  let firstWindow: number
  const carryByWindow = new Map<number, number>()

  if (strategy === 'carry-in-current') {
    // 旧占用继续计入当前新窗口：当前窗口的新桶额度先被旧占用抵扣
    if (oldOccupied >= perWindowCap) {
      currentWindowNewQuota = 0
      nextWindowCarry = oldOccupied - perWindowCap
      carryByWindow.set(0, perWindowCap)
      if (nextWindowCarry > 0) {
        // 结转的旧占用在后续窗口继续抵扣，直至摊完
        let remaining = nextWindowCarry
        let win = 1
        while (remaining > 0) {
          const hit = Math.min(remaining, perWindowCap)
          carryByWindow.set(win, hit)
          remaining -= hit
          win += 1
        }
      }
    } else {
      currentWindowNewQuota = perWindowCap - oldOccupied
      carryByWindow.set(0, oldOccupied)
    }
    firstWindow = 0
  } else {
    // 旧占用与下一窗口分开计算：当前窗口只消化旧占用，不安排新请求
    currentWindowNewQuota = 0
    separateBooking = oldOccupied
    firstWindow = 1
  }

  const batches = buildBatches(
    pending,
    newRps,
    config.bucketCapacity,
    firstWindow,
    carryByWindow,
    cooldownSeconds,
  )
  const allocatedTokens = batches.reduce((sum, batch) => {
    const tokens = batch.allocatedRequestIds.reduce((sub, requestId) => {
      const target = pending.find((row) => row.requestId === requestId)
      return sub + (target?.demandTokens ?? 0)
    }, 0)
    return sum + tokens
  }, 0)

  const boundaryRule =
    strategy === 'carry-in-current'
      ? '在途请求按旧额度边界保留，旧占用计入当前新窗口抵扣新桶；后续批次一律按新上限令牌桶取额'
      : '在途请求按旧额度边界保留并单独记账，当前新窗口不排新请求；后续批次从下一窗口起按新上限令牌桶取额'

  return {
    resultId,
    ratelimitKey: config.ratelimitKey,
    configId: config.id,
    configNo: config.configNo,
    configVersion: config.version,
    createdAt: now,
    strategy,
    persistenceRoute: STRATEGY_ROUTE[strategy],
    routeImpactNote:
      strategy === 'carry-in-current'
        ? '结果写入当前新窗口版本，旧占用占用当前窗口额度并可能结转下一窗口，本地持久化版本随本次调节 +1'
        : '结果写入下一窗口分账版本，旧占用单独记账不挤占后续批次，本地持久化版本随本次调节 +1',
    reviewBasis: REVIEW_BASIS,
    oldRps,
    newRps,
    bucketCapacity: config.bucketCapacity,
    cooldownSeconds,
    isReduction: newRps < oldRps,
    oldOccupied,
    inFlightCount: inFlight.length,
    preservedInFlightRequestIds,
    currentWindowNewQuota,
    nextWindowCarry,
    separateBooking,
    boundary: {
      oldQuotaRequestIds: preservedInFlightRequestIds,
      reCountedAsNew: false,
      rule: boundaryRule,
    },
    batches,
    totalPendingTokens,
    allocatedTokens,
    preserved: preservedInFlightRequestIds.length === inFlight.length,
  }
}

/** 工具：构造一条带旧额度边界标记的在途请求 */
export function makeInFlightRequest(
  requestId: string,
  configId: number,
  allocatedTokens: number,
  now: string,
): InFlightRequest {
  return { requestId, configId, allocatedTokens, quotaBoundary: 'old-quota', issuedAt: now }
}
