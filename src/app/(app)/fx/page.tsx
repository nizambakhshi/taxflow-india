'use client'

// Multi-currency — the register that says what a foreign-currency deal is worth, twice.
//
// The engine (src/lib/fx.ts) owns the model: a rate is a dated record with a source stamp, an
// entry joins to the books by invoice number, and the three rupee numbers (the rate you used,
// the rate the books imply, today's rate) are never averaged into one. This page is the only
// place that money is looked at, so it is also the only place the disagreements are shown —
// a rate gap, an orphaned invoice number, a settled-looking deal whose invoice still carries a
// balance, a revaluation resting on a nine-week-old rate. Each is printed on the row.
//
// Three boundaries are on the screen rather than buried in the code:
//  * Rule 45 of the CGST Rules values the supply in rupees at the rate notified for that day.
//    That valuation stays in Postgres, on the invoice — every GST report keeps reading it unchanged.
//  * A rate pulled from a reference table is stamped `feed` and called indicative. It is not
//    the notification.
//  * Recording a remittance here does not receive it in the books. The ledger entry stays on
//    /payments.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN, plural } from '@/lib/format'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import {
  addReceipt, currencyOf, currentRates, deleteEntry, deleteRate, emptyEntry, emptyFx, entryFromInvoice,
  feedUrl, foreign, fxRows, FX_CSV_HEADERS, fxSummary, fxView, fxViews, inr,
  loadFx, parseFeedRates, rateFor, rateHistory, rateLabel, ratesFromFeed, rateRows, RATE_CSV_HEADERS,
  removeReceipt, saveFx, SETTLEMENT_LABEL, setRate, todayISO, TRADABLE_CURRENCIES, upsertEntry,
  validateEntry, validateReceipt,
  type FeedResult, type FxBookInvoice, type FxEntry, type FxReceipt, type FxSettlement,
  type FxStore, type FxView,
} from '@/lib/fx'
import {
  Badge, Button, Card, EmptyState, PageHeader, ProgressBar, SearchInput, SectionTitle, Segmented,
  StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'

type ViewFilter = 'work' | 'outstanding' | 'settled' | 'all'

const VIEWS: { value: ViewFilter; label: string }[] = [
  { value: 'work', label: 'Needs a look' },
  { value: 'outstanding', label: 'Outstanding' },
  { value: 'settled', label: 'Received' },
  { value: 'all', label: 'All deals' },
]

const SETTLE_TONE: Record<FxSettlement, 'red' | 'amber' | 'green' | 'violet'> = {
  open: 'red', partial: 'amber', settled: 'green', overpaid: 'violet',
}

interface BookRow extends FxBookInvoice { id: string }

/**
 * Numeric fields are kept as the text that was typed — a half-typed "83." is not the number 83
 * yet, and a controlled numeric input that rewrites itself under the cursor is unusable. The
 * stored entry is built from the draft only when it is saved.
 */
interface EditorState {
  e: FxEntry
  raw: { foreign_value: string; booked_rate: string; booked_inr: string }
  isNew: boolean
}
interface ReceiptDraft { date: string; foreign: string; inr: string; reference: string }
interface RateDraft { code: string; as_of: string; rate: string; note: string }

/** Comma-tolerant, because a rupee figure is usually pasted off a bank advice. */
function numInput(v: string): number {
  const n = Number(String(v).replace(/[,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

const show = (v: number) => (v > 0 ? String(v) : '')

/** ₹ first, sign second — a gain and a loss must not look alike. */
function signedRupees(v: number): string {
  const abs = inr(Math.abs(v))
  if (v > 0) return `+${abs}`
  if (v < 0) return `−${abs}`
  return abs
}

function ageInDays(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`)
  const b = Date.parse(`${to}T12:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86400000)
}

function dayOrDash(iso: string): string {
  return iso ? formatDateIN(iso) : '—'
}

/** A stored entry, unfolded back into the text the editor shows. */
const rawOf = (e: FxEntry) => ({
  foreign_value: show(e.foreign_value),
  booked_rate: e.booked_rate > 0 ? String(e.booked_rate) : '',
  booked_inr: show(e.booked_inr),
})

function FxPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [books, setBooks] = useState<BookRow[]>([])
  const [store, setStore] = useState<FxStore>(emptyFx())
  const [loading, setLoading] = useState(true)

  const [search, setSearch] = useSearchDeepLink()
  const [view, setView] = useState<ViewFilter>('outstanding')
  const [openTrail, setOpenTrail] = useState('')
  const [openHistory, setOpenHistory] = useState('')
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)

  const [fetching, setFetching] = useState(false)
  const [feed, setFeed] = useState<{ written: string[]; missing: string[]; failed: string[] } | null>(null)

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [editorError, setEditorError] = useState('')

  const [receiptFor, setReceiptFor] = useState('')
  const [draft, setDraft] = useState<ReceiptDraft>({ date: '', foreign: '', inr: '', reference: '' })
  const [recError, setRecError] = useState('')

  const [rateDraft, setRateDraft] = useState<RateDraft | null>(null)
  const [rateError, setRateError] = useState('')

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

      // The rupee half of every row below comes from here — the books, unchanged.
      const { data: rows } = await supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, customer_name, grand_total, balance_due, status, payment_status')
        .eq('organization_id', oid)
        .neq('status', 'cancelled')
        .order('invoice_date', { ascending: false })
        .limit(600)
      const bookRows = (rows || []) as unknown as BookRow[]
      setBooks(bookRows)

      const fresh = loadFx(oid)
      setStore(fresh)

      // ?new=1 — the palette's "New foreign-currency deal" lands here with the editor open.
      if (searchParams.get('new') === '1') {
        const e = emptyEntry()
        setEditor({ e, raw: rawOf(e), isNew: true })
        setEditorError('')
      }
      // Land on the work pile when the register has one; otherwise on what is still outstanding.
      setView(fxViews(fresh, bookRows, todayISO()).some(v => v.problems.length > 0) ? 'work' : 'outstanding')
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const today = todayISO()
  const views = useMemo(() => fxViews(store, books, today), [store, books, today])
  const roll = useMemo(() => fxSummary(views), [views])
  const rates = useMemo(() => currentRates(store), [store])

  const visible = useMemo(() => views.filter(v => {
    if (view === 'work' && v.problems.length === 0) return false
    if (view === 'outstanding' && v.settlement === 'settled') return false
    if (view === 'settled' && v.settlement !== 'settled') return false
    return matchesAny(search, [
      v.entry.invoice_number, v.entry.party_name, v.book?.customer_name || '',
      v.entry.currency, v.currency?.name || '',
    ])
  }), [views, view, search])

  const unvalued = views.filter(v => v.revalued_outstanding_inr === null && v.outstanding_foreign > 0).length

  function flash(msg: string) { setNotice({ msg, bad: false }) }
  function warn(msg: string) { setNotice({ msg, bad: true }) }

  // ── the deal editor ─────────────────────────────────────────────────────────
  /** The draft, folded back into the stored shape — the only place the text becomes numbers. */
  function entryOf(cur: EditorState): FxEntry {
    return {
      ...cur.e,
      foreign_value: numInput(cur.raw.foreign_value),
      booked_rate: numInput(cur.raw.booked_rate),
      booked_inr: numInput(cur.raw.booked_inr),
    }
  }

  function openEditor(e: FxEntry, isNew: boolean) {
    setEditor({ e, raw: rawOf(e), isNew })
    setEditorError('')
  }

  function patchEditor(patch: Partial<FxEntry>) {
    setEditor(cur => (cur ? { ...cur, e: { ...cur.e, ...patch } } : cur))
  }

  function patchRaw(patch: Partial<EditorState['raw']>) {
    setEditor(cur => (cur ? { ...cur, raw: { ...cur.raw, ...patch } } : cur))
  }

  /** Choosing the document pulls the rupee side out of the books instead of typing it twice. */
  function pickInvoice(number: string) {
    if (!number) { patchEditor({ invoice_number: '', party_name: '' }); return }
    const b = books.find(x => x.invoice_number === number)
    if (!b) return
    setEditor(cur => {
      if (!cur) return cur
      const seeded = entryFromInvoice(b, cur.e.currency, numInput(cur.raw.foreign_value) || cur.e.foreign_value)
      const next: FxEntry = {
        ...seeded,
        id: cur.e.id,
        party_name: seeded.party_name || cur.e.party_name,
        notes: cur.e.notes,
        receipts: cur.e.receipts,
        created_at: cur.e.created_at,
        // A rate typed before the document was picked is not this invoice's rate.
        booked_rate: seeded.booked_rate > 0 ? seeded.booked_rate : cur.e.booked_rate,
      }
      return { ...cur, e: next, raw: rawOf(next) }
    })
  }

  const takenNumbers = useMemo(() => new Set(
    store.entries.filter(e => !editor || e.id !== editor.e.id).map(e => e.invoice_number),
  ), [store.entries, editor])

  /** Live figures while the deal is still being typed — the same derivation the register uses. */
  const draftEntry = editor ? entryOf(editor) : null
  const editorView: FxView | null = useMemo(
    () => (draftEntry ? fxView(draftEntry, { rates: store.rates, books, today }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, store.rates, books, today],
  )
  const editorRateForDay = draftEntry ? rateFor(store.rates, draftEntry.currency, draftEntry.invoice_date) : null
  const impliedRate = editorView?.implied_rate ?? null
  const dayRate = editorRateForDay?.rate ?? null
  const worth = draftEntry ? draftEntry.foreign_value * draftEntry.booked_rate : 0

  function saveEntry() {
    if (!editor || !draftEntry) return
    const problems = validateEntry(draftEntry)
    if (problems.length) { setEditorError(problems[0]); return }
    const res = upsertEntry(orgId, draftEntry)
    if (!res.ok) { setEditorError(res.error); return }
    const saved = res.store.entries.find(x => x.id === draftEntry.id)
    setStore(res.store)
    setEditor(null)
    flash(editor.isNew
      ? `${saved?.invoice_number || draftEntry.invoice_number} is on the currency register — ${foreign(saved?.foreign_value ?? draftEntry.foreign_value, saved?.currency || draftEntry.currency)} at ${rateLabel(saved?.booked_rate ?? draftEntry.booked_rate, saved?.currency || draftEntry.currency)}.`
      : `${draftEntry.invoice_number.toUpperCase()} updated.`)
  }

  function removeEntry(v: FxView) {
    const trailing = v.entry.receipts.length
      ? ' Its recorded remittances go with it.'
      : ' No remittance is recorded against it.'
    if (!confirm(`Remove ${v.entry.invoice_number} from the currency register?${trailing} The invoice itself is untouched.`)) return
    const res = deleteEntry(orgId, v.entry.id)
    if (!res.ok) { warn(res.error); return }
    setStore(res.store)
    flash(`${v.entry.invoice_number} is off the register. The invoice is unchanged.`)
  }

  // ── remittances ─────────────────────────────────────────────────────────────
  const receiptEntry = receiptFor ? store.entries.find(e => e.id === receiptFor) || null : null
  const receiptOwed = receiptEntry
    ? receiptEntry.foreign_value - receiptEntry.receipts.reduce((s, r) => s + r.foreign, 0)
    : 0

  function openReceipt(v: FxView) {
    setReceiptFor(v.entry.id)
    setDraft({
      date: today,
      foreign: v.outstanding_foreign > 0 ? String(v.outstanding_foreign) : '',
      inr: '',
      reference: '',
    })
    setRecError('')
  }

  const draftPreview = useMemo(() => {
    if (!receiptEntry) return null
    const f = numInput(draft.foreign)
    const landed = numInput(draft.inr)
    if (!f || !landed) return null
    return {
      foreign: f, landed,
      expected: f * receiptEntry.booked_rate,
      realised: landed - f * receiptEntry.booked_rate,
    }
  }, [receiptEntry, draft])

  function saveReceipt() {
    if (!receiptEntry) return
    const candidate: FxReceipt = {
      id: '', date: draft.date, foreign: numInput(draft.foreign), inr: numInput(draft.inr),
      reference: draft.reference,
    }
    const problems = validateReceipt(receiptEntry, candidate)
    if (problems.length) { setRecError(problems[0]); return }
    const res = addReceipt(orgId, receiptEntry.id, candidate)
    if (!res.ok) { setRecError(res.error); return }
    setStore(res.store)
    setReceiptFor('')
    const gain = candidate.inr - candidate.foreign * receiptEntry.booked_rate
    flash(`${foreign(candidate.foreign, receiptEntry.currency)} recorded — ${gain >= 0 ? 'a realised gain of' : 'a realisation loss of'} ${inr(Math.abs(gain))}. The ledger receipt still belongs on /payments.`)
  }

  function takeReceipt(entryId: string, receiptId: string) {
    if (!confirm('Remove this remittance from the register?')) return
    setStore(removeReceipt(orgId, entryId, receiptId))
    flash('Remittance taken off the register.')
  }

  // ── the rate ledger ─────────────────────────────────────────────────────────
  function saveManualRate() {
    if (!rateDraft) return
    const res = setRate(orgId, {
      code: rateDraft.code, rate: numInput(rateDraft.rate), as_of: rateDraft.as_of,
      source: 'manual', note: rateDraft.note,
    })
    if (!res.ok) { setRateError(res.error); return }
    setStore(res.store)
    setRateDraft(null)
    setRateError('')
    flash(`${rateLabel(numInput(rateDraft.rate), rateDraft.code)} recorded for ${formatDateIN(rateDraft.as_of)} — stamped as a rate you read off, not one fetched.`)
  }

  function removeRate(code: string, asOf: string) {
    if (!confirm(`Remove the ${code} rate for ${formatDateIN(asOf)}? Deals revalued on it fall back to whatever is left on the ledger.`)) return
    setStore(deleteRate(orgId, code, asOf))
    if (openHistory === code) setOpenHistory('')
    flash(`${code} rate for ${formatDateIN(asOf)} removed.`)
  }

  /**
   * One request per currency, asked rupees-per-unit, because inverting a five-significant-figure
   * table costs precision. Codes the table does not publish are reported, never guessed.
   */
  async function fetchRates() {
    const codes = [...new Set([
      ...store.entries.map(e => e.currency),
      ...rates.map(r => r.code),
    ])].filter(c => c && c !== 'INR')
    if (codes.length === 0) {
      warn('Nothing to fetch yet — put a deal or a rate on the register, and TaxFlow pulls the reference table for those currencies.')
      return
    }
    setFetching(true)
    setFeed(null)
    const results: FeedResult[] = []
    const missing: string[] = []
    const failed: string[] = []
    for (const code of codes) {
      if (!currencyOf(code)?.in_reference_feed) { missing.push(code); continue }
      try {
        const res = await fetch(feedUrl(code))
        if (!res.ok) { failed.push(code); continue }
        const parsed = parseFeedRates(await res.json(), code, today)
        if (parsed.error) failed.push(code)
        else results.push(parsed)
      } catch {
        failed.push(code)
      }
    }
    const latest = loadFx(orgId)
    const merged = ratesFromFeed(results, latest)
    if (results.length) saveFx(orgId, { ...latest, rates: merged.rates })
    setStore(loadFx(orgId))
    const gaps = [...new Set([...missing, ...merged.missing])]
    setFeed({ written: results.map(r => r.code), missing: gaps, failed: [...new Set(failed)] })
    setFetching(false)
    flash(results.length
      ? `${plural(results.length, 'rate')} written — stamped as a reference table, which is indicative and not the Rule 45 notification.`
      : 'The reference table gave nothing usable. The ledger keeps the rates you typed.')
  }

  function exportCsv() {
    download(`taxflow-currency-${today}.csv`, toCsv(FX_CSV_HEADERS, fxRows(visible)))
  }

  function exportRates() {
    download(`taxflow-fx-rates-${today}.csv`, toCsv(RATE_CSV_HEADERS, rateRows(store.rates)))
  }

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the currency register…</div>
  }

  return (
    <div className="fx page-container" style={{ maxWidth: 1180 }}>
      <PageHeader
        eyebrow={`${orgName.toUpperCase() || 'SALES'} · FOREIGN CURRENCY`}
        title="Multi-currency"
        subtitle="A deal struck in dollars is still worth rupees — to the GST law on the day you invoiced, and to your bank on the day the money lands. This register keeps both and shows the gap between them."
        actions={
          <>
            <Button variant="ghost" size="sm" icon="cloud" onClick={fetchRates} disabled={fetching}>
              {fetching ? 'Reading the table…' : 'Fetch rates'}
            </Button>
            <Button variant="ghost" size="sm" icon="download" onClick={exportCsv} disabled={visible.length === 0}>CSV</Button>
            <Button icon="plus" onClick={() => openEditor(emptyEntry(), true)}>New deal</Button>
          </>
        }
      />

      <div className="fx-stats">
        <StatCard
          label="Exposure today" value={roll.exposure_inr}
          sub={`${plural(roll.open_count, 'deal')} awaiting a remittance · booked at ${inr(roll.outstanding_inr)}`}
          icon="globe" tone="cyan" delay={0}
        />
        <StatCard
          label="Unrealised movement" value={signedRupees(roll.unrealised)}
          sub={`paper until the money lands · ${plural(unvalued, 'deal')} ${unvalued === 1 ? 'has' : 'have'} no rate to revalue on`}
          icon="trend" tone={roll.unrealised > 0 ? 'green' : roll.unrealised < 0 ? 'red' : 'grey'} delay={40}
        />
        <StatCard
          label="Realised" value={signedRupees(roll.realised)}
          sub="what the bank credited against the rate the invoice was written at"
          icon="wallet" tone={roll.realised > 0 ? 'green' : roll.realised < 0 ? 'red' : 'grey'} delay={80}
        />
        <StatCard
          label="Needs a look" value={String(roll.problems)}
          sub={`${roll.unmatched_count} not in the books · ${unvalued} without a current rate`}
          icon={roll.problems ? 'alert' : 'check'} tone={roll.problems ? 'amber' : 'green'} delay={120}
        />
      </div>

      <div className="fx-notes">
        <div className="fx-note">
          <Icon name="percent" size={13} strokeWidth={2.2} />
          <span>
            <em>Rule 45 of the CGST Rules</em> values a foreign-currency supply in rupees at the rate
            notified for that day — in practice the RBI reference rate on the invoice date, or the FEDI
            rate for exports. That valuation lives on the invoice in Postgres and every GST report keeps
            reading it unchanged. Because <em>invoices have no currency column</em>, this register joins to
            the books by invoice number: a number that is not in the books is flagged, not hidden.
          </span>
        </div>
        <div className="fx-note is-warn">
          <Icon name="alert" size={13} strokeWidth={2.2} />
          <span>
            This page does not receive money. A remittance here is a realisation workpaper — the ledger
            entry still belongs on <Link href="/payments">/payments</Link>. When a deal looks fully received
            while its invoice still shows a balance, the row reports both instead of picking a winner.
          </span>
        </div>
      </div>

      <div className="fx-toolbar">
        <Segmented options={VIEWS} value={view} onChange={v => setView(v as ViewFilter)} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Invoice, customer or currency…"
          ariaLabel="Search the currency register"
          style={{ flex: '1 1 220px', maxWidth: 300, marginLeft: 'auto' }}
        />
      </div>

      {notice && (
        <div className={`fx-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
          <Icon name={notice.bad ? 'alert' : 'check'} size={14} strokeWidth={notice.bad ? 2.2 : 2.4} />
          <span>{notice.msg}</span>
          <button type="button" className="fx-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {feed && (
        <div className="fx-feed" role="status">
          <div className="fx-feed-row">
            <Icon name="cloud" size={13} />
            <span>
              {feed.written.length
                ? <>Written from the reference table: <strong>{feed.written.join(', ')}</strong>. </>
                : 'The reference table gave nothing usable. '}
              {feed.missing.length > 0 && <>It does not publish <strong>{feed.missing.join(', ')}</strong> — type those from the RBI card rather than fetching a wrong number. </>}
              {feed.failed.length > 0 && <>No answer from <strong>{feed.failed.join(', ')}</strong> — the ledger kept whatever was already recorded. </>}
              <em>A fetched rate is indicative; Rule 45 wants the notification for the day of supply.</em>
            </span>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon="globe"
            title={store.entries.length > 0 ? 'Nothing in this view' : 'No foreign-currency deals yet'}
            message={store.entries.length > 0
              ? 'Clear the search or pick another view to see the rest of the register.'
              : 'Pick an invoice, say which currency the deal was struck in and what one unit was worth on the day. The register then tracks what that money is worth now and what it was worth when it landed.'}
            action={store.entries.length > 0
              ? undefined
              : <Button size="sm" icon="plus" onClick={() => openEditor(emptyEntry(), true)}>New deal</Button>}
          />
        </Card>
      ) : (
        <div className="fx-grid">
          {visible.map(v => {
            const e = v.entry
            const c = v.currency
            const open = openTrail === e.id
            const pct = e.foreign_value > 0 ? (v.received_foreign / e.foreign_value) * 100 : 0
            // The library joins by number; the row's own id is what makes the link work.
            const bookId = books.find(b => b.invoice_number === e.invoice_number)?.id || ''
            return (
              <div key={e.id} className={`fx-card ${v.problems.length ? 'has-problems' : ''} ${open ? 'is-open' : ''}`}>
                <div className="fx-card-head">
                  <div className="fx-card-title">
                    <span className="fx-card-name">
                      <Icon name="globe" size={15} />
                      {bookId
                        ? <Link href={`/invoices/${bookId}`} className="fx-invoice-link">{e.invoice_number}</Link>
                        : <span>{e.invoice_number}</span>}
                      <span className="fx-code">{e.currency}</span>
                    </span>
                    <span className="fx-card-sub">
                      {v.book?.customer_name || e.party_name || 'no customer named'}
                      {' · '}invoiced {dayOrDash(e.invoice_date)}
                      {v.due_days !== null ? ` · ${plural(v.due_days, 'day')} old` : ''}
                    </span>
                  </div>
                  <div className="fx-card-badges">
                    <Badge tone={SETTLE_TONE[v.settlement]} dot={false}>{SETTLEMENT_LABEL[v.settlement]}</Badge>
                    {v.problems.length > 0 && <Badge tone="red" dot={false}>{v.problems.length} to check</Badge>}
                  </div>
                </div>

                {/* The three rupee numbers, side by side and never averaged into one. */}
                <div className="fx-rates">
                  <div className="fx-rate">
                    <span className="fx-rate-label">Rate you used</span>
                    <span className="fx-rate-value">{rateLabel(e.booked_rate, e.currency)}</span>
                  </div>
                  <div className={`fx-rate ${v.rate_gap !== null ? 'is-off' : ''}`}>
                    <span className="fx-rate-label">The books imply</span>
                    <span className="fx-rate-value">
                      {v.implied_rate !== null ? rateLabel(v.implied_rate, e.currency) : '—'}
                      {v.rate_gap !== null && <em> off by {signedRupees(v.rate_gap)}</em>}
                    </span>
                  </div>
                  <div className={`fx-rate ${v.today_rate?.carried ? 'is-carried' : ''}`}>
                    <span className="fx-rate-label">Today</span>
                    <span className="fx-rate-value">
                      {v.today_rate ? rateLabel(v.today_rate.rate, e.currency) : 'no rate recorded'}
                      {v.today_rate && (
                        <em> {v.today_rate.as_of === today ? 'today' : `of ${dayOrDash(v.today_rate.as_of)}`}</em>
                      )}
                    </span>
                  </div>
                </div>

                <div className="fx-card-stats">
                  <StatRow label={`Invoiced in ${c?.code || e.currency}`} value={foreign(e.foreign_value, e.currency)} strong />
                  <StatRow label="Rupee value in the books" value={inr(e.booked_inr)} />
                  <StatRow
                    label="Received"
                    value={v.received_foreign > 0 ? `${foreign(v.received_foreign, e.currency)} · ${inr(v.received_inr)}` : 'nothing yet'}
                  />
                  <StatRow label="Still owed" value={v.outstanding_foreign > 0 ? foreign(v.outstanding_foreign, e.currency) : '—'} />
                  <StatRow label="Owed at your rate" value={inr(v.booked_outstanding_inr)} />
                  <StatRow
                    label="Owed at today’s rate"
                    value={v.revalued_outstanding_inr === null ? 'cannot revalue' : inr(v.revalued_outstanding_inr)}
                    tone={v.unrealised === null ? 'grey' : v.unrealised >= 0 ? 'green' : 'red'}
                  />
                </div>

                {pct > 0 && (
                  <div className="fx-progress">
                    <ProgressBar value={pct} color={pct >= 100 ? 'var(--green)' : 'var(--brand)'} />
                    <span className="fx-share-label">{Math.round(pct)}% of the contract value has landed</span>
                  </div>
                )}

                <div className="fx-gains">
                  <div className={`fx-gain ${v.realised > 0 ? 'is-up' : v.realised < 0 ? 'is-down' : ''}`}>
                    <span>Realised — settled in rupees</span>
                    <strong>{signedRupees(v.realised)}</strong>
                  </div>
                  <div className={`fx-gain ${v.unrealised === null ? '' : v.unrealised > 0 ? 'is-up' : v.unrealised < 0 ? 'is-down' : ''}`}>
                    <span>Unrealised — paper</span>
                    <strong>{v.unrealised === null ? 'no rate to say' : signedRupees(v.unrealised)}</strong>
                  </div>
                </div>

                {v.entry.notes && (
                  <p className="fx-card-note"><Icon name="clipboard" size={12} />{v.entry.notes}</p>
                )}

                {v.problems.map(p => (
                  <div key={p} className="fx-flag">
                    <Icon name="alert" size={12} strokeWidth={2.2} />
                    {p}
                  </div>
                ))}

                {open && (
                  <div className="fx-trail">
                    <div className="fx-trail-head">Remittances recorded here</div>
                    {e.receipts.length === 0 ? (
                      <p className="fx-trail-empty">No money has been recorded against this deal yet.</p>
                    ) : (
                      [...e.receipts].reverse().map(r => (
                        <div key={r.id} className="fx-bill">
                          <span className="fx-bill-date">{dayOrDash(r.date)}</span>
                          <span className="fx-bill-mid">
                            <span className="fx-bill-amount">{foreign(r.foreign, e.currency)}</span>
                            <span className="fx-bill-ref">{r.reference || 'no FIRC / UTR quoted'}</span>
                          </span>
                          <span className="fx-bill-right">
                            <span className="fx-bill-total">{inr(r.inr)}</span>
                            <span className="fx-bill-seq">{signedRupees(r.inr - r.foreign * e.booked_rate)} realised</span>
                          </span>
                          <button
                            type="button" className="fx-bill-x"
                            aria-label={`Remove the remittance of ${foreign(r.foreign, e.currency)}`}
                            onClick={() => takeReceipt(e.id, r.id)}
                          >
                            <Icon name="x" size={12} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}

                <div className="fx-card-foot">
                  <Button variant="ghost" size="sm" icon="list" onClick={() => setOpenTrail(open ? '' : e.id)}>
                    {open ? 'Hide money' : `Money in${e.receipts.length ? ` (${e.receipts.length})` : ''}`}
                  </Button>
                  <span className="fx-card-actions">
                    <Button variant="ghost" size="sm" icon="edit" onClick={() => openEditor(e, false)}>Edit</Button>
                    <Button variant="ghost" size="sm" icon="x" onClick={() => removeEntry(v)}>Remove</Button>
                    {v.outstanding_foreign > 0 && (
                      <Button size="sm" icon="wallet" onClick={() => openReceipt(v)}>Record receipt</Button>
                    )}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── the rate ledger ─────────────────────────────────────────────────────── */}
      <Card style={{ marginTop: 18 }}>
        <SectionTitle icon="percent" action={
          <span className="fx-rate-actions">
            <Button variant="ghost" size="sm" icon="download" onClick={exportRates} disabled={store.rates.length === 0}>
              Rates CSV
            </Button>
            <Button variant="ghost" size="sm" icon="plus"
              onClick={() => {
                setRateDraft({
                  code: rates[0]?.code || store.entries[0]?.currency || 'USD',
                  as_of: today, rate: '', note: '',
                })
                setRateError('')
              }}>Record a rate</Button>
          </span>
        }>
          Rate ledger — rupees per one unit, dated
        </SectionTitle>

        {store.rates.length === 0 && !rateDraft ? (
          <p className="fx-lead">
            Nothing recorded yet. A rate is always <strong>rupees per one unit of the foreign currency</strong> and
            carries the day it applies to — a rate with no date cannot value a supply under Rule 45, so{' '}
            <strong>Fetch rates</strong> above pulls the reference table, or record the notification yourself.
          </p>
        ) : (
          <div className="responsive-table">
            <div className="table-header fx-row fx-head">
              <span data-label="Currency">Currency</span>
              <span data-label="Rate">Rate</span>
              <span data-label="Applies to">Applies to</span>
              <span data-label="Age">Age</span>
              <span data-label="Source">Source</span>
              <span className="fx-right" data-label="History">History</span>
            </div>
            {rates.map(r => {
              const c = currencyOf(r.code)
              const age = ageInDays(r.as_of, today)
              return (
                <div key={`${r.code}-${r.as_of}`} className="table-row fx-row">
                  <span data-label="Currency" className="fx-cur">
                    <span className="fx-cur-code">{r.code}</span>
                    <span className="fx-sub">{c?.name || ''}</span>
                  </span>
                  <span data-label="Rate" className="fx-num">{rateLabel(r.rate, r.code)}</span>
                  <span data-label="Applies to" className="fx-num">{dayOrDash(r.as_of)}</span>
                  <span data-label="Age" className={age === 0 ? 'fx-sub' : age > 0 ? 'fx-amber' : 'fx-sub'}>
                    {age === 0 ? 'today' : age < 0 ? `${plural(-age, 'day')} ahead` : `${plural(age, 'day')} old`}
                  </span>
                  <span data-label="Source">
                    <Badge tone={r.source === 'feed' ? 'cyan' : 'grey'} dot={false}>
                      {r.source === 'feed' ? 'reference table' : 'typed'}
                    </Badge>
                  </span>
                  <span className="fx-right fx-row-actions" data-label="History">
                    <button
                      type="button" className="fx-linkbtn"
                      onClick={() => setOpenHistory(openHistory === r.code ? '' : r.code)}
                    >
                      {openHistory === r.code ? 'Hide' : `${plural(rateHistory(store.rates, r.code).length, 'day')}`}
                    </button>
                    <button type="button" className="fx-linkbtn is-bad" onClick={() => removeRate(r.code, r.as_of)}>Delete</button>
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {openHistory && (
          <div className="fx-history">
            <div className="fx-trail-head">Every {openHistory} rate on the ledger — newest first</div>
            {rateHistory(store.rates, openHistory).map(r => (
              <div key={`${r.code}-${r.as_of}`} className="fx-bill">
                <span className="fx-bill-date">{dayOrDash(r.as_of)}</span>
                <span className="fx-bill-mid">
                  <span className="fx-bill-amount">{rateLabel(r.rate, r.code)}</span>
                  <span className="fx-bill-ref">{r.source === 'feed' ? 'reference table' : (r.note || 'typed by you')}</span>
                </span>
                <span className="fx-bill-right">
                  <button type="button" className="fx-linkbtn is-bad" onClick={() => removeRate(r.code, r.as_of)}>Remove</button>
                </span>
                <span />
              </div>
            ))}
          </div>
        )}

        {rateDraft && (
          <div className="fx-rateform">
            <div className="fx-grid3">
              <label className="fx-field">
                <span>Currency</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value={rateDraft.code}
                  onChange={ev => setRateDraft({ ...rateDraft, code: ev.target.value })}>
                  {TRADABLE_CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
                </select>
              </label>
              <label className="fx-field">
                <span>Applies to *</span>
                <input className="tf-input" type="date" value={rateDraft.as_of}
                  onChange={ev => setRateDraft({ ...rateDraft, as_of: ev.target.value })} />
              </label>
              <label className="fx-field">
                <span>Rupees per 1 {rateDraft.code} *</span>
                <input className="tf-input" inputMode="decimal" placeholder="83.50" value={rateDraft.rate}
                  onChange={ev => setRateDraft({ ...rateDraft, rate: ev.target.value })} />
              </label>
            </div>
            <label className="fx-field">
              <span>Where it came from</span>
              <input className="tf-input" placeholder="RBI reference rate for the day · bank realisation card"
                value={rateDraft.note} onChange={ev => setRateDraft({ ...rateDraft, note: ev.target.value })} />
            </label>
            <p className="fx-hint">
              {currencyOf(rateDraft.code)?.in_reference_feed
                ? `${rateDraft.code} is in the reference table — fetching is quicker, but the notified rate is what the invoice value should follow.`
                : `${rateDraft.code} is not published by the reference table. Typing it from the RBI card or the bank advice is the only honest way, and the Gulf trade is full of it.`}
            </p>
            {rateError && (
              <div className="fx-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{rateError}</div>
            )}
            <div className="fx-save">
              <Button variant="ghost" onClick={() => { setRateDraft(null); setRateError('') }}>Cancel</Button>
              <Button icon="check" onClick={saveManualRate}>Record this rate</Button>
            </div>
          </div>
        )}
      </Card>

      <div className="fx-foot">
        <span>
          {plural(views.length, 'deal')} on the register · {rates.length} currenc{rates.length === 1 ? 'y has' : 'ies have'} a rate ·{' '}
          {inr(roll.exposure_inr)} revalued, {inr(roll.unvalued_inr)} of it with no rate to revalue on.
        </span>
        <span className="fx-foot-links">
          <Link href="/invoices">Invoices →</Link>
          <Link href="/payments">Receivables →</Link>
          <Link href="/gst/gstr1">GSTR-1 →</Link>
          <Link href="/gst/exports">Export register →</Link>
        </span>
      </div>

      {/* ── the deal editor ─────────────────────────────────────────────────────── */}
      {editor && draftEntry && (
        <div className="fx-scrim" role="dialog" aria-modal="true"
          aria-label={editor.isNew ? 'New foreign-currency deal' : `Edit ${editor.e.invoice_number}`}>
          <div className="fx-modal" style={{ maxWidth: 720 }}>
            <div className="fx-modal-head">
              <div>
                <h2>{editor.isNew ? 'New foreign-currency deal' : `Edit ${editor.e.invoice_number}`}</h2>
                <p>
                  The rupee side comes from your books. What lives here is the currency, the rate the supply
                  was valued at, and the remittances as the bank cleared them.
                </p>
              </div>
              <button type="button" className="fx-close" onClick={() => setEditor(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {editorError && (
              <div className="fx-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{editorError}</div>
            )}

            {books.length > 0 && (
              <label className="fx-field">
                <span>Which invoice is this deal?</span>
                <select className="tf-input" style={{ cursor: 'pointer' }}
                  value={books.some(b => b.invoice_number === draftEntry.invoice_number) ? draftEntry.invoice_number : ''}
                  onChange={ev => pickInvoice(ev.target.value)}>
                  <option value="">Pick an invoice — or type its number below…</option>
                  {books.map(b => (
                    <option key={b.id} value={b.invoice_number} disabled={takenNumbers.has(b.invoice_number)}>
                      {b.invoice_number} · {b.customer_name} · {inr(Number(b.grand_total) || 0)}
                      {takenNumbers.has(b.invoice_number) ? ' — already on the register' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="fx-grid2">
              <label className="fx-field">
                <span>Invoice number *</span>
                <input className="tf-input" value={editor.e.invoice_number} placeholder="INV-2026-27-0007"
                  spellCheck={false} onChange={ev => patchEditor({ invoice_number: ev.target.value })} autoFocus />
              </label>
              <label className="fx-field">
                <span>Invoice date *</span>
                <input className="tf-input" type="date" value={editor.e.invoice_date}
                  onChange={ev => patchEditor({ invoice_date: ev.target.value })} />
              </label>
            </div>

            <div className="fx-grid2">
              <label className="fx-field">
                <span>Customer</span>
                <input className="tf-input" value={editor.e.party_name} placeholder="Acme Trading LLC"
                  onChange={ev => patchEditor({ party_name: ev.target.value })} />
              </label>
              <label className="fx-field">
                <span>Currency the deal was struck in *</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value={editor.e.currency}
                  onChange={ev => patchEditor({ currency: ev.target.value })}>
                  {TRADABLE_CURRENCIES.map(c => (
                    <option key={c.code} value={c.code}>{c.code} — {c.name} ({c.symbol})</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="fx-grid2">
              <label className="fx-field">
                <span>Contract value in {editor.e.currency} *</span>
                <input className="tf-input" inputMode="decimal" placeholder="10000" value={editor.raw.foreign_value}
                  onChange={ev => patchRaw({ foreign_value: ev.target.value })} />
              </label>
              <label className="fx-field">
                <span>Rupee value in the books *</span>
                <input className="tf-input" inputMode="decimal" placeholder="835000" value={editor.raw.booked_inr}
                  onChange={ev => patchRaw({ booked_inr: ev.target.value })} />
              </label>
            </div>

            <label className="fx-field">
              <span>The rate you valued it at (₹ per 1 {editor.e.currency}) *</span>
              <div className="fx-inline">
                <input className="tf-input" inputMode="decimal" placeholder="83.50" value={editor.raw.booked_rate}
                  onChange={ev => patchRaw({ booked_rate: ev.target.value })} />
                <span className="fx-suggest">
                  {impliedRate !== null && Math.abs(impliedRate - draftEntry.booked_rate) > 0.0001 && (
                    <Button variant="ghost" size="sm" onClick={() => patchRaw({ booked_rate: String(impliedRate) })}>
                      Use the books’ rate
                    </Button>
                  )}
                  {dayRate !== null && Math.abs(dayRate - draftEntry.booked_rate) > 0.0001 && (
                    <Button variant="ghost" size="sm" onClick={() => patchRaw({ booked_rate: String(dayRate) })}>
                      Use the ledger’s rate
                    </Button>
                  )}
                </span>
              </div>
              <span className="fx-hint">
                {editorView?.implied_rate != null && (
                  <>The books say {rateLabel(editorView.implied_rate, editor.e.currency)} — that is the rate your own
                    {' '}₹ figure reproduces{Math.abs(editorView.implied_rate - draftEntry.booked_rate) > 0.0001 ? ', which the rate above does not' : ''}. </>
                )}
                {editorRateForDay
                  ? <>The ledger has {rateLabel(editorRateForDay.rate, editor.e.currency)} for {dayOrDash(editorRateForDay.as_of)}
                    {editorRateForDay.as_of !== draftEntry.invoice_date
                      ? ', carried forward to the invoice date — which is not the same as the notified rate'
                      : ''}
                    {' '}({editorRateForDay.source === 'feed' ? 'reference table' : 'typed'}).</>
                  : <>No {editor.e.currency} rate is recorded up to {dayOrDash(draftEntry.invoice_date)}. Rule 45 wants the notified rate for the day of supply — record one and this row can be revalued.</>}
              </span>
            </label>

            <label className="fx-field">
              <span>Note on the deal</span>
              <textarea className="tf-input fx-area"
                placeholder="LUT export, no IGST paid · remittance expected in 60 days · FIRC with the bank"
                value={editor.e.notes} onChange={ev => patchEditor({ notes: ev.target.value })} />
            </label>

            <div className="fx-figures">
              <StatRow label="Contract value at the rate above" value={inr(worth)} strong />
              <StatRow label="The books carry" value={inr(draftEntry.booked_inr)} />
              <StatRow
                label={worth - draftEntry.booked_inr >= 0 ? 'Difference — the books are short by' : 'Difference — the books are long by'}
                value={inr(Math.abs(worth - draftEntry.booked_inr))}
                tone={Math.abs(worth - draftEntry.booked_inr) < 0.5 ? 'grey' : 'amber'}
              />
              <StatRow label="Remittances already recorded" value={String(draftEntry.receipts.length)} />
            </div>

            <div className="fx-save">
              <Button variant="ghost" onClick={() => setEditor(null)}>Cancel</Button>
              <Button icon="check" onClick={saveEntry}>{editor.isNew ? 'Put it on the register' : 'Save the deal'}</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── the remittance form ─────────────────────────────────────────────────── */}
      {receiptEntry && (
        <div className="fx-scrim" role="dialog" aria-modal="true"
          aria-label={`Record a receipt against ${receiptEntry.invoice_number}`}>
          <div className="fx-modal" style={{ maxWidth: 520 }}>
            <div className="fx-modal-head">
              <div>
                <h2>Money in — {receiptEntry.invoice_number}</h2>
                <p>
                  {receiptEntry.party_name || 'this deal'}
                  {' · still owed '}
                  {foreign(Math.max(0, receiptOwed), receiptEntry.currency)}
                  {' at '}
                  {rateLabel(receiptEntry.booked_rate, receiptEntry.currency)}
                </p>
              </div>
              <button type="button" className="fx-close" onClick={() => setReceiptFor('')} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {recError && (
              <div className="fx-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{recError}</div>
            )}

            <div className="fx-grid2">
              <label className="fx-field">
                <span>The day it landed *</span>
                <input className="tf-input" type="date" value={draft.date}
                  onChange={ev => setDraft({ ...draft, date: ev.target.value })} />
              </label>
              <label className="fx-field">
                <span>Amount in {receiptEntry.currency} *</span>
                <input className="tf-input" inputMode="decimal" placeholder="4000" value={draft.foreign}
                  onChange={ev => setDraft({ ...draft, foreign: ev.target.value })} />
              </label>
            </div>

            <label className="fx-field">
              <span>Rupees the bank actually credited *</span>
              <input className="tf-input" inputMode="decimal" placeholder="336000" value={draft.inr}
                onChange={ev => setDraft({ ...draft, inr: ev.target.value })} />
              <span className="fx-hint">
                After realisation charges and the bank&apos;s margin — the figure on the credit advice, not the one at
                the invoice rate. That difference is the realised gain or loss.
              </span>
            </label>

            <label className="fx-field">
              <span>FIRC / UTR / remittance reference</span>
              <input className="tf-input" placeholder="FIRC-4471" value={draft.reference} spellCheck={false}
                onChange={ev => setDraft({ ...draft, reference: ev.target.value })} />
            </label>

            {draftPreview && (
              <div className="fx-figures">
                <StatRow label="At the rate the invoice used" value={inr(draftPreview.expected)} />
                <StatRow label="What the bank credited" value={inr(draftPreview.landed)} />
                <StatRow
                  label={draftPreview.realised >= 0 ? 'Realised gain' : 'Realised loss'}
                  value={signedRupees(draftPreview.realised)}
                  tone={draftPreview.realised >= 0 ? 'green' : 'red'}
                  strong
                />
              </div>
            )}

            <div className="fx-note is-warn">
              <Icon name="alert" size={13} strokeWidth={2.2} />
              <span>
                Recording this does not receipt the invoice. Put the same money on <Link href="/payments">/payments</Link>
                so the ledger and this register agree — a deal that looks settled here while the invoice still shows a
                balance is a gap, not a payment.
              </span>
            </div>

            <div className="fx-save">
              <Button variant="ghost" onClick={() => setReceiptFor('')}>Cancel</Button>
              <Button icon="wallet" onClick={saveReceipt}>Record the remittance</Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .fx-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .fx-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }

        .fx-notes { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
        .fx-note { display: flex; align-items: flex-start; gap: 7px; padding: 10px 12px; border-radius: 10px;
          font-size: 12px; color: var(--muted); background: var(--surface-2); border: 1px solid var(--line-soft);
          line-height: 1.6; }
        .fx-note svg { flex-shrink: 0; margin-top: 2px; color: var(--brand); }
        .fx-note em { font-style: normal; color: var(--ink); font-weight: 600; }
        .fx-note strong { color: var(--ink-2); }
        .fx-note a { color: var(--brand); text-decoration: none; font-weight: 600; }
        .fx-note.is-warn { color: var(--amber); background: var(--amber-soft);
          border-color: color-mix(in srgb, var(--amber) 26%, white); }
        .fx-note.is-warn svg { color: var(--amber); }
        .fx-note.is-warn a { color: var(--amber); }

        .fx-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px;
          font-size: 12.5px; color: var(--green); background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 10px; }
        .fx-notice svg { flex-shrink: 0; }
        .fx-notice.is-bad { color: var(--amber); background: var(--amber-soft);
          border-color: color-mix(in srgb, var(--amber) 26%, white); }
        .fx-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer;
          padding: 2px; border-radius: 6px; min-height: 0; }
        .fx-notice-x:hover { background: rgba(0,0,0,0.05); }

        .fx-feed { border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
          padding: 10px 12px; margin-bottom: 12px; }
        .fx-feed-row { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--muted); line-height: 1.6; }
        .fx-feed-row svg { flex-shrink: 0; margin-top: 2px; color: var(--brand); }
        .fx-feed-row strong { color: var(--ink); font-variant-numeric: tabular-nums; }
        .fx-feed-row em { font-style: normal; color: var(--amber); font-weight: 600; }

        .fx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
        .fx-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg);
          padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-xs); }
        .fx-card.has-problems { border-color: color-mix(in srgb, var(--amber) 40%, white); }
        .fx-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .fx-card-title { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .fx-card-name { display: flex; align-items: center; gap: 7px; font-size: 14.5px; font-weight: 650;
          color: var(--ink); overflow-wrap: anywhere; }
        .fx-card-name svg { color: var(--brand); flex-shrink: 0; }
        .fx-invoice-link { color: var(--ink); text-decoration: none; }
        .fx-invoice-link:hover { color: var(--brand); }
        .fx-code { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; color: var(--brand);
          background: var(--brand-soft); border-radius: 6px; padding: 2px 6px; }
        .fx-card-sub { font-size: 11.5px; color: var(--faint); line-height: 1.5; overflow-wrap: anywhere; }
        .fx-card-badges { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }

        .fx-rates { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
        .fx-rate { background: var(--surface-2); border: 1px solid var(--line-soft); border-radius: 10px;
          padding: 8px 10px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .fx-rate-label { font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .fx-rate-value { font-size: 12px; font-weight: 650; color: var(--ink-2); font-variant-numeric: tabular-nums;
          overflow-wrap: anywhere; }
        .fx-rate-value em { font-style: normal; font-weight: 500; color: var(--faint); }
        .fx-rate.is-off { border-color: color-mix(in srgb, var(--amber) 34%, white); background: var(--amber-soft); }
        .fx-rate.is-off .fx-rate-label { color: var(--amber); }
        .fx-rate.is-off .fx-rate-value, .fx-rate.is-off .fx-rate-value em { color: var(--amber); }
        .fx-rate.is-carried .fx-rate-value em { color: var(--amber); }

        .fx-card-stats { display: flex; flex-direction: column; }
        .fx-card-stats > div:last-child { border-bottom: none; }
        .fx-progress { display: flex; flex-direction: column; gap: 5px; }
        .fx-share-label { font-size: 11px; color: var(--faint); }
        .fx-card-note { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: 11.5px;
          color: var(--muted); line-height: 1.55; }
        .fx-card-note svg { flex-shrink: 0; margin-top: 2px; color: var(--faint); }

        .fx-gains { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .fx-gain { display: flex; flex-direction: column; gap: 2px; padding: 9px 11px; border-radius: 10px;
          background: var(--surface-2); border: 1px solid var(--line-soft); }
        .fx-gain span { font-size: 10px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint); }
        .fx-gain strong { font-size: 14px; font-variant-numeric: tabular-nums; color: var(--ink-2); }
        .fx-gain.is-up strong { color: var(--green); }
        .fx-gain.is-down strong { color: var(--red); }

        .fx-flag { font-size: 11.5px; color: var(--amber); background: var(--amber-soft); border-radius: 8px;
          padding: 8px 10px; line-height: 1.5; display: flex; align-items: flex-start; gap: 6px; }
        .fx-flag svg { flex-shrink: 0; margin-top: 2px; }

        .fx-trail, .fx-history { border-top: 1px dashed var(--line); padding-top: 10px; display: flex;
          flex-direction: column; gap: 6px; }
        .fx-history { margin-top: 12px; }
        .fx-trail-head { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .fx-trail-empty { font-size: 12px; color: var(--faint); margin: 0; }
        .fx-bill { display: grid; grid-template-columns: 92px minmax(0, 1fr) auto 24px; gap: 8px; align-items: center;
          padding: 7px 9px; background: var(--surface-2); border-radius: 9px; font-size: 12px; }
        .fx-bill-date { font-variant-numeric: tabular-nums; color: var(--ink-2); font-weight: 600; }
        .fx-bill-mid { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .fx-bill-amount { font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
        .fx-bill-ref { font-size: 10.5px; color: var(--faint); overflow-wrap: anywhere; }
        .fx-bill-right { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
        .fx-bill-total { font-weight: 650; color: var(--ink); font-variant-numeric: tabular-nums; }
        .fx-bill-seq { font-size: 10.5px; color: var(--faint); font-variant-numeric: tabular-nums; }
        .fx-bill-x { background: none; border: none; color: var(--faint); cursor: pointer; padding: 3px;
          border-radius: 6px; min-height: 0; display: flex; }
        .fx-bill-x:hover { background: var(--red-soft); color: var(--red); }

        .fx-card-foot { display: flex; align-items: center; gap: 6px; margin-top: auto; flex-wrap: wrap; }
        .fx-card-actions { display: flex; gap: 6px; margin-left: auto; align-items: center; flex-wrap: wrap; }

        .fx-lead { margin: 0; font-size: 12.5px; color: var(--muted); line-height: 1.65; }
        .fx-lead strong { color: var(--ink-2); }
        .fx-rate-actions { display: flex; gap: 6px; }
        .fx-row { display: grid; grid-template-columns: 1.2fr 1.2fr 1fr 1fr 0.9fr auto; gap: 8px; align-items: center; }
        .fx-head { font-size: 11px; font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.04em; }
        .fx-cur { display: flex; flex-direction: column; gap: 1px; }
        .fx-cur-code { font-size: 12.5px; font-weight: 700; color: var(--ink); letter-spacing: 0.03em; }
        .fx-sub { font-size: 11px; color: var(--faint); }
        .fx-amber { font-size: 11.5px; color: var(--amber); }
        .fx-num { font-variant-numeric: tabular-nums; font-size: 12.5px; color: var(--ink-2); }
        .fx-right { text-align: right; }
        .fx-row-actions { display: flex; gap: 10px; justify-content: flex-end; }
        .fx-linkbtn { background: none; border: none; color: var(--brand); cursor: pointer; font-size: 11.5px;
          font-weight: 600; padding: 2px 0; min-height: 0; font-family: inherit; }
        .fx-linkbtn.is-bad { color: var(--faint); }
        .fx-linkbtn.is-bad:hover { color: var(--red); }
        .fx-rateform { margin-top: 12px; border: 1px solid var(--line); border-radius: 12px; padding: 12px;
          background: var(--surface-2); display: flex; flex-direction: column; gap: 10px; }

        .fx-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          font-size: 11.5px; color: var(--faint); margin-top: 18px; }
        .fx-foot-links { display: flex; gap: 12px; }
        .fx-foot-links a { color: var(--brand); text-decoration: none; }

        .fx-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .fx-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .fx-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .fx-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .fx-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; max-width: 460px; line-height: 1.5; }
        .fx-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px;
          border-radius: 6px; flex-shrink: 0; min-height: 0; }
        .fx-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .fx-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .fx-alert svg { flex-shrink: 0; }

        .fx-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
        .fx-grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; align-items: start; }
        .fx-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .fx-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .fx-area { min-height: 58px; resize: vertical; }
        .fx-inline { display: flex; align-items: flex-start; gap: 8px; }
        .fx-inline .tf-input { flex: 1; }
        .fx-suggest { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
        .fx-hint { font-size: 11.5px; color: var(--faint); line-height: 1.55; }
        .fx-figures { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; padding: 0 12px; }
        .fx-figures > div:last-child { border-bottom: none; }
        .fx-save { display: flex; gap: 10px; justify-content: flex-end; }

        @media (max-width: 1100px) { .fx-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .fx-stats { grid-template-columns: 1fr 1fr; }
          .fx-grid { grid-template-columns: 1fr; }
          .fx-grid2, .fx-grid3 { grid-template-columns: 1fr; }
          .fx-rates { grid-template-columns: 1fr; }
          .fx-scrim { align-items: flex-end; padding: 0; }
          .fx-scrim .fx-modal { max-width: none !important; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .fx-save { flex-direction: column-reverse; }
          .fx-card-actions { width: 100%; margin-left: 0; }
          .fx-bill { grid-template-columns: 78px minmax(0, 1fr) auto 22px; }
        }
      `}</style>
    </div>
  )
}

export default function FxPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <FxPageInner />
    </Suspense>
  )
}
