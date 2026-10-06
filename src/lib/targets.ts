// Targets, budgets and achievement. A plan is a management number, not a
// transaction, so it lives in the browser against the organisation rather than
// in the hand-managed Supabase schema — nothing to migrate, and the person who
// sets the target is the person who reads the report.
//
// Every figure here is measured on *taxable value, GST excluded*, because that
// is what a target is really about: what the business sold, not what it
// collected on behalf of the department. Credit notes reduce the month they are
// dated in, which matches how the books close.

/* ── plan model ─────────────────────────────────────────────────────────── */

export const PLAN_VERSION = 1

export interface ProductTarget {
  productId: string
  name: string
  target: number
  basis: 'amount' | 'qty'
}

export interface TargetPlan {
  version: number
  updatedAt: string
  /** 'YYYY-MM' → taxable sales target. Only months that were planned appear. */
  sales: Record<string, number>
  /** 'YYYY-MM' → spend budget (expenses plus purchase bills). */
  expenses: Record<string, number>
  products: ProductTarget[]
}

const PLAN_KEY = 'taxflow:targets:'

export function emptyPlan(): TargetPlan {
  return { version: PLAN_VERSION, updatedAt: '', sales: {}, expenses: {}, products: [] }
}

export function loadPlan(orgId: string): TargetPlan {
  if (typeof window === 'undefined' || !orgId) return emptyPlan()
  try {
    const raw = window.localStorage.getItem(PLAN_KEY + orgId)
    if (!raw) return emptyPlan()
    const parsed = JSON.parse(raw) as Partial<TargetPlan>
    return {
      version: PLAN_VERSION,
      updatedAt: parsed.updatedAt || '',
      sales: parsed.sales && typeof parsed.sales === 'object' ? parsed.sales : {},
      expenses: parsed.expenses && typeof parsed.expenses === 'object' ? parsed.expenses : {},
      products: Array.isArray(parsed.products) ? parsed.products : [],
    }
  } catch {
    return emptyPlan()
  }
}

export function savePlan(orgId: string, plan: TargetPlan): TargetPlan {
  const stamped: TargetPlan = { ...plan, updatedAt: new Date().toISOString() }
  try {
    window.localStorage.setItem(PLAN_KEY + orgId, JSON.stringify(stamped))
  } catch {
    // Private-mode quota failures must not break the screen; the plan just
    // stays for this session.
  }
  return stamped
}

export function hasPlan(plan: TargetPlan): boolean {
  return Object.keys(plan.sales).length > 0
    || Object.keys(plan.expenses).length > 0
    || plan.products.length > 0
}

/* ── calendar helpers ───────────────────────────────────────────────────── */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The financial year this date belongs to, named by its starting year. */
export function fyStartYear(date: Date = new Date()): number {
  return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1
}

export function fyLabel(startYear: number): string {
  return `${startYear}-${String(startYear + 1).slice(2)}`
}

/** The twelve 'YYYY-MM' keys of a financial year, April first. */
export function fyMonths(startYear: number): string[] {
  const out: string[] = []
  for (let i = 0; i < 12; i++) {
    const d = new Date(startYear, 3 + i, 1)
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

/** 'YYYY-MM-DD' → 'YYYY-MM'. Unparseable dates have no month. */
export function monthOf(date: string | null | undefined): string {
  if (!date) return ''
  const m = /^(\d{4})-(\d{2})/.exec(date)
  return m ? `${m[1]}-${m[2]}` : ''
}

export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(month)
  if (!m) return month
  return `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}`
}

export function monthShort(month: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(month)
  if (!m) return month
  return MONTH_SHORT[Number(m[2]) - 1]
}

export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function daysInMonth(month: string): number {
  const m = /^(\d{4})-(\d{2})/.exec(month)
  if (!m) return 30
  return new Date(Number(m[1]), Number(m[2]), 0).getDate()
}

/* ── actuals ────────────────────────────────────────────────────────────── */

/** A document reduced to what the plan cares about: when, and how much. */
export interface MoneyDoc {
  month: string
  amount: number
}

export function toMoneyDocs(rows: { date?: string | null; amount?: number | null }[]): MoneyDoc[] {
  return rows.map(r => ({ month: monthOf(r.date), amount: Number(r.amount) || 0 }))
}

export function sumByMonth(docs: MoneyDoc[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const d of docs) {
    if (!d.month) continue
    out[d.month] = round2((out[d.month] || 0) + d.amount)
  }
  return out
}

export interface MonthActual {
  sales: number
  expenses: number
  purchases: number
  /** Spend the budget is measured against: expenses + purchase bills. */
  spend: number
  invoiceCount: number
}

export function actualsByMonth(
  invoices: MoneyDoc[],
  creditNotes: MoneyDoc[],
  expenses: MoneyDoc[],
  bills: MoneyDoc[],
): Record<string, MonthActual> {
  const months: Record<string, MonthActual> = {}
  const touch = (month: string) => {
    if (!months[month]) months[month] = { sales: 0, expenses: 0, purchases: 0, spend: 0, invoiceCount: 0 }
    return months[month]
  }
  for (const d of invoices) {
    if (!d.month) continue
    const m = touch(d.month)
    m.sales = round2(m.sales + d.amount)
    m.invoiceCount += 1
  }
  for (const d of creditNotes) {
    if (!d.month) continue
    const m = touch(d.month)
    m.sales = round2(m.sales - d.amount)
  }
  for (const d of expenses) {
    if (!d.month) continue
    const m = touch(d.month)
    m.expenses = round2(m.expenses + d.amount)
  }
  for (const d of bills) {
    if (!d.month) continue
    touch(d.month).purchases = round2(touch(d.month).purchases + d.amount)
  }
  for (const key of Object.keys(months)) {
    const m = months[key]
    m.spend = round2(m.expenses + m.purchases)
  }
  return months
}

/* ── achievement ────────────────────────────────────────────────────────── */

export type MonthStatus = 'hit' | 'miss' | 'in-progress' | 'upcoming' | 'unset'
export type Pace = 'ahead' | 'on-track' | 'behind'

export interface MonthAchievement {
  month: string
  label: string
  target: number
  actual: number
  /** null when nothing was planned, so the UI can say "—" instead of 0%. */
  pct: number | null
  gap: number
  status: MonthStatus
  /** Only meaningful while the month is still running. */
  pace: Pace | null
  expected: number
  projected: number
  perDayToHit: number | null
  daysLeft: number
  isCurrent: boolean
  isPast: boolean
}

/**
 * Compare one planned month with the books. The prorated `expected` figure is
 * the honest part: 40% of the way through the month at 45% of the target is
 * ahead of plan, and a report that only shows "45% achieved" hides that.
 */
export function monthAchievement(
  month: string,
  target: number,
  actual: number,
  now: Date = new Date(),
): MonthAchievement {
  const t = round2(Number(target) || 0)
  const a = round2(Number(actual) || 0)
  const cur = currentMonth(now)
  const isCurrent = month === cur
  const isPast = month < cur

  const total = daysInMonth(month)
  const elapsed = isCurrent
    ? Math.max(1, Math.min(total, now.getDate()))
    : isPast ? total : 0
  const daysLeft = isCurrent ? Math.max(0, total - now.getDate()) : 0

  const expected = t > 0 ? round2(t * (elapsed / total)) : 0

  let projected = a
  if (isCurrent) projected = round2(elapsed > 0 ? (a / elapsed) * total : 0)
  else if (isFuture(month, cur)) projected = 0

  let perDayToHit: number | null = null
  if (isCurrent && t > 0) {
    const remaining = t - a
    perDayToHit = remaining <= 0 ? 0 : daysLeft > 0 ? round2(remaining / daysLeft) : null
  }

  let status: MonthStatus
  if (t <= 0) status = 'unset'
  else if (isFuture(month, cur)) status = 'upcoming'
  else if (isCurrent) status = 'in-progress'
  else status = a >= t ? 'hit' : 'miss'

  let pace: Pace | null = null
  if (isCurrent && expected > 0) {
    const ratio = a / expected
    pace = ratio >= 1.05 ? 'ahead' : ratio < 0.95 ? 'behind' : 'on-track'
  }

  return {
    month,
    label: monthLabel(month),
    target: t,
    actual: a,
    pct: t > 0 ? Math.round((a / t) * 1000) / 10 : null,
    gap: round2(a - t),
    status,
    pace,
    expected,
    projected,
    perDayToHit,
    daysLeft,
    isCurrent,
    isPast,
  }
}

function isFuture(month: string, current: string): boolean {
  return month > current
}

export function achievementSeries(
  months: string[],
  targets: Record<string, number>,
  actuals: Record<string, MonthActual>,
  metric: 'sales' | 'spend',
  now: Date = new Date(),
): MonthAchievement[] {
  return months.map(m => monthAchievement(
    m,
    targets[m] || 0,
    metric === 'sales' ? (actuals[m]?.sales || 0) : (actuals[m]?.spend || 0),
    now,
  ))
}

/* ── year roll-up ───────────────────────────────────────────────────────── */

export interface PlanSummary {
  monthsPlanned: number
  monthsClosed: number
  monthsHit: number
  hitRate: number | null
  ytdTarget: number
  ytdActual: number
  ytdPct: number | null
  yearTarget: number
  /** Closed months at actuals, the running month at its run rate, the rest at plan. */
  yearOutlook: number
  avgAchievement: number | null
  best: MonthAchievement | null
  worst: MonthAchievement | null
  monthsBehind: number
  budgetYear: number
  budgetSpendYtd: number
  budgetPct: number | null
  monthsOverBudget: number
}

export function summarise(
  sales: MonthAchievement[],
  budget: MonthAchievement[],
): PlanSummary {
  const planned = sales.filter(r => r.target > 0)
  const closed = planned.filter(r => r.isPast)
  const hit = closed.filter(r => r.status === 'hit')
  const soFar = planned.filter(r => r.isPast || r.isCurrent)

  const ytdTarget = round2(soFar.reduce((s, r) => s + r.target, 0))
  const ytdActual = round2(soFar.reduce((s, r) => s + r.actual, 0))

  const rated = planned.filter(r => (r.pct ?? 0) > 0)
  const best = rated.length ? rated.reduce((b, r) => ((r.pct ?? 0) > (b.pct ?? 0) ? r : b)) : null
  const worst = closed.length ? closed.reduce((w, r) => ((r.pct ?? 0) < (w.pct ?? 0) ? r : w)) : null

  const budgetSoFar = budget.filter(r => r.target > 0 && (r.isPast || r.isCurrent))
  const budgetTargetYtd = round2(budgetSoFar.reduce((s, r) => s + r.target, 0))
  const budgetSpendYtd = round2(budgetSoFar.reduce((s, r) => s + r.actual, 0))

  return {
    monthsPlanned: planned.length,
    monthsClosed: closed.length,
    monthsHit: hit.length,
    hitRate: closed.length ? Math.round((hit.length / closed.length) * 1000) / 10 : null,
    ytdTarget,
    ytdActual,
    ytdPct: ytdTarget > 0 ? Math.round((ytdActual / ytdTarget) * 1000) / 10 : null,
    yearTarget: round2(planned.reduce((s, r) => s + r.target, 0)),
    yearOutlook: round2(planned.reduce((s, r) => s + (r.isPast || r.isCurrent ? r.projected : r.target), 0)),
    avgAchievement: rated.length
      ? Math.round((rated.reduce((s, r) => s + (r.pct ?? 0), 0) / rated.length) * 10) / 10
      : null,
    best,
    worst,
    monthsBehind: closed.filter(r => r.status === 'miss').length,
    budgetYear: round2(budget.reduce((s, r) => s + r.target, 0)),
    budgetSpendYtd,
    budgetPct: budgetTargetYtd > 0 ? Math.round((budgetSpendYtd / budgetTargetYtd) * 1000) / 10 : null,
    monthsOverBudget: budgetSoFar.filter(r => r.actual > r.target).length,
  }
}

/* ── product targets ────────────────────────────────────────────────────── */

export interface ProductAchievement {
  productId: string
  name: string
  basis: 'amount' | 'qty'
  target: number
  actual: number
  pct: number | null
  gap: number
}

/**
 * `actuals` is keyed by product id with the amount and quantity sold inside the
 * window. A target is either rupees or units — mixing them would compare two
 * different things on one bar.
 */
export function productAchievements(
  targets: ProductTarget[],
  actuals: Record<string, { amount: number; qty: number }>,
): ProductAchievement[] {
  const rows = targets.map(t => {
    const hit = actuals[t.productId] || { amount: 0, qty: 0 }
    const actual = round2(t.basis === 'qty' ? hit.qty : hit.amount)
    const target = round2(Number(t.target) || 0)
    return {
      productId: t.productId,
      name: t.name,
      basis: t.basis,
      target,
      actual,
      pct: target > 0 ? Math.round((actual / target) * 1000) / 10 : null,
      gap: round2(actual - target),
    }
  })
  return rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.target - a.target)
}

/* ── planning aids ──────────────────────────────────────────────────────── */

/**
 * Indian retail seasonality, April → March: a quiet summer, the festival run in
 * October–November, and a March push as the year closes. Weights sum to 12 so
 * the average month is a normal month.
 */
export const SEASONAL_WEIGHTS = [0.75, 0.80, 0.82, 0.80, 0.90, 1.00, 1.35, 1.30, 1.05, 0.95, 1.00, 1.28]

/**
 * Break an annual number into the twelve months, either evenly or on the
 * seasonal curve. Rounding drift is absorbed by the last month so the parts
 * always add back to the whole — a plan that totals ₹1 more than the owner
 * typed is a plan they stop trusting.
 */
export function splitAnnual(
  total: number,
  months: string[],
  mode: 'flat' | 'seasonal',
): Record<string, number> {
  const out: Record<string, number> = {}
  const whole = Math.round(Number(total) || 0)
  if (!months.length || whole <= 0) return out

  const weights = mode === 'seasonal'
    ? SEASONAL_WEIGHTS
    : months.map(() => 1)
  const weightSum = weights.reduce((s, w) => s + w, 0)

  let assigned = 0
  months.forEach((m, i) => {
    if (i === months.length - 1) {
      out[m] = whole - assigned
    } else {
      const value = Math.round(whole * ((weights[i] || 1) / weightSum))
      out[m] = value
      assigned += value
    }
  })
  return out
}

/** What the next month needs, given a run rate that is not hitting the plan. */
export function recoveryNeeded(rows: MonthAchievement[]): { shortfall: number; months: number; perMonth: number } | null {
  const closed = rows.filter(r => r.target > 0 && r.isPast)
  if (!closed.length) return null
  const shortfall = round2(closed.reduce((s, r) => s + Math.max(0, r.target - r.actual), 0))
  const ahead = rows.filter(r => r.target > 0 && !r.isPast && !r.isCurrent)
  if (shortfall <= 0 || !ahead.length) return null
  return { shortfall, months: ahead.length, perMonth: round2(shortfall / ahead.length) }
}

/* ── export ─────────────────────────────────────────────────────────────── */

export function planCsvRows(
  sales: MonthAchievement[],
  budget: MonthAchievement[],
): (string | number)[][] {
  return sales.map((r, i) => {
    const b = budget[i]
    return [
      r.label,
      r.target,
      r.actual,
      r.pct === null ? '' : r.pct,
      r.gap,
      statusText(r),
      b?.target ?? 0,
      b?.actual ?? 0,
    ]
  })
}

export const PLAN_CSV_HEADERS = [
  'Month', 'Sales target', 'Achieved (taxable)', 'Achievement %', 'Gap', 'Status',
  'Budget', 'Spend',
]

function statusText(r: MonthAchievement): string {
  if (r.status === 'unset') return 'Not planned'
  if (r.status === 'upcoming') return 'Upcoming'
  if (r.status === 'in-progress') return r.pace ? `In progress — ${r.pace}` : 'In progress'
  return r.status === 'hit' ? 'Target hit' : 'Missed'
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}
