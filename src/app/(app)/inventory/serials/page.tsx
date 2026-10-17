'use client'

// Serial-number register — every unit by its own number: where it came from,
// who has it now, and whether it is still under warranty.
//
// The engine (src/lib/serials.ts) explains the domain: a serial is an identity,
// not a quantity (localStorage, ADR-013). One row per physical unit, forever —
// a return puts the unit back on the shelf instead of forking its history, the
// status comes from the latest recorded event (corrections are new events, not
// edits of the past), and the warranty window is derived from the latest sale.
// Unlike batches there is no automatic hook on invoices — nothing in an invoice
// can name the physical unit — so units attach to bills through the Issue
// action, which carries the invoice number.
//
// Since R2-35 one more kind of paper can name a unit: a build draw. A run at
// /inventory/recipes that draws a numbered part issues it (`issued` — "In a
// build", with the job number as the reference), and cancelling the run puts it
// back the same way a return does. Both are events appended here, through this
// register's own writers — the recipes page proposes and this page's library
// records, the same division lots already have.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN, plural, pluralNoun } from '@/lib/format'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import {
  canMove, deleteUnit, duplicateSerials, loadEvents, loadUnits, recordEvent,
  receiveUnits, serialViews, SERIAL_STATUS_LABEL, SERIAL_STATUS_TONE, summarise,
  todayISO, upsertUnit, validateUnit,
  SERIAL_CSV_HEADERS, serialCsvRows,
  type ReceiveCommon, type SerialEvent, type SerialUnit, type SerialView,
} from '@/lib/serials'
import {
  Badge, Button, Card, EmptyState, PageHeader, SearchInput, Segmented, StatCard,
} from '@/components/ui'
import Icon from '@/components/Icons'

interface ProductOption {
  id: string
  name: string
  sku?: string | null
}

type ViewFilter = 'in_stock' | 'issued' | 'returned' | 'sold' | 'scrapped' | 'all'
type MoveKind = 'sold' | 'returned' | 'scrapped'

const VIEWS: { value: ViewFilter; label: string }[] = [
  { value: 'in_stock', label: 'On the shelf' },
  { value: 'issued', label: 'In a build' },
  { value: 'returned', label: 'Returned' },
  { value: 'sold', label: 'With customers' },
  { value: 'scrapped', label: 'Scrapped' },
  { value: 'all', label: 'All' },
]

const MOVE_TITLE: Record<MoveKind, string> = {
  sold: 'Issue unit',
  returned: 'Take the unit back',
  scrapped: 'Write the unit off',
}

function matchesView(v: SerialView, view: ViewFilter): boolean {
  return view === 'all' || v.status === view
}

/** The one-line story under the status badge — the latest recorded event. */
function historyLine(v: SerialView): string {
  if (v.status === 'in_stock') return v.last_date ? `on the shelf since ${formatDateIN(v.last_date)}` : 'awaiting its first movement'
  if (v.status === 'issued') return v.last_date ? `in a build since ${formatDateIN(v.last_date)}` : 'inside a build'
  if (v.status === 'sold') return `sold ${formatDateIN(v.last_date)}`
  if (v.status === 'returned') return `returned ${formatDateIN(v.last_date)}`
  return `scrapped ${formatDateIN(v.last_date)}`
}

/** Who has (or had) the unit, and under what paper. */
function whereText(v: SerialView): { main: string; sub: string } {
  if (v.status === 'issued') {
    const ref = v.last_ref
    return {
      main: ref ? `In build ${ref}` : 'Inside a build',
      sub: `issued ${formatDateIN(v.last_date)}${ref ? ' · cancelling the run puts it back' : ''}`,
    }
  }
  if (v.status === 'sold') {
    return {
      main: v.sold_to || 'With a customer',
      sub: [v.sold_date ? formatDateIN(v.sold_date) : '', v.sold_ref].filter(Boolean).join(' · ') || 'no invoice recorded',
    }
  }
  if (v.status === 'returned') {
    return {
      main: v.sold_to ? `Back from ${v.sold_to}` : 'Back from a customer',
      sub: `returned ${formatDateIN(v.last_date)}`,
    }
  }
  if (v.status === 'scrapped') {
    return {
      main: 'Written off',
      sub: v.sold_date ? `had been sold ${formatDateIN(v.sold_date)}` : `recv ${v.received_date ? formatDateIN(v.received_date) : '—'}`,
    }
  }
  return {
    main: v.vendor || 'On the shelf',
    sub: [`recv ${v.received_date ? formatDateIN(v.received_date) : '—'}`, v.bill_ref].filter(Boolean).join(' · '),
  }
}

function warrantyLine(v: SerialView): { text: string; bad: boolean } {
  if (v.warranty_till) {
    const days = v.warranty_days
    if (days === null) return { text: formatDateIN(v.warranty_till), bad: false }
    if (days < 0) return { text: `ended ${formatDateIN(v.warranty_till)}`, bad: true }
    if (days === 0) return { text: `ends today · ${formatDateIN(v.warranty_till)}`, bad: false }
    return { text: `${formatDateIN(v.warranty_till)} · ${plural(days, 'day')} left`, bad: false }
  }
  if (v.sold_date) return { text: 'No warranty', bad: false }
  if (v.warranty_months > 0) return { text: `${v.warranty_months} mo, from sale`, bad: false }
  return { text: '—', bad: false }
}

/** A SerialView minus the derived fields — what actually gets stored. */
function unitOf(v: SerialView): SerialUnit {
  return {
    id: v.id,
    product_id: v.product_id,
    product_name: v.product_name,
    sku: v.sku,
    serial_no: v.serial_no,
    vendor_serial: v.vendor_serial,
    cost: v.cost,
    vendor: v.vendor,
    bill_ref: v.bill_ref,
    received_date: v.received_date,
    warranty_months: v.warranty_months,
    notes: v.notes,
    created_at: v.created_at,
  }
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const money = (n: number) => `₹${inr.format(Math.round(Number(n) || 0))}`

interface ReceiveState {
  productId: string
  text: string
  received_date: string
  cost: string
  vendor: string
  bill_ref: string
  warranty_months: string
  notes: string
}

function blankReceive(): ReceiveState {
  return {
    productId: '', text: '', received_date: todayISO(), cost: '',
    vendor: '', bill_ref: '', warranty_months: '', notes: '',
  }
}

interface EditorState { unit: SerialUnit; locked: boolean }
interface MoveState {
  unitId: string
  kind: MoveKind
  date: string
  party: string
  ref: string
  note: string
}

function SerialsPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)
  const [products, setProducts] = useState<ProductOption[]>([])

  const [units, setUnits] = useState<SerialUnit[]>([])
  const [events, setEvents] = useState<SerialEvent[]>([])

  const [search, setSearch] = useSearchDeepLink()
  const [view, setView] = useState<ViewFilter>('in_stock')
  const [notice, setNotice] = useState('')

  const [receive, setReceive] = useState<ReceiveState | null>(null)
  const [receiveError, setReceiveError] = useState('')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [editorError, setEditorError] = useState('')
  const [move, setMove] = useState<MoveState | null>(null)
  const [moveError, setMoveError] = useState('')

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

      const { data: prods } = await supabase
        .from('products')
        .select('id, name, sku')
        .eq('organization_id', oid)
        .eq('is_active', true)
        .order('name')
      setProducts(prods || [])

      setUnits(loadUnits(oid))
      setEvents(loadEvents(oid))

      // ?new=1 — the palette's "Add serial numbers" action lands here with the
      // receive modal open. State is set inline rather than via openReceive():
      // a function defined later in the component cannot be called from the
      // load effect.
      if (searchParams.get('new') === '1') {
        setReceive(blankReceive())
        setReceiveError('')
      }
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const today = todayISO()
  const views = useMemo(() => serialViews(units, events, today), [units, events, today])
  const summary = useMemo(() => summarise(views), [views])
  const historyIds = useMemo(
    () => new Set(events.filter(e => e.kind !== 'received').map(e => e.serial_id)),
    [events],
  )

  const visible = useMemo(() => views.filter(v =>
    matchesView(v, view) &&
    matchesAny(search, [v.serial_no, v.vendor_serial, v.product_name, v.sku, v.sold_to, v.sold_ref, v.vendor, v.bill_ref])),
  [views, view, search])

  /** The receive modal's working list, and what of it collides with the register. */
  const receiveList = useMemo(
    () => (receive ? receive.text.split('\n').map(s => s.trim()).filter(Boolean) : []),
    [receive],
  )
  const receiveDupes = useMemo(() => duplicateSerials(receiveList, units), [receiveList, units])

  function flash(message: string) {
    setNotice(message)
  }

  // ── receive (bulk) ─────────────────────────────────────────────────────────
  function openReceive() {
    setReceive(blankReceive())
    setReceiveError('')
  }

  function closeReceive() {
    setReceive(null)
    setReceiveError('')
  }

  function patchReceive(patch: Partial<ReceiveState>) {
    setReceive(r => (r ? { ...r, ...patch } : r))
  }

  function saveReceive() {
    if (!receive) return
    const product = products.find(p => p.id === receive.productId)
    if (!product) { setReceiveError('Pick the item these units belong to'); return }
    if (receiveList.length === 0) { setReceiveError('Add at least one serial number — one per line'); return }
    if (receiveDupes.length > 0) {
      const names = receiveDupes.slice(0, 3).join(', ')
      setReceiveError(`${names}${receiveDupes.length > 3 ? ` and ${receiveDupes.length - 3} more` : ''} — already in the register. A unit's number can never appear twice.`)
      return
    }
    const cost = Number(receive.cost)
    if (Number.isFinite(cost) && cost < 0) { setReceiveError('Cost cannot be negative'); return }
    const warranty = Number(receive.warranty_months)
    if (Number.isFinite(warranty) && warranty < 0) { setReceiveError('Warranty months cannot be negative'); return }

    const common: ReceiveCommon = {
      received_date: receive.received_date || todayISO(),
      cost: Number(receive.cost) || 0,
      vendor: receive.vendor.trim(),
      bill_ref: receive.bill_ref.trim(),
      warranty_months: Number(receive.warranty_months) || 0,
      notes: receive.notes.trim(),
    }
    const added = receiveUnits(orgId, product, receiveList, common)
    setUnits(loadUnits(orgId))
    setEvents(loadEvents(orgId))
    setNotice(`${plural(added.length, 'unit')} of ${product.name} added to the register.`)
    closeReceive()
  }

  // ── editor (single unit) ───────────────────────────────────────────────────
  function openEditor(v: SerialView) {
    setEditor({ unit: unitOf(v), locked: historyIds.has(v.id) })
    setEditorError('')
  }

  function closeEditor() {
    setEditor(null)
    setEditorError('')
  }

  function patchEditor(patch: Partial<SerialUnit>) {
    setEditor(e => (e ? { ...e, unit: { ...e.unit, ...patch } } : e))
  }

  function pickProduct(productId: string) {
    const p = products.find(x => x.id === productId)
    if (!p) { patchEditor({ product_id: null }); return }
    patchEditor({ product_id: p.id, product_name: p.name, sku: p.sku || '' })
  }

  function saveUnit() {
    if (!editor) return
    const draft = { ...editor.unit, serial_no: editor.unit.serial_no.trim() }
    const problems = validateUnit(draft, units, events)
    if (problems.length) { setEditorError(problems.join(' · ')); return }
    setUnits(upsertUnit(orgId, draft))
    setNotice(`Unit ${draft.serial_no} updated.`)
    closeEditor()
  }

  function removeUnit(v: SerialView) {
    if (!confirm(`Delete unit ${v.serial_no}? It has never moved, so nothing else refers to it.`)) return
    const next = deleteUnit(orgId, v.id)
    if (!next) { flash(`${v.serial_no} has moved — delete is off the table. Scrap it instead.`); return }
    setUnits(next.units)
    setEvents(next.events)
    flash(`Unit ${v.serial_no} removed.`)
  }

  // ── movements ──────────────────────────────────────────────────────────────
  function openMove(v: SerialView, kind: MoveKind) {
    if (!canMove(v.status, kind)) return
    setMove({
      unitId: v.id,
      kind,
      date: todayISO(),
      party: kind === 'returned' ? v.sold_to : '',
      ref: '',
      note: '',
    })
    setMoveError('')
  }

  function saveMove() {
    if (!move) return
    const v = views.find(x => x.id === move.unitId)
    if (!v) { setMove(null); return }
    if (!move.date) { setMoveError('Give the movement a date'); return }
    setEvents(recordEvent(orgId, move.unitId, move.kind, move.date, move.ref.trim(), move.party.trim(), move.note.trim()))
    if (move.kind === 'sold') {
      flash(`${v.serial_no} issued${move.party.trim() ? ` to ${move.party.trim()}` : ''}${move.ref.trim() ? ` under ${move.ref.trim()}` : ''}.`)
    } else if (move.kind === 'returned') {
      flash(`${v.serial_no} back from the customer — restock it when it can go out again.`)
    } else {
      flash(`${v.serial_no} written off.`)
    }
    setMove(null)
  }

  function restock(v: SerialView) {
    // Two roads back to the shelf: a return, or a hand take-back out of a build. The wording says
    // which — a unit leaving a run by hand is a correction, and cancelling the run is the tidy way
    // back, so the confirm warns that the issue event will still stand either way.
    if (!confirm(v.status === 'issued'
      ? `Take ${v.serial_no} out of the build by hand? It goes back on the shelf, but ${v.last_ref ? `${v.last_ref} will still record issuing it` : 'the run will still record issuing it'} — cancelling the run is the tidy way back.`
      : `Put ${v.serial_no} back on the shelf? It goes back to in stock straight away.`)) return
    setEvents(recordEvent(orgId, v.id, 'restocked', todayISO()))
    flash(`${v.serial_no} back on the shelf.`)
  }

  function exportCsv() {
    download(`taxflow-serials-${today}.csv`, toCsv(SERIAL_CSV_HEADERS, serialCsvRows(visible)))
  }

  // ── modal derivations ──────────────────────────────────────────────────────
  const moveView = move ? views.find(v => v.id === move.unitId) : null
  const receiveProduct = receive ? products.find(p => p.id === receive.productId) : null

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the serial register…</div>
  }

  return (
    <div className="page-container sr" style={{ maxWidth: 1180 }}>
      <PageHeader
        eyebrow={`${orgName.toUpperCase() || 'INVENTORY'} · ONE ROW PER PHYSICAL UNIT`}
        title="Serial numbers"
        subtitle="Every unit by its own number — where it came from, who has it, and whether it is still under warranty. Issuing a unit attaches it to the invoice it left under."
        actions={
          <>
            <Button variant="ghost" size="sm" icon="download" onClick={exportCsv} disabled={visible.length === 0}>CSV</Button>
            <Button icon="plus" onClick={openReceive}>Receive units</Button>
          </>
        }
      />

      <div className="sr-stats">
        <StatCard
          label="In stock" value={String(summary.inStock)}
          sub={summary.inStock ? `${money(summary.inStockValue)} at recorded cost` : 'no units on the shelf'}
          icon="box" tone="blue" delay={0}
        />
        <StatCard
          label="In a build" value={String(summary.issued)}
          sub={summary.issued ? 'issued into a run — a cancel puts them back' : 'no units inside a build'}
          icon="factory" tone={summary.issued ? 'amber' : 'green'} delay={40}
        />
        <StatCard
          label="With customers" value={String(summary.sold)}
          sub={summary.sold
            ? (summary.onWarranty ? `${summary.onWarranty} still inside warranty` : 'all past their warranty window')
            : 'nothing out with customers'}
          icon="bag" tone="cyan" delay={80}
        />
        <StatCard
          label="Returned" value={String(summary.returned)}
          sub={summary.returned ? 'awaiting restock or scrap' : 'nothing awaiting a decision'}
          icon="undo" tone={summary.returned ? 'amber' : 'green'} delay={120}
        />
        <StatCard
          label="On warranty" value={String(summary.onWarranty)}
          sub={summary.onWarranty ? 'claims window open today' : 'no open warranty windows'}
          icon="shield" tone="green" delay={160}
        />
      </div>

      <div className="sr-toolbar">
        <Segmented options={VIEWS} value={view} onChange={v => setView(v as ViewFilter)} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Serial, item or customer…"
          ariaLabel="Search serial numbers"
          style={{ flex: '1 1 240px', maxWidth: 340, marginLeft: 'auto' }}
        />
      </div>

      {notice && (
        <div className="sr-notice" role="status">
          <Icon name="check" size={14} strokeWidth={2.4} />
          <span>{notice}</span>
          <button type="button" className="sr-notice-x" onClick={() => setNotice('')} aria-label="Dismiss">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={units.length ? 'search' : 'hash'}
            title={units.length
              ? (search ? `No unit matches “${search}”` : 'No units in this view')
              : 'No serial numbers registered'}
            message={units.length
              ? 'Clear the search or pick another view to see the rest of the register.'
              : 'Receive units by their serial numbers — usually when an item is costly enough to track one by one. Each unit becomes one row that remembers who has it and until when it is under warranty.'}
            action={!units.length
              ? <Button size="sm" icon="plus" onClick={openReceive}>Receive units</Button>
              : undefined}
          />
        </Card>
      ) : (
        <div className="table-frame">
          <div className="responsive-table">
            <div className="table-header sr-row sr-head">
              <span data-label="Serial">Serial</span>
              <span data-label="Item">Item</span>
              <span data-label="Status">Status</span>
              <span data-label="Where">Where</span>
              <span data-label="Warranty">Warranty</span>
              <span className="sr-right" data-label="Cost">Cost</span>
              <span data-label="Actions" className="sr-right">{''}</span>
            </div>
            {visible.map(v => {
              const where = whereText(v)
              const warranty = warrantyLine(v)
              const fresh = !historyIds.has(v.id)
              return (
                <div key={v.id} className={`table-row sr-row ${v.status === 'scrapped' ? 'sr-dim' : ''}`}>
                  <span data-label="Serial">
                    <span className="sr-mono sr-serial">{v.serial_no || '—'}</span>
                    {v.vendor_serial && <div className="sr-sub">vendor {v.vendor_serial}</div>}
                  </span>
                  <span data-label="Item" className="sr-item">
                    <span className="sr-name">{v.product_name || '—'}</span>
                    {v.sku && <span className="sr-sub">{v.sku}</span>}
                  </span>
                  <span data-label="Status">
                    <Badge tone={SERIAL_STATUS_TONE[v.status]} dot={false}>{SERIAL_STATUS_LABEL[v.status]}</Badge>
                    <div className="sr-sub">{historyLine(v)}</div>
                  </span>
                  <span data-label="Where">
                    <span className="sr-where">{where.main}</span>
                    <div className="sr-sub">{where.sub}</div>
                  </span>
                  <span data-label="Warranty">
                    <span className={warranty.bad ? 'sr-sub-red' : ''}>{warranty.text}</span>
                  </span>
                  <span className="sr-right sr-num" data-label="Cost">{v.cost ? money(v.cost) : '—'}</span>
                  <span className="sr-right sr-actions" data-label="Actions">
                    {v.status === 'in_stock' && (
                      <Button variant="ghost" size="sm" icon="bag" title={`Issue ${v.serial_no} — record the invoice it leaves under`}
                        onClick={() => openMove(v, 'sold')} style={{ width: 32, padding: 0 }}>{' '}</Button>
                    )}
                    {v.status === 'sold' && (
                      <Button variant="ghost" size="sm" icon="undo" title={`Take ${v.serial_no} back`}
                        onClick={() => openMove(v, 'returned')} style={{ width: 32, padding: 0 }}>{' '}</Button>
                    )}
                    {v.status === 'returned' && (
                      <Button variant="ghost" size="sm" icon="box" title={`Put ${v.serial_no} back on the shelf`}
                        onClick={() => restock(v)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                    )}
                    {v.status === 'issued' && (
                      <Button variant="ghost" size="sm" icon="box" title={`Take ${v.serial_no} out of the build by hand — cancelling the run at /inventory/recipes is the tidy way`}
                        onClick={() => restock(v)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                    )}
                    {(v.status === 'in_stock' || v.status === 'issued' || v.status === 'returned') && (
                      <Button variant="ghost" size="sm" icon="alert" title={`Write off ${v.serial_no}`}
                        onClick={() => openMove(v, 'scrapped')} style={{ width: 32, padding: 0 }}>{' '}</Button>
                    )}
                    <Button variant="ghost" size="sm" icon="edit" title={`Edit unit ${v.serial_no}`}
                      onClick={() => openEditor(v)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                    {fresh && (
                      <Button variant="danger" size="sm" icon="x" title={`Delete unit ${v.serial_no}`}
                        onClick={() => removeUnit(v)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="sr-foot">
        <span>
          Shown: {visible.length} of {summary.units} {pluralNoun(summary.units, 'unit')}
          {summary.sold ? ` · ${summary.sold} with customers` : ''}
          {summary.onWarranty ? ` · ${summary.onWarranty} on warranty` : ''}
        </span>
        <span className="sr-foot-links">
          <Link href="/inventory/batches">Batches & expiry →</Link>
          <Link href="/products">Products →</Link>
          <Link href="/inventory">Shelf counts →</Link>
        </span>
      </div>

      {/* ── Receive (bulk) ─────────────────────────────────────────────────── */}
      {receive && (
        <div className="sr-scrim" role="dialog" aria-modal="true" aria-label="Receive units">
          <div className="sr-modal" style={{ maxWidth: 640 }}>
            <div className="sr-modal-head">
              <div>
                <h2>Receive units</h2>
                <p>One row per physical unit. Type the serial numbers as printed — one per line; a number can never enter the register twice.</p>
              </div>
              <button type="button" className="sr-close" onClick={closeReceive} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {receiveError && (
              <div className="sr-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{receiveError}</div>
            )}

            <label className="sr-field">
              <span>Item *</span>
              <select className="tf-input" style={{ cursor: 'pointer' }} value={receive.productId}
                onChange={e => { patchReceive({ productId: e.target.value }); setReceiveError('') }}>
                <option value="">Select product…</option>
                {products.map(p => (
                  <option key={p.id} value={p.id}>{p.name}{p.sku ? ` — ${p.sku}` : ''}</option>
                ))}
              </select>
            </label>

            <label className="sr-field">
              <span>Serial numbers * — one per line</span>
              <textarea className="tf-input sr-area" rows={6} value={receive.text}
                onChange={e => { patchReceive({ text: e.target.value }); setReceiveError('') }}
                placeholder={'SN-0001\nSN-0002\nSN-0003…'} />
            </label>

            {receiveList.length > 0 && (
              <div className="sr-preview">
                <div className="sr-preview-head">
                  <span>This will add</span>
                  <span className="sr-preview-total">
                    {plural(receiveList.length - receiveDupes.length, 'unit')}
                    {receiveProduct ? ` of ${receiveProduct.name}` : ''}
                  </span>
                </div>
                {receiveDupes.length > 0 && (
                  <p className="sr-warn">
                    <Icon name="alert" size={13} strokeWidth={2.2} />
                    Already in the register: {receiveDupes.slice(0, 6).join(', ')}{receiveDupes.length > 6 ? ` and ${receiveDupes.length - 6} more` : ''} — remove them to continue.
                  </p>
                )}
              </div>
            )}

            <div className="sr-grid">
              <label className="sr-field">
                <span>Received on *</span>
                <input className="tf-input" type="date" value={receive.received_date}
                  onChange={e => patchReceive({ received_date: e.target.value })} />
              </label>
              <label className="sr-field">
                <span>Unit cost (₹)</span>
                <input className="tf-input" type="number" min="0" step="0.01" value={receive.cost}
                  onChange={e => patchReceive({ cost: e.target.value })} placeholder="Landed cost per unit" />
              </label>
            </div>

            <div className="sr-grid">
              <label className="sr-field">
                <span>Vendor</span>
                <input className="tf-input" value={receive.vendor}
                  onChange={e => patchReceive({ vendor: e.target.value })} placeholder="Who supplied the units" />
              </label>
              <label className="sr-field">
                <span>Bill ref</span>
                <input className="tf-input" value={receive.bill_ref}
                  onChange={e => patchReceive({ bill_ref: e.target.value })} placeholder="Purchase bill / GRN no." />
              </label>
            </div>

            <div className="sr-grid">
              <label className="sr-field">
                <span>Warranty (months)</span>
                <input className="tf-input" type="number" min="0" step="1" value={receive.warranty_months}
                  onChange={e => patchReceive({ warranty_months: e.target.value })} placeholder="0 = none" />
              </label>
              <label className="sr-field">
                <span>Notes</span>
                <input className="tf-input" value={receive.notes}
                  onChange={e => patchReceive({ notes: e.target.value })} placeholder="Sealed box, open unit…" />
              </label>
            </div>

            <div className="sr-note-inline">
              <Icon name="check" size={13} strokeWidth={2.4} />
              Warranty is counted from the sale date — enter the length once and the register works out each unit&apos;s expiry when it is issued.
            </div>

            <div className="sr-save">
              <Button variant="ghost" onClick={closeReceive}>Cancel</Button>
              <Button icon="check" onClick={saveReceive} disabled={receiveList.length === 0 || receiveDupes.length > 0}>
                {receiveList.length - receiveDupes.length > 0
                  ? `Receive ${plural(receiveList.length - receiveDupes.length, 'unit')}`
                  : 'Receive units'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Editor (single unit) ───────────────────────────────────────────── */}
      {editor && (
        <div className="sr-scrim" role="dialog" aria-modal="true"
          aria-label={`Edit unit ${editor.unit.serial_no}`}>
          <div className="sr-modal" style={{ maxWidth: 640 }}>
            <div className="sr-modal-head">
              <div>
                <h2>Edit unit {editor.unit.serial_no}</h2>
                <p>The unit&apos;s identity — its item and number — locks once it has moved; everything else stays editable.</p>
              </div>
              <button type="button" className="sr-close" onClick={closeEditor} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {editorError && (
              <div className="sr-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{editorError}</div>
            )}

            <div className="sr-grid">
              <label className="sr-field">
                <span>Item *</span>
                <select className={`tf-input${editor.locked ? ' sr-locked' : ''}`} disabled={editor.locked}
                  style={{ cursor: editor.locked ? 'not-allowed' : 'pointer' }} value={editor.unit.product_id || ''}
                  onChange={e => pickProduct(e.target.value)}>
                  <option value="">Select product…</option>
                  {editor.unit.product_id && !products.some(p => p.id === editor.unit.product_id) && (
                    <option value={editor.unit.product_id}>{editor.unit.product_name} (not in the active list)</option>
                  )}
                  {products.map(p => (
                    <option key={p.id} value={p.id}>{p.name}{p.sku ? ` — ${p.sku}` : ''}</option>
                  ))}
                </select>
                {editor.locked && <em className="sr-hintline">locked — this unit has history</em>}
              </label>
              <label className="sr-field">
                <span>Serial no. *</span>
                <input className={`tf-input sr-mono${editor.locked ? ' sr-locked' : ''}`} disabled={editor.locked}
                  value={editor.unit.serial_no}
                  onChange={e => patchEditor({ serial_no: e.target.value })} placeholder="As printed on the unit" />
                {editor.locked && <em className="sr-hintline">locked — the history refers to this number</em>}
              </label>
            </div>

            <div className="sr-grid">
              <label className="sr-field">
                <span>Vendor serial</span>
                <input className="tf-input sr-mono" value={editor.unit.vendor_serial}
                  onChange={e => patchEditor({ vendor_serial: e.target.value })} placeholder="If it differs from ours" />
              </label>
              <label className="sr-field">
                <span>Received on *</span>
                <input className="tf-input" type="date" value={editor.unit.received_date}
                  onChange={e => patchEditor({ received_date: e.target.value })} />
              </label>
            </div>

            <div className="sr-grid">
              <label className="sr-field">
                <span>Unit cost (₹)</span>
                <input className="tf-input" type="number" min="0" step="0.01" value={editor.unit.cost || ''}
                  onChange={e => patchEditor({ cost: Number(e.target.value) || 0 })} />
              </label>
              <label className="sr-field">
                <span>Warranty (months)</span>
                <input className="tf-input" type="number" min="0" step="1" value={editor.unit.warranty_months || ''}
                  onChange={e => patchEditor({ warranty_months: Number(e.target.value) || 0 })} placeholder="0 = none" />
              </label>
            </div>

            <div className="sr-grid">
              <label className="sr-field">
                <span>Vendor</span>
                <input className="tf-input" value={editor.unit.vendor}
                  onChange={e => patchEditor({ vendor: e.target.value })} />
              </label>
              <label className="sr-field">
                <span>Bill ref</span>
                <input className="tf-input" value={editor.unit.bill_ref}
                  onChange={e => patchEditor({ bill_ref: e.target.value })} />
              </label>
            </div>

            <label className="sr-field">
              <span>Notes</span>
              <input className="tf-input" value={editor.unit.notes}
                onChange={e => patchEditor({ notes: e.target.value })} placeholder="Open box, minor scratch…" />
            </label>

            <div className="sr-note-inline">
              <Icon name="check" size={13} strokeWidth={2.4} />
              Change the warranty months and any open warranty window follows — the expiry is always worked out from the latest sale.
            </div>

            <div className="sr-save">
              <Button variant="ghost" onClick={closeEditor}>Cancel</Button>
              <Button icon="check" onClick={saveUnit}>Save changes</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Movement (issue / return / scrap) ──────────────────────────────── */}
      {move && moveView && (
        <div className="sr-scrim" role="dialog" aria-modal="true" aria-label={MOVE_TITLE[move.kind]}>
          <div className="sr-modal" style={{ maxWidth: 520 }}>
            <div className="sr-modal-head">
              <div>
                <h2>{MOVE_TITLE[move.kind]}</h2>
                <p><span className="sr-mono">{moveView.serial_no}</span> · {moveView.product_name} — {historyLine(moveView)}.</p>
              </div>
              <button type="button" className="sr-close" onClick={() => setMove(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {moveError && (
              <div className="sr-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{moveError}</div>
            )}

            <div className="sr-grid">
              <label className="sr-field">
                <span>Date *</span>
                <input className="tf-input" type="date" value={move.date}
                  onChange={e => { setMove(m => (m ? { ...m, date: e.target.value } : m)); setMoveError('') }} />
              </label>
              {move.kind === 'sold' && (
                <label className="sr-field">
                  <span>Sold to</span>
                  <input className="tf-input" value={move.party}
                    onChange={e => setMove(m => (m ? { ...m, party: e.target.value } : m))} placeholder="Customer name" />
                </label>
              )}
              {move.kind === 'returned' && (
                <label className="sr-field">
                  <span>Returned by</span>
                  <input className="tf-input" value={move.party}
                    onChange={e => setMove(m => (m ? { ...m, party: e.target.value } : m))} placeholder="Customer name" />
                </label>
              )}
              {move.kind === 'scrapped' && (
                <label className="sr-field">
                  <span>Reason</span>
                  <input className="tf-input" value={move.note}
                    onChange={e => setMove(m => (m ? { ...m, note: e.target.value } : m))} placeholder="Damaged, dead on arrival…" />
                </label>
              )}
            </div>

            {move.kind === 'sold' && (
              <label className="sr-field">
                <span>Invoice no.</span>
                <input className="tf-input" value={move.ref}
                  onChange={e => setMove(m => (m ? { ...m, ref: e.target.value } : m))} placeholder="The bill this unit left under" />
              </label>
            )}

            {move.kind !== 'scrapped' && (
              <label className="sr-field">
                <span>Note</span>
                <input className="tf-input" value={move.note}
                  onChange={e => setMove(m => (m ? { ...m, note: e.target.value } : m))}
                  placeholder={move.kind === 'sold' ? 'Accessories, delivery…' : 'Condition on arrival…'} />
              </label>
            )}

            <div className="sr-note-inline">
              {move.kind === 'scrapped'
                ? <Icon name="alert" size={13} strokeWidth={2.2} />
                : <Icon name="check" size={13} strokeWidth={2.4} />}
              {move.kind === 'sold' && 'The warranty story starts here — the claims window, if any, is counted from this date.'}
              {move.kind === 'returned' && 'Return is a log entry, not an undo. Restock the unit when it can be sold again — a later sale restarts its warranty.'}
              {move.kind === 'scrapped' && 'Scrapping closes the unit\u2019s story. The row stays — the register never forgets a serial.'}
            </div>

            <div className="sr-save">
              <Button variant="ghost" onClick={() => setMove(null)}>Cancel</Button>
              <Button icon="check" onClick={saveMove}>
                {move.kind === 'sold' ? 'Issue unit' : move.kind === 'returned' ? 'Record return' : 'Scrap unit'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .sr-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .sr-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }

        .sr-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px;
          font-size: 12.5px; color: var(--green); background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 10px; }
        .sr-notice svg { flex-shrink: 0; }
        .sr-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; border-radius: 6px; min-height: 0; }
        .sr-notice-x:hover { background: rgba(0,0,0,0.05); }

        .sr-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1.05fr) minmax(0, 1.35fr) minmax(0, 1.1fr) minmax(0, 0.6fr) 168px;
          gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .sr-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .sr-right { text-align: right; justify-content: flex-end; }
        .sr-item { display: flex; flex-direction: column; gap: 2px; color: var(--ink); min-width: 0; }
        .sr-item .sr-name { font-weight: 600; overflow-wrap: anywhere; }
        .sr-serial { font-weight: 650; color: var(--ink); overflow-wrap: anywhere; }
        .sr-where { color: var(--ink-2); overflow-wrap: anywhere; }
        .sr-sub { font-size: 11px; color: var(--faint); margin-top: 2px; }
        .sr-sub-red { color: var(--red); font-weight: 600; }
        .sr-mono { font-family: var(--mono); }
        .sr-num { font-variant-numeric: tabular-nums; color: var(--ink-2); }
        .sr-dim { opacity: 0.72; }
        .sr-actions { display: flex; gap: 6px; }

        .sr-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          font-size: 11.5px; color: var(--faint); margin-top: 10px; }
        .sr-foot-links { display: flex; gap: 12px; }
        .sr-foot-links a { color: var(--brand); text-decoration: none; }

        .sr-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .sr-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .sr-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .sr-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .sr-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; max-width: 440px; line-height: 1.5; }
        .sr-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; flex-shrink: 0; min-height: 0; }
        .sr-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .sr-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .sr-alert svg { flex-shrink: 0; }

        .sr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
        .sr-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .sr-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .sr-hintline { font-size: 11.5px; color: var(--muted); font-style: normal; }
        .sr-hintline.is-bad { color: var(--red); font-weight: 600; }
        .sr-locked { background: var(--surface-2); color: var(--muted); }
        .sr-area { resize: vertical; min-height: 120px; font-family: var(--mono);
          font-size: 12px; line-height: 1.7; letter-spacing: 0.02em; }

        .sr-note-inline { display: flex; align-items: flex-start; gap: 6px; padding: 8px 12px; border-radius: 8px;
          font-size: 12px; background: var(--surface-2); color: var(--muted); border: 1px solid var(--line-soft); line-height: 1.5; }
        .sr-note-inline svg { flex-shrink: 0; margin-top: 2px; }

        .sr-preview { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--surface-2); }
        .sr-preview-head { display: flex; justify-content: space-between; font-size: 11px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .sr-preview-total { color: var(--brand); font-variant-numeric: tabular-nums; }
        .sr-warn { display: flex; align-items: flex-start; gap: 6px; margin: 8px 0 0; font-size: 12px; color: var(--amber); font-weight: 600; line-height: 1.5; }
        .sr-warn svg { flex-shrink: 0; margin-top: 2px; }

        .sr-save { display: flex; gap: 10px; justify-content: flex-end; }

        @media (max-width: 1100px) { .sr-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
        @media (max-width: 768px) {
          .sr-row { grid-template-columns: 1fr; gap: 6px; }
          .sr-head { display: none; }
          .sr-right { text-align: left; }
          .sr-stats { grid-template-columns: 1fr 1fr; }
          .sr-grid { grid-template-columns: 1fr; }
          .sr-scrim { align-items: flex-end; padding: 0; }
          .sr-scrim .sr-modal { max-width: none !important; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .sr-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}

export default function SerialsPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <SerialsPageInner />
    </Suspense>
  )
}
