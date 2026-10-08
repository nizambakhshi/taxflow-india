import { formatDateIN } from '@/lib/format'

export type ComplianceCategory = 'gst' | 'tds' | 'income-tax' | 'payroll' | 'other'

export interface Penalty {
  /** ₹ per day of delay, e.g. GSTR-1 is ₹50 (₹25 CGST + ₹25 SGST). */
  lateFeePerDay?: number
  /** Nil/duplicate-return daily fee where it differs. */
  nilFeePerDay?: number
  lateFeeCap?: number
  /** Simple interest per annum on the tax that went unpaid. */
  interestPct?: number
  note: string
}

export interface ComplianceEvent {
  id: string
  title: string
  form: string
  category: ComplianceCategory
  due: string
  period: string
  description: string
  amountHint?: string
  href?: string
  penalty: Penalty
}

export interface Profile {
  filing: 'monthly' | 'qrmp' | 'composition'
  taxAudit: boolean
  employees: boolean
  deductsTds: boolean
  professionalTax: boolean
}

export const DEFAULT_PROFILE: Profile = {
  filing: 'monthly', taxAudit: false, employees: false, deductsTds: true, professionalTax: false,
}

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']

/** Month index (0-11) of the n-th month of the financial year starting April `fyStart`. */
function fyMonth(fyStart: number, index: number) {
  const m = (index + 3) % 12            // April = index 0
  const y = fyStart + (index + 3 >= 12 ? 1 : 0)
  return { y, m, label: `${MONTHS[m]} ${y}` }
}

/**
 * One year of statutory deadlines for a given financial year (April `fyStart`
 * to March `fyStart + 1`). Dates follow the usual monthly/quarterly calendar;
 * notifications that shift due dates are not modelled.
 */
export function generateEvents(fyStart: number, profile: Profile = DEFAULT_PROFILE): ComplianceEvent[] {
  const events: ComplianceEvent[] = []
  const push = (e: Omit<ComplianceEvent, 'id'> & { key: string }) => {
    const { key, ...rest } = e
    events.push({ id: `${fyStart}-${key}`, ...rest })
  }

  for (let i = 0; i < 12; i++) {
    const supply = fyMonth(fyStart, i)                 // period being reported
    const next = fyMonth(fyStart, i + 1)               // month the return falls in

    if (profile.filing === 'composition') {
      if ([2, 5, 8, 11].includes(i)) {                 // quarter-ending month
        const q = fyMonth(fyStart, i + 1)
        push({
          key: `cmp-${q.y}-${q.m}`, title: 'CMP-08 composition return', form: 'CMP-08',
          category: 'gst', due: iso(q.y, q.m + 1, 18),
          period: `for ${quarterLabel(supply, i)}`,
          description: 'Quarterly composition-scheme tax payment and return.',
          href: '/gst/gstr4',
          penalty: { lateFeePerDay: 50, lateFeeCap: 5000, interestPct: 18, note: '₹50/day, and 18% interest on the tax short-paid.' },
        })
      }
    } else if (profile.filing === 'qrmp') {
      const quarterEnd = [2, 5, 8, 11].includes(i)
      if (quarterEnd) {
        const q = fyMonth(fyStart, i + 1)
        push({
          key: `r1-${q.y}-${q.m}`, title: 'GSTR-1 quarterly return', form: 'GSTR-1',
          category: 'gst', due: iso(q.y, q.m + 1, 11),
          period: `for ${quarterLabel(supply, i)}`,
          description: 'Outward supplies statement under the QRMP scheme.',
          href: '/gst/gstr1',
          penalty: { lateFeePerDay: 50, nilFeePerDay: 20, lateFeeCap: 5000, note: '₹50/day (₹20/day on a nil return), capped at ₹5,000 per GSTIN.' },
        })
        push({
          key: `iff-${q.y}-${q.m}`, title: 'Invoice Furnishing Facility', form: 'IFF',
          category: 'gst', due: iso(q.y, q.m + 1, 13),
          period: `for ${MONTHS[supply.m]} ${supply.y}`,
          description: 'Upload B2B invoices of the first two months of the quarter.',
          href: '/gst/gstr1',
          penalty: { note: 'Invoices slip to the next quarter, delaying your buyers’ ITC.' },
        })
      }
    } else {
      push({
        key: `r1-${next.y}-${next.m}`, title: 'GSTR-1 outward supplies', form: 'GSTR-1',
        category: 'gst', due: iso(next.y, next.m + 1, 11),
        period: `for ${supply.label}`,
        description: 'Every invoice, debit and credit note raised in the month.',
        href: '/gst/gstr1',
        penalty: { lateFeePerDay: 50, nilFeePerDay: 20, lateFeeCap: 5000, note: '₹50/day (₹20/day on a nil return), capped at ₹5,000 per GSTIN.' },
      })
    }

    if (profile.filing !== 'composition') push({
      key: `r3b-${next.y}-${next.m}`, title: 'GSTR-3B summary return', form: 'GSTR-3B',
      category: 'gst', due: iso(next.y, next.m + 1, 20),
      period: `for ${supply.label}`,
      description: 'Summary of supplies with the tax payment.',
      href: '/gst/gstr3b',
      penalty: { interestPct: 18, note: 'No late fee since Circular 231/2024, but 18% p.a. interest runs on the unpaid tax.' },
    })

    if (profile.deductsTds) {
      push({
        key: `tdsp-${next.y}-${next.m}`, title: 'TDS deposit', form: 'Challan 281',
        category: 'tds', due: iso(next.y, next.m + 1, 7),
        period: `for ${supply.label}`,
        description: 'Tax deducted at source in the month, paid to the exchequer.',
        penalty: { interestPct: 12, note: '1%–1.5% per month of interest under sections 201(1A) and 201(1).' },
      })
    }

    if (profile.employees) {
      push({
        key: `pf-${next.y}-${next.m}`, title: 'EPF & ESI contribution', form: 'ECR',
        category: 'payroll', due: iso(next.y, next.m + 1, 15),
        period: `for ${supply.label}`,
        description: 'Provident fund and employee state insurance for the month.',
        penalty: { note: 'EPF: 5%–12% per month damages under para 69; ESI: 12% per month.' },
      })
    }

    if (profile.professionalTax) {
      push({
        key: `pt-${next.y}-${next.m}`, title: 'Professional tax', form: 'PT',
        category: 'other', due: iso(next.y, next.m + 1, 21),
        period: `for ${supply.label}`,
        description: 'State professional tax on salaries (date varies by state).',
        penalty: { note: 'Typically ₹1,000–₹5,000 plus 1.25–2% per month, state by state.' },
      })
    }
  }

  const nextYear = fyStart + 1
  const tdsQuarters: { due: [number, number, number], label: string }[] = [
    { due: [fyStart, 6, 31], label: 'Q1 (Apr–Jun)' },
    { due: [fyStart, 9, 31], label: 'Q2 (Jul–Sep)' },
    { due: [nextYear, 0, 31], label: 'Q3 (Oct–Dec)' },
    { due: [nextYear, 4, 31], label: 'Q4 (Jan–Mar)' },
  ]
  if (profile.deductsTds) {
    for (const q of tdsQuarters) {
      push({
        key: `tdsr-${q.due[0]}-${q.due[1]}`, title: 'TDS / TCS statement', form: '24Q · 26Q',
        category: 'tds', due: iso(q.due[0], q.due[1] + 1, q.due[2]),
        period: `for ${q.label}`,
        description: 'Quarterly statement of tax deducted and deposited.',
        penalty: { lateFeePerDay: 200, note: '₹200/day under section 234E, capped at the TDS amount.' },
      })
    }
  }

  const advance: { m: number, d: number, pct: string }[] = [
    { m: 5, d: 15, pct: '15% of estimated tax' },
    { m: 8, d: 15, pct: '45% cumulative' },
    { m: 11, d: 15, pct: '75% cumulative' },
    { m: 2, d: 15, pct: '100% cumulative', },
  ]
  advance.forEach((a, idx) => {
    const y = a.m >= 3 ? fyStart : nextYear
    push({
      key: `at-${y}-${a.m}`, title: `Advance tax instalment ${idx + 1}`, form: '1902/1903',
      category: 'income-tax', due: iso(y, a.m + 1, a.d),
      period: `${a.pct}`,
      description: 'Pay-as-you-earn instalment on the estimated annual liability.',
      penalty: { interestPct: 1, note: '1% p.a. under 234B plus 1% per month under 234C on the shortfall.' },
    })
  })

  push({
    key: `itr-${nextYear}`, form: 'ITR', title: 'Income tax return',
    category: 'income-tax',
    due: iso(nextYear, profile.taxAudit ? 10 : 7, 31),
    period: `for FY ${fyStart}-${String(nextYear).slice(2)}`,
    description: profile.taxAudit
      ? 'Audit cases: return after the tax audit report is filed.'
      : 'Non-audit cases. Belated return window closes 31 December.',
    penalty: { lateFeePerDay: 0, note: '₹5,000 fees under 234F (₹1,000 below ₹5 lakh income) plus 1% p.a. under 234A.' },
  })

  push({
    key: `gstr9-${nextYear}`, form: 'GSTR-9', title: 'GSTR-9 annual return',
    category: 'gst', due: iso(nextYear, 12, 31),
    period: `for FY ${fyStart}-${String(nextYear).slice(2)}`,
    description: 'Annual reconciliation of GSTR-1 against GSTR-3B, with the GSTR-9C certificate.',
    href: '/gst/reconciliation',
    penalty: { lateFeePerDay: 200, lateFeeCap: 5000, note: '₹100 per GSTIN per day (₹200 total), capped at 0.25% of turnover.' },
  })

  if (profile.filing === 'composition') {
    push({
      key: `gstr4-${nextYear}`, form: 'GSTR-4', title: 'GSTR-4 annual return',
      category: 'gst', due: iso(nextYear, 4, 30),
      period: `for FY ${fyStart}-${String(nextYear).slice(2)}`,
      description: 'Annual statement for composition dealers.',
      href: '/gst/gstr4',
      penalty: { lateFeePerDay: 50, lateFeeCap: 5000, note: '₹50/day, and 18% interest on tax unpaid.' },
    })
  }

  return events.sort((a, b) => a.due.localeCompare(b.due))
}

function quarterLabel(supply: { y: number, m: number, label: string }, index: number) {
  const q = Math.floor(index / 3) + 1
  return `Q${q} ${supply.y}-${String(supply.y + 1).slice(2)}`
}

export interface LateCharge {
  fee: number
  interest: number
  total: number
  note: string
}

/** What a delay actually costs — the reason this calendar exists. */
export function estimateLateCharge(
  event: ComplianceEvent, daysLate: number, taxPayable = 0, nil = false,
): LateCharge {
  if (daysLate <= 0) return { fee: 0, interest: 0, total: 0, note: event.penalty.note }
  const perDay = nil && event.penalty.nilFeePerDay ? event.penalty.nilFeePerDay : (event.penalty.lateFeePerDay || 0)
  const raw = perDay * daysLate
  const fee = event.penalty.lateFeeCap ? Math.min(raw, event.penalty.lateFeeCap) : raw
  const interest = event.penalty.interestPct
    ? taxPayable * (event.penalty.interestPct / 100) * (daysLate / 365)
    : 0
  return { fee, interest, total: fee + interest, note: event.penalty.note }
}

// ── Filing status (localStorage — no schema change) ──────
const KEY_PREFIX = 'taxflow:compliance:'

export type StatusMap = Record<string, { doneOn: string; reference?: string }>

export function loadStatuses(orgId: string): StatusMap {
  if (typeof window === 'undefined' || !orgId) return {}
  try { return JSON.parse(localStorage.getItem(KEY_PREFIX + orgId) || '{}') } catch { return {} }
}

export function saveStatuses(orgId: string, statuses: StatusMap): void {
  if (typeof window === 'undefined' || !orgId) return
  try { localStorage.setItem(KEY_PREFIX + orgId, JSON.stringify(statuses)) } catch { /* non-critical */ }
}

// ── Calendar export ──────
function stamp(date: string) { return date.replace(/-/g, '') }

export function googleCalendarUrl(event: ComplianceEvent, business: string): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${event.form} — ${business}`.slice(0, 100),
    dates: `${stamp(event.due)}/${stamp(event.due)}`,
    details: `${event.description}\nPeriod: ${event.period}\nMade with TaxFlow India`,
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

/** All-day events in .ics so the whole FY can be dropped into any calendar app. */
export function toIcs(events: ComplianceEvent[], business: string): string {
  const esc = (s: string) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n')
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TaxFlow India//Compliance//EN',
    'CALSCALE:GREGORIAN',
  ]
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.id}@taxflow-india`,
      `DTSTAMP:${stamp(new Date().toISOString().slice(0, 10))}T000000`,
      `DTSTART;VALUE=DATE:${stamp(e.due)}`,
      `SUMMARY:${esc(`${e.form} — ${e.title} (${business})`)}`,
      `DESCRIPTION:${esc(`${e.description}\n${e.period}\n${e.penalty.note}`)}`,
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

export function eventDateLabel(event: ComplianceEvent): string {
  return formatDateIN(event.due)
}
