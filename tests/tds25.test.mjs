// R3-25 — the statement clock stops on the day the shop says it filed.
//
// R2-11's 26Q card printed its own limitation: "Statements are filed on the income-tax portal, so this
// page cannot see whether you filed one." The fee under section 271H therefore always read to today —
// a ceiling, even for a quarter filed a year ago. R3-21's shape (a limitation a card prints about itself
// is a task) and R3-24's grammar (a clock stops on a date the register holds, or it does not) are applied
// whole to a second register under a second statute: a quarter can now carry the shop's own filing day
// and acknowledgement, the days and fee stop there, and a quarter still undated keeps reading to today
// with its fee labelled a ceiling. What is new beyond R3-24 is the cap: once the fee reaches the tax
// involved (or ₹5,00,000) another late day adds nothing, and that is a third state, not a running clock.
//
// This suite fences the six things that must not silently regress:
//   A. the reading to today is unchanged for a register written before this round (same fee, same ceiling),
//   B. a held day stops the clock and a day before the quarter closed or after today never does,
//   C. the ceiling is labelled, the stopped figure is not, and the cap is its own labelled state,
//   D. totals split a ceiling from a figure — a closed liability is not a risk (Rule 27/Rule 61),
//   E. the write path trims, clears whole, and refuses through sentences, and
//   F. the page prints each state in its own words, and the statement CSV says which basis it used.
//
// Run from the repo root with nvm's Node 24 (PATH node is Homebrew v20 and refuses
// --experimental-strip-types):
//   /Users/mohdnizam/.nvm/versions/node/v24.21.0/bin/node --experimental-strip-types --no-warnings \
//     --import ./tests/register.mjs ./tests/tds25.test.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// loadTds/saveTds read `localStorage` directly in the lib; the pages reach it through window.
const lsBacking = new Map()
const store = {
  getItem: (k) => (lsBacking.has(k) ? lsBacking.get(k) : null),
  setItem: (k, v) => { lsBacking.set(k, String(v)) },
  removeItem: (k) => { lsBacking.delete(k) },
}
globalThis.localStorage = store
globalThis.window = { localStorage: store }

const {
  TDS_VERSION, TDS_STATEMENT_CSV_HEADERS, buildWorkpaper, emptyTds, loadTds,
  setStatementFiling, setVendorSection, tdsStatementCsvRows, validateStatementFiling,
} = await import('@/lib/tds')

const AS_OF = new Date(2026, 9, 17)          // '2026-10-17' — Q1 is late, Q2 falls due in a fortnight
const AS_OF_MIXED = new Date(2026, 11, 15)   // '2026-12-15' — Q1 and Q2 both past their due date
const AS_OF_2030 = new Date(2030, 5, 1)      // '2030-06-01' — every quarter is at the tax cap
const AS_OF_2040 = new Date(2040, 5, 1)      // '2040-06-01' — ₹100/day crosses even the ₹5,00,000 ceiling

/** An independent day count from UTC midnights, so the engine's local-midnight count is checked. */
function dayCount(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000)
}

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
// One professional-fee supplier tagged 194J_PRO (10%, whole once ₹50,000 is crossed), one ₹1,00,000 bill
// in each quarter of 2026-27. Each quarter therefore holds ₹10,000 of tax, which is also the 271H cap.
const VENDOR = { id: 'v1', name: 'A & Co', pan: 'ABCDE1234F', gstin: '' }
const bill = (id, billNumber, billDate) => ({
  id, billNumber, billDate, vendorId: 'v1', vendorName: 'A & Co', gstin: '',
  taxable: 100000, gst: 0, grandTotal: 100000, balanceDue: 0,
})
const BILLS = [
  bill('b1', 'B-1', '2026-05-10'),   // Q1 Apr–Jun, due 2026-07-31
  bill('b2', 'B-2', '2026-08-12'),   // Q2 Jul–Sep, due 2026-10-31
  bill('b3', 'B-3', '2026-11-05'),   // Q3 Oct–Dec, due 2027-01-31
  bill('b4', 'B-4', '2027-02-10'),   // Q4 Jan–Mar, due 2027-05-31
]
const BASE = setVendorSection(emptyTds(), 'v1', '194J_PRO')
const read = (state, asOf = AS_OF) => buildWorkpaper(BILLS, [], [VENDOR], state, 2026, asOf)

// ── A. unchanged for a register with no filing days ───────────────────────────
const wp = read(BASE)
eq('A0 four quarters are always read', wp.statements.length, 4)
eq('A0a each quarter holds its own ₹10,000', wp.statements.map(q => q.tax).join(), '10000,10000,10000,10000')
eq('A1 Q1 due 31 July 2026', wp.statements[0].due, '2026-07-31')
eq('A1a Q1 period closes 30 June 2026', wp.statements[0].periodTo, '2026-06-30')
eq('A2 the late days are due→today', wp.statements[0].daysLate, dayCount('2026-07-31', '2026-10-17'))
eq('A2a that is 78 days', wp.statements[0].daysLate, 78)
eq('A3 the fee is ₹100 a day', wp.statements[0].fee, 78 * 100)
eq('A3a no filing day — the fee is a ceiling', wp.statements[0].ceiling, true)
eq('A3b and it is not called stopped', wp.statements[0].stopped, false)
eq('A3c nor capped', wp.statements[0].capped, false)
eq('A3d the per-day clock still runs', wp.statements[0].perDay, 100)
eq('A3e no day is invented for it', wp.statements[0].filedOn, '')
eq('A4 Q2 has not fallen due yet', wp.statements[1].due, '2026-10-31')
eq('A4a nothing has run', wp.statements[1].fee, 0)
eq('A4b and it is not a ceiling', wp.statements[1].ceiling, false)
eq('A5 Q3 is due in the calendar year after it opened', wp.statements[2].due, '2027-01-31')
eq('A5a Q4 likewise', wp.statements[3].due, '2027-05-31')
eq('A6 the year totals the one late quarter', wp.totals.statementFee, 7800)
eq('A6a all of it is a ceiling', wp.totals.statementFeeCeiling, 7800)
eq('A6b nothing is stopped money', wp.totals.statementFee - wp.totals.statementFeeCeiling, 0)

// ── B. a held day stops the clock ──────────────────────────────────────────────
const stopped = setStatementFiling(BASE, '2026-07-31', { filedOn: '2026-08-20', reference: 'ACK-9' })
eq('B0 the original state is untouched', BASE.statementFilings['2026-07-31'], undefined)
const wpStop = read(stopped)
const q1s = wpStop.statements[0]
eq('B1 the day the register holds travels with the quarter', q1s.filedOn, '2026-08-20')
eq('B1a the acknowledgement travels beside it', q1s.reference, 'ACK-9')
eq('B2 days run due→filed, not due→today', q1s.daysLate, dayCount('2026-07-31', '2026-08-20'))
eq('B2a that is 20 days', q1s.daysLate, 20)
eq('B3 the fee stops at the held day', q1s.fee, 20 * 100)
eq('B3a recomputed independently against the tax cap', q1s.fee, Math.min(dayCount('2026-07-31', '2026-08-20') * 100, 10000))
eq('B3b stopped is its own state', q1s.stopped, true)
eq('B3c it is no longer a ceiling', q1s.ceiling, false)
eq('B3d and no day is added beyond it', q1s.perDay, 0)
eq('B4 the other quarters are untouched by one filing', wpStop.statements[1].fee, 0)
eq('B4a and carry no day', wpStop.statements[1].filedOn, '')
eq('B5 the year carries only the stopped figure', wpStop.totals.statementFee, 2000)
eq('B5a with no ceiling left in it', wpStop.totals.statementFeeCeiling, 0)

// Filed on the due date is on time; filed before it (but after the quarter closed) is also on time.
const onDue = read(setStatementFiling(BASE, '2026-07-31', { filedOn: '2026-07-31', reference: '' }))
eq('B6 filed on the due date — nothing is late', onDue.statements[0].daysLate, 0)
eq('B6a the fee is a nil reading, not a blank', onDue.statements[0].fee, 0)
eq('B6b stopped stays false because nothing ran', onDue.statements[0].stopped, false)
eq('B6c no ceiling either', onDue.statements[0].ceiling, false)
eq('B6d but the day is kept', onDue.statements[0].filedOn, '2026-07-31')
const beforeDue = read(setStatementFiling(BASE, '2026-07-31', { filedOn: '2026-07-15', reference: 'EARLY' }))
eq('B7 filed inside the quarter but after it closed', beforeDue.statements[0].daysLate, 0)
eq('B7a the day is kept', beforeDue.statements[0].filedOn, '2026-07-15')

// A hand-edited store can hold days the composer refuses. Both fall back to reading to today.
const future = read(setStatementFiling(BASE, '2026-07-31', { filedOn: '2026-11-01', reference: 'TOMORROW' }))
eq('B8 a filing day after today cannot stop a clock', future.statements[0].filedOn, '')
eq('B8a the quarter keeps its ceiling', future.statements[0].ceiling, true)
eq('B8b read to today', future.statements[0].daysLate, 78)
const prePeriod = read(setStatementFiling(BASE, '2026-07-31', { filedOn: '2026-05-01', reference: 'TOO SOON' }), AS_OF_MIXED)
eq('B9 a day before the quarter closed cannot stop one either', prePeriod.statements[0].filedOn, '')
eq('B9a measured to the reading day', prePeriod.statements[0].daysLate, dayCount('2026-07-31', '2026-12-15'))

// ── C. the ceiling, and the cap as a third state ───────────────────────────────
const mixed = setStatementFiling(BASE, '2026-07-31', { filedOn: '2026-08-20', reference: 'ACK-9' })
const wpMixed = read(mixed, AS_OF_MIXED)
eq('C0 Q1 is stopped', wpMixed.statements[0].stopped, true)
eq('C0a Q2 is still a ceiling', wpMixed.statements[1].ceiling, true)
eq('C0b Q2 days are due→today', wpMixed.statements[1].daysLate, dayCount('2026-10-31', '2026-12-15'))
eq('C0c that is 45 days', wpMixed.statements[1].daysLate, 45)
eq('C1 Q1 money is a figure', wpMixed.statements[0].fee, 2000)
eq('C1a Q2 money is a ceiling', wpMixed.statements[1].fee, 4500)
eq('C2 totals keep the two kinds apart', wpMixed.totals.statementFee, 6500)
eq('C2a the ceiling is only the undated quarter', wpMixed.totals.statementFeeCeiling, 4500)
eq('C2b the closed liability is what is left after the ceiling', wpMixed.totals.statementFee - wpMixed.totals.statementFeeCeiling, 2000)

// Once the fee reaches the tax involved, another late day adds nothing — a bounded ceiling.
const wpLate = read(BASE, AS_OF_2030)
eq('C3 four years late is at the tax cap', wpLate.statements[0].fee, 10000)
eq('C3a that is exactly the quarter\'s tax', wpLate.statements[0].fee, wpLate.statements[0].tax)
eq('C3b capped is its own state', wpLate.statements[0].capped, true)
eq('C3c the per-day clock is a labelled nil at the cap', wpLate.statements[0].perDay, 0)
eq('C3d it is still a ceiling, not a figure', wpLate.statements[0].ceiling, true)
eq('C3e all four quarters are at the cap', wpLate.statements.filter(q => q.capped).length, 4)
eq('C3f the year cannot claim more than the tax withheld', wpLate.totals.statementFeeCeiling, 40000)

// The ₹5,00,000 ceiling binds before the tax does on a large quarter.
const bigBill = { ...bill('big', 'BIG-1', '2026-05-10'), taxable: 6000000, grandTotal: 6000000 }
const wpBig = buildWorkpaper([bigBill], [], [VENDOR], BASE, 2026, AS_OF_2040)
eq('C4 a ₹60,00,000 fee bill withholds ₹6,00,000', wpBig.statements[0].tax, 600000)
eq('C4a the fee stops at the statutory ceiling', wpBig.statements[0].fee, 500000)
eq('C4b capped, not running', wpBig.statements[0].capped, true)
eq('C4c and no further day is added', wpBig.statements[0].perDay, 0)

// A stopped quarter that is also at the cap is a figure; stopped wins over capped in what it calls itself.
const stopAtCap = read(setStatementFiling(BASE, '2026-07-31', { filedOn: '2030-06-01', reference: 'LATE-ACK' }), AS_OF_2030)
eq('C5 a stopped quarter at the cap is still stopped', stopAtCap.statements[0].stopped, true)
eq('C5a it is not a ceiling', stopAtCap.statements[0].ceiling, false)
eq('C5b it is capped too', stopAtCap.statements[0].capped, true)
eq('C5c its fee is the tax', stopAtCap.statements[0].fee, 10000)
eq('C5d and it adds no day', stopAtCap.statements[0].perDay, 0)
eq('C5e the other three quarters remain the year\'s ceiling', stopAtCap.totals.statementFeeCeiling, 30000)

// ── D. the empty and the dating-free year ──────────────────────────────────────
const wpEmpty = buildWorkpaper([], [], [], emptyTds(), 2026, AS_OF)
eq('D1 the four dates exist even with no bills', wpEmpty.statements.length, 4)
eq('D1a every fee is nil', wpEmpty.statements.reduce((s, q) => s + q.fee, 0), 0)
eq('D1b no ceiling is claimed', wpEmpty.totals.statementFeeCeiling, 0)
ok('D1c nothing was withheld is not called late', wpEmpty.statements.every(q => q.daysLate === 0 && !q.ceiling && !q.stopped))

// ── E. the read guard and the pre-round store ─────────────────────────────────
const RAW = {
  version: 1,
  updatedAt: '2026-10-01T00:00:00.000Z',
  payerType: 'business',
  vendorSection: { v1: '194J_PRO' },
  billSection: {},
  challans: {},
  statementFilings: {
    '2026-07-31': { filedOn: '2026-08-20', reference: 'ACK-9' },
    '2026-10-31': { filedOn: '2026-08-01' },                       // before Q2 closed — kept, not read
    '2027-01-31': { filedOn: 'not-a-day' },                        // dropped by the parse
    '2027-05-31': { filedOn: '2026-11-01', reference: 'EARLY' },    // future to AS_OF — kept, not read
  },
}
lsBacking.set('taxflow:tds:org-test', JSON.stringify(RAW))
const loaded = loadTds('org-test')
eq('E1 a non-date is not a filing row', '2027-01-31' in loaded.statementFilings, false)
eq('E1a the three dates that parse are kept', Object.keys(loaded.statementFilings).length, 3)
eq('E1b the acknowledgement survives a round trip', loaded.statementFilings['2026-07-31'].reference, 'ACK-9')
eq('E2 the store version is unchanged', TDS_VERSION, 1)
eq('E2a and load reports it', loaded.version, 1)
const wpNow = buildWorkpaper(BILLS, [], [VENDOR], loaded, 2026, AS_OF)
eq('E3 the held day stops Q1 after a reload', wpNow.statements[0].fee, 2000)
eq('E3a so the year has a figure and no Q1 ceiling', wpNow.totals.statementFeeCeiling, 0)
eq('E4 a future day in the store is not read', wpNow.statements[3].filedOn, '')
const wpDec = buildWorkpaper(BILLS, [], [VENDOR], loaded, 2026, AS_OF_MIXED)
eq('E5 a day before the quarter closed is not read', wpDec.statements[1].filedOn, '')
eq('E5a Q2 keeps reading to the reading day', wpDec.statements[1].daysLate, 45)
eq('E6 the day stored for Q4 predates the quarter and is not printed as a filing', wpDec.statements[3].filedOn, '')
eq('E6a so Q4 is not credited with an on-time statement', wpDec.statements[3].stopped, false)

// A register written the round before has no statementFilings key at all.
const legacy = { version: 1, updatedAt: '', payerType: 'business', vendorSection: { v1: '194J_PRO' }, billSection: {}, challans: {} }
lsBacking.set('taxflow:tds:org-legacy', JSON.stringify(legacy))
const old = loadTds('org-legacy')
eq('E7 a pre-round register loads with no filing days', Object.keys(old.statementFilings).length, 0)
eq('E8 and the fee reads exactly as the round before', buildWorkpaper(BILLS, [], [VENDOR], old, 2026, AS_OF).totals.statementFee, 7800)
lsBacking.set('taxflow:tds:org-broken', '{not json')
const broken = loadTds('org-broken')
eq('E9 a damaged file loads empty, not throwing', Object.keys(broken.statementFilings).length, 0)

// ── F. the write path and the sentences that refuse a day ─────────────────────
const s1 = setStatementFiling(BASE, '2026-07-31', { filedOn: '2026-08-20', reference: '  ACK-9  ' })
eq('F1 the acknowledgement is trimmed', s1.statementFilings['2026-07-31'].reference, 'ACK-9')
const s2 = setStatementFiling(s1, '2026-10-31', { filedOn: '2026-10-31', reference: '' })
eq('F2 setting a second quarter keeps the first', s2.statementFilings['2026-07-31'].filedOn, '2026-08-20')
eq('F2a and adds the second', s2.statementFilings['2026-10-31'].filedOn, '2026-10-31')
eq('F3 null clears the row whole', '2026-07-31' in setStatementFiling(s2, '2026-07-31', null).statementFilings, false)
eq('F3a an empty day clears it too', '2026-07-31' in setStatementFiling(s2, '2026-07-31', { filedOn: '', reference: 'X' }).statementFilings, false)
eq('F3b a non-date clears rather than stores a guess', '2026-07-31' in setStatementFiling(s2, '2026-07-31', { filedOn: 'soon', reference: 'X' }).statementFilings, false)
eq('F3c and clearing one leaves the other', setStatementFiling(s2, '2026-07-31', null).statementFilings['2026-10-31'].filedOn, '2026-10-31')

const noProblems = (filedOn, periodTo = '2026-06-30', today = '2026-10-17') => validateStatementFiling(periodTo, filedOn, today)
eq('V1 no day is not a problem — the quarter simply keeps running', noProblems('').length, 0)
ok('V2 a non-date is a sentence', noProblems('soon').some(p => /must be a date/.test(p)))
ok('V3 a future day is refused with its day named', noProblems('2026-11-01').some(p => /that day has not come yet/.test(p)))
ok('V4 a day before the quarter closed is refused', noProblems('2026-05-01').some(p => /days that had not happened/.test(p)))
eq('V5 the day the quarter closes is allowed', noProblems('2026-06-30').length, 0)
eq('V6 the day after it closes is allowed', noProblems('2026-07-01').length, 0)
eq('V7 a day inside the window is allowed', noProblems('2026-08-20').length, 0)

// ── G. the paper: one basis sentence per state ────────────────────────────────
eq('G1 the statement CSV prints eleven columns', TDS_STATEMENT_CSV_HEADERS.length, 11)
ok('G1a including the day and its acknowledgement', ['Filed on', 'Acknowledgement', 'Fee basis'].every(h => TDS_STATEMENT_CSV_HEADERS.includes(h)))
const csv = tdsStatementCsvRows(wpStop)
eq('G2 one row per quarter', csv.length, 4)
ok('G2a every row matches its header width', csv.every(r => r.length === TDS_STATEMENT_CSV_HEADERS.length))
const basis = (rows, i) => rows[i][TDS_STATEMENT_CSV_HEADERS.indexOf('Fee basis')]
eq('G3 a stopped row says which day it is measured to', basis(csv, 0), 'measured to the day this register holds')
eq('G3a and prints that day', csv[0][TDS_STATEMENT_CSV_HEADERS.indexOf('Filed on')], '2026-08-20')
eq('G3b and the acknowledgement', csv[0][TDS_STATEMENT_CSV_HEADERS.indexOf('Acknowledgement')], 'ACK-9')
eq('G4 a ceiling row says it is read to today', basis(tdsStatementCsvRows(wp), 0), 'ceiling — no filing day, read to today')
eq('G4a with no day invented', tdsStatementCsvRows(wp)[0][TDS_STATEMENT_CSV_HEADERS.indexOf('Filed on')], '')
eq('G5 a capped ceiling says so', basis(tdsStatementCsvRows(wpLate), 0), 'ceiling — no filing day, at the cap')
eq('G6 a quarter with nothing at stake says that', basis(tdsStatementCsvRows(wp), 1), 'nothing at stake')
eq('G6a and a quarter filed on time says nothing is at stake', basis(tdsStatementCsvRows(onDue), 0), 'nothing at stake')
eq('G6b while still printing the held day', tdsStatementCsvRows(onDue)[0][TDS_STATEMENT_CSV_HEADERS.indexOf('Filed on')], '2026-07-31')

// ── H. the page and the engine keep the round's sentences ─────────────────────
const PAGE = readFileSync(join(import.meta.dirname, '..', 'src', 'app', '(app)', 'tds', 'page.tsx'), 'utf8')
const LIB = readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'tds.ts'), 'utf8')
ok('H1 the page takes the statement filing writer and reader from the engine', /setStatementFiling,/.test(PAGE) && /validateStatementFiling,/.test(PAGE))
ok('H2 the composer validates against the quarter and the reading day', /validateStatementFiling\(q\.periodTo, filing\.filedOn, todayISO\)/.test(PAGE))
ok('H3 a refused day is shown as its sentence', /stmtProblems\[q\.due\]\.map/.test(PAGE))
ok('H4 the stopped sentence names the held day', /The register holds \$\{formatDateIN\(q\.filedOn\)\}/.test(PAGE))
ok('H5 the on-time sentence does not claim a fee', /on or before the due date — nothing is at stake/.test(PAGE))
ok('H6 the ceiling sentence says the clock still runs', /and it keeps growing/.test(PAGE))
ok('H7 the capped sentence refuses to call it growing', /another late day adds nothing/.test(PAGE))
ok('H8 the per-day cell keeps a labelled nil for both stopped and capped', /₹0, stopped/.test(PAGE) && /₹0, at the cap/.test(PAGE))
ok('H9 the year total names the ceiling', /of that fee is a ceiling/.test(PAGE))
ok('H10 the KPI sub-line reads the ceiling instead of the whole fee story', /statementFeeCeiling > 0/.test(PAGE))
ok('H11 the statement sheet has its own export', /exportStatements/.test(PAGE) && /Statement sheet CSV/.test(PAGE))
ok('H12 the acknowledgement is held until a day exists', /a reference alone does not stop the clock/.test(PAGE))
ok('H13 the old "cannot see whether you filed" sentence is gone', !/cannot see whether you filed one/.test(PAGE))
ok('H14 the old table constants are gone', !/STMT_COLS|STMT_GRID/.test(PAGE))
ok('H15 no hand-spelled plural was added in the round\'s sentences', !/day\$\{[^}]*=== 1 \? '' : 's'\}/.test(PAGE))
ok('H16 the engine guards the pre-period day as well as the future one', /filing\.filedOn <= ymd\(asOf\) && filing\.filedOn >= periodTo/.test(LIB))
ok('H17 per-day is nil once stopped or capped', /perDay: late && !filedOn && !capped \? 100 : 0/.test(LIB))
ok('H18 the cap is min(tax, 5,00,000)', /const cap = Math\.min\(tax, 5_00_000\)/.test(LIB))

console.log(`\ntds25: ${pass - failures.length}/${pass} passed`)
if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f)
  process.exitCode = 1
}
