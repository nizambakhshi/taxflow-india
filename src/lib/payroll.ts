// Payroll — what a person costs, what the state takes from their pay, and which figures this
// register refuses to work out.
//
// Every billing app in India eventually gets asked the same question by an owner with three
// staff: *what do I actually owe this month?* Not "what do I bill" — what leaves my account to
// the employee, to the provident fund, to the insurance corporation, to the state, and to the
// income tax department, and by which day. The books answer part of it: `expenses` holds the
// rupees that were paid, `purchases` and `invoices` hold the paper. Nothing in this app has ever
// held a person, their salary structure, or the rules that turn a salary into four different
// liabilities with four different due dates.
//
// So this register lives on localStorage (ADR-013, `taxflow:payroll:<orgId>`) because there is
// no employee table, no salary table and no schema window to add one — and because a salary is
// the most private record a business keeps. What it holds is deliberately narrow:
//
//  * **Structure and inputs are stored; every rupee is derived.** An employee carries monthly
//    components. A month carries lost-time days, arrears, a bonus and a recovery. The gross, the
//    PF, the ESI, the tax and the take-home are computed on every load, so correcting a component
//    re-values every month that used it — the same rule the recipe book runs on (ADR-031) and the
//    reason nothing here can quietly go stale.
//  * **The rates are dated bands, each citing its own instrument.** The provident fund wage
//    ceiling moved from ₹15,000 to ₹25,000 on 17-09-2026, so a run dated before that day is
//    computed on the old ceiling and says so, in the same way the FEMA window is (ADR-032). A
//    rate table that does not know its own effective date is a rumour, and this file refuses the
//    rumour.
//  * **Where the sources disagree, the disagreement is printed.** Whether the *pensionable*
//    salary for EPS moved with the September ceiling is not settled by any document fetched for
//    this file, so the register computes EPS on a figure the owner sets (default ₹15,000) and
//    prints it as an open question rather than picking a side. Professional tax is worse: it is a
//    state subject, the fetched state tables contradict each other (one shows Gujarat at ₹200 a
//    month on salary, which Gujarat does not levy), so **there is no national table here at all**.
//    An employee's professional tax is `null` until the owner types it, which prints a dash and
//    the words "not recorded", or a real `0`, which prints zero and claims it. Absence and zero
//    are never the same row.
//  * **Tax is the employer's obligation computed the way the employer computes it.** Section 192
//    read with rule 31-33 asks for an *estimate* of the year and an equal monthly deduction of
//    what is left of it — so the walk runs April forward, projects the remaining months at the
//    current month's wages, and divides the residue by the months still to come. A bonus in June
//    raises July onwards; a December joiner carries the year in four months; a March row absorbs
//    whatever the estimate under-collected. Nothing is stored per month as "TDS deducted": the
//    figure is re-walked every load, so it cannot disagree with itself.
//  * **The default regime only, and it says so.** The register models section 115BAC — the
//    regime an employee is in unless they opt out — where HRA is not exempt and investments do not
//    reduce tax. Two consequences are printed rather than hidden: an employee aged 60 or above is
//    *refused* a tax figure (the senior schedules were not in any page fetched, and the general
//    schedule is wrong for them), and the deduction ignores 80CCD(2), the employer's own PF
//    contribution, because its limit is a percentage of salary that this register will not guess.
//    A figure computed on those terms is an upper bound, not a verdict, and the page calls it one.
//  * **A build is not a supply; a payroll run is not a payment.** This file never writes to the
//    books. `/expenses` remains the writer of the rupees that leave, `/payments` the writer of
//    money in and out, and the challans are paid on the EPFO, ESIC and income tax portals, which
//    no browser-side register can reach. What leaves this page is a computed row, a CSV, and a
//    date with a rule attached.
//  * **The 50% wage rule is watched, not applied.** The four labour codes came into force on
//    21-11-2025 and redefine "wages" with a floor: allowances beyond half of remuneration are
//    added back for statutory purposes. Guidance says the threshold is not applied mechanically
//    to provident fund calculations, and the EPFO office that administers yours settles it — so
//    an employee whose basic is under half their salary gets a flag with that citation, and their
//    PF stays computed on basic + dearness allowance.
//
// What v1 deliberately does NOT claim: no work-in-progress or accrual posting (the priced reading
// is not a journal entry), no attendance import, no per-day wage labour or contract labour, no
// overtime rate (which is a 2× statutory multiplier under the Payment of Wages Act and an
// establishment-level question), no gratuity or leave encashment provision, no LTA, no perquisite
// valuation for cars or accommodation, no old-regime computation, no NPS, no PT challan, no Form
// 16 Part A (which comes out of TRACES, not out of a browser), and no money movement of any kind.
// The one thing it does give the rest of the app is a *cost*: `costPerHour()` turns a month's
// employer cost into the rupee figure `/projects` has always printed beside a billed hour and
// never been able to state.

import { newId, todayISO } from '@/lib/batches'
import { round2 } from '@/lib/costcentres'

const KEY_PAYROLL = 'taxflow:payroll:'
/** Today's shape. A stored envelope with a different version is read as empty, not guessed at. */
const PAYROLL_VERSION = 1

// ── the rule tables, each with its own effective date and source ──────────────

/**
 * One financial year's version of the default (section 115BAC) regime: where each slab band
 * stops, what it charges there, the standard deduction, the section 87A rebate and the income
 * limit it disappears at, the surcharge cliffs, and the cess.
 *
 * Two entries with the same arithmetic are not redundancy — they are two different statements.
 * FY 2025-26 is what the portal's own salaried page for AY 2026-27 sets out; FY 2026-27 is what
 * Budget 2026 left in force, cited separately because "nothing moved" is a fact about this year
 * that has to be re-established every April rather than inherited.
 */
export interface RegimeTable {
  /** The April that opens the financial year this table governs. */
  fy_start: number
  bands: { up_to: number | null; pct: number }[]
  standard_deduction: number
  rebate_limit: number
  rebate_max: number
  /** Surcharge starts here; below it there is none. */
  surcharge_from: number
  surcharge_bands: { up_to: number | null; pct: number }[]
  cess_pct: number
  cite: string
}

export const REGIME_TABLES: RegimeTable[] = [
  {
    fy_start: 2025,
    bands: [
      { up_to: 400000, pct: 0 },
      { up_to: 800000, pct: 5 },
      { up_to: 1200000, pct: 10 },
      { up_to: 1600000, pct: 15 },
      { up_to: 2000000, pct: 20 },
      { up_to: 2400000, pct: 25 },
      { up_to: null, pct: 30 },
    ],
    standard_deduction: 75000,
    rebate_limit: 1200000,
    rebate_max: 60000,
    surcharge_from: 5000000,
    surcharge_bands: [
      { up_to: 10000000, pct: 10 },
      { up_to: 20000000, pct: 15 },
      { up_to: null, pct: 25 },
    ],
    cess_pct: 4,
    cite: 'Income Tax Department, "Salaried Individuals for AY 2026-27" (incometax.gov.in, fetched 10-10-2026): slabs to ₹4L nil, 5% to ₹8L, 10% to ₹12L, 15% to ₹16L, 20% to ₹20L, 25% to ₹24L, 30% above; rebate u/s 87A ₹60,000 up to ₹12,00,000; marginal relief at ₹50L / ₹1Cr / ₹2Cr.',
  },
  {
    fy_start: 2026,
    bands: [
      { up_to: 400000, pct: 0 },
      { up_to: 800000, pct: 5 },
      { up_to: 1200000, pct: 10 },
      { up_to: 1600000, pct: 15 },
      { up_to: 2000000, pct: 20 },
      { up_to: 2400000, pct: 25 },
      { up_to: null, pct: 30 },
    ],
    standard_deduction: 75000,
    rebate_limit: 1200000,
    rebate_max: 60000,
    surcharge_from: 5000000,
    surcharge_bands: [
      { up_to: 10000000, pct: 10 },
      { up_to: 20000000, pct: 15 },
      { up_to: null, pct: 25 },
    ],
    cess_pct: 4,
    cite: 'FY 2026-27 (AY 2027-28) — Budget 2026 continuity: CA Club India slab/rebate/marginal-relief reference (06-10-2026) and Tata Capital slab table, both listing the same bands, ₹75,000 standard deduction and ₹60,000 rebate up to ₹12,00,000. Section 115BAC is the default regime; the Income-tax Act, 2025 replaced the 1961 Act from 01-04-2026.',
  },
]

/** The table for a month, or `null` when the register does not hold that year's rates. */
export function regimeFor(month: string): RegimeTable | null {
  const start = fyStartOfMonth(month)
  return REGIME_TABLES.find(t => t.fy_start === start) ?? null
}

/**
 * The provident fund wage ceiling, as a band that knows the day it changed.
 *
 * The first band deliberately has no start date: this register does not claim to know when
 * ₹15,000 became the ceiling, only the day it stopped being it.
 */
export interface CeilingBand { from: string; ceiling: number; cite: string }

export const PF_WAGE_CEILINGS: CeilingBand[] = [
  {
    from: '',
    ceiling: 15000,
    cite: 'The ceiling in force before the September 2026 revision. No start date is claimed here.',
  },
  {
    from: '2026-09-17',
    ceiling: 25000,
    cite: 'EPFO statutory wage ceiling raised from ₹15,000 to ₹25,000 a month, effective 17-09-2026 (EY alert 17-09-2026; Ministry of Labour release 16-09-2026; the compliance note at sgcms.com cites Notification S.O. 5109(E)).',
  },
]

/** Which ceiling applied on a given day, and the sentence that says so. */
export function pfCeilingOn(date: string): { ceiling: number; cite: string } {
  let current = PF_WAGE_CEILINGS[0]
  for (const band of PF_WAGE_CEILINGS) {
    if (!band.from || date >= band.from) current = band
  }
  return { ceiling: current.ceiling, cite: current.cite }
}

/**
 * Provident fund rates. `employer_pct` is the whole employer share; `epf_share_pct` and
 * `eps_share_pct` are how that share is split inside it, and `edli_pct` and `admin_pct` are the
 * employer-only legs on top of it.
 */
export const PF_RATES = {
  employee_pct: 12,
  employer_pct: 12,
  epf_share_pct: 3.67,
  eps_share_pct: 8.33,
  edli_pct: 0.5,
  admin_pct: 0.5,
  cite: 'Employees’ Provident Funds and Miscellaneous Provisions Act, 1952 with the EPF Scheme and the Pension Scheme, 1995: employee 12% of basic + dearness allowance; employer 12%, split 8.33% to the Pension Scheme and 3.67% to the Provident Fund; EDLI 0.5% and administrative charges 0.5%, both employer-only. The split arithmetic was checked against the ceiling worked example at sgcms.com (16-09-2026).',
}

export interface EsiBand {
  from: string
  wage_limit: number
  disabled_limit: number
  employee_pct: number
  employer_pct: number
  cite: string
}

/**
 * Employee State Insurance: the wage limit that decides whether a person is covered at all, and
 * the two rates that apply once they are. The limit did *not* move when the PF ceiling did — that
 * disagreement between two statutes on the same payroll is a finding, and `/payroll` prints it.
 */
export const ESI_BANDS: EsiBand[] = [
  {
    from: '',
    wage_limit: 21000,
    disabled_limit: 25000,
    employee_pct: 0.75,
    employer_pct: 3.25,
    cite: 'ESIC Act, 1948: ₹21,000 a month gross wages (₹25,000 for persons with disability), employee 0.75% and employer 3.25%. Neither figure changed in 2026 (toolisky.com, 11-06-2026; tallysolutions.com, 11-05-2026), and both state it in the same words.',
  },
]

/**
 * Walked by date like the PF ceiling even though the table has one row today: when the corporation
 * next raises the wage limit, the row goes in with its notification date and nothing else changes.
 */
export function esiBandOn(date: string): EsiBand {
  let current = ESI_BANDS[0]
  for (const band of ESI_BANDS) {
    if (!band.from || date >= band.from) current = band
  }
  return current
}

/**
 * ESIC's own six-month calendar, which is not the financial year's and was not the calendar
 * year's either. The return dates are quoted from the same two 2026 guides and are printed with
 * that caveat: the establishment's actual period is fixed by ESIC.
 */
export interface EsiPeriod { label: string; window: string; return_due: string }

export function esiPeriodOf(month: string): EsiPeriod {
  const y = Number(month.slice(0, 4))
  const mm = Number(month.slice(5, 7))
  return mm >= 4 && mm <= 9
    ? { label: 'Apr–Sep', window: `${y}-04-01 → ${y}-09-30`, return_due: `${y}-11-11` }
    : { label: 'Oct–Mar', window: mm <= 3 ? `${y - 1}-10-01 → ${y}-03-31` : `${y}-10-01 → ${y + 1}-03-31`, return_due: mm <= 3 ? `${y}-05-11` : `${y + 1}-05-11` }
}

/** Deposit days, stated once with the source that states them. */
export const DUE_DAYS = {
  pf_esi: 15,
  tds: 7,
  form16: { month: 6, day: 15 },
  cite: 'EPF and ESI contributions are payable by the 15th of the following month, with damages escalating from 5% to 25% a year (indiafilings.com, 12-08-2026). Tax deducted from salary is deposited by the 7th of the following month, with March allowed until 30 April, and Form 16 issued by 15 June (taxguru.in FY 2026-27 compliance calendar, 15-05-2026; rule 31 of the Income tax Rules).',
}

/** The 21st of the following month is only a habit — professional tax is a state date. */
export const PT_ANNUAL_CAP = 2500
export const PT_ANNUAL_CAP_CITE = 'Section 16(iii) of the Income-tax Act caps the professional-tax deduction from salary at ₹2,500 a year, however much the state actually charges.'

/**
 * The labour codes' definition of wages. Watched and printed; never applied to a PF base here.
 */
export const WAGE_CODE_50 = {
  from: '2025-11-21',
  cite: 'The four labour codes came into force on 21-11-2025 (PIB release, 21-11-2025). "Wages" is basic pay + dearness allowance + retaining allowance, and the surplus of remuneration beyond that floor — historically capped at 50% of total — is added back for statutory purposes; guidance states the 50% threshold is not to be applied mechanically to provident fund calculations (mercans.com glossary). Your EPFO office settles what applies to your establishment.',
}

/** The panel the page prints so every figure on screen can be traced to a rule with a date. */
export interface RuleNote { head: string; body: string }

export const PAYROLL_RULES: RuleNote[] = [
  { head: 'Provident fund', body: PF_RATES.cite },
  { head: 'PF wage ceiling', body: PF_WAGE_CEILINGS[PF_WAGE_CEILINGS.length - 1].cite },
  { head: 'Employee State Insurance', body: ESI_BANDS[0].cite },
  { head: 'Deposit dates', body: DUE_DAYS.cite },
  { head: 'Income tax on salary', body: 'Section 192 of the Income-tax Act read with rules 31-33: the employer estimates the year’s salary income, computes the tax on it, and deducts the balance in equal monthly instalments over the months left. This register walks April forward and re-walks it on every load, so the figure cannot disagree with the months before it. HRA is not exempt in the default regime, so no rent paper is needed; 80CCD(2) is not modelled, so the tax printed is an upper bound.' },
  { head: 'Rebate and marginal relief', body: 'Section 87A gives a rebate of up to ₹60,000 when total income does not exceed ₹12,00,000, and marginal relief makes the tax on income just above that limit no more than the excess itself — which is why the relief binds only up to about ₹12,70,588 and disappears after it. Surcharge relief works the same way at ₹50 lakh, ₹1 crore and ₹2 crore.' },
  { head: 'Professional tax', body: 'A state subject. There is no national rate to ship, and the state tables fetched for this file contradict one another, so the owner types what their state charges — or `0` when it charges nothing. Section 16(iii) caps the deduction at ₹2,500 a year.' },
  { head: 'The 50% wage rule', body: WAGE_CODE_50.cite },
]

// ── the register ──────────────────────────────────────────────────────────────

export type AgeBand = 'below_60' | '60_to_80' | 'above_80'
export type PfMode = 'ceiling' | 'actual' | 'out'

export interface AgeMeta { label: string; modelled: boolean; note: string }

export const AGE_META: Record<AgeBand, AgeMeta> = {
  below_60: { label: 'Below 60', modelled: true, note: 'The general schedule — the one this register holds.' },
  '60_to_80': {
    label: '60 to 80', modelled: false,
    note: 'A senior citizen has a higher basic exemption under the same regime. That schedule is not in the tables this file was built from, so no tax figure is computed rather than the general one being used by mistake.',
  },
  above_80: {
    label: 'Above 80', modelled: false,
    note: 'An 80+ employee has a still higher basic exemption. Not modelled here; the tax row prints a dash and the reason.',
  },
}

export const AGE_BANDS = (Object.keys(AGE_META) as AgeBand[]).map(value => ({
  value, label: AGE_META[value].label, note: AGE_META[value].note,
}))

/**
 * A PF mode, in the words an owner would use. `ceiling` is the statutory default; `actual` is the
 * "higher wages" contribution both sides agree to; `out` is a person the fund does not reach.
 */
export interface PfModeMeta { label: string; note: string }

export const PF_MODE_META: Record<PfMode, PfModeMeta> = {
  ceiling: { label: 'On the ceiling', note: '12% of basic + DA up to the statutory wage ceiling for the month.' },
  actual: { label: 'On full basic', note: 'Above the ceiling by agreement of employer and employee — the whole of basic + DA carries the contribution.' },
  out: { label: 'Outside PF', note: 'No provident fund for this person — a consultant, an exempt establishment, or an opted-out class. The row prints nothing rather than ₹0 of a fund they are not in.' },
}

export const PF_MODES = (Object.keys(PF_MODE_META) as PfMode[]).map(value => ({
  value, label: PF_MODE_META[value].label, note: PF_MODE_META[value].note,
}))

/** The six monthly components a salary is written as. Order matters: it is the payslip's order. */
export interface Components {
  basic: number
  da: number
  hra: number
  conveyance: number
  medical: number
  special: number
}

export const COMPONENT_LABELS: { key: keyof Components; label: string; in_pf: boolean; in_esi: boolean }[] = [
  { key: 'basic', label: 'Basic pay', in_pf: true, in_esi: true },
  { key: 'da', label: 'Dearness allowance', in_pf: true, in_esi: true },
  { key: 'hra', label: 'House rent allowance', in_pf: false, in_esi: true },
  { key: 'conveyance', label: 'Conveyance allowance', in_pf: false, in_esi: true },
  { key: 'medical', label: 'Medical allowance', in_pf: false, in_esi: true },
  { key: 'special', label: 'Special allowance', in_pf: false, in_esi: true },
]

export interface Employee {
  id: string
  name: string
  /** The shop's own payroll number — "E-07", "P-114". */
  code: string
  role: string
  /** Where the work is actually done. GST state codes, the same list the documents use. */
  state_code: string
  pan: string
  uan: string
  esi_no: string
  join_date: string
  /** '' = still on the rolls. */
  leave_date: string
  active: boolean
  components: Components
  pf_mode: PfMode
  disabled: boolean
  /** `null` = the owner has not said what the state charges. `0` = the state charges nothing. */
  pt_monthly: number | null
  hours_per_day: number
  age_band: AgeBand
  notes: string
  created_at: string
}

/**
 * What one month of one employee's life adds or removes. Only these four numbers are stored per
 * month; every rupee around them is computed.
 */
export interface PayInput {
  id: string
  employee_id: string
  month: string
  lop_days: number
  arrears: number
  bonus: number
  /** Anything taken out of this month's pay that is not a statutory deduction — a recovery, not a relief. */
  recovery: number
  note: string
  created_at: string
}

export interface PayrollSettings {
  /**
   * The Pension Scheme's own ceiling on pensionable salary. Whether it moved with the September
   * 2026 wage ceiling is not settled by any document fetched for this file, so the register asks
   * rather than assumes — and prints the figure it used on every slip.
   */
  eps_pension_ceiling: number
  /**
   * The divisor for a lost-day deduction. Calendar days is the plain reading; 26 is the
   * establishment convention many shops use, and it changes every net figure in the month.
   */
  working_days: 'calendar' | 'convention_26'
  /** Set false when the establishment is not registered with ESIC — no employee is then covered. */
  esi_registered: boolean
  /** The day the shop pays on, for the "money to transfer" row. '' = not recorded. */
  pay_day: string
}

export interface PayrollStore {
  version: number
  updatedAt: string
  orgId: string
  employees: Employee[]
  inputs: PayInput[]
  settings: PayrollSettings
}

export const DEFAULT_SETTINGS: PayrollSettings = {
  eps_pension_ceiling: 15000,
  working_days: 'calendar',
  esi_registered: true,
  pay_day: '',
}

export function emptyPayroll(orgId = ''): PayrollStore {
  return { version: PAYROLL_VERSION, updatedAt: todayISO(), orgId, employees: [], inputs: [], settings: { ...DEFAULT_SETTINGS } }
}

export function newEmployee(): Employee {
  return {
    id: newId(),
    name: '',
    code: '',
    role: '',
    state_code: '',
    pan: '',
    uan: '',
    esi_no: '',
    join_date: todayISO(),
    leave_date: '',
    active: true,
    components: { basic: 0, da: 0, hra: 0, conveyance: 0, medical: 0, special: 0 },
    pf_mode: 'ceiling',
    disabled: false,
    pt_monthly: null,
    hours_per_day: 8,
    age_band: 'below_60',
    notes: '',
    created_at: new Date().toISOString(),
  }
}

export function newInput(employeeId: string, month: string): PayInput {
  return {
    id: newId(),
    employee_id: employeeId,
    month,
    lop_days: 0,
    arrears: 0,
    bonus: 0,
    recovery: 0,
    note: '',
    created_at: new Date().toISOString(),
  }
}

// ── months, the way a payroll register counts them ────────────────────────────

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function isMonth(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}$/.test(v)) return false
  const mm = Number(v.slice(5, 7))
  return mm >= 1 && mm <= 12
}

/** A real calendar day, not merely something shaped like one — 30 February is not a joining date. */
export function isDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)
}

function daysInMonth(y: number, m: number): number {
  if (m !== 2) return MONTH_DAYS[m - 1]
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28
}

export function daysInMonthKey(month: string): number {
  return daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))
}

/** Every month this register names in prose is named in full — "Apr" belongs in a column, not a sentence. */
export function monthLabel(month: string): string {
  if (!isMonth(month)) return month
  return `${MONTH_FULL[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
}

export function monthStart(month: string): string {
  return `${month}-01`
}

export function monthEnd(month: string): string {
  return `${month}-${String(daysInMonthKey(month)).padStart(2, '0')}`
}

export function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7)) - 1 + n
  const yy = y + Math.floor(m / 12)
  const mm = ((m % 12) + 12) % 12
  return `${yy}-${String(mm + 1).padStart(2, '0')}`
}

export function currentMonth(today = todayISO()): string {
  return today.slice(0, 7)
}

/** The April that opens the financial year a month falls in. */
export function fyStartOfMonth(month: string): number {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return m >= 4 ? y : y - 1
}

export const FY_LABEL = (start: number) => `${start}-${String(start + 1).slice(2)}`

/** April first, March last — the order the tax walk runs in. */
export function fyMonths(start: number): string[] {
  return Array.from({ length: 12 }, (_, i) => addMonths(`${start}-04`, i))
}

/** The day of the following month a deposit falls due, with the March-on-salary exception. */
export function depositDue(month: string, kind: 'pf_esi' | 'tds'): string {
  const next = addMonths(month, 1)
  const y = Number(next.slice(0, 4))
  const m = Number(next.slice(5, 7))
  if (kind === 'tds' && month.slice(5, 7) === '03') return `${y}-04-30`
  const day = kind === 'tds' ? DUE_DAYS.tds : DUE_DAYS.pf_esi
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function form16Due(fyStart: number): string {
  return `${fyStart + 1}-${String(DUE_DAYS.form16.month).padStart(2, '0')}-${String(DUE_DAYS.form16.day).padStart(2, '0')}`
}

// ── parsing and storage ───────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

function flag(v: unknown): boolean {
  return v === true
}

/** `null` stays `null` and `0` stays `0` — the difference is the whole point of the field. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, round2(n)) : null
}

function isAgeBand(v: unknown): v is AgeBand {
  return v === 'below_60' || v === '60_to_80' || v === 'above_80'
}

function isPfMode(v: unknown): v is PfMode {
  return v === 'ceiling' || v === 'actual' || v === 'out'
}

function parseComponents(raw: unknown): Components {
  const c = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    basic: Math.max(0, num(c.basic)),
    da: Math.max(0, num(c.da)),
    hra: Math.max(0, num(c.hra)),
    conveyance: Math.max(0, num(c.conveyance)),
    medical: Math.max(0, num(c.medical)),
    special: Math.max(0, num(c.special)),
  }
}

function parseEmployee(raw: unknown): Employee | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const id = str(e.id)
  const name = str(e.name).trim()
  // A row with no name is not an employee; it is a blank line that would price nothing.
  if (!id || !name) return null
  return {
    id,
    name,
    code: str(e.code).trim(),
    role: str(e.role),
    state_code: str(e.state_code),
    pan: str(e.pan).trim().toUpperCase(),
    uan: str(e.uan).trim(),
    esi_no: str(e.esi_no).trim(),
    // A missing or unreadable joining date stays missing rather than defaulting to today — silently
    // starting somebody on the day the register was read would erase them from every month before it.
    join_date: isDate(e.join_date) ? e.join_date : '',
    leave_date: isDate(e.leave_date) ? e.leave_date : '',
    active: e.active === undefined ? true : flag(e.active),
    components: parseComponents(e.components),
    pf_mode: isPfMode(e.pf_mode) ? e.pf_mode : 'ceiling',
    disabled: flag(e.disabled),
    pt_monthly: numOrNull(e.pt_monthly),
    hours_per_day: Math.min(24, Math.max(0, num(e.hours_per_day) || 8)),
    age_band: isAgeBand(e.age_band) ? e.age_band : 'below_60',
    notes: str(e.notes),
    created_at: str(e.created_at) || new Date().toISOString(),
  }
}

function parseInput(raw: unknown): PayInput | null {
  if (!raw || typeof raw !== 'object') return null
  const i = raw as Record<string, unknown>
  const id = str(i.id)
  if (!id || !str(i.employee_id) || !isMonth(i.month)) return null
  return {
    id,
    employee_id: str(i.employee_id),
    month: i.month,
    lop_days: Math.max(0, round2(num(i.lop_days))),
    arrears: Math.max(0, num(i.arrears)),
    bonus: Math.max(0, num(i.bonus)),
    recovery: Math.max(0, num(i.recovery)),
    note: str(i.note),
    created_at: str(i.created_at) || new Date().toISOString(),
  }
}

function parseSettings(raw: unknown): PayrollSettings {
  const s = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    eps_pension_ceiling: Math.max(0, num(s.eps_pension_ceiling) || DEFAULT_SETTINGS.eps_pension_ceiling),
    working_days: s.working_days === 'convention_26' ? 'convention_26' : 'calendar',
    esi_registered: s.esi_registered === undefined ? true : flag(s.esi_registered),
    pay_day: typeof s.pay_day === 'string' ? s.pay_day : '',
  }
}

export function parsePayroll(raw: string | null): PayrollStore {
  if (!raw) return emptyPayroll()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyPayroll()
  }
  if (!parsed || typeof parsed !== 'object') return emptyPayroll()
  const s = parsed as Record<string, unknown>
  const orgId = str(s.orgId)
  if (s.version !== PAYROLL_VERSION) return emptyPayroll(orgId)
  const employees = Array.isArray(s.employees) ? s.employees.map(parseEmployee).filter((x): x is Employee => x !== null) : []
  const inputs = Array.isArray(s.inputs) ? s.inputs.map(parseInput).filter((x): x is PayInput => x !== null) : []
  return {
    version: PAYROLL_VERSION,
    updatedAt: str(s.updatedAt) || todayISO(),
    orgId,
    employees,
    // A month row pointing at an employee who is not in the envelope is dropped: half a register
    // is worse than an empty one, and the same rule the projects register runs on.
    inputs: inputs.filter(i => employees.some(e => e.id === i.employee_id)),
    settings: parseSettings(s.settings),
  }
}

export function loadPayroll(orgId: string): PayrollStore {
  if (typeof window === 'undefined' || !orgId) return emptyPayroll()
  try {
    const store = parsePayroll(window.localStorage.getItem(KEY_PAYROLL + orgId))
    return { ...store, orgId }
  } catch {
    return emptyPayroll(orgId)
  }
}

export function savePayroll(orgId: string, store: PayrollStore): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(
      KEY_PAYROLL + orgId,
      JSON.stringify({ ...store, orgId, version: PAYROLL_VERSION, updatedAt: todayISO() }),
    )
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

function mutate(orgId: string, fn: (store: PayrollStore) => PayrollStore): PayrollStore {
  const next = fn(loadPayroll(orgId))
  savePayroll(orgId, next)
  return next
}

// ── writing to the register ───────────────────────────────────────────────────

export function upsertEmployee(orgId: string, employee: Employee): PayrollStore {
  return mutate(orgId, s => ({
    ...s,
    employees: s.employees.some(e => e.id === employee.id)
      ? s.employees.map(e => (e.id === employee.id ? employee : e))
      : [...s.employees, employee],
  }))
}

export function setActiveEmployee(orgId: string, id: string, active: boolean): PayrollStore {
  return mutate(orgId, s => ({ ...s, employees: s.employees.map(e => (e.id === id ? { ...e, active } : e)) }))
}

export type DeleteEmployeeResult = { ok: true; store: PayrollStore } | { ok: false; error: string }

/**
 * An employee with months recorded is not deletable — those months' PF, ESI and tax would lose
 * the structure they were computed on, and the annual sheet would lose a person the department
 * has a challan against. It goes off the rolls instead, which keeps every computation intact.
 */
export function deleteEmployee(orgId: string, id: string): DeleteEmployeeResult {
  const s = loadPayroll(orgId)
  const rows = s.inputs.filter(i => i.employee_id === id).length
  if (rows > 0) {
    return {
      ok: false,
      error: `This person still has ${rows} recorded month${rows === 1 ? '' : 's'} of salary. Take them off the rolls instead — set a leaving date, and the months they worked stay computed exactly as they were.`,
    }
  }
  return { ok: true, store: mutate(orgId, n => ({ ...n, employees: n.employees.filter(e => e.id !== id) })) }
}

export function upsertInput(orgId: string, input: PayInput): PayrollStore {
  return mutate(orgId, s => ({
    ...s,
    inputs: s.inputs.some(i => i.id === input.id)
      ? s.inputs.map(i => (i.id === input.id ? input : i))
      : [...s.inputs, input],
  }))
}

export function deleteInput(orgId: string, id: string): PayrollStore {
  return mutate(orgId, s => ({ ...s, inputs: s.inputs.filter(i => i.id !== id) }))
}

export function saveSettings(orgId: string, settings: PayrollSettings): PayrollStore {
  return mutate(orgId, s => ({ ...s, settings }))
}

/**
 * One month for everybody on the rolls, written as an empty row so the screen has something to
 * type into. A month is never "generated" with figures in it — the figures are computed on load,
 * and storing them would be storing an answer that the rules table can change under it.
 */
export function openMonth(orgId: string, month: string): { created: number; store: PayrollStore } {
  let created = 0
  const store = mutate(orgId, s => {
    const roster = s.employees.filter(e => onRollsIn(e, month))
    const have = new Set(s.inputs.filter(i => i.month === month).map(i => i.employee_id))
    const fresh = roster.filter(e => !have.has(e.id)).map(e => ({ ...newInput(e.id, month), created_at: new Date().toISOString() }))
    created = fresh.length
    return { ...s, inputs: [...s.inputs, ...fresh] }
  })
  return { created, store }
}

// ── validation ────────────────────────────────────────────────────────────────

export interface Issue {
  field: string
  /** What the page says next to the field. */
  message: string
  /** `block` refuses the save; `warn` saves and prints the finding. */
  level: 'block' | 'warn'
}

/**
 * The record is policed here; the shelf — the state's portals, the department's rates — is not.
 * A warning is a fact the owner should see, not a reason to refuse them their own payroll.
 */
export function validateEmployee(e: Employee, today = todayISO()): Issue[] {
  const out: Issue[] = []
  if (!e.name.trim()) out.push({ field: 'name', message: 'A row needs a name — an employee is not a total.', level: 'block' })
  const total = monthlyTotal(e)
  if (total <= 0) {
    out.push({
      field: 'components',
      message: 'No monthly component is recorded, so there is nothing to compute. Gross will print a dash rather than ₹0 — a salary nobody has written down is not a salary of zero.',
      level: 'warn',
    })
  }
  if (e.components.basic + e.components.da <= 0 && e.pf_mode !== 'out') {
    out.push({
      field: 'basic',
      message: 'Provident fund sits on basic + dearness allowance. With neither recorded the PF legs are ₹0 while the person stays in the scheme — set basic, or move them to "Outside PF".',
      level: 'warn',
    })
  }
  if (!e.join_date) {
    out.push({
      field: 'join_date',
      message: 'No joining date is recorded, so this person is treated as on the rolls in every month the register holds — including months before they arrived.',
      level: 'warn',
    })
  }
  if (e.join_date && e.leave_date && e.leave_date < e.join_date) {
    out.push({ field: 'leave_date', message: 'The leaving date falls before the joining date. One of the two is wrong, and every month between them is uncomputable.', level: 'block' })
  }
  if (e.join_date > today) {
    out.push({ field: 'join_date', message: 'A joining date in the future means no month can be run yet — the register will show this person as not started.', level: 'warn' })
  }
  if (!e.pan.trim() && e.age_band === 'below_60') {
    out.push({ field: 'pan', message: 'No PAN recorded. Tax on salary is still computed, but a return without the employee’s PAN is a defect the department charges for — quote it before Form 16 season.', level: 'warn' })
  }
  if (e.pt_monthly === null) {
    out.push({
      field: 'pt_monthly',
      message: 'Professional tax is not recorded. It deducts nothing and claims nothing: the payslip prints a dash, and the annual sheet will not take a ₹2,500 deduction you never set. Enter 0 if your state charges nothing.',
      level: 'warn',
    })
  }
  if (e.pt_monthly !== null && e.pt_monthly > 500) {
    out.push({ field: 'pt_monthly', message: 'More than ₹500 a month on salary is above any state figure fetched for this file. The deduction from tax is capped at ₹2,500 a year in any case.', level: 'warn' })
  }
  if (e.hours_per_day <= 0 || e.hours_per_day > 24) {
    out.push({ field: 'hours_per_day', message: 'Hours per day must be between 1 and 24 — it is the divisor for the cost of an hour, not a preference.', level: 'block' })
  }
  return out
}

export function validateInput(i: PayInput, employee: Employee | null, month: string, today = todayISO()): Issue[] {
  const out: Issue[] = []
  if (!isMonth(month)) out.push({ field: 'month', message: 'A month is YYYY-MM — the walk that computes tax needs to know which one.', level: 'block' })
  if (!employee) out.push({ field: 'employee_id', message: 'This row points at an employee who is not in the register.', level: 'block' })
  const days = daysInMonthKey(month)
  if (i.lop_days < 0) out.push({ field: 'lop_days', message: 'Lost days cannot be negative. To pay for a day that was not worked, add it to arrears.', level: 'block' })
  if (i.lop_days > days) {
    out.push({
      field: 'lop_days',
      message: `${monthLabel(month)} has ${days} days. A lost-day count above the month's own length would produce a negative salary, so the run is refused rather than clipped.`,
      level: 'block',
    })
  }
  if (month > currentMonth(today)) {
    out.push({ field: 'month', message: 'That month has not happened yet. Payroll records what was worked; planning is what the recipe board’s demand tab is for.', level: 'block' })
  }
  if (employee && employee.join_date && monthEnd(month) < employee.join_date) {
    out.push({ field: 'month', message: `They joined on ${employee.join_date}, so ${monthLabel(month)} is before they were on the rolls.`, level: 'block' })
  }
  if (employee && employee.leave_date && monthStart(month) > employee.leave_date) {
    out.push({ field: 'month', message: `They left on ${employee.leave_date}, so ${monthLabel(month)} is after they went.`, level: 'block' })
  }
  if (i.recovery > 100000000) {
    out.push({ field: 'recovery', message: 'A recovery above ₹1 crore is a typo, not a payroll line.', level: 'block' })
  }
  return out
}

// ── the roster ────────────────────────────────────────────────────────────────

/** On the rolls for a month means the two calendars overlap somewhere inside it. */
export function onRollsIn(e: Employee, month: string): boolean {
  if (!e.active) return false
  if (e.join_date && monthEnd(month) < e.join_date) return false
  if (e.leave_date && monthStart(month) > e.leave_date) return false
  return true
}

/** The reason a person is not in this month's register — '' when they are. */
export function offRosterWhy(e: Employee, month: string): string {
  if (!e.active) return 'Marked inactive, so no month is run for them.'
  if (e.join_date && monthEnd(month) < e.join_date) return `Joins on ${e.join_date}.`
  if (e.leave_date && monthStart(month) > e.leave_date) return `Left on ${e.leave_date}.`
  return ''
}

export interface Roster {
  month: string
  on: Employee[]
  off: { employee: Employee; why: string }[]
}

/** The register prints who it skipped and why. A quiet disappearance is worse than an ugly row. */
export function rosterFor(store: PayrollStore, month: string): Roster {
  const on: Employee[] = []
  const off: Roster['off'] = []
  for (const e of store.employees) {
    const why = offRosterWhy(e, month)
    if (why) off.push({ employee: e, why })
    else on.push(e)
  }
  on.sort((a, b) => a.name.localeCompare(b.name))
  off.sort((a, b) => a.employee.name.localeCompare(b.employee.name))
  return { month, on, off }
}

export function employeeById(employees: Employee[]): Map<string, Employee> {
  return new Map(employees.map(e => [e.id, e]))
}

export function inputsByMonth(inputs: PayInput[]): Map<string, Map<string, PayInput>> {
  const out = new Map<string, Map<string, PayInput>>()
  for (const i of inputs) {
    const byEmployee = out.get(i.month) ?? new Map<string, PayInput>()
    byEmployee.set(i.employee_id, i)
    out.set(i.month, byEmployee)
  }
  return out
}

/** Every month that has a row, newest first — the month picker reads this, not a calendar. */
export function monthsWithData(store: PayrollStore): string[] {
  const set = new Set(store.inputs.map(i => i.month))
  return [...set].sort((a, b) => b.localeCompare(a))
}

// ── the money side: computed on every load ────────────────────────────────────

export interface ComponentRow {
  key: string
  label: string
  /** The monthly figure as the employee is structured. */
  monthly: number
  /** What was actually paid this month, after lost time. */
  paid: number
  in_pf: boolean
  in_esi: boolean
}

export interface PfReading {
  in_scheme: boolean
  /** Basic + DA paid this month — the base PF sits on, before any ceiling. */
  wages: number
  /** What the ceiling or the agreement made the base. */
  used: number
  ceiling: number
  ceiling_cite: string
  /** The part of basic + DA the ceiling left out, so the owner can see what they are not funding. */
  above_ceiling: number
  employee: number
  epf: number
  eps: number
  edli: number
  admin: number
  employer_total: number
  eps_ceiling: number
  why: string
}

export interface EsiReading {
  covered: boolean
  wages: number
  limit: number
  employee: number
  employer: number
  why: string
}

export interface SlabLeg {
  band: string
  taxed_on: number
  pct: number
  tax: number
}

export interface TaxReading {
  applicable: boolean
  /** Why nothing is printed, when nothing is printed. */
  reason: string
  /** The year's estimated income before deductions. */
  income_estimate: number
  standard_deduction: number
  pt_deduction: number
  taxable_income: number
  slabs: SlabLeg[]
  tax_before_rebate: number
  rebate: number
  /** How much the rebate cliff's marginal relief took off. */
  rebate_relief: number
  surcharge: number
  surcharge_relief: number
  cess: number
  /** The year's tax on this estimate. */
  annual_tax: number
  /** What has already been walked off earlier months of the same year. */
  deducted_to_date: number
  /** What is left to take, over the months still to come. */
  months_remaining: number
  /** This month's deduction — the number the payslip prints. */
  tds: number
  regime_note: string
}

export interface Flag {
  field: string
  text: string
  tone: 'amber' | 'red' | 'grey'
}

export interface Payslip {
  employee_id: string
  name: string
  code: string
  role: string
  month: string
  input: PayInput | null
  components: ComponentRow[]
  monthly_total: number
  divisor: number
  divisor_label: string
  lop_days: number
  lop_deduction: number
  arrears: number
  bonus: number
  recovery: number
  /** Wages for the month: paid components plus arrears and bonus. The taxable and insured figure. */
  gross: number
  pf: PfReading
  esi: EsiReading
  /** `null` — not a zero — when the owner has not said what the state charges. */
  pt: number | null
  tax: TaxReading
  tds: number
  deductions: number
  net_pay: number
  employer_cost: number
  /** Carried onto the slip because the cost of an hour is divided by it and nothing else. */
  hours_per_day: number
  flags: Flag[]
  computable: boolean
  why_not: string
}

function pctOf(amount: number, pct: number): number {
  return round2((amount * pct) / 100)
}

/** The bands as a sentence a payslip can print: "₹4,00,000 – ₹8,00,000". */
function bandLabel(from: number, up_to: number | null): string {
  const inr = (n: number) => n.toLocaleString('en-IN')
  return up_to === null ? `above ${inr(from)}` : `${inr(from)} – ${inr(up_to)}`
}

/** Everything the Act charges before surcharge: the slab legs, section 87A, and its relief. */
function baseTax(income: number, table: RegimeTable): {
  slabs: SlabLeg[]
  tax_before_rebate: number
  rebate: number
  rebate_relief: number
  after_rebate: number
} {
  const slabs: SlabLeg[] = []
  let lower = 0
  let tax_before_rebate = 0
  for (const band of table.bands) {
    const ceiling = band.up_to === null ? Infinity : band.up_to
    const slice = Math.max(0, Math.min(income, ceiling) - lower)
    const leg = pctOf(slice, band.pct)
    if (slice > 0) slabs.push({ band: bandLabel(lower, band.up_to), taxed_on: round2(slice), pct: band.pct, tax: leg })
    tax_before_rebate = round2(tax_before_rebate + leg)
    lower = ceiling
    if (income <= ceiling) break
  }

  if (income <= table.rebate_limit) {
    const rebate = Math.min(table.rebate_max, tax_before_rebate)
    return { slabs, tax_before_rebate, rebate, rebate_relief: 0, after_rebate: round2(tax_before_rebate - rebate) }
  }
  // Marginal relief: the tax on income just above the rebate limit may not exceed the excess
  // itself. Below the point where the slab tax catches up, this is what the relief is — which is
  // why a ₹12,10,000 salary pays ₹10,000 and not the ₹61,000 the bands alone would give.
  const excess = round2(income - table.rebate_limit)
  const capped = Math.min(tax_before_rebate, excess)
  return { slabs, tax_before_rebate, rebate: 0, rebate_relief: round2(tax_before_rebate - capped), after_rebate: round2(capped) }
}

/**
 * The year's tax on a taxable income under one table, with every leg kept separate because the
 * page prints them: slab tax, the 87A rebate, the relief at the rebate cliff, surcharge and its
 * own relief at each cliff, and the cess.
 */
export function taxBreakdown(taxable: number, table: RegimeTable): Omit<TaxReading, 'applicable' | 'reason' | 'income_estimate' | 'standard_deduction' | 'pt_deduction' | 'deducted_to_date' | 'months_remaining' | 'tds' | 'regime_note'> {
  const income = Math.max(0, round2(taxable))
  const base = baseTax(income, table)

  let surcharge = 0
  let surcharge_relief = 0
  if (income > table.surcharge_from) {
    // Which band the income sits in, and the threshold at its foot. Marginal relief is measured
    // against that foot: past ₹50L / ₹1Cr / ₹2Cr the tax plus surcharge may not rise by more than
    // the rupees above the threshold, so at ₹50,00,001 the surcharge is essentially nil.
    let floor = table.surcharge_from
    let pct = 0
    for (const band of table.surcharge_bands) {
      const top = band.up_to === null ? Infinity : band.up_to
      pct = band.pct
      if (income <= top) break
      floor = top
    }
    const raw = pctOf(base.after_rebate, pct)
    const allowed = round2(baseTax(floor, table).after_rebate + (income - floor))
    const over = Math.max(0, round2(base.after_rebate + raw - allowed))
    surcharge = round2(Math.max(0, raw - over))
    surcharge_relief = round2(raw - surcharge)
  }

  const cess = pctOf(round2(base.after_rebate + surcharge), table.cess_pct)
  return {
    taxable_income: income,
    slabs: base.slabs,
    tax_before_rebate: base.tax_before_rebate,
    rebate: base.rebate,
    rebate_relief: base.rebate_relief,
    surcharge,
    surcharge_relief,
    cess,
    annual_tax: round2(base.after_rebate + surcharge + cess),
  }
}

/** The divisor a lost day is measured against, and the words that tell the owner which was used. */
function divisorFor(month: string, settings: PayrollSettings): { days: number; label: string } {
  if (settings.working_days === 'convention_26') return { days: 26, label: '26-day convention' }
  const d = daysInMonthKey(month)
  return { days: d, label: `${d} calendar days` }
}

function monthlyTotal(e: Employee): number {
  return COMPONENT_LABELS.reduce((s, c) => s + Math.max(0, num(e.components[c.key])), 0)
}

/**
 * One month's wages for one employee: the components, the lost-time deduction measured against
 * the divisor the shop chose, and the extras. Public because the tax walk and the annual sheet
 * both need it, and neither should be re-deriving it a second way.
 */
export function monthWages(e: Employee, input: PayInput | null, month: string, settings: PayrollSettings): {
  components: ComponentRow[]
  monthly_total: number
  divisor: number
  divisor_label: string
  lop_days: number
  lop_deduction: number
  arrears: number
  bonus: number
  recovery: number
  gross: number
  pf_wages: number
} {
  const { days, label } = divisorFor(month, settings)
  const lop = Math.min(Math.max(0, num(input?.lop_days)), days)
  const rows: ComponentRow[] = []
  let monthly_total = 0
  let paid_total = 0
  let pf_wages = 0
  for (const c of COMPONENT_LABELS) {
    const monthly = Math.max(0, num(e.components[c.key]))
    const paid = days > 0 ? round2(monthly - (monthly / days) * lop) : monthly
    rows.push({ key: c.key, label: c.label, monthly: round2(monthly), paid, in_pf: c.in_pf, in_esi: c.in_esi })
    monthly_total = round2(monthly_total + monthly)
    paid_total = round2(paid_total + paid)
    if (c.in_pf) pf_wages = round2(pf_wages + paid)
  }
  const arrears = Math.max(0, num(input?.arrears))
  const bonus = Math.max(0, num(input?.bonus))
  const recovery = Math.max(0, num(input?.recovery))
  return {
    components: rows,
    monthly_total: round2(monthly_total),
    divisor: days,
    divisor_label: label,
    lop_days: lop,
    lop_deduction: round2(monthly_total - paid_total),
    arrears,
    bonus,
    recovery,
    gross: round2(paid_total + arrears + bonus),
    pf_wages,
  }
}

/** The provident fund legs for a month, with the ceiling that was in force on that month's day. */
function pfReading(e: Employee, wages: number, month: string, settings: PayrollSettings): PfReading {
  const { ceiling, cite } = pfCeilingOn(monthEnd(month))
  const eps_ceiling = Math.max(0, num(settings.eps_pension_ceiling))
  const base: PfReading = {
    in_scheme: e.pf_mode !== 'out',
    wages: round2(wages),
    used: 0,
    ceiling,
    ceiling_cite: cite,
    above_ceiling: 0,
    employee: 0,
    epf: 0,
    eps: 0,
    edli: 0,
    admin: 0,
    employer_total: 0,
    eps_ceiling,
    why: '',
  }
  if (e.pf_mode === 'out') {
    return { ...base, why: 'Outside PF — no contribution is computed, and the row prints nothing rather than ₹0 of a fund they are not in.' }
  }
  if (wages <= 0) {
    return { ...base, why: 'No basic + dearness allowance to sit a contribution on.' }
  }
  const used = e.pf_mode === 'actual' ? round2(wages) : round2(Math.min(wages, ceiling))
  const above = round2(wages - used)
  return {
    ...base,
    used,
    above_ceiling: above,
    employee: pctOf(used, PF_RATES.employee_pct),
    epf: pctOf(used, PF_RATES.epf_share_pct),
    // The pension leg is capped by the Pension Scheme's own figure, which this file does not
    // claim moved with the September ceiling — see `PayrollSettings.eps_pension_ceiling`.
    eps: pctOf(Math.min(used, eps_ceiling), PF_RATES.eps_share_pct),
    edli: pctOf(Math.min(wages, ceiling || wages), PF_RATES.edli_pct),
    admin: pctOf(used, PF_RATES.admin_pct),
    employer_total: round2(
      pctOf(used, PF_RATES.epf_share_pct)
      + pctOf(Math.min(used, eps_ceiling), PF_RATES.eps_share_pct)
      + pctOf(Math.min(wages, ceiling || wages), PF_RATES.edli_pct)
      + pctOf(used, PF_RATES.admin_pct),
    ),
    // Said out loud because it is the one number on the slip the owner can choose to change:
    // contributing on actual wages needs a joint request and the employer's agreement.
    why: e.pf_mode === 'ceiling' && above > 0
      ? `${monthLabel(month)}'s PF wage ceiling is ₹${ceiling.toLocaleString('en-IN')}; the fund leg stops there, and the ₹${above.toLocaleString('en-IN')} above it is contributed only if employer and employee agree in writing.`
      : e.pf_mode === 'actual'
        ? `Contributed on actual basic + dearness allowance by agreement, so the ₹${ceiling.toLocaleString('en-IN')} ceiling does not cap this row.`
        : '',
  }
}

function esiReading(e: Employee, wages: number, month: string, settings: PayrollSettings): EsiReading {
  const band = esiBandOn(monthEnd(month))
  const limit = e.disabled ? band.disabled_limit : band.wage_limit
  const base: EsiReading = { covered: false, wages: round2(wages), limit, employee: 0, employer: 0, why: '' }
  if (!settings.esi_registered) return { ...base, why: 'This establishment is not registered with ESIC, so nobody is covered whatever they earn.' }
  if (wages <= 0) return { ...base, why: 'No wages this month to test against the limit.' }
  if (wages > limit) {
    return {
      ...base,
      why: `Gross wages of ${Math.round(wages).toLocaleString('en-IN')} are above the ₹${limit.toLocaleString('en-IN')} limit${e.disabled ? ' for a person with disability' : ''}, so ESI does not reach this month.`,
    }
  }
  return {
    ...base,
    covered: true,
    employee: pctOf(wages, band.employee_pct),
    employer: pctOf(wages, band.employer_pct),
    why: e.disabled ? `Covered up to the ₹${limit.toLocaleString('en-IN')} limit for a person with disability.` : 'Covered.',
  }
}

/**
 * The walk that turns a salary structure into this month's tax deduction.
 *
 * Section 192 read with rules 31-33 asks the employer to estimate the year, compute the tax on
 * that estimate, and take the balance in equal monthly instalments over the months still to come.
 * So this runs April forward: it adds each month's actual wages, projects the months after it at
 * the same rate, computes the year's tax, subtracts what the earlier months of the walk already
 * took, and divides the remainder by the number of on-roll months left. Nothing is stored as
 * "tax deducted" — the figure is re-walked on every load, which is the only way a register can
 * promise that June's row and March's row add up to the year.
 */
function taxWalk(e: Employee, byMonth: Map<string, Map<string, PayInput>>, month: string, settings: PayrollSettings): TaxReading {
  const start = fyStartOfMonth(month)
  const table = regimeTableFor(start)
  const age = AGE_META[e.age_band]
  if (!table) {
    return emptyTax(`This register holds the default-regime tables for ${REGIME_TABLES.map(t => FY_LABEL(t.fy_start)).join(' and ')}. FY ${FY_LABEL(start)} is not in them, so no tax figure is invented.`)
  }
  if (!age.modelled) {
    return emptyTax(age.note)
  }
  const months = fyMonths(start)
  const upto = months.indexOf(month)
  const ptMonthly = e.pt_monthly === null ? 0 : Math.max(0, e.pt_monthly)
  /**
   * Section 16(iii) is a deduction from the *year's* salary income, so the estimate subtracts the
   * professional tax the year will actually carry — ₹200 a month for a person on the rolls for all
   * twelve is ₹2,400 off the estimate from April onwards, not ₹200. Dividing by the months left only
   * works if the whole year was priced first; taking the elapsed months alone would make every
   * instalment a little too large and hand the difference to March.
   */
  const pt_year = Math.min(PT_ANNUAL_CAP, round2(ptMonthly * months.filter(m => onRollsIn(e, m)).length))

  let income_to_date = 0
  let deducted = 0
  let last: TaxReading = emptyTax('No month of this year has been walked — the employee is not on the rolls in any month up to ' + monthLabel(month) + '.')

  for (let i = 0; i <= Math.max(0, upto); i++) {
    const m = months[i]
    if (!onRollsIn(e, m)) continue
    const wages = monthWages(e, byMonth.get(m)?.get(e.id) ?? null, m, settings)
    income_to_date = round2(income_to_date + wages.gross)
    const remaining = months.slice(i).filter(mm => onRollsIn(e, mm)).length
    const estimate = round2(income_to_date + wages.gross * Math.max(0, remaining - 1))
    const std = Math.min(table.standard_deduction, estimate)
    const ptTo = pt_year
    const taxable = Math.max(0, round2(estimate - std - ptTo))
    const legs = taxBreakdown(taxable, table)
    const this_month = remaining > 0
      ? Math.max(0, round2((legs.annual_tax - deducted) / remaining))
      : Math.max(0, round2(legs.annual_tax - deducted))
    deducted = round2(deducted + this_month)
    last = {
      applicable: true,
      reason: '',
      income_estimate: estimate,
      standard_deduction: round2(std),
      pt_deduction: round2(ptTo),
      taxable_income: taxable,
      slabs: legs.slabs,
      tax_before_rebate: legs.tax_before_rebate,
      rebate: legs.rebate,
      rebate_relief: legs.rebate_relief,
      surcharge: legs.surcharge,
      surcharge_relief: legs.surcharge_relief,
      cess: legs.cess,
      annual_tax: legs.annual_tax,
      deducted_to_date: deducted,
      months_remaining: remaining,
      tds: this_month,
      regime_note: `Default regime (section 115BAC), ${FY_LABEL(start)}. HRA is taxed in full because the regime does not exempt it; the employer’s own PF contribution under 80CCD(2) is not deducted, so this tax is an upper bound rather than a verdict.`,
    }
  }
  return last
}

function emptyTax(reason: string): TaxReading {
  return {
    applicable: false, reason,
    income_estimate: 0, standard_deduction: 0, pt_deduction: 0, taxable_income: 0,
    slabs: [], tax_before_rebate: 0, rebate: 0, rebate_relief: 0,
    surcharge: 0, surcharge_relief: 0, cess: 0, annual_tax: 0,
    deducted_to_date: 0, months_remaining: 0, tds: 0, regime_note: '',
  }
}

function regimeTableFor(fy_start: number): RegimeTable | null {
  return REGIME_TABLES.find(t => t.fy_start === fy_start) ?? null
}

/** One employee, one month, every leg computed from the structure rather than stored beside it. */
export function payslipOf(e: Employee, inputs: PayInput[], month: string, settings: PayrollSettings): Payslip {
  const byMonth = inputsByMonth(inputs)
  const input = byMonth.get(month)?.get(e.id) ?? null
  // A month outside the employment has no salary in it. The roster already keeps such people out of
  // the month's rows; a slip called up directly has to refuse the same way rather than print the
  // structure as though the person were still being paid.
  const off_why = offRosterWhy(e, month)
  if (off_why) {
    return dashSlip(e, input, month, settings, `${off_why} ${monthLabel(month)} was never worked, so the row prints a dash rather than a salary.`)
  }
  const w = monthWages(e, input, month, settings)
  const pf = pfReading(e, w.pf_wages, month, settings)
  const esi = esiReading(e, w.gross, month, settings)
  const tax = taxWalk(e, byMonth, month, settings)
  const pt = e.pt_monthly === null ? null : Math.max(0, round2(e.pt_monthly))

  const flags: Flag[] = []
  if (!e.pan.trim()) flags.push({ field: 'pan', text: 'No PAN on the card — the annual sheet can be printed but not handed over as Form 16-shaped evidence.', tone: 'amber' })
  if (e.pt_monthly === null) flags.push({ field: 'pt', text: 'Professional tax not recorded, so nothing is deducted for it and the ₹2,500 cap is not claimed. Enter 0 if your state charges nothing.', tone: 'amber' })
  if (!AGE_META[e.age_band].modelled) flags.push({ field: 'age_band', text: `${AGE_META[e.age_band].label}: no tax figure is computed. ${AGE_META[e.age_band].note}`, tone: 'red' })
  if (pf.above_ceiling > 0) {
    flags.push({
      field: 'pf',
      text: `${Math.round(pf.above_ceiling).toLocaleString('en-IN')} of basic sits above the ₹${pf.ceiling.toLocaleString('en-IN')} ceiling and carries no contribution. Both sides can agree to contribute on the full basic — that is the "On full basic" mode.`,
      tone: 'grey',
    })
  }
  if (pf.in_scheme && w.monthly_total > 0 && pf.wages < 0.5 * w.monthly_total) {
    flags.push({
      field: 'components',
      text: `Allowances are more than half of this salary. Under the labour codes in force since ${WAGE_CODE_50.from.replace(/-/g, '-')}, "wages" can be deemed to include the surplus; PF here is still computed on basic + DA. ${WAGE_CODE_50.cite}`,
      tone: 'amber',
    })
  }
  if (e.pf_mode === 'ceiling' && pf.wages > pf.ceiling && pf.ceiling !== pf.eps_ceiling) {
    flags.push({
      field: 'eps',
      text: `The pension leg here is capped at the ₹${pf.eps_ceiling.toLocaleString('en-IN')} figure you set, while the wage ceiling for the month is ₹${pf.ceiling.toLocaleString('en-IN')}. No document fetched for this file settles whether the pensionable salary moved with the September ceiling — change the figure in settings if your establishment has been told otherwise.`,
      tone: 'amber',
    })
  }
  if (!tax.applicable && tax.reason) flags.push({ field: 'tax', text: tax.reason, tone: 'amber' })
  if (esi.covered && pf.in_scheme) {
    // Not a problem — the two statutes simply have different ceilings, and the owner should know
    // the month they overlap rather than discover it on a challan.
    flags.push({ field: 'esi', text: `In PF and covered by ESI in the same month: the PF ceiling is ₹${pf.ceiling.toLocaleString('en-IN')}, the ESI limit ₹${esi.limit.toLocaleString('en-IN')}. Two statutes, two bases, no contradiction.`, tone: 'grey' })
  }

  const deductions = round2(pf.employee + esi.employee + (pt ?? 0) + tax.tds + w.recovery)
  const computable = w.monthly_total > 0
  return {
    employee_id: e.id,
    name: e.name,
    code: e.code,
    role: e.role,
    month,
    input,
    components: w.components,
    monthly_total: w.monthly_total,
    divisor: w.divisor,
    divisor_label: w.divisor_label,
    lop_days: w.lop_days,
    lop_deduction: w.lop_deduction,
    arrears: w.arrears,
    bonus: w.bonus,
    recovery: w.recovery,
    gross: w.gross,
    pf,
    esi,
    pt,
    tax,
    tds: tax.tds,
    deductions,
    net_pay: round2(w.gross - deductions),
    employer_cost: round2(w.gross + pf.employer_total + esi.employer),
    hours_per_day: Math.max(0, num(e.hours_per_day)),
    flags,
    computable,
    why_not: computable ? '' : 'No monthly component is recorded for this person, so gross, deductions and take-home all print a dash rather than ₹0.',
  }
}

/** A slip for a month this person was not paid in: every rupee a dash, with the reason attached. */
function dashSlip(e: Employee, input: PayInput | null, month: string, settings: PayrollSettings, why_not: string): Payslip {
  const { days, label } = divisorFor(month, settings)
  return {
    employee_id: e.id,
    name: e.name,
    code: e.code,
    role: e.role,
    month,
    input,
    components: [],
    monthly_total: 0,
    divisor: days,
    divisor_label: label,
    lop_days: 0,
    lop_deduction: 0,
    arrears: 0,
    bonus: 0,
    recovery: 0,
    gross: 0,
    pf: pfReading(e, 0, month, settings),
    esi: esiReading(e, 0, month, settings),
    // Nothing was deducted this month because nothing was paid — a recorded nil, not a missing figure.
    pt: 0,
    tax: emptyTax(`Not on the rolls in ${monthLabel(month)} — the employment window does not reach this month, so no tax is estimated for it.`),
    tds: 0,
    deductions: 0,
    net_pay: 0,
    employer_cost: 0,
    hours_per_day: Math.max(0, num(e.hours_per_day)),
    flags: [{ field: 'roster', text: why_not, tone: 'grey' }],
    computable: false,
    why_not,
  }
}

/** The whole month, on the rolls first, biggest employer cost first. */
export function monthRegister(store: PayrollStore, month: string): Payslip[] {
  const { on } = rosterFor(store, month)
  return on
    .map(e => payslipOf(e, store.inputs, month, store.settings))
    .sort((a, b) => b.employer_cost - a.employer_cost || a.name.localeCompare(b.name))
}

export interface RegisterSummary {
  heads: number
  gross: number
  pf_employee: number
  pf_employer: number
  esi_employee: number
  esi_employer: number
  pt: number
  /** Heads whose professional tax the owner never set — counted so the total can say what it is not. */
  pt_unset: number
  tds: number
  recovery: number
  net: number
  employer_cost: number
  in_pf: number
  in_esi: number
  no_tax: number
  no_pan: number
  above_ceiling: number
}

export function summariseRegister(slips: Payslip[]): RegisterSummary {
  const s: RegisterSummary = {
    heads: slips.length, gross: 0, pf_employee: 0, pf_employer: 0, esi_employee: 0, esi_employer: 0,
    pt: 0, pt_unset: 0, tds: 0, recovery: 0, net: 0, employer_cost: 0,
    in_pf: 0, in_esi: 0, no_tax: 0, no_pan: 0, above_ceiling: 0,
  }
  for (const p of slips) {
    s.gross = round2(s.gross + p.gross)
    s.pf_employee = round2(s.pf_employee + p.pf.employee)
    s.pf_employer = round2(s.pf_employer + p.pf.employer_total)
    s.esi_employee = round2(s.esi_employee + p.esi.employee)
    s.esi_employer = round2(s.esi_employer + p.esi.employer)
    if (p.pt === null) s.pt_unset += 1
    else s.pt = round2(s.pt + p.pt)
    s.tds = round2(s.tds + p.tds)
    s.recovery = round2(s.recovery + p.recovery)
    s.net = round2(s.net + p.net_pay)
    s.employer_cost = round2(s.employer_cost + p.employer_cost)
    if (p.pf.in_scheme) s.in_pf += 1
    if (p.esi.covered) s.in_esi += 1
    if (!p.tax.applicable) s.no_tax += 1
    if (p.pf.above_ceiling > 0) s.above_ceiling += 1
  }
  s.no_pan = slips.filter(p => p.flags.some(f => f.field === 'pan')).length
  return s
}

// ── what the month owes, and by when ─────────────────────────────────────────

export interface StatutoryLine {
  key: string
  label: string
  form: string
  amount: number
  due: string
  /** What the amount is made of, in the register's own words. */
  basis: string
  cite: string
  note: string
  href: string
}

/**
 * The challans a month of payroll produces. A head with nothing in it is not a deadline, so it
 * is absent from this list rather than shown as ₹0 — and `missingHeads()` says which heads are
 * absent and why, because "no ESI this month" is a fact worth printing once.
 */
export function statutoryDues(store: PayrollStore, month: string): StatutoryLine[] {
  const slips = monthRegister(store, month)
  const s = summariseRegister(slips)
  const out: StatutoryLine[] = []
  const pfTotal = round2(s.pf_employee + slips.reduce((a, p) => a + p.pf.epf + p.pf.eps + p.pf.edli + p.pf.admin, 0))
  if (s.in_pf > 0 && pfTotal > 0) {
    out.push({
      key: 'pf', label: 'Provident fund', form: 'ECR',
      amount: pfTotal, due: depositDue(month, 'pf_esi'),
      basis: `Employee 12% plus the employer's EPF, EPS, EDLI and administrative legs, over ${s.in_pf} head${s.in_pf === 1 ? '' : 's'} in the scheme.`,
      cite: PF_RATES.cite,
      note: 'Filed as one Electronic Contribution Record on the EPFO member portal. The register computes it; the challan is paid there, not here.',
      href: '/payroll',
    })
  }
  const esiTotal = round2(s.esi_employee + s.esi_employer)
  if (esiTotal > 0) {
    const period = esiPeriodOf(month)
    out.push({
      key: 'esi', label: 'Employee State Insurance', form: 'ESIC contribution',
      amount: esiTotal, due: depositDue(month, 'pf_esi'),
      basis: `Employee 0.75% and employer 3.25% of gross wages, over ${s.in_esi} covered head${s.in_esi === 1 ? '' : 's'} inside the ₹21,000 limit.`,
      cite: ESI_BANDS[0].cite,
      note: `Contribution period ${period.label} (${period.window}); the return for it is due ${period.return_due}.`,
      href: '/payroll',
    })
  }
  if (s.tds > 0) {
    out.push({
      key: 'tds', label: 'Tax on salary', form: 'Challan 281 · 192',
      amount: s.tds, due: depositDue(month, 'tds'),
      basis: `Sum of the month's section 192 deductions across ${slips.filter(p => p.tax.applicable).length} computable head${slips.filter(p => p.tax.applicable).length === 1 ? '' : 's'}.`,
      cite: DUE_DAYS.cite,
      note: 'Deposited on the income tax portal against a challan; the register holds no challan number, so `/tds` cannot see it. Form 24Q is where this goes back into the department’s books.',
      href: '/tds',
    })
  }
  if (s.pt > 0) {
    out.push({
      key: 'pt', label: 'Professional tax', form: 'State PT return',
      amount: s.pt, due: '',
      basis: `Typed per employee — ${s.heads - s.pt_unset} head${s.heads - s.pt_unset === 1 ? '' : 's'} with an amount set, ${s.pt_unset} with none.`,
      cite: 'A state subject: the rate, the due date and whether salary is taxed at all are all the state’s, and the tables fetched for this file disagree. Section 16(iii) caps the deduction from salary at ₹2,500 a year.',
      note: 'No national due date to print. The calendar leaves this row undated rather than inventing the 21st.',
      href: '/payroll',
    })
  }
  return out
}

/** The heads that produced nothing, with the reason — so an empty total is a stated fact. */
export function missingHeads(store: PayrollStore, month: string): { key: string; label: string; why: string }[] {
  const slips = monthRegister(store, month)
  const s = summariseRegister(slips)
  const lines = statutoryDues(store, month)
  const have = new Set(lines.map(l => l.key))
  const out: { key: string; label: string; why: string }[] = []
  if (!have.has('pf')) {
    out.push({
      key: 'pf', label: 'Provident fund',
      why: s.in_pf === 0
        ? `Nobody in this month's register is in the scheme — all ${s.heads} head${s.heads === 1 ? '' : 's'} are marked outside PF.`
        : `${s.in_pf} head${s.in_pf === 1 ? '' : 's'} in the scheme, but basic + DA this month carries no contribution.`,
    })
  }
  if (!have.has('esi')) {
    out.push({
      key: 'esi', label: 'Employee State Insurance',
      why: !store.settings.esi_registered
        ? 'The establishment is not registered with ESIC.'
        : s.in_esi === 0
          ? `No employee's gross this month is inside the ₹${(ESI_BANDS[0].wage_limit).toLocaleString('en-IN')} limit${s.heads ? ` — the lowest is ${Math.round(Math.min(...slips.map(p => p.gross || Infinity))).toLocaleString('en-IN')}` : ''}.`
          : 'Covered heads exist but their wages this month are nil.',
    })
  }
  if (!have.has('tds')) {
    out.push({
      key: 'tds', label: 'Tax on salary',
      why: s.no_tax > 0
        ? `${s.no_tax} head${s.no_tax === 1 ? '' : 's'} have no tax figure the register can compute${s.no_tax === s.heads ? ' (no employee is under a schedule this file holds)' : ''}. Everyone else falls under the ₹12,00,000 rebate, which is a real nil — not a gap.`
        : 'The walk gives no month a deduction: every salary in the register is covered by the section 87A rebate.',
    })
  }
  if (!have.has('pt')) {
    out.push({
      key: 'pt', label: 'Professional tax',
      why: s.pt_unset === s.heads
        ? 'Not recorded for anyone, so nothing is deducted and nothing is claimed.'
        : 'Every employee with an amount set has ₹0, or nobody has one.',
    })
  }
  return out
}

// ── the hour cost: what `/projects` has never been able to ask for ────────────

export interface HourCost {
  employee_id: string
  name: string
  month: string
  paid_days: number
  hours_per_day: number
  cost_per_day: number | null
  cost_per_hour: number | null
  /** What the figure is made of, because a cost with no basis is a guess. */
  basis: string
  why: string
}

/**
 * The rupee an hour of this person's time actually cost the business: the month's *employer cost*
 * — gross plus the employer's own PF and ESI legs — divided by the days that were paid for and
 * the hours the shop works in a day.
 *
 * This is the number R2-23 said it could not have. It is not subtracted from a project's
 * contribution automatically: the hours logged on a job were not necessarily this person's, and
 * the page that knows who worked is `/projects`, not here.
 */
export function costPerHour(p: Payslip): HourCost {
  const paid_days = Math.max(0, round2(p.divisor - p.lop_days))
  // A month that cost nothing has no hour to price. Dividing ₹0 by the paid days would print a
  // rupee-per-hour figure the business never spent, which is the one thing a cost column must not do.
  const nothing_to_price = p.employer_cost <= 0
  const per_day = paid_days > 0 && !nothing_to_price ? round2(p.employer_cost / paid_days) : null
  const per_hour = per_day === null || p.hours_per_day <= 0 ? null : round2(per_day / p.hours_per_day)
  return {
    employee_id: p.employee_id,
    name: p.name,
    month: p.month,
    paid_days,
    hours_per_day: p.hours_per_day,
    cost_per_day: per_day,
    cost_per_hour: per_hour,
    basis: per_hour === null ? '' : `₹${Math.round(p.employer_cost).toLocaleString('en-IN')} employer cost ÷ ${paid_days} paid day${paid_days === 1 ? '' : 's'} (${p.divisor_label}) ÷ ${p.hours_per_day} h a day.`,
    why: per_hour === null
      ? (paid_days <= 0
        ? 'Every day of the divisor was lost, so there is no paid time to divide a cost into.'
        : nothing_to_price
          ? 'No cost this month, so no hour to price.'
          : 'No hours are recorded on this card, so a day cannot be split into hours.')
      : '',
  }
}

export function costPerHourFor(store: PayrollStore, month: string): HourCost[] {
  return monthRegister(store, month).map(costPerHour)
}

/** A weighted hour across the month: total employer cost over total paid hours. Not an average of averages. */
export function blendedHourCost(slips: Payslip[]): { per_hour: number | null; paid_hours: number; why: string } {
  let cost = 0
  let paid_hours = 0
  for (const p of slips) {
    const days = Math.max(0, p.divisor - p.lop_days)
    if (days <= 0) continue
    cost = round2(cost + p.employer_cost)
    paid_hours = round2(paid_hours + days * Math.max(0, num(p.hours_per_day)))
  }
  return {
    per_hour: paid_hours > 0 ? round2(cost / paid_hours) : null,
    paid_hours,
    why: paid_hours > 0 ? '' : 'No paid days were recorded in this month, so there is no hour to price.',
  }
}

// ── the year: one sheet per employee ─────────────────────────────────────────

export interface AnnualSheet {
  employee_id: string
  name: string
  code: string
  fy: string
  months_worked: number
  gross_salary: number
  standard_deduction: number
  pt_deduction: number
  pt_recorded: number
  taxable_income: number
  tax_before_rebate: number
  rebate: number
  surcharge: number
  cess: number
  /** What the December walk says the year's tax is. */
  tax_payable: number
  /** What was actually taken, month by month. */
  tds_deducted: number
  /** Positive means the year is short; negative means the employee over-deducted. */
  difference: number
  pf_employee: number
  employer_cost: number
  tax_modelled: boolean
  why_not: string
  flags: Flag[]
}

/**
 * The year as the employee's return will see it. Shaped like Form 16 and labelled as not Form 16:
 * Part A of that certificate is generated from challans the department has accepted, which live on
 * TRACES and not in a browser. What this sheet can prove is the salary, the deductions the register
 * holds, and the tax it walked — and where the monthly instalments and the year's real figure
 * disagree, it prints the disagreement instead of smoothing it, because that gap is exactly what
 * the employee settles in their own return.
 */
export function annualSheets(store: PayrollStore, fyStart: number): AnnualSheet[] {
  const months = fyMonths(fyStart)
  const table = regimeTableFor(fyStart)
  const out: AnnualSheet[] = []
  for (const e of store.employees) {
    const worked = months.filter(m => onRollsIn(e, m))
    if (!worked.length) continue
    let gross = 0
    let tds = 0
    let pf_employee = 0
    let employer_cost = 0
    let pt_recorded = 0
    let last: TaxReading = emptyTax('')
    // A month on the rolls with no attendance row is counted at the structure, not skipped: salary is
    // owed by the contract, and a row only records the exceptions to it. The register says this out
    // loud because it is the one place the sheet reads the *contract*, not the *cash*.
    for (const m of months) {
      if (!onRollsIn(e, m)) continue
      const p = payslipOf(e, store.inputs, m, store.settings)
      gross = round2(gross + p.gross)
      tds = round2(tds + p.tds)
      pf_employee = round2(pf_employee + p.pf.employee)
      employer_cost = round2(employer_cost + p.employer_cost)
      if (p.pt !== null) pt_recorded = round2(pt_recorded + p.pt)
      last = p.tax
    }
    const std = table ? Math.min(table.standard_deduction, gross) : 0
    const pt = Math.min(PT_ANNUAL_CAP, pt_recorded)
    const taxable = Math.max(0, round2(gross - std - pt))
    const legs = table ? taxBreakdown(taxable, table) : null
    const modelled = last.applicable && !!table
    const year_tax = legs ? legs.annual_tax : 0
    const flags: Flag[] = []
    if (!modelled) flags.push({ field: 'tax', text: last.applicable ? 'No regime table for this year, so the year’s tax is not stated.' : last.reason, tone: 'red' })
    if (e.pt_monthly === null) flags.push({ field: 'pt', text: 'Professional tax was never recorded, so the sheet takes no 16(iii) deduction. If the state charged some, the taxable income printed here is too high.', tone: 'amber' })
    if (round2(tds - year_tax) > 0.5) {
      flags.push({ field: 'tds', text: `The months took ${Math.round(tds).toLocaleString('en-IN')} against a year computed at ${Math.round(year_tax).toLocaleString('en-IN')} — an excess of ${Math.round(tds - year_tax).toLocaleString('en-IN')}. A negative deduction is never taken from pay, so this comes back as a refund claim in the employee’s return.`, tone: 'amber' })
    }
    if (round2(year_tax - tds) > 0.5) {
      flags.push({ field: 'tds', text: `The year computes to ${Math.round(year_tax).toLocaleString('en-IN')} and the months took ${Math.round(tds).toLocaleString('en-IN')} — short by ${Math.round(year_tax - tds).toLocaleString('en-IN')}. The March row is where a mid-year change should have landed; if it did not, this is the employer's default, not the employee's.`, tone: 'red' })
    }
    out.push({
      employee_id: e.id,
      name: e.name,
      code: e.code,
      fy: FY_LABEL(fyStart),
      months_worked: worked.length,
      gross_salary: gross,
      standard_deduction: round2(std),
      pt_deduction: round2(pt),
      pt_recorded,
      taxable_income: taxable,
      tax_before_rebate: legs ? legs.tax_before_rebate : 0,
      rebate: legs ? legs.rebate : 0,
      surcharge: legs ? legs.surcharge : 0,
      cess: legs ? legs.cess : 0,
      tax_payable: round2(year_tax),
      tds_deducted: tds,
      difference: round2(tds - year_tax),
      pf_employee,
      employer_cost,
      tax_modelled: modelled,
      why_not: modelled ? '' : (last.reason || 'No regime table for this year.'),
      flags,
    })
  }
  return out.sort((a, b) => b.gross_salary - a.gross_salary || a.name.localeCompare(b.name))
}

// ── calendar rows: the register says its own deadlines ────────────────────────

export interface PayEvent {
  id: string
  title: string
  form: string
  due: string
  period: string
  description: string
  amount: number
  href: string
  note: string
}

/**
 * Deadlines this register can prove, in the same shape the compliance calendar reads. A month with
 * no rows accrued has nothing to deposit, so it emits nothing — which is why the calendar can grow
 * and shrink these events on its own without a profile tick-box to contradict the books.
 */
export function payrollEvents(store: PayrollStore, fyStart: number): PayEvent[] {
  const out: PayEvent[] = []
  const months = fyMonths(fyStart)
  let anyInput = false
  /** One return per contribution period this year actually accrued ESI for, keyed by its own due date. */
  const esiPeriods = new Map<string, { due: string; window: string; label: string }>()
  for (const m of months) {
    if (!store.inputs.some(i => i.month === m)) continue
    anyInput = true
    for (const line of statutoryDues(store, m)) {
      if (!line.amount) continue
      out.push({
        id: `${fyStart}-pay-${line.key}-${m}`,
        title: `${line.label} — ${monthLabel(m)}`,
        form: line.form,
        due: line.due || '',
        period: `for ${monthLabel(m)}`,
        description: line.basis,
        amount: line.amount,
        href: '/payroll',
        note: line.due ? `${line.cite}` : `${line.note} ${line.cite}`,
      })
      if (line.key === 'esi') {
        const p = esiPeriodOf(m)
        esiPeriods.set(`${p.label}|${p.return_due}`, { due: p.return_due, window: p.window, label: p.label })
      }
    }
  }
  for (const [key, p] of esiPeriods) {
    out.push({
      id: `${fyStart}-pay-esi-return-${key}`,
      title: `ESI return — ${p.label}`,
      form: 'ESIC return',
      due: p.due,
      period: `for ${p.window}`,
      description: 'The half-yearly contribution return for the ESI deposited in this period.',
      amount: 0,
      href: '/payroll',
      note: 'The corporation wants the return by the 11th of the month after the period closes. The register totals the months inside it; filing it happens on the ESIC portal, not here.',
    })
  }
  if (anyInput) {
    out.push({
      id: `${fyStart}-pay-form16`,
      title: 'Form 16 for the year',
      form: 'Form 16',
      due: form16Due(fyStart),
      period: `for ${FY_LABEL(fyStart)}`,
      description: 'The certificate the department prescribes for tax deducted from salary, to every employee it was deducted from.',
      amount: 0,
      href: '/payroll',
      note: 'Rule 31 of the Income tax Rules fixes 15 June. Part A of the certificate is generated from accepted challans on TRACES, which this register cannot reach — the annual sheet here is shaped like Form 16 and labelled as not one.',
    })
  }
  return out.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.title.localeCompare(b.title))
}

// ── CSV ───────────────────────────────────────────────────────────────────────

export const PAYROLL_CSV_HEADERS = [
  'Month', 'Code', 'Employee', 'Role', 'Basic + DA', 'Allowances', 'Monthly total', 'Days basis', 'Lost days',
  'Lost-day deduction', 'Arrears', 'Bonus', 'Gross', 'PF employee', 'PF employer', 'EPS', 'EDLI + admin',
  'ESI employee', 'ESI employer', 'Professional tax', 'TDS 192', 'Recovery', 'Net pay', 'Employer cost',
  'PF ceiling used', 'ESI covered', 'Tax note',
]

export function payrollCsvRows(slips: Payslip[]): (string | number)[][] {
  return slips.map(p => {
    const allowances = round2(p.components.filter(c => !c.in_pf).reduce((s, c) => s + c.paid, 0))
    return [
      p.month, p.code, p.name, p.role, round2(p.pf.wages), allowances, p.monthly_total, p.divisor_label, p.lop_days,
      p.lop_deduction, p.arrears, p.bonus, p.gross, p.pf.employee, p.pf.epf, p.pf.eps,
      round2(p.pf.edli + p.pf.admin), p.esi.employee, p.esi.employer,
      // A blank is "the owner never said"; a 0 is "the state charges nothing". They are not the same row.
      p.pt === null ? '' : p.pt, p.tds, p.recovery, p.net_pay, p.employer_cost,
      p.pf.in_scheme ? p.pf.ceiling : '', p.esi.covered ? 'yes' : 'no',
      p.tax.applicable ? '' : p.tax.reason,
    ]
  })
}

export const STATUTORY_CSV_HEADERS = ['Month', 'Head', 'Form', 'Amount', 'Deposit due', 'What it is made of', 'Source']

export function statutoryCsvRows(store: PayrollStore, months: string[]): (string | number)[][] {
  const out: (string | number)[][] = []
  for (const m of months) {
    for (const l of statutoryDues(store, m)) {
      out.push([m, l.label, l.form, l.amount, l.due || 'state date', `${l.basis} ${l.note}`, l.cite])
    }
    for (const miss of missingHeads(store, m)) {
      out.push([m, miss.label, '', '', '', `Nothing due — ${miss.why}`, ''])
    }
  }
  return out
}

export const ANNUAL_CSV_HEADERS = [
  'FY', 'Code', 'Employee', 'Months worked', 'Gross salary', 'Standard deduction 16(ia)',
  'Professional tax 16(iii)', 'Taxable income', 'Tax before rebate', 'Rebate 87A', 'Surcharge', 'Cess',
  'Year tax', 'TDS deducted', 'Difference', 'PF employee', 'Employer cost', 'Tax modelled', 'Why not',
]

export function annualCsvRows(sheets: AnnualSheet[]): (string | number)[][] {
  return sheets.map(s => [
    s.fy, s.code, s.name, s.months_worked, s.gross_salary, s.standard_deduction, s.pt_deduction,
    s.taxable_income, s.tax_before_rebate, s.rebate, s.surcharge, s.cess, s.tax_payable, s.tds_deducted,
    s.difference, s.pf_employee, s.employer_cost, s.tax_modelled ? 'yes' : 'no', s.why_not,
  ])
}
