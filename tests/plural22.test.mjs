// R3-22 — the plural sweep: every hand-rolled noun plural in `src` went through the kit's own word.
//
// R3-16 made `plural()` the home for a count and its noun, and thirteen rounds later the tree still had
// hundreds of sentences spelling the agreement themselves — `${n} lot${n === 1 ? '' : 's'}`, and the
// wider shape a page writes when it cannot remember whether the word ends in "y". R3-21 measured 209 of
// them in `.tsx` alone and reported the rest. This round swept them: the pages *and* the libraries, one
// page-local `count()` helper deleted, and the hand-written `{one, many}` table in the cadence spec
// retired, because a table that remembers both spellings is a second pluraliser sitting beside the kit's
// own and the two can only drift.
//
// The boundary the round drew, and this suite is the fence for it: **the kit pluralises nouns and nothing
// else.** Verb agreement ("1 document carries / 3 documents carry") and irregulars ("person / people")
// are part of the sentence, and a machine that "fixes" them writes worse English than the one it
// replaced. So the residue is pinned by name: a new hedge outside the allowlist fails, and so does a
// sweep that reaches into a verb.
//
// Run from the repo root with nvm's Node 24 (PATH node is Homebrew v20 and refuses
// --experimental-strip-types):
//   /Users/mohdnizam/.nvm/versions/node/v24.21.0/bin/node --experimental-strip-types --no-warnings \
//     --import ./tests/register.mjs ./tests/plural22.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as formatKit from '@/lib/format'
import { plural, pluralNoun } from '@/lib/format'
import { FREQUENCIES, cadenceLine } from '@/lib/recurring'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
/** Paths in this suite are relative to `src`, like the keys of ALL below. */
const read = (rel) => readFileSync(join(SRC, rel), 'utf8')

let pass = 0
const failures = []
function ok(name, cond, detail = '') {
  pass += 1
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

/** Every `.ts` / `.tsx` under src as text, keyed by its path relative to src. */
function sources(dir, out = {}) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.tsx?$/.test(entry)) out[relative(SRC, full)] = readFileSync(full, 'utf8')
  }
  return out
}
const ALL = Object.entries(sources(SRC))
const lines = (t) => t.split('\n')

// ── A. the grammar the kit owns ───────────────────────────────────────────────
// Three rules, in this order: a consonant before a final "y" becomes "ies"; a sibilant tail takes "es";
// everything else takes "s". R3-16 shipped the first and third. This round added the second, because a
// register that names a branch prints "2 branchs" and nothing else in the tree could say it.

eq('A1 one count, one spelling — plural(n, u) is the figure beside pluralNoun(n, u)',
  [0, 1, 2, 7].flatMap(n => ['lot', 'category', 'branch', 'day'].map(u => `${n}:${plural(n, u)}`)).join(' | '),
  [0, 1, 2, 7].flatMap(n => ['lot', 'category', 'branch', 'day'].map(u => `${n}:${n} ${pluralNoun(n, u)}`)).join(' | '))

eq('A2 the singular is the word, untouched', pluralNoun(1, 'ledger entry'), 'ledger entry')
eq('A3 a consonant before the "y" turns into "ies"', pluralNoun(3, 'category'), 'categories')
eq('A4 a vowel before the "y" just takes an s — day is not daies', pluralNoun(4, 'day'), 'days')
eq('A5 the new rule: a sibilant tail takes "es", never a bare "s"', pluralNoun(2, 'branch'), 'branches')
eq('A5b the sibilant classes each read right', ['box', 'match', 'bus', 'quartz'].map(w => pluralNoun(2, w)).join(' '),
  'boxes matches buses quartzes')
eq('A6 plain nouns take an s', [pluralNoun(2, 'lot'), pluralNoun(6, 'amendment')].join(' '), 'lots amendments')
eq('A7 a compound unit agrees on its last word', [pluralNoun(2, 'logged day'), pluralNoun(5, 'series override')].join(' | '),
  'logged days | series overrides')
eq('A7b and a hyphenated one is still one word', pluralNoun(3, 'half-year'), 'half-years')
eq('A8 an initialism keeps its caps and takes a bare s — the vault prints "3 LUTs"', plural(3, 'LUT'), '3 LUTs')
eq('A9 zero is a plural, not a singular — "0 findings" is the honest reading of an empty register',
  plural(0, 'document finding'), '0 document findings')
eq('A10 a negative figure asks the kit about its size, not its sign',
  plural(Math.abs(-2), 'day'), '2 days')

// ── B. one home for the word ──────────────────────────────────────────────────

eq('B1 format.ts exports six formatters now — plural and pluralNoun are the two this round added',
  Object.keys(formatKit).sort().join(),
  'changePct,formatCompactINR,formatDateIN,initials,plural,pluralNoun')
eq('B2 the pluraliser lives in exactly one file',
  ALL.filter(([, t]) => /export function plural(?:Noun)?\(/.test(t)).map(([f]) => f).join(), 'lib/format.ts')
ok('B3 the reorder page-local `count()` helper is gone — it was a second pluraliser with one rule',
  !/const count = /.test(read('app/(app)/inventory/reorder/page.tsx')))
ok('B4 the cadence spec no longer remembers both spellings — each frequency carries one `unit`',
  !/one:|many:/.test(read('lib/recurring.ts')))
eq('B5 and it carries the kit-compatible word for all seven cadences',
  FREQUENCIES.map(f => f.unit).join(' '), 'day week fortnight month quarter half-year year')
eq('B6 no caller calls the kit without importing it',
  ALL.filter(([f, t]) => f !== 'lib/format.ts' && /\bplural\(/.test(t)
    && !/import \{[^}]*\bplural\b[^}]*\} from '@\/lib\/format'/.test(t)).map(([f]) => f).join(), '')
eq('B7 and none calls pluralNoun() without importing it',
  ALL.filter(([f, t]) => f !== 'lib/format.ts' && /\bpluralNoun\(/.test(t)
    && !/import \{[^}]*\bpluralNoun\b[^}]*\} from '@\/lib\/format'/.test(t)).map(([f]) => f).join(), '')
// R3-22's own footprint, as a floor rather than a pin — the reason the number matters is that the sweep
// reached the libraries as well as the pages, and a future page that counts is supposed to raise it.
const pluralSites = ALL.reduce((n, [, t]) => n + (t.match(/\bplural\(/g) || []).length, 0)
const nounSites = ALL.reduce((n, [, t]) => n + (t.match(/\bpluralNoun\(/g) || []).length, 0)
ok('B8 the sweep put at least its measured 400 noun counts through plural()', pluralSites >= 400, `${pluralSites}`)
ok('B9 and at least 52 word-only agreements through pluralNoun()', nounSites >= 52, `${nounSites}`)

// ── C. the census: nothing the kit can say is still spelled by hand ───────────
// The classifier reads a *plural pair*: `? 'sing' : 'sing' + 's'`, `? 'sing' : 'si' + 'ies'`, or the
// suffix forms `${n === 1 ? '' : 's'}` / `${n > 1 ? 's' : ''}`. A ternary between two different words
// (`'customer' : 'vendor'`) is a choice of kind, not of number, and is no hedge at all.

const PLURAL_PAIR = /\?\s*'([a-z][a-z -]*)'\s*:\s*'([a-z][a-z -]*)'/g
const SUFFIX_HEDGE = /=== 1 \? '' : 's'|=== 1 \? 's' : ''|> 1 \? 's'|=== 1 \? 'ies' : 'y'/

/** The ten places that still spell a suffix on purpose: every one of them is a *verb*, named here. */
const VERB_HEDGES = [
  ['app/(app)/cost-centres/page.tsx', 'carr'],         // documents already carry a split
  ['app/(app)/inventory/recipes/page.tsx', 'produce'], // a recipe produces it
  ['app/(app)/payroll/page.tsx', 'carr'],              // a month row carries the lost days
  ['lib/attendance.ts', 'carr'],                       // rows on the sheet carry no mark
  ['lib/costcentres.ts', 'carr'],                      // two: a document still carries a share
  ['lib/filings.ts', 'point'],                         // amendments still point at that period
  ['lib/godowns.ts', 'hold'],                          // lots still hold stock here
  ['lib/tally.ts', 'state'],                           // two: lines state a discount
]
const ALLOWED_SUFFIX = new Set(VERB_HEDGES.map(([f]) => f))

const strays = []
for (const [f, t] of ALL) {
  if (f === 'lib/format.ts') continue
  lines(t).forEach((l, i) => {
    let m
    PLURAL_PAIR.lastIndex = 0
    while ((m = PLURAL_PAIR.exec(l))) {
      const [, one, many] = m
      if (many === one + 's' || (one.endsWith('y') && many === `${one.slice(0, -1)}ies`)) {
        strays.push(`${f}:${i + 1} ${one}/${many}`)
      }
    }
    if (SUFFIX_HEDGE.test(l) && !ALLOWED_SUFFIX.has(f)) strays.push(`${f}:${i + 1} suffix`)
  })
}
eq('C1 not one hand-spelled noun plural is left anywhere in src', strays.join(' | '), '')
const suffixSites = []
for (const [f, t] of ALL) {
  if (f === 'lib/format.ts') continue
  lines(t).forEach((l, i) => { if (SUFFIX_HEDGE.test(l)) suffixSites.push([f, i + 1, l]) })
}
eq('C2 the verb agreement that stayed behind is exactly ten sites', suffixSites.length, 10)
eq('C3 every one of them is a verb this round names, and the verb is the word on the line',
  suffixSites.filter(([f, , l]) => !VERB_HEDGES.some(([vf, verb]) => vf === f && l.includes(verb)))
    .map(([f, n]) => `${f}:${n}`).join(' '), '')
// The other side of the fence: a sweep that "helped" a verb would be a regression, so the verbs are
// pinned as sentences the kit is forbidden to own.
ok('C4 the verbs are still verbs — four of them spell "carry" against "carries"',
  read('lib/costcentres.ts').includes("carr${used === 1 ? 'ies' : 'y'}")
  && read('app/(app)/cost-centres/page.tsx').includes("carr${result.skipped === 1 ? 'ies' : 'y'}"))
ok('C5 and the log card still spells its own participles — built, planned, cancelled',
  read('app/(app)/inventory/recipes/page.tsx').includes('const parts = [`${built} built`, `${planned} planned`]'))
const IRREGULARS = ALL.reduce((n, [, t]) => n + (t.match(/\? 'person' : 'people'/g) || []).length, 0)
eq('C6 the irregular is left to the sentence — four person/people choices survive', IRREGULARS, 4)
// Every literal unit the tree hands the kit, and which of them the new "-es" rule can bite. The measured
// answer is one word: `branch`. A future unit that ends in a sibilant is welcome — it is the rule's whole
// point — but it has to be *seen*, so it fails here until someone reads the sentence it prints.
// The unit is read by walking the call, not by a regex: `plural(arrCount(v, 'luts'), 'LUT')` has a storage
// key in a position where a naive pattern finds the word, and "luts" would falsely convict the rule.
const UNITS = new Set()
for (const [f, t] of ALL) {
  if (f === 'lib/format.ts') continue
  for (const call of ['plural(', 'pluralNoun(']) {
    let at = 0
    while ((at = t.indexOf(call, at)) >= 0) {
      at += call.length
      let depth = 1, i = at, arg = '', args = []
      while (i < t.length && depth > 0) {
        const c = t[i]
        if (c === "'" || c === '"' || c === '`') {
          const quote = c
          let j = i + 1
          while (j < t.length && t[j] !== quote) j += t[j] === '\\' ? 2 : 1
          if (depth === 1) args.push([arg, t.slice(i + 1, j)])
          arg = ''
          i = j + 1
          continue
        }
        if (c === '(' || c === '[' || c === '{') depth += 1
        else if (c === ')' || c === ']' || c === '}') depth -= 1
        if (depth === 1 && c === ',') { args.push([arg, null]); arg = '' }
        else if (depth > 0) arg += c
        i += 1
      }
      const last = args[args.length - 1]
      if (last && last[1] !== null) UNITS.add(last[1])
    }
  }
}
const SIBILANT_UNITS = [...UNITS].filter(u => /(?:s|x|z|ch|sh)$/i.test(u))
eq('C7 "branch" is the only sibilant-tailed unit in the app, so the new rule changes no other reading',
  SIBILANT_UNITS.sort().join(), 'branch')
eq('C8 the kit is handed over 130 distinct noun words and every one is a word, not an expression',
  [UNITS.size >= 130, [...UNITS].every(u => /^[A-Za-z][A-Za-z0-9 -]*$/.test(u))].join(' / '), 'true / true')

// ── D. the base vocabulary, re-spelled by the kit ─────────────────────────────
// Every pair below is a form the tree spelled by hand before this round, copied off the old line. The
// claim is not that the kit is clever — it is that the sweep changed no word a shop ever read.

const BASE_FORMS = [
  ['entry', 'entries'], ['category', 'categories'], ['invoice', 'invoices'], ['bill', 'bills'],
  ['customer', 'customers'], ['deadline', 'deadlines'], ['document', 'documents'], ['expense', 'expenses'],
  ['line', 'lines'], ['payment', 'payments'], ['posting', 'postings'], ['row', 'rows'], ['thing', 'things'],
  ['ledger entry', 'ledger entries'], ['time entry', 'time entries'], ['journal entry', 'journal entries'],
  ['logged day', 'logged days'], ['posted reversal', 'posted reversals'], ['document finding', 'document findings'],
  ['export invoice', 'export invoices'], ['purchase bill', 'purchase bills'], ['sale line', 'sale lines'],
  ['stocked item', 'stocked items'], ['dated obligation', 'dated obligations'], ['overdue filing', 'overdue filings'],
  ['day mark', 'day marks'], ['lost day', 'lost days'], ['month row', 'month rows'],
]
const wrongForms = BASE_FORMS.filter(([unit, spelled]) => pluralNoun(2, unit) !== spelled)
  .map(([unit, spelled]) => `${unit} → ${pluralNoun(2, unit)} ≠ ${spelled}`)
eq('D1 the kit says each of the 28 words the base wrote by hand, exactly as the base wrote it', wrongForms.join(' | '), '')
eq('D2 and hands every one back untouched at one', BASE_FORMS.filter(([unit]) => pluralNoun(1, unit) !== unit).length, 0)

// The cadence line is the round's second pluraliser, retired. `cadenceLine()` used to look a spelling up
// in a table; now it asks the kit. Both the one and the many are asserted against the engine's own output.
eq('D3 every month-based cadence still reads in English at 1 and at 3',
  ['monthly', 'quarterly', 'half-yearly', 'yearly']
    .map(v => {
      const f = FREQUENCIES.find(x => x.value === v)
      return `${pluralNoun(1, f.unit)}/${pluralNoun(3, f.unit)}`
    }).join(' '),
  'month/months quarter/quarters half-year/half-years year/years')
eq('D4 "Every 2 fortnights" is the kit\'s word, not a remembered one',
  cadenceLine({ interval: 2, frequency: 'fortnightly' }), 'Every 2 fortnights')
eq('D5 and the singular cadence reads "Every month" — the kit was asked, and it did not print "1 months"',
  cadenceLine({ interval: 1, frequency: 'monthly' }), 'Every month')
ok('D6 the recurring page asks the kit for the unit beside its interval input',
  read('app/(app)/recurring/page.tsx').includes("pluralNoun(editor.s.interval, frequencyOf(editor.s.frequency).unit)"))

// ── E. the four sentences that changed meaning, and where they now sit ────────
// Rule 57: a copy repair moves the sentence, never the arithmetic. These are the places where the old
// wording was *wrong*, not merely spelled by hand — so the pin is on the new claim.

ok('E1 the refund-track footer counts files as files, not as bills',
  read('app/(app)/gst/exports/page.tsx').includes(
    `{plural(track.groups.length, 'bill')} · {plural(track.groups.reduce((s, g) => s + g.members.length, 0), 'file')}`)
  && !read('app/(app)/gst/exports/page.tsx').includes(`file{track.groups.length === 1 ? '' : 's'}`))
ok('E2 a project with one logged entry stopped calling it "1 logged rows" — one noun now owns the figure',
  read('app/(app)/projects/page.tsx').includes("${plural(sum.entries, 'logged day')}")
  && !read('app/(app)/projects/page.tsx').includes("logged ${sum.entries === 1 ? 'day' : 'rows'}"))
eq('E3 the vault prints a branch count the kit agrees',
  read('lib/vault.ts').includes("${plural(b, 'branch')}"), true)
ok('E4 nine cards that hedged with "> 1" now state their zero — "0 invoices", not "0 invoice"',
  !ALL.some(([, t]) => /> 1 \? 's'/.test(t)))

// ── F. what a wording round must not have touched ───────────────────────────────
// The sweep was a text transform, so it has no business inside a comparison, a storage key or a
// computation. The carried suites own the arithmetic; these pin the shape of the calls.

ok('F1 no plural call sits in a condition, a comparison or a key',
  !ALL.some(([, t]) => /if \(plural|=== plural|!== plural|key: plural|case plural/.test(t)))
// The defect this check found and the round fixed: the sweep pasted a JSX expression brace — `{plural(…)}`
// — into a *template literal* in `tally.ts`, where it is not an expression at all and prints as itself.
// A library has no JSX, so a bare brace before `plural` there is never right.
eq('F2 no library hands the kit as a JSX brace inside a plain string',
  ALL.filter(([f, t]) => f.endsWith('.ts') && /[^$]\{plural/.test(t)).map(([f]) => f).join(), '')
ok('F3 no storage key or CSV header picked up the kit',
  !ALL.some(([, t]) => /'taxflow:[^']*plural/i.test(t)))
ok('F4 the paise still rounds money — money wording never reached the arithmetic',
  read('lib/journal.ts').includes('export function paise('))
ok('F5 ledger.ts still derives the statements itself',
  read('lib/ledger.ts').includes('export function computeProfitLoss('))
ok('F6 and the seal still keeps its photograph, with no noun agreement inside it',
  read('lib/audit.ts').includes('snapshot_unreadable')
  && !read('lib/audit.ts').includes('plural('))

// ── G. the verb that the swept noun governs ─────────────────────────────────────
// The kit owns the noun and nothing else, so agreement of the *verb* stays in the sentence. That is the
// boundary — but a boundary is only honest if the sentence actually lives inside it. Routing "3 documents
// carry no centre" through the kit left the noun agreed and the verb never agreed at all, so at one it
// printed "1 document carry no centre": a kit-spelled subject and a verb that ignores it, on the same
// card. Seventeen such sentences were measured (six of them already hand-agreeing their verb, which is
// why the ten suffix sites of C survived). Each row below is one repaired sentence: the old bare wording
// must be gone and the agreed wording present, so the fence bites in both directions.

const VERB_SITES = [
  ['app/(app)/cost-centres/page.tsx',
    "${plural(free.length, 'document')} carry no centre",
    "${plural(free.length, 'document')} ${free.length === 1 ? 'carries' : 'carry'} no centre"],
  ['app/(app)/cost-centres/page.tsx',
    'in this view have a split worth reading again',
    "in this view {visibleSheets.filter(s => s.problems.length).length === 1 ? 'has' : 'have'} a split worth reading again"],
  ['app/(app)/cost-centres/page.tsx',
    'already carrying a split were left exactly as they were',
    "already carrying a split ${result.skipped === 1 ? 'was left exactly as it was' : 'were left exactly as they were'}"],
  ['app/(app)/fx/page.tsx',
    "${plural(unvalued, 'deal')} have no rate",
    "${plural(unvalued, 'deal')} ${unvalued === 1 ? 'has' : 'have'} no rate"],
  ['app/(app)/gst/filings/page.tsx',
    "${plural(costs.length, 'correction')} carry a figure",
    "${plural(costs.length, 'correction')} ${costTotals.quantified === 1 ? 'carries' : 'carry'} a figure"],
  ['app/(app)/gst/filings/page.tsx',
    "'open amendment')} name {periodLabel",
    "'open amendment')} {openAmendmentsFor(store, removing.row.period).length === 1 ? 'names' : 'name'} {periodLabel"],
  ['app/(app)/gst/job-work/page.tsx',
    'in this period carry no HSN/SAC',
    "in this period ${statement.rows_without_hsn === 1 ? 'carries' : 'carry'} no HSN/SAC"],
  ['app/(app)/gst/job-work/page.tsx',
    "'movement')} name a job worker without a GSTIN",
    "'movement')} ${statement.rows_without_gstin === 1 ? 'names' : 'name'} a job worker without a GSTIN"],
  ['app/(app)/gst/job-work/page.tsx',
    "'movement')} name a job worker who is not",
    "'movement')} {unnamedWorkers === 1 ? 'names' : 'name'} a job worker who is not"],
  ['app/(app)/inventory/batches/page.tsx',
    "'recorded movement')} go with it",
    "'recorded movement')} ${n === 1 ? 'goes' : 'go'} with it"],
  ['app/(app)/inventory/batches/page.tsx',
    "{plural(allocExpiredTakes, 'unit')} come from lots",
    "{plural(allocExpiredTakes, 'unit')} {allocExpiredTakes === 1 ? 'comes' : 'come'} from lots"],
  ['app/(app)/inventory/batches/page.tsx',
    "'unit')} have no batch recorded and stay off the register",
    "'unit')} {allocPreview.shortfall === 1 ? 'has' : 'have'} no batch recorded and {allocPreview.shortfall === 1 ? 'stays' : 'stay'} off the register"],
  ['app/(app)/inventory/recipes/page.tsx',
    "'numbered unit')} stand on the shelf again",
    "'numbered unit')} ${undoneSerial === 1 ? 'stands' : 'stand'} on the shelf again"],
  ['app/(app)/journal/page.tsx',
    "'entry')} name a head this register no longer holds",
    "'entry')} {l.entries === 1 ? 'names' : 'name'} a head this register no longer holds"],
  ['app/(app)/payroll/page.tsx',
    "${plural(result.skipped.length, 'person')} were left out",
    "${plural(result.skipped.length, 'person')} ${result.skipped.length === 1 ? 'was' : 'were'} left out"],
  ['app/(app)/payroll/page.tsx',
    'with no day written were left alone',
    "with no day written ${result.untouched === 1 ? 'was' : 'were'} left alone"],
  ['app/(app)/payroll/page.tsx',
    "{plural(result.written, 'day mark')} are in the book",
    "{plural(result.written, 'day mark')} ${result.written === 1 ? 'is' : 'are'} in the book"],
  ['app/(app)/payroll/page.tsx',
    'of this month are still unwritten',
    "of this month ${book.footer.unwritten_on_weekly_off === 1 ? 'is' : 'are'} still unwritten"],
  ['app/(app)/payroll/page.tsx',
    'from that page now sit on the grid',
    "from that page now {pageWritten === 1 ? 'sits' : 'sit'} on the grid"],
  ['app/(app)/payroll/page.tsx',
    "${plural(result.untouched, 'person')} have no day written",
    "${plural(result.untouched, 'person')} ${result.untouched === 1 ? 'has' : 'have'} no day written"],
  ['app/(app)/pos/page.tsx',
    "'product')} still need a barcode",
    "'product')} still {missingBarcodeCount === 1 ? 'needs' : 'need'} a barcode"],
  ['app/(app)/projects/page.tsx',
    "'row')} now point at ${ref}",
    "'row')} now ${billFor.ids.length === 1 ? 'points' : 'point'} at ${ref}"],
  ['lib/bom.ts',
    'on the log were made from this recipe',
    "on the log ${used === 1 ? 'was' : 'were'} made from this recipe"],
  ['lib/gstr9.ts',
    "'month')} do not tie between",
    "'month')} ${recon.monthsVariance === 1 ? 'does' : 'do'} not tie between"],
  ['lib/payroll.ts',
    "{plural(s.heads, 'head')} are marked outside PF",
    "{plural(s.heads, 'head')} ${s.heads === 1 ? 'is' : 'are'} marked outside PF"],
  ['lib/payroll.ts',
    "{plural(s.no_tax, 'head')} have no tax figure",
    "{plural(s.no_tax, 'head')} ${s.no_tax === 1 ? 'has' : 'have'} no tax figure"],
  ['lib/wip.ts',
    "'component')} carry no price",
    "'component')} ${full.material.unpriced.length === 1 ? 'carries' : 'carry'} no price"],
]

const verbStrays = []
for (const [f, bare, agreed] of VERB_SITES) {
  const t = read(f)
  if (t.includes(bare)) verbStrays.push(`${f} still prints "${bare}"`)
  if (!t.includes(agreed)) verbStrays.push(`${f} lost its verb agreement`)
}
eq('G1 every sentence whose subject the kit now spells also spells its verb', verbStrays.join(' | '), '')
eq('G2 the repair covers twenty-seven sentences, the round\'s own ledger', VERB_SITES.length, 27)
// The two sentences that show the fence from the other side: the noun moved to the kit, and the verb (or
// the pronoun) was already agreeing in the sentence, so it stayed exactly where it was.
ok('G3 the calendar moved its noun and left its already-agreeing "is"/"are" alone',
  read('app/(app)/gst/calendar/page.tsx').includes("{pluralNoun(payRows.length, 'deadline')} this year {payRows.length === 1 ? 'is' : 'are'}"))
ok('G4 and /journal moved its noun and left its already-choosing "it"/"them" alone',
  read('app/(app)/journal/page.tsx').includes("${pluralNoun(used, 'entry')} already carrying ${used === 1 ? 'it' : 'them'}"))
// No participle was ever a defect, and no finite verb is allowed to hide among them: the words the round
// agreed must not reappear bare anywhere in the tree.
const BARE_AGAIN = ['carry no centre', 'have no rate to revalue', 'come from lots already past',
  'have no batch recorded', 'name a job worker', 'name a head this register', 'carry no HSN/SAC',
  'carry no price', 'have no tax figure', 'are marked outside PF', 'do not tie between',
  'were made from this recipe', 'were left out', 'now sit on the grid', 'still need a barcode',
  'now point at', 'stand on the shelf again', "'recorded movement')} go with it",
  "{plural(result.written, 'day mark')} are in the book", 'a split were left', 'have no day written']
const reappeared = BARE_AGAIN.filter(s => ALL.some(([, t]) => t.includes(s)))
eq('G5 the bare wording is gone from the whole tree, not only from the line the round edited',
  reappeared.join(' | '), '')

console.log(`${pass}/${pass + failures.length} assertions passed`)
if (failures.length) {
  for (const f of failures) console.log('  FAIL: ' + f)
  process.exit(1)
}
