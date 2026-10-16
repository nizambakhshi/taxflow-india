// R3-17 — the work-in-progress suite.
//
// §8 #10 carried one clause after R2-28: *no WIP posting — the labour and overhead legs are
// readings, not journal entries*. The blocker it named was a posting engine, and `/journal`
// shipped. This round turns a built run's cost into the journal's own drafts through `src/lib/wip.ts`,
// and this suite is the fence around the arithmetic and the refusals: every entry the engine plans
// must balance in paise, the pair must net Work-in-progress to nothing, every refusal sentence must
// be reachable from a named hole in the shop's data, and the page must keep its side of the bargain —
// it proposes heads, it never creates them, and it writes only through `writeEntry`.
//
// Run from the repo root:
//   /Users/mohdnizam/.nvm/versions/node/v24.21.0/bin/node --experimental-strip-types --no-warnings \
//     --import ./tests/register.mjs ./tests/wip17.test.mjs

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paise, SLOT_META } from '@/lib/journal'
import {
  ROLE_META, WIP_BOUNDARIES, WIP_ROLES, emptyPicks, headFitsRole, roleSlots,
  wipCancelNote, wipPaper, wipPickerHints, wipPlan,
} from '@/lib/wip'

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
// One shop, one recipe, one rate row in force. Numbers chosen so every leg is exact in paise:
// material 120.50 × 5 = 602.50, labour 60 min at 300/hr = 300.00, overhead 30 min at 100/hr = 50.00.

const products = [
  { id: 'choc', name: 'Chocolate', unit: 'kg', purchase_price: 120.5, selling_price: 400, track_inventory: true, current_stock: 40 },
  { id: 'box', name: 'Gift box', unit: 'pc', purchase_price: null, selling_price: null, track_inventory: true, current_stock: 100 },
  { id: 'tray', name: 'Festive tray', unit: 'pc', purchase_price: null, selling_price: 600, track_inventory: true, current_stock: 0 },
]

const recipe = {
  id: 'rec1', name: 'Festive tray, 10 pcs', output_product_id: 'tray', output_qty: 10,
  status: 'active', notes: '', components: [
    { id: 'c1', product_id: 'choc', qty_per_unit: 0.5 },
    { id: 'c2', product_id: 'box', qty_per_unit: 1 },
  ],
  labour_minutes: 60, overhead_minutes: 30, created_at: '2026-04-01 09:00',
}

const rates = [{ id: 'rate1', from_date: '2026-04-01', labour_per_hour: 300, overhead_per_hour: 100, note: 'festival season rates' }]

const built = {
  id: 'b1', ref: 'JOB-2026-27-0001', recipe_id: 'rec1', date: '2026-10-05', units: 10,
  status: 'built', lines: [{ product_id: 'choc', qty: 5 }], moved: true, notes: '', created_at: '2026-10-05 18:00',
}

const head = (id, name, slot, active = true) => ({ id, name, slot, active, notes: '', created_at: '', updated_at: '' })
const wipHeads = [
  head('h-wip', 'Work-in-progress', 'inventory'),
  head('h-raw', 'Raw stock', 'inventory'),
  head('h-fin', 'Finished goods', 'inventory'),
  head('h-wages', 'Wages', 'expense'),
  head('h-closed', 'Old workshop', 'inventory', false),
  head('h-bank', 'Bank', 'bank'),
]
const journalStore = { version: 1, updatedAt: '', orgId: 'org', heads: wipHeads, entries: [], seq: {} }

const fullPicks = { wip: 'h-wip', raw: 'h-raw', finished: 'h-fin', time: 'h-wages' }
const materialOnlyPicks = { wip: 'h-wip', raw: 'h-raw', finished: 'h-fin', time: '' }

const entry = (reference, status, number = '') => ({
  id: `e-${reference}-${status}-${pass}`, number, date: '2026-10-05', narration: 'x', reference,
  legs: [], status, posted_at: '', reversed_by: '', reverses: '', actor: '', created_at: '', updated_at: '',
})

// ── A. the roles, and what fits them ─────────────────────────────────────────

eq('four roles, time last', WIP_ROLES.join(','), 'wip,raw,finished,time')
ok('three required, one optional', WIP_ROLES.filter(r => ROLE_META[r].required).length === 3 && !ROLE_META.time.required)
ok('the three stock roles move the Stock-on-hand line', ['wip', 'raw', 'finished'].every(r => ROLE_META[r].slot === 'inventory' && SLOT_META.inventory.group === 'asset'))
eq('the time role is an expense role', ROLE_META.time.slot, 'expense-group')
ok('emptyPicks picks nothing, incl. time', JSON.stringify(emptyPicks()) === JSON.stringify({ wip: '', raw: '', finished: '', time: '' }))
ok('an inventory head fits wip', headFitsRole(wipHeads[0], 'wip'))
ok('an inventory head does not fit time', !headFitsRole(wipHeads[0], 'time'))
ok('an expense head fits time', headFitsRole(wipHeads[3], 'time'))
ok('an expense head does not fit raw', !headFitsRole(wipHeads[3], 'raw'))
ok('a bank head fits nothing here', !headFitsRole(wipHeads[5], 'wip') && !headFitsRole(wipHeads[5], 'time'))
ok('no head at all fits nothing', !headFitsRole(undefined, 'wip'))
eq('roleSlots for wip is just inventory', roleSlots('wip', Object.keys(SLOT_META)).join(','), 'inventory')
ok('roleSlots for time is every expense-group slot', roleSlots('time', Object.keys(SLOT_META)).every(s => SLOT_META[s].group === 'expense') && roleSlots('time', Object.keys(SLOT_META)).includes('purchases'))
eq('the picker hints name the four asks in order', wipPickerHints().length, 4)
ok('the time hint refuses a blind expense pick', wipPickerHints()[3].includes('never raised'))

// ── B. the pair, capitalising shop time ──────────────────────────────────────

const both = wipPlan(built, recipe, products, rates, fullPicks, journalStore)
eq('no refusals for a complete run', both.refusals.length, 0)
eq('the material rupee is read', both.material, 602.5)
eq('the labour rupee is read', both.labour, 300)
eq('the overhead rupee is read', both.overhead, 50)
eq('the run entry exists', !!both.run, true)
eq('the finish entry exists', !!both.finish, true)
eq('the run debits WIP the whole cost', both.run.total, 952.5)
eq('the finish hands on the same rupee', both.finish.total, 952.5)
eq('the run is three legs', both.run.legs.length, 3)
eq('the finish is two legs', both.finish.legs.length, 2)
ok('run balances in paise', both.run.legs.filter(l => l.side === 'debit').reduce((s, l) => s + paise(l.amount), 0)
  === both.run.legs.filter(l => l.side === 'credit').reduce((s, l) => s + paise(l.amount), 0))
eq('the run is self-declared balanced', both.run.balanced, true)
eq('the finish is self-declared balanced', both.finish.balanced, true)
eq('the raw credit is the material alone', both.run.legs.find(l => l.role === 'raw').amount, 602.5)
eq('the time credit is the shop minutes', both.run.legs.find(l => l.role === 'time').amount, 350)
ok('WIP nets to nil across the pair', paise(both.run.legs.find(l => l.role === 'wip').amount)
  === paise(both.finish.legs.find(l => l.side === 'credit').amount))
eq('the pair nets as the engine says', both.wip_nets, 'nil')
eq('both entries dated the run', both.run.date === built.date && both.finish.date === built.date, true)
eq('both entries carry the job number', both.run.reference === built.ref && both.finish.reference === built.ref, true)
ok('the run narration names WIP', both.run.narration.includes('work-in-progress'))
ok('the finish narration names the run', both.finish.narration.includes(built.ref))
ok('every leg names a head that stands on the register', [...both.run.legs, ...both.finish.legs]
  .every(l => journalStore.heads.some(h => h.id === l.headId)))
ok('every leg carries the sentence it was read from', [...both.run.legs, ...both.finish.legs].every(l => l.basis.length > 10))
eq('the time leg basis names both halves', both.run.legs.find(l => l.role === 'time').basis.includes('labour') && both.run.legs.find(l => l.role === 'time').basis.includes('overhead'), true)

// ── C. the pair without capitalising shop time ───────────────────────────────

const material = wipPlan(built, recipe, products, rates, materialOnlyPicks, journalStore)
eq('no refusals without the time head', material.refusals.length, 0)
eq('the run is two legs then', material.run.legs.length, 2)
eq('material-only totals the material', material.run.total, 602.5)
eq('capitalise_time says false', material.capitalise_time, false)
ok('the time note calls it a reading', material.time_note.includes('stays a reading'))
eq('the pair still nets nil', material.wip_nets, 'nil')

// ── D. a float tail cannot split the two sides ───────────────────────────────

const tailBuild = { ...built, lines: [{ product_id: 'choc', qty: 3 }], units: 2 }
const tailPicks = { ...materialOnlyPicks }
const priced = products.map(p => (p.id === 'choc' ? { ...p, purchase_price: 8.35 } : p))
const tail = wipPlan(tailBuild, recipe, priced, rates, tailPicks, journalStore)
eq('8.35 × 3 reads as 25.05', tail.material, 25.05)
ok('both sides of the debit are the same paise', paise(tail.run.total) === paise(tail.run.legs.find(l => l.side === 'credit').amount))

// ── E. every refusal is reachable, in its own sentence ───────────────────────

const planned = wipPlan({ ...built, status: 'planned' }, recipe, products, rates, fullPicks, journalStore)
ok('a plan is refused — nothing consumed yet', planned.refusals.some(f => f.includes('still a plan')))
eq('a plan plans nothing', planned.run, null)
const cancelled = wipPlan({ ...built, status: 'cancelled' }, recipe, products, rates, fullPicks, journalStore)
ok('a cancelled run is refused', cancelled.refusals.some(f => f.includes('was cancelled')))
const unmoved = wipPlan({ ...built, moved: false }, recipe, products, rates, fullPicks, journalStore)
ok('built-but-never-written is refused', unmoved.refusals.some(f => f.includes('never reached the stock ledger')))
const unpriced = wipPlan({ ...built, lines: [{ product_id: 'choc', qty: 5 }, { product_id: 'box', qty: 10 }] }, recipe, products, rates, fullPicks, journalStore)
ok('an unpriced component names itself', unpriced.refusals.some(f => f.includes('Gift box') && f.includes('A posting never invents one')))
eq('an unpriced run plans nothing', unpriced.wip_nets, 'not_planned')
const noRate = wipPlan(built, recipe, products, [], fullPicks, journalStore)
ok('a time leg with no rate in force is refused', noRate.refusals.some(f => f.includes('the labour leg has no rate')))
const noMinutes = wipPlan(built, { ...recipe, labour_minutes: 0, overhead_minutes: 0 }, products, rates, fullPicks, journalStore)
ok('zero minutes with a time head is refused', noMinutes.refusals.some(f => f.includes('no minutes')))
const bare = wipPlan(built, recipe, products, rates, emptyPicks(), journalStore)
eq('the three required asks all print', bare.refusals.filter(f => f.includes('/journal')).length, 3)
const ghost = wipPlan(built, recipe, products, rates, { ...fullPicks, wip: 'no-such-head' }, journalStore)
ok('a pick off the register is refused', ghost.refusals.some(f => f.includes('not on the journal register')))
const closed = wipPlan(built, recipe, products, rates, { ...fullPicks, raw: 'h-closed' }, journalStore)
ok('a closed head is refused its new rupee', closed.refusals.some(f => f.includes('is closed')))
const wrongSlot = wipPlan(built, recipe, products, rates, { ...fullPicks, wip: 'h-wages' }, journalStore)
ok('a slot mismatch is refused with the slot named', wrongSlot.refusals.some(f => f.includes('Stock-on-hand')))
const doubled = wipPlan(built, recipe, products, rates, { ...fullPicks, raw: 'h-wip' }, journalStore)
ok('one head across the pair is refused', doubled.refusals.some(f => f.includes('hand a rupee to itself')))
const zero = wipPlan({ ...built, lines: [] }, recipe, products, rates, materialOnlyPicks, journalStore)
ok('a no-rupee run is refused before the journal sees it', zero.refusals.some(f => f.includes('no rupee at all')))
const noRecipe = wipPlan(built, undefined, products, rates, materialOnlyPicks, journalStore)
eq('a run whose recipe left still plans on its own drawn lines', noRecipe.run && noRecipe.run.total, 602.5)

// ── F. the tie back: what the journal already holds ──────────────────────────

const paper0 = wipPaper(journalStore, built.ref)
eq('a fresh register holds nothing', paper0.state, 'none')
eq('and says so', paper0.entries.length, 0)
const storeDrafts = { ...journalStore, entries: [entry(built.ref, 'draft'), entry(built.ref, 'draft')] }
eq('two drafts read as drafted', wipPaper(storeDrafts, built.ref).state, 'drafted')
ok('the drafted note sends the shop to post', wipPaper(storeDrafts, built.ref).note.includes('post them'))
const storePosted = { ...journalStore, entries: [entry(built.ref, 'posted', 'JR-0001'), entry(built.ref, 'posted', 'JR-0002')] }
eq('two posted read as posted', wipPaper(storePosted, built.ref).state, 'posted')
ok('the posted note counts the pair', wipPaper(storePosted, built.ref).note.includes('nets WIP to nothing'))
const storeHalf = { ...journalStore, entries: [entry(built.ref, 'posted', 'JR-0001'), entry(built.ref, 'draft')] }
eq('one posted and one draft read as partial', wipPaper(storeHalf, built.ref).state, 'partial')
const storeRev = { ...journalStore, entries: [entry(built.ref, 'reversed'), entry(built.ref, 'posted', 'JR-0001')] }
eq('any reversed row reads as reversed', wipPaper(storeRev, built.ref).state, 'reversed')
ok('a different job number never counts', wipPaper(storePosted, 'JOB-2026-27-9999').state, 'none')

eq('a run with no paper gets no cancel note', wipCancelNote(paper0), '')
ok('a cancelled run with drafts is told to delete them', wipCancelNote(wipPaper(storeDrafts, built.ref)).includes('Delete them on /journal'))
ok('a cancelled run with postings is told to reverse', wipCancelNote(wipPaper(storePosted, built.ref)).includes('reverse them on /journal'))
ok('a half-reversed posting is named as standing paper', wipCancelNote(wipPaper({ ...journalStore, entries: [entry(built.ref, 'posted', 'JR-0001'), entry(built.ref, 'posted', 'JR-0002'), entry(built.ref, 'reversed')] }, built.ref)).includes('only part'))
eq('a fully reversed pair closes the note — the trail needs no nagging', wipCancelNote(wipPaper({ ...journalStore, entries: [entry(built.ref, 'reversed'), entry(built.ref, 'posted', 'JR-0003')] }, built.ref)), '')

// ── G. the boundaries, and the page's side of the bargain ────────────────────

eq('five boundaries', WIP_BOUNDARIES.length, 5)
ok('they say these are drafts first', WIP_BOUNDARIES[0].includes('drafts until you post'))
ok('they name the seal as the build date’s own door', WIP_BOUNDARIES[1].includes('sealed period'))
ok('they warn the time credit cannot shrink a phantom expense', WIP_BOUNDARIES[2].includes('never raised'))
ok('they own the today-price reading', WIP_BOUNDARIES[3].includes('no price history'))
ok('they promise no filing', WIP_BOUNDARIES[4].includes('no return reads a journal row'))

const page = readFileSync(join(ROOT, 'src/app/(app)/inventory/recipes/page.tsx'), 'utf8')
ok('the page reads the engine', page.includes("from '@/lib/wip'"))
ok('the page writes only through the journal door', page.includes('writeEntry(orgId, entry, orgName)'))
ok('the page never creates a head', !page.includes('writeHead') && !page.includes('upsertHead'))
ok('the drafts are status draft', page.includes("status: 'draft' as const"))
ok('the drafts carry the job number as reference', page.includes('reference: p.reference'))
ok('the page links the paper back to /journal?q=', page.includes('/journal?q=${encodeURIComponent(r.build.ref)}'))
ok('the page dates the entries the run, not today', page.includes('...newEntry(p.date)'))
ok('the header records the round', page.includes('since R3-17'))
const wipSrc = readFileSync(join(ROOT, 'src/lib/wip.ts'), 'utf8')
ok('the engine never touches storage', !wipSrc.includes('localStorage') && !wipSrc.includes('saveJournal'))
ok('the engine never asks the seal itself — the door does', !wipSrc.includes('askSeal') && !wipSrc.includes('stopForSeal'))

// ── the verdict ───────────────────────────────────────────────────────────────

console.log(`${pass - failures.length}/${pass} assertions passed`)
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`)
  process.exit(1)
}
