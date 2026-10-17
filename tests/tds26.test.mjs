// R3-26 — the fee was never 271H's.
//
// R2-11's /tds statements card printed, for six rounds, "₹100 a day under 271H ... and a
// separate ₹200 a day under 285(2A)". The statute says neither: section 427 of the Income-tax
// Act, 2025 — section 234E of the 1961 Act it replaced — is ₹200 a day, capped at the tax
// deductible for the quarter; section 271H (section 461 of the 2025 Act) is a separate
// ₹10,000–₹1,00,000 penalty the officer decides, never a per-day charge; and 285(2A) does not
// exist in either Act. The compliance calendar had printed the right fee all along, so the
// tree falsified itself and no suite compared the two readers. R3-25 stopped the clock
// correctly and inherited the wrong arithmetic; this round leaves the stop rule alone and
// corrects what it measures.
//
// This suite fences five things:
//   A. one rate and one citation live in the engine, and they are 427/234E's;
//   B. the cap is the tax involved, reached at 50 days on a ₹10,000 quarter and not at 49;
//   C. a stopped quarter reads the corrected rate, and stopped still wins over capped;
//   D. the page and the compliance calendar both read the engine's constant, and
//   E. no source file carries the old ₹100, 285(2A), 271H-fee or ₹5,00,000 arithmetic.
//
// Run from the repo root with nvm's Node 24:
//   /Users/mohdnizam/.nvm/versions/node/v24.21.0/bin/node --experimental-strip-types --no-warnings \
//     --import ./tests/register.mjs ./tests/tds26.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
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
  TDS_STATEMENT_FEE_CITATION, TDS_STATEMENT_FEE_PER_DAY, TDS_STATEMENT_PENALTY_CITATION,
  TDS_STATEMENT_CSV_HEADERS, buildWorkpaper, emptyTds, setStatementFiling, setVendorSection,
  tdsStatementCsvRows,
} = await import('@/lib/tds')
const { generateEvents } = await import('@/lib/compliance')

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
// One ₹1,00,000 professional-fee bill in Q1 of 2026-27, tagged 194J_PRO at 10%: ₹10,000 of
// tax, which is also the 427 cap. Q1 falls due 31 July 2026.
const VENDOR = { id: 'v1', name: 'A & Co', pan: 'ABCDE1234F', gstin: '' }
const Q1 = {
  id: 'b1', billNumber: 'B-1', billDate: '2026-05-10', vendorId: 'v1', vendorName: 'A & Co',
  gstin: '', taxable: 100000, gst: 0, grandTotal: 100000, balanceDue: 0,
}
const BASE = setVendorSection(emptyTds(), 'v1', '194J_PRO')
const read = (state, asOf) => buildWorkpaper([Q1], [], [VENDOR], state, 2026, asOf)
const AS_OF = new Date(2026, 9, 17)   // 2026-10-17

// ── A. one rate, one citation ─────────────────────────────────────────────────
eq('A1 the fee is ₹200 a day', TDS_STATEMENT_FEE_PER_DAY, 200)
ok('A2 the fee citation names 427 and 234E',
  /427/.test(TDS_STATEMENT_FEE_CITATION) && /234E/.test(TDS_STATEMENT_FEE_CITATION))
ok('A3 it names the Act in force', /Income-tax Act, 2025/.test(TDS_STATEMENT_FEE_CITATION))
ok('A4 the penalty citation names 461 and 271H',
  /461/.test(TDS_STATEMENT_PENALTY_CITATION) && /271H/.test(TDS_STATEMENT_PENALTY_CITATION))
ok('A5 neither citation invents 285(2A)',
  !/285/.test(TDS_STATEMENT_FEE_CITATION) && !/285/.test(TDS_STATEMENT_PENALTY_CITATION))

const LIB = readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'tds.ts'), 'utf8')
ok('A6 the cap is the tax involved, with no second ceiling', /const cap = tax/.test(LIB))
ok('A7 the fee multiplies the engine constant', /Math\.min\(daysLate \* TDS_STATEMENT_FEE_PER_DAY, cap\)/.test(LIB))
ok('A8 the per-day cell also reads the constant', /perDay: late && !filedOn && !capped \? TDS_STATEMENT_FEE_PER_DAY : 0/.test(LIB))
ok('A9 the engine no longer multiplies days by 100', !/daysLate \* 100/.test(LIB))
ok('A10 the engine no longer carries the ₹5,00,000 bound', !/5_00_000/.test(LIB))

// ── B. the cap, at the day it is reached ──────────────────────────────────────
// 31 July + 49 days = 18 September 2026; 50 days = 19 September.
const d49 = read(BASE, new Date(2026, 8, 18)).statements[0]
eq('B1 49 days late', d49.daysLate, 49)
eq('B2 49 × ₹200 is ₹9,800', d49.fee, 9800)
eq('B2a still below the ₹10,000 tax', d49.capped, false)
eq('B2b the clock is still running', d49.perDay, 200)
eq('B2c and it is still a ceiling', d49.ceiling, true)

const d50 = read(BASE, new Date(2026, 8, 19)).statements[0]
eq('B3 50 days late', d50.daysLate, 50)
eq('B4 50 × ₹200 is exactly the tax', d50.fee, 10000)
eq('B4a so the cap is reached', d50.capped, true)
eq('B4b the labelled nil replaces the running clock', d50.perDay, 0)

const d51 = read(BASE, new Date(2026, 8, 20)).statements[0]
eq('B5 51 days adds nothing', d51.fee, 10000)
eq('B5a still capped', d51.capped, true)
eq('B5b the raw arithmetic would have been ₹10,200', 51 * 200, 10200)

// ── C. a stopped quarter reads the corrected rate ─────────────────────────────
const stopped = read(setStatementFiling(BASE, '2026-07-31', { filedOn: '2026-08-20', reference: 'ACK-9' }), AS_OF).statements[0]
eq('C1 20 days at ₹200 is ₹4,000', stopped.fee, 4000)
eq('C1a the day is kept', stopped.filedOn, '2026-08-20')
eq('C1b stopped is its own state', stopped.stopped, true)
eq('C1c and no day is added beyond it', stopped.perDay, 0)

const stopAtCap = read(setStatementFiling(BASE, '2026-07-31', { filedOn: '2026-09-19', reference: 'LATE-ACK' }), AS_OF).statements[0]
eq('C2 a stopped quarter at the cap is still stopped', stopAtCap.stopped, true)
eq('C2a it is also capped', stopAtCap.capped, true)
eq('C2b but it is not a ceiling', stopAtCap.ceiling, false)
eq('C2c its fee is the tax', stopAtCap.fee, 10000)
eq('C2d and it adds no day', stopAtCap.perDay, 0)

// ── D. the cap is the tax, not a second ₹5,00,000 ceiling ────────────────────
const BIG = {
  id: 'big', billNumber: 'BIG-1', billDate: '2026-05-10', vendorId: 'v1', vendorName: 'A & Co',
  gstin: '', taxable: 6000000, gst: 0, grandTotal: 6000000, balanceDue: 0,
}
const big = buildWorkpaper([BIG], [], [VENDOR], BASE, 2026, new Date(2040, 5, 1)).statements[0]
eq('D1 a ₹60,00,000 fee bill withholds ₹6,00,000', big.tax, 600000)
eq('D2 the fee stops at the tax', big.fee, 600000)
ok('D2a not at the old ₹5,00,000 bound', big.fee !== 500000)
eq('D2b capped', big.capped, true)
eq('D2c the fee equals the tax', big.fee, big.tax)

// ── E. the page and the calendar read one source ──────────────────────────────
const events = generateEvents(2026, {
  filing: 'monthly', taxAudit: false, employees: false, deductsTds: true, professionalTax: false,
})
// The calendar's `tds` category holds twelve monthly deposit rows beside the four quarterly
// statements; the statements are the ones that carry the 24Q · 26Q form.
const tdsEvents = events.filter(e => e.category === 'tds' && e.form === '24Q · 26Q')
eq('E1 the calendar emits four TDS statements', tdsEvents.length, 4)
ok('E2 each calendar row reads ₹200/day', tdsEvents.every(e => e.penalty.lateFeePerDay === TDS_STATEMENT_FEE_PER_DAY))
ok('E3 each note names 427 and 234E',
  tdsEvents.every(e => /427/.test(e.penalty.note) && /234E/.test(e.penalty.note)))
ok('E4 no note cites 285(2A)', tdsEvents.every(e => !/285/.test(e.penalty.note)))
ok('E5 the calendar still calls the forms 24Q · 26Q', tdsEvents.every(e => e.form === '24Q · 26Q'))

const COMPLIANCE = readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'compliance.ts'), 'utf8')
ok('E6 the calendar imports the engine constant and citation',
  /import \{ TDS_STATEMENT_FEE_CITATION, TDS_STATEMENT_FEE_PER_DAY \} from '@\/lib\/tds'/.test(COMPLIANCE))
ok('E7 the calendar no longer carries its own fee literal',
  !/₹200\/day under section 234E, capped at the TDS amount\./.test(COMPLIANCE))
ok('E8 the note is built from the shared citation',
  /lateFeePerDay: TDS_STATEMENT_FEE_PER_DAY/.test(COMPLIANCE) && /TDS_STATEMENT_FEE_CITATION/.test(COMPLIANCE))

// ── F. the page states the fee and refuses to accrue the penalty ──────────────
const PAGE = readFileSync(join(import.meta.dirname, '..', 'src', 'app', '(app)', 'tds', 'page.tsx'), 'utf8')
ok('F1 the page imports the rate and both citations',
  /TDS_STATEMENT_FEE_PER_DAY/.test(PAGE) && /TDS_STATEMENT_FEE_CITATION/.test(PAGE) && /TDS_STATEMENT_PENALTY_CITATION/.test(PAGE))
ok('F2 the title names the 2025 Act forms', /Form 138 \/ 140 \(24Q \/ 26Q\)/.test(PAGE))
ok('F3 the card label names the fee section', /Late fee · 427/.test(PAGE))
ok('F4 the per-day cell reads the engine constant', /money\(TDS_STATEMENT_FEE_PER_DAY\)\}, still running/.test(PAGE))
ok('F5 the footer prints the penalty range', /₹10,000 to ₹1,00,000/.test(PAGE))
ok('F6 the footer refuses to accrue a discretionary penalty',
  /not a daily charge, so this page does not accrue it/.test(PAGE))
ok('F7 the footer names Form 140 beside the familiar 26Q', /Form 140; the familiar 26Q name is kept/.test(PAGE))
ok('F8 the old ₹100/day sentence is gone', !/₹100 a day/.test(PAGE))
ok('F9 the old ₹100 per-day cell is gone', !/₹100, still running/.test(PAGE))
ok('F10 the invented section is gone from the page', !/285\(2A\)/.test(PAGE))
ok('F11 the old 271H fee label is gone', !/271H fee/.test(PAGE))
ok('F12 the R3-25 boundary sentence survives', /a transcript, not proof/.test(PAGE))
ok('F13 the capped footline survives', /another late day adds nothing/.test(PAGE))
ok('F14 the ceiling total survives', /of that fee is a ceiling/.test(PAGE))
ok('F15 the on-time sentence survives', /on or before the due date — nothing is at stake/.test(PAGE))

// ── G. the paper still says which basis it used ───────────────────────────────
const basis = (rows, i) => rows[i][TDS_STATEMENT_CSV_HEADERS.indexOf('Fee basis')]
eq('G1 the sheet is still eleven columns', TDS_STATEMENT_CSV_HEADERS.length, 11)
eq('G2 a stopped row names its day', basis(tdsStatementCsvRows(read(setStatementFiling(BASE, '2026-07-31', { filedOn: '2026-08-20', reference: 'ACK-9' }), AS_OF)), 0), 'measured to the day this register holds')
eq('G3 a capped row says so', basis(tdsStatementCsvRows(read(BASE, new Date(2026, 8, 19))), 0), 'ceiling — no filing day, at the cap')
eq('G4 a growing ceiling says so',
  basis(tdsStatementCsvRows(read(BASE, new Date(2026, 8, 18))), 0), 'ceiling — no filing day, read to today')

// ── H. the tree-wide citation census ──────────────────────────────────────────
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}
const SRC = walk(join(import.meta.dirname, '..', 'src'))
ok('H0 the census sees the whole source tree', SRC.length > 100, `saw ${SRC.length} files`)

function filesMatching(re) {
  return SRC.filter(f => re.test(readFileSync(f, 'utf8')))
}
eq('H1 no source file cites 285(2A)', filesMatching(/285\(2A\)/).length, 0)
eq('H2 no source file prints ₹100 a day', filesMatching(/₹100 a day/).length, 0)
eq('H3 no source file labels a 271H fee', filesMatching(/271H fee/).length, 0)
// `\b` before the 5 is what separates the invented bound from the legitimate 75,00,000 and
// 25,00,000 literals in gstr4.ts: `_` is a word character, so a 5 inside a larger digit run has
// no boundary in front of it.
eq('H4 no source file caps at ₹5,00,000', filesMatching(/\b5_00_000\b/).length, 0)
eq('H5 no source file multiplies late days by 100', filesMatching(/daysLate \* 100/).length, 0)

console.log(`\ntds26: ${pass - failures.length}/${pass} passed`)
if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f)
  process.exitCode = 1
}
