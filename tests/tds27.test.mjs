// R3-27 — the composer's first live run.
//
// R3-25 built the 26Q statement composer and R3-26 corrected the fee's law, but neither round
// had typed a filing into the page. The first signed-in run found a class of defect no assertion
// had looked at: the transcript and the fee clock were read from one flag.
//
// The engine set `late = tax > 0 && due < stop`, so a quarter with no tax withheld had no days
// late at all. Filed on 15 August against a 31 July due date, the card printed "Filed on time",
// a green border and "on or before the due date" — all three false. The fee is still nil, because
// section 427 charges a share of tax and there is no tax to charge; but the filing day is a
// transcript, and 15 August is after 31 July whatever the tax.
//
// The same run found four page defects beside it: the saved line was session-only, so a reload
// said "Nothing saved yet" beside "1 of 4 quarters have a filing day"; the verb disagreed with the
// count; the date input had a max but no min; and a refused draft beside a stored filing left the
// reader with two dates and no sentence saying which one the register held.
//
// This suite fences:
//   A. a nil quarter's held filing day is counted as late, and its fee is still a labelled nil;
//   B. a nil quarter with no filing day still has no clock and no lateness;
//   C. a taxed quarter is unchanged (the R3-25/R3-26 readings survive);
//   D. the statement sheet prints the day and names why the fee is nil;
//   E. the page carries the repaired sentences and the input's lower bound.
//
// Run from the repo root with nvm's Node 24:
//   /Users/mohdnizam/.nvm/versions/node/v24.21.0/bin/node --experimental-strip-types --no-warnings \
//     --import ./tests/register.mjs ./tests/tds27.test.mjs

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
  buildWorkpaper, emptyTds, setStatementFiling, setVendorSection, tdsStatementCsvRows,
} = await import('@/lib/tds')

let pass = 0
const failures = []
function ok(name, cond, detail = '') {
  pass += 1
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}
const basis = (rows, i) => rows[i][8]

// ── the fixtures ───────────────────────────────────────────────────────────────
// The live shop's shape: bills and payments exist, but no supplier is tagged, so every quarter
// withholds ₹0. Q1 of 2026-27 falls due 31 July 2026.
const AS_OF = new Date(2026, 9, 17)   // 2026-10-17
const NIL = emptyTds()
const nilRead = (state, asOf = AS_OF) => buildWorkpaper([], [], [], state, 2026, asOf)

// The R3-25/R3-26 fixture: one ₹1,00,000 professional-fee bill, tagged 194J_PRO at 10%, so Q1
// withholds ₹10,000 — enough to keep a fee clock running.
const VENDOR = { id: 'v1', name: 'A & Co', pan: 'ABCDE1234F', gstin: '' }
const BILL = {
  id: 'b1', billNumber: 'B-1', billDate: '2026-05-10', vendorId: 'v1', vendorName: 'A & Co',
  gstin: '', taxable: 100000, gst: 0, grandTotal: 100000, balanceDue: 0,
}
const TAXED = setVendorSection(emptyTds(), 'v1', '194J_PRO')
const taxedRead = (state, asOf = AS_OF) => buildWorkpaper([BILL], [], [VENDOR], state, 2026, asOf)

// ── A. a nil quarter's filing day is a transcript ──────────────────────────────
const nilLateWp = nilRead(setStatementFiling(NIL, '2026-07-31', { filedOn: '2026-08-15', reference: 'ACK-RACE' }))
const nilLate = nilLateWp.statements[0]
eq('A1 the filing day is held', nilLate.filedOn, '2026-08-15')
eq('A2 31 July → 15 August is 15 days', nilLate.daysLate, 15)
eq('A3 no tax was withheld', nilLate.tax, 0)
eq('A4 so the fee is nil', nilLate.fee, 0)
eq('A5 the fee clock never ran, so it is not stopped', nilLate.stopped, false)
eq('A6 and no ceiling is claimed', nilLate.ceiling, false)
eq('A7 nothing is capped', nilLate.capped, false)
eq('A8 no per-day charge is invented', nilLate.perDay, 0)
eq('A9 the year total is still nil', nilLateWp.totals.statementFee, 0)

// The day the quarter closed is the earliest day a statement can describe; filing then is not late.
const duringClose = nilRead(setStatementFiling(NIL, '2026-07-31', { filedOn: '2026-06-30', reference: '' })).statements[0]
eq('A10 filing on the quarter\'s last day is not late', duringClose.daysLate, 0)
eq('A11 and it is held as the filing day', duringClose.filedOn, '2026-06-30')

// Filed on the due date itself: stopped in the plain sense, but late by zero days.
const onDue = nilRead(setStatementFiling(NIL, '2026-07-31', { filedOn: '2026-07-31', reference: '' })).statements[0]
eq('A12 filing on the due date is 0 days late', onDue.daysLate, 0)
eq('A13 and it reads as filed on time', onDue.filedOn, '2026-07-31')

// The day after the due date is already a day late, in a nil quarter as in any other.
const dayAfter = nilRead(setStatementFiling(NIL, '2026-07-31', { filedOn: '2026-08-01', reference: '' })).statements[0]
eq('A14 1 August is 1 day late', dayAfter.daysLate, 1)
eq('A15 and the fee is still nil', dayAfter.fee, 0)

// ── B. a nil quarter with no filing day has no clock ──────────────────────────
const nilOpen = nilRead(NIL).statements[0]
eq('B1 no filing day, no days late', nilOpen.daysLate, 0)
eq('B2 no fee', nilOpen.fee, 0)
eq('B3 no ceiling', nilOpen.ceiling, false)
eq('B4 no stop', nilOpen.stopped, false)
eq('B5 no per-day charge', nilOpen.perDay, 0)

// ── C. the taxed quarter is unchanged ─────────────────────────────────────────
const taxedStopped = taxedRead(setStatementFiling(TAXED, '2026-07-31', { filedOn: '2026-08-20', reference: 'ACK-9' })).statements[0]
eq('C1 31 July → 20 August is 20 days', taxedStopped.daysLate, 20)
eq('C2 20 × ₹200 is ₹4,000', taxedStopped.fee, 4000)
eq('C3 the clock stopped on the held day', taxedStopped.stopped, true)
eq('C4 and no further day is added', taxedStopped.perDay, 0)

const taxedRunning = taxedRead(TAXED).statements[0]
eq('C5 an undated taxed quarter still reads to today', taxedRunning.daysLate, 78)
eq('C6 its fee is a ceiling', taxedRunning.ceiling, true)
eq('C7 78 days is past the 50-day cap on ₹10,000', taxedRunning.capped, true)
eq('C8 so the per-day charge is the labelled nil', taxedRunning.perDay, 0)

// A filed-on-time taxed quarter is not late by either reading.
const taxedOnTime = taxedRead(setStatementFiling(TAXED, '2026-07-31', { filedOn: '2026-07-20', reference: '' })).statements[0]
eq('C9 a taxed quarter filed before the due date is 0 days late', taxedOnTime.daysLate, 0)
eq('C10 its fee is nil', taxedOnTime.fee, 0)
eq('C11 and no clock is called stopped', taxedOnTime.stopped, false)

// ── D. the statement sheet names the nil fee's reason ─────────────────────────
const nilRows = tdsStatementCsvRows(nilLateWp)
eq('D1 the sheet prints the 15 late days', nilRows[0][6], 15)
eq('D2 the fee column is 0', nilRows[0][7], 0)
eq('D3 and the basis says why', basis(nilRows, 0), 'filed after the due date — nothing was withheld')

const nilOpenRows = tdsStatementCsvRows(nilRead(NIL))
eq('D4 an undated nil quarter still says nothing is at stake', basis(nilOpenRows, 0), 'nothing at stake')
const nilOnTimeRows = tdsStatementCsvRows(nilRead(setStatementFiling(NIL, '2026-07-31', { filedOn: '2026-07-31', reference: '' })))
eq('D5 a nil quarter filed on the due date has no late basis', basis(nilOnTimeRows, 0), 'nothing at stake')

const taxedRows = tdsStatementCsvRows(taxedRead(setStatementFiling(TAXED, '2026-07-31', { filedOn: '2026-08-20', reference: '' })))
eq('D6 the taxed stop keeps its carried basis', basis(taxedRows, 0), 'measured to the day this register holds')
eq('D7 and its days', taxedRows[0][6], 20)

// ── E. the page's repaired sentences ─────────────────────────────────────────
const PAGE = readFileSync(join(import.meta.dirname, '..', 'src', 'app', '(app)', 'tds', 'page.tsx'), 'utf8')

ok('E1 the card distinguishes a late filing from an on-time one',
  /const filedLate = Boolean\(q\.filedOn\) && q\.daysLate > 0/.test(PAGE))
ok('E2 a late nil filing gets its own badge', PAGE.includes("Filed late — fee nil"))
ok('E3 it no longer falls through to the green filing border',
  /q\.ceiling \? 'is-ceiling' : filedLate \? 'is-late' : q\.filedOn \? 'is-filed'/.test(PAGE))
ok('E4 its footline prints the day, the days and the nil', PAGE.includes('Nothing was withheld, so the fee reads nil.'))
ok('E5 the on-time sentence still exists for the on-time case',
  PAGE.includes('on or before the due date — nothing is at stake.'))

ok('E6 the count no longer disagrees with its verb', PAGE.includes('quarters with a filing day'))
ok('E7 the count line survives both tabs', (PAGE.match(/savedLine \|\| 'Nothing saved yet'/g) || []).length === 2)
ok('E8 the saved line is read from the loaded register',
  (PAGE.match(/setSavedLine\(savedLineFor\(loaded\.updatedAt\)\)/g) || []).length === 2)
ok('E9 and from every write', PAGE.includes('setSavedLine(savedLineFor(stamped.updatedAt))'))
ok('E10 a write from another day carries that day',
  /Saved on this device on \$\{d\.toLocaleDateString/.test(PAGE))

ok('E11 the date input has a lower bound at the quarter close', PAGE.includes('min={q.periodTo}'))
ok('E12 a refused draft beside a stored filing says which day is held',
  PAGE.includes('The register still holds {formatDateIN(q.filedOn)}; the day above was not saved.'))
ok('E13 a year change drops the old quarter\'s refusals', PAGE.includes('setStmtProblems({})'))

console.log(`\ntds27: ${pass}/${pass} passed`)
if (failures.length) {
  console.error(`\n${failures.length} failure(s):`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
