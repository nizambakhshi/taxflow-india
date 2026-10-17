// R3-21 — the seal keeps a photograph of the window it closed.
//
// R3-19 printed its own first boundary sentence: *nothing in this app stores what a period contained
// at the moment it was sealed*, so a sealed window's figures were always *today's* reading of it. That
// is a limitation written on a card, and a limitation on a card is a task (Rule 57's shelf-life clause;
// the same shape as R3-14 lifting its own boundary as an amendment rather than crossing it). R3-21
// makes the close reading's figures travel onto the seal as a **photograph** and prints *as sealed*
// against *as read today*, with the drift between them.
//
// What this suite is the fence around:
//   * the snapshot is drawn by **spread** from the reading, so a field added to the reading later
//     cannot silently fail to appear in the picture (A);
//   * the seal record still belongs to `audit.ts` — the page hands a figure over, the engine decides
//     whether it may be kept, and refuses a picture that captions a window it did not read (B, Rule 54);
//   * a photograph this register cannot read is *unreadable*, never *absent*, and never a zero (C, Rule 27);
//   * a comparison is only drawn between two figures that both exist — money withheld when either side
//     was never fetched, paper lines always drawn, findings matched by their own key (D);
//   * the file a CA takes says which columns were photographed and which are blank (E);
//   * and the page keeps its half of the bargain, with the ledger unmoved by a single line (F/G).
//
// Run from the repo root:
//   /Users/mohdnizam/.nvm/versions/node/v24.21.0/bin/node --experimental-strip-types --no-warnings \
//     --import ./tests/register.mjs ./tests/seal21.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLOSE_BOUNDARIES, CLOSE_CSV_HEADERS, closeCsvRows, closeDrift, closeReading, sealSnapshotOf,
} from '@/lib/period-close'
import { loadAudit, saveAudit, sealPeriod, sealCsvRows, SEAL_CSV_HEADERS } from '@/lib/audit'

const ROOT = join(import.meta.dirname, '..')

let pass = 0
const failures = []
function ok(name, cond, detail = '') {
  pass += 1
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

// ── the register's own storage, faked only as far as the engine reaches ────────
// `loadAudit`/`saveAudit` guard on `typeof window`, so a bare `window.localStorage` is the whole stub.
// It is installed deliberately: the point of section C is what survives an actual save.
const mem = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  },
}

// ── one shop, one ended month, three things still moving ──────────────────────
// Deliberately the same shape `close19` argues about: a paise tail on an invoice and a bill, a
// draft, a convertible challan and an unfiled return, so a photograph has findings of its own.
const TODAY = '2026-10-17'
const MONTH = '2026-09'

const invoice = (status, invoice_date, taxable_amount, balance_due) =>
  ({ status, invoice_date, taxable_amount, total_tax: 0, balance_due })
const bill = (status, bill_date, taxable_amount) =>
  ({ status, bill_date, taxable_amount, total_tax: 0, itc_eligible: true, balance_due: 0 })
const expense = (expense_date, taxable_amount, amount, gst_amount, category) =>
  ({ expense_date, taxable_amount, amount, gst_amount, itc_eligible: true, payment_status: 'paid', category })
const payment = (payment_type, payment_date, amount) => ({ payment_type, payment_date, amount })

const docs = {
  invoices: [invoice('issued', '2026-09-05', 1000, 300), invoice('issued', '2026-09-20', 500.25, 0.1)],
  bills: [bill('issued', '2026-09-08', 400)],
  expenses: [expense('2026-09-11', 100, 118, 18, 'Electricity')],
  payments: [payment('received', '2026-09-30', 300)],
}

const head = (id, name, slot) => ({ id, name, slot, active: true, notes: '', created_at: '', updated_at: '' })
const leg = (id, head_id, side, amount) => ({ id, head_id, side, amount, note: '' })
const jEntry = (id, number, date, status, legs) =>
  ({ id, number, date, narration: 'n', reference: '', legs, status, posted_at: '', reversed_by: '', reverses: '', actor: '', created_at: '', updated_at: '' })

const jHeads = [head('h-rent', 'Rent', 'expense'), head('h-bank', 'Bank', 'bank')]
const journal = {
  version: 1, updatedAt: '', orgId: 'org', heads: jHeads, seq: {},
  entries: [
    jEntry('e-in', 'JV-0001', '2026-09-15', 'posted', [leg('l1', 'h-rent', 'debit', 500), leg('l2', 'h-bank', 'credit', 500)]),
    jEntry('e-draft', '', '2026-09-10', 'draft', [leg('l5', 'h-rent', 'debit', 40), leg('l6', 'h-bank', 'credit', 40)]),
  ],
}
const journalClean = { ...journal, entries: journal.entries.filter(e => e.status !== 'draft') }

const flowLine = (quantity, rate) =>
  ({ product_id: null, item_name: 'x', hsn_sac: '6109', quantity, unit: 'pc', rate, discount_percent: 0, gst_rate: 0, cess_rate: 0 })
const flowDoc = (id, kind, doc_date, status) =>
  ({ id, kind, number: id, doc_date, due_date: '', party_id: null, party_name: 'p', party_gstin: '', party_address: '', party_state: '', place_of_supply: '', supply_type: 'forward', reason: '', vehicle_number: '', transporter: '', eway_bill_number: '', lines: [flowLine(4, 250)], status, notes: '', created_at: '', converted_to_id: null, converted_to_number: null, converted_at: null })
const flow = [flowDoc('DC-1', 'challan', '2026-09-28', 'active')]

const filing = (form, period, status) => ({
  id: `f-${form}-${period}`, form, period,
  period_kind: period.includes('Q') ? 'quarter' : /^\d{4}$/.test(period) ? 'year' : 'month',
  status, due: '', due_reason: '', filed_on: '', reference: '',
  heads: { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, tax: 0 },
  tax_paid_on: '', late_fee_paid: 0, interest_paid: 0, unpaid_intimation: 0,
  notes: '', actor: '', history: [], created_at: '', updated_at: '',
})
const filings = [filing('gstr1', '2026-09', 'not_filed')]

const auditEmpty = { version: 1, updatedAt: '', orgId: 'org', seals: [], events: [] }

const read = (over = {}) => closeReading({
  month: MONTH, today: TODAY, documents: docs, journal, flow, filings, audit: auditEmpty, ...over,
})

const sealRow = (over = {}) => ({
  id: 's1', kind: 'month', period: '2026-09', from: '2026-09-01', to: '2026-09-30', label: 'September 2026',
  note: '', sealed_at: '2026-10-03T09:12:00.000Z', sealed_by: 'Nizam', released_at: null, release_reason: '',
  snapshot: null, snapshot_unreadable: false, ...over,
})

// The reading every section below photographs: an ended month, three findings, nothing unread.
const base = read()
eq('the fixture really does leave three things unfinished', base.findings.map(f => f.key).join(','),
  'journal-drafts,unconverted-papers,returns-unfiled')
eq('and read every register it was handed', base.unread.length, 0)

// ── A. the photograph is a spread of the reading, not a summary of it ─────────

const photo = sealSnapshotOf(base)

eq('the picture names the window it was taken of', photo.month, base.window.month)
eq('and the day it was taken, because a photograph is dated or it is nothing', photo.taken_on, base.window.today)
eq('it keeps the reading’s own verdict word', photo.state, base.state)
eq('and the sentence that verdict was printed as', photo.headline, base.headline)
eq('every money key the reading holds is photographed', Object.keys(photo.money).join('|'), Object.keys(base.money).join('|'))
eq('every count key the reading holds is photographed', Object.keys(photo.counts).join('|'), Object.keys(base.counts).join('|'))
eq('and each of those keys carries the reading’s own number, to the paise',
  Object.keys(base.money).every(k => photo.money[k] === base.money[k]), true)
eq('the counts too', Object.keys(base.counts).every(k => photo.counts[k] === base.counts[k]), true)
ok('a figure with paise in it is not rounded on the way in', photo.money.revenue === 1500.25, String(photo.money.revenue))
eq('a finding keeps its key, its label, its count and its money',
  JSON.stringify(photo.findings), JSON.stringify(base.findings.map(f => ({ key: f.key, label: f.label, count: f.count, amount: f.amount }))))
ok('and each finding keeps the key the drift will match on',
  photo.findings.every((f, i) => f.key === base.findings[i].key))
ok('the finding’s rupee travels with it', photo.findings.some(f => f.amount > 0))
eq('the unread list is copied, not shared — the reading may move later', photo.unread === base.unread, false)
eq('the money object is copied too', photo.money === base.money, false)
eq('and the findings array is a new array of new rows',
  [photo.findings === base.findings, photo.findings[0] === base.findings[0]].join('/'), 'false/false')
eq('a reading taken without three registers photographs that fact',
  sealSnapshotOf(read({ journal: null, flow: null, filings: null })).unread.join(','),
  'the journal,the order registers,the filings register')
ok('and the picture of an un-fetched window says its money was never loaded',
  sealSnapshotOf(read({ documents: null })).money.loaded === false)
eq('a photograph carries the reading’s `loaded` flag, not a guessed one',
  typeof sealSnapshotOf(base).money.loaded, 'boolean')

// ── B. the page may hand a figure over; the seal is the engine's to build ─────

const snap = (over = {}) => sealSnapshotOf(read(over))

const wrongKind = sealPeriod('orgA', { kind: 'year', year: 2025, note: '', actor: 'Nizam', snapshot: snap() }, TODAY)
eq('a month’s photograph cannot caption a year seal', wrongKind.ok, false)
ok('and the refusal is a sentence, not a code', wrongKind.why.includes('cannot caption a year'), wrongKind.why)
ok('it tells the shop which of the two to change', wrongKind.why.includes('seal the month'), wrongKind.why)

const wrongMonth = sealPeriod('orgB', { kind: 'month', month: '2026-08', actor: 'Nizam', snapshot: snap() }, TODAY)
eq('a figure must not be sealed under a period it did not read', wrongMonth.ok, false)
ok('the refusal names both windows', /2026-09/.test(wrongMonth.why) && /2026-08/.test(wrongMonth.why), wrongMonth.why)

eq('and neither refusal wrote a seal', loadAudit('orgA').seals.length, 0)
eq('nor a line on the trail', loadAudit('orgA').events.length, 0)

const withPhoto = sealPeriod('orgC', { kind: 'month', month: '2026-09', note: 'monthly close', actor: 'Nizam', snapshot: snap() }, TODAY)
eq('the right window and the right picture are accepted', withPhoto.ok, true)
const kept = withPhoto.store.seals[0]
ok('the seal carries the photograph', kept.snapshot !== null)
eq('it is the same picture, key for key', JSON.stringify(kept.snapshot), JSON.stringify(snap()))
eq('a readable picture is not stamped unreadable', kept.snapshot_unreadable, false)
ok('the trail says the figures were kept, and dates the keeping',
  withPhoto.store.events.some(e => e.note.includes("the period's figures were kept as they stood on")
    && e.note.includes(TODAY)),
  JSON.stringify(withPhoto.store.events.map(e => e.note)))

const bare = sealPeriod('orgD', { kind: 'month', month: '2026-09', actor: 'Nizam' }, TODAY)
eq('a seal from the Seals tab still seals — the photograph is optional, not required', bare.ok, true)
eq('and it keeps no picture', bare.store.seals[0].snapshot, null)
eq('a seal that never had one is not marked unreadable', bare.store.seals[0].snapshot_unreadable, false)
ok('its trail line promises no photograph',
  !bare.store.events[bare.store.events.length - 1].note.includes('figures were kept'),
  bare.store.events[bare.store.events.length - 1].note)

const stillRunning = sealPeriod('orgE', { kind: 'month', month: '2026-10', actor: 'Nizam', snapshot: sealSnapshotOf(read({ month: '2026-10' })) }, TODAY)
eq('a picture does not unlock a window that has not ended', stillRunning.ok, false)
ok('and the date rule refuses it first', stillRunning.why.includes('A period is sealed only once it has ended'), stillRunning.why)
eq('a refused seal wrote nothing to storage either', loadAudit('orgE').seals.length, 0)

const overlap = (() => {
  const first = sealPeriod('orgF', { kind: 'month', month: '2026-09', actor: 'Nizam', snapshot: snap() }, TODAY)
  const second = sealPeriod('orgF', { kind: 'month', month: '2026-09', actor: 'Nizam', snapshot: snap() }, TODAY)
  return { first, second }
})()
eq('the seal that stands was laid first, or the refusal below proves nothing', overlap.first.ok, true)
eq('a second seal on the same window is refused, photograph or not', overlap.second.ok, false)
ok('and it is refused by the overlap rule, not the picture rule', overlap.second.why.includes('overlaps a seal already standing'), overlap.second.why)

// ── C. what an unreadable photograph is, and what it is never folded into ─────

saveAudit('orgC', withPhoto.store)
const again = loadAudit('orgC')
ok('the photograph survives a save', again.seals[0].snapshot !== null)
eq('with its money, its counts and its findings intact',
  `${again.seals[0].snapshot.money.revenue}/${again.seals[0].snapshot.counts.invoices}/${again.seals[0].snapshot.findings.length}`,
  `${base.money.revenue}/${base.counts.invoices}/${base.findings.length}`)
eq('and its date', again.seals[0].snapshot.taken_on, base.window.today)
eq('and the words the reading printed', again.seals[0].snapshot.headline, base.headline)
eq('a saved picture is not stamped unreadable', again.seals[0].snapshot_unreadable, false)

const damaged = { ...auditEmpty, seals: [sealRow({ snapshot: { month: '2026-09', money: 'not a photograph' } })] }
saveAudit('orgG', damaged)
const unread = loadAudit('orgG')
eq('a snapshot this register cannot read is dropped from the figures', unread.seals[0].snapshot, null)
eq('but the row keeps the fact that one was there', unread.seals[0].snapshot_unreadable, true)
saveAudit('orgG', unread)
eq('and that fact survives a second save — a damaged picture never decays into no picture',
  loadAudit('orgG').seals[0].snapshot_unreadable, true)

const legacy = { ...auditEmpty, seals: [sealRow()] }                              // a pre-R3-21 row: no field at all
saveAudit('orgH', legacy)
const old = loadAudit('orgH')
eq('an old seal loads with no photograph', old.seals[0].snapshot, null)
eq('and is not accused of a damaged one', old.seals[0].snapshot_unreadable, false)

const halfMoney = { ...auditEmpty, seals: [sealRow({ snapshot: { ...snap(), money: undefined } })] }
saveAudit('orgI', halfMoney)
eq('a photograph missing its money object is unreadable, not empty', loadAudit('orgI').seals[0].snapshot_unreadable, true)
eq('and it keeps no figures either', loadAudit('orgI').seals[0].snapshot, null)

const stringMoney = { ...auditEmpty, seals: [sealRow({ snapshot: { ...snap(), money: { ...snap().money, revenue: '1000' } } })] }
saveAudit('orgJ', stringMoney)
eq('a rupee spelled as a string is refused — a figure has to be a figure', loadAudit('orgJ').seals[0].snapshot_unreadable, true)

const noLoaded = { ...auditEmpty, seals: [sealRow({ snapshot: { ...snap(), money: Object.fromEntries(Object.entries(snap().money).filter(([k]) => k !== 'loaded')) } })] }
saveAudit('orgK', noLoaded)
eq('a photograph that never said whether it loaded anything is unreadable too',
  loadAudit('orgK').seals[0].snapshot_unreadable, true)

const badFinding = { ...auditEmpty, seals: [sealRow({ snapshot: { ...snap(), findings: [{ key: 'k', label: 'l', count: 'three', amount: 0 }] } })] }
saveAudit('orgL', badFinding)
eq('one uncountable finding spoils the whole picture rather than the row it sits on',
  loadAudit('orgL').seals[0].snapshot_unreadable, true)

const bareObject = { ...auditEmpty, seals: [sealRow({ snapshot: {} })] }          // an old row that wrote the key empty
saveAudit('orgM', bareObject)
eq('an empty object is unreadable — it is a picture that failed, not a window with no picture',
  loadAudit('orgM').seals[0].snapshot_unreadable, true)

const noSnapshotKeyAtAll = { ...auditEmpty, seals: [{ ...sealRow(), snapshot: undefined }] }
saveAudit('orgN', noSnapshotKeyAtAll)
eq('and the same field simply absent is the other sentence', loadAudit('orgN').seals[0].snapshot_unreadable, false)

// ── D. the comparison is drawn only between two figures that both exist ───────

const photoOn = (r, snapArg) => ({ ...auditEmpty, seals: [sealRow({ snapshot: snapArg })] })

// D1 — nothing to compare
eq('an open period draws no drift', closeDrift(read()), null)
eq('a seal with no photograph draws no drift', closeDrift(read({ audit: photoOn(base, null) })), null)
eq('a seal whose photograph is unreadable draws no drift either — the page prints that sentence',
  closeDrift(read({ audit: { ...auditEmpty, seals: [sealRow({ snapshot: null, snapshot_unreadable: true })] } })), null)
const photoOfAnother = sealSnapshotOf(read({ month: '2026-08' }))
eq('and neither does a photograph of a different window — that is a caption error, not a comparison',
  closeDrift(read({ audit: photoOn(base, photoOfAnother) })), null)

// D2 — a real drift: the seal photographed September, then a document moved
const asSealed = read()
const sealedStore = photoOn(base, sealSnapshotOf(asSealed))
const todayLater = read({
  audit: sealedStore,
  documents: { ...docs, invoices: [...docs.invoices, invoice('issued', '2026-09-28', 250.5, 250.5)] },
})
const d = closeDrift(todayLater)
ok('a seal standing with a photograph produces the pair', d !== null)
eq('the photograph travels onto the surface unchanged', JSON.stringify(d.snapshot), JSON.stringify(sealSnapshotOf(asSealed)))
eq('seven money lines and seven paper lines are drawn', d.lines.length, 14)
eq('money first, paper after', `${d.lines[0].kind}/${d.lines[13].kind}`, 'money/paper')
eq('the revenue line says what was sealed', d.lines.find(l => l.key === 'money:revenue').sealed, asSealed.money.revenue)
eq('and what today reads', d.lines.find(l => l.key === 'money:revenue').now, todayLater.money.revenue)
eq('the delta is today minus sealed, not an absolute', d.lines.find(l => l.key === 'money:revenue').delta, todayLater.money.revenue - asSealed.money.revenue)
eq('a moved paise figure moves exactly, not to two decimals', d.lines.find(l => l.key === 'money:revenue').delta, 250.5)
eq('the paper line moved with it', d.lines.find(l => l.key === 'paper:invoices').delta, 1)
eq('and a line that stands still reports a zero delta, not an absence', d.lines.find(l => l.key === 'paper:bills').delta, 0)
eq('the drift says out loud that something moved', d.moved, true)
eq('a seal that photographs an unchanged window says nothing moved', closeDrift(read({ audit: sealedStore })).moved, false)
eq('the money lines are the seven document figures the reading prints',
  d.lines.filter(l => l.kind === 'money').map(l => l.key.split(':')[1]).join('|'),
  'revenue|purchases|expenses|netProfit|received|paid|outstanding')
eq('every one of them a live key on the reading — a renamed figure breaks this fence, not a silent gap',
  d.lines.filter(l => l.kind === 'money').every(l => l.key.split(':')[1] in base.money), true)
eq('and the paper lines are every count the reading holds, in its own order',
  d.lines.filter(l => l.kind === 'paper').map(l => l.key.split(':')[1]).join('|'),
  Object.keys(base.counts).join('|'))
eq('the three journal aggregates the reading carries are not drift lines — they count its own rows',
  Object.keys(base.money).filter(k => k !== 'loaded' && !['revenue', 'purchases', 'expenses', 'netProfit', 'received', 'paid', 'outstanding'].includes(k)).join('|'),
  'journalEntries|journalLegs|journalTouched')
eq('every line labels itself in words a shop reads', d.lines.every(l => l.label.length > 3), true)

// D3 — withheld pairs
const photoNoMoney = sealSnapshotOf(read({ documents: null }))
const w1 = closeDrift(read({ audit: photoOn(base, photoNoMoney) }))
eq('a photograph with no rupees in it draws no money line', w1.lines.filter(l => l.kind === 'money').length, 0)
eq('but still draws the seven paper lines', w1.lines.filter(l => l.kind === 'paper').length, 7)
ok('and prints the reason as its own sentence', w1.withheld.some(s => s.includes('the photograph holds no money figure')), w1.withheld.join(' | '))
const w2 = closeDrift(read({
  documents: null,
  audit: photoOn(base, sealSnapshotOf(read())),
}))
eq('today without documents draws no money line either', w2.lines.filter(l => l.kind === 'money').length, 0)
ok('and says a blank is being kept rather than drawn as ₹0', w2.withheld.some(s => s.includes('rather than drawn as ₹0')), w2.withheld.join(' | '))
const w3 = closeDrift(read({
  documents: null,
  audit: photoOn(base, sealSnapshotOf(read({ documents: null }))),
}))
ok('neither side holding a figure is a third, distinct sentence',
  w3.withheld.some(s => s.includes('no money line is drawn')), w3.withheld.join(' | '))
eq('and the photograph’s own unread register is named beside it, not folded into the same line',
  w3.withheld.length, 2)
ok('and a withheld money line is never faked as a zero line', w3.lines.every(l => l.kind === 'paper'), true)
const w4 = closeDrift(read({ audit: photoOn(base, sealSnapshotOf(read({ journal: null }))) }))
ok('a photograph taken without a register says the picture is of a partial book',
  w4.withheld.some(s => s.includes('a picture of a partial book')), w4.withheld.join(' | '))
eq('and it names the register it was taken without', w4.photo_unread.join(','), 'the journal')
eq('an unread photograph does not silently pass as comparable money — the pair is still drawn when both loaded',
  w4.lines.filter(l => l.kind === 'money').length, 7)
eq('withheld sentences are sentences, not codes', w1.withheld.every(s => s.includes('—')), true)

// D4 — findings matched by their own key
const d4 = closeDrift(read({ audit: photoOn(base, sealSnapshotOf(read({ journal, flow, filings }))) }))
eq('a photograph of the same window matches its own findings one for one', d4.findings.length, 3)
eq('every finding the photograph held is on the surface',
  base.findings.every(f => d4.findings.some(x => x.key === f.key)), true)
eq('sealed count is the photograph’s', d4.findings[0].sealed, base.findings[0].count)
eq('and today’s is the reading’s', d4.findings[0].now, base.findings[0].count)

const cleared = read({ audit: photoOn(base, sealSnapshotOf(base)), journal: journalClean, flow: [], filings: [] })
const d5 = closeDrift(cleared)
eq('three findings the shop finished since the seal fell are still listed', d5.findings.length, 3)
ok('each under its own key, not a re-spelled label', d5.findings.every(f => typeof f.key === 'string' && f.sealed > 0), true)
eq('and today’s column reads zero because the reading says zero — the picture is what held the three',
  d5.findings.map(f => `${f.key}/${f.now}`).join(','), 'journal-drafts/0,unconverted-papers/0,returns-unfiled/0')
eq('the paper line for the drafts moved with it', d5.lines.find(l => l.key === 'paper:draftEntries').delta, -1)

const d6 = closeDrift(read({
  audit: photoOn(base, { ...sealSnapshotOf(read()), findings: [{ key: 'gone-away', label: 'Something the register no longer names', count: 3, amount: 0 }] }),
}))
ok('a finding only the photograph remembers is printed, not dropped',
  d6.findings.some(f => f.key === 'gone-away' && f.sealed === 3 && f.now === 0), JSON.stringify(d6.findings))
eq('and it is labelled with the name the photograph gave it',
  d6.findings.find(f => f.key === 'gone-away').label, 'Something the register no longer names')
ok('while today’s own findings are still listed beside it', d6.findings.filter(f => f.key !== 'gone-away').length === 3)

// ── E. the two files a CA takes ───────────────────────────────────────────────

eq('the seals export grew five photo columns, no more', SEAL_CSV_HEADERS.length, 16)
eq('and they are named for what they are', SEAL_CSV_HEADERS.slice(11).join(','),
  'photo_taken_on,photo_revenue,photo_net_profit,photo_findings,photo_unread')
const photoOfNoDocs = sealSnapshotOf(read({ documents: null }))
const csvStore = {
  version: 1, updatedAt: '', orgId: 'org',
  seals: [
    sealRow({ snapshot: sealSnapshotOf(base) }),
    sealRow({ id: 's2', period: '2026-08', label: 'August 2026' }),
    sealRow({ id: 's3', period: '2026-07', label: 'July 2026', snapshot_unreadable: true }),
    sealRow({ id: 's4', period: '2026-06', label: 'June 2026', snapshot: photoOfNoDocs }),
  ],
  events: [],
}
const rows = sealCsvRows(csvStore)
eq('one row per seal', rows.length, 4)
eq('every row carries all sixteen columns', rows.map(r => r.length).join(','), '16,16,16,16')
eq('a photographed seal prints its date, its figures and its finding count', rows[0].slice(11).join('|'),
  `${base.window.today}|${base.money.revenue}|${base.money.netProfit}|${base.findings.length}|`)
eq('a seal with no photograph leaves all five columns blank — a blank is not a zero', rows[1].slice(11).join('|'), '||||')
eq('an unreadable one says so in words, and still leaves the figures blank', rows[2].slice(11).join('|'), 'unreadable||||')
eq('and a photograph that never saw the documents refuses to lend it a number, naming what it could not read',
  rows[3].slice(11).join('|'), `${base.window.today}|not photographed|not photographed|${photoOfNoDocs.findings.length}|the documents`)
ok('the paper it did read is still counted, because it really was counted', photoOfNoDocs.findings.length === 3)

eq('the close file keeps its eight columns', CLOSE_CSV_HEADERS.length, 8)
ok('the close export carries the pair when a photograph stands',
  closeCsvRows(todayLater).some(r => r[0] === 'sealed_figure' && r[3] === 'Revenue billed'))
const driftRows = closeCsvRows(todayLater).filter(r => r[0] === 'sealed_figure')
eq('one row per comparable line', driftRows.length, 14)
ok('each says when the picture was taken', driftRows.every(r => r[7] === `photograph taken ${base.window.today}`))
ok('and puts the sealed figure in the detail, not the amount column',
  driftRows[0][5] === todayLater.money.revenue && String(driftRows[0][6]).startsWith(`as sealed ${base.window.today}:`))
ok('the detail also prints the move', driftRows[0][6].includes('moved'))
eq('paper rows come out as counts, not rupees',
  driftRows.find(r => r[3] === 'Invoices dated here')[5], todayLater.counts.invoices)
eq('no photograph, no sealed_figure rows',
  closeCsvRows(read({ audit: photoOn(base, null) })).filter(r => r[0] === 'sealed_figure').length, 0)
eq('a month with a photograph still has its summary line first', closeCsvRows(todayLater)[0][0], 'summary')

// ── F. the page’s half of the bargain ────────────────────────────────────────

const page = readFileSync(join(ROOT, 'src/app/(app)/audit/page.tsx'), 'utf8')
ok('the handover is a memo, so the dialog and the write agree', page.includes('const photoInHand = useMemo('))
ok('it only photographs a month', page.includes('seal.kind !== \'month\''))
ok('it only photographs the window the reading actually read', page.includes('closeReadingNow.window.month !== seal.month'))
ok('it only photographs when the close tab is the one open', page.includes('tab !== \'close\''))
ok('the page draws the picture, it does not restate it', page.includes('sealSnapshotOf(closeReadingNow)'))
ok('and hands it to the register that owns the seal', page.includes('snapshot: photo,'))
ok('the dialog says what a photograph costs the shop', page.includes('A photograph of the close reading'))
ok('and says the opposite when none is in hand', page.includes('No photograph: this dialog has read no window'))
ok('a year seal is told why it gets no picture', page.includes('a year cannot carry a month'))
ok('the notice after sealing names the date the figures stood at', page.includes('were kept as they stood on'))
ok('and names the absence too, so a seal is never quietly picture-less', page.includes('No photograph of the window was kept with it'))
ok('the drift card is mounted inside the close tab', page.includes('<SealDrift reading={reading} search={search} />'))
ok('it is drawn from the engine, not computed on the screen', page.includes('const drift = closeDrift(reading)'))
ok('the card is a component of its own', page.includes('function SealDrift('))
ok('the two columns are labelled as the two things they are', page.includes('As sealed') && page.includes('Read today'))
ok('the photograph’s own date is printed on it', page.includes('Photograph taken'))
ok('and the reading it came from is quoted, not paraphrased', page.includes('{drift.snapshot.headline}'))
ok('a seal with no photograph is told so, not left blank', page.includes('No photograph stands on this seal'))
ok('an unreadable one is told differently', page.includes('a photograph this register cannot read'))
ok('the two absences print different sentences, never one shared blank',
  page.includes('its figures are not shown') && page.includes('What is printed above is'))
ok('the withheld sentences are printed, never dropped', page.includes('{drift.withheld.map('))
ok('every seal card names its photograph state', page.includes('Photograph kept from the close reading on'))
ok('including the absence', page.includes('No photograph kept — this seal carries the decision'))
ok('a photograph that saw no documents is not read as a zero month', page.includes('so no rupee figure was photographed'))
ok('the moved count uses the kit’s pluraliser, not a hand-rolled one', page.includes('plural(changed.length, \'figure\')'))
ok('and the verb agrees with it', page.includes('${changed.length === 1 ? \'has\' : \'have\'}'))
ok('the search reaches the photograph’s date and window', page.includes('s.snapshot?.taken_on ?? \'\''))
eq('the close tab is still the third tab, not a new route', page.includes('type Tab = \'seals\' | \'trail\' | \'close\''), true)
ok('the ?tab= guard is untouched', page.includes('if (t === \'trail\' || t === \'seals\' || t === \'close\') setTab(t)'))

const driftRules = page.slice(page.indexOf('/* A seal\'s photograph'), page.indexOf('@media (max-width: 1100px)'))
ok('the new rules exist', driftRules.includes('.au-drift-row') && driftRules.includes('.au-photo'))
ok('and they are token-only — no hex, no rgba', !driftRules.includes('#') && !driftRules.includes('rgba'), driftRules.slice(0, 60))
ok('they declare no font of their own — no re-spelled monospace (Rule 55)', !driftRules.includes('font-family') && !driftRules.includes('ui-monospace'))
ok('the drift table collapses for a narrow screen', page.includes('.au-drift-row { grid-template-columns: 1fr 1fr; gap: 4px 10px; }'))
ok('and its header row is dropped when it collapses', page.includes('.au-drift-row.is-head { display: none; }'))

// the boundary the round lifted, and the doctrine it made stale
eq('the reading still prints six boundaries', CLOSE_BOUNDARIES.length, 6)
ok('and no longer claims it cannot be a photograph', !CLOSE_BOUNDARIES[0].includes('not a photograph'))
ok('it says which seal keeps one', CLOSE_BOUNDARIES[0].includes('A seal closed from *this* tab keeps a photograph'))
ok('and which keeps none', CLOSE_BOUNDARIES[0].includes('one put on from the Seals tab where no reading was open, keeps none'))
ok('the page header was narrowed rather than crossed', page.includes('hold no money of their own'))
ok('and still says what a photograph is made of', page.includes('it repeats what that reading printed'))
ok('a photograph is not refreshed', page.includes('A photograph is taken once'))
const auditSrc = readFileSync(join(ROOT, 'src/lib/audit.ts'), 'utf8')
ok('the seal register’s own header admits the field and keeps the rule',
  auditSrc.includes('it repeats what a reading already computed') && auditSrc.includes('it moves no money'))
ok('and the close library says it decides nothing',
  readFileSync(join(ROOT, 'src/lib/period-close.ts'), 'utf8').includes('Nothing here *decides* to store a period'))

// ── G. the ledger did not move ───────────────────────────────────────────────

const libs = readdirSync(join(ROOT, 'src/lib')).filter(f => /\.tsx?$/.test(f))
eq('no new library — the photograph lives on the two files that already owned it', libs.length, 57)
ok('audit.ts owns the record', libs.includes('audit.ts') && libs.includes('period-close.ts'))
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (e === 'page.tsx') out.push(p)
  }
  return out
}
eq('no new route', walk(join(ROOT, 'src/app')).length, 65)
ok('the register is still version 1 — a photograph is an added field, not a new shape',
  /const AUDIT_VERSION = 1/.test(auditSrc))
ok('and `ledger.ts` reads none of it', !readFileSync(join(ROOT, 'src/lib/ledger.ts'), 'utf8').includes('SealSnapshot'))
const vaultSrc = readFileSync(join(ROOT, 'src/lib/vault.ts'), 'utf8')
ok('the vault still accepts an audit store by the same shape test',
  vaultSrc.includes('Array.isArray(field(v, \'seals\')) && Array.isArray(field(v, \'events\'))'))
ok('and its description of the register says what it now holds',
  vaultSrc.includes('the close figures a sealed month kept'))
const persistSrc = readFileSync(join(ROOT, 'src/lib/persistence.ts'), 'utf8')
ok('the persistence inventory counts the photograph as part of what a wipe costs',
  persistSrc.includes('photographed') && persistSrc.includes('nothing regenerates either'))
const iconSrc = readFileSync(join(ROOT, 'src/components/Icons.tsx'), 'utf8')
eq('the drift borrowed no new glyph', ['compare', 'clock', 'alert', 'x'].every(g => iconSrc.includes(`  ${g}:`)), true)
ok('and the drift card uses the comparison glyph it borrowed', page.includes('name="compare"'))

// ── the report ────────────────────────────────────────────────────────────────

if (failures.length) {
  console.log(`\n${pass - failures.length}/${pass} passed, ${failures.length} FAILED:`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log(`${pass}/${pass} assertions passed`)
