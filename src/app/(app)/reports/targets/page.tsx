'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import { formatCompactINR, plural } from '@/lib/format'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import {
  PLAN_CSV_HEADERS, achievementSeries, actualsByMonth, currentMonth, daysInMonth, emptyPlan,
  fyLabel, fyMonths, fyStartYear, hasPlan, loadPlan, monthShort, planCsvRows, productAchievements,
  recoveryNeeded, savePlan, splitAnnual, summarise, toMoneyDocs,
  type MonthAchievement, type MonthActual, type TargetPlan,
} from '@/lib/targets'
import {
  Badge, Button, Card, EmptyState, PageHeader, ProgressBar, SectionTitle, StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'

/** Whole rupees are what a plan is written in; paise only add noise here. */
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const money = (n: number) => `₹${inr.format(Math.round(Number(n) || 0))}`

const PACE_TONE = { ahead: 'green', 'on-track': 'blue', behind: 'amber' } as const

function barColor(r: MonthAchievement): string {
  if (r.status === 'hit') return 'var(--green)'
  if (r.status === 'miss') return 'var(--amber)'
  if (r.status === 'in-progress') return r.pace === 'behind' ? 'var(--amber)' : 'var(--brand)'
  return 'var(--line)'
}

function statusBadge(r: MonthAchievement) {
  if (r.status === 'unset') return <span style={{ fontSize: 12, color: 'var(--faint)' }}>Not planned</span>
  if (r.status === 'upcoming') return <Badge tone="grey" dot={false}>Upcoming</Badge>
  if (r.status === 'hit') return <Badge tone="green">Hit</Badge>
  if (r.status === 'miss') return <Badge tone="red">Missed</Badge>
  return r.pace
    ? <Badge tone={PACE_TONE[r.pace]}>{r.pace === 'ahead' ? 'Ahead of pace' : r.pace === 'behind' ? 'Behind pace' : 'On pace'}</Badge>
    : <Badge tone="blue">In progress</Badge>
}

/** Circular gauge of how the running month compares with its prorated plan. */
function AchievementRing({ pct, tone }: { pct: number; tone: string }) {
  const size = 138
  const stroke = 13
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--slate-soft)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={tone} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)}
          style={{ transition: 'stroke-dashoffset 0.7s cubic-bezier(0.22,1,0.36,1)' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div className="tf-num" style={{ fontSize: 26, fontWeight: 700, color: 'var(--ink)', lineHeight: 1.1 }}>
          {Math.round(pct)}%
        </div>
        <div style={{ fontSize: 10, fontWeight: 650, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--faint)' }}>
          of plan
        </div>
      </div>
    </div>
  )
}

/** Twelve columns: the bar is what happened, the dashed tick is what was planned. */
function YearBars({ rows, max }: { rows: MonthAchievement[]; max: number }) {
  return (
    <div className="tgt-bars">
      {rows.map(r => {
        const h = Math.max(r.actual > 0 ? 3 : 0, Math.min(100, (r.actual / max) * 100))
        const tick = Math.min(100, (r.target / max) * 100)
        return (
          <div key={r.month} className="tgt-bar-col" title={`${r.label}: ${money(r.actual)} against a ${money(r.target)} plan`}>
            <div className="tgt-bar-track">
              {r.target > 0 && <span className="tgt-tick" style={{ bottom: `${tick}%` }} />}
              <span className="tgt-bar-fill" style={{ height: `${h}%`, background: barColor(r) }} />
            </div>
            <span className={`tgt-bar-label ${r.isCurrent ? 'is-now' : ''}`}>{monthShort(r.month)}</span>
          </div>
        )
      })}
    </div>
  )
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="tgt-mini">
      <div className="tgt-mini-label">{label}</div>
      <div className="tf-num tgt-mini-value">{value}</div>
      {hint && <div className="tgt-mini-hint">{hint}</div>}
    </div>
  )
}

export default function TargetsPage() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [fy, setFy] = useState(() => fyStartYear(new Date()))
  const [plan, setPlan] = useState<TargetPlan>(emptyPlan())
  const [savedAt, setSavedAt] = useState('')

  const [annual, setAnnual] = useState('')
  const [annualBudget, setAnnualBudget] = useState('')
  const [splitMode, setSplitMode] = useState<'seasonal' | 'flat'>('seasonal')

  const [products, setProducts] = useState<{ id: string; name: string; sku: string | null }[]>([])
  const [prodForm, setProdForm] = useState({ productId: '', target: '', basis: 'amount' as 'amount' | 'qty' })

  const [actuals, setActuals] = useState<Record<string, MonthActual>>({})
  const [productActuals, setProductActuals] = useState<Record<string, { amount: number; qty: number }>>({})
  const [docCount, setDocCount] = useState(0)
  const [truncated, setTruncated] = useState(false)

  // One clock for the whole screen so the prorated figures cannot disagree.
  const now = useMemo(() => new Date(), [])
  const months = useMemo(() => fyMonths(fy), [fy])

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: membership } = await supabase
        .from('org_members').select('organization_id, organizations(name)')
        .eq('user_id', user.id).eq('is_active', true).single()
      if (!membership) { router.push('/setup'); return }

      const oid = membership.organization_id
      setOrgId(oid)
      setOrgName((membership.organizations as any)?.name || '')
      setPlan(loadPlan(oid))
      setSavedAt('')
      await Promise.all([loadYear(oid, fyStartYear(new Date())), loadProducts(oid)])
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadYear(oid: string, startYear: number) {
    const start = `${startYear}-04-01`
    const end = `${startYear + 1}-03-31`

    const [invRes, cnRes, expRes, billRes] = await Promise.all([
      supabase.from('invoices').select('id, invoice_date, taxable_amount')
        .eq('organization_id', oid).neq('status', 'cancelled')
        .gte('invoice_date', start).lte('invoice_date', end).limit(5000),
      supabase.from('credit_notes').select('credit_note_date, taxable_amount')
        .eq('organization_id', oid).neq('status', 'cancelled')
        .gte('credit_note_date', start).lte('credit_note_date', end).limit(2000),
      supabase.from('expenses').select('expense_date, amount')
        .eq('organization_id', oid)
        .gte('expense_date', start).lte('expense_date', end).limit(5000),
      supabase.from('purchase_bills').select('bill_date, taxable_amount')
        .eq('organization_id', oid).neq('status', 'cancelled')
        .gte('bill_date', start).lte('bill_date', end).limit(5000),
    ])

    const invoices = (invRes.data || []) as { id: string; invoice_date: string; taxable_amount: number }[]
    setDocCount(invoices.length + (cnRes.data || []).length)
    setTruncated((invRes.data || []).length >= 5000)

    setActuals(actualsByMonth(
      toMoneyDocs(invoices.map(i => ({ date: i.invoice_date, amount: i.taxable_amount }))),
      toMoneyDocs(((cnRes.data || []) as any[]).map(c => ({ date: c.credit_note_date, amount: c.taxable_amount }))),
      toMoneyDocs(((expRes.data || []) as any[]).map(e => ({ date: e.expense_date, amount: e.amount }))),
      toMoneyDocs(((billRes.data || []) as any[]).map(b => ({ date: b.bill_date, amount: b.taxable_amount }))),
    ))

    // Product achievement needs the invoice lines, and credit-note lines are
    // netted so a return takes the sale back out of the product's tally.
    const ids = invoices.map(i => i.id)
    const groups: string[][] = []
    for (let i = 0; i < ids.length; i += 500) groups.push(ids.slice(i, i + 500))
    const cnIds = ((cnRes.data || []) as { id?: string }[]).map(c => c.id).filter(Boolean) as string[]
    const cnGroups: string[][] = []
    for (let i = 0; i < cnIds.length; i += 500) cnGroups.push(cnIds.slice(i, i + 500))

    const [invItems, cnItems] = await Promise.all([
      Promise.all(groups.map(b => supabase.from('invoice_items')
        .select('product_id, quantity, taxable_value').in('invoice_id', b))),
      Promise.all(cnGroups.map(b => supabase.from('credit_note_items')
        .select('product_id, quantity, taxable_value').in('credit_note_id', b))),
    ])

    const tally: Record<string, { amount: number; qty: number }> = {}
    const add = (rows: any[], sign: number) => {
      for (const it of rows) {
        if (!it.product_id) continue
        const cur = tally[it.product_id] || { amount: 0, qty: 0 }
        cur.amount += (Number(it.taxable_value) || 0) * sign
        cur.qty += (Number(it.quantity) || 0) * sign
        tally[it.product_id] = cur
      }
    }
    invItems.forEach(res => add((res.data || []) as any[], 1))
    cnItems.forEach(res => add((res.data || []) as any[], -1))
    for (const k of Object.keys(tally)) {
      tally[k] = { amount: Math.round(tally[k].amount * 100) / 100, qty: Math.round(tally[k].qty * 100) / 100 }
    }
    setProductActuals(tally)
  }

  async function loadProducts(oid: string) {
    const { data } = await supabase.from('products')
      .select('id, name, sku').eq('organization_id', oid).eq('is_active', true).order('name')
    setProducts((data || []) as { id: string; name: string; sku: string | null }[])
  }

  function changeYear(year: number) {
    setFy(year)
    loadYear(orgId, year)
  }

  function commit(next: TargetPlan) {
    const saved = orgId ? savePlan(orgId, next) : { ...next, updatedAt: new Date().toISOString() }
    setPlan(saved)
    setSavedAt(saved.updatedAt)
  }

  function setMonthValue(field: 'sales' | 'expenses', month: string, raw: string) {
    const n = Number(raw.replace(/[^\d.]/g, ''))
    const next = { ...plan[field] }
    if (!n || Number.isNaN(n)) delete next[month]
    else next[month] = Math.round(n * 100) / 100
    commit({ ...plan, [field]: next })
  }

  function applyAnnual(field: 'sales' | 'expenses', raw: string, mode: 'flat' | 'seasonal') {
    const total = Number(raw.replace(/[^\d.]/g, ''))
    if (!total || total <= 0) return
    commit({ ...plan, [field]: { ...plan[field], ...splitAnnual(total, months, mode) } })
  }

  function addProductTarget() {
    const target = Number(prodForm.target.replace(/[^\d.]/g, ''))
    if (!prodForm.productId || !target || target <= 0) return
    const product = products.find(p => p.id === prodForm.productId)
    commit({
      ...plan,
      products: [
        ...plan.products.filter(p => p.productId !== prodForm.productId),
        { productId: prodForm.productId, name: product?.name || 'Product', target, basis: prodForm.basis },
      ],
    })
    setProdForm({ productId: '', target: '', basis: 'amount' })
  }

  function removeProductTarget(productId: string) {
    commit({ ...plan, products: plan.products.filter(p => p.productId !== productId) })
  }

  function clearYear() {
    if (!window.confirm(`Remove this year's sales targets and spend budget? Product targets stay.`)) return
    const next = { ...plan, sales: {}, expenses: {} }
    commit(next)
  }

  function exportPlan() {
    download(
      `taxflow-targets-${fyLabel(fy).replace('-', '')}.csv`,
      toCsv(PLAN_CSV_HEADERS, planCsvRows(salesRows, budgetRows)),
    )
  }

  const salesRows = useMemo(
    () => achievementSeries(months, plan.sales, actuals, 'sales', now),
    [months, plan.sales, actuals, now],
  )
  const budgetRows = useMemo(
    () => achievementSeries(months, plan.expenses, actuals, 'spend', now),
    [months, plan.expenses, actuals, now],
  )
  const summary = useMemo(() => summarise(salesRows, budgetRows), [salesRows, budgetRows])
  const recovery = useMemo(() => recoveryNeeded(salesRows), [salesRows])
  const prodRows = useMemo(() => productAchievements(plan.products, productActuals), [plan.products, productActuals])

  const thisMonth = salesRows.find(r => r.isCurrent) || null
  const thisBudget = budgetRows.find(r => r.isCurrent) || null
  const chartMax = Math.max(...salesRows.map(r => Math.max(r.target, r.actual)), 1)
  const planned = hasPlan(plan)
  const yearActual = salesRows.reduce((s, r) => s + r.actual, 0)
  const yearSpend = budgetRows.reduce((s, r) => s + r.actual, 0)

  if (loading) {
    return (
      <div className="page-container" style={{ maxWidth: 1240 }}>
        <div style={{ height: 84, borderRadius: 16, background: 'linear-gradient(115deg,#dbe6f7,#eef2f9)' }} />
        <div className="tf-g-4" style={{ marginTop: '1rem' }}>
          {[0, 1, 2, 3].map(i => <div key={i} style={{ height: 96, borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--line)' }} />)}
        </div>
        <div style={{ height: 300, borderRadius: 16, background: 'var(--surface)', border: '1px solid var(--line)', marginTop: '1rem' }} />
      </div>
    )
  }

  const ringPct = thisMonth
    ? (thisMonth.expected > 0 ? (thisMonth.actual / thisMonth.expected) * 100 : (thisMonth.target > 0 ? (thisMonth.actual / thisMonth.target) * 100 : 0))
    : 0
  const ringTone = thisMonth?.pace === 'behind' ? 'var(--amber)'
    : thisMonth?.pace === 'ahead' ? 'var(--green)'
    : 'var(--brand)'

  return (
    <div className="page-container" style={{ maxWidth: 1240 }}>
      <PageHeader
        eyebrow={`${orgName} · Financial year ${fyLabel(fy)}`}
        title="Targets & achievement"
        subtitle="Plan the year in one line, then measure it against the books. Everything is on taxable value — GST collected for the department is not a sale."
        actions={
          <>
            <Button variant="subtle" icon="download" onClick={exportPlan} disabled={!planned}>CSV</Button>
            <Button variant="ghost" icon="printer" onClick={() => window.print()}>Print</Button>
          </>
        }
        right={
          <div className="tab-bar" style={{ gap: 4 }}>
            {[fy - 1, fy, fy + 1].map(y => (
              <button key={y} type="button" className={`tgt-year ${y === fy ? 'is-on' : ''}`} onClick={() => changeYear(y)}>
                {fyLabel(y)}
              </button>
            ))}
          </div>
        }
      />

      <div className="tf-g-4" style={{ marginBottom: '1rem' }}>
        <StatCard
          label={`Plan for ${fyLabel(fy)}`}
          value={summary.yearTarget ? formatCompactINR(summary.yearTarget) : '—'}
          sub={summary.monthsPlanned ? `${summary.monthsPlanned} of 12 months planned` : 'No targets set yet'}
          icon="target" tone="blue"
        />
        <StatCard
          label={`Sold in ${fyLabel(fy)}`}
          value={yearActual ? formatCompactINR(yearActual) : '—'}
          sub={`${plural(docCount, 'document')} read`}
          icon="trend" tone="cyan"
          delta={summary.ytdPct === null ? null : summary.ytdPct - 100}
          deltaSuffix="vs plan"
        />
        <StatCard
          label="Months on target"
          value={summary.monthsClosed ? `${summary.monthsHit} / ${summary.monthsClosed}` : '—'}
          sub={summary.hitRate === null ? 'No closed months yet' : `${summary.hitRate}% hit rate`}
          icon="check" tone={summary.hitRate !== null && summary.hitRate >= 60 ? 'green' : 'amber'}
        />
        <StatCard
          label="Where the year lands"
          value={summary.yearTarget ? formatCompactINR(summary.yearOutlook) : '—'}
          sub={summary.yearTarget ? `${Math.round((summary.yearOutlook / summary.yearTarget) * 100)}% of the plan` : 'Set a plan to project'}
          icon="chart" tone={summary.yearTarget && summary.yearOutlook >= summary.yearTarget ? 'green' : 'violet'}
        />
      </div>

      <div className="tgt-hero-grid" style={{ marginBottom: '1rem' }}>
        <Card style={{ display: 'flex', flexDirection: 'column' }}>
          <SectionTitle icon="calendar">{thisMonth ? `${thisMonth.label} so far` : `${fyLabel(fy)} in review`}</SectionTitle>

          {thisMonth && thisMonth.target > 0 ? (
            <>
              <div className="tf-row tf-wrap" style={{ gap: 16, alignItems: 'center' }}>
                <AchievementRing pct={ringPct} tone={ringTone} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 4 }}>
                    <span className="tf-num" style={{ color: 'var(--ink)', fontWeight: 650 }}>{money(thisMonth.actual)}</span>
                    {' sold against a '}
                    <span className="tf-num" style={{ fontWeight: 650 }}>{money(thisMonth.target)}</span>
                    {' target'}
                  </div>
                  {statusBadge(thisMonth)}
                  <ProgressBar
                    value={thisMonth.target > 0 ? Math.min(100, (thisMonth.actual / thisMonth.target) * 100) : 0}
                    color={barColor(thisMonth)}
                    height={8}
                  />
                  <div style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: 6 }}>
                    {plural(thisMonth.daysLeft, 'day')} left in the month ·{' '}
                    {thisMonth.pct ?? 0}% of the full target
                  </div>
                </div>
              </div>

              <div className="tgt-mini-grid" style={{ marginTop: '0.9rem' }}>
                <MiniStat label="Expected by today" value={money(thisMonth.expected)} hint={`Day ${now.getDate()} of ${daysInMonth(currentMonth(now))}`} />
                <MiniStat label="Run rate" value={money(thisMonth.actual / Math.max(1, now.getDate()))} hint="per day so far" />
                <MiniStat label="Projected month end" value={money(thisMonth.projected)} hint="if the pace holds" />
                <MiniStat
                  label="Needed per day"
                  value={thisMonth.perDayToHit === null ? '—' : money(thisMonth.perDayToHit)}
                  hint={thisMonth.perDayToHit === 0 ? 'target already cleared' : 'to finish on plan'}
                />
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <StatRow label="Months planned" value={`${summary.monthsPlanned} of 12`} />
              <StatRow label="Closed months" value={`${summary.monthsClosed}`} tone="grey" />
              <StatRow
                label="Achieved in planned months"
                value={money(summary.ytdActual)}
                tone={summary.ytdPct !== null && summary.ytdPct >= 100 ? 'green' : 'grey'}
              />
              <StatRow label="Average achievement" value={summary.avgAchievement === null ? '—' : `${summary.avgAchievement}%`} />
              <StatRow label="Best month" value={summary.best ? `${monthShort(summary.best.month)} · ${summary.best.pct}%` : '—'} tone="green" />
              <StatRow label="Weakest month" value={summary.worst ? `${monthShort(summary.worst.month)} · ${summary.worst.pct}%` : '—'} tone="amber" />
            </div>
          )}

          {recovery && (
            <div className="tgt-callout">
              <Icon name="alert" size={14} />
              <span>
                {money(recovery.shortfall)} short of plan across {summary.monthsClosed} closed months. Clearing it needs{' '}
                <b className="tf-num">{money(recovery.perMonth)}</b> a month over the {recovery.months} months left.
              </span>
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle
            icon="chart"
            action={
              <div className="tf-row" style={{ gap: 10, fontSize: 11, color: 'var(--faint)' }}>
                <span className="tgt-key"><i style={{ background: 'var(--green)' }} /> hit</span>
                <span className="tgt-key"><i className="tgt-key-tick" /> target</span>
              </div>
            }
          >
            The year, month by month
          </SectionTitle>

          {planned ? (
            <>
              <YearBars rows={salesRows} max={chartMax} />
              <div className="tgt-bars-foot">
                <span>Peak month: <b>{summary.best ? `${monthShort(summary.best.month)} · ${money(summary.best.actual)}` : '—'}</b></span>
                <span>Year plan: <b>{money(summary.yearTarget)}</b></span>
                <span>Sold: <b>{money(yearActual)}</b></span>
              </div>
            </>
          ) : (
            <EmptyState
              icon="target"
              title="No plan for this year yet"
              message="Type an annual sales number below and TaxFlow splits it across the twelve months — evenly, or weighted for the festival season."
            />
          )}

          <div className="tgt-mini-grid" style={{ marginTop: '0.9rem' }}>
            <MiniStat label="Spend budget" value={summary.budgetYear ? money(summary.budgetYear) : '—'} hint="expenses + purchases" />
            <MiniStat label="Spend so far" value={money(yearSpend)} />
            <MiniStat
              label="Budget used"
              value={summary.budgetPct === null ? '—' : `${summary.budgetPct}%`}
              hint={summary.monthsOverBudget ? `${plural(summary.monthsOverBudget, 'month')} over` : 'within monthly limits'}
            />
            <MiniStat
              label="Pace verdict"
              value={thisMonth?.pace ? (thisMonth.pace === 'on-track' ? 'On pace' : thisMonth.pace === 'ahead' ? 'Ahead' : 'Behind') : '—'}
              hint="sales vs prorated plan"
            />
          </div>
        </Card>
      </div>

      <Card pad={false} style={{ marginBottom: '1rem' }}>
        <div style={{ padding: '1rem 1rem 0.85rem' }}>
          <SectionTitle
            icon="sparkles"
            action={planned ? <Button variant="subtle" size="sm" icon="x" onClick={clearYear}>Clear this year</Button> : undefined}
          >
            Set the plan
          </SectionTitle>

          <div className="tgt-plan-forms">
            <div className="tgt-plan-form">
              <label className="tgt-plan-label" htmlFor="annual-sales">Annual sales target</label>
              <div className="tf-row" style={{ gap: 6 }}>
                <div style={{ position: 'relative', flex: 1, minWidth: 110 }}>
                  <span className="tgt-prefix">₹</span>
                  <input
                    id="annual-sales" value={annual} inputMode="decimal" placeholder="60,00,000"
                    onChange={e => setAnnual(e.target.value.replace(/[^\d]/g, ''))}
                    className="tgt-input tgt-input-indented"
                  />
                </div>
                <select value={splitMode} onChange={e => setSplitMode(e.target.value as 'seasonal' | 'flat')} className="tgt-select" aria-label="Split method">
                  <option value="seasonal">Festival-weighted</option>
                  <option value="flat">Even months</option>
                </select>
                <Button size="sm" icon="check" onClick={() => applyAnnual('sales', annual, splitMode)} disabled={!annual}>Apply</Button>
              </div>
              <p className="tgt-plan-hint">
                {splitMode === 'seasonal'
                  ? 'October–November and March carry more of the year, the summer months less.'
                  : 'One twelfth of the year in every month.'}
              </p>
            </div>

            <div className="tgt-plan-form">
              <label className="tgt-plan-label" htmlFor="annual-budget">Annual spend budget</label>
              <div className="tf-row" style={{ gap: 6 }}>
                <div style={{ position: 'relative', flex: 1, minWidth: 110 }}>
                  <span className="tgt-prefix">₹</span>
                  <input
                    id="annual-budget" value={annualBudget} inputMode="decimal" placeholder="12,00,000"
                    onChange={e => setAnnualBudget(e.target.value.replace(/[^\d]/g, ''))}
                    className="tgt-input tgt-input-indented"
                  />
                </div>
                <Button size="sm" icon="check" onClick={() => applyAnnual('expenses', annualBudget, 'flat')} disabled={!annualBudget}>Apply</Button>
              </div>
              <p className="tgt-plan-hint">Split evenly — a monthly spending ceiling works better than a seasonal one.</p>
            </div>
          </div>

          {savedAt && (
            <div className="tgt-saved">
              <Icon name="check" size={12} /> Plan saved in this browser at{' '}
              {new Date(savedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </div>
          )}
        </div>

        <div className="table-scroll">
          <div className="tgt-grid">
            <div className="tgt-cols tgt-head">
              <span className="tgt-th">Month</span>
              <span className="tgt-th is-right">Sales target</span>
              <span className="tgt-th is-right">Achieved</span>
              <span className="tgt-th">Progress</span>
              <span className="tgt-th">Status</span>
              <span className="tgt-th is-right">Budget</span>
              <span className="tgt-th is-right">Spend</span>
            </div>

            {salesRows.map((r, i) => {
              const b = budgetRows[i]
              return (
                <div key={r.month} className={`tgt-cols tgt-row tf-tr ${r.isCurrent ? 'is-now' : ''}`}>
                  <span className="tgt-td" data-label="Month">
                    <b style={{ fontWeight: r.isCurrent ? 700 : 550 }}>{r.label}</b>
                    {r.isCurrent && <span className="tgt-now-tag">now</span>}
                  </span>
                  <span className="tgt-td is-right" data-label="Sales target">
                    <input
                      value={plan.sales[r.month] ? String(plan.sales[r.month]) : ''}
                      onChange={e => setMonthValue('sales', r.month, e.target.value)}
                      inputMode="decimal" placeholder="—" className="tgt-input tgt-cell-input"
                      aria-label={`Sales target for ${r.label}`}
                    />
                  </span>
                  <span className="tgt-td is-right tf-num" data-label="Achieved">{money(r.actual)}</span>
                  <span className="tgt-td" data-label="Progress">
                    <div className="tgt-progress">
                      <ProgressBar
                        value={r.target > 0 ? Math.min(100, (r.actual / r.target) * 100) : 0}
                        color={barColor(r)} height={6}
                      />
                      <span className="tgt-pct tf-num" style={{ color: r.pct !== null && r.pct >= 100 ? 'var(--green)' : 'var(--muted)' }}>
                        {r.pct === null ? '—' : `${r.pct}%`}
                      </span>
                    </div>
                  </span>
                  <span className="tgt-td" data-label="Status">{statusBadge(r)}</span>
                  <span className="tgt-td is-right" data-label="Budget">
                    <input
                      value={plan.expenses[r.month] ? String(plan.expenses[r.month]) : ''}
                      onChange={e => setMonthValue('expenses', r.month, e.target.value)}
                      inputMode="decimal" placeholder="—" className="tgt-input tgt-cell-input"
                      aria-label={`Spend budget for ${r.label}`}
                    />
                  </span>
                  <span className="tgt-td is-right tf-num" data-label="Spend" style={{ color: b && b.target > 0 && b.actual > b.target ? 'var(--red)' : undefined }}>
                    {money(b?.actual || 0)}
                  </span>
                </div>
              )
            })}

            <div className="tgt-cols tgt-foot">
              <span className="tgt-td" data-label="Month">{fyLabel(fy)}</span>
              <span className="tgt-td is-right tf-num" data-label="Sales target">{money(summary.yearTarget)}</span>
              <span className="tgt-td is-right tf-num" data-label="Achieved">{money(yearActual)}</span>
              <span className="tgt-td" data-label="Progress">
                {summary.ytdPct === null ? '—' : `${summary.ytdPct}% of plan so far`}
              </span>
              <span className="tgt-td" data-label="Status">
                {summary.hitRate === null ? '—' : `${summary.monthsHit}/${summary.monthsClosed} hit`}
              </span>
              <span className="tgt-td is-right tf-num" data-label="Budget">{money(summary.budgetYear)}</span>
              <span className="tgt-td is-right tf-num" data-label="Spend">{money(yearSpend)}</span>
            </div>
          </div>
        </div>

        {truncated && (
          <div className="tgt-truncation">
            Over 5,000 invoices in this year — the figures cover the first 5,000 only.
          </div>
        )}
      </Card>

      <Card pad={false} style={{ marginBottom: '1rem' }}>
        <div style={{ padding: '1rem 1rem 0.85rem' }}>
          <SectionTitle icon="box">Product targets</SectionTitle>
          <p className="tgt-plan-hint" style={{ marginTop: -4, marginBottom: 10 }}>
            Set a unit or rupee goal on the items that matter and watch them fill up. Lines not linked to a product
            are skipped, and credit-note returns are taken back out.
          </p>

          {products.length > 0 && (
            <div className="tf-row tf-wrap" style={{ gap: 8, marginBottom: '0.9rem' }}>
              <select
                value={prodForm.productId} onChange={e => setProdForm(f => ({ ...f, productId: e.target.value }))}
                className="tgt-select" style={{ minWidth: 190, maxWidth: 260 }} aria-label="Product"
              >
                <option value="">Choose product…</option>
                {products.filter(p => !plan.products.some(t => t.productId === p.id)).map(p => (
                  <option key={p.id} value={p.id}>{p.name}{p.sku ? ` · ${p.sku}` : ''}</option>
                ))}
              </select>
              <select
                value={prodForm.basis} onChange={e => setProdForm(f => ({ ...f, basis: e.target.value as 'amount' | 'qty' }))}
                className="tgt-select" aria-label="Target basis"
              >
                <option value="amount">Rupees sold</option>
                <option value="qty">Units sold</option>
              </select>
              <div style={{ position: 'relative', width: 140 }}>
                {prodForm.basis === 'amount' && <span className="tgt-prefix">₹</span>}
                <input
                  value={prodForm.target} onChange={e => setProdForm(f => ({ ...f, target: e.target.value.replace(/[^\d.]/g, '') }))}
                  inputMode="decimal" placeholder={prodForm.basis === 'amount' ? '2,00,000' : '250'}
                  className={`tgt-input ${prodForm.basis === 'amount' ? 'tgt-input-indented' : ''}`}
                  style={{ width: '100%' }} aria-label="Target value"
                />
              </div>
              <Button size="sm" icon="plus" onClick={addProductTarget} disabled={!prodForm.productId || !prodForm.target}>
                Add target
              </Button>
            </div>
          )}
        </div>

        {prodRows.length === 0 ? (
          <EmptyState
            icon="box"
            title="No product targets"
            message={products.length
              ? 'Pick your best-seller above and give it a number for the year.'
              : 'Add products first — targets follow the catalogue.'}
            action={products.length ? undefined : <Button variant="subtle" href="/products" icon="box">Manage products</Button>}
          />
        ) : (
          <div className="table-scroll">
            <div className="tgt-grid">
              <div className="tgt-cols tgt-head" style={{ gridTemplateColumns: '1.6fr 0.9fr 1fr 1.5fr 1fr 44px' }}>
                <span className="tgt-th">Product</span>
                <span className="tgt-th">Basis</span>
                <span className="tgt-th is-right">Target</span>
                <span className="tgt-th">Achievement</span>
                <span className="tgt-th is-right">Sold</span>
                <span className="tgt-th" />
              </div>
              {prodRows.map(p => (
                <div key={p.productId} className="tgt-cols tgt-row tf-tr" style={{ gridTemplateColumns: '1.6fr 0.9fr 1fr 1.5fr 1fr 44px' }}>
                  <span className="tgt-td" data-label="Product"><b style={{ fontWeight: 560 }}>{p.name}</b></span>
                  <span className="tgt-td" data-label="Basis">
                    <Badge tone="grey" dot={false}>{p.basis === 'qty' ? 'Units' : 'Rupees'}</Badge>
                  </span>
                  <span className="tgt-td is-right tf-num" data-label="Target">{p.basis === 'qty' ? p.target : money(p.target)}</span>
                  <span className="tgt-td" data-label="Achievement">
                    <div className="tgt-progress">
                      <ProgressBar
                        value={p.target > 0 ? Math.min(100, (p.actual / p.target) * 100) : 0}
                        color={p.pct !== null && p.pct >= 100 ? 'var(--green)' : 'var(--brand)'}
                        height={6}
                      />
                      <span className="tgt-pct tf-num">{p.pct === null ? '—' : `${p.pct}%`}</span>
                    </div>
                  </span>
                  <span className="tgt-td is-right tf-num" data-label="Sold">{p.basis === 'qty' ? p.actual : money(p.actual)}</span>
                  <span className="tgt-td">
                    <button type="button" className="tgt-remove" onClick={() => removeProductTarget(p.productId)} aria-label={`Remove target for ${p.name}`}>
                      <Icon name="x" size={14} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <div className="tf-row tf-wrap no-print" style={{ gap: 12, fontSize: 12, color: 'var(--muted)' }}>
        <span>Credit notes reduce the month they are dated in.</span>
        <span>Cancelled documents are excluded.</span>
        <span>The plan lives in this browser, not on a server.</span>
      </div>
      <div className="tf-row tf-wrap" style={{ gap: 14, fontSize: 12, marginTop: 8 }}>
        <Link href="/reports" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Business reports →</Link>
        <Link href="/ledger" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Party statements →</Link>
        <Link href="/reports/registers" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Statutory registers →</Link>
        <Link href="/gst/calendar" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Compliance calendar →</Link>
      </div>

      <style>{`
        .tgt-year {
          font-family: inherit; font-size: 12px; font-weight: 650; white-space: nowrap;
          color: rgba(255,255,255,0.75); background: rgba(255,255,255,0.12);
          border: 1px solid rgba(255,255,255,0.18); border-radius: 8px;
          padding: 7px 11px; cursor: pointer; min-height: 0;
        }
        .tgt-year.is-on { background: white; color: var(--brand); border-color: white; }

        .tgt-hero-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; align-items: stretch; }
        .tgt-grid { min-width: 800px; }
        .tgt-cols {
          display: grid; grid-template-columns: 1.15fr 1fr 0.95fr 1.35fr 1fr 1fr 0.9fr;
          align-items: center; gap: 12px; padding: 9px 1rem;
          border-bottom: 1px solid var(--line-soft);
        }
        .tgt-head { background: var(--surface-2); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 1; }
        .tgt-th {
          font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--faint);
        }
        .tgt-th.is-right, .tgt-td.is-right { text-align: right; }
        .tgt-td { font-size: 13px; color: var(--ink-2); }
        .tgt-row.is-now { background: var(--brand-soft); }
        .tgt-row:hover { background: #f9fbfe; }
        .tgt-row.is-now:hover { background: var(--brand-soft); }
        .tgt-foot {
          display: grid; grid-template-columns: 1.15fr 1fr 0.95fr 1.35fr 1fr 1fr 0.9fr;
          gap: 12px; padding: 11px 1rem; background: var(--surface-2);
          border-top: 1px solid var(--line); font-size: 12.5px; font-weight: 650; color: var(--ink);
        }
        .tgt-now-tag {
          display: inline-block; margin-left: 6px; font-size: 9.5px; font-weight: 750;
          letter-spacing: .06em; text-transform: uppercase; color: var(--brand);
          background: white; border: 1px solid var(--brand-ring); border-radius: 99px; padding: 1px 6px;
        }
        .tgt-input {
          font-family: inherit; font-variant-numeric: tabular-nums; font-size: 12.5px; color: var(--ink);
          border: 1px solid var(--line); border-radius: 8px; background: var(--surface);
          padding: 7px 9px; min-height: 0;
        }
        .tgt-cell-input { width: 100%; max-width: 130px; text-align: right; }
        .tgt-input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); }
        .tgt-input-indented { padding-left: 20px; }
        .tgt-prefix {
          position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
          font-size: 12px; color: var(--faint); pointer-events: none;
        }
        .tgt-select {
          font-family: inherit; font-size: 12.5px; color: var(--ink); background: var(--surface);
          border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; min-height: 0; cursor: pointer;
        }
        .tgt-select:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); }
        .tgt-progress { display: flex; align-items: center; gap: 8px; }
        .tgt-progress > div { flex: 1; min-width: 40px; }
        .tgt-pct { font-size: 11.5px; font-weight: 650; color: var(--muted); min-width: 46px; text-align: right; }

        .tgt-plan-forms { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
        .tgt-plan-form { display: flex; flex-direction: column; gap: 6px; }
        .tgt-plan-label { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); }
        .tgt-plan-hint { margin: 0; font-size: 11.5px; color: var(--faint); line-height: 1.45; }
        .tgt-saved {
          display: inline-flex; align-items: center; gap: 5px; margin-top: 0.7rem;
          font-size: 11.5px; color: var(--green);
        }
        .tgt-callout {
          display: flex; gap: 8px; align-items: flex-start; margin-top: 0.9rem;
          font-size: 12px; line-height: 1.5; color: var(--amber);
          background: var(--amber-soft); border: 1px solid #fde68a; border-radius: 10px; padding: 9px 11px;
        }
        .tgt-mini-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
        .tgt-mini {
          background: var(--surface-2); border: 1px solid var(--line-soft);
          border-radius: 10px; padding: 8px 10px; min-width: 0;
        }
        .tgt-mini-label { font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); }
        .tgt-mini-value { font-size: 15px; font-weight: 700; color: var(--ink); margin-top: 2px; }
        .tgt-mini-hint { font-size: 10.5px; color: var(--faint); margin-top: 1px; }

        .tgt-bars { display: flex; align-items: flex-end; gap: 6px; height: 168px; padding: 6px 2px 0; }
        .tgt-bar-col { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; height: 100%; }
        .tgt-bar-track {
          position: relative; flex: 1; width: 100%; max-width: 34px;
          background: linear-gradient(180deg, var(--surface-2), transparent);
          border: 1px dashed var(--line); border-radius: 7px; overflow: hidden;
        }
        .tgt-bar-fill {
          position: absolute; left: 0; right: 0; bottom: 0;
          border-radius: 6px 6px 0 0; transform-origin: bottom;
          animation: tf-grow 0.55s cubic-bezier(0.22,1,0.36,1) both;
        }
        .tgt-tick {
          position: absolute; left: -2px; right: -2px; height: 2px;
          background: #334155; border-radius: 2px; opacity: 0.75;
        }
        .tgt-bar-label { font-size: 10px; color: var(--faint); font-weight: 550; }
        .tgt-bar-label.is-now { color: var(--brand); font-weight: 750; }
        .tgt-bars-foot {
          display: flex; flex-wrap: wrap; gap: 14px; margin-top: 8px;
          font-size: 11.5px; color: var(--muted);
        }
        .tgt-key { display: inline-flex; align-items: center; gap: 4px; }
        .tgt-key i { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }
        .tgt-key-tick { width: 12px !important; height: 2px !important; border-radius: 2px !important; background: #334155 !important; }
        .tgt-remove {
          display: inline-flex; align-items: center; justify-content: center;
          width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--line);
          background: var(--surface); color: var(--faint); cursor: pointer; padding: 0; min-height: 0;
        }
        .tgt-remove:hover { color: var(--red); border-color: #fecaca; background: var(--red-soft); }
        .tgt-truncation {
          padding: 0.7rem 1rem; font-size: 12px; color: var(--amber);
          background: var(--amber-soft); border-top: 1px solid #fde68a;
        }

        @media (max-width: 1120px) {
          .tgt-hero-grid { grid-template-columns: minmax(0, 1fr); }
        }
        @media (max-width: 900px) {
          .tgt-mini-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 768px) {
          .tgt-hero-grid { gap: 0.75rem; }
          .tgt-plan-forms { grid-template-columns: minmax(0, 1fr); }
          .tgt-grid { min-width: 0; }
          .tgt-cols, .tgt-foot {
            display: flex; flex-direction: column; align-items: stretch; gap: 6px;
            background: white; border: 1px solid #e2e8f0; border-radius: 12px;
            padding: 12px; margin-bottom: 10px;
          }
          .tgt-head { display: none; }
          .tgt-td.is-right, .tgt-th.is-right { text-align: left; }
          .tgt-td::before {
            content: attr(data-label); display: block; font-size: 10px; font-weight: 700;
            letter-spacing: .05em; text-transform: uppercase; color: var(--faint); margin-bottom: 2px;
          }
          .tgt-cell-input { max-width: none; text-align: left; }
          .tgt-bars { height: 132px; gap: 3px; }
          .tgt-bar-track { max-width: none; }
          .tgt-bar-label { font-size: 8.5px; }
        }
        @media print {
          .no-print, .tgt-plan-forms, .tgt-saved, .tgt-callout { display: none !important; }
          .tgt-cell-input { border: none; background: transparent; }
        }
      `}</style>
    </div>
  )
}
