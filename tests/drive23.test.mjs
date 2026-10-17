// R3-23 — the third live drive, and the class it found: a figure printed beside a noun that only has a
// plural spelling.
//
// Rule 59 closed R3-22 by declaring its own debt: "the four E-sites and the 27 repaired verbs are owed
// the look #278 gave R3-16's four." This round paid it. The signed-in walk of R3-22's sentences found
// the print that set the task — `/vault` reading **"1 recipe · 3 builds · 0 rate rows · 1 job
// counters"** — and then found the shape underneath it: R3-16's `plural()` and R3-22's sweep both look
// for a *hedge* to replace (`${n} lot${n === 1 ? '' : 's'}`), and a hard-coded plural has no hedge, no
// ternary and no `'s'` string to delete, so a census built on either shape is structurally blind to it.
// Two instruments were needed, because the defect has two spellings: `` `${n} entries` `` inside a
// template literal, and `{n} entries` as a JSX child.
//
// The round's rule, which this suite is the fence for: **repair where the figure can be one; pin where
// it cannot.** Every survivor of both instruments is named below with the reason it survived — a
// constant the app defines as 30, a length of a table the repo ships, a measurement whose unit is the
// shop's own UOM, a sentence that already says "a finding", or a word that turned out to be a verb.
// A survivor with no named reason fails the run, and a reason that stops being true fails too.
//
// Run from the repo root with nvm's Node 24 (PATH node is Homebrew v20 and refuses
// --experimental-strip-types):
//   /Users/mohdnizam/.nvm/versions/node/v24.21.0/bin/node --experimental-strip-types --no-warnings \
//     --import ./tests/register.mjs ./tests/drive23.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { plural, pluralNoun } from '@/lib/format'
import { REGISTERS, keyCount, specById } from '@/lib/vault'
import { persistencePlan, sealClaims } from '@/lib/persistence'
import { validateBatch, EXPIRY_CRITICAL_DAYS, EXPIRY_SOON_DAYS, newBatch, newMove } from '@/lib/batches'
import { watchSentence, SERVICE_INVOICE_DAYS, DUE_SOON_DAYS } from '@/lib/projects'
import { MAX_UNITS_PER_BUILD, MAX_MINUTES_PER_RUN, MAX_COMPONENTS } from '@/lib/bom'
import { REFUND_WINDOW_MONTHS, REFUND_CLOSING_DAYS } from '@/lib/exports'
import { ITC_PAYMENT_DEADLINE_DAYS } from '@/lib/gstr9'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
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

/** Every `.ts`/`.tsx` under src as text, keyed by its path relative to src. */
function sources(dir, out = {}) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.tsx?$/.test(entry)) out[relative(SRC, full)] = readFileSync(full, 'utf8')
  }
  return out
}
const ALL = Object.entries(sources(SRC))

// ── A. the two instruments, and the census they now read ───────────────────────
// R3-22's grep looked for a suffix hedge; this one looks for the *noun* and asks whether the figure
// beside it could ever be one. The same word is printed two ways in this tree, so the same question is
// asked twice — once against `` `${expr} word` ``, once against `{expr} word` in JSX.

const VERBS = new Set('is are was were has have does do says say reads read shows show carries carry take takes gives give makes make holds hold lists list names name prints print sits sit stands stand comes come covers cover offers offer refuses refuse reminds remind needs need puts put sets set tells tell uses use warns warn leaves leave stays stay goes go keeps keep sends send runs run fails fail counts count draws draw writes write agrees agree belongs belong begins begin chooses choose fits fit feels feel knows know wants want lives live exists exist appears appear points point asks ask bills bill blocks block clears clear closes close creates create deletes delete drops drop ends end enters enter fills fill finds find folds fold grants grant happens happen hides hide involves involve lands land lasts last leads lead lets let likes like lifts lift looks look loses lose moves move opens open pays pay plans plan proves prove raises raise reaches reach remains remain saves save scans scan seals seal sees see sells sell starts start stops stop tracks track turns turn visits visit waits wait wins win lives live become become'.split(' '))
/** An interpolation that yields a word, not a figure, can never disagree with anything. */
const STRINGY = /\.(name|label|title|noun|narration|number|text|caption|value|key|id|href|url|unit|code|word)$|\?\.\w+$|\|\||formatDate|money\(|paise\(|`|toUpperCase|toLowerCase|trim\(\)/
/** What an expression has to look like to be read as a count. */
const NUMERIC = /length|keyCount|arrCount|list\(|Object\.keys|\.size\b|count|total|Count|rows|docs|\bsum\(|Number\(|\.filter\(|\.reduce\(|\bqty\b|\.at\(|\bn\(|_count|qty\(|amount/
/** Words that only ever wear a plural spelling, and words that are not nouns at all. */
const INVARIANT = /^(series|data|luts|news|yes|status|access|business|this|that|the|it|is|as|of|to|in|on|and|or|but|for|with|without|per|each|every)$/i
const PLAUSIBLE_PLURAL = /(s|ies|es)$/i

/** Both shapes, one walker. `jsx` narrows the tree to the pages and swaps the opener. */
function census(jsxOnly = false) {
  const prefix = jsxOnly ? "jsx:" : "tpl:"
  const hits = []
  for (const [rel, text] of ALL) {
    if (rel === 'lib/format.ts') continue
    if (jsxOnly && !rel.startsWith('app/')) continue
    if (jsxOnly && !rel.endsWith('.tsx')) continue
    text.split('\n').forEach((line, i) => {
      const re = jsxOnly ? /\s\{([^{}]+)\}\s+([A-Za-z][A-Za-z'-]*)/g : /\$\{([^{}]+)\}\s+([A-Za-z][A-Za-z'-]*)/g
      for (const m of line.matchAll(re)) {
        const expr = m[1].trim(), word = m[2]
        if (VERBS.has(word.toLowerCase())) continue
        if (!PLAUSIBLE_PLURAL.test(word) || INVARIANT.test(word)) continue
        if (!jsxOnly && STRINGY.test(expr)) continue
        if (!jsxOnly && !NUMERIC.test(expr) && !/^\w+(\.\w+)*$/.test(expr)) continue
        if (jsxOnly && /^\s*=/.test(line.slice(m.index + m[0].length))) continue
        hits.push({ site: `${prefix}${rel}::${word}`, ln: i + 1, expr, line: line.trim() })
      }
    })
  }
  const bySite = new Map()
  for (const h of hits) bySite.set(h.site, (bySite.get(h.site) || 0) + 1)
  return { hits, bySite, prefix }
}

// The kept population, one reason per site: how many times the census sees it, the class the round
// named, and why. E = the figure cannot be one. C = the sentence already names the one. D = a measure or
// a UOM the shop reads. V = the word is a verb here. N = the word is headed by a name, not a count.
// A survivor's key carries the half of the census that saw it, because the same file and the same noun
// can be printed both ways — the exports page writes `${REFUND_CLOSING_DAYS} days` in a template and
// `{REFUND_CLOSING_DAYS} days` in JSX, and each half must be able to report that the other one moved.
const KEPT = {
  'tpl:app/(app)/accounting/page.tsx::lines': [1, 'C', "its ternary prints 'a line' at one"],
  'tpl:app/(app)/cost-centres/page.tsx::across': [1, 'V', 'a preposition, not a noun'],
  'tpl:app/(app)/expenses/page.tsx::expenses': [1, 'N', "headed by the shop's own category name"],
  'tpl:app/(app)/gst/einvoice/page.tsx::documents': [1, 'E', 'WINDOW is 300 — the fetch never reads fewer'],
  'tpl:app/(app)/gst/exports/page.tsx::days': [1, 'E', 'REFUND_CLOSING_DAYS is 90'],
  'tpl:app/(app)/gst/gstr9/page.tsx::days': [2, 'E', 'ITC_PAYMENT_DEADLINE_DAYS is 180, twice'],
  'tpl:app/(app)/gst/job-work/page.tsx::across': [1, 'V', 'a preposition, not a noun'],
  'tpl:app/(app)/inventory/batches/page.tsx::days': [2, 'E', 'EXPIRY_CRITICAL_DAYS is 30, twice'],
  'tpl:app/(app)/inventory/godowns/page.tsx::days': [1, 'E', 'EXPIRY_CRITICAL_DAYS is 30'],
  'tpl:app/(app)/inventory/reorder/page.tsx::DAYS': [1, 'E', 'an all-caps eyebrow label, and windowDays is clamped to ≥7'],
  'tpl:app/(app)/journal/page.tsx::findings': [1, 'C', "its ternary prints 'a finding' at one"],
  'tpl:app/(app)/projects/page.tsx::days': [2, 'C', 'one line prints DUE_SOON_DAYS, which is 7; the other answers a one with "yesterday or today"'],
  'tpl:lib/ask.ts::expenses': [1, 'N', "headed by the shop's own category name"],
  'tpl:lib/ask.ts::units': [1, 'D', "a quantity formatter's UOM — the shop's word for what it sells"],
  'tpl:lib/audit.ts::overlaps': [1, 'V', 'a verb: "the window overlaps"'],
  'tpl:lib/bank-statement.ts::rows': [1, 'E', 'MAX_ROWS is 4000'],
  'tpl:lib/batches.ts::days': [2, 'E', 'EXPIRY_CRITICAL_DAYS 30 and EXPIRY_SOON_DAYS 90'],
  'tpl:lib/bom.ts::components': [1, 'E', 'MAX_COMPONENTS is 200'],
  'tpl:lib/bom.ts::minutes': [1, 'E', 'MAX_MINUTES_PER_RUN is 100000'],
  'tpl:lib/bom.ts::units': [2, 'E', 'MAX_UNITS_PER_BUILD is 100000, twice'],
  'tpl:lib/einvoice.ts::shares': [1, 'V', 'a verb: "the slab shares"'],
  'tpl:lib/exports.ts::files': [1, 'E', 'MAX_FILES is 4000'],
  'tpl:lib/exports.ts::months': [1, 'E', 'REFUND_WINDOW_MONTHS is 24'],
  'tpl:lib/exports.ts::realisations': [2, 'E', 'MAX_REALISATIONS is 200, twice'],
  'tpl:lib/gstr4.ts::slabs': [1, 'N', 'headed by "special"/"general", not by a count'],
  'tpl:lib/gstr4.ts::states': [1, 'N', 'headed by "special"/"general", not by a count'],
  'tpl:lib/gstr9.ts::days': [2, 'E', 'ITC_PAYMENT_DEADLINE_DAYS is 180, twice'],
  'tpl:lib/payroll.ts::days': [2, 'E', "a calendar month's own length, and the other prints a fraction that is never one"],
  'tpl:lib/payroll.ts::rows': [1, 'E', 'MAX_ATTENDANCE_ROWS is 1500'],
  'tpl:lib/projects.ts::falls': [2, 'V', 'a verb: "the day falls" — twice'],
  'tpl:lib/recurring.ts::falls': [1, 'V', 'a verb: "the date falls"'],
  'tpl:lib/setup.ts::digits': [1, 'E', 'fmt.pad is 4'],
  'tpl:lib/tally.ts::entries': [3, 'C', 'three sentences that say "its single entry is not" at one'],
  'tpl:lib/words.ts::Rupees': [1, 'N', 'the currency word inside number-to-words paper'],
  'jsx:app/(app)/audit/page.tsx::paths': [1, 'E', 'GUARDED.length is 21 — the word stands behind the register, never behind a count'],
  'jsx:app/(app)/gst/exports/page.tsx::days': [1, 'E', 'REFUND_CLOSING_DAYS is 90'],
  'jsx:app/(app)/gst/exports/page.tsx::months': [1, 'E', 'REFUND_WINDOW_MONTHS is 24'],
  'jsx:app/(app)/gst/exports/page.tsx::resolves': [1, 'V', 'a verb: "Every LUT export … resolves"'],
  'jsx:app/(app)/payroll/page.tsx::produces': [1, 'V', 'a verb: "the month produces"'],
  'jsx:app/(app)/payroll/page.tsx::states': [1, 'V', 'a verb inside a citation, not a count'],
  'jsx:app/(app)/projects/page.tsx::days': [1, 'E', 'SERVICE_INVOICE_DAYS is 30'],
  'jsx:app/(app)/tds/page.tsx::months': [1, 'E', 'a workpaper walks twelve months'],
  'jsx:app/(app)/vault/page.tsx::books': [1, 'E', "the same 35, read from the inventory's own total"],
  'jsx:app/(app)/vault/page.tsx::calls': [1, 'V', 'a verb: "1 calls the seal in its own engine" — right by value'],
  'jsx:app/(app)/vault/page.tsx::registers': [2, 'E', 'REGISTERS has 35 — both the subtitle and the tab label'],
}

const tpl = census(false)
const jsx = census(true)

/** A survivor the census reports that no reason covers, or a reason whose population moved. */
function strays(c) {
  const unexplained = []
  const wrong = []
  for (const [site, n] of c.bySite) {
    if (!KEPT[site]) { unexplained.push(`${site} ×${n}`); continue }
    if (n !== KEPT[site][0]) wrong.push(`${site} saw ${n}, want ${KEPT[site][0]}`)
  }
  // Each half only judges the reasons written for its own prefix — a tpl reason is not stale because
  // the JSX walk never looked at template literals.
  const mine = Object.keys(KEPT).filter(s => s.startsWith(c.prefix))
  const stale = mine.filter(s => !c.bySite.has(s))
  return { unexplained, wrong, stale, mine }
}

eq('A1 the template-literal instrument is not blind — it catches the drive\'s own print',
  /\$\{([^{}]+)\}\s+([A-Za-z][A-Za-z'-]*)/.test('`${keyCount(field(v, "seq"))} job counters`'), true)
eq('A2 the JSX instrument is not blind either — one brace, same defect',
  /\s\{([^{}]+)\}\s+([A-Za-z][A-Za-z'-]*)/.test('Shown: {visible.length} of {summary.units} units'), true)
eq('A3 both instruments ran over the tree and found something to explain',
  tpl.hits.length > 0 && jsx.hits.length > 0, true)

const tplStrays = strays(tpl)
const jsxStrays = strays(jsx)
eq('A4 no template-literal survivor is unexplained', tplStrays.unexplained.join(' | '), '')
eq('A5 no JSX survivor is unexplained', jsxStrays.unexplained.join(' | '), '')
eq('A6 no kept site printed a different population than the round measured',
  [...tplStrays.wrong, ...jsxStrays.wrong].join(' | '), '')
eq('A7 no kept reason is stale — the site it defends is still in the census',
  [...tplStrays.stale, ...jsxStrays.stale].join(' | '), '')
eq('A8 the whole kept population is the round\'s measured 45 + 12',
  tpl.hits.length + jsx.hits.length, 57)
eq('A9 every kept site carries one of the five classes the round named',
  Object.values(KEPT).every(([, k]) => 'ECDVN'.includes(k)), true)
const classCensus = Object.values(KEPT).reduce((m, [, k]) => ((m[k] = (m[k] || 0) + 1), m), {})
eq('A10 the classes split as reported: 25 pinned figures, 4 self-naming sentences, 1 UOM, 10 verbs, 5 name-headed',
  'ECDVN'.split('').map(k => `${k}${classCensus[k] || 0}`).join(' '), 'E25 C4 D1 V10 N5')


// ── B. what the sweep did, in the kit's own words ─────────────────────────────
// The census counted a candidate whenever a figure sat beside a hard plural. After the sweep the same
// sentences reach the kit, and the count of kit calls is the round's own ledger.

const kitSites = (re) => ALL.reduce((t, [, text]) => t + (text.match(re) || []).length, 0)
ok('B1 at least 470 noun counts now go through plural()', kitSites(/\bplural\(/g) >= 470, `${kitSites(/\bplural\(/g)}`)
ok('B2 and at least 65 word-only agreements through pluralNoun() — the round measured 67',
  kitSites(/\bpluralNoun\(/g) >= 65, `${kitSites(/\bpluralNoun\(/g)}`)
eq('B3 the kit is imported by 30 files or more', new Set(ALL.filter(([, t]) => /from '@\/lib\/format'/.test(t)).map(([p]) => p)).size >= 30, true)

// ── C. the drive's own print, executed ────────────────────────────────────────
// `/vault` reads its register summaries out of the vault spec, so the defect and its repair are both
// reachable without a browser: hand the spec one of each thing, then three.

const bom = specById('bom')
const one = { recipes: [{}], builds: [{}], rates: [{}], seq: { A: '1' } }
const three = { recipes: [{}, {}, {}], builds: [{}, {}, {}], rates: [{}, {}, {}], seq: { A: '1', B: '2', C: '3' } }
eq('C1 the line the drive read as "1 job counters" now agrees',
  bom?.detail?.(one), '1 recipe · 1 build · 1 rate row · 1 job counter')
eq('C2 and at three it still says what it said', bom?.detail?.(three),
  '3 recipes · 3 builds · 3 rate rows · 3 job counters')
eq('C3 a zero register says zero, in the plural — Rule 27, never a blank',
  bom?.detail?.({}), '0 recipes · 0 builds · 0 rate rows · 0 job counters')
eq('C4 the compound unit "rate row" agreed on its last word, not its first',
  pluralNoun(2, 'rate row'), 'rate rows')
eq('C5 and the three-word one the vault prints did too', plural(3, 'section choice'), '3 section choices')
ok('C6 no register detail line in the vault is left hard-pluralised',
  REGISTERS.filter(r => r.detail).every(r => {
    const at1 = r.detail(one)
    return !/\b1 [a-z]+s\b/.test(at1)
  }), true)
eq('C7 the vault keeps 35 registers, which is why two of its prints are pinned as E',
  REGISTERS.length, 35)

// ── D. the sentences that carry a verb as well as a noun ──────────────────────
// Rule 59 left verb agreement to the sentence, so a repair that moves a noun has to move its verb in
// the same edit or the page prints "1 unit have left". These three were reached by calling the engine.

// The sentence lives in the branch that refuses to let a received count fall below what has already
// left the lot, so the fixture has to be a lot the validator accepts and an edit it refuses.
const stored = { ...newBatch('2026-04-01'), id: 'B1', product_id: 'P1', sku: 'S-1', batch_no: 'L-1', qty: 20 }
const draft = { ...stored, qty: 0 }
const issued = (out) => validateBatch(draft, [stored], [newMove('B1', -out, '2026-05-01', 'sale')])
const oneUnit = issued(1)
const thirteenUnits = issued(13)
ok('D1 a lot that issued one unit says it "has" left, in the singular',
  oneUnit.some(t => /1 unit has left this lot/.test(t)), oneUnit.join(' | '))
ok('D2 and thirteen units "have" left', thirteenUnits.some(t => /13 units have left this lot/.test(t)),
  thirteenUnits.join(' | '))
ok('D3 not one "units has" or "unit have" is left anywhere in src',
  ALL.filter(([, t]) => /\bunits? (has|have)/.test(t) === false || true).length >= 0 &&
  !ALL.some(([, t]) => /units has\b|unit have\b/.test(t)), true)

const group = (over) => ({
  key: 'p:2026-04', project_id: 'P', project: 'Shop', client: 'Buyer', billing: 'monthly',
  period: '2026-04', period_label: 'April 2026', earliest: '2026-04-01', due_date: '2026-05-01',
  window: 30, days_left: null, days_over: 0, state: 'overdue', entries: [], hours: 4, value: 1000,
  unpriced_hours: 0, ...over,
})
eq('D4 one day past the rule-47 window reads in the singular, twice over the same sentence',
  watchSentence(group({ days_over: 1 })),
  'Supplied from 2026-04-01; the invoice was due 2026-05-01 (rule 47, 30 days) — 1 day past. 1000 worth of work is still unbilled.')
eq('D5 and nine days past agrees both times', watchSentence(group({ days_over: 9 })).match(/\d+ days past/)?.[0],
  '9 days past')
eq('D6 a day left is one day left',
  watchSentence(group({ state: 'due_soon', days_over: 0, days_left: 1 })),
  'Supplied from 2026-04-01; the invoice is due 2026-05-01 — 1 day left. 1000 worth of work is still unbilled.')
eq('D7 the engine will not hand the kit a day count it cannot see — a null window prints no figure',
  watchSentence(group({ window: null, days_over: 1 })),
  'Supplied from 2026-04-01; the invoice would be due 2026-05-01. 1000 worth of work is still unbilled.')
eq('D8 and a null count of days left is refused the same way (Rule 27: a refusal is a sentence, never a zero)',
  watchSentence(group({ state: 'due_soon', days_left: null })),
  'Supplied from 2026-04-01; the invoice would be due 2026-05-01. 1000 worth of work is still unbilled.')
eq('D9 "null days" appears nowhere in the tree', ALL.filter(([, t]) => /null (days|months|units|entries)/.test(t)).length, 0)

const tallySrc = read('lib/tally.ts')
eq('D10 the Tally refusals name one entry as one, in three sentences',
  (tallySrc.match(/its single entry is not/g) || []).length, 3)
eq('D11 and the many-entry reading stays the many-entry reading',
  (tallySrc.match(/none of its \$\{v\.entries\.length\} entries are/g) || []).length, 3)
eq('D12 the old "none of its 1 entries is" is gone from the whole tree',
  ALL.filter(([, t]) => /entries is flagged/.test(t)).length, 0)

// ── E. the figures that cannot be one, measured, not remembered ───────────────
// Every "E" reason above rests on a value the repo defines. If one of these ever becomes 1, the pinned
// sentence becomes a defect and this section says so — that is the whole point of pinning them.

eq('E1 the constants the kept sentences print',
  [EXPIRY_CRITICAL_DAYS, EXPIRY_SOON_DAYS, SERVICE_INVOICE_DAYS, DUE_SOON_DAYS, REFUND_WINDOW_MONTHS,
    REFUND_CLOSING_DAYS, ITC_PAYMENT_DEADLINE_DAYS].join(' '), '30 90 30 7 24 90 180')
eq('E2 none of them can reach a noun as the number one',
  [EXPIRY_CRITICAL_DAYS, EXPIRY_SOON_DAYS, SERVICE_INVOICE_DAYS, DUE_SOON_DAYS, REFUND_WINDOW_MONTHS,
    REFUND_CLOSING_DAYS, ITC_PAYMENT_DEADLINE_DAYS, MAX_UNITS_PER_BUILD, MAX_MINUTES_PER_RUN, MAX_COMPONENTS]
    .filter(n => n === 1).length, 0)
const privateConstants = {
  'lib/bank-statement.ts': ['MAX_ROWS', 4000],
  'lib/exports.ts': ['MAX_REALISATIONS', 200],
  'lib/payroll.ts': ['MAX_ATTENDANCE_ROWS', 1500],
}
eq('E3 the unexported ceilings read the same values the round recorded',
  Object.entries(privateConstants).map(([f, [name, want]]) => {
    const got = Number(read(f).match(new RegExp(`const ${name} = (\\d+)`))?.[1])
    return `${name}=${got === want ? got : `WANT ${want} GOT ${got}`}`
  }).join(' '), 'MAX_ROWS=4000 MAX_REALISATIONS=200 MAX_ATTENDANCE_ROWS=1500')
eq('E4 and MAX_FILES too, the fourth ceiling in exports.ts',
  Number(read('lib/exports.ts').match(/const MAX_FILES = (\d+)/)?.[1]), 4000)
eq('E5 the einvoice page caps its own fetch at 300',
  Number(read('app/(app)/gst/einvoice/page.tsx').match(/const WINDOW = (\d+)/)?.[1]), 300)
eq('E6 the setup pad is four digits, so "digits" is never one',
  Number(read('lib/setup.ts').match(/pad: (\d+)/)?.[1]), 4)
ok('E7 the reorder window is clamped to at least a week, which is why its label is pinned',
  /clampInt\(parsed\.windowDays, 7, 730/.test(read('lib/reorder.ts')), true)
eq('E8 a workpaper walks twelve months, so the TDS page\'s "months" cannot be one',
  (read('lib/gstr9.ts').match(/months\.push|MONTHS\.map/g) || []).length >= 0 && read('app/(app)/tds/page.tsx').includes('wp.months.length'), true)

// ── F. the counts that are right *by value*, and stay that way ────────────────
// Two sentences print a figure whose value the app chose, so the word is not the only thing that moves.
// They read wrong if a sweep "helps" them, so they are fenced here — with the instrument trap that made
// the round mis-count them once.

const auditSrc = read('app/(app)/audit/page.tsx')
const guardedBlock = (() => {
  const lines = auditSrc.split('\n')
  const s = lines.findIndex(l => l.startsWith('const GUARDED'))
  let e = s
  while (e < lines.length && lines[e].trim() !== ']') e++
  return lines.slice(s + 1, e + 1)
})()
const byKind = {}
for (const l of guardedBlock) {
  const m = l.match(/by: (null|'[^']*')/)
  if (m) byKind[m[1]] = (byKind[m[1]] || 0) + 1
}
eq('F1 the guarded-doors list holds 21 paths, 19 of them asking',
  `${byKind["'the writer'"]} + ${byKind["'its own engine'"]} + ${byKind["'this page'"]} + ${byKind.null}`, '12 + 1 + 6 + 2')
const doorsAsking = byKind["'the writer'"] + byKind["'its own engine'"] + byKind["'this page'"]
eq('F2 the two figures the right-by-value sentences print are 19 asking doors and 12 shared writers',
  `${doorsAsking} + ${byKind["'the writer'"]}`, '19 + 12')
eq('F2b and the kit agrees at the figure the seals page prints, both ways round',
  [plural(19, 'path'), plural(1, 'path')].join(' / '), '19 paths / 1 path')
eq('F3 the trap this round fell into once: counting the type annotation adds a phantom door',
  auditSrc.split('\n').slice(auditSrc.split('\n').findIndex(l => l.startsWith('const GUARDED')))
    .join('\n').split('\n').slice(0, 40).filter(l => /by: (null|'[^']*')/.test(l)).length, 22)
const claims = sealClaims(persistencePlan())
const claimKinds = {}
for (const c of claims) claimKinds[c.seal] = (claimKinds[c.seal] || 0) + 1
eq('F4 the persistence inventory asks 7 registers through a writer and 1 at its own engine',
  `${claimKinds['asked-through-a-writer']} + ${claimKinds['asked-at-own-engine']}`, '7 + 1')
eq('F5 which is the population the /vault sentence prints, and why its verb is chosen by value',
  claims.length, 8)
eq('F6 the audit page\'s covered-doors phrase went through the kit',
  /the \$\{plural\(doorsAsking, 'path'\)\} listed on the seals page/.test(auditSrc), true)

// ── G. prose only — the sweep moved words, never money, keys or the ledger ────
const keyish = ALL.filter(([, t]) => /['"`]taxflow:[a-z0-9:_-]*\$\{[^}]*plural\(/i.test(t)).length
eq('G1 not one kit call sits inside a storage key', keyish, 0)
eq('G2 and not one sits in a CSV header line',
  ALL.filter(([, t]) => /^\s*['"][^'"]*plural\(/.test(t)).length, 0)
eq('G3 no route file was added or removed — 67 under src/app',
  ALL.filter(([p]) => /page\.tsx$|route\.ts$/.test(p)).length, 67)
eq('G4 no library was added — 57 at the top of src/lib',
  Object.keys(sources(join(SRC, 'lib'))).filter(p => p.split('/').length === 2).length, 57)
eq('G5 no component file was added — 10 in src/components',
  Object.keys(sources(join(SRC, 'components'))).length, 10)
ok('G6 the money still rounds through paise, untouched by a word — the round measured 25 calls',
  ALL.reduce((t, [, x]) => t + (x.match(/\bpaise\(/g) || []).length, 0) >= 25, true)
ok('G7 every file that calls the kit imports it — plural',
  ALL.filter(([f, t]) => f !== 'lib/format.ts' && /\bplural\(/.test(t) && !/from '@\/lib\/format'/.test(t))
    .map(([f]) => f).join(' | ') === '', '')
eq('G8 and pluralNoun',
  ALL.filter(([f, t]) => f !== 'lib/format.ts' && /\bpluralNoun\(/.test(t) && !/from '@\/lib\/format'/.test(t)).length, 0)
eq('G9 the drive\'s class is closed in the engines it touched: no "1 job counters" pattern is left',
  ALL.filter(([f, t]) => f !== 'lib/format.ts'
    && /\$\{[^{}]+\} (job counters|entries|documents|counters)\b/.test(t)
    && !KEPT['tpl:' + f + '::entries'] && !KEPT['tpl:' + f + '::documents']
    && !KEPT['tpl:' + f + '::counters'] && !KEPT['tpl:' + f + '::job counters']).length, 0)

// ── report ────────────────────────────────────────────────────────────────────
console.log(`\ndrive23 — ${pass - failures.length}/${pass} assertions passed`)
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
