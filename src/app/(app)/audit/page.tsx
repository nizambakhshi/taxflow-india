'use client'

// The audit trail and the period seal — evidence of what was decided, and a window closed.
//
// The engine (src/lib/audit.ts) owns the model: a standing list of sealed periods and an
// append-only trail of every seal, release, refusal and note, kept in this browser under
// `taxflow:audit:<orgId>`. This page is the register itself — the seals, the trail, the
// integrity verdict on that trail, and the two dialogs (close a period, lift a seal) that
// are the only ways anything is written from here.
//
// This page holds three answers, and three boundaries are printed on the screen rather than left to
// the reader to assume, because each one is where an "audit log" feature elsewhere quietly overreaches:
//
//  * **The seals and the trail hold no money of their own.** A seal is a window, an event is a sentence.
//    The money stays in the invoices and bills; nothing here charges, debits or files anything. A month
//    sealed from the close tab may carry the figures that reading printed as a photograph — a copy of
//    what another register already said, which `ledger.ts` never reads and no derivation folds.
//  * **The trail is a checksum, not a signature.** The page says "the trail is unbroken" —
//    that the `seq` numbers run 1..n with no gap, duplicate or reorder. That is what a
//    hand-edit leaves behind. It cannot say *who* held the keyboard; only the actor each
//    write path chose to stamp is as good as that write path's own login.
//  * **The seal only closes the doors that ask it.** Since R3-5 the question is asked by the
//    shared writers — `createInvoice`, `createPurchaseBill`, `createNote` — so an invoice, a bill,
//    a credit or debit note, a POS sale, a recurring catch-up, a converted order or challan, a
//    Tally voucher or an offline replay dated inside a sealed window is refused before a sequence
//    number is spent on it, and the attempt is logged here. The paths that type straight into a
//    table (expenses, payments, cancelling or marking a document paid) ask from their own page.
//    Anything still not wired is printed below by name, not implied: a lock that quietly covers
//    some doors is worse than a smaller lock that says which ones it covers.
//
// The third tab is the exception to the first boundary, and says so: the **period close**
// (`src/lib/period-close.ts`) folds the four document tables for one month — the only server read this
// page makes — beside the journal, the order registers, the filings register and this trail, and prints
// what the window still holds. It is a reading, not a door: it seals nothing itself, and its one button
// hands the month to the dialog below, which keeps its own date check and its own note (Rule 54: a
// reading reaches paper only through the register that owns the paper).
//
// Since R3-21 the handover carries one more thing, and it is still the dialog that decides: when a month
// is sealed *from this tab*, the reading's figures go with it as a **photograph** stored on the seal, and
// the tab then prints what was sealed against what the same derivation reads today. A seal put on from
// the Seals tab keeps none — that dialog has looked at nothing, and this register will not photograph a
// window it has not read.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN, plural } from '@/lib/format'
import { formatINR } from '@/lib/gst-engine'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import {
  activeSeals, type AuditEvent, type AuditStore, EVENT_META, fyLabel, fyStartOf, loadAudit,
  monthLabel, monthSealability, type PeriodSeal, SEAL_CSV_HEADERS, sealCsvRows, sealGuard, sealPeriod,
  type SealKind, trailCsvRows, trailStats, TRAIL_CSV_HEADERS, releaseSeal, recordNote, todayISO, verifyChain,
} from '@/lib/audit'
import {
  CLOSE_CSV_HEADERS, CLOSE_STATE_META, closeCsvRows, closeDrift, closeMonthOptions, closeReading,
  closeWindowOf, defaultCloseMonth, SEAL_VIEW_META, sealSnapshotOf, type CloseReading,
} from '@/lib/period-close'
import { loadFilings } from '@/lib/filings'
import { loadJournal } from '@/lib/journal'
import { loadAllDocs, type FlowDoc } from '@/lib/orderflow'
import type { LedgerBill, LedgerExpense, LedgerInvoice, LedgerPayment } from '@/lib/ledger'
import {
  Badge, Button, Card, EmptyState, PageHeader, SearchInput, SectionTitle, Segmented, StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'

type Tab = 'seals' | 'trail' | 'close'

const TABS: { value: Tab; label: string }[] = [
  { value: 'seals', label: 'Period seals' },
  { value: 'trail', label: 'The trail' },
  { value: 'close', label: 'Period close' },
]

/** The four document tables a close reading folds, exactly as `ledger.ts` asks for them. */
interface CloseDocs {
  invoices: LedgerInvoice[]
  bills: LedgerBill[]
  expenses: LedgerExpense[]
  payments: LedgerPayment[]
}

// The doors, named. A seal is only as strong as the paths that consult it, so the page prints them
// rather than let "period lock" imply a coverage the wiring has not earned.
//
// `by` says *where* the question is asked, which matters to a shop reading this list: a door marked
// **the writer** is closed inside the shared creator (`createInvoice`, `createPurchaseBill`,
// `createNote`), so every page that saves through it inherits the seal — including pages that never
// mention a seal. A door marked **its own engine** is closed inside that register's library rather
// than on the form above it, so the sentence a refusal prints is the engine's, not the page's. A door
// marked **this page** types straight into its table, so the page carries the door itself. Since R3-5
// the writer covers most of the money paths, and the residue is named here.
const GUARDED: { href: string; label: string; by: 'the writer' | 'its own engine' | 'this page' | null }[] = [
  { href: '/invoices/new', label: 'New invoice', by: 'the writer' },
  { href: '/pos', label: 'POS counter sale', by: 'the writer' },
  { href: '/recurring', label: 'Recurring catch-up bill', by: 'the writer' },
  { href: '/offline', label: 'Outbox replay', by: 'the writer' },
  { href: '/sales-orders', label: 'Sales order → invoice', by: 'the writer' },
  { href: '/purchase-orders', label: 'Purchase order → bill', by: 'the writer' },
  { href: '/challans', label: 'Challan → invoice', by: 'the writer' },
  { href: '/tally', label: 'Tally import', by: 'the writer' },
  { href: '/ai/scan-bill', label: 'Scanned purchase bill', by: 'the writer' },
  { href: '/bills', label: 'New purchase bill', by: 'the writer' },
  { href: '/credit-notes', label: 'Credit note', by: 'the writer' },
  { href: '/debit-notes', label: 'Debit note', by: 'the writer' },
  { href: '/journal', label: 'Journal entry', by: 'its own engine' },
  { href: '/expenses', label: 'Expense entry', by: 'this page' },
  { href: '/payments', label: 'Payment received', by: 'this page' },
  { href: '/invoices', label: 'Invoice paid stamp / cancel', by: 'this page' },
  { href: '/bills', label: 'Bill paid stamp / cancel', by: 'this page' },
  { href: '/quotations', label: 'Quotation → invoice', by: 'this page' },
  // The scan page has two halves and they are guarded by two different hands: the bill goes through
  // `createPurchaseBill`, the receipt kept as an expense is typed into `expenses` by the page.
  { href: '/ai/scan-bill', label: 'Scanned receipt kept as an expense', by: 'this page' },
  // Open on purpose, and printed as open. A master record (customer, vendor, product, settings)
  // carries no date and moves no rupee on a statement, so a period seal has nothing to close it.
  { href: '/gst/gstr1', label: 'GSTR-1 filing status', by: null },
  { href: '/customers', label: 'Master records', by: null },
]

/** How many doors actually ask, in the shop's own terms — a count is honest at thirteen in a way a
 *  comma-separated sentence stops being. */
const doorsAsking = GUARDED.filter(d => d.by).length
const doorsWriter = GUARDED.filter(d => d.by === 'the writer').length
const doorsEngine = GUARDED.filter(d => d.by === 'its own engine').length
const doorsPage = GUARDED.filter(d => d.by === 'this page').length

/** The doors a seal actually closes, counted off `GUARDED` — a sentence on this page can never claim
 *  a coverage the wiring has not earned, and a new door changes the count by itself. */
function sealedDoors(): string {
  if (doorsAsking === 0) return 'no path yet'
  return `the ${plural(doorsAsking, 'path')} listed on the seals page`
}

function stamp(isoStr: string): string {
  if (!isoStr) return '—'
  const d = new Date(isoStr)
  if (Number.isNaN(d.getTime())) return isoStr
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

/** The FY window a year seal would close — shown so the shop reads the span before it acts. */
function fyWindow(startYear: number): string {
  return `1 Apr ${startYear} – 31 Mar ${startYear + 1}`
}

interface SealDraft { year: number; kind: SealKind; month: string; note: string }
interface ReleaseDraft { seal: PeriodSeal; reason: string }

function AuditPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)

  const [store, setStore] = useState<AuditStore>({ version: 1, updatedAt: '', orgId: '', seals: [], events: [] })

  const [tab, setTab] = useState<Tab>('seals')
  const [search, setSearch] = useSearchDeepLink()
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)

  // The period close — a reading the page takes, not a state it keeps. `closeDocs` is null until the
  // fetch answers, and the engine prints that as ignorance rather than as an empty month (Rule 27).
  const [closeMonth, setCloseMonth] = useState(() => defaultCloseMonth(todayISO()))
  const [closeFy, setCloseFy] = useState(() => fyStartOf(defaultCloseMonth(todayISO())) ?? new Date().getFullYear())
  const [closeDocs, setCloseDocs] = useState<CloseDocs | null>(null)
  const [closeLoading, setCloseLoading] = useState(false)

  const [seal, setSeal] = useState<SealDraft | null>(null)
  const [sealError, setSealError] = useState('')
  const [release, setRelease] = useState<ReleaseDraft | null>(null)
  const [releaseError, setReleaseError] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')

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
      setStore(loadAudit(oid))

      const t = searchParams.get('tab')
      if (t === 'trail' || t === 'seals' || t === 'close') setTab(t)
      // ?month=YYYY-MM — the palette and a seal dialog's neighbour rows land on one period's close.
      const mo = searchParams.get('month')
      if (mo && /^\d{4}-\d{2}$/.test(mo)) {
        setCloseMonth(mo)
        const fy = fyStartOf(`${mo}-01`)
        if (fy !== null) setCloseFy(fy)
      }
      // ?new=1 — the palette's "Seal a period" action lands here with the dialog open.
      if (searchParams.get('new') === '1') openSeal()
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The documents the close folds are the only thing this page has ever asked the server for, and it
  // asks for one window at a time — the same four tables, the same columns `ledger.ts` reads.
  useEffect(() => {
    if (tab !== 'close' || !orgId || !/^\d{4}-\d{2}$/.test(closeMonth)) return
    const w = closeWindowOf(closeMonth)
    if (!w) return
    const win = { from: w.from, to: w.to }
    let dead = false
    async function pull() {
      setCloseLoading(true)
      setCloseDocs(null)
      const [inv, bill, exp, pay] = await Promise.all([
        supabase.from('invoices').select('status, invoice_date, taxable_amount, total_tax, balance_due')
          .eq('organization_id', orgId).gte('invoice_date', win.from).lte('invoice_date', win.to),
        supabase.from('purchase_bills').select('status, bill_date, taxable_amount, total_tax, itc_eligible, balance_due')
          .eq('organization_id', orgId).gte('bill_date', win.from).lte('bill_date', win.to),
        supabase.from('expenses').select('expense_date, amount, gst_amount, taxable_amount, itc_eligible, payment_status, category')
          .eq('organization_id', orgId).gte('expense_date', win.from).lte('expense_date', win.to),
        supabase.from('payments').select('payment_type, amount, payment_date')
          .eq('organization_id', orgId).gte('payment_date', win.from).lte('payment_date', win.to),
      ])
      if (dead) return
      if (inv.error || bill.error || exp.error || pay.error) {
        setCloseDocs(null)
        setCloseLoading(false)
        return
      }
      setCloseDocs({
        invoices: (inv.data || []) as LedgerInvoice[],
        bills: (bill.data || []) as LedgerBill[],
        expenses: (exp.data || []) as LedgerExpense[],
        payments: (pay.data || []) as LedgerPayment[],
      })
      setCloseLoading(false)
    }
    pull()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, orgId, closeMonth])

  const closeReadingNow = useMemo(() => {
    if (tab !== 'close') return null
    return closeReading({
      month: closeMonth,
      documents: closeDocs,
      journal: orgId ? loadJournal(orgId) : null,
      flow: orgId ? (loadAllDocs(orgId) as FlowDoc[]) : null,
      filings: orgId ? loadFilings(orgId).filings : null,
      audit: store,
    })
  }, [tab, closeMonth, closeDocs, store, orgId])

  const stats = useMemo(() => trailStats(store), [store])
  const chain = useMemo(() => verifyChain(store), [store])

  const standing = useMemo(() => activeSeals(store), [store])
  const orderedSeals = useMemo(() => {
    const a = standing.slice().sort((x, y) => (y.sealed_at || '').localeCompare(x.sealed_at || ''))
    const r = store.seals.filter(s => s.released_at !== null)
      .sort((x, y) => (y.released_at || '').localeCompare(x.released_at || ''))
    return [...a, ...r]
  }, [store, standing])

  const visibleSeals = useMemo(
    () => orderedSeals.filter(s => matchesView(s, tab) && matchesAny(search,
      [s.label, s.note, s.sealed_by, s.release_reason, s.from, s.to, s.snapshot?.taken_on ?? '', s.snapshot?.month ?? ''])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orderedSeals, search],
  )

  const newestFirst = useMemo(() => store.events.slice().reverse(), [store])
  const visibleEvents = useMemo(
    () => newestFirst.filter(e =>
      matchesAny(search, [e.ref, e.target, e.actor, e.note, EVENT_META[e.kind].label, e.date])),
    [newestFirst, search],
  )

  // Which dates in the current view are inside a standing seal — the mini-calendar marks them.
  const monthRows = useMemo(() => (seal ? monthSealability(seal.year) : []), [seal])

  function openSeal() {
    const today = todayISO()
    const year = fyStartOf(today) ?? Number(today.slice(0, 4))
    setSeal({ year, kind: 'month', month: '', note: '' })
    setSealError('')
  }

  /** The close reading's one action: hand the period to the seal dialog, preset to the month it read. */
  function openSealFor(month: string) {
    const year = fyStartOf(`${month}-01`) ?? Number(month.slice(0, 4))
    setSeal({ year, kind: 'month', month, note: '' })
    setSealError('')
  }

  /**
   * The photograph this dialog would hand the seal, or `null` for none. Three conditions, all of them
   * the engine's own refusal made visible before the click: the reading has to be open, the seal has to
   * be a month, and the month the dialog holds has to be the month the reading read (Rule 54 — the
   * reading reaches the record only as a figure handed over, and the seal stays `sealPeriod`'s to build).
   */
  const photoInHand = useMemo(() => {
    if (!seal || tab !== 'close' || seal.kind !== 'month' || !closeReadingNow) return null
    if (closeReadingNow.window.month !== seal.month) return null
    return sealSnapshotOf(closeReadingNow)
  }, [seal, tab, closeReadingNow])

  function runSeal() {
    if (!seal || !orgId) return
    const photo = photoInHand ?? undefined
    const result = sealPeriod(orgId, {
      kind: seal.kind,
      month: seal.kind === 'month' ? seal.month : undefined,
      year: seal.kind === 'year' ? seal.year : undefined,
      note: seal.note,
      actor: orgName,
      snapshot: photo,
    })
    if (!result.ok) { setSealError(result.why); return }
    setStore(result.store)
    setSeal(null)
    setSealError('')
    if (tab !== 'close') setTab('seals')
    setNotice({ msg: `The period is sealed. A write dated inside it is now refused at ${sealedDoors()}, and each refusal lands on the trail.${
      photo ? ` The window’s figures were kept as they stood on ${photo.taken_on}; the close tab will print them against today’s reading.` : ' No photograph of the window was kept with it — the close tab will print today’s reading of it.'}`, bad: false })
  }

  function runRelease() {
    if (!release || !orgId) return
    const result = releaseSeal(orgId, release.seal.id, release.reason, todayISO(), orgName)
    if (!result.ok) { setReleaseError(result.why); return }
    setStore(result.store)
    const label = release.seal.label
    setRelease(null)
    setReleaseError('')
    setNotice({ msg: `${label} is open again — the seal stays on the trail as a released seal, never deleted.`, bad: true })
  }

  function runNote() {
    if (!orgId || !noteText.trim()) return
    setStore(recordNote(orgId, noteText, orgName))
    setNoteText('')
    setNoteOpen(false)
    setTab('trail')
    setNotice({ msg: 'A line was added to the trail.', bad: false })
  }

  function exportSeals() {
    download(`taxflow-period-seals-${todayISO()}.csv`, toCsv(SEAL_CSV_HEADERS, sealCsvRows(store)))
  }
  function exportTrail() {
    download(`taxflow-audit-trail-${todayISO()}.csv`, toCsv(TRAIL_CSV_HEADERS, trailCsvRows(store)))
  }
  function exportClose() {
    if (!closeReadingNow) return
    download(`taxflow-period-close-${closeMonth}.csv`, toCsv(CLOSE_CSV_HEADERS, closeCsvRows(closeReadingNow)))
  }

  if (loading) {
    return <div className="au-wrap"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the register…</p></div>
  }

  const guardToday = orgId ? sealGuard(orgId, todayISO()) : { sealed: false, label: '', why: '' }
  const canSealSave = !!seal && (seal.kind === 'year' || !!seal.month)

  return (
    <div className="au-wrap">
      <PageHeader
        eyebrow="Evidence & locks"
        title="Audit trail and period seals"
        subtitle="Who closed what, whether a filed period can still be typed over, and — on the close tab — what one month still holds. The seals and the trail keep decisions; a month sealed from the close tab also keeps the figures that reading printed, as a photograph. The close reads the documents' money and moves none of it."
        actions={
          <>
            <Button variant="ghost" icon="edit" onClick={() => setNoteOpen(true)}>Add a note</Button>
            <Button icon="lock" onClick={openSeal}>Seal a period</Button>
          </>
        }
      />

      {notice && (
        <div className={`au-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
          <Icon name={notice.bad ? 'unlock' : 'check'} size={14} strokeWidth={notice.bad ? 2.2 : 2.4} />
          <span>{notice.msg}</span>
          <button type="button" className="au-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {/* ── The four numbers, and the verdict on the trail ────────────────────── */}
      {/* These four cards count seals and events, never rupees, so each value goes to `StatCard` as a
          string — bypassing its default `formatCompactINR` (Rule 52: a count prints as a count). */}
      <div className="au-stats">
        <StatCard label="Standing seals" value={String(stats.active)} icon="lock" tone="green"
          sub={stats.active ? 'closed to edits' : 'nothing locked'} delay={0} />
        <StatCard label="Released" value={String(stats.released)} icon="unlock" tone="amber"
          sub="lifted, still on record" delay={60} />
        <StatCard label="Trail events" value={String(stats.events)} icon="clock" tone="blue"
          sub="seals, releases, refusals, notes" delay={120} />
        <StatCard label="Writes refused" value={String(stats.refused)} icon="shield" tone="red"
          sub="attempts to edit a closed period" delay={180} />
      </div>

      <Card pad={false} className="au-integrity">
        <div className="au-integrity-body">
          <span className={`au-seal-dot ${chain.count === 0 ? 'is-nil' : chain.ok ? 'is-ok' : 'is-bad'}`}>
            <Icon name={chain.count === 0 ? 'clock' : chain.ok ? 'check' : 'alert'} size={18} strokeWidth={2.4} />
          </span>
          <div className="au-integrity-text">
            <div className="au-integrity-head">
              {chain.count === 0
                ? <>The trail is <strong>empty</strong> — nothing has been sealed, released, refused or noted on this device. An empty trail is not a broken one, but it is no proof either: there is nothing here yet to vouch for.</>
                : chain.ok
                  ? <>The trail is <strong>unbroken</strong> — {plural(chain.count, 'event')} numbered 1 to {chain.count} with no gap, duplicate or reorder.</>
                  : <>The trail <strong>shows a break</strong> at sequence {chain.broken.join(', ')} — a row was added, removed or re-sorted by hand.</>}
            </div>
            <p>
              This is a checksum over the <span className="au-mono">seq</span> numbers, not a signature. It proves the file was
              edited by something other than the register; it cannot name who. {orgId && `Last written ${formatDateIN(store.updatedAt)}.`}
            </p>
          </div>
          <div className="au-integrity-side">
            {guardToday.sealed
              ? <Badge tone="red" dot={false}>Today is inside {guardToday.label}</Badge>
              : <Badge tone="grey" dot={false}>Today is open</Badge>}
          </div>
        </div>
      </Card>

      {/* ── Which doors the seal actually closes ──────────────────────────────── */}
      <div className="au-bounds">
        <div className="au-bounds-col">
          <SectionTitle icon="lock">What a seal stops</SectionTitle>
          <ul className="au-doors">
            {GUARDED.map(d => (
              <li key={`${d.href}#${d.label}`} className={d.by ? 'is-live' : 'is-dormant'}>
                <span className={`au-door-dot ${d.by ? 'is-live' : 'is-dormant'}`} />
                <Link href={d.href} className="au-door-link">{d.label}</Link>
                <span className="au-door-tag">{d.by ?? 'not wired'}</span>
              </li>
            ))}
          </ul>
          <p className="au-bounds-note">
            {doorsAsking} of {GUARDED.length} paths consult the seal before they save, and the list says where each one does it:{' '}
            <strong>{doorsWriter}</strong> are closed inside the shared writers, so any page that saves an invoice, a bill or a note
            through them inherits the door; <strong>{doorsEngine}</strong> is closed inside its own register library; <strong>{doorsPage}</strong>{' '}
            type straight into their own table and carry it themselves.
            When a path is stopped, the attempt is written here as a <strong>Write refused</strong> event, so the edit that never
            happened is still on the record — and the paths still open are named above rather than left out of the list.
          </p>
          <p className="au-bounds-note">
            A seal is also <em>read</em>, not only refused. The <Link href="/gst/filings" className="au-door-link">filings register</Link> prints a
            sealed period as closed paper and offers to close an ended one from its own row, but it guards no door here: a transcript of a
            return moves no rupee on the statements, so it is shown the seal rather than stopped by it. Its status changes still land on this trail.
          </p>
        </div>
        <div className="au-bounds-col">
          <SectionTitle icon="alert">What this register is not</SectionTitle>
          <div className="au-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>The seals and the trail move no money — a seal is a window, an event is a sentence. A month sealed from the close tab may carry a photograph of its figures; it repeats what that reading printed, and the statements read none of it.</span></div>
          <div className="au-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>Nothing here files anything. The seals are your shop’s decision, not the portal’s.</span></div>
          <div className="au-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>The close tab prints figures, but it closes nothing: it reads the period so the seal dialog can be decided, and never instead of it.</span></div>
          <div className="au-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>A photograph is taken once, on the day the seal falls. It is not refreshed when the books move — the point of it is that it stopped moving.</span></div>
          <div className="au-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>It lives in this browser (ADR-013). It travels only inside the books vault, never on its own.</span></div>
          <div className="au-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>Releasing a seal keeps it — a silent unlock is exactly what an auditor looks for, so a reason is required.</span></div>
        </div>
      </div>

      {/* ── Toolbar ───────────────────────────────────────────────────────────── */}
      <div className="au-toolbar">
        <Segmented options={TABS} value={tab} onChange={v => setTab(v as Tab)} />
        <SearchInput value={search} onChange={setSearch} ariaLabel="Search seals, the trail and the close"
          placeholder={tab === 'seals' ? 'Search periods…' : tab === 'close' ? 'Search the returns and events…' : 'Search the trail…'}
          style={{ width: 240 }} />
        <span className="au-export">
          <Button variant="ghost" size="sm" icon="download"
            onClick={tab === 'seals' ? exportSeals : tab === 'trail' ? exportTrail : exportClose}
            disabled={tab === 'seals' ? store.seals.length === 0 : tab === 'trail' ? store.events.length === 0 : !closeReadingNow}>
            Export {tab === 'seals' ? 'seals' : tab === 'trail' ? 'trail' : 'this close'}
          </Button>
        </span>
      </div>

      {/* ── Seals ─────────────────────────────────────────────────────────────── */}
      {tab === 'seals' && (
        visibleSeals.length === 0
          ? (
            <EmptyState icon="lock"
              title={store.seals.length === 0 ? 'No period is sealed' : 'Nothing matches'}
              message={store.seals.length === 0
                ? 'A seal closes a GST period that has fully ended. Until one stands, every past month can still be typed over.'
                : 'No seal matches this search.'}
              action={store.seals.length === 0
                ? <Button icon="lock" onClick={openSeal}>Seal a period</Button>
                : <Button variant="ghost" onClick={() => setSearch('')}>Clear search</Button>} />
          ) : (
            <div className="au-grid">
              {visibleSeals.map(s => <SealCard key={s.id} seal={s}
                onRelease={() => { setRelease({ seal: s, reason: '' }); setReleaseError('') }} />)}
            </div>
          )
      )}

      {/* ── Trail ─────────────────────────────────────────────────────────────── */}
      {tab === 'trail' && (
        visibleEvents.length === 0
          ? (
            <EmptyState icon="clock"
              title={store.events.length === 0 ? 'The trail is empty' : 'Nothing matches'}
              message={store.events.length === 0
                ? 'Every seal, release, refused write and note lands here, numbered in order. It fills as the register is used.'
                : 'No event matches this search.'}
              action={store.events.length === 0
                ? <Button variant="ghost" icon="edit" onClick={() => setNoteOpen(true)}>Add a note</Button>
                : <Button variant="ghost" onClick={() => setSearch('')}>Clear search</Button>} />
          ) : (
            <Card pad={false}>
              <div className="au-head au-event-row">
                <span>#</span><span>Event</span><span>When</span><span>About</span><span>By</span><span>Detail</span>
              </div>
              {visibleEvents.map(e => <EventRow key={e.id} e={e} />)}
            </Card>
          )
      )}

      {/* ── Period close ──────────────────────────────────────────────────────── */}
      {tab === 'close' && (
        <PeriodClose
          month={closeMonth}
          fy={closeFy}
          onMonth={m => {
            setCloseMonth(m)
            const fy = fyStartOf(`${m}-01`)
            if (fy !== null) setCloseFy(fy)
          }}
          reading={closeReadingNow}
          loading={closeLoading}
          search={search}
          onSeal={() => openSealFor(closeMonth)}
        />
      )}

      <div className="au-foot">
        <span>Seals and events are stored in this browser at <span className="au-mono">taxflow:audit:&lt;org&gt;</span>. Nothing here reaches a return.</span>
        <span className="au-foot-links">
          <Link href="/vault">Books vault →</Link>
          <Link href="/invoices/new">New invoice →</Link>
        </span>
      </div>

      {/* ── Seal a period ─────────────────────────────────────────────────────── */}
      {seal && (
        <div className="au-scrim" role="dialog" aria-modal="true" aria-label="Seal a period">
          <div className="au-modal">
            <div className="au-modal-head">
              <div>
                <h2>Seal a period</h2>
                <p>Close a GST period that has fully ended. A month still in progress, or one that overlaps a seal already standing, is refused.</p>
              </div>
              <button type="button" className="au-close" onClick={() => setSeal(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {sealError && <div className="au-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} /><span>{sealError}</span></div>}

            <Segmented options={[{ value: 'month', label: 'A month' }, { value: 'year', label: 'The financial year' }]}
              value={seal.kind} onChange={v => setSeal({ ...seal, kind: v as SealKind, month: '' })} />

            <div className="au-yearpick">
              <button type="button" className="au-ybtn" aria-label="Previous year"
                onClick={() => setSeal({ ...seal, year: seal.year - 1, month: '' })}><Icon name="chevron-left" size={16} /></button>
              <span className="au-year-label">
                {seal.kind === 'year' ? `FY ${fyLabel(seal.year)}` : `FY ${fyLabel(seal.year)} · months`}
              </span>
              <button type="button" className="au-ybtn" aria-label="Next year"
                onClick={() => setSeal({ ...seal, year: seal.year + 1, month: '' })}><Icon name="chevron-right" size={16} /></button>
            </div>

            {seal.kind === 'month' ? (
              <div className="au-months">
                {monthRows.map(m => {
                  const chosen = seal.month === m.month
                  return (
                    <button key={m.month} type="button"
                      className={`au-mchip ${chosen ? 'is-chosen' : ''} ${m.sealable ? '' : 'is-off'}`}
                      disabled={!m.sealable}
                      title={m.sealable ? 'Close this month' : 'Not finished yet — a period is sealed only once it has ended'}
                      onClick={() => setSeal({ ...seal, month: m.month })}>
                      {m.label.replace(/\s\d{4}$/, '')}
                      <span className="au-mchip-year">{m.month.slice(0, 4)}</span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="au-note-box">
                <Icon name="lock" size={14} />
                <span>Closes <strong>{fyWindow(seal.year)}</strong> as one period. The engine refuses it if the year has not ended or it crosses a seal already standing.</span>
              </div>
            )}

            <label className="au-field">
              <span>Note (optional)</span>
              <input className="tf-input" value={seal.note} onChange={e => setSeal({ ...seal, note: e.target.value })}
                placeholder="Filed GSTR-3B for the quarter, reconciled to the books…" autoFocus />
            </label>

            <div className="au-preview">
              <div className="au-preview-head">
                <span>What sealing writes</span>
                <span className="au-preview-total">
                  {seal.kind === 'year' ? `FY ${fyLabel(seal.year)}` : (seal.month ? monthLabel(seal.month) : 'no month yet')}
                </span>
              </div>
              <ul className="au-preview-list">
                <li>A standing seal on the period<span className="au-preview-take">a locked window</span></li>
                <li>A write dated inside it is refused at {sealedDoors()}<span className="au-preview-take">lock</span></li>
                <li>A line on the trail<span className="au-preview-take">+1 event</span></li>
                {photoInHand
                  ? <li>A photograph of the close reading — the figures this tab printed today, kept on the seal<span className="au-preview-take">as at {photoInHand.taken_on}</span></li>
                  : <li>No photograph: this dialog has read no window, so the seal keeps only the decision{seal.kind === 'year' ? ' — a year cannot carry a month’s figures' : ''}<span className="au-preview-take">none</span></li>}
              </ul>
            </div>

            <div className="au-save">
              <Button variant="ghost" onClick={() => setSeal(null)}>Cancel</Button>
              <Button icon="lock" onClick={runSeal} disabled={!canSealSave}>Seal it</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Release a seal ────────────────────────────────────────────────────── */}
      {release && (
        <div className="au-scrim" role="dialog" aria-modal="true" aria-label={`Release ${release.seal.label}`}>
          <div className="au-modal" style={{ maxWidth: 500 }}>
            <div className="au-modal-head">
              <div>
                <h2>Release {release.seal.label}</h2>
                <p>This reopens the period to edits. The seal is <em>not</em> deleted — it stays on the trail and on this page as a released seal, with your reason beside it.</p>
              </div>
              <button type="button" className="au-close" onClick={() => setRelease(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {releaseError && <div className="au-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} /><span>{releaseError}</span></div>}

            <div className="au-facts">
              <StatRow label="Window" value={`${formatDateIN(release.seal.from)} → ${formatDateIN(release.seal.to)}`} />
              <StatRow label="Sealed" value={`${release.seal.sealed_by || 'this device'}, ${formatDateIN((release.seal.sealed_at || '').slice(0, 10))}`} tone="green" />
            </div>

            <label className="au-field">
              <span>Why is the period being reopened? *</span>
              <textarea className="tf-input" rows={3} value={release.reason}
                onChange={e => setRelease({ ...release, reason: e.target.value })}
                placeholder="A credit note dated in the month surfaced after filing; the period must be corrected…"
                style={{ resize: 'vertical' }} autoFocus />
              <span className="au-hint">An empty reason is a silent unlock — the register refuses it.</span>
            </label>

            <div className="au-save">
              <Button variant="ghost" onClick={() => setRelease(null)}>Keep it sealed</Button>
              <Button variant="danger" icon="unlock" onClick={runRelease} disabled={!release.reason.trim()}>Release seal</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add a note ────────────────────────────────────────────────────────── */}
      {noteOpen && (
        <div className="au-scrim" role="dialog" aria-modal="true" aria-label="Add a note to the trail">
          <div className="au-modal" style={{ maxWidth: 480 }}>
            <div className="au-modal-head">
              <div>
                <h2>Add a line to the trail</h2>
                <p>A note changes no seal and writes no document. It is a decision recorded beside the numbers — filed a return, agreed a correction, closed a book.</p>
              </div>
              <button type="button" className="au-close" onClick={() => setNoteOpen(false)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>
            <label className="au-field">
              <span>Note</span>
              <textarea className="tf-input" rows={3} value={noteText} onChange={e => setNoteText(e.target.value)}
                placeholder="FY 2025-26 GSTR-9 filed 11 Oct, per CA sign-off…" style={{ resize: 'vertical' }} autoFocus />
            </label>
            <div className="au-save">
              <Button variant="ghost" onClick={() => setNoteOpen(false)}>Cancel</Button>
              <Button icon="edit" onClick={runNote} disabled={!noteText.trim()}>Add note</Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .au-wrap { display: flex; flex-direction: column; }
        .au-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }

        .au-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px;
          font-size: 12.5px; color: var(--green); background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 10px; }
        .au-notice svg { flex-shrink: 0; }
        .au-notice.is-bad { color: var(--amber); background: var(--amber-soft);
          border-color: color-mix(in srgb, var(--amber) 26%, white); }
        .au-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; border-radius: 6px; min-height: 0; }
        .au-notice-x:hover { background: rgba(0,0,0,0.05); }

        .au-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px; margin-bottom: 12px;
          padding: 10px 12px; background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .au-alert svg { flex-shrink: 0; }

        .au-integrity { margin-bottom: 1rem; }
        .au-integrity-body { display: flex; align-items: flex-start; gap: 13px; padding: 14px 16px; }
        .au-seal-dot { width: 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .au-seal-dot.is-ok { color: var(--green); background: var(--green-soft); }
        .au-seal-dot.is-bad { color: var(--red); background: var(--red-soft); }
        .au-seal-dot.is-nil { color: var(--muted); background: var(--surface-2); }
        .au-integrity-text { min-width: 0; flex: 1; }
        .au-integrity-head { font-size: 13.5px; color: var(--ink); line-height: 1.5; }
        .au-integrity-head strong { font-weight: 700; }
        .au-integrity-text p { font-size: 11.5px; color: var(--muted); line-height: 1.55; margin: 5px 0 0; }
        .au-integrity-side { flex-shrink: 0; align-self: center; }

        .au-bounds { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 1.15rem; }
        .au-bounds-col { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 15px 16px; }
        .au-doors { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .au-doors li { display: flex; align-items: center; gap: 9px; font-size: 12.5px; }
        .au-door-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .au-door-dot.is-live { background: var(--green); }
        .au-door-dot.is-dormant { background: var(--faint); }
        .au-door-link { color: var(--ink-2); font-weight: 600; text-decoration: none; }
        .au-door-link:hover { color: var(--brand); }
        .au-door-tag { margin-left: auto; font-size: 10.5px; color: var(--faint); }
        .au-doors li.is-live .au-door-tag { color: var(--green); }
        .au-bounds-note { font-size: 11.5px; color: var(--muted); line-height: 1.6; margin: 11px 0 0; }
        .au-bounds-note em { color: var(--green); font-style: normal; font-weight: 650; }
        .au-bounds-note strong { color: var(--ink-2); font-weight: 650; }
        .au-fact { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--muted); line-height: 1.55; padding: 6px 0; }
        .au-fact svg { flex-shrink: 0; margin-top: 2px; color: var(--faint); }

        .au-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
        .au-export { margin-left: auto; }

        .au-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
        .au-card { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--green);
          border-radius: var(--radius-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-xs); }
        .au-card.is-released { border-left-color: var(--amber); background: var(--surface-2); opacity: 0.92; }
        .au-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .au-card-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .au-card-title svg { color: var(--green); flex-shrink: 0; }
        .au-card.is-released .au-card-title svg { color: var(--amber); }
        .au-card-name { font-size: 14.5px; font-weight: 650; color: var(--ink); overflow-wrap: anywhere; }
        .au-card-sub { font-size: 11.5px; color: var(--faint); }
        .au-card-note { font-size: 12px; color: var(--ink-2); line-height: 1.55; background: var(--surface-2);
          border-radius: 9px; padding: 8px 10px; }
        .au-card.is-released .au-card-note { background: var(--surface); }
        .au-card-foot { display: flex; align-items: center; gap: 8px; margin-top: 2px; flex-wrap: wrap; }
        .au-reason { font-size: 11.5px; color: var(--amber); line-height: 1.5; margin-top: 6px;
          border-top: 1px dashed var(--line); padding-top: 8px; }
        .au-reason strong { color: var(--ink-2); }

        .au-event-row { display: grid; gap: 10px; align-items: center; padding: 9px 16px;
          grid-template-columns: 40px 140px 150px 130px 120px minmax(0, 1.6fr); }
        .au-event-row.is-row { font-size: 12.5px; border-top: 1px solid var(--line-soft); padding: 11px 16px; }
        .au-head { background: var(--surface-2); font-size: 11px; font-weight: 650; color: var(--faint);
          text-transform: uppercase; letter-spacing: 0.05em; }
        .au-seq { font-variant-numeric: tabular-nums; color: var(--faint); font-size: 12px; }
        .au-ev-what { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .au-ev-ref { font-size: 11px; color: var(--faint); overflow-wrap: anywhere; }
        .au-ev-when, .au-ev-by { font-size: 11.5px; color: var(--muted); }
        .au-ev-note { font-size: 12px; color: var(--ink-2); line-height: 1.5; overflow-wrap: anywhere; }

        .au-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          font-size: 11.5px; color: var(--faint); margin-top: 18px; }
        .au-foot-links { display: flex; gap: 12px; flex-wrap: wrap; }
        .au-mono { font-family: var(--mono); font-size: 0.94em; }

        .au-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .au-modal { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg);
          padding: 1.4rem 1.5rem; width: 100%; max-width: 560px; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .au-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .au-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .au-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; line-height: 1.55; }
        .au-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px;
          border-radius: 6px; flex-shrink: 0; min-height: 0; }
        .au-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .au-yearpick { display: flex; align-items: center; justify-content: center; gap: 14px; }
        .au-ybtn { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; color: var(--ink-2);
          cursor: pointer; padding: 6px; min-height: 0; display: flex; align-items: center; }
        .au-ybtn:hover { background: var(--slate-soft); }
        .au-year-label { font-size: 13px; font-weight: 650; color: var(--ink); }

        .au-months { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
        .au-mchip { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
          padding: 9px 11px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface);
          font-family: inherit; font-size: 12.5px; font-weight: 600; color: var(--ink-2); cursor: pointer; text-align: left; }
        .au-mchip:hover:not(:disabled) { border-color: var(--brand); }
        .au-mchip.is-chosen { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); }
        .au-mchip.is-off, .au-mchip:disabled { opacity: 0.45; cursor: not-allowed; }
        .au-mchip-year { font-size: 10px; font-weight: 500; color: var(--faint); }

        .au-seal-dot.is-warn { color: var(--amber); background: var(--amber-soft); }

        .au-close-pick { display: grid; gap: 10px; justify-items: center; margin-bottom: 14px; }
        .au-close-pick > .au-months { width: 100%; }
        .au-find-list { display: grid; gap: 9px; margin-top: 10px; }
        .au-find { background: var(--surface-2); border: 1px solid var(--line); border-radius: 11px;
          padding: 10px 12px; display: flex; flex-direction: column; gap: 5px; }
        .au-find-head { display: flex; align-items: baseline; gap: 7px; font-size: 12.5px; font-weight: 650; color: var(--ink); }
        .au-find-head svg { color: var(--amber); flex-shrink: 0; align-self: center; }
        .au-find-take { margin-left: auto; font-size: 11.5px; font-weight: 650; color: var(--ink-2); font-variant-numeric: tabular-nums; }
        .au-find-why { font-size: 11.5px; color: var(--muted); line-height: 1.6; }
        .au-find-link { font-size: 11.5px; color: var(--brand); font-weight: 600; text-decoration: none; }
        .au-find-link:hover { text-decoration: underline; }

        .au-note-box { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--muted);
          background: var(--surface-2); border-radius: 10px; padding: 10px 12px; line-height: 1.55; }
        .au-note-box svg { flex-shrink: 0; margin-top: 2px; color: var(--brand); }
        .au-note-box strong { color: var(--ink-2); }

        .au-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .au-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .au-hint { font-size: 11px; color: var(--faint); }
        .au-facts { display: flex; flex-direction: column; }

        .au-preview { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--surface-2); }
        .au-preview-head { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .au-preview-total { color: var(--brand); font-variant-numeric: tabular-nums; text-transform: none; letter-spacing: 0; }
        .au-preview-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .au-preview-list li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--ink-2); line-height: 1.5; flex-wrap: wrap; }
        .au-preview-take { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 650; color: var(--ink); }
        .au-save { display: flex; gap: 10px; justify-content: flex-end; }

        /* A seal's photograph, and the pair it makes against today's reading. */
        .au-photo { display: flex; align-items: flex-start; gap: 8px; font-size: 11.5px; color: var(--muted);
          line-height: 1.55; background: var(--surface-2); border-radius: 9px; padding: 8px 10px; }
        .au-photo svg { flex-shrink: 0; margin-top: 2px; color: var(--brand); }
        .au-photo.is-bad svg { color: var(--red); }
        .au-photo.is-none svg { color: var(--faint); }
        .au-photo.is-none { color: var(--faint); }
        .au-photo strong { color: var(--ink-2); }

        .au-drift-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
          padding: 13px 16px; flex-wrap: wrap; }
        .au-drift-title { display: flex; align-items: flex-start; gap: 9px; min-width: 0; }
        .au-drift-title svg { color: var(--brand); flex-shrink: 0; margin-top: 1px; }
        .au-drift-name { font-size: 14px; font-weight: 650; color: var(--ink); }
        .au-drift-tally { font-size: 12px; font-weight: 600; color: var(--ink-2); }
        .au-drift-row { display: grid; gap: 10px; align-items: center; padding: 9px 16px;
          grid-template-columns: minmax(0, 1.8fr) minmax(90px, 1fr) minmax(90px, 1fr) minmax(90px, 1fr);
          border-top: 1px solid var(--line-soft); font-size: 12.5px; color: var(--ink-2); }
        .au-drift-row.is-head { font-size: 11px; font-weight: 650; color: var(--faint); background: var(--surface-2); }
        .au-drift-what { overflow-wrap: anywhere; }
        .au-drift-num { font-variant-numeric: tabular-nums; text-align: right; }
        .au-drift-delta.is-up { color: var(--green); font-weight: 650; }
        .au-drift-delta.is-down { color: var(--red); font-weight: 650; }
        .au-drift-delta.is-same { color: var(--faint); }
        .au-drift-find { padding: 11px 16px 4px; border-top: 1px solid var(--line-soft); }
        .au-drift-find-head { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
          color: var(--faint); margin-bottom: 6px; }
        .au-drift-find-row { display: grid; gap: 10px; align-items: baseline; font-size: 12px; color: var(--muted);
          grid-template-columns: minmax(0, 1.8fr) minmax(90px, 1fr) minmax(90px, 1fr); padding: 4px 0; }
        .au-drift-withheld { display: flex; align-items: flex-start; gap: 8px; padding: 10px 16px; font-size: 11.5px;
          color: var(--muted); line-height: 1.6; border-top: 1px dashed var(--line); background: var(--surface-2); }
        .au-drift-withheld svg { flex-shrink: 0; margin-top: 2px; color: var(--amber); }

        @media (max-width: 1100px) { .au-stats { grid-template-columns: 1fr 1fr; } .au-bounds { grid-template-columns: 1fr; } }
        @media (max-width: 768px) {
          .au-grid { grid-template-columns: 1fr; }
          .au-months { grid-template-columns: 1fr 1fr; }
          .au-event-row { grid-template-columns: 1fr; gap: 6px; }
          .au-drift-row { grid-template-columns: 1fr 1fr; gap: 4px 10px; }
          .au-drift-row > .au-drift-what { grid-column: 1 / -1; }
          .au-drift-row.is-head { display: none; }
          .au-drift-find-row { grid-template-columns: 1fr 1fr; }
          .au-drift-find-row > span:first-child { grid-column: 1 / -1; }
          .au-head { display: none; }
          .au-export { margin-left: 0; }
          .au-scrim { align-items: flex-end; padding: 0; }
          .au-scrim .au-modal { max-width: none !important; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .au-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}

/** The state's dot, in the three colours this page already owns plus the amber the seals use. */
function dotClass(tone: 'blue' | 'green' | 'red' | 'amber' | 'grey'): string {
  return tone === 'green' ? 'is-ok' : tone === 'red' ? 'is-bad' : tone === 'amber' ? 'is-warn' : 'is-nil'
}

const STATE_GLYPH: Record<string, string> = {
  'not-loaded': 'clock', 'in-progress': 'calendar', 'nothing-here': 'list', unfinished: 'alert', ready: 'check',
}

/**
 * The period close — the third tab, and the only one of the three that prints rupees.
 *
 * Every figure on it came from `closeReading`, which folds the documents the page fetched, the
 * journal, the order registers, the filings register and the trail for one month. The tab is placed
 * here rather than on `/accounting` because the question it answers belongs to the seal: *is this
 * period finished enough to close*. It changes nothing — the one button on it hands the month to the
 * seal dialog, and that dialog keeps its own date check, its own note and its own refusal.
 */
function PeriodClose({ month, fy, onMonth, reading, loading, search, onSeal }: {
  month: string
  fy: number
  onMonth: (m: string) => void
  reading: CloseReading | null
  loading: boolean
  search: string
  onSeal: () => void
}) {
  const months = useMemo(() => closeMonthOptions(fy), [fy])

  if (!reading) {
    return (
      <Card pad={false}>
        <div className="au-note-box" style={{ border: 0, background: 'transparent' }}>
          <Icon name={loading ? 'clock' : 'alert'} size={14} />
          <span>{loading
            ? `Reading ${monthLabel(month)} — the documents, the journal, the order registers and the filings register for that window.`
            : `${month} is not a month this register can read. Pick one of the twelve above.`}</span>
        </div>
      </Card>
    )
  }

  const state = CLOSE_STATE_META[reading.state]
  const sealView = SEAL_VIEW_META[reading.seal.view]
  const visibleReturns = reading.returns.filter(t =>
    matchesAny(search, [t.form, t.label, t.status, t.due, t.filedOn, String(t.statedTax)]))
  const visibleEvents = [...reading.trail.about, ...reading.trail.acts].filter(e =>
    matchesAny(search, [EVENT_META[e.kind].label, e.ref, e.target, e.actor, e.note, e.date]))
  const canSeal = reading.window.ended && reading.seal.view === 'open'

  return (
    <>
      {/* The subject is named before its totals: a reading always says which window it read. */}
      <div className="au-close-pick">
        <div className="au-yearpick">
          <button type="button" className="au-ybtn" aria-label="Previous financial year"
            onClick={() => { const m = closeMonthOptions(fy - 1)[0]; if (m) onMonth(m.month) }}>
            <Icon name="chevron-left" size={16} />
          </button>
          <span className="au-year-label">FY {fyLabel(fy)} · months</span>
          <button type="button" className="au-ybtn" aria-label="Next financial year"
            onClick={() => { const m = closeMonthOptions(fy + 1)[0]; if (m) onMonth(m.month) }}>
            <Icon name="chevron-right" size={16} />
          </button>
        </div>
        <div className="au-months">
          {months.map(m => {
            const chosen = m.month === month
            return (
              <button key={m.month} type="button"
                className={`au-mchip ${chosen ? 'is-chosen' : ''}`}
                title={m.ended ? 'Read this close' : 'Still running — a close can be read, but only an ended period can be sealed'}
                aria-pressed={chosen}
                onClick={() => onMonth(m.month)}>
                {m.label.replace(/\s\d{4}$/, '')}
                <span className="au-mchip-year">{m.ended ? m.month.slice(0, 4) : `${m.month.slice(0, 4)} · open`}</span>
              </button>
            )
          })}
        </div>
      </div>

      <Card pad={false} className="au-integrity">
        <div className="au-integrity-body">
          <span className={`au-seal-dot ${dotClass(state.tone)}`}>
            <Icon name={STATE_GLYPH[reading.state] ?? 'clock'} size={18} strokeWidth={2.4} />
          </span>
          <div className="au-integrity-text">
            <div className="au-integrity-head"><strong>{reading.headline}</strong></div>
            <p>{reading.why}</p>
            <p>
              Read on <span className="au-mono">{reading.window.today}</span> across{' '}
              <span className="au-mono">{reading.window.from}</span> → <span className="au-mono">{reading.window.to}</span>{' '}
              — one month of this shop’s documents, journal, order registers, filings register and trail. It is not the company’s
              balance sheet, not a return, and not the figure a wider statement prints: the same derivations, a narrower window.
            </p>
          </div>
          <div className="au-integrity-side">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
              <Badge tone={state.tone} dot={false}>{state.label}</Badge>
              <Badge tone={sealView.tone} dot={false}>{sealView.label}</Badge>
              {canSeal && <Button size="sm" icon="lock" onClick={onSeal}>Seal this period</Button>}
            </div>
          </div>
        </div>
      </Card>

      {reading.money.loaded ? (
        <div className="au-stats">
          <StatCard label="Revenue billed" value={reading.money.revenue} icon="trend" tone="blue"
            sub={`${plural(reading.counts.invoices, 'invoice')}${reading.counts.cancelledInvoices ? ` · ${reading.counts.cancelledInvoices} cancelled` : ''}`} delay={0} />
          <StatCard label="Purchases" value={reading.money.purchases} icon="bag" tone="amber"
            sub={`${plural(reading.counts.bills, 'bill')} dated here`} delay={60} />
          <StatCard label="Expenses" value={reading.money.expenses} icon="wallet" tone="red"
            sub={`${plural(reading.counts.expenses, 'expense')} dated here`} delay={120} />
          <StatCard label="Net for the window" value={reading.money.netProfit}
            icon={reading.money.netProfit >= 0 ? 'check' : 'arrow-down'} tone={reading.money.netProfit >= 0 ? 'green' : 'red'}
            sub={`Journal: ${plural(reading.money.journalEntries, 'posting')}, ${plural(reading.money.journalTouched, 'line')} moved`}
            delay={180} />
        </div>
      ) : (
        <div className="au-note-box">
          <Icon name="clock" size={14} />
          <span><strong>No money is printed.</strong> The page has no document rows for this window yet — an empty fetch, not an
            empty month. The seal’s answer above is still real; the figures are simply not read.</span>
        </div>
      )}

      <SealDrift reading={reading} search={search} />

      <div className="au-bounds">
        <div className="au-bounds-col">
          <SectionTitle icon="alert">What is still moving in it</SectionTitle>
          {reading.findings.length === 0
            ? <div className="au-note-box"><Icon name="check" size={14} /><span>
              {reading.state === 'in-progress'
                ? 'Nothing dated here is left draft, unbilled or unfiled — while the month is still running, that is a snapshot, not a close.'
                : 'Nothing dated here is left draft, unbilled or unfiled. The period’s own paper is finished; the seal’s decision is the only thing left.'}
            </span></div>
            : (
              <div className="au-find-list">
                {reading.findings.map(f => (
                  <div key={f.key} className="au-find">
                    <div className="au-find-head">
                      <Icon name="pause" size={13} />
                      <span>{f.label}</span>
                      {f.amount > 0 && <span className="au-find-take">₹{formatINR(f.amount)}</span>}
                    </div>
                    <div className="au-find-why">{f.detail}</div>
                    <Link href={f.href} className="au-find-link">Open the register →</Link>
                  </div>
                ))}
              </div>
            )}
          <p className="au-bounds-note">
            Money that moved and money waiting: <strong>₹{formatINR(reading.money.received)}</strong> received and{' '}
            <strong>₹{formatINR(reading.money.paid)}</strong> paid with a date inside the window, and{' '}
            <strong>₹{formatINR(reading.money.outstanding)}</strong> still outstanding on the invoices this window raised. The journal
            contributed {plural(reading.money.journalEntries, 'entry')} and{' '}
            {plural(reading.money.journalLegs, 'leg')} to the figures above, through the same fold the
            statements read. A payment dated after the window settles what the window raised without touching it, so the outstanding
            line is the books reading themselves today, not the last day of the period.
          </p>
        </div>
        <div className="au-bounds-col">
          <SectionTitle icon="x">What this reading is not</SectionTitle>
          {reading.boundaries.map(b => (
            <div key={b} className="au-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>{b}</span></div>
          ))}
        </div>
      </div>

      {reading.returns.length > 0 && (
        <Card pad={false} style={{ marginBottom: '1rem' }}>
          <div className="au-head au-event-row">
            <span>Form</span><span>Period</span><span>Status</span><span>Due</span><span>Filed</span><span>Tax as transcribed</span>
          </div>
          {visibleReturns.map(t => (
            <div key={`${t.form}#${t.period}`} className="au-event-row is-row">
              <span className="au-ev-what"><Link href={`/gst/filings?q=${encodeURIComponent(t.period)}`} className="au-door-link">{t.form.toUpperCase()}</Link></span>
              <span className="au-ev-what"><span className="au-ev-ref">{t.label}</span><span className="au-ev-ref">covers the {t.touches}</span></span>
              <span><Badge tone={t.status === 'not_filed' ? 'amber' : t.status === 'nil' ? 'grey' : 'green'} dot={false}>{t.status.replace('_', ' ')}</Badge></span>
              <span className="au-ev-when">{t.due ? formatDateIN(t.due) : '—'}</span>
              <span className="au-ev-by">{t.filedOn ? formatDateIN(t.filedOn) : '—'}</span>
              <span className="au-ev-note">₹{formatINR(t.statedTax)}</span>
            </div>
          ))}
          {visibleReturns.length === 0 && (
            <div className="au-event-row is-row"><span className="au-ev-note" style={{ gridColumn: '1 / -1' }}>No return covering this period matches the search.</span></div>
          )}
        </Card>
      )}

      {reading.trail.about.length + reading.trail.acts.length > 0 && (
        <Card pad={false}>
          <div className="au-head au-event-row">
            <span>#</span><span>Event</span><span>When</span><span>About</span><span>By</span><span>Detail</span>
          </div>
          {visibleEvents.map(e => <EventRow key={e.id} e={e} />)}
          {visibleEvents.length === 0 && (
            <div className="au-event-row is-row"><span className="au-ev-note" style={{ gridColumn: '1 / -1' }}>Nothing on the trail about this period matches the search.</span></div>
          )}
        </Card>
      )}
    </>
  )
}

/**
 * The seal's photograph set beside today's reading of the same window. This is the whole reason a
 * picture is kept: a live fold says what the books say *now*, and only a photograph can say whether
 * they said it on the day the period fell. Everything here is a pair — never one side dressed up as
 * the other, and never an absent side drawn as a zero (Rules 27/56). A comparison the engine refuses
 * to make is printed as its own withheld sentence, not left as a blank row.
 */
function SealDrift({ reading, search }: { reading: CloseReading; search: string }) {
  const seal = reading.seal.seal
  if (!seal) return null

  const drift = closeDrift(reading)
  if (!drift) {
    return (
      <div className="au-note-box" style={{ marginBottom: '1rem' }}>
        <Icon name={seal.snapshot_unreadable ? 'alert' : 'clock'} size={14} />
        <span>{seal.snapshot_unreadable
          ? <><strong>The seal carries a photograph this register cannot read.</strong> Nothing below compares the two: the picture stays on the record, its figures are not shown, and an unreadable photograph prints as unreadable rather than as a seal that never had one.</>
          : <>No photograph stands on this seal — it fell before photographs were kept, or it was put on from the <strong>Period seals</strong> tab, where no reading was open. What is printed above is <strong>today’s reading</strong> of {reading.window.label}; nothing here can say what that window held on the day it closed.</>}</span>
      </div>
    )
  }

  const fmt = (l: { kind: 'money' | 'paper' }, v: number) => (l.kind === 'money' ? `₹${formatINR(v)}` : String(v))
  const lines = drift.lines.filter(l => matchesAny(search, [l.label]))
  const changed = drift.lines.filter(l => l.delta !== 0)
  const movedFindings = drift.findings.filter(f => f.sealed !== f.now)

  return (
    <Card pad={false} style={{ marginBottom: '1rem' }}>
      <div className="au-drift-head">
        <div className="au-drift-title">
          <Icon name="compare" size={15} />
          <div>
            <div className="au-drift-name">As sealed, against as read today</div>
            <div className="au-card-sub">
              Photograph taken <span className="au-mono">{drift.snapshot.taken_on}</span> · the reading said{' '}
              <em>{drift.snapshot.headline}</em>
            </div>
          </div>
        </div>
        <div className="au-drift-tally">
          {changed.length === 0
            ? 'Nothing has moved since the seal fell.'
            : `${plural(changed.length, 'figure')} ${changed.length === 1 ? 'has' : 'have'} moved.`}
        </div>
      </div>

      <div className="au-drift-row is-head">
        <span>Figure</span><span className="au-drift-num">As sealed</span><span className="au-drift-num">Read today</span><span className="au-drift-num">Moved</span>
      </div>

      {lines.map(l => (
        <div key={l.key} className="au-drift-row">
          <span className="au-drift-what">{l.label}</span>
          <span className="au-drift-num">{fmt(l, l.sealed)}</span>
          <span className="au-drift-num">{fmt(l, l.now)}</span>
          <span className={`au-drift-num au-drift-delta ${l.delta === 0 ? 'is-same' : l.delta > 0 ? 'is-up' : 'is-down'}`}>
            {l.delta === 0 ? '—' : `${l.delta > 0 ? '+' : '−'}${l.kind === 'money' ? `₹${formatINR(Math.abs(l.delta))}` : Math.abs(l.delta)}`}
          </span>
        </div>
      ))}
      {lines.length === 0 && (
        <div className="au-drift-row"><span className="au-drift-what">No figure matches this search.</span></div>
      )}

      {movedFindings.length > 0 && (
        <div className="au-drift-find">
          <div className="au-drift-find-head">What was unfinished then, beside what is unfinished now</div>
          {movedFindings.map(f => (
            <div key={f.key} className="au-drift-find-row">
              <span>{f.label}</span>
              <span className="au-drift-num">{f.sealed === 0 ? 'not open then' : plural(f.sealed, 'item')}</span>
              <span className="au-drift-num">{f.now === 0 ? 'now closed' : plural(f.now, 'item')}</span>
            </div>
          ))}
        </div>
      )}

      {drift.withheld.map(w => (
        <div key={w} className="au-drift-withheld"><Icon name="alert" size={13} /><span>{w}</span></div>
      ))}
    </Card>
  )
}

function matchesView(s: PeriodSeal, tab: Tab): boolean {  // The seals tab shows every seal (standing first, released after); the trail tab has no seal rows.
  return tab === 'seals' ? true : s.released_at === null
}

function SealCard({ seal, onRelease }: { seal: PeriodSeal; onRelease: () => void }) {
  const released = seal.released_at !== null
  return (
    <div className={`au-card ${released ? 'is-released' : ''}`}>
      <div className="au-card-head">
        <div className="au-card-title">
          <Icon name={released ? 'unlock' : 'lock'} size={17} />
          <div>
            <div className="au-card-name">{seal.label}</div>
            <div className="au-card-sub">{seal.kind === 'year' ? 'Financial year' : 'Month'} · {formatDateIN(seal.from)} → {formatDateIN(seal.to)}</div>
          </div>
        </div>
        <Badge tone={released ? 'amber' : 'green'}>{released ? 'Released' : 'Sealed'}</Badge>
      </div>

      {seal.note && <div className="au-card-note">{seal.note}</div>}

      {/* Every photograph state named, including the absence: a seal that kept no picture must not read
          as a seal whose picture was lost. Rule 27 again — an unreadable thing prints as unreadable. */}
      {seal.snapshot ? (
        <div className="au-photo">
          <Icon name="clock" size={12} />
          <span>Photograph kept from the close reading on <span className="au-mono">{seal.snapshot.taken_on}</span>{' '}
            ({monthLabel(seal.snapshot.month)}): {seal.snapshot.money.loaded
              ? <>revenue ₹{formatINR(seal.snapshot.money.revenue)}, net ₹{formatINR(seal.snapshot.money.netProfit)},{' '}
                {plural(seal.snapshot.findings.length, 'finding')} still open</>
              : <>the documents were never fetched that day, so no rupee figure was photographed</>}{''}
            {seal.snapshot.unread.length > 0 ? ` · read without ${seal.snapshot.unread.join(', ')}` : ''}.</span>
        </div>
      ) : seal.snapshot_unreadable ? (
        <div className="au-photo is-bad">
          <Icon name="alert" size={12} />
          <span><strong>A photograph is on this seal but this register cannot read it.</strong> The figures are not
            shown; the seal itself stands, and the window is still locked.</span>
        </div>
      ) : (
        <div className="au-photo is-none">
          <Icon name="x" size={12} strokeWidth={2.2} />
          <span>No photograph kept — this seal carries the decision, not the window’s figures. On the close tab
            they are today’s reading of the period.</span>
        </div>
      )}

      <div className="au-card-foot">
        <span className="au-card-sub">
          {released ? 'Released' : 'Sealed'} {seal.sealed_by ? `by ${seal.sealed_by}, ` : ''}
          {formatDateIN(((released ? seal.released_at : seal.sealed_at) || '').slice(0, 10))}
        </span>
        {!released && <Button variant="ghost" size="sm" icon="unlock" onClick={onRelease} style={{ marginLeft: 'auto' }}>Release</Button>}
      </div>

      {released && seal.release_reason && (
        <div className="au-reason"><strong>Why reopened:</strong> {seal.release_reason}</div>
      )}
    </div>
  )
}

function EventRow({ e }: { e: AuditEvent }) {
  const meta = EVENT_META[e.kind]
  const icon = e.kind === 'sealed' ? 'lock' : e.kind === 'released' ? 'unlock' : e.kind === 'refused' ? 'shield' : 'edit'
  return (
    <div className="au-event-row is-row">
      <span className="au-seq">#{e.seq}</span>
      <span className="au-ev-what">
        <Badge tone={meta.tone}><Icon name={icon} size={11} /> {meta.label}</Badge>
      </span>
      <span className="au-ev-when">{stamp(e.at)}</span>
      <span className="au-ev-what">
        <span className="au-ev-ref">{e.date ? formatDateIN(e.date) : '—'}</span>
        <span className="au-ev-ref">{e.target || '—'}{e.ref ? ` · ${e.ref}` : ''}</span>
      </span>
      <span className="au-ev-by">{e.actor || 'this device'}</span>
      <span className="au-ev-note">{e.note}</span>
    </div>
  )
}

export default function AuditPage() {
  return (
    <Suspense fallback={<div className="au-wrap"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <AuditPageInner />
    </Suspense>
  )
}
