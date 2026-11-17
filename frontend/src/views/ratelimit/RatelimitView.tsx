import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import {
  addInFlightRequest,
  addPendingRequest,
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
} from '@/api/ratelimit-service'
import type {
  PendingActionItem,
  QuotaRecalcResult,
  QuotaStrategy,
  RateLimitConfigV2,
} from '@/data/ratelimit/types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('ratelimit')
const columns = [
  '配置编号',
  '目标站点',
  '每秒请求上限',
  '并发窗口',
  '令牌桶容量',
  '惩罚系数',
  '冷却秒数',
  '优先级权重',
]
const actions = ['提交校验', '启用限速', '停用限速']
const statuses = ['草稿', '待校验', '已启用', '已停用']

const STRATEGY_OPTIONS: { value: QuotaStrategy; label: string; hint: string }[] = [
  {
    value: 'carry-in-current',
    label: '旧占用继续计入当前新窗口',
    hint: '当前新窗口先抵扣旧占用，后续批次等待更短，复核依据路线',
  },
  {
    value: 'separate-next',
    label: '旧占用与下一窗口分开计算',
    hint: '旧占用单独记账，后续请求从下一窗口开始，边界更清晰',
  },
]

type Notice = { tone: 'ok' | 'error'; text: string }

export default function RatelimitView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const [config, setConfig] = useState<RateLimitConfigV2 | null>(null)
  const [inFlight, setInFlight] = useState<ReturnType<typeof getInFlight>>([])
  const [pendingQueue, setPendingQueue] = useState<ReturnType<typeof getPendingRequests>>([])
  const [results, setResults] = useState<QuotaRecalcResult[]>([])
  const [pendingActions, setPendingActions] = useState<PendingActionItem[]>([])
  const [effective, setEffective] = useState<QuotaRecalcResult | null>(null)
  const [expandedResult, setExpandedResult] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const [newRps, setNewRps] = useState('')
  const [cooldown, setCooldown] = useState('')
  const [strategy, setStrategy] = useState<QuotaStrategy>('carry-in-current')
  const [inFlightTokens, setInFlightTokens] = useState('')
  const [pendingTokens, setPendingTokens] = useState('')

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '限速调节列表读取失败')
    }
    const nextConfig = getConfig()
    setConfig(nextConfig)
    setInFlight(getInFlight())
    setPendingQueue(getPendingRequests())
    setResults(getResults())
    setPendingActions(getPendingActions())
    setEffective(getEffectiveResult())
    // 表单默认值跟随当前配置，保证页面展示的是持久化后的同一结果
    setNewRps(String(nextConfig.rpsLimit))
    setCooldown(String(nextConfig.cooldownSeconds))
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function flash(tone: Notice['tone'], text: string) {
    setNotice({ tone, text })
  }

  function runLegacyAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  /** 执行限速调节：平滑重算在途请求额度并落库 */
  function handleAdjust() {
    if (!config) {
      return
    }
    const rps = Number(newRps)
    const cool = Number(cooldown)
    const outcome = adjustRateLimit({
      newRps: rps,
      cooldownSeconds: cool,
      strategy,
      expectedVersion: config.version,
    })
    flash(outcome.ok ? 'ok' : 'error', outcome.message)
    if (outcome.ok) {
      reload()
    }
  }

  /** 并发保存两次配置：同一基准版本连写两次，CAS 只允许一个当前生效版本 */
  function handleConcurrentSave() {
    if (!config) {
      return
    }
    const rps = Number(newRps)
    const cool = Number(cooldown)
    const first = saveRateLimitConfig(
      {
        targetSite: config.targetSite,
        rpsLimit: rps,
        bucketCapacity: config.bucketCapacity,
        cooldownSeconds: cool,
      },
      config.version,
    )
    const second = saveRateLimitConfig(
      {
        targetSite: config.targetSite,
        rpsLimit: rps,
        bucketCapacity: config.bucketCapacity,
        cooldownSeconds: cool,
      },
      config.version,
    )
    flash(
      first.ok && !second.ok ? 'ok' : 'error',
      `第一次保存：${first.ok ? '成功' : '被拒绝'}；第二次保存：${second.ok ? '成功' : '被拒绝'}。${second.message}`,
    )
    reload()
  }

  function handleResume() {
    const outcome = resumeAfterInterruption()
    flash(outcome.ok ? 'ok' : 'error', outcome.message)
    reload()
  }

  function handleConfirmAction(actionId: string) {
    const result = confirmPendingAction(actionId)
    flash(result.ok ? 'ok' : 'error', result.message)
    reload()
  }

  function handleAddInFlight() {
    const result = addInFlightRequest(Number(inFlightTokens))
    flash(result.ok ? 'ok' : 'error', result.message)
    if (result.ok) {
      setInFlightTokens('')
      reload()
    }
  }

  function handleAddPending() {
    const result = addPendingRequest(Number(pendingTokens))
    flash(result.ok ? 'ok' : 'error', result.message)
    if (result.ok) {
      setPendingTokens('')
      reload()
    }
  }

  function handleReset() {
    const result = resetRatelimit()
    flash(result.ok ? 'ok' : 'error', result.message)
    setExpandedResult(null)
    reload()
  }

  const stats = [
    { label: '限速配置总数', value: total },
    { label: '已启用配置', value: rows.filter((row) => String(row.status) === '已启用').length },
    { label: '待校验配置', value: rows.filter((row) => String(row.status) === '待校验').length },
    { label: '重算结果数', value: results.length },
    { label: '待复核项', value: pendingActions.filter((item) => item.status === 'pending').length },
  ]

  return (
    <section className="page" data-module="ratelimit">
      <header className="page-head">
        <div>
          <h2>限速调节管理</h2>
          <p className="page-desc">
            上限降低时平滑重算在途请求额度：已发出请求不丢失，后续批次按新上限执行，结果与配置版本持久化到本地。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出限速调节清单
          </button>
          <button className="btn ghost" type="button" onClick={handleReset}>
            重置演示数据
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      {notice && (
        <p className={`notice-bar ${notice.tone === 'ok' ? 'notice-ok' : 'notice-error'}`}>{notice.text}</p>
      )}
      {errorMessage && <p className="notice-bar notice-error">{errorMessage}</p>}

      {/* 额度切换工作台 */}
      <article className="panel">
        <header className="panel-head">
          <h3>额度切换工作台</h3>
          <span className="panel-sub">限速调节主键：ratelimit ｜ 配置与配置编号共同描述业务对象</span>
        </header>
        {config && (
          <div className="panel-body">
            <dl className="config-grid">
              <div><dt>配置编号</dt><dd>{config.configNo}</dd></div>
              <div><dt>目标站点</dt><dd>{config.targetSite}</dd></div>
              <div><dt>当前生效上限（新）</dt><dd>{config.rpsLimit} req/s</dd></div>
              <div><dt>旧额度上限</dt><dd>{config.previousRpsLimit} req/s</dd></div>
              <div><dt>令牌桶容量</dt><dd>{config.bucketCapacity}</dd></div>
              <div><dt>冷却秒数</dt><dd>{config.cooldownSeconds} 秒</dd></div>
              <div><dt>当前生效版本</dt><dd>v{config.version}</dd></div>
              <div><dt>生效重算结果</dt><dd>{config.effectiveResultId ?? '—'}</dd></div>
            </dl>

            <div className="form-grid">
              <label className="filter-item">
                <span>新的每秒请求上限</span>
                <input value={newRps} inputMode="numeric" onChange={(event) => setNewRps(event.target.value)} />
              </label>
              <label className="filter-item">
                <span>冷却秒数（加工进批次等待）</span>
                <input value={cooldown} inputMode="numeric" onChange={(event) => setCooldown(event.target.value)} />
              </label>
              <label className="filter-item">
                <span>旧占用落库路线（冲突判定）</span>
                <select value={strategy} onChange={(event) => setStrategy(event.target.value as QuotaStrategy)}>
                  {STRATEGY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="hint-text">{STRATEGY_OPTIONS.find((option) => option.value === strategy)?.hint}</p>

            <div className="row-actions wrap">
              <button className="btn primary" type="button" onClick={handleAdjust}>
                执行在途额度重算
              </button>
              <button className="btn" type="button" onClick={handleConcurrentSave}>
                模拟并发保存两次配置
              </button>
              <button className="btn" type="button" onClick={handleResume}>
                中断恢复（不回退版本）
              </button>
            </div>
          </div>
        )}
      </article>

      {/* 在途请求台账：旧额度边界 */}
      <article className="panel">
        <header className="panel-head">
          <h3>在途请求台账（旧额度请求）</h3>
          <span className="panel-sub">
            旧占用合计 {inFlight.reduce((sum, row) => sum + row.allocatedTokens, 0)} 令牌，
            刷新后仍按旧额度边界保留，不会重计为新请求
          </span>
        </header>
        <table className="data-table">
          <thead>
            <tr>
              <th>请求编号</th>
              <th>已分配令牌（旧桶）</th>
              <th>额度边界</th>
              <th>发出时间</th>
            </tr>
          </thead>
          <tbody>
            {inFlight.map((row) => (
              <tr key={row.requestId}>
                <td>{row.requestId}</td>
                <td>{row.allocatedTokens}</td>
                <td><span className="tag tag-old">旧额度请求</span></td>
                <td>{row.issuedAt}</td>
              </tr>
            ))}
            {inFlight.length === 0 && (
              <tr><td className="empty-state" colSpan={4}>暂无在途请求</td></tr>
            )}
          </tbody>
        </table>
        <div className="inline-form">
          <label className="filter-item">
            <span>登记在途请求的已分配令牌</span>
            <input value={inFlightTokens} inputMode="numeric" onChange={(event) => setInFlightTokens(event.target.value)} />
          </label>
          <button className="btn" type="button" onClick={handleAddInFlight}>登记在途请求</button>
        </div>
      </article>

      {/* 后续待发请求 */}
      <article className="panel">
        <header className="panel-head">
          <h3>后续待发请求队列（新上限令牌桶排期）</h3>
          <span className="panel-sub">未占用任何令牌，重算后按新额度分批执行</span>
        </header>
        <table className="data-table">
          <thead>
            <tr><th>请求编号</th><th>需求令牌</th><th>额度来源</th></tr>
          </thead>
          <tbody>
            {pendingQueue.map((row) => (
              <tr key={row.requestId}>
                <td>{row.requestId}</td>
                <td>{row.demandTokens}</td>
                <td><span className="tag tag-new">新上限令牌桶</span></td>
              </tr>
            ))}
            {pendingQueue.length === 0 && (
              <tr><td className="empty-state" colSpan={3}>暂无待发请求</td></tr>
            )}
          </tbody>
        </table>
        <div className="inline-form">
          <label className="filter-item">
            <span>登记后续请求的需求令牌</span>
            <input value={pendingTokens} inputMode="numeric" onChange={(event) => setPendingTokens(event.target.value)} />
          </label>
          <button className="btn" type="button" onClick={handleAddPending}>登记后续请求</button>
        </div>
      </article>

      {/* 在途请求额度重算结果 */}
      <article className="panel">
        <header className="panel-head">
          <h3>在途请求额度重算结果（本地持久化，append-only）</h3>
          <span className="panel-sub">
            {effective
              ? `当前生效：${effective.resultId} ｜ 复核依据：${effective.reviewBasis}`
              : '尚未生成重算结果'}
          </span>
        </header>
        <table className="data-table">
          <thead>
            <tr>
              <th>结果编号</th>
              <th>配置编号 / 版本</th>
              <th>旧→新上限</th>
              <th>落库路线</th>
              <th>旧占用</th>
              <th>在途保留</th>
              <th>批次数</th>
              <th>生成时间</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            {[...results].reverse().map((result) => (
              <Fragment key={result.resultId}>
                <tr className={config?.effectiveResultId === result.resultId ? 'row-effective' : undefined}>
                  <td>
                    {result.resultId}
                    {config?.effectiveResultId === result.resultId && <span className="tag tag-live">生效中</span>}
                  </td>
                  <td>{result.configNo} / v{result.configVersion}</td>
                  <td>{result.oldRps} → {result.newRps} req/s{result.isReduction && <span className="tag tag-down">降低</span>}</td>
                  <td>{result.persistenceRoute}</td>
                  <td>{result.oldOccupied}</td>
                  <td>{result.preserved ? `${result.inFlightCount} 条全保留` : '有丢失'}</td>
                  <td>{result.batches.length}</td>
                  <td>{result.createdAt}</td>
                  <td>
                    <button
                      className="link"
                      type="button"
                      onClick={() => setExpandedResult(expandedResult === result.resultId ? null : result.resultId)}
                    >
                      {expandedResult === result.resultId ? '收起' : '展开'}
                    </button>
                  </td>
                </tr>
                {expandedResult === result.resultId && (
                  <tr key={`${result.resultId}-detail`} className="detail-row">
                    <td colSpan={9}>
                      <ResultDetail result={result} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {results.length === 0 && (
              <tr><td className="empty-state" colSpan={9}>暂无重算结果，执行在途额度重算后在此核对快照</td></tr>
            )}
          </tbody>
        </table>
      </article>

      {/* 待处理复核清单 */}
      <article className="panel">
        <header className="panel-head">
          <h3>旧占用继续计入当前新窗口 · 待处理清单</h3>
          <span className="panel-sub">动作结果落本地持久化并同步刷新，复核依据固定为「旧占用继续计入当前新窗口」</span>
        </header>
        <table className="data-table">
          <thead>
            <tr>
              <th>待处理编号</th>
              <th>关联结果</th>
              <th>配置编号</th>
              <th>复核依据</th>
              <th>状态</th>
              <th>生成时间</th>
              <th>复核时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {[...pendingActions].reverse().map((item) => (
              <tr key={item.id}>
                <td>{item.id}</td>
                <td>{item.resultId}</td>
                <td>{item.configNo}</td>
                <td>{item.reviewBasis}</td>
                <td>
                  <span className={`tag ${item.status === 'pending' ? 'tag-pending' : 'tag-done'}`}>
                    {item.status === 'pending' ? '待复核' : '已复核'}
                  </span>
                </td>
                <td>{item.createdAt}</td>
                <td>{item.confirmedAt ?? '—'}</td>
                <td>
                  {item.status === 'pending' ? (
                    <button className="link" type="button" onClick={() => handleConfirmAction(item.id)}>
                      核对确认
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
            {pendingActions.length === 0 && (
              <tr><td className="empty-state" colSpan={8}>暂无待处理项</td></tr>
            )}
          </tbody>
        </table>
      </article>

      {/* 原有模块清单（保留既有页面能力） */}
      <article className="panel">
        <header className="panel-head">
          <h3>限速配置登记清单</h3>
          <span className="panel-sub">沿用本地数据层的登记、筛选与状态流转</span>
        </header>
        <p className="status-legend">
          {statuses.map((status: string) => (
            <span key={status} className="legend-item">
              {status}：{rows.filter((row) => String(row.status) === status).length}
            </span>
          ))}
        </p>
        <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
          {filterFields.map((field) => (
            <label key={field} className="filter-item">
              <span>{field}</span>
              <input
                value={filters[field] ?? ''}
                placeholder={`按${field}检索`}
                onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
              />
            </label>
          ))}
          <button className="btn" type="submit">查询</button>
          <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
        </form>
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((column) => <th key={column}>{column}</th>)}
              <th>当前状态</th>
              <th>可执行动作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row.id)}>
                {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                <td>{row.status}</td>
                <td className="row-actions">
                  {actions.map((action) => (
                    <button key={action} className="link" type="button" onClick={() => runLegacyAction(action, row)}>
                      {action}
                    </button>
                  ))}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={columns.length + 2}>暂无限速调节数据</td>
              </tr>
            )}
          </tbody>
        </table>
        <footer className="page-foot">
          <span>共 {total} 条限速调节记录</span>
        </footer>
      </article>
    </section>
  )
}

/** 重算结果快照详情：批次额度、冷却加工、额度边界与版本证据 */
function ResultDetail({ result }: { result: QuotaRecalcResult }) {
  return (
    <div className="detail-box">
      <dl className="config-grid">
        <div><dt>限速调节主键</dt><dd>{result.ratelimitKey}</dd></div>
        <div><dt>配置编号</dt><dd>{result.configNo}</dd></div>
        <div><dt>配置版本</dt><dd>v{result.configVersion}</dd></div>
        <div><dt>冷却秒数</dt><dd>{result.cooldownSeconds} 秒</dd></div>
        <div><dt>当前新窗口新请求额度</dt><dd>{result.currentWindowNewQuota}</dd></div>
        <div><dt>结转下一窗口旧占用</dt><dd>{result.nextWindowCarry}</dd></div>
        <div><dt>分开记账旧占用</dt><dd>{result.separateBooking}</dd></div>
        <div><dt>复核依据</dt><dd>{result.reviewBasis}</dd></div>
      </dl>
      <p className="hint-text">{result.routeImpactNote}</p>
      <p className="hint-text">
        额度边界：{result.boundary.rule}；旧额度请求 {result.boundary.oldQuotaRequestIds.join('、') || '无'}；
        已发出请求重计为新请求：{result.boundary.reCountedAsNew ? '是' : '否'}
      </p>
      <table className="data-table sub-table">
        <thead>
          <tr>
            <th>批次</th>
            <th>窗口</th>
            <th>新桶额度</th>
            <th>排入请求</th>
            <th>冷却加工（秒）</th>
            <th>总等待（秒）</th>
          </tr>
        </thead>
        <tbody>
          {result.batches.map((batch) => (
            <tr key={batch.batchNo}>
              <td>第 {batch.batchNo} 批</td>
              <td>第 {batch.windowIndex} 窗口（偏移 {batch.windowOffsetSeconds} 秒）</td>
              <td>{batch.quotaTokens}</td>
              <td>{batch.allocatedRequestIds.join('、') || '空批次（额度被旧占用占满）'}</td>
              <td>{batch.cooldownSeconds}</td>
              <td>{batch.waitSeconds}</td>
            </tr>
          ))}
          {result.batches.length === 0 && (
            <tr><td className="empty-state" colSpan={6}>无后续待发请求</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
