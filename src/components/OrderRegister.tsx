'use client'

// Sales orders and purchase orders — the two order books, one implementation.
// The documents live in localStorage (see src/lib/orderflow.ts for why); this
// component owns the register and the create/edit editor for both kinds and is
// mounted by /sales-orders and /purchase-orders. Delivery challans are the
// sibling document — same engine, same lifecycle, its own page.

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import {
  determineGSTType, calculateLineItem, getFinancialYear, formatINR,
  type LineItemResult,
} from '@/lib/gst-engine'
import { INDIAN_STATES } from '@/lib/constants'
import { GST_RATES } from '@/lib/gst-rates'
import {
  Badge, Button, Card, EmptyState, PageHeader, SearchInput, Segmented, StatCard,
} from '@/components/ui'
import Icon from '@/components/Icons'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import {
  KIND_META, loadStore, saveStore, peekNumber, takeNumber,
  computeTotals, isUsableLine, validateDoc, newDoc, sortDocs, docValue,
  type FlowDoc, type FlowLine, type GstType,
} from '@/lib/orderflow'

export type OrderKind = 'sales_order' | 'purchase_order'

interface PartyRow {
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
  purchase_price?: number | null
  gst_rate?: number | null
  cess_rate?: number | null
}

interface KindCopy {
  eyebrow: string
  subtitle: string
  partyLabel: string
  partyNameLabel: string
  addressPlaceholder: string
  notesPlaceholder: string
  listHref: string
  itemsTitle: string
  conversionLocal: string
  conversionInter: string
  totalsHint: string
  emptyTitle: string
  emptyMessage: string
  footNote: string
  stats: { label: string; sub: string; icon: string; tone: 'blue' | 'amber' | 'grey' | 'cyan'; pick: 'active' | 'closed' | 'draft' | 'value' }[]
}

const COPY: Record<OrderKind, KindCopy> = {
  sales_order: {
    eyebrow: 'Sales',
    subtitle: 'Confirm what the customer wants, before it ships. Numbers are allocated on first save and never reused.',
    partyLabel: 'Customer',
    partyNameLabel: 'Customer (name) *',
    addressPlaceholder: 'Delivery address shown on the order',
    notesPlaceholder: 'Dispatch instructions, remarks…',
    listHref: '/sales-orders',
    itemsTitle: 'Items ordered',
    conversionLocal: 'Same state — the invoice this converts to will split CGST + SGST',
    conversionInter: 'Interstate — the invoice this converts to will carry IGST',
    totalsHint: 'Estimated value — no tax liability yet. The invoice raised from this order carries the same figures.',
    emptyTitle: 'No orders yet',
    emptyMessage: 'Raise a sales order to confirm what the customer asked for, then fulfil it and turn it into the invoice in one click.',
    footNote: 'Orders are stored in this browser (localStorage) until invoiced — the invoice is the statutory record.',
    stats: [
      { label: 'Confirmed', sub: 'won, not yet delivered', icon: 'check', tone: 'blue', pick: 'active' },
      { label: 'Awaiting invoice', sub: 'fulfilled — ready to invoice', icon: 'clock', tone: 'amber', pick: 'closed' },
      { label: 'Draft', sub: 'not sent yet', icon: 'clipboard', tone: 'grey', pick: 'draft' },
      { label: 'Order book', sub: 'confirmed or fulfilled', icon: 'wallet', tone: 'cyan', pick: 'value' },
    ],
  },
  purchase_order: {
    eyebrow: 'Purchases',
    subtitle: 'What you have committed to buy — recorded before the goods arrive. Numbers are allocated on first save and never reused.',
    partyLabel: 'Vendor',
    partyNameLabel: 'Vendor (name) *',
    addressPlaceholder: 'Vendor address shown on the order',
    notesPlaceholder: 'Delivery instructions, remarks…',
    listHref: '/purchase-orders',
    itemsTitle: 'Items ordered',
    conversionLocal: 'Same state — the bill recorded from this order will split CGST + SGST',
    conversionInter: 'Interstate — the bill recorded from this order will carry IGST',
    totalsHint: "Committed value — the vendor's tax invoice is the tax document; the bill you record from this order carries the same figures.",
    emptyTitle: 'No purchase orders yet',
    emptyMessage: 'Raise a purchase order before goods arrive, mark it placed, then record the vendor\u2019s bill against it when it does.',
    footNote: "Orders are stored in this browser (localStorage) until billed — the vendor's bill in your books is the input-credit record.",
    stats: [
      { label: 'Placed', sub: 'sent to suppliers', icon: 'check', tone: 'blue', pick: 'active' },
      { label: 'Received', sub: "awaiting the vendor's bill", icon: 'box', tone: 'amber', pick: 'closed' },
      { label: 'Draft', sub: 'not placed yet', icon: 'clipboard', tone: 'grey', pick: 'draft' },
      { label: 'Committed spend', sub: 'placed or received', icon: 'wallet', tone: 'cyan', pick: 'value' },
    ],
  },
}

const num = (v: string) => Number(v) || 0
const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const money = (v: number) => inr0.format(v)
const todayISO = () => new Date().toISOString().split('T')[0]

const STATUS_TONE: Record<string, 'grey' | 'blue' | 'amber' | 'green' | 'red'> = {
  draft: 'grey', active: 'blue', closed: 'amber', converted: 'green', cancelled: 'red',
}

type StatusFilter = 'all' | 'draft' | 'active' | 'closed' | 'converted' | 'cancelled'

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

function OrderRegisterInner({ kind }: { kind: OrderKind }) {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const copy = COPY[kind]
  const meta = KIND_META[kind]

  const [orgId, setOrgId] = useState('')
  const [orgStateCode, setOrgStateCode] = useState('')
  const [parties, setParties] = useState<PartyRow[]>([])
  const [products, setProducts] = useState<ProductRow[]>([])
  const [docs, setDocs] = useState<FlowDoc[]>([])
  const [loading, setLoading] = useState(true)

  const [search, setSearch] = useSearchDeepLink()
  const [view, setView] = useState<StatusFilter>('all')

  // Modal state — `modalDoc` non-null means the editor is open.
  const [modalDoc, setModalDoc] = useState<FlowDoc | null>(null)
  const [modalLines, setModalLines] = useState<DraftLine[]>([])
  const [isNewDoc, setIsNewDoc] = useState(true)
  const [modalError, setModalError] = useState('')
  const [saving, setSaving] = useState(false)

  const fy = getFinancialYear()

  const views: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'draft', label: meta.statusLabels.draft },
    { value: 'active', label: meta.statusLabels.active },
    { value: 'closed', label: meta.statusLabels.closed },
    { value: 'converted', label: meta.statusLabels.converted },
    { value: 'cancelled', label: meta.statusLabels.cancelled },
  ]

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

      // Sales orders trade with customers; purchase orders with vendors.
      const master = kind === 'sales_order' ? 'customers' : 'vendors'
      const [{ data: partyRows }, { data: prods }] = await Promise.all([
        supabase.from(master).select('*').eq('organization_id', oid).eq('is_active', true).order('name'),
        supabase.from('products').select('*').eq('organization_id', oid).eq('is_active', true).order('name'),
      ])
      setParties(partyRows || [])
      setProducts(prods || [])

      const store = loadStore(kind, oid)
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
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function openCreate() {
    const doc = newDoc(kind, peekNumber(loadStore(kind, orgId), kind, fy), todayISO())
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

  function handlePartyChange(partyId: string) {
    if (!partyId) { patchModal({ party_id: null }); return }
    const p = parties.find(x => x.id === partyId)
    if (!p) return
    patchModal({
      party_id: p.id,
      party_name: p.name || '',
      party_gstin: p.gstin || '',
      party_address: [p.address_line1, p.city, p.state].filter(Boolean).join(', '),
      party_state: p.state_code || '',
      place_of_supply: p.state_code || modalDoc?.place_of_supply || '',
      supply_type: kind === 'sales_order' ? (p.customer_type || 'b2b') : 'b2b',
    })
  }

  function handleProductSelect(index: number, productId: string) {
    const p = products.find(x => x.id === productId)
    if (!p) { patchLine(index, 'product_id', ''); return }
    const rate = kind === 'purchase_order' ? (p.purchase_price ?? p.selling_price) : p.selling_price
    setModalLines(prev => prev.map((l, i) => (i === index ? {
      ...l,
      product_id: productId,
      item_name: p.name || '',
      hsn_sac: p.hsn_sac || '',
      unit: p.unit || 'NOS',
      rate: String(rate ?? ''),
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
    const store = loadStore(kind, orgId)
    let number = candidate.number
    let nextStore = store
    if (isNewDoc) {
      const taken = takeNumber(store, kind, fy)
      number = taken.number
      nextStore = taken.store
    }
    const finalDoc: FlowDoc = { ...candidate, number }
    const nextDocs = isNewDoc
      ? [...nextStore.docs, finalDoc]
      : nextStore.docs.map(d => (d.id === finalDoc.id ? finalDoc : d))
    const next = { ...nextStore, docs: nextDocs }
    saveStore(kind, orgId, next)
    setDocs(nextDocs)
    setSaving(false)
    closeEditor()
    router.push(`${copy.listHref}/${finalDoc.id}`)
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
    const open = docs.filter(d => d.status === 'active' || d.status === 'closed')
    return {
      draft: count('draft'),
      active: count('active'),
      closed: count('closed'),
      converted: count('converted'),
      openValue: open.reduce((s, d) => s + docValue(d), 0),
      openCount: open.length,
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
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading {meta.plural.toLowerCase()}…</div>
  }

  return (
    <div className="page-container ob" style={{ maxWidth: 1100 }}>
      <PageHeader
        eyebrow={copy.eyebrow}
        title={meta.plural}
        subtitle={copy.subtitle}
        actions={<Button icon="plus" onClick={openCreate}>New {meta.label.toLowerCase()}</Button>}
      />

      <div className="ob-stats">
        {copy.stats.map((s, i) => {
          const count = s.pick === 'active' ? summary.active
            : s.pick === 'closed' ? summary.closed
            : s.pick === 'draft' ? summary.draft
            : summary.openCount
          return (
            <StatCard key={s.label}
              label={s.label}
              value={s.pick === 'value' ? money(summary.openValue) : String(count)}
              sub={s.pick === 'value' ? `${summary.openCount} open orders ${s.sub}` : s.sub}
              icon={s.icon}
              tone={s.pick !== 'value' && count === 0 ? 'grey' : s.tone}
              delay={i * 40}
            />
          )
        })}
      </div>

      <div className="ob-toolbar">
        <Segmented options={views} value={view} onChange={v => setView(v as StatusFilter)} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Number, party or GSTIN…"
          ariaLabel={`Search ${meta.plural.toLowerCase()}`}
          style={{ flex: '1 1 240px', maxWidth: 340, marginLeft: 'auto' }}
        />
      </div>

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={docs.length ? 'search' : (kind === 'sales_order' ? 'bag' : 'clipboard-check')}
            title={docs.length
              ? (search ? `No order matches “${search}”` : `No ${views.find(v => v.value === view)?.label.toLowerCase()} orders`)
              : copy.emptyTitle}
            message={docs.length
              ? 'Clear the search or pick another status to see every order.'
              : copy.emptyMessage}
            action={!docs.length
              ? <Button size="sm" icon="plus" onClick={openCreate}>New {meta.label.toLowerCase()}</Button>
              : undefined}
          />
        </Card>
      ) : (
        <div className="table-frame">
          <div className="responsive-table">
            <div className="table-header ob-row ob-head">
              <span data-label="Order">Order</span>
              <span data-label="Party">{copy.partyLabel}</span>
              <span data-label="Date">Date</span>
              <span className="ob-right" data-label="Value">Value</span>
              <span data-label="Status">Status</span>
              <span className="ob-right" data-label="Open">Open</span>
            </div>
            {visible.map(d => (
              <div key={d.id} className={`table-row ob-row ${d.status === 'cancelled' ? 'ob-dim' : ''}`}>
                <span data-label="Order" className="ob-doc-cell">
                  <span className="ob-doc-number">{d.number}</span>
                </span>
                <span data-label="Party" className="ob-party">
                  <span>{d.party_name || '—'}</span>
                  {d.party_gstin && <span className="ob-sub ob-mono">{d.party_gstin}</span>}
                </span>
                <span data-label="Date">
                  <span className="ob-sub">{d.doc_date}</span>
                  {d.due_date && <div className="ob-sub ob-faint">by {d.due_date}</div>}
                </span>
                <span className="ob-right ob-amount" data-label="Value">
                  {money(docValue(d))}
                  <div className="ob-sub">{d.lines.filter(isUsableLine).length} items</div>
                </span>
                <span data-label="Status">
                  <Badge tone={STATUS_TONE[d.status] || 'grey'}>{meta.statusLabels[d.status]}</Badge>
                  {d.converted_to_number && <div className="ob-sub ob-faint">{d.converted_to_number}</div>}
                </span>
                <span className="ob-right" data-label="Open">
                  <Button size="sm" variant="subtle" icon="arrow-right"
                    onClick={() => router.push(`${copy.listHref}/${d.id}`)}>
                    Open
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="ob-foot">
        <span>Shown: {visible.length} of {docs.length}</span>
        <span>{summary.converted > 0 && `${summary.converted} converted. `}{copy.footNote}</span>
      </div>

      {modalDoc && (
        <div className="ob-scrim" role="dialog" aria-modal="true"
          aria-label={isNewDoc ? `New ${meta.label.toLowerCase()}` : `Edit ${modalDoc.number}`}>
          <div className="ob-modal">
            <div className="ob-modal-head">
              <div>
                <h2>{isNewDoc ? `New ${meta.label.toLowerCase()}` : `Edit ${modalDoc.number}`}</h2>
                <p>
                  {isNewDoc
                    ? `Number ${modalDoc.number} will be allocated when you save.`
                    : `${modalDoc.doc_date}${modalDoc.due_date ? ` · expected by ${modalDoc.due_date}` : ''}`}
                </p>
              </div>
              <button type="button" className="ob-close" onClick={closeEditor} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {modalError && (
              <div className="ob-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{modalError}</div>
            )}

            <div className="ob-grid">
              <label className="ob-field">
                <span>{copy.partyLabel}</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value={modalDoc.party_id || ''}
                  onChange={e => handlePartyChange(e.target.value)}>
                  <option value="">Type a name below…</option>
                  {parties.map(p => (
                    <option key={p.id} value={p.id}>{p.name}{p.business_name ? ` — ${p.business_name}` : ''}</option>
                  ))}
                </select>
              </label>
              <label className="ob-field">
                <span>{copy.partyNameLabel}</span>
                <input className="tf-input" value={modalDoc.party_name}
                  onChange={e => patchModal({ party_name: e.target.value })}
                  placeholder="Party name" />
              </label>
            </div>

            <div className="ob-grid">
              <label className="ob-field">
                <span>GSTIN</span>
                <input className="tf-input ob-mono" value={modalDoc.party_gstin}
                  onChange={e => patchModal({ party_gstin: e.target.value.toUpperCase() })}
                  placeholder="Optional" />
              </label>
              <label className="ob-field">
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

            <div className="ob-field">
              <span>Address</span>
              <input className="tf-input" value={modalDoc.party_address}
                onChange={e => patchModal({ party_address: e.target.value })}
                placeholder={copy.addressPlaceholder} />
            </div>

            <div className="ob-grid">
              <label className="ob-field">
                <span>Order date *</span>
                <input className="tf-input" type="date" value={modalDoc.doc_date}
                  onChange={e => patchModal({ doc_date: e.target.value })} />
              </label>
              <label className="ob-field">
                <span>Expected delivery</span>
                <input className="tf-input" type="date" value={modalDoc.due_date}
                  onChange={e => patchModal({ due_date: e.target.value })} />
              </label>
            </div>

            {modalDoc.place_of_supply && orgStateCode && (
              <div className={`ob-note ${gstType === 'cgst_sgst' ? 'is-local' : 'is-inter'}`}>
                <Icon name="check" size={13} strokeWidth={2.6} />
                {gstType === 'cgst_sgst' ? copy.conversionLocal : copy.conversionInter}
              </div>
            )}

            <div className="ob-lihead">
              <span className="ob-li-title">{copy.itemsTitle}</span>
            </div>

            <div className="line-items-head ob-linehead">
              <span>Item *</span>
              <span>HSN/SAC</span>
              <span>Qty *</span>
              <span>Rate (₹)</span>
              <span>Disc %</span>
              <span>GST %</span>
              <span className="ob-right">Amount</span>
              <span></span>
            </div>

            {modalLines.map((l, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div className="line-item-row ob-linerow">
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
                  <div data-label="Amount" className="ob-amount-cell">
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

            <label className="ob-field">
              <span>Notes (printed on the order)</span>
              <textarea className="tf-input ob-area" value={modalDoc.notes}
                onChange={e => patchModal({ notes: e.target.value })}
                placeholder={copy.notesPlaceholder} />
            </label>

            {modalTotals && (
              <div className="ob-totals">
                {[
                  { label: 'Taxable value', value: modalTotals.taxable_amount },
                  modalTotals.cgst_amount > 0 ? { label: 'CGST', value: modalTotals.cgst_amount } : null,
                  modalTotals.sgst_amount > 0 ? { label: 'SGST', value: modalTotals.sgst_amount } : null,
                  modalTotals.igst_amount > 0 ? { label: 'IGST', value: modalTotals.igst_amount } : null,
                  modalTotals.cess_amount > 0 ? { label: 'Cess', value: modalTotals.cess_amount } : null,
                  modalTotals.round_off !== 0 ? { label: 'Round off', value: modalTotals.round_off } : null,
                ].filter(Boolean).map(row => (
                  <div key={row!.label} className="ob-tot-row">
                    <span>{row!.label}</span>
                    <span>₹{formatINR(Math.abs(row!.value))}</span>
                  </div>
                ))}
                <div className="ob-tot-grand">
                  <span>Order value</span>
                  <span>₹{formatINR(modalTotals.grand_total)}</span>
                </div>
                <p className="ob-hint">{copy.totalsHint}</p>
              </div>
            )}

            <div className="ob-save">
              <Button variant="ghost" onClick={closeEditor} disabled={saving}>Cancel</Button>
              <Button icon={saving ? undefined : 'check'} onClick={save} disabled={saving}>
                {saving ? 'Saving…' : (isNewDoc ? `Save ${meta.label.toLowerCase()}` : 'Save changes')}
              </Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .ob-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .ob-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }

        .ob-row { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.5fr) minmax(0, 1fr) 116px minmax(0, 0.9fr) 96px;
          gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .ob-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .ob-right { text-align: right; }
        .ob-doc-cell { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
        .ob-doc-number { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
        .ob-party { display: flex; flex-direction: column; gap: 2px; color: var(--ink); min-width: 0; }
        .ob-sub { font-size: 11px; color: var(--faint); }
        .ob-faint { opacity: 0.85; }
        .ob-mono { font-family: ui-monospace, Menlo, monospace; }
        .ob-amount { color: var(--ink); font-weight: 650; }
        .ob-dim { opacity: 0.72; }
        .ob-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 11.5px;
          color: var(--faint); margin-top: 10px; }

        .ob-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .ob-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-width: 860px; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .ob-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .ob-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .ob-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; }
        .ob-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; flex-shrink: 0; }
        .ob-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .ob-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .ob-alert svg { flex-shrink: 0; }

        .ob-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
        .ob-grid-3 { grid-template-columns: 1fr 1fr 1fr; }
        .ob-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .ob-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .ob-area { height: 58px; resize: vertical; }

        .ob-note { display: flex; align-items: flex-start; gap: 6px; padding: 8px 12px; border-radius: 8px; font-size: 12px;
          background: var(--surface-2); color: var(--muted); border: 1px solid var(--line-soft); }
        .ob-note svg { flex-shrink: 0; margin-top: 2px; }
        .ob-note.is-local { background: var(--green-soft); border-color: color-mix(in srgb, var(--green) 22%, white); color: var(--green); }
        .ob-note.is-inter { background: var(--brand-soft); border-color: color-mix(in srgb, var(--brand) 22%, white); color: var(--brand-dark); }

        .ob-lihead { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
        .ob-li-title { font-size: 13px; font-weight: 650; color: var(--ink); }
        .ob-linehead { display: grid; grid-template-columns: 2fr 1fr 0.8fr 1fr 0.7fr 0.7fr 1fr 36px; gap: 6px; margin-bottom: 6px;
          font-size: 11px; font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.04em; }
        .ob-linehead .ob-right { text-align: right; }
        .ob-linerow { display: grid; grid-template-columns: 2fr 1fr 0.8fr 1fr 0.7fr 0.7fr 1fr 36px; gap: 6px; align-items: center; }
        .ob-amount-cell {
          padding: 8px 10px; background: var(--surface-2);
          border: 1px solid var(--line); border-radius: var(--radius-sm);
          font-size: 13px; font-weight: 500; color: var(--ink); text-align: right;
        }

        .ob-totals { border-top: 1px solid var(--line-soft); padding-top: 8px; }
        .ob-tot-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; color: var(--muted); }
        .ob-tot-row span:last-child { color: var(--ink); font-weight: 550; }
        .ob-tot-grand { display: flex; justify-content: space-between; padding: 8px 0 2px; font-size: 15px;
          font-weight: 700; color: var(--ink); }
        .ob-tot-grand span:last-child { color: var(--brand); }
        .ob-hint { font-size: 11px; color: var(--faint); line-height: 1.5; margin-top: 4px; }

        .ob-save { display: flex; gap: 10px; justify-content: flex-end; }

        @media (max-width: 1100px) { .ob-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .ob-row { grid-template-columns: 1fr; gap: 6px; }
          .ob-head { display: none; }
          .ob-right { text-align: left; }
          .ob-stats { grid-template-columns: 1fr 1fr; }
          .ob-grid, .ob-grid-3 { grid-template-columns: 1fr; }
          .ob-scrim { align-items: flex-end; padding: 0; }
          .ob-scrim .ob-modal { max-width: none; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .ob-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}

export default function OrderRegister({ kind }: { kind: OrderKind }) {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <OrderRegisterInner kind={kind} />
    </Suspense>
  )
}
