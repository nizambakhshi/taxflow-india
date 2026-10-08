'use client'

// Cost centres — which part of the business earned this, and which part spent it.
//
// The engine (src/lib/costcentres.ts) owns the model: a register of centres kept in this browser,
// shares that split a document between them, and figures re-read from the books on every load.
// This page is the register itself — the centres, their contribution, the documents nobody has
// placed, and the split dialog.
//
// Two boundaries are printed on the screen rather than left to the reader's imagination, because
// both are things a competitor's "cost centre" module quietly gets wrong:
//
//  * A cost centre is not a legal person. Nothing here reaches a return. The one place a split of
//    the business becomes a statutory question — a branch in another state with no GSTIN of its
//    own — shows up as a flag that links to the GSTR-9 workpaper, never as a tax figure invented here.
//  * This page never writes to the books. It stores percentages against invoices and bills; the
//    rupees come back out of those documents each time the page opens, so a bill amended at /bills
//    changes the centre's contribution with it and nothing ever has to be re-entered.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN } from '@/lib/format'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import { INDIAN_STATES } from '@/lib/constants'
import {
  ALLOC_CSV_HEADERS, allocationCsvRows, archiveCentre, type BookDoc, bookDocs, bulkAssign, CENTRE_CSV_HEADERS,
  CENTRE_SORTS, centreCsvRows, centreViews, type CCStore, type CostCentre, deleteCentre,
  DOC_KIND_META, type DocSheet, docKey, emptyCC, KIND_META, loadCC, newAllocation, newCentre,
  removeAllocation, round2, saveCC, setAllocation, SHARE_CSV_HEADERS, shareCsvRows, sheets, summarise,
  sortCentreViews, totalShare, unassigned, upsertCentre, validateAllocation, validateCentre, type CentreSort,
  type Allocation, type CentreView,
} from '@/lib/costcentres'
import {
  Badge, Button, Card, EmptyState, PageHeader, ProgressBar, SearchInput, Segmented, StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'

// ── the shape of the screen ───────────────────────────────────────────────────

type Tab = 'centres' | 'documents' | 'unassigned' | 'attention'
type Period = 'this_fy' | 'last_fy' | 'all'
type Side = 'all' | 'outward' | 'inward'

const TABS: { value: Tab; label: string }[] = [
  { value: 'centres', label: 'Centres' },
  { value: 'documents', label: 'Documents' },
  { value: 'unassigned', label: 'To assign' },
  { value: 'attention', label: 'To check' },
]

const PERIODS: { value: Period; label: string }[] = [
  { value: 'this_fy', label: 'This FY' },
  { value: 'last_fy', label: 'Last FY' },
  { value: 'all', label: 'All time' },
]

const SIDES: { value: Side; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'outward', label: 'What came in' },
  { value: 'inward', label: 'What went out' },
]

/** The financial year today falls in — April rolls it, so 2026-03-31 is still FY 2025-26. */
function fyStart(d = new Date()): number {
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
}

const fyLabel = (start: number) => `${start}-${String(start + 1).slice(2)}`

function inPeriod(date: string, period: Period, base: number): boolean {
  if (period === 'all') return true
  if (!date) return true
  const start = period === 'this_fy' ? base : base - 1
  return date >= `${start}-04-01` && date < `${start + 1}-04-01`
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
/** Rupees with the paisa when there are paisa to show — a 33.33% split always has some. */
function money(n: number): string {
  const v = round2(Number(n) || 0)
  return `₹${Math.abs(v) >= 1000 ? inr0.format(v) : inr.format(v)}`
}
const pct = (n: number) => `${round2(Number(n) || 0)}%`

const stateName = (code: string) => INDIAN_STATES.find(s => s.value === code)?.label || code

// ── modal state ───────────────────────────────────────────────────────────────

interface EditorState { centre: CostCentre; isNew: boolean }
interface SplitState { doc: BookDoc; parts: { centre_id: string; share: string }[]; note: string }

function splitOf(doc: BookDoc, alloc: Allocation | null): SplitState {
  return {
    doc,
    parts: (alloc?.parts || []).map(p => ({ centre_id: p.centre_id, share: String(p.share) })),
    note: alloc?.note || '',
  }
}

function toAllocation(s: SplitState): Allocation {
  const base = newAllocation(s.doc.kind, s.doc.id, s.doc.number, s.doc.date)
  return {
    ...base,
    parts: s.parts
      .filter(p => p.centre_id)
      .map(p => ({ centre_id: p.centre_id, share: Number(p.share) || 0 })),
    note: s.note,
  }
}

function CostCentresPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [homeState, setHomeState] = useState('')
  const [loading, setLoading] = useState(true)

  const [books, setBooks] = useState({
    invoices: [] as Record<string, unknown>[],
    credit_notes: [] as Record<string, unknown>[],
    debit_notes: [] as Record<string, unknown>[],
    bills: [] as Record<string, unknown>[],
    expenses: [] as Record<string, unknown>[],
  })
  const [store, setStore] = useState<CCStore>(emptyCC())

  const [search, setSearch] = useSearchDeepLink()
  const [tab, setTab] = useState<Tab>('centres')
  const [period, setPeriod] = useState<Period>('all')
  const [side, setSide] = useState<Side>('all')
  const [sort, setSort] = useState<CentreSort>('contribution')
  const [openCentre, setOpenCentre] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)
  const [error, setError] = useState('')

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [editorError, setEditorError] = useState('')
  const [split, setSplit] = useState<SplitState | null>(null)

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

      // The state this GSTIN is registered in is what makes "another state" mean something, and
      // therefore what makes a branch a rule 41A question rather than just another office.
      const { data: reg } = await supabase
        .from('gst_registrations')
        .select('gstin, state_code, registration_type')
        .eq('organization_id', oid)
        .eq('is_primary', true)
        .single()
      const stateCode = reg?.state_code || ''
      setHomeState(stateCode)

      const [invRes, cnRes, dnRes, billRes, expRes] = await Promise.all([
        supabase.from('invoices')
          .select('id, invoice_number, invoice_date, customer_name, status, taxable_amount, total_tax, grand_total')
          .eq('organization_id', oid).neq('status', 'cancelled').limit(5000),
        supabase.from('credit_notes')
          .select('id, credit_note_number, credit_note_date, customer_name, status, taxable_amount, total_tax, grand_total')
          .eq('organization_id', oid).neq('status', 'cancelled').limit(2000),
        supabase.from('debit_notes')
          .select('id, debit_note_number, debit_note_date, vendor_name, status, taxable_amount, total_tax, grand_total')
          .eq('organization_id', oid).neq('status', 'cancelled').limit(2000),
        supabase.from('purchase_bills')
          .select('id, bill_number, bill_date, vendor_name, status, taxable_amount, total_tax, grand_total, itc_eligible')
          .eq('organization_id', oid).neq('status', 'cancelled').limit(5000),
        supabase.from('expenses')
          .select('id, bill_number, expense_date, category, vendor_name, amount, gst_amount, taxable_amount, itc_eligible')
          .eq('organization_id', oid).limit(5000),
      ])
      setError(invRes.error ? `Could not read the books: ${invRes.error.message}` : '')

      setBooks({
        invoices: invRes.data || [],
        credit_notes: cnRes.data || [],
        debit_notes: dnRes.data || [],
        bills: billRes.data || [],
        expenses: expRes.data || [],
      })

      const loaded = loadCC(oid)
      setStore(loaded)
      // Remember the home state on the register so the flags read back the same way offline.
      if (stateCode && loaded.settings.home_state !== stateCode) {
        const stamped = { ...loaded, settings: { home_state: stateCode } }
        saveCC(oid, stamped)
        setStore(stamped)
      }

      // ?new=1 — the palette's "New cost centre" action lands here with the editor open.
      if (searchParams.get('new') === '1') openEditor(newCentre(), true)
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── derived workpaper: the shares, and the rupees the books say they are worth ──

  const docs = useMemo(() => bookDocs({
    invoices: books.invoices as never,
    credit_notes: books.credit_notes as never,
    debit_notes: books.debit_notes as never,
    bills: books.bills as never,
    expenses: books.expenses as never,
  }), [books])

  const allSheets = useMemo(
    () => sheets({ docs, allocations: store.allocations, centres: store.centres }),
    [docs, store],
  )

  const base = fyStart()
  const periodSheets = useMemo(
    () => allSheets.filter(s => s.orphan || inPeriod(s.doc.date, period, base)),
    [allSheets, period, base],
  )
  const sideSheets = useMemo(
    () => periodSheets.filter(s => s.orphan || side === 'all' || s.side === side),
    [periodSheets, side],
  )

  const views = useMemo(
    () => sortCentreViews(centreViews(store.centres, periodSheets, homeState), sort),
    [store, periodSheets, homeState, sort],
  )
  const sum = useMemo(() => summarise(store.centres, periodSheets, homeState), [store, periodSheets, homeState])
  const free = useMemo(() => unassigned(sideSheets, side === 'all' ? undefined : side), [sideSheets, side])
  const splitSheets = useMemo(() => sideSheets.filter(s => !s.orphan && s.parts.length > 0), [sideSheets])
  const orphans = useMemo(() => periodSheets.filter(s => s.orphan), [periodSheets])

  const visibleCentres = useMemo(
    () => views.filter(v => matchesAny(search, [
      v.centre.name, v.centre.code, KIND_META[v.centre.kind].label, stateName(v.centre.state), v.centre.gstin,
    ])),
    [views, search],
  )
  const visibleSheets = useMemo(
    () => sideSheets.filter(s => matchesAny(search, [s.doc.number, s.doc.party, DOC_KIND_META[s.kind].label]))
      .filter(s => (openCentre ? s.parts.some(p => p.centre_id === openCentre) : true)),
    [sideSheets, search, openCentre],
  )

  const tracked = round2(sum.revenue_allocated + sum.cost_allocated)
  const untracked = round2(sum.unallocated_revenue + sum.unallocated_cost)
  const centreById = useMemo(() => new Map(store.centres.map(c => [c.id, c])), [store.centres])

  const attention = useMemo(() => ({
    centres: views.filter(v => v.problems.length),
    sheets: periodSheets.filter(s => !s.orphan && s.problems.length),
    orphans,
  }), [views, periodSheets, orphans])

  // ── helpers ──────────────────────────────────────────────────────────────────

  function flash(message: string) { setNotice({ msg: message, bad: false }) }
  function warn(message: string) { setNotice({ msg: message, bad: true }) }

  // ── centres ──────────────────────────────────────────────────────────────────

  function openEditor(centre: CostCentre, isNew: boolean) {
    setEditor({ centre: { ...centre }, isNew })
    setEditorError('')
  }

  function patchEditor(patch: Partial<CostCentre>) {
    setEditor(e => (e ? { ...e, centre: { ...e.centre, ...patch } } : e))
  }

  const editorProblems = editor ? validateCentre(editor.centre, store.centres) : []

  function saveCentre() {
    if (!editor) return
    if (editorProblems.length) { setEditorError(editorProblems.join(' · ')); return }
    const result = upsertCentre(orgId, editor.centre)
    if (!result.ok) { setEditorError(result.error); return }
    setStore(result.store)
    flash(editor.isNew
      ? `${editor.centre.name.trim()} is on the register — a centre earns its rupees only when a document is split against it.`
      : `${editor.centre.name.trim()} updated — every split against it re-reads its rupees from the books.`)
    setEditor(null)
    setEditorError('')
  }

  function archive(centre: CostCentre) {
    setStore(archiveCentre(orgId, centre.id, !centre.archived))
    flash(centre.archived ? `${centre.name} is on the register again — its past shares still count.` : `${centre.name} archived — it leaves the picker, its rupees stay in the figures.`)
  }

  function removeCentre(centre: CostCentre) {
    const result = deleteCentre(orgId, centre.id)
    if (!result.ok) { setStore(result.store); warn(result.error); return }
    setStore(result.store)
    flash(`${centre.name} deleted — nothing on the books was tagged to it.`)
    if (openCentre === centre.id) setOpenCentre('')
  }

  // ── splits ───────────────────────────────────────────────────────────────────

  function openSplit(sheet: DocSheet) {
    setSplit(splitOf(sheet.doc, store.allocations.find(a => a.id === sheet.key) || null))
  }

  function patchSplit(patch: Partial<SplitState>) {
    setSplit(s => (s ? { ...s, ...patch } : s))
  }

  const splitAlloc = split ? toAllocation(split) : null
  // The preview is the engine's own arithmetic, run on the draft — what the screen shows is what
  // gets stored, and what gets stored is only the percentages.
  const splitPreview = useMemo(() => {
    if (!split || !splitAlloc) return null
    const [sheet] = sheets({ docs: [split.doc], allocations: [splitAlloc], centres: store.centres })
    return { sheet, problems: validateAllocation(splitAlloc, store.centres) }
  }, [split, splitAlloc, store.centres])

  function saveSplit() {
    if (!split || !splitAlloc) return
    const result = setAllocation(orgId, splitAlloc, store.centres)
    if (!result.ok) { warn(result.error); return }
    setStore(result.store)
    const label = split.doc.number || DOC_KIND_META[split.doc.kind].label
    flash(splitAlloc.parts.length
      ? `${label} split ${pct(totalShare(splitAlloc.parts))} across ${splitAlloc.parts.length} centre${splitAlloc.parts.length === 1 ? '' : 's'} — the rest stays unassigned.`
      : `${label} is unassigned again.`)
    setSplit(null)
  }

  function clearTag(sheet: DocSheet) {
    setStore(removeAllocation(orgId, sheet.key))
    flash(`${sheet.doc.number || DOC_KIND_META[sheet.kind].label} is unassigned — no rupees were touched, only the tag.`)
  }

  function tagAllUnassigned() {
    if (!bulkCentre) { warn('Pick the centre to tag them against'); return }
    if (!picked.length) { warn('Select at least one document to tag'); return }
    const result = bulkAssign(orgId, bulkCentre, picked, bulkShare, docs)
    setStore(result.store)
    setPicked([])
    const centre = centreById.get(bulkCentre)?.name || 'the centre'
    flash(result.assigned
      ? `${result.assigned} document${result.assigned === 1 ? '' : 's'} tagged to ${centre}${result.skipped ? ` — ${result.skipped} already carrying a split were left exactly as they were` : ''}.`
      : `Nothing was tagged — ${result.skipped} document${result.skipped === 1 ? ' already' : 's already'} carr${result.skipped === 1 ? 'ies' : 'y'} a split, and a bulk action will not flatten one.`)
  }

  const [bulkCentre, setBulkCentre] = useState('')
  const [bulkShare, setBulkShare] = useState(100)

  // ── export ───────────────────────────────────────────────────────────────────

  function exportCentres() {
    download(`taxflow-cost-centres-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(CENTRE_CSV_HEADERS, centreCsvRows(visibleCentres)))
  }
  function exportDocuments() {
    download(`taxflow-cost-centre-documents-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(ALLOC_CSV_HEADERS, allocationCsvRows(visibleSheets)))
  }
  function exportCentreSheet(v: CentreView) {
    download(`taxflow-${v.centre.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-shares.csv`,
      toCsv(SHARE_CSV_HEADERS, shareCsvRows(periodSheets, v.centre.id)))
  }

  // ── the screen ───────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the books for a centre split…</div>
  }

  const noDocs = docs.length === 0
  const liveCentres = store.centres.filter(c => !c.archived)

  return (
    <div className="page-container cc" style={{ maxWidth: 1180 }}>
      <PageHeader
        eyebrow={`${orgName.toUpperCase() || 'TAXFLOW'} · ${period === 'all' ? 'ALL TIME' : `FY ${fyLabel(period === 'this_fy' ? base : base - 1)}`}`}
        title="Cost centres"
        subtitle="Which part of the business earned this, and which part spent it. A split stores a percentage against the document — the rupees are read back from the books every time this page opens, so nothing here can drift away from them."
        actions={
          <>
            <Button variant="ghost" size="sm" icon="download" onClick={exportCentres} disabled={visibleCentres.length === 0}>Centres CSV</Button>
            <Button variant="ghost" size="sm" icon="download" onClick={exportDocuments} disabled={visibleSheets.length === 0}>Splits CSV</Button>
            <Button icon="plus" onClick={() => openEditor(newCentre(), true)}>New centre</Button>
          </>
        }
      />

      <div className="cc-stats">
        <StatCard
          label="Rupees placed with a centre" value={money(tracked)}
          sub={`${pct(sum.revenue_coverage_pct)} of revenue · ${pct(sum.cost_coverage_pct)} of spending covered`}
          icon="layers" tone="blue" delay={0}
        />
        <StatCard
          label="Nobody’s rupees" value={money(untracked)}
          sub={free.length ? `${free.length} document${free.length === 1 ? '' : 's'} carry no centre` : 'every document in view has a centre'}
          icon={free.length ? 'alert' : 'check'} tone={free.length ? 'amber' : 'green'} delay={40}
        />
        <StatCard
          label="Strongest centre" value={sum.top ? sum.top.centre.name : '—'}
          sub={sum.top ? `${money(sum.top.contribution)} contribution · ${sum.top.docs} document${sum.top.docs === 1 ? '' : 's'}` : 'nothing tagged yet'}
          icon="trend" tone={sum.top ? 'violet' : 'grey'} delay={80}
        />
        <StatCard
          label="Things to check" value={String(attention.centres.length + attention.sheets.length + attention.orphans.length)}
          sub={attention.orphans.length
            ? `${attention.centres.length + attention.sheets.length} findings · ${attention.orphans.length} orphan tag${attention.orphans.length === 1 ? '' : 's'}`
            : `${attention.centres.length + attention.sheets.length} finding${attention.centres.length + attention.sheets.length === 1 ? '' : 's'}`}
          icon={attention.centres.length + attention.sheets.length ? 'shield' : 'check'}
          tone={attention.centres.length + attention.sheets.length ? 'red' : 'green'} delay={120}
        />
      </div>

      <div className="cc-toolbar">
        <Segmented options={TABS} value={tab} onChange={v => setTab(v as Tab)} />
        {tab === 'centres' && (
          <label className="cc-select">
            <span>Sort</span>
            <select className="tf-input" value={sort} onChange={e => setSort(e.target.value as CentreSort)}>
              {CENTRE_SORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        )}
        {(tab === 'documents' || tab === 'unassigned') && (
          <Segmented options={SIDES} value={side} onChange={v => { setSide(v as Side); setPicked([]) }} />
        )}
        <select className="tf-input cc-period" value={period} onChange={e => setPeriod(e.target.value as Period)} aria-label="Period">
          {PERIODS.map(p => <option key={p.value} value={p.value}>{p.label === 'all' ? 'All time' : `${p.label} · FY ${fyLabel(p.value === 'this_fy' ? base : base - 1)}`}</option>)}
        </select>
        <SearchInput value={search} onChange={setSearch} placeholder="Centre, code, document or party…"
          ariaLabel="Search cost centres" style={{ flex: '1 1 200px', maxWidth: 300, marginLeft: 'auto' }} />
      </div>

      {notice && (
        <div className={`cc-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
          <Icon name={notice.bad ? 'alert' : 'check'} size={14} strokeWidth={notice.bad ? 2.2 : 2.4} />
          <span>{notice.msg}</span>
          <button type="button" className="cc-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {error && (
        <div className="cc-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{error}</div>
      )}

      {noDocs && (
        <div className="cc-note">
          <Icon name="alert" size={14} strokeWidth={2.2} />
          <span>
            There is nothing in the books to split — no invoice, bill or expense this centre could be given a share of.
            A cost centre is a way of reading trade that exists, so start at <Link href="/invoices">invoices</Link> or <Link href="/bills">bills</Link>.
          </span>
        </div>
      )}

      {!homeState && (
        <div className="cc-note">
          <Icon name="shield" size={13} strokeWidth={2.2} />
          <span>
            No primary GSTIN on record, so the register cannot tell a branch in <em>another</em> state from one in your own —
            the rule 41A flags below therefore say “if”, not “is”. Set the registration at <Link href="/settings">settings</Link> and this page reads the difference.
          </span>
        </div>
      )}

      {liveCentres.length === 0 && tab !== 'centres' && (
        <div className="cc-note">
          <Icon name="layers" size={14} />
          <span>The register has no centre yet, so nothing can be tagged. <button type="button" className="cc-inline" onClick={() => openEditor(newCentre(), true)}>Add the first one</button>.</span>
        </div>
      )}

      {/* ── Centres ──────────────────────────────────────────────────────────── */}
      {tab === 'centres' && (
        visibleCentres.length === 0 ? (
          <Card>
            <EmptyState
              icon="layers"
              title={store.centres.length ? 'No centre in this search' : 'No cost centre yet'}
              message={store.centres.length
                ? 'Clear the search to see the whole register.'
                : 'A centre is any part of the business you want revenue and spending split by — a depot, a department, a project, a branch. Nothing is charged to it until a document is split against it.'}
              action={!store.centres.length
                ? <Button size="sm" icon="plus" onClick={() => openEditor(newCentre(), true)}>New centre</Button>
                : undefined}
            />
          </Card>
        ) : (
          <div className="cc-grid">
            {visibleCentres.map(v => {
              const c = v.centre
              const open = openCentre === c.id
              const shares = periodSheets.filter(s => s.parts.some(p => p.centre_id === c.id))
              return (
                <div key={c.id} className={`cc-card ${c.archived ? 'is-archived' : ''} ${v.problems.length ? 'is-flagged' : ''}`}>
                  <div className="cc-card-head">
                    <div className="cc-card-title">
                      <span className="cc-card-name"><Icon name="layers" size={15} />{c.name}</span>
                      <span className="cc-card-sub">
                        {KIND_META[c.kind].label}{c.code ? ` · ${c.code}` : ''}
                        {c.state ? ` · ${stateName(c.state)}` : ''}{c.gstin ? ` · ${c.gstin}` : ''}
                      </span>
                    </div>
                    <div className="cc-card-badges">
                      {KIND_META[c.kind].statutory && <Badge tone="violet" dot={false}>Statutory kind</Badge>}
                      {c.archived && <Badge tone="grey" dot={false}>Archived</Badge>}
                      {v.docs > 0 && !c.archived && <Badge tone="blue" dot={false}>{v.docs} doc{v.docs === 1 ? '' : 's'}</Badge>}
                    </div>
                  </div>

                  <div className="cc-bars">
                    <div className="cc-bar-row">
                      <span className="cc-bar-label">Revenue</span>
                      <ProgressBar value={v.share_of_revenue} color="var(--brand)" height={6} />
                      <span className="cc-bar-num">{pct(v.share_of_revenue)}</span>
                    </div>
                    <div className="cc-bar-row">
                      <span className="cc-bar-label">Spending</span>
                      <ProgressBar value={v.share_of_cost} color="var(--cyan)" height={6} />
                      <span className="cc-bar-num">{pct(v.share_of_cost)}</span>
                    </div>
                  </div>

                  <div className="cc-card-stats">
                    <StatRow label="Revenue tagged" value={v.revenue ? money(v.revenue) : '—'} />
                    <StatRow label="Tax collected on it" value={v.tax_collected ? money(v.tax_collected) : '—'} />
                    <StatRow label="Spending tagged" value={v.cost ? money(v.cost) : '—'} />
                    <StatRow label="ITC tagged" value={v.itc ? money(v.itc) : '—'} />
                    <StatRow label="Contribution" tone={v.contribution >= 0 ? 'green' : 'red'} value={money(v.contribution)} strong />
                  </div>

                  {v.largest && (
                    <p className="cc-largest">
                      <Icon name="invoice" size={12} />
                      Biggest share: {v.largest.label} — {money(v.largest.total)}
                    </p>
                  )}

                  {v.problems.length > 0 && (
                    <ul className="cc-problems">
                      {v.problems.map(p => (
                        <li key={p}>
                          <Icon name="alert" size={12} strokeWidth={2.2} />
                          <span>
                            {p.replace(' (see /gst/gstr9)', '')}
                            {p.includes('/gst/gstr9') && <> — <Link href="/gst/gstr9">GSTR-9 workpaper →</Link></>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {open && (
                    <div className="cc-shares">
                      {shares.length === 0 ? (
                        <p className="cc-shares-empty">No document carries a share to this centre.</p>
                      ) : shares.map(s => {
                        const mine = s.parts.filter(p => p.centre_id === c.id)
                        return (
                          <div key={s.key} className="cc-share-row">
                            <span className="cc-share-what">
                              <span className="cc-share-name">{s.doc.number || DOC_KIND_META[s.kind].label}</span>
                              <span className="cc-share-sub">{formatDateIN(s.doc.date)} · {s.doc.party || DOC_KIND_META[s.kind].party}</span>
                            </span>
                            <span className="cc-share-right">
                              <span className="cc-share-pct">{pct(round2(mine.reduce((t, p) => t + p.share, 0)))}</span>
                              <span className="cc-share-sub">{money(round2(mine.reduce((t, p) => t + p.total, 0)))}</span>
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  <div className="cc-card-foot">
                    <Button variant="ghost" size="sm" icon="list" onClick={() => setOpenCentre(open ? '' : c.id)}>
                      {open ? 'Hide shares' : `${shares.length} share${shares.length === 1 ? '' : 's'}`}
                    </Button>
                    <span className="cc-card-actions">
                      <Button variant="ghost" size="sm" icon="download" title={`Export ${c.name}’s shares`}
                        onClick={() => exportCentreSheet(v)} disabled={shares.length === 0} style={{ width: 32, padding: 0 }}>{' '}</Button>
                      <Button variant="ghost" size="sm" icon="edit" title={`Edit ${c.name}`}
                        onClick={() => openEditor({ ...c }, false)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                      <Button variant="ghost" size="sm" icon="undo" title={c.archived ? `Reopen ${c.name}` : `Archive ${c.name}`}
                        onClick={() => archive(c)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                      <Button variant="danger" size="sm" icon="x" title={`Delete ${c.name}`}
                        onClick={() => removeCentre(c)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )
      )}

      {/* ── Documents ────────────────────────────────────────────────────────── */}
      {tab === 'documents' && (
        <div className="cc-section">
          <div className="cc-section-head">
            <h2><Icon name="filter" size={15} />Every document in view</h2>
            <span className="cc-section-sub">
              {openCentre ? `Filtered to ${centreById.get(openCentre)?.name || 'a centre'} — ` : ''}
              Split a document to give centres a percentage of it. {splitSheets.length} of {sideSheets.filter(s => !s.orphan).length} carry a centre.
            </span>
            {openCentre && (
              <Button variant="ghost" size="sm" icon="x" onClick={() => setOpenCentre('')} style={{ marginLeft: 'auto' }}>Clear centre</Button>
            )}
          </div>

          {visibleSheets.length === 0 ? (
            <Card><EmptyState icon="filter" title="No document here"
              message="Widen the period, the side, or the search — a document only appears once it is in the books." /></Card>
          ) : (
            <div className="table-frame">
              <div className="responsive-table">
                <div className="table-header cc-row cc-head">
                  <span data-label="Date">Date</span>
                  <span data-label="Document">Document / party</span>
                  <span data-label="Value">Taxable</span>
                  <span data-label="Placed">Placed</span>
                  <span data-label="Split">Split</span>
                  <span data-label="Left">Unassigned</span>
                  <span className="cc-right" data-label="Actions">Actions</span>
                </div>
                {visibleSheets.map(s => (
                  <div key={s.key} className={`table-row cc-row ${s.orphan ? 'is-dim' : ''} ${s.problems.length ? 'is-flagged' : ''}`}>
                    <span data-label="Date" className="cc-mono">
                      {s.orphan ? <Badge tone="grey" dot={false}>orphan</Badge> : formatDateIN(s.doc.date)}
                    </span>
                    <span data-label="Document" className="cc-what">
                      <span className="cc-name">{s.doc.number || DOC_KIND_META[s.kind].label}</span>
                      <span className="cc-sub">{DOC_KIND_META[s.kind].label} · {s.doc.party || DOC_KIND_META[s.kind].party}</span>
                    </span>
                    <span data-label="Value" className={`cc-num ${s.orphan ? '' : 'cc-right'}`}>{s.orphan ? '—' : money(s.doc.taxable)}</span>
                    <span data-label="Placed" className="cc-placed">
                      {s.orphan ? '—' : (
                        <>
                          <ProgressBar value={Math.min(100, s.allocated_pct)} color={s.allocated_pct > 100 ? 'var(--red)' : s.parts.length ? 'var(--green)' : 'var(--faint)'} height={6} />
                          <span className="cc-sub">{pct(s.allocated_pct)}</span>
                        </>
                      )}
                    </span>
                    <span data-label="Split" className="cc-splits">
                      {s.parts.length === 0 ? <span className="cc-blank">nobody’s</span> : s.parts.map(p => (
                        <span key={p.centre_id} className={`cc-chip ${p.centre ? '' : 'is-ghost'}`}>
                          {p.name}{p.share !== 100 ? ` ${pct(p.share)}` : ''}
                          <span className="cc-chip-rupee">{money(p.total)}</span>
                        </span>
                      ))}
                    </span>
                    <span data-label="Left" className={`cc-num cc-right ${s.unallocated.total && !s.orphan ? 'is-hot' : ''}`}>
                      {s.orphan ? '—' : money(s.unallocated.total)}
                    </span>
                    <span data-label="Actions" className="cc-actions">
                      {s.orphan ? (
                        <Button variant="ghost" size="sm" icon="x" title="Forget this tag — the document is gone"
                          onClick={() => clearTag(s)}>Forget</Button>
                      ) : (
                        <Button variant="ghost" size="sm" icon={s.parts.length ? 'edit' : 'plus'}
                          onClick={() => openSplit(s)}>{s.parts.length ? 'Re-split' : 'Split'}</Button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {visibleSheets.some(s => s.problems.length) && (
            <div className="cc-note is-hot">
              <Icon name="alert" size={14} strokeWidth={2.2} />
              <span>{visibleSheets.filter(s => s.problems.length).length} document{visibleSheets.filter(s => s.problems.length).length === 1 ? '' : 's'} in this view have a split worth reading again — the row carries the reason, and the <button type="button" className="cc-inline" onClick={() => setTab('attention')}>To check</button> tab lists them together.</span>
            </div>
          )}
        </div>
      )}

      {/* ── To assign ────────────────────────────────────────────────────────── */}
      {tab === 'unassigned' && (
        <div className="cc-section">
          <div className="cc-section-head">
            <h2><Icon name="plus" size={15} />Documents no centre has been given a share of</h2>
            <span className="cc-section-sub">
              Unassigned rupees are the number a spreadsheet loses: they exist in the books and appear in nobody’s contribution.
              Tag a run of them at once, or split one document across several centres.
            </span>
          </div>

          {free.length === 0 ? (
            <Card><EmptyState icon="check" title="Everything in view has a centre"
              message={`${side === 'all' ? 'Not a rupee is unassigned' : side === 'outward' ? 'No outward document is unassigned' : 'No spending document is unassigned'} in this period. Widen the period to check the rest.`} /></Card>
          ) : (
            <>
              <div className="cc-bulk">
                <label className="cc-select">
                  <span>Tag the selected documents to</span>
                  <select className="tf-input" value={bulkCentre} onChange={e => setBulkCentre(e.target.value)}>
                    <option value="">Choose a centre…</option>
                    {liveCentres.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <label className="cc-select">
                  <span>Share</span>
                  <input className="tf-input" type="number" min="1" max="100" step="any" value={bulkShare}
                    onChange={e => setBulkShare(Math.min(100, Math.max(0, Number(e.target.value) || 0)))} />
                </label>
                <div className="cc-bulk-actions">
                  <Button variant="ghost" size="sm" icon="check"
                    onClick={() => setPicked(picked.length === free.length ? [] : free.map(s => s.key))}>
                    {picked.length === free.length ? 'Clear selection' : `Select all ${free.length}`}
                  </Button>
                  <Button size="sm" icon="tag" onClick={tagAllUnassigned} disabled={!bulkCentre || picked.length === 0}>
                    Tag {picked.length || 0} document{picked.length === 1 ? '' : 's'}
                  </Button>
                </div>
                <span className="cc-bulk-total">{money(round2(free.reduce((t, s) => t + s.doc.total, 0)))} sitting unassigned</span>
              </div>

              <div className="table-frame">
                <div className="responsive-table">
                  <div className="table-header cc-row2 cc-head">
                    <span data-label="">✓</span>
                    <span data-label="Date">Date</span>
                    <span data-label="Document">Document / party</span>
                    <span className="cc-right" data-label="Taxable">Taxable</span>
                    <span className="cc-right" data-label="Total">Total</span>
                    {side === 'inward' && <span data-label="ITC">ITC</span>}
                    <span className="cc-right" data-label="Split">Split</span>
                  </div>
                  {free.map(s => {
                    const on = picked.includes(s.key)
                    return (
                      <div key={s.key} className={`table-row cc-row2 ${on ? 'is-picked' : ''}`}>
                        <span data-label="Pick">
                          <input type="checkbox" checked={on} aria-label={`Select ${s.doc.number || DOC_KIND_META[s.kind].label}`}
                            onChange={() => setPicked(p => (p.includes(s.key) ? p.filter(k => k !== s.key) : [...p, s.key]))} />
                        </span>
                        <span data-label="Date" className="cc-mono">{formatDateIN(s.doc.date)}</span>
                        <span data-label="Document" className="cc-what">
                          <span className="cc-name">{s.doc.number || DOC_KIND_META[s.kind].label}</span>
                          <span className="cc-sub">{DOC_KIND_META[s.kind].label} · {s.doc.party || DOC_KIND_META[s.kind].party}</span>
                        </span>
                        <span className="cc-num cc-right" data-label="Taxable">{money(s.doc.taxable)}</span>
                        <span className="cc-num cc-right" data-label="Total">{money(s.doc.total)}</span>
                        {side === 'inward' && <span className="cc-num" data-label="ITC">{s.doc.itc ? money(s.doc.itc) : '—'}</span>}
                        <span className="cc-right" data-label="Split">
                          <span className="cc-row-actions">
                            <Button variant="ghost" size="sm" icon="plus" onClick={() => openSplit(s)}>Split…</Button>
                          </span>
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── To check ─────────────────────────────────────────────────────────── */}
      {tab === 'attention' && (
        <div className="cc-section">
          <div className="cc-section-head">
            <h2><Icon name="shield" size={15} />Findings on the register</h2>
            <span className="cc-section-sub">
              Each one is something the page can see and cannot decide: a split past 100%, a share pointing at a deleted centre,
              a tag whose document is gone, a branch that raises a registration question.
            </span>
          </div>

          {attention.centres.length + attention.sheets.length + attention.orphans.length === 0 ? (
            <Card><EmptyState icon="check" title="Nothing to check"
              message="Every split adds up, every centre on a share is still on the register, and no branch is asking a registration question. This stays quiet — it is not a place to look for work that does not exist." /></Card>
          ) : (
            <div className="cc-issues">
              {attention.centres.map(v => (
                <div key={v.centre.id} className="cc-issue">
                  <div className="cc-issue-head">
                    <Icon name="layers" size={14} />
                    <span className="cc-issue-title">{v.centre.name}</span>
                    <Badge tone="red" dot={false}>{KIND_META[v.centre.kind].label}</Badge>
                    <Button variant="ghost" size="sm" icon="edit" onClick={() => openEditor({ ...v.centre }, false)}
                      style={{ marginLeft: 'auto' }}>Edit centre</Button>
                  </div>
                  <ul className="cc-problems is-modal">
                    {v.problems.map(p => (
                      <li key={p}><Icon name="alert" size={12} strokeWidth={2.2} />
                        <span>{p.replace(' (see /gst/gstr9)', '')}{p.includes('/gst/gstr9') && <> — <Link href="/gst/gstr9">GSTR-9 workpaper →</Link></>}</span></li>
                    ))}
                  </ul>
                </div>
              ))}

              {attention.sheets.map(s => (
                <div key={s.key} className="cc-issue">
                  <div className="cc-issue-head">
                    <Icon name="invoice" size={14} />
                    <span className="cc-issue-title">{s.doc.number || DOC_KIND_META[s.kind].label}</span>
                    <Badge tone="amber" dot={false}>{DOC_KIND_META[s.kind].label}</Badge>
                    <span className="cc-sub">{formatDateIN(s.doc.date)} · {pct(s.allocated_pct)} placed</span>
                    <Button variant="ghost" size="sm" icon="edit" onClick={() => openSplit(s)}
                      style={{ marginLeft: 'auto' }}>Re-split</Button>
                  </div>
                  <ul className="cc-problems is-modal">
                    {s.problems.map(p => <li key={p}><Icon name="alert" size={12} strokeWidth={2.2} /><span>{p}</span></li>)}
                  </ul>
                </div>
              ))}

              {attention.orphans.length > 0 && (
                <div className="cc-issue">
                  <div className="cc-issue-head">
                    <Icon name="undo" size={14} />
                    <span className="cc-issue-title">{attention.orphans.length} orphan tag{attention.orphans.length === 1 ? '' : 's'}</span>
                    <Badge tone="grey" dot={false}>no rupees</Badge>
                  </div>
                  <ul className="cc-problems is-modal">
                    <li>
                      <Icon name="alert" size={12} strokeWidth={2.2} />
                      <span>A share outlived the document it was made against. It is kept and labelled rather than dropped quietly, because deleting the bill should not silently delete what the register said about it — and it adds nothing to any centre, because the rupees are gone.</span>
                    </li>
                    {attention.orphans.map(s => (
                      <li key={s.key}>
                        <Icon name="x" size={12} strokeWidth={2.2} />
                        <span>{s.doc.number || DOC_KIND_META[s.kind].label} · {s.parts.map(p => `${p.name} ${pct(p.share)}`).join(' · ')}</span>
                        <Button variant="ghost" size="sm" icon="x" onClick={() => clearTag(s)} style={{ marginLeft: 'auto' }}>Forget</Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── The two boundaries, in the reader's terms ─────────────────────────── */}
      <div className="cc-bounds">
        <div className="cc-note">
          <Icon name="shield" size={13} strokeWidth={2.2} />
          <span>
            <strong>A cost centre is not a legal person.</strong> Nothing on this page reaches a return, and no tax figure is invented here.
            The statutory questions a split of the business can raise — a branch in another state with no GSTIN of its own (rule 41A),
            inputs used partly for something else (rules 42 and 43) — are flagged with a link to the{' '}
            <Link href="/gst/gstr9">GSTR-9 / 9C workpaper</Link>, where reversals are actually computed.
          </span>
        </div>
        <div className="cc-note">
          <Icon name="book" size={13} strokeWidth={2.2} />
          <span>
            <strong>This page never writes to the books.</strong> A split stores only percentages, in this browser, against a document’s own id;
            the rupees are re-read from <Link href="/invoices">invoices</Link>, <Link href="/credit-notes">credit notes</Link>,{' '}
            <Link href="/debit-notes">debit notes</Link>, <Link href="/bills">bills</Link> and <Link href="/expenses">expenses</Link> on every load.
            Amend a bill tomorrow and this centre’s contribution changes with it, because nothing here was ever entered.
          </span>
        </div>
        <div className="cc-note">
          <Icon name="briefcase" size={13} strokeWidth={2.2} />
          <span>
            <strong>A centre splits a document; a project collects them.</strong> A cost centre — even one whose kind reads “Project / job” — answers
            “which part of the business is this rupee in?” by holding a percentage of one invoice or bill, and it knows nothing about hours.
            If what you are tracking is a job — the time it took, the documents it earned, the month of
            delivered work that still has no invoice — that belongs at <Link href="/projects">Projects &amp; time</Link>.
            The two read the same books and never write to them.
          </span>
        </div>
      </div>

      <div className="cc-foot">
        <span>
          {store.centres.length} centre{store.centres.length === 1 ? '' : 's'} · {sum.tagged} of {sum.docs} document{sum.docs === 1 ? '' : 's'} split
          {sum.orphans ? ` · ${sum.orphans} orphan tag${sum.orphans === 1 ? '' : 's'}` : ''} · stored in this browser under taxflow:ccentres
        </span>
        <span className="cc-foot-links">
          <Link href="/accounting">Financial statements →</Link>
          <Link href="/reports">Reports →</Link>
          <Link href="/projects">Projects &amp; time →</Link>
          <Link href="/gst/gstr9">GSTR-9 workpaper →</Link>
          <Link href="/inventory/godowns">Godowns →</Link>
        </span>
      </div>

      {/* ── Centre editor ─────────────────────────────────────────────────────── */}
      {editor && (
        <div className="cc-scrim" role="dialog" aria-modal="true"
          aria-label={editor.isNew ? 'Add cost centre' : `Edit ${editor.centre.name}`}>
          <div className="cc-modal" style={{ maxWidth: 560 }}>
            <div className="cc-modal-head">
              <div>
                <h2>{editor.isNew ? 'Add cost centre' : `Edit ${editor.centre.name}`}</h2>
                <p>A centre is any part of the business you want revenue and spending split by. It is a label on a share, not an account — it holds no money of its own.</p>
              </div>
              <button type="button" className="cc-close" onClick={() => setEditor(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {editorError && (
              <div className="cc-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{editorError}</div>
            )}

            <div className="cc-grid2">
              <label className="cc-field">
                <span>Name *</span>
                <input className="tf-input" value={editor.centre.name} onChange={e => patchEditor({ name: e.target.value })}
                  placeholder="North depot" autoFocus />
              </label>
              <label className="cc-field">
                <span>Code</span>
                <input className="tf-input" value={editor.centre.code} onChange={e => patchEditor({ code: e.target.value })}
                  placeholder="CC-01" />
              </label>
            </div>

            <label className="cc-field">
              <span>What kind of centre *</span>
              <select className="tf-input" style={{ cursor: 'pointer' }} value={editor.centre.kind}
                onChange={e => patchEditor({ kind: e.target.value as CostCentre['kind'] })}>
                {Object.entries(KIND_META).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}
              </select>
              <span className="cc-hint">{KIND_META[editor.centre.kind].note}</span>
            </label>

            <div className="cc-grid2">
              <label className="cc-field">
                <span>State</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value={editor.centre.state}
                  onChange={e => patchEditor({ state: e.target.value })}>
                  <option value="">Not recorded</option>
                  {INDIAN_STATES.map(s => <option key={s.value} value={s.value}>{s.value} — {s.label}</option>)}
                </select>
              </label>
              <label className="cc-field">
                <span>Its own GSTIN</span>
                <input className="tf-input" value={editor.centre.gstin} onChange={e => patchEditor({ gstin: e.target.value })}
                  placeholder="27AAAAA0000A1Z5" style={{ fontFamily: 'ui-monospace, Menlo, monospace' }} />
              </label>
            </div>

            {homeState && editor.centre.kind === 'branch' && editor.centre.state && editor.centre.state !== homeState && !editor.centre.gstin && (
              <div className="cc-note is-hot">
                <Icon name="shield" size={13} strokeWidth={2.2} />
                <span>
                  {stateName(editor.centre.state)} is not the {stateName(homeState)} this GSTIN is registered in, and the branch has no GSTIN of its own.
                  That is a rule 41A question — saving this records the flag on the register, it does not compute anything. Reversals belong on the{' '}
                  <Link href="/gst/gstr9">GSTR-9 workpaper</Link>.
                </span>
              </div>
            )}

            <label className="cc-field">
              <span>Notes</span>
              <textarea className="tf-input" rows={2} value={editor.centre.notes}
                onChange={e => patchEditor({ notes: e.target.value })}
                placeholder="Which line it covers, who runs it, what it is not…" style={{ resize: 'vertical' }} />
            </label>

            <div className="cc-preview">
              <div className="cc-preview-head">
                <span>What saving writes</span>
                <span className="cc-preview-total">{editor.centre.name.trim() || 'unnamed'}</span>
              </div>
              <ul className="cc-preview-list">
                <li>A centre on the register in this browser<span className="cc-preview-take">{KIND_META[editor.centre.kind].label}</span></li>
                <li>Nothing charged, nothing debited<span className="cc-preview-take">₹0</span></li>
                <li>Rupees arrive only when a document is split against it<span className="cc-preview-take">{sum.tagged} split{sum.tagged === 1 ? '' : 's'} today</span></li>
              </ul>
              {editorProblems.length > 0 && (
                <ul className="cc-problems is-modal">
                  {editorProblems.map(p => <li key={p}><Icon name="alert" size={12} strokeWidth={2.2} /><span>{p}</span></li>)}
                </ul>
              )}
            </div>

            <div className="cc-save">
              <Button variant="ghost" onClick={() => setEditor(null)}>Cancel</Button>
              <Button icon="check" onClick={saveCentre} disabled={editorProblems.length > 0}>
                {editor.isNew ? 'Add centre' : 'Save changes'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Split a document ─────────────────────────────────────────────────── */}
      {split && splitPreview && (
        <div className="cc-scrim" role="dialog" aria-modal="true" aria-label={`Split ${split.doc.number || 'document'}`}>
          <div className="cc-modal" style={{ maxWidth: 620 }}>
            <div className="cc-modal-head">
              <div>
                <h2>Split {split.doc.number || DOC_KIND_META[split.doc.kind].label}</h2>
                <p>
                  {DOC_KIND_META[split.doc.kind].label} · {formatDateIN(split.doc.date)} · {split.doc.party || DOC_KIND_META[split.doc.kind].party} —{' '}
                  {money(split.doc.taxable)} taxable, {money(split.doc.total)} all-in{split.doc.itc ? `, ${money(split.doc.itc)} of ITC` : ''}.
                  Shares are percentages of this one document; they cannot add past 100%.
                </p>
              </div>
              <button type="button" className="cc-close" onClick={() => setSplit(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {splitPreview.problems.length > 0 && (
              <div className="cc-alert" role="alert">
                <Icon name="alert" size={14} strokeWidth={2.2} />
                <span>{splitPreview.problems[0]}</span>
              </div>
            )}

            {split.parts.map((p, i) => (
              <div key={`${p.centre_id || 'row'}-${i}`} className="cc-part">
                <select className="tf-input" style={{ cursor: 'pointer' }} value={p.centre_id}
                  aria-label={`Centre ${i + 1}`}
                  onChange={e => patchSplit({ parts: split.parts.map((x, j) => (j === i ? { ...x, centre_id: e.target.value } : x)) })}>
                  <option value="">Choose a centre…</option>
                  {store.centres.map(c => <option key={c.id} value={c.id} disabled={c.archived && c.id !== p.centre_id}>
                    {c.name}{c.archived ? ' (archived)' : ''} · {KIND_META[c.kind].label}
                  </option>)}
                </select>
                <input className="tf-input cc-part-share" type="number" min="0" max="100" step="0.01" value={p.share}
                  aria-label={`Share ${i + 1}`} placeholder="%"
                  onChange={e => patchSplit({ parts: split.parts.map((x, j) => (j === i ? { ...x, share: e.target.value } : x)) })} />
                <span className="cc-part-rupee">{money(round2(split.doc.total * ((Number(p.share) || 0) / 100)))}</span>
                <button type="button" className="cc-part-x" aria-label={`Remove centre ${i + 1}`}
                  onClick={() => patchSplit({ parts: split.parts.filter((_, j) => j !== i) })}>
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}

            <div className="cc-part-actions">
              <Button variant="ghost" size="sm" icon="plus"
                onClick={() => patchSplit({ parts: [...split.parts, { centre_id: '', share: '' }] })}>
                Another centre
              </Button>
              {split.parts.length > 1 && (
                <Button variant="ghost" size="sm" icon="target"
                  title="Give the whole document to the first centre"
                  onClick={() => patchSplit({ parts: [split.parts[0].centre_id ? { ...split.parts[0], share: '100' } : split.parts[0] ].filter(p => p.centre_id) })}>
                  All to the first
                </Button>
              )}
            </div>

            <label className="cc-field">
              <span>Note on this split</span>
              <input className="tf-input" value={split.note} onChange={e => patchSplit({ note: e.target.value })}
                placeholder="Why it is split this way…" />
            </label>

            <div className="cc-preview">
              <div className="cc-preview-head">
                <span>This is what gets written</span>
                <span className="cc-preview-total">{pct(splitPreview.sheet.allocated_pct)} placed</span>
              </div>
              <ul className="cc-preview-list">
                {splitPreview.sheet.parts.length === 0 && <li>No centre named yet — saving unassigns this document</li>}
                {splitPreview.sheet.parts.map((p, i) => (
                  <li key={`${p.centre_id}-${i}`}>
                    <span className={`cc-dot ${p.centre ? 'cc-dot-blue' : 'cc-dot-amber'}`} />
                    {p.name} — {pct(p.share)} of the document
                    <span className="cc-preview-take">{money(p.total)}</span>
                  </li>
                ))}
                {round2(Math.abs(splitPreview.sheet.unallocated.total)) !== 0 && (
                  <li>
                    <span className="cc-dot cc-dot-grey" />
                    Unassigned remainder, printed rather than lost
                    <span className="cc-preview-take">{money(splitPreview.sheet.unallocated.total)}</span>
                  </li>
                )}
                <li>
                  <span className="cc-dot cc-dot-green" />
                  Σ parts + remainder always equals the document
                  <span className="cc-preview-take">{money(split.doc.total)}</span>
                </li>
                <li>
                  <span className="cc-dot cc-dot-violet" />
                  Stored as percentages only
                  <span className="cc-preview-take">{docKey(split.doc.kind, split.doc.id).slice(0, 18)}…</span>
                </li>
              </ul>
              <div className="cc-basis">
                <Icon name="shield" size={13} strokeWidth={2.2} />
                <span>
                  {split.doc.kind === 'credit_note'
                    ? 'This is a credit note: the shares run backwards with it, so a centre given 60% of the sale also carries 60% of the reversal.'
                    : split.doc.taxable < 0
                      ? 'A negative document splits negative rupees — the share follows the money, not the other way round.'
                      : 'Nothing is charged here. The document keeps its rupees; the centres are given a percentage of them, and a branch never becomes a legal person by being named.'}
                </span>
              </div>
            </div>

            <div className="cc-save">
              <Button variant="ghost" onClick={() => setSplit(null)}>Cancel</Button>
              <Button icon="check" onClick={saveSplit} disabled={splitPreview.problems.length > 0}>
                {splitPreview.sheet.parts.length ? 'Save split' : 'Unassign document'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .cc-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .cc-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .cc-period { width: auto; max-width: 210px; cursor: pointer; font-size: 12.5px; }
        .cc-select { display: flex; flex-direction: column; gap: 4px; }
        .cc-select > span { font-size: 11px; font-weight: 600; color: var(--faint); }
        .cc-select .tf-input { width: 210px; cursor: pointer; }

        .cc-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px;
          font-size: 12.5px; color: var(--green); background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 10px; }
        .cc-notice svg { flex-shrink: 0; }
        .cc-notice.is-bad { color: var(--amber); background: var(--amber-soft);
          border-color: color-mix(in srgb, var(--amber) 26%, white); }
        .cc-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; border-radius: 6px; min-height: 0; }
        .cc-notice-x:hover { background: rgba(0,0,0,0.05); }

        .cc-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px; margin-bottom: 12px;
          padding: 10px 12px; background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .cc-alert svg { flex-shrink: 0; }

        .cc-note { display: flex; align-items: flex-start; gap: 7px; padding: 9px 12px; border-radius: 10px;
          font-size: 12px; color: var(--muted); background: var(--surface-2); border: 1px solid var(--line-soft); line-height: 1.55; }
        .cc-note svg { flex-shrink: 0; margin-top: 2px; }
        .cc-note a { color: var(--brand); }
        .cc-note strong { color: var(--ink-2); font-weight: 650; }
        .cc-note.is-hot { color: var(--red); background: var(--red-soft); border-color: color-mix(in srgb, var(--red) 22%, white); }
        .cc-note.is-hot a, .cc-note.is-hot strong { color: inherit; }
        .cc-inline { background: none; border: none; color: var(--brand); cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
        .cc-bounds { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 22px; }

        .cc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
        .cc-card { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--brand);
          border-radius: var(--radius-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-xs); }
        .cc-card.is-archived { background: var(--surface-2); border-left-color: var(--faint); opacity: 0.9; }
        .cc-card.is-flagged { border-left-color: var(--red); }
        .cc-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .cc-card-title { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .cc-card-name { display: flex; align-items: center; gap: 7px; font-size: 14.5px; font-weight: 650; color: var(--ink); overflow-wrap: anywhere; }
        .cc-card-name svg { color: var(--brand); flex-shrink: 0; }
        .cc-card-sub { font-size: 11.5px; color: var(--faint); line-height: 1.5; }
        .cc-card-badges { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
        .cc-card-stats { display: flex; flex-direction: column; }
        .cc-card-stats > div:last-child { border-bottom: none; }

        .cc-bars { display: flex; flex-direction: column; gap: 6px; }
        .cc-bar-row { display: grid; grid-template-columns: 78px minmax(0, 1fr) 54px; gap: 8px; align-items: center; }
        .cc-bar-label { font-size: 11px; color: var(--faint); }
        .cc-bar-num { font-size: 11.5px; font-weight: 650; color: var(--ink-2); text-align: right; font-variant-numeric: tabular-nums; }
        .cc-largest { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 11.5px; color: var(--muted); }
        .cc-largest svg { color: var(--faint); flex-shrink: 0; }

        .cc-problems { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .cc-problems li { display: flex; align-items: flex-start; gap: 6px; font-size: 11.5px; line-height: 1.5;
          color: var(--amber); background: var(--amber-soft); border-radius: 8px; padding: 7px 9px; }
        .cc-problems li svg { flex-shrink: 0; margin-top: 1px; }
        .cc-problems li a { color: var(--brand); }
        .cc-problems.is-modal { margin-top: 8px; }

        .cc-shares { border-top: 1px dashed var(--line); padding-top: 9px; display: flex; flex-direction: column; gap: 5px; }
        .cc-shares-empty { font-size: 12px; color: var(--faint); margin: 0; }
        .cc-share-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center;
          padding: 6px 8px; background: var(--surface-2); border-radius: 9px; }
        .cc-share-what, .cc-share-right { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .cc-share-right { align-items: flex-end; }
        .cc-share-name { font-size: 12px; font-weight: 600; color: var(--ink-2); overflow-wrap: anywhere; }
        .cc-share-pct { font-size: 12px; font-weight: 650; color: var(--ink); font-variant-numeric: tabular-nums; }
        .cc-share-sub { font-size: 10.5px; color: var(--faint); }

        .cc-card-foot { display: flex; align-items: center; gap: 8px; margin-top: auto; flex-wrap: wrap; }
        .cc-card-actions { display: flex; gap: 6px; margin-left: auto; }

        .cc-section { margin-top: 4px; display: flex; flex-direction: column; gap: 10px; }
        .cc-section-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
        .cc-section-head h2 { display: flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 650; color: var(--ink); margin: 0; }
        .cc-section-head h2 svg { color: var(--brand); }
        .cc-section-sub { font-size: 11.5px; color: var(--faint); max-width: 720px; line-height: 1.5; }

        .cc-row { display: grid; gap: 10px; align-items: center; padding: 11px 14px; font-size: 12.5px;
          grid-template-columns: 96px minmax(0, 1.2fr) 100px 120px minmax(0, 1.5fr) 100px 92px; }
        .cc-row2 { display: grid; gap: 10px; align-items: center; padding: 10px 14px; font-size: 12.5px;
          grid-template-columns: 26px 96px minmax(0, 1.4fr) 110px 110px minmax(0, 1fr) 96px; }
        .cc-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .cc-row.is-dim { opacity: 0.72; }
        .cc-row.is-flagged { box-shadow: inset 3px 0 0 var(--amber); }
        .cc-row2.is-picked { background: var(--brand-soft); }
        .cc-right { text-align: right; justify-content: flex-end; }
        .cc-num { font-variant-numeric: tabular-nums; color: var(--ink-2); }
        .cc-num.is-hot { color: var(--amber); font-weight: 650; }
        .cc-mono { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; }
        .cc-sub { font-size: 10.5px; color: var(--faint); line-height: 1.4; }
        .cc-name { font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
        .cc-what { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .cc-blank { color: var(--faint); font-size: 11.5px; }
        .cc-placed { display: flex; align-items: center; gap: 7px; }
        .cc-splits { display: flex; flex-wrap: wrap; gap: 5px; }
        .cc-chip { display: inline-flex; align-items: baseline; gap: 6px; padding: 4px 8px; border-radius: 8px;
          font-size: 11.5px; background: var(--brand-soft); color: var(--brand); }
        .cc-chip.is-ghost { background: var(--amber-soft); color: var(--amber); }
        .cc-chip-rupee { font-variant-numeric: tabular-nums; color: var(--ink-2); font-weight: 600; }
        .cc-actions, .cc-row-actions { display: flex; gap: 6px; justify-content: flex-end; }

        .cc-bulk { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; padding: 11px 13px;
          background: var(--surface-2); border: 1px solid var(--line-soft); border-radius: 12px; }
        .cc-bulk-actions { display: flex; gap: 6px; }
        .cc-bulk-total { margin-left: auto; font-size: 12px; font-weight: 650; color: var(--amber); font-variant-numeric: tabular-nums; }

        .cc-issues { display: flex; flex-direction: column; gap: 10px; }
        .cc-issue { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg);
          padding: 13px 15px; display: flex; flex-direction: column; gap: 8px; box-shadow: var(--shadow-xs); }
        .cc-issue-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .cc-issue-head svg { color: var(--brand); flex-shrink: 0; }
        .cc-issue-title { font-size: 13.5px; font-weight: 650; color: var(--ink); overflow-wrap: anywhere; }

        .cc-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          font-size: 11.5px; color: var(--faint); margin-top: 16px; }
        .cc-foot-links { display: flex; gap: 12px; flex-wrap: wrap; }
        .cc-foot-links a { color: var(--brand); text-decoration: none; }

        .cc-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .cc-modal { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg);
          padding: 1.4rem 1.5rem; width: 100%; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 11px; }
        .cc-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .cc-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .cc-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; max-width: 480px; line-height: 1.55; }
        .cc-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px;
          border-radius: 6px; flex-shrink: 0; min-height: 0; }
        .cc-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .cc-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
        .cc-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .cc-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .cc-field select.tf-input { cursor: pointer; }
        .cc-hint { font-size: 11px; color: var(--faint); line-height: 1.5; }

        .cc-part { display: grid; grid-template-columns: minmax(0, 1fr) 84px 96px 26px; gap: 8px; align-items: center; }
        .cc-part-share { text-align: right; font-variant-numeric: tabular-nums; }
        .cc-part-rupee { font-size: 12px; font-weight: 650; color: var(--ink); text-align: right; font-variant-numeric: tabular-nums; }
        .cc-part-x { background: none; border: none; color: var(--faint); cursor: pointer; padding: 5px; border-radius: 6px; min-height: 0; }
        .cc-part-x:hover { background: var(--red-soft); color: var(--red); }
        .cc-part-actions { display: flex; gap: 8px; flex-wrap: wrap; }

        .cc-preview { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--surface-2); }
        .cc-preview-head { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .cc-preview-total { color: var(--brand); font-variant-numeric: tabular-nums; }
        .cc-preview-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .cc-preview-list li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--ink-2); line-height: 1.5; flex-wrap: wrap; }
        .cc-preview-take { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 650; color: var(--ink); }
        .cc-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; }
        .cc-dot-red { background: var(--red); }
        .cc-dot-green { background: var(--green); }
        .cc-dot-blue { background: var(--brand); }
        .cc-dot-amber { background: var(--amber); }
        .cc-dot-violet { background: var(--violet); }
        .cc-dot-grey { background: var(--faint); }

        .cc-basis { display: flex; align-items: flex-start; gap: 7px; font-size: 11.5px; color: var(--muted); margin-top: 8px;
          background: var(--surface); border-left: 3px solid var(--brand); border-radius: 8px; padding: 8px 11px; line-height: 1.55; }
        .cc-basis svg { flex-shrink: 0; margin-top: 2px; color: var(--brand); }

        .cc-save { display: flex; gap: 10px; justify-content: flex-end; }

        @media (max-width: 1100px) { .cc-stats { grid-template-columns: 1fr 1fr; } .cc-bounds { grid-template-columns: 1fr; } }
        @media (max-width: 768px) {
          .cc-stats { grid-template-columns: 1fr 1fr; }
          .cc-grid { grid-template-columns: 1fr; }
          .cc-grid2, .cc-part { grid-template-columns: 1fr; gap: 8px; }
          .cc-part { background: var(--surface-2); border-radius: 10px; padding: 9px 10px; }
          .cc-part-rupee { text-align: left; }
          .cc-row, .cc-row2 { grid-template-columns: 1fr; gap: 6px; }
          .cc-head { display: none; }
          .cc-right { text-align: left; justify-content: flex-start; }
          .cc-placed { max-width: 220px; }
          .cc-bulk-total { margin-left: 0; }
          .cc-scrim { align-items: flex-end; padding: 0; }
          .cc-scrim .cc-modal { max-width: none !important; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .cc-save { flex-direction: column-reverse; }
          .cc-card-actions { margin-left: auto; }
        }
      `}</style>
    </div>
  )
}

export default function CostCentresPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <CostCentresPageInner />
    </Suspense>
  )
}
