// R3-19 — the period-close suite.
//
// `/audit` could always answer *is this window closed* and *who tried to edit it after it was*. It
// could not answer the month-end question — **what is still moving in there** — so a shop sealed a
// half-finished month and the seal's first act was to refuse its own unfinished paper.
// `src/lib/period-close.ts` is the reading that closes that gap, and this suite is the fence around
// it: the window arithmetic, the money being *the statements' own number* rather than a second
// implementation of it, every finding reachable from a named hole in the shop's data, the seal and
// the close kept as two separate answers, an unread register printed as ignorance and never as a zero
// (Rule 27), and the Rule 54 discipline — this engine opens no door.
//
// Run from the repo root:
//   /Users/mohdnizam/.nvm/versions/node/v24.21.0/bin/node --experimental-strip-types --no-warnings \
//     --import ./tests/register.mjs ./tests/close19.test.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeProfitLoss } from '@/lib/ledger'
import { drafts, journalRows, paise, rowsInWindow } from '@/lib/journal'
import { docValue, KIND_META } from '@/lib/orderflow'
import { periodLabel, quarterOfMonth } from '@/lib/filings'
import {
  CLOSE_BOUNDARIES, CLOSE_CSV_HEADERS, CLOSE_STATE_META, SEAL_VIEW_META,
  closeCsvRows, closeMonthOptions, closeReading, closeWindowOf, defaultCloseMonth,
} from '@/lib/period-close'

const ROOT = join(import.meta.dirname, '..')

// ── the harness ───────────────────────────────────────────────────────────────

let pass = 0
const failures = []

function ok(name, cond, detail = '') {
  pass += 1
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// ── the fixtures ──────────────────────────────────────────────────────────────
// One shop, one month read: September 2026, on a device whose today is 17 October 2026.
// Numbers chosen so every figure is exact in paise.

const TODAY = '2026-10-17'
const MONTH = '2026-09'

const invoice = (status, invoice_date, taxable_amount, balance_due) =>
  ({ status, invoice_date, taxable_amount, total_tax: 0, balance_due })
const bill = (status, bill_date, taxable_amount) =>
  ({ status, bill_date, taxable_amount, total_tax: 0, itc_eligible: true, balance_due: 0 })
const expense = (expense_date, taxable_amount, amount, gst_amount, category) =>
  ({ expense_date, taxable_amount, amount, gst_amount, itc_eligible: true, payment_status: 'paid', category })
const payment = (payment_type, payment_date, amount) => ({ payment_type, payment_date, amount })

const docsSept = {
  invoices: [
    invoice('issued', '2026-09-05', 1000, 300),
    invoice('issued', '2026-09-20', 500.25, 0.1),
    invoice('cancelled', '2026-09-21', 999, 999),        // cancelled: counted separately, never in the money
    invoice('issued', '2026-10-02', 700, 700),           // next month: not this window's
  ],
  bills: [
    bill('issued', '2026-09-08', 400),
    bill('cancelled', '2026-09-09', 50),
    bill('issued', '2026-10-01', 60),
  ],
  expenses: [
    expense('2026-09-11', 100, 118, 18, 'Electricity'),   // taxable wins: net 100
    expense('2026-09-19', 0, 500, 0, 'Repairs'),          // falls back to amount − gst: net 500
    expense('2026-10-04', 0, 90, 0, 'Repairs'),
  ],
  payments: [
    payment('received', '2026-09-30', 300),
    payment('made', '2026-09-12', 100),
    payment('received', '2026-10-05', 700),
  ],
}

const head = (id, name, slot, active = true) =>
  ({ id, name, slot, active, notes: '', created_at: '', updated_at: '' })
const leg = (id, head_id, side, amount) => ({ id, head_id, side, amount, note: '' })
const entry = (id, number, date, status, legs) =>
  ({ id, number, date, narration: 'n', reference: '', legs, status, posted_at: '', reversed_by: '', reverses: '', actor: '', created_at: '', updated_at: '' })

const jHeads = [head('h-rent', 'Rent', 'expense'), head('h-bank', 'Bank', 'bank'), head('h-sale', 'Sales', 'revenue')]
const journalSept = {
  version: 1, updatedAt: '', orgId: 'org', heads: jHeads, seq: {},
  entries: [
    entry('e-in', 'JV-0001', '2026-09-15', 'posted', [leg('l1', 'h-rent', 'debit', 500), leg('l2', 'h-bank', 'credit', 500)]),
    entry('e-out', 'JV-0002', '2026-10-05', 'posted', [leg('l3', 'h-sale', 'credit', 900), leg('l4', 'h-bank', 'debit', 900)]),
    entry('e-draft', '', '2026-09-10', 'draft', [leg('l5', 'h-rent', 'debit', 40), leg('l6', 'h-bank', 'credit', 40)]),
    entry('e-draft2', '', '2026-10-03', 'draft', [leg('l7', 'h-rent', 'debit', 10), leg('l8', 'h-bank', 'credit', 10)]),
  ],
}
const journalClean = { ...journalSept, entries: journalSept.entries.filter(e => e.status !== 'draft') }
const journalEmpty = { version: 1, updatedAt: '', orgId: 'org', heads: jHeads, entries: [], seq: {} }

const flowLine = (quantity, rate) =>
  ({ product_id: null, item_name: 'x', hsn_sac: '6109', quantity, unit: 'pc', rate, discount_percent: 0, gst_rate: 0, cess_rate: 0 })
const flowDoc = (id, kind, doc_date, status, lines) =>
  ({ id, kind, number: id, doc_date, due_date: '', party_id: null, party_name: 'p', party_gstin: '', party_address: '', party_state: '', place_of_supply: '', supply_type: 'forward', reason: '', vehicle_number: '', transporter: '', eway_bill_number: '', lines, status, notes: '', created_at: '', converted_to_id: null, converted_to_number: null, converted_at: null })

const flowSept = [
  flowDoc('DC-1', 'challan', '2026-09-28', 'active', [flowLine(4, 250)]),        // 1000, convertible
  flowDoc('SO-1', 'sales_order', '2026-09-30', 'closed', [flowLine(1, 500.5)]),  // 500.50, convertible
  flowDoc('DC-2', 'challan', '2026-09-15', 'converted', [flowLine(2, 100)]),     // already billed
  flowDoc('DC-3', 'challan', '2026-10-02', 'active', [flowLine(2, 100)]),        // not this window
]

const filing = (form, period, status, tax = 0, extra = {}) => ({
  id: `f-${form}-${period}`, form, period,
  period_kind: period.includes('Q') ? 'quarter' : /^\d{4}$/.test(period) ? 'year' : 'month',
  status, due: '', due_reason: '', filed_on: '', reference: '',
  heads: { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, tax },
  tax_paid_on: '', late_fee_paid: 0, interest_paid: 0, unpaid_intimation: 0,
  notes: '', actor: '', history: [], created_at: '', updated_at: '', ...extra,
})

const filingsSept = [
  filing('gstr1', '2026-09', 'not_filed'),
  filing('gstr3b', '2026-09', 'filed', 4200, { filed_on: '2026-10-11' }),
  filing('gstr3b', '2026-Q2', 'not_filed'),
  filing('gstr9', '2026', 'filed', 0, { filed_on: '2026-12-01' }),
  filing('gstr3b', '2026-08', 'not_filed'),                       // a different month's row
]

const seal = (over = {}) => ({
  id: 's1', kind: 'month', period: '2026-09', from: '2026-09-01', to: '2026-09-30',
  label: 'September 2026', note: 'monthly close', sealed_at: '2026-10-03T09:12:00.000Z',
  sealed_by: 'Nizam', released_at: null, release_reason: '', ...over,
})
const event = (id, seq, kind, date, ref, target = 'invoice', note = '', actor = 'Nizam') =>
  ({ id, seq, at: `${date}T10:00:00.000Z`, kind, date, target, ref, actor, note })

const auditEmpty = { version: 1, updatedAt: '', orgId: 'org', seals: [], events: [] }
const auditSealed = { version: 1, updatedAt: '', orgId: 'org', seals: [seal()], events: [] }
const auditTrail = {
  version: 1, updatedAt: '', orgId: 'org',
  seals: [seal()],
  events: [
    event('ev1', 7, 'refused', '2026-09-14', 'INV-0007'),                      // inside the window
    event('ev2', 8, 'note', '2026-09-02', 'September 2026', 'period', 'Books agreed with the CA'),
    event('ev3', 9, 'sealed', '2026-10-03', 'September 2026', 'seal', 'monthly close'),
    event('ev4', 10, 'refused', '2026-10-04', 'INV-0002'),                     // the act, not the window
  ],
}

const Q = quarterOfMonth(2026, 9)
eq('September sits in the fixture’s own quarter', `${Q.fy}-Q${Q.q}`, '2026-Q2')

/** The reading every section below argues about: an ended month, three things still moving, no seal. */
function read(over = {}) {
  return closeReading({
    month: MONTH, today: TODAY, documents: docsSept, journal: journalSept,
    flow: flowSept, filings: filingsSept, audit: auditEmpty, ...over,
  })
}

const base = read()
ok('the reading exists', !!base)

// ── A. the window ─────────────────────────────────────────────────────────────

const w = base.window
eq('an ended month names its first day', w.from, '2026-09-01')
eq('and its last day, February-style arithmetic included', w.to, '2026-09-30')
eq('and the day this reading was taken', w.today, TODAY)
eq('and its label, in the register’s own words', w.label, 'September 2026')
eq('it has ended', w.ended, true)
eq('it could be sealed the day after it ended', w.sealableFrom, '2026-10-01')
eq('its financial year starts in April', w.fyStart, 2026)
eq('a leap February is 29 days', closeWindowOf('2024-02', TODAY).to, '2024-02-29')
eq('a plain February is 28', closeWindowOf('2025-02', TODAY).to, '2025-02-28')
eq('December’s sealable day crosses into January', closeWindowOf('2026-12', TODAY).sealableFrom, '2027-01-01')
eq('a month still running is not ended', closeWindowOf('2026-10', TODAY).ended, false)
eq('and the day it ended is not today', closeWindowOf('2026-10', TODAY).to, '2026-10-31')
eq('a today inside the month reads as that date', closeWindowOf('2026-10', '2026-10-17').today, '2026-10-17')
eq('month 13 is refused, not guessed', closeWindowOf('2026-13', TODAY), null)
eq('month 0 is refused', closeWindowOf('2026-00', TODAY), null)
eq('a bare year is refused', closeWindowOf('2026', TODAY), null)
eq('an empty period is refused', closeWindowOf('', TODAY), null)
eq('a full date is refused — this reading asks for a month key', closeWindowOf('2026-09-14', TODAY), null)
eq('closeReading refuses the same period', read({ month: '2026-13' }), null)

eq('the close defaults to the last month that has fully ended', defaultCloseMonth(TODAY), '2026-09')
eq('and in January it steps back into the last December', defaultCloseMonth('2026-01-05'), '2025-12')
const opts = closeMonthOptions(2026, TODAY)
eq('one financial year offers twelve months', opts.length, 12)
eq('starting in April', opts[0].month, '2026-04')
eq('ending in March', opts[11].month, '2027-03')
eq('six of them have ended', opts.filter(o => o.ended).length, 6)
eq('the running month is marked open', opts.find(o => o.month === '2026-10').ended, false)
eq('a future month is marked open', opts.find(o => o.month === '2027-03').ended, false)
eq('its picker label comes from the register', opts[0].label, 'April 2026')

// ── B. the money is the statements’ money, not a second implementation ────────

const jrows = rowsInWindow(journalRows(journalSept), { start: w.from, end: w.to })
const pl = computeProfitLoss(docsSept.invoices, docsSept.bills, docsSept.expenses, w.from, w.to, jrows)
eq('revenue is computeProfitLoss’s revenue', base.money.revenue, pl.revenue)
eq('purchases is computeProfitLoss’s purchases', base.money.purchases, pl.purchases)
eq('expenses is computeProfitLoss’s totalExpenses', base.money.expenses, pl.totalExpenses)
eq('the net is computeProfitLoss’s net', base.money.netProfit, pl.netProfit)
eq('the engine does not re-derive it either', [base.money.revenue, base.money.purchases, base.money.expenses, base.money.netProfit].join('|'), '1500.25|400|1100|0.25')
eq('a cancelled invoice is not revenue', pl.revenue, 1000 + 500.25)
eq('next month’s invoice is not revenue either', base.money.revenue < 2200, true)
eq('money is read', base.money.loaded, true)
eq('two invoices dated here', base.counts.invoices, 2)
eq('one of them cancelled, counted apart', base.counts.cancelledInvoices, 1)
eq('one bill dated here', base.counts.bills, 1)
eq('two expenses dated here', base.counts.expenses, 2)
eq('received inside the window', base.money.received, 300)
eq('paid inside the window', base.money.paid, 100)
eq('outstanding sums the balance due the window raised', base.money.outstanding, 300.1)
eq('and sums it in paise, not in float', paise(base.money.outstanding), paise(300) + paise(0.1))
eq('one posted entry folded in', base.money.journalEntries, 1)
eq('one posted entry counted from the rows', base.counts.postedEntries, 1)
eq('two legs carried it', base.money.journalLegs, 2)
eq('the journal’s rows are the statements’ rows', base.money.journalEntries, pl.journal.entries)
eq('one draft dated here', base.counts.draftEntries, 1)
eq('two papers dated here were never billed', base.counts.unconvertedPapers, 2)

// a register with nothing to read prints no figure at all
const notLoaded = read({ documents: null })
eq('the fold reports it unloaded', notLoaded.money.loaded, false)
eq('and prints no revenue', notLoaded.money.revenue, 0)
eq('not even a net', notLoaded.money.netProfit, 0)
eq('and it is a state of its own', notLoaded.state, 'not-loaded')

// ── C. the findings: what a seal would stop the shop finishing *in this period* ─

eq('three things are moving', base.findings.length, 3)
eq('in the engine’s own order', base.findings.map(f => f.key).join(','), 'journal-drafts,unconverted-papers,returns-unfiled')

const [fDrafts, fPapers, fReturns] = base.findings
eq('a draft is counted, not posted', fDrafts.count, 1)
eq('its label is a sentence', fDrafts.label, '1 journal draft is dated here')
ok('the drafts finding says posting is refused at the journal’s door', fDrafts.detail.includes("refused at the journal's own door"))
eq('it carries no rupee — a draft holds no posted money', fDrafts.amount, 0)
eq('it links to the journal', fDrafts.href, '/journal')
eq('two papers read as plural', fPapers.label, '2 papers dated here have never been billed')
eq('their value is the registers’ own docValue', fPapers.amount, docValue(flowSept[0]) + docValue(flowSept[1]))
eq('exact in rupees', fPapers.amount, 1500.5)
ok('the unbilled sentence is honest about the conversion date', fPapers.detail.includes("raises its invoice with today's date"))
eq('it links to the kind the shop first met', fPapers.href, KIND_META.challan.listHref)
eq('two returns covering this period are transcribed as not filed', fReturns.count, 2)
eq('plural too', fReturns.label, '2 returns covering this period are transcribed as not filed')
ok('and names Rule 41 rather than inventing a door', fReturns.detail.includes('guards no door'))
eq('it links to the filings register', fReturns.href, '/gst/filings')

// a single paper reads as one, and its kind names the link
const onePaper = read({ journal: journalClean, filings: [], flow: [flowDoc('SO-9', 'sales_order', '2026-09-20', 'active', [flowLine(1, 70)])] })
eq('one paper, singular', onePaper.findings[0].label, '1 paper dated here has never been billed')
eq('a sales order links to its own register', onePaper.findings[0].href, KIND_META.sales_order.listHref)
eq('and only the drafts finding is left besides', onePaper.findings.length, 1)

// ── D. the returns the register holds for this window, read never re-derived ───

eq('four rows cover September', base.returns.length, 4)
eq('month rows first', base.returns.map(r => r.touches).join(','), 'month,month,quarter,year')
eq('then by form', base.returns.map(r => `${r.form}@${r.period}`).join(','), 'gstr1@2026-09,gstr3b@2026-09,gstr3b@2026-Q2,gstr9@2026')
eq('a month row is read with its own status', base.returns[0].status, 'not_filed')
eq('never re-derived', base.returns[1].status, 'filed')
eq('and its filed date is the register’s', base.returns[1].filedOn, '2026-10-11')
eq('the tax is the one transcribed', base.returns[1].statedTax, 4200)
eq('a quarter is labelled by the register', base.returns[2].label, periodLabel('2026-Q2'))
eq('a year covers the year above both', base.returns[3].touches, 'year')
eq('another month’s row is not this window’s', base.returns.some(r => r.period === '2026-08'), false)

// ── E. the seal’s answer, kept separate from the close’s ──────────────────────

eq('with no seal the window reads open', base.seal.view, 'open')
eq('and nothing is claimed about it', base.seal.seal, null)
eq('an open month can still be unfinished', base.state, 'unfinished')

const sealed = read({ audit: auditSealed })
eq('a standing month seal seals this window', sealed.seal.view, 'sealed')
eq('and names itself', sealed.seal.seal.label, 'September 2026')
eq('a year seal covering the days answers for it too',
  read({ audit: { ...auditEmpty, seals: [seal({ kind: 'year', period: '2026', from: '2026-04-01', to: '2027-03-31', label: 'FY 2026-27' })] } }).seal.view, 'sealed')
const released = read({ audit: { ...auditEmpty, seals: [seal({ released_at: '2026-10-10T08:00:00.000Z', release_reason: 'a credit note dated in the month' })] } })
eq('a released seal prints released, never as though it still closed anything', released.seal.view, 'released')
ok('the sentence names both days', released.why.includes('closed September 2026 on 2026-10-03, released 2026-10-10'), released.why)
eq('a seal on another window does not answer for this one',
  read({ audit: { ...auditEmpty, seals: [seal({ period: '2026-07', from: '2026-07-01', to: '2026-07-31', label: 'July 2026' })] } }).seal.view, 'open')

// a sealed period is still allowed to be unfinished — that is the whole point of two answers
eq('sealed and unfinished stand together', sealed.state + '/' + sealed.seal.view, 'unfinished/sealed')
eq('the headline keeps both', sealed.headline, 'Closed, with 3 things still moving inside')
ok('and names who sealed it, when, and the note', sealed.why.startsWith('It is closed — Nizam sealed September 2026 on 2026-10-03, with the note "monthly close".'))
const sealedQuiet = read({ audit: auditSealed, journal: journalClean, flow: [], filings: [] })
eq('a sealed, finished month reads ready', sealedQuiet.state, 'ready')
eq('and the seal still says closed', sealedQuiet.headline, 'Closed — September 2026 stands sealed')
ok('with the since-sentence', sealedQuiet.why.includes('Nothing has tried to edit paper dated here since.'))
eq('three seal views, three labels', Object.keys(SEAL_VIEW_META).join(','), 'open,sealed,released')

// ── F. the trail this window is already on the record for ─────────────────────

const withTrail = read({ audit: auditTrail })
eq('two events are dated inside the window', withTrail.trail.about.length, 2)
eq('one of them a refusal', withTrail.trail.refused, 1)
eq('the sealing act is found by its label, not its date', withTrail.trail.acts.length, 1)
eq('and it is the sealed event', withTrail.trail.acts[0].kind, 'sealed')
ok('a refusal inside a ready month is printed as evidence',
  read({ audit: { ...auditEmpty, events: [event('ev1', 1, 'refused', '2026-09-14', 'INV-0007')] }, journal: journalClean, flow: [], filings: [] })
    .why.includes('1 write has been refused against paper dated in this period'))
eq('an event dated in the next month is not about this window', withTrail.trail.about.some(e => e.seq === 10), false)

// ── G. every state is reachable, and each says something different ────────────

const inProgress = read({ month: '2026-10' })
eq('today inside the window outranks everything', inProgress.state, 'in-progress')
ok('and the headline says so', inProgress.headline.includes('today falls inside it'))
ok('the running month prints both dates', inProgress.why.includes('2026-10-31') && inProgress.why.includes(TODAY))
ok('and names the day a seal becomes possible', inProgress.why.includes('could be sealed from 2026-11-01'))
ok('while still counting what would move', inProgress.why.includes('in it would still move'))

const empty = read({ month: '2026-07', documents: { invoices: [], bills: [], expenses: [], payments: [] }, journal: journalEmpty, flow: [], filings: [], audit: auditEmpty })
eq('an ended month with no paper at all', empty.state, 'nothing-here')
eq('calls the month empty in the headline', empty.headline, 'July 2026 holds no paper')
ok('and refuses to call it a clean close', empty.why.includes('a finding, not a clean close'))

const ready = read({ journal: journalClean, flow: [], filings: [] })
eq('an ended month with finished paper', ready.state, 'ready')
eq('reads ready', ready.headline, 'September 2026 is ready to close')
ok('and prints its own counts', ready.why.includes('The period holds 2 invoices, 1 purchase bill, 2 expenses and 1 journal posting'))

const noDraftsOnly = read({ journal: journalClean })
eq('a finished journal is still not a finished month', noDraftsOnly.state, 'unfinished')
eq('and the headline does not soften it', noDraftsOnly.headline, 'September 2026 is not ready to close')
eq('five states, five labels', Object.keys(CLOSE_STATE_META).join(','), 'not-loaded,in-progress,nothing-here,unfinished,ready')
ok('only ready is green', Object.entries(CLOSE_STATE_META).filter(([, m]) => m.tone === 'green').map(([k]) => k).join(',') === 'ready')
ok('unfinished warns in amber', CLOSE_STATE_META.unfinished.tone === 'amber')

// ── H. a register the page could not read is named, never folded into a zero ──

eq('a complete read has nothing uncounted', base.unread.length, 0)
eq('a missing journal is named', read({ journal: null }).unread.join(','), 'the journal')
eq('a missing filings register is named', read({ filings: null }).unread.join(','), 'the filings register')
const nothing = read({ journal: null, flow: null, filings: null })
eq('and three of them at once', nothing.unread.join('|'), 'the journal|the order registers|the filings register')
eq('a window is still read while three registers are unread', nothing.state, 'ready')
ok('written as English in the sentence, not as a joined array',
  nothing.why.includes('Read without the journal, the order registers and the filings register'), nothing.why)
ok('the not-read window prints its own absence', notLoaded.why.includes('prints no figure and no verdict'))
const partial = read({ journal: null, filings: null, flow: [] })
ok('an unfinished month with a register unread still says unread', partial.why.includes('Read without the journal and the filings register'), partial.why)
ok('a zero-count from an unread register is called an absence of evidence', partial.why.includes('absence of evidence'))
const draftless = read({ journal: null, flow: [], filings: [] })
eq('the drafts figure from an unread journal is 0, and said to be unread', `${draftless.counts.draftEntries}/${draftless.unread.join(',')}`, '0/the journal')

// ── I. the boundaries are printed, not smoothed over ──────────────────────────

eq('six boundaries', CLOSE_BOUNDARIES.length, 6)
eq('the reading hands them out as its own copy', base.boundaries === CLOSE_BOUNDARIES, false)
ok('they own the live fold', CLOSE_BOUNDARIES[0].includes('compared against today'))
  // R3-21 amended this pin: the sentence that used to disclaim a photograph now names the one the
  // seal keeps, and the seal that keeps none. Rule 57's last clause — a copy repair amends the pin.
  ok('and it still prints the seal that carries none', CLOSE_BOUNDARIES[0].includes('keeps none'))
ok('they disclaim the act of sealing', CLOSE_BOUNDARIES[1].includes('Nothing on this page closes anything'))
ok('they keep Rule 41 for the returns', CLOSE_BOUNDARIES[2].includes('guards no door'))
ok('they label the outstanding figure as today’s reading', CLOSE_BOUNDARIES[3].includes('as the books hold it today'))
ok('they admit a write that never asks the seal', CLOSE_BOUNDARIES[4].includes('appears in no refusal here'))
ok('and they promise no return', CLOSE_BOUNDARIES[5].includes('not a return'))

// ── J. the export: one flat table, four kinds of row ──────────────────────────

eq('eight columns', CLOSE_CSV_HEADERS.length, 8)
eq('named for a CA', CLOSE_CSV_HEADERS.join(','), 'kind,period,label,item,count,amount,detail,reference')
const rows = closeCsvRows(withTrail)
eq('one summary + 3 findings + 4 returns + 3 events', rows.length, 11)
eq('the summary leads', rows[0][0], 'summary')
eq('and carries the verdict in its detail', rows[0][6].startsWith(withTrail.headline), true)
eq('the summary’s reference is the seal’s answer', rows[0][7], 'Sealed')
eq('the finding rows follow', rows[1][0], 'finding')
eq('with the finding’s own href', rows[1][7], '/journal')
eq('a return row is deep-linkable to its period', rows[4][7], '/gst/filings?q=2026-09')
eq('and prints its status and dates as one sentence', rows[4][6].includes('not_filed · due —'), true)
eq('every row is the same width as the headers', rows.every(r => r.length === CLOSE_CSV_HEADERS.length), true)
eq('a trail row keeps its seq and date', rows[8][7].startsWith('#7 2026-09-14'), true)
eq('no row carries a rupee that this reading never printed', rows.every(r => typeof r[5] === 'number'), true)

// ── K. determinism: the same rows give the same answer ────────────────────────

eq('two reads of the same input are identical', JSON.stringify(read()), JSON.stringify(base))
eq('and a day later the window moves but the money does not', JSON.stringify(read({ today: '2026-10-18' }).money), JSON.stringify(base.money))
eq('a whole financial year already past offers twelve ended months', closeMonthOptions(2025, TODAY).every(o => o.ended), true)

// ── L. Rule 54: this engine opens no door ─────────────────────────────────────

const src = readFileSync(join(ROOT, 'src/lib/period-close.ts'), 'utf8')
ok('the engine reads no storage', !src.includes('localStorage.getItem') && !src.includes('localStorage.setItem'))
ok('it writes no storage either', !src.includes('setItem'))
ok('it imports no server', !src.includes('supabase'))
ok('it never posts a journal entry', !src.includes('writeEntry('))
ok('it never seals a period', !src.includes('sealPeriod(') && !src.includes('releaseSeal('))
ok('it never appends a trail event', !src.includes('appendEvent(') && !src.includes('recordNote('))
ok('it loads no store — the page hands it the rows', !src.includes('loadJournal') && !src.includes('loadFilings') && !src.includes('loadAllDocs'))
ok('the only dates it takes from the device is today’s', src.includes("from '@/lib/audit'"))
ok('and it says the window arithmetic stays local', src.includes('owes nothing to another register'))

// ── M. the page’s side of the bargain ─────────────────────────────────────────

const page = readFileSync(join(ROOT, 'src/app/(app)/audit/page.tsx'), 'utf8')
ok('the close is a third tab, not a new route', page.includes("type Tab = 'seals' | 'trail' | 'close'"))
ok('and the tab list carries it', page.includes("{ value: 'close', label: 'Period close' }"))
ok('the page reads the engine', page.includes("from '@/lib/period-close'"))
ok('a ?month= is guarded before it is trusted', page.includes("/^\\d{4}-\\d{2}$/.test(mo)"))
ok('an unparseable tab query cannot strand the page', page.includes("if (t === 'trail' || t === 'seals' || t === 'close') setTab(t)"))
ok('the fetch waits for the tab, the org and a real month', page.includes("if (tab !== 'close' || !orgId || !/^\\d{4}-\\d{2}$/.test(closeMonth)) return"))
eq('the four tables it folds are the four the ledger reads', ['invoices', 'purchase_bills', 'expenses', 'payments'].filter(t => page.includes(`supabase.from('${t}')`)).length, 4)
ok('the reading is a memo, not a state it keeps', page.includes('const closeReadingNow = useMemo('))
ok('its one action hands the month to the seal dialog', page.includes('function openSealFor(month: string)'))
ok('and the dialog keeps its own year arithmetic', page.includes("const year = fyStartOf(`${month}-01`) ?? Number(month.slice(0, 4))"))
ok('sealing from the close tab stays on the close tab', page.includes("if (tab !== 'close') setTab('seals')"))
ok('the close exports its own file', page.includes('taxflow-period-close-${closeMonth}.csv'))
ok('the export button is the third arm of the ternary', page.includes("tab === 'trail' ? exportTrail : exportClose"))
ok('and it is disabled while nothing is read', page.includes(': !closeReadingNow}'))
ok('money reaches the cards as numbers, not strings', page.includes('value={reading.money.revenue}'))
ok('an unread window prints no rupee at all', page.includes('<strong>No money is printed.</strong>'))
ok('the scope is named before the totals', page.indexOf('au-close-pick') < page.indexOf('reading.money.revenue'))
ok('the read date is printed on the card', page.includes('{reading.window.today}'))
ok('the seal button only appears on an ended, unsealed period', page.includes("const canSeal = reading.window.ended && reading.seal.view === 'open'"))
ok('the chips tell an open month from an ended one', page.includes("{m.ended ? m.month.slice(0, 4) : `${m.month.slice(0, 4)} · open`}"))
ok('and carry pressed state', page.includes('aria-pressed={chosen}'))
ok('findings link to the register that owns them', page.includes('<Link href={f.href} className="au-find-link">'))
ok('a finding’s rupee is printed as a rupee', page.includes('₹{formatINR(f.amount)}'))
ok('the boundaries are printed, not hidden', page.includes('reading.boundaries.map'))
ok('the returns table reads the register’s own tax', page.includes('₹{formatINR(t.statedTax)}'))
ok('a return row deep-links the register', page.includes('/gst/filings?q=${encodeURIComponent(t.period)}'))
ok('the trail rows are the same rows the trail tab draws', page.includes('{visibleEvents.map(e => <EventRow key={e.id} e={e} />)}'))
ok('the header admits the exception', page.includes('hold no money of their own'))
  // R3-21: the claim was true until a seal could carry a photograph; it is now narrower, not crossed.
  ok('and says plainly what a photograph is', page.includes('it repeats what that reading printed'))
ok('and the old absolute claim is gone', !page.includes('It holds no rupee —'))
ok('the close header disclaims the act', page.includes('it closes nothing'))
ok('the month picker cannot strand a bad period', page.includes('is not a month this register can read'))
const newRules = page.slice(page.indexOf('.au-seal-dot.is-warn'), page.indexOf('.au-note-box {'))
ok('the warning dot exists', page.includes('.au-seal-dot.is-warn { color: var(--amber); background: var(--amber-soft); }'))
ok('the findings list exists', page.includes('.au-find-list {') && page.includes('.au-find-why {'))
ok('the close’s new rules are token-only — no hex, no rgba', newRules.length > 700 && !newRules.includes('#') && !newRules.includes('rgba'))
ok('and they inherit the house font, not a re-declared one', !newRules.includes('font-family: ui-monospace') && !newRules.includes('Menlo'))

// ── N. the palette reaches the reading, and promises no month it cannot show ──

const cmds = readFileSync(join(ROOT, 'src/lib/commands.ts'), 'utf8')
ok('the action exists', cmds.includes("id: 'action:period-close'"))
ok('it lands on the close tab', cmds.includes("href: '/audit?tab=close'"))
ok('it is an action, not a record', cmds.includes("kind: 'action'"))
ok('its sublabel says what the reading answers', cmds.includes('What one month still holds'))
ok('it borrows a glyph the set already has', /id: 'action:period-close'[\s\S]{0,400}icon: 'calendar'/.test(cmds))
ok('no month name is claimed the static href cannot show', !/id: 'action:period-close'[\s\S]{0,900}keywords: '[^']*september/.test(cmds))

// ── the verdict ───────────────────────────────────────────────────────────────

console.log(`${pass - failures.length}/${pass} assertions passed`)
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`)
  process.exit(1)
}
