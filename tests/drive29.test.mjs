// R3-29 — the fifth signed-in drive, and the five defects the eye found where no assertion stood.
//
// R3-21's photographed month end, R3-24's stopped filings clock and R3-27's taxed-late statement are the
// three branches those rounds left "owed to an eye". Driving all three live on the shop's own session
// found the branches working and the prose around them carrying five defects, every one of which was
// invisible to the suites because each suite tests a figure, a state or a sentence it already knew:
//
//   A. `filings.ts` stores its basis strings lowercase because most are read mid-sentence. Three sentences
//      start with one after a full stop, so the live detail printed "…the money left. the day this row
//      states…" and "…a finding, not a zero. rule 61(1)(ii) gives…" — a capitalising `sentence()` now lifts
//      the first letter at the call site, leaving the engine strings lowercase for every mid-sentence use.
//   B. The cost totals sentence agreed its noun through `plural()` but not its verb or pronoun: one stopped
//      row read "1 row stopped on the day their tax was paid and read …". One/their/reads now follow the
//      count, and the same agreement was given to the running and undated clauses.
//   C. A tax paid *before* the day it was owed printed a backward range: "from the day the tax was due
//      (20 Jun 26) till 15 Jun 26". A row not yet due had the same shape. Those states now state the two
//      dates without inventing a range between them; `cannot_tell` prints no measurement at all.
//   D. Each window card printed its note and then its citation, and for two of the three the note *is* the
//      citation's opening — "the proviso to rule 59(1) — proviso to rule 59(1) — …". `clockBasis()` prints
//      the fuller citation alone when the note is its prefix.
//   E. The TDS statement clock read a day longer after breakfast: 5 November at 10:00 made Q2 six days
//      late and ₹1,200, while midnight made it five and ₹1,000; on 15 December the ceiling read 46 against
//      a typed filing day's 45. `asOf` carries a time of day and the due date is midnight, and `ceil()` on
//      that difference gains a day after 00:00. Both ends now drop to their calendar day, and the due date
//      itself is not late — the clock starts the day after it; the page says "Due today" rather than
//      "No filing day" on the day itself.
//
// What this suite fences:
//   A. the day count is whole calendar days at every hour, the due day is not late, and the fee follows,
//   B. the engine's basis strings stay lowercase for mid-sentence use while every sentence that starts
//      with one starts with a capital,
//   C. the cost sentence agrees noun, pronoun and verb at one row and at several,
//   D. no cost detail prints a range backwards, and a row that cannot be read prints no measurement,
//   E. a window card never prints the same citation twice, and the page's "Due today" branch exists.
//
// Run from the repo root with nvm's Node 24 (PATH node is Homebrew v20 and refuses
// --experimental-strip-types):
//   /Users/mohdnizam/.nvm/versions/node/v24.21.0/bin/node --experimental-strip-types --no-warnings \
//     --import ./tests/register.mjs ./tests/drive29.test.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const lsBacking = new Map()
const store = {
  getItem: (k) => (lsBacking.has(k) ? lsBacking.get(k) : null),
  setItem: (k, v) => { lsBacking.set(k, String(v)) },
  removeItem: (k) => { lsBacking.delete(k) },
}
globalThis.localStorage = store
globalThis.window = { localStorage: store }

const {
  buildWorkpaper, emptyTds, setStatementFiling, setVendorSection,
} = await import('@/lib/tds')
const {
  DEFAULT_FILINGS_SETTINGS, FILINGS_VERSION, amendmentCost, parseFilings,
} = await import('@/lib/filings')

let pass = 0
const failures = []
function ok(name, cond, detail = '') {
  pass += 1
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

const root = join(import.meta.dirname, '..')
const filingsPage = readFileSync(join(root, 'src/app/(app)/gst/filings/page.tsx'), 'utf8')
const tdsPage = readFileSync(join(root, 'src/app/(app)/tds/page.tsx'), 'utf8')

/* ── the TDS fixture: one ₹75,000 bill a quarter, so the tax is ₹7,500 ──────── */
// The live drive's own numbers: the quarter read ₹7,500, six days and ₹1,200 at 10:00 on 5 November,
// then five days and ₹1,000 once a filing day was typed. The suite reproduces that quarter exactly.

const VENDOR = { id: 'v1', name: 'A & Co', pan: 'ABCDE1234F', gstin: '' }
const bill = (id, billNumber, billDate) => ({
  id, billNumber, billDate, vendorId: 'v1', vendorName: 'A & Co', gstin: '',
  taxable: 75000, gst: 0, grandTotal: 75000, balanceDue: 0,
})
const BILLS = [
  bill('b1', 'B-1', '2026-05-10'),   // Q1 Apr–Jun, due 2026-07-31, ₹7,500
  bill('b2', 'B-2', '2026-08-12'),   // Q2 Jul–Sep, due 2026-10-31, ₹7,500
  bill('b3', 'B-3', '2026-11-05'),   // Q3 Oct–Dec, due 2027-01-31
  bill('b4', 'B-4', '2027-02-10'),   // Q4 Jan–Mar, due 2027-05-31
]
const BASE = setVendorSection(emptyTds(), 'v1', '194J_PRO')
const read = (state, asOf) => buildWorkpaper(BILLS, [], [VENDOR], state, 2026, asOf)
const q2 = (wp) => wp.statements[1]

/* ── A. the day count is the calendar's, not the clock's ─────────────────────── */

const morning = new Date(2026, 10, 5, 10, 0)   // 5 Nov 2026, 10:00 — when the drive typed
const midnight = new Date(2026, 10, 5, 0, 0)
const lateNight = new Date(2026, 10, 5, 23, 59)

const wpMorning = read(BASE, morning)
eq('A1 Q2 is five whole days late at 10:00, not six', q2(wpMorning).daysLate, 5)
eq('A1a the fee is five days × ₹200', q2(wpMorning).fee, 1000)
eq('A1b and it is not the ₹7,500 cap', q2(wpMorning).capped, false)
eq('A1c a further day still adds ₹200', q2(wpMorning).perDay, 200)
ok('A1d it is still a ceiling, because no filing day is held', q2(wpMorning).ceiling, true)

// The defect was that the same row read differently at different hours of the same day. Every hour must
// agree, and each must agree with the UTC-midnight arithmetic the suite can check independently.
for (const [label, asOf] of [['midnight', midnight], ['10:00', morning], ['23:59', lateNight]]) {
  const w = read(BASE, asOf)
  eq(`A2 at ${label} Q2 is five days late`, q2(w).daysLate, 5)
  eq(`A2a at ${label} Q2 owes ₹1,000`, q2(w).fee, 1000)
}
eq('A2b independent day count agrees', q2(wpMorning).daysLate,
  Math.round((Date.parse('2026-11-05') - Date.parse('2026-10-31')) / 86400000))

// Q1 is long past its cap; the old ceil() made it 98 at 10:00 against 97 at midnight. The drive did not
// see this one, but it is the same defect and the same morning.
eq('A3 Q1 is 97 days late at 10:00, not 98', wpMorning.statements[0].daysLate, 97)
eq('A3a and the fee is capped at the tax', wpMorning.statements[0].fee, 7500)
eq('A3b the cap is its own state', wpMorning.statements[0].capped, true)
eq('A3c with no per-day figure', wpMorning.statements[0].perDay, 0)
eq('A3d Q1 reads 97 at midnight too', read(BASE, midnight).statements[0].daysLate, 97)

// The due date itself is not late: section 50's clock starts the day after the tax was due.
const dueDay = read(BASE, new Date(2026, 9, 31, 23, 59))
eq('A4 on the due date Q2 has run no day', q2(dueDay).daysLate, 0)
eq('A4a and the fee is a real nil', q2(dueDay).fee, 0)
eq('A4b it is not treated as a ceiling', q2(dueDay).ceiling, false)
eq('A4c no per-day figure is pretended', q2(dueDay).perDay, 0)

const dueDayFiled = read(setStatementFiling(BASE, '2026-10-31', { filedOn: '2026-10-31', reference: 'DUE-1' }),
  new Date(2026, 9, 31, 23, 59))
eq('A5 a filing typed on the due date is held', q2(dueDayFiled).filedOn, '2026-10-31')
eq('A5a and is on time, not late', q2(dueDayFiled).daysLate, 0)
eq('A5b the fee reads nil and the clock is not "stopped"', q2(dueDayFiled).stopped, false)
eq('A5c nothing is at stake', q2(dueDayFiled).fee, 0)

// A nil quarter keeps R3-27's split: with no filing day there is no clock and no lateness; with one,
// the transcript runs even though the fee has no tax to charge.
const nilOpen = buildWorkpaper([], [], [], emptyTds(), 2026, morning).statements[1]
eq('A5d a nil quarter with no filing day reads no days late', nilOpen.daysLate, 0)
eq('A5e and claims no clock', nilOpen.ceiling || nilOpen.stopped, false)
const nilFiled = buildWorkpaper([], [], [], setStatementFiling(emptyTds(), '2026-10-31', { filedOn: '2026-11-05', reference: '' }), 2026, morning).statements[1]
eq('A5f a nil quarter filed late keeps its five days', nilFiled.daysLate, 5)
eq('A5g with a nil fee and no fee clock', nilFiled.fee, 0)
eq('A5h the nil stop is not called stopped', nilFiled.stopped, false)

// 15 December at 10:00: the drive's ceiling read 46; the typed filing day then read 45 and stopped.
const dec = new Date(2026, 11, 15, 10, 0)
const wpDec = read(BASE, dec)
eq('A6 the December ceiling is 45 days, not 46', q2(wpDec).daysLate, 45)
eq('A6a and the fee has reached the tax', q2(wpDec).fee, 7500)
eq('A6b the ceiling is labelled', q2(wpDec).ceiling, true)
eq('A6c and the cap is reached, so a further day adds nothing', q2(wpDec).perDay, 0)

const filedDec = read(
  setStatementFiling(BASE, '2026-10-31', { filedOn: '2026-12-15', reference: 'LATE-1' }), dec)
eq('A7 the typed day stops the clock at 45 days', q2(filedDec).daysLate, 45)
eq('A7a with the same fee as the ceiling', q2(filedDec).fee, 7500)
eq('A7b the row is stopped, not a ceiling', q2(filedDec).stopped, true)
eq('A7c and the ceiling flag is gone', q2(filedDec).ceiling, false)
eq('A7d a stopped row adds nothing per day', q2(filedDec).perDay, 0)

// Totals still split a finished figure from a ceiling (Rule 27 / Rule 61).
eq('A8 the year\'s fee is both late quarters at their cap', wpDec.totals.statementFee, 15000)
eq('A8a all of it is a ceiling while no day is held', wpDec.totals.statementFeeCeiling, 15000)
eq('A8b with one day held, only Q1 is still a ceiling', filedDec.totals.statementFeeCeiling, 7500)
eq('A8c and the stopped money is the difference', filedDec.totals.statementFee - filedDec.totals.statementFeeCeiling, 7500)

/* ── B. a basis kept lowercase, a sentence lifted at its start ───────────────── */

// The live register: one filed 3B with a due date, a row paid after it, one paid before it, a future
// period, and a quarter whose rule date cannot be fixed without a state.
const RAW = {
  version: FILINGS_VERSION,
  orgId: 'org-test',
  settings: DEFAULT_FILINGS_SETTINGS,
  filings: [
    { id: 'f-mar', form: 'gstr3b', period: '2026-03', status: 'filed', due: '2026-04-20', filed_on: '2026-04-22', tax_paid_on: '2026-04-25' },
  ],
  amendments: [
    { id: 'a-stopped', period: '2026-03', kind: 'invoice_omitted', effect: 'add', taxable: 500000, tax: 90000, found_on: '2026-05-01', status: 'open', carried_in: '', paid_on: '2026-06-10' },
    { id: 'a-early', period: '2026-03', kind: 'invoice_omitted', effect: 'add', taxable: 100000, tax: 18000, found_on: '2026-04-01', status: 'open', carried_in: '', paid_on: '2026-04-10' },
    { id: 'a-future', period: '2027-01', kind: 'invoice_omitted', effect: 'add', taxable: 100000, tax: 18000, found_on: '2026-10-01', status: 'open', carried_in: '', paid_on: '' },
    { id: 'a-nostate', period: '2026-Q2', kind: 'invoice_omitted', effect: 'add', taxable: 100000, tax: 18000, found_on: '2026-10-01', status: 'open', carried_in: '', paid_on: '' },
  ],
}
const filingsStore = parseFilings(JSON.stringify(RAW), 'org-test')
const TODAY = '2026-10-17'
const cost = (id) => amendmentCost(filingsStore.amendments.find(a => a.id === id), filingsStore, TODAY)

const cStopped = cost('a-stopped')
eq('B1 the stopped row is a finished figure', cStopped.state, 'stopped')
ok('B1a the engine keeps its basis lowercase for mid-sentence use',
  cStopped.paidBasis.startsWith('the day this row states'))
ok('B1b the sentence that starts with it is lifted',
  cStopped.why.includes('. The day this row states the tax was paid'))
ok('B1c and no sentence still opens on the lowercase copy',
  !/\.\s+the day this row states/.test(cStopped.why))
ok('B1d the due basis the row carries is lowercase too',
  cStopped.dueBasis.startsWith('the due date'))

const cEarly = cost('a-early')
eq('B2 a payment before the due day is its own state', cEarly.state, 'stopped_before_due')
ok('B2a its sentence is lifted as well',
  cEarly.why.includes('. The day this row states the tax was paid'))
ok('B2b and it says nothing ran', /Nothing ran\./.test(cEarly.why))

const cFuture = cost('a-future')
eq('B3 a period not yet due is its own state', cFuture.state, 'not_due_yet')
ok('B3a its basis is the rule\'s, lowercase in the engine',
  cFuture.dueBasis.startsWith('re-derived from the rule:'))
ok('B3b and lifted where it begins a sentence',
  cFuture.why.includes('. Re-derived from the rule:'))

const cNoState = cost('a-nostate')
eq('B4 a quarter with no state named cannot be dated', cNoState.state, 'cannot_tell')
ok('B4a the engine basis names the missing state', /no state is named/.test(cNoState.dueBasis))
ok('B4b the sentence that opens on it is lifted',
  cNoState.why.includes('. Rule 61(1)(ii) gives the twenty-second or twenty-fourth'))
ok('B4c and the finding is not dressed as a zero',
  /No start date is a finding, not a zero/.test(cNoState.why))

const cUnparseable = amendmentCost(
  { ...filingsStore.amendments[0], id: 'a-no-period', period: 'not a period' }, filingsStore, TODAY)
eq('B5 an unparseable period cannot be measured', cUnparseable.state, 'cannot_tell')
ok('B5a its why never starts a sentence lowercase', !/\.\s+[a-z]/.test(cUnparseable.why))

/* ── C. the cost totals agree their verb and pronoun with the noun ───────────── */

ok('C1 one stopped row takes "its" and "reads"',
  filingsPage.includes("${one ? 'its' : 'their'}") && filingsPage.includes("${one ? 'reads' : 'read'}"))
ok('C2 several stopped rows take "their" and "read"',
  filingsPage.includes("stopped on the day ${one ? 'its' : 'their'} tax was paid"))
ok('C2a the old unagreed sentence is gone',
  !filingsPage.includes('stopped on the day its tax was paid and reads'))
ok('C3 a single running row takes "reads" and "adds"',
  filingsPage.includes("${one ? 'reads' : 'read'} ${money(t.runningMoney)} so far and ${one ? 'adds' : 'add'}"))
ok('C4 a single undated row takes "is"',
  filingsPage.includes("${t.undatedRows === 1 ? 'is' : 'are'} read to today"))

/* ── D. no range reads backwards, and a row that cannot be read is not measured ─ */

ok('D1 a tax paid before it was due states the two dates, not a range',
  filingsPage.includes("cost.state === 'stopped_before_due' ? (")
  && filingsPage.includes('the money left on or before the day it was owed'))
ok('D2 a period not yet due likewise',
  filingsPage.includes("cost.state === 'not_due_yet' ? (")
  && filingsPage.includes('the day it is owed has not passed'))
ok('D3 the forward range is kept for the states that have one',
  filingsPage.includes('till {formatDateIN(cost.readTo)} — {cost.dueBasis}.'))
ok('D4 a row that cannot be measured prints no measurement',
  filingsPage.includes("cost.state !== 'cannot_tell'"))
ok('D5 the forward range sits inside the state branch, not before it',
  filingsPage.indexOf("cost.state === 'stopped_before_due' ? (") > -1
  && filingsPage.indexOf('of gross tax, from') > filingsPage.indexOf("cost.state === 'stopped_before_due' ? ("))

/* ── E. a window card names its citation once ────────────────────────────────── */

ok('E1 the card prints through the dedupe helper',
  filingsPage.includes('<small>{clockBasis(note, w.citation)}</small>'))
ok('E1a the old double print is gone',
  !filingsPage.includes('<small>{note} — {w.citation}</small>'))
ok('E2 the helper keeps the fuller citation when the note is its prefix',
  filingsPage.includes('norm(citation).startsWith(norm(note))'))
ok('E2a and keeps the note when it is not',
  filingsPage.includes(': `${note} — ${citation}`'))

/* ── F. the page's due-day branch, and the fee clock it starts ───────────────── */

ok('F1 the badge has a due-today state',
  tdsPage.includes("label: 'Due today'") && tdsPage.includes('q.due === todayISO'))
ok('F2 the foot says the clock starts tomorrow',
  tdsPage.includes('The statement falls due today'))
ok('F3 the date input is still bounded by the quarter close and today',
  tdsPage.includes('min={q.periodTo} max={todayISO}'))
ok('F4 the fee is still the statute\'s ₹200 and the tax cap',
  !tdsPage.includes('₹100') && tdsPage.includes('money(TDS_STATEMENT_FEE_PER_DAY)'))

/* ── the tally ──────────────────────────────────────────────────────────────── */

if (failures.length) {
  console.error(`\n${failures.length} failing of ${pass} assertions:\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`drive29: ${pass}/${pass} assertions pass`)
