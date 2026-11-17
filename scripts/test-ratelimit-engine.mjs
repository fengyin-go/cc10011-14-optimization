/**
 * 重算引擎纯函数断言测试（无 DOM / localStorage 依赖）。
 * 验证：在途请求不中断、额度边界不重计、两条落库路线的窗口分配与等待时间差异、冷却秒数加工、非法输入。
 */
import assert from 'node:assert/strict'

import {
  REVIEW_BASIS,
  makeInFlightRequest,
  recalculateInFlightQuota,
  routeName,
} from '../frontend/src/data/ratelimit/recalc-engine.ts'
import { RATELIMIT_SEED_CONFIG } from '../frontend/src/data/ratelimit/seed.ts'

const NOW = '2026-11-17T10:00:00.000Z'

function baseConfig(overrides = {}) {
  return { ...RATELIMIT_SEED_CONFIG, ...overrides }
}

function pending(...demands) {
  return demands.map((demand, index) => ({ requestId: `REQ-P-${index + 1}`, demandTokens: demand }))
}

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

console.log('在途请求额度重算引擎测试')

/* 场景 A：旧占用（8）小于新上限（6 时旧占用更大），先做旧占用 > 新上限的结转场景 */
check('旧占用超过新上限：carry 路线当前窗口无新额度，结转下一窗口继续抵扣', () => {
  const config = baseConfig({ rpsLimit: 10, bucketCapacity: 10, version: 1 })
  const inFlight = [
    makeInFlightRequest('REQ-I-1', 1, 3, NOW),
    makeInFlightRequest('REQ-I-2', 1, 2, NOW),
    makeInFlightRequest('REQ-I-3', 1, 3, NOW),
  ] // 旧占用 8，新上限 6
  const result = recalculateInFlightQuota({
    resultId: 'QRR-0001',
    config,
    newRps: 6,
    cooldownSeconds: 2,
    strategy: 'carry-in-current',
    inFlight,
    pending: pending(2, 3, 2, 4),
    now: NOW,
  })

  assert.equal(result.isReduction, true)
  assert.equal(result.oldOccupied, 8)
  assert.equal(result.inFlightCount, 3)
  assert.equal(result.preserved, true)
  assert.deepEqual(result.preservedInFlightRequestIds, ['REQ-I-1', 'REQ-I-2', 'REQ-I-3'])
  // 当前窗口 6 额度全被旧占用抵扣，新请求额度 0；剩余 2 旧占用结转下一窗口
  assert.equal(result.currentWindowNewQuota, 0)
  assert.equal(result.nextWindowCarry, 2)
  // 第 0 窗口：无新请求；第 1 窗口新桶 6 被结转占 2，剩 4，顺序贪心只放下 REQ-P-1（2），
  // 再放 REQ-P-2（3）会超 4，故顺延（不会回跳选后面的 REQ-P-3）
  const first = result.batches[0]
  assert.equal(first.windowIndex, 1)
  assert.equal(first.quotaTokens, 4)
  assert.deepEqual(first.allocatedRequestIds, ['REQ-P-1'])
  // 第 2 窗口完整新桶 6：REQ-P-2（3）+ REQ-P-3（2）=5 同窗口，REQ-P-4（4）顺延单独一批
  assert.deepEqual(result.batches[1].allocatedRequestIds, ['REQ-P-2', 'REQ-P-3'])
  assert.equal(result.batches[1].windowIndex, 2)
  assert.deepEqual(result.batches[2].allocatedRequestIds, ['REQ-P-4'])
  assert.equal(result.batches[2].windowIndex, 3)
  // 全部后续请求都完成排期，额度不丢
  const scheduled = result.batches.flatMap((batch) => batch.allocatedRequestIds)
  assert.deepEqual(scheduled, ['REQ-P-1', 'REQ-P-2', 'REQ-P-3', 'REQ-P-4'])
})

check('同场景 separate 路线：当前窗口只消化旧占用，新请求一律从下一窗口开始', () => {
  const config = baseConfig({ rpsLimit: 10, bucketCapacity: 10 })
  const inFlight = [
    makeInFlightRequest('REQ-I-1', 1, 3, NOW),
    makeInFlightRequest('REQ-I-2', 1, 2, NOW),
    makeInFlightRequest('REQ-I-3', 1, 3, NOW),
  ]
  const result = recalculateInFlightQuota({
    resultId: 'QRR-0002',
    config,
    newRps: 6,
    cooldownSeconds: 2,
    strategy: 'separate-next',
    inFlight,
    pending: pending(2, 3),
    now: NOW,
  })

  assert.equal(result.currentWindowNewQuota, 0)
  assert.equal(result.separateBooking, 8)
  assert.equal(result.nextWindowCarry, 0)
  assert.equal(result.batches[0].windowIndex, 1)
  assert.equal(result.batches[0].quotaTokens, 6)
  assert.deepEqual(result.batches[0].allocatedRequestIds, ['REQ-P-1', 'REQ-P-2'])
})

check('两条路线导致后续批次得到不同的等待时间（冲突点可验证）', () => {
  const config = baseConfig({ rpsLimit: 10, bucketCapacity: 10 })
  const inFlight = [makeInFlightRequest('REQ-I-1', 1, 3, NOW)]
  const queue = pending(2)
  const carry = recalculateInFlightQuota({
    resultId: 'QRR-C', config, newRps: 6, cooldownSeconds: 0,
    strategy: 'carry-in-current', inFlight, pending: queue, now: NOW,
  })
  const separate = recalculateInFlightQuota({
    resultId: 'QRR-S', config, newRps: 6, cooldownSeconds: 0,
    strategy: 'separate-next', inFlight, pending: queue, now: NOW,
  })
  // carry：当前窗口剩 3 额度即可放行（等待 0 秒）；separate：下一窗口才放行（等待 1 秒）
  assert.equal(carry.batches[0].windowIndex, 0)
  assert.equal(carry.batches[0].waitSeconds, 0)
  assert.equal(carry.currentWindowNewQuota, 3)
  assert.equal(separate.batches[0].windowIndex, 1)
  assert.equal(separate.batches[0].waitSeconds, 1)
})

check('旧额度边界：在途请求带 old-quota 标记，不会重计为新请求', () => {
  const config = baseConfig({ rpsLimit: 10 })
  const inFlight = [makeInFlightRequest('REQ-I-1', 1, 4, NOW)]
  const result = recalculateInFlightQuota({
    resultId: 'QRR-0003', config, newRps: 5, cooldownSeconds: 0,
    strategy: 'carry-in-current', inFlight, pending: pending(1), now: NOW,
  })
  assert.equal(result.boundary.reCountedAsNew, false)
  assert.deepEqual(result.boundary.oldQuotaRequestIds, ['REQ-I-1'])
  // 在途请求不出现在任何新批次里
  for (const batch of result.batches) {
    assert.equal(batch.allocatedRequestIds.includes('REQ-I-1'), false)
    assert.equal(batch.capSource, 'new-bucket')
  }
  assert.equal(inFlight[0].quotaBoundary, 'old-quota')
})

check('冷却秒数加工进批次等待：冷却未过不提前放行', () => {
  const config = baseConfig({ rpsLimit: 10, bucketCapacity: 10 })
  // 需求 6 + 5：同窗口（上限 10）放不下第二个，强制跨到第 1 窗口
  const result = recalculateInFlightQuota({
    resultId: 'QRR-0004', config, newRps: 10, cooldownSeconds: 3,
    strategy: 'carry-in-current', inFlight: [], pending: pending(6, 5), now: NOW,
  })
  // 第 0 窗口：冷却剩余 3 秒，总等待 = 0 + 3 = 3
  assert.equal(result.batches[0].windowIndex, 0)
  assert.equal(result.batches[0].cooldownSeconds, 3)
  assert.equal(result.batches[0].waitSeconds, 3)
  // 第 1 窗口：冷却剩余 2 秒，总等待 = 1 + 2 = 3
  assert.equal(result.batches[1].windowIndex, 1)
  assert.equal(result.batches[1].cooldownSeconds, 2)
  assert.equal(result.batches[1].waitSeconds, 3)
})

check('令牌桶容量保护：每窗口额度不超过 min(新上限, 桶容量)', () => {
  const config = baseConfig({ rpsLimit: 10, bucketCapacity: 4 })
  const result = recalculateInFlightQuota({
    resultId: 'QRR-0005', config, newRps: 8, cooldownSeconds: 0,
    strategy: 'carry-in-current', inFlight: [], pending: pending(4, 4), now: NOW,
  })
  assert.equal(result.batches[0].quotaTokens, 4)
  assert.equal(result.batches.length, 2)
})

check('放不下的请求顺延，不拆分请求', () => {
  const config = baseConfig({ rpsLimit: 10, bucketCapacity: 5 })
  // 任意两个需求之和都超过单窗 5，强制每个窗口只放一个、其余顺延
  const result = recalculateInFlightQuota({
    resultId: 'QRR-0006', config, newRps: 5, cooldownSeconds: 0,
    strategy: 'carry-in-current', inFlight: [], pending: pending(3, 4, 3), now: NOW,
  })
  assert.deepEqual(result.batches[0].allocatedRequestIds, ['REQ-P-1'])
  assert.equal(result.batches[0].windowIndex, 0)
  assert.deepEqual(result.batches[1].allocatedRequestIds, ['REQ-P-2'])
  assert.equal(result.batches[1].windowIndex, 1)
  assert.deepEqual(result.batches[2].allocatedRequestIds, ['REQ-P-3'])
  assert.equal(result.batches[2].windowIndex, 2)
  assert.equal(result.allocatedTokens, 10)
})

check('请求需求超过新桶单窗口容量时显式报错，不产生静默死循环', () => {
  const config = baseConfig({ rpsLimit: 10, bucketCapacity: 4 })
  assert.throws(
    () => recalculateInFlightQuota({
      resultId: 'QRR-BAD', config, newRps: 4, cooldownSeconds: 0,
      strategy: 'carry-in-current', inFlight: [], pending: pending(5), now: NOW,
    }),
    /无法排期/,
  )
})

check('无后续请求时返回空批次，在途仍全部保留', () => {
  const config = baseConfig({ rpsLimit: 10 })
  const inFlight = [makeInFlightRequest('REQ-I-1', 1, 2, NOW)]
  const result = recalculateInFlightQuota({
    resultId: 'QRR-0007', config, newRps: 4, cooldownSeconds: 1,
    strategy: 'carry-in-current', inFlight, pending: [], now: NOW,
  })
  assert.deepEqual(result.batches, [])
  assert.equal(result.preserved, true)
  assert.equal(result.totalPendingTokens, 0)
})

check('复核依据与落库路线口径固定，配置编号/版本/主键可回看', () => {
  const config = baseConfig({ version: 7, configNo: 'RATE-0003' })
  const result = recalculateInFlightQuota({
    resultId: 'QRR-0008', config, newRps: 6, cooldownSeconds: 2,
    strategy: 'separate-next', inFlight: [], pending: pending(1), now: NOW,
  })
  assert.equal(result.reviewBasis, REVIEW_BASIS)
  assert.equal(result.reviewBasis, '旧占用继续计入当前新窗口')
  assert.equal(result.persistenceRoute, routeName('separate-next'))
  assert.equal(result.configVersion, 7)
  assert.equal(result.configNo, 'RATE-0003')
  assert.equal(result.ratelimitKey, 'ratelimit')
  assert.equal(result.cooldownSeconds, 2)
})

check('非法输入被拒绝：非正上限、负冷却、负令牌', () => {
  const config = baseConfig()
  assert.throws(
    () => recalculateInFlightQuota({
      resultId: 'X', config, newRps: 0, cooldownSeconds: 0,
      strategy: 'carry-in-current', inFlight: [], pending: [], now: NOW,
    }),
    /正整数/,
  )
  assert.throws(
    () => recalculateInFlightQuota({
      resultId: 'X', config, newRps: 5, cooldownSeconds: -1,
      strategy: 'carry-in-current', inFlight: [], pending: [], now: NOW,
    }),
    /冷却秒数/,
  )
  assert.throws(
    () => recalculateInFlightQuota({
      resultId: 'X', config, newRps: 5, cooldownSeconds: 0,
      strategy: 'carry-in-current',
      inFlight: [makeInFlightRequest('BAD', 1, -1, NOW)], pending: [], now: NOW,
    }),
    /已分配令牌/,
  )
})

console.log(`\n引擎测试全部通过：${passed} 项`)
