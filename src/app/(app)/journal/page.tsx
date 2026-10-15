'use client'

// The manual journal — the one place a shop may state a movement that no document raised.
//
// Everything else in TaxFlow is written backwards from paper: an invoice makes revenue, a bill
// makes a payable, a payment moves cash. A journal entry is written forwards — the owner says
// "depreciation is ₹40,000 this year", "the loan arrived but no bill did", "I took ₹10,000 out of
// the till" — and the derived statements on /accounting read that statement as a movement on the
// line the entry names.
//
// The engine (src/lib/journal.ts) owns the model: heads that declare which statement line they
// move, entries of at least two legs, a draft → posted → reversed lifecycle, and numbering dressed
// from the business register's own series (Rule 39 — this register counts, /business only shapes).
// All of it lives in this browser under `taxflow:journal:<orgId>` (ADR-013).
//
// Four boundaries are printed on the screen rather than left to be assumed:
//
//  * **A balanced entry renames money; it cannot explain it.** Every posting is debited and credited
//    to the paisa, which is why it moves a named line without moving the derived "Capital account
//    (derived)" figure on the balance sheet by a rupee. The card below prints that arithmetic over
//    the rows the statements are actually holding.
//  * **No return reads this register.** GSTR-1, GSTR-3B, GSTR-9 and the TDS workpaper are built from
//    invoices, bills and payments. A journal line moves your statements and your management answers;
//    it files nothing, and the portal has never heard of it.
//  * **A posted entry is never edited.** The exit is a reversal — a second entry with every leg's side
//    flipped, the heads and rupees re-summoned from the original so it cannot drift. Both halves stay
//    on the register and net to nothing. Only drafts may change, and only drafts may be deleted.
//  * **The seal is a second door here.** An entry dated inside a standing seal is refused before the
//    legs are even read, and the attempt lands on the audit trail (Rule 38) — a draft dated there is
//    a future posting dated there, so the draft is refused too.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN } from '@/lib/format'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import { currentFY, loadOpeningBalances } from '@/lib/ledger'
import { activeSeals, loadAudit, sealGuard, todayISO } from '@/lib/audit'
import {
  addStarterHeads, beforeTheBooksOpened, deleteEntry, deleteHead, drafts, entryHeadNames, GROUP_LABEL,
  headBalance, headById, headsCsvRows, HEADS_CSV_HEADERS, journalCsvRows, JOURNAL_CSV_HEADERS,
  journalRows, journalStats, loadJournal, movements, newEntry, newHead, newLeg, peekNumber,
  plugProof, postEntry, reverseEntry, rowsInWindow, setHeadActive, SLOT_META, SLOTS_BY_GROUP,
  slotsInGroup, STATUS_META, type HeadGroup, type JournalEntry, type JournalHead,
  type JournalLeg, type JournalStore, type LegSide, type StatementSlot, totals, trialBalance,
  trialBalanceCsvRows, TRIAL_BALANCE_CSV_HEADERS, unresolvableLegs,
  validateHead, validateLegs, writeEntry, writeHead,
} from '@/lib/journal'
import {
  Badge, Button, Card, EmptyState, PageHeader, SearchInput, SectionTitle, Segmented, StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'

type Tab = 'entries' | 'heads' | 'trial'

const TABS: { value: Tab; label: string }[] = [
  { value: 'entries', label: 'The register' },
  { value: 'heads', label: 'Heads' },
  { value: 'trial', label: 'Trial balance' },
]

const SIDES: LegSide[] = ['debit', 'credit']

const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
const money = (v: number) => inr2.format(Number.isFinite(v) ? v : 0)
/** A signed rupee says its own direction in words — never a bare minus the reader decodes (Rule 28). */
const signed = (v: number) => `${v < 0 ? '− ' : '+ '}${money(Math.abs(v))}`

/** The heads a leg may name: every open one, plus any this entry already carries. A closed head is
 *  still the head that rupee belongs to — the picker must not silently re-point it, and posting is
 *  where the engine says so in its own words. */
function headGroups(store: JournalStore, includeIds: string[] = []): { group: HeadGroup; heads: JournalHead[] }[] {
  return SLOTS_BY_GROUP
    .map(group => ({
      group,
      heads: store.heads.filter(h => (h.active || includeIds.includes(h.id)) && slotsInGroup(group).includes(h.slot)),
    }))
    .filter(g => g.heads.length > 0)
}

function JournalPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)

  const [store, setStore] = useState<JournalStore>({ version: 1, updatedAt: '', orgId: '', heads: [], entries: [], seq: {} })
  const [openingAsOf, setOpeningAsOf] = useState('')

  const [tab, setTab] = useState<Tab>('entries')
  const [search, setSearch] = useSearchDeepLink()
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  // The composer holds an entry-shaped draft plus the amount text for each leg. Rupees stay strings
  // while they are being typed — a half-typed "1." is not a zero, and the engine only ever sees a
  // finished number.
  const [draft, setDraft] = useState<JournalEntry | null>(null)
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [draftError, setDraftError] = useState<string[]>([])
  const [saving, setSaving] = useState<'draft' | 'post' | null>(null)

  const [reversal, setReversal] = useState<{ entry: JournalEntry; reason: string; date: string } | null>(null)
  const [reversalError, setReversalError] = useState<string[]>([])

  const [head, setHead] = useState<JournalHead | null>(null)
  const [headError, setHeadError] = useState<string[]>([])

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id, organizations(name)')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()
      if (!membership) { router.push('/setup'); return }

      const oid = membership.organization_id
      setOrgId(oid)
      setOrgName((membership.organizations as { name?: string } | null)?.name || '')
      setStore(loadJournal(oid))
      setOpeningAsOf(loadOpeningBalances(oid).as_of || '')

      const t = searchParams.get('tab')
      if (t === 'heads' || t === 'entries' || t === 'trial') setTab(t)
      if (searchParams.get('new') === '1') openDraft()
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fy = useMemo(() => currentFY(), [])
  const stats = useMemo(() => journalStats(store, fy.start, fy.end), [store, fy])
  const rows = useMemo(() => journalRows(store), [store])
  const proof = useMemo(() => plugProof(rows), [rows])
  // The register's own trial balance: every head netted Dr/Cr over the foldable rows, a leg naming a
  // missing head kept on a labelled placeholder, and the two columns footed. Read-only (R3-14).
  const tb = useMemo(() => trialBalance(store), [store])
  const movedThisFY = useMemo(() => movements(rowsInWindow(rows, { start: fy.start, end: fy.end })), [rows, fy])
  // The windows that are closed. An entry dated inside one is refused before its legs are read, so the
  // page states the locks it is obeying rather than let a Post button surprise the shop.
  const seals = useMemo(() => (orgId ? activeSeals(loadAudit(orgId)) : []), [orgId])

  // Postings struck before the day the books were picked up. The fold reads an entry by its own date,
  // so these do move the statements — printed as a finding, never silently corrected (Rule 29). The
  // engine owns the sentence; the page only decides whether the shop has ever named that day.
  const beforeTheBooks = useMemo(
    () => (openingAsOf ? beforeTheBooksOpened(store, openingAsOf) : []),
    [store, openingAsOf],
  )

  const listed = useMemo(
    () => store.entries
      .slice()
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.created_at.localeCompare(a.created_at))
      .filter(e => matchesAny(search, [
        e.number, e.date, e.narration, e.reference, e.actor, STATUS_META[e.status].label,
        ...entryHeadNames(e.legs, store),
      ])),
    [store, search],
  )
  const pending = useMemo(() => drafts(store), [store])
  const visibleHeads = useMemo(
    () => store.heads
      .slice()
      .sort((a, b) => GROUP_LABEL[SLOT_META[a.slot].group].localeCompare(GROUP_LABEL[SLOT_META[b.slot].group])
        || a.name.localeCompare(b.name))
      .filter(h => matchesAny(search, [h.name, h.notes, SLOT_META[h.slot].label, GROUP_LABEL[SLOT_META[h.slot].group]])),
    [store, search],
  )

  // ── the composer ────────────────────────────────────────────────────────────

  function seedAmounts(legs: JournalLeg[]): Record<string, string> {
    const map: Record<string, string> = {}
    for (const l of legs) map[l.id] = l.amount ? String(l.amount) : ''
    return map
  }

  function openDraft(existing?: JournalEntry) {
    if (existing) {
      const copy: JournalEntry = { ...existing, legs: existing.legs.map(l => ({ ...l })) }
      setDraft(copy)
      setAmounts(seedAmounts(copy.legs))
    } else {
      const fresh = newEntry(todayISO())
      setDraft(fresh)
      setAmounts(seedAmounts(fresh.legs))
    }
    setDraftError([])
    setSaving(null)
  }

  function closeDraft() {
    setDraft(null)
    setDraftError([])
    setSaving(null)
  }

  function patchLeg(id: string, patch: Partial<JournalLeg>) {
    if (!draft) return
    setDraft({ ...draft, legs: draft.legs.map(l => (l.id === id ? { ...l, ...patch } : l)) })
  }

  function addLeg() {
    if (!draft) return
    const leg = newLeg('', 'debit')
    setDraft({ ...draft, legs: [...draft.legs, leg] })
    setAmounts(a => ({ ...a, [leg.id]: '' }))
  }

  function removeLeg(id: string) {
    if (!draft) return
    setDraft({ ...draft, legs: draft.legs.filter(l => l.id !== id) })
    setAmounts(a => {
      const next = { ...a }
      delete next[id]
      return next
    })
  }

  /** The legs as the engine will see them: rupees resolved out of the typed text. */
  const liveLegs: JournalLeg[] = draft
    ? draft.legs.map(l => ({ ...l, amount: Number(amounts[l.id] ?? '') || 0 }))
    : []
  const draftTotals = totals(liveLegs)
  const draftProblems = draft ? validateLegs(liveLegs, store, false) : []
  const draftSeal = draft && orgId ? sealGuard(orgId, draft.date) : { sealed: false, label: '', why: '' }

  function entryFromDraft(posting: boolean): JournalEntry | null {
    if (!draft) return null
    return {
      ...draft,
      narration: draft.narration.trim(),
      reference: draft.reference.trim(),
      legs: liveLegs,
      // The lifecycle stays with the engine; the composer only states the shape it wants saved.
      status: posting ? 'draft' : draft.status,
    }
  }

  function saveDraft() {
    if (!orgId || !draft) return
    const entry = entryFromDraft(false)
    if (!entry) return
    const r = writeEntry(orgId, entry, orgName)
    if (!r.ok) {
      setDraftError(r.problems)
      setStore(loadJournal(orgId))
      if (r.sealed) setNotice({ msg: 'The seal refused this date. Nothing was saved, and the attempt is now on the audit trail.', bad: true })
      return
    }
    setStore(r.store)
    setDraftError([])
    closeDraft()
    setTab('entries')
    setNotice({ msg: `${r.entry.narration || 'The entry'} is kept as a draft — no number taken, nothing folded yet.`, bad: false })
  }

  function postDraft() {
    if (!orgId || !draft) return
    setSaving('post')
    const entry = entryFromDraft(true)
    if (!entry) return
    const saved = writeEntry(orgId, entry, orgName)
    if (!saved.ok) {
      setDraftError(saved.problems)
      setStore(loadJournal(orgId))
      if (saved.sealed) setNotice({ msg: 'Nothing was posted or drafted — the seal refused this date, and the refusal is on the trail.', bad: true })
      setSaving(null)
      return
    }
    const posted = postEntry(orgId, saved.entry.id, orgName)
    setStore(loadJournal(orgId))
    setSaving(null)
    if (!posted.ok) {
      setDraftError(posted.problems)
      setNotice({ msg: `Kept as a draft — the posting was refused: ${posted.problems[0]}`, bad: true })
      return
    }
    setDraftError([])
    closeDraft()
    setTab('entries')
    setNotice({ msg: `${posted.entry.number} is posted. The statements now carry the ${money(draftTotals.debit)} of movement it named.`, bad: false })
  }

  function runPost(existing: JournalEntry) {
    if (!orgId) return
    const r = postEntry(orgId, existing.id, orgName)
    setStore(loadJournal(orgId))
    if (!r.ok) { setNotice({ msg: r.problems[0], bad: true }); return }
    setNotice({ msg: `${r.entry.number} is posted and folds into the statements.`, bad: false })
  }

  function runDelete(existing: JournalEntry) {
    if (!orgId) return
    const r = deleteEntry(orgId, existing.id)
    setStore(r.ok ? r.store : loadJournal(orgId))
    if (!r.ok) { setNotice({ msg: r.problems[0], bad: true }); return }
    setOpen(o => ({ ...o, [existing.id]: false }))
    setNotice({ msg: 'The draft is gone. A draft carries no number, so nothing was taken out of the series.', bad: false })
  }

  function runReverse() {
    if (!orgId || !reversal) return
    const r = reverseEntry(orgId, reversal.entry.id, reversal.reason, reversal.date, orgName)
    setStore(loadJournal(orgId))
    if (!r.ok) { setReversalError(r.problems); return }
    setReversal(null)
    setReversalError([])
    setNotice({ msg: `${r.entry.number} reverses ${reversal.entry.number}. Both halves stay on the register and net to nothing.`, bad: false })
  }

  // ── heads ───────────────────────────────────────────────────────────────────

  function openHead(existing?: JournalHead) {
    setHead(existing ? { ...existing } : newHead('expense', ''))
    setHeadError([])
  }

  function runHead() {
    if (!orgId || !head) return
    const r = writeHead(orgId, head)
    if (!r.ok) { setHeadError(r.problems); return }
    setStore(r.store)
    setHead(null)
    setHeadError([])
    setNotice({ msg: `${head.name} is on the register — an entry naming it moves ${SLOT_META[head.slot].label.toLowerCase()}.`, bad: false })
  }

  function runHeadActive(h: JournalHead, active: boolean) {
    if (!orgId) return
    const used = entriesNaming(store, h.id)
    const r = setHeadActive(orgId, h.id, active)
    setStore(r.ok ? r.store : loadJournal(orgId))
    if (!r.ok) { setNotice({ msg: r.problem, bad: true }); return }
    setNotice({
      msg: active
        ? `${h.name} is open again — the composer offers it to new entries.`
        : `${h.name} is closed. New entries cannot use it; the ${used} ${used === 1 ? 'entry' : 'entries'} already carrying ${used === 1 ? 'it' : 'them'} still read on the statements.`,
      bad: !active,
    })
  }

  function runHeadDelete(h: JournalHead) {
    if (!orgId) return
    const r = deleteHead(orgId, h.id)
    setStore(r.ok ? r.store : loadJournal(orgId))
    if (!r.ok) { setNotice({ msg: r.problems[0], bad: true }); return }
    setNotice({ msg: `${h.name} was never used, so it has left the register entirely.`, bad: false })
  }

  function runStarters() {
    if (!orgId) return
    const r = addStarterHeads(orgId)
    setStore(r.store)
    setNotice({
      msg: r.added.length === 0
        ? 'All six starting heads were already on the register — one name, one head.'
        : `Added ${r.added.join(', ')}. Nothing was seeded silently; you clicked once.`,
      bad: false,
    })
  }

  // ── exports ─────────────────────────────────────────────────────────────────

  function exportRegister() {
    download(`taxflow-journal-${todayISO()}.csv`, toCsv(JOURNAL_CSV_HEADERS, journalCsvRows(store)))
  }
  function exportHeads() {
    download(`taxflow-journal-heads-${todayISO()}.csv`, toCsv(HEADS_CSV_HEADERS, headsCsvRows(store)))
  }
  function exportTrial() {
    download(`taxflow-journal-trial-balance-${todayISO()}.csv`, toCsv(TRIAL_BALANCE_CSV_HEADERS, trialBalanceCsvRows(tb)))
  }

  if (loading) {
    return <div className="jn-wrap"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the register…</p></div>
  }

  const guardToday = orgId ? sealGuard(orgId, todayISO()) : { sealed: false, label: '', why: '' }
  const findings = [
    proof.ok ? null : `The register holds rows whose debits (${money(proof.debits)}) and credits (${money(proof.credits)}) differ by ${money(Math.abs(proof.residual))} — a hand-edit, not an entry the composer wrote.`,
    stats.unbalanced > 0 ? `${stats.unbalanced} numbered ${stats.unbalanced === 1 ? 'entry is' : 'entries are'} unbalanced.` : null,
    stats.dangling > 0 ? `${stats.dangling} ${stats.dangling === 1 ? 'leg names' : 'legs name'} a head this register no longer holds — those rows cannot be posted.` : null,
    beforeTheBooks.length > 0 && openingAsOf
      ? `${beforeTheBooks.length} ${beforeTheBooks.length === 1 ? 'posting is' : 'postings are'} dated before ${formatDateIN(openingAsOf)}, the day the books were picked up. The fold reads an entry by its own date, so those movements do reach the statements.`
      : null,
  ].filter((f): f is string => !!f)

  // A sealed date does not disable the buttons. The invoice form works the same way (R3-1): the click
  // reaches the engine, the engine refuses, and `recordRefusal` puts the *attempt* on the trail — a
  // held button would leave a stopped write off the record, which is exactly what a seal is for.
  const canPost = !!draft && draftTotals.balanced && !!draft.narration.trim()
    && draft.date !== '' && draftProblems.length === 0
  const canSave = !!draft && draft.date !== ''

  return (
    <div className="jn-wrap">
      <PageHeader
        eyebrow="Books"
        title="Journal entries"
        subtitle="The one register where you state a movement no document raised — depreciation, a drawing, a loan that arrived without a bill. Every entry is balanced, numbered in your own series, and folded into the financial statements."
        actions={
          <>
            <Button variant="ghost" icon="tag" onClick={() => setTab('heads')}>Heads</Button>
            <Button icon="plus" onClick={() => openDraft()} disabled={store.heads.filter(h => h.active).length < 2}>
              New entry
            </Button>
          </>
        }
      />

      {notice && (
        <div className={`jn-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
          <Icon name={notice.bad ? 'alert' : 'check'} size={14} strokeWidth={notice.bad ? 2.2 : 2.4} />
          <span>{notice.msg}</span>
          <button type="button" className="jn-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {/* ── The four numbers ──────────────────────────────────────────────────── */}
      <div className="jn-stats">
        <StatCard label="Postings standing" value={String(stats.posted)} icon="book" tone="green"
          sub={stats.reversed > 0 ? `folded into the statements · ${stats.reversed} reversed` : 'folded into the statements'} delay={0} />
        <StatCard label="Drafts" value={String(stats.drafts)} icon="edit" tone={stats.drafts ? 'amber' : 'grey'}
          sub="no number taken yet" delay={60} />
        <StatCard label={`Moved in ${fy.label}`} value={money(stats.rupeesThisFY)} icon="hash" tone="blue"
          sub={`${movedThisFY.length} statement ${movedThisFY.length === 1 ? 'line' : 'lines'} touched`} delay={120} />
        <StatCard label="Heads" value={String(stats.heads)} icon="tag" tone="violet"
          sub={`${stats.openHeads} open · ${stats.heads - stats.openHeads} closed`} delay={180} />
      </div>

      {/* ── The invariant, printed instead of asserted ────────────────────────── */}
      <Card pad={false} className="jn-integrity">
        <div className="jn-integrity-body">
          <span className={`jn-dot ${proof.legs === 0 ? 'is-nil' : findings.length === 0 ? 'is-ok' : 'is-bad'}`}>
            <Icon name={proof.legs === 0 ? 'book' : findings.length === 0 ? 'check' : 'alert'} size={18} strokeWidth={2.4} />
          </span>
          <div className="jn-integrity-text">
            <div className="jn-integrity-head">
              {proof.legs === 0
                ? <>Nothing is posted on this register — <strong>no legs, so no balance to prove</strong>. An empty journal is not a broken one, but it is not a balanced one either.</>
                : findings.length === 0
                ? <>Every entry on this register <strong>balances to the paisa</strong> — {money(proof.debits)} debited, {money(proof.credits)} credited across {proof.legs} legs.</>
                : <>The register <strong>shows {findings.length === 1 ? 'a finding' : `${findings.length} findings`}</strong> — the statements still foot, but the arithmetic below is not what the composer wrote.</>}
            </div>
            {findings.length === 0 ? (
              <p>
                Balance is not a nicety: it is <em>why</em> a journal can move a figure from the derived capital line to a named
                one without moving the derived line at all. A balanced entry changes <span className="jn-mono">assets − liabilities − profit</span> by
                exactly Σ debits − Σ credits, which here is zero. {orgId && `Last written ${formatDateIN(store.updatedAt)}.`}
              </p>
            ) : (
              <ul className="jn-findings">
                {findings.map(f => <li key={f}><Icon name="alert" size={13} strokeWidth={2.2} /><span>{f}</span></li>)}
              </ul>
            )}
          </div>
          <div className="jn-integrity-side">
            {guardToday.sealed
              ? <Badge tone="red" dot={false}>Today sits inside {guardToday.label}</Badge>
              : <Badge tone="grey" dot={false}>Today is open</Badge>}
          </div>
        </div>
      </Card>

      {/* ── Where the journal lands, and what it is not ───────────────────────── */}
      <div className="jn-bounds">
        <div className="jn-bounds-col">
          <SectionTitle icon="hash">What {fy.label}&apos;s entries moved</SectionTitle>
          {movedThisFY.length === 0
            ? <p className="jn-bounds-empty">Nothing has been posted in this financial year yet. A posting lands on the line its head names.</p>
            : (
              <ul className="jn-moves">
                {movedThisFY.map(m => (
                  <li key={m.slot}>
                    <span className="jn-move-line">{m.label}</span>
                    <span className={`jn-move-amt ${m.signed < 0 ? 'is-down' : 'is-up'}`}>{signed(m.signed)}</span>
                  </li>
                ))}
              </ul>
            )}
          <p className="jn-bounds-note">
            These are the same rows <Link href="/accounting">the financial statements</Link> read, printed beside the figure they
            moved and tagged <em>from the journal</em>. A line that did not move is not printed.
          </p>
        </div>
        <div className="jn-bounds-col">
          <SectionTitle icon="alert">What this register is not</SectionTitle>
          <div className="jn-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>No return reads it. GSTR-1, 3B, 9 and the TDS workpaper are built from invoices, bills and payments — a journal line files nothing.</span></div>
          <div className="jn-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>It invents no document. An entry moves a statement line; it does not raise an invoice, a bill or a payment.</span></div>
          <div className="jn-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>It lives in this browser (ADR-013), at <span className="jn-mono">taxflow:journal:&lt;org&gt;</span>, and travels only inside the <Link href="/vault">books vault</Link>.</span></div>
          <div className="jn-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>A posted entry is never edited — it is reversed, and the reversal must say why.</span></div>
        </div>
      </div>

      {seals.length > 0 && (
        <div className="jn-sealbar">
          <Icon name="lock" size={14} />
          <span>
            {seals.length} {seals.length === 1 ? 'period is' : 'periods are'} sealed ({seals.slice(0, 2).map(s => s.label).join(', ')}
            {seals.length > 2 ? ', …' : ''}). An entry dated inside one is refused here before its legs are even read, and the attempt is
            written on the trail.
          </span>
          <Link href="/audit" className="jn-seallink">Seals →</Link>
        </div>
      )}

      {stats.openHeads < 2 && (
        <div className="jn-sealbar is-soft">
          <Icon name="tag" size={14} />
          <span>
            An entry moves a rupee between two named heads, and a head is the only place the decision &ldquo;this money belongs on that
            statement line&rdquo; is written down. Name a pair before composing — or take the six movements the engine offers.
          </span>
          {store.heads.length === 0
            ? <Button variant="ghost" size="sm" icon="plus" onClick={runStarters}>Add the starting six</Button>
            : <Button variant="ghost" size="sm" icon="tag" onClick={() => setTab('heads')}>Name one</Button>}
        </div>
      )}

      {pending.length > 0 && (
        <div className="jn-draftbar">
          <Icon name="edit" size={14} />
          <span>
            {pending.length} {pending.length === 1 ? 'draft is' : 'drafts are'} waiting — the oldest is
            &ldquo;{pending[0].narration || pending[0].reference || 'unnamed'}&rdquo; of {formatDateIN(pending[0].date)}. A draft is a shape, not
            yet a posting: it carries no number and the statements do not read it.
          </span>
          <span className="jn-draftbar-acts">
            <Button variant="ghost" size="sm" icon="edit" onClick={() => openDraft(pending[0])}>Open</Button>
            <Button variant="ghost" size="sm" icon="check" onClick={() => runPost(pending[0])}>Post it</Button>
          </span>
        </div>
      )}

      {/* ── Toolbar ───────────────────────────────────────────────────────────── */}
      <div className="jn-toolbar">
        <Segmented options={TABS} value={tab} onChange={v => setTab(v as Tab)} />
        <SearchInput value={search} onChange={setSearch} ariaLabel="Search the register"
          placeholder={tab === 'entries' ? 'Search number, narration, head…' : 'Search heads…'} style={{ width: 240 }} />
        <span className="jn-export">
          <Button variant="ghost" size="sm" icon="download"
            onClick={tab === 'entries' ? exportRegister : tab === 'heads' ? exportHeads : exportTrial}
            disabled={tab === 'trial' ? store.heads.length === 0 : tab === 'entries' ? store.entries.length === 0 : store.heads.length === 0}>
            Export {tab === 'entries' ? 'register' : tab === 'heads' ? 'heads' : 'trial balance'}
          </Button>
        </span>
      </div>

      {/* ── The register ──────────────────────────────────────────────────────── */}
      {tab === 'entries' && (
        listed.length === 0
          ? (
            <EmptyState icon="book"
              title={store.entries.length === 0 ? 'The journal is empty' : 'Nothing matches'}
              message={store.entries.length === 0
                ? 'A journal entry states a movement no document raised, in two or more balanced legs. Until one is posted, your statements derive entirely from paper.'
                : 'No entry matches this search.'}
              action={store.entries.length === 0
                ? (store.heads.length === 0
                  ? <Button icon="tag" onClick={runStarters}>Add the six starting heads</Button>
                  : <Button icon="plus" onClick={() => openDraft()}>New entry</Button>)
                : <Button variant="ghost" onClick={() => setSearch('')}>Clear search</Button>} />
          ) : (
            <Card pad={false}>
              <div className="jn-head jn-row">
                <span>Number</span><span>Date</span><span>The entry</span><span>Heads moved</span><span>Amount</span><span>Status</span>
              </div>
              {listed.map(e => (
                <EntryRow key={e.id} e={e} store={store} open={!!open[e.id]}
                  onToggle={() => setOpen(o => ({ ...o, [e.id]: !o[e.id] }))}
                  onEdit={() => openDraft(e)}
                  onPost={() => runPost(e)}
                  onDelete={() => runDelete(e)}
                  onReverse={() => { setReversal({ entry: e, reason: '', date: todayISO() }); setReversalError([]) }} />
              ))}
            </Card>
          )
      )}

      {/* ── Heads ─────────────────────────────────────────────────────────────── */}
      {tab === 'heads' && (
        visibleHeads.length === 0
          ? (
            <EmptyState icon="tag"
              title={store.heads.length === 0 ? 'No head is on the register' : 'Nothing matches'}
              message={store.heads.length === 0
                ? 'A head names which line of the statements an entry moves, and it is the only place that decision is written down. Six movements a shop asks for most are offered as a starting chart.'
                : 'No head matches this search.'}
              action={store.heads.length === 0
                ? (
                  <span className="jn-actions">
                    <Button variant="ghost" icon="tag" onClick={() => openHead()}>Name your own</Button>
                    <Button icon="plus" onClick={runStarters}>Add the six starting heads</Button>
                  </span>
                )
                : <Button variant="ghost" onClick={() => setSearch('')}>Clear search</Button>} />
          ) : (
            <>
              <div className="jn-grid">
                {visibleHeads.map(h => (
                  <HeadCard key={h.id} h={h} store={store}
                    onEdit={() => openHead(h)}
                    onToggle={() => runHeadActive(h, !h.active)}
                    onDelete={() => runHeadDelete(h)} />
                ))}
              </div>
              <div className="jn-addbar">
                <Button variant="ghost" icon="plus" onClick={() => openHead()}>Add a head</Button>
                <span className="jn-addbar-note">
                  Every head declares the statement line it moves. Two entries naming the same head land on the same line — that is
                  what makes a journal figure auditable rather than free text.
                </span>
              </div>
            </>
          )
      )}

      {/* ── Trial balance ─────────────────────────────────────────────────────── */}
      {tab === 'trial' && (
        <>
          <Card pad={false} className="jn-tb-integrity">
            <div className="jn-tb-integrity-body">
              <span className={`jn-dot ${tb.entries === 0 ? 'is-nil' : tb.foots ? 'is-ok' : 'is-bad'}`}>
                <Icon name={tb.entries === 0 ? 'scale' : tb.foots ? 'check' : 'alert'} size={18} strokeWidth={2.4} />
              </span>
              <div className="jn-integrity-text">
                <div className="jn-integrity-head">
                  {tb.entries === 0
                    ? <>The columns are <strong>both zero because nothing has moved</strong>, not because the books agree. Post an entry and this schedule has a figure to foot.</>
                    : tb.foots
                    ? <>The journal&rsquo;s own columns <strong>foot to the paisa</strong> — {money(tb.total_debit)} carried on a debit, {money(tb.total_credit)} on a credit, across {tb.entries} {tb.entries === 1 ? 'posting' : 'postings'}.</>
                    : <>The columns <strong>do not foot</strong> — the debit side ({money(tb.total_debit)}) and the credit side ({money(tb.total_credit)}) differ by {money(Math.abs(tb.residual))}. That is the rupee this register lost or gained, and no schedule can close it for you.</>}
                </div>
                <p>
                  This is a trial balance of <em>the journal&rsquo;s rows only</em> — the invoices, bills and payments the financial
                  statements also read are not here. The two columns foot over what this register moved, not over your whole books.
                  Every balance is netted from the posted entries a reversed pair cancels, and a leg naming a head the register no
                  longer holds is kept on its own line rather than dropped — a foot is exactly the check for money that lost its name.
                </p>
              </div>
            </div>
          </Card>

          <div className="jn-stats">
            <StatCard label="Postings read" value={String(tb.entries)} icon="book" tone="blue"
              sub="drafts carry no number and are not here" delay={0} />
            <StatCard label="Heads with a balance" value={String(tb.moved)} icon="tag" tone="green"
              sub={`${tb.nil} named, never moved`} delay={60} />
            <StatCard label="Contra balances" value={String(tb.contra_heads)} icon="scale" tone={tb.contra_heads ? 'amber' : 'grey'}
              sub="carried against their natural side" delay={120} />
            <StatCard label="Legs with no head" value={String(tb.dangling_legs)} icon="alert" tone={tb.dangling_legs ? 'red' : 'grey'}
              sub={tb.dangling_legs ? 'kept on the placeholder line' : 'every rupee still has a name'} delay={180} />
          </div>

          {tb.lines.length === 0
            ? <EmptyState icon="scale" title="No head is on the register"
                message="A trial balance lists every head and the side it carries a balance on. Name a head, post an entry against it, and the schedule fills in." />
            : (
              <Card pad={false}>
                <div className="jn-tb-head">
                  <span>Head</span><span>Moves</span><span>Entries</span><span>Debit</span><span>Credit</span>
                </div>
                {tb.lines.map(l => (
                  <div key={l.dangling ? '(dangling)' : l.head_id}
                    className={`jn-tb-row ${l.dangling ? 'is-dangle' : ''} ${l.contra ? 'is-contra' : ''}`}>
                    <span className="jn-tb-name">
                      {l.label}
                      {l.contra && <em className="jn-tb-contra">contra</em>}
                      {l.dangling && <small>{l.entries} {l.entries === 1 ? 'entry' : 'entries'} name a head this register no longer holds</small>}
                    </span>
                    <span className="jn-tb-moves">{l.dangling ? '— no line to move' : SLOT_META[l.slot].label}</span>
                    <span className="jn-tb-entries">{l.entries}</span>
                    <span className="jn-tb-amt">{l.carried === 'debit' ? money(l.net_paise / 100) : ''}</span>
                    <span className="jn-tb-amt is-cr">{l.carried === 'credit' ? money(-l.net_paise / 100) : ''}</span>
                  </div>
                ))}
                <div className="jn-tb-foot">
                  <span className="jn-tb-foot-label">The two columns</span>
                  <span className="jn-tb-foot-cell" />
                  <span className="jn-tb-foot-cell" />
                  <span className="jn-tb-amt">{money(tb.total_debit)}</span>
                  <span className="jn-tb-amt is-cr">{money(tb.total_credit)}</span>
                </div>
              </Card>
            )}

          <div className="jn-bounds">
            <div className="jn-bounds-col">
              <SectionTitle icon="scale">How to read a line here</SectionTitle>
              <div className="jn-fact"><Icon name="hash" size={13} /><span>A head is netted across every posted entry that names it; a reversal and its original land on the same head and cancel, so the pair shows as ₹0 carried.</span></div>
              <div className="jn-fact"><Icon name="alert" size={13} /><span>A <em>contra</em> balance sits on the side opposite to the head&rsquo;s natural one — an asset over-credited, a refunded expense. It is flagged and kept there, never folded back.</span></div>
              <div className="jn-fact"><Icon name="x" size={13} /><span>A <span className="jn-mono">(no such head)</span> line gathers legs the financial statements silently drop; the columns still foot over them, so the schedule shows money the statements cannot place.</span></div>
            </div>
            <div className="jn-bounds-col">
              <SectionTitle icon="lock">What this schedule is not</SectionTitle>
              <div className="jn-fact"><Icon name="x" size={13} /><span>It is not the company&rsquo;s trial balance. No document rupee is here — only what the journal moved — and no return or statement is built from this foot.</span></div>
              <div className="jn-fact"><Icon name="x" size={13} /><span>It reads nothing the register does not hold: no opening balances, no chart of accounts, no statutory closing. It foots the journal, nothing more.</span></div>
              <div className="jn-fact"><Icon name="x" size={13} /><span>A non-zero residual is a finding, not something to force shut — the register prints the gap and leaves the entry that caused it on the record.</span></div>
            </div>
          </div>
        </>
      )}

      <div className="jn-foot">
        <span>
          Entries and heads are stored in this browser at <span className="jn-mono">taxflow:journal:&lt;org&gt;</span>. Numbering is dressed from the{' '}
          <Link href="/business">business register</Link>&apos;s journal series and counted here — see <Link href="/business?tab=series">document series</Link> for the shape.
        </span>
        <span className="jn-foot-links">
          <Link href="/accounting">Financial statements →</Link>
          <Link href="/audit">Audit trail →</Link>
          <Link href="/vault">Books vault →</Link>
        </span>
      </div>

      {/* ── The composer ──────────────────────────────────────────────────────── */}
      {draft && (
        <div className="jn-scrim" role="dialog" aria-modal="true" aria-label={saving === 'post' ? 'Post a journal entry' : 'Compose a journal entry'}>
          <div className="jn-modal">
            <div className="jn-modal-head">
              <div>
                <h2>{draft.number ? `Edit ${draft.number}` : 'Compose an entry'}</h2>
                <p>Two legs or more, one side to take the rupee and one to give it. It folds into the statements only once it is posted.</p>
              </div>
              <button type="button" className="jn-close" onClick={closeDraft} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {draftError.length > 0 && (
              <div className="jn-alert" role="alert">
                <Icon name="alert" size={14} strokeWidth={2.2} />
                <span>
                  {draftError.length === 1 ? draftError[0] : (
                    <ul className="jn-problems">{draftError.map(p => <li key={p}>{p}</li>)}</ul>
                  )}
                </span>
              </div>
            )}

            <div className="jn-fields">
              <label className="jn-field">
                <span>Date *</span>
                <input className="tf-input" type="date" value={draft.date}
                  onChange={e => setDraft({ ...draft, date: e.target.value })} autoFocus />
              </label>
              <label className="jn-field jn-field-wide">
                <span>Narration *</span>
                <input className="tf-input" value={draft.narration}
                  onChange={e => setDraft({ ...draft, narration: e.target.value })}
                  placeholder="Depreciation on the delivery vehicles, FY…" />
              </label>
              <label className="jn-field">
                <span>Reference (optional)</span>
                <input className="tf-input" value={draft.reference}
                  onChange={e => setDraft({ ...draft, reference: e.target.value })}
                  placeholder="Voucher no., notice, CA note…" />
              </label>
            </div>

            {draftSeal.sealed ? (
              <div className="jn-sealed" role="status">
                <Icon name="lock" size={14} />
                <span>{draftSeal.why} Nothing is saved if you press either button — and the attempt itself goes on the <Link href="/audit">audit trail</Link>, so a write that was stopped is still evidence.</span>
              </div>
            ) : (
              <p className="jn-hint">
                {draft.number
                  ? `${draft.number} is a draft — saving keeps it a draft. The number was never taken, so nothing has a hole in it.`
                  : `Posting takes the next number in your own series: ${peekNumber(store, draft.date, orgId) || '—'}${draft.date && beforeTheBooks.length > 0 && openingAsOf && draft.date < openingAsOf ? `, dated before the books opened on ${formatDateIN(openingAsOf)}` : ''}.`}
              </p>
            )}

            <div className="jn-legs">
              <div className="jn-legs-head">
                <span>Head</span><span>Side</span><span>Rupees</span><span>Why this leg</span><span />
              </div>
              {liveLegs.map((l, i) => {
                const problem = draftProblems.find(p => p.index === i)
                const head_ = headById(store, l.head_id)
                const dangling = unresolvableLegs([l], store).length > 0 && !!l.head_id
                return (
                  <div key={l.id} className="jn-leg-wrap">
                    <div className="jn-leg">
                      <select className="tf-input" value={l.head_id}
                        onChange={e => patchLeg(l.id, { head_id: e.target.value })}
                        aria-label={`Leg ${i + 1} head`}>
                        <option value="">Choose a head…</option>
                        {headGroups(store, draft.legs.map(l => l.head_id)).map(g => (
                          <optgroup key={g.group} label={GROUP_LABEL[g.group]}>
                            {g.heads.map(h => <option key={h.id} value={h.id}>{h.name}{h.active ? '' : ' (closed)'}</option>)}
                          </optgroup>
                        ))}
                      </select>
                      <div className="jn-sides" role="group" aria-label={`Leg ${i + 1} side`}>
                        {SIDES.map(s => (
                          <button key={s} type="button"
                            className={`jn-side ${l.side === s ? 'is-on' : ''} ${s === 'debit' ? 'is-dr' : 'is-cr'}`}
                            aria-pressed={l.side === s}
                            title={head_
                              ? `${s === 'debit' ? 'Debit' : 'Credit'} — ${head_.name} grows on a ${SLOT_META[head_.slot].natural}`
                              : `${s === 'debit' ? 'Debit' : 'Credit'} — name a head and the picker says which side grows it`}
                            onClick={() => patchLeg(l.id, { side: s })}>
                            {s === 'debit' ? 'Dr' : 'Cr'}
                          </button>
                        ))}
                      </div>
                      <input className="tf-input jn-amount" inputMode="decimal" placeholder="0"
                        value={amounts[l.id] ?? ''}
                        onChange={e => setAmounts(a => ({ ...a, [l.id]: e.target.value.replace(/[^0-9.]/g, '') }))}
                        aria-label={`Leg ${i + 1} amount`} />
                      <input className="tf-input" placeholder="note (optional)" value={l.note}
                        onChange={e => patchLeg(l.id, { note: e.target.value })}
                        aria-label={`Leg ${i + 1} note`} />
                      <button type="button" className="jn-leg-x" onClick={() => removeLeg(l.id)}
                        aria-label={`Remove leg ${i + 1}`} disabled={liveLegs.length <= 2}>
                        <Icon name="x" size={14} />
                      </button>
                    </div>
                    {(problem || dangling) && (
                      <p className="jn-leg-problem">
                        <Icon name="alert" size={12} strokeWidth={2.2} />
                        {dangling ? 'This leg names a head the register no longer holds — re-point it or the entry cannot be posted.' : problem?.problem}
                      </p>
                    )}
                  </div>
                )
              })}
              <button type="button" className="jn-addleg" onClick={addLeg}>
                <Icon name="plus" size={13} /> Add a leg
              </button>
            </div>

            {/* The balance meter — the engine's own totals, read live off the typed rupees. */}
            <div className="jn-meter">
              <div className="jn-meter-sides">
                <div className="jn-meter-side is-dr">
                  <span>Debits</span>
                  <strong>{money(draftTotals.debit)}</strong>
                  <div className="jn-bar"><i style={{ width: `${barPct(draftTotals.debit, draftTotals)}%` }} /></div>
                </div>
                <div className="jn-meter-side is-cr">
                  <span>Credits</span>
                  <strong>{money(draftTotals.credit)}</strong>
                  <div className="jn-bar"><i style={{ width: `${barPct(draftTotals.credit, draftTotals)}%` }} /></div>
                </div>
              </div>
              <div className={`jn-verdict ${draftTotals.balanced && draftTotals.debitPaise > 0 ? 'is-ok' : 'is-out'}`}>
                <Icon name={draftTotals.balanced && draftTotals.debitPaise > 0 ? 'check' : 'scale'} size={13} strokeWidth={2.2} />
                <span>
                  {draftTotals.lines === 0
                    ? 'An entry is at least two legs.'
                    : draftTotals.debitPaise === 0 && draftTotals.creditPaise === 0
                      ? 'Nothing typed yet — two empty legs balance to the paisa, but they state no movement.'
                      : draftTotals.balanced
                        ? `Balanced to the paisa across ${draftTotals.lines} legs — posting this moves a named line and leaves the derived capital figure where it stands.`
                        : `Out by ${money(Math.abs(draftTotals.difference))} — ${draftTotals.difference > 0 ? 'the debit side is heavier' : 'the credit side is heavier'}. A draft may stand unbalanced; a posting may not.`}
                </span>
              </div>
            </div>

            <div className="jn-save">
              <Button variant="ghost" onClick={closeDraft}>Cancel</Button>
              <Button variant="subtle" icon="edit" onClick={saveDraft} disabled={!canSave}>Save draft</Button>
              <Button icon="check" onClick={postDraft} disabled={!canPost || saving === 'post'}>
                {saving === 'post' ? 'Posting…' : 'Post it'}
              </Button>
            </div>
            {!canPost && !!draft && !draftSeal.sealed && (
              <p className="jn-save-hint">
                {draftTotals.balanced
                  ? 'Posting also wants a narration, a readable date, and every leg naming an open head with a real rupee amount.'
                  : 'Post it becomes live once the two sides foot.'}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Reverse an entry ──────────────────────────────────────────────────── */}
      {reversal && (
        <div className="jn-scrim" role="dialog" aria-modal="true" aria-label={`Reverse ${reversal.entry.number}`}>
          <div className="jn-modal" style={{ maxWidth: 520 }}>
            <div className="jn-modal-head">
              <div>
                <h2>Reverse {reversal.entry.number}</h2>
                <p>The original is not edited or deleted. A second entry is posted with every leg&rsquo;s side flipped — the same heads,
                  the same rupees, the opposite direction — and both halves stay on the register.</p>
              </div>
              <button type="button" className="jn-close" onClick={() => setReversal(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {reversalError.length > 0 && (
              <div className="jn-alert" role="alert">
                <Icon name="alert" size={14} strokeWidth={2.2} />
                <ul className="jn-problems">{reversalError.map(p => <li key={p}>{p}</li>)}</ul>
              </div>
            )}

            <div className="jn-facts">
              <StatRow label="Original" value={`${formatDateIN(reversal.entry.date)} · ${reversal.entry.narration || '—'}`} />
              <StatRow label="Amount" value={money(totals(reversal.entry.legs).debit)} />
              <StatRow label="Heads" value={entryHeadNames(reversal.entry.legs, store).join(' · ')} />
              {reversal.entry.reversed_by && <StatRow label="Already answered" value="this entry has a reversal" tone="amber" />}
            </div>

            <label className="jn-field">
              <span>Why is it being reversed? *</span>
              <textarea className="tf-input" rows={3} value={reversal.reason}
                onChange={e => setReversal({ ...reversal, reason: e.target.value })}
                placeholder="The depreciation rate the CA named was 10%, not 15%; the entry overstated by ₹24,000…"
                style={{ resize: 'vertical' }} autoFocus />
              <span className="jn-hint">An unexplained reversal is the same silent unlock a seal refuses — the register will not take it.</span>
            </label>

            <label className="jn-field">
              <span>Dated</span>
              <input className="tf-input" type="date" value={reversal.date}
                onChange={e => setReversal({ ...reversal, date: e.target.value })} />
            </label>

            {(() => {
              const g = orgId ? sealGuard(orgId, reversal.date) : { sealed: false, why: '', label: '' }
              if (!g.sealed) return null
              return (
                <div className="jn-sealed" role="status">
                  <Icon name="lock" size={14} />
                  <span>{g.why}</span>
                </div>
              )
            })()}

            <div className="jn-preview">
              <div className="jn-preview-head">
                <span>What reversing writes</span>
                <span className="jn-preview-total">{peekNumber(store, reversal.date, orgId) || 'the next number'}</span>
              </div>
              <ul className="jn-preview-list">
                <li>The original stays, marked reversed<span className="jn-preview-take">kept</span></li>
                <li>A mirror entry with every leg&rsquo;s side flipped<span className="jn-preview-take">{money(totals(reversal.entry.legs).debit)} back</span></li>
                <li>The pair nets to nothing on the statements<span className="jn-preview-take">₹0</span></li>
              </ul>
            </div>

            <div className="jn-save">
              <Button variant="ghost" onClick={() => setReversal(null)}>Keep it</Button>
              <Button variant="danger" icon="undo" onClick={runReverse} disabled={!reversal.reason.trim()}>Post the reversal</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── A head ────────────────────────────────────────────────────────────── */}
      {head && (
        <div className="jn-scrim" role="dialog" aria-modal="true" aria-label="Name a head">
          <div className="jn-modal" style={{ maxWidth: 480 }}>
            <div className="jn-modal-head">
              <div>
                <h2>{store.heads.some(h => h.id === head.id) ? `Edit ${head.name || 'the head'}` : 'Name a head'}</h2>
                <p>A head is a name and a place: what the statement line prints, and which line of the derived figures it moves.</p>
              </div>
              <button type="button" className="jn-close" onClick={() => setHead(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {headError.length > 0 && (
              <div className="jn-alert" role="alert">
                <Icon name="alert" size={14} strokeWidth={2.2} />
                <ul className="jn-problems">{headError.map(p => <li key={p}>{p}</li>)}</ul>
              </div>
            )}

            <label className="jn-field">
              <span>Name *</span>
              <input className="tf-input" value={head.name} maxLength={40}
                onChange={e => setHead({ ...head, name: e.target.value })}
                placeholder="Depreciation — vehicles" autoFocus />
              <span className="jn-hint">Forty characters or fewer — this name prints beside a figure on /accounting.</span>
            </label>

            <label className="jn-field">
              <span>Moves which statement line? *</span>
              <select className="tf-input" value={head.slot}
                onChange={e => setHead({ ...head, slot: e.target.value as StatementSlot })}>
                {SLOTS_BY_GROUP.map(g => (
                  <optgroup key={g} label={GROUP_LABEL[g]}>
                    {slotsInGroup(g).map(s => <option key={s} value={s}>{SLOT_META[s].label}</option>)}
                  </optgroup>
                ))}
              </select>
              <span className="jn-hint">
                {SLOT_META[head.slot].where === 'pl' ? 'The profit & loss statement' : 'The balance sheet'} reads it.
                This line grows on a <strong>{SLOT_META[head.slot].natural}</strong>.
              </span>
            </label>

            <label className="jn-field">
              <span>Notes (optional)</span>
              <textarea className="tf-input" rows={2} value={head.notes}
                onChange={e => setHead({ ...head, notes: e.target.value })}
                placeholder="How the figure is arrived at, or who named it…" style={{ resize: 'vertical' }} />
            </label>

            {(() => {
              const problems = validateHead({ ...head, name: head.name.trim() }, store.heads)
              if (problems.length === 0) return null
              return <p className="jn-leg-problem"><Icon name="alert" size={12} strokeWidth={2.2} />{problems[0]}</p>
            })()}

            <div className="jn-save">
              <Button variant="ghost" onClick={() => setHead(null)}>Cancel</Button>
              <Button icon="tag" onClick={runHead}
                disabled={validateHead({ ...head, name: head.name.trim() }, store.heads).length > 0}>
                Save head
              </Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .jn-wrap { display: flex; flex-direction: column; }
        .jn-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }

        .jn-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px;
          font-size: 12.5px; color: var(--green); background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 10px; }
        .jn-notice svg { flex-shrink: 0; }
        .jn-notice.is-bad { color: var(--amber); background: var(--amber-soft);
          border-color: color-mix(in srgb, var(--amber) 26%, white); }
        .jn-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; border-radius: 6px; min-height: 0; }
        .jn-notice-x:hover { background: rgba(0,0,0,0.05); }

        .jn-alert { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; border-radius: 10px; margin-bottom: 12px;
          padding: 10px 12px; background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .jn-alert svg { flex-shrink: 0; margin-top: 2px; }
        .jn-problems { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 3px; }

        .jn-integrity { margin-bottom: 1rem; }
        .jn-integrity-body { display: flex; align-items: flex-start; gap: 13px; padding: 14px 16px; }
        .jn-dot { width: 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .jn-dot.is-ok { color: var(--green); background: var(--green-soft); }
        .jn-dot.is-bad { color: var(--red); background: var(--red-soft); }
        .jn-dot.is-nil { color: var(--muted); background: var(--surface-2); }
        .jn-integrity-text { min-width: 0; flex: 1; }
        .jn-integrity-head { font-size: 13.5px; color: var(--ink); line-height: 1.5; }
        .jn-integrity-head strong { font-weight: 700; }
        .jn-integrity-text p { font-size: 11.5px; color: var(--muted); line-height: 1.6; margin: 5px 0 0; }
        .jn-integrity-text em { color: var(--ink-2); font-style: normal; font-weight: 650; }
        .jn-integrity-side { flex-shrink: 0; align-self: center; }
        .jn-findings { list-style: none; margin: 7px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .jn-findings li { display: flex; align-items: flex-start; gap: 7px; font-size: 11.5px; color: var(--muted); line-height: 1.55; }
        .jn-findings svg { flex-shrink: 0; margin-top: 1px; color: var(--amber); }
        .jn-mono { font-family: var(--mono); font-size: 0.94em; }

        .jn-bounds { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 1.15rem; }
        .jn-bounds-col { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 15px 16px; }
        .jn-moves { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
        .jn-moves li { display: flex; align-items: baseline; gap: 10px; font-size: 12.5px; padding: 6px 0; border-top: 1px solid var(--line-soft); }
        .jn-moves li:first-child { border-top: none; }
        .jn-move-line { color: var(--ink-2); font-weight: 600; min-width: 0; }
        .jn-move-amt { margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 650; }
        .jn-move-amt.is-up { color: var(--green); }
        .jn-move-amt.is-down { color: var(--red); }
        .jn-bounds-empty { font-size: 12px; color: var(--faint); margin: 4px 0 0; line-height: 1.6; }
        .jn-bounds-note { font-size: 11.5px; color: var(--muted); line-height: 1.6; margin: 11px 0 0; }
        .jn-bounds-note em { color: var(--ink-2); font-style: normal; font-weight: 650; }
        .jn-bounds-note a { color: var(--brand); text-decoration: none; }
        .jn-fact { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--muted); line-height: 1.55; padding: 6px 0; }
        .jn-fact svg { flex-shrink: 0; margin-top: 2px; color: var(--faint); }
        .jn-fact a { color: var(--brand); text-decoration: none; }

        .jn-draftbar { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--ink-2);
          background: var(--slate-soft); border: 1px solid var(--line); border-radius: var(--radius-lg);
          padding: 10px 13px; margin-bottom: 1rem; line-height: 1.5; }
        .jn-draftbar svg { color: var(--amber); flex-shrink: 0; }
        .jn-draftbar-acts { margin-left: auto; display: flex; gap: 8px; flex-shrink: 0; }

        .jn-sealbar { display: flex; align-items: center; gap: 9px; font-size: 12px; color: var(--ink-2);
          background: var(--red-soft); border: 1px solid color-mix(in srgb, var(--red) 18%, white);
          border-radius: var(--radius-lg); padding: 9px 13px; margin-bottom: 10px; line-height: 1.55; }
        .jn-sealbar svg { color: var(--red); flex-shrink: 0; }
        .jn-sealbar.is-soft { background: var(--slate-soft); border-color: var(--line); color: var(--muted); }
        .jn-sealbar.is-soft svg { color: var(--violet); }
        .jn-sealbar button { margin-left: auto; flex-shrink: 0; }
        .jn-seallink { margin-left: auto; font-size: 11.5px; font-weight: 650; color: var(--brand); text-decoration: none; white-space: nowrap; }

        .jn-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
        .jn-export { margin-left: auto; }

        .jn-head, .jn-row { display: grid; grid-template-columns: 130px 104px minmax(0, 1.6fr) minmax(0, 1.4fr) 120px 168px;
          gap: 12px; align-items: center; padding: 10px 16px; }
        .jn-head { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
          color: var(--faint); border-bottom: 1px solid var(--line); }
        .jn-row.is-entry { border-top: 1px solid var(--line-soft); padding-top: 11px; padding-bottom: 11px; }
        .jn-row.is-entry:hover { background: var(--surface-2); }
        .jn-row.is-draft { background: color-mix(in srgb, var(--amber-soft) 55%, var(--surface)); }
        .jn-toggle { background: none; border: none; color: var(--faint); cursor: pointer; padding: 2px; min-height: 0;
          display: inline-flex; align-items: center; border-radius: 5px; vertical-align: -2px; margin-right: 4px; }
        .jn-toggle:hover { background: var(--slate-soft); color: var(--ink-2); }
        .jn-num { font-size: 12px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
        .jn-num.is-draft { color: var(--amber); font-weight: 650; }
        .jn-date { font-size: 11.5px; color: var(--muted); }
        .jn-narr { font-size: 12.5px; color: var(--ink-2); line-height: 1.45; min-width: 0; }
        .jn-narr small { display: block; font-size: 10.5px; color: var(--faint); margin-top: 2px; }
        .jn-heads { font-size: 11.5px; color: var(--muted); line-height: 1.45; min-width: 0; }
        .jn-amt { font-size: 12.5px; font-weight: 650; color: var(--ink); font-variant-numeric: tabular-nums; text-align: right; }
        .jn-amt small { display: block; font-weight: 500; color: var(--faint); font-size: 10px; }
        .jn-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; justify-content: flex-end; }

        .jn-legs-open { background: var(--surface-2); border-top: 1px solid var(--line-soft); padding: 12px 16px 14px; }
        .jn-legs-title { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); margin-bottom: 8px; }
        .jn-leg-line { display: grid; grid-template-columns: minmax(0, 1.4fr) 52px 120px minmax(0, 1fr); gap: 10px; align-items: baseline;
          font-size: 12px; padding: 5px 0; border-top: 1px dashed var(--line); }
        .jn-leg-line:first-of-type { border-top: none; }
        .jn-leg-head { color: var(--ink-2); font-weight: 600; }
        .jn-leg-side { font-size: 10.5px; font-weight: 700; }
        .jn-leg-side.is-dr { color: var(--brand); }
        .jn-leg-side.is-cr { color: var(--violet); }
        .jn-leg-amt { font-variant-numeric: tabular-nums; text-align: right; color: var(--ink); }
        .jn-leg-note { color: var(--faint); font-size: 11px; }
        .jn-why { font-size: 11.5px; color: var(--muted); line-height: 1.55; margin: 9px 0 0; }

        .jn-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
        .jn-card { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--violet);
          border-radius: var(--radius-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 9px; box-shadow: var(--shadow-xs); }

        .jn-tb-integrity { margin-bottom: 1rem; }
        .jn-tb-integrity-body { display: flex; align-items: flex-start; gap: 13px; padding: 14px 16px; }
        .jn-tb-head, .jn-tb-row, .jn-tb-foot { display: grid;
          grid-template-columns: minmax(0, 1.7fr) minmax(0, 1.1fr) 76px 130px 130px; gap: 12px; align-items: baseline; }
        .jn-tb-head { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
          color: var(--faint); border-bottom: 1px solid var(--line); padding: 10px 16px; }
        .jn-tb-row { border-top: 1px solid var(--line-soft); padding: 11px 16px; }
        .jn-tb-row:first-of-type { border-top: none; }
        .jn-tb-row.is-contra { background: color-mix(in srgb, var(--amber-soft) 42%, var(--surface)); }
        .jn-tb-row.is-dangle { background: color-mix(in srgb, var(--red-soft) 48%, var(--surface)); }
        .jn-tb-name { font-size: 12.5px; font-weight: 650; color: var(--ink); min-width: 0; }
        .jn-tb-name small { display: block; font-size: 10.5px; font-weight: 500; color: var(--red); margin-top: 2px; }
        .jn-tb-contra { display: inline-block; margin-left: 7px; font-size: 9.5px; font-style: normal; font-weight: 700;
          letter-spacing: 0.04em; text-transform: uppercase; color: var(--amber); background: var(--amber-soft);
          border-radius: 6px; padding: 1px 6px; vertical-align: 1px; }
        .jn-tb-moves { font-size: 11.5px; color: var(--muted); min-width: 0; }
        .jn-tb-entries { font-size: 11.5px; color: var(--faint); font-variant-numeric: tabular-nums; }
        .jn-tb-amt { font-size: 12.5px; font-weight: 650; color: var(--brand); font-variant-numeric: tabular-nums; text-align: right; }
        .jn-tb-amt.is-cr { color: var(--violet); }
        .jn-tb-foot { border-top: 2px solid var(--line); padding: 11px 16px; font-weight: 700; }
        .jn-tb-foot-label { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .jn-tb-foot .jn-tb-amt { color: var(--ink); }
        .jn-card.is-closed { border-left-color: var(--faint); opacity: 0.85; }
        .jn-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .jn-card-name { font-size: 13.5px; font-weight: 700; color: var(--ink); }
        .jn-card-sub { font-size: 11px; color: var(--faint); margin-top: 2px; }
        .jn-card-note { font-size: 11.5px; color: var(--muted); line-height: 1.55; }
        .jn-card-foot { display: flex; align-items: center; gap: 8px; margin-top: auto; }
        .jn-card-bal { font-size: 12.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
        .jn-card-bal.is-up { color: var(--green); }
        .jn-card-bal.is-down { color: var(--red); }
        .jn-card-bal.is-nil { color: var(--faint); font-weight: 550; }

        .jn-addbar { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
        .jn-addbar-note { font-size: 11.5px; color: var(--faint); line-height: 1.55; max-width: 620px; }

        .jn-foot { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-top: 1.5rem;
          font-size: 11.5px; color: var(--faint); line-height: 1.6; }
        .jn-foot a { color: var(--brand); text-decoration: none; }
        .jn-foot-links { display: flex; gap: 16px; flex-wrap: wrap; }

        .jn-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; overflow-y: auto; }
        .jn-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-width: 680px; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 13px; }
        .jn-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
        .jn-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .jn-modal-head p { font-size: 12px; color: var(--muted); margin: 4px 0 0; line-height: 1.55; max-width: 52ch; }
        .jn-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; min-height: 0; }
        .jn-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .jn-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 11px; }
        .jn-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .jn-field-wide { grid-column: 1 / -1; }
        .jn-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .jn-field strong { font-weight: 700; color: var(--ink); }
        .jn-hint { font-size: 11px; color: var(--faint); line-height: 1.55; margin: 0; }

        .jn-sealed { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.55;
          color: var(--red); background: var(--red-soft); border-left: 3px solid var(--red);
          border-radius: var(--radius-sm); padding: 9px 11px; }
        .jn-sealed svg { flex-shrink: 0; margin-top: 2px; }

        .jn-legs { display: flex; flex-direction: column; gap: 8px; }
        .jn-legs-head, .jn-leg { display: grid; grid-template-columns: minmax(0, 1.5fr) 92px 110px minmax(0, 1.1fr) 30px; gap: 8px; align-items: center; }
        .jn-legs-head { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .jn-leg-wrap { display: flex; flex-direction: column; gap: 4px; }
        .jn-sides { display: flex; gap: 4px; }
        .jn-side { flex: 1; font-family: inherit; font-size: 11.5px; font-weight: 700; padding: 7px 0; cursor: pointer;
          border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); color: var(--faint); min-height: 0; }
        .jn-side.is-dr.is-on { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); }
        .jn-side.is-cr.is-on { border-color: var(--violet); background: var(--violet-soft); color: var(--violet); }
        .jn-amount { text-align: right; font-variant-numeric: tabular-nums; }
        .jn-leg-x { background: none; border: none; color: var(--faint); cursor: pointer; padding: 5px; border-radius: 6px; min-height: 0; }
        .jn-leg-x:hover:not(:disabled) { background: var(--red-soft); color: var(--red); }
        .jn-leg-x:disabled { opacity: 0.35; cursor: not-allowed; }
        .jn-leg-problem { display: flex; align-items: flex-start; gap: 6px; font-size: 11px; color: var(--amber); margin: 0; line-height: 1.5; }
        .jn-leg-problem svg { flex-shrink: 0; margin-top: 1px; }
        .jn-addleg { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; background: none;
          border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); font-family: inherit; font-size: 12px;
          font-weight: 600; padding: 7px 11px; cursor: pointer; min-height: 0; }
        .jn-addleg:hover { border-color: var(--brand); color: var(--brand); }

        .jn-meter { border: 1px solid var(--line); border-radius: 12px; padding: 12px 13px; background: var(--surface-2); }
        .jn-meter-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .jn-meter-side span { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .jn-meter-side strong { display: block; font-size: 15px; font-variant-numeric: tabular-nums; color: var(--ink); margin-top: 2px; }
        .jn-meter-side.is-dr strong { color: var(--brand); }
        .jn-meter-side.is-cr strong { color: var(--violet); }
        .jn-bar { height: 5px; border-radius: 999px; background: var(--line); margin-top: 6px; overflow: hidden; }
        .jn-bar i { display: block; height: 100%; border-radius: 999px; background: var(--brand); transition: width 160ms ease; }
        .jn-meter-side.is-cr .jn-bar i { background: var(--violet); }
        .jn-verdict { display: flex; align-items: flex-start; gap: 7px; font-size: 11.5px; line-height: 1.55; margin-top: 11px;
          padding-top: 10px; border-top: 1px solid var(--line); }
        .jn-verdict svg { flex-shrink: 0; margin-top: 2px; }
        .jn-verdict.is-ok { color: var(--green); }
        .jn-verdict.is-out { color: var(--amber); }

        .jn-facts { display: flex; flex-direction: column; }
        .jn-preview { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--surface-2); }
        .jn-preview-head { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .jn-preview-total { color: var(--brand); font-variant-numeric: tabular-nums; text-transform: none; letter-spacing: 0; }
        .jn-preview-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .jn-preview-list li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--ink-2); line-height: 1.5; flex-wrap: wrap; }
        .jn-preview-take { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 650; color: var(--ink); }
        .jn-save { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
        .jn-save-hint { font-size: 11px; color: var(--faint); margin: 0; text-align: right; width: 100%; }

        @media (max-width: 1100px) { .jn-stats { grid-template-columns: 1fr 1fr; } .jn-bounds { grid-template-columns: 1fr; } }
        @media (max-width: 980px) {
          .jn-head { display: none; }
          .jn-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4px 12px; }
          .jn-row.is-entry { padding: 12px 14px; }
          .jn-amt { text-align: left; }
          .jn-actions { grid-column: 1 / -1; justify-content: flex-start; }
          .jn-legs-head { display: none; }
          .jn-leg { grid-template-columns: minmax(0, 1fr) 96px; }
          .jn-leg > select { grid-column: 1 / -1; }
          .jn-leg .jn-sides { grid-column: 1; }
          .jn-leg .jn-amount { grid-column: 2; }
          .jn-leg > input:nth-of-type(2) { grid-column: 1; }
          .jn-leg .jn-leg-x { grid-column: 2; justify-self: end; }
          .jn-leg-line { grid-template-columns: minmax(0, 1fr) 40px 100px; }
          .jn-leg-note { grid-column: 1 / -1; }
          .jn-tb-head, .jn-tb-moves, .jn-tb-entries, .jn-tb-foot-cell { display: none; }
          .jn-tb-row, .jn-tb-foot { grid-template-columns: minmax(0, 1fr) 110px 110px; }
        }
        @media (max-width: 768px) {
          .jn-grid { grid-template-columns: 1fr; }
          .jn-stats { grid-template-columns: 1fr 1fr; }
          .jn-export { margin-left: 0; }
          .jn-fields { grid-template-columns: 1fr; }
          .jn-scrim { align-items: flex-end; padding: 0; }
          .jn-scrim .jn-modal { max-width: none; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .jn-save { flex-direction: column-reverse; }
          .jn-save .tf-btn { width: 100%; justify-content: center; }
          .jn-draftbar, .jn-sealbar { flex-wrap: wrap; }
          .jn-draftbar-acts, .jn-seallink { margin-left: 0; }
        }
      `}</style>
    </div>
  )
}

/** The two bars are drawn against the heavier side, so an out-of-balance entry is visible, not just stated. */
function barPct(side: number, t: { debit: number; credit: number }): number {
  const max = Math.max(t.debit, t.credit, 1)
  return Math.max(0, Math.min(100, (side / max) * 100))
}

/** How many entries name a head — the count the close-head notice prints, and the delete button's reason. */
function entriesNaming(store: JournalStore, headId: string): number {
  return store.entries.filter(e => e.legs.some(l => l.head_id === headId)).length
}

/** Which printed sheet an entry's heads land on — so a row can say where its rupee went. */
function statements(legs: JournalLeg[], store: JournalStore): string {
  const heads = legs.map(l => headById(store, l.head_id)).filter((h): h is JournalHead => !!h)
  const onPl = heads.some(h => SLOT_META[h.slot].where === 'pl')
  const onBs = heads.some(h => SLOT_META[h.slot].where === 'bs')
  if (onPl && onBs) return 'both statements'
  if (onPl) return 'the profit & loss statement'
  if (onBs) return 'the balance sheet'
  return 'no statement line it recognises'
}

function EntryRow({
  e, store, open, onToggle, onEdit, onPost, onDelete, onReverse,
}: {
  e: JournalEntry
  store: JournalStore
  open: boolean
  onToggle: () => void
  onEdit: () => void
  onPost: () => void
  onDelete: () => void
  onReverse: () => void
}) {
  const t = totals(e.legs)
  const meta = STATUS_META[e.status]
  const mirror = e.reversed_by ? store.entries.find(x => x.id === e.reversed_by) : undefined
  const original = e.reverses ? store.entries.find(x => x.id === e.reverses) : undefined
  const names = entryHeadNames(e.legs, store)
  const dangling = unresolvableLegs(e.legs, store).length

  return (
    <>
      <div className={`jn-row is-entry ${e.status === 'draft' ? 'is-draft' : ''}`}>
        <span className={`jn-num ${e.status === 'draft' ? 'is-draft' : ''}`}>
          <button type="button" className="jn-toggle" onClick={onToggle} aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the legs of ${e.number || 'this draft'}`}>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
          </button>
          {e.number || 'Draft'}
        </span>
        <span className="jn-date">{e.date ? formatDateIN(e.date) : '—'}</span>
        <span className="jn-narr">
          {e.narration || <em style={{ color: 'var(--faint)' }}>no narration yet</em>}
          {(e.reference || original || e.actor) && (
            <small>
              {original ? `Reverses ${original.number} · ` : ''}
              {e.reference ? `${e.reference} · ` : ''}
              {e.actor || ''}
            </small>
          )}
        </span>
        <span className="jn-heads">{names.join(' · ')}</span>
        <span className="jn-amt">
          {money(t.debit)}
          <small>{t.balanced ? 'both sides' : `out by ${money(Math.abs(t.difference))}`}</small>
        </span>
        <span className="jn-actions">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          {e.status === 'draft' && (
            <>
              <Button variant="ghost" size="sm" icon="edit" onClick={onEdit}>Open</Button>
              <Button variant="ghost" size="sm" icon="check" onClick={onPost} disabled={!t.balanced || !e.narration.trim()}>Post</Button>
              <Button variant="ghost" size="sm" icon="x" onClick={onDelete}>Delete</Button>
            </>
          )}
          {e.status === 'posted' && (
            <Button variant="ghost" size="sm" icon="undo" onClick={onReverse}>Reverse</Button>
          )}
          {e.status === 'reversed' && (
            <span className="jn-date">{mirror ? `by ${mirror.number}` : 'reversal not on this register'}</span>
          )}
        </span>
      </div>
      {open && (
        <div className="jn-legs-open">
          <div className="jn-legs-title">The legs{dangling > 0 ? ` — ${dangling} naming a head that is gone` : ''}</div>
          {e.legs.map(l => {
            const h = headById(store, l.head_id)
            return (
              <div key={l.id} className="jn-leg-line">
                <span className="jn-leg-head">{h ? h.name : '— missing head'}</span>
                <span className={`jn-leg-side ${l.side === 'debit' ? 'is-dr' : 'is-cr'}`}>{l.side === 'debit' ? 'Dr' : 'Cr'}</span>
                <span className="jn-leg-amt">{money(l.amount)}</span>
                <span className="jn-leg-note">{h ? `${SLOT_META[h.slot].label}${h.active ? '' : ' · head closed'}` : 'no line to move'}</span>
              </div>
            )
          })}
          <p className="jn-why">
            {e.status === 'draft'
              ? 'A draft is a shape, not a posting: the statements do not read it and no number has been taken. Post it when both sides foot and the narration says what happened.'
              : e.status === 'reversed'
                ? `${e.number} is answered by ${mirror ? mirror.number : 'a reversal that is no longer here'}. Both halves keep folding, and the pair nets to nothing — the movement is on the record, the figure is not in the statements.`
                : `${e.number} folds into ${statements(e.legs, store)}, onto every line its heads name. Both sides foot at ${money(t.debit)}, which is why the derived capital figure on the balance sheet does not move.`}
          </p>
        </div>
      )}
    </>
  )
}

function HeadCard({
  h, store, onEdit, onToggle, onDelete,
}: {
  h: JournalHead
  store: JournalStore
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  const bal = headBalance(store, h.id)
  const meta = SLOT_META[h.slot]
  const used = entriesNaming(store, h.id)
  return (
    <div className={`jn-card ${h.active ? '' : 'is-closed'}`}>
      <div className="jn-card-head">
        <div>
          <div className="jn-card-name">{h.name}</div>
          <div className="jn-card-sub">{meta.label} · {GROUP_LABEL[meta.group]} · grows on a {meta.natural}</div>
        </div>
        <Badge tone={h.active ? 'violet' : 'grey'} dot={false}>{h.active ? 'Open' : 'Closed'}</Badge>
      </div>

      {h.notes && <div className="jn-card-note">{h.notes}</div>}

      <div className="jn-card-foot">
        <span className={`jn-card-bal ${bal.signed === 0 ? 'is-nil' : bal.signed > 0 ? 'is-up' : 'is-down'}`}>
          {bal.signed === 0
            ? bal.entries === 0
              ? '₹0 — never moved'
              : `₹0 where it stands · ${bal.entries} ${bal.entries === 1 ? 'posting names' : 'postings name'} it and they net to nothing`
            : `${signed(bal.signed)} · ${bal.entries} ${bal.entries === 1 ? 'entry' : 'entries'}`}
        </span>
        <span className="jn-actions" style={{ marginLeft: 'auto' }}>
          <Button variant="ghost" size="sm" icon={h.active ? 'lock' : 'unlock'} onClick={onToggle}>
            {h.active ? 'Close' : 'Reopen'}
          </Button>
          <Button variant="ghost" size="sm" icon="edit" onClick={onEdit}>Edit</Button>
          <Button variant="ghost" size="sm" icon="x" onClick={onDelete} disabled={used > 0}
            title={used > 0 ? `${used} ${used === 1 ? 'entry carries' : 'entries carry'} this head — close it instead of deleting` : 'Delete the head'}>
            Delete
          </Button>
        </span>
      </div>
    </div>
  )
}

export default function JournalPage() {
  return (
    <Suspense fallback={<div className="jn-wrap"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <JournalPageInner />
    </Suspense>
  )
}
