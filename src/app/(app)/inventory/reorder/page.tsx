'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN } from '@/lib/format'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import {
  DEFAULT_SETTINGS, PLAN_CSV_HEADERS, PO_CSV_HEADERS, STATUS_LABEL, STATUS_TONE,
  buildRows, fmtQty, groupBySupplier, levelSuggestion, loadSettings, orderText, planCsvRows,
  poCsvRows, roundQty, saveSettings, summarise,
  type ProductRow as ReorderProduct, type ReorderRow, type ReorderSettings, type SupplyLine,
} from '@/lib/reorder'
import { Badge, Button, Card, EmptyState, PageHeader, SectionTitle, StatCard } from '@/components/ui'
import Icon from '@/components/Icons'

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const money = (n: number) => `₹${inr.format(Math.round(Number(n) || 0))}`

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const WINDOWS = [
  { value: '30', label: '30 days' },
  { value: '60', label: '60 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '6 months' },
]

const VIEWS = [
  { value: 'needs', label: 'Needs ordering' },
  { value: 'all', label: 'All stock' },
  { value: 'stale', label: 'Dead & over' },
]

/** Cover is the number a buyer acts on, so an empty shelf reads as zero days. */
function coverTone(row: ReorderRow): string {
  if (row.status === 'out-of-stock' || row.status === 'critical') return 'var(--red)'
  if (row.status === 'reorder') return 'var(--amber)'
  if (row.status === 'overstock') return 'var(--violet)'
  return 'var(--brand)'
}

export default function ReorderPlannerPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [settings, setSettings] = useState<ReorderSettings>(DEFAULT_SETTINGS)
  const [savedAt, setSavedAt] = useState('')
  const [view, setView] = useState('needs')
  const [search, setSearch] = useState('')
  const [qtyOverrides, setQtyOverrides] = useState<Record<string, number>>({})
  const [savingLevel, setSavingLevel] = useState('')

  const [products, setProducts] = useState<ReorderProduct[]>([])
  const [demand, setDemand] = useState<{ productId: string; quantity: number }[]>([])
  const [supply, setSupply] = useState<SupplyLine[]>([])
  const [lineCount, setLineCount] = useState({ sold: 0, bought: 0 })

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: membership } = await supabase
        .from('org_members').select('organization_id, organizations(name)')
        .eq('user_id', user.id).eq('is_active', true).single()
      if (!membership) { router.push('/setup'); return }

      const oid = membership.organization_id
      setOrgId(oid)
      setOrgName((membership.organizations as any)?.name || '')
      setSettings(loadSettings(oid))
      await loadWindow(oid, loadSettings(oid).windowDays)
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Everything the model needs: what is on the shelf, what left it, what arrived. */
  async function loadWindow(oid: string, windowDays: number) {
    const from = new Date(Date.now() - (windowDays - 1) * 86400000).toISOString().slice(0, 10)

    const [prodRes, invRes, cnRes, billRes] = await Promise.all([
      supabase.from('products')
        .select('id, name, sku, unit, track_inventory, current_stock, minimum_stock, purchase_price, selling_price')
        .eq('organization_id', oid).eq('is_active', true).eq('track_inventory', true).order('name'),
      supabase.from('invoices').select('id, invoice_date').eq('organization_id', oid)
        .neq('status', 'cancelled').gte('invoice_date', from).limit(5000),
      supabase.from('credit_notes').select('id, credit_note_date').eq('organization_id', oid)
        .neq('status', 'cancelled').gte('credit_note_date', from).limit(2000),
      supabase.from('purchase_bills').select('id, bill_date, vendor_name').eq('organization_id', oid)
        .neq('status', 'cancelled').gte('bill_date', from).limit(5000),
    ])

    const prods = (prodRes.data || []) as ReorderProduct[]
    setProducts(prods)
    setError(prodRes.error ? `Could not read products: ${prodRes.error.message}` : '')

    const tracked = new Set(prods.map(p => p.id))
    const invoices = (invRes.data || []) as { id: string; invoice_date: string }[]
    const notes = (cnRes.data || []) as { id: string; credit_note_date: string }[]
    const bills = (billRes.data || []) as { id: string; bill_date: string; vendor_name: string }[]
    const billById = new Map(bills.map(b => [b.id, b]))

    const sold: { productId: string; quantity: number }[] = []
    const bought: SupplyLine[] = []

    // Lines are pulled in id batches — an FY of invoices is far more than one
    // request can carry in a PostgREST `in` filter.
    const batches = (ids: string[]) => {
      const out: string[][] = []
      for (let i = 0; i < ids.length; i += 500) out.push(ids.slice(i, i + 500))
      return out
    }

    const invLines = await Promise.all(batches(invoices.map(i => i.id)).map(batch =>
      supabase.from('invoice_items').select('invoice_id, product_id, quantity').in('invoice_id', batch)))
    for (const res of invLines) {
      for (const line of (res.data || []) as any[]) {
        if (line.product_id && tracked.has(line.product_id)) sold.push({ productId: line.product_id, quantity: Number(line.quantity) || 0 })
      }
    }

    const cnLines = await Promise.all(batches(notes.map(n => n.id)).map(batch =>
      supabase.from('credit_note_items').select('credit_note_id, product_id, quantity').in('credit_note_id', batch)))
    for (const res of cnLines) {
      for (const line of (res.data || []) as any[]) {
        if (line.product_id && tracked.has(line.product_id)) sold.push({ productId: line.product_id, quantity: -(Number(line.quantity) || 0) })
      }
    }

    const billLines = await Promise.all(batches(bills.map(b => b.id)).map(batch =>
      supabase.from('purchase_bill_items').select('bill_id, product_id, quantity, rate').in('bill_id', batch)))
    for (const res of billLines) {
      for (const line of (res.data || []) as any[]) {
        if (!line.product_id || !tracked.has(line.product_id)) continue
        const bill = billById.get(line.bill_id)
        bought.push({
          productId: line.product_id,
          quantity: Number(line.quantity) || 0,
          rate: Number(line.rate) || 0,
          date: bill?.bill_date || null,
          vendorName: bill?.vendor_name || null,
        })
      }
    }

    setDemand(sold)
    setSupply(bought)
    setLineCount({ sold: sold.length, bought: bought.length })
    setQtyOverrides({})
  }

  const rows = useMemo(() => buildRows(products, demand, supply, settings), [products, demand, supply, settings])

  /** The editable quantity is what the buyer actually orders, so the PO follows it. */
  const withOverrides = useMemo(() => rows.map(r => {
    const override = qtyOverrides[r.productId]
    if (override === undefined || override === r.orderQty) return r
    const qty = roundQty(override, r.unit)
    return { ...r, orderQty: qty, costEstimate: Math.round(qty * r.unitCost * 100) / 100 }
  }), [rows, qtyOverrides])

  // The KPIs follow the quantities on screen, not the model's first guess.
  const summary = useMemo(() => summarise(withOverrides), [withOverrides])

  const groups = useMemo(() => groupBySupplier(withOverrides), [withOverrides])
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const pool = view === 'needs'
      ? withOverrides.filter(r => r.orderQty > 0)
      : view === 'stale'
        ? withOverrides.filter(r => r.status === 'idle' || r.status === 'overstock')
        : withOverrides
    if (!needle) return pool
    return pool.filter(r => `${r.name} ${r.sku} ${r.lastVendor}`.toLowerCase().includes(needle))
  }, [withOverrides, view, search])

  function commit(next: ReorderSettings) {
    setSettings(next)
    if (orgId) {
      saveSettings(orgId, next)
      setSavedAt(new Date().toISOString())
    }
  }

  function changeWindow(days: number) {
    commit({ ...settings, windowDays: days })
    if (orgId) loadWindow(orgId, days)
  }

  async function acceptLevel(row: ReorderRow) {
    const value = levelSuggestion(row)
    if (value === null || !orgId) return
    setSavingLevel(row.productId)
    const { error: err } = await supabase.from('products').update({ minimum_stock: value }).eq('id', row.productId)
    setSavingLevel('')
    if (err) { setError(`Could not save the reorder level: ${err.message}`); return }
    setError('')
    setProducts(prev => prev.map(p => (p.id === row.productId ? { ...p, minimum_stock: value } : p)))
  }

  function exportPlan() {
    download(`taxflow-reorder-plan-${settings.windowDays}d.csv`, toCsv(PLAN_CSV_HEADERS, planCsvRows(withOverrides)))
  }

  function exportPo() {
    download(`taxflow-purchase-order-${settings.windowDays}d.csv`, toCsv(PO_CSV_HEADERS, poCsvRows(groups)))
  }

  async function copyOrder() {
    await navigator.clipboard.writeText(orderText(groups, settings.windowDays))
  }

  const windowFrom = new Date(Date.now() - (settings.windowDays - 1) * 86400000).toISOString().slice(0, 10)

  if (loading) {
    return <div style={{ padding: '2rem', color: 'var(--muted)', fontSize: 14 }}>Reading your stock and sales lines…</div>
  }

  return (
    <div className="page-container" style={{ padding: '1.5rem' }}>
      <PageHeader
        eyebrow={`${orgName.toUpperCase()} · LAST ${settings.windowDays} DAYS`}
        title="Reorder planner"
        subtitle={`${count(products.length, 'stocked item')} · ${count(lineCount.sold, 'sale line')} and ${count(lineCount.bought, 'purchase line')} since ${formatDateIN(windowFrom)}`}
        actions={
          <>
            <Button variant="ghost" size="sm" icon="download" onClick={exportPlan}>Plan CSV</Button>
            <Button variant="ghost" size="sm" icon="printer" onClick={() => window.print()}>Print</Button>
          </>
        }
        right={
          <div className="rp-seg-group">
            <Segmentedish options={WINDOWS} value={String(settings.windowDays)} onChange={v => changeWindow(Number(v))} />
          </div>
        }
      />

      {error && (
        <div className="rp-error"><Icon name="alert" size={14} /> {error}</div>
      )}

      <div className="tf-g-4" style={{ marginBottom: '1rem' }}>
        <StatCard label="To reorder" value={String(summary.needsOrder)}
          sub={summary.needsOrder ? `${money(summary.spend)} of stock to buy` : 'Nothing has hit its reorder point'}
          icon="cart" tone={summary.needsOrder ? 'amber' : 'green'} />
        <StatCard label="Stock-out risk" value={String(summary.stockAtRisk)}
          sub="Sold out, or short of the lead time" icon="alert" tone={summary.stockAtRisk ? 'red' : 'green'} />
        <StatCard label="Median cover" value={summary.daysCoverMedian === null ? '—' : `${summary.daysCoverMedian} d`}
          sub={`Target is ${settings.leadDays + settings.coverDays} days`} icon="clock" tone="blue" />
        <StatCard label="Dead stock" value={money(summary.deadStockValue)}
          sub={summary.deadStockCount ? `${count(summary.deadStockCount, 'item')} sold nothing` : 'Everything moved in the window'}
          icon="box" tone={summary.deadStockValue > 0 ? 'violet' : 'green'} />
      </div>

      <div className="rp-two" style={{ marginBottom: '1rem' }}>
        <Card pad={false}>
          <div style={{ padding: '0.9rem 1rem 0.4rem' }}>
            <SectionTitle icon="settings">How the planner decides</SectionTitle>
            <p className="rp-help">
              Demand is what actually left the shelf in the window — invoice lines with credit notes taken back out.
              The reorder point is lead-time demand plus safety stock; an order lifts you to lead&nbsp;+&nbsp;cover days of demand.
            </p>
          </div>
          <div className="rp-fields" style={{ padding: '0.6rem 1rem 1rem' }}>
            <label className="rp-field">
              <span>Lead time (days)</span>
              <input type="number" min={0} max={180} value={settings.leadDays}
                onChange={e => commit({ ...settings, leadDays: Math.max(0, Number(e.target.value) || 0) })} />
            </label>
            <label className="rp-field">
              <span>Cover after delivery (days)</span>
              <input type="number" min={0} max={365} value={settings.coverDays}
                onChange={e => commit({ ...settings, coverDays: Math.max(0, Number(e.target.value) || 0) })} />
            </label>
            <label className="rp-field">
              <span>Safety factor</span>
              <input type="number" min={0} max={3} step={0.1} value={settings.safetyFactor}
                onChange={e => commit({ ...settings, safetyFactor: Math.min(3, Math.max(0, Number(e.target.value) || 0)) })} />
            </label>
          </div>
          <div className="rp-foot">
            <span className="rp-note">
              {savedAt ? `Saved ${formatDateIN(savedAt.slice(0, 10))} · kept on this device only` : 'Defaults — nothing saved yet'}
            </span>
            <button type="button" className="rp-link" onClick={() => commit({ ...DEFAULT_SETTINGS, leadByProduct: settings.leadByProduct })}>
              Reset to defaults
            </button>
          </div>
        </Card>

        <Card pad={false}>
          <div style={{ padding: '0.9rem 1rem' }}>
            <SectionTitle icon="cart" action={groups.length > 0
              ? <span className="rp-count">{groups.length} supplier{groups.length === 1 ? '' : 's'}</span> : undefined}>
              Purchase orders
            </SectionTitle>
            {groups.length === 0 ? (
              <p className="rp-help" style={{ margin: 0 }}>Nothing has reached its reorder point. When it does, orders are grouped by the supplier each item last arrived from.</p>
            ) : (
              <div className="rp-po-list">
                {groups.map(g => (
                  <div key={g.vendor} className="rp-po-card">
                    <div className="rp-po-head">
                      <span className="rp-po-vendor">{g.vendor}</span>
                      <span className="rp-po-value">{money(g.value)}</span>
                    </div>
                    <ul className="rp-po-lines">
                      {g.rows.map(r => (
                        <li key={r.productId}>
                          <span>{r.name}</span>
                          <span className="rp-po-qty">{fmtQty(r.orderQty, r.unit)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                <div className="rp-po-actions">
                  <Button size="sm" variant="subtle" icon="chat" onClick={copyOrder}>Copy for WhatsApp</Button>
                  <Button size="sm" variant="subtle" icon="download" onClick={exportPo}>PO CSV</Button>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card pad={false}>
        <div className="rp-table-head">
          <SectionTitle icon="box">Suggested orders</SectionTitle>
          <div className="tf-row tf-wrap" style={{ gap: 8 }}>
            <Segmentedish options={VIEWS} value={view} onChange={setView} />
            <div className="rp-search-wrap">
              <Icon name="search" size={14} />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Item or supplier" className="rp-search" />
            </div>
          </div>
        </div>

        {visible.length === 0 ? (
          <EmptyState icon="check"
            title={view === 'needs' ? 'Nothing to order' : 'No items match'}
            message={view === 'needs'
              ? 'Every stocked item is above its reorder point for this window. Try a longer window, or raise the cover target if you want to order ahead.'
              : 'Clear the filter, or widen the search.'}
          />
        ) : (
          <div className="table-scroll">
            <div className="rp-grid">
              <div className="rp-cols rp-head" style={{ gridTemplateColumns: rpCols }}>
                {RP_COLUMNS.map(c => <span key={c} className="rp-th">{c}</span>)}
              </div>
              {visible.map(r => {
                const suggestion = levelSuggestion(r)
                return (
                  <div key={r.productId} className="rp-cols rp-row" style={{ gridTemplateColumns: rpCols }}>
                    <span data-label="Item" className="rp-td rp-td-item">
                      <span className="rp-name">{r.name}</span>
                      <span className="rp-meta">{r.sku ? `${r.sku} · ` : ''}{fmtQty(r.onHand, r.unit)} on hand</span>
                      <span className="rp-reason">{r.reason}</span>
                    </span>
                    <span data-label={`Sold / ${settings.windowDays}d`} className="rp-td">{fmtQty(r.sold, r.unit)}<span className="rp-sub"> · {r.daily}/day</span></span>
                    <span data-label="Cover" className="rp-td rp-num" style={{ color: coverTone(r), fontWeight: 640 }}>
                      {r.daysOfCover === null ? '—' : `${r.daysOfCover} d`}
                    </span>
                    <span data-label="Reorder point" className="rp-td">
                      {fmtQty(r.reorderPoint, r.unit)}
                      <span className="rp-sub"> {r.usingOwnerLevel ? '· yours' : '· suggested'}</span>
                      {suggestion !== null && (
                        <button type="button" className="rp-accept" disabled={savingLevel === r.productId}
                          onClick={() => acceptLevel(r)} title={`Save ${fmtQty(suggestion, r.unit)} as this item's minimum stock`}>
                          {savingLevel === r.productId ? 'Saving…' : `Set ${fmtQty(suggestion, r.unit)}`}
                        </button>
                      )}
                    </span>
                    <span data-label="Order qty" className="rp-td">
                      <input type="number" min={0} step="any" className="rp-qty" value={r.orderQty || ''}
                        placeholder="0" aria-label={`Order quantity for ${r.name}`}
                        onChange={e => setQtyOverrides(prev => ({ ...prev, [r.productId]: Number(e.target.value) || 0 }))} />
                    </span>
                    <span data-label="Est. value" className="rp-td rp-num">{r.costEstimate ? money(r.costEstimate) : '—'}</span>
                    <span data-label="Supplier" className="rp-td">
                      {r.lastVendor || <span className="rp-sub">not bought yet</span>}
                      {r.lastSupplyDate && <span className="rp-sub"> · {formatDateIN(r.lastSupplyDate)}</span>}
                    </span>
                    <span data-label="Status" className="rp-td"><Badge tone={STATUS_TONE[r.status]} dot={false}>{STATUS_LABEL[r.status]}</Badge></span>
                  </div>
                )
              })}
              <div className="rp-cols rp-total" style={{ gridTemplateColumns: rpCols }}>
                <span data-label="Total" className="rp-td">Register total</span>
                <span data-label={`Sold / ${settings.windowDays}d`} className="rp-td" />
                <span data-label="Cover" className="rp-td" />
                <span data-label="Reorder point" className="rp-td" />
                <span data-label="Order qty" className="rp-td rp-num">
                  {fmtQty(Math.round(visible.reduce((s, r) => s + r.orderQty, 0) * 100) / 100, '')}
                </span>
                <span data-label="Est. value" className="rp-td rp-num">{money(visible.reduce((s, r) => s + r.costEstimate, 0))}</span>
                <span data-label="Supplier" className="rp-td" />
                <span data-label="Status" className="rp-td" />
              </div>
            </div>
          </div>
        )}
      </Card>

      <div className="tf-row tf-wrap" style={{ gap: 12, fontSize: 12, color: 'var(--muted)', marginTop: '1rem' }}>
        <span>Only items with stock tracking on are planned.</span>
        <Link href="/inventory" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Adjust stock →</Link>
        <Link href="/products" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Products →</Link>
        <Link href="/bills" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Enter a purchase bill →</Link>
      </div>

      <style>{`
        .rp-seg-group { display: flex; gap: 6px; flex-wrap: wrap; }
        .rp-error {
          display: flex; align-items: center; gap: 8px; margin-bottom: 1rem;
          font-size: 13px; color: var(--red); background: var(--red-soft);
          border: 1px solid #fecaca; border-radius: 10px; padding: 10px 12px;
        }
        .rp-two { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 1rem; }
        .rp-help { font-size: 12.5px; line-height: 1.6; color: var(--muted); margin: 6px 0 0; }
        .rp-fields { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 12px; }
        .rp-field { display: flex; flex-direction: column; gap: 5px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--faint); }
        .rp-field input {
          font-family: inherit; font-size: 14px; font-weight: 550; color: var(--ink); letter-spacing: 0;
          text-transform: none; border: 1px solid var(--line); border-radius: 9px; background: var(--surface);
          padding: 8px 10px; min-height: 0;
        }
        .rp-field input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); }
        .rp-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 10px 1rem; border-top: 1px solid var(--line-soft); background: var(--surface-2); }
        .rp-note { font-size: 11.5px; color: var(--faint); }
        .rp-link { font-family: inherit; font-size: 12px; font-weight: 620; color: var(--brand); background: none; border: none; cursor: pointer; padding: 0; min-height: 0; }
        .rp-count { font-size: 11.5px; color: var(--faint); font-weight: 550; }
        .rp-po-list { display: flex; flex-direction: column; gap: 10px; }
        .rp-po-card { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--surface); }
        .rp-po-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
        .rp-po-vendor { font-size: 13.5px; font-weight: 660; color: var(--ink); }
        .rp-po-value { font-size: 13.5px; font-weight: 700; color: var(--brand); font-variant-numeric: tabular-nums; }
        .rp-po-lines { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
        .rp-po-lines li { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; color: var(--ink-2); }
        .rp-po-qty { font-variant-numeric: tabular-nums; color: var(--muted); }
        .rp-po-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .rp-table-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 0.9rem 1rem; border-bottom: 1px solid var(--line-soft); }
        .rp-search-wrap { display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); padding: 0 9px; color: var(--faint); }
        .rp-search { border: none; background: none; font-family: inherit; font-size: 12.5px; color: var(--ink); padding: 8px 0; width: 140px; min-height: 0; }
        .rp-search:focus { outline: none; }
        .rp-grid { min-width: 900px; }
        .rp-cols { display: grid; grid-template-columns: ${rpCols}; align-items: center; gap: 12px; padding: 11px 1rem; border-bottom: 1px solid var(--line-soft); }
        .rp-head { background: var(--surface-2); border-bottom: 1px solid var(--line); }
        .rp-th { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
        .rp-td { font-size: 13px; color: var(--ink-2); min-width: 0; }
        .rp-num { font-variant-numeric: tabular-nums; }
        .rp-td-item { display: flex; flex-direction: column; gap: 2px; }
        .rp-name { font-size: 13.5px; font-weight: 620; color: var(--ink); }
        .rp-meta { font-size: 11.5px; color: var(--faint); }
        .rp-reason { font-size: 11.5px; color: var(--muted); line-height: 1.45; }
        .rp-sub { font-size: 11.5px; color: var(--faint); }
        .rp-qty { width: 78px; font-family: inherit; font-size: 13px; color: var(--ink); border: 1px solid var(--line); border-radius: 8px; background: var(--surface); padding: 6px 8px; min-height: 0; font-variant-numeric: tabular-nums; }
        .rp-qty:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); }
        .rp-accept {
          display: block; margin-top: 4px; font-family: inherit; font-size: 11px; font-weight: 620;
          color: var(--brand); background: var(--brand-soft); border: 1px solid #c7d7fb;
          border-radius: 7px; padding: 3px 7px; cursor: pointer; min-height: 0;
        }
        .rp-accept:hover { background: #e0e9fd; }
        .rp-accept:disabled { color: var(--faint); cursor: default; }
        .rp-total { background: var(--surface-2); font-weight: 700; color: var(--ink); }
        .rp-total .rp-td { color: var(--ink); }
        @media (max-width: 1040px) {
          .rp-two { grid-template-columns: minmax(0,1fr); }
          .rp-fields { grid-template-columns: minmax(0,1fr); }
        }
        @media (max-width: 768px) {
          .rp-grid { min-width: 0; }
          .rp-head { display: none; }
          .rp-cols { grid-template-columns: minmax(0,1fr) !important; gap: 6px; padding: 12px 14px; }
          .rp-row { border: 1px solid var(--line); border-radius: 12px; margin: 0 0.6rem 10px; background: var(--surface); }
          .rp-td { display: flex; justify-content: space-between; align-items: center; gap: 12px; text-align: right; }
          .rp-td::before {
            content: attr(data-label); font-size: 10.5px; font-weight: 700; color: var(--faint);
            text-transform: uppercase; letter-spacing: .05em; text-align: left;
          }
          .rp-td-item { display: block; text-align: left; }
          .rp-td-item::before { display: none; }
          .rp-total { border-radius: 12px; margin-bottom: 0.6rem; }
          .rp-total .rp-td:empty { display: none; }
        }
        @media print {
          .no-print, .tf-pagehead, .rp-search-wrap, .rp-po-actions { display: none !important; }
          .rp-grid { min-width: 0; }
          .rp-cols { grid-template-columns: ${rpCols}; }
          .rp-two { grid-template-columns: minmax(0,1fr) minmax(0,1fr); }
        }
      `}</style>
    </div>
  )
}

const RP_COLUMNS = ['Item', `Sold`, 'Cover', 'Reorder point', 'Order qty', 'Est. value', 'Supplier', 'Status']
const rpCols = 'minmax(230px,2fr) 0.95fr 0.6fr 1.15fr 0.8fr 0.95fr 1.1fr 0.95fr'

/** Small pill switch — the kit's Segmented is sized for page headers. */
function Segmentedish({ options, value, onChange }: {
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="sg-wrap">
      {options.map(o => (
        <button key={o.value} type="button" className={`sg-btn ${o.value === value ? 'is-on' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
      <style>{`
        .sg-wrap { display: inline-flex; gap: 2px; background: var(--slate-soft); border-radius: 9px; padding: 3px; }
        .sg-btn {
          font-family: inherit; font-size: 12px; font-weight: 620; color: var(--muted);
          background: none; border: none; border-radius: 7px; padding: 5px 10px; cursor: pointer; min-height: 0;
          white-space: nowrap;
        }
        .sg-btn.is-on { background: var(--surface); color: var(--brand); box-shadow: 0 1px 2px rgba(15,23,42,.08); }
        @media (max-width: 768px) { .sg-btn { min-height: 32px; } }
      `}</style>
    </div>
  )
}
