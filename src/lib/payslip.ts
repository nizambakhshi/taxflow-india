// Payslips — the register's own figures, laid out as the one document an employee keeps.
//
// The salary register (src/lib/payroll.ts, ADR-034) computes everything and stores nothing: gross,
// both statutory legs, the tax instalment and the take-home are re-walked on every load. What it has
// never produced is the *paper*. An employee does not want a row in a table on somebody's screen —
// they want one sheet with their name on it, their allowance lines, what was taken off, what landed,
// and the employer's signature. Every payroll product in India ships that sheet; the register here
// had the arithmetic and not the document.
//
// So this file owns the shape of the sheet and nothing else:
//
//  * **Every rupee comes from `payslipOf()`.** Not one amount is re-derived here. A slip that added
//    up its own columns could disagree with the register it came from, which is exactly the failure
//    ADR-034 exists to prevent. The breakdown lines are printed as a breakdown *of* the engine's
//    totals, and the totals are the engine's.
//  * **A slip is a statement, not a payment.** The line says *Net payable*. This document does not
//    know whether the money moved — `/expenses` and `/payments` are the only writers of money in this
//    app, and the challans are settled on the EPFO, ESIC and income-tax portals. A slip that said
//    "paid" would be a claim the register cannot support.
//  * **A slip is not Form 16.** Part A is issued out of TRACES after the 281 challan is posted; what
//    this sheet certifies is the employer's own computation for one month. It says so on the face of
//    the document rather than leaving the reader to assume.
//  * **Absence prints a dash, zero prints a claim** — the same rule the register runs on. A person
//    whose professional tax was never recorded gets a dashed line and the sentence explaining it; a
//    typed `0` gets a zero, which is a fact the owner asserted.
//  * **The letterhead prints what was typed, and names what was not.** The employer's establishment
//    code, ESIC code, PAN and GSTIN are *asked for*, never invented: a statutory-looking document
//    carrying a made-up code is worse than one carrying a dash. When the letterhead has never been
//    filled in, the slip still prints — under the workspace name, with the gaps listed beside it.
//  * **A month the register cannot compute produces no slip at all.** `printable: false` with the
//    engine's own reason: a senior citizen's tax, an unmodelled financial year, or a structure with
//    no components in it blanks the document rather than printing a salary of nothing.

import { todayISO } from '@/lib/batches'
import { round2 } from '@/lib/costcentres'
import { formatDateIN } from '@/lib/format'
import { amountInWords } from '@/lib/words'
import { INDIAN_STATES } from '@/lib/constants'
import {
  AGE_META, DUE_DAYS, ESI_BANDS, FY_LABEL, LETTERHEAD_FIELDS, LETTERHEAD_IDENTIFIERS, PF_MODE_META, PF_RATES,
  PT_ANNUAL_CAP, PT_ANNUAL_CAP_CITE, addMonths, attendanceProvenance, daysInMonthKey, depositDue,
  employeeById, emptyPayroll, fyStartOfMonth, letterheadGaps, monthEnd, monthLabel, monthRegister, payslipOf,
  rosterFor,
  type Employee, type Flag, type Letterhead, type PayrollStore, type Payslip,
} from '@/lib/payroll'

/** ₹ with Indian grouping, always to the paisa. `null` is a dash — never a zero. */
export function inr(v: number | null): string {
  return v === null ? '—' : `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** ₹ with Indian grouping, no decimals — the way a ceiling or a wage base is written on paper. */
export function inrWhole(v: number | null): string {
  return v === null ? '—' : `₹${Math.round(v).toLocaleString('en-IN')}`
}

/** One line of the slip: a label, an amount or a dash, and the small print beside it. */
export interface SlipLine {
  key: string
  label: string
  /** `null` prints a dash, with `dash` saying why there is no figure. */
  amount: number | null
  basis: string
  dash: string
}

/** One identity row — the employer's code, the employee's UAN. `recorded: false` is a named gap. */
export interface SlipField {
  label: string
  value: string
  recorded: boolean
  why: string
}

export interface PayslipDoc {
  // ── the header ──────────────────────────────────────────────────────────────
  employee_id: string
  employee_name: string
  code: string
  role: string
  month: string
  period_label: string
  fy_label: string
  computed_on: string
  /** The employer block. `name_from` says whether the name was typed or inherited from the workspace. */
  employer_name: string
  name_from: 'letterhead' | 'workspace' | 'nothing'
  address_lines: string[]
  identifiers: SlipField[]
  contact: SlipField[]
  /** Blank letterhead labels, for the strip beside the document. */
  letterhead_gaps: string[]

  // ── the employee block ──────────────────────────────────────────────────────
  employee_fields: SlipField[]

  // ── the month ───────────────────────────────────────────────────────────────
  days_in_month: number
  divisor_label: string
  lop_days: number
  /** The sheet's own sentence, when R2-32's paste put one there. '' = the month was typed by hand. */
  attendance_from: string

  earnings: SlipLine[]
  /** Monthly structure plus arrears and bonus — before anything is taken off. */
  earnings_total: number
  deductions: SlipLine[]
  /** The figure the slip totals as deductions: loss of pay with the statutory legs. */
  deduction_total: number
  /** The engine's own statutory-and-recovery total, kept separate because loss of pay is inside gross. */
  statutory_total: number
  net_pay: number
  net_words: string

  /** What the employer pays *besides* this salary — printed separately so the two never add. */
  employer_legs: SlipLine[]
  /** The sum of the legs above, so the block's own heading totals what it lists. */
  employer_legs_total: number
  employer_cost: number

  pay_day_line: string
  footnotes: string[]
  flags: Flag[]
  /** The standing sentences every slip carries, whatever the month says. */
  boundaries: string[]

  printable: boolean
  refuse_why: string

  place: string
  signatory: string
  signatory_role: string
}

/** The four sentences that belong on every slip, beside the numbers that change. */
export const PAYSLIP_BOUNDARIES: string[] = [
  'Net payable, not paid: this sheet states what the month computes to. Whether the money moved is a fact about the bank, not about this register.',
  'The statutory columns are computed, never recorded. PF, ESI, professional tax and tax on salary are re-walked from the salary structure every time a slip is opened, so a corrected component re-values the slip instead of leaving it stale.',
  'This is not Form 16. Part A is issued from TRACES against the challans the employer deposits on the income-tax portal; a month slip certifies the employer’s computation for one month only.',
  'Nothing here is filed. The EPFO ECR, the ESIC return and the 26Q statement are made on their own portals, and this register holds no challan numbers to quote.',
]

function field(label: string, raw: string, why: string): SlipField {
  const value = (raw || '').trim()
  return { label, value, recorded: !!value, why: value ? '' : why }
}

function stateLabel(code: string): string {
  return INDIAN_STATES.find(s => s.value === code)?.label || ''
}

/** The earning or deduction line for one of the six monthly components. */
function componentLine(c: { key: string; label: string; monthly: number; paid: number; in_pf: boolean }): SlipLine {
  const legs = [c.in_pf ? 'PF wages' : null, c.key === 'hra' || c.key === 'conveyance' || c.key === 'medical'
    ? 'not exempt in the default regime' : null].filter(Boolean).join(' · ')
  return {
    key: c.key,
    label: c.label,
    amount: round2(c.monthly),
    basis: legs,
    dash: '',
  }
}

/**
 * One slip, one employee, one month. `slip` is the register's own reading — the caller is expected
 * to have got it from `payslipOf()` or `monthRegister()` and not built it another way.
 */
export function buildPayslip(store: PayrollStore, slip: Payslip, workspaceName = '', today = todayISO()): PayslipDoc {
  const lh: Letterhead = store.letterhead || (emptyPayroll().letterhead)
  const employees = employeeById(store.employees)
  const employee: Employee | null = employees.get(slip.employee_id) ?? null
  const month = slip.month

  // A component the owner never filled in prints no line. Six ruled rows of which four are ₹0 is
  // how a spreadsheet looks, not a salary certificate — and dropping them cannot move a total.
  const earnings: SlipLine[] = slip.components.filter(c => c.monthly > 0).map(componentLine)
  if (slip.arrears > 0) earnings.push({ key: 'arrears', label: 'Arrears', amount: round2(slip.arrears), basis: 'Entered beside the month', dash: '' })
  if (slip.bonus > 0) earnings.push({ key: 'bonus', label: 'Bonus / ex-gratia', amount: round2(slip.bonus), basis: 'Entered beside the month', dash: '' })
  const earnings_total = round2(slip.monthly_total + slip.arrears + slip.bonus)

  const deductions: SlipLine[] = []
  if (slip.lop_deduction > 0) {
    deductions.push({
      key: 'lop',
      label: `Loss of pay (${slip.lop_days} day${slip.lop_days === 1 ? '' : 's'} of ${slip.divisor})`,
      amount: round2(slip.lop_deduction),
      basis: slip.divisor_label,
      dash: '',
    })
  }
  if (slip.pf.in_scheme) {
    deductions.push({
      key: 'pf',
      label: `Provident fund — employee ${PF_RATES.employee_pct}%`,
      amount: round2(slip.pf.employee),
      basis: `${PF_RATES.employee_pct}% of ${inrWhole(slip.pf.used)}${slip.pf.above_ceiling > 0 ? `; ${inrWhole(slip.pf.above_ceiling)} of basic sat above the ceiling and carries nothing` : ''}`,
      dash: '',
    })
  }
  if (slip.esi.covered) {
    deductions.push({
      key: 'esi',
      label: `Employee state insurance — ${ESI_BANDS[0].employee_pct}%`,
      amount: round2(slip.esi.employee),
      basis: `${ESI_BANDS[0].employee_pct}% of ${inrWhole(slip.esi.wages)}, inside the ${inrWhole(slip.esi.limit)} wage limit`,
      dash: '',
    })
  }
  deductions.push({
    key: 'pt',
    label: 'Professional tax',
    amount: slip.pt === null ? null : round2(slip.pt),
    basis: slip.pt === null ? '' : `₹${PT_ANNUAL_CAP.toLocaleString('en-IN')} a year is the most salary can carry — section 16(iii)`,
    dash: slip.pt === null
      ? 'Not recorded for this person. Nothing is deducted for it, the ₹2,500 annual cap is not claimed, and the row prints a dash rather than the ₹0 of a state that charges nothing.'
      : '',
  })
  deductions.push({
    key: 'tds',
    label: 'Income tax on salary — u/s 192',
    amount: slip.tax.applicable ? round2(slip.tds) : null,
    basis: slip.tax.applicable
      ? `One instalment of a year estimated at ${inrWhole(slip.tax.income_estimate)}, taxable ${inrWhole(slip.tax.taxable_income)}, computed tax ${inrWhole(slip.tax.annual_tax)}; ${inrWhole(slip.tax.deducted_to_date)} was taken in the months before this one`
      : '',
    dash: slip.tax.applicable ? '' : slip.tax.reason || 'No tax figure is computed for this month.',
  })
  if (slip.recovery > 0) {
    deductions.push({ key: 'recovery', label: 'Recovery', amount: round2(slip.recovery), basis: 'Entered beside the month — not a statutory leg', dash: '' })
  }

  const employer_legs: SlipLine[] = []
  if (slip.pf.in_scheme) {
    const used = slip.pf.used
    const pensionable = Math.min(used, slip.pf.eps_ceiling)
    employer_legs.push(
      { key: 'epf', label: `EPF — ${PF_RATES.epf_share_pct}%`, amount: round2(slip.pf.epf), basis: `On ${inrWhole(used)}`, dash: '' },
      { key: 'eps', label: `Pension scheme — ${PF_RATES.eps_share_pct}%`, amount: round2(slip.pf.eps), basis: `On ${inrWhole(pensionable)}, the pensionable figure set in the register`, dash: '' },
      { key: 'edli', label: `EDLI — ${PF_RATES.edli_pct}%`, amount: round2(slip.pf.edli), basis: 'Employer only', dash: '' },
      { key: 'admin', label: `Administrative charges — ${PF_RATES.admin_pct}%`, amount: round2(slip.pf.admin), basis: 'Employer only', dash: '' },
    )
  }
  if (slip.esi.covered) {
    employer_legs.push({
      key: 'esi_employer',
      label: `Employee state insurance — employer ${ESI_BANDS[0].employer_pct}%`,
      amount: round2(slip.esi.employer),
      basis: `${ESI_BANDS[0].employer_pct}% of ${inrWhole(slip.esi.wages)}`,
      dash: '',
    })
  }

  const footnotes: string[] = []
  if (slip.pf.in_scheme) footnotes.push(`PF wage ceiling for ${monthLabel(month)}: ${inrWhole(slip.pf.ceiling)}. ${slip.pf.why}`.trim())
  if (!slip.pf.in_scheme) footnotes.push(`No provident fund leg: ${PF_MODE_META.out.note}`)
  if (slip.esi.covered) footnotes.push(`ESI ${ESI_BANDS[0].cite}`)
  else footnotes.push(`ESI: ${slip.esi.why || 'Not covered this month.'}`)
  if (slip.tax.applicable) footnotes.push(`Salary tax: ${slip.tax.regime_note || 'Estimated under the default (section 115BAC) regime and spread over the months left on the rolls.'}`)
  if (slip.pt === null) footnotes.push(`Professional tax is a state subject and this person’s figure was never entered. ${PT_ANNUAL_CAP_CITE}`)
  else footnotes.push(`${PT_ANNUAL_CAP_CITE} The figure deducted here is the one recorded for this person, not a national rate.`)
  footnotes.push(
    `The month's PF and ESI fall due on ${formatDateIN(depositDue(month, 'pf_esi'))} and the salary tax on `
    + `${formatDateIN(depositDue(month, 'tds'))}${month.slice(5, 7) === '03' ? ' — March’s tax has until 30 April' : ''}. `
    + `Deposit dates: ${DUE_DAYS.cite}`,
  )
  footnotes.push('Neither amount is paid here. The ECR, the ESIC return and the tax challan are made on their own portals, and this register holds no challan number to print.')

  const identifiers = LETTERHEAD_IDENTIFIERS.map(i => field(i.label, lh[i.key], i.why))
  const address_lines = [lh.address_line1, lh.address_line2, [lh.city, lh.state, lh.pincode].filter(Boolean).join(' ')]
    .map(l => l.trim()).filter(Boolean)
  const contact = [
    field('Phone', lh.phone, 'Not recorded'),
    field('Email', lh.email, 'Not recorded'),
  ]

  const employer_name = lh.name.trim() || workspaceName.trim()
  const name_from = lh.name.trim() ? 'letterhead' as const : workspaceName.trim() ? 'workspace' as const : 'nothing' as const

  const employee_fields: SlipField[] = [
    field('Payroll number', slip.code, 'The shop has never given this person a payroll number'),
    field('Designation', slip.role || (employee?.role ?? ''), 'Not recorded'),
    field('UAN', employee?.uan ?? '', 'No Universal Account Number on the card — the EPFO portal cannot be tied to this slip'),
    field('PF account number', '', 'The register holds the UAN, not the member’s PF account number'),
    field('ESIC insurance number', employee?.esi_no ?? '', 'No ESIC IP number on the card'),
    field('PAN', employee?.pan ?? '', 'No PAN on the card, so this slip cannot be matched to a Form 16 by the department'),
    field('Work state', stateLabel(employee?.state_code ?? ''), 'Not recorded'),
    // Formatted only when the card carries a date — `formatDateIN('')` is a dash, and a dash inside
    // a value would read back as a recorded one.
    field('Date of joining', employee?.join_date ? formatDateIN(employee.join_date) : '', 'Not recorded'),
    field('Date of leaving', employee?.leave_date ? formatDateIN(employee.leave_date) : '', ''),
    field('Age band', AGE_META[employee?.age_band ?? 'below_60'].label, ''),
  ].filter(f => f.label !== 'Date of leaving' || f.recorded)

  const attendance_from = attendanceProvenance(slip.input?.note ?? '', month)

  // A month the register cannot compute produces no sheet, so neither block is laid out for it:
  // ₹0 rows of a fund this month is not in would read as contributions, which is the opposite of
  // what the register itself does with them. The reason travels in `refuse_why` instead.
  const slip_lines: SlipLine[] = slip.computable ? deductions : []
  const employer_lines: SlipLine[] = slip.computable ? employer_legs : []

  return {
    employee_id: slip.employee_id,
    employee_name: slip.name,
    code: slip.code,
    role: slip.role,
    month,
    period_label: monthLabel(month),
    fy_label: FY_LABEL(fyStartOfMonth(month)),
    computed_on: today,
    employer_name,
    name_from,
    address_lines,
    identifiers,
    contact,
    letterhead_gaps: letterheadGaps(lh),
    employee_fields,
    days_in_month: daysInMonthKey(month),
    divisor_label: slip.divisor_label,
    lop_days: slip.lop_days,
    attendance_from,
    earnings,
    earnings_total,
    deductions: slip_lines,
    deduction_total: round2(slip.lop_deduction + slip.deductions),
    statutory_total: round2(slip.deductions),
    net_pay: round2(slip.net_pay),
    net_words: amountInWords(round2(slip.net_pay)),
    employer_legs: employer_lines,
    employer_legs_total: round2(employer_lines.reduce((a, l) => a + (l.amount || 0), 0)),
    employer_cost: round2(slip.employer_cost),
    pay_day_line: store.settings.pay_day
      ? `Payable on the ${store.settings.pay_day} of ${monthLabel(addMonths(month, 1))}, as the register is set`
      : 'No pay day is recorded in the register, so the slip states no date of payment',
    footnotes,
    flags: slip.flags,
    boundaries: PAYSLIP_BOUNDARIES,
    printable: slip.computable,
    refuse_why: slip.why_not,
    place: lh.place.trim(),
    signatory: lh.signatory.trim(),
    signatory_role: lh.signatory_role.trim(),
  }
}

/** The slip for one named person in one named month, or the reason there is none. */
export function payslipFor(
  store: PayrollStore,
  employeeId: string,
  month: string,
  workspaceName = '',
  today = todayISO(),
): { doc: PayslipDoc | null; error: string } {
  const employee = store.employees.find(e => e.id === employeeId) || null
  if (!employee) return { doc: null, error: 'Nobody on this register carries that identifier — the person may have been deleted, or the link is from another organisation.' }
  const off = offRosterReason(store, employee, month)
  if (off) return { doc: null, error: off }
  const slip = payslipOf(employee, store.inputs, month, store.settings)
  return { doc: buildPayslip(store, slip, workspaceName, today), error: '' }
}

/**
 * A month outside the employment window has no salary in it. `payslipOf()` already returns a
 * refused slip for those; naming the reason here keeps the page from printing a document-shaped
 * apology when there is simply nothing to certify.
 */
function offRosterReason(store: PayrollStore, e: Employee, month: string): string {
  const { off } = rosterFor(store, month)
  const found = off.find(o => o.employee.id === e.id)
  return found ? `${found.why} ${monthLabel(month)} was never worked, so there is no slip to print for it.` : ''
}

export interface PackRefusal {
  employee_id: string
  name: string
  why: string
}

export interface PayslipPack {
  month: string
  period_label: string
  /** The slips that print, in the register's own order (biggest employer cost first). */
  docs: PayslipDoc[]
  /** Everybody in the month who gets no paper, with the reason the register gives. */
  refused: PackRefusal[]
  totals: {
    employees: number
    gross: number
    deductions: number
    net_pay: number
    employer_cost: number
  }
  /** True when at least one slip in the month is refused, so the totals are not the whole month. */
  partial: boolean
}

/**
 * The whole month as paper. Refusals are kept beside the pack rather than dropped: an owner who
 * prints "all the payslips" needs to know who was left out and why, or the pack reads as a complete
 * set when it is not one.
 */
export function monthPack(store: PayrollStore, month: string, workspaceName = '', today = todayISO()): PayslipPack {
  const slips = monthRegister(store, month)
  const docs: PayslipDoc[] = []
  const refused: PackRefusal[] = []
  for (const slip of slips) {
    if (!slip.computable) {
      refused.push({ employee_id: slip.employee_id, name: slip.name, why: slip.why_not || 'This month cannot be computed for them.' })
      continue
    }
    docs.push(buildPayslip(store, slip, workspaceName, today))
  }
  const { off } = rosterFor(store, month)
  for (const o of off) {
    const hasRow = store.inputs.some(i => i.employee_id === o.employee.id && i.month === month)
    refused.push({
      employee_id: o.employee.id,
      name: o.employee.name,
      // The same sentence the engine puts on a dash slip, so a pack and a single sheet never name
      // the missing month two different ways.
      why: `${o.why} ${monthLabel(month)} was never worked, so there is no slip to print for it.`
        + (hasRow ? ' The month row typed for them is left out of every total until the window is corrected.' : ''),
    })
  }
  const sum = (pick: (d: PayslipDoc) => number) => round2(docs.reduce((a, d) => a + pick(d), 0))
  return {
    month,
    period_label: monthLabel(month),
    docs,
    refused,
    totals: {
      employees: docs.length,
      gross: sum(d => d.earnings_total),
      deductions: sum(d => d.deduction_total),
      net_pay: sum(d => d.net_pay),
      employer_cost: sum(d => d.employer_cost),
    },
    partial: refused.length > 0,
  }
}

/** The file name an employee can find later: month, name, payroll number. */
export function payslipFilename(doc: PayslipDoc, ext = 'pdf'): string {
  // A payroll number like "A/8" would otherwise come out as "A8-" and glue itself to the next
  // segment with a doubled hyphen, so the edges are trimmed after the punctuation goes.
  const slug = (s: string) => (s || '').trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  const who = slug(doc.employee_name) || doc.employee_id.slice(0, 8)
  const code = slug(doc.code)
  return `Payslip-${doc.month}${code ? `-${code}` : ''}-${who}.${ext}`
}

/** The letterhead, as the register holds it — a blank one is a fact, not an error. */
export function letterheadOf(store: PayrollStore): Letterhead {
  return store.letterhead || emptyPayroll().letterhead
}

/** Every letterhead line the editor asks for, so the page builds its fields from the engine. */
export const LETTERHEAD_ORDER = LETTERHEAD_FIELDS

/** The slip's own date window, for the header line: 01-10-2026 → 31-10-2026. */
export function periodWindow(month: string): string {
  return `${formatDateIN(`${month}-01`)} → ${formatDateIN(monthEnd(month))}`
}
