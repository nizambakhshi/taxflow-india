// Filings — the history of what was told to the department, and the paper that missed the window.
//
// Why this exists: the review that opened R3 lists, under GST, "live GSP workflows, **filing-status
// history, amendment tracking** and period locks" (`TaxFlow Feature_1.pdf`, p. 2). Period locks
// landed as R3-1 and the ledger's shape as R3-2. The other two had no home: `/gst/calendar` knows a
// return is *due* and carries a tick ("done on", a free-text reference in `taxflow:compliance:<org>`),
// `/gst/gstr9` knows what a year's 3B *stated* for the 9C workpaper, and between those two the shop
// had nowhere that answers the two questions a department actually asks — *when did you file each
// period, was it late, what did it say, and what did you do about the invoice you forgot?* The
// calendar's tick cannot answer the second half at all; the workpaper cannot answer the first.
//
// It rides on localStorage (ADR-013) as `taxflow:filings:<orgId>` at version 1, joins the vault in
// the same round it is created (Rule 31), and holds no rupee of its own: the figures on a row are a
// **transcript of what the return said**, not a posting. Nothing in `ledger.ts` reads this register.
//
// The four decisions that make it trustworthy rather than decorative:
//
//  * **The due date is snapshotted, then audited.** Each row copies the date the app's calendar
//    stated (`due`) and keeps `due_reason` for a date the shop replaced after a notification. On top
//    of that, `statutoryDue()` re-derives the date from the rule text for the forms where the rule
//    states one — 20th under rule 61(1)(i), 22nd or 24th under rule 61(1)(ii) by the state your
//    principal place of business is in, 18th under rule 62(1)(i), 30th June under the proviso to rule
//    62(1)(ii) from FY 2024-25 — and `expectedRows()` prints every place the two disagree. A
//    register that silently trusts its own calendar is a register that repeats a mistake forever.
//    Two shapes of that disagreement are worth naming. `compliance.ts` emits a **monthly** summary row
//    even for a quarterly filer, so `eventPeriod()` folds twelve of those rows into the four quarters
//    rule 61(1)(ii) actually speaks of — and says so in `calendarObjections()` instead of hiding the
//    fold. And Q4 of a financial year is January–March of the *following* calendar year, so a quarter's
//    statutory due date has to carry that year with it; a roll that lost it dated a 2026-Q4 return in
//    April 2026, a year early.
//  * **Late fee is computed by the slab that applies, not the headline the app prints.** Section 47
//    says ₹50 a day capped at ₹5,000; Notifications No. 19, 20 and 21/2021-Central Tax, dated
//    01.06.2021, cut the ceiling to ₹2,000 up to ₹1.5 crore of the preceding year's turnover, ₹5,000
//    up to ₹5 crore, ₹10,000 above it, and ₹500 on a nil return; Notification No. 07/2023-Central
//    Tax, dated 31.03.2023, gives GSTR-9 its own three slabs of ₹50/₹100/₹200 a day capped at 0.04%
//    or 0.50% **of the turnover in that State or Union territory**. `estimateLateFee()` applies those
//    and prints which notification decided the number, so the ₹5,000 headline on `/gst/calendar` is
//    shown beside the figure, never merged into it (Rule 33).
//  * **An amendment is dated against the window that still allows it.** Three mechanisms, each with
//    its own clock: the option in the proviso to rule 59(1) to amend outward details in FORM
//    GSTR-1A *"after furnishing the details … in FORM GSTR-1 for a tax period but before filing of
//    return in FORM GSTR-3B for the said tax period"* — so the door shuts the moment that period's
//    3B goes in; Table 9A of the annual return, open until GSTR-9 is actually filed; and the
//    recipient's credit, which section 16(4) — reproduced verbatim in Circular No. 237/31/2024-GST,
//    dated 15.10.2024 — closes on *"the thirtieth day of November following the end of financial year
//    … or furnishing of the relevant annual return, whichever is earlier"*. `windowsFor()` computes
//    all three per period, and an amendment whose windows have all shut prints as lapsed, because a
//    correction nobody can use is not a to-do.
//  * **The chain the rules already enforce is spelled out.** Rule 59(6) does not allow a GSTR-1 (or
//    the IFF, for a quarterly filer) when the return in FORM GSTR-3B for the preceding period has not
//    been furnished, and rule 59(6)(d) stops the next GSTR-1 while an intimation under rule 88C(1)
//    stands unpaid or unanswered. `consequencesFor()` reads the register for exactly those two bars,
//    cites them, and points at the row that has to go in first.
//
// What v1 deliberately does NOT do: it does not talk to the portal — no GSP feed, no ITR-V, no ARN
// verification (`reference` is stored as the shop writes it and the register says it never checks it);
// it files nothing and pays nothing, so a row here cannot discharge the liability on `/gst/gstr3b` or
// move the cash ledger. It does not ask the seal: a filing record moves no rupee on the statements, so
// R3-1's door is not a door on this register — it *reads* seals for a badge and offers "seal this
// period" through `sealFilingsPeriod()`, which hands the work to /audit's `sealPeriod()` and keeps its
// rules, and every status change writes one line to that same trail.
// The Invoice Furnishing Facility, refunds, DRC notices, and the PMT-06 deposit a QRMP filer owes by
// the 25th under rule 61(3) are named in `NOT_TRACKED` with their rule, not quietly left out.

import {
  DEFAULT_PROFILE, generateEvents, loadStatuses,
  type ComplianceEvent, type Profile, type StatusMap,
} from '@/lib/compliance'
import { RECON_TOLERANCE, emptyHeads, headsOf, round2, type Heads } from '@/lib/gstr9'
import {
  fyLabel as auditFyLabel, loadAudit, monthLabel, recordNote, sealForDate, sealPeriod, todayISO,
  type AuditStore, type PeriodSeal, type SealResult,
} from '@/lib/audit'
import { INDIAN_STATES } from '@/lib/constants'

const KEY_FILINGS = 'taxflow:filings:'
export const FILINGS_VERSION = 1
export const FILINGS_KEY_PREFIX = KEY_FILINGS

/* ── the forms this register keeps ──────────────────────────────────────────── */

export type FilingForm = 'gstr1' | 'gstr1a' | 'gstr3b' | 'cmp08' | 'gstr4' | 'gstr9'
export const FORMS: FilingForm[] = ['gstr1', 'gstr1a', 'gstr3b', 'cmp08', 'gstr4', 'gstr9']

export type PeriodKind = 'month' | 'quarter' | 'year'

/** What a row of this register is, in law, and where its date comes from. */
export interface FormMeta {
  label: string
  /** The obligation. */
  section: string
  /** The rule that fixes the form and, where the rule states it, the date. */
  rule: string
  cadence: PeriodKind[]
  what: string
  /** Whether a late fee runs on this form at all, and which slab table governs it. */
  fee: 'statement' | 'summary' | 'composition' | 'annual' | 'none'
  optional: boolean
  href: string
}

export const FORM_META: Record<FilingForm, FormMeta> = {
  gstr1: {
    label: 'GSTR-1', section: 'section 37(1)', rule: 'rule 59(1)', cadence: ['month', 'quarter'],
    what: 'Details of outward supplies — every invoice, note and entry the month (or quarter) held.',
    fee: 'statement', optional: false, href: '/gst/gstr1',
  },
  gstr1a: {
    label: 'GSTR-1A', section: 'section 37(1)', rule: 'proviso to rule 59(1)',
    cadence: ['month', 'quarter'],
    what: 'The one optional amendment: added or corrected outward details for a period whose GSTR-1 is in and whose GSTR-3B is not.',
    fee: 'none', optional: true, href: '/gst/gstr1',
  },
  gstr3b: {
    label: 'GSTR-3B', section: 'section 39(1)', rule: 'rule 61(1)', cadence: ['month', 'quarter'],
    what: 'The summary return with the payment — the period as the department books it.',
    fee: 'summary', optional: false, href: '/gst/gstr3b',
  },
  cmp08: {
    label: 'CMP-08', section: 'section 10(2)', rule: 'rule 62(1)(i)', cadence: ['quarter'],
    what: 'The quarterly self-assessed statement a composition dealer pays against.',
    fee: 'composition', optional: false, href: '/gst/gstr4',
  },
  gstr4: {
    label: 'GSTR-4', section: 'section 10(2)', rule: 'rule 62(1)(ii)', cadence: ['year'],
    what: 'The annual statement and return for the composition scheme.',
    fee: 'composition', optional: false, href: '/gst/gstr4',
  },
  gstr9: {
    label: 'GSTR-9', section: 'section 59', rule: 'the date is notified under section 59',
    cadence: ['year'],
    what: 'The annual return reconciling GSTR-1 against GSTR-3B, with Table 9A for what GSTR-1 missed.',
    fee: 'annual', optional: false, href: '/gst/gstr9',
  },
}

/** The calendar's `form` strings, mapped onto the forms this register keeps. */
export const FORM_BY_CALENDAR: Record<string, FilingForm> = {
  'GSTR-1': 'gstr1', 'GSTR-3B': 'gstr3b', 'CMP-08': 'cmp08', 'GSTR-4': 'gstr4', 'GSTR-9': 'gstr9',
}

/** GST paper the calendar carries and this register deliberately does not. */
export const UNTRACKED_CALENDAR_FORMS: Record<string, string> = {
  IFF: 'The Invoice Furnishing Facility is not a return with a payment. Rule 59(2) gives it a window '
    + 'from the 1st to the 13th of the month succeeding, for the first two months of a quarter, up to '
    + '₹50 lakh of B2B value a month — and rule 59(3) says what goes through it must not be furnished '
    + 'again in that quarter\'s GSTR-1. Nothing here tracks it.',
  'CMP-02': 'The composition opt-in under section 10(2) is an election, not a filing. This register '
    + 'keeps returns and statements; the opt-in date stays on /gst/calendar.',
}

/* ── periods: one key shape, three cadences ────────────────────────────────── */

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/
const QUARTER_RE = /^(\d{4})-Q([1-4])$/
const YEAR_RE = /^\d{4}$/

const pad2 = (n: number) => String(n).padStart(2, '0')
const isoDate = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`

const isDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))

/** `2026-03` → 2026-04; the calendar states a due date, the register stores the period. */
function monthBefore(y: number, m: number): { y: number, m: number } {
  return m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 }
}
function monthAfter(y: number, m: number): { y: number, m: number } {
  return m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 }
}
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getDate()
}

/** The financial year a month falls in, by its April start. */
export function fyStartOfMonth(month: string): number {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return m >= 4 ? y : y - 1
}

/** Which quarter of the financial year a month is in — Q1 is April to June. */
export function quarterOfMonth(y: number, m: number): { q: number, fy: number } {
  return { q: Math.floor(((m + 8) % 12) / 3) + 1, fy: m >= 4 ? y : y - 1 }
}

export interface ParsedPeriod {
  kind: PeriodKind
  /** Month: the year of the month. Quarter/annual: the FY start year. */
  y: number
  m?: number
  q?: number
}

export function parsePeriod(period: string): ParsedPeriod | null {
  const p = (period ?? '').trim()
  const mo = MONTH_RE.exec(p)
  if (mo) return { kind: 'month', y: Number(mo[1]), m: Number(mo[2]) }
  const q = QUARTER_RE.exec(p)
  if (q) return { kind: 'quarter', y: Number(q[1]), q: Number(q[2]) }
  if (YEAR_RE.test(p)) return { kind: 'year', y: Number(p) }
  return null
}

export function periodKindOf(period: string): PeriodKind | null {
  return parsePeriod(period)?.kind ?? null
}

/** '2026-03' → 'March 2026' · '2026-Q4' → 'Q4 FY 2026-27' (Jan–Mar 2027) · '2025' → 'FY 2025-26'.
 *  The month comes back **full**, because `MONTHS` in `audit.ts` is the engine's own month table and it
 *  spells them out; a seal this register dresses reads the same way ('January 2026'), so the register and
 *  the trail never print two different names for one period. A period that does not parse is returned
 *  as it came in — the register prints what the shop typed rather than inventing a label for it.
 *  A quarter key names the financial year it belongs to, not the calendar year its months fall in. */
export function periodLabel(period: string): string {
  const p = parsePeriod(period)
  if (!p) return period ?? ''
  if (p.kind === 'month') return monthLabel(`${p.y}-${pad2(p.m ?? 1)}`)
  if (p.kind === 'quarter') return `Q${p.q} FY ${auditFyLabel(p.y)}`
  return `FY ${auditFyLabel(p.y)}`
}

export function periodFyStart(period: string): number {
  const p = parsePeriod(period)
  if (!p) return NaN
  return p.kind === 'month' ? fyStartOfMonth(`${p.y}-${pad2(p.m ?? 1)}`) : p.y
}

/** The first and last day the period covers — what a seal is checked against. */
export function periodRange(period: string): { from: string, to: string } | null {
  const p = parsePeriod(period)
  if (!p) return null
  if (p.kind === 'month') {
    const m = p.m ?? 1
    return { from: isoDate(p.y, m, 1), to: isoDate(p.y, m, daysInMonth(p.y, m)) }
  }
  if (p.kind === 'quarter') {
    const startMonth = ((p.q ?? 1) - 1) * 3 + 4
    const y = startMonth > 12 ? p.y + 1 : p.y
    const m = startMonth > 12 ? startMonth - 12 : startMonth
    const last = m + 2 > 12 ? m : m + 2
    const lastY = m + 2 > 12 ? y + 1 : y
    return { from: isoDate(y, m, 1), to: isoDate(lastY, last, daysInMonth(lastY, last)) }
  }
  return { from: isoDate(p.y, 4, 1), to: isoDate(p.y + 1, 3, 31) }
}

/** Every month key the period covers — what the books figures are summed from. */
export function periodMonths(period: string): string[] {
  const p = parsePeriod(period)
  if (!p) return []
  if (p.kind === 'month') return [`${p.y}-${pad2(p.m ?? 1)}`]
  if (p.kind === 'quarter') {
    const out: string[] = []
    // April of the financial year the quarter belongs to, offset by the quarter, then three months on.
    const first = p.y * 12 + 3 + ((p.q ?? 1) - 1) * 3
    for (let i = 0; i < 3; i++) {
      const abs = first + i
      out.push(`${Math.floor(abs / 12)}-${pad2((abs % 12) + 1)}`)
    }
    return out
  }
  const out: string[] = []
  for (let i = 0; i < 12; i++) {
    const abs = p.y * 12 + 3 + i
    out.push(`${Math.floor(abs / 12)}-${pad2((abs % 12) + 1)}`)
  }
  return out
}

/** The immediately preceding tax period — rule 59(6) speaks of "the preceding month"/"tax period". */
export function prevPeriod(period: string): string {
  const p = parsePeriod(period)
  if (!p) return ''
  if (p.kind === 'month') {
    const b = monthBefore(p.y, p.m ?? 1)
    return `${b.y}-${pad2(b.m)}`
  }
  if (p.kind === 'quarter') {
    if ((p.q ?? 1) === 1) return `${p.y - 1}-Q4`
    return `${p.y}-Q${(p.q ?? 1) - 1}`
  }
  return String(p.y - 1)
}

export function nextPeriod(period: string): string {
  const p = parsePeriod(period)
  if (!p) return ''
  if (p.kind === 'month') {
    const a = monthAfter(p.y, p.m ?? 1)
    return `${a.y}-${pad2(a.m)}`
  }
  if (p.kind === 'quarter') {
    if ((p.q ?? 4) === 4) return `${p.y + 1}-Q1`
    return `${p.y}-Q${(p.q ?? 4) + 1}`
  }
  return String(p.y + 1)
}

/**
 * The tax period a calendar due date belongs to. The app's calendar always states the date in the
 * month (or after the year) following the period, so one step back recovers it — which is why the
 * register keys on the period and never on the calendar's row id.
 */
export function periodFromDue(form: FilingForm, due: string, cadence: Cadence): string {
  if (!isDate(due)) return ''
  const y = Number(due.slice(0, 4))
  const m = Number(due.slice(5, 7))
  if (form === 'gstr4' || form === 'gstr9') return String(y - 1)
  if (form === 'cmp08' || (form === 'gstr1' && cadence !== 'monthly')) {
    const b = monthBefore(y, m)
    const { q, fy } = quarterOfMonth(b.y, b.m)
    return `${fy}-Q${q}`
  }
  const b = monthBefore(y, m)
  return `${b.y}-${pad2(b.m)}`
}

/**
 * The period a calendar row stands for, in this register's keys. One thing is folded: the app's
 * calendar still emits a GSTR-3B row every month for a QRMP filer, while rule 61(1)(ii) puts that
 * filer's summary return on a quarter. The register keys the row by the quarter — which is what the
 * statute asks for — and lets the disagreement print as drift on the row rather than hiding it by
 * keeping a monthly date the rule cannot have meant.
 */
function eventPeriod(form: FilingForm, due: string, cadence: Cadence): string {
  const m = periodFromDue(form, due, cadence)
  if (!m || !(cadence === 'qrmp' && form === 'gstr3b')) return m
  const p = parsePeriod(m)
  if (!p || p.kind !== 'month') return m
  const { q, fy } = quarterOfMonth(p.y, p.m ?? 1)
  return `${fy}-Q${q}`
}

/* ── the cadence, and the two state categories rule 61(1)(ii) draws ────────── */

export type Cadence = 'monthly' | 'qrmp' | 'composition'

export const CADENCES: Cadence[] = ['monthly', 'qrmp', 'composition']

export const CADENCE_META: Record<Cadence, { label: string; why: string }> = {
  monthly: {
    label: 'Monthly',
    why: 'GSTR-1 and GSTR-3B every month — rule 61(1)(i) puts the summary on the twentieth day of the '
      + 'month succeeding; the outward statement is on the eleventh, a date notified under section 37(2).',
  },
  qrmp: {
    label: 'QRMP (quarterly)',
    why: 'Quarterly returns with monthly payment. Rule 61(1)(ii) sets the summary return on the '
      + 'twenty-second day for the states in the first row of its table and the twenty-fourth for the '
      + 'states in the second, and rule 61(3) still wants the tax for the first two months of the '
      + 'quarter deposited by the twenty-fifth of the succeeding month in FORM GST PMT-06.',
  },
  composition: {
    label: 'Composition',
    why: 'CMP-08 every quarter by the eighteenth (rule 62(1)(i)) and GSTR-4 for the year — the '
      + 'proviso to rule 62(1)(ii) moved the annual date from 30 April to 30 June for FY 2024-25 onward.',
  },
}

/**
 * The two lists in the table to rule 61(1)(ii), read from the rule text and matched by state *name*
 * against `INDIAN_STATES` — the codes in that list are the app's own and are not all the codes the
 * portal issues, so a name is the safer key.
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

/** Which of rule 61(1)(ii)'s two rows a shop sits in — or null when the register cannot say. */
export function qrmpCategory(stateCode: string): QrmpCategory | null {
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

export interface StatutoryDue {
  /** '' when the rule fixes a day but the register cannot say which one applies to this shop. */
  date: string
  citation: string
  /** False where the date comes from a notification the register has not read, not from the rule. */
  cited: boolean
}

/**
 * The date the rule text states, re-derived rather than trusted. Where the obligation is dated by
 * notification under section 37(2) or 59 — GSTR-1's eleventh, the quarterly thirteenth, GSTR-9's
 * December — `cited` is false and the register says so instead of dressing a notification as a rule.
 */
export function statutoryDue(
  form: FilingForm, period: string, settings: FilingsSettings,
): StatutoryDue | null {
  const p = parsePeriod(period)
  if (!p) return null
  const meta = FORM_META[form]
  if (!meta.cadence.includes(p.kind)) return null

  switch (form) {
    case 'gstr3b': {
      if (p.kind === 'month') {
        const a = monthAfter(p.y, p.m ?? 1)
        return {
          date: isoDate(a.y, a.m, 20), cited: true,
          citation: 'rule 61(1)(i) — the twentieth day of the month succeeding',
        }
      }
      // The quarter's last month, and the month succeeding it. Q4 ends in March of the *next*
      // calendar year (2026-Q4 is Jan–Mar 2027), so the wrap has to carry the year with it — the
      // summary return for a Q4 is dated in April of that following year.
      const lastMonth = ((p.q ?? 1) - 1) * 3 + 6
      const a = monthAfter(lastMonth > 12 ? p.y + 1 : p.y, lastMonth > 12 ? lastMonth - 12 : lastMonth)
      const cat = qrmpCategory(settings.stateCode)
      if (!cat) {
        return {
          date: '', cited: true,
          citation: 'rule 61(1)(ii) — the twenty-second or twenty-fourth day by the state of the '
            + 'principal place of business; state it in Settings and this row can be checked',
        }
      }
      return { date: isoDate(a.y, a.m, cat.day), cited: true, citation: `${cat.cited} — ${cat.state}` }
    }
    case 'cmp08': {
      const lastMonth = ((p.q ?? 1) - 1) * 3 + 6
      const a = lastMonth > 12
        ? { y: p.y + 1, m: lastMonth - 12 }
        : { y: p.y, m: lastMonth }
      const next = monthAfter(a.y, a.m)
      return {
        date: isoDate(next.y, next.m, 18), cited: true,
        citation: 'rule 62(1)(i) — the eighteenth day of the month succeeding the quarter',
      }
    }
    case 'gstr4': {
      const june = p.y >= 2024
      return {
        date: isoDate(p.y + 1, june ? 6 : 4, 30), cited: true,
        citation: june
          ? 'proviso to rule 62(1)(ii) — the thirtieth day of June following the year, for FY 2024-25 onward'
          : 'rule 62(1)(ii) — the thirtieth day of April following the year',
      }
    }
    case 'gstr9':
      return {
        date: isoDate(p.y + 1, 12, 31), cited: false,
        citation: 'section 59 with the due date notified under it (the thirty-first of December) — a notification, not the rule',
      }
    case 'gstr1': {
      if (p.kind === 'month') {
        const a = monthAfter(p.y, p.m ?? 1)
        return {
          date: isoDate(a.y, a.m, 11), cited: false,
          citation: 'section 37(2) with the date notified under it (the eleventh) — the CBIC moves it by notification',
        }
      }
      const lastMonth = ((p.q ?? 1) - 1) * 3 + 6
      const a = lastMonth > 12 ? { y: p.y + 1, m: lastMonth - 12 } : { y: p.y, m: lastMonth }
      const next = monthAfter(a.y, a.m)
      return {
        date: isoDate(next.y, next.m, 13), cited: false,
        citation: 'the quarterly date for a QRMP filer, notified under section 37(2); rule 59(2) fixes the IFF window inside it, 1st to 13th',
      }
    }
    case 'gstr1a':
      return {
        date: '', cited: true,
        citation: 'proviso to rule 59(1) — after the GSTR-1 for the period and before its GSTR-3B; there is no calendar date, only that door',
      }
  }
}

/* ── late fee: the slab that applies, with the notification that says so ───── */

export interface LateFeeSlab {
  id: string
  label: string
  perDay: number
  /** A rupee ceiling, or a percentage of the turnover in this State/UT — rule 07/2023 works that way. */
  cap: number
  capPct: number
  capText: string
  basis: string
  /** True where the ceiling is this register's reading rather than the notification's words. */
  inferred: boolean
}

const CRORE = 1_00_00_000

const STATEMENT_CAPS: { max: number; cap: number; label: string }[] = [
  { max: 1.5 * CRORE, cap: 2000, label: 'turnover of the preceding FY up to ₹1.5 crore' },
  { max: 5 * CRORE, cap: 5000, label: 'turnover of the preceding FY above ₹1.5 crore, up to ₹5 crore' },
  { max: Infinity, cap: 10000, label: 'turnover of the preceding FY above ₹5 crore' },
]

/**
 * Section 47's own figure is ₹50 a day to a maximum of ₹5,000; the notifications below cut the
 * ceiling by turnover. The nil-return rate of ₹10 each (₹20 total) is the figure the handbook's
 * summary of revised late fees carries forward from Notification No. 76/2018-C.T., dated 31.12.2018.
 */
export function lateFeeSlab(
  form: FilingForm, args: { nil: boolean; precedingFyTurnover: number; stateTurnover: number },
): LateFeeSlab {
  const kind = FORM_META[form].fee
  if (kind === 'none') {
    return {
      id: 'none', label: 'no late fee', perDay: 0, cap: 0, capPct: 0, capText: '—', inferred: false,
      basis: 'GSTR-1A is an option, not an obligation: the proviso to rule 59(1) gives the window and '
        + 'nothing attaches a fee to using it or not.',
    }
  }
  if (kind === 'annual') {
    const t = Math.max(0, args.stateTurnover)
    const tier = t <= 5 * CRORE
      ? { perDay: 50, pct: 0.04, label: 'turnover in this State/UT up to ₹5 crore' }
      : t <= 20 * CRORE
        ? { perDay: 100, pct: 0.04, label: 'turnover in this State/UT above ₹5 crore, up to ₹20 crore' }
        : { perDay: 200, pct: 0.50, label: 'turnover in this State/UT above ₹20 crore' }
    return {
      id: 'annual', label: tier.label, perDay: tier.perDay, cap: round2(t * tier.pct / 100),
      capPct: tier.pct,
      capText: `${tier.pct}% of the turnover in this State or Union territory`,
      inferred: false,
      basis: 'Notification No. 07/2023-Central Tax, dated 31.03.2023, for FY 2022-23 onward: ₹'
        + `${tier.perDay} a day (CGST and SGST together) to a maximum of ${tier.pct}% of that turnover. `
        + 'For a year that is not a nil return this is the only table that applies.',
    }
  }
  if (kind === 'composition') {
    return args.nil
      ? {
        id: 'comp_nil', label: 'a nil composition return', perDay: 20, cap: 500, capPct: 0,
        capText: '₹500 (₹250 under each Act)', inferred: false,
        basis: 'Notification No. 21/2021-Central Tax, dated 01.06.2021, from FY 2021-22 onward: a nil '
          + 'GSTR-4 to ₹500. Applied here to the CMP-08 statement of the same dealer as well — '
          + 'stated as this register\'s reading, not the notification\'s words.',
      }
      : {
        id: 'comp', label: 'the composition scheme', perDay: 50, cap: 2000, capPct: 0,
        capText: '₹2,000 (₹1,000 under each Act)', inferred: false,
        basis: 'Notification No. 21/2021-Central Tax, dated 01.06.2021, from FY 2021-22 onward: ₹2,000 '
          + 'to a maximum on GSTR-4, at section 47\'s ₹50 a day. The same ceiling is printed for CMP-08 '
          + 'as this register\'s reading — the notification names the annual return.',
      }
  }
  if (args.nil) {
    return {
      id: 'nil', label: 'a nil return', perDay: 20, cap: 500, capPct: 0,
      capText: '₹500 (₹250 under each Act)', inferred: false,
      basis: 'Notifications No. 19/2021 and No. 20/2021-Central Tax, dated 01.06.2021, from the tax '
        + 'period of June 2021: a nil GSTR-1 or GSTR-3B is capped at ₹500. The ₹20 a day is the nil '
        + 'rate carried down from Notification No. 76/2018-C.T., dated 31.12.2018.',
    }
  }
  const turnover = Math.max(0, args.precedingFyTurnover)
  const tier = STATEMENT_CAPS.find(s => turnover <= s.max) ?? STATEMENT_CAPS[STATEMENT_CAPS.length - 1]
  return {
    id: `slab_${tier.cap}`, label: tier.label, perDay: 50, cap: tier.cap, capPct: 0,
    capText: `₹${tier.cap.toLocaleString('en-IN')}`, inferred: false,
    basis: 'Notifications No. 19/2021 and No. 20/2021-Central Tax, dated 01.06.2021: ₹50 a day '
      + `(₹25 under each Act) for ${tier.label}, to a maximum of ₹${tier.cap.toLocaleString('en-IN')} `
      + 'for the statement. Section 47\'s headline of ₹5,000 is the middle slab, not the ceiling.',
  }
}

/** Whole days from the day after the due date to `end`, inclusive of `end`. */
export function daysLate(due: string, end: string): number {
  if (!isDate(due) || !isDate(end)) return 0
  const a = Date.parse(`${due}T00:00:00Z`)
  const b = Date.parse(`${end}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

export function daysBetween(a: string, b: string): number {
  if (!isDate(a) || !isDate(b)) return 0
  const x = Date.parse(`${a}T00:00:00Z`)
  const y = Date.parse(`${b}T00:00:00Z`)
  if (Number.isNaN(x) || Number.isNaN(y)) return 0
  return Math.round((y - x) / 86_400_000)
}

export interface FeeEstimate {
  form: FilingForm
  days: number
  perDay: number
  /** perDay × days before the ceiling. */
  raw: number
  cap: number
  capText: string
  fee: number
  capped: boolean
  slab: string
  basis: string
  /** Section 50 interest on the tax the return owed, due date to payment. */
  interest: number
  interestDays: number
  interestBasis: string
  total: number
  /** What the shop says it paid, so the estimate can be shown against it. */
  paid: { lateFee: number; interest: number }
  /** Sentences the page prints beside the figures — never merged into them (Rule 33). */
  prints: string[]
}

/** The interest rate section 50(1) carries, and the base the handbook works it on. */
export const INTEREST_PCT = 18

/**
 * What the delay costs under the table that applies to this form. The annual return owes no tax in
 * itself, so interest runs only where the row states tax that went unpaid.
 */
export function estimateLateFee(args: {
  form: FilingForm
  days: number
  nil: boolean
  tax: number
  due: string
  paidOn?: string
  today: string
  precedingFyTurnover?: number
  stateTurnover?: number
  lateFeePaid?: number
  interestPaid?: number
}): FeeEstimate {
  const days = Math.max(0, Math.floor(args.days))
  const slab = lateFeeSlab(args.form, {
    nil: args.nil,
    precedingFyTurnover: args.precedingFyTurnover ?? 0,
    stateTurnover: args.stateTurnover ?? 0,
  })
  const raw = round2(slab.perDay * days)
  const cap = slab.cap
  const fee = days <= 0 ? 0 : Math.min(raw, cap)
  const interestEnd = isDate(args.paidOn ?? '') ? (args.paidOn as string) : args.today
  const interestDays = days > 0 ? daysBetween(args.due, interestEnd) : 0
  const interest = days > 0 && args.tax > 0 && interestDays > 0
    ? round2(args.tax * (INTEREST_PCT / 100) * (interestDays / 365))
    : 0
  const prints: string[] = []
  if (days > 0 && slab.perDay > 0) {
    prints.push(`₹${slab.perDay} a day for ${days} day${days === 1 ? '' : 's'} = ₹${raw.toLocaleString('en-IN')}, `
      + `against a ceiling of ${slab.capText}.` + (fee < raw ? ' The fee printed is the ceiling.' : ''))
  }
  if (days > 0 && args.tax > 0) {
    prints.push(interestDays > 0
      ? `Interest under section 50: ${INTEREST_PCT}% a year on ₹${args.tax.toLocaleString('en-IN')} for ${interestDays} day(s)${isDate(args.paidOn ?? '') ? '' : ' — to today, because the date the cash left is not stated'} = ₹${interest.toLocaleString('en-IN')}.`
      : 'Interest cannot run backwards to the due date — the payment date is on or before it.')
  }
  if (days > 0 && args.tax <= 0 && slab.perDay > 0) {
    prints.push('A nil or no-tax period still draws the fee; only interest needs a tax to run on.')
  }
  if (args.nil && slab.id !== 'nil' && slab.id !== 'comp_nil') {
    prints.push('This row is marked nil; the fee table used is the one for ' + slab.label + '.')
  }
  return {
    form: args.form, days, perDay: slab.perDay, raw, cap, capText: slab.capText, fee,
    capped: fee < raw, slab: slab.label, basis: slab.basis,
    interest, interestDays,
    interestBasis: `section 50(1) — ${INTEREST_PCT}% a year on the tax payable in the return`,
    total: round2(fee + interest),
    paid: { lateFee: args.lateFeePaid ?? 0, interest: args.interestPaid ?? 0 },
    prints,
  }
}

/* ── the shape of the register ─────────────────────────────────────────────── */

export type FilingStatus = 'not_filed' | 'filed' | 'nil'
export const FILING_STATUSES: FilingStatus[] = ['not_filed', 'filed', 'nil']

export const STATUS_META: Record<FilingStatus, { label: string; tone: 'blue' | 'green' | 'red' | 'amber' | 'grey' }> = {
  filed: { label: 'Filed', tone: 'green' },
  nil: { label: 'Nil return', tone: 'green' },
  not_filed: { label: 'Not filed', tone: 'amber' },
}

/** One line of the history: what the row said before, and who changed it. */
export interface FilingChange {
  at: string
  action: string
  from: string
  to: string
  actor: string
  note: string
}

/** A transcript of one period's return. The figures are what the return *stated*. */
export interface FilingRecord {
  id: string
  form: FilingForm
  period: string
  period_kind: PeriodKind
  status: FilingStatus
  /** The date this register was told to expect the return by, copied at the time of writing. */
  due: string
  /** Why the shop replaced that date — a notification, a portal error, a corrected extension. */
  due_reason: string
  filed_on: string
  /** An ARN as written. The register never checks it against the portal. */
  reference: string
  heads: Heads
  tax_paid_on: string
  late_fee_paid: number
  interest_paid: number
  /** An intimation under rule 88C(1) that stands unpaid on this return — rule 59(6)(d) bars the next GSTR-1. */
  unpaid_intimation: number
  notes: string
  actor: string
  history: FilingChange[]
  created_at: string
  updated_at: string
}

export type AmendmentKind = 'gstr1a' | 'table9a' | 'invoice_omitted' | 'note_omitted' | 'itc_late'
export const AMENDMENT_KINDS: AmendmentKind[] = ['gstr1a', 'table9a', 'invoice_omitted', 'note_omitted', 'itc_late']

export interface AmendmentMeta {
  label: string
  where: string
  /** Which of the three clocks governs this kind. */
  clock: 'gstr1a' | 'table9a' | 'itc'
  basis: string
}

export const AMENDMENT_META: Record<AmendmentKind, AmendmentMeta> = {
  gstr1a: {
    label: 'Carried in a GSTR-1A', where: 'FORM GSTR-1A for the same tax period', clock: 'gstr1a',
    basis: 'the proviso to rule 59(1) — after the period\'s GSTR-1 and before its GSTR-3B',
  },
  table9a: {
    label: 'Left for Table 9A of GSTR-9', where: 'Table 9A/9C of the annual return', clock: 'table9a',
    basis: 'the annual return is where a document GSTR-1 missed is disclosed; section 16(4) still '
      + 'decides whether the recipient can use it',
  },
  invoice_omitted: {
    label: 'An invoice that never went into GSTR-1', where: 'to be raised through one of the routes below', clock: 'itc',
    basis: 'section 16(4), reproduced in Circular No. 237/31/2024-GST, dated 15.10.2024',
  },
  note_omitted: {
    label: 'A credit or debit note that was not reported', where: 'GSTR-1A while it is open, else Table 9A', clock: 'itc',
    basis: 'section 37(1) with rule 59(1); a note changes the outward details the statement carried',
  },
  itc_late: {
    label: 'Input credit on a document found late', where: 'a later GSTR-3B, inside the recipient\'s window', clock: 'itc',
    basis: 'section 16(4) — "after the thirtieth day of November following the end of financial year '
      + '… or furnishing of the relevant annual return, whichever is earlier"',
  },
}

export type AmendmentStatus = 'open' | 'carried' | 'lapsed'
export const AMENDMENT_STATUSES: AmendmentStatus[] = ['open', 'carried', 'lapsed']

export const AMENDMENT_STATUS_META: Record<AmendmentStatus, { label: string; tone: 'blue' | 'green' | 'red' | 'amber' | 'grey' }> = {
  open: { label: 'Open', tone: 'amber' },
  carried: { label: 'Carried', tone: 'green' },
  lapsed: { label: 'Lapsed', tone: 'red' },
}

/** One piece of paper that the return as filed did not carry, or carried wrong. */
export interface Amendment {
  id: string
  /** The tax period being corrected. */
  period: string
  kind: AmendmentKind
  /** The invoice, note or ITC reference as the shop writes it — never validated. */
  doc_ref: string
  party: string
  effect: 'add' | 'reduce'
  taxable: number
  tax: number
  /** The day the mistake was found. */
  found_on: string
  status: AmendmentStatus
  /** The return the correction actually went through, once it has. */
  carried_in: string
  notes: string
  actor: string
  created_at: string
  updated_at: string
}

export interface FilingsSettings {
  cadence: Cadence
  taxAudit: boolean
  /** Two digits of the GSTIN — the state the principal place of business is in. */
  stateCode: string
  /** Aggregate turnover of the financial year *preceding* the one being filed — the 1/3B slab key. */
  precedingFyTurnover: number
  /** Turnover in this State or Union territory — the percentage key for GSTR-9 under 07/2023. */
  stateTurnover: number
  gstin: string
  actor: string
}

export const DEFAULT_FILINGS_SETTINGS: FilingsSettings = {
  cadence: 'monthly', taxAudit: false, stateCode: '', precedingFyTurnover: 0, stateTurnover: 0,
  gstin: '', actor: '',
}

export interface FilingsStore {
  version: number
  orgId: string
  updatedAt: string
  settings: FilingsSettings
  filings: FilingRecord[]
  amendments: Amendment[]
}

/* ── small helpers ─────────────────────────────────────────────────────────── */

function nowStamp(): string {
  return new Date().toISOString()
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function n(v: unknown, fallback = 0): number {
  const x = typeof v === 'string' ? Number(v) : v
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback
}

function nonNegative(v: unknown): number {
  return Math.max(0, round2(n(v)))
}

export function filingId(form: FilingForm, period: string): string {
  return `${form}|${period}`
}

/* ── read / write ──────────────────────────────────────────────────────────── */

function emptyStore(orgId = ''): FilingsStore {
  return {
    version: FILINGS_VERSION, orgId, updatedAt: '',
    settings: { ...DEFAULT_FILINGS_SETTINGS }, filings: [], amendments: [],
  }
}

function parseSettings(raw: unknown): FilingsSettings {
  const s = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const cadence = CADENCES.includes(str(s.cadence) as Cadence) ? str(s.cadence) as Cadence : 'monthly'
  return {
    cadence,
    taxAudit: s.taxAudit === true,
    stateCode: str(s.stateCode).trim(),
    precedingFyTurnover: nonNegative(s.precedingFyTurnover),
    stateTurnover: nonNegative(s.stateTurnover),
    gstin: str(s.gstin).trim(),
    actor: str(s.actor),
  }
}

function parseChange(raw: unknown): FilingChange | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  return {
    at: str(c.at), action: str(c.action), from: str(c.from), to: str(c.to),
    actor: str(c.actor), note: str(c.note),
  }
}

function parseHeads(raw: unknown): Heads {
  const h = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  // Each figure goes through the same guard the rest of this register uses: a null, a text field or
  // a float tail from a hand-edited file becomes a clean two-decimal rupee, never NaN on the grid.
  return headsOf(nonNegative(h.taxable), nonNegative(h.igst), nonNegative(h.cgst), nonNegative(h.sgst), nonNegative(h.cess))
}

function parseFiling(raw: unknown): FilingRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const f = raw as Record<string, unknown>
  const id = str(f.id)
  const form = str(f.form) as FilingForm
  const period = str(f.period)
  const kind = periodKindOf(period)
  // A row that names no form, or a period this register cannot place, is a damaged row: reading it
  // half-way would put a return on the grid that no statutory table can date.
  if (!id || !FORMS.includes(form) || !kind) return null
  const status: FilingStatus = f.status === 'filed' || f.status === 'nil' ? f.status : 'not_filed'
  const history = Array.isArray(f.history)
    ? f.history.map(parseChange).filter((x): x is FilingChange => x !== null)
    : []
  return {
    id,
    form,
    period,
    period_kind: kind,
    status,
    due: isDate(f.due) ? str(f.due) : '',
    due_reason: str(f.due_reason),
    filed_on: isDate(f.filed_on) ? str(f.filed_on) : '',
    reference: str(f.reference),
    heads: parseHeads(f.heads),
    tax_paid_on: isDate(f.tax_paid_on) ? str(f.tax_paid_on) : '',
    late_fee_paid: nonNegative(f.late_fee_paid),
    interest_paid: nonNegative(f.interest_paid),
    unpaid_intimation: form === 'gstr3b' ? nonNegative(f.unpaid_intimation) : 0,
    notes: str(f.notes),
    actor: str(f.actor),
    history,
    created_at: str(f.created_at),
    updated_at: str(f.updated_at),
  }
}

function parseAmendment(raw: unknown): Amendment | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  const id = str(a.id)
  const kind = str(a.kind) as AmendmentKind
  if (!id || !AMENDMENT_KINDS.includes(kind) || !parsePeriod(str(a.period))) return null
  return {
    id,
    period: str(a.period),
    kind,
    doc_ref: str(a.doc_ref),
    party: str(a.party),
    effect: a.effect === 'reduce' ? 'reduce' : 'add',
    taxable: nonNegative(a.taxable),
    tax: nonNegative(a.tax),
    found_on: isDate(a.found_on) ? str(a.found_on) : '',
    status: a.status === 'carried' || a.status === 'lapsed' ? a.status : 'open',
    carried_in: str(a.carried_in),
    notes: str(a.notes),
    actor: str(a.actor),
    created_at: str(a.created_at),
    updated_at: str(a.updated_at),
  }
}

/** The first occurrence of each key, in the order they were written. */
function dedupe<T>(list: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return list.filter(item => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function parseFilings(raw: string | null, orgId = ''): FilingsStore {
  if (!raw) return emptyStore(orgId)
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return emptyStore(orgId)
    // A wrong-version file reads as empty rather than half-understood, the guard every register here carries.
    if (parsed.version !== FILINGS_VERSION) return emptyStore(str(parsed.orgId) || orgId)
    const filings = Array.isArray(parsed.filings)
      ? parsed.filings.map(parseFiling).filter((x): x is FilingRecord => x !== null) : []
    const amendments = Array.isArray(parsed.amendments)
      ? parsed.amendments.map(parseAmendment).filter((x): x is Amendment => x !== null) : []
    return {
      version: FILINGS_VERSION,
      orgId: str(parsed.orgId) || orgId,
      updatedAt: str(parsed.updatedAt),
      settings: parseSettings(parsed.settings),
      // One row per form and period is the register's own promise; a hand-edited duplicate keeps the
      // first. Both passes must look for the first match in the array they are filtering — a damaged
      // row dropped by the first pass shifts every later index, and reading the *original* positions
      // there would then discard healthy rows one by one.
      filings: dedupe(filings, f => f.id).filter((f, i, kept) =>
        kept.findIndex(x => x.form === f.form && x.period === f.period) === i)
        .sort((a, b) => (a.period > b.period ? 1 : a.period < b.period ? -1 : a.form.localeCompare(b.form))),
      amendments: dedupe(amendments, a => a.id)
        .sort((a, b) => (a.period > b.period ? 1 : a.period < b.period ? -1 : (b.found_on || '').localeCompare(a.found_on || ''))),
    }
  } catch {
    return emptyStore(orgId)
  }
}

export function loadFilings(orgId: string): FilingsStore {
  if (typeof window === 'undefined' || !orgId) return emptyStore()
  try {
    const store = parseFilings(window.localStorage.getItem(KEY_FILINGS + orgId), orgId)
    return { ...store, orgId }
  } catch {
    return emptyStore(orgId)
  }
}

export function saveFilings(orgId: string, store: FilingsStore): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(
      KEY_FILINGS + orgId,
      JSON.stringify({ ...store, orgId, version: FILINGS_VERSION, updatedAt: nowStamp() }),
    )
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

function write(orgId: string, next: Omit<FilingsStore, 'version' | 'updatedAt'>): FilingsStore {
  const store: FilingsStore = { ...next, version: FILINGS_VERSION, updatedAt: nowStamp() }
  saveFilings(orgId, store)
  return store
}

/* ── validation ────────────────────────────────────────────────────────────── */

/** What the shop types. Everything the register adds — id, kind, history, stamps — is its own. */
export interface FilingDraft {
  id?: string
  form: FilingForm
  period: string
  status: FilingStatus
  due?: string
  due_reason?: string
  filed_on?: string
  reference?: string
  taxable?: number | string
  igst?: number | string
  cgst?: number | string
  sgst?: number | string
  cess?: number | string
  tax_paid_on?: string
  late_fee_paid?: number | string
  interest_paid?: number | string
  unpaid_intimation?: number | string
  notes?: string
  actor?: string
}

export function validateFiling(draft: FilingDraft, store: FilingsStore, today: string): string[] {
  const problems: string[] = []
  const meta = FORMS.includes(draft.form) ? FORM_META[draft.form] : null
  if (!meta) {
    problems.push('This register keeps GSTR-1, 1A, 3B, CMP-08, GSTR-4 and GSTR-9 — the rest of the calendar stays on /gst/calendar.')
    return problems
  }
  const p = parsePeriod(draft.period)
  if (!p) {
    problems.push('The period must be a month (2026-03), a quarter (2026-Q1) or the year a financial year starts in (2025) — a return has to be dated at a period.')
    return problems
  }
  if (!meta.cadence.includes(p.kind)) {
    problems.push(`${meta.label} is furnished ${meta.cadence.map(k => k === 'month' ? 'monthly' : k === 'quarter' ? 'quarterly' : 'for a financial year').join(' or ')} — ${meta.rule} does not know the shape "${draft.period}".`)
  }
  if (!FILING_STATUSES.includes(draft.status)) problems.push('Say whether it is filed, nil, or not yet filed.')

  const range = periodRange(draft.period)
  if (range && range.to >= today && draft.status !== 'not_filed') {
    problems.push(`${periodLabel(draft.period)} has not ended — the last day is ${range.to}. Nothing can have been filed for a period still running.`)
  }
  if (draft.status !== 'not_filed') {
    if (!isDate(draft.filed_on ?? '')) problems.push('A filed row needs the date it was filed.')
    else {
      if ((draft.filed_on as string) > today) problems.push('The filing date is after today — this register records what the portal already took, not what it will take.')
      if (range && (draft.filed_on as string) < range.from) problems.push(`A return for ${periodLabel(draft.period)} cannot be dated ${draft.filed_on}, before the period opened on ${range.from}.`)
    }
    const ref = (draft.reference ?? '').trim()
    if (ref.includes(' ')) problems.push('The reference is written as you saw it — no spaces. A portal reference with a space is two references to this register.')
    if (ref.length > 40) problems.push('Keep the reference to forty characters; it is a label, not a paragraph.')
    if (!ref) problems.push('The ARN the portal gave is the one thing that makes this row verifiable later. It is stored exactly as written and never checked against the portal.')
  }
  const heads = headsOf(draft.taxable ?? 0, draft.igst ?? 0, draft.cgst ?? 0, draft.sgst ?? 0, draft.cess ?? 0)
  for (const [label, v] of [['Taxable value', heads.taxable], ['IGST', heads.igst], ['CGST', heads.cgst], ['SGST', heads.sgst], ['Cess', heads.cess]] as [string, number][]) {
    if (v < 0) problems.push(`${label} cannot be negative — a reduction belongs in the next period as an amendment, not as a negative figure on a filed return.`)
  }
  if (draft.status === 'nil' && heads.tax > 0) {
    problems.push('A nil return states no tax. This row carries ₹' + heads.tax.toLocaleString('en-IN') + ' — record it as filed, with the figures.')
  }
  const due = draft.due ?? ''
  if (due && !isDate(due)) problems.push('The date you were told to file by must be a real date.')
  if (due && draft.due_reason && draft.due_reason.length > 160) problems.push('Keep the reason for a changed date to 160 characters.')
  if (draft.form !== 'gstr3b' && n(draft.unpaid_intimation) > 0) {
    problems.push('Only a GSTR-3B row can carry an unpaid intimation — rule 88C(1) speaks of the return under section 39.')
  }
  if (draft.form === 'gstr1a') {
    const base = store.filings.find(f => f.form === 'gstr1' && f.period === draft.period)
    if (!base || base.status === 'not_filed') {
      problems.push('A GSTR-1A comes after the GSTR-1 for the same period and before its GSTR-3B (proviso to rule 59(1)) — record the GSTR-1 first.')
    }
    const three = store.filings.find(f => f.form === 'gstr3b' && f.period === draft.period)
    if (three && three.status !== 'not_filed') {
      problems.push(`${periodLabel(draft.period)}'s GSTR-3B is already recorded as filed — the window in the proviso to rule 59(1) shut when it went in.`)
    }
  }
  return problems
}

/** The sentence that goes to the audit trail when a row changes meaning. Exported so it is testable. */
export function filingTrailNote(r: FilingRecord, action: 'recorded' | 'corrected' | 'withdrawn' | 'deleted'): string {
  const label = FORM_META[r.form].label
  const when = periodLabel(r.period)
  const who = r.actor ? ` by ${r.actor}` : ''
  if (action === 'recorded') {
    return `${label} for ${when} recorded as ${r.status === 'nil' ? 'a nil return' : 'filed'} on ${r.filed_on || '—'}${r.reference ? ` (reference ${r.reference})` : ''}.`
  }
  if (action === 'corrected') {
    return `${label} for ${when} corrected after it was recorded${who}: ${r.notes ? r.notes.slice(0, 120) : 'the figures or the date were amended on this device.'}`
  }
  if (action === 'withdrawn') {
    return `${label} for ${when} set back to not filed${who}: ${r.notes || 'no reason given'}.`
  }
  return `${label} row for ${when} removed from the filings register${who}: ${r.notes || 'no reason given'}.`
}

export interface FilingWriteResult {
  ok: boolean
  store: FilingsStore
  record: FilingRecord | null
  problems: string[]
  /** The line written to /audit, or '' when nothing went to the trail. */
  trail: string
}

/**
 * Record, or correct, one period's return. The due date is snapshotted here — from the shop's own
 * override, else from what the app's calendar states for that period, else from the rule — so the row
 * keeps the date it was written against instead of following the calendar forever.
 */
export function recordFiling(
  orgId: string, draft: FilingDraft, today: string = todayISO(), events?: ComplianceEvent[],
): FilingWriteResult {
  const store = loadFilings(orgId)
  const problems = validateFiling(draft, store, today)
  if (problems.length) return { ok: false, store, record: null, problems, trail: '' }

  const existing = store.filings.find(f => f.form === draft.form && f.period === draft.period) ?? null
  const settings = store.settings
  const heads = headsOf(draft.taxable ?? 0, draft.igst ?? 0, draft.cgst ?? 0, draft.sgst ?? 0, draft.cess ?? 0)
  const kind = periodKindOf(draft.period) as PeriodKind
  const at = nowStamp()
  const actor = (draft.actor ?? '').trim() || settings.actor

  const due = pickDue(draft, existing, settings, draft.period, events ?? null)
  const wasFiled = !!existing && existing.status !== 'not_filed'
  const isFiled = draft.status !== 'not_filed'

  const record: FilingRecord = {
    id: existing?.id ?? newId(),
    form: draft.form,
    period: draft.period,
    period_kind: kind,
    status: draft.status,
    due: due.date,
    due_reason: (draft.due_reason ?? existing?.due_reason ?? '').trim(),
    filed_on: isFiled ? (draft.filed_on ?? '') : '',
    reference: isFiled ? (draft.reference ?? '').trim() : '',
    heads,
    tax_paid_on: isFiled ? (draft.tax_paid_on ?? '') : '',
    late_fee_paid: isFiled ? nonNegative(draft.late_fee_paid) : 0,
    interest_paid: isFiled ? nonNegative(draft.interest_paid) : 0,
    unpaid_intimation: draft.form === 'gstr3b' ? nonNegative(draft.unpaid_intimation) : 0,
    notes: (draft.notes ?? '').trim(),
    actor,
    history: [
      ...(existing?.history ?? []),
      {
        at,
        action: !existing ? 'recorded' : isFiled && !wasFiled ? 'filed' : 'corrected',
        from: existing ? existing.status : '',
        to: draft.status,
        actor,
        note: !existing ? 'first written on this device' : `${heads.taxable.toFixed(2)} taxable / ₹${heads.tax.toFixed(2)} tax, filed_on ${draft.filed_on || '—'}`,
      },
    ],
    created_at: existing?.created_at ?? at,
    updated_at: at,
  }

  const filings = existing
    ? store.filings.map(f => (f.id === existing.id ? record : f))
    : [...store.filings, record].sort((a, b) => (a.period > b.period ? 1 : a.period < b.period ? -1 : a.form.localeCompare(b.form)))

  const next = write(orgId, { ...store, filings })

  let trail = ''
  if (!existing || (!wasFiled && isFiled)) {
    trail = filingTrailNote(record, 'recorded')
    recordNote(orgId, trail, actor)
  } else if (wasFiled && isFiled && figuresChanged(existing, record)) {
    trail = filingTrailNote(record, 'corrected')
    recordNote(orgId, trail, actor)
  } else if (wasFiled && !isFiled) {
    trail = filingTrailNote({ ...record, notes: record.notes || 'set back to not filed' }, 'withdrawn')
    recordNote(orgId, trail, actor)
  }
  return { ok: true, store: next, record, problems: [], trail }
}

function figuresChanged(a: FilingRecord, b: FilingRecord): boolean {
  return a.status !== b.status || a.filed_on !== b.filed_on || a.reference !== b.reference
    || a.heads.taxable !== b.heads.taxable || a.heads.tax !== b.heads.tax
    || a.tax_paid_on !== b.tax_paid_on || a.late_fee_paid !== b.late_fee_paid || a.interest_paid !== b.interest_paid
}

/** The date the row is measured against, and where it came from. */
export interface DueChoice {
  date: string
  provenance: 'stated on the row' | 'the app calendar' | 'cited from the rule' | 'not stated'
  note: string
}

export function pickDue(
  draft: FilingDraft, existing: FilingRecord | null, settings: FilingsSettings,
  period: string, events: ComplianceEvent[] | null,
): DueChoice {
  if (isDate(draft.due ?? '')) {
    return { date: draft.due as string, provenance: 'stated on the row', note: (draft.due_reason ?? '').trim() }
  }
  const kept = existing?.due ?? ''
  if (isDate(kept)) return { date: kept, provenance: 'stated on the row', note: existing?.due_reason ?? '' }
  const calendar = calendarEventFor(settings, period, events)?.due ?? ''
  if (isDate(calendar)) {
    return { date: calendar, provenance: 'the app calendar', note: 'copied from /gst/calendar when this row was written' }
  }
  const stat = statutoryDue(draft.form, period, settings)
  if (stat && isDate(stat.date)) return { date: stat.date, provenance: 'cited from the rule', note: stat.citation }
  return { date: '', provenance: 'not stated', note: '' }
}

export interface FilingDeleteResult {
  ok: boolean
  store: FilingsStore
  why: string
  trail: string
}

/**
 * A row that was recorded as filed and has amendments waiting on it is refused: the amendment's whole
 * meaning is "this period's return did not carry this paper", and deleting the return would leave the
 * paper answering nothing.
 */
export function deleteFiling(orgId: string, id: string, reason = ''): FilingDeleteResult {
  const store = loadFilings(orgId)
  const record = store.filings.find(f => f.id === id)
  if (!record) return { ok: false, store, why: 'No row of that id is on the register.', trail: '' }
  const waiting = store.amendments.filter(a => a.period === record.period && a.status === 'open')
  if (record.status !== 'not_filed' && waiting.length) {
    return {
      ok: false, store,
      why: `${FORM_META[record.form].label} for ${periodLabel(record.period)} is recorded as filed and ${waiting.length} amendment${waiting.length === 1 ? '' : 's'} still point${waiting.length === 1 ? 's' : ''} at that period. Close or re-date the amendments first — a correction that belongs to no return is not a record.`,
      trail: '',
    }
  }
  const next = write(orgId, { ...store, filings: store.filings.filter(f => f.id !== id) })
  const trail = record.status === 'not_filed'
    && (record.filed_on === '' && record.reference === '')
    ? '' : filingTrailNote({ ...record, notes: reason || record.notes }, 'deleted')
  if (trail) recordNote(orgId, trail, record.actor)
  return { ok: true, store: next, why: '', trail }
}

export function saveFilingsSettings(orgId: string, patch: Partial<FilingsSettings>): FilingsStore {
  const store = loadFilings(orgId)
  return write(orgId, { ...store, settings: { ...store.settings, ...patch } })
}

/* ── amendments ────────────────────────────────────────────────────────────── */

export interface AmendmentDraft {
  id?: string
  period: string
  kind: AmendmentKind
  doc_ref?: string
  party?: string
  effect?: 'add' | 'reduce'
  taxable?: number | string
  tax?: number | string
  found_on?: string
  status?: AmendmentStatus
  carried_in?: string
  notes?: string
  actor?: string
}

export function validateAmendment(draft: AmendmentDraft, store: FilingsStore, today: string): string[] {
  const problems: string[] = []
  if (!parsePeriod(draft.period)) problems.push('Name the tax period the correction belongs to — 2026-03, 2026-Q1, or 2025 for a financial year.')
  if (!AMENDMENT_KINDS.includes(draft.kind)) problems.push('Say which kind of correction this is.')
  if (!str(draft.doc_ref).trim()) problems.push('Write the document number or the credit you are chasing. This register prints it as you write it and never matches it to the portal.')
  if (n(draft.taxable) <= 0 && n(draft.tax) <= 0) problems.push('An amendment carries a value or a tax — otherwise nothing is being corrected.')
  if (draft.found_on && !isDate(draft.found_on)) problems.push('The day the mistake was found must be a date.')
  if (draft.found_on && isDate(draft.found_on) && (draft.found_on as string) > today) problems.push('A mistake cannot be found in the future.')
  const range = periodRange(draft.period)
  if (range && draft.found_on && isDate(draft.found_on) && (draft.found_on as string) < range.from) {
    problems.push(`A correction of ${periodLabel(draft.period)} cannot have been found on ${draft.found_on}, before the period opened.`)
  }
  if (draft.status === 'carried' && !str(draft.carried_in).trim()) {
    problems.push('Say which return carried it — the GSTR-1A, the Table 9A of a GSTR-9, or the 3B that finally took the credit.')
  }
  if (draft.kind === 'gstr1a') {
    const three = store.filings.find(f => f.form === 'gstr3b' && f.period === draft.period)
    if (three && three.status !== 'not_filed' && draft.status !== 'carried') {
      problems.push(`${periodLabel(draft.period)}'s GSTR-3B is already recorded as filed — a GSTR-1A correction (proviso to rule 59(1)) cannot be made after it. Re-key this as a Table 9A item instead.`)
    }
  }
  return problems
}

export interface AmendmentWriteResult {
  ok: boolean
  store: FilingsStore
  amendment: Amendment | null
  problems: string[]
}

export function addAmendment(
  orgId: string, draft: AmendmentDraft, today: string = todayISO(),
): AmendmentWriteResult {
  const store = loadFilings(orgId)
  const problems = validateAmendment(draft, store, today)
  if (problems.length) return { ok: false, store, amendment: null, problems }
  const at = nowStamp()
  const existing = draft.id ? store.amendments.find(a => a.id === draft.id) : undefined
  const amendment: Amendment = {
    id: existing?.id ?? newId(),
    period: draft.period,
    kind: draft.kind,
    doc_ref: str(draft.doc_ref).trim(),
    party: str(draft.party).trim(),
    effect: draft.effect === 'reduce' ? 'reduce' : 'add',
    taxable: nonNegative(draft.taxable),
    tax: nonNegative(draft.tax),
    found_on: isDate(draft.found_on ?? '') ? (draft.found_on as string) : today,
    status: draft.status ?? existing?.status ?? 'open',
    carried_in: str(draft.carried_in ?? existing?.carried_in).trim(),
    notes: str(draft.notes ?? existing?.notes).trim(),
    actor: str(draft.actor ?? existing?.actor).trim() || store.settings.actor,
    created_at: existing?.created_at ?? at,
    updated_at: at,
  }
  const amendments = existing
    ? store.amendments.map(a => (a.id === existing.id ? amendment : a))
    : [...store.amendments, amendment]
  const next = write(orgId, {
    ...store,
    amendments: amendments.sort((a, b) => (a.period > b.period ? 1 : a.period < b.period ? -1 : (b.found_on || '').localeCompare(a.found_on || ''))),
  })
  if (!existing) recordNote(orgId, amendmentTrailNote(amendment, 'added'), amendment.actor)
  else if (existing.status !== amendment.status) {
    recordNote(orgId, amendmentTrailNote(amendment, amendment.status === 'carried' ? 'carried' : 'closed'), amendment.actor)
  }
  return { ok: true, store: next, amendment, problems: [] }
}

export function amendmentTrailNote(a: Amendment, action: 'added' | 'carried' | 'closed'): string {
  const where = periodLabel(a.period)
  if (action === 'added') {
    return `Amendment logged for ${where}: ${AMENDMENT_META[a.kind].label} — ${a.doc_ref || 'no document named'}, ${a.effect === 'add' ? 'adding' : 'reducing'} ₹${a.taxable.toLocaleString('en-IN')} taxable.`
  }
  if (action === 'carried') return `Amendment on ${where} (${a.doc_ref || 'document not named'}) carried through ${a.carried_in || 'a return'}.`
  return `Amendment on ${where} (${a.doc_ref || 'document not named'}) marked ${a.status}.`
}

export function deleteAmendment(orgId: string, id: string): { ok: boolean; store: FilingsStore; why: string } {
  const store = loadFilings(orgId)
  const found = store.amendments.find(a => a.id === id)
  if (!found) return { ok: false, store, why: 'No amendment of that id is on the register.' }
  const next = write(orgId, { ...store, amendments: store.amendments.filter(a => a.id !== id) })
  if (found.status !== 'open') {
    recordNote(orgId, `Amendment on ${periodLabel(found.period)} (${found.doc_ref || 'no document'}) removed from the register.`, found.actor)
  }
  // The store handed back is the one just written, so a caller that keeps it cannot re-save the row
  // it deleted — the same shape `deleteFiling` returns.
  return { ok: true, store: next, why: '' }
}

/* ── the three clocks ──────────────────────────────────────────────────────── */

export interface Window {
  open: boolean
  /** The date the door shuts — '' when it shuts on an event rather than a day. */
  closesOn: string
  /** Days left on today; negative once shut. */
  left: number
  why: string
  citation: string
}

export interface PeriodWindows {
  period: string
  gstr1a: Window
  table9a: Window
  itc: Window
}

/**
 * The date section 16(4) shuts the recipient's credit for a financial year: the thirtieth of November
 * following the year, or the day its annual return was actually filed, whichever comes first
 * (Circular No. 237/31/2024-GST, dated 15.10.2024).
 */
export function itcDeadline(fyStart: number, annualFiledOn: string): string {
  const nov = isoDate(fyStart + 1, 11, 30)
  if (isDate(annualFiledOn)) return annualFiledOn < nov ? annualFiledOn : nov
  return nov
}

export function windowsFor(store: FilingsStore, period: string, today: string): PeriodWindows | null {
  const p = parsePeriod(period)
  if (!p) return null
  const one = store.filings.find(f => f.form === 'gstr1' && f.period === period) ?? null
  const three = store.filings.find(f => f.form === 'gstr3b' && f.period === period) ?? null

  // The proviso to rule 59(1) has no date at all: it opens after the GSTR-1 for the period and shuts
  // when that period's GSTR-3B goes in, so `closesOn` is the 3B that has not happened yet.
  const oneFiled = !!one && one.status !== 'not_filed'
  const threeFiled = !!three && three.status !== 'not_filed'
  const gstr1aOpen = oneFiled && !threeFiled
  const gstr1a: Window = {
    open: gstr1aOpen,
    closesOn: three && isDate(three.due) ? three.due : (threeFiled ? three?.filed_on ?? '' : ''),
    left: three && isDate(three.due) ? daysBetween(today, three.due) : (gstr1aOpen ? 0 : -1),
    why: !oneFiled
      ? `The GSTR-1 for ${periodLabel(period)} is not on the register — the option opens only after it.`
      : threeFiled
        ? `Shut: the GSTR-3B for ${periodLabel(period)} went in on ${three?.filed_on}, and the proviso takes the amendment door with it.`
        : `Open until the GSTR-3B for ${periodLabel(period)} is filed. The date printed is the 3B's, only because that is the return that shuts the door.`,
    citation: 'proviso to rule 59(1) — "after furnishing the details … in FORM GSTR-1 for a tax period but before filing of return in FORM GSTR-3B for the said tax period"',
  }

  const fy = periodFyStart(period)
  const annual = Number.isFinite(fy)
    ? store.filings.find(f => (f.form === 'gstr9' || f.form === 'gstr4') && f.period === String(fy)) ?? null
    : null
  const annualFiled = !!annual && annual.status !== 'not_filed'
  const annualDue = annual && isDate(annual.due) ? annual.due : (Number.isFinite(fy) ? isoDate(fy + 1, 12, 31) : '')
  const table9a: Window = {
    open: !annualFiled,
    closesOn: annualFiled ? annual?.filed_on ?? '' : annualDue,
    left: annualDue ? daysBetween(today, annualDue) : 0,
    why: annualFiled
      ? `Shut: the annual return for FY ${auditFyLabel(fy)} was filed on ${annual?.filed_on}. Table 9A belongs to that return.`
      : `Open until the annual return for FY ${auditFyLabel(fy)} is furnished — the date printed is its stated due date, not a rule that shuts the table.`,
    citation: 'Table 9A of FORM GSTR-9, with the 9C reconciliation; section 59 fixes the annual return',
  }

  const itcDate = itcDeadline(fy, annualFiled ? annual?.filed_on ?? '' : '')
  const itc: Window = {
    open: isDate(today) && today <= itcDate,
    closesOn: itcDate,
    left: daysBetween(today, itcDate),
    why: today > itcDate
      ? `Shut on ${itcDate}: section 16(4) takes the credit for ${annualFiled ? 'good — the annual return went in first' : 'the year — thirty days of November, or the annual return, whichever came first'}.`
      : `The recipient can still take the credit up to ${itcDate}.`,
    citation: 'section 16(4), reproduced in Circular No. 237/31/2024-GST, dated 15.10.2024 — "after the thirtieth day of November following the end of financial year to which such invoice or debit note pertains or furnishing of the relevant annual return, whichever is earlier"',
  }

  return { period, gstr1a, table9a, itc }
}

export type Urgency = 'act_now' | 'closing' | 'open' | 'lapsed' | 'done'

export const URGENCY_META: Record<Urgency, { label: string; tone: 'blue' | 'green' | 'red' | 'amber' | 'grey' }> = {
  act_now: { label: 'Act now', tone: 'red' },
  closing: { label: 'Closing', tone: 'amber' },
  open: { label: 'Still open', tone: 'blue' },
  lapsed: { label: 'Lapsed', tone: 'grey' },
  done: { label: 'Carried', tone: 'green' },
}

export interface BoardRow {
  amendment: Amendment
  windows: PeriodWindows | null
  urgency: Urgency
  /** The clock that governs this kind, and what it says. */
  clock: string
  closesOn: string
  left: number
  /** True when the shop named a document and no paper of that number is in the books it passed in. */
  dangling: boolean
  why: string
}

/**
 * The amendment board: each open item against the window that can still carry it. `knownDocs` is the
 * shop's own list of document numbers — a reference found on nothing is printed as such, never dropped.
 */
export function amendmentBoard(
  store: FilingsStore, args: { today: string; knownDocs?: string[] | null },
): BoardRow[] {
  const docs = args.knownDocs ?? null
  return store.amendments.map(a => {
    const windows = windowsFor(store, a.period, args.today)
    const clock = AMENDMENT_META[a.kind].clock
    const w = windows ? (clock === 'gstr1a' ? windows.gstr1a : clock === 'table9a' ? windows.table9a : windows.itc) : null
    let urgency: Urgency = 'open'
    if (a.status === 'carried') urgency = 'done'
    else if (a.status === 'lapsed') urgency = 'lapsed'
    else if (!w) urgency = 'open'
    else if (!w.open) urgency = 'lapsed'
    else if (w.left <= 7) urgency = 'act_now'
    else if (w.left <= 30) urgency = 'closing'
    const dangling = !!docs && !!a.doc_ref && !docs.some(d => d.trim().toLowerCase() === a.doc_ref.trim().toLowerCase())
    return {
      amendment: a,
      windows,
      urgency,
      clock: AMENDMENT_META[a.kind].basis,
      closesOn: w?.closesOn ?? '',
      left: w?.left ?? 0,
      dangling,
      why: a.status === 'carried'
        ? `Carried through ${a.carried_in || 'a return'}.`
        : w && !w.open ? w.why : `${w?.why ?? 'No window on this period yet.'} ${AMENDMENT_META[a.kind].where}.`,
    }
  })
}

export function openAmendmentsFor(store: FilingsStore, period: string): Amendment[] {
  return store.amendments.filter(a => a.period === period && a.status === 'open')
}

/* ── the calendar, and whether it still matches the rule ───────────────────── */

export function profileFor(settings: FilingsSettings): Profile {
  return { ...DEFAULT_PROFILE, filing: settings.cadence, taxAudit: settings.taxAudit }
}

export interface ExpectedRow {
  form: FilingForm
  period: string
  periodLabel: string
  periodKind: PeriodKind
  eventId: string
  calendarTitle: string
  calendarDue: string
  href: string
  statutory: StatutoryDue | null
  /** The date the row will be measured against before any record overrides it. */
  due: string
  dueSource: DueChoice['provenance']
  dueNote: string
  /** A sentence when the app's calendar and the rule do not agree. */
  drift: string
}

export function calendarEventFor(
  settings: FilingsSettings, period: string, events: ComplianceEvent[] | null,
): ComplianceEvent | null {
  if (!events) return null
  const cadence = settings.cadence
  for (const e of events) {
    if (e.category !== 'gst') continue
    const form = FORM_BY_CALENDAR[e.form]
    if (!form) continue
    if (eventPeriod(form, e.due, cadence) === period) return e
  }
  return null
}

/** Every return the statute expects for one financial year, keyed the way this register keys rows. */
export function expectedRows(
  fyStart: number, settings: FilingsSettings, events?: ComplianceEvent[],
): ExpectedRow[] {
  const list = events ?? generateEvents(fyStart, profileFor(settings))
  const out: ExpectedRow[] = []
  const seen = new Set<string>()
  for (const e of list) {
    if (e.category !== 'gst') continue
    const form = FORM_BY_CALENDAR[e.form]
    if (!form) continue
    const period = eventPeriod(form, e.due, settings.cadence)
    const kind = periodKindOf(period)
    if (!kind || !FORM_META[form].cadence.includes(kind)) continue
    const key = filingId(form, period)
    if (seen.has(key)) continue
    if (form === 'gstr9' && settings.cadence === 'composition') continue
    seen.add(key)
    const stat = statutoryDue(form, period, settings)
    let drift = ''
    if (stat && stat.cited && stat.date && stat.date !== e.due) {
      drift = `The calendar states ${e.due} for ${e.form}; ${stat.citation} gives ${stat.date}.`
    } else if (stat && stat.cited && !stat.date) {
      drift = `${stat.citation} — so the calendar's date for this row cannot be checked yet.`
    } else if (stat && !stat.cited) {
      // Only a date the rule does *not* state is worth a sentence: the row agrees with a cited rule
      // when the two dates match, and printing that as "drift" would say the opposite of what it means.
      drift = `${stat.citation}. The calendar's date is kept; this register does not present a notified date as a rule.`
    }
    out.push({
      form, period, periodLabel: periodLabel(period), periodKind: kind,
      eventId: e.id, calendarTitle: e.title, calendarDue: e.due, href: e.href ?? FORM_META[form].href,
      statutory: stat,
      due: stat && stat.cited && stat.date ? stat.date : e.due,
      dueSource: stat && stat.cited && stat.date ? 'cited from the rule' : 'the app calendar',
      dueNote: stat ? stat.citation : '',
      drift,
    })
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.form.localeCompare(b.form))
}

/** GST paper the calendar carries that this register deliberately does not. */
export function untrackedRows(fyStart: number, settings: FilingsSettings, events?: ComplianceEvent[]): {
  form: string; title: string; due: string; why: string
}[] {
  const list = events ?? generateEvents(fyStart, profileFor(settings))
  return list
    .filter(e => e.category === 'gst' && !FORM_BY_CALENDAR[e.form])
    .map(e => ({
      form: e.form, title: e.title, due: e.due,
      why: UNTRACKED_CALENDAR_FORMS[e.form] ?? 'This register keeps returns and statements; the calendar keeps the rest.',
    }))
}

/** The calendar's own GST rows against what the statute asks of *this* shop's registration. */
export interface Objection {
  title: string
  why: string
  citation: string
  severity: Severity
}

/**
 * Where the app's calendar asks something of the shop the rules do not, or says nothing when the rules
 * do. The composition dealer's GSTR-9 is the standing case: section 59 excepts a person paying tax
 * under section 10, and the calendar still generates the row.
 */
export function calendarObjections(
  fyStart: number, settings: FilingsSettings, events?: ComplianceEvent[],
): Objection[] {
  const list = events ?? generateEvents(fyStart, profileFor(settings))
  const out: Objection[] = []
  const gst9 = list.filter(e => e.category === 'gst' && e.form === 'GSTR-9')
  if (settings.cadence === 'composition' && gst9.length) {
    out.push({
      title: `The calendar asks ${FORM_META.gstr9.label} for a composition dealer`,
      why: 'A person paying tax under section 10 is excepted from the annual return; the composition '
        + 'year is stated in GSTR-4. This register drops the GSTR-9 row and keeps the GSTR-4 one.',
      citation: 'section 59, opening words, with section 10(2) and rule 62(1)(ii)',
      severity: 'warn',
    })
  }
  if (settings.cadence === 'qrmp') {
    const quarterly3b = list.filter(e => e.category === 'gst' && e.form === 'GSTR-3B')
    const unchecked = new Set<string>()
    for (const e of quarterly3b) {
      const period = eventPeriod('gstr3b', e.due, 'qrmp')
      const stat = statutoryDue('gstr3b', period, settings)
      if (period && (!stat || !stat.date)) unchecked.add(period)
    }
    if (unchecked.size) {
      out.push({
        title: 'The quarterly summary returns cannot be checked against rule 61(1)(ii) yet',
        why: `Rule 61(1)(ii) puts ${unchecked.size} of them on the twenty-second or twenty-fourth day by `
          + 'the state of the principal place of business. The register does not know which category this shop '
          + 'is in — name the state in Settings and the drift is checked automatically. The app\'s calendar also '
          + 'carries these as twelve monthly rows; a QRMP filer furnishes four, so this register folds them onto '
          + 'the quarter and prints the disagreement on each row.',
        citation: 'rule 61(1)(ii)',
        severity: 'info',
      })
    }
    out.push({
      title: 'A QRMP filer still pays monthly, and the calendar does not carry that day',
      why: 'Rule 61(3) wants the tax for the first two months of the quarter deposited in FORM GST PMT-06 by '
        + 'the twenty-fifth day of the month succeeding. It is a payment, not a return, so it is not this '
        + "register's to keep — and the calendar emits no PMT-06 row, so this objection is where a quarterly "
        + 'filer hears the day at all.',
      citation: 'rule 61(3) with the proviso to section 39(7)',
      severity: 'warn',
    })
  }
  const monthly3b = list.filter(e => e.category === 'gst' && e.form === 'GSTR-3B')
  if (settings.cadence === 'monthly' && monthly3b.length) {
    out.push({
      title: 'The calendar says no late fee runs on GSTR-3B; section 47 says one does',
      why: 'The calendar\'s note for every summary return reads "No late fee since Circular 231/2024". Section '
        + '47 attaches a late fee to a default in the return under section 39, and the notifications of '
        + '01.06.2021 fix the ceiling rather than removing the fee. This register estimates ₹50 a day inside '
        + 'the turnover ceiling and prints both the notification and the calendar\'s sentence, so the shop can '
        + 'see the disagreement instead of inheriting one side of it.',
      citation: 'section 47 with Notifications No. 19 and 20/2021-Central Tax, dated 01.06.2021',
      severity: 'warn',
    })
  }
  return out
}

/** The calendar's own tick, matched by the event id it stores under. */
export interface TickCheck {
  eventId: string
  label: string
  /** The calendar says it is done and this register has no filed row, or the other way round. */
  note: string
}

export function calendarTicks(orgId: string): StatusMap {
  return typeof window === 'undefined' ? {} : loadStatuses(orgId)
}

export function crossCheck(rows: RegisterRow[], statuses: StatusMap): TickCheck[] {
  const out: TickCheck[] = []
  for (const r of rows) {
    if (!r.eventId) continue
    const tick = statuses[r.eventId]
    const filed = r.record ? r.record.status !== 'not_filed' : false
    if (tick && !filed) {
      out.push({
        eventId: r.eventId, label: `${FORM_META[r.form].label} · ${r.periodLabel}`,
        note: `/gst/calendar is ticked done on ${tick.doneOn}${tick.reference ? ` (${tick.reference})` : ''}, but this register has no filed row for the period. One of the two is wrong about the same return.`,
      })
    } else if (!tick && filed) {
      out.push({
        eventId: r.eventId, label: `${FORM_META[r.form].label} · ${r.periodLabel}`,
        note: `Recorded here as filed on ${r.record?.filed_on || '—'}; the calendar still shows it open. Clear the calendar row too, or the two lists disagree in front of the next person who reads them.`,
      })
    }
  }
  return out
}

/* ── consequences the rules already enforce ─────────────────────────────────── */

export type Severity = 'block' | 'warn' | 'info'

export interface Consequence {
  code: string
  title: string
  why: string
  citation: string
  severity: Severity
  href: string
}

/**
 * The two bars that can be read off this register's own rows: rule 59(6), which stops the outward
 * statement until the summary return of the preceding period is in, and rule 59(6)(d), which stops it
 * while a rule 88C(1) intimation on that return stands unpaid.
 */
export function consequencesFor(
  store: FilingsStore, form: FilingForm, period: string, today: string,
): Consequence[] {
  const out: Consequence[] = []
  const settings = store.settings
  if (form === 'gstr1') {
    const prev = prevPeriod(period)
    if (prev) {
      const three = store.filings.find(f => f.form === 'gstr3b' && f.period === prev)
      const filedPrev = !!three && three.status !== 'not_filed'
      if (!filedPrev) {
        out.push({
          code: 'rule_59_6',
          title: 'The portal will not take this GSTR-1',
          why: settings.cadence === 'monthly'
            ? `The GSTR-3B for ${periodLabel(prev)} is not recorded as filed. Rule 59(6)(a) speaks of the preceding month, and the common portal enforces it before your figures are read.`
            : `The GSTR-3B for ${periodLabel(prev)} is not recorded as filed. For a quarterly filer rule 59(6)(b) bars the GSTR-1 and the Invoice Furnishing Facility both.`,
          citation: settings.cadence === 'monthly' ? 'rule 59(6)(a)' : 'rule 59(6)(b)',
          severity: 'block',
          href: '/gst/gstr3b',
        })
      }
      if (filedPrev && n(three?.unpaid_intimation) > 0) {
        out.push({
          code: 'rule_59_6_d',
          title: 'An intimation stands unpaid on the previous return',
          why: `₹${n(three?.unpaid_intimation).toLocaleString('en-IN')} was intimated under rule 88C(1) on ${periodLabel(prev)} and this register has it unpaid. Until it is deposited or answered, rule 59(6)(d) keeps the next GSTR-1 shut.`,
          citation: 'rule 59(6)(d) with rule 88C(1)',
          severity: 'block',
          href: '/gst/gstr3b',
        })
      }
    }
  }
  if (form === 'gstr1a') {
    const w = windowsFor(store, period, today)
    if (w && !w.gstr1a.open) {
      out.push({
        code: 'rule_59_1_proviso',
        title: 'The amendment door is shut for this period',
        why: w.gstr1a.why,
        citation: 'proviso to rule 59(1)',
        severity: 'warn',
        href: '/gst/filings?tab=amendments',
      })
    }
  }
  if (form === 'gstr9') {
    const months = expectedRows(periodFyStart(period), settings)
      .filter(r => r.form === 'gstr3b' && r.periodKind !== 'year')
    const missing = months.filter(r => {
      const rec = store.filings.find(f => f.form === 'gstr3b' && f.period === r.period)
      return !rec || rec.status === 'not_filed'
    })
    if (missing.length) {
      out.push({
        code: 'nine_needs_the_year',
        title: 'The workpaper has gaps this return is reconciled against',
        why: `${missing.length} of ${months.length} summary returns for FY ${auditFyLabel(periodFyStart(period))} are not on the register. GSTR-9 reconciles the year against them; /gst/gstr9 draws 9C from the same figures.`,
        citation: 'section 59 with section 39; Table 9 of FORM GSTR-9',
        severity: 'warn',
        href: '/gst/gstr9',
      })
    }
    if (settings.taxAudit) {
      out.push({
        code: 'nine_c',
        title: 'This is an audit case — GSTR-9C goes with it',
        why: 'Turnover above ₹5 crore takes the audited reconciliation statement along with the annual return. The certificate is not this register\'s to hold; the workpaper at /gst/gstr9 is where its figures are built.',
        citation: 'section 35(5) with rule 80',
        severity: 'info',
        href: '/gst/gstr9',
      })
    }
  }
  if (form === 'gstr4' && settings.cadence !== 'composition') {
    out.push({
      code: 'wrong_scheme',
      title: 'GSTR-4 is a composition return',
      why: 'The register is set to a monthly/QRMP filer. A regular taxpayer files GSTR-9 for the year; this row is here because you asked for it, not because the cadence calls for it.',
      citation: 'section 10(2) with rule 62(1)(ii)',
      severity: 'info',
      href: '/gst/filings?tab=returns',
    })
  }
  return out
}

/* ── declared against books ────────────────────────────────────────────────── */

export type VarianceStatus = 'unset' | 'matched' | 'variance'

export interface VarianceRow {
  form: FilingForm
  period: string
  periodLabel: string
  stated: Heads | null
  books: Heads | null
  /** books − stated: positive means the return said less than the books hold. */
  diff: Heads
  status: VarianceStatus
  heads: string[]
}

/** The books figure behind one period: the months it covers, summed. */
export function booksForPeriod(
  booksByMonth: Record<string, Heads>, period: string,
): Heads | null {
  const months = periodMonths(period)
  if (!months.length) return null
  let found = false
  const total = emptyHeads()
  for (const m of months) {
    const b = booksByMonth[m]
    if (!b) continue
    found = true
    total.taxable += b.taxable; total.igst += b.igst; total.cgst += b.cgst
    total.sgst += b.sgst; total.cess += b.cess; total.tax += b.tax
  }
  if (!found) return null
  return {
    taxable: round2(total.taxable), igst: round2(total.igst), cgst: round2(total.cgst),
    sgst: round2(total.sgst), cess: round2(total.cess), tax: round2(total.tax),
  }
}

/** What the return stated against what the shop's own documents hold, inside gstr9's ₹1 tolerance. */
export function varianceFor(stated: Heads | null, books: Heads | null): { diff: Heads; status: VarianceStatus; heads: string[] } {
  if (!stated || !books) return { diff: emptyHeads(), status: 'unset', heads: [] }
  const diff: Heads = {
    taxable: round2(books.taxable - stated.taxable),
    igst: round2(books.igst - stated.igst),
    cgst: round2(books.cgst - stated.cgst),
    sgst: round2(books.sgst - stated.sgst),
    cess: round2(books.cess - stated.cess),
    tax: round2(books.tax - stated.tax),
  }
  const heads: string[] = []
  if (Math.abs(diff.taxable) > RECON_TOLERANCE) heads.push('taxable value')
  if (Math.abs(diff.igst) > RECON_TOLERANCE) heads.push('IGST')
  if (Math.abs(diff.cgst) > RECON_TOLERANCE) heads.push('CGST')
  if (Math.abs(diff.sgst) > RECON_TOLERANCE) heads.push('SGST')
  if (Math.abs(diff.cess) > RECON_TOLERANCE) heads.push('Cess')
  if (Math.abs(diff.tax) > RECON_TOLERANCE) heads.push('total tax')
  return { diff, status: heads.length ? 'variance' : 'matched', heads }
}

export const VARIANCE_META: Record<VarianceStatus, { label: string; tone: 'blue' | 'green' | 'red' | 'amber' | 'grey' }> = {
  unset: { label: 'Nothing to compare', tone: 'grey' },
  matched: { label: 'Ties', tone: 'green' },
  variance: { label: 'Variance', tone: 'red' },
}

export function declaredVsBooks(
  store: FilingsStore, booksByMonth: Record<string, Heads>, fyStart: number, settings: FilingsSettings,
): VarianceRow[] {
  const rows: VarianceRow[] = []
  for (const r of expectedRows(fyStart, settings)) {
    const rec = store.filings.find(f => f.form === r.form && f.period === r.period)
    if (!rec || rec.status === 'not_filed') continue
    const books = booksForPeriod(booksByMonth, r.period)
    const v = varianceFor(rec.heads, books)
    rows.push({
      form: r.form, period: r.period, periodLabel: r.periodLabel,
      stated: rec.status === 'nil' ? emptyHeads() : rec.heads,
      books, diff: v.diff, status: v.status, heads: v.heads,
    })
  }
  // A row recorded without the calendar expecting it — an amendment, a late year — still compares.
  for (const rec of store.filings) {
    if (rec.status === 'not_filed') continue
    if (periodFyStart(rec.period) !== fyStart) continue
    if (rows.some(r => r.form === rec.form && r.period === rec.period)) continue
    const books = booksForPeriod(booksByMonth, rec.period)
    const v = varianceFor(rec.heads, books)
    rows.push({
      form: rec.form, period: rec.period, periodLabel: periodLabel(rec.period),
      stated: rec.status === 'nil' ? emptyHeads() : rec.heads,
      books, diff: v.diff, status: v.status, heads: v.heads,
    })
  }
  return rows.sort((a, b) => a.period.localeCompare(b.period))
}

/* ── the grid the page prints ──────────────────────────────────────────────── */

export type FilingState = 'filed' | 'nil' | 'late' | 'overdue' | 'blocked' | 'due_today' | 'due_soon' | 'scheduled' | 'recorded'

export const STATE_META: Record<FilingState, { label: string; tone: 'blue' | 'green' | 'red' | 'amber' | 'grey' }> = {
  filed: { label: 'Filed on time', tone: 'green' },
  nil: { label: 'Nil, filed', tone: 'green' },
  late: { label: 'Filed late', tone: 'amber' },
  overdue: { label: 'Overdue', tone: 'red' },
  blocked: { label: 'Blocked by the chain', tone: 'red' },
  due_today: { label: 'Due today', tone: 'amber' },
  due_soon: { label: 'Due within a week', tone: 'amber' },
  scheduled: { label: 'Coming up', tone: 'blue' },
  recorded: { label: 'Recorded, not expected', tone: 'grey' },
}

export interface RegisterRow {
  key: string
  form: FilingForm
  period: string
  periodLabel: string
  periodKind: PeriodKind
  eventId: string
  href: string
  /** The effective date the row is measured against, and where it came from. */
  due: string
  dueSource: DueChoice['provenance']
  dueNote: string
  drift: string
  record: FilingRecord | null
  state: FilingState
  days: number
  fee: FeeEstimate
  consequences: Consequence[]
  blocked: boolean
  seal: { sealed: boolean; label: string; id: string }
  amendments: number
  /** The optional GSTR-1A window for the same period, when the period has a GSTR-1 row. */
  window: Window | null
}

export interface RegisterArgs {
  fyStart: number
  today: string
  events?: ComplianceEvent[] | null
  audit?: AuditStore | null
}

/** Expected rows and recorded rows in one grid — a record with no calendar row still shows. */
export function registerRows(store: FilingsStore, args: RegisterArgs): RegisterRow[] {
  const settings = store.settings
  const events = args.events ?? generateEvents(args.fyStart, profileFor(settings))
  const expected = expectedRows(args.fyStart, settings, events)
  const rows: RegisterRow[] = []
  const seen = new Set<string>()

  for (const e of expected) {
    const rec = store.filings.find(f => f.form === e.form && f.period === e.period) ?? null
    seen.add(filingId(e.form, e.period))
    rows.push(shapeRow(store, e.form, e.period, rec, {
      due: e.due, dueSource: e.dueSource, dueNote: e.dueNote, drift: e.drift,
      eventId: e.eventId, href: e.href,
    }, e.periodLabel, args))
  }

  for (const rec of store.filings) {
    const key = filingId(rec.form, rec.period)
    if (seen.has(key)) continue
    if (periodFyStart(rec.period) !== args.fyStart) continue
    const ev = calendarEventFor(settings, rec.period, events)
    rows.push(shapeRow(store, rec.form, rec.period, rec, {
      due: rec.due || ev?.due || '', dueSource: rec.due ? 'stated on the row' : 'the app calendar',
      dueNote: rec.due_reason || FORM_META[rec.form].rule, drift: '',
      eventId: ev?.id ?? '', href: ev?.href ?? FORM_META[rec.form].href,
    }, periodLabel(rec.period), args))
  }

  return rows.sort((a, b) => a.due.localeCompare(b.due) || a.period.localeCompare(b.period) || a.form.localeCompare(b.form))
}

function shapeRow(
  store: FilingsStore, form: FilingForm, period: string, record: FilingRecord | null,
  base: { due: string; dueSource: DueChoice['provenance']; dueNote: string; drift: string; eventId: string; href: string },
  label: string, args: RegisterArgs,
): RegisterRow {
  const settings = store.settings
  const due = record?.due || base.due
  const dueSource: DueChoice['provenance'] = record?.due ? 'stated on the row' : base.dueSource
  const nil = record?.status === 'nil'
  const filed = !!record && record.status !== 'not_filed'
  const tax = record && !nil ? record.heads.tax : 0

  const measured = filed ? (record?.filed_on || args.today) : args.today
  const days = due ? daysLate(due, measured) : 0
  const fee = estimateLateFee({
    form, days, nil, tax, due,
    paidOn: record?.tax_paid_on || (filed ? record?.filed_on : '') || '',
    today: args.today,
    precedingFyTurnover: settings.precedingFyTurnover,
    stateTurnover: settings.stateTurnover,
    lateFeePaid: record?.late_fee_paid ?? 0,
    interestPaid: record?.interest_paid ?? 0,
  })

  const consequences = consequencesFor(store, form, period, args.today)
  const blocked = consequences.some(c => c.severity === 'block')

  const seal: PeriodSeal | null = sealForPeriod(args.audit, period)

  let state: FilingState
  if (filed) state = nil ? 'nil' : (days > 0 ? 'late' : 'filed')
  else if (blocked) state = 'blocked'
  else if (!due) state = 'recorded'
  else if (args.today > due) state = 'overdue'
  else if (args.today === due) state = 'due_today'
  else if (daysBetween(args.today, due) <= 7) state = 'due_soon'
  else state = 'scheduled'

  return {
    key: filingId(form, period),
    form, period, periodLabel: label, periodKind: periodKindOf(period) ?? 'month',
    eventId: base.eventId, href: base.href,
    due, dueSource, dueNote: record?.due_reason || base.dueNote, drift: base.drift,
    record, state, days, fee, consequences, blocked,
    seal: { sealed: !!seal, label: seal?.label ?? '', id: seal?.id ?? '' },
    amendments: openAmendmentsFor(store, period).length,
    window: form === 'gstr1' ? windowsFor(store, period, args.today)?.gstr1a ?? null : null,
  }
}

export interface RegisterStats {
  total: number
  filed: number
  nil: number
  late: number
  open: number
  overdue: number
  blocked: number
  dueSoon: number
  drift: number
  openAmendments: number
  lapsedAmendments: number
  feeTotal: number
  interestTotal: number
  sealed: number
}

export function registerStats(rows: RegisterRow[], board: BoardRow[]): RegisterStats {
  const has = (r: RegisterRow, s: FilingState) => r.state === s
  return {
    total: rows.length,
    filed: rows.filter(r => has(r, 'filed') || has(r, 'late')).length,
    nil: rows.filter(r => has(r, 'nil')).length,
    late: rows.filter(r => has(r, 'late')).length,
    open: rows.filter(r => !r.record || r.record.status === 'not_filed').length,
    overdue: rows.filter(r => has(r, 'overdue')).length,
    blocked: rows.filter(r => r.blocked).length,
    dueSoon: rows.filter(r => has(r, 'due_soon') || has(r, 'due_today')).length,
    drift: rows.filter(r => !!r.drift).length,
    openAmendments: board.filter(b => b.amendment.status === 'open').length,
    lapsedAmendments: board.filter(b => b.urgency === 'lapsed').length,
    feeTotal: round2(rows.reduce((s, r) => s + r.fee.fee, 0)),
    interestTotal: round2(rows.reduce((s, r) => s + r.fee.interest, 0)),
    sealed: rows.filter(r => r.seal.sealed).length,
  }
}

/* ── the seal, read and offered ────────────────────────────────────────────── */

/**
 * A filing record is a transcript, not a book entry, so this register does not ask `sealGuard` before
 * it writes. It does read the seals — a sealed period is shown as closed paper — and it offers to
 * close one through /audit's own `sealPeriod`, which keeps its rules: an ended period, no overlap.
 *
 * This is the only place that turns a *period label* into a seal: /audit's `sealForDate` answers for a
 * day, a filing row is a month or a quarter, so the span is folded to its first day here rather than at
 * each caller. Two spellings of the same question (`sealOf` beside `sealForDate`) read as two different
 * rules, which is how a register ends up asking the wrong one.
 */
export function sealForPeriod(audit: AuditStore | null | undefined, period: string): PeriodSeal | null {
  const range = periodRange(period)
  if (!audit || !range) return null
  return sealForDate(audit, range.from)
}

export function sealFilingsPeriod(
  orgId: string, period: string, note = '', actor = '', today: string = todayISO(),
): { result: SealResult; label: string } {
  const p = parsePeriod(period)
  if (!p) {
    const store = loadAudit(orgId)
    return { result: { ok: false, store, why: 'That period is not a shape this register can close.' }, label: '' }
  }
  if (p.kind === 'month') {
    const r = sealPeriod(orgId, { kind: 'month', month: period, note, actor }, today)
    return { result: r, label: periodLabel(period) }
  }
  if (p.kind === 'year') {
    const r = sealPeriod(orgId, { kind: 'year', year: p.y, note, actor }, today)
    return { result: r, label: `FY ${auditFyLabel(p.y)}` }
  }
  // Rule 40's seal kinds are a month or a year; a quarter is three months of paper.
  const store = loadAudit(orgId)
  const months = periodMonths(period)
  const open = months.filter(m => !sealForPeriod(store, m))
  if (!open.length) return { result: { ok: true, store, why: `All three months of ${periodLabel(period)} are already sealed.` }, label: periodLabel(period) }
  return {
    result: {
      ok: false, store,
      why: `A seal closes a month or a year. ${periodLabel(period)} is ${open.length} month${open.length === 1 ? '' : 's'} of paper — seal ${open.join(', ')} at /audit, one month at a time.`,
    },
    label: periodLabel(period),
  }
}

/** Everything the page needs that lives on another register, in one call. */
export function loadContext(orgId: string, fyStart: number, today: string = todayISO()) {
  const store = loadFilings(orgId)
  const events = generateEvents(fyStart, profileFor(store.settings))
  const audit = typeof window === 'undefined' ? null : loadAudit(orgId)
  const statuses = typeof window === 'undefined' ? {} : loadStatuses(orgId)
  const rows = registerRows(store, { fyStart, today, events, audit })
  const board = amendmentBoard(store, { today })
  return {
    store, events, audit, statuses, rows, board,
    untracked: untrackedRows(fyStart, store.settings, events),
    objections: calendarObjections(fyStart, store.settings, events),
    checks: crossCheck(rows, statuses),
    stats: registerStats(rows, board),
    exposure: exposureOf(rows),
  }
}

/* ── what this register is not ─────────────────────────────────────────────── */

export const NOT_TRACKED: { title: string; why: string }[] = [
  {
    title: 'The portal itself',
    why: 'No GSP feed, no ARN check, no download of what the department holds. A row here is what the shop '
      + 'says was filed; the register prints that and never implies the portal agreed.',
  },
  {
    title: 'The Invoice Furnishing Facility',
    why: UNTRACKED_CALENDAR_FORMS.IFF,
  },
  {
    title: 'The PMT-06 deposit a QRMP filer owes monthly',
    why: 'Rule 61(3) wants the tax for the first two months of a quarter deposited in FORM GST PMT-06 by the '
      + 'twenty-fifth day of the month succeeding. It is a payment, not a return, so a deposit belongs on '
      + '/payments — and the compliance calendar carries no PMT-06 day yet, which is the other half of why '
      + 'it is named here: a quarterly filer who reads only this register, or only the calendar, would never '
      + 'be told.',
  },
  {
    title: 'Refunds, notices and demands',
    why: 'A refund claim, a DRC-01A, a SCN or a demand has no return period to hang on and belongs to the '
      + 'notice file this app does not keep yet.',
  },
  {
    title: 'The figures on the statements',
    why: 'Nothing in ledger.ts reads this register. Correcting a filed return does not move the balance sheet; '
      + 'that is what a journal entry at /journal is for, and the two stay deliberately apart.',
  },
]

export const BOUNDARY: string[] = [
  '**Dates are snapshotted, then checked.** The calendar\'s date is copied onto the row and kept; where a rule '
    + 'states the day, `statutoryDue()` re-derives it and every disagreement is printed as drift.',
  '**Late fee is the slab, not the headline.** Section 47\'s ₹5,000 is the middle of three ceilings that turn on '
    + 'the preceding year\'s turnover; GSTR-9 has its own table capped by a percentage of the turnover in this '
    + 'State or Union territory. The estimate prints its notification.',
  '**An amendment lives inside a window.** The proviso to rule 59(1), Table 9A, and section 16(4) each shut on '
    + 'their own terms; a correction with no window left is printed as lapsed, not as a task.',
  '**The chain is quoted, not invented.** Rule 59(6)(a)/(b) and 59(6)(d) with 88C(1) are the only bars this '
    + 'register states, because both can be read from the rows on the register.',
  '**A filed row is a transcript.** It can be corrected, and the correction is journalled on /audit — but it is '
    + 'not a posting, it pays nothing, and it does not ask the seal.',
]

/* ── export ────────────────────────────────────────────────────────────────── */

export const FILINGS_CSV_HEADERS = [
  'Form', 'Period', 'Status', 'State', 'Due (row)', 'Due from', 'Drift', 'Filed on', 'Reference',
  'Taxable', 'IGST', 'CGST', 'SGST', 'Cess', 'Tax', 'Days late', 'Late fee (rule)', 'Late fee (paid)',
  'Interest (rule)', 'Interest (paid)', 'Slab', 'Seal', 'Amendments open', 'Blocked by', 'Notes', 'By', 'History',
]

export function filingsCsvRows(rows: RegisterRow[]): (string | number)[][] {
  return rows.map(r => {
    const rec = r.record
    const heads = rec?.heads ?? emptyHeads()
    return [
      FORM_META[r.form].label, r.periodLabel, rec ? STATUS_META[rec.status].label : 'Not recorded',
      STATE_META[r.state].label, r.due, r.dueSource, r.drift,
      rec?.filed_on ?? '', rec?.reference ?? '',
      heads.taxable, heads.igst, heads.cgst, heads.sgst, heads.cess, heads.tax,
      r.days, r.fee.fee, r.fee.paid.lateFee, r.fee.interest, r.fee.paid.interest, r.fee.slab,
      r.seal.sealed ? r.seal.label : '', r.amendments,
      r.consequences.filter(c => c.severity === 'block').map(c => c.citation).join(' + '),
      rec?.notes ?? '', rec?.actor ?? '',
      (rec?.history ?? []).map(h => `${h.at.slice(0, 10)} ${h.action}: ${h.from || '—'}→${h.to}`).join(' | '),
    ]
  })
}

export const AMENDMENT_CSV_HEADERS = [
  'Period', 'Kind', 'Document', 'Party', 'Effect', 'Taxable', 'Tax', 'Found on', 'Status',
  'Urgency', 'Window shuts', 'Days left', 'Governing clock', 'Carried through', 'In the books?', 'Notes', 'By',
]

export function amendmentCsvRows(board: BoardRow[]): (string | number)[][] {
  return board.map(b => {
    const a = b.amendment
    return [
      periodLabel(a.period), AMENDMENT_META[a.kind].label, a.doc_ref, a.party,
      a.effect === 'reduce' ? 'Reduces' : 'Adds', a.taxable, a.tax, a.found_on,
      AMENDMENT_STATUS_META[a.status].label, URGENCY_META[b.urgency].label,
      b.closesOn, b.left, b.clock, a.carried_in,
      b.dangling ? 'No document of this number is on the list you gave the register' : 'Named on the register',
      a.notes, a.actor,
    ]
  })
}

export const VARIANCE_CSV_HEADERS = [
  'Form', 'Period', 'Stated taxable', 'Stated tax', 'Books taxable', 'Books tax',
  'Taxable difference', 'Tax difference', 'Result', 'Heads that differ',
]

export function varianceCsvRows(rows: VarianceRow[]): (string | number)[][] {
  return rows.map(r => [
    FORM_META[r.form].label, r.periodLabel,
    r.stated?.taxable ?? '', r.stated?.tax ?? '', r.books?.taxable ?? '', r.books?.tax ?? '',
    r.diff.taxable, r.diff.tax, VARIANCE_META[r.status].label, r.heads.join(', '),
  ])
}

/** One FY's worth of money at risk, for the page's headline strip. */
export function exposureOf(rows: RegisterRow[]): { fee: number; interest: number; total: number; periods: number } {
  const fee = round2(rows.reduce((s, r) => s + Math.max(0, r.fee.fee - r.fee.paid.lateFee), 0))
  const interest = round2(rows.reduce((s, r) => s + Math.max(0, r.fee.interest - r.fee.paid.interest), 0))
  return {
    fee, interest, total: round2(fee + interest),
    periods: rows.filter(r => r.days > 0).length,
  }
}
