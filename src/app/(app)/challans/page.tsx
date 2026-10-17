'use client'

// Delivery challans — the goods-movement document that travels with a dispatch
// and later turns into the invoice. The documents live in localStorage
// (see src/lib/orderflow.ts for why), so this page owns the full lifecycle:
// list → create/edit modal → open the printable challan → convert to invoice.

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { plural } from '@/lib/format'
import { createClient } from '@/lib/supabase'
import {
  determineGSTType, calculateLineItem, getFinancialYear, formatINR,
  type LineItemResult,
} from '@/lib/gst-engine'
import { INDIAN_STATES } from '@/lib/constants'
import { GST_RATES } from '@/lib/gst-rates'
import {
  Badge, Button, Card, EmptyState, PageHeader, SearchInput, Segmented, StatCard,
  useDialog,
} from '@/components/ui'
import Icon from '@/components/Icons'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import {
  KIND_META, CHALLAN_REASONS, reasonLabel,
  loadStore, saveStore, peekNumber, takeNumber,
  computeTotals, isUsableLine, validateDoc, newDoc, sortDocs, docValue,
  type FlowDoc, type FlowLine, type GstType,
} from '@/lib/orderflow'
import { loadSetup, resolveSeries } from '@/lib/setup'

interface CustomerRow {
  id: string
  name: string
  business_name?: string | null
  gstin?: string | null
  state_code?: string | null
  address_line1?: string | null
  city?: string | null
  state?: string | null
  customer_type?: string | null
}

interface ProductRow {
  id: string
  name: string
  hsn_sac?: string | null
  unit?: string | null
  selling_price?: number | null
  gst_rate?: number | null
  cess_rate?: number | null
}

const KIND = 'challan' as const
const META = KIND_META[KIND]

const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const money = (v: number) => inr0.format(v)
const num = (v: string) => Number(v) || 0

type StatusFilter = 'all' | 'draft' | 'active' | 'closed' | 'converted' | 'cancelled'

const VIEWS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: META.statusLabels.draft },
  { value: 'active', label: META.statusLabels.active },
  { value: 'closed', label: META.statusLabels.closed },
  { value: 'converted', label: META.statusLabels.converted },
  { value: 'cancelled', label: META.statusLabels.cancelled },
]

const STATUS_TONE: Record<string, 'grey' | 'blue' | 'amber' | 'green' | 'red'> = {
  draft: 'grey', active: 'blue', closed: 'amber', converted: 'green', cancelled: 'red',
}

const todayISO = () => new Date().toISOString().split('T')[0]

// The editor keeps strings (a half-typed "12." is not a number yet); the store
// keeps the canonical FlowLine shape.
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
  product_id: '', item_name: '', hsn_sac: '', quantity: '1', unit: 'NOS',
  rate: '', discount_percent: '0', gst_rate: '18', cess_rate: '0',
})

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

function ChallansPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgStateCode, setOrgStateCode] = useState('')
  const [customers, setCustomers] = useState<CustomerRow[]>([])
  const [products, setProducts] = useState<ProductRow[]>([])
  const [docs, setDocs] = useState<FlowDoc[]>([])
  const [loading, setLoading] = useState(true)

  const [search, setSearch] = useSearchDeepLink()
  const [view, setView] = useState<StatusFilter>('all')

  // Modal state — `modalDoc` non-null means the editor is open.
  const [modalDoc, setModalDoc] = useState<FlowDoc | null>(null)
  const editorDialog = useDialog(closeEditor)
  const [modalLines, setModalLines] = useState<DraftLine[]>([])
  const [isNewDoc, setIsNewDoc] = useState(true)
  const [modalError, setModalError] = useState('')
  const [saving, setSaving] = useState(false)

  const fy = getFinancialYear()

  // R3-2 — the challan number's shape comes from the series register; the
  // counter stays in this kind's own store. Default arg reads the org in state.
  function fmtFor(oid: string = orgId) {
    return resolveSeries(loadSetup(oid), KIND)
  }

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

      const org = membership.organizations as { state_code?: string } | null
      let stateCode = org?.state_code || ''
      const { data: gstReg } = await supabase
        .from('gst_registrations')
        .select('state_code')
        .eq('organization_id', oid)
        .eq('is_primary', true)
        .single()
      if (gstReg?.state_code) stateCode = gstReg.state_code
      setOrgStateCode(stateCode)

      const [{ data: custs }, { data: prods }] = await Promise.all([
        supabase.from('customers').select('*').eq('organization_id', oid).eq('is_active', true).order('name'),
        supabase.from('products').select('*').eq('organization_id', oid).eq('is_active', true).order('name'),
      ])
      setCustomers(custs || [])
      setProducts(prods || [])

      const store = loadStore(KIND, oid)
      setDocs(store.docs)

      // ?edit=<id> — the detail page's Edit button lands here with the editor open.
      const editId = searchParams.get('edit')
      if (editId) {
        const found = store.docs.find(d => d.id === editId)
        if (found) {
          setModalDoc({ ...found })
          setModalLines(found.lines.length ? found.lines.map(toDraftLine) : [emptyDraftLine()])
          setIsNewDoc(false)
        }
      }

      // ?new=1 — the palette's "New challan" action lands here with the editor open.
      // State is set inline rather than via openCreate(): a function defined later
      // in the component cannot be called from the load effect (React compiler).
      if (searchParams.get('new') === '1') {
        setModalDoc(newDoc(KIND, peekNumber(store, KIND, fy, fmtFor(oid)), todayISO()))
        setModalLines([emptyDraftLine()])
        setIsNewDoc(true)
        setModalError('')
      }
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function openCreate() {
    const doc = newDoc(KIND, peekNumber(loadStore(KIND, orgId), KIND, fy, fmtFor()), todayISO())
    setModalDoc(doc)
    setModalLines([emptyDraftLine()])
    setIsNewDoc(true)
    setModalError('')
  }

  function closeEditor() {
    setModalDoc(null)
    setModalError('')
  }

  function patchModal(patch: Partial<FlowDoc>) {
    setModalDoc(p => (p ? { ...p, ...patch } : p))
  }

  function patchLine(index: number, field: keyof DraftLine, value: string) {
    setModalLines(prev => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)))
  }

  function handlePartyChange(customerId: string) {
    if (!customerId) { patchModal({ party_id: null }); return }
    const c = customers.find(x => x.id === customerId)
    if (!c) return
    patchModal({
      party_id: c.id,
      party_name: c.name || '',
      party_gstin: c.gstin || '',
      party_address: [c.address_line1, c.city, c.state].filter(Boolean).join(', '),
      party_state: c.state_code || '',
      place_of_supply: c.state_code || modalDoc?.place_of_supply || '',
      supply_type: c.customer_type || 'b2b',
    })
  }

  function handleProductSelect(index: number, productId: string) {
    const p = products.find(x => x.id === productId)
    if (!p) { patchLine(index, 'product_id', ''); return }
    setModalLines(prev => prev.map((l, i) => (i === index ? {
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

  function addLine() { setModalLines(prev => [...prev, emptyDraftLine()]) }
  function removeLine(index: number) {
    setModalLines(prev => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)))
  }

  function save() {
    if (!modalDoc) return
    const lines = modalLines.map(toFlowLine).filter(isUsableLine)
    const candidate: FlowDoc = { ...modalDoc, lines }
    const problems = validateDoc(candidate)
    if (problems.length) { setModalError(problems.join(' · ')); return }

    setSaving(true)
    const store = loadStore(KIND, orgId)
    let number = candidate.number
    let nextStore = store
    if (isNewDoc) {
      const taken = takeNumber(store, KIND, fy, fmtFor())
      number = taken.number
      nextStore = taken.store
    }
    const finalDoc: FlowDoc = { ...candidate, number }
    const nextDocs = isNewDoc
      ? [...nextStore.docs, finalDoc]
      : nextStore.docs.map(d => (d.id === finalDoc.id ? finalDoc : d))
    const next = { ...nextStore, docs: nextDocs }
    saveStore(KIND, orgId, next)
    setDocs(nextDocs)
    setSaving(false)
    closeEditor()
    router.push(`/challans/${finalDoc.id}`)
  }

  const gstType: GstType = modalDoc
    ? determineGSTType(orgStateCode, modalDoc.place_of_supply, modalDoc.supply_type)
    : 'cgst_sgst'

  const lineCalcs: (LineItemResult | null)[] = modalLines.map(l => {
    const fl = toFlowLine(l)
    if (!isUsableLine(fl)) return null
    return calculateLineItem(
      {
        quantity: fl.quantity, rate: fl.rate, discount_percent: fl.discount_percent,
        gst_rate: fl.gst_rate, cess_rate: fl.cess_rate,
      },
      gstType,
    )
  })
  const modalTotals = computeTotals(modalLines.map(toFlowLine), gstType).totals

  const summary = useMemo(() => {
    const count = (s: string) => docs.filter(d => d.status === s).length
    const moving = docs.filter(d => d.status === 'active' || d.status === 'closed')
    return {
      draft: count('draft'),
      active: count('active'),
      closed: count('closed'),
      converted: count('converted'),
      movingValue: moving.reduce((s, d) => s + docValue(d), 0),
      movingCount: moving.length,
    }
  }, [docs])

  const visible = useMemo(() => {
    const filtered = docs.filter(d => {
      if (view !== 'all' && d.status !== view) return false
      return matchesAny(search, [d.number, d.party_name, d.party_gstin])
    })
    return sortDocs(filtered)
  }, [docs, view, search])

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading delivery challans…</div>
  }

  return (
    <div className="page-container dc" style={{ maxWidth: 1100 }}>
      <PageHeader
        eyebrow="Sales"
        title={META.plural}
        subtitle="The movement document for goods leaving your premises — dispatched on its own, invoiced when the sale firms up. Numbers are allocated on first save and never reused."
        actions={<Button icon="plus" onClick={openCreate}>New challan</Button>}
      />

      <div className="dc-stats">
        <StatCard label={META.statusLabels.active} value={String(summary.active)}
          sub="sent out, not yet delivered" icon="truck" tone="blue" delay={0} />
        <StatCard label="Awaiting invoice" value={String(summary.closed)}
          sub="delivered — ready to invoice" icon="clock"
          tone={summary.closed ? 'amber' : 'grey'} delay={40} />
        <StatCard label={META.statusLabels.draft} value={String(summary.draft)}
          sub="not dispatched yet" icon="clipboard" tone="grey" delay={80} />
        <StatCard label="Value on the road" value={money(summary.movingValue)}
          sub={`${plural(summary.movingCount, 'challan')} in transit or delivered`}
          icon="wallet" tone="cyan" delay={120} />
      </div>

      <div className="dc-toolbar">
        <Segmented options={VIEWS} value={view} onChange={v => setView(v as StatusFilter)} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Number, party or GSTIN…"
          ariaLabel="Search delivery challans"
          style={{ flex: '1 1 240px', maxWidth: 340, marginLeft: 'auto' }}
        />
      </div>

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={docs.length ? 'search' : 'truck'}
            title={docs.length
              ? (search ? `No challan matches “${search}”` : `No ${VIEWS.find(v => v.value === view)?.label.toLowerCase()} challans`)
              : 'Nothing dispatched yet'}
            message={docs.length
              ? 'Clear the search or pick another status to see every challan.'
              : 'Create a delivery challan when goods leave for job work, approval, a branch transfer or a sale that is not invoiced yet — then turn it into the invoice in one click.'}
            action={!docs.length
              ? <Button size="sm" icon="plus" onClick={openCreate}>New challan</Button>
              : undefined}
          />
        </Card>
      ) : (
        <div className="table-frame">
          <div className="responsive-table">
            <div className="table-header dc-row dc-head">
              <span data-label="Challan">Challan</span>
              <span data-label="Party">Party</span>
              <span data-label="Date">Date &amp; reason</span>
              <span className="dc-right" data-label="Value">Value</span>
              <span data-label="Status">Status</span>
              <span className="dc-right" data-label="Open">Open</span>
            </div>
            {visible.map(d => (
              <div key={d.id} className={`table-row dc-row ${d.status === 'cancelled' ? 'dc-dim' : ''}`}>
                <span data-label="Challan" className="dc-doc-cell">
                  <span className="dc-doc-number">{d.number}</span>
                </span>
                <span data-label="Party" className="dc-party">
                  <span>{d.party_name || '—'}</span>
                  {d.party_gstin && <span className="dc-sub dc-mono">{d.party_gstin}</span>}
                </span>
                <span data-label="Date">
                  <span className="dc-sub">{d.doc_date}</span>
                  {d.reason && <div className="dc-sub dc-faint">{reasonLabel(d.reason)}</div>}
                </span>
                <span className="dc-right dc-amount" data-label="Value">
                  {money(docValue(d))}
                  <div className="dc-sub">{d.lines.filter(isUsableLine).length} items</div>
                </span>
                <span data-label="Status">
                  <Badge tone={STATUS_TONE[d.status] || 'grey'}>{META.statusLabels[d.status]}</Badge>
                  {d.converted_to_number && <div className="dc-sub dc-faint">{d.converted_to_number}</div>}
                </span>
                <span className="dc-right" data-label="Open">
                  <Button size="sm" variant="subtle" icon="printer"
                    onClick={() => router.push(`/challans/${d.id}`)}>
                    Open
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="dc-foot">
        <span>Shown: {visible.length} of {docs.length}</span>
        <span>{summary.converted > 0 && `${summary.converted} converted to invoices. `}
          Challans are stored in this browser (localStorage) until invoiced — the invoice is the statutory record.</span>
      </div>

      {modalDoc && (
        <div ref={editorDialog} className="dc-scrim" role="dialog" aria-modal="true"
          aria-label={isNewDoc ? 'New delivery challan' : `Edit ${modalDoc.number}`}>
          <div className="dc-modal">
            <div className="dc-modal-head">
              <div>
                <h2>{isNewDoc ? 'New delivery challan' : `Edit ${modalDoc.number}`}</h2>
                <p>
                  {isNewDoc
                    ? `Number ${modalDoc.number} will be allocated when you save.`
                    : `${modalDoc.doc_date} · ${reasonLabel(modalDoc.reason) || 'no reason set'}`}
                </p>
              </div>
              <button type="button" className="dc-close" onClick={closeEditor} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {modalError && (
              <div className="dc-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{modalError}</div>
            )}

            <div className="dc-grid">
              <label className="dc-field">
                <span>Customer</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value={modalDoc.party_id || ''}
                  onChange={e => handlePartyChange(e.target.value)}>
                  <option value="">Type a name below…</option>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>{c.name}{c.business_name ? ` — ${c.business_name}` : ''}</option>
                  ))}
                </select>
              </label>
              <label className="dc-field">
                <span>Deliver to (name) *</span>
                <input className="tf-input" value={modalDoc.party_name}
                  onChange={e => patchModal({ party_name: e.target.value })}
                  placeholder="Party name" />
              </label>
            </div>

            <div className="dc-grid">
              <label className="dc-field">
                <span>GSTIN</span>
                <input className="tf-input dc-mono" value={modalDoc.party_gstin}
                  onChange={e => patchModal({ party_gstin: e.target.value.toUpperCase() })}
                  placeholder="Optional" />
              </label>
              <label className="dc-field">
                <span>Place of supply *</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value={modalDoc.place_of_supply}
                  onChange={e => patchModal({ place_of_supply: e.target.value })}>
                  <option value="">Select state…</option>
                  {INDIAN_STATES.map(s => (
                    <option key={s.value} value={s.value}>{s.value} — {s.label}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="dc-field">
              <span>Address</span>
              <input className="tf-input" value={modalDoc.party_address}
                onChange={e => patchModal({ party_address: e.target.value })}
                placeholder="Delivery address shown on the challan" />
            </div>

            <div className="dc-grid">
              <label className="dc-field">
                <span>Challan date *</span>
                <input className="tf-input" type="date" value={modalDoc.doc_date}
                  onChange={e => patchModal({ doc_date: e.target.value })} />
              </label>
              <label className="dc-field">
                <span>Reason for movement *</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value={modalDoc.reason}
                  onChange={e => patchModal({ reason: e.target.value })}>
                  {CHALLAN_REASONS.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </label>
            </div>

            {CHALLAN_REASONS.find(r => r.value === modalDoc.reason)?.note && (
              <div className="dc-note">
                <Icon name="alert" size={13} strokeWidth={2.2} />
                {CHALLAN_REASONS.find(r => r.value === modalDoc.reason)?.note}
              </div>
            )}

            <div className="dc-grid dc-grid-3">
              <label className="dc-field">
                <span>Vehicle number</span>
                <input className="tf-input" value={modalDoc.vehicle_number}
                  onChange={e => patchModal({ vehicle_number: e.target.value.toUpperCase() })}
                  placeholder="MH 12 AB 1234" />
              </label>
              <label className="dc-field">
                <span>Transporter</span>
                <input className="tf-input" value={modalDoc.transporter}
                  onChange={e => patchModal({ transporter: e.target.value })}
                  placeholder="Transport name" />
              </label>
              <label className="dc-field">
                <span>E-way bill no.</span>
                <input className="tf-input dc-mono" value={modalDoc.eway_bill_number}
                  onChange={e => patchModal({ eway_bill_number: e.target.value })}
                  placeholder="Generated on the portal" />
              </label>
            </div>

            {modalDoc.place_of_supply && orgStateCode && (
              <div className={`dc-note ${gstType === 'cgst_sgst' ? 'is-local' : 'is-inter'}`}>
                <Icon name="check" size={13} strokeWidth={2.6} />
                {gstType === 'cgst_sgst'
                  ? 'Same state — the invoice this converts to will split CGST + SGST'
                  : 'Interstate — the invoice this converts to will carry IGST'}
              </div>
            )}

            <div className="dc-lihead">
              <span className="dc-li-title">Goods being moved</span>
            </div>

            <div className="line-items-head dc-linehead">
              <span>Item *</span>
              <span>HSN/SAC</span>
              <span>Qty *</span>
              <span>Rate (₹)</span>
              <span>Disc %</span>
              <span>GST %</span>
              <span className="dc-right">Amount</span>
              <span></span>
            </div>

            {modalLines.map((l, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div className="line-item-row dc-linerow">
                  <div className="li-full" data-label="Item *">
                    <select className="tf-input" style={{ marginBottom: 4, cursor: 'pointer' }}
                      value={l.product_id} onChange={e => handleProductSelect(i, e.target.value)}>
                      <option value="">Select product…</option>
                      {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <input className="tf-input" value={l.item_name}
                      onChange={e => patchLine(i, 'item_name', e.target.value)}
                      placeholder="Or type item name" />
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
                  <div data-label="Amount" className="dc-amount-cell">
                    {lineCalcs[i] ? `₹${formatINR(lineCalcs[i]!.total_amount)}` : '—'}
                  </div>
                  <div className="li-full" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Button variant="danger" size="sm" icon="x" disabled={modalLines.length === 1}
                      onClick={() => removeLine(i)}
                      style={{ width: 32, height: 32, padding: 0 }} title="Remove line">{' '}</Button>
                  </div>
                </div>
              </div>
            ))}

            <div>
              <Button variant="ghost" size="sm" icon="plus" onClick={addLine}>Add line</Button>
            </div>

            <label className="dc-field">
              <span>Notes (printed on the challan)</span>
              <textarea className="tf-input dc-area" value={modalDoc.notes}
                onChange={e => patchModal({ notes: e.target.value })}
                placeholder="Marks, packing details, return instructions…" />
            </label>

            {modalTotals && (
              <div className="dc-totals">
                {[
                  { label: 'Taxable value', value: modalTotals.taxable_amount },
                  modalTotals.cgst_amount > 0 ? { label: 'CGST', value: modalTotals.cgst_amount } : null,
                  modalTotals.sgst_amount > 0 ? { label: 'SGST', value: modalTotals.sgst_amount } : null,
                  modalTotals.igst_amount > 0 ? { label: 'IGST', value: modalTotals.igst_amount } : null,
                  modalTotals.cess_amount > 0 ? { label: 'Cess', value: modalTotals.cess_amount } : null,
                  modalTotals.round_off !== 0 ? { label: 'Round off', value: modalTotals.round_off } : null,
                ].filter(Boolean).map(row => (
                  <div key={row!.label} className="dc-tot-row">
                    <span>{row!.label}</span>
                    <span>₹{formatINR(Math.abs(row!.value))}</span>
                  </div>
                ))}
                <div className="dc-tot-grand">
                  <span>Document total</span>
                  <span>₹{formatINR(modalTotals.grand_total)}</span>
                </div>
                <p className="dc-hint">
                  Value shown for transit and insurance — the challan itself creates no tax liability.
                  The invoice raised from it carries the same figures.
                </p>
              </div>
            )}

            <div className="dc-save">
              <Button variant="ghost" onClick={closeEditor} disabled={saving}>Cancel</Button>
              <Button icon={saving ? undefined : 'check'} onClick={save} disabled={saving}>
                {saving ? 'Saving…' : (isNewDoc ? 'Save challan' : 'Save changes')}
              </Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .dc-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .dc-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }

        .dc-row { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.5fr) minmax(0, 1fr) 116px minmax(0, 0.9fr) 96px;
          gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .dc-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .dc-right { text-align: right; }
        .dc-doc-cell { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
        .dc-doc-number { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
        .dc-party { display: flex; flex-direction: column; gap: 2px; color: var(--ink); min-width: 0; }
        .dc-sub { font-size: 11px; color: var(--faint); }
        .dc-faint { opacity: 0.85; }
        .dc-mono { font-family: var(--mono); }
        .dc-amount { color: var(--ink); font-weight: 650; }
        .dc-dim { opacity: 0.72; }
        .dc-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 11.5px;
          color: var(--faint); margin-top: 10px; }

        .dc-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .dc-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-width: 860px; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .dc-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .dc-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .dc-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; }
        .dc-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; flex-shrink: 0; }
        .dc-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .dc-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .dc-alert svg { flex-shrink: 0; }

        .dc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
        .dc-grid-3 { grid-template-columns: 1fr 1fr 1fr; }
        .dc-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .dc-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .dc-area { height: 58px; resize: vertical; }

        .dc-note { display: flex; align-items: flex-start; gap: 6px; padding: 8px 12px; border-radius: 8px; font-size: 12px;
          background: var(--surface-2); color: var(--muted); border: 1px solid var(--line-soft); }
        .dc-note svg { flex-shrink: 0; margin-top: 2px; }
        .dc-note.is-local { background: var(--green-soft); border-color: color-mix(in srgb, var(--green) 22%, white); color: var(--green); }
        .dc-note.is-inter { background: var(--brand-soft); border-color: color-mix(in srgb, var(--brand) 22%, white); color: var(--brand-dark); }

        .dc-lihead { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
        .dc-li-title { font-size: 13px; font-weight: 650; color: var(--ink); }
        .dc-linehead { display: grid; grid-template-columns: 2fr 1fr 0.8fr 1fr 0.7fr 0.7fr 1fr 36px; gap: 6px; margin-bottom: 6px;
          font-size: 11px; font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.04em; }
        .dc-linehead .dc-right { text-align: right; }
        .dc-linerow { display: grid; grid-template-columns: 2fr 1fr 0.8fr 1fr 0.7fr 0.7fr 1fr 36px; gap: 6px; align-items: center; }
        .dc-amount-cell {
          padding: 8px 10px; background: var(--surface-2);
          border: 1px solid var(--line); border-radius: var(--radius-sm);
          font-size: 13px; font-weight: 500; color: var(--ink); text-align: right;
        }

        .dc-totals { border-top: 1px solid var(--line-soft); padding-top: 8px; }
        .dc-tot-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; color: var(--muted); }
        .dc-tot-row span:last-child { color: var(--ink); font-weight: 550; }
        .dc-tot-grand { display: flex; justify-content: space-between; padding: 8px 0 2px; font-size: 15px;
          font-weight: 700; color: var(--ink); }
        .dc-tot-grand span:last-child { color: var(--brand); }
        .dc-hint { font-size: 11px; color: var(--faint); line-height: 1.5; margin-top: 4px; }

        .dc-save { display: flex; gap: 10px; justify-content: flex-end; }

        @media (max-width: 1100px) { .dc-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .dc-row { grid-template-columns: 1fr; gap: 6px; }
          .dc-head { display: none; }
          .dc-right { text-align: left; }
          .dc-stats { grid-template-columns: 1fr 1fr; }
          .dc-grid, .dc-grid-3 { grid-template-columns: 1fr; }
          .dc-scrim { align-items: flex-end; padding: 0; }
          .dc-scrim .dc-modal { max-width: none; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .dc-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}

export default function ChallansPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <ChallansPageInner />
    </Suspense>
  )
}
