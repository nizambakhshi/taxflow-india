import { formatDateIN } from '@/lib/format'
import { INDIAN_STATES } from '@/lib/constants'
import { TDS_STATEMENT_FEE_CITATION, TDS_STATEMENT_FEE_PER_DAY } from '@/lib/tds'

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
  /**
   * Two digits of the GSTIN — the state of the principal place of business. Only a QRMP filer is
   * split by it: rule 61(1)(ii) puts the summary return on the twenty-second day for the states in
   * the first row of its table and the twenty-fourth for the second, so without a state the calendar
   * can name the quarter but not the day. It is optional, and `DEFAULT_PROFILE` leaves it blank.
   */
  stateCode?: string
}

export const DEFAULT_PROFILE: Profile = {
  filing: 'monthly', taxAudit: false, employees: false, deductsTds: true, professionalTax: false,
}

/* ── rule 61(1)(ii)'s two rows of states ────────────────────────────────────── */

/**
 * The two lists in the table to rule 61(1)(ii), read from the rule text and matched by state *name*
 * against `INDIAN_STATES` — the codes in that list are the app's own and are not all the codes the
 * portal issues, so a name is the safer key. One table, two readers: the calendar's emitter uses it
 * to date a quarterly return and `filings.ts` uses it to check the date the calendar printed, so the
 * two screens cannot drift apart on which day a state is in.
 *
 * Read off the rule as CBIC prints it, not off a summary: Chandigarh and Delhi are both in the
 * twenty-fourth row, and the twenty-second row's union-territory list is Daman and Diu, Dadra and
 * Nagar Haveli, Puducherry, Andaman and Nicobar Islands and Lakshadweep. A reorganisation notice has
 * merged the first two into one Union territory since, which the rule's own table has not been
 * re-tabulated for — the app places both names, so either spelling of that shop's state lands on the
 * twenty-second rather than going unanswered.
 */
const QRMP_TWENTY_SECOND = [
  'chhattisgarh', 'madhya pradesh', 'gujarat', 'maharashtra', 'karnataka', 'goa', 'kerala',
  'tamil nadu', 'telangana', 'andhra pradesh', 'andhra pradesh (old)', 'daman & diu',
  'dadra & nagar haveli', 'puducherry', 'andaman & nicobar islands', 'lakshadweep',
]
const QRMP_TWENTY_FOURTH = [
  'himachal pradesh', 'punjab', 'uttarakhand', 'haryana', 'rajasthan', 'uttar pradesh', 'bihar',
  'sikkim', 'arunachal pradesh', 'nagaland', 'manipur', 'mizoram', 'tripura', 'meghalaya', 'assam',
  'west bengal', 'jharkhand', 'odisha', 'jammu & kashmir', 'jammu and kashmir', 'ladakh',
  'chandigarh', 'delhi',
]

export interface QrmpCategory {
  day: 22 | 24
  state: string
  cited: string
}

/** Which of rule 61(1)(ii)'s two rows a shop sits in — or null when the app cannot say. */
export function qrmpCategory(stateCode: string | undefined): QrmpCategory | null {
  const code = (stateCode ?? '').trim()
  if (!code) return null
  const hit = INDIAN_STATES.find(s => s.value === code)
  if (!hit) return null
  const name = hit.label.toLowerCase().trim()
  const cited = 'rule 61(1)(ii), Table row '
  if (QRMP_TWENTY_SECOND.includes(name)) return { day: 22, state: hit.label, cited: cited + '1 (twenty-second day)' }
  if (QRMP_TWENTY_FOURTH.includes(name)) return { day: 24, state: hit.label, cited: cited + '2 (twenty-fourth day)' }
  return null
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
 * One year of statutory deadlines for a given financial year (April `fyStart` to March
 * `fyStart + 1`), shaped by how this shop actually files: a monthly filer gets twelve GSTR-1s and
 * twelve GSTR-3Bs, a QRMP filer gets four of each **plus** the eight deposits and eight IFF windows
 * the quarter leaves behind, and a composition dealer gets four CMP-08s and a GSTR-4 for the year.
 *
 * Two limits are printed rather than hidden. Dates that the rules themselves state — the twentieth
 * under rule 61(1)(i), the twenty-second or twenty-fourth under rule 61(1)(ii), the eighteenth under
 * rule 62(1)(i), the twenty-fifth under rule 61(3) and the thirteenth that closes the IFF window under
 * rule 59(2) — are derived here; the dates the CBIC sets by notification (GSTR-1's eleventh, a quarter's
 * thirteenth) are the app's reading of the current table and no notification shift in this year is
 * modelled. And a quarterly filer whose state is not named cannot be placed in either row of
 * rule 61(1)(ii)'s table: the earlier of the two days is printed, the row says so, and the filings
 * register at `/gst/filings` prints that date as unchecked rather than confirmed.
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
          period: `for ${quarterLabel(fyStart, i)}`,
          description: 'Quarterly composition-scheme tax payment and return.',
          href: '/gst/gstr4',
          penalty: { lateFeePerDay: 50, lateFeeCap: 5000, interestPct: 18, note: '₹50/day, and 18% interest on the tax short-paid.' },
        })
      }
    } else if (profile.filing === 'qrmp') {
      // A QRMP filer files quarterly and pays monthly, so only the money keeps a month: rule 59 gives
      // the quarter its GSTR-1, rule 61(1)(ii) gives the quarter its summary return, and rule 61(3)
      // asks for a deposit in FORM GST PMT-06 on the twenty-fifth of each of the quarter's first two
      // months. Emitting the twelve monthly summary rows instead — which is what this file used to do
      // — put a date on the calendar that the rule this shop is under cannot produce.
      if ([2, 5, 8, 11].includes(i)) {
        const cat = qrmpCategory(profile.stateCode)
        push({
          key: `r1-${next.y}-${next.m}`, title: 'GSTR-1 quarterly return', form: 'GSTR-1',
          category: 'gst', due: iso(next.y, next.m + 1, 13),
          period: `for ${quarterLabel(fyStart, i)}`,
          description: 'Outward supplies statement for the quarter under the QRMP scheme — the eleventh is a monthly filer\'s date; a quarter\'s statement is on the thirteenth.',
          href: '/gst/gstr1',
          penalty: { lateFeePerDay: 50, nilFeePerDay: 20, lateFeeCap: 5000, note: '₹50/day (₹20/day on a nil return), capped at ₹5,000 per GSTIN.' },
        })
        push({
          key: `r3b-${next.y}-${next.m}`, title: 'GSTR-3B quarterly summary', form: 'GSTR-3B',
          category: 'gst', due: iso(next.y, next.m + 1, cat ? cat.day : 22),
          period: `for ${quarterLabel(fyStart, i)}`,
          description: cat
            ? `Summary of the quarter's supplies with the tax payment. ${cat.state} is in ${cat.cited}, so the return is on the ${cat.day === 22 ? 'twenty-second' : 'twenty-fourth'} day of the month succeeding the quarter.`
            : 'Summary of the quarter\'s supplies with the tax payment. Rule 61(1)(ii) puts it on the twenty-second day for the states in the first row of its table and the twenty-fourth for the second; the earlier of the two is printed here until the state is named above, and the filings register refuses to check the date until it is.',
          href: '/gst/gstr3b',
          penalty: { interestPct: 18, note: 'No late fee since Circular 231/2024, but 18% p.a. interest runs on the unpaid tax.' },
        })
      } else {
        // The first two months of a quarter carry paper and money but no return: the invoices go up
        // through the IFF, the tax through PMT-06, and both are repeated inside the quarter's own two
        // dates above. The third month of a quarter has neither — its invoices are the quarter's GSTR-1.
        push({
          key: `iff-${supply.y}-${pad(supply.m + 1)}`, title: 'Invoice Furnishing Facility', form: 'IFF',
          category: 'gst', due: iso(next.y, next.m + 1, 13),
          period: `for ${supply.label}`,
          description: 'B2B invoices of this month, furnished while the quarter is still running so your buyers can take credit before the quarter\'s statement — up to a cumulative ₹50 lakh of business-to-business supplies a month, inter-State and intra-State both (rule 59(5)(a) names both of them), and nothing furnished here may be furnished again in that quarter\'s GSTR-1 (rule 59(3)).',
          href: '/gst/gstr1',
          penalty: { note: 'Rule 59(2) fixes the window in its own words: it opens "from the 1st day of the month succeeding such month till the 13th day of the said month", so no circular has to be read into it and nothing here is a choice between two readings. Invoices that miss it wait for the quarter\'s statement and hold up your buyers’ ITC. No fee runs on the window either: rule 59(2) reads "may furnish", and section 47’s late fee attaches to a default in furnishing a return, which this is not.' },
        })
        push({
          key: `pmt06-${supply.y}-${pad(supply.m + 1)}`, title: 'PMT-06 monthly tax deposit', form: 'PMT-06',
          category: 'gst', due: iso(next.y, next.m + 1, 25),
          period: `for ${supply.label}`,
          description: 'The deposit that keeps a QRMP filer paying monthly while filing quarterly. Rule 61(3) asks for "the tax due under proviso to sub-section (7) of section 39" for each of the quarter\'s first two months, deposited in FORM GST PMT-06 "by the twenty fifth day of the month succeeding such month". The rule states no sum of money, because section 39(7) leaves the amount to be notified. The fixed sum is notified law — Notification No. 85/2020-Central Tax, dated 10.11.2020, issued under section 148 read with the proviso to section 39(7), prescribes it as thirty-five per cent of the tax paid by debiting the electronic cash ledger in the return for the preceding quarter — and the Board spells out both shapes it takes in Circular No. 143/13/2020-GST, dated 10.11.2020, para 6.1: that fixed sum, which the portal pre-fills, or a self-assessed amount for this month\'s own liability. Whatever the two deposits leave unpaid is settled by the quarter\'s summary return, and rule 61(4) debits against it what was already put in.',
          href: '/gst/gstr3b',
          penalty: { interestPct: 18, note: 'Nothing is charged per day on a deposit — it is not a return under section 39, so section 47\'s late fee does not reach it. What does run is interest: para 8.1(ii) of Circular No. 143/13/2020-GST, dated 10.11.2020, payable "at the applicable rate" from the twenty-fifth till the day the cash arrives, and this app works it at the eighteen per annum of section 50(1) that the filings register uses everywhere. Para 8.1(i) is the relief beside it: deposit the system-calculated fixed sum on time and clear the whole quarter in its own GSTR-3B by its due date, and no interest is charged even when the month\'s real liability turned out higher than the deposit.' },
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

    // Rule 61(1)(i) puts a monthly filer's summary return on the twentieth; rule 61(1)(ii) puts a
    // quarterly filer's on the twenty-second or twenty-fourth after the quarter, which is emitted in
    // the branch above, and a composition dealer files no GSTR-3B at all.
    if (profile.filing === 'monthly') push({
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
        penalty: {
          lateFeePerDay: TDS_STATEMENT_FEE_PER_DAY,
          note: `₹${TDS_STATEMENT_FEE_PER_DAY}/day under ${TDS_STATEMENT_FEE_CITATION}, capped at the TDS amount.`,
        },
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
      // The proviso to rule 62(1)(ii) moved the composition year's return from 30 April to 30 June for
      // FY 2024-25 onwards; the older date still stands for a year before that.
      category: 'gst', due: iso(nextYear, fyStart >= 2024 ? 6 : 4, 30),
      period: `for FY ${fyStart}-${String(nextYear).slice(2)}`,
      description: 'Annual statement for composition dealers.',
      href: '/gst/gstr4',
      penalty: { lateFeePerDay: 50, lateFeeCap: 5000, note: '₹50/day, and 18% interest on tax unpaid.' },
    })
  } else {
    push({
      key: `cmp02-${nextYear}`, form: 'CMP-02', title: 'Composition scheme opt-in',
      category: 'gst', due: iso(nextYear, 3, 31),
      period: `to switch to composition for FY ${nextYear}-${String(nextYear + 1).slice(2)}`,
      description: 'Only if you want to move to the composition scheme — goods up to ₹1.5 crore, services up to ₹50 lakh (₹75 lakh / ₹25 lakh in the special-category states). A composition dealer cannot collect GST or claim input credit.',
      href: '/gst/gstr4',
      penalty: { note: 'Miss 31 March and the scheme cannot start until the following year.' },
    })
  }

  return events.sort((a, b) => a.due.localeCompare(b.due))
}

function quarterLabel(fyStart: number, index: number) {
  const q = Math.floor(index / 3) + 1
  // The quarter belongs to the financial year that started in April `fyStart`, whatever calendar year
  // its last month falls in — Q4 of FY 2026-27 ends in March 2027 and must not read "2027-28".
  return `Q${q} ${fyStart}-${String(fyStart + 1).slice(2)}`
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

export type StatusMap = Record<string, { doneOn: string; reference?: string; cashTax?: number }>

/**
 * The cash tax a shop says actually left the electronic cash ledger in a quarter, kept against the
 * quarter (not the month's deposit) on the same `taxflow:compliance:` envelope as the ticks. Rule 61(3)
 * takes PMT-06 at thirty-five per cent of that *cash* figure, which no register here holds — the filings
 * rows keep what a return *stated* in total, and the credit leg it was settled from is not one of them —
 * so the shop states it once per quarter and both of that quarter's deposits read it.
 */
const CASH_KEY = 'cash:'
export function cashTaxKey(period: string): string { return CASH_KEY + period }
/** Whether a key on the calendar's own envelope is a stated cash tax rather than a filed tick. */
export function isCashTaxKey(key: string): boolean { return key.startsWith(CASH_KEY) }
export function enteredCashTax(statuses: StatusMap, period: string): number {
  const v = statuses[cashTaxKey(period)]?.cashTax
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}
export function withEnteredCashTax(statuses: StatusMap, period: string, value: number): StatusMap {
  const key = cashTaxKey(period)
  const entry = statuses[key]
  const next = { ...statuses }
  if (value > 0) next[key] = { doneOn: entry?.doneOn ?? '', reference: entry?.reference, cashTax: value }
  else if (entry) {
    /** A new entry object, never a delete on the one passed in — the caller's map is React state. */
    if (entry.doneOn || entry.reference) next[key] = { doneOn: entry.doneOn, reference: entry.reference }
    else delete next[key]
  }
  return next
}

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
