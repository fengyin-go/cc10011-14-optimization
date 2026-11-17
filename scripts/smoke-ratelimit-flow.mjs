/**
 * 运维操作端到端冒烟：模拟「修改上限并刷新页面」的完整操作链路。
 * 用内存版 localStorage 充当浏览器，覆盖题目可验证结果：
 *   在途请求不中断、后续批次按新上限执行、刷新/重进后同一结果、并发保存只有一个生效版本。
 */
import assert from 'node:assert/strict'

const memory = new Map()
class MemoryStorage {
  getItem(key) { return memory.has(key) ? memory.get(key) : null }
  setItem(key, value) { memory.set(key, String(value)) }
  removeItem(key) { memory.delete(key) }
  clear() { memory.clear() }
}
globalThis.window = { localStorage: new MemoryStorage() }

const service = await import('../frontend/src/api/ratelimit-service.ts')

function snapshot() {
  return {
    config: service.getConfig(),
    effective: service.getEffectiveResult(),
    results: service.getResults().length,
    pendingActions: service.getPendingActions().length,
    inFlight: service.getInFlight().length,
  }
}

console.log('运维操作端到端冒烟')

// 1. 运维进入页面：种子态
service.resetRatelimit()
let s = snapshot()
assert.equal(s.config.version, 1)
assert.equal(s.inFlight, 3)
assert.equal(s.effective, null)
console.log('  1. 进入限速调节页：配置 v1，在途请求 3 条（旧额度边界）')

// 2. 上限从 10 降到 6，按「旧占用继续计入当前新窗口」重算
let outcome = service.adjustRateLimit({
  newRps: 6, cooldownSeconds: 2, strategy: 'carry-in-current', expectedVersion: 1,
})
assert.equal(outcome.ok, true)
const r1 = outcome.result
assert.equal(r1.preserved, true, '在途请求必须全部保留')
assert.equal(r1.inFlightCount, 3)
assert.equal(r1.oldOccupied, 8)
assert.ok(r1.batches.every((b) => b.capSource === 'new-bucket'), '后续批次只能用新桶')
assert.ok(r1.batches.every((b) => b.quotaTokens <= 6), '后续批次额度不得超过新上限')
console.log(`  2. 上限 10→6：结果 ${r1.resultId}，在途 3 条全保留，首批窗口 ${r1.batches[0].windowIndex}、等待 ${r1.batches[0].waitSeconds}s`)

// 3. 刷新页面：数据层每次都从 localStorage 现读、无内存缓存，重新读取即等价于刷新后的新会话
s = {
  config: service.getConfig(),
  effective: service.getEffectiveResult(),
  results: service.getResults().length,
  pendingActions: service.getPendingActions().length,
}
assert.equal(s.config.version, 2)
assert.equal(s.config.effectiveResultId, 'QRR-0001')
assert.equal(s.effective.resultId, 'QRR-0001')
assert.equal(s.effective.boundary.reCountedAsNew, false)
console.log('  3. 刷新页面后：仍指向 QRR-0001、配置 v2，旧额度请求未被重计为新请求')

// 4. 中断恢复：结果不回退
const resumed = service.resumeAfterInterruption()
assert.equal(resumed.ok, true)
assert.equal(resumed.result.resultId, 'QRR-0001')
console.log('  4. 中断恢复：生效结果仍是 QRR-0001，未跳回先前版本')

// 5. 复核待处理项
const action = service.getPendingActions()[0]
const confirm = service.confirmPendingAction(action.id)
assert.equal(confirm.ok, true)
assert.equal(service.getPendingActions()[0].status, 'confirmed')
console.log(`  5. 运维核对快照并确认：${action.id}，复核依据「${action.reviewBasis}」`)

// 6. 切换落库路线再降一次上限（冲突点：两条路线等待时间不同）
const alt = service.adjustRateLimit({
  newRps: 4, cooldownSeconds: 1, strategy: 'separate-next', expectedVersion: 2,
})
assert.equal(alt.ok, true, alt.message)
assert.equal(alt.result.strategy, 'separate-next')
assert.equal(alt.result.batches[0].windowIndex, 1, '分开计算路线首批必须从下一窗口开始')
assert.equal(alt.result.separateBooking, alt.result.oldOccupied, '分开计算路线旧占用单独记账')
const sepView = alt.result
console.log(`  6. 再降 6→4（分开计算路线）：结果 ${sepView.resultId}，首批等待 ${sepView.batches[0].waitSeconds}s，历史结果全部保留`)

// 7. 并发保存两次配置：只允许一个当前生效版本
const v = service.getConfig().version
const patch = { targetSite: service.getConfig().targetSite, rpsLimit: 3, bucketCapacity: 10, cooldownSeconds: 1 }
const a = service.saveRateLimitConfig(patch, v)
const b = service.saveRateLimitConfig(patch, v)
assert.equal(a.ok, true)
assert.equal(b.ok, false)
assert.equal(service.getConfig().version, v + 1)
console.log(`  7. 并发保存两次：第一次成功升 v${v + 1}，第二次被 CAS 拒绝`)

// 8. 重新进入页面：同一结果、同一版本、在途台账仍区分旧额度
const again = {
  config: service.getConfig(),
  effective: service.getEffectiveResult(),
  inFlight: service.getInFlight(),
  results: service.getResults(),
}
assert.equal(again.config.effectiveResultId, alt.result.resultId)
assert.ok(again.inFlight.every((row) => row.quotaBoundary === 'old-quota'))
assert.equal(again.results.length, 2)
console.log(`  8. 重新进入：生效 ${again.effective.resultId}、v${again.config.version}，在途仍标记旧额度，2 份结果可回看`)

console.log('\n端到端冒烟全部通过：在途请求不中断，后续批次按新上限执行，刷新/重进持久一致')
