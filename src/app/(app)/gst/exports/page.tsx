'use client'

// Exports — the zero-rated supply register.
//
// The engine (src/lib/exports.ts) owns the model: the Letter of Undertaking that makes a supply
// zero-rated without payment, the two clocks every consignment runs against (the FEMA realisation
// window for the money and section 54(1) for the refund), the shipping bill and port the customs
// paper carries, and the rupees that actually landed — which live on /fx when /fx holds the deal.
// This page is the register: what left, under what claim, what is still missing, what is due when.
//
// Two things shape every row here. First, a client-side register never stores a rupee it can re-read:
// the invoice value, the IGST paid and the ledger balance come from the books on every render, and the
// proceeds are counted from one home only — /fx when it holds the deal, this file otherwise — with a
// disagreement printed rather than summed. Second, the missing paper is the product: the gap list is
// what a trader actually needs before an audit, so it is drawn on the face of every card.
//
// Nothing here files anything. An RFD-11 or RFD-1 reference is transcribed from the portal, never
// sent to it; the balances are receipted on /payments; the realisation window is a cited band table,
// printed with the instrument behind each figure and the one day the sources disagree about; and the
// IGST refund track reads the shipping bill as the application it already is — it names which return
// that bill has to ride on is missing or short, and it never raises a claim of its own.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN, plural } from '@/lib/format'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import { loadFx, emptyFx, type FxStore } from '@/lib/fx'
import { loadFilings, type FilingsStore } from '@/lib/filings'
import { addMonthsISO, daysBetween } from '@/lib/recurring'
import {
  ADVANCE_BANDS, CLAIM_META, CLAIM_ORDER, EXPORT_DESTINATIONS, EXPORT_REGISTER_CSV_HEADERS,
  IGST_TRACK_CSV_HEADERS, INDIAN_PORTS, KIND_META, KIND_ORDER, LUT_CSV_HEADERS, MODE_LABEL,
  REALISATION_BANDS, REALISATION_CSV_HEADERS, REFUND_CLOSING_DAYS, REFUND_LABEL, REFUND_TONE,
  REFUND_TRACK_BOUNDARIES, REFUND_TRACK_CITATIONS, REFUND_WINDOW_MONTHS, ROUTE_META, ROUTE_ORDER,
  SCREENED_EXPORT_CSV_HEADERS, SCREEN_META, SHIPPING_BILL_CSV_HEADERS, SORTS, TIME_LABEL, TIME_TONE,
  TRACK_META, TRACK_ORDER, TRANSPORT_MODES, WATCH_CSV_HEADERS,
  addRealisation, advanceWindow, archiveLut, deleteFile, deleteLut, emptyExp, exportDateOf,
  exportViews, fileFromInvoice, fyOf, igstTrackCsvRows, isExportDoc, loadExp, lutCsvRows,
  lutRenewalDeadline, newFile, newLut, newRealisation, nextLutWindow, realisationCsvRows,
  realisationWindow, recordFile, refundTrack, registerCsvRows, removeRealisation, screenedCsvRows,
  shippingBillCsvRows, summarise, sortViews, todayISO, unregisteredExports, upsertLut, validateFile,
  validateLut, watchCsvRows, watchRows, setHomeGstin, setRefund,
  type ConsignKind, type ExportBookInvoice, type ExportFile, type ExportSort, type ExpStore,
  type ExportView, type FxDealLite, type LutRecord, type Realisation, type RefundClaim,
  type ReturnReading, type ScreenedRow, type TrackState, type WatchRow, type WindowInfo,
  type ZeroRatingRoute,
} from '@/lib/exports'
import {
  Badge, Button, Card, EmptyState, PageHeader, ProgressBar, SearchInput, SectionTitle, Segmented,
  StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'

type Tab = 'register' | 'lut' | 'watch' | 'track' | 'rule'

const TABS: { value: Tab; label: string }[] = [
  { value: 'register', label: 'Export register' },
  { value: 'lut', label: 'Letters of undertaking' },
  { value: 'watch', label: 'Watch list' },
  { value: 'track', label: 'IGST refund track' },
  { value: 'rule', label: 'The rule' },
]

type Filter = 'attention' | 'window' | 'short' | 'settled' | 'all'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'attention', label: 'Needs attention' },
  { value: 'window', label: 'Window closing / gone' },
  { value: 'short', label: 'Money still out' },
  { value: 'settled', label: 'Realised' },
  { value: 'all', label: 'All' },
]

function matchesFilter(v: ExportView, f: Filter): boolean {
  if (f === 'all') return true
  if (f === 'attention') return v.needs_attention
  if (f === 'window') return v.time_state === 'approaching' || v.time_state === 'overdue' || v.time_state === 'restricted'
  if (f === 'short') return v.outstanding > 0
  return v.money_state === 'full' || v.money_state === 'excess'
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const money = (n: number) => `₹${inr.format(Math.round(Number(n) || 0))}`
const pct = (n: number) => `${Math.round(Number(n) || 0)}%`

/** The proceeds clock in one line, in the words the regulation would use. */
function clockLine(v: ExportView): { text: string; tone: 'red' | 'amber' | 'blue' | 'green' | 'grey' } {
  if (!v.due_date) return { text: 'No date of export — no realisation clock can run', tone: 'grey' }
  const due = formatDateIN(v.due_date)
  const d = v.days_to_due
  if (v.time_state === 'settled') return { text: `Realised in full — the window closed on ${due}`, tone: 'green' }
  if (v.time_state === 'settled_late') return { text: `Realised, but after ${due} — a late credit does not undo the contravention`, tone: 'amber' }
  if (d === null) return { text: `Proceeds due ${due}`, tone: 'blue' }
  if (d < 0 && v.time_state === 'restricted') return { text: `${plural(-d, 'day')} past the window — the AD bank may restrict future exports`, tone: 'red' }
  if (d < 0) return { text: `Window ran out ${plural(-d, 'day')} ago (due ${due})`, tone: 'red' }
  if (d === 0) return { text: `Proceeds due today (${due})`, tone: 'amber' }
  if (d <= 45) return { text: `${plural(d, 'day')} left — proceeds due ${due}`, tone: 'amber' }
  return { text: `${plural(d, 'day')} left — proceeds due ${due}`, tone: 'blue' }
}

/** Which instrument fixed the window, in one line, with the disagreement kept visible. */
function windowWords(w: WindowInfo | null): string {
  if (!w) return 'no window'
  const base = `${plural(w.months, 'month')}${w.rupee_channel ? ' (rupee contract)' : ''}`
  if (w.overridden) return `${base} — overridden on this file`
  if (w.disputed) return `${base} — sources differ, could be ${w.alternative_months}`
  return base
}

function windowLine(v: ExportView): string {
  return windowWords(v.window)
}

const DATE_FROM_LABEL: Record<ExportView['date_from'], string> = {
  file: 'recorded on the file',
  shipping_bill: 'the shipping bill date',
  invoice: 'the invoice date',
  none: 'nowhere',
}

/** A refund line the way a CA would phrase it. */
function refundLine(v: ExportView): string {
  const r = v.refund
  if (r.state === 'nothing_to_claim') return 'No IGST paid on the invoice — nothing to refund'
  if (r.state === 'no_book') return 'No invoice matched, so the tax paid is unknown'
  if (!r.deadline) return 'No relevant date, so the two-year clock has not started'
  const left = r.days_left
  const tail = left === null ? '' : left < 0
    ? ` · ${plural(-left, 'day')} past`
    : ` · ${plural(left, 'day')} left`
  return `${r.label} — ${money(r.igst_paid)} · last day ${formatDateIN(r.deadline)}${tail}`
}

// ── The book rows this page reads ──────────────────────────────────────────────

interface BookRow {
  id: string
  invoice_number: string
  invoice_date: string | null
  customer_name: string | null
  customer_gstin: string | null
  supply_type: string | null
  place_of_supply: string | null
  taxable_amount: number | string | null
  igst_amount: number | string | null
  total_tax: number | string | null
  grand_total: number | string | null
  balance_due: number | string | null
  status: string | null
  kind_hint?: 'goods' | 'service' | null
}

/** One return, read for one bill: the period, what the register holds for it, and whether it is short. */
function ReadingLine({ r }: { r: ReturnReading }) {
  const name = r.form === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'
  if (!r.has_register) {
    return (
      <span className="ex-track-ret">
        <b>{name}</b>
        <span className="ex-sub is-dim">no returns recorded on this device</span>
      </span>
    )
  }
  if (!r.lines.length) {
    return (
      <span className="ex-track-ret">
        <b>{name}</b>
        <span className="ex-sub is-dim">no date on the bill, so no period to read</span>
      </span>
    )
  }
  return (
    <span className="ex-track-ret">
      <b>{name}</b>
      {r.lines.map(l => (
        <span key={l.period} className={`ex-track-ret-line ${l.short || l.status !== 'filed' ? 'is-bad' : ''}`}>
          {l.label} — {l.status === 'filed'
            ? `filed${l.filed_on ? ` ${formatDateIN(l.filed_on)}` : ''}, states ${money(Number(l.igst_stated) || 0)} IGST${l.short ? ' — less than this bill paid' : ''}`
            : l.status === 'nil'
              ? 'a nil return, which cannot carry the export row'
              : l.status === 'not_filed'
                ? 'recorded here, not filed'
                : 'nothing recorded for this period'}
        </span>
      ))}
    </span>
  )
}

/** The supplies the mechanism does not cover, each with the reason and the clock that runs instead. */
function ScreenedList({ rows, onCsv }: { rows: ScreenedRow[]; onCsv: () => void }) {
  const by = (s: ScreenedRow) => SCREEN_META[s.screen].label
  return (
    <Card pad={false}>
      <div className="ex-section-head" style={{ padding: '14px 16px 0' }}>
        <h2><Icon name="globe" size={15} />Outside the mechanism — and what runs instead</h2>
        <span className="ex-section-sub">
          A service export has no shipping bill and a LUT shipment paid no tax, so neither has a claim for a bill to
          carry. The section 54(1) clock on the register tab is the one that reads them.
        </span>
      </div>
      <div className="ex-head ex-head-screen">
        <span>Invoice</span><span>Why not on the track</span><span>What runs instead</span>
      </div>
      {[...rows].sort((a, b) => by(a).localeCompare(by(b)) || a.invoice_number.localeCompare(b.invoice_number)).map(r => (
        <div key={r.file_id} className="ex-row ex-row-screen">
          <span className="ex-name">
            {r.invoice_number || <span className="ex-blank">no number</span>}
            <span className="ex-sub">{r.party || '—'}{r.igst > 0 ? ` · ${money(r.igst)} IGST on the invoice` : ' · no IGST on the invoice'}</span>
          </span>
          <span className="ex-track-why">
            <b>{r.label}</b>
            <span className="ex-sub">{r.why}</span>
          </span>
        </div>
      ))}
      <div className="ex-foot">
        <span>{plural(rows.length, 'file')} outside the mechanism.</span>
        <span className="ex-foot-links"><Button size="sm" variant="ghost" icon="download" onClick={onCsv}>List CSV</Button></span>
      </div>
    </Card>
  )
}

function ExportsPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)

  const [store, setStore] = useState<ExpStore>(emptyExp())
  const [books, setBooks] = useState<ExportBookInvoice[]>([])
  const [fx, setFx] = useState<FxStore>(emptyFx())
  /** Read-only: the returns this tab compares the bill against. Nothing here writes a filing row. */
  const [filings, setFilings] = useState<FilingsStore | null>(null)
  const [homeInput, setHomeInput] = useState('')

  const [search, setSearch] = useSearchDeepLink()
  const [tab, setTab] = useState<Tab>('register')
  const [filter, setFilter] = useState<Filter>('attention')
  const [sort, setSort] = useState<ExportSort>('attention')
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)

  const [editor, setEditor] = useState<{ file: ExportFile; isNew: boolean } | null>(null)
  const [lutEditor, setLutEditor] = useState<{ lut: LutRecord; isNew: boolean } | null>(null)
  const [receipt, setReceipt] = useState<{ fileId: string; draft: Realisation } | null>(null)
  const [claim, setClaim] = useState<{ fileId: string; draft: RefundClaim } | null>(null)

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

      const stored = loadExp(oid)
      setStore(stored)
      setHomeInput(stored.settings.home_gstin)
      setFx(loadFx(oid))
      setFilings(loadFilings(oid))

      // The rupee half of every row comes from the books, never from this register.
      const { data } = await supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, customer_name, customer_gstin, supply_type, place_of_supply, taxable_amount, igst_amount, total_tax, grand_total, balance_due, status')
        .eq('organization_id', oid)
        .neq('status', 'cancelled')
        .order('invoice_date', { ascending: false })
        .limit(800)
      const rows = (data || []) as unknown as BookRow[]
      const exportRows = rows.filter(r => isExportDoc(r as unknown as ExportBookInvoice))

      // A SAC on the line items says the supply is a service, and a service export has no shipping
      // bill — so the kind is read from the books rather than guessed at by whoever fills the form.
      const ids = exportRows.map(r => r.id).filter(Boolean)
      if (ids.length) {
        const { data: items } = await supabase
          .from('invoice_items')
          .select('invoice_id, hsn_sac')
          .in('invoice_id', ids)
        const sac = new Map<string, { lines: number; services: number }>()
        for (const it of (items || []) as { invoice_id: string; hsn_sac: string | null }[]) {
          const bucket = sac.get(it.invoice_id) || { lines: 0, services: 0 }
          bucket.lines++
          if (String(it.hsn_sac || '').trim().startsWith('9')) bucket.services++
          sac.set(it.invoice_id, bucket)
        }
        for (const r of exportRows) {
          const b = sac.get(r.id)
          if (b?.lines) r.kind_hint = b.services * 2 >= b.lines ? 'service' : 'goods'
        }
      }
      setBooks(exportRows as unknown as ExportBookInvoice[])

      // ?tab= opens the register, the LUT list, the watch, the refund track, or the rules — so a
      // ⌘K row that found a shipping bill can land the shop on the track rather than the register.
      const t = searchParams.get('tab')
      if (t === 'register' || t === 'lut' || t === 'watch' || t === 'track' || t === 'rule') setTab(t)
      // ?new=1 opens a blank file, ?lut=1 the undertaking editor, ?file=<invoice> seeds from a book row.
      if (searchParams.get('new') === '1') setEditor({ file: newFile(), isNew: true })
      if (searchParams.get('lut') === '1') setLutEditor({ lut: newLut(), isNew: true })
      const seedNumber = searchParams.get('file')
      if (seedNumber) {
        const inv = exportRows.find(r => r.invoice_number === seedNumber)
        setEditor({ file: fileFromInvoice(inv as unknown as ExportBookInvoice || { invoice_number: seedNumber, invoice_date: '' } as ExportBookInvoice, todayISO()), isNew: true })
      }
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const today = todayISO()
  const deals = useMemo<FxDealLite[]>(() => fx.entries.map(e => ({
    invoice_number: e.invoice_number,
    currency: e.currency,
    foreign_value: e.foreign_value,
    booked_inr: e.booked_inr,
    receipts: e.receipts.map(r => ({ date: r.date, foreign: r.foreign, inr: r.inr, reference: r.reference })),
  })), [fx])

  const views = useMemo(() => exportViews(store, books, deals, today), [store, books, deals, today])
  const watch = useMemo(() => watchRows(store, books, deals, today), [store, books, deals, today])
  const unpapered = useMemo(() => unregisteredExports(books, store.files), [books, store.files])
  const totals = useMemo(() => summarise(views, unpapered.length), [views, unpapered.length])
  /** Per shipping bill: what this app can see about the claim the bill itself carries. */
  const track = useMemo(() => refundTrack(views, filings), [views, filings])

  const filtered = useMemo(() => views.filter(v =>
    matchesFilter(v, filter) &&
    matchesAny(search, [
      v.file.invoice_number, v.party, v.file.shipping_bill_number, v.file.destination,
      v.file.port_code, v.file.port_name, v.file.notes, v.file.lut_id,
    ])), [views, filter, search])
  const visible = useMemo(() => sortViews(filtered, sort), [filtered, sort])

  const noFiles = store.files.length === 0
  const viewOf = (id: string) => views.find(v => v.file.id === id) || null
  const nextLut = useMemo(() => nextLutWindow(today), [today])
  const lutCountdown = nextLut ? daysBetween(today, nextLut.deadline) : null

  function flash(message: string) { setNotice({ msg: message, bad: false }) }
  function warn(message: string) { setNotice({ msg: message, bad: true }) }

  // ── the file editor ────────────────────────────────────────────────────────
  function openFile(file: ExportFile, isNew: boolean) { setEditor({ file, isNew }) }
  function patchFile(patch: Partial<ExportFile>) {
    setEditor(e => (e ? { ...e, file: { ...e.file, ...patch } } : e))
  }
  const editorProblems = editor ? validateFile(editor.file, store, books, today) : []
  const editorDate = editor ? exportDateOf(editor.file, books) : null
  const editorWindow = editor
    ? realisationWindow(editorDate?.date || '', { rupee: editor.file.rupee_contract, overrideMonths: editor.file.window_months })
    : null
  const editorDue = editor && editorDate?.date && editorWindow
    ? addMonthsISO(editorDate.date, editorWindow.months)
    : ''
  const editorAdvance = editor && editor.file.advance_date
    ? advanceWindow(editor.file.advance_date, editor.file.advance_months)
    : null

  function saveFile() {
    if (!editor) return
    const result = recordFile(orgId, editor.file, books)
    if (!result.ok) { warn(result.error); return }
    setStore(result.store)
    const saved = result.store.files.find(f => f.id === editor.file.id)
    flash(editor.isNew
      ? `${saved?.invoice_number || 'File'} added — the register derived its window from the date of export.`
      : `${editor.file.invoice_number} updated — the clocks were re-run from the paper.`)
    setEditor(null)
  }

  function removeFile(v: ExportView) {
    const owed = v.outstanding > 0 ? ` Its ${money(v.outstanding)} of recorded realisations go with it.` : ''
    if (!confirm(`Take ${v.file.invoice_number} off the register? The invoice stays in the books.${owed}`)) return
    const result = deleteFile(orgId, v.file.id)
    if (!result.ok) { warn(result.error); return }
    setStore(result.store)
    flash(`${v.file.invoice_number} removed — the register no longer claims a clock for it.`)
  }

  function pickBook(invoiceNumber: string) {
    if (!editor) return
    const inv = books.find(b => b.invoice_number === invoiceNumber)
    if (!invoiceNumber) { patchFile({ invoice_number: '' }); return }
    if (!inv) { patchFile({ invoice_number: invoiceNumber }); return }
    const seeded = fileFromInvoice(inv, today)
    patchFile({
      invoice_number: seeded.invoice_number,
      kind: seeded.kind,
      export_date: editor.file.export_date || seeded.export_date,
      route: editor.file.route === 'unknown' ? seeded.route : editor.file.route,
      notes: editor.file.notes || seeded.notes,
    })
  }

  // ── realisations ───────────────────────────────────────────────────────────
  function openReceipt(fileId: string) {
    setReceipt({ fileId, draft: newRealisation(0) })
  }
  function patchReceipt(patch: Partial<Realisation>) {
    setReceipt(r => (r ? { ...r, draft: { ...r.draft, ...patch } } : r))
  }
  function saveReceipt() {
    if (!receipt) return
    const result = addRealisation(orgId, receipt.fileId, receipt.draft)
    if (!result.ok) { warn(result.error); return }
    setStore(result.store)
    const file = result.store.files.find(f => f.id === receipt.fileId)
    flash(`${money(receipt.draft.inr)} counted against ${file?.invoice_number || 'the consignment'} — the clock reads the day it landed, not today.`)
    setReceipt(null)
  }
  function dropReceipt(fileId: string, r: Realisation) {
    if (!confirm(`Remove the ${money(r.inr)} credit of ${formatDateIN(r.date)}? The bank advice still exists; this register just stops counting it.`)) return
    setStore(removeRealisation(orgId, fileId, r.id))
    flash('That credit was taken out of the count.')
  }

  // ── the refund claim ───────────────────────────────────────────────────────
  function openClaim(fileId: string) {
    const file = store.files.find(f => f.id === fileId)
    if (!file) return
    setClaim({ fileId, draft: { ...file.refund } })
  }
  function patchClaim(patch: Partial<RefundClaim>) {
    setClaim(c => (c ? { ...c, draft: { ...c.draft, ...patch } } : c))
  }
  function saveClaim() {
    if (!claim) return
    const result = setRefund(orgId, claim.fileId, claim.draft, books)
    if (!result.ok) { warn(result.error); return }
    setStore(result.store)
    flash(`Claim marked ${CLAIM_META[claim.draft.status].label.toLowerCase()} — the register re-ran the section 54(1) clock.`)
    setClaim(null)
  }

  // ── the LUT register ───────────────────────────────────────────────────────
  function openLut(lut: LutRecord, isNew: boolean) { setLutEditor({ lut, isNew }) }
  function patchLut(patch: Partial<LutRecord>) {
    setLutEditor(l => (l ? { ...l, lut: { ...l.lut, ...patch } } : l))
  }
  const lutProblems = lutEditor ? validateLut(lutEditor.lut, store.luts) : []
  function saveLut() {
    if (!lutEditor) return
    const result = upsertLut(orgId, lutEditor.lut)
    if (!result.ok) { warn(result.error); return }
    setStore(result.store)
    flash(lutEditor.isNew
      ? `Undertaking for ${result.store.luts.find(l => l.id === lutEditor.lut.id)?.financial_year || 'the year'} recorded — files that shipped under it now resolve.`
      : 'Undertaking updated — every file that names it was re-read.')
    setLutEditor(null)
  }
  function closeLut(l: LutRecord) {
    setStore(archiveLut(orgId, l.id, !l.archived))
    flash(l.archived
      ? `${l.financial_year} is live again.`
      : `${l.financial_year} archived — the paper still covered those shipments, so any file resting on it now shows a gap.`)
  }
  function removeLut(l: LutRecord) {
    const result = deleteLut(orgId, l.id)
    if (!result.ok) { warn(result.error); return }
    setStore(result.store)
    flash(`${l.financial_year} deleted from the register.`)
  }

  function saveHome() {
    setStore(setHomeGstin(orgId, homeInput))
    flash(homeInput.trim()
      ? `Home GSTIN set — LUTs are now matched to this registration.`
      : 'Home GSTIN cleared — the register will search every undertaking instead.')
  }

  // ── CSVs ───────────────────────────────────────────────────────────────────
  function exportRegister() {
    download(`taxflow-export-register-${today}.csv`, toCsv(EXPORT_REGISTER_CSV_HEADERS, registerCsvRows(visible)))
  }
  function exportShipping() {
    download(`taxflow-shipping-bills-${today}.csv`, toCsv(SHIPPING_BILL_CSV_HEADERS, shippingBillCsvRows(views)))
  }
  function exportRealisations() {
    download(`taxflow-realisations-${today}.csv`, toCsv(REALISATION_CSV_HEADERS, realisationCsvRows(views)))
  }
  function exportWatch() {
    download(`taxflow-export-watch-${today}.csv`, toCsv(WATCH_CSV_HEADERS, watchCsvRows(watch)))
  }
  function exportTrack() {
    download(`taxflow-igst-refund-track-${today}.csv`, toCsv(IGST_TRACK_CSV_HEADERS, igstTrackCsvRows(track.groups)))
  }
  function exportScreened() {
    download(`taxflow-export-not-on-track-${today}.csv`, toCsv(SCREENED_EXPORT_CSV_HEADERS, screenedCsvRows(track.screened)))
  }
  function exportLuts() {
    download(`taxflow-lut-${today}.csv`, toCsv(LUT_CSV_HEADERS, lutCsvRows(store.luts)))
  }

  // ── render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the export register…</div>
  }

  return (
    <div className="page-container ex" style={{ maxWidth: 1240 }}>
      <PageHeader
        eyebrow={`${(orgName || 'GST').toUpperCase()} · ZERO-RATED SUPPLY`}
        title="Exports"
        subtitle="Every consignment that left India, the paper that made it zero-rated, the day the proceeds have to be in, and the refund still on the table. Two clocks run here: FEMA on the money, and the refund — which goods claim through the shipping bill they sailed on, while services file a claim of their own under section 54(1)."
        actions={
          <>
            <Button variant="ghost" size="sm" icon="download"
              onClick={tab === 'lut' ? exportLuts : tab === 'watch' ? exportWatch : tab === 'track' ? exportTrack : exportRegister}
              disabled={tab === 'lut' ? store.luts.length === 0
                : tab === 'watch' ? watch.length === 0
                : tab === 'track' ? track.groups.length === 0
                : visible.length === 0}>
              CSV
            </Button>
            <Button variant="ghost" size="sm" icon="doc-check" onClick={() => openLut(newLut(), true)}>LUT</Button>
            <Button icon="plus" onClick={() => openFile(newFile(), true)}>New export file</Button>
          </>
        }
      />

      <div className="ex-stats">
        <StatCard
          label="Export files" value={String(totals.files)}
          sub={unpapered.length
            ? `${plural(unpapered.length, 'export invoice')} in the books with no file here`
            : `${totals.unmatched} with no invoice behind them`}
          icon="ship" tone="blue" delay={0}
        />
        <StatCard
          label="Value shipped" value={money(totals.value)}
          sub={`${totals.within} inside their window · ${totals.approaching} closing`}
          icon="scale" tone="cyan" delay={40}
        />
        <StatCard
          label="Proceeds still to land" value={money(totals.outstanding)}
          sub={totals.restricted || totals.overdue
            ? `${totals.restricted} past a year late · ${totals.overdue} overdue${totals.settled_late ? ` · ${totals.settled_late} settled late` : ''}`
            : totals.settled_late ? `${totals.settled_late} paid up after the window closed` : 'nothing short of its window'}
          icon={totals.restricted ? 'alert' : 'clock'} tone={totals.restricted ? 'red' : totals.overdue || totals.settled_late ? 'amber' : 'green'}
          delay={80}
        />
        <StatCard
          label="IGST to refund" value={money(totals.igst_claimable)}
          sub={`${totals.refunds_open} unclaimed · ${totals.refunds_closing} closing inside ${REFUND_CLOSING_DAYS} days · ${totals.refunds_lapsed} lapsed`}
          icon="wallet" tone={totals.refunds_lapsed ? 'red' : totals.refunds_closing ? 'amber' : 'violet'} delay={120}
        />
      </div>

      <div className="ex-toolbar">
        <Segmented options={TABS} value={tab} onChange={t => setTab(t as Tab)} />
        {tab === 'register' && (
          <>
            <select className="tf-input ex-sort" value={sort} onChange={e => setSort(e.target.value as ExportSort)} aria-label="Sort the register">
              {SORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <SearchInput value={search} onChange={setSearch} placeholder="Invoice, shipping bill, party or country…"
              ariaLabel="Search export files" style={{ flex: '1 1 220px', maxWidth: 320, marginLeft: 'auto' }} />
          </>
        )}
        {tab === 'lut' && (
          <div className="ex-home">
            <input className="tf-input" value={homeInput} onChange={e => setHomeInput(e.target.value.toUpperCase())}
              placeholder="Home GSTIN — 27AAACE1234F1ZP" aria-label="Home GSTIN" maxLength={15} />
            <Button size="sm" variant="ghost" icon="check" onClick={saveHome}>Set</Button>
          </div>
        )}
      </div>

      {notice && (
        <div className={`ex-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
          <Icon name={notice.bad ? 'alert' : 'check'} size={14} strokeWidth={notice.bad ? 2.2 : 2.4} />
          <span>{notice.msg}</span>
          <button type="button" className="ex-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {tab === 'register' && (
        <>
          <div className="ex-filters">
            <Segmented options={FILTERS} value={filter} onChange={f => setFilter(f as Filter)} />
            <div className="ex-filter-actions">
              <Button size="sm" variant="ghost" icon="download" onClick={exportShipping} disabled={views.length === 0}>Shipping bills</Button>
              <Button size="sm" variant="ghost" icon="download" onClick={exportRealisations} disabled={views.length === 0}>Realisations</Button>
            </div>
          </div>

          {noFiles && (
            <div className="ex-note" style={{ marginBottom: 12 }}>
              <Icon name="ship" size={14} strokeWidth={2.2} />
              <span>
                Nothing is registered yet. A file is one consignment: the invoice it travelled on, how the supply was
                made zero-rated (a <Link href="/gst/exports" onClick={e => { e.preventDefault(); openLut(newLut(), true) }}>LUT</Link> or
                IGST paid), the shipping bill, and the day the proceeds have to reach India. Fill in what the paper says —
                the register derives everything else.
              </span>
            </div>
          )}

          {!noFiles && totals.lut_gap > 0 && (
            <div className="ex-note is-hot" style={{ marginBottom: 12 }}>
              <Icon name="alert" size={14} strokeWidth={2.2} />
              <span>
                {plural(totals.lut_gap, 'file')} claim a LUT this register cannot match to the date of
                export. Without an undertaking in force for that year the supply is not zero-rated without payment — IGST
                becomes payable, and refundable under rule 96.
              </span>
            </div>
          )}

          {unpapered.length > 0 && (
            <Card pad={false} className="ex-unpapered">
              <div className="ex-unpapered-head">
                <Icon name="invoice" size={14} />
                <span>
                  {plural(unpapered.length, 'export invoice')} in the books with no file here.
                  The return is going to be filed from the invoice whether the shipping bill is written down or not.
                </span>
              </div>
              <div className="ex-unpapered-list">
                {unpapered.slice(0, 6).map(b => (
                  <button key={b.invoice_number} type="button" className="ex-chip"
                    onClick={() => setEditor({ file: fileFromInvoice(b, today), isNew: true })}>
                    <Icon name="plus" size={12} strokeWidth={2.4} />
                    {b.invoice_number}
                    <span className="ex-chip-sub">{b.customer_name || '—'} · {money(Number(b.grand_total) || 0)}</span>
                  </button>
                ))}
                {unpapered.length > 6 && <span className="ex-sub">…and {unpapered.length - 6} more</span>}
              </div>
            </Card>
          )}

          {visible.length === 0 ? (
            <Card>
              <EmptyState
                icon="ship"
                title={views.length > 0 ? 'Nothing in this view' : 'No export files yet'}
                message={views.length > 0
                  ? 'Clear the search or pick another filter to read the rest of the register.'
                  : 'Record a consignment when its shipping bill and invoice are both in hand. The register then tracks the realisation window, the refund clock and the paper still missing.'}
                action={views.length > 0
                  ? undefined
                  : <Button size="sm" icon="plus" onClick={() => openFile(newFile(), true)}>New export file</Button>}
              />
            </Card>
          ) : (
            <div className="ex-grid">
              {visible.map(v => <FileCard key={v.file.id} v={v} onEdit={() => openFile(v.file, false)}
                onReceipt={() => openReceipt(v.file.id)} onClaim={() => openClaim(v.file.id)}
                onDelete={() => removeFile(v)} onRemoveReceipt={r => dropReceipt(v.file.id, r)} />)}
            </div>
          )}
        </>
      )}

      {tab === 'lut' && (
        <Card pad={false}>
          {nextLut && (
            <div className="ex-renew">
              <div>
                <span className="ex-renew-label"><Icon name="doc-check" size={12} strokeWidth={2.2} /> Next undertaking</span>
                <div className="ex-renew-value">
                  Form GST RFD-11 for {nextLut.financial_year} — {formatDateIN(nextLut.from_date)} to {formatDateIN(nextLut.to_date)}
                </div>
                <p className="ex-sub">
                  One undertaking per registration per financial year, filed before 1 April. The portal returns an
                  RFD-11A acknowledgement; this register records it and never files it.
                  {lutCountdown === null
                    ? ` Deadline ${formatDateIN(nextLut.deadline)}.`
                    : ` Deadline ${formatDateIN(nextLut.deadline)} — ${plural(Math.max(0, lutCountdown), 'day')} away.`}
                </p>
              </div>
              <Button size="sm" icon="plus" onClick={() => openLut(newLut(nextLut.from_date), true)}>Record undertaking</Button>
            </div>
          )}

          {store.luts.length === 0 ? (
            <div style={{ padding: 4 }}>
              <EmptyState icon="doc-check" title="No undertaking on the register"
                message="A LUT export without a covering undertaking is not zero-rated without payment. Record the RFD-11A for each year you ship under one."
                action={<Button size="sm" icon="plus" onClick={() => openLut(newLut(), true)}>Record undertaking</Button>} />
            </div>
          ) : (
            <>
              <div className="ex-head ex-head-lut">
                <span>Financial year</span><span>GSTIN</span><span>Valid</span><span>RFD-11A</span>
                <span>Filed on</span><span>Files</span><span></span>
              </div>
              {[...store.luts].sort((a, b) => b.from_date.localeCompare(a.from_date)).map(l => {
                const files = views.filter(v => v.lut?.id === l.id)
                return (
                  <div key={l.id} className={`ex-row ex-row-lut ${l.archived ? 'is-dim' : ''}`}>
                    <span className="ex-name">{l.financial_year || fyOf(l.from_date)}{l.archived && <span className="ex-blank"> · archived</span>}</span>
                    <span className="ex-mono">{l.gstin || '—'}</span>
                    <span className="ex-num">{formatDateIN(l.from_date)} → {formatDateIN(l.to_date)}</span>
                    <span className="ex-mono">{l.reference || <span className="ex-blank">not recorded</span>}</span>
                    <span className="ex-num">{l.filed_date ? formatDateIN(l.filed_date) : <span className="ex-blank">—</span>}</span>
                    <span className="ex-num">{files.length}</span>
                    <span className="ex-actions">
                      <Button size="sm" variant="ghost" icon="edit" onClick={() => openLut(l, false)}>Edit</Button>
                      <Button size="sm" variant="ghost" icon={l.archived ? 'undo' : 'pause'} onClick={() => closeLut(l)}>{l.archived ? 'Live' : 'Archive'}</Button>
                      <Button size="sm" variant="ghost" icon="x" onClick={() => removeLut(l)}>Delete</Button>
                    </span>
                  </div>
                )
              })}
              <div className="ex-foot">
                <span>An archived undertaking stays on the register: the shipments it covered happened. A new file resting on an archived one is reported as a gap.</span>
                <span className="ex-foot-links"><Link href="/gst/calendar">Compliance calendar</Link><Link href="/invoices?supply_type=export">Export invoices</Link></span>
              </div>
            </>
          )}
        </Card>
      )}

      {tab === 'watch' && (
        <Card pad={false}>
          <div className="ex-section-head" style={{ padding: '14px 16px 0' }}>
            <h2><Icon name="calendar" size={15} />Every date on this register someone has to act on</h2>
            <span className="ex-section-sub">
              The same rows feed the compliance calendar, so the two can never disagree. Nothing is filed from here.
            </span>
          </div>
          {watch.length === 0 ? (
            <div style={{ padding: 8 }}>
              <EmptyState icon="calendar" title="Nothing to watch yet"
                message="Record a consignment and its window, or an undertaking for next year, and the dates appear here." />
            </div>
          ) : (
            <>
              <div className="ex-head ex-head-watch">
                <span>Date</span><span>What is due</span><span>Form / paper</span><span>Party</span><span>State</span>
              </div>
              {watch.map((w: WatchRow) => (
                <div key={w.id} className="ex-row ex-row-watch">
                  <span className="ex-num">{formatDateIN(w.date)}</span>
                  <span className="ex-watch-what">
                    <span className={`ex-dot ex-dot-${w.tone}`} />
                    <span className="ex-name">{w.label}</span>
                    <span className="ex-sub ex-watch-detail">{w.detail}</span>
                  </span>
                  <span className="ex-num">{w.form || '—'}</span>
                  <span className="ex-sub">{w.party || '—'}{w.ref ? ` · ${w.ref}` : ''}</span>
                  <span className={`ex-watch-state is-${w.tone}`}>{w.kind}</span>
                </div>
              ))}
              <div className="ex-foot">
                <span>{plural(watch.length, 'dated obligation')} on {plural(totals.files, 'file')}.</span>
                <span className="ex-foot-links"><Button size="sm" variant="ghost" icon="download" onClick={exportWatch}>Watch list CSV</Button></span>
              </div>
            </>
          )}
        </Card>
      )}

      {tab === 'track' && (
        <>
          <Card>
            <SectionTitle icon="ship">On the goods route, the shipping bill is the application</SectionTitle>
            <p className="ex-sub" style={{ marginTop: 0 }}>
              So this tab does not ask whether an RFD-1 was raised. It asks the question that decides whether the
              money moves: <b>what still blocks this bill</b>, read from the invoices in the books and the returns
              recorded on <Link href="/gst/filings">/gst/filings</Link>. One row per bill, however many invoices
              travelled on it — which is how the claim itself travels.
            </p>
            <div className="ex-quotes">
              {REFUND_TRACK_CITATIONS.map(c => (
                <div key={c.text} className={`ex-quote ${c.read === 'own' ? 'is-own' : ''}`}>
                  <p>{c.text}</p>
                  <a href={c.url} target="_blank" rel="noreferrer" className="ex-sub">
                    {c.read === 'own' ? 'own reading — ' : ''}{c.source}
                  </a>
                </div>
              ))}
            </div>
            <div className="ex-track-counts">
              <span><b>{track.at_risk}</b> provably blocked</span>
              <span><b>{track.waiting}</b> waiting on a return</span>
              <span><b>{track.clear}</b> nothing here blocks them</span>
              <span><b>{track.transcribed}</b> grant written on the file</span>
              <span><b>{track.unread}</b> no return to read yet</span>
              <span><b>{track.screened.length}</b> outside the mechanism</span>
            </div>
          </Card>

          <Card pad={false}>
            <div className="ex-section-head" style={{ padding: '14px 16px 0' }}>
              <h2><Icon name="wallet" size={15} />Per shipping bill, in the order the claim travels</h2>
              <span className="ex-section-sub">
                {track.has_filings
                  ? 'The returns below are what this device recorded on /gst/filings. A pass means nothing here blocks it — it does not mean the refund is due.'
                  : 'The filings register holds nothing on this device, so neither condition can be read yet. These rows are unknown, not unpaid.'}
              </span>
            </div>

            {track.groups.length === 0 ? (
              <div style={{ padding: 8 }}>
                <EmptyState icon="wallet" title="No bill to track yet"
                  message="The track reads goods files made zero-rated by paying IGST. Record a consignment with its shipping bill number, or see the list below for the supplies that fall outside the mechanism and what runs instead." />
              </div>
            ) : (
              <>
                <div className="ex-head ex-head-track">
                  <span>Shipping bill</span><span>Invoices on it</span><span>IGST at stake</span>
                  <span>Returns for the period</span><span>State, and what it says</span>
                </div>
                {track.groups.map(g => (
                  <div key={g.key} className="ex-row ex-row-track">
                    <span className="ex-track-bill">
                      <span className="ex-mono">{g.bill_number || <span className="ex-blank">no number</span>}</span>
                      <span className="ex-sub">
                        {g.bill_date ? `bill dated ${formatDateIN(g.bill_date)}` : 'no bill date'}
                        {' · '}{g.periods.length ? g.periods.join(', ') : 'no period named'}
                      </span>
                    </span>
                    <span className="ex-track-inv">
                      {g.members.map(m => (
                        <span key={m.file_id} className="ex-track-member">
                          <b>{m.invoice_number}</b>
                          <span className="ex-sub">
                            {m.in_books ? money(m.igst) : 'not in the books'}
                            {m.date ? ` · left ${formatDateIN(m.date)}` : ' · no date'}
                            {m.outstanding > 0 ? ` · ${money(m.outstanding)} still out` : ''}
                          </span>
                        </span>
                      ))}
                    </span>
                    <span className="ex-num">
                      {money(g.igst_stated)}
                      {g.igst_unknown > 0 && <span className="ex-sub"> floor — {g.igst_unknown} unread</span>}
                      {g.claim === 'mixed' && <span className="ex-sub"> · files disagree</span>}
                    </span>
                    <span className="ex-track-returns">
                      <ReadingLine r={g.gstr1} />
                      <ReadingLine r={g.gstr3b} />
                    </span>
                    <span className={`ex-track-state is-${TRACK_META[g.state].tone}`}>
                      <Badge tone={TRACK_META[g.state].tone} dot={false}>{TRACK_META[g.state].label}</Badge>
                      <span className="ex-sub">{g.blocker}</span>
                      <span className="ex-track-next">{g.next}</span>
                      {g.warnings.map(w => (
                        <span key={w.code} className="ex-track-warn"><b>{w.label}</b> — {w.detail}</span>
                      ))}
                    </span>
                  </div>
                ))}
                <div className="ex-foot">
                  <span>{plural(track.groups.length, 'bill')} · {plural(track.groups.reduce((s, g) => s + g.members.length, 0), 'file')}.</span>
                  <span className="ex-foot-links">
                    <Button size="sm" variant="ghost" icon="download" onClick={exportTrack}>Refund track CSV</Button>
                    <Link href="/gst/filings">The returns register</Link>
                  </span>
                </div>
              </>
            )}
          </Card>

          {track.screened.length > 0 && <ScreenedList rows={track.screened} onCsv={exportScreened} />}

          <Card>
            <SectionTitle icon="shield">What the track states, and what it cannot</SectionTitle>
            <div className="ex-refund-states">
              {TRACK_ORDER.map((s: TrackState) => (
                <span key={s} className={`ex-rstate is-${TRACK_META[s].tone}`}>{TRACK_META[s].label}</span>
              ))}
            </div>
            <ul className="ex-boundaries">
              {REFUND_TRACK_BOUNDARIES.map(b => <li key={b}>{b}</li>)}
            </ul>
            <p className="ex-sub">
              The comparison this tab makes is weaker than the portal&rsquo;s in one direction, deliberately: the
              filings register keeps a return&rsquo;s <b>total</b> stated IGST, and tables 6A/6B and 3.1(b) are parts
              of that total. So a bill bigger than the total is <b>provably short</b>; a bill that fits inside it
              proves nothing, and is printed as a pass, not a promise.
            </p>
          </Card>
        </>
      )}

      {tab === 'rule' && (
        <div className="ex-rule">
          <Card>
            <SectionTitle icon="clock">The realisation window, as it has stood on each date of export</SectionTitle>
            <p className="ex-sub" style={{ marginTop: 0 }}>
              The period is chosen by the date the goods left, not by today. Each band carries the instrument that
              fixed it; where two secondary sources read the same notification differently, the disagreement is
              printed as a question rather than averaged into a date. Verify against rbi.org.in before relying on one.
            </p>
            <div className="ex-head ex-head-band">
              <span>From</span><span>Months</span><span>Rupee contract</span><span>Instrument</span>
            </div>
            {REALISATION_BANDS.map(b => (
              <div key={b.from} className="ex-row ex-row-band">
                <span className="ex-num">{formatDateIN(b.from)}</span>
                <span className="ex-num is-strong">{b.months}</span>
                <span className="ex-num">{b.rupee_months ?? 'same'}</span>
                <span className="ex-band-what">
                  <a href={b.url} target="_blank" rel="noreferrer">{b.source}</a>
                  <span className="ex-sub">{b.note}</span>
                  {b.disputed && (
                    <span className="ex-dispute">
                      <Icon name="compare" size={12} strokeWidth={2.2} />
                      Exports on {formatDateIN(b.disputed.from)}: the register says {plural(b.months, 'month')}, the other reading says
                      {' '}{b.disputed.instead_months} — {b.disputed.why}
                    </span>
                  )}
                </span>
              </div>
            ))}
            <div className="ex-rule-foot">
              <span className="ex-label">Today</span>
              <span className="ex-chip is-static">
                {windowLabelOf(today)} for a consignment that leaves now
              </span>
            </div>
          </Card>

          <Card>
            <SectionTitle icon="truck">Advance against export — how long the goods may stay undispatched</SectionTitle>
            <div className="ex-head ex-head-band">
              <span>From</span><span>Months</span><span>Rupee contract</span><span>Instrument</span>
            </div>
            {ADVANCE_BANDS.map(b => (
              <div key={b.from} className="ex-row ex-row-band">
                <span className="ex-num">{formatDateIN(b.from)}</span>
                <span className="ex-num is-strong">{b.months}</span>
                <span className="ex-num">{b.rupee_months ?? 'same'}</span>
                <span className="ex-band-what">
                  <a href={b.url} target="_blank" rel="noreferrer">{b.source}</a>
                  <span className="ex-sub">{b.note}</span>
                </span>
              </div>
            ))}
            <p className="ex-sub">
              A file with an advance carries its own dispatch clock. Goods that leave after it are reported late even
              though they left; goods that never left are the louder of the two.
            </p>
          </Card>

          <Card>
            <SectionTitle icon="shield">How a supply is made zero-rated, and what each route has to prove</SectionTitle>
            {ROUTE_ORDER.map(r => (
              <div key={r} className="ex-route">
                <div className="ex-route-head">
                  <Badge tone={r === 'lut' ? 'blue' : r === 'igst_paid' ? 'violet' : r === 'sez' ? 'cyan' : 'grey'} dot={false}>
                    {ROUTE_META[r].short}
                  </Badge>
                  <span className="ex-name">{ROUTE_META[r].label}</span>
                  <span className="ex-sub">{ROUTE_META[r].tax_paid ? 'IGST paid, refundable' : 'no tax paid first'}</span>
                </div>
                <p className="ex-sub">{ROUTE_META[r].basis}</p>
              </div>
            ))}
            <div className="ex-split">
              {KIND_ORDER.map(k => (
                <div key={k} className="ex-kind">
                  <span className="ex-label">{KIND_META[k].label}</span>
                  <p className="ex-sub">{KIND_META[k].paper}</p>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle icon="wallet">The refund clock, and what it is not</SectionTitle>
            <p className="ex-sub" style={{ marginTop: 0 }}>
              Section 54(1) allows two years from the relevant date — the register takes the date of export for goods
              and the invoice date for services. That is the outer limit; rule 96(10)&apos;s claim-window was dropped by
              Notification 20/2024-Central Tax. A LUT or SEZ supply that paid no IGST has nothing to refund, so the
              register says so instead of printing a deadline it cannot act on.
            </p>
            <div className="ex-refund-states">
              {(Object.keys(REFUND_LABEL) as (keyof typeof REFUND_LABEL)[]).map(k => (
                <span key={k} className={`ex-rstate is-${REFUND_TONE[k]}`}>{REFUND_LABEL[k]}</span>
              ))}
            </div>
            <p className="ex-sub">
              {REFUND_WINDOW_MONTHS} months is the outer wall; inside {REFUND_CLOSING_DAYS} days of it a row turns amber.
              Rule 91(2)/section 54(6) provisional 90% is the portal&apos;s call, not a figure this register invents.
            </p>
          </Card>
        </div>
      )}

      <div className="ex-foot">
        <span>
          A workpaper, not a filing. Proceeds are counted from <Link href="/fx">/fx</Link> when it holds the deal,
          balances are receipted on <Link href="/payments">/payments</Link>, and the invoices stay in
          {' '}<Link href="/invoices">the books</Link>.
        </span>
        <span className="ex-foot-links">
          <Link href="/gst/gstr1">GSTR-1</Link>
          <Link href="/gst/calendar">Compliance calendar</Link>
          <Link href="/fx">Foreign currency</Link>
        </span>
      </div>

      {editor && (
        <div className="ex-scrim" role="dialog" aria-modal="true" aria-label={editor.isNew ? 'Record an export file' : 'Edit the export file'}
          onClick={e => { if (e.target === e.currentTarget) setEditor(null) }}>
          <div className="ex-modal" style={{ maxWidth: 760 }}>
            <div className="ex-modal-head">
              <div>
                <h2>{editor.isNew ? 'A consignment that left India' : `Edit ${editor.file.invoice_number || 'export file'}`}</h2>
                <p>
                  One row per shipping bill or per service invoice. The date of export starts the clock, so it is the
                  field worth getting from the paper rather than the memory.
                </p>
              </div>
              <button type="button" className="ex-close" onClick={() => setEditor(null)} aria-label="Close"><Icon name="x" size={16} /></button>
            </div>

            <div className="ex-grid2">
              <label className="ex-field">
                <span>Invoice number *</span>
                <input className="tf-input" value={editor.file.invoice_number} list="ex-book-invoices"
                  onChange={e => pickBook(e.target.value)} placeholder="INV-2026-27-0007" autoFocus spellCheck={false} />
                <datalist id="ex-book-invoices">
                  {books.map(b => <option key={b.invoice_number} value={b.invoice_number}>{b.customer_name || ''}</option>)}
                </datalist>
              </label>
              <label className="ex-field">
                <span>Date of export</span>
                <input className="tf-input" type="date" value={editor.file.export_date}
                  onChange={e => patchFile({ export_date: e.target.value })} />
              </label>
            </div>
            <div className="ex-basis">
              <Icon name="clock" size={12} strokeWidth={2.2} />
              The clock runs on {editorDate?.date ? `${formatDateIN(editorDate.date)} (${DATE_FROM_LABEL[editorDate.from]})` : 'no date the register can find'}
              {editorWindow ? ` — proceeds due ${editorDue ? formatDateIN(editorDue) : '—'} (${windowWords(editorWindow)})` : ''}.
              Leave the date blank and the shipping bill carries it; then the invoice date. The register always says which.
            </div>

            <div className="ex-grid2">
              <Segmented options={KIND_ORDER.map(k => ({ value: k, label: KIND_META[k].label }))}
                value={editor.file.kind} onChange={k => patchFile({ kind: k as ConsignKind })} />
              <Segmented options={ROUTE_ORDER.map(r => ({ value: r, label: ROUTE_META[r].short }))}
                value={editor.file.route} onChange={r => patchFile({ route: r as ZeroRatingRoute })} />
            </div>
            <div className="ex-basis"><Icon name="shield" size={12} strokeWidth={2.2} />{ROUTE_META[editor.file.route].basis}</div>

            <div className="ex-grid3">
              <label className="ex-field">
                <span>Shipping bill number</span>
                <input className="tf-input" value={editor.file.shipping_bill_number}
                  onChange={e => patchFile({ shipping_bill_number: e.target.value })} placeholder="912004556781 — ICEGATE" disabled={editor.file.kind === 'service'} />
              </label>
              <label className="ex-field">
                <span>Shipping bill date</span>
                <input className="tf-input" type="date" value={editor.file.shipping_bill_date}
                  onChange={e => patchFile({ shipping_bill_date: e.target.value })} disabled={editor.file.kind === 'service'} />
              </label>
              <label className="ex-field">
                <span>Mode of transport</span>
                <select className="tf-input" value={editor.file.mode} onChange={e => patchFile({ mode: e.target.value })}>
                  {TRANSPORT_MODES.map(m => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                </select>
              </label>
            </div>

            <div className="ex-grid3">
              <label className="ex-field">
                <span>Port / ICD of lading</span>
                <select className="tf-input" value={editor.file.port_code} onChange={e => {
                  const p = INDIAN_PORTS.find(x => x.code === e.target.value)
                  patchFile({ port_code: e.target.value, port_name: p ? p.name : editor.file.port_name })
                }}>
                  <option value="">Not on the shortlist</option>
                  {INDIAN_PORTS.map(p => <option key={p.code} value={p.code}>{p.code} — {p.name}</option>)}
                </select>
              </label>
              <label className="ex-field">
                <span>Or typed</span>
                <input className="tf-input" value={editor.file.port_name} onChange={e => patchFile({ port_name: e.target.value })}
                  placeholder="As the shipping bill spells it" />
              </label>
              <label className="ex-field">
                <span>Country of destination</span>
                <input className="tf-input" value={editor.file.destination} list="ex-destinations"
                  onChange={e => patchFile({ destination: e.target.value })} placeholder="United States of America" />
                <datalist id="ex-destinations">{EXPORT_DESTINATIONS.map(d => <option key={d} value={d} />)}</datalist>
              </label>
            </div>

            <div className="ex-grid3">
              <label className="ex-field">
                <span>Undertaking it travelled under</span>
                <select className="tf-input" value={editor.file.lut_id} onChange={e => patchFile({ lut_id: e.target.value })}>
                  <option value="">Match by date and GSTIN</option>
                  {store.luts.map(l => <option key={l.id} value={l.id}>{l.financial_year} · {l.gstin} · {l.reference || 'no ref'}</option>)}
                </select>
              </label>
              <label className="ex-field">
                <span>Registration that shipped it</span>
                <input className="tf-input" value={editor.file.gstin} onChange={e => patchFile({ gstin: e.target.value.toUpperCase() })}
                  placeholder={store.settings.home_gstin || 'Blank = the home GSTIN'} maxLength={15} />
              </label>
              <label className="ex-field">
                <span>Currency of the contract</span>
                <input className="tf-input" value={editor.file.currency_override} onChange={e => patchFile({ currency_override: e.target.value.toUpperCase() })}
                  placeholder="USD — /fx holds the deal" />
              </label>
            </div>

            <div className="ex-grid3">
              <label className="ex-field">
                <span>Window months (0 = the cited band)</span>
                <input className="tf-input" type="number" min="0" max="60" step="1" value={editor.file.window_months || ''}
                  onChange={e => patchFile({ window_months: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
                  placeholder={editorWindow ? String(editorWindow.months) : '9'} />
              </label>
              <label className="ex-field">
                <span>Advance received (date)</span>
                <input className="tf-input" type="date" value={editor.file.advance_date}
                  onChange={e => patchFile({ advance_date: e.target.value })} />
              </label>
              <label className="ex-field">
                <span>Advance dispatch window (0 = band)</span>
                <input className="tf-input" type="number" min="0" max="60" step="1" value={editor.file.advance_months || ''}
                  onChange={e => patchFile({ advance_months: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
                  placeholder={editorAdvance ? String(editorAdvance.months) : '12'} />
              </label>
            </div>

            <label className="ex-check">
              <input type="checkbox" checked={editor.file.rupee_contract} onChange={e => patchFile({ rupee_contract: e.target.checked })} />
              <span>Rupee-denominated export contract — the rupee trade channel</span>
            </label>

            <label className="ex-field">
              <span>Notes</span>
              <input className="tf-input" value={editor.file.notes} onChange={e => patchFile({ notes: e.target.value })}
                placeholder="Condonation applied for, buyer's inspection, whatever the paper says" />
            </label>

            <div className="ex-preview">
              <div className="ex-preview-head">
                <span>What the register will write</span>
                <span className="ex-preview-total">{editorDue ? `proceeds by ${formatDateIN(editorDue)}` : 'no clock yet'}</span>
              </div>
              <ul className="ex-preview-list">
                <li>
                  <span className={`ex-dot ex-dot-${editorWindow ? (editorWindow.disputed ? 'amber' : 'blue') : 'grey'}`} />
                  {editorWindow
                    ? `${plural(editorWindow.months, 'month')} from ${editorDate?.date ? formatDateIN(editorDate.date) : 'the date of export'} — ${editorWindow.source}`
                    : 'No date of export: the window cannot be fixed until the paper is recorded'}
                </li>
                {editorWindow?.disputed && editorWindow.alternative_months !== null && (
                  <li>
                    <span className="ex-dot ex-dot-amber" />
                    The sources split for this date: it may be {plural(editorWindow.alternative_months, 'month')} instead. {editorWindow.dispute}
                  </li>
                )}
                {editorWindow?.overridden && (
                  <li><span className="ex-dot ex-dot-violet" />This file overrides the band table — the register prints the override, it does not hide it.</li>
                )}
                {editorWindow?.rupee_channel && (
                  <li><span className="ex-dot ex-dot-blue" />Rupee-contract channel: {plural(editorWindow.months, 'month')}, per the band&apos;s rupee carve-out.</li>
                )}
                {editor.file.kind === 'service' && (
                  <li><span className="ex-dot ex-dot-grey" />A service export has no shipping bill — the invoice, the payment and the foreign recipient are the paper.</li>
                )}
                {editorAdvance && (
                  <li>
                    <span className="ex-dot ex-dot-violet" />
                    Advance of {formatDateIN(editor.file.advance_date)}: goods due out by the {editorAdvance.months}-month window,
                    i.e. {addMonthsISO(editor.file.advance_date, editorAdvance.months)}
                    {editorAdvance.disputed ? ' (the same date is read two ways)' : ''}
                  </li>
                )}
                {!editor.file.destination.trim() && (
                  <li><span className="ex-dot ex-dot-red" />No destination — zero-rating depends on the supply leaving India to a recipient outside it.</li>
                )}
                {editor.file.route === 'lut' && store.luts.length === 0 && (
                  <li><span className="ex-dot ex-dot-red" />No undertaking on the register, so this file will report a LUT gap until one is recorded.</li>
                )}
              </ul>
              {editorProblems.length > 0 && (
                <ul className="ex-problems is-modal">
                  {editorProblems.map(p => <li key={p}><Icon name="alert" size={12} strokeWidth={2.2} />{p}</li>)}
                </ul>
              )}
            </div>

            <div className="ex-save">
              <Button variant="ghost" onClick={() => setEditor(null)}>Cancel</Button>
              <Button icon="check" onClick={saveFile} disabled={editorProblems.length > 0}>
                {editor.isNew ? 'Record export file' : 'Save changes'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {lutEditor && (
        <div className="ex-scrim" role="dialog" aria-modal="true" aria-label={lutEditor.isNew ? 'Record a Letter of Undertaking' : 'Edit the undertaking'}
          onClick={e => { if (e.target === e.currentTarget) setLutEditor(null) }}>
          <div className="ex-modal" style={{ maxWidth: 620 }}>
            <div className="ex-modal-head">
              <div>
                <h2>{lutEditor.isNew ? 'Letter of Undertaking' : `Edit ${lutEditor.lut.financial_year || 'the undertaking'}`}</h2>
                <p>
                  Filed in Form GST RFD-11 for one registration for one financial year. The portal returns an RFD-11A
                  acknowledgement — this register keeps its number so a shipment can be matched to it.
                </p>
              </div>
              <button type="button" className="ex-close" onClick={() => setLutEditor(null)} aria-label="Close"><Icon name="x" size={16} /></button>
            </div>

            <div className="ex-grid2">
              <label className="ex-field">
                <span>GSTIN it was filed under *</span>
                <input className="tf-input" value={lutEditor.lut.gstin} onChange={e => patchLut({ gstin: e.target.value.toUpperCase() })}
                  placeholder={store.settings.home_gstin || '27AAACE1234F1ZP'} maxLength={15} autoFocus />
              </label>
              <label className="ex-field">
                <span>RFD-11A acknowledgement</span>
                <input className="tf-input" value={lutEditor.lut.reference} onChange={e => patchLut({ reference: e.target.value })}
                  placeholder="RFD11A260001234" />
              </label>
            </div>

            <div className="ex-grid2">
              <label className="ex-field">
                <span>Valid from *</span>
                <input className="tf-input" type="date" value={lutEditor.lut.from_date}
                  onChange={e => patchLut({ from_date: e.target.value, financial_year: fyOf(e.target.value) })} />
              </label>
              <label className="ex-field">
                <span>Valid to *</span>
                <input className="tf-input" type="date" value={lutEditor.lut.to_date} onChange={e => patchLut({ to_date: e.target.value })} />
              </label>
            </div>

            <label className="ex-field">
              <span>Filed on the portal</span>
              <input className="tf-input" type="date" value={lutEditor.lut.filed_date} onChange={e => patchLut({ filed_date: e.target.value })} />
            </label>
            <label className="ex-field">
              <span>Note</span>
              <input className="tf-input" value={lutEditor.lut.notes} onChange={e => patchLut({ notes: e.target.value })}
                placeholder="Circle, revision, whatever the acknowledgement carries" />
            </label>

            <div className="ex-preview">
              <div className="ex-preview-head"><span>What the register will write</span>
                <span className="ex-preview-total">{fyOf(lutEditor.lut.from_date)}</span></div>
              <ul className="ex-preview-list">
                <li><span className="ex-dot ex-dot-blue" />Every LUT export dated between {lutEditor.lut.from_date ? formatDateIN(lutEditor.lut.from_date) : '—'} and {lutEditor.lut.to_date ? formatDateIN(lutEditor.lut.to_date) : '—'} resolves to this undertaking.</li>
                {lutEditor.lut.filed_date && lutEditor.lut.filed_date > lutEditor.lut.from_date && (
                  <li><span className="ex-dot ex-dot-amber" />Filed after the year opened — some circles read coverage from filing, others from 1 April. Files in that stretch print the question.</li>
                )}
                <li><span className="ex-dot ex-dot-grey" />One undertaking per registration per year; the deadline for next year is {formatDateIN(lutRenewalDeadline(today))}.</li>
              </ul>
              {lutProblems.length > 0 && (
                <ul className="ex-problems is-modal">{lutProblems.map(p => <li key={p}><Icon name="alert" size={12} strokeWidth={2.2} />{p}</li>)}</ul>
              )}
            </div>

            <div className="ex-save">
              <Button variant="ghost" onClick={() => setLutEditor(null)}>Cancel</Button>
              <Button icon="check" onClick={saveLut} disabled={lutProblems.length > 0}>
                {lutEditor.isNew ? 'Record undertaking' : 'Save changes'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {receipt && (() => {
        const v = viewOf(receipt.fileId)
        if (!v) return null
        const countedElsewhere = v.realisation_source === 'fx'
        return (
          <div className="ex-scrim" role="dialog" aria-modal="true" aria-label="Record a realisation"
            onClick={e => { if (e.target === e.currentTarget) setReceipt(null) }}>
            <div className="ex-modal" style={{ maxWidth: 560 }}>
              <div className="ex-modal-head">
                <div>
                  <h2>Rupees that landed — {v.file.invoice_number}</h2>
                  <p>
                    The date the bank credited matters more than the amount: the register proves whether the window was
                    met by the day the money arrived.
                  </p>
                </div>
                <button type="button" className="ex-close" onClick={() => setReceipt(null)} aria-label="Close"><Icon name="x" size={16} /></button>
              </div>

              {countedElsewhere && (
                <div className="ex-basis is-warn"><Icon name="globe" size={12} strokeWidth={2.2} />
                  /fx holds this deal and its receipts are the counted figure. Recording a credit here shows it beside the
                  FX row and flags the disagreement — the register never adds the two together.
                </div>
              )}

              <div className="ex-grid2">
                <label className="ex-field">
                  <span>Rupees credited *</span>
                  <input className="tf-input" type="number" min="0" step="0.01" value={receipt.draft.inr || ''}
                    onChange={e => patchReceipt({ inr: Number(e.target.value) || 0 })} placeholder="0" autoFocus />
                </label>
                <label className="ex-field">
                  <span>Date of credit *</span>
                  <input className="tf-input" type="date" value={receipt.draft.date} onChange={e => patchReceipt({ date: e.target.value })} />
                </label>
              </div>
              <div className="ex-grid2">
                <label className="ex-field">
                  <span>FIRC / e-BRC / UTR</span>
                  <input className="tf-input" value={receipt.draft.reference} onChange={e => patchReceipt({ reference: e.target.value })}
                    placeholder="Whatever the bank advice quotes" />
                </label>
                <label className="ex-field">
                  <span>Note</span>
                  <input className="tf-input" value={receipt.draft.note} onChange={e => patchReceipt({ note: e.target.value })}
                    placeholder="Net of bank charges, part of a batch, …" />
                </label>
              </div>

              <div className="ex-preview">
                <div className="ex-preview-head"><span>Counted so far</span>
                  <span className="ex-preview-total">{money(v.realised)} of {money(v.invoice_value)}</span></div>
                <ul className="ex-preview-list">
                  <li><span className={`ex-dot ex-dot-${v.due_date && receipt.draft.date > v.due_date ? 'red' : 'green'}`} />
                    {v.due_date
                      ? `Window closes ${formatDateIN(v.due_date)}; this credit is dated ${receipt.draft.date ? formatDateIN(receipt.draft.date) : '—'}`
                      : 'No window to fit this credit into — record the date of export'}
                  </li>
                  <li><span className="ex-dot ex-dot-blue" />The ledger balance is receipted on /payments — this register only proves the money reached India.</li>
                </ul>
              </div>

              <div className="ex-save">
                <Button variant="ghost" onClick={() => setReceipt(null)}>Cancel</Button>
                <Button icon="check" onClick={saveReceipt} disabled={!(receipt.draft.inr > 0) || !receipt.draft.date}>Record realisation</Button>
              </div>
            </div>
          </div>
        )
      })()}

      {claim && (() => {
        const v = viewOf(claim.fileId)
        if (!v) return null
        // On the goods route with IGST paid there is no refund form to raise: the shipping bill the
        // customs side already holds IS the application (see the "IGST refund track" tab). The wording
        // below follows the file, so a goods consignment is never asked for a form it does not need.
        const onGoodsBill = v.kind === 'goods' && v.route === 'igst_paid'
        return (
          <div className="ex-scrim" role="dialog" aria-modal="true" aria-label="Record the refund claim"
            onClick={e => { if (e.target === e.currentTarget) setClaim(null) }}>
            <div className="ex-modal" style={{ maxWidth: 560 }}>
              <div className="ex-modal-head">
                <div>
                  <h2>Refund claim — {v.file.invoice_number}</h2>
                  <p>
                    {onGoodsBill
                      ? 'On a goods export made with IGST paid the shipping bill itself is the refund application — there is no separate form to file. The money moves once the return side is complete; this register transcribes what the portal or ICEGATE says about it and never files anything.'
                      : 'IGST paid on a zero-rated supply is recoverable, but only inside two years of the relevant date. This register transcribes the ARN the portal returns; it never files anything.'}
                  </p>
                </div>
                <button type="button" className="ex-close" onClick={() => setClaim(null)} aria-label="Close"><Icon name="x" size={16} /></button>
              </div>

              <Segmented options={CLAIM_ORDER.map(k => ({ value: k, label: CLAIM_META[k].label }))}
                value={claim.draft.status} onChange={k => patchClaim({ status: k as RefundClaim['status'] })} />
              <div className="ex-basis"><Icon name="shield" size={12} strokeWidth={2.2} />{CLAIM_META[claim.draft.status].note}</div>

              <div className="ex-grid2">
                <label className="ex-field">
                  <span>{onGoodsBill ? 'Refund reference (ARN / ICEGATE)' : 'RFD-1 ARN'}</span>
                  <input className="tf-input" value={claim.draft.claim_ref} onChange={e => patchClaim({ claim_ref: e.target.value })}
                    placeholder={onGoodsBill ? `${v.file.shipping_bill_number || 'Shipping bill no.'} · sanction ref` : 'AA1234567890123'}
                    disabled={claim.draft.status === 'none'} />
                </label>
                <label className="ex-field">
                  <span>Claim date</span>
                  <input className="tf-input" type="date" value={claim.draft.claim_date} onChange={e => patchClaim({ claim_date: e.target.value })}
                    disabled={claim.draft.status === 'none'} />
                </label>
              </div>
              <div className="ex-grid2">
                <label className="ex-field">
                  <span>Grant / rejection order</span>
                  <input className="tf-input" value={claim.draft.order_ref} onChange={e => patchClaim({ order_ref: e.target.value })}
                    placeholder={onGoodsBill ? 'Refund order / ICEGATE sanction ref' : 'RFD-12 reference'}
                    disabled={claim.draft.status !== 'granted' && claim.draft.status !== 'rejected'} />
                </label>
                <label className="ex-field">
                  <span>Note</span>
                  <input className="tf-input" value={claim.draft.notes} onChange={e => patchClaim({ notes: e.target.value })}
                    placeholder={onGoodsBill ? 'Customs objection, EGM, part sanction, …' : 'Provisional 90% under section 54(6), …'} />
                </label>
              </div>

              <div className="ex-preview">
                <div className="ex-preview-head"><span>The clock beside this claim</span>
                  <span className="ex-preview-total">{money(v.igst_paid)} paid</span></div>
                <ul className="ex-preview-list">
                  <li><span className={`ex-dot ex-dot-${REFUND_TONE[v.refund.state] === 'grey' ? 'grey' : REFUND_TONE[v.refund.state]}`} />
                    {refundLine(v)}</li>
                  <li><span className="ex-dot ex-dot-grey" />Relevant date {v.refund.relevant_date ? formatDateIN(v.refund.relevant_date) : 'not established'} — {v.refund.basis}</li>
                </ul>
              </div>

              <div className="ex-save">
                <Button variant="ghost" onClick={() => setClaim(null)}>Cancel</Button>
                <Button icon="check" onClick={saveClaim}>Save claim</Button>
              </div>
            </div>
          </div>
        )
      })()}

      <style>{`
        .ex-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .ex-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .ex-sort { width: auto; padding-right: 26px; }
        .ex-home { display: flex; align-items: center; gap: 8px; margin-left: auto; }
        .ex-home .tf-input { width: 230px; }
        .ex-filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .ex-filter-actions { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; }

        .ex-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px;
          font-size: 12.5px; color: var(--green); background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 10px; }
        .ex-notice svg { flex-shrink: 0; }
        .ex-notice.is-bad { color: var(--amber); background: var(--amber-soft);
          border-color: color-mix(in srgb, var(--amber) 26%, white); }
        .ex-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; border-radius: 6px; min-height: 0; }
        .ex-notice-x:hover { background: rgba(0,0,0,0.05); }

        .ex-note { display: flex; align-items: flex-start; gap: 7px; padding: 9px 12px; border-radius: 10px;
          font-size: 12px; color: var(--muted); background: var(--surface-2); border: 1px solid var(--line-soft); line-height: 1.55; }
        .ex-note svg { flex-shrink: 0; margin-top: 2px; }
        .ex-note a { color: var(--brand); }
        .ex-note.is-hot { color: var(--red); background: var(--red-soft); border-color: color-mix(in srgb, var(--red) 24%, white); }
        .ex-note.is-hot a { color: inherit; text-decoration: underline; }

        .ex-unpapered { margin-bottom: 12px; }
        .ex-unpapered-head { display: flex; align-items: flex-start; gap: 8px; padding: 12px 14px 4px;
          font-size: 12px; color: var(--muted); line-height: 1.55; }
        .ex-unpapered-head svg { color: var(--brand); flex-shrink: 0; margin-top: 2px; }
        .ex-unpapered-list { display: flex; flex-wrap: wrap; gap: 7px; padding: 8px 14px 14px; }
        .ex-chip { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px;
          border: 1px solid var(--line); background: var(--surface-2); color: var(--ink-2);
          font-family: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer; }
        .ex-chip:hover { border-color: var(--brand); color: var(--brand); background: var(--brand-soft); }
        .ex-chip.is-static { cursor: default; }
        .ex-chip.is-static:hover { border-color: var(--line); color: var(--ink-2); background: var(--surface-2); }
        .ex-chip-sub { font-weight: 500; color: var(--faint); }

        .ex-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
        .ex-card { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--line);
          border-radius: var(--radius-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-xs); }
        .ex-card.is-restricted { border-left-color: var(--red); }
        .ex-card.is-overdue { border-left-color: var(--red); }
        .ex-card.is-approaching, .ex-card.is-settled_late, .ex-card.is-no_date { border-left-color: var(--amber); }
        .ex-card.is-within { border-left-color: var(--brand); }
        .ex-card.is-settled { border-left-color: var(--green); }
        .ex-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .ex-card-title { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .ex-card-name { display: flex; align-items: center; gap: 7px; font-size: 14.5px; font-weight: 650; color: var(--ink); overflow-wrap: anywhere; }
        .ex-card-name svg { color: var(--brand); flex-shrink: 0; }
        .ex-card-sub { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--faint); line-height: 1.5; flex-wrap: wrap; }
        .ex-card-badges { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
        .ex-card-stats { display: flex; flex-direction: column; }
        .ex-card-stats > div:last-child { border-bottom: none; }

        .ex-clock { display: flex; align-items: center; gap: 7px; padding: 8px 11px; border-radius: 10px;
          font-size: 12px; font-weight: 600; background: var(--slate-soft); color: var(--muted); flex-wrap: wrap; }
        .ex-clock-window { margin-left: auto; font-weight: 550; font-size: 11px; color: var(--faint);
          font-variant-numeric: tabular-nums; text-align: right; }
        .ex-clock.is-red { background: var(--red-soft); color: var(--red); }
        .ex-clock.is-amber { background: var(--amber-soft); color: var(--amber); }
        .ex-clock.is-blue { background: var(--brand-soft); color: var(--brand); }
        .ex-clock.is-green { background: var(--green-soft); color: var(--green); }
        .ex-clock.is-grey { background: var(--slate-soft); color: var(--muted); }

        .ex-progress { display: flex; flex-direction: column; gap: 5px; }
        .ex-progress-label { font-size: 11px; color: var(--faint); }

        .ex-gaps { display: flex; flex-direction: column; gap: 5px; }
        .ex-gap { display: flex; align-items: flex-start; gap: 6px; font-size: 11.5px; line-height: 1.5;
          color: var(--ink-2); background: var(--surface-2); border: 1px solid var(--line-soft);
          border-left: 3px solid var(--amber); border-radius: 8px; padding: 7px 9px; }
        .ex-gap svg { color: var(--amber); flex-shrink: 0; margin-top: 1px; }
        .ex-gap b { font-weight: 650; }
        .ex-gap span { color: var(--muted); }
        .ex-gaps-head { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }

        .ex-attention { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .ex-attention li { display: flex; align-items: flex-start; gap: 6px; font-size: 11.5px; line-height: 1.5;
          color: var(--red); background: var(--red-soft); border-radius: 8px; padding: 7px 9px; }
        .ex-attention li svg { flex-shrink: 0; margin-top: 1px; }

        .ex-lines { border-top: 1px dashed var(--line); padding-top: 9px; display: flex; flex-direction: column; gap: 5px; }
        .ex-line { display: grid; grid-template-columns: minmax(0, 1fr) auto 22px; gap: 8px; align-items: center;
          padding: 6px 8px; background: var(--surface-2); border-radius: 9px; }
        .ex-line-what { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; min-width: 0; }
        .ex-line-name { font-size: 12px; font-weight: 600; color: var(--ink-2); }
        .ex-line-sub { font-size: 10.5px; color: var(--faint); }
        .ex-line-right { display: flex; flex-direction: column; align-items: flex-end; }
        .ex-line-qty { font-size: 12px; font-weight: 650; color: var(--ink); font-variant-numeric: tabular-nums; }
        .ex-line-x { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; min-height: 0; }
        .ex-line-x:hover { background: var(--red-soft); color: var(--red); }

        .ex-card-foot { display: flex; align-items: center; gap: 8px; margin-top: auto; flex-wrap: wrap; }
        .ex-card-actions { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; }

        .ex-head, .ex-row { display: grid; gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .ex-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .ex-head-lut, .ex-row-lut { grid-template-columns: 130px 160px minmax(0, 1.3fr) 150px 110px 60px minmax(0, 1fr); }
        .ex-head-watch, .ex-row-watch { grid-template-columns: 110px minmax(0, 2.2fr) 130px minmax(0, 1fr) 110px; }
        .ex-head-band, .ex-row-band { grid-template-columns: 110px 70px 120px minmax(0, 1fr); }
        .ex-row:not(.ex-row-lut):not(.ex-row-watch):not(.ex-row-band) { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .ex-row.is-dim { opacity: 0.62; }
        .ex-num { font-variant-numeric: tabular-nums; color: var(--ink-2); }
        .ex-num.is-strong { font-weight: 700; color: var(--ink); }
        .ex-mono { font-family: var(--mono); font-size: 11.5px; color: var(--ink-2); overflow-wrap: anywhere; }
        .ex-sub { font-size: 11px; color: var(--faint); line-height: 1.5; }
        .ex-name { font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
        .ex-blank { color: var(--faint); font-weight: 550; font-size: 11px; }
        .ex-label { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .ex-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
        .ex-watch-what { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; min-width: 0; }
        .ex-watch-detail { flex-basis: 100%; }
        .ex-watch-state { font-size: 11px; font-weight: 650; text-transform: capitalize; color: var(--muted); }
        .ex-watch-state.is-red { color: var(--red); }
        .ex-watch-state.is-amber { color: var(--amber); }
        .ex-watch-state.is-green { color: var(--green); }
        .ex-watch-state.is-blue { color: var(--brand); }

        .ex-band-what { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .ex-band-what a { color: var(--brand); font-size: 12px; font-weight: 600; text-decoration: none; overflow-wrap: anywhere; }
        .ex-band-what a:hover { text-decoration: underline; }
        .ex-dispute { display: flex; align-items: flex-start; gap: 6px; font-size: 11.5px; color: var(--amber);
          background: var(--amber-soft); border-radius: 8px; padding: 6px 8px; line-height: 1.5; }
        .ex-dispute svg { flex-shrink: 0; margin-top: 2px; }
        .ex-rule-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px;
          padding: 10px 12px; border: 1px solid var(--line-soft); border-radius: 10px; background: var(--surface-2); }
        .ex-rule { display: flex; flex-direction: column; gap: 14px; }
        .ex-route { padding: 10px 0; border-bottom: 1px solid var(--line-soft); display: flex; flex-direction: column; gap: 5px; }
        .ex-route:last-child { border-bottom: none; }
        .ex-route-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .ex-split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 10px; }
        .ex-kind { background: var(--surface-2); border: 1px solid var(--line-soft); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 5px; }
        .ex-refund-states { display: flex; flex-wrap: wrap; gap: 7px; margin: 10px 0; }
        .ex-rstate { font-size: 11.5px; font-weight: 600; padding: 5px 9px; border-radius: 8px;
          background: var(--slate-soft); color: var(--muted); }
        .ex-rstate.is-red { background: var(--red-soft); color: var(--red); }
        .ex-rstate.is-amber { background: var(--amber-soft); color: var(--amber); }
        .ex-rstate.is-green { background: var(--green-soft); color: var(--green); }
        .ex-rstate.is-blue { background: var(--brand-soft); color: var(--brand); }
        .ex-rstate.is-violet { background: var(--violet-soft); color: var(--violet); }

        /* The IGST refund track: one row per shipping bill, and the reading that decides the state stays legible. */
        .ex-quotes { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 9px; margin-top: 12px; }
        .ex-quote { background: var(--surface-2); border: 1px solid var(--line-soft); border-left: 3px solid var(--brand);
          border-radius: 10px; padding: 9px 11px; display: flex; flex-direction: column; gap: 5px; }
        .ex-quote p { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--ink); }
        .ex-quote.is-own { border-left-color: var(--amber); }
        .ex-quote.is-own p { color: var(--muted); font-style: italic; }
        .ex-quote a { color: var(--faint); text-decoration: underline; text-underline-offset: 2px; }
        .ex-track-counts { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 12px; font-size: 12px; color: var(--muted); }
        .ex-track-counts b { color: var(--ink); font-size: 13px; }
        .ex-head-track, .ex-row-track { display: grid; gap: 10px;
          grid-template-columns: 170px minmax(0, 1.4fr) 130px minmax(0, 1.5fr) minmax(0, 1.8fr); }
        .ex-head-screen, .ex-row-screen { display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) minmax(0, 2.2fr); }
        .ex-row-track, .ex-row-screen { padding: 12px 16px; border-bottom: 1px solid var(--line-soft); align-items: start; }
        .ex-track-bill, .ex-track-inv, .ex-track-returns, .ex-track-state, .ex-track-why, .ex-track-member {
          display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .ex-track-member b { font-size: 12.5px; color: var(--ink); font-weight: 650; }
        .ex-track-ret { display: flex; flex-direction: column; gap: 3px; }
        .ex-track-ret > b { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .ex-track-ret-line { font-size: 11.5px; color: var(--muted); line-height: 1.45; }
        .ex-track-ret-line.is-bad { color: var(--amber); font-weight: 600; }
        .ex-sub.is-dim { color: var(--faint); font-style: italic; }
        .ex-track-state > span:not(.ex-rstate) { font-size: 11.5px; line-height: 1.45; }
        .ex-track-next { color: var(--ink); font-weight: 600; }
        .ex-track-warn { background: var(--amber-soft); color: var(--amber); border-radius: 8px; padding: 5px 8px; }
        .ex-track-why b { font-size: 12.5px; color: var(--ink); font-weight: 650; }
        /* The state cell carries the same tone rule the register cards' FEMA clock does, so a long
           bill list scans by colour and the is-… class on that cell is a style, not a label. */
        .ex-track-state { border-left: 2px solid var(--line); padding-left: 10px; }
        .ex-track-state.is-red { border-left-color: var(--red); }
        .ex-track-state.is-amber { border-left-color: var(--amber); }
        .ex-track-state.is-green { border-left-color: var(--green); }
        .ex-track-state.is-blue { border-left-color: var(--brand); }
        .ex-boundaries { margin: 10px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px;
          font-size: 12px; color: var(--muted); line-height: 1.5; }

        .ex-renew { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line-soft); flex-wrap: wrap; }
        .ex-renew > div { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .ex-renew-label { display: flex; align-items: center; gap: 6px; font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .ex-renew-value { font-size: 14px; font-weight: 650; color: var(--ink); }

        .ex-section-head { display: flex; flex-direction: column; gap: 4px; }
        .ex-section-head h2 { display: flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 650; color: var(--ink); margin: 0; }
        .ex-section-head h2 svg { color: var(--brand); }
        .ex-section-sub { font-size: 11.5px; color: var(--faint); max-width: 760px; line-height: 1.55; }

        .ex-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          font-size: 11.5px; color: var(--faint); margin-top: 20px; }
        .ex-foot-links { display: flex; gap: 12px; flex-wrap: wrap; }
        .ex-foot-links a { color: var(--brand); text-decoration: none; }

        .ex-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .ex-modal { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg);
          padding: 1.4rem 1.5rem; width: 100%; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .ex-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .ex-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .ex-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; max-width: 470px; line-height: 1.5; }
        .ex-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; flex-shrink: 0; min-height: 0; }
        .ex-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .ex-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
        .ex-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: start; }
        .ex-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .ex-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .ex-check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-2); }
        .ex-check input { width: 16px; height: 16px; accent-color: var(--brand); }
        .ex-basis { display: flex; align-items: flex-start; gap: 7px; font-size: 11.5px; color: var(--muted);
          background: var(--surface-2); border-left: 3px solid var(--brand); border-radius: 8px; padding: 8px 11px; line-height: 1.55; }
        .ex-basis svg { flex-shrink: 0; margin-top: 2px; color: var(--brand); }
        .ex-basis.is-warn { border-left-color: var(--amber); color: var(--amber); background: var(--amber-soft); }
        .ex-basis.is-warn svg { color: var(--amber); }

        .ex-preview { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--surface-2); }
        .ex-preview-head { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); flex-wrap: wrap; }
        .ex-preview-total { color: var(--brand); font-variant-numeric: tabular-nums; }
        .ex-preview-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .ex-preview-list li { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; color: var(--ink-2); line-height: 1.5; flex-wrap: wrap; }
        .ex-problems { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .ex-problems li { display: flex; align-items: flex-start; gap: 6px; font-size: 11.5px; line-height: 1.5;
          color: var(--amber); background: var(--amber-soft); border-radius: 8px; padding: 7px 9px; }
        .ex-problems li svg { flex-shrink: 0; margin-top: 1px; }
        .ex-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; }
        .ex-dot-red { background: var(--red); }
        .ex-dot-green { background: var(--green); }
        .ex-dot-blue { background: var(--brand); }
        .ex-dot-amber { background: var(--amber); }
        .ex-dot-violet { background: var(--violet); }
        .ex-dot-cyan { background: var(--cyan); }
        .ex-dot-grey { background: var(--faint); }
        .ex-save { display: flex; gap: 10px; justify-content: flex-end; }

        @media (max-width: 1100px) { .ex-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .ex-stats { grid-template-columns: 1fr 1fr; }
          .ex-grid { grid-template-columns: 1fr; }
          .ex-grid2, .ex-grid3, .ex-split { grid-template-columns: 1fr; }
          .ex-row, .ex-row-lut, .ex-row-watch, .ex-row-band, .ex-row-track, .ex-row-screen { grid-template-columns: 1fr; gap: 6px; }
          .ex-head, .ex-head-lut, .ex-head-watch, .ex-head-band, .ex-head-track, .ex-head-screen { display: none; }
          .ex-quotes { grid-template-columns: 1fr; }
          .ex-track-counts { gap: 5px 14px; font-size: 11.5px; }
          .ex-track-state { border-left: none; padding-left: 0; border-top: 1px dashed var(--line); padding-top: 8px; }
          .ex-actions { justify-content: flex-start; }
          .ex-scrim { align-items: flex-end; padding: 0; }
          .ex-scrim .ex-modal { max-width: none !important; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .ex-save { flex-direction: column-reverse; }
          .ex-filter-actions { margin-left: 0; }
        }
      `}</style>
    </div>
  )
}

// ── The card ───────────────────────────────────────────────────────────────────

function FileCard({ v, onEdit, onReceipt, onClaim, onDelete, onRemoveReceipt }: {
  v: ExportView
  onEdit: () => void
  onReceipt: () => void
  onClaim: () => void
  onDelete: () => void
  onRemoveReceipt: (r: Realisation) => void
}) {
  const clock = clockLine(v)
  const kind = KIND_META[v.kind]
  const route = ROUTE_META[v.route]
  return (
    <div className={`ex-card is-${v.time_state}`}>
      <div className="ex-card-head">
        <div className="ex-card-title">
          <span className="ex-card-name">
            <Icon name="ship" size={15} />
            {v.file.invoice_number}
          </span>
          <span className="ex-card-sub">
            <Icon name="users" size={12} /> {v.party || (v.unmatched ? 'no invoice in the books' : 'party not on the invoice')}
            {v.file.destination ? ` · to ${v.file.destination}` : ' · destination not recorded'}
          </span>
          <span className="ex-card-sub">
            {v.export_date
              ? <>Left India {formatDateIN(v.export_date)} <span className="ex-blank">({DATE_FROM_LABEL[v.date_from]})</span></>
              : 'No date of export'}
            {v.file.shipping_bill_number ? ` · SB ${v.file.shipping_bill_number}` : ` · ${kind.paper.split('—')[0].trim()}`}
            {v.file.port_code ? ` · ${v.file.port_code}` : ''}
          </span>
        </div>
        <div className="ex-card-badges">
          <Badge tone={TIME_TONE[v.time_state]} dot={false}>{TIME_LABEL[v.time_state]}</Badge>
          <Badge tone={v.kind === 'service' ? 'cyan' : 'blue'} dot={false}>{kind.label}</Badge>
          <Badge tone={route.tax_paid ? 'violet' : 'grey'} dot={false}>{route.short}</Badge>
        </div>
      </div>

      <div className={`ex-clock is-${clock.tone}`}>
        <Icon name="clock" size={14} strokeWidth={2.2} />
        <span>{clock.text}</span>
        <span className="ex-clock-window">{windowLine(v)}{v.window ? ` · ${v.window.band_from} band` : ''}</span>
      </div>

      <div className="ex-card-stats">
        <StatRow label={`Invoice value${v.unmatched ? ' (not in the books)' : ''}`}
          value={v.invoice_value ? money(v.invoice_value) : '—'} />
        <StatRow label={`Realised${v.realisation_source === 'fx' ? ' (from /fx)' : v.realisation_source === 'here' ? ' (recorded here)' : ''}`}
          tone={v.realisation_source === 'fx' ? 'violet' : 'grey'} value={money(v.realised)} />
        <StatRow label="Still to realise" tone={v.outstanding > 0 ? (v.time_state === 'restricted' || v.time_state === 'overdue' ? 'red' : 'cyan') : 'green'}
          strong value={v.outstanding > 0 ? money(v.outstanding) : 'Nothing owing'} />
        {v.fx.has_deal && (
          <StatRow label={`Foreign side (${v.fx.currency})`}
            tone={v.fx.foreign_unmeasured ? 'grey' : v.fx.outstanding_foreign ? 'amber' : 'green'}
            value={v.fx.foreign_unmeasured
              ? 'rupee receipts only'
              : `${inr.format(v.fx.foreign_value)} · ${v.fx.outstanding_foreign ? `${inr.format(v.fx.outstanding_foreign)} to come` : 'complete'}`} />
        )}
        <StatRow label="Refund" tone={REFUND_TONE[v.refund.state] === 'grey' ? 'grey' : REFUND_TONE[v.refund.state]}
          value={refundLine(v)} />
        {v.lut && (
          <StatRow label="Undertaking" tone={v.lut_gap ? 'red' : 'blue'}
            value={`${v.lut.financial_year || fyOf(v.lut.from_date)} · ${v.lut.reference || 'no RFD-11A'}${v.lut.archived ? ' · archived' : ''}`} />
        )}
        {v.advance && (
          <StatRow label={`Advance ${formatDateIN(v.advance.received)}`} tone={v.advance.late ? 'red' : 'grey'}
            value={v.advance.dispatched
              ? `goods out ${formatDateIN(v.file.export_date || v.file.shipping_bill_date)} · window closed ${formatDateIN(v.advance.due_date)}`
              : `dispatch by ${formatDateIN(v.advance.due_date)}${v.advance.days_left !== null ? ` · ${plural(v.advance.days_left, 'day')}` : ''}`} />
        )}
      </div>

      <div className="ex-progress">
        <ProgressBar value={v.received_pct} max={100}
          color={v.outstanding > 0 ? (v.time_state === 'restricted' || v.time_state === 'overdue' ? 'var(--red)' : 'var(--brand)') : 'var(--green)'} />
        <span className="ex-progress-label">
          {v.invoice_value ? `${pct(v.received_pct)} of the invoice value has reached India` : 'no invoice value to measure against'}
        </span>
      </div>

      {v.attention.length > 0 && (
        <ul className="ex-attention">
          {v.attention.map(a => <li key={a}><Icon name="alert" size={12} strokeWidth={2.2} />{a}</li>)}
        </ul>
      )}

      {v.paper_missing.length > 0 && (
        <div className="ex-gaps">
          <span className="ex-gaps-head">Paper this consignment has to produce</span>
          {v.paper_missing.map(g => (
            <div key={g.label} className="ex-gap" title={g.why}>
              <Icon name="file-check" size={12} strokeWidth={2.2} />
              <span><b>{g.label}</b> — {g.document}</span>
            </div>
          ))}
        </div>
      )}

      {v.file.realisations.length > 0 && (
        <div className="ex-lines">
          {v.file.realisations.slice().reverse().map(r => (
            <div key={r.id} className="ex-line">
              <span className="ex-line-what">
                <span className={`ex-dot ex-dot-${v.due_date && r.date > v.due_date ? 'amber' : 'green'}`} />
                <span className="ex-line-name">{formatDateIN(r.date)}</span>
                <span className="ex-line-sub">{r.reference || 'no bank reference'}{v.realisation_source === 'here' ? '' : ' · not counted'}</span>
              </span>
              <span className="ex-line-right"><span className="ex-line-qty">{money(r.inr)}</span></span>
              <button type="button" className="ex-line-x" onClick={() => onRemoveReceipt(r)} aria-label="Remove this credit">
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="ex-card-foot">
        {v.book?.id && <Link className="ex-sub" href={`/invoices/${v.book.id}`}>the invoice</Link>}
        {v.fx.has_deal && <Link className="ex-sub" href="/fx">FX deal</Link>}
        <div className="ex-card-actions">
          <Button size="sm" variant="ghost" icon="wallet" onClick={onReceipt}>Realisation</Button>
          <Button size="sm" variant="ghost" icon="percent" onClick={onClaim}>Claim</Button>
          <Button size="sm" variant="ghost" icon="edit" onClick={onEdit}>Edit</Button>
          <Button size="sm" variant="ghost" icon="x" onClick={onDelete}>Remove</Button>
        </div>
      </div>
    </div>
  )
}

// ── Small helpers the card and the page share ──────────────────────────────────

function windowLabelOf(today: string): string {
  const w = realisationWindow(today)
  return w ? `${w.months}-month window` : 'no window'
}

export default function ExportsPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <ExportsPageInner />
    </Suspense>
  )
}
