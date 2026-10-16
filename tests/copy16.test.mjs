// R3-16 — the copy-polish suite.
//
// Four findings came out of R3-15's live drive and were deliberately left unfixed there: a count hedged
// with an optional letter, one action wearing three names, a card that pointed at a list instead of
// stating its finding, and a palette that could not answer "March". This suite is the fence that keeps
// them fixed. It reads the sources as text for the copy claims and imports the two pure helpers for the
// behavioural ones — the engines' arithmetic is not this round's subject and is asserted only where a
// sentence depends on it.
//
// Run from the repo root:
//   /Users/mohdnizam/.nvm/versions/node/v24.21.0/bin/node --experimental-strip-types --no-warnings \
//     --import ./tests/register.mjs ./tests/copy16.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as formatKit from '@/lib/format'
import { plural } from '@/lib/format'
import { buildPageCommands, rankCommands, isKnownHref } from '@/lib/commands'
import { exposureOf } from '@/lib/filings'
import { STARTER_HEADS } from '@/lib/journal'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')

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

/** Every `.ts` / `.tsx` under src, as text, keyed by its path relative to src. */
function sources(dir) {
  const out = {}
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) Object.assign(out, sources(full))
    else if (/\.tsx?$/.test(entry)) out[relative(SRC, full)] = readFileSync(full, 'utf8')
  }
  return out
}

const FILES = sources(SRC)
const ALL = Object.entries(FILES)

// ── A. the counter says one or many ───────────────────────────────────────────

eq('plural: one day', plural(1, 'day'), '1 day')
eq('plural: two days', plural(2, 'day'), '2 days')
eq('plural: zero rows is a count, not a hedge', plural(0, 'row'), '0 rows')
eq('plural: one row', plural(3 - 2, 'row'), '1 row')
eq('plural: a consonant and y becomes ies', plural(3, 'entry'), '3 entries')
eq('plural: one of an ies word stays as written', plural(1, 'entry'), '1 entry')
eq('plural: a vowel and y only ever takes s', plural(2, 'key'), '2 keys')
eq('plural: so does day', plural(2, 'day'), '2 days')
eq('plural: a multi-word unit takes s at the end', plural(4, 'stock item'), '4 stock items')
eq('plural: one multi-word unit', plural(1, 'outward document'), '1 outward document')
eq('plural: two multi-word units', plural(2, 'outward document'), '2 outward documents')
eq('plural: an upper-case initialism takes s', plural(2, 'LUT'), '2 LUTs')
eq('plural: period, the word the risk card counts', plural(1, 'period'), '1 period')
eq('plural: period again', plural(7, 'period'), '7 periods')
ok('plural: never hedges', [0, 1, 2, 17].every(n => !plural(n, 'day').includes('(')), plural(17, 'day'))
ok('plural: always prints the count first', [0, 1, 2, 9, 100].every(n => plural(n, 'invoice').startsWith(`${n} `)))
ok('plural: never doubles a unit', [1, 2].every(n => !/(s|ies)\s*\1/i.test(plural(n, 'draft'))))
eq('the kit has five formatters now', Object.keys(formatKit).sort().join(), 'changePct,formatCompactINR,formatDateIN,initials,plural')

// ── B. the bracketed hedge survives only where it is an argument list ─────────

/**
 * The measure R3-15 recorded — "125 `(s)` across 29 files" — counted every occurrence of the four
 * characters, which includes the 44 places `s` is a variable handed to a function: `render(s)`,
 * `exec(s)`, `openSplit(s)`. Those are not copy. The prose this round fixed was the hedge, and a hedge
 * always follows a noun the sentence is counting. So the fence is the word in front of the bracket: an
 * argument list names a callee or a control keyword, and a count hedged in prose names a thing.
 */
const CALLEES = new Set([
  'ask', 'cadenceLine', 'clearTag', 'closePlace', 'effectiveRate', 'exec', 'filter', 'flatMap', 'fromISO',
  'get', 'includes', 'latestOccurrence', 'map', 'noPanRateOf', 'Number', 'occurrenceCsvRows', 'openSplit', 'push',
  'render', 'ruleEndsOn', 'some', 'tallyNumber', 'test', 'validateSchedule',
])
const KEYWORDS = new Set(['if', 'while', 'for', 'return', 'switch'])
const census = {}
for (const [file, text] of ALL) {
  let n = 0
  for (const m of text.matchAll(/\(s\)/g)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index)
    const callee = (/([A-Za-z_$][\w$]*)\s*$/.exec(before) ?? [])[1]
    const isArgument = callee !== undefined
      ? (CALLEES.has(callee) || KEYWORDS.has(callee))
      : /[([]\s*$/.test(before)   // an arrow parameter, `(s) =>`
    if (!isArgument) failures.push(`hedge still in prose: ${file} near "${before.replace(/\s+/g, ' ').trim()}(s)"`)
    n += 1
  }
  if (n) census[file] = n
}
const EXPECTED_CENSUS = {
  'app/(app)/ai/ask/page.tsx': 1,
  'app/(app)/cost-centres/page.tsx': 5,
  'app/(app)/gst/reconciliation/page.tsx': 1,
  'app/(app)/inventory/godowns/page.tsx': 1,
  'app/(app)/recurring/page.tsx': 3,
  'app/(app)/tds/page.tsx': 1,
  'app/setup/page.tsx': 1,
  'lib/ask.ts': 1,
  'lib/bank-statement.ts': 5,
  'lib/bill-text.ts': 2,
  'lib/exports.ts': 1,
  'lib/gstr9.ts': 1,
  'lib/journal.ts': 3,
  'lib/recurring.ts': 5,
  'lib/registers.ts': 1,
  'lib/serials.ts': 2,
  'lib/tally.ts': 10,
}
eq('the surviving `(s)` are 44 argument lists', Object.values(census).reduce((a, b) => a + b, 0), 44)
eq('and they sit in exactly these 17 files', JSON.stringify(census), JSON.stringify(EXPECTED_CENSUS))
ok('no interpolation is followed by a hedged noun anywhere in src',
  !ALL.some(([, t]) => /\}\s+[a-z][a-z ]{0,22}\(s\)/.test(t)))
ok('no hedged month, form or head name is left in prose',
  !ALL.some(([, t]) => /(return|period|invoice|amendment|head|draft|row|day|document|entry|file)s?\(s\)/.test(t)))

// ── C. one pluraliser, and it lives in the kit ────────────────────────────────

eq('format.ts is the only home for plural', ALL.filter(([, t]) => /export function plural\(/.test(t)).map(([f]) => f).join(), 'lib/format.ts')
ok('vault.ts no longer defines its own', !/function plural\(/.test(FILES['lib/vault.ts']))
ok('vault.ts imports the kit one', /import \{[^}]*\bplural\b[^}]*\} from '@\/lib\/format'/.test(FILES['lib/vault.ts']))
eq('files that import plural from the kit', ALL.filter(([, t]) => /import \{[^}]*\bplural\b[^}]*\} from '@\/lib\/format'/.test(t)).length, 15)

// ── D. one action, one offer ─────────────────────────────────────────────────

const journalPage = FILES['app/(app)/journal/page.tsx']
const starterButtons = journalPage.match(/<Button[^>]*onClick=\{runStarters\}[^>]*>[^<]*</g) ?? []
eq('the starting chart is offered three times', starterButtons.length, 3)
ok('every offer renders the same label', starterButtons.every(b => b.includes('{STARTER_LABEL}')), starterButtons.join('\n'))
ok('every offer carries the same glyph', starterButtons.every(b => b.includes('icon="plus"')), starterButtons.join('\n'))
ok('the drifted spelling is gone from src', !ALL.some(([, t]) => /Add the starting six/.test(t)))
eq('and the label is the engine phrase', (journalPage.match(/const STARTER_LABEL = '([^']+)'/) ?? [])[1], 'Add the six starting heads')
ok('the click reports back in the same words', /All six starting heads were already on the register/.test(journalPage))
ok('the heads empty state names heads, not movements', /Six heads, named for the movements a shop asks for most/.test(journalPage))
eq('the engine offers the six the label counts', STARTER_HEADS.length, 6)

// ── E. the risk card states its finding ──────────────────────────────────────

const filingsPage = FILES['app/(app)/gst/filings/page.tsx']
eq('the card is labelled for what it counts', /label="At risk this year"/.test(filingsPage), true)
ok('the old label that read like a list is gone', !/At risk on this year/.test(filingsPage))
ok('it no longer sends the reader to a breakdown', !/see the breakdown below/.test(filingsPage))
ok('state one: money owed names its two parts', /\$\{money\(exposure\.fee\)\} of late fee and \$\{money\(exposure\.interest\)\} of section 50 interest/.test(filingsPage))
ok('state two: time past with nothing owed says so', /past their date and nothing owed on them/.test(filingsPage))
ok('state three: nothing past its date is stated, not implied', /no period on this register is past its date/.test(filingsPage))
ok('the card counts its periods through the kit', /plural\(exposure\.periods, 'period'\)/.test(filingsPage))
ok('the card still prints a rupee, not a count', /value=\{money\(exposure\.total\)\}/.test(filingsPage))
ok('the tone follows the money, not the days', /tone=\{exposure\.total > 0 \? 'red' : 'grey'\}/.test(filingsPage))

// The three states are only honest if the engine can actually reach all three. These are the fields the
// fold reads, not whole register rows — the arithmetic itself belongs to R3-4's suite.
const owed = { days: 12, fee: { fee: 200, interest: 50, paid: { lateFee: 0, interest: 0 } } }
const pastButPaid = { days: 3, fee: { fee: 0, interest: 0, paid: { lateFee: 0, interest: 0 } } }
const onTime = { days: 0, fee: { fee: 0, interest: 0, paid: { lateFee: 0, interest: 0 } } }
eq('state one is reachable', JSON.stringify(exposureOf([owed])), JSON.stringify({ fee: 200, interest: 50, total: 250, periods: 1 }))
eq('state two is reachable: no money', exposureOf([pastButPaid]).total, 0)
eq('state two is reachable: and one period past its date', exposureOf([pastButPaid]).periods, 1)
eq('state three is reachable: a row within its date', exposureOf([onTime, onTime]).periods, 0)
eq('an empty register reaches state three too', exposureOf([]).total, 0)

// ── F. ⌘K answers a month ────────────────────────────────────────────────────

const pages = buildPageCommands()
eq('the palette offers every nav page', pages.length, 55)
const MONTHS = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March']
for (const m of MONTHS) {
  const hits = rankCommands(m, pages).map(c => c.href)
  ok(`⌘K resolves "${m}" to the two pages that print it`,
    hits.includes('/gst/calendar') && hits.includes('/gst/filings'), hits.join(', ') || 'nothing')
}
eq('a month routes nowhere else', rankCommands('March', pages).map(c => c.href).sort().join(), '/gst/calendar,/gst/filings')
ok('⌘K resolves a quarter', rankCommands('Q2', pages).map(c => c.href).includes('/gst/filings'))
ok('⌘K resolves the words a due date is described with', rankCommands('overdue', pages).map(c => c.href).includes('/gst/filings'))
ok('and they are real destinations (Rule 48)', isKnownHref('/gst/calendar') && isKnownHref('/gst/filings'))
ok('a nonsense prefix does not inherit a month', rankCommands('marmalade', pages).length === 0)
const commands = FILES['lib/commands.ts']
eq('only two pages were given period words', (commands.match(/^  '\/gst\/(calendar|filings)':/gm) ?? []).length, 2)
const palette = readFileSync(join(ROOT, 'src/components/CommandPalette.tsx'), 'utf8')
ok('the no-match line states the boundary', /is computed, and the Compliance Calendar prints it/.test(palette))

// ── the run ──────────────────────────────────────────────────────────────────

console.log(`${pass - failures.length}/${pass} assertions passed`)
for (const f of failures) console.log(`  FAIL  ${f}`)
process.exit(failures.length ? 1 : 0)
