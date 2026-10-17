'use client'

// Recurring invoices — the schedule register, and the button that catches the bills up.
//
// The engine (src/lib/recurring.ts) owns the model: a schedule is a bill template plus a
// cadence plus an end rule, and its calendar is derived from that rule at read time — due
// dates are never stored, so a March bill that nobody raised is still sitting there in
// April. Generating one goes through the same createInvoice() a typed invoice uses, dated
// on the period it covers, which lands it in the financial year it belongs to.
//
// The honest limit, printed on the page: nothing runs while the app is closed. There is no
// server worker posting invoices at midnight; the schedule accrues, and opening TaxFlow is
// what turns up the pile.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { INDIAN_STATES } from '@/lib/constants'
import { GST_RATES } from '@/lib/gst-rates'
import {
  calculateInvoiceTotals, calculateLineItem, determineGSTType, getFinancialYear,
} from '@/lib/gst-engine'
import { formatDateIN, plural, pluralNoun } from '@/lib/format'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import { createInvoice } from '@/lib/create-invoice'
import { isNetworkError, queueOfflineInvoice } from '@/lib/outbox'
import { isUsableLine, loadAllDocs, type FlowDoc, type FlowLine } from '@/lib/orderflow'
import {
  buildSchedulePayload, cadenceLine, deleteSchedule, END_MODES, emptySchedule, FREQUENCIES, frequencyOf,
  latestOccurrence, loadSchedules, occurrenceCsvRows, OCCURRENCE_CSV_HEADERS, occurrenceIndex,
  recordOccurrence, recurringCsvRows, RECURRING_CSV_HEADERS, rollup, scheduleFromDoc, scheduleViews,
  setStatus, sortViews, STATE_LABEL, todayISO, upsertSchedule, validateSchedule,
  type Schedule, type ScheduleState, type ScheduleView,
} from '@/lib/recurring'
import {
  Badge, Button, Card, EmptyState, PageHeader, ProgressBar, SearchInput, Segmented, StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'

type ViewFilter = ScheduleState | 'all'

const VIEWS: { value: ViewFilter; label: string }[] = [
  { value: 'due', label: 'Due now' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
]

const STATE_TONE: Record<ScheduleState, 'red' | 'blue' | 'amber' | 'green'> = {
  due: 'red', upcoming: 'blue', paused: 'amber', completed: 'green',
}

const SUPPLY_TYPES = [
  { value: 'b2b', label: 'B2B — registered customer' },
  { value: 'b2c', label: 'B2C — unregistered' },
  { value: 'export', label: 'Export / SEZ' },
]

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const money = (n: number) => `₹${inr.format(Math.round(Number(n) || 0))}`

interface CustomerRow {
  id: string
  name?: string
  gstin?: string
  state_code?: string
  address_line1?: string
  city?: string
  state?: string
  customer_type?: string
}

interface ProductRow {
  id: string
  name?: string
  hsn_sac?: string
  unit?: string
  selling_price?: number
  gst_rate?: number
  cess_rate?: number
}

// The editor keeps strings — a half-typed "12." is not a number yet — while the stored
// schedule keeps the canonical FlowLine shape the invoice builder expects.
interface DraftLine {
  product_id: string
  item_name: string
  hsn_sac: string
  quantity: string
  unit: string
  rate: string
  discount_percent: string
  gst_rate: string
  cess_rate: string
}

const emptyDraftLine = (): DraftLine => ({
  product_id: '', item_name: '', hsn_sac: '', quantity: '1', unit: 'MONTH',
  rate: '', discount_percent: '0', gst_rate: '18', cess_rate: '0',
})

const num = (v: string) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function toFlowLine(l: DraftLine): FlowLine {
  return {
    product_id: l.product_id || null,
    item_name: l.item_name.trim(),
    hsn_sac: l.hsn_sac.trim(),
    quantity: num(l.quantity),
    unit: l.unit || 'NOS',
    rate: num(l.rate),
    discount_percent: num(l.discount_percent),
    gst_rate: num(l.gst_rate),
    cess_rate: num(l.cess_rate),
  }
}

function toDraftLine(l: FlowLine): DraftLine {
  return {
    product_id: l.product_id || '',
    item_name: l.item_name,
    hsn_sac: l.hsn_sac,
    quantity: String(l.quantity),
    unit: l.unit,
    rate: String(l.rate),
    discount_percent: String(l.discount_percent),
    gst_rate: String(l.gst_rate),
    cess_rate: String(l.cess_rate),
  }
}

interface EditorState { s: Schedule; isNew: boolean }
interface GenerateState { id: string; queue: string[]; raised: { number: string; date: string; queued: boolean }[] }

function RecurringPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [orgStateCode, setOrgStateCode] = useState('')
  const [customers, setCustomers] = useState<CustomerRow[]>([])
  const [products, setProducts] = useState<ProductRow[]>([])
  const [orders, setOrders] = useState<FlowDoc[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(true)

  const [search, setSearch] = useSearchDeepLink()
  const [view, setView] = useState<ViewFilter>('due')
  const [openTrail, setOpenTrail] = useState('')
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [draftLines, setDraftLines] = useState<DraftLine[]>([])
  const [editorError, setEditorError] = useState('')

  const [gen, setGen] = useState<GenerateState | null>(null)
  const [genError, setGenError] = useState('')
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id, organizations(name, state_code)')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { router.push('/setup'); return }
      const oid = membership.organization_id
      setOrgId(oid)
      setOrgName((membership.organizations as { name?: string } | null)?.name || '')

      let stateCode = (membership.organizations as { state_code?: string } | null)?.state_code || ''
      const { data: gstReg } = await supabase
        .from('gst_registrations')
        .select('state_code')
        .eq('organization_id', oid)
        .eq('is_primary', true)
        .single()
      if (gstReg?.state_code) stateCode = gstReg.state_code
      setOrgStateCode(stateCode)

      const [{ data: customerRows }, { data: prods }] = await Promise.all([
        supabase.from('customers').select('*').eq('organization_id', oid).eq('is_active', true).order('name'),
        supabase.from('products').select('*').eq('organization_id', oid).eq('is_active', true).order('name'),
      ])
      setCustomers((customerRows || []) as CustomerRow[])
      setProducts((prods || []) as ProductRow[])

      // An order or challan already drawn up is the fastest way to build a schedule.
      setOrders(loadAllDocs(oid).filter(d =>
        (d.kind === 'sales_order' || d.kind === 'challan') && d.status !== 'cancelled'))

      const stored = loadSchedules(oid)
      setSchedules(stored)

      // ?new=1 — the palette's "New recurring invoice" lands here with the editor open.
      // Set inline: a function defined later in the component cannot be called from here.
      if (searchParams.get('new') === '1') {
        setEditor({ s: emptySchedule(), isNew: true })
        setDraftLines([emptyDraftLine()])
        setEditorError('')
      }
      // Land on the work pile when there is one; otherwise show the whole register.
      const workable = stored.some(s => validateSchedule(s).length === 0)
      setView(workable ? 'due' : 'all')
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const today = todayISO()
  const views = useMemo(() => scheduleViews(schedules, orgStateCode, today), [schedules, orgStateCode, today])
  const roll = useMemo(() => rollup(views), [views])

  /** What the page adds to the library's check: a bill needs a real customer row. */
  function blockers(v: ScheduleView): string[] {
    const extra = v.s.party_id ? [] : ['Pick the registered customer this bills — a typed name is not enough']
    return [...v.problems, ...extra]
  }

  const visible = useMemo(() => sortViews(views.filter(v =>
    (view === 'all' || v.state === view) &&
    matchesAny(search, [v.s.name, v.s.party_name, v.s.party_gstin, v.cadence]))), [views, view, search])

  /** The editor's live figures — the same engine the generated bill runs through, so the
   *  preview on screen cannot disagree with the invoice it produces. */
  const editorCalcs = useMemo(() => {
    if (!editor) return null
    const flow = draftLines.map(toFlowLine)
    const gstType = determineGSTType(orgStateCode, editor.s.place_of_supply, editor.s.supply_type)
    const results = flow.map(l => calculateLineItem({
      quantity: l.quantity, rate: l.rate, discount_percent: l.discount_percent,
      gst_rate: l.gst_rate, cess_rate: l.cess_rate,
    }, gstType))
    const usable = results.filter((_, i) => isUsableLine(flow[i]))
    return { results, gstType, totals: usable.length ? calculateInvoiceTotals(usable) : null }
  }, [editor, draftLines, orgStateCode])

  function flash(message: string) { setNotice({ msg: message, bad: false }) }
  function warn(message: string) { setNotice({ msg: message, bad: true }) }

  // ── the editor ─────────────────────────────────────────────────────────────
  function openEditor(s: Schedule, isNew: boolean) {
    setEditor({ s, isNew })
    setDraftLines(s.lines.length ? s.lines.map(toDraftLine) : [emptyDraftLine()])
    setEditorError('')
  }

  function patchEditor(patch: Partial<Schedule>) {
    setEditor(e => (e ? { ...e, s: { ...e.s, ...patch } } : e))
  }

  function patchLine(index: number, field: keyof DraftLine, value: string) {
    setDraftLines(prev => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)))
  }

  function addLine() { setDraftLines(prev => [...prev, emptyDraftLine()]) }
  function removeLine(index: number) {
    setDraftLines(prev => (prev.length === 1 ? [emptyDraftLine()] : prev.filter((_, i) => i !== index)))
  }

  function handleCustomer(partyId: string) {
    if (!partyId) { patchEditor({ party_id: null, party_name: '' }); return }
    const c = customers.find(x => x.id === partyId)
    if (!c) return
    patchEditor({
      party_id: c.id,
      party_name: c.name || '',
      party_gstin: c.gstin || '',
      party_address: [c.address_line1, c.city, c.state].filter(Boolean).join(', '),
      party_state: c.state_code || '',
      place_of_supply: c.state_code || '',
      supply_type: c.customer_type || 'b2b',
    })
  }

  function handleProduct(index: number, productId: string) {
    const p = products.find(x => x.id === productId)
    if (!p) { patchLine(index, 'product_id', ''); return }
    setDraftLines(prev => prev.map((l, i) => (i === index ? {
      ...l,
      product_id: productId,
      item_name: p.name || '',
      hsn_sac: p.hsn_sac || '',
      unit: p.unit || 'NOS',
      rate: String(p.selling_price ?? ''),
      gst_rate: String(p.gst_rate ?? 18),
      cess_rate: String(p.cess_rate ?? 0),
    } : l)))
  }

  /** Bring a party and its lines in from an order or challan already on the books. */
  function seedFromOrder(docId: string) {
    const doc = orders.find(d => d.id === docId)
    if (!doc || !editor) return
    const seeded = scheduleFromDoc(doc, editor.s.name || `${doc.number} — ${doc.party_name}`)
    patchEditor({ ...seeded, id: editor.s.id, created_at: editor.s.created_at,
      occurrences: editor.s.occurrences, name: editor.s.name || seeded.name })
    setDraftLines(seeded.lines.length ? seeded.lines.map(toDraftLine) : [emptyDraftLine()])
    setEditorError('')
  }

  function saveSchedule() {
    if (!editor) return
    const draft: Schedule = { ...editor.s, lines: draftLines.map(toFlowLine) }
    const problems = validateSchedule(draft)
    if (problems.length) { setEditorError(problems.join(' · ')); return }
    setSchedules(upsertSchedule(orgId, draft))
    flash(editor.isNew
      ? `${draft.name} is on the register. Its first bill is dated ${draft.anchor_date}.`
      : `${draft.name} updated — the change applies to bills raised from now on.`)
    setEditor(null)
    setEditorError('')
  }

  function togglePause(v: ScheduleView) {
    const next = v.s.status === 'active' ? 'paused' : 'active'
    setSchedules(setStatus(orgId, v.s.id, next))
    flash(next === 'paused'
      ? `${v.s.name} paused — nothing further accrues while it is held.`
      : `${v.s.name} is running again.`)
  }

  function remove(v: ScheduleView) {
    if (v.raised > 0) {
      // The serial-register rule: a schedule that wrote books stays on the record.
      warn(`${v.s.name} has raised ${plural(v.raised, 'invoice')}. Those bills are in your books, `
        + 'so the schedule that produced them stays on the record — pause it instead.')
      return
    }
    if (!confirm(`Delete ${v.s.name}? Nothing has been billed from it, so no invoice is left behind.`)) return
    const result = deleteSchedule(orgId, v.s.id)
    if (!result.ok) { warn(result.error); return }
    setSchedules(result.schedules)
    flash(`${v.s.name} removed from the register.`)
  }

  // ── generating ─────────────────────────────────────────────────────────────
  function openGenerate(v: ScheduleView) {
    const blocked = blockers(v)
    if (blocked.length) { warn(blocked[0]); return }
    setGen({ id: v.s.id, queue: [...v.due], raised: [] })
    setGenError('')
  }

  async function raiseOldest() {
    if (!gen || gen.queue.length === 0) return
    const v = views.find(x => x.s.id === gen.id)
    const date = gen.queue[0]
    if (!v || !v.s) return

    setGenerating(true)
    setGenError('')
    try {
      const { invoiceFields, items } = buildSchedulePayload(v.s, orgStateCode, date)
      const total = Number(invoiceFields.grand_total) || 0

      let written: { invoice_id: string; invoice_number: string; queued: boolean }
      if (!navigator.onLine) {
        const entry = queueOfflineInvoice(orgId, invoiceFields, items)
        written = { invoice_id: '', invoice_number: entry.tempNumber, queued: true }
      } else {
        try {
          const created = await createInvoice(supabase, orgId, invoiceFields, items)
          written = { invoice_id: created.invoiceId, invoice_number: created.invoiceNumber, queued: false }
        } catch (err) {
          // The connection went mid-save — the bill is too good to lose.
          const message = err instanceof Error ? err.message : String(err)
          if (!isNetworkError(message)) throw err
          const entry = queueOfflineInvoice(orgId, invoiceFields, items)
          written = { invoice_id: '', invoice_number: entry.tempNumber, queued: true }
        }
      }

      const res = recordOccurrence(orgId, v.s.id, {
        date, invoice_id: written.invoice_id, invoice_number: written.invoice_number,
        total, queued: written.queued,
      }, today)
      if (!res.ok) { setGenError(res.error); return }

      setSchedules(res.schedules)
      setGen({ ...gen, queue: gen.queue.slice(1),
        raised: [...gen.raised, { number: written.invoice_number, date, queued: written.queued }] })
      if (written.queued) flash(`${formatDateIN(date)} queued in the outbox as ${written.invoice_number} — it syncs when the device is back online.`)
      else flash(`${formatDateIN(date)} billed as ${written.invoice_number}.`)
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  const genView = gen ? views.find(v => v.s.id === gen.id) || null : null
  const genDate = gen?.queue[0] || ''
  const genFigures = useMemo(() => {
    if (!genView || !genDate) return null
    try {
      const { invoiceFields } = buildSchedulePayload(genView.s, orgStateCode, genDate)
      return invoiceFields
    } catch {
      return null
    }
  }, [genView, genDate, orgStateCode])
  /** A bill dated in the past belongs to a period that may already have been filed. */
  const genBackdated = Boolean(genDate && genDate < today)
  const genOtherFy = Boolean(genDate && getFinancialYear(new Date(genDate)) !== getFinancialYear(new Date(today)))

  function exportCsv() {
    download(`taxflow-recurring-${today}.csv`, toCsv(RECURRING_CSV_HEADERS, recurringCsvRows(visible)))
  }

  function exportTrail() {
    const rows = schedules.flatMap(s => occurrenceCsvRows(s))
    download(`taxflow-recurring-bills-${today}.csv`, toCsv(OCCURRENCE_CSV_HEADERS, rows))
  }

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the recurring register…</div>
  }

  const dueSchedules = views.filter(v => v.due.length > 0).length

  return (
    <div className="page-container ri" style={{ maxWidth: 1180 }}>
      <PageHeader
        eyebrow={`${orgName.toUpperCase() || 'SALES'} · BILLS THAT COME BACK`}
        title="Recurring invoices"
        subtitle="Retainers, rent, subscriptions, AMC — one template, one cadence, and every period it has owed since you set it up shows up here waiting to be raised."
        actions={
          <>
            <Button variant="ghost" size="sm" icon="download" onClick={exportCsv} disabled={visible.length === 0}>CSV</Button>
            <Button variant="ghost" size="sm" icon="list" onClick={exportTrail}
              disabled={schedules.every(s => s.occurrences.length === 0)}>Bill trail</Button>
            <Button icon="plus" onClick={() => openEditor(emptySchedule(), true)}>New schedule</Button>
          </>
        }
      />

      <div className="ri-stats">
        <StatCard
          label="Due to raise" value={String(roll.dueCount)}
          sub={roll.dueCount ? `${money(roll.dueValue)} waiting · across ${plural(dueSchedules, 'schedule')}` : 'every period so far has been billed'}
          icon={roll.dueCount ? 'alert' : 'check'} tone={roll.dueCount ? 'red' : 'green'} delay={0}
        />
        <StatCard
          label="Raised from schedules" value={money(roll.raisedValue)}
          sub={roll.raised ? `${plural(roll.raised, 'invoice')} so far` : 'nothing billed yet'}
          icon="invoice" tone="cyan" delay={40}
        />
        <StatCard
          label="Running schedules" value={String(roll.active)}
          sub={`${roll.paused} paused${roll.completed ? ` · ${roll.completed} completed` : ''}`}
          icon="repeat" tone="violet" delay={80}
        />
        <StatCard
          label="≈ Monthly run-rate" value={money(roll.runRate)}
          sub="What the live schedules bill in a month, whichever cadence they run on"
          icon="chart" tone="blue" delay={120}
        />
      </div>

      <div className="ri-note">
        <Icon name="alert" size={13} strokeWidth={2.2} />
        <span>
          Nothing bills itself while TaxFlow is closed — there is no server posting invoices at midnight.
          A schedule <em>accrues</em>: open this page and every period that has come due is here, dated on the day
          it belonged to, ready to raise. Missed a quarter? It is still waiting, and it still lands in that
          quarter&apos;s books.
        </span>
      </div>

      <div className="ri-toolbar">
        <Segmented options={VIEWS} value={view} onChange={v => setView(v as ViewFilter)} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Customer, schedule or cadence…"
          ariaLabel="Search recurring schedules"
          style={{ flex: '1 1 240px', maxWidth: 320, marginLeft: 'auto' }}
        />
      </div>

      {notice && (
        <div className={`ri-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
          <Icon name={notice.bad ? 'alert' : 'check'} size={14} strokeWidth={notice.bad ? 2.2 : 2.4} />
          <span>{notice.msg}</span>
          <button type="button" className="ri-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon="repeat"
            title={schedules.length > 0 ? 'Nothing in this view' : 'No recurring invoices yet'}
            message={schedules.length > 0
              ? 'Clear the search or pick another view to see the rest of the register.'
              : 'Pick a customer, lay out the lines once, and choose how often they should be billed. Rent on the 1st, an AMC every quarter, a retainer every month — each period then arrives here with its own invoice date.'}
            action={schedules.length > 0
              ? undefined
              : <Button size="sm" icon="plus" onClick={() => openEditor(emptySchedule(), true)}>New schedule</Button>}
          />
        </Card>
      ) : (
        <div className="ri-grid">
          {visible.map(v => {
            const s = v.s
            const blocked = blockers(v)
            const open = openTrail === s.id
            const last = latestOccurrence(s)
            return (
              <div key={s.id} className={`ri-card ${blocked.length ? 'has-problems' : ''} ${open ? 'is-open' : ''}`}>
                <div className="ri-card-head">
                  <div className="ri-card-title">
                    <span className="ri-card-name">
                      <Icon name="repeat" size={15} />
                      {s.name || 'Untitled schedule'}
                    </span>
                    <span className="ri-card-sub">
                      {s.party_name || 'no customer yet'}{s.party_gstin ? ` · ${s.party_gstin}` : ''}
                    </span>
                  </div>
                  <div className="ri-card-badges">
                    <Badge tone={STATE_TONE[v.state]} dot={false}>{STATE_LABEL[v.state]}</Badge>
                    {v.due.length > 0 && <Badge tone="red" dot={false}>{v.due.length} due</Badge>}
                    {s.status === 'paused' && <Badge tone="amber" dot={false}>Held</Badge>}
                  </div>
                </div>

                <p className="ri-cadence">
                  <Icon name="calendar" size={13} />
                  {v.cadence}
                  <span className="ri-cadence-end">
                    {v.endsOn ? ` · till ${formatDateIN(v.endsOn)}` : v.openEnded ? ' · open-ended' : ''}
                  </span>
                </p>

                <div className="ri-card-stats">
                  <StatRow label="Per invoice" value={v.perOccurrence ? money(v.perOccurrence) : '—'} strong />
                  <StatRow label="GST this bill" value={v.gstType === 'igst' ? 'IGST' : 'CGST + SGST'} />
                  <StatRow label="Raised" value={`${v.raised}${s.end_mode === 'count' ? ` / ${s.end_count}` : ''}`} />
                  <StatRow label="Next date" value={v.next ? formatDateIN(v.next) : '—'} />
                </div>

                {v.progress !== null && (
                  <div className="ri-progress">
                    <ProgressBar value={v.raised} max={s.end_count} color="var(--brand)" />
                    <span className="ri-share-label">
                      {v.raised} of {s.end_count} {pluralNoun(s.end_count, 'invoice')} · {Math.round(v.progress * 100)}% through the term
                    </span>
                  </div>
                )}

                {v.due.length > 0 && (
                  <div className="ri-due">
                    <Icon name="alert" size={13} strokeWidth={2.2} />
                    <span>
                      {v.due.length === 1
                        ? <><strong>{formatDateIN(v.due[0])}</strong> is still unbilled — {money(v.perOccurrence)} worth.</>
                        : <><strong>{formatDateIN(v.due[0])}</strong> and {v.due.length - 1} more {pluralNoun(v.due.length - 1, 'period')}
                          {' '}are unbilled — {money(v.due.length * v.perOccurrence)} worth.</>}
                    </span>
                  </div>
                )}

                {v.truncated && (
                  <div className="ri-flag">
                    This cadence runs finer than the horizon the register projects — raise what is listed here and the
                    next dates arrive as the calendar moves.
                  </div>
                )}

                {blocked.length > 0 && (
                  <div className="ri-flag is-warn">
                    <Icon name="alert" size={12} strokeWidth={2.2} />
                    {blocked[0]}
                  </div>
                )}

                {open && (
                  <div className="ri-trail">
                    {s.occurrences.length === 0 ? (
                      <p className="ri-trail-empty">No invoice has come out of this schedule yet.</p>
                    ) : (
                      <>
                        <div className="ri-trail-head">Bills raised — newest period first</div>
                        {[...s.occurrences].reverse().map(o => (
                          <div key={o.date} className="ri-bill">
                            <span className="ri-bill-date">{formatDateIN(o.date)}</span>
                            {o.queued
                              ? <Badge tone="amber" dot={false}>{o.invoice_number} queued</Badge>
                              : (o.invoice_id
                                ? <Link className="ri-bill-link" href={`/invoices/${o.invoice_id}`}>{o.invoice_number} →</Link>
                                : <span className="ri-bill-link">{o.invoice_number}</span>)}
                            <span className="ri-bill-right">
                              <span className="ri-bill-total">{money(o.total)}</span>
                              <span className="ri-bill-seq">period {occurrenceIndex(s, o.date) + 1}</span>
                            </span>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}

                <div className="ri-card-foot">
                  <Button variant="ghost" size="sm" icon="list"
                    onClick={() => setOpenTrail(open ? '' : s.id)}>{open ? 'Hide bills' : 'See bills'}</Button>
                  <span className="ri-card-actions">
                    {v.due.length > 0 && blocked.length === 0 && (
                      <Button size="sm" icon="invoice" onClick={() => openGenerate(v)}>
                        {v.due.length === 1 ? 'Raise invoice' : `Raise ${v.due.length} bills`}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" icon="edit" title={`Edit ${s.name}`}
                      onClick={() => openEditor({ ...s }, false)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                    <Button variant="ghost" size="sm" icon={s.status === 'active' ? 'pause' : 'play'}
                      title={s.status === 'active' ? `Pause ${s.name}` : `Resume ${s.name}`}
                      onClick={() => togglePause(v)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                    <Button variant="danger" size="sm" icon="x" title={`Delete ${s.name}`}
                      onClick={() => remove(v)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                  </span>
                </div>

                {last && !open && (
                  <p className="ri-last">Last bill {last.invoice_number} for {formatDateIN(last.date)}</p>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="ri-foot">
        <span>
          {plural(schedules.length, 'schedule')} · {plural(roll.raised, 'invoice')} raised
          {roll.dueCount ? ` · ${roll.dueCount} still to bill` : ''}
        </span>
        <span className="ri-foot-links">
          <Link href="/invoices">Invoices →</Link>
          <Link href="/sales-orders">Sales orders →</Link>
          <Link href="/payments">Receivables →</Link>
        </span>
      </div>

      {/* ── the schedule editor ─────────────────────────────────────────────── */}
      {editor && (
        <div className="ri-scrim" role="dialog" aria-modal="true"
          aria-label={editor.isNew ? 'New recurring invoice' : `Edit ${editor.s.name}`}>
          <div className="ri-modal" style={{ maxWidth: 880 }}>
            <div className="ri-modal-head">
              <div>
                <h2>{editor.isNew ? 'New recurring invoice' : `Edit ${editor.s.name}`}</h2>
                <p>The lines below are copied into every bill the schedule raises — GST recomputed on the day it is generated.</p>
              </div>
              <button type="button" className="ri-close" onClick={() => setEditor(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {editorError && (
              <div className="ri-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{editorError}</div>
            )}

            {orders.length > 0 && (
              <label className="ri-field">
                <span>Start from an order or challan</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value=""
                  onChange={e => seedFromOrder(e.target.value)}>
                  <option value="">Blank schedule</option>
                  {orders.map(d => (
                    <option key={d.id} value={d.id}>
                      {d.number} · {d.party_name} · {plural(d.lines.filter(l => l.item_name).length, 'line')}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="ri-grid2">
              <label className="ri-field">
                <span>Name *</span>
                <input className="tf-input" value={editor.s.name}
                  onChange={e => patchEditor({ name: e.target.value })}
                  placeholder="AMC — Sunrise Traders" autoFocus />
              </label>
              <label className="ri-field">
                <span>Customer *</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value={editor.s.party_id || ''}
                  onChange={e => handleCustomer(e.target.value)}>
                  <option value="">Select customer…</option>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>{c.name}{c.gstin ? ` · ${c.gstin}` : ''}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="ri-grid3">
              <label className="ri-field">
                <span>Place of supply *</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value={editor.s.place_of_supply}
                  onChange={e => patchEditor({ place_of_supply: e.target.value })}>
                  <option value="">Select state…</option>
                  {INDIAN_STATES.map(st => <option key={st.value} value={st.value}>{st.value} — {st.label}</option>)}
                </select>
              </label>
              <label className="ri-field">
                <span>Supply type</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value={editor.s.supply_type}
                  onChange={e => patchEditor({ supply_type: e.target.value })}>
                  {SUPPLY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
              <label className="ri-field">
                <span>Payment terms (days)</span>
                <input className="tf-input" type="number" min="0" max="365" value={String(editor.s.due_in_days)}
                  onChange={e => patchEditor({ due_in_days: num(e.target.value) })} />
              </label>
            </div>

            {editor.s.place_of_supply && orgStateCode && (
              <div className={`ri-split ${isLocalSupply(editor.s.place_of_supply, orgStateCode) ? 'is-local' : 'is-inter'}`}>
                <Icon name="check" size={13} strokeWidth={2.6} />
                {isLocalSupply(editor.s.place_of_supply, orgStateCode)
                  ? 'Same state — each bill splits CGST + SGST'
                  : 'Interstate — each bill carries IGST'}
              </div>
            )}

            <div className="ri-rule">
              <div className="ri-rule-title">
                <Icon name="calendar" size={14} />
                How often, from when, till when
              </div>
              <div className="ri-grid3">
                <label className="ri-field">
                  <span>Cadence *</span>
                  <select className="tf-input" style={{ cursor: 'pointer' }} value={editor.s.frequency}
                    onChange={e => patchEditor({ frequency: e.target.value as Schedule['frequency'] })}>
                    {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </label>
                <label className="ri-field">
                  <span>Every</span>
                  <div className="ri-inline">
                    <input className="tf-input" type="number" min="1" max="365" value={String(editor.s.interval)}
                      onChange={e => patchEditor({ interval: Math.round(num(e.target.value)) })} />
                    <span className="ri-inline-unit">
                      {pluralNoun(editor.s.interval, frequencyOf(editor.s.frequency).unit)}
                    </span>
                  </div>
                </label>
                <label className="ri-field">
                  <span>First invoice date *</span>
                  <input className="tf-input" type="date" value={editor.s.anchor_date}
                    onChange={e => patchEditor({ anchor_date: e.target.value })} />
                </label>
              </div>
              <div className="ri-grid2">
                <label className="ri-field">
                  <span>End rule</span>
                  <select className="tf-input" style={{ cursor: 'pointer' }} value={editor.s.end_mode}
                    onChange={e => patchEditor({ end_mode: e.target.value as Schedule['end_mode'] })}>
                    {END_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </label>
                {editor.s.end_mode === 'count' && (
                  <label className="ri-field">
                    <span>Number of invoices *</span>
                    <input className="tf-input" type="number" min="1" value={String(editor.s.end_count)}
                      onChange={e => patchEditor({ end_count: Math.round(num(e.target.value)) })} />
                  </label>
                )}
                {editor.s.end_mode === 'date' && (
                  <label className="ri-field">
                    <span>Stop after *</span>
                    <input className="tf-input" type="date" value={editor.s.end_date}
                      onChange={e => patchEditor({ end_date: e.target.value })} />
                  </label>
                )}
              </div>
              <p className="ri-preview">
                {cadenceLine(editor.s)} — {editor.s.end_mode === 'never'
                  ? 'keeps repeating until paused'
                  : editor.s.end_mode === 'count'
                    ? `${editor.s.end_count} bills in all`
                    : `stops after ${editor.s.end_date || 'the date you set'}`}
              </p>
            </div>

            <div className="ri-lihead">
              <span className="ri-li-title">Lines on every bill *</span>
              <span className="ri-li-total">
                {money(editorCalcs?.totals?.grand_total ?? 0)} per invoice
              </span>
            </div>

            <div className="line-items-head ri-linehead">
              <span>Item *</span>
              <span>HSN/SAC</span>
              <span>Qty *</span>
              <span>Rate (₹)</span>
              <span>Disc %</span>
              <span>GST %</span>
              <span className="ri-right">Amount</span>
              <span></span>
            </div>

            {draftLines.map((l, i) => {
              const calc = editorCalcs?.results[i] ?? null
              return (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div className="line-item-row ri-linerow">
                    <div className="li-full" data-label="Item *">
                      <select className="tf-input" style={{ marginBottom: 4, cursor: 'pointer' }}
                        value={l.product_id} onChange={e => handleProduct(i, e.target.value)}>
                        <option value="">Select product…</option>
                        {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                      <input className="tf-input" value={l.item_name}
                        onChange={e => patchLine(i, 'item_name', e.target.value)}
                        placeholder="Or type the service, e.g. monthly maintenance" />
                    </div>
                    <div data-label="HSN/SAC">
                      <input className="tf-input" value={l.hsn_sac}
                        onChange={e => patchLine(i, 'hsn_sac', e.target.value)} placeholder="HSN/SAC" />
                    </div>
                    <div data-label="Qty *">
                      <input className="tf-input" type="number" value={l.quantity}
                        onChange={e => patchLine(i, 'quantity', e.target.value)} min="0" step="0.001" />
                    </div>
                    <div data-label="Rate (₹)">
                      <input className="tf-input" type="number" value={l.rate}
                        onChange={e => patchLine(i, 'rate', e.target.value)} placeholder="0.00" min="0" step="0.01" />
                    </div>
                    <div data-label="Disc %">
                      <input className="tf-input" type="number" value={l.discount_percent}
                        onChange={e => patchLine(i, 'discount_percent', e.target.value)} min="0" max="100" step="0.01" />
                    </div>
                    <div data-label="GST %">
                      <select className="tf-input" style={{ cursor: 'pointer' }} value={l.gst_rate}
                        onChange={e => patchLine(i, 'gst_rate', e.target.value)}>
                        {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                      </select>
                    </div>
                    <div data-label="Amount" className="ri-amount-cell">
                      {calc ? `₹${inr.format(Math.round(calc.total_amount))}` : '—'}
                    </div>
                    <div className="li-full" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Button variant="danger" size="sm" icon="x" disabled={draftLines.length === 1}
                        onClick={() => removeLine(i)} style={{ width: 32, height: 32, padding: 0 }}
                        title="Remove line">{' '}</Button>
                    </div>
                  </div>
                </div>
              )
            })}

            <div><Button variant="ghost" size="sm" icon="plus" onClick={addLine}>Add line</Button></div>

            <div className="ri-grid2">
              <label className="ri-field">
                <span>Notes (printed on each bill)</span>
                <textarea className="tf-input ri-area" value={editor.s.notes}
                  onChange={e => patchEditor({ notes: e.target.value })}
                  placeholder="Period covered, contract reference…" />
              </label>
              <label className="ri-field">
                <span>Terms</span>
                <textarea className="tf-input ri-area" value={editor.s.terms}
                  onChange={e => patchEditor({ terms: e.target.value })}
                  placeholder="Payable within 30 days…" />
              </label>
            </div>

            {!editor.isNew && editor.s.occurrences.length > 0 && (
              <div className="ri-note is-flat">
                <Icon name="shield" size={13} strokeWidth={2.2} />
                <span>
                  {plural(editor.s.occurrences.length, 'invoice')} already raised from this
                  schedule keep the figures they were billed with. Editing here changes only the bills raised from now on.
                </span>
              </div>
            )}

            <div className="ri-save">
              <Button variant="ghost" onClick={() => setEditor(null)}>Cancel</Button>
              <Button icon="check" onClick={saveSchedule}>
                {editor.isNew ? 'Add schedule' : 'Save changes'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── the catch-up run ───────────────────────────────────────────────── */}
      {gen && genView && (
        <div className="ri-scrim" role="dialog" aria-modal="true" aria-label={`Raise ${genView.s.name}`}>
          <div className="ri-modal" style={{ maxWidth: 560 }}>
            <div className="ri-modal-head">
              <div>
                <h2>{genView.s.name}</h2>
                <p>{genView.cadence} · {money(genView.perOccurrence)} a bill</p>
              </div>
              <button type="button" className="ri-close" onClick={() => setGen(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {genError && (
              <div className="ri-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{genError}</div>
            )}

            {gen.queue.length === 0 ? (
              <div className="ri-done">
                <Icon name="check" size={22} strokeWidth={2.4} />
                <h3>{plural(gen.raised.length, 'invoice')} raised</h3>
                <ul className="ri-done-list">
                  {gen.raised.map(r => (
                    <li key={r.number}>
                      <span>{formatDateIN(r.date)}</span>
                      <span className="ri-done-num">{r.number}{r.queued ? ' · queued offline' : ''}</span>
                    </li>
                  ))}
                </ul>
                <p className="ri-done-sub">
                  Each is dated on its own period and numbered in that period&apos;s series — the invoice register is
                  the tax record now.
                </p>
                <div className="ri-save">
                  <Button variant="ghost" onClick={() => { setGen(null); router.push('/invoices') }}>
                    Open invoices
                  </Button>
                  <Button icon="check" onClick={() => setGen(null)}>Done</Button>
                </div>
              </div>
            ) : (
              <>
                <div className="ri-queue-head">
                  <span>Bill {gen.raised.length + 1} of {gen.raised.length + gen.queue.length}</span>
                  <span className="ri-queue-rest">{gen.queue.length} still waiting</span>
                </div>

                <div className="ri-target">
                  <span className="ri-target-date">{formatDateIN(genDate)}</span>
                  <span className="ri-target-sub">invoice date — the period this bill covers</span>
                  <span className="ri-target-total">{genFigures ? money(Number(genFigures.grand_total) || 0) : ''}</span>
                </div>

                {genBackdated && (
                  <div className="ri-note is-warn">
                    <Icon name="alert" size={13} strokeWidth={2.2} />
                    <span>
                      {genOtherFy
                        ? `This date falls in ${getFinancialYear(new Date(genDate))}, not the running year — the bill will be numbered in that year's series and belong to that return.`
                        : 'The bill is dated in the past, so it sits in the period it covers rather than today — which is the point, but it changes figures you may already have filed.'}
                    </span>
                  </div>
                )}

                {genFigures && (
                  <div className="ri-figures">
                    <StatRow label="Taxable value" value={money(Number(genFigures.taxable_amount) || 0)} />
                    {Number(genFigures.cgst_amount) > 0 && (
                      <StatRow label="CGST" value={money(Number(genFigures.cgst_amount))} />)}
                    {Number(genFigures.sgst_amount) > 0 && (
                      <StatRow label="SGST" value={money(Number(genFigures.sgst_amount))} />)}
                    {Number(genFigures.igst_amount) > 0 && (
                      <StatRow label="IGST" value={money(Number(genFigures.igst_amount))} />)}
                    <StatRow label="Due date" value={genFigures.due_date ? formatDateIN(String(genFigures.due_date)) : 'On receipt'} />
                  </div>
                )}

                <div className="ri-queue">
                  {gen.queue.map((d, i) => (
                    <div key={d} className={`ri-queue-row ${i === 0 ? 'is-now' : ''}`}>
                      <Icon name={i === 0 ? 'invoice' : 'calendar'} size={12} />
                      <span>{formatDateIN(d)}</span>
                      <span className="ri-queue-amt">{money(genView.perOccurrence)}</span>
                    </div>
                  ))}
                </div>

                <div className="ri-save">
                  <Button variant="ghost" onClick={() => setGen(null)} disabled={generating}>Stop</Button>
                  <Button icon={generating ? undefined : 'invoice'} onClick={raiseOldest} disabled={generating}>
                    {generating ? 'Raising…' : `Raise ${formatDateIN(genDate)}`}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <style>{`
        .ri-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .ri-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }

        .ri-note { display: flex; align-items: flex-start; gap: 7px; padding: 10px 12px; border-radius: 10px;
          font-size: 12px; color: var(--muted); background: var(--surface-2); border: 1px solid var(--line-soft);
          line-height: 1.6; margin-bottom: 14px; }
        .ri-note svg { flex-shrink: 0; margin-top: 2px; }
        .ri-note em { font-style: normal; color: var(--ink); font-weight: 600; }
        .ri-note.is-warn { color: var(--amber); background: var(--amber-soft);
          border-color: color-mix(in srgb, var(--amber) 26%, white); }
        .ri-note.is-flat { margin-bottom: 0; }

        .ri-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px;
          font-size: 12.5px; color: var(--green); background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 10px; }
        .ri-notice svg { flex-shrink: 0; }
        .ri-notice.is-bad { color: var(--amber); background: var(--amber-soft);
          border-color: color-mix(in srgb, var(--amber) 26%, white); }
        .ri-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer;
          padding: 2px; border-radius: 6px; min-height: 0; }
        .ri-notice-x:hover { background: rgba(0,0,0,0.05); }

        .ri-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
        .ri-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg);
          padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-xs); }
        .ri-card.has-problems { border-color: color-mix(in srgb, var(--amber) 40%, white); }
        .ri-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .ri-card-title { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .ri-card-name { display: flex; align-items: center; gap: 7px; font-size: 14.5px; font-weight: 650;
          color: var(--ink); overflow-wrap: anywhere; }
        .ri-card-name svg { color: var(--brand); flex-shrink: 0; }
        .ri-card-sub { font-size: 11.5px; color: var(--faint); line-height: 1.5; overflow-wrap: anywhere; }
        .ri-card-badges { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }

        .ri-cadence { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12.5px;
          color: var(--ink-2); font-weight: 550; }
        .ri-cadence svg { color: var(--brand); flex-shrink: 0; }
        .ri-cadence-end { color: var(--faint); font-weight: 450; }

        .ri-card-stats { display: flex; flex-direction: column; }
        .ri-card-stats > div:last-child { border-bottom: none; }
        .ri-progress { display: flex; flex-direction: column; gap: 5px; }
        .ri-share-label { font-size: 11px; color: var(--faint); }

        .ri-due { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; color: var(--red);
          background: var(--red-soft); border-radius: 8px; padding: 8px 10px; line-height: 1.55; }
        .ri-due svg { flex-shrink: 0; margin-top: 2px; }
        .ri-due strong { font-variant-numeric: tabular-nums; }
        .ri-flag { font-size: 11.5px; color: var(--amber); background: var(--amber-soft);
          border-radius: 8px; padding: 8px 10px; line-height: 1.5; display: flex; align-items: flex-start; gap: 6px; }
        .ri-flag.is-warn { color: var(--amber); }
        .ri-flag svg { flex-shrink: 0; margin-top: 2px; }

        .ri-trail { border-top: 1px dashed var(--line); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
        .ri-trail-head { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .ri-trail-empty { font-size: 12px; color: var(--faint); margin: 0; }
        .ri-bill { display: grid; grid-template-columns: 92px minmax(0, 1fr) auto; gap: 8px; align-items: center;
          padding: 7px 9px; background: var(--surface-2); border-radius: 9px; font-size: 12px; }
        .ri-bill-date { font-variant-numeric: tabular-nums; color: var(--ink-2); font-weight: 600; }
        .ri-bill-link { color: var(--brand); text-decoration: none; overflow-wrap: anywhere; font-size: 11.5px; }
        .ri-bill-right { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
        .ri-bill-total { font-weight: 650; color: var(--ink); font-variant-numeric: tabular-nums; }
        .ri-bill-seq { font-size: 10.5px; color: var(--faint); }

        .ri-card-foot { display: flex; align-items: center; gap: 6px; margin-top: auto; }
        .ri-card-actions { display: flex; gap: 6px; margin-left: auto; align-items: center; }
        .ri-last { margin: 0; font-size: 11px; color: var(--faint); }

        .ri-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          font-size: 11.5px; color: var(--faint); margin-top: 18px; }
        .ri-foot-links { display: flex; gap: 12px; }
        .ri-foot-links a { color: var(--brand); text-decoration: none; }

        .ri-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .ri-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .ri-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .ri-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .ri-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; max-width: 470px; line-height: 1.5; }
        .ri-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px;
          border-radius: 6px; flex-shrink: 0; min-height: 0; }
        .ri-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .ri-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .ri-alert svg { flex-shrink: 0; }

        .ri-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
        .ri-grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; align-items: start; }
        .ri-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .ri-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .ri-area { height: 58px; resize: vertical; }
        .ri-inline { display: flex; align-items: center; gap: 8px; }
        .ri-inline .tf-input { flex: 1; }
        .ri-inline-unit { font-size: 12px; color: var(--faint); min-width: 62px; }

        .ri-split { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 8px; font-size: 12px; }
        .ri-split.is-local { background: var(--green-soft); color: var(--green); }
        .ri-split.is-inter { background: var(--violet-soft); color: var(--violet); }

        .ri-rule { border: 1px solid var(--line); border-radius: 12px; padding: 12px;
          display: flex; flex-direction: column; gap: 10px; background: var(--surface-2); }
        .ri-rule-title { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 650; color: var(--ink); }
        .ri-rule-title svg { color: var(--brand); }
        .ri-preview { margin: 0; font-size: 12px; color: var(--muted); }

        .ri-lihead { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-top: 4px; }
        .ri-li-title { font-size: 13px; font-weight: 650; color: var(--ink); }
        .ri-li-total { font-size: 12.5px; font-weight: 650; color: var(--brand); font-variant-numeric: tabular-nums; }
        .ri-linehead { display: grid; grid-template-columns: 2fr 1fr 0.8fr 1fr 0.7fr 0.7fr 1fr 36px; gap: 6px;
          margin-bottom: 6px; font-size: 11px; font-weight: 650; color: var(--faint);
          text-transform: uppercase; letter-spacing: 0.04em; }
        .ri-linerow { display: grid; grid-template-columns: 2fr 1fr 0.8fr 1fr 0.7fr 0.7fr 1fr 36px; gap: 6px; align-items: center; }
        .ri-right { text-align: right; }
        .ri-amount-cell { padding: 8px 10px; background: var(--surface-2); border: 1px solid var(--line);
          border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; color: var(--ink); text-align: right; }

        .ri-queue-head { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .ri-queue-rest { color: var(--red); text-transform: none; letter-spacing: 0; font-weight: 600; }
        .ri-target { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; border-radius: 12px;
          background: var(--brand-soft); border: 1px solid color-mix(in srgb, var(--brand) 22%, white); }
        .ri-target-date { font-size: 20px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
        .ri-target-sub { font-size: 11.5px; color: var(--muted); }
        .ri-target-total { font-size: 15px; font-weight: 650; color: var(--brand); font-variant-numeric: tabular-nums; margin-top: 4px; }
        .ri-figures { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
        .ri-queue { display: flex; flex-direction: column; gap: 4px; max-height: 168px; overflow-y: auto; }
        .ri-queue-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--faint);
          padding: 6px 9px; border-radius: 8px; }
        .ri-queue-row.is-now { background: var(--surface-2); color: var(--ink); font-weight: 600; }
        .ri-queue-row svg { flex-shrink: 0; }
        .ri-queue-amt { margin-left: auto; font-variant-numeric: tabular-nums; }

        .ri-done { display: flex; flex-direction: column; gap: 10px; text-align: center; align-items: center; }
        .ri-done > svg { color: var(--green); }
        .ri-done h3 { margin: 0; font-size: 16px; font-weight: 650; color: var(--ink); }
        .ri-done-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; width: 100%; }
        .ri-done-list li { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px;
          background: var(--surface-2); border-radius: 8px; padding: 8px 11px; }
        .ri-done-num { color: var(--brand); font-weight: 600; }
        .ri-done-sub { margin: 0; font-size: 11.5px; color: var(--faint); line-height: 1.55; }
        .ri-done .ri-save { width: 100%; }

        .ri-save { display: flex; gap: 10px; justify-content: flex-end; }

        @media (max-width: 1100px) { .ri-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .ri-stats { grid-template-columns: 1fr 1fr; }
          .ri-grid { grid-template-columns: 1fr; }
          .ri-grid2, .ri-grid3 { grid-template-columns: 1fr; }
          .ri-scrim { align-items: flex-end; padding: 0; }
          .ri-scrim .ri-modal { max-width: none !important; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .ri-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}

/** Local supply splits CGST + SGST; anywhere else the bill carries IGST. */
function isLocalSupply(placeOfSupply: string, orgStateCode: string): boolean {
  return placeOfSupply.slice(0, 2) === orgStateCode.slice(0, 2)
}

export default function RecurringPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <RecurringPageInner />
    </Suspense>
  )
}
