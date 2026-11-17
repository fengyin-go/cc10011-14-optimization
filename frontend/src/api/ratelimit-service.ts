/**
 * 限速调节业务编排：额度切换、在途请求额度重算、配置版本与待处理复核清单。
 *
 * 所有业务判断集中在这一层，页面组件只负责渲染与调用（与 local-service.ts 的约定一致）。
 */
import {
  appendResult,
  loadConfig,
  loadInFlight,
  loadPendingActions,
  loadPendingRequests,
  loadResults,
  loadState,
  resetRatelimitDomain,
  saveConfig,
  saveInFlight,
  savePendingActions,
  savePendingRequests,
  saveState,
} from '@/data/ratelimit/ratelimit-store'
import { REVIEW_BASIS, recalculateInFlightQuota, routeName } from '@/data/ratelimit/recalc-engine'
import type {
  InFlightRequest,
  PendingActionItem,
  PendingRequest,
  QuotaRecalcResult,
  QuotaStrategy,
  RateLimitConfigV2,
} from '@/data/ratelimit/types'
import type { ActionResult } from '@/data/types'

export type AdjustmentOutcome = {
  ok: boolean
  message: string
  result: QuotaRecalcResult | null
  config: RateLimitConfigV2
}

function nowIso(): string {
  return new Date().toISOString()
}

function nextSequence(): number {
  const state = loadState()
  const sequence = state.sequence + 1
  saveState({ ...state, sequence })
  return sequence
}

export function getConfig(): RateLimitConfigV2 {
  return loadConfig()
}

export function getInFlight(): InFlightRequest[] {
  return loadInFlight()
}

export function getPendingRequests(): PendingRequest[] {
  return loadPendingRequests()
}

export function getResults(): QuotaRecalcResult[] {
  return loadResults()
}

export function getPendingActions(): PendingActionItem[] {
  return loadPendingActions()
}

export function getEffectiveResult(): QuotaRecalcResult | null {
  const state = loadState()
  if (!state.effectiveResultId) {
    return null
  }
  return loadResults().find((row) => row.resultId === state.effectiveResultId) ?? null
}

/**
 * 保存限速配置（CAS 乐观锁）。
 * 并发保存两次配置时，expectedVersion 与当前版本不一致的写入会被拒绝，
 * 因此任何时刻只有一个当前生效版本。
 */
export function saveRateLimitConfig(
  patch: Pick<RateLimitConfigV2, 'targetSite' | 'rpsLimit' | 'bucketCapacity' | 'cooldownSeconds'>,
  expectedVersion: number,
): AdjustmentOutcome {
  const current = loadConfig()
  if (expectedVersion !== current.version) {
    return {
      ok: false,
      message: `配置已被其他操作更新（当前版本 v${current.version}），本次基于 v${expectedVersion} 的保存被拒绝，请刷新后重试`,
      result: null,
      config: current,
    }
  }
  if (patch.rpsLimit <= 0) {
    return { ok: false, message: '每秒请求上限必须是正整数', result: null, config: current }
  }
  if (patch.bucketCapacity <= 0) {
    return { ok: false, message: '令牌桶容量必须是正整数', result: null, config: current }
  }
  if (patch.cooldownSeconds < 0) {
    return { ok: false, message: '冷却秒数不能为负数', result: null, config: current }
  }
  const updated: RateLimitConfigV2 = {
    ...current,
    targetSite: patch.targetSite,
    rpsLimit: patch.rpsLimit,
    bucketCapacity: patch.bucketCapacity,
    cooldownSeconds: patch.cooldownSeconds,
    version: current.version + 1,
    updatedAt: nowIso(),
  }
  saveConfig(updated)
  return { ok: true, message: `配置已保存，当前生效版本 v${updated.version}`, result: null, config: updated }
}

/**
 * 限速调节主流程：上限降低时平滑重算在途请求额度并落库。
 *
 * 1. 先核对旧占用继续计入当前新窗口（在途请求已分配令牌照旧计入，不重新计为新请求）；
 * 2. 生成在途请求额度重算结果数据，append-only 写入本地持久化；
 * 3. 动作结果落到「旧占用继续计入当前新窗口」待处理清单并同步刷新；
 * 4. 配置版本 +1，生效结果指针指向本次结果——中断恢复后不会跳回先前版本。
 */
export function adjustRateLimit(params: {
  newRps: number
  cooldownSeconds: number
  strategy: QuotaStrategy
  expectedVersion: number
}): AdjustmentOutcome {
  const config = loadConfig()
  if (params.expectedVersion !== config.version) {
    return {
      ok: false,
      message: `配置版本已变化（当前 v${config.version}），本次调节基于 v${params.expectedVersion}，已拒绝并发写入`,
      result: null,
      config,
    }
  }

  const inFlight = loadInFlight()
  const pending = loadPendingRequests()
  const sequence = nextSequence()
  const resultId = `QRR-${String(sequence).padStart(4, '0')}`

  let result: QuotaRecalcResult
  try {
    result = recalculateInFlightQuota({
      resultId,
      config,
      newRps: params.newRps,
      cooldownSeconds: params.cooldownSeconds,
      strategy: params.strategy,
      inFlight,
      pending,
      now: nowIso(),
    })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '在途请求额度重算失败',
      result: null,
      config,
    }
  }

  // append-only 落库：历史结果全部保留，复核时可回看限速调节、限速配置与配置编号
  appendResult(result)

  // 配置版本推进，旧上限转入 previousRpsLimit，生效结果指针固定到本次结果
  const updatedConfig: RateLimitConfigV2 = {
    ...config,
    previousRpsLimit: config.rpsLimit,
    rpsLimit: params.newRps,
    cooldownSeconds: params.cooldownSeconds,
    version: config.version + 1,
    effectiveResultId: resultId,
    updatedAt: nowIso(),
  }
  saveConfig(updatedConfig)
  saveState({ effectiveResultId: resultId, sequence })

  // 动作结果落到待处理清单并同步刷新
  const actions = loadPendingActions()
  const action: PendingActionItem = {
    id: `ACT-${String(sequence).padStart(4, '0')}`,
    resultId,
    configId: config.id,
    configNo: config.configNo,
    reviewBasis: REVIEW_BASIS,
    kind: 'quota-recalc-review',
    status: 'pending',
    createdAt: nowIso(),
    confirmedAt: null,
  }
  savePendingActions([...actions, action])

  const waitHint =
    result.batches.length > 0 ? `首批后续请求等待 ${result.batches[0].waitSeconds} 秒` : '无待发后续请求'
  return {
    ok: true,
    message: `已按「${routeName(params.strategy)}」生成重算结果 ${resultId}：在途 ${result.inFlightCount} 条全部保留不打断，${waitHint}，配置升至 v${updatedConfig.version}`,
    result,
    config: updatedConfig,
  }
}

/** 复核待处理项：核对旧占用继续计入当前新窗口留下的当前快照 */
export function confirmPendingAction(actionId: string): ActionResult {
  const actions = loadPendingActions()
  const index = actions.findIndex((row) => row.id === actionId)
  if (index < 0) {
    return { ok: false, message: `没有找到待处理项 ${actionId}` }
  }
  if (actions[index].status === 'confirmed') {
    return { ok: false, message: '该待处理项已复核，无需重复确认' }
  }
  const next = [...actions]
  next[index] = { ...next[index], status: 'confirmed', confirmedAt: nowIso() }
  savePendingActions(next)
  return { ok: true, message: `待处理项 ${actionId} 已复核，复核依据：${REVIEW_BASIS}` }
}

/**
 * 限速调节中断后的恢复入口：按持久化的生效结果指针恢复。
 * 结果是 append-only 的，指针不回退，因此重算结果不会跳回先前版本，
 * 当前业务证据（在途台账、旧占用快照、批次排期）继续保留。
 */
export function resumeAfterInterruption(): { ok: boolean; message: string; result: QuotaRecalcResult | null } {
  const state = loadState()
  if (!state.effectiveResultId) {
    return { ok: false, message: '没有可恢复的限速调节结果', result: null }
  }
  const result = loadResults().find((row) => row.resultId === state.effectiveResultId)
  if (!result) {
    return { ok: false, message: `生效结果 ${state.effectiveResultId} 已不存在，无法恢复`, result: null }
  }
  return {
    ok: true,
    message: `已恢复生效结果 ${state.effectiveResultId}（配置 v${result.configVersion}），未回退到先前版本`,
    result,
  }
}

/** 登记一条在途请求（带旧额度边界标记，测试/演示用） */
export function addInFlightRequest(allocatedTokens: number): ActionResult {
  if (allocatedTokens <= 0) {
    return { ok: false, message: '已分配令牌必须是正整数' }
  }
  const config = loadConfig()
  const rows = loadInFlight()
  const requestId = `REQ-I-${String(rows.length + 1).padStart(3, '0')}`
  const row: InFlightRequest = {
    requestId,
    configId: config.id,
    allocatedTokens,
    quotaBoundary: 'old-quota',
    issuedAt: nowIso(),
  }
  saveInFlight([...rows, row])
  return { ok: true, message: `在途请求 ${requestId} 已登记，按旧额度边界保留` }
}

/** 登记一条后续待发请求（测试/演示用） */
export function addPendingRequest(demandTokens: number): ActionResult {
  if (demandTokens <= 0) {
    return { ok: false, message: '需求令牌必须是正整数' }
  }
  const rows = loadPendingRequests()
  const requestId = `REQ-P-${String(rows.length + 1).padStart(3, '0')}`
  savePendingRequests([...rows, { requestId, demandTokens }])
  return { ok: true, message: `后续请求 ${requestId} 已加入待发队列` }
}

export function resetRatelimit(): ActionResult {
  resetRatelimitDomain()
  return { ok: true, message: '限速调节域已重置为初始演示数据' }
}
