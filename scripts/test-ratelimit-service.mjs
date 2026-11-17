/**
 * 业务编排 + 本地持久化断言测试（用内存版 localStorage 模拟浏览器与刷新）。
 * 验证：重算落库、待处理清单同步、CAS 并发只生效一个版本、中断恢复不回退、刷新后持久一致。
 */
import assert from 'node:assert/strict'

/* ---- 内存版 localStorage，必须在 import service 前装好全局 window ---- */
const memory = new Map()
class MemoryStorage {
  getItem(key) {
    return memory.has(key) ? memory.get(key) : null
  }
  setItem(key, value) {
    memory.set(key, String(value))
  }
  removeItem(key) {
    memory.delete(key)
  }
  clear() {
    memory.clear()
  }
}
globalThis.window = { localStorage: new MemoryStorage() }

const {
  adjustRateLimit,
  confirmPendingAction,
  getConfig,
  getEffectiveResult,
  getInFlight,
  getPendingActions,
  getPendingRequests,
  getResults,
  resetRatelimit,
  resumeAfterInterruption,
  saveRateLimitConfig,
} = await import('../frontend/src/api/ratelimit-service.ts')

const STORE_KEYS = [
  'scraper-strategy-studio:ratelimit:config',
  'scraper-strategy-studio:ratelimit:inflight',
  'scraper-strategy-studio:ratelimit:pending',
  'scraper-strategy-studio:ratelimit:results',
  'scraper-strategy-studio:ratelimit:pending-actions',
  'scraper-strategy-studio:ratelimit:state',
]

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

function raw(key) {
  return JSON.parse(memory.get(key))
}

console.log('限速调节业务编排与持久化测试')

check('重置后从种子启动：配置 v1、在途 3 条带旧额度边界', () => {
  resetRatelimit()
  const config = getConfig()
  assert.equal(config.version, 1)
  assert.equal(config.rpsLimit, 10)
  assert.equal(config.effectiveResultId, null)
  const inFlight = getInFlight()
  assert.equal(inFlight.length, 3)
  assert.ok(inFlight.every((row) => row.quotaBoundary === 'old-quota'))
  assert.equal(getPendingRequests().length, 6)
  assert.equal(getResults().length, 0)
})

check('上限降低重算落库：在途全保留、结果 append-only、待处理清单同步生成', () => {
  const outcome = adjustRateLimit({
    newRps: 6,
    cooldownSeconds: 2,
    strategy: 'carry-in-current',
    expectedVersion: 1,
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.result.resultId, 'QRR-0001')
  assert.equal(outcome.config.version, 2)
  assert.equal(outcome.config.previousRpsLimit, 10)
  assert.equal(outcome.config.rpsLimit, 6)
  assert.equal(outcome.config.effectiveResultId, 'QRR-0001')

  const result = getResults()[0]
  assert.equal(result.inFlightCount, 3)
  assert.equal(result.preserved, true)
  assert.equal(result.oldOccupied, 8)
  assert.equal(result.boundary.reCountedAsNew, false)
  assert.equal(result.reviewBasis, '旧占用继续计入当前新窗口')
  assert.ok(result.batches.length > 0)

  const actions = getPendingActions()
  assert.equal(actions.length, 1)
  assert.equal(actions[0].id, 'ACT-0001')
  assert.equal(actions[0].resultId, 'QRR-0001')
  assert.equal(actions[0].status, 'pending')
  assert.equal(actions[0].reviewBasis, '旧占用继续计入当前新窗口')

  // 六个持久化键全部有数据
  for (const key of STORE_KEYS) {
    assert.ok(memory.has(key), `${key} 应已写入本地持久化`)
  }
})

check('刷新页面后数据持久一致：同一结果、同一版本、旧额度边界仍可区分', () => {
  // store 每次都从 localStorage 现读，这里直接重新读取即等价于刷新后的新页面会话
  const config = getConfig()
  assert.equal(config.version, 2)
  assert.equal(config.effectiveResultId, 'QRR-0001')
  const effective = getEffectiveResult()
  assert.equal(effective.resultId, 'QRR-0001')
  assert.equal(effective.newRps, 6)
  assert.deepEqual(
    getInFlight().map((row) => row.requestId),
    effective.preservedInFlightRequestIds,
  )
  assert.ok(getInFlight().every((row) => row.quotaBoundary === 'old-quota'))
  // 原始存储里结果编号与状态指针对得上
  assert.equal(raw('scraper-strategy-studio:ratelimit:state').effectiveResultId, 'QRR-0001')
  assert.equal(raw('scraper-strategy-studio:ratelimit:results')[0].resultId, 'QRR-0001')
})

check('CAS 乐观锁：基于旧版本的保存被拒绝，只有一个当前生效版本', () => {
  const stale = saveRateLimitConfig(
    { targetSite: '商品列表采集站点', rpsLimit: 5, bucketCapacity: 10, cooldownSeconds: 1 },
    1, // 已过期的基准版本
  )
  assert.equal(stale.ok, false)
  assert.match(stale.message, /拒绝/)
  assert.equal(getConfig().version, 2)

  const fresh = saveRateLimitConfig(
    { targetSite: '商品列表采集站点', rpsLimit: 5, bucketCapacity: 10, cooldownSeconds: 1 },
    2,
  )
  assert.equal(fresh.ok, true)
  assert.equal(getConfig().version, 3)
  assert.equal(getConfig().rpsLimit, 5)
})

check('并发保存两次配置（同基准版本）：第一次成功、第二次被拒绝', () => {
  const patch = { targetSite: '商品列表采集站点', rpsLimit: 4, bucketCapacity: 10, cooldownSeconds: 1 }
  const first = saveRateLimitConfig(patch, 3)
  const second = saveRateLimitConfig(patch, 3)
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.match(second.message, /v3/)
  assert.equal(getConfig().version, 4)
})

check('中断恢复：结果不跳回先前版本，当前业务证据继续保留', () => {
  // 当前生效 QRR-0001；再做一次调节产生 QRR-0002（新上限 8 可容纳种子队列里的最大需求 4）
  const again = adjustRateLimit({
    newRps: 8,
    cooldownSeconds: 1,
    strategy: 'separate-next',
    expectedVersion: 4,
  })
  assert.equal(again.ok, true)
  assert.equal(again.result.resultId, 'QRR-0002')
  assert.equal(getConfig().version, 5)

  const resumed = resumeAfterInterruption()
  assert.equal(resumed.ok, true)
  assert.equal(resumed.result.resultId, 'QRR-0002')
  assert.match(resumed.message, /未回退/)

  // 历史结果 append-only 全部保留，生效指针只指向最新
  const results = getResults()
  assert.deepEqual(results.map((row) => row.resultId), ['QRR-0001', 'QRR-0002'])
  assert.equal(getEffectiveResult().resultId, 'QRR-0002')
  // 第二次走的是分开计算路线，证据字段保留
  assert.equal(results[1].strategy, 'separate-next')
  assert.equal(results[1].separateBooking, results[1].oldOccupied)
})

check('待处理清单复核：确认后落 confirmed，重复复核被拒绝', () => {
  const actions = getPendingActions()
  const target = actions.find((row) => row.resultId === 'QRR-0001')
  const done = confirmPendingAction(target.id)
  assert.equal(done.ok, true)
  const after = getPendingActions().find((row) => row.id === target.id)
  assert.equal(after.status, 'confirmed')
  assert.ok(after.confirmedAt)
  const dup = confirmPendingAction(target.id)
  assert.equal(dup.ok, false)
})

check('基于过期版本的调节同样被 CAS 拒绝，不产生脏结果', () => {
  const before = getResults().length
  const rejected = adjustRateLimit({
    newRps: 2,
    cooldownSeconds: 0,
    strategy: 'carry-in-current',
    expectedVersion: 1,
  })
  assert.equal(rejected.ok, false)
  assert.equal(getResults().length, before)
  assert.equal(getConfig().version, 5)
})

check('非法参数被拦截，不写库', () => {
  const bad = saveRateLimitConfig(
    { targetSite: 'x', rpsLimit: 0, bucketCapacity: 10, cooldownSeconds: 0 },
    5,
  )
  assert.equal(bad.ok, false)
  assert.equal(getConfig().version, 5)
})

check('重置清空限速域全部本地记录', () => {
  resetRatelimit()
  assert.equal(getResults().length, 0)
  assert.equal(getPendingActions().length, 0)
  assert.equal(getConfig().version, 1)
  assert.equal(raw('scraper-strategy-studio:ratelimit:state').effectiveResultId, null)
})

console.log(`\n业务与持久化测试全部通过：${passed} 项`)
