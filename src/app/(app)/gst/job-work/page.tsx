'use client'

// Job work — goods that leave to be worked on and must come back, and the ITC-04
// statement about them.
//
// The engine (src/lib/jobwork.ts) owns the model: the job-worker register, the rule 55
// movements out, the three things that can happen to goods away from home (come back, go
// straight to a customer, move on to a second worker), the section 143 clock each lot runs
// against, and the rule 45 deeming that catches whatever is still out past that day — plus
// whatever came back after it. This page is the register and the statement: what is where,
// what is due, what has already been deemed supplied, and the four ITC-04 grids as at a
// chosen period. Nothing is counted twice: the challan stays on /challans, a direct delivery
// is an invoice on /invoices, and money is only ever receipted on /payments.
//
// The figures this page prints are a workpaper. The tax shown against a deemed supply is
// labelled indicative wherever it appears, because whether tax falls on the value of the
// goods or on the job-work service is a call for the officer and the CA — not something a
// screen should present as a challan amount.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN } from '@/lib/format'
import { fmtQty } from '@/lib/reorder'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import { INDIAN_STATES } from '@/lib/constants'
import { loadStore, type FlowDoc } from '@/lib/orderflow'
import {
  APPROACHING_DAYS, CATEGORY_META, CATEGORY_ORDER, DISPOSITION_META, DISPOSITION_ORDER, ITC04_TURNOVER_LIMIT,
  JOB_MOVEMENT_CSV_HEADERS, JOB_REGISTER_CSV_HEADERS, ITC04_GRID_CSV_HEADERS, ITC04_HSN_CSV_HEADERS, STATUS_TONE,
  addDisposition, applyChallan, archiveWorker, deadlineOf, deleteDisposition, deleteLot, emptyJob,
  itc04Cadence, itc04GridCsvRows, itc04HsnCsvRows, itc04PeriodChoices, itc04Statement,
  jobMovementCsvRows, jobRegisterCsvRows, jobSummary, jobViews, loadJob, newDisposition, newLot, newWorker,
  outstandingOf, periodMonths, periodToReport, recordLot, setTurnoverCr, sortJobViews, todayISO,
  upsertWorker, validateDisposition, validateLot, validateWorker,
  type ChallanRef, type DispositionKind, type GoodsCategory, type Itc04DetailRow, type Itc04Period,
  type JobDisposition, type JobLot, type JobStore, type JobView, type JobWorker,
} from '@/lib/jobwork'
import {
  Badge, Button, Card, EmptyState, PageHeader, ProgressBar, SearchInput, Segmented, StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'

const UNITS = ['NOS', 'PCS', 'KGS', 'MTR', 'LTR', 'BOX', 'SET', 'DZN', 'PKG']

type ViewFilter = 'attention' | 'open' | 'closed' | 'tooling' | 'all'

const VIEWS: { value: ViewFilter; label: string }[] = [
  { value: 'attention', label: 'Needs attention' },
  { value: 'open', label: 'Still out' },
  { value: 'closed', label: 'Fully back' },
  { value: 'tooling', label: 'Tooling' },
  { value: 'all', label: 'All' },
]

function matchesView(v: JobView, view: ViewFilter): boolean {
  if (view === 'all') return true
  if (view === 'attention') return v.status === 'overdue' || v.status === 'approaching' || v.status === 'returned_late'
  if (view === 'open') return v.outstanding_qty > 0
  if (view === 'closed') return v.outstanding_qty === 0
  return v.lot.category === 'moulds_tools'
}

type GridKey = 'hsn' | 'sent' | 'received' | 'direct' | 'alternate'

const GRIDS: { value: GridKey; label: string }[] = [
  { value: 'hsn', label: 'HSN summary' },
  { value: 'sent', label: 'A · Sent out' },
  { value: 'received', label: 'B · Received back' },
  { value: 'direct', label: 'C · Delivered direct' },
  { value: 'alternate', label: 'D · On to a 2nd worker' },
]

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const money = (n: number) => `₹${inr.format(Math.round(Number(n) || 0))}`
const money2 = (n: number) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The clock in one line, phrased the way the statute would say it. */
function clockLine(v: JobView): { text: string; tone: 'red' | 'amber' | 'blue' | 'grey' } {
  if (v.deadline === null) return { text: 'No return period — reported, never recalled', tone: 'grey' }
  const d = v.days_to_deadline
  const back = formatDateIN(v.deadline)
  if (d === null) return { text: `Back by ${back}`, tone: 'blue' }
  if (d < 0) return { text: `${-d} day${-d === 1 ? '' : 's'} past the period — due back by ${back}`, tone: 'red' }
  if (d === 0) return { text: `Due back today (${back})`, tone: 'amber' }
  if (d <= APPROACHING_DAYS) return { text: `${d} day${d === 1 ? '' : 's'} left — due back ${back}`, tone: 'amber' }
  return { text: `${d} days left — due back ${back}`, tone: 'blue' }
}

/** The period the lot runs, phrased for a human — statutory label when no cap is applied. */
const lotPeriodText = (lot: JobLot): string => {
  const months = periodMonths(lot)
  return months === null ? CATEGORY_META[lot.category].statutory_label : `${months} months`
}

const periodText = (v: JobView): string => lotPeriodText(v.lot)

/** A movement row for the editors, from the string-y state the inputs keep. */
interface DispState {
  id: string
  created_at: string
  lotId: string
  kind: DispositionKind
  qty: string
  date: string
  party_name: string
  party_gstin: string
  ref: string
  note: string
}

function draftOf(s: DispState): JobDisposition {
  return {
    id: s.id,
    lot_id: s.lotId,
    kind: s.kind,
    date: s.date,
    qty: Number(s.qty) || 0,
    party_name: s.party_name,
    party_gstin: s.party_gstin,
    ref: s.ref,
    note: s.note,
    created_at: s.created_at,
  }
}

function JobWorkPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)

  const [job, setJob] = useState<JobStore>(emptyJob())
  const [challans, setChallans] = useState<FlowDoc[]>([])
  const [turnoverInput, setTurnoverInput] = useState('')

  const [search, setSearch] = useSearchDeepLink()
  const [view, setView] = useState<ViewFilter>('attention')
  const [grid, setGrid] = useState<GridKey>('hsn')
  const [periodKey, setPeriodKey] = useState('')
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)

  const [editor, setEditor] = useState<{ lot: JobLot; isNew: boolean } | null>(null)
  const [disp, setDisp] = useState<DispState | null>(null)
  const [workerEditor, setWorkerEditor] = useState<{ worker: JobWorker; isNew: boolean } | null>(null)

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

      const stored = loadJob(oid)
      setJob(stored)
      setTurnoverInput(stored.settings.turnover_cr ? String(stored.settings.turnover_cr) : '')

      // A job-work movement travels on a rule 55 challan; the register offers its own
      // job-work challans so the number and date come off the paper, not the typist.
      const docs = loadStore('challan', oid).docs
      setChallans(docs.filter(d => d.reason === 'job-work' && d.status !== 'cancelled'))

      // ?new=1 opens the movement editor, ?worker=1 the job-worker editor — the palette lands here.
      if (searchParams.get('new') === '1') setEditor({ lot: newLot(todayISO()), isNew: true })
      if (searchParams.get('worker') === '1') setWorkerEditor({ worker: newWorker(), isNew: true })
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const today = todayISO()
  const views = useMemo(() => jobViews(job, today), [job, today])
  const triaged = useMemo(() => sortJobViews(views), [views])
  const totals = useMemo(() => jobSummary(views, job.workers), [views, job.workers])

  const visible = useMemo(() => triaged.filter(v =>
    matchesView(v, view) &&
    matchesAny(search, [v.lot.item_name, v.worker_name, v.lot.challan_number, v.lot.hsn_sac, v.lot.notes])),
  [triaged, view, search])

  const turnover = job.settings.turnover_cr
  const cadence = useMemo(() => itc04Cadence(turnover), [turnover])
  const choices = useMemo(() => itc04PeriodChoices(today, turnover), [today, turnover])
  const report = useMemo(() => periodToReport(today, turnover), [today, turnover])
  const period: Itc04Period | null = useMemo(
    () => choices.find(c => c.key === periodKey) || report || choices[0] || null,
    [choices, periodKey, report],
  )
  const statement = useMemo(() => (period ? itc04Statement(views, period, today) : null), [views, period, today])

  const allLines = useMemo(
    () => views.flatMap(v => v.lines.map(l => ({ v, l })))
      .sort((a, b) => (a.l.disposition.date !== b.l.disposition.date
        ? (a.l.disposition.date < b.l.disposition.date ? 1 : -1)
        : (a.l.disposition.created_at < b.l.disposition.created_at ? 1 : -1))),
    [views],
  )

  const workerRows = useMemo(() => job.workers.map(w => {
    const mine = views.filter(v => v.lot.worker_id === w.id)
    return {
      worker: w,
      lots: mine.length,
      outstanding_qty: mine.reduce((s, v) => s + v.outstanding_qty, 0),
      outstanding_value: mine.reduce((s, v) => s + v.outstanding_value, 0),
      deemed_qty: mine.reduce((s, v) => s + v.deemed_qty, 0),
    }
  }).sort((a, b) => (b.outstanding_value - a.outstanding_value) || a.worker.name.localeCompare(b.worker.name)), [job.workers, views])

  const unnamedWorkers = views.filter(v => !v.worker && !v.lot.worker_id).length
  const maxSent = Math.max(1, ...views.map(v => v.sent_qty))

  function flash(message: string) { setNotice({ msg: message, bad: false }) }
  function warn(message: string) { setNotice({ msg: message, bad: true }) }

  // ── movement editor ────────────────────────────────────────────────────────
  function openLot(lot: JobLot, isNew: boolean) {
    setEditor({ lot, isNew })
  }

  function patchLot(patch: Partial<JobLot>) {
    setEditor(e => (e ? { ...e, lot: { ...e.lot, ...patch } } : e))
  }

  const editorProblems = editor ? validateLot(editor.lot, job) : []

  function saveLot() {
    if (!editor) return
    const result = recordLot(orgId, editor.lot)
    if (!result.ok) { warn(result.error); return }
    setJob(result.store)
    flash(editor.isNew
      ? `${result.store.lots.find(l => l.id === editor.lot.id)?.item_name || 'Movement'} recorded — the clock starts on ${editor.lot.sent_date}.`
      : `${editor.lot.item_name} updated — the register re-derived its figures.`)
    setEditor(null)
  }

  function removeLot(lot: JobLot) {
    const result = deleteLot(orgId, lot.id)
    if (!result.ok) { warn(result.error); return }
    setJob(result.store)
    flash(`${lot.item_name} taken off the register.`)
  }

  function pullChallan(challanId: string) {
    if (!editor) return
    const doc = challans.find(c => c.id === challanId)
    if (!doc) { patchLot({ challan_ref: '' }); return }
    const ref: ChallanRef = {
      id: doc.id, number: doc.number, doc_date: doc.doc_date, party_name: doc.party_name,
      party_gstin: doc.party_gstin, eway_bill_number: doc.eway_bill_number, vehicle_number: doc.vehicle_number,
    }
    patchLot(applyChallan(editor.lot, ref))
    // The challan names the worker on the paper; match it to the register when it can.
    const named = job.workers.find(w => !w.archived && w.name.toLowerCase() === doc.party_name.trim().toLowerCase())
    if (named) patchLot({ worker_id: named.id })
  }

  // ── movement-back editor ───────────────────────────────────────────────────
  function openDisp(v: JobView, kind: DispositionKind = 'returned') {
    const seed = newDisposition(v.lot.id, kind)
    setDisp({
      id: seed.id,
      created_at: seed.created_at,
      lotId: v.lot.id,
      kind,
      qty: String(v.outstanding_qty > 0 ? v.outstanding_qty : ''),
      date: todayISO(),
      party_name: '',
      party_gstin: '',
      ref: '',
      note: '',
    })
  }

  function patchDisp(patch: Partial<DispState>) {
    setDisp(d => (d ? { ...d, ...patch } : d))
  }

  const dispLot = disp ? job.lots.find(l => l.id === disp.lotId) || null : null
  const dispView = disp ? views.find(v => v.lot.id === disp.lotId) || null : null
  const dispDraft = disp ? draftOf(disp) : null
  const dispProblems = disp && dispLot && dispDraft ? validateDisposition(dispDraft, dispLot, job.dispositions) : []
  const dispOutstanding = disp && dispLot ? outstandingOf(dispLot, job.dispositions) : 0
  const dispValue = disp && dispLot && dispView
    ? Math.round(dispView.unit_value * (Number(disp.qty) || 0) * 100) / 100
    : 0
  const dispLate = Boolean(dispView?.deadline && disp && disp.date > dispView.deadline)

  function saveDisp() {
    if (!disp || !dispLot || !dispDraft) { warn('Pick the movement the goods came back against'); return }
    const result = addDisposition(orgId, dispDraft)
    if (!result.ok) { warn(result.error); return }
    setJob(result.store)
    flash(`${DISPOSITION_META[disp.kind].short} recorded — ${DISPOSITION_META[disp.kind].grid.split(' — ')[1]} now carries it.`)
    setDisp(null)
  }

  function removeDisposition(d: JobDisposition) {
    setJob(deleteDisposition(orgId, d.id))
    setDisp(null)
    flash('That movement of goods was removed — the register re-derived the outstanding figures.')
  }

  // ── job workers ────────────────────────────────────────────────────────────
  function openWorker(worker: JobWorker, isNew: boolean) { setWorkerEditor({ worker, isNew }) }
  function patchWorker(patch: Partial<JobWorker>) {
    setWorkerEditor(w => (w ? { ...w, worker: { ...w.worker, ...patch } } : w))
  }
  const workerProblems = workerEditor ? validateWorker(workerEditor.worker, job.workers) : []

  function saveWorker() {
    if (!workerEditor) return
    const name = workerEditor.worker.name.trim()
    const result = upsertWorker(orgId, workerEditor.worker)
    if (!result.ok) { warn(result.error); return }
    setJob(result.store)
    flash(workerEditor.isNew ? `${name} added to the job-worker register.` : `${name} updated.`)
    setWorkerEditor(null)
  }

  function closeWorker(w: JobWorker) {
    const result = archiveWorker(orgId, w.id)
    if (!result.ok) { warn(result.error); return }
    setJob(result.store)
    flash(`${w.name} archived — their movements still read as going to them.`)
  }

  // ── statement settings ─────────────────────────────────────────────────────
  function saveTurnover() {
    const next = setTurnoverCr(orgId, Number(turnoverInput) || 0)
    setJob(next)
    setPeriodKey('')
    flash(next.settings.turnover_cr
      ? `Turnover declared at ₹${next.settings.turnover_cr} crore — the statement is ${itc04Cadence(next.settings.turnover_cr).label.toLowerCase()}.`
      : 'Turnover cleared — the cadence is being assumed from the books again.')
  }

  function exportRegister() {
    download(`taxflow-job-work-${today}.csv`, toCsv(JOB_REGISTER_CSV_HEADERS, jobRegisterCsvRows(visible)))
  }

  function exportGrids() {
    if (!statement) return
    download(`itc04-${statement.period.label.replace(/[^a-z0-9]+/gi, '-')}-grids.csv`, toCsv(ITC04_GRID_CSV_HEADERS, itc04GridCsvRows(statement)))
  }

  function exportHsn() {
    if (!statement) return
    download(`itc04-${statement.period.label.replace(/[^a-z0-9]+/gi, '-')}-hsn.csv`, toCsv(ITC04_HSN_CSV_HEADERS, itc04HsnCsvRows(statement)))
  }

  function exportMovements() {
    download(`taxflow-job-movements-${today}.csv`, toCsv(JOB_MOVEMENT_CSV_HEADERS, jobMovementCsvRows(views)))
  }

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the job-work register…</div>
  }

  const noMovements = views.length === 0
  const detailRows: Itc04DetailRow[] = statement
    ? (grid === 'sent' ? statement.sent : grid === 'received' ? statement.received : grid === 'direct' ? statement.direct : statement.alternate)
    : []

  return (
    <div className="page-container jw" style={{ maxWidth: 1200 }}>
      <PageHeader
        eyebrow={`${orgName.toUpperCase() || 'GST'} · GOODS THAT MUST COME BACK`}
        title="Job work"
        subtitle="Every movement of goods out to a job worker, what has come back, what never did, and the ITC-04 statement drawn from them. The clock is section 143; running it out is rule 45."
        actions={
          <>
            <Button variant="ghost" size="sm" icon="download" onClick={exportRegister} disabled={visible.length === 0}>CSV</Button>
            <Button variant="ghost" size="sm" icon="users" onClick={() => openWorker(newWorker(), true)}>Job worker</Button>
            <Button icon="plus" onClick={() => openLot(newLot(todayISO()), true)}>Record movement</Button>
          </>
        }
      />

      <div className="jw-stats">
        <StatCard
          label="Movements out" value={String(totals.lots)}
          sub={`${totals.openLots} still out · ${totals.settledLots} closed · ${totals.workers} job worker${totals.workers === 1 ? '' : 's'}`}
          icon="factory" tone="blue" delay={0}
        />
        <StatCard
          label="Value still with job workers" value={money(totals.outstanding_value)}
          sub={totals.openLots ? `${fmtQty(totals.outstanding_qty, '')} units across ${totals.openLots} challan${totals.openLots === 1 ? '' : 's'}` : 'everything is accounted for'}
          icon="scale" tone="cyan" delay={40}
        />
        <StatCard
          label="Rule 45 exposure" value={money(totals.deemed_value)}
          sub={totals.deemed_qty
            ? `${fmtQty(totals.deemed_qty, '')} units deemed supplied · indicative tax ${money(totals.indicative_tax)}`
            : `${totals.overdue ? `${totals.overdue} past the period` : 'nothing past its period'}`}
          icon={totals.deemed_qty ? 'alert' : 'shield'} tone={totals.deemed_qty ? 'red' : 'green'} delay={80}
        />
        <StatCard
          label="ITC-04 statement" value={period ? period.label : 'No period closed'}
          sub={period
            ? `${cadence.label} · due ${formatDateIN(period.due)}${period.days_left !== null ? ` (${period.days_left >= 0 ? `${period.days_left} day${period.days_left === 1 ? '' : 's'} left` : `${-period.days_left} day${-period.days_left === 1 ? '' : 's'} past`})` : ''}`
            : 'declare the turnover to fix the cadence'}
          icon="calendar" tone={period && (period.days_left ?? 0) < 0 ? 'amber' : 'violet'} delay={120} href="/gst/calendar"
        />
      </div>

      <div className="jw-toolbar">
        <Segmented options={VIEWS} value={view} onChange={v => setView(v as ViewFilter)} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Item, worker, challan or HSN…"
          ariaLabel="Search job-work movements"
          style={{ flex: '1 1 240px', maxWidth: 320, marginLeft: 'auto' }}
        />
      </div>

      {notice && (
        <div className={`jw-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
          <Icon name={notice.bad ? 'alert' : 'check'} size={14} strokeWidth={notice.bad ? 2.2 : 2.4} />
          <span>{notice.msg}</span>
          <button type="button" className="jw-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {noMovements && (
        <div className="jw-note" style={{ marginBottom: 12 }}>
          <Icon name="alert" size={14} strokeWidth={2.2} />
          <span>
            Nothing has gone out for job work yet. A movement needs the rule 55 delivery challan that travelled with
            it — raise one on the <Link href="/challans">challan register</Link>, then record it here so the section 143
            clock starts running and ITC-04 has something to report.
          </span>
        </div>
      )}

      {!noMovements && totals.overdue > 0 && (
        <div className="jw-note is-hot" style={{ marginBottom: 12 }}>
          <Icon name="alert" size={14} strokeWidth={2.2} />
          <span>
            {totals.overdue} movement{totals.overdue === 1 ? '' : 's'} ran the period out — {fmtQty(totals.deemed_qty, '')} unit
            {totals.deemed_qty === 1 ? '' : 's'} worth {money(totals.deemed_value)} are deemed supplied on the day they went out, and a
            later return does not undo that. The <Link href="/gst/gstr1">GSTR-1 workpaper</Link> will not show them by itself.
          </span>
        </div>
      )}

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon="factory"
            title={views.length > 0 ? 'Nothing in this view' : 'No movements recorded'}
            message={views.length > 0
              ? 'Clear the search or pick another view to read the rest of the register.'
              : 'Record a movement when goods leave for job work. The register then tracks what comes back, what is late, and what the ITC-04 statement reports.'}
            action={views.length > 0
              ? undefined
              : <Button size="sm" icon="plus" onClick={() => openLot(newLot(todayISO()), true)}>Record movement</Button>}
          />
        </Card>
      ) : (
        <div className="jw-grid">
          {visible.map(v => {
            const lot = v.lot
            const clock = clockLine(v)
            const cat = CATEGORY_META[lot.category]
            const accounted = v.returned_qty + v.direct_qty + v.alternate_qty
            const firstProblem = v.problems[0]
            return (
              <div key={lot.id} className={`jw-card is-${v.status}`}>
                <div className="jw-card-head">
                  <div className="jw-card-title">
                    <span className="jw-card-name">
                      <Icon name="box" size={15} />
                      {lot.item_name}
                    </span>
                    <span className="jw-card-sub">
                      <Icon name="users" size={12} /> {v.worker_name}
                      {v.worker_gstin && <span className="jw-mono"> · {v.worker_gstin}</span>}
                    </span>
                    <span className="jw-card-sub">
                      {lot.challan_number ? `Challan ${lot.challan_number}` : 'No challan number'}
                      {lot.challan_date ? ` dated ${formatDateIN(lot.challan_date)}` : ''}
                      {' · sent '}{formatDateIN(lot.sent_date)}
                      {lot.hsn_sac ? ` · HSN ${lot.hsn_sac}` : ' · no HSN'}
                    </span>
                  </div>
                  <div className="jw-card-badges">
                    <Badge tone={STATUS_TONE[v.status]} dot={false}>{v.status_label}</Badge>
                    <Badge tone={lot.category === 'input' ? 'blue' : lot.category === 'capital_goods' ? 'violet' : 'grey'} dot={false}>
                      {cat.short}
                    </Badge>
                  </div>
                </div>

                <div className={`jw-clock is-${clock.tone}`}>
                  <Icon name="clock" size={14} strokeWidth={2.2} />
                  <span>{clock.text}</span>
                  <span className="jw-clock-period">{periodText(v)} out</span>
                </div>

                <div className="jw-card-stats">
                  <StatRow label={`Sent on ${formatDateIN(lot.sent_date)}`} value={`${fmtQty(v.sent_qty, lot.unit)} · ${money(v.sent_value)}`} />
                  <StatRow label="Received back" tone={v.returned_after_qty > 0 ? 'amber' : 'grey'}
                    value={v.returned_qty ? `${fmtQty(v.returned_qty, lot.unit)} · ${money(v.returned_value)}${v.returned_after_qty > 0 ? ` (${fmtQty(v.returned_after_qty, '')} late)` : ''}` : '—'} />
                  {(v.direct_qty > 0 || v.alternate_qty > 0) && (
                    <StatRow label="Direct delivery / on to a 2nd worker"
                      value={`${fmtQty(v.direct_qty, '')} / ${fmtQty(v.alternate_qty, '')}`} />
                  )}
                  <StatRow label="Outstanding" tone={v.outstanding_qty > 0 ? (v.status === 'overdue' ? 'red' : 'cyan') : 'green'} strong
                    value={v.outstanding_qty > 0 ? `${fmtQty(v.outstanding_qty, lot.unit)} · ${money(v.outstanding_value)}` : 'Nothing left out'} />
                  {v.deemed_qty > 0 && (
                    <StatRow label={`Deemed supplied on ${formatDateIN(v.deemed_on || lot.sent_date)}`} tone="red"
                      value={`${fmtQty(v.deemed_qty, lot.unit)} · ${money(v.deemed_value)}`} />
                  )}
                </div>

                <div className="jw-share">
                  <ProgressBar value={accounted} max={maxSent}
                    color={v.status === 'overdue' ? 'var(--red)' : v.status === 'settled' ? 'var(--green)' : 'var(--brand)'} />
                  <span className="jw-share-label">
                    {v.sent_qty ? `${Math.round((accounted / v.sent_qty) * 100)}% of what went out is accounted for` : 'nothing sent'}
                  </span>
                </div>

                {v.problems.length > 0 && (
                  <ul className="jw-problems">
                    {v.problems.map(p => <li key={p}><Icon name="alert" size={12} strokeWidth={2.2} />{p}</li>)}
                  </ul>
                )}

                {v.lines.length > 0 && (
                  <div className="jw-lines">
                    {v.lines.slice().reverse().map(l => (
                      <div key={l.disposition.id} className="jw-line">
                        <span className="jw-line-what">
                          <span className={`jw-dot jw-dot-${l.disposition.kind === 'returned' ? 'green' : l.disposition.kind === 'direct_delivery' ? 'blue' : 'violet'}`} />
                          <span className="jw-line-name">{DISPOSITION_META[l.disposition.kind].short}</span>
                          <span className="jw-line-sub">
                            {formatDateIN(l.disposition.date)}
                            {l.disposition.party_name ? ` · ${l.disposition.party_name}` : ''}
                            {l.disposition.ref ? ` · ${l.disposition.ref}` : ''}
                          </span>
                        </span>
                        <span className="jw-line-right">
                          <span className="jw-line-qty">{fmtQty(l.disposition.qty, lot.unit)}</span>
                          <span className="jw-line-sub">{money2(l.value)}{l.within === false ? ' · late' : ''}</span>
                        </span>
                        <button type="button" className="jw-line-x" title="Remove this movement"
                          onClick={() => removeDisposition(l.disposition)}>
                          <Icon name="x" size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="jw-card-foot">
                  <Button variant="ghost" size="sm" icon="undo" disabled={v.outstanding_qty === 0}
                    title={v.outstanding_qty === 0 ? 'Everything that went out has been accounted for' : 'Record goods coming back, going to a customer, or moving on'}
                    onClick={() => openDisp(v)}>Move goods</Button>
                  {firstProblem && (
                    <span className="jw-foot-hint" title={firstProblem}>
                      <Icon name="alert" size={12} strokeWidth={2.2} />
                      {firstProblem.length > 58 ? `${firstProblem.slice(0, 58)}…` : firstProblem}
                    </span>
                  )}
                  <span className="jw-card-actions">
                    <Button variant="ghost" size="sm" icon="edit" title={`Edit ${lot.item_name}`}
                      onClick={() => openLot({ ...lot }, false)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                    <Button variant="danger" size="sm" icon="x" title={`Delete ${lot.item_name}`}
                      onClick={() => removeLot(lot)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── ITC-04 ────────────────────────────────────────────────────────────── */}
      <div className="jw-section">
        <div className="jw-section-head">
          <h2>
            <Icon name="book" size={15} />
            ITC-04 statement
          </h2>
          <span className="jw-section-sub">
            Four grids — goods sent, goods received back, goods delivered from the job worker’s place, goods sent straight to
            another job worker — and the HSN-wise summary the statement is actually filed in. Prepared from the register above,
            never stored twice.
          </span>
        </div>

        <Card>
          <div className="jw-stmt-bar">
            <label className="jw-field jw-field-period">
              <span>Period covered</span>
              <select className="tf-input" value={period?.key || ''} onChange={e => setPeriodKey(e.target.value)}>
                {choices.map(c => (
                  <option key={c.key} value={c.key}>
                    {c.label} ({c.start} → {c.end}, due {c.due})
                  </option>
                ))}
                {choices.length === 0 && <option value="">No period available</option>}
              </select>
            </label>
            <div className="jw-turnover">
              <span>Aggregate turnover (₹ crore)</span>
              <div className="jw-turnover-row">
                <input className="tf-input" type="number" min="0" step="0.01" value={turnoverInput}
                  onChange={e => setTurnoverInput(e.target.value)} placeholder="e.g. 6.5" />
                <Button size="sm" icon="check" onClick={saveTurnover}>Declare</Button>
              </div>
            </div>
          </div>

          <div className="jw-cadence">
            <Icon name="shield" size={13} strokeWidth={2.2} />
            <span>
              <strong>{cadence.label}</strong> — {cadence.basis}
              {!turnover && ` Set the figure above: the ₹${ITC04_TURNOVER_LIMIT / 10000000} crore limit is about your own aggregate turnover, not the size of each movement.`}
            </span>
          </div>

          {period && (
            <div className="jw-due">
              <span className="jw-due-label">Filing window</span>
              <span className="jw-due-value">{formatDateIN(period.start)} → {formatDateIN(period.end)}</span>
              <span className={`jw-due-count ${period.days_left !== null && period.days_left < 0 ? 'is-past' : ''}`}>
                {period.days_left === null ? '—' : period.days_left >= 0
                  ? `due in ${period.days_left} day${period.days_left === 1 ? '' : 's'}`
                  : `${-period.days_left} day${-period.days_left === 1 ? '' : 's'} past the 25th`}
              </span>
            </div>
          )}

          {statement && (
            <>
              <div className="jw-grid-totals">
                <div className="jw-gt"><span>A · Sent to job worker</span><strong>{fmtQty(statement.totals.sent_qty, '')}</strong><em>{money(statement.totals.sent_value)}</em></div>
                <div className="jw-gt"><span>B · Received back</span><strong>{fmtQty(statement.totals.received_qty, '')}</strong><em>{money(statement.totals.received_value)}</em></div>
                <div className="jw-gt"><span>C · Delivered direct</span><strong>{fmtQty(statement.totals.direct_qty, '')}</strong><em>{money(statement.totals.direct_value)}</em></div>
                <div className="jw-gt"><span>D · To another worker</span><strong>{fmtQty(statement.totals.alternate_qty, '')}</strong><em>{money(statement.totals.alternate_value)}</em></div>
                <div className="jw-gt is-out"><span>Outstanding at period end</span><strong>{fmtQty(statement.totals.outstanding_qty, '')}</strong><em>{money(statement.totals.outstanding_value)}</em></div>
              </div>

              {(statement.rows_without_hsn > 0 || statement.rows_without_gstin > 0) && (
                <div className="jw-note" style={{ marginTop: 12 }}>
                  <Icon name="alert" size={13} strokeWidth={2.2} />
                  <span>
                    {statement.rows_without_hsn > 0 &&
                      `${statement.rows_without_hsn} movement${statement.rows_without_hsn === 1 ? '' : 's'} in this period carry no HSN/SAC — the statement is prepared HSN-wise, so they fall under the blank code. `}
                    {statement.rows_without_gstin > 0 &&
                      `${statement.rows_without_gstin} movement${statement.rows_without_gstin === 1 ? '' : 's'} name a job worker without a GSTIN — that is legal below their service threshold, but grid A reports them by name only.`}
                  </span>
                </div>
              )}

              <div className="jw-grid-bar">
                <Segmented options={GRIDS} value={grid} onChange={g => setGrid(g as GridKey)} />
                <span className="jw-grid-actions">
                  <Button variant="ghost" size="sm" icon="download" onClick={exportGrids}
                    disabled={statement.sent.length + statement.received.length + statement.direct.length + statement.alternate.length === 0}>
                    Grids CSV
                  </Button>
                  <Button variant="ghost" size="sm" icon="download" onClick={exportHsn} disabled={statement.hsn.length === 0}>HSN CSV</Button>
                </span>
              </div>

              {grid === 'hsn' ? (
                statement.hsn.length === 0 ? (
                  <p className="jw-empty-grid">Nothing was sent to or from a job worker in {period?.label}. An empty statement is still a statement — the period is reported as nil.</p>
                ) : (
                  <div className="table-frame">
                    <div className="responsive-table">
                      <div className="table-header jw-row jw-head">
                        <span data-label="HSN/SAC">HSN/SAC</span>
                        <span data-label="Item">Item</span>
                        <span data-label="Goods">Goods</span>
                        <span className="jw-right" data-label="Sent">Sent</span>
                        <span className="jw-right" data-label="Received">Received</span>
                        <span className="jw-right" data-label="Direct">Direct</span>
                        <span className="jw-right" data-label="2nd worker">2nd worker</span>
                        <span className="jw-right" data-label="Outstanding">Outstanding</span>
                      </div>
                      {statement.hsn.map(r => (
                        <div key={`${r.hsn_sac}|${r.unit}`} className="table-row jw-row">
                          <span data-label="HSN/SAC" className="jw-mono">{r.hsn_sac || <em className="jw-blank">none</em>}</span>
                          <span data-label="Item"><span className="jw-name">{r.item_name}</span><span className="jw-sub"> {r.unit}</span></span>
                          <span data-label="Goods"><span className="jw-sub">{r.categories}</span></span>
                          <span className="jw-right jw-num" data-label="Sent">{fmtQty(r.sent_qty, '')}<span className="jw-sub"> · {money(r.sent_value)}</span></span>
                          <span className="jw-right jw-num" data-label="Received">{fmtQty(r.returned_qty, '')}<span className="jw-sub"> · {money(r.returned_value)}</span></span>
                          <span className="jw-right jw-num" data-label="Direct">{fmtQty(r.direct_qty, '')}<span className="jw-sub"> · {money(r.direct_value)}</span></span>
                          <span className="jw-right jw-num" data-label="2nd worker">{fmtQty(r.alternate_qty, '')}<span className="jw-sub"> · {money(r.alternate_value)}</span></span>
                          <span className={`jw-right jw-num ${r.outstanding_qty > 0 ? 'is-hot' : ''}`} data-label="Outstanding">
                            {fmtQty(r.outstanding_qty, '')}<span className="jw-sub"> · {money(r.outstanding_value)}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              ) : detailRows.length === 0 ? (
                <p className="jw-empty-grid">No rows in this grid for {period?.label}.</p>
              ) : (
                <div className="table-frame">
                  <div className="responsive-table">
                    <div className="table-header jw-row jw-head-detail">
                      <span data-label="Date">Date</span>
                      <span data-label="Document">Document</span>
                      <span data-label="Item">Item</span>
                      <span className="jw-right" data-label="Qty">Qty</span>
                      <span className="jw-right" data-label="Value">Value</span>
                      <span data-label="Party">Party</span>
                      <span data-label="Within period">Within period</span>
                    </div>
                    {detailRows.map(r => (
                      <div key={`${r.date}-${r.lot_id}-${r.ref}-${r.qty}`} className="table-row jw-row jw-row-detail">
                        <span data-label="Date" className="jw-num">{formatDateIN(r.date)}</span>
                        <span data-label="Document">
                          <span className="jw-mono">{r.ref || '—'}</span>
                          {r.eway_bill_number && <span className="jw-sub"> · EWB {r.eway_bill_number}</span>}
                        </span>
                        <span data-label="Item">
                          <span className="jw-name">{r.item_name}</span>
                          <span className="jw-sub"> · {CATEGORY_META[r.category].short}{r.hsn_sac ? ` · ${r.hsn_sac}` : ''}</span>
                        </span>
                        <span className="jw-right jw-num" data-label="Qty">{fmtQty(r.qty, r.unit)}</span>
                        <span className="jw-right jw-num" data-label="Value">{money(r.value)}</span>
                        <span data-label="Party">
                          <span className="jw-name">{r.party}</span>
                          <span className="jw-sub jw-mono">{r.party_gstin ? ` · ${r.party_gstin}` : ' · no GSTIN'}</span>
                        </span>
                        <span data-label="Within period">
                          {r.within === null ? <span className="jw-sub">n/a</span>
                            : r.within ? <Badge tone="green" dot={false}>Yes</Badge>
                              : <Badge tone="red" dot={false}>No — late</Badge>}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="jw-deemed">
                <div>
                  <span className="jw-deemed-label">Deemed supply as at today, on every lot in the register</span>
                  <span className="jw-deemed-value">
                    {statement.totals.deemed_qty
                      ? `${fmtQty(statement.totals.deemed_qty, '')} units · ${money(statement.totals.deemed_value)}`
                      : 'Nothing past its section 143 period'}
                  </span>
                  <span className="jw-sub">
                    Rule 45 dates a deemed supply to the day the goods went out, so this reaches backwards across periods — the
                    indicative tax at the goods’ own rate is {money(statement.totals.indicative_tax)} and is a workpaper figure, not a challan.
                  </span>
                </div>
                <Button variant="ghost" size="sm" icon="download" onClick={exportMovements} disabled={allLines.length === 0}>
                  Movements CSV
                </Button>
              </div>
            </>
          )}
        </Card>

        <div className="jw-note" style={{ marginTop: 12 }}>
          <Icon name="shield" size={13} strokeWidth={2.2} />
          <span>
            This is a workpaper: nothing here files anything, posts tax, or receives money. A movement out needs a real rule 55
            challan on the <Link href="/challans">challan register</Link>; a delivery from the job worker’s own place is your supply and
            belongs on <Link href="/invoices">invoices</Link> so GSTR-1 sees it; the statement is taken to the portal yourself.
          </span>
        </div>
      </div>

      {/* ── job-worker register ─────────────────────────────────────────────── */}
      <div className="jw-section">
        <div className="jw-section-head">
          <h2>
            <Icon name="users" size={15} />
            Job workers
          </h2>
          <span className="jw-section-sub">
            The people the goods go to. An unregistered job worker is legal below their own service threshold — the statement then
            names them without a GSTIN.
          </span>
          <Button variant="ghost" size="sm" icon="plus" onClick={() => openWorker(newWorker(), true)} style={{ marginLeft: 'auto' }}>
            Add job worker
          </Button>
        </div>

        {job.workers.length === 0 ? (
          <Card>
            <EmptyState icon="users" title="No job worker on the register"
              message="Movements can still be recorded by the name on the challan, but ITC-04 reports grid A party-wise — add the worker so their GSTIN and address travel with the statement."
              action={<Button size="sm" icon="plus" onClick={() => openWorker(newWorker(), true)}>Add job worker</Button>} />
          </Card>
        ) : (
          <div className="table-frame">
            <div className="responsive-table">
              <div className="table-header jw-row jw-head-worker">
                <span data-label="Job worker">Job worker</span>
                <span data-label="GSTIN">GSTIN</span>
                <span data-label="State">State</span>
                <span className="jw-right" data-label="Movements">Movements</span>
                <span className="jw-right" data-label="Still out">Still out</span>
                <span data-label="Actions" className="jw-right">{''}</span>
              </div>
              {workerRows.map(r => (
                <div key={r.worker.id} className={`table-row jw-row jw-row-worker ${r.worker.archived ? 'is-dim' : ''}`}>
                  <span data-label="Job worker">
                    <span className="jw-name">{r.worker.name}</span>
                    {r.worker.archived && <Badge tone="grey" dot={false}>Archived</Badge>}
                    {r.worker.contact && <span className="jw-sub"> · {r.worker.contact}</span>}
                    {r.worker.address && <div className="jw-sub">{r.worker.address}</div>}
                  </span>
                  <span data-label="GSTIN" className="jw-mono">{r.worker.gstin || <em className="jw-blank">unregistered</em>}</span>
                  <span data-label="State">{r.worker.state ? (INDIAN_STATES.find(s => s.value === r.worker.state)?.label || r.worker.state) : '—'}</span>
                  <span className="jw-right jw-num" data-label="Movements">{r.lots}</span>
                  <span className={`jw-right jw-num ${r.deemed_qty > 0 ? 'is-hot' : ''}`} data-label="Still out">
                    {r.outstanding_qty ? fmtQty(r.outstanding_qty, '') : '—'}
                    <span className="jw-sub">{r.outstanding_qty ? ` · ${money(r.outstanding_value)}` : ''}</span>
                  </span>
                  <span className="jw-right jw-actions" data-label="Actions">
                    <Button variant="ghost" size="sm" icon="edit" title={`Edit ${r.worker.name}`}
                      onClick={() => openWorker({ ...r.worker }, false)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                    {!r.worker.archived && (
                      <Button variant="danger" size="sm" icon="x" title={`Archive ${r.worker.name}`}
                        onClick={() => closeWorker(r.worker)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {unnamedWorkers > 0 && (
          <div className="jw-note" style={{ marginTop: 10 }}>
            <Icon name="alert" size={13} strokeWidth={2.2} />
            <span>
              {unnamedWorkers} movement{unnamedWorkers === 1 ? '' : 's'} name a job worker who is not on the register. Add them so the
              statement carries a GSTIN and an address against those challans.
            </span>
          </div>
        )}
      </div>

      <div className="jw-foot">
        <span>
          {totals.lots ? `${totals.lots} movement${totals.lots === 1 ? '' : 's'} · ${totals.sent_qty} units sent · ${totals.outstanding_qty} still out` : 'Nothing on the register'}
        </span>
        <span className="jw-foot-links">
          <Link href="/challans">Delivery challans</Link>
          <Link href="/invoices">Invoices</Link>
          <Link href="/gst/calendar">Compliance calendar</Link>
          <Link href="/inventory/batches">Batch register</Link>
        </span>
      </div>

      {/* ── movement editor ─────────────────────────────────────────────────── */}
      {editor && (
        <div className="jw-scrim" role="dialog" aria-modal="true" aria-label={editor.isNew ? 'Record a job-work movement' : 'Edit the movement'}
          onClick={e => { if (e.target === e.currentTarget) setEditor(null) }}>
          <div className="jw-modal" style={{ maxWidth: 720 }}>
            <div className="jw-modal-head">
              <div>
                <h2>{editor.isNew ? 'Goods going out for job work' : `Edit ${editor.lot.item_name || 'movement'}`}</h2>
                <p>
                  One row per challan. The section 143 clock starts on the day the goods went out, so the date and the challan
                  number are the two fields the statement leans on.
                </p>
              </div>
              <button type="button" className="jw-close" onClick={() => setEditor(null)} aria-label="Close"><Icon name="x" size={16} /></button>
            </div>

            {challans.length > 0 && (
              <label className="jw-field">
                <span>Pull from a job-work challan (optional)</span>
                <select className="tf-input" value={editor.lot.challan_ref} onChange={e => pullChallan(e.target.value)}>
                  <option value="">Type the challan details yourself</option>
                  {challans.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.number} · {c.doc_date} · {c.party_name || 'unnamed party'}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="jw-grid2">
              <label className="jw-field">
                <span>Item sent *</span>
                <input className="tf-input" value={editor.lot.item_name} onChange={e => patchLot({ item_name: e.target.value })}
                  placeholder="Cotton greige rolls, machine frame…" />
              </label>
              <label className="jw-field">
                <span>HSN / SAC</span>
                <input className="tf-input" value={editor.lot.hsn_sac} onChange={e => patchLot({ hsn_sac: e.target.value })}
                  placeholder="5205 — ITC-04 groups by this" />
              </label>
            </div>

            <Segmented options={CATEGORY_ORDER.map(c => ({ value: c, label: CATEGORY_META[c].short }))}
              value={editor.lot.category} onChange={c => patchLot({ category: c as GoodsCategory })} />
            <div className="jw-basis"><Icon name="shield" size={12} strokeWidth={2.2} />{CATEGORY_META[editor.lot.category].basis}</div>

            <div className="jw-grid3">
              <label className="jw-field">
                <span>Quantity sent *</span>
                <input className="tf-input" type="number" min="0" step="any" value={editor.lot.qty || ''}
                  onChange={e => patchLot({ qty: Number(e.target.value) || 0 })} placeholder="0" />
              </label>
              <label className="jw-field">
                <span>Unit</span>
                <select className="tf-input" value={editor.lot.unit} onChange={e => patchLot({ unit: e.target.value })}>
                  {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </label>
              <label className="jw-field">
                <span>Value at cost (₹)</span>
                <input className="tf-input" type="number" min="0" step="0.01" value={editor.lot.value || ''}
                  onChange={e => patchLot({ value: Number(e.target.value) || 0 })} placeholder="What the challan declares" />
              </label>
            </div>

            <div className="jw-grid3">
              <label className="jw-field">
                <span>Job worker</span>
                <select className="tf-input" value={editor.lot.worker_id}
                  onChange={e => patchLot({ worker_id: e.target.value })}>
                  <option value="">Not on the register — name them below</option>
                  {job.workers.filter(w => !w.archived).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </label>
              <label className="jw-field">
                <span>Or the name on the challan</span>
                <input className="tf-input" value={editor.lot.worker_name} onChange={e => patchLot({ worker_name: e.target.value })}
                  placeholder="As printed on the movement paper" disabled={Boolean(editor.lot.worker_id)} />
              </label>
              <label className="jw-field">
                <span>GST rate on the goods (%)</span>
                <input className="tf-input" type="number" min="0" step="0.01" value={editor.lot.gst_rate || ''}
                  onChange={e => patchLot({ gst_rate: Number(e.target.value) || 0 })} placeholder="18" />
              </label>
            </div>

            <div className="jw-grid3">
              <label className="jw-field">
                <span>Date the goods went out *</span>
                <input className="tf-input" type="date" value={editor.lot.sent_date} onChange={e => patchLot({ sent_date: e.target.value })} />
              </label>
              <label className="jw-field">
                <span>Challan number *</span>
                <input className="tf-input" value={editor.lot.challan_number} onChange={e => patchLot({ challan_number: e.target.value })}
                  placeholder="DC-2026-27-0004" />
              </label>
              <label className="jw-field">
                <span>Challan date *</span>
                <input className="tf-input" type="date" value={editor.lot.challan_date} onChange={e => patchLot({ challan_date: e.target.value })} />
              </label>
            </div>

            <div className="jw-grid3">
              <label className="jw-field">
                <span>Period the challan stipulates (months)</span>
                <input className="tf-input" type="number" min="0" step="1" value={editor.lot.stipulated_months || ''}
                  onChange={e => patchLot({ stipulated_months: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
                  placeholder={`0 = statutory ${CATEGORY_META[editor.lot.category].statutory_label}`} />
              </label>
              <label className="jw-field">
                <span>E-way bill</span>
                <input className="tf-input" value={editor.lot.eway_bill_number} onChange={e => patchLot({ eway_bill_number: e.target.value })}
                  placeholder="12-digit EWB" />
              </label>
              <label className="jw-field">
                <span>Vehicle number</span>
                <input className="tf-input" value={editor.lot.vehicle_number} onChange={e => patchLot({ vehicle_number: e.target.value })}
                  placeholder="MH12AB1234" />
              </label>
            </div>

            <label className="jw-field">
              <span>Notes</span>
              <input className="tf-input" value={editor.lot.notes} onChange={e => patchLot({ notes: e.target.value })}
                placeholder="What the job worker is doing to the goods" />
            </label>

            <div className="jw-preview">
              <div className="jw-preview-head">
                <span>This is what gets written</span>
                <span className="jw-preview-total">
                  {periodMonths(editor.lot) === null ? 'no deadline' : `back by ${deadlineOf(editor.lot) || '—'}`}
                </span>
              </div>
              <ul className="jw-preview-list">
                <li>
                  <span className="jw-dot jw-dot-blue" />
                  Grid A — sent to job worker: {fmtQty(editor.lot.qty, editor.lot.unit)} of {editor.lot.item_name || '—'} to
                  {editor.lot.worker_id
                    ? ` ${job.workers.find(w => w.id === editor.lot.worker_id)?.name || '—'}`
                    : ` ${editor.lot.worker_name.trim() || '(name the worker)'}`}
                  <span className="jw-preview-take">{money(editor.lot.value)}</span>
                </li>
                <li>
                  <span className={`jw-dot jw-dot-${periodMonths(editor.lot) === null ? 'grey' : 'amber'}`} />
                  {periodMonths(editor.lot) === null
                    ? 'Tooling — reported on ITC-04 and never recalled, so nothing here can be overdue'
                    : `Section 143 period ${lotPeriodText(editor.lot)} from ${editor.lot.sent_date || '—'} — rule 45 deems the goods supplied on the send day if the period runs out`}
                </li>
                {editor.lot.stipulated_months > 0 && CATEGORY_META[editor.lot.category].statutory_months !== null && (
                  <li>
                    <span className="jw-dot jw-dot-grey" />
                    The challan stipulates {editor.lot.stipulated_months} months; the statutory cap is
                    {' '}{CATEGORY_META[editor.lot.category].statutory_label} — the shorter of the two runs.
                  </li>
                )}
                {!editor.lot.hsn_sac.trim() && (
                  <li><span className="jw-dot jw-dot-red" />No HSN/SAC yet — the statement would report this under the blank code.</li>
                )}
              </ul>
              {editorProblems.length > 0 && (
                <ul className="jw-problems is-modal">
                  {editorProblems.map(p => <li key={p}><Icon name="alert" size={12} strokeWidth={2.2} />{p}</li>)}
                </ul>
              )}
            </div>

            <div className="jw-save">
              <Button variant="ghost" onClick={() => setEditor(null)}>Cancel</Button>
              <Button icon="check" onClick={saveLot} disabled={editorProblems.length > 0}>
                {editor.isNew ? 'Record movement' : 'Save changes'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── movement-back editor ────────────────────────────────────────────── */}
      {disp && dispLot && dispView && (
        <div className="jw-scrim" role="dialog" aria-modal="true" aria-label="Record what happened to the goods"
          onClick={e => { if (e.target === e.currentTarget) setDisp(null) }}>
          <div className="jw-modal" style={{ maxWidth: 620 }}>
            <div className="jw-modal-head">
              <div>
                <h2>{dispLot.item_name}</h2>
                <p>
                  {fmtQty(dispOutstanding, dispLot.unit)} of challan {dispLot.challan_number || '—'} is still out, sent on{' '}
                  {formatDateIN(dispLot.sent_date)}{dispView.deadline ? ` and due back by ${formatDateIN(dispView.deadline)}` : ' with no return period'}.
                </p>
              </div>
              <button type="button" className="jw-close" onClick={() => setDisp(null)} aria-label="Close"><Icon name="x" size={16} /></button>
            </div>

            <Segmented options={DISPOSITION_ORDER.map(k => ({ value: k, label: DISPOSITION_META[k].short }))}
              value={disp.kind} onChange={k => patchDisp({ kind: k as DispositionKind })} />
            <div className="jw-basis">
              <Icon name="shield" size={12} strokeWidth={2.2} />
              {DISPOSITION_META[disp.kind].note}
            </div>

            <div className="jw-grid2">
              <label className="jw-field">
                <span>Quantity moving *</span>
                <input className="tf-input" type="number" min="0" step="any" value={disp.qty}
                  onChange={e => patchDisp({ qty: e.target.value })} placeholder={`Up to ${dispOutstanding}`} />
              </label>
              <label className="jw-field">
                <span>{disp.kind === 'returned' ? 'Date received back *' : disp.kind === 'direct_delivery' ? 'Date delivered *' : 'Date moved on *'}</span>
                <input className="tf-input" type="date" value={disp.date} onChange={e => patchDisp({ date: e.target.value })} />
              </label>
            </div>

            {disp.kind !== 'returned' && (
              <div className="jw-grid2">
                <label className="jw-field">
                  <span>{disp.kind === 'direct_delivery' ? 'Customer the goods went to *' : 'Second job worker *'}</span>
                  <input className="tf-input" value={disp.party_name} onChange={e => patchDisp({ party_name: e.target.value })}
                    placeholder={disp.kind === 'direct_delivery' ? 'Named on the invoice you raise' : 'And the intimation you sent'} />
                </label>
                <label className="jw-field">
                  <span>Their GSTIN</span>
                  <input className="tf-input" value={disp.party_gstin} onChange={e => patchDisp({ party_gstin: e.target.value.toUpperCase() })}
                    placeholder="15 characters, optional" />
                </label>
              </div>
            )}

            <div className="jw-grid2">
              <label className="jw-field">
                <span>{disp.kind === 'direct_delivery' ? 'Invoice number' : 'Challan / e-way bill ref'}</span>
                <input className="tf-input" value={disp.ref} onChange={e => patchDisp({ ref: e.target.value })}
                  placeholder={disp.kind === 'direct_delivery' ? 'INV-2026-27-0112 — that is the supply' : 'The paper the goods moved under'} />
              </label>
              <label className="jw-field">
                <span>Note</span>
                <input className="tf-input" value={disp.note} onChange={e => patchDisp({ note: e.target.value })}
                  placeholder="Return challan, job card, intimation…" />
              </label>
            </div>

            <div className="jw-preview">
              <div className="jw-preview-head">
                <span>This is what gets written</span>
                <span className="jw-preview-total">{money2(dispValue)}</span>
              </div>
              <ul className="jw-preview-list">
                <li>
                  <span className={`jw-dot jw-dot-${disp.kind === 'returned' ? 'green' : disp.kind === 'direct_delivery' ? 'blue' : 'violet'}`} />
                  {DISPOSITION_META[disp.kind].grid}
                  <span className="jw-preview-take">{fmtQty(Number(disp.qty) || 0, dispLot.unit)}</span>
                </li>
                <li>
                  <span className="jw-dot jw-dot-grey" />
                  Outstanding after this: {fmtQty(Math.max(0, Math.round((dispOutstanding - (Number(disp.qty) || 0)) * 1000) / 1000), dispLot.unit)}
                  {' '}of {dispLot.item_name}
                </li>
                {dispLate && (
                  <li>
                    <span className="jw-dot jw-dot-red" />
                    Dated after {dispView.deadline} — rule 45 already deemed these units supplied on {formatDateIN(dispLot.sent_date)}, so this
                    return is reported and still counted as late.
                  </li>
                )}
                {disp.kind === 'direct_delivery' && (
                  <li>
                    <span className="jw-dot jw-dot-blue" />
                    This leg is a supply by you — raise it on <Link href="/invoices">invoices</Link> so GSTR-1 carries it.
                  </li>
                )}
                {disp.kind === 'alternate_worker' && (
                  <li>
                    <span className="jw-dot jw-dot-violet" />
                    The clock does not restart — the deadline stays {dispView.deadline ? formatDateIN(dispView.deadline) : 'the original one'}.
                  </li>
                )}
              </ul>
              {dispProblems.length > 0 && (
                <ul className="jw-problems is-modal">
                  {dispProblems.map(p => <li key={p}><Icon name="alert" size={12} strokeWidth={2.2} />{p}</li>)}
                </ul>
              )}
            </div>

            <div className="jw-save">
              <Button variant="ghost" onClick={() => setDisp(null)}>Cancel</Button>
              <Button icon="check" onClick={saveDisp} disabled={dispProblems.length > 0}>Record movement</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── job-worker editor ───────────────────────────────────────────────── */}
      {workerEditor && (
        <div className="jw-scrim" role="dialog" aria-modal="true" aria-label={workerEditor.isNew ? 'Add a job worker' : 'Edit the job worker'}
          onClick={e => { if (e.target === e.currentTarget) setWorkerEditor(null) }}>
          <div className="jw-modal" style={{ maxWidth: 560 }}>
            <div className="jw-modal-head">
              <div>
                <h2>{workerEditor.isNew ? 'Add a job worker' : `Edit ${workerEditor.worker.name || 'job worker'}`}</h2>
                <p>ITC-04 reports goods party-wise, so the name and GSTIN here are what the statement prints against every challan.</p>
              </div>
              <button type="button" className="jw-close" onClick={() => setWorkerEditor(null)} aria-label="Close"><Icon name="x" size={16} /></button>
            </div>

            <div className="jw-grid2">
              <label className="jw-field">
                <span>Name *</span>
                <input className="tf-input" value={workerEditor.worker.name} onChange={e => patchWorker({ name: e.target.value })}
                  placeholder="Sharma Job Works" />
              </label>
              <label className="jw-field">
                <span>GSTIN</span>
                <input className="tf-input" value={workerEditor.worker.gstin}
                  onChange={e => patchWorker({ gstin: e.target.value.toUpperCase() })} placeholder="Blank if unregistered" />
              </label>
            </div>

            <div className="jw-grid2">
              <label className="jw-field">
                <span>State of their place of business</span>
                <select className="tf-input" value={workerEditor.worker.state} onChange={e => patchWorker({ state: e.target.value })}>
                  <option value="">Not recorded</option>
                  {INDIAN_STATES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </label>
              <label className="jw-field">
                <span>Contact</span>
                <input className="tf-input" value={workerEditor.worker.contact} onChange={e => patchWorker({ contact: e.target.value })}
                  placeholder="Phone or email" />
              </label>
            </div>

            <label className="jw-field">
              <span>Address</span>
              <input className="tf-input" value={workerEditor.worker.address} onChange={e => patchWorker({ address: e.target.value })}
                placeholder="Where the goods are being worked on" />
            </label>
            <label className="jw-field">
              <span>Notes</span>
              <input className="tf-input" value={workerEditor.worker.notes} onChange={e => patchWorker({ notes: e.target.value })}
                placeholder="What they do to your goods" />
            </label>

            {workerProblems.length > 0 && (
              <ul className="jw-problems is-modal">
                {workerProblems.map(p => <li key={p}><Icon name="alert" size={12} strokeWidth={2.2} />{p}</li>)}
              </ul>
            )}

            <div className="jw-save">
              <Button variant="ghost" onClick={() => setWorkerEditor(null)}>Cancel</Button>
              <Button icon="check" onClick={saveWorker} disabled={workerProblems.length > 0}>
                {workerEditor.isNew ? 'Add job worker' : 'Save changes'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .jw-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .jw-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }

        .jw-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px;
          font-size: 12.5px; color: var(--green); background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 10px; }
        .jw-notice svg { flex-shrink: 0; }
        .jw-notice.is-bad { color: var(--amber); background: var(--amber-soft);
          border-color: color-mix(in srgb, var(--amber) 26%, white); }
        .jw-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; border-radius: 6px; min-height: 0; }
        .jw-notice-x:hover { background: rgba(0,0,0,0.05); }

        .jw-note { display: flex; align-items: flex-start; gap: 7px; padding: 9px 12px; border-radius: 10px;
          font-size: 12px; color: var(--muted); background: var(--surface-2); border: 1px solid var(--line-soft); line-height: 1.55; }
        .jw-note svg { flex-shrink: 0; margin-top: 2px; }
        .jw-note a { color: var(--brand); }
        .jw-note.is-hot { color: var(--red); background: var(--red-soft); border-color: color-mix(in srgb, var(--red) 24%, white); }
        .jw-note.is-hot a { color: inherit; text-decoration: underline; }

        .jw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
        .jw-card { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--line);
          border-radius: var(--radius-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-xs); }
        .jw-card.is-overdue { border-left-color: var(--red); }
        .jw-card.is-approaching, .jw-card.is-returned_late { border-left-color: var(--amber); }
        .jw-card.is-within { border-left-color: var(--brand); }
        .jw-card.is-settled { border-left-color: var(--green); }
        .jw-card.is-no_deadline { border-left-color: var(--violet); }
        .jw-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .jw-card-title { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .jw-card-name { display: flex; align-items: center; gap: 7px; font-size: 14.5px; font-weight: 650; color: var(--ink); overflow-wrap: anywhere; }
        .jw-card-name svg { color: var(--brand); flex-shrink: 0; }
        .jw-card-sub { display: flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--faint); line-height: 1.5; flex-wrap: wrap; }
        .jw-card-badges { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
        .jw-card-stats { display: flex; flex-direction: column; }
        .jw-card-stats > div:last-child { border-bottom: none; }

        .jw-clock { display: flex; align-items: center; gap: 7px; padding: 8px 11px; border-radius: 10px;
          font-size: 12px; font-weight: 600; background: var(--slate-soft); color: var(--muted); }
        .jw-clock-period { margin-left: auto; font-weight: 550; font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
        .jw-clock.is-red { background: var(--red-soft); color: var(--red); }
        .jw-clock.is-amber { background: var(--amber-soft); color: var(--amber); }
        .jw-clock.is-blue { background: var(--brand-soft); color: var(--brand); }
        .jw-clock.is-grey { background: var(--violet-soft); color: var(--violet); }

        .jw-share { display: flex; flex-direction: column; gap: 5px; }
        .jw-share-label { font-size: 11px; color: var(--faint); }

        .jw-problems { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .jw-problems li { display: flex; align-items: flex-start; gap: 6px; font-size: 11.5px; line-height: 1.5;
          color: var(--amber); background: var(--amber-soft); border-radius: 8px; padding: 7px 9px; }
        .jw-problems li svg { flex-shrink: 0; margin-top: 1px; }
        .jw-problems.is-modal { margin-top: 2px; }

        .jw-lines { border-top: 1px dashed var(--line); padding-top: 9px; display: flex; flex-direction: column; gap: 5px; }
        .jw-line { display: grid; grid-template-columns: minmax(0, 1fr) auto 22px; gap: 8px; align-items: center;
          padding: 6px 8px; background: var(--surface-2); border-radius: 9px; }
        .jw-line-what { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; min-width: 0; }
        .jw-line-name { font-size: 12px; font-weight: 600; color: var(--ink-2); }
        .jw-line-sub { font-size: 10.5px; color: var(--faint); }
        .jw-line-right { display: flex; flex-direction: column; align-items: flex-end; }
        .jw-line-qty { font-size: 12px; font-weight: 650; color: var(--ink); font-variant-numeric: tabular-nums; }
        .jw-line-x { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; min-height: 0; }
        .jw-line-x:hover { background: var(--red-soft); color: var(--red); }

        .jw-card-foot { display: flex; align-items: center; gap: 8px; margin-top: auto; flex-wrap: wrap; }
        .jw-foot-hint { display: flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--amber);
          min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 210px; }
        .jw-card-actions { display: flex; gap: 6px; margin-left: auto; }

        .jw-section { margin-top: 26px; display: flex; flex-direction: column; gap: 10px; }
        .jw-section-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
        .jw-section-head h2 { display: flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 650; color: var(--ink); margin: 0; }
        .jw-section-head h2 svg { color: var(--brand); }
        .jw-section-sub { font-size: 11.5px; color: var(--faint); max-width: 720px; line-height: 1.5; }

        .jw-stmt-bar { display: flex; gap: 14px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 12px; }
        .jw-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .jw-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .jw-field-period { flex: 1 1 300px; max-width: 420px; }
        .jw-turnover { flex: 0 1 260px; display: flex; flex-direction: column; gap: 4px; }
        .jw-turnover > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .jw-turnover-row { display: flex; gap: 8px; }
        .jw-turnover-row .tf-input { width: 120px; }

        .jw-cadence { display: flex; align-items: flex-start; gap: 7px; padding: 9px 12px; border-radius: 10px;
          background: var(--violet-soft); color: var(--violet); font-size: 11.5px; line-height: 1.55; }
        .jw-cadence svg { flex-shrink: 0; margin-top: 2px; }

        .jw-due { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px;
          padding: 10px 12px; border: 1px solid var(--line-soft); border-radius: 10px; background: var(--surface-2); }
        .jw-due-label { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .jw-due-value { font-size: 12.5px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
        .jw-due-count { margin-left: auto; font-size: 11.5px; font-weight: 650; color: var(--green); }
        .jw-due-count.is-past { color: var(--red); }

        .jw-grid-totals { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
        .jw-gt { display: flex; flex-direction: column; gap: 2px; padding: 9px 11px; border-radius: 10px;
          background: var(--slate-soft); border: 1px solid var(--line-soft); }
        .jw-gt span { font-size: 10.5px; color: var(--faint); line-height: 1.35; }
        .jw-gt strong { font-size: 15px; font-weight: 650; color: var(--ink); font-variant-numeric: tabular-nums; }
        .jw-gt em { font-style: normal; font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
        .jw-gt.is-out { background: var(--cyan-soft); border-color: color-mix(in srgb, var(--cyan) 22%, white); }
        .jw-gt.is-out strong { color: var(--cyan); }

        .jw-grid-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 16px 0 10px; }
        .jw-grid-actions { display: flex; gap: 6px; margin-left: auto; }
        .jw-empty-grid { font-size: 12.5px; color: var(--muted); background: var(--surface-2); border: 1px dashed var(--line);
          border-radius: 10px; padding: 14px; margin: 0; line-height: 1.55; }

        .jw-deemed { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-top: 14px;
          padding-top: 12px; border-top: 1px dashed var(--line); }
        .jw-deemed > div { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1 1 320px; }
        .jw-deemed-label { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .jw-deemed-value { font-size: 14px; font-weight: 650; color: var(--red); font-variant-numeric: tabular-nums; }
        .jw-deemed .jw-sub { max-width: 700px; line-height: 1.5; }

        .jw-row { display: grid; gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .jw-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .jw-row-detail { grid-template-columns: 92px minmax(0, 1.1fr) minmax(0, 1.3fr) 90px 100px minmax(0, 1.1fr) 110px; }
        .jw-row-worker { grid-template-columns: minmax(0, 1.4fr) 160px 130px 90px 130px 76px; }
        .jw-head-worker { grid-template-columns: minmax(0, 1.4fr) 160px 130px 90px 130px 76px; }
        .jw-head-detail { grid-template-columns: 92px minmax(0, 1.1fr) minmax(0, 1.3fr) 90px 100px minmax(0, 1.1fr) 110px; }
        .jw-row:not(.jw-row-detail):not(.jw-row-worker) { grid-template-columns: 110px minmax(0, 1.4fr) 110px 90px 90px 90px 90px minmax(0, 1fr); }
        .jw-head:not(.jw-head-detail):not(.jw-head-worker) { grid-template-columns: 110px minmax(0, 1.4fr) 110px 90px 90px 90px 90px minmax(0, 1fr); }
        .jw-right { text-align: right; justify-content: flex-end; }
        .jw-num { font-variant-numeric: tabular-nums; color: var(--ink-2); }
        .jw-num.is-hot { color: var(--red); font-weight: 650; }
        .jw-mono { font-family: var(--mono); font-size: 11.5px; }
        .jw-sub { font-size: 11px; color: var(--faint); }
        .jw-name { font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
        .jw-blank { color: var(--faint); font-weight: 550; font-size: 11px; }
        .jw-actions { display: flex; gap: 6px; justify-content: flex-end; }
        .jw-row.is-dim { opacity: 0.7; }

        .jw-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          font-size: 11.5px; color: var(--faint); margin-top: 20px; }
        .jw-foot-links { display: flex; gap: 12px; flex-wrap: wrap; }
        .jw-foot-links a { color: var(--brand); text-decoration: none; }

        .jw-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .jw-modal { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .jw-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .jw-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .jw-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; max-width: 470px; line-height: 1.5; }
        .jw-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; flex-shrink: 0; min-height: 0; }
        .jw-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .jw-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
        .jw-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: start; }
        .jw-basis { display: flex; align-items: flex-start; gap: 7px; font-size: 11.5px; color: var(--muted);
          background: var(--surface-2); border-left: 3px solid var(--brand); border-radius: 8px; padding: 8px 11px; line-height: 1.55; }
        .jw-basis svg { flex-shrink: 0; margin-top: 2px; color: var(--brand); }

        .jw-preview { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--surface-2); }
        .jw-preview-head { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .jw-preview-total { color: var(--brand); font-variant-numeric: tabular-nums; }
        .jw-preview-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .jw-preview-list li { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; color: var(--ink-2); line-height: 1.5; flex-wrap: wrap; }
        .jw-preview-list a { color: var(--brand); }
        .jw-preview-take { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 650; color: var(--ink); }
        .jw-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; }
        .jw-dot-red { background: var(--red); }
        .jw-dot-green { background: var(--green); }
        .jw-dot-blue { background: var(--brand); }
        .jw-dot-amber { background: var(--amber); }
        .jw-dot-violet { background: var(--violet); }
        .jw-dot-grey { background: var(--faint); }

        .jw-save { display: flex; gap: 10px; justify-content: flex-end; }

        @media (max-width: 1100px) { .jw-stats { grid-template-columns: 1fr 1fr; } .jw-grid-totals { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        @media (max-width: 768px) {
          .jw-stats { grid-template-columns: 1fr 1fr; }
          .jw-grid { grid-template-columns: 1fr; }
          .jw-grid2, .jw-grid3 { grid-template-columns: 1fr; }
          .jw-row, .jw-row-detail, .jw-row-worker { grid-template-columns: 1fr; gap: 6px; }
          .jw-head, .jw-head-detail, .jw-head-worker { display: none; }
          .jw-right { text-align: left; justify-content: flex-start; }
          .jw-foot-hint { max-width: 100%; }
          .jw-scrim { align-items: flex-end; padding: 0; }
          .jw-scrim .jw-modal { max-width: none !important; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .jw-save { flex-direction: column-reverse; }
          .jw-card-actions { margin-left: auto; }
        }
      `}</style>
    </div>
  )
}

export default function JobWorkPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <JobWorkPageInner />
    </Suspense>
  )
}
