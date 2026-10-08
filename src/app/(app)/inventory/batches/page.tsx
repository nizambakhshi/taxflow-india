'use client'

// Batch & expiry register — every lot received, what has left it, and what is
// about to go bad.
//
// The engine (src/lib/batches.ts) explains the domain: lots ride on
// localStorage (ADR-013), consumption is FEFO, and invoices billed in the app
// draw the register down automatically through recordSale(). This page is the
// register itself: the shelf view, the expiry watch, and the two manual
// corrections — selling off-book stock, and adjusting a lot by hand.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN } from '@/lib/format'
import { formatINR } from '@/lib/gst-engine'
import { fmtQty } from '@/lib/reorder'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import {
  allocateFefo, appendMoves, batchCsvRows, BATCH_CSV_HEADERS, batchViews, BATCH_STATUS_LABEL,
  BATCH_STATUS_TONE, deleteBatch, loadBatches, loadMoves, newBatch, newMove,
  statusOf, summarise, todayISO, upsertBatch, validateBatch,
  EXPIRY_CRITICAL_DAYS, type Batch, type BatchMove, type BatchView,
} from '@/lib/batches'
import {
  Badge, Button, Card, EmptyState, PageHeader, SearchInput, Segmented, StatCard,
} from '@/components/ui'
import Icon from '@/components/Icons'

interface ProductOption {
  id: string
  name: string
  sku?: string | null
  unit?: string | null
  purchase_price?: number | null
}

type ViewFilter = 'live' | 'expired' | 'd30' | 'd90' | 'consumed' | 'all'

const VIEWS: { value: ViewFilter; label: string }[] = [
  { value: 'live', label: 'On the shelf' },
  { value: 'expired', label: 'Expired' },
  { value: 'd30', label: `≤ ${EXPIRY_CRITICAL_DAYS} days` },
  { value: 'd90', label: '31–90 days' },
  { value: 'consumed', label: 'Sold out' },
  { value: 'all', label: 'All' },
]

function matchesView(v: BatchView, view: ViewFilter): boolean {
  if (view === 'all') return true
  if (view === 'live') return v.left > 0
  if (view === 'consumed') return v.left <= 0
  if (view === 'expired') return v.left > 0 && v.status === 'expired'
  if (view === 'd30') return v.left > 0 && v.status === 'critical'
  return v.left > 0 && v.status === 'soon'
}

function daysText(v: Pick<BatchView, 'daysLeft'>): string {
  if (v.daysLeft === null) return 'No expiry'
  if (v.daysLeft < 0) return `Expired ${-v.daysLeft} day${v.daysLeft === -1 ? '' : 's'} ago`
  if (v.daysLeft === 0) return 'Expires today'
  return `${v.daysLeft} day${v.daysLeft === 1 ? '' : 's'} left`
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const money = (n: number) => `₹${inr.format(Math.round(Number(n) || 0))}`

interface EditorState { batch: Batch; isNew: boolean }
interface AllocState { productId: string; qty: string; date: string; ref: string }
interface AdjustState { batchId: string; dir: 'out' | 'in'; qty: string; date: string; note: string }

function BatchesPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)
  const [products, setProducts] = useState<ProductOption[]>([])

  const [batches, setBatches] = useState<Batch[]>([])
  const [moves, setMoves] = useState<BatchMove[]>([])

  const [search, setSearch] = useSearchDeepLink()
  const [view, setView] = useState<ViewFilter>('live')
  const [notice, setNotice] = useState('')

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [editorError, setEditorError] = useState('')
  const [alloc, setAlloc] = useState<AllocState | null>(null)
  const [allocError, setAllocError] = useState('')
  const [adjust, setAdjust] = useState<AdjustState | null>(null)
  const [adjustError, setAdjustError] = useState('')

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
        .select('id, name, sku, unit, purchase_price')
        .eq('organization_id', oid)
        .eq('is_active', true)
        .order('name')
      setProducts(prods || [])

      setBatches(loadBatches(oid))
      setMoves(loadMoves(oid))

      // ?new=1 — the palette's "Add batch" action lands here with the editor
      // open. State is set inline rather than via openEditor(): a function
      // defined later in the component cannot be called from the load effect.
      if (searchParams.get('new') === '1') {
        setEditor({ batch: newBatch(), isNew: true })
        setEditorError('')
      }
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const today = todayISO()
  const views = useMemo(() => batchViews(batches, moves, today), [batches, moves, today])
  const summary = useMemo(() => summarise(views), [views])

  const visible = useMemo(() => {
    return views.filter(v =>
      matchesView(v, view) &&
      matchesAny(search, [v.product_name, v.sku, v.batch_no, v.vendor, v.bill_ref]))
  }, [views, view, search])

  /** Items that actually have live lots — the only ones FEFO can draw from. */
  const liveProducts = useMemo(() => {
    const map = new Map<string, { id: string; name: string; lots: number; left: number }>()
    for (const v of views) {
      if (v.left <= 0 || !v.product_id) continue
      const cur = map.get(v.product_id) || { id: v.product_id, name: v.product_name, lots: 0, left: 0 }
      cur.lots += 1
      cur.left = Math.round((cur.left + v.left) * 1000) / 1000
      map.set(v.product_id, cur)
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [views])

  function flash(message: string) {
    setNotice(message)
  }

  function openEditor(batch: Batch, isNew: boolean) {
    setEditor({ batch, isNew })
    setEditorError('')
  }

  function closeEditor() {
    setEditor(null)
    setEditorError('')
  }

  function patchEditor(patch: Partial<Batch>) {
    setEditor(e => (e ? { ...e, batch: { ...e.batch, ...patch } } : e))
  }

  function pickProduct(productId: string) {
    const p = products.find(x => x.id === productId)
    if (!p) { patchEditor({ product_id: null }); return }
    patchEditor({
      product_id: p.id,
      product_name: p.name,
      sku: p.sku || '',
      unit: p.unit || '',
      cost: Number(p.purchase_price) || 0,
    })
  }

  function saveBatch() {
    if (!editor) return
    const draft = { ...editor.batch, batch_no: editor.batch.batch_no.trim() }
    const problems = validateBatch(draft, batches, moves)
    if (problems.length) { setEditorError(problems.join(' · ')); return }
    setBatches(upsertBatch(orgId, draft))
    setNotice(editor.isNew ? `Lot ${draft.batch_no} added.` : `Lot ${draft.batch_no} updated.`)
    closeEditor()
  }

  function removeLot(v: BatchView) {
    const n = moves.filter(m => m.batch_id === v.id).length
    if (!confirm(`Delete lot ${v.batch_no} of ${v.product_name}?${n ? ` Its ${n} recorded movement${n === 1 ? '' : 's'} go with it.` : ''}`)) return
    const next = deleteBatch(orgId, v.id)
    setBatches(next.batches)
    setMoves(next.moves)
    flash(`Lot ${v.batch_no} deleted.`)
  }

  function openAlloc(productId = '') {
    setAlloc({ productId, qty: '', date: todayISO(), ref: '' })
    setAllocError('')
  }

  function saveAlloc() {
    if (!alloc) return
    const qty = Number(alloc.qty)
    if (!alloc.productId) { setAllocError('Pick the item that left the shelf'); return }
    if (!Number.isFinite(qty) || qty <= 0) { setAllocError('Quantity must be more than zero'); return }
    const preview = allocateFefo(batches, moves, alloc.productId, qty)
    if (preview.picks.length === 0) { setAllocError('No registered lots of this item have stock left'); return }
    const fresh = preview.picks.map(p =>
      newMove(p.batch.id, -p.take, alloc.date || todayISO(), 'sale', alloc.ref.trim()))
    setMoves(appendMoves(orgId, fresh))
    const label = liveProducts.find(p => p.id === alloc.productId)?.name || 'item'
    flash(`Drew ${qty - preview.shortfall} × ${label} from ${preview.picks.length} lot${preview.picks.length === 1 ? '' : 's'}${preview.shortfall > 0 ? ` — ${preview.shortfall} had no batch recorded` : ''}.`)
    setAlloc(null)
  }

  function openAdjust(v: BatchView) {
    setAdjust({ batchId: v.id, dir: 'out', qty: '', date: todayISO(), note: '' })
    setAdjustError('')
  }

  function saveAdjust() {
    if (!adjust) return
    const view = views.find(v => v.id === adjust.batchId)
    if (!view) { setAdjust(null); return }
    const qty = Number(adjust.qty)
    if (!Number.isFinite(qty) || qty <= 0) { setAdjustError('Quantity must be more than zero'); return }
    if (adjust.dir === 'out' && qty > view.left) {
      setAdjustError(`Only ${fmtQty(view.left, view.unit)} left in this lot`)
      return
    }
    const signed = adjust.dir === 'out' ? -qty : qty
    setMoves(appendMoves(orgId, [newMove(adjust.batchId, signed, adjust.date || todayISO(), 'adjust', '', adjust.note.trim())]))
    flash(`${adjust.dir === 'out' ? 'Wrote off' : 'Returned'} ${fmtQty(qty, view.unit)} ${adjust.dir === 'out' ? 'from' : 'to'} lot ${view.batch_no}.`)
    setAdjust(null)
  }

  function exportCsv() {
    download(`taxflow-batches-${today}.csv`, toCsv(BATCH_CSV_HEADERS, batchCsvRows(visible)))
  }

  // ── modal derivations ──────────────────────────────────────────────────────
  const allocPreview = useMemo(() => (
    alloc && alloc.productId ? allocateFefo(batches, moves, alloc.productId, Number(alloc.qty) || 0) : null
  ), [alloc, batches, moves])
  const allocExpiredTakes = allocPreview
    ? allocPreview.picks.reduce((s, p) => s + (p.batch.expiry_date && p.batch.expiry_date < today ? p.take : 0), 0)
    : 0

  const editorExpiry = editor && editor.batch.expiry_date ? statusOf(editor.batch.expiry_date, today) : null
  const editorProductMissing = editor?.batch.product_id
    ? !products.some(p => p.id === editor.batch.product_id)
    : false
  const adjustView = adjust ? views.find(v => v.id === adjust.batchId) : null

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the batch register…</div>
  }

  return (
    <div className="page-container bt" style={{ maxWidth: 1180 }}>
      <PageHeader
        eyebrow={`${orgName.toUpperCase() || 'INVENTORY'} · FIRST EXPIRY, FIRST OUT`}
        title="Batches & expiry"
        subtitle="Every lot received, what has left it, and what is about to go bad. Sales billed in TaxFlow draw lots down automatically."
        actions={
          <>
            <Button variant="ghost" size="sm" icon="download" onClick={exportCsv} disabled={visible.length === 0}>CSV</Button>
            <Button variant="ghost" size="sm" icon="swap" onClick={() => openAlloc()}>Sell from stock</Button>
            <Button icon="plus" onClick={() => openEditor(newBatch(), true)}>Add batch</Button>
          </>
        }
      />

      <div className="bt-stats">
        <StatCard
          label="On the shelf" value={String(summary.live)}
          sub={`${summary.lots === 0 ? 'no lots yet' : `${summary.lots} lot${summary.lots === 1 ? '' : 's'} recorded · ${summary.items} item${summary.items === 1 ? '' : 's'}`}`}
          icon="box" tone="blue" delay={0}
        />
        <StatCard
          label="Stock value" value={money(summary.valueLeft)}
          sub={summary.unitsLeft ? `${summary.unitsLeft.toLocaleString('en-IN')} units at recorded cost` : 'nothing in stock'}
          icon="scale" tone="cyan" delay={40}
        />
        <StatCard
          label={`Expiring in ${EXPIRY_CRITICAL_DAYS} days`} value={money(summary.d30.value)}
          sub={summary.d30.count ? `${summary.d30.count} lot${summary.d30.count === 1 ? '' : 's'} — sell or flag them` : 'nothing in the danger window'}
          icon="clock" tone={summary.d30.count ? 'amber' : 'green'} delay={80}
        />
        <StatCard
          label="Expired" value={money(summary.expired.value)}
          sub={summary.expired.count ? `${summary.expired.count} lot${summary.expired.count === 1 ? '' : 's'} past expiry` : 'nothing past its date'}
          icon="alert" tone={summary.expired.count ? 'red' : 'green'} delay={120}
        />
      </div>

      <div className="bt-toolbar">
        <Segmented options={VIEWS} value={view} onChange={v => setView(v as ViewFilter)} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Item, batch no. or vendor…"
          ariaLabel="Search batches"
          style={{ flex: '1 1 240px', maxWidth: 340, marginLeft: 'auto' }}
        />
      </div>

      {notice && (
        <div className="bt-notice" role="status">
          <Icon name="check" size={14} strokeWidth={2.4} />
          <span>{notice}</span>
          <button type="button" className="bt-notice-x" onClick={() => setNotice('')} aria-label="Dismiss">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={batches.length ? 'search' : 'box'}
            title={batches.length
              ? (search ? `No lot matches “${search}”` : 'No lots in this view')
              : 'No batches registered'}
            message={batches.length
              ? 'Clear the search or pick another view to see the rest of the register.'
              : 'Add a batch when stock arrives — its expiry date, quantity and cost. From then on, invoices of that item draw the oldest expiry down first.'}
            action={!batches.length
              ? <Button size="sm" icon="plus" onClick={() => openEditor(newBatch(), true)}>Add batch</Button>
              : undefined}
          />
        </Card>
      ) : (
        <div className="table-frame">
          <div className="responsive-table">
            <div className="table-header bt-row bt-head">
              <span data-label="Item">Item</span>
              <span data-label="Batch">Batch</span>
              <span data-label="Expiry">Expiry</span>
              <span data-label="Received">In</span>
              <span data-label="Out">Out</span>
              <span className="bt-right" data-label="Left">Left</span>
              <span className="bt-right" data-label="Value">Value</span>
              <span data-label="Actions" className="bt-right">{''}</span>
            </div>
            {visible.map(v => (
              <div key={v.id} className={`table-row bt-row ${v.left <= 0 ? 'bt-dim' : ''}`}>
                <span data-label="Item" className="bt-item">
                  <span className="bt-name">{v.product_name || '—'}</span>
                  {v.sku && <span className="bt-sub">{v.sku}</span>}
                </span>
                <span data-label="Batch">
                  <span className="bt-mono">{v.batch_no || '—'}</span>
                  <div className="bt-sub">
                    recv {v.received_date ? formatDateIN(v.received_date) : '—'}{v.vendor ? ` · ${v.vendor}` : ''}
                  </div>
                </span>
                <span data-label="Expiry">
                  <Badge tone={BATCH_STATUS_TONE[v.status]} dot={false}>{BATCH_STATUS_LABEL[v.status]}</Badge>
                  <div className={`bt-sub ${v.status === 'expired' ? 'bt-sub-red' : ''}`}>
                    {v.expiry_date ? `${formatDateIN(v.expiry_date)} — ${daysText(v)}` : daysText(v)}
                  </div>
                </span>
                <span data-label="Received" className="bt-num">{fmtQty(v.qty, v.unit)}</span>
                <span data-label="Out" className="bt-num">
                  {v.out ? fmtQty(v.out, v.unit) : '—'}
                  {v.back > 0 && <div className="bt-sub">{fmtQty(v.back, v.unit)} returned</div>}
                </span>
                <span className="bt-right bt-num bt-left" data-label="Left">
                  {fmtQty(Math.max(0, v.left), v.unit)}
                  <div className="bt-sub">{v.left <= 0 ? 'sold out' : 'in stock'}</div>
                </span>
                <span className="bt-right bt-num" data-label="Value">
                  {v.value ? money(v.value) : '—'}
                  {v.cost > 0 && <div className="bt-sub">₹{formatINR(v.cost)}/unit</div>}
                </span>
                <span className="bt-right bt-actions" data-label="Actions">
                  <Button variant="ghost" size="sm" icon="truck" title={`Sell from ${v.product_name} — first expiry, first out`}
                    onClick={() => openAlloc(v.product_id || '')} style={{ width: 32, padding: 0 }}>{' '}</Button>
                  <Button variant="ghost" size="sm" icon="swap" title={`Adjust lot ${v.batch_no}`}
                    onClick={() => openAdjust(v)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                  <Button variant="ghost" size="sm" icon="edit" title={`Edit lot ${v.batch_no}`}
                    onClick={() => openEditor({ ...v }, false)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                  <Button variant="danger" size="sm" icon="x" title={`Delete lot ${v.batch_no}`}
                    onClick={() => removeLot(v)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bt-foot">
        <span>Shown: {visible.length} of {summary.lots} lots · {summary.consumed} sold out{summary.noExpiry.count ? ` · ${summary.noExpiry.count} without an expiry` : ''}</span>
        <span className="bt-foot-links">
          <Link href="/products">Products →</Link>
          <Link href="/inventory/reorder">Reorder planner →</Link>
          <Link href="/inventory">Shelf counts →</Link>
        </span>
      </div>

      {/* ── Editor ─────────────────────────────────────────────────────────── */}
      {editor && (
        <div className="bt-scrim" role="dialog" aria-modal="true"
          aria-label={editor.isNew ? 'Add batch' : `Edit lot ${editor.batch.batch_no}`}>
          <div className="bt-modal" style={{ maxWidth: 640 }}>
            <div className="bt-modal-head">
              <div>
                <h2>{editor.isNew ? 'Add batch' : `Edit lot ${editor.batch.batch_no}`}</h2>
                <p>One row per receipt — the same batch number delivered twice is two lots, each with its own expiry.</p>
              </div>
              <button type="button" className="bt-close" onClick={closeEditor} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {editorError && (
              <div className="bt-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{editorError}</div>
            )}

            <label className="bt-field">
              <span>Item *</span>
              <select className="tf-input" style={{ cursor: 'pointer' }} value={editor.batch.product_id || ''}
                onChange={e => pickProduct(e.target.value)}>
                <option value="">Select product…</option>
                {editorProductMissing && (
                  <option value={editor.batch.product_id || ''}>{editor.batch.product_name} (not in the active list)</option>
                )}
                {products.map(p => (
                  <option key={p.id} value={p.id}>{p.name}{p.sku ? ` — ${p.sku}` : ''}</option>
                ))}
              </select>
            </label>

            <div className="bt-grid">
              <label className="bt-field">
                <span>Batch no. *</span>
                <input className="tf-input bt-mono" value={editor.batch.batch_no}
                  onChange={e => patchEditor({ batch_no: e.target.value })} placeholder="As printed on the pack" />
              </label>
              <label className="bt-field">
                <span>Qty received *</span>
                <input className="tf-input" type="number" min="0" step="any" value={editor.batch.qty || ''}
                  onChange={e => patchEditor({ qty: Number(e.target.value) || 0 })} placeholder="0" />
              </label>
            </div>

            <div className="bt-grid">
              <label className="bt-field">
                <span>Mfg date</span>
                <input className="tf-input" type="date" value={editor.batch.mfg_date}
                  onChange={e => patchEditor({ mfg_date: e.target.value })} />
              </label>
              <label className="bt-field">
                <span>Expiry date</span>
                <input className="tf-input" type="date" value={editor.batch.expiry_date}
                  onChange={e => patchEditor({ expiry_date: e.target.value })} />
                {editorExpiry && (
                  <em className={`bt-hintline ${editorExpiry.status === 'expired' ? 'is-bad' : ''}`}>
                    {daysText(editorExpiry)} — {BATCH_STATUS_LABEL[editorExpiry.status]}
                  </em>
                )}
              </label>
            </div>

            <div className="bt-grid">
              <label className="bt-field">
                <span>Received on *</span>
                <input className="tf-input" type="date" value={editor.batch.received_date}
                  onChange={e => patchEditor({ received_date: e.target.value })} />
              </label>
              <label className="bt-field">
                <span>Unit cost (₹)</span>
                <input className="tf-input" type="number" min="0" step="0.01" value={editor.batch.cost || ''}
                  onChange={e => patchEditor({ cost: Number(e.target.value) || 0 })} placeholder="Landed cost per unit" />
              </label>
            </div>

            <div className="bt-grid">
              <label className="bt-field">
                <span>Vendor</span>
                <input className="tf-input" value={editor.batch.vendor}
                  onChange={e => patchEditor({ vendor: e.target.value })} placeholder="Who supplied the lot" />
              </label>
              <label className="bt-field">
                <span>Bill ref</span>
                <input className="tf-input" value={editor.batch.bill_ref}
                  onChange={e => patchEditor({ bill_ref: e.target.value })} placeholder="Purchase bill / GRN no." />
              </label>
            </div>

            <label className="bt-field">
              <span>Notes</span>
              <input className="tf-input" value={editor.batch.notes}
                onChange={e => patchEditor({ notes: e.target.value })} placeholder="Cold chain, damage on arrival…" />
            </label>

            <div className="bt-note-inline">
              <Icon name="check" size={13} strokeWidth={2.4} />
              Once a lot exists for an item, invoices of that item draw from lots first-expiry-first-out automatically — the register follows your sales.
            </div>

            <div className="bt-save">
              <Button variant="ghost" onClick={closeEditor}>Cancel</Button>
              <Button icon="check" onClick={saveBatch}>{editor.isNew ? 'Add lot' : 'Save changes'}</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── FEFO allocation ────────────────────────────────────────────────── */}
      {alloc && (
        <div className="bt-scrim" role="dialog" aria-modal="true" aria-label="Sell from stock">
          <div className="bt-modal" style={{ maxWidth: 620 }}>
            <div className="bt-modal-head">
              <div>
                <h2>Sell from stock — first expiry, first out</h2>
                <p>Sales billed in TaxFlow already draw lots down. Use this when stock left without an invoice, or to catch up the past.</p>
              </div>
              <button type="button" className="bt-close" onClick={() => setAlloc(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {allocError && (
              <div className="bt-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{allocError}</div>
            )}

            <div className="bt-grid">
              <label className="bt-field">
                <span>Item *</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value={alloc.productId}
                  onChange={e => { setAlloc(a => (a ? { ...a, productId: e.target.value } : a)); setAllocError('') }}>
                  <option value="">Select item…</option>
                  {liveProducts.map(p => (
                    <option key={p.id} value={p.id}>{p.name} — {p.left.toLocaleString('en-IN')} left in {p.lots} lot{p.lots === 1 ? '' : 's'}</option>
                  ))}
                </select>
              </label>
              <label className="bt-field">
                <span>Quantity *</span>
                <input className="tf-input" type="number" min="0" step="any" value={alloc.qty}
                  onChange={e => { setAlloc(a => (a ? { ...a, qty: e.target.value } : a)); setAllocError('') }} placeholder="0" />
              </label>
            </div>

            <div className="bt-grid">
              <label className="bt-field">
                <span>Date out</span>
                <input className="tf-input" type="date" value={alloc.date}
                  onChange={e => setAlloc(a => (a ? { ...a, date: e.target.value } : a))} />
              </label>
              <label className="bt-field">
                <span>Reference</span>
                <input className="tf-input" value={alloc.ref}
                  onChange={e => setAlloc(a => (a ? { ...a, ref: e.target.value } : a))} placeholder="Invoice no. or person, optional" />
              </label>
            </div>

            {allocPreview && Number(alloc.qty) > 0 && (
              <div className="bt-preview">
                <div className="bt-preview-head">
                  <span>This will take</span>
                  <span className="bt-preview-total">
                    {allocPreview.covered.toLocaleString('en-IN')} of {Number(alloc.qty).toLocaleString('en-IN')}
                  </span>
                </div>
                {allocPreview.picks.length === 0 ? (
                  <p className="bt-preview-empty">No lots of this item have stock left.</p>
                ) : (
                  <ul className="bt-preview-list">
                    {allocPreview.picks.map(p => {
                      const expired = Boolean(p.batch.expiry_date) && p.batch.expiry_date < today
                      return (
                        <li key={p.batch.id} className={expired ? 'is-bad' : ''}>
                          <span className="bt-mono">{p.batch.batch_no}</span>
                          <span className="bt-sub-inline">{p.batch.expiry_date ? `exp ${formatDateIN(p.batch.expiry_date)}` : 'no expiry'}{expired ? ' · expired' : ''}</span>
                          <span className="bt-preview-take">{fmtQty(p.take, p.batch.unit)}</span>
                        </li>
                      )
                    })}
                  </ul>
                )}
                {allocExpiredTakes > 0 && (
                  <p className="bt-warn">
                    <Icon name="alert" size={13} strokeWidth={2.2} />
                    {allocExpiredTakes} unit{allocExpiredTakes === 1 ? '' : 's'} come from lots already past expiry — that stock should not have gone out.
                  </p>
                )}
                {allocPreview.shortfall > 0 && (
                  <p className="bt-warn">
                    <Icon name="alert" size={13} strokeWidth={2.2} />
                    {allocPreview.shortfall} unit{allocPreview.shortfall === 1 ? '' : 's'} have no batch recorded and stay off the register.
                  </p>
                )}
              </div>
            )}

            <div className="bt-save">
              <Button variant="ghost" onClick={() => setAlloc(null)}>Cancel</Button>
              <Button icon="check" onClick={saveAlloc}>Record sale</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Manual adjustment ──────────────────────────────────────────────── */}
      {adjust && adjustView && (
        <div className="bt-scrim" role="dialog" aria-modal="true" aria-label={`Adjust lot ${adjustView.batch_no}`}>
          <div className="bt-modal" style={{ maxWidth: 520 }}>
            <div className="bt-modal-head">
              <div>
                <h2>Adjust lot {adjustView.batch_no}</h2>
                <p>{adjustView.product_name} · {fmtQty(Math.max(0, adjustView.left), adjustView.unit)} left of {fmtQty(adjustView.qty, adjustView.unit)} received.</p>
              </div>
              <button type="button" className="bt-close" onClick={() => setAdjust(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {adjustError && (
              <div className="bt-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{adjustError}</div>
            )}

            <Segmented
              options={[
                { value: 'out', label: 'Leaves the lot' },
                { value: 'in', label: 'Returns to the lot' },
              ]}
              value={adjust.dir}
              onChange={v => { setAdjust(a => (a ? { ...a, dir: v as 'out' | 'in' } : a)); setAdjustError('') }}
            />

            <div className="bt-grid">
              <label className="bt-field">
                <span>Quantity *</span>
                <input className="tf-input" type="number" min="0" step="any" value={adjust.qty}
                  onChange={e => { setAdjust(a => (a ? { ...a, qty: e.target.value } : a)); setAdjustError('') }} placeholder="0" />
              </label>
              <label className="bt-field">
                <span>Date</span>
                <input className="tf-input" type="date" value={adjust.date}
                  onChange={e => setAdjust(a => (a ? { ...a, date: e.target.value } : a))} />
              </label>
            </div>

            <label className="bt-field">
              <span>Reason</span>
              <input className="tf-input" value={adjust.note}
                onChange={e => setAdjust(a => (a ? { ...a, note: e.target.value } : a))}
                placeholder={adjust.dir === 'out' ? 'Damaged, expired, internal use…' : 'Customer return, count correction…'} />
            </label>

            <div className="bt-note-inline">
              <Icon name="alert" size={13} strokeWidth={2.2} />
              Adjustments are bookkeeping only — the shelf count on the Inventory page does not move.
            </div>

            <div className="bt-save">
              <Button variant="ghost" onClick={() => setAdjust(null)}>Cancel</Button>
              <Button icon="check" onClick={saveAdjust}>Record adjustment</Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .bt-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .bt-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }

        .bt-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px;
          font-size: 12.5px; color: var(--green); background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 10px; }
        .bt-notice svg { flex-shrink: 0; }
        .bt-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; border-radius: 6px; min-height: 0; }
        .bt-notice-x:hover { background: rgba(0,0,0,0.05); }

        .bt-row { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1.25fr) minmax(0, 0.8fr) minmax(0, 0.8fr) minmax(0, 0.75fr) minmax(0, 0.85fr) 168px;
          gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .bt-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .bt-right { text-align: right; justify-content: flex-end; }
        .bt-item { display: flex; flex-direction: column; gap: 2px; color: var(--ink); min-width: 0; }
        .bt-item .bt-name { font-weight: 600; overflow-wrap: anywhere; }
        .bt-sub { font-size: 11px; color: var(--faint); margin-top: 2px; }
        .bt-sub-red { color: var(--red); }
        .bt-sub-inline { font-size: 11px; color: var(--faint); }
        .bt-mono { font-family: ui-monospace, Menlo, monospace; }
        .bt-num { font-variant-numeric: tabular-nums; color: var(--ink-2); }
        .bt-left { color: var(--ink); font-weight: 650; }
        .bt-dim { opacity: 0.72; }
        .bt-actions { display: flex; gap: 6px; }

        .bt-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          font-size: 11.5px; color: var(--faint); margin-top: 10px; }
        .bt-foot-links { display: flex; gap: 12px; }
        .bt-foot-links a { color: var(--brand); text-decoration: none; }

        .bt-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .bt-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .bt-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .bt-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .bt-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; max-width: 440px; line-height: 1.5; }
        .bt-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; flex-shrink: 0; min-height: 0; }
        .bt-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .bt-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .bt-alert svg { flex-shrink: 0; }

        .bt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
        .bt-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .bt-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .bt-hintline { font-size: 11.5px; color: var(--muted); font-style: normal; }
        .bt-hintline.is-bad { color: var(--red); font-weight: 600; }

        .bt-note-inline { display: flex; align-items: flex-start; gap: 6px; padding: 8px 12px; border-radius: 8px;
          font-size: 12px; background: var(--surface-2); color: var(--muted); border: 1px solid var(--line-soft); line-height: 1.5; }
        .bt-note-inline svg { flex-shrink: 0; margin-top: 2px; }

        .bt-preview { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--surface-2); }
        .bt-preview-head { display: flex; justify-content: space-between; font-size: 11px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .bt-preview-total { color: var(--brand); font-variant-numeric: tabular-nums; }
        .bt-preview-empty { font-size: 12.5px; color: var(--red); margin: 8px 0 0; }
        .bt-preview-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
        .bt-preview-list li { display: flex; align-items: baseline; gap: 10px; font-size: 12.5px; color: var(--ink-2); }
        .bt-preview-list li.is-bad { color: var(--red); }
        .bt-preview-take { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 650; color: var(--ink); }
        .bt-preview-list li.is-bad .bt-preview-take { color: var(--red); }
        .bt-warn { display: flex; align-items: flex-start; gap: 6px; margin: 8px 0 0; font-size: 12px; color: var(--amber); font-weight: 600; line-height: 1.5; }
        .bt-warn svg { flex-shrink: 0; margin-top: 2px; }

        .bt-save { display: flex; gap: 10px; justify-content: flex-end; }

        @media (max-width: 1100px) { .bt-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .bt-row { grid-template-columns: 1fr; gap: 6px; }
          .bt-head { display: none; }
          .bt-right { text-align: left; }
          .bt-stats { grid-template-columns: 1fr 1fr; }
          .bt-grid { grid-template-columns: 1fr; }
          .bt-scrim { align-items: flex-end; padding: 0; }
          .bt-scrim .bt-modal { max-width: none !important; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .bt-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}

export default function BatchesPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <BatchesPageInner />
    </Suspense>
  )
}
