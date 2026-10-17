// R3-20 — the signed-in drive's six repairs.
//
// This round added no engine, no register, no route, no glyph. It read six sentences that the eye
// contradicted — a printed count that disagrees with the figure beside it, or a claim a later round
// made false — and repaired the *page*, never the arithmetic. The suite is the fence in both
// directions: it pins each new sentence, and it pins the engine line the sentence was wrong about,
// so a future round cannot "fix" the finding by moving the number.
//
// Run from the repo root with nvm's Node 24 (PATH node is Homebrew v20 and refuses
// --experimental-strip-types):
//   /Users/mohdnizam/.nvm/versions/node/v24.21.0/bin/node --experimental-strip-types --no-warnings \
//     --import ./tests/register.mjs ./tests/drive20.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REGISTERS } from '@/lib/vault'

const ROOT = join(import.meta.dirname, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

const RECIPES = 'src/app/(app)/inventory/recipes/page.tsx'
const JOURNAL = 'src/app/(app)/journal/page.tsx'
const FILINGS = 'src/app/(app)/gst/filings/page.tsx'
const VAULT = 'src/app/(app)/vault/page.tsx'

const recipes = read(RECIPES)
const journal = read(JOURNAL)
const filings = read(FILINGS)
const vault = read(VAULT)

let pass = 0
const failures = []
function ok(name, cond, detail = '') {
  pass += 1
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// ── A. the recipes footer stopped denying what R3-17 shipped on the same page ──
//
// The doctrine line still said "there is still no work-in-progress account" two rounds after the
// WIP pair went live beside it. It now credits the pair and names the one door it can reach.

ok('A1 the footer points at the journal as the door the paper goes through',
  recipes.includes('a reading first, and paper only through'))
ok('A2 and the sentence links to the register that owns the posting',
  recipes.includes('<Link href="/journal">the journal</Link>'))
ok('A3 it says the run is *drafted*, not posted, from this page',
  recipes.includes('a built run can be drafted as a work-in-progress pair on heads the shop names'))
ok('A4 and admits the page posts nothing itself',
  recipes.includes('and nothing posts it from this page'))
ok('A5 the denial R3-17 made false is gone',
  !recipes.includes('there is still no work-in-progress account'))
ok('A6 the GST doctrine the footer exists to state is untouched',
  recipes.includes('Making something inside your own registered place moves no GST.'))
ok('A7 the back-flush honesty survived the rewrite',
  recipes.includes('No run consumes materials by itself when an invoice is raised'))
ok('A8 and its reason with it',
  recipes.includes('may have come from opening stock or a purchase just as well as from a build'))

// ── B. "Runs on the log" names every state it counts ─────────────────────────
//
// The card read `3` over a log of three all-cancelled runs while its sub-line printed
// "0 built · 0 planned" — the reader was left adding a state the card never mentions.

ok('B1 the card still counts the log with a plain string, not a rupee',
  recipes.includes('label="Runs on the log" value={String(buildList.length)}'))
ok('B2 an empty log keeps its own sentence (the R3-15 vacuity class)',
  recipes.includes("buildList.length === 0 ? 'no run recorded yet'"))
ok('B3 built and planned are still named first',
  recipes.includes('const parts = [`${built} built`, `${planned} planned`]'))
ok('B4 the cancelled third state is named when there is one to name',
  recipes.includes("if (cancelled > 0) parts.push(`${cancelled} cancelled`)"))
ok('B5 cancelled is derived, not picked from a fourth status the engine has no name for',
  recipes.includes('const cancelled = buildList.length - built - planned'))
ok('B6 waiting demand still rides along',
  recipes.includes("if (demand.length) parts.push(`${demand.length} order${demand.length === 1 ? '' : 's'} waiting`)"))
ok('B7 the old two-only sub-line is gone',
  !recipes.includes("${buildList.filter(b => b.status === 'built').length} built"))

// ── C. a called-off run is not invited to draft paper it has no cost to draft ─
//
// The gate lets `cancelled` runs show their paper state — that is how a shop finds live drafts on a
// dead run. Only the *no-paper* sentence has to know the difference.

ok('C1 a cancelled run with no journal row prints its own state',
  recipes.includes('the run was called off, so there is no cost left to draft as paper'))
ok('C2 it branches on the run status, not on the paper state',
  recipes.includes(": r.build.status === 'cancelled'"))
ok('C3 a built run keeps the invitation, because for it the offer is true',
  recipes.includes('its cost is a screen reading until the shop drafts it as paper'))
ok('C4 and the drafting plan is still gated to a built run with no paper',
  recipes.includes("const plan = r.build.status === 'built' && paper.state === 'none'"))
ok('C5 the run-with-paper route still sends the shop to /journal rather than drafting twice',
  recipes.includes('open them on /journal'))
ok('C6 the cancel warning that fires when paper *does* exist is untouched',
  recipes.includes('const cancelNote = r.build.status === \'cancelled\' ? wipCancelNote(paper) : \'\''))

// ── D. /journal's standing-postings card accounts for its own third row ─────
//
// `livePostings` excludes a posted reversal (it is `status: 'posted'` with `reverses` set) and
// `journalStats` counts only the original as reversed, so three numbered entries read as
// "1 standing · 1 reversed" beside a trial balance that said "Postings read 3". The count was right;
// the sentence was short. Fixing it in the card, not in the fold, is the point.

ok('D1 the page counts posted reversals itself, page-side',
  journal.includes('store.entries.filter(e => e.status === \'posted\' && !!e.reverses).length'))
ok('D2 the card now prints them as its own clause',
  journal.includes('posted reversal${postedReversals === 1 ? \'\' : \'s\'}'))
ok('D3 and says what they do, which is why they are not "standing"',
  journal.includes('the pair nets to nothing'))
ok('D4 the card widens only when there is something to widen for',
  journal.includes('stats.reversed > 0 || postedReversals > 0'))
ok('D5 a plain register still reads "folded into the statements" and nothing more',
  journal.includes(': \'folded into the statements\'} delay={0} />'))
ok('D6 the trial-balance card it had to agree with is unchanged',
  journal.includes('label="Postings read" value={String(tb.entries)}'))
ok('D7 its disclaimer is unchanged',
  journal.includes('drafts carry no number and are not here'))

// ── E. the two "past their date" figures on /gst/filings became two sentences ─
//
// `stats.overdue` counts rows whose *state* is overdue (5). `exposure.periods` counts rows whose
// clock has run — overdue *and* filed late (11). One screen, one phrase, two populations.

const engine = read('src/lib/filings.ts')
ok('E1 the finding\'s population is the state-based one, and only that',
  engine.includes("overdue: rows.filter(r => has(r, 'overdue')).length"))
ok('E2 and the cost strip\'s population is the days-based one, and only that',
  engine.includes('periods: rows.filter(r => r.days > 0).length'))
ok('E2b the two are different expressions in the same file — the page may not print them alike',
  engine.indexOf("overdue: rows.filter") !== engine.indexOf('periods: rows.filter'))
ok('E3 the finding now says "still unfiled" — its own fact, in singular',
  filings.includes("'return still unfiled past its date'"))
ok('E4 and in plural',
  filings.includes("'returns still unfiled past their date'"))
ok('E5 its detail names the other figure instead of competing with it',
  filings.includes('the cost strip below counts every period whose date has passed, filed late or not'))
ok('E6 the risk card reads "late or unfiled", which is what days > 0 holds',
  filings.includes("over ${plural(exposure.periods, 'period')} late or unfiled"))
ok('E7 its nil-money state moved with it',
  filings.includes("late or unfiled and nothing owed on them"))
ok('E8 the exposure StatRow label moved too',
  filings.includes('<StatRow label="Periods late or unfiled" value={String(exposure.periods)} />'))
ok('E9 the shared phrase is gone from the label',
  !filings.includes('Periods past their date'))
ok('E10 and from the card',
  !filings.includes("over ${plural(exposure.periods, 'period')} past their date"))
ok('E11 the zero state is untouched — no period past its date at all',
  filings.includes('no period on this register is past its date'))
ok('E12 the late-filed finding is still its own separate line',
  filings.includes("{ n: stats.late, label: 'filed late'"))

// ── F. /vault's subtitle stopped captioning the restorable count as the device's ─
//
// It printed `restorable` (30) as "the registers this app keeps on this browser" while the card
// beside it said the browser holds 35. The numbers the eye compares have to be the same two numbers
// the engine exports.

eq('F1 the register list really is 35 long', REGISTERS.length, 35)
eq('F2 and 30 of them are restorable', REGISTERS.filter(r => r.write).length, 30)
ok('F3 the subtitle now counts every register the app keeps',
  vault.includes('The {REGISTERS.length} registers this app keeps on'))
ok('F4 and reserves `restorable` for what the vault can put back',
  vault.includes('puts {restorable} of them back through the pages that own them'))
ok('F5 naming the remainder instead of hiding it',
  vault.includes('{REGISTERS.length - restorable} travel as evidence only'))
ok('F6 the wrong caption is gone',
  !vault.includes('The {restorable} registers this app keeps on'))
ok('F7 the card it had to agree with is unchanged',
  vault.includes('label="Registers stored here"') && vault.includes('`${storedCount} / ${REGISTERS.length}`'))
ok('F8 and its own restorable clause is unchanged',
  vault.includes('${restorable} can be put back'))
eq('F9 the card\'s evidence-only figure and the subtitle\'s are one subtraction',
  REGISTERS.length - REGISTERS.filter(r => r.write).length, 5)

// ── G. the engines the sentences were wrong about ────────────────────────────
//
// A drive round that "fixed" a finding by editing the arithmetic would be a different round. These
// pins are the fence on that side.

ok('G1 livePostings still excludes a posted reversal',
  read('src/lib/journal.ts').includes("e.status === 'posted' && !e.reverses"))
ok('G2 journalStats still counts reversed by status',
  read('src/lib/journal.ts').includes("store.entries.filter(e => e.status === 'reversed').length"))
ok('G3 foldableEntries is still every non-draft row',
  read('src/lib/journal.ts').includes("store.entries.filter(e => e.status !== 'draft')"))
ok('G4 wipPaper still answers "has this run reached the books" and nothing else',
  read('src/lib/wip.ts').includes("const entries = store.entries.filter(e => e.reference === ref)"))
ok('G5 its no-paper note is still the engine\'s own sentence',
  read('src/lib/wip.ts').includes('no journal row carries this job number yet'))
ok('G6 wipCancelNote still returns blank when there is no paper to warn about',
  read('src/lib/wip.ts').includes('if (paper.entries.length === 0) return \'\''))
ok('G7 exposureOf still foots from days > 0, untouched',
  read('src/lib/filings.ts').includes('periods: rows.filter(r => r.days > 0).length'))
ok('G8 registerStats still counts overdue by state',
  read('src/lib/filings.ts').includes("overdue: rows.filter(r => has(r, 'overdue')).length"))

// ── H. the ledger moved by no line, and the sweep moved nothing else ─────────

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const libCount = readdirSync(join(ROOT, 'src/lib')).filter(f => f.endsWith('.ts')).length
const allFiles = walk(join(ROOT, 'src/app'))
const routeCount = allFiles.filter(f => f.endsWith('page.tsx') || f.endsWith('route.ts')).length
const compCount = readdirSync(join(ROOT, 'src/components')).filter(f => f.endsWith('.tsx')).length

const iconLines = read('src/components/Icons.tsx').split('\n')
const pStart = iconLines.findIndex(l => l.startsWith('const P'))
let pEnd = pStart + 1
while (pEnd < iconLines.length && iconLines[pEnd] !== '}') pEnd += 1
const glyphCount = iconLines.slice(pStart + 1, pEnd).filter(l => /^ {2}['"]?[A-Za-z0-9_-]+['"]?:/.test(l)).length

eq('H1 57 libraries — this round added none', libCount, 57)
eq('H2 67 route source files — this round added none', routeCount, 67)
eq('H3 10 component files — this round added none', compCount, 10)
eq('H4 74 glyphs — this round added none', glyphCount, 74)
eq('H5 35 vault specs, 30 restorable — unchanged', REGISTERS.length, 35)

for (const [name, txt] of [['recipes', recipes], ['journal', journal], ['filings', filings], ['vault', vault]]) {
  ok(`H6 ${name}: no mojibake reached the source through an em dash`, !txt.includes('â€') && !txt.includes('Ã«'))
}
// `plural()` counts nouns ("3 periods"), not participles ("0 built"). The log card needed the
// participle counts, so it uses them directly — and importing `plural` there would have been a
// second way to say the same thing badly.
ok('H7 the recipes page gained no plural() import for this repair',
  recipes.includes("import { formatDateIN } from '@/lib/format'") && !recipes.includes('plural('))
ok('H8 the filings page still routes its noun counts through plural()',
  filings.includes("plural(exposure.periods, 'period')"))
ok('H9 no engine file was rewritten to make a sentence agree',
  !read('src/lib/journal.ts').includes('postedReversals')
  && !read('src/lib/filings.ts').includes('late or unfiled')
  && !read('src/lib/wip.ts').includes('called off'))

// ── the verdict ───────────────────────────────────────────────────────────────

console.log(`${pass - failures.length}/${pass} assertions passed`)
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`)
  process.exit(1)
}
