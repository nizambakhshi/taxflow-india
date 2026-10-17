// Natural-language reporting over the books, with no LLM and no data leaving
// the browser: the question is parsed with deterministic rules and answered by
// summing the same rows the GST reports use. That keeps every answer auditable —
// the UI can show what it understood, the exact figures, and the links to check
// them, which is what a business owner needs before acting on a number.

import { formatINR } from '@/lib/gst-engine'
import { computeProfitLoss, type LedgerJournalRow } from '@/lib/ledger'
import { pluralNoun } from '@/lib/format'

type Row = Record<string, any>

export interface AskDataset {
  invoices: Row[]
  bills: Row[]
  expenses: Row[]
  payments: Row[]
  /** The journal legs the statements read — the same rows `/accounting` is handed, so a question
   *  answered here cannot print a different profit from the sheet printed there. Optional: a shop
   *  with no register answers from its documents alone, exactly as before. */
  journal?: LedgerJournalRow[]
  // True when the page hit its row cap and the figures below are incomplete.
  truncated?: boolean
}

export interface Period {
  start: string
  end: string
  label: string
}

export interface AnswerRow {
  label: string
  value: number
  meta?: string
}

export interface SeriesPoint {
  label: string
  value: number
}

export interface Comparison {
  current: number
  previous: number
  label: string
  previousLabel: string
}

export interface AskAnswer {
  matched: boolean
  intent: IntentId
  intentLabel: string
  headline: string
  value: string
  note: string
  sentence: string
  chips: string[]
  rows: AnswerRow[]
  rowsCaption: string
  // How the UI should render row values: rupees or plain counts.
  unit: 'currency' | 'count'
  series: SeriesPoint[]
  seriesCaption: string
  comparison: Comparison | null
  caveats: string[]
  links: { label: string; href: string }[]
  suggestions: string[]
}

type IntentId =
  | 'sales' | 'collections' | 'cash' | 'purchases' | 'expenses' | 'expense_breakdown'
  | 'profit' | 'gst_output' | 'gst_itc' | 'gst_net' | 'receivables' | 'payables'
  | 'invoice_count' | 'avg_invoice' | 'top_customers' | 'top_vendors' | 'top_products'
  | 'unknown'

// ── Small numeric / date helpers ─────────────────────────
function num(x: unknown): number {
  const n = typeof x === 'string' ? parseFloat(x) : (x as number)
  return n == null || isNaN(n) ? 0 : Number(n)
}

function money(n: number): string {
  return `₹${formatINR(Math.round((n || 0) * 100) / 100)}`
}

function count(n: number): string {
  return new Intl.NumberFormat('en-IN').format(n)
}

function units(n: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n)
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fromISO(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() + n)
  return x
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0)
}

function dayDiff(a: string, b: string): number {
  return Math.round((fromISO(b).getTime() - fromISO(a).getTime()) / 86_400_000)
}

// Invoice/bill/payment dates are 'yyyy-mm-dd' strings, so lexical compare works.
function inRange(date: string | null | undefined, start: string, end: string): boolean {
  if (!date) return false
  const d = date.slice(0, 10)
  return d >= start && d <= end
}

function prettyDate(s: string): string {
  const d = fromISO(s)
  return `${d.getDate()} ${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`
}

function fyOf(d: Date): { year: number; start: Date; end: Date } {
  const year = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return { year, start: new Date(year, 3, 1), end: new Date(year + 1, 2, 31) }
}

function fyLabel(year: number): string {
  return `FY ${year}-${String((year + 1) % 100).padStart(2, '0')}`
}

// The window immediately before `p`, same length — used for growth comparisons.
function previousPeriod(p: Period): Period {
  const length = dayDiff(p.start, p.end) + 1
  const end = addDays(fromISO(p.start), -1)
  const start = addDays(end, -(length - 1))
  return { start: iso(start), end: iso(end), label: `the ${length} days before it` }
}

// ── Time range parsing ───────────────────────────────────
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'am', 'are', 'ask', 'be', 'been', 'but', 'by', 'can', 'did', 'do',
  'does', 'for', 'from', 'get', 'give', 'had', 'has', 'have', 'how', 'i', 'in', 'is',
  'it', 'many', 'me', 'm', 'my', 'of', 'on', 'or', 'please', 'show', 'tell', 'that',
  'the', 'to', 'till', 'was', 'we', 'what', 'when', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
])

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function has(norm: string, ...patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(norm))
}

const MONTH_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b/

function monthIndex(token: string): number {
  const t = token.replace(/\.$/, '')
  const i = MONTH_NAMES.findIndex(m => m.toLowerCase() === t)
  if (i >= 0) return i
  return MONTH_ABBR.findIndex(m => m.toLowerCase() === t.slice(0, 3))
}

export function parsePeriod(norm: string, now: Date): Period {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const thisFY = fyOf(today)
  const clamp = (start: Date, end: Date, label: string): Period => ({
    start: iso(start),
    end: iso(end > today ? today : end),
    label,
  })

  // "FY 2025-26", "fy 25/26", "financial year 2024-25" — kept as a year so a
  // quarter named in the same sentence ("Q2 FY 2025-26") can use it.
  const fyMatch = norm.match(/\b(?:fy|ff|financial year|accounting year)\s*(?:of\s*)?(20)?(\d{2})\s*[-\/]?\s*(?:20)?(\d{2})\b/)
  const explicitFY = fyMatch ? 2000 + Number(fyMatch[2]) : null

  if (has(norm, /\bthis (financial|accounting)?\s*year\b/, /\bthis fy\b/, /\bcurrent fy\b/, /\b(belonging|running) year\b/, /\bytd\b/, /\byear to date\b/)) {
    return clamp(thisFY.start, thisFY.end, `${fyLabel(thisFY.year)} (year to date)`)
  }
  if (has(norm, /\blast (financial|accounting)?\s*year\b/, /\bprevious (financial|accounting)?\s*year\b/, /\blast fy\b/, /\bprevious fy\b/)) {
    const prev = thisFY.year - 1
    return { start: iso(new Date(prev, 3, 1)), end: iso(new Date(prev + 1, 2, 31)), label: fyLabel(prev) }
  }

  // "this month", "last month", "month of september", "september 2025"
  if (has(norm, /\bthis month\b/, /\bcurrent month\b/, /\bmonth to date\b/, /\bmtd\b/, /\bso far this month\b/)) {
    return clamp(new Date(today.getFullYear(), today.getMonth(), 1), endOfMonth(today), `${MONTH_NAMES[today.getMonth()]} ${today.getFullYear()} (so far)`)
  }
  if (has(norm, /\blast month\b/, /\bprevious month\b/)) {
    const m = addMonths(today, -1)
    return clamp(new Date(m.getFullYear(), m.getMonth(), 1), endOfMonth(m), `${MONTH_NAMES[m.getMonth()]} ${m.getFullYear()}`)
  }
  if (has(norm, /\bnext month\b/)) {
    const m = addMonths(today, 1)
    return clamp(new Date(m.getFullYear(), m.getMonth(), 1), endOfMonth(m), `${MONTH_NAMES[m.getMonth()]} ${m.getFullYear()}`)
  }

  const monthName = norm.match(MONTH_RE)
  // "may i know my sales" is the verb, not the month.
  const mayIsVerb = /\bmay\s+(i|we|you|it|this|that|there|or|not)\b/.test(norm)
  if (monthName && !(mayIsVerb && monthName[1] === 'may')) {
    const idx = monthIndex(monthName[1])
    if (idx >= 0) {
      const yearMatch = norm.match(/\b(20\d{2})\b/)
      let year = yearMatch ? Number(yearMatch[1]) : today.getFullYear()
      if (!yearMatch && idx > today.getMonth()) year -= 1
      return {
        start: iso(new Date(year, idx, 1)),
        end: iso(new Date(year, idx + 1, 0)),
        label: `${MONTH_NAMES[idx]} ${year}`,
      }
    }
  }

  // Quarters are financial quarters: Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar.
  const qNum = norm.match(/\bq([1-4])\b/)
  const wantsQuarter = Boolean(qNum) || has(norm, /\bthis quarter\b/, /\bcurrent quarter\b/, /\blast quarter\b/, /\bprevious quarter\b/)
  if (wantsQuarter) {
    let idx = qNum ? Number(qNum[1]) - 1 : Math.floor(((today.getMonth() - 3 + 12) % 12) / 3)
    let year = explicitFY ?? thisFY.year
    if (!qNum && has(norm, /\blast quarter\b/, /\bprevious quarter\b/)) {
      idx = (idx + 3) % 4
      if (idx === 3) year -= 1
    }
    // Q4 of an FY lands in Jan-Mar of the following calendar year.
    const startMonth = 3 + idx * 3
    const calendarYear = startMonth > 11 ? year + 1 : year
    const month = startMonth % 12
    return {
      start: iso(new Date(calendarYear, month, 1)),
      end: iso(new Date(calendarYear, month + 2, 0)),
      label: `Q${idx + 1} ${fyLabel(year)}`,
    }
  }

  if (explicitFY !== null) {
    return { start: iso(new Date(explicitFY, 3, 1)), end: iso(new Date(explicitFY + 1, 2, 31)), label: fyLabel(explicitFY) }
  }

  if (has(norm, /\btoday\b/, /\btoday's\b/, /\bthis ?week\b/, /\bcurrent week\b/, /\bthis week so far\b/)) {
    if (has(norm, /\bthis ?week\b/, /\bcurrent week\b/)) {
      const dow = (today.getDay() + 6) % 7 // Monday = 0
      return clamp(addDays(today, -dow), today, `this week (since ${prettyDate(iso(addDays(today, -dow)))})`)
    }
    return { start: iso(today), end: iso(today), label: `today (${prettyDate(iso(today))})` }
  }
  if (has(norm, /\byesterday\b/)) {
    const y = addDays(today, -1)
    return { start: iso(y), end: iso(y), label: `yesterday (${prettyDate(iso(y))})` }
  }
  if (has(norm, /\blast week\b/, /\bprevious week\b/)) {
    const end = addDays(today, -1)
    const start = addDays(end, -6)
    return { start: iso(start), end: iso(end), label: `last 7 days (${prettyDate(iso(start))} – ${prettyDate(iso(end))})` }
  }

  const nDays = norm.match(/\b(?:last|past|previous)\s+(\d{1,3})\s*(?:no?of\s+)?(days?|weeks?|months?|years?)\b/)
  if (nDays) {
    const n = Number(nDays[1])
    const unit = nDays[2]
    if (unit.startsWith('day')) {
      const start = addDays(today, -(n - 1))
      return { start: iso(start), end: iso(today), label: `last ${n} days (${prettyDate(iso(start))} – ${prettyDate(iso(today))})` }
    }
    if (unit.startsWith('week')) {
      const start = addDays(today, -(n * 7 - 1))
      return { start: iso(n < 5 ? start : start), end: iso(today), label: `last ${n} weeks (${prettyDate(iso(start))} – ${prettyDate(iso(today))})` }
    }
    if (unit.startsWith('month')) {
      const start = new Date(today.getFullYear(), today.getMonth() - (n - 1), 1)
      return { start: iso(start), end: iso(today), label: `last ${n} months (${MONTH_ABBR[start.getMonth()]} ${start.getFullYear()} – ${MONTH_ABBR[today.getMonth()]} ${today.getFullYear()})` }
    }
    const start = new Date(today.getFullYear() - n, today.getMonth(), 1)
    return { start: iso(start), end: iso(today), label: `last ${n} years` }
  }

  // Plain calendar year: "in 2025", "sales 2024"
  const cal = norm.match(/\b(20\d{2})\b/)
  if (cal) {
    const y = Number(cal[1])
    if (y !== today.getFullYear()) {
      return { start: iso(new Date(y, 0, 1)), end: iso(new Date(y, 11, 31)), label: `${y} (calendar year)` }
    }
  }

  return clamp(thisFY.start, thisFY.end, `${fyLabel(thisFY.year)} (year to date)`)
}

// ── Entity (party / product / category) detection ────────
function candidateNames(rows: Row[], keys: string[]): string[] {
  const set = new Set<string>()
  for (const row of rows) {
    for (const key of keys) {
      const raw = row[key]
      if (typeof raw !== 'string') continue
      const name = raw.trim()
      if (name.length >= 3 && !/^\d+$/.test(name)) set.add(name)
    }
  }
  return [...set]
}

// Matches "Sharma Traders" against "sharma traders", "traders sharma" and
// "sharma" — token-set containment is what makes the answers feel forgiving.
function matchesName(norm: string, name: string): boolean {
  const target = normalize(name)
  if (!target) return false
  if (target.length < 3) return false
  if (` ${norm} `.includes(` ${target} `)) return true
  const tokens = target.split(' ').filter(t => t.length >= 3 && !STOP_WORDS.has(t))
  if (tokens.length === 0) return false
  const haystack = ` ${norm.split(' ').filter(t => !STOP_WORDS.has(t)).join(' ')} `
  return tokens.every(t => haystack.includes(` ${t} `))
}

function findLongestMatch(norm: string, names: string[]): string | null {
  let best: string | null = null
  for (const name of names) {
    if (!matchesName(norm, name)) continue
    if (!best || normalize(name).length > normalize(best).length) best = name
  }
  return best
}

export interface DetectedFilters {
  party: string | null
  product: string | null
  category: string | null
}

const GENERIC_CATEGORIES = [
  'Rent', 'Salary', 'Utilities', 'Electricity', 'Internet', 'Telephone', 'Travel',
  'Food', 'Advertising', 'Bank charges', 'Repairs', 'Maintenance', 'Office supplies',
  'Professional fees', 'Insurance', 'Transport', 'Freight', 'Software',
]

const PRODUCT_INTENTS: IntentId[] = ['sales', 'purchases', 'top_products', 'avg_invoice', 'invoice_count']

function detectFilters(norm: string, data: AskDataset, intent: IntentId): DetectedFilters {
  const parties = [...new Set([
    ...candidateNames(data.invoices, ['customer_name']),
    ...candidateNames(data.bills, ['vendor_name']),
    ...candidateNames(data.expenses, ['vendor_name']),
    ...candidateNames(data.payments, ['party_name']),
  ])]
  const party = findLongestMatch(norm, parties)

  let product: string | null = null
  if (PRODUCT_INTENTS.includes(intent)) {
    const names = candidateNames(data.invoices.concat(data.bills).flatMap(r => itemsOf(r)), ['item_name'])
    const nameMatch = findLongestMatch(norm, names)
    if (nameMatch && normalize(nameMatch) !== normalize(party || '')) {
      product = nameMatch
    } else {
      // A bare 4-8 digit token is most likely an HSN/SAC the owner is quoting.
      const hsn = norm.match(/\b(\d{4,8})\b/)
      const lines = data.invoices.concat(data.bills).flatMap(r => itemsOf(r))
      if (hsn && lines.some(l => String(l.hsn_sac || '').replace(/\D/g, '').startsWith(hsn[1]))) {
        product = `HSN ${hsn[1]}`
      }
    }
  }

  const categories = [...new Set(candidateNames(data.expenses, ['category']).concat(GENERIC_CATEGORIES))]
  const category = intent === 'expenses' || intent === 'expense_breakdown'
    ? findLongestMatch(norm, categories)
    : null

  return { party, product, category }
}

// ── Intent classification ────────────────────────────────
interface IntentRule { id: Exclude<IntentId, 'unknown'>; label: string; patterns: RegExp[] }

type ResolvedIntent = Exclude<IntentId, 'unknown'>

const INTENT_RULES: IntentRule[] = [
  {
    id: 'gst_net', label: 'Net GST payable',
    patterns: [/\bnet\s+gst\b/, /\bgst\s+(payable|liability|due|owed)\b/, /\bgst\b[^.]{0,25}\b(pay|owe|paid|paying)\b/, /\btax\s+payable\b/, /\b3b\s+(liability|payable)\b/],
  },
  {
    id: 'gst_itc', label: 'Input tax credit',
    patterns: [/\bitc\b/, /\binput\s+(tax\s+)?credit\b/, /\bgst\s+credit\b/, /\bcredit\s+(available|on\s+purchases?)\b/, /\binput\s+tax\b/],
  },
  {
    id: 'gst_output', label: 'GST collected on sales',
    patterns: [/\bgst\s+(collected|charged|realised|recovered|on\s+sales?)\b/, /\bgst\b[^.]{0,25}\b(collect|collected|charged|charge)\b/, /\boutput\s+(gst|tax)\b/, /\btax\s+(collected|charged)\b/, /\bcgst\b/, /\bsgst\b/, /\bigst\b/, /\bcess\b/, /\bgst\s+amount\b/, /\btotals?\s+of\s+gst\b/],
  },
  {
    id: 'profit', label: 'Profit',
    patterns: [/\bprofit\b/, /\bprofitable\b/, /\bprofitability\b/, /\bnet\s+(income|result)\b/, /\bincome\s+statement\b/, /\bmargin\b/, /\bafter\s+(all\s+)?expenses\b/, /\bam\s+i\s+(making|doing)\b/, /\bmake\s+(any\s+)?money\b/, /\bearnings?\b/, /\bloss\b/],
  },
  {
    id: 'avg_invoice', label: 'Average invoice value',
    patterns: [/\b(average|avg|typical|mean|per)\b[^.]{0,30}\b(invoice|bills?\s+raised|sale|order|ticket|customer)\b/],
  },
  {
    id: 'invoice_count', label: 'Invoices raised',
    patterns: [/\b(how\s+many|number\s+of|count\s+of|total)\b[^.]{0,30}\binvoices?\b/, /\b(how\s+many|number\s+of)\b[^.]{0,30}\b(bills?\s+raised|tax\s+invoices?)\b/],
  },
  {
    id: 'top_customers', label: 'Top customers',
    patterns: [/\b(top|best|biggest|largest|main|key|highest)\b[^.]{0,30}\b(customers?|clients?|parties)\b/, /\bcustomers?\b[^.]{0,20}\b(by\s+sales|ranking|list)\b/, /\bwho\s+(are|is)\s+my\s+(top|biggest|best)\b(?![^.]{0,30}\b(vendors?|suppliers?|products?|items?|goods|expenses?|categories)\b)/],
  },
  {
    id: 'top_vendors', label: 'Top vendors',
    patterns: [/\b(top|best|biggest|largest|main|key|highest)\b[^.]{0,30}\b(vendors?|suppliers?)\b/, /\b(vendors?|suppliers?)\b[^.]{0,20}\b(by\s+(spend|purchase)|ranking|list)\b/, /\bwhich\s+(vendor|supplier)\b/],
  },
  {
    id: 'top_products', label: 'Top products',
    patterns: [/\b(top|best|most|popular|fast\s?moving|highest)\b[^.]{0,30}\b(products?|items?|goods|skus?)\b/, /\bwhich\s+(product|item)\b/, /\bwhat\s+(did\s+i\s+)?(sell|sold)\b/, /\b(products?|items?)\s+(sold|selling)\b/, /\bsold\s+the\s+most\b/, /\bproduct\s+wise\b/],
  },
  {
    id: 'receivables', label: 'Receivables',
    patterns: [/\breceivables?\b/, /\boutstanding\b[^.]{0,25}\b(customers?|clients?|invoices?|to\s+collect)\b/, /\bwho\s+(owes|owe)\b/, /\bcustomers?\s+(who|that)\s+owe\b/, /\bmoney\s+(yet\s+to\s+come|to\s+be\s+collected|to\s+collect|coming\s+in)\b/, /\buncollected\b/, /\bdues?\s+from\b/, /\bpending\b[^.]{0,20}\b(payments?|from)\b[^.]{0,20}\b(customers?|clients?)\b/, /\bpayments?\s+pending\b/],
  },
  {
    id: 'payables', label: 'Payables',
    patterns: [/\bpayables?\b/, /\boutstanding\b[^.]{0,25}\b(vendors?|suppliers?|bills?|to\s+pay)\b/, /\b(owe|owed)\b[^.]{0,25}\b(vendors?|suppliers?|them|to\s+whom)\b/, /\bmoney\s+(to\s+be\s+paid|to\s+pay|going\s+out)\b/, /\bunpaid\b[^.]{0,20}\b(bills?|purchases?|suppliers?|vendors?)\b/, /\bdues?\s+to\b/],
  },
  {
    id: 'cash', label: 'Cash movement',
    patterns: [/\bcash\s+(balance|position|in\s+hand|on\s+hand)\b/, /\bbank\s+balance\b/, /\bhow\s+much\s+cash\b/, /\bcash\s+flow\b/, /\bcash\s+(generated|received|paid)\b/],
  },
  {
    id: 'collections', label: 'Collections',
    patterns: [/\bcollected\b/, /\bcollections?\b/, /\bcash\s+received\b/, /\breceived\b[^.]{0,25}\b(from|payments?|customers?)\b/, /\bpayments?\s+received\b/, /\brealisations?\b/, /\bhow\s+much\b[^.]{0,25}\b(receive|collect)\b/],
  },
  {
    id: 'expense_breakdown', label: 'Expense breakdown',
    patterns: [/\b(by|category|categories|breakdown|break\s?up|wise)\b[^.]{0,20}\b(expenses?|spend|cost)\b/, /\bexpenses?\b[^.]{0,20}\b(by|category|categories|breakdown|wise)\b/, /\bwhere\s+(did|do)\s+i\s+spend\b/, /\bwhat\s+(did|i)\s+spend\b/],
  },
  {
    id: 'purchases', label: 'Purchases',
    patterns: [/\bpurchases?\b/, /\bpurchased\b/, /\bbought\b/, /\bbuys?\b/, /\bbuy\b/, /\bprocurement\b/, /\bstock\s+(bought|purchased)\b/, /\bsupplier\s+spend\b/, /\bbills?\s+(from|entered)\b/, /\binward\s+supplies\b/],
  },
  {
    id: 'expenses', label: 'Expenses',
    patterns: [/\bexpenses?\b/, /\bspending\b/, /\bspent\b/, /\bspend\b/, /\bcosts?\b/, /\brent\b/, /\bsalary\b/, /\bpayroll\b/, /\belectricity\b/, /\binternet\b/, /\badvertising\b/, /\btravel\b/],
  },
  {
    id: 'sales', label: 'Sales',
    patterns: [/\bsales?\b/, /\bsell\b/, /\bsold\b/, /\brevenue\b/, /\bturnover\b/, /\bbilling\b/, /\bbilled\b/, /\bincoming\s+business\b/, /\bbusiness\s+(volume|worth)\b/, /\boutward\s+supplies\b/, /\bhow\s+much\s+did\s+i\s+(make|earn|bill)\b/],
  },
]

function detectIntent(norm: string): IntentRule | null {
  // Ask in the user's terms: 'loss' should not beat 'profit' on a shared row.
  let best: IntentRule | null = null
  let bestScore = 0
  for (const rule of INTENT_RULES) {
    let score = 0
    for (const p of rule.patterns) if (p.test(norm)) score += 1
    if (score > bestScore) { bestScore = score; best = rule }
  }
  return best
}

// ── Row access helpers ───────────────────────────────────
function itemsOf(row: Row): Row[] {
  const nested = row.invoice_items || row.purchase_bill_items
  return Array.isArray(nested) ? nested : []
}

function sumBy(rows: Row[], pick: (r: Row) => number): number {
  let total = 0
  for (const r of rows) total += pick(r)
  return total
}

function groupSum(rows: Row[], key: (r: Row) => string | null, value: (r: Row) => number, limit = 8): AnswerRow[] {
  const map = new Map<string, { value: number; count: number }>()
  for (const r of rows) {
    const label = (key(r) || 'Unnamed').trim() || 'Unnamed'
    const cur = map.get(label) || { value: 0, count: 0 }
    cur.value += value(r)
    cur.count += 1
    map.set(label, cur)
  }
  return [...map.entries()]
    .map(([label, v]) => ({ label, value: v.value, meta: `${v.count} ${pluralNoun(v.count, 'entry')}` }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
}

function monthlyCounts(rows: Row[], limit = 12): AnswerRow[] {
  const map = new Map<string, number>()
  for (const r of rows) {
    const key = String(r.invoice_date || '').slice(0, 7) || 'undated'
    map.set(key, (map.get(key) || 0) + 1)
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-limit)
    .map(([key, value]) => ({
      label: key === 'undated' ? 'Undated' : `${MONTH_ABBR[fromISO(`${key}-01`).getMonth()]} ${key.slice(0, 4)}`,
      value,
      meta: `${value} ${pluralNoun(value, 'invoice')}`,
    }))
}

interface Ctx {
  data: AskDataset
  period: Period
  filters: DetectedFilters
}

function partyLike(name: string | null | undefined, target: string): boolean {
  if (!name) return false
  const a = normalize(name)
  const b = normalize(target)
  return a === b || a.includes(b) || b.includes(a)
}

function lineMatchesProduct(line: Row, filter: string): boolean {
  if (filter.startsWith('HSN ')) {
    return String(line.hsn_sac || '').replace(/\D/g, '').startsWith(filter.slice(4))
  }
  const want = normalize(filter)
  const got = normalize(String(line.item_name || ''))
  return !!got && (got === want || got.includes(want) || want.includes(got))
}

function saleInvoices(ctx: Ctx, start = ctx.period.start, end = ctx.period.end): Row[] {
  const { filters } = ctx
  return ctx.data.invoices.filter(inv => {
    if (inv.status === 'cancelled') return false
    if (!inRange(inv.invoice_date, start, end)) return false
    if (filters.party && !partyLike(inv.customer_name, filters.party)) return false
    if (filters.product && !itemsOf(inv).some(it => lineMatchesProduct(it, filters.product as string))) return false
    return true
  })
}

function purchaseBills(ctx: Ctx, start = ctx.period.start, end = ctx.period.end): Row[] {
  const { filters } = ctx
  return ctx.data.bills.filter(b => {
    if (b.status === 'cancelled') return false
    if (!inRange(b.bill_date, start, end)) return false
    if (filters.party && !partyLike(b.vendor_name, filters.party)) return false
    if (filters.product && !itemsOf(b).some(it => lineMatchesProduct(it, filters.product as string))) return false
    return true
  })
}

function expenseRows(ctx: Ctx, start = ctx.period.start, end = ctx.period.end): Row[] {
  const { filters } = ctx
  return ctx.data.expenses.filter(e => {
    if (!inRange(e.expense_date, start, end)) return false
    if (filters.party && !partyLike(e.vendor_name, filters.party)) return false
    if (filters.category) {
      const cat = normalize(String(e.category || ''))
      const want = normalize(filters.category)
      if (cat !== want && !cat.includes(want) && !want.includes(cat)) return false
    }
    return true
  })
}

function paymentRows(ctx: Ctx, type: 'received' | 'made', start = ctx.period.start, end = ctx.period.end): Row[] {
  return ctx.data.payments.filter(p => {
    if (p.payment_type !== type) return false
    if (!inRange(p.payment_date, start, end)) return false
    if (ctx.filters.party && !partyLike(p.party_name, ctx.filters.party)) return false
    return true
  })
}

function expenseNet(e: Row): number {
  const taxable = num(e.taxable_amount)
  if (taxable > 0) return taxable
  return num(e.amount) - num(e.gst_amount)
}

// Monthly buckets when the window spans more than ~2 months, daily buckets for
// a shorter one. A single month of daily bars is unreadable noise, so there the
// zero days are dropped and only the days with activity are shown.
function buckets(period: Period): { label: string; start: string; end: string }[] {
  const start = fromISO(period.start)
  const end = fromISO(period.end)
  const days = dayDiff(period.start, period.end) + 1
  const out: { label: string; start: string; end: string }[] = []
  if (days > 60) {
    let cursor = new Date(start.getFullYear(), start.getMonth(), 1)
    while (cursor <= end) {
      const monthEnd = endOfMonth(cursor)
      out.push({
        label: `${MONTH_ABBR[cursor.getMonth()]} ${String(cursor.getFullYear()).slice(2)}`,
        start: iso(cursor < start ? start : cursor),
        end: iso(monthEnd > end ? end : monthEnd),
      })
      cursor = addMonths(cursor, 1)
      if (out.length > 36) break
    }
  } else if (days >= 8) {
    let cursor = start
    while (cursor <= end && out.length < 62) {
      out.push({ label: `${cursor.getDate()} ${MONTH_ABBR[cursor.getMonth()]}`, start: iso(cursor), end: iso(cursor) })
      cursor = addDays(cursor, 1)
    }
  }
  return out
}

function seriesFor(period: Period, pick: (start: string, end: string) => number): SeriesPoint[] {
  const bs = buckets(period)
  if (bs.length < 2) return []
  const points = bs.map(b => ({ label: b.label, value: Math.round(pick(b.start, b.end) * 100) / 100 }))
  const daily = dayDiff(period.start, period.end) + 1 <= 60
  const nonZero = points.filter(p => p.value !== 0)
  if (daily && nonZero.length < 2) return []
  return daily ? nonZero : points
}

// ── Answer building ──────────────────────────────────────
const BASE: Omit<AskAnswer, 'matched' | 'intent' | 'intentLabel' | 'headline' | 'value' | 'note' | 'sentence'> = {
  chips: [],
  unit: 'currency',
  rows: [],
  rowsCaption: '',
  series: [],
  seriesCaption: '',
  comparison: null,
  caveats: [],
  links: [],
  suggestions: [],
}

function answer(ctx: Ctx, part: Partial<AskAnswer> & Pick<AskAnswer, 'intent' | 'headline'>): AskAnswer {
  const chips = [`Period: ${ctx.period.label}`]
  if (ctx.filters.party) chips.push(`Party: ${ctx.filters.party}`)
  if (ctx.filters.product) chips.push(`Product: ${ctx.filters.product}`)
  if (ctx.filters.category) chips.push(`Category: ${ctx.filters.category}`)
  const caveats = [...(part.caveats || [])]
  if (ctx.data.truncated) {
    caveats.unshift('Your books hold more documents than this answer could load, so totals may be short of the full picture.')
  }
  return {
    ...BASE,
    ...part,
    matched: part.matched !== false,
    intent: part.intent,
    intentLabel: INTENT_RULES.find(r => r.id === part.intent)?.label || part.headline,
    headline: part.headline,
    chips: [...chips, ...(part.chips || [])],
    caveats,
  } as AskAnswer
}

function trendNote(cmp: Comparison): string {
  if (cmp.previous === 0) {
    return cmp.current === 0
      ? `The same span before this one (${cmp.previousLabel}) was empty too.`
      : `There was nothing at all in ${cmp.previousLabel}, so this is new activity.`
  }
  const diff = cmp.current - cmp.previous
  const pctChange = Math.abs((diff / Math.abs(cmp.previous)) * 100)
  const dir = diff > 0 ? 'up' : 'down'
  return `That is ${pctChange.toFixed(pctChange >= 100 ? 0 : 1)}% ${dir} from ${money(cmp.previous)} in ${cmp.previousLabel}.`
}

function buildComparison(ctx: Ctx, current: number, measure: (start: string, end: string) => number): Comparison | null {
  const prev = previousPeriod(ctx.period)
  if (prev.start > prev.end) return null
  const previous = measure(prev.start, prev.end)
  return {
    current: Math.round(current * 100) / 100,
    previous: Math.round(previous * 100) / 100,
    label: ctx.period.label,
    previousLabel: prev.label,
  }
}

// ── The intents, one function each ───────────────────────
function lineValue(line: Row): number {
  return num(line.taxable_value) || num(line.quantity) * num(line.rate)
}

function lineTax(line: Row): number {
  return num(line.cgst_amount) + num(line.sgst_amount) + num(line.igst_amount) + num(line.cess_amount)
}

// With a product named, the answer has to be line-level: an invoice that also
// carries other items would otherwise be counted whole.
function salesTaxable(ctx: Ctx, start: string, end: string): number {
  const invoices = saleInvoices(ctx, start, end)
  const product = ctx.filters.product
  if (!product) return sumBy(invoices, r => num(r.taxable_amount))
  return sumBy(invoices.flatMap(inv => itemsOf(inv).filter(it => lineMatchesProduct(it, product))), lineValue)
}

function askSales(ctx: Ctx): AskAnswer {
  const invoices = saleInvoices(ctx)
  const product = ctx.filters.product
  const lines = product ? invoices.flatMap(inv => itemsOf(inv).filter(it => lineMatchesProduct(it, product))) : []
  const taxable = salesTaxable(ctx, ctx.period.start, ctx.period.end)
  const tax = product ? sumBy(lines, lineTax) : sumBy(invoices, r => num(r.total_tax))
  const grand = product ? taxable + tax : sumBy(invoices, r => num(r.grand_total))
  const docLabel = product
    ? `${lines.length} ${pluralNoun(lines.length, 'line')} billed`
    : `${invoices.length} ${pluralNoun(invoices.length, 'invoice')}`
  const scoped = !!(ctx.filters.party || product)
  const measure = (s: string, e: string) => salesTaxable(ctx, s, e)
  const cmp = buildComparison(ctx, taxable, measure)
  return answer(ctx, {
    intent: 'sales',
    headline: product ? `Sales of ${product}` : ctx.filters.party ? `Sales to ${ctx.filters.party}` : 'Taxable sales',
    value: money(taxable),
    note: `${docLabel} · GST ${money(tax)} · billed value ${money(grand)}`,
    sentence: `Between ${prettyDate(ctx.period.start)} and ${prettyDate(ctx.period.end)} you billed ${money(taxable)} of taxable sales across ${docLabel}. GST on those sales is ${money(tax)}, so they add up to ${money(grand)}.` + (cmp ? ` ${trendNote(cmp)}` : ''),
    rows: scoped ? [] : groupSum(invoices, r => r.customer_name, r => num(r.taxable_amount), 6),
    rowsCaption: 'Where the sales came from',
    series: seriesFor(ctx.period, measure),
    seriesCaption: 'Taxable sales',
    comparison: cmp,
    links: [{ label: 'Invoices', href: '/invoices' }, { label: 'Sales report', href: '/reports' }],
  })
}

function askCollections(ctx: Ctx): AskAnswer {
  const rows = paymentRows(ctx, 'received')
  const received = sumBy(rows, r => num(r.amount))
  const measure = (s: string, e: string) => sumBy(paymentRows(ctx, 'received', s, e), r => num(r.amount))
  const cmp = buildComparison(ctx, received, measure)
  return answer(ctx, {
    intent: 'collections',
    headline: 'Money received',
    value: money(received),
    note: `${rows.length} ${pluralNoun(rows.length, 'payment')} recorded`,
    sentence: `You collected ${money(received)} in ${rows.length} ${pluralNoun(rows.length, 'payment')} during ${ctx.period.label}.` + (cmp ? ` ${trendNote(cmp)}` : ''),
    rows: groupSum(rows, r => r.party_name, r => num(r.amount), 8),
    rowsCaption: 'Who paid',
    series: seriesFor(ctx.period, (s, e) => sumBy(paymentRows(ctx, 'received', s, e), r => num(r.amount))),
    seriesCaption: 'Collections',
    comparison: cmp,
    caveats: ['Only payments recorded on the Payments screen are counted here — invoice totals are billing, not cash.'],
    links: [{ label: 'Payments', href: '/payments' }],
  })
}

function askCash(ctx: Ctx): AskAnswer {
  const inRows = paymentRows(ctx, 'received')
  const outRows = paymentRows(ctx, 'made')
  const expOut = expenseRows(ctx).filter(e => e.payment_status === 'paid')
  const cashIn = sumBy(inRows, r => num(r.amount))
  const cashOut = sumBy(outRows, r => num(r.amount)) + sumBy(expOut, r => num(r.amount))
  const net = cashIn - cashOut
  return answer(ctx, {
    intent: 'cash',
    headline: 'Net cash movement',
    value: money(net),
    note: `In ${money(cashIn)} · Out ${money(cashOut)}`,
    sentence: `In ${ctx.period.label}, ${money(cashIn)} came in and ${money(cashOut)} went out, a net movement of ${money(net)}.`,
    rows: [
      { label: 'Received from customers', value: cashIn, meta: `${inRows.length} payments` },
      { label: 'Paid to vendors', value: sumBy(outRows, r => num(r.amount)), meta: `${outRows.length} payments` },
      { label: 'Expenses marked paid', value: sumBy(expOut, r => num(r.amount)), meta: `${expOut.length} expenses` },
    ],
    rowsCaption: 'The movement, split',
    caveats: ['This is movement from recorded payments and paid expenses — it is not a bank balance, because the bank opening balance is not tracked here.'],
    links: [{ label: 'Payments', href: '/payments' }, { label: 'Financial statements', href: '/accounting' }],
  })
}

function askPurchases(ctx: Ctx): AskAnswer {
  const rows = purchaseBills(ctx)
  const taxable = sumBy(rows, r => num(r.taxable_amount))
  const tax = sumBy(rows, r => num(r.total_tax))
  const eligible = rows.filter(r => r.itc_eligible !== false)
  const itc = sumBy(eligible, r => num(r.total_tax))
  const measure = (s: string, e: string) => sumBy(purchaseBills(ctx, s, e), r => num(r.taxable_amount))
  const cmp = buildComparison(ctx, taxable, measure)
  return answer(ctx, {
    intent: 'purchases',
    headline: ctx.filters.party ? 'Purchases from this vendor' : 'Taxable purchases',
    value: money(taxable),
    note: `${rows.length} ${pluralNoun(rows.length, 'bill')} · GST ${money(tax)} · ITC eligible ${money(itc)}`,
    sentence: `You recorded ${money(taxable)} of taxable purchases across ${rows.length} ${pluralNoun(rows.length, 'bill')} in ${ctx.period.label}. ${money(itc)} of that carries ITC you can claim.` + (cmp ? ` ${trendNote(cmp)}` : ''),
    rows: ctx.filters.party ? [] : groupSum(rows, r => r.vendor_name, r => num(r.taxable_amount), 8),
    rowsCaption: 'Vendor spend',
    series: seriesFor(ctx.period, (s, e) => sumBy(purchaseBills(ctx, s, e), r => num(r.taxable_amount))),
    seriesCaption: 'Purchases',
    comparison: cmp,
    links: [{ label: 'Bills', href: '/bills' }],
  })
}

/** A journal expense head is judgement, not a bill. It is never folded into the document rows an
 *  expense answer sums; the answer says the statements carry that extra line, and names it — so the
 *  two figures can differ on purpose, in print, rather than by accident. */
function journalExpenseCaveat(ctx: Ctx): string | null {
  const rows = (ctx.data.journal ?? []).filter(r => r.slot === 'expense' && inRange(r.date, ctx.period.start, ctx.period.end))
  if (rows.length === 0) return null
  const by = new Map<string, number>()
  for (const r of rows) by.set(r.label, (by.get(r.label) ?? 0) + r.signed)
  const parts = [...by.entries()]
    .filter(([, v]) => Math.round(v * 100) !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3)
    .map(([label, v]) => `${label} ${v >= 0 ? 'adds' : 'reduces by'} ${money(Math.abs(v))}`)
  if (parts.length === 0) return null
  return `Your financial statements also carry journal expense heads for this period — ${parts.join(', ')} — those are judgement rather than a bill, so they are not counted in the figures above.`
}

function askExpenses(ctx: Ctx): AskAnswer {
  const rows = expenseRows(ctx)
  const net = sumBy(rows, r => expenseNet(r))
  const gst = sumBy(rows, r => num(r.gst_amount))
  const measure = (s: string, e: string) => sumBy(expenseRows(ctx, s, e), r => expenseNet(r))
  const cmp = buildComparison(ctx, net, measure)
  return answer(ctx, {
    intent: 'expenses',
    headline: ctx.filters.category ? `Expenses — ${ctx.filters.category}` : 'Total expenses',
    value: money(net),
    note: `${rows.length} ${pluralNoun(rows.length, 'entry')} · GST on them ${money(gst)}`,
    sentence: ctx.filters.category
      ? `${ctx.filters.category} expenses were ${money(net)} in ${ctx.period.label}, across ${rows.length} ${pluralNoun(rows.length, 'entry')}.`
      : `You spent ${money(net)} (net of GST) in ${ctx.period.label} across ${rows.length} ${pluralNoun(rows.length, 'expense')}.` + (cmp ? ` ${trendNote(cmp)}` : ''),
    rows: groupSum(rows, r => r.category, r => expenseNet(r), 8),
    rowsCaption: 'By category',
    series: seriesFor(ctx.period, (s, e) => sumBy(expenseRows(ctx, s, e), r => expenseNet(r))),
    seriesCaption: 'Expenses',
    comparison: cmp,
    caveats: ['Expenses are counted net of GST, since the GST portion is either ITC or a liability, not cost.']
      .concat([journalExpenseCaveat(ctx)].filter((c): c is string => !!c)),
    links: [{ label: 'Expenses', href: '/expenses' }],
  })
}

function askExpenseBreakdown(ctx: Ctx): AskAnswer {
  const rows = expenseRows(ctx)
  const net = sumBy(rows, r => expenseNet(r))
  const grouped = groupSum(rows, r => r.category, r => expenseNet(r), 10)
  return answer(ctx, {
    intent: 'expense_breakdown',
    headline: 'Expense breakdown',
    value: money(net),
    note: `${grouped.length} ${pluralNoun(grouped.length, 'category')}`,
    sentence: `Your ${money(net)} of expenses in ${ctx.period.label} splits as ${grouped.slice(0, 4).map(g => `${g.label} ${money(g.value)}`).join(', ')}${grouped.length > 4 ? ', and the rest elsewhere' : ''}.`,
    rows: grouped.map(g => ({ ...g, meta: `${net > 0 ? ((g.value / net) * 100).toFixed(1) : '0'}% of spend` })),
    rowsCaption: 'Biggest categories first',
    caveats: ['Expenses are counted net of GST.']
      .concat([journalExpenseCaveat(ctx)].filter((c): c is string => !!c)),
    links: [{ label: 'Expenses', href: '/expenses' }],
  })
}

function askProfit(ctx: Ctx): AskAnswer {
  // One array, every window: the fold reads each row's own date, so the journal figure answered for
  // a period is the same figure the statement prints for that period — never a second arithmetic.
  const journal = ctx.data.journal ?? []
  const pl = computeProfitLoss(
    saleInvoices(ctx) as any,
    purchaseBills(ctx) as any,
    expenseRows(ctx) as any,
    ctx.period.start,
    ctx.period.end,
    journal,
  )
  const prev = previousPeriod(ctx.period)
  const prevPL = computeProfitLoss(
    saleInvoices(ctx, prev.start, prev.end) as any,
    purchaseBills(ctx, prev.start, prev.end) as any,
    expenseRows(ctx, prev.start, prev.end) as any,
    prev.start,
    prev.end,
    journal,
  )
  const margin = pl.revenue > 0 ? (pl.netProfit / pl.revenue) * 100 : null
  const fromJournal = pl.journal.entries > 0
  return answer(ctx, {
    intent: 'profit',
    headline: 'Net profit',
    value: money(pl.netProfit),
    note: `Gross ${money(pl.grossProfit)} · Expenses ${money(pl.totalExpenses)}${margin !== null ? ` · Margin ${margin.toFixed(1)}%` : ''}`,
    sentence: `In ${ctx.period.label}: sales of ${money(pl.revenue)} less purchases of ${money(pl.purchases)} gives a gross profit of ${money(pl.grossProfit)}, and after ${money(pl.totalExpenses)} of expenses the net profit is ${money(pl.netProfit)}.` + (prevPL.netProfit || prevPL.revenue ? ` ${trendNote({ current: pl.netProfit, previous: prevPL.netProfit, label: ctx.period.label, previousLabel: prev.label })}` : ''),
    rows: pl.expensesByCategory.slice(0, 8).map(e => ({ label: e.label, value: e.amount })),
    rowsCaption: 'Expenses by category',
    series: seriesFor(ctx.period, (s, e) => computeProfitLoss(
      saleInvoices(ctx, s, e) as any,
      purchaseBills(ctx, s, e) as any,
      expenseRows(ctx, s, e) as any,
      s, e,
      journal,
    ).netProfit),
    seriesCaption: 'Net profit',
    comparison: {
      current: pl.netProfit,
      previous: prevPL.netProfit,
      label: ctx.period.label,
      previousLabel: prev.label,
    },
    caveats: ['Profit here is sales minus purchases minus expenses. It does not yet value opening/closing stock, so it is a management view, not a filed P&L.']
      .concat(fromJournal
        ? [`This period also reads ${pl.journal.entries} journal ${pluralNoun(pl.journal.entries, 'posting')} — the same rows the financial statements fold, tagged "from the journal".`]
        : []),
    links: [{ label: 'Financial statements', href: '/accounting' }, { label: 'Reports', href: '/reports' }]
      .concat(fromJournal ? [{ label: 'Journal register', href: '/journal' }] : []),
  })
}

function askGstOutput(ctx: Ctx): AskAnswer {
  const rows = saleInvoices(ctx)
  const cgst = sumBy(rows, r => num(r.cgst_amount))
  const sgst = sumBy(rows, r => num(r.sgst_amount))
  const igst = sumBy(rows, r => num(r.igst_amount))
  const cess = sumBy(rows, r => num(r.cess_amount))
  const total = sumBy(rows, r => num(r.total_tax))
  return answer(ctx, {
    intent: 'gst_output',
    headline: 'GST charged on sales',
    value: money(total),
    note: `On ${money(sumBy(rows, r => num(r.taxable_amount)))} of taxable sales`,
    sentence: `You charged ${money(total)} of GST on your sales in ${ctx.period.label} — CGST ${money(cgst)}, SGST ${money(sgst)}, IGST ${money(igst)}${cess > 0 ? `, cess ${money(cess)}` : ''}. That amount is a liability until it is paid or offset by ITC.`,
    rows: [
      { label: 'CGST', value: cgst },
      { label: 'SGST', value: sgst },
      { label: 'IGST', value: igst },
      ...(cess > 0 ? [{ label: 'Cess', value: cess }] : []),
    ],
    rowsCaption: 'Split by tax head',
    series: seriesFor(ctx.period, (s, e) => sumBy(saleInvoices(ctx, s, e), r => num(r.total_tax))),
    seriesCaption: 'GST charged',
    comparison: buildComparison(ctx, total, (s, e) => sumBy(saleInvoices(ctx, s, e), r => num(r.total_tax))),
    links: [{ label: 'GSTR-3B', href: '/gst/gstr3b' }, { label: 'GST dashboard', href: '/gst' }],
  })
}

function itcParts(ctx: Ctx, start: string, end: string) {
  const bills = purchaseBills(ctx, start, end).filter(b => b.itc_eligible !== false)
  const expenses = expenseRows(ctx, start, end).filter(e => e.itc_eligible === true)
  return {
    bills,
    expenses,
    onBills: sumBy(bills, r => num(r.total_tax)),
    onExpenses: sumBy(expenses, r => num(r.gst_amount)),
  }
}

function askGstItc(ctx: Ctx): AskAnswer {
  const p = itcParts(ctx, ctx.period.start, ctx.period.end)
  const total = p.onBills + p.onExpenses
  const blocked = sumBy(purchaseBills(ctx).filter(b => b.itc_eligible === false), r => num(r.total_tax))
  return answer(ctx, {
    intent: 'gst_itc',
    headline: 'Input tax credit available',
    value: money(total),
    note: `Bills ${money(p.onBills)} · Expenses ${money(p.onExpenses)}`,
    sentence: `In ${ctx.period.label} you can claim ${money(total)} of ITC — ${money(p.onBills)} on ${p.bills.length} supplier ${pluralNoun(p.bills.length, 'bill')} and ${money(p.onExpenses)} on expenses.` + (blocked > 0 ? ` A further ${money(blocked)} sits on bills marked ITC-ineligible, so it is a cost, not a credit.` : ''),
    rows: [
      { label: 'On purchase bills', value: p.onBills, meta: `${p.bills.length} bills` },
      { label: 'On expenses marked ITC eligible', value: p.onExpenses, meta: `${p.expenses.length} expenses` },
      ...(blocked > 0 ? [{ label: 'On bills with ITC turned off', value: blocked, meta: 'not claimable' }] : []),
    ],
    rowsCaption: 'Where the credit comes from',
    series: seriesFor(ctx.period, (s, e) => { const q = itcParts(ctx, s, e); return q.onBills + q.onExpenses }),
    seriesCaption: 'ITC',
    comparison: buildComparison(ctx, total, (s, e) => { const q = itcParts(ctx, s, e); return q.onBills + q.onExpenses }),
    caveats: ['This is ITC as per your entered bills. Before filing, match it against GSTR-2B on the reconciliation screen — credit you cannot match is credit you cannot take.'],
    links: [{ label: '2B reconciliation', href: '/gst/reconciliation' }, { label: 'GSTR-3B', href: '/gst/gstr3b' }],
  })
}

function askGstNet(ctx: Ctx): AskAnswer {
  const output = sumBy(saleInvoices(ctx), r => num(r.total_tax))
  const p = itcParts(ctx, ctx.period.start, ctx.period.end)
  const itc = p.onBills + p.onExpenses
  const net = output - itc
  return answer(ctx, {
    intent: 'gst_net',
    headline: net >= 0 ? 'Net GST payable' : 'Net GST credit balance',
    value: money(Math.abs(net)),
    note: `Output ${money(output)} − ITC ${money(itc)}`,
    sentence: `For ${ctx.period.label}, GST charged on sales is ${money(output)} and ITC available is ${money(itc)}, so ${net >= 0 ? `you owe about ${money(net)}` : `you carry a credit of about ${money(-net)}`}.`,
    rows: [
      { label: 'GST charged on sales', value: output },
      { label: 'Less: ITC on purchases and expenses', value: -itc },
      { label: net >= 0 ? 'Payable' : 'Credit carried', value: Math.abs(net) },
    ],
    rowsCaption: 'The set-off',
    caveats: [
      'A rough working only: real set-off rules keep CGST/SGST and IGST in separate lanes, so confirm the split on GSTR-3B before paying.',
      'Dates here are document dates. GST is filed per return period, which may differ from this window.',
    ],
    links: [{ label: 'GSTR-3B', href: '/gst/gstr3b' }, { label: 'GST dashboard', href: '/gst' }],
  })
}

function askReceivables(ctx: Ctx): AskAnswer {
  const asOf = ctx.period.end
  const open = ctx.data.invoices.filter(i =>
    i.status !== 'cancelled' && num(i.balance_due) > 0 && inRange(i.invoice_date, '0001-01-01', asOf) &&
    (!ctx.filters.party || partyLike(i.customer_name, ctx.filters.party)),
  )
  const total = sumBy(open, r => num(r.balance_due))
  const overdueCutoff = iso(addDays(fromISO(asOf), -30))
  const overdue = open.filter(i => (i.invoice_date || '') <= overdueCutoff)
  const overdueAmount = sumBy(overdue, r => num(r.balance_due))
  const billedInPeriod = sumBy(saleInvoices(ctx), r => num(r.grand_total))
  return answer(ctx, {
    intent: 'receivables',
    headline: 'Customers owe you',
    value: money(total),
    note: `${open.length} unpaid ${pluralNoun(open.length, 'invoice')}${overdueAmount > 0 ? ` · ${money(overdueAmount)} over 30 days old` : ''}`,
    sentence: `As at ${prettyDate(asOf)}, ${money(total)} is still to be collected on ${open.length} unpaid ${pluralNoun(open.length, 'invoice')}. Of that, ${money(overdueAmount)} is more than 30 days old. You billed ${money(billedInPeriod)} during ${ctx.period.label}.`,
    rows: groupSum(open, r => r.customer_name, r => num(r.balance_due), 10).map(g => ({ ...g, meta: `${g.meta} outstanding` })),
    rowsCaption: 'Biggest balances first',
    caveats: ['Balance due is read from the invoice record, so it only reflects payments entered on the Payments screen.'],
    links: [{ label: 'Receivables & payables', href: '/payments' }, { label: 'Payment links', href: '/payments/links' }, { label: 'Invoices', href: '/invoices' }],
  })
}

function askPayables(ctx: Ctx): AskAnswer {
  const asOf = ctx.period.end
  const open = ctx.data.bills.filter(b =>
    b.status !== 'cancelled' && num(b.balance_due) > 0 && inRange(b.bill_date, '0001-01-01', asOf) &&
    (!ctx.filters.party || partyLike(b.vendor_name, ctx.filters.party)),
  )
  const total = sumBy(open, r => num(r.balance_due))
  const paidInPeriod = sumBy(paymentRows(ctx, 'made'), r => num(r.amount))
  return answer(ctx, {
    intent: 'payables',
    headline: 'You owe vendors',
    value: money(total),
    note: `${open.length} unpaid ${pluralNoun(open.length, 'bill')}`,
    sentence: `As at ${prettyDate(asOf)}, ${money(total)} is still to be paid to vendors on ${open.length} unpaid ${pluralNoun(open.length, 'bill')}. You paid out ${money(paidInPeriod)} in ${ctx.period.label}.`,
    rows: groupSum(open, r => r.vendor_name, r => num(r.balance_due), 10),
    rowsCaption: 'Largest dues first',
    links: [{ label: 'Receivables & payables', href: '/payments' }, { label: 'Bills', href: '/bills' }],
  })
}

function askInvoiceCount(ctx: Ctx): AskAnswer {
  const rows = saleInvoices(ctx)
  const taxable = sumBy(rows, r => num(r.taxable_amount))
  const avg = rows.length ? taxable / rows.length : 0
  const draft = rows.filter(r => r.status === 'draft').length
  return answer(ctx, {
    intent: 'invoice_count',
    headline: 'Invoices raised',
    value: count(rows.length),
    note: `Worth ${money(taxable)} · average ${money(avg)}`,
    sentence: `You raised ${rows.length} ${pluralNoun(rows.length, 'invoice')} in ${ctx.period.label}, worth ${money(taxable)}, averaging ${money(avg)} each.` + (draft > 0 ? ` ${draft} of them ${draft === 1 ? 'is' : 'are'} still in draft.` : ''),
    rows: monthlyCounts(rows),
    rowsCaption: 'Invoices per month',
    unit: 'count',
    links: [{ label: 'Invoices', href: '/invoices' }],
  })
}

function askAvgInvoice(ctx: Ctx): AskAnswer {
  const rows = saleInvoices(ctx)
  const taxable = sumBy(rows, r => num(r.taxable_amount))
  const avg = rows.length ? taxable / rows.length : 0
  const sorted = [...rows].sort((a, b) => num(b.taxable_amount) - num(a.taxable_amount))
  return answer(ctx, {
    intent: 'avg_invoice',
    headline: 'Average invoice value',
    value: money(avg),
    note: `${rows.length} ${pluralNoun(rows.length, 'invoice')} · total ${money(taxable)}`,
    sentence: `The average invoice in ${ctx.period.label} is ${money(avg)}, from ${money(taxable)} spread over ${rows.length} ${pluralNoun(rows.length, 'invoice')}.` + (sorted.length ? ` Your largest single invoice was ${money(num(sorted[0].taxable_amount))}.` : ''),
    rows: sorted.slice(0, 6).map(r => ({
      label: `${r.invoice_number || 'Invoice'} — ${r.customer_name || 'Unnamed'}`,
      value: num(r.taxable_amount),
      meta: r.invoice_date ? prettyDate(String(r.invoice_date).slice(0, 10)) : '',
    })),
    rowsCaption: 'Largest invoices in the period',
    caveats: rows.length < 3 ? ['With so few invoices the average moves a lot on one big bill.'] : [],
    links: [{ label: 'Invoices', href: '/invoices' }],
  })
}

function askTopCustomers(ctx: Ctx): AskAnswer {
  const rows = saleInvoices(ctx)
  const grouped = groupSum(rows, r => r.customer_name, r => num(r.taxable_amount), 10)
  const total = sumBy(rows, r => num(r.taxable_amount))
  const repeat = new Set(rows.map(r => normalize(String(r.customer_name || '')))).size
  return answer(ctx, {
    intent: 'top_customers',
    headline: grouped.length ? `Top customer: ${grouped[0].label}` : 'Top customers',
    value: grouped.length ? money(grouped[0].value) : money(0),
    note: `${repeat} ${pluralNoun(repeat, 'customer')} bought in ${ctx.period.label}`,
    sentence: grouped.length
      ? `${grouped[0].label} is your largest customer in ${ctx.period.label} with ${money(grouped[0].value)}, ${total > 0 ? `${((grouped[0].value / total) * 100).toFixed(1)}% of ` : ''}of taxable sales. ${grouped.slice(1, 3).map(g => `${g.label} ${money(g.value)}`).join(', ')}.`
      : `No customer sales fall in ${ctx.period.label}.`,
    rows: grouped.map(g => ({ ...g, meta: `${total > 0 ? ((g.value / total) * 100).toFixed(1) : '0'}% of sales` })),
    rowsCaption: 'Ranked by taxable value',
    links: [{ label: 'Customers', href: '/customers' }, { label: 'Invoices', href: '/invoices' }],
  })
}

function askTopVendors(ctx: Ctx): AskAnswer {
  const rows = purchaseBills(ctx)
  const grouped = groupSum(rows, r => r.vendor_name, r => num(r.taxable_amount), 10)
  const total = sumBy(rows, r => num(r.taxable_amount))
  return answer(ctx, {
    intent: 'top_vendors',
    headline: grouped.length ? `Top vendor: ${grouped[0].label}` : 'Top vendors',
    value: grouped.length ? money(grouped[0].value) : money(0),
    note: `${rows.length} ${pluralNoun(rows.length, 'bill')} from ${new Set(rows.map(r => normalize(String(r.vendor_name || '')))).size} vendors`,
    sentence: grouped.length
      ? `You spent most with ${grouped[0].label}: ${money(grouped[0].value)} in ${ctx.period.label}${total > 0 ? `, ${((grouped[0].value / total) * 100).toFixed(1)}% of purchases` : ''}. Next: ${grouped.slice(1, 3).map(g => `${g.label} ${money(g.value)}`).join(', ') || 'nobody else'}.`
      : `No purchase bills fall in ${ctx.period.label}.`,
    rows: grouped.map(g => ({ ...g, meta: `${total > 0 ? ((g.value / total) * 100).toFixed(1) : '0'}% of purchases` })),
    rowsCaption: 'Ranked by taxable purchases',
    links: [{ label: 'Vendors', href: '/vendors' }, { label: 'Bills', href: '/bills' }],
  })
}

function askTopProducts(ctx: Ctx): AskAnswer {
  const invoices = saleInvoices(ctx)
  const lines = invoices.flatMap(inv =>
    itemsOf(inv).filter(it => !ctx.filters.product || lineMatchesProduct(it, ctx.filters.product)),
  )
  const byName = new Map<string, { value: number; qty: number }>()
  for (const line of lines) {
    const name = String(line.item_name || '').trim() || 'Unnamed item'
    const cur = byName.get(name) || { value: 0, qty: 0 }
    cur.value += lineValue(line)
    cur.qty += num(line.quantity)
    byName.set(name, cur)
  }
  const ranked = [...byName.entries()]
    .map(([label, v]) => ({ label, value: v.value, meta: `${units(v.qty)} units` }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
  const total = ranked.reduce((s, r) => s + r.value, 0)
  return answer(ctx, {
    intent: 'top_products',
    headline: ranked.length ? `Best seller: ${ranked[0].label}` : 'Best sellers',
    value: ranked.length ? money(ranked[0].value) : money(0),
    note: ranked.length ? `${ranked[0].meta} · ${count(lines.length)} lines billed` : '',
    sentence: ranked.length
      ? `${ranked[0].label} led your sales in ${ctx.period.label} at ${money(ranked[0].value)} (${ranked[0].meta}). After it: ${ranked.slice(1, 4).map(r => `${r.label} ${money(r.value)}`).join(', ') || 'nothing else of note'}.`
      : `No line items fall in ${ctx.period.label}.`,
    rows: ranked.map(r => ({ ...r, meta: `${total > 0 ? ((r.value / total) * 100).toFixed(1) : '0'}% · ${r.meta}` })),
    rowsCaption: 'By taxable value',
    series: seriesFor(ctx.period, (s, e) => {
      const ids = saleInvoices(ctx, s, e)
      return sumBy(
        ids.flatMap(inv => itemsOf(inv).filter(it => !ctx.filters.product || lineMatchesProduct(it, ctx.filters.product))),
        lineValue,
      )
    }),
    seriesCaption: 'Line-item value billed',
    links: [{ label: 'Products', href: '/products' }, { label: 'Reports', href: '/reports' }],
  })
}

const COMPUTE: Record<Exclude<IntentId, 'unknown'>, (ctx: Ctx) => AskAnswer> = {
  sales: askSales,
  collections: askCollections,
  cash: askCash,
  purchases: askPurchases,
  expenses: askExpenses,
  expense_breakdown: askExpenseBreakdown,
  profit: askProfit,
  gst_output: askGstOutput,
  gst_itc: askGstItc,
  gst_net: askGstNet,
  receivables: askReceivables,
  payables: askPayables,
  invoice_count: askInvoiceCount,
  avg_invoice: askAvgInvoice,
  top_customers: askTopCustomers,
  top_vendors: askTopVendors,
  top_products: askTopProducts,
}

// ── Public API ───────────────────────────────────────────
export const SUGGESTED_QUESTIONS = [
  'What were my sales last month?',
  'Am I making a profit this year?',
  'How much GST do I have to pay this quarter?',
  'How much ITC do I have from purchases?',
  'Who owes me money?',
  'What are my top 5 products?',
  'Which vendor do I pay the most?',
  'Break down my expenses by category',
  'How much did I collect in cash this month?',
  'How many invoices did I raise this month?',
  'What was my average invoice value this year?',
  'Show me sales for the last 6 months',
]

export function emptyDataset(): AskDataset {
  return { invoices: [], bills: [], expenses: [], payments: [], journal: [] }
}

// "What did Sharma buy" and "how much did I pay Gujarat Papers" name a party and
// a money verb but no metric word; the party's role decides which side of the
// books to read.
function partySideIntent(norm: string, data: AskDataset, party: string): ResolvedIntent | null {
  if (!/\b(buy|buys|bought|paid|pay|spend|spent)\b/.test(norm)) return null
  const isCustomer = candidateNames(data.invoices, ['customer_name']).some(n => partyLike(n, party))
  const isVendor = candidateNames(data.bills, ['vendor_name']).some(n => partyLike(n, party))
  if (isVendor && !isCustomer) return 'purchases'
  if (isCustomer && !isVendor) return 'sales'
  return null
}

const SIDE_OVERRIDEABLE = new Set<ResolvedIntent>(['sales', 'purchases', 'expenses', 'collections', 'cash', 'profit'])

export function answerQuestion(question: string, data: AskDataset, options: { now?: Date } = {}): AskAnswer {
  const now = options.now ? new Date(options.now) : new Date()
  const norm = normalize(question)
  const rule = detectIntent(norm)
  const period = parsePeriod(norm, now)

  let id: ResolvedIntent | null = rule ? rule.id : null
  let filters = detectFilters(norm, data, id || 'unknown')
  if (filters.party) {
    const side = partySideIntent(norm, data, filters.party)
    if (side && (id === null || SIDE_OVERRIDEABLE.has(id))) {
      id = side
      filters = detectFilters(norm, data, id)
    }
  }

  if (!id) {
    return {
      ...BASE,
      matched: false,
      intent: 'unknown',
      intentLabel: 'Not recognised',
      headline: 'I could not map that to a report',
      value: '',
      note: '',
      sentence: 'I answer questions about sales, purchases, expenses, profit, GST and dues. Try one of these:',
      chips: [],
      caveats: [],
      suggestions: SUGGESTED_QUESTIONS.slice(0, 6),
    }
  }

  return COMPUTE[id]({ data, period, filters })
}
