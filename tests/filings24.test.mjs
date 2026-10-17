// R3-24 — the clock stops on the day the tax actually left.
//
// R3-12 shipped *What waiting costs* reading rule 88B(2) up to today and printing the figure as an upper
// bound, and it said so twice: on the card and in the boundary ("this register holds no date the tax was
// paid, so the clock cannot be stopped honestly"). R3-21's shape — a limitation a card prints about
// itself is a task — turned that sentence into this round. A correction row can now state the day its tax
// left, and the register can also read that day off the GSTR-3B row of the return the correction went
// through. Where either exists the figure is exact and the clock is stopped; where neither does, R3-12's
// ceiling is kept whole (Rule 27: a blank is a state, never a zero, and a real nil is a labelled reading).
//
// This suite is the fence for the four things that must never silently regress:
//   A. the priority of the stop date (row > carried return > that return's filing day > nothing),
//   B. that a stopped row is a *figure* and an unstopped one is still a *ceiling* — same tax, two states,
//   C. that the arithmetic measures due→paid and round2's to the paise the engine ships, and
//   D. that the round never invents a date: refusals are sentences, a disagreement is printed not resolved,
//      and clearing a payment date turns a finished figure back into a ceiling with a trail line.
//
// Run from the repo root with nvm's Node 24 (PATH node is Homebrew v20 and refuses
// --experimental-strip-types):
//   /Users/mohdnizam/.nvm/versions/node/v24.21.0/bin/node --experimental-strip-types --no-warnings \
//     --import ./tests/register.mjs ./tests/filings24.test.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// addAmendment / saveFilings guard on `typeof window`; the pure readers below never touch it, but the
// write-path assertions (paid_on round-trips, a cleared date emits a trail line) need a stand-in store.
const lsBacking = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (lsBacking.has(k) ? lsBacking.get(k) : null),
    setItem: (k, v) => { lsBacking.set(k, String(v)) },
    removeItem: (k) => { lsBacking.delete(k) },
  },
}

const {
  AMENDMENT_COST_CSV_HEADERS, AMENDMENT_CSV_HEADERS, BOUNDARY, COST_CITATIONS, COST_STATE_META,
  DEFAULT_FILINGS_SETTINGS, FILINGS_VERSION, NOT_TRACKED, addAmendment, amendmentCost,
  amendmentCostCsvRows, amendmentCostTotals, amendmentPaidNote, amendmentTrailNote, daysBetween,
  parseFilings, saveFilings, stopDate, validateAmendment,
} = await import('@/lib/filings')
const { round2 } = await import('@/lib/gstr9')

const TODAY = '2026-10-17'
const round = (n) => round2(n)
const expectInterest = (tax, from, to) => round(tax * (18 / 100) * (daysBetween(from, to) / 365))

let pass = 0
const failures = []
function ok(name, cond, detail = '') {
  pass += 1
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// ── the fixture ────────────────────────────────────────────────────────────────
// One corrected period (2026-03) whose own GSTR-3B row carries a due date, so the start of the clock is
// the register's number and not a rule re-derivation. Two other 3B rows are the returns a correction can
// be carried through: 2026-04 (a tax-paid date), 2026-05 (only a filing date). 2027-01 is deliberately
// absent — the "the return it names is not on the register" branch.
const RAW = {
  version: FILINGS_VERSION,
  orgId: 'org-test',
  settings: DEFAULT_FILINGS_SETTINGS,
  filings: [
    { id: 'f-mar', form: 'gstr3b', period: '2026-03', status: 'filed', due: '2026-04-20', filed_on: '2026-04-22', tax_paid_on: '2026-04-25' },
    { id: 'f-apr', form: 'gstr3b', period: '2026-04', status: 'filed', due: '2026-05-20', filed_on: '2026-05-22', tax_paid_on: '2026-05-20' },
    { id: 'f-may', form: 'gstr3b', period: '2026-05', status: 'filed', due: '2026-06-20', filed_on: '2026-06-20', tax_paid_on: '' },
  ],
  amendments: [
    { id: 'a-row', period: '2026-03', kind: 'invoice_omitted', effect: 'add', taxable: 500000, tax: 90000, found_on: '2026-05-01', status: 'open', carried_in: '', paid_on: '2026-06-10' },
    { id: 'a-early', period: '2026-03', kind: 'invoice_omitted', effect: 'add', taxable: 100000, tax: 18000, found_on: '2026-04-01', status: 'open', carried_in: '', paid_on: '2026-04-10' },
    { id: 'a-carried-row', period: '2026-03', kind: 'gstr1a', effect: 'add', taxable: 200000, tax: 36000, found_on: '2026-05-01', status: 'carried', carried_in: '2026-04', paid_on: '' },
    { id: 'a-carried-filed', period: '2026-03', kind: 'gstr1a', effect: 'add', taxable: 100000, tax: 18000, found_on: '2026-05-01', status: 'carried', carried_in: '2026-05', paid_on: '' },
    { id: 'a-undated', period: '2026-03', kind: 'itc_late', effect: 'add', taxable: 100000, tax: 18000, found_on: '2026-05-01', status: 'carried', carried_in: 'the 3B for Apr 2026', paid_on: '' },
    { id: 'a-missing-3b', period: '2026-03', kind: 'itc_late', effect: 'add', taxable: 100000, tax: 18000, found_on: '2026-05-01', status: 'carried', carried_in: '2027-01', paid_on: '' },
    { id: 'a-running', period: '2026-03', kind: 'invoice_omitted', effect: 'add', taxable: 100000, tax: 18000, found_on: '2026-05-01', status: 'open', carried_in: '', paid_on: '' },
    { id: 'a-conflict', period: '2026-03', kind: 'gstr1a', effect: 'add', taxable: 100000, tax: 18000, found_on: '2026-05-01', status: 'carried', carried_in: '2026-04', paid_on: '2026-06-10' },
    { id: 'a-reduce', period: '2026-03', kind: 'note_omitted', effect: 'reduce', taxable: 50000, tax: 9000, found_on: '2026-05-01', status: 'open', carried_in: '', paid_on: '' },
  ],
}

const store = parseFilings(JSON.stringify(RAW), 'org-test')
const am = (id) => store.amendments.find(a => a.id === id)

// A round-trip guard the whole suite rests on: the parse must keep the paid_on the fixture wrote, and drop
// a non-date, so a downstream state is reading a real value rather than a stringified guess.
eq('A0 fixture parsed nine amendments', store.amendments.length, 9)
eq('A0a row date survived the parse', am('a-row').paid_on, '2026-06-10')
eq('A0b blank stays blank, not a fabricated date', am('a-running').paid_on, '')

// ── A. the priority of the stop date ───────────────────────────────────────────
const sRow = stopDate(am('a-row'), store)
eq('A1 row states a day — that wins', sRow.from, 'row')
eq('A1a stop date is the row day', sRow.date, '2026-06-10')
ok('A1b basis names the row', /written on the correction itself/.test(sRow.basis))

const sCarried = stopDate(am('a-carried-row'), store)
eq('A2 row silent — the carried return answers', sCarried.from, 'carried_row')
eq('A2a its tax-paid date stops the clock', sCarried.date, '2026-05-20')
ok('A2b basis names whose row it read', /GSTR-3B row/.test(sCarried.basis) && /April 2026/.test(sCarried.basis) && /paid on 2026-05-20/.test(sCarried.basis))

const sFiled = stopDate(am('a-carried-filed'), store)
eq('A3 carried return has no paid date — its filing day answers', sFiled.from, 'carried_filed')
eq('A3a earliest-day date stops the clock', sFiled.date, '2026-06-20')
ok('A3b basis says the day is an earliest, not a proof', /earliest day the tax can have been paid/.test(sFiled.basis))

const sNone = stopDate(am('a-running'), store)
eq('A4 open row with no date — nothing stops', sNone.from, 'none')
eq('A4a no date is an empty string, never a zero-day', sNone.date, '')
ok('A4b basis is a sentence about why', /nothing has stopped the clock/.test(sNone.basis))

const sWords = stopDate(am('a-undated'), store)
eq('A5 carried_in in prose this register cannot date', sWords.from, 'none')
ok('A5a names that the words are unreadable', /cannot date/.test(sWords.basis))

const sMissing = stopDate(am('a-missing-3b'), store)
eq('A6 carried_in names a period but no 3B row exists', sMissing.from, 'none')
ok('A6a the reason says the register holds no such return', /no GSTR-3B is on the register/.test(sMissing.basis))

// A disagreement is printed, never resolved in silence (Rule 14: flagged not corrected).
const sConflict = stopDate(am('a-conflict'), store)
eq('A7 conflict still measures to the shop\'s own date', sConflict.date, '2026-06-10')
ok('A7a both dates are spelled into the finding', /2026-06-10/.test(sConflict.conflict) && /2026-05-20/.test(sConflict.conflict))
ok('A7b names which figure the number follows', /measured to the shop's own date/.test(sConflict.conflict))

// ── B & C. a stopped row is a figure, an unstopped one is a ceiling ─────────────
const cRow = amendmentCost(am('a-row'), store, TODAY)
eq('B1 open row with a paid date is stopped, not running', cRow.state, 'stopped')
eq('B1a the clock reports stopped', cRow.stopped, true)
eq('B1b read-to is the paid day, not today', cRow.readTo, '2026-06-10')
eq('B1c the stop basis travels with the figure', cRow.paidBasis, sRow.basis)
eq('C1 measured due→paid, to the paise', cRow.interest, 2263.56)
eq('C1a independently recomputed', cRow.interest, expectInterest(90000, '2026-04-20', '2026-06-10'))
eq('C1b the day count is what the measure says', cRow.days, daysBetween('2026-04-20', '2026-06-10'))
eq('C1c a stopped row adds nothing per day', cRow.perDay, 0)
ok('B1d the why reads to the day the money left', /read to the day the money left/.test(cRow.why))

const cEarly = amendmentCost(am('a-early'), store, TODAY)
eq('B2 paid before it was due', cEarly.state, 'stopped_before_due')
eq('B2a the clock is stopped', cEarly.stopped, true)
eq('B2b nil, measured not blank', cEarly.interest, 0)
eq('B2c zero days ran', cEarly.days, 0)
ok('B2d the nil is labelled a reading (Rule 27)', /the nil here is a reading, not a blank/.test(cEarly.why))

const cCarried = amendmentCost(am('a-carried-row'), store, TODAY)
eq('B3 a carried row with a readable date is no longer a ceiling', cCarried.state, 'stopped')
eq('B3a stopped on the carried return\'s day', cCarried.readTo, '2026-05-20')
eq('B3b carried-from-row has no row stated date', cCarried.paidOnRow, '')
eq('C2 carried interest measures due→return-paid', cCarried.interest, expectInterest(36000, '2026-04-20', '2026-05-20'))

const cUndated = amendmentCost(am('a-undated'), store, TODAY)
eq('B4 prose carried_in keeps the ceiling', cUndated.state, 'carried_undated')
eq('B4a read to today — the bound is honest', cUndated.readTo, TODAY)
eq('B4b not stopped', cUndated.stopped, false)
ok('B4c the why now says what would turn it into a figure', /writing that day on the row turns it into a figure/.test(cUndated.why))

const cMissing = amendmentCost(am('a-missing-3b'), store, TODAY)
eq('B5 carried_in names an absent return — still a ceiling', cMissing.state, 'carried_undated')
ok('B5a the reason names the missing register row', /no GSTR-3B is on the register/.test(cMissing.why))

const cRunning = amendmentCost(am('a-running'), store, TODAY)
eq('B6 open row with no date still runs', cRunning.state, 'running')
eq('B6a read to today', cRunning.readTo, TODAY)
ok('B6b keeps its per-day sentence', cRunning.perDay > 0)

const cReduce = amendmentCost(am('a-reduce'), store, TODAY)
eq('B7 a reduction never measures money', cReduce.state, 'reduce_takes_tax_out')
eq('B7a nothing stopped, nothing ran', cReduce.stopped, false)

// The conflict row is a stopped figure that also prints its finding.
const cConf = amendmentCost(am('a-conflict'), store, TODAY)
eq('B8 conflict row is stopped to the shop date', cConf.state, 'stopped')
eq('B8a it carries the disagreement forward', cConf.dateConflict, sConflict.conflict)

// ── totals: three kinds of money keep their own phrase (Rule 57) ───────────────
const costs = store.amendments.map(a => amendmentCost(a, store, TODAY))
const totals = amendmentCostTotals(costs)
const stoppedSum = round(costs.filter(c => c.stopped).reduce((s, c) => s + c.interest, 0))
const runningSum = round(costs.filter(c => c.state === 'running').reduce((s, c) => s + c.interest, 0))
const undatedSum = round(costs.filter(c => c.state === 'carried_undated').reduce((s, c) => s + c.interest, 0))
eq('D1 stopped rows counted (row, early, both carried, conflict)', totals.stoppedRows, 5) // a-row, a-early, a-carried-row, a-carried-filed, a-conflict
eq('D1a running rows counted', totals.runningRows, 1)
eq('D1b undated ceilings counted', totals.undatedRows, 2) // a-undated, a-missing-3b
eq('D1c reduce / not_due never counted as money', totals.quantified, 8)
eq('D2 ceiling is running + undated, never stopped', totals.ceiling, round(runningSum + undatedSum))
eq('D3a stopped money foots the five stopped figures', totals.stoppedMoney, stoppedSum)
eq('D3b the ceiling excludes stopped money entirely', totals.ceiling > 0 && totals.ceiling === runningSum + undatedSum, true)
eq('D4 per-day only accrues on the running row', totals.perDay, cRunning.perDay)
// The reasons-not-money states must each be named in `unquantified`, none silently dropped.
const unqStates = totals.unquantified.map(u => u.state)
ok('D5 the reduction is counted out with a name', unqStates.includes('reduce_takes_tax_out'))
eq('D6 stopped rows are NOT in the unquantified list', unqStates.includes('stopped'), false)

// ── D. the register never invents a date: validation is a sentence ─────────────
const base = { id: 'v1', period: '2026-03', kind: 'invoice_omitted', effect: 'add', taxable: 100000, tax: 18000, found_on: '2026-05-01', status: 'open', carried_in: '', actor: 'shop' }
const problemsFor = (patch) => validateAmendment({ ...base, ...patch }, store, TODAY)
ok('V1 a good paid date is accepted', !problemsFor({ paid_on: '2026-06-10' }).some(p => /paid/.test(p)))
ok('V2 a non-date is refused', problemsFor({ paid_on: 'not-a-day' }).some(p => /must be a date/.test(p)))
ok('V3 a future payment is refused', problemsFor({ paid_on: '2099-01-01' }).some(p => /has not arrived/.test(p)))
ok('V4 paid before found is refused', problemsFor({ paid_on: '2026-04-01', found_on: '2026-05-01' }).some(p => /money left before the omission/.test(p)))
ok('V5 a reduction cannot hold a payment date', problemsFor({ effect: 'reduce', tax: 9000, paid_on: '2026-06-10' }).some(p => /no day it was paid/.test(p)))
ok('V6 a row with no tax cannot stop a clock', problemsFor({ tax: 0, taxable: 0, paid_on: '2026-06-10' }).some(p => /no tax/.test(p) || /carries a value/.test(p)))

// ── the write path: a date round-trips, and clearing it is a trail line ─────────
saveFilings('org-write', parseFilings(JSON.stringify({ ...RAW, orgId: 'org-write' }), 'org-write'))
const writeStore0 = parseFilings(JSON.stringify(RAW), 'org-write')
const added = addAmendment('org-write', { id: 'a-new', period: '2026-03', kind: 'invoice_omitted', effect: 'add', doc_ref: 'INV-2026-0451', taxable: 100000, tax: 18000, found_on: '2026-05-01', status: 'open', carried_in: '', paid_on: '2026-06-10', actor: 'shop' }, TODAY)
eq('W1 the row stores the day it was given', added.amendment?.paid_on, '2026-06-10')
// Editing the same id with an empty paid_on is the shop *clearing* the day — the engine must not keep the old one.
const cleared = addAmendment('org-write', { id: 'a-new', period: '2026-03', kind: 'invoice_omitted', effect: 'add', doc_ref: 'INV-2026-0451', taxable: 100000, tax: 18000, found_on: '2026-05-01', status: 'open', carried_in: '', paid_on: '', actor: 'shop' }, TODAY)
eq('W2 an empty field clears the stored date', cleared.amendment?.paid_on, '')
// A date that survives an edit where the field was never shown must be preserved, not blanked.
const carriedIn = addAmendment('org-write', { id: 'a-new', period: '2026-03', kind: 'invoice_omitted', effect: 'add', doc_ref: 'INV-2026-0451', taxable: 100000, tax: 18000, found_on: '2026-05-01', status: 'open', carried_in: '', paid_on: '2026-06-10', actor: 'shop' }, TODAY)
const kept = addAmendment('org-write', { ...carriedIn.amendment, notes: 'challan scanned' }, TODAY)
eq('W3 an edit that omits nothing keeps the date', kept.amendment?.paid_on, '2026-06-10')
void writeStore0

const gained = amendmentPaidNote({ ...am('a-row'), paid_on: '2026-06-10' }, '')
ok('T1 gaining a date is a sentence about the clock', /interest reads to that day, not to today/.test(gained))
const dropped = amendmentPaidNote({ ...am('a-row'), paid_on: '' }, '2026-06-10')
ok('T2 losing a date returns the figure to a ceiling', /upper figure again/.test(dropped))
const moved = amendmentPaidNote({ ...am('a-row'), paid_on: '2026-07-01' }, '2026-06-10')
ok('T3 a moved date names both days', /2026-06-10/.test(moved) && /2026-07-01/.test(moved))

const carriedNote = amendmentTrailNote({ ...am('a-carried-row'), paid_on: '2026-05-20' }, 'carried')
ok('T4 a carried trail line records the payment day', /holds 2026-05-20 as the day that tax was paid/.test(carriedNote))
const carriedNoDate = amendmentTrailNote({ ...am('a-carried-row'), paid_on: '' }, 'carried')
ok('T4a and does not invent one when there is none', !/the day that tax was paid/.test(carriedNoDate))

// ── the paper: CSV columns match, the ledger text is amended not crossed ───────
eq('P1 the amendments CSV gained a paid-date column', AMENDMENT_CSV_HEADERS.includes('Tax paid on'), true)
eq('P2 the cost CSV gained the stop columns', ['Tax paid on (the row)', 'Where the stop date comes from', 'Clock stopped', 'Dates that disagree'].every(h => AMENDMENT_COST_CSV_HEADERS.includes(h)), true)
const csvRow = amendmentCostCsvRows([cRow])[0]
eq('P2a cost CSV row width equals its header', csvRow.length, AMENDMENT_COST_CSV_HEADERS.length)
eq('P2b the stopped flag prints as a sentence', csvRow[AMENDMENT_COST_CSV_HEADERS.indexOf('Clock stopped')], 'Stopped on the day the tax was paid')
eq('P2c the undated row prints its own sentence', amendmentCostCsvRows([cUndated])[0][AMENDMENT_COST_CSV_HEADERS.indexOf('Clock stopped')], 'Read to today')

ok('P3 the boundary now names the stop-date priority', BOUNDARY.some(b => /The clock stops on a date the register holds/.test(b)))
ok('P3a and refuses to stop on an invented date', BOUNDARY.some(b => /never stopped on a date invented/.test(b)))
eq('P4 the old "no payment date" card title is gone', NOT_TRACKED.some(t => t.title === 'The date a correction tax actually left'), false)
ok('P4a replaced by what the portal still holds', NOT_TRACKED.some(t => t.title === 'The challan the department holds'))
const ownCite = COST_CITATIONS.filter(c => c.read === 'own')
ok('P5 the register\'s own reading was amended not deleted', ownCite.some(c => /Since R3-24 the register holds that date two ways/.test(c.text)))

// A new optional, isDate-guarded field needs no migration.
eq('M1 the store version is unchanged', FILINGS_VERSION, 1)

// ── page-source pins: the sentence and the field live where the round put them ─
const PAGE = readFileSync(join(import.meta.dirname, '..', 'src', 'app', '(app)', 'gst', 'filings', 'page.tsx'), 'utf8')
ok('G1 the page prints the stop basis beside a stopped figure', /The clock stops on \$\{formatDateIN\(cost\.readTo\)\}/.test(PAGE))
ok('G2 the page prints the disagreement as its own finding', /cost\.dateConflict &&/.test(PAGE))
ok('G3 the composer takes a payment date', /paidOn: e\.target\.value/.test(PAGE))
ok('G4 the totals sentence gates the ceiling to two unpaid kinds', /t\.runningRows > 0 && t\.undatedRows > 0/.test(PAGE))
// Rule 59/60: no hand-spelled plural introduced into the round's own additions.
ok('G5 no hand-spelled plural in the cost sentence', !/row\$\{[^}]*=== 1 \? '' : 's'\}/.test(PAGE))
// The tone the kit was told to give a stopped clock.
eq('S1 stopped is green', COST_STATE_META.stopped.tone, 'green')
eq('S2 paid-before-due is green', COST_STATE_META.stopped_before_due.tone, 'green')
ok('S3 the label says the clock stopped', /clock stopped/i.test(COST_STATE_META.stopped.label))

console.log(`\nfilings24: ${pass - failures.length}/${pass} passed`)
if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f)
  process.exitCode = 1
}
