'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import { Badge, Button, Card, EmptyState, PageHeader, SearchInput, Segmented, StatCard } from '@/components/ui'
import Icon from '@/components/Icons'
import {
  EiInvoiceInput, EiSeller, EwbInput,
  validateEInvoice, buildEInvoiceJson, buildEwbJson, deriveInvoiceType,
  INVOICE_TYPE_LABELS, downloadJson, safeFilePart, stateNameFor,
} from '@/lib/einvoice'
import { upsertEwbEntry } from '@/lib/registers'
import { plural } from '@/lib/format'

// The portal only takes invoices that have been issued; a draft has no IRN to sign.
const WINDOW = 300

interface InvoiceRow {
  id: string
  invoice_number: string
  invoice_date: string
  due_date: string | null
  invoice_type: string
  customer_id: string
  customer_name: string
  customer_gstin: string | null
  customer_state_code: string | null
  place_of_supply: string
  is_reverse_charge: boolean
  taxable_amount: number
  discount_amount: number
  igst_amount: number
  cgst_amount: number
  sgst_amount: number
  cess_amount: number
  round_off: number
  grand_total: number
  status: string
}

interface CustomerRow {
  id: string
  name: string | null
  business_name: string | null
  gstin: string | null
  address_line1: string | null
  city: string | null
  state_code: string | null
  pincode: string | null
}

interface ItemRow {
  invoice_id: string
  item_name: string
  hsn_sac: string | null
  quantity: number
  unit: string | null
  rate: number
  discount_amount: number
  taxable_value: number
  gst_rate: number
  igst_amount: number
  cgst_amount: number
  sgst_amount: number
  cess_amount: number
}

interface OrgMaster {
  name: string | null
  address_line1: string | null
  city: string | null
  state_code: string | null
  pincode: string | null
}

interface Membership {
  organization_id: string
  organizations: OrgMaster | null
}

interface DocRow {
  inv: InvoiceRow
  input: EiInvoiceInput
  issues: string[]
  typeLabel: string
  draft: boolean
  docKind: string
}

const money = (value: number) => `₹${formatINR(value)}`

const DOC_KIND: Record<string, string> = {
  tax_invoice: 'Tax invoice',
  bill_of_supply: 'Bill of supply',
}

const FILTERS = [
  { value: 'ready', label: 'Ready' },
  { value: 'fix', label: 'To fix' },
  { value: 'draft', label: 'Drafts' },
  { value: 'all', label: 'All' },
]

export default function EInvoicePage() {
  const supabase = createClient()

  const [orgId, setOrgId] = useState('')
  const [seller, setSeller] = useState<EiSeller | null>(null)
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [customers, setCustomers] = useState<Map<string, CustomerRow>>(new Map())
  const [itemsByInvoice, setItemsByInvoice] = useState<Map<string, ItemRow[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [copied, setCopied] = useState(false)

  const [jsonModal, setJsonModal] = useState<{ title: string; data: Record<string, unknown>; issues: string[]; filename: string } | null>(null)
  const [inspect, setInspect] = useState<DocRow | null>(null)
  const [ewbFor, setEwbFor] = useState<InvoiceRow | null>(null)
  const [gspProvider, setGspProvider] = useState('mock')
  const [ewbSubmitting, setEwbSubmitting] = useState(false)
  const [ewbResult, setEwbResult] = useState<{ ewbNo: string; validityEndDate: string; mock: boolean } | null>(null)
  const [ewbError, setEwbError] = useState('')
  const [ewbForm, setEwbForm] = useState({
    fromPlace: '', fromPincode: '', toPlace: '',
    transportMode: 'Road' as EwbInput['transportMode'],
    vehicleType: 'Regular' as NonNullable<EwbInput['vehicleType']>,
    vehicleNumber: '', distanceKm: '', transactionType: 'O' as EwbInput['transactionType'],
  })

  function buildInput(inv: InvoiceRow): EiInvoiceInput {
    const cust = customers.get(inv.customer_id)
    const rawItems = itemsByInvoice.get(inv.id) || []
    const items: EiInvoiceInput['items'] = rawItems.map(it => ({
      description: it.item_name,
      hsnSac: it.hsn_sac || '',
      qty: Number(it.quantity) || 0,
      unit: it.unit || '',
      unitPrice: Number(it.rate) || 0,
      discountAmount: Number(it.discount_amount) || 0,
      taxableValue: Number(it.taxable_value) || 0,
      gstRate: Number(it.gst_rate) || 0,
      igst: Number(it.igst_amount) || 0,
      cgst: Number(it.cgst_amount) || 0,
      sgst: Number(it.sgst_amount) || 0,
      cess: Number(it.cess_amount) || 0,
    }))

    const pos = inv.place_of_supply || ''
    const bos = inv.invoice_type === 'bill_of_supply'
    return {
      invoiceNumber: inv.invoice_number,
      invoiceDate: inv.invoice_date,
      dueDate: inv.due_date,
      documentType: bos ? 'BIL' : 'INV',
      reverseCharge: !!inv.is_reverse_charge,
      isExport: pos === '99',
      placeOfSupply: pos,
      buyer: {
        gstin: cust?.gstin || inv.customer_gstin || '',
        name: cust?.business_name || cust?.name || inv.customer_name || '',
        address1: cust?.address_line1 || '',
        city: cust?.city || '',
        stateCode: cust?.state_code || inv.customer_state_code || '',
        pincode: cust?.pincode || '',
      },
      items,
      totals: {
        taxable: Number(inv.taxable_amount) || 0,
        discount: Number(inv.discount_amount) || 0,
        igst: Number(inv.igst_amount) || 0,
        cgst: Number(inv.cgst_amount) || 0,
        sgst: Number(inv.sgst_amount) || 0,
        cess: Number(inv.cess_amount) || 0,
        roundOff: Number(inv.round_off) || 0,
        grandTotal: Number(inv.grand_total) || 0,
      },
    }
  }

  useEffect(() => {
    async function loadDocuments() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setError('Not signed in.'); setLoading(false); return }

      const { data: memberData } = await supabase
        .from('org_members')
        .select('organization_id, organizations(name, address_line1, city, state_code, pincode)')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      const membership = memberData as unknown as Membership | null
      if (!membership) { setError('No organization found.'); setLoading(false); return }
      const org = membership.organizations
      setOrgId(membership.organization_id)

      const { data: gstReg } = await supabase
        .from('gst_registrations')
        .select('gstin, legal_name')
        .eq('organization_id', membership.organization_id)
        .eq('is_primary', true)
        .single()

      setSeller({
        gstin: gstReg?.gstin || '',
        legalName: gstReg?.legal_name || org?.name || '',
        tradeName: org?.name || '',
        address1: org?.address_line1 || '',
        city: org?.city || '',
        stateCode: org?.state_code || gstReg?.gstin?.slice(0, 2) || '',
        pincode: org?.pincode || '',
      })

      const { data: invData } = await supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, due_date, invoice_type, customer_id, customer_name, customer_gstin, customer_state_code, place_of_supply, is_reverse_charge, taxable_amount, discount_amount, igst_amount, cgst_amount, sgst_amount, cess_amount, round_off, grand_total, status')
        .eq('organization_id', membership.organization_id)
        .neq('status', 'cancelled')
        .order('invoice_date', { ascending: false })
        .limit(WINDOW)

      const invs = (invData || []) as InvoiceRow[]
      setInvoices(invs)
      if (invs.length === 0) { setLoading(false); return }

      // The window is capped at 300, so one batch stays inside Supabase's 500-id limit.
      const custIds = [...new Set(invs.map(i => i.customer_id).filter(Boolean))]
      const [itemsRes, custRes] = await Promise.all([
        supabase.from('invoice_items')
          .select('invoice_id, item_name, hsn_sac, quantity, unit, rate, discount_amount, taxable_value, gst_rate, igst_amount, cgst_amount, sgst_amount, cess_amount')
          .in('invoice_id', invs.map(i => i.id))
          .order('sort_order'),
        custIds.length
          ? supabase.from('customers')
            .select('id, name, business_name, gstin, address_line1, city, state_code, pincode')
            .in('id', custIds)
          : Promise.resolve({ data: [] as CustomerRow[] }),
      ])

      const map = new Map<string, ItemRow[]>()
      for (const it of ((itemsRes.data || []) as ItemRow[])) {
        const list = map.get(it.invoice_id) || []
        list.push(it)
        map.set(it.invoice_id, list)
      }
      setItemsByInvoice(map)

      const cmap = new Map<string, CustomerRow>()
      for (const c of ((custRes.data || []) as CustomerRow[])) cmap.set(c.id, c)
      setCustomers(cmap)

      setLoading(false)
    }

    loadDocuments()
  }, [])

  const rows = useMemo(
    () => invoices.map(inv => {
      const input = buildInput(inv)
      return {
        inv,
        input,
        draft: inv.status === 'draft',
        docKind: DOC_KIND[inv.invoice_type] || 'Tax invoice',
        typeLabel: INVOICE_TYPE_LABELS[deriveInvoiceType(input)] || deriveInvoiceType(input),
        issues: seller ? validateEInvoice(seller, input) : ['Seller details are still loading.'],
      }
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [invoices, seller, customers, itemsByInvoice]
  )

  const issued = rows.filter(r => !r.draft)
  const readyRows = issued.filter(r => r.issues.length === 0)
  const fixRows = issued.filter(r => r.issues.length > 0)
  const draftRows = rows.filter(r => r.draft)

  const buckets: Record<string, DocRow[]> = {
    ready: readyRows, fix: fixRows, draft: draftRows, all: rows,
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = buckets[filter] || rows
    if (!q) return list
    return list.filter(({ inv, input }) =>
      [inv.invoice_number, input.buyer.name, input.buyer.gstin || '', inv.place_of_supply]
        .some(v => String(v).toLowerCase().includes(q))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filter, search])

  const totalIssues = fixRows.reduce((s, r) => s + r.issues.length, 0)

  function openJson(row: DocRow) {
    if (!seller) return
    setCopied(false)
    setInspect(null)
    setJsonModal({
      title: `e-Invoice JSON — ${row.inv.invoice_number}`,
      data: buildEInvoiceJson(seller, row.input),
      issues: row.issues,
      filename: `einvoice_${safeFilePart(row.inv.invoice_number)}.json`,
    })
  }

  function closeModal() {
    setJsonModal(null)
    setCopied(false)
  }

  function openEwb(inv: InvoiceRow) {
    const cust = customers.get(inv.customer_id)
    setEwbFor(inv)
    setEwbResult(null)
    setEwbError('')
    setEwbForm(f => ({
      ...f,
      fromPlace: seller?.city || '',
      fromPincode: seller?.pincode || '',
      toPlace: cust?.city || '',
    }))
  }

  function buildEwbPayload(inv: InvoiceRow): Record<string, unknown> {
    const cust = customers.get(inv.customer_id)
    const rawItems = itemsByInvoice.get(inv.id) || []
    const input: EwbInput = {
      sellerGstin: seller?.gstin || '',
      sellerName: seller?.legalName || '',
      fromPincode: ewbForm.fromPincode || seller?.pincode || '',
      fromPlace: ewbForm.fromPlace || seller?.city || '',
      buyerName: cust?.business_name || cust?.name || inv.customer_name || '',
      buyerGstin: cust?.gstin || inv.customer_gstin || '',
      toPincode: cust?.pincode || '',
      toPlace: ewbForm.toPlace || cust?.city || '',
      toStateCode: inv.place_of_supply || '',
      invoiceNumber: inv.invoice_number,
      invoiceDate: inv.invoice_date,
      transactionType: ewbForm.transactionType,
      transportMode: ewbForm.transportMode,
      vehicleType: ewbForm.vehicleType,
      vehicleNumber: ewbForm.vehicleNumber || undefined,
      distanceKm: parseFloat(ewbForm.distanceKm) || 0,
      itemSummary: rawItems.map(it => ({
        description: it.item_name,
        hsnSac: it.hsn_sac || '',
        qty: Number(it.quantity) || 0,
      })),
    }
    return buildEwbJson(input)
  }

  function generateEwb() {
    if (!ewbFor) return
    const json = buildEwbPayload(ewbFor)
    setEwbFor(null)
    setCopied(false)
    setJsonModal({
      title: `E-way bill request — ${ewbFor.invoice_number}`,
      data: json,
      issues: [],
      filename: `ewaybill_${safeFilePart(ewbFor.invoice_number)}.json`,
    })
  }

  async function submitToGsp() {
    if (!ewbFor || ewbSubmitting) return
    setEwbSubmitting(true)
    setEwbError('')
    setEwbResult(null)
    try {
      const payload = buildEwbPayload(ewbFor)
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/gsp/ewaybill', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ providerId: gspProvider, payload }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`)
      setEwbResult({
        ewbNo: body.result.ewbNo,
        validityEndDate: body.result.validityEndDate,
        mock: Boolean(body.result.mock),
      })
      if (orgId) upsertEwbEntry(orgId, {
        invoiceId: ewbFor.id,
        invoiceNumber: ewbFor.invoice_number,
        party: ewbFor.customer_name || 'Unnamed',
        ewbNo: body.result.ewbNo,
        validityEnd: body.result.validityEndDate,
        vehicleNumber: ewbForm.vehicleNumber,
        transportMode: ewbForm.transportMode,
        fromPlace: ewbForm.fromPlace,
        toPlace: ewbForm.toPlace,
        distanceKm: ewbForm.distanceKm,
        goodsValue: Number(ewbFor.grand_total) || 0,
        source: 'generated',
        createdAt: new Date().toISOString(),
      })
    } catch (err) {
      setEwbError(err instanceof Error ? err.message : 'Submission failed.')
    } finally {
      setEwbSubmitting(false)
    }
  }

  const columns = [
    { key: 'invoice', label: 'Invoice', width: '1.1fr', align: 'left' },
    { key: 'buyer', label: 'Buyer', width: '1.6fr', align: 'left' },
    { key: 'value', label: 'Invoice value', width: '1fr', align: 'right' },
    { key: 'document', label: 'Document', width: '1fr', align: 'left' },
    { key: 'readiness', label: 'Readiness', width: '1.1fr', align: 'left' },
    { key: 'actions', label: 'Actions', width: 'auto', align: 'left' },
  ]
  const grid = columns.map(c => c.width).join(' ')

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Reading your issued invoices…</div>
  }

  return (
    <div className="page-container ef" style={{ maxWidth: 1080 }}>
      <PageHeader
        eyebrow="GST compliance"
        title="E-invoicing (IRN)"
        subtitle={seller
          ? `NIC-ready documents for ${seller.gstin || 'this organisation'} · ${readyRows.length} of ${issued.length} issued invoices can be signed as they are`
          : 'Generate the standard NIC e-invoice JSON and e-way bill request payloads'}
        actions={rows.length > 0 ? (
          <SearchInput
            value={search}
            onChange={v => { setSearch(v); setFilter('all') }}
            ariaLabel="Search by invoice number, buyer or GSTIN"
            placeholder="Invoice no., buyer, GSTIN…"
            style={{ width: '100%', maxWidth: 260 }}
          />
        ) : undefined}
      />

      <div className="ef-alert is-info">
        <Icon name="book" size={15} />
        <span>
          <strong>How this works:</strong> e-invoicing is mandatory for B2B invoices once aggregate turnover
          crosses ₹5 crore. Each row below builds the standard <code>Ctx 1.10</code> JSON exactly as NIC expects it.
          Above ₹10 crore turnover every invoice must be reported within <strong>30 days</strong> of its date
          (since 1 April 2025) — miss that window and the IRN cannot be generated at all, which costs your buyer
          the input credit. Upload or paste the file into your GSP / the e-invoice portal to sign it; the portal
          returns the <strong>IRN and QR code</strong> you print on the invoice. Nothing leaves this browser until you send it.
        </span>
      </div>

      {error && (
        <div className="ef-alert is-error">
          <Icon name="alert" size={15} />
          <span>{error}</span>
        </div>
      )}

      {seller && !seller.gstin && (
        <div className="ef-alert is-error">
          <Icon name="alert" size={15} />
          <span>No primary GSTIN for this organisation yet. Add it under Settings → GST registration before generating e-invoices.</span>
        </div>
      )}

      {rows.length === 0 ? (
        <Card className="ef-card">
          <EmptyState
            icon="invoice"
            title="No invoices to e-invoice"
            message="E-invoice payloads are built from your issued invoices. Create an invoice and it appears here, validated against the NIC rules before you sign it."
            action={<Button variant="primary" icon="plus" href="/invoices/new">New invoice</Button>}
          />
        </Card>
      ) : (
        <>
          <div className="ef-metrics">
            <StatCard label="Ready to sign" value={`${readyRows.length}`} tone="green" icon="check"
              sub={issued.length ? `${Math.round(readyRows.length / issued.length * 100)}% of issued invoices` : 'Nothing issued yet'} />
            <StatCard label="Needs fixing" value={`${fixRows.length}`} tone={fixRows.length ? 'amber' : 'green'} icon="alert"
              sub={totalIssues ? `${plural(totalIssues, 'field')} NIC will reject` : 'No validation errors'} />
            <StatCard label="Drafts" value={`${draftRows.length}`} tone="grey" icon="clipboard"
              sub="No IRN until they are issued" />
            <StatCard label="Invoice value ready" value={readyRows.reduce((s, r) => s + Number(r.inv.grand_total), 0)}
              tone="blue" icon="invoice" sub={`Latest ${WINDOW} documents, cancelled excluded`} />
          </div>

          <div className="ef-tabs">
            <Segmented value={filter} onChange={v => setFilter(v)}
              options={FILTERS.map(f => ({
                value: f.value,
                label: f.value === 'all' ? `All ${rows.length}` : `${f.label} ${(buckets[f.value] || []).length}`,
              }))} />
            <span className="ef-tabs-note">
              {search ? `Matching “${search}”` : `Showing ${visible.length} of ${rows.length}`}
            </span>
          </div>

          {visible.length === 0 ? (
            <Card className="ef-card">
              <EmptyState
                icon="check"
                title={filter === 'fix' ? 'Nothing to fix' : filter === 'ready' ? 'No invoice is ready yet' : filter === 'draft' ? 'No drafts' : 'No invoice matches that search'}
                message={search
                  ? 'Clear the search, or switch tab to see the rest of the window.'
                  : filter === 'ready'
                    ? 'Open the Needs fixing tab and NIC will tell you exactly which field is missing.'
                    : undefined}
                action={search ? <Button variant="subtle" icon="x" onClick={() => setSearch('')}>Clear search</Button> : undefined}
              />
            </Card>
          ) : (
            <div className="table-frame ef-frame">
              <div className="table-scroll">
                <div className="responsive-table">
                  <div className="ef-cols ef-head" style={{ gridTemplateColumns: grid }}>
                    {columns.map(c => (
                      <span key={c.key} className={c.align === 'right' ? 'is-right' : undefined}>{c.label}</span>
                    ))}
                  </div>
                  {visible.map(row => (
                    <div key={row.inv.id} className="ef-cols ef-row tf-tr" style={{ gridTemplateColumns: grid }}>
                      <span className="ef-td is-lead" data-label="Invoice">
                        <span className="ef-lead">
                          <strong>{row.inv.invoice_number}</strong>
                          <em>{new Date(row.inv.invoice_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                            {row.input.placeOfSupply ? ` · POS ${row.input.placeOfSupply}` : ''}</em>
                        </span>
                      </span>

                      <span className="ef-td" data-label="Buyer">
                        <span className="ef-buyer">
                          <strong>{row.input.buyer.name || '—'}</strong>
                          <em>{row.input.buyer.gstin || 'Unregistered buyer'}</em>
                        </span>
                      </span>

                      <span className="ef-td is-right" data-label="Invoice value">{money(Number(row.inv.grand_total))}</span>

                      <span className="ef-td" data-label="Document">
                        <span className="ef-doc">
                          <Badge tone={row.docKind === 'Bill of supply' ? 'grey' : 'cyan'} dot={false}>{row.docKind}</Badge>
                          <em>{row.typeLabel}{row.input.reverseCharge ? ' · reverse charge' : ''}</em>
                        </span>
                      </span>

                      <span className="ef-td" data-label="Readiness">
                        {row.draft ? (
                          <Badge tone="grey">Draft</Badge>
                        ) : row.issues.length === 0 ? (
                          <Badge tone="green">Ready to sign</Badge>
                        ) : (
                          <button type="button" className="ef-fixbtn" onClick={() => setInspect(row)}
                            title={row.issues.join('\n')}>
                            <Badge tone="amber" dot={false}>{row.issues.length} to fix</Badge>
                            <Icon name="search" size={13} />
                          </button>
                        )}
                      </span>

                      <span className="ef-td ef-actions" data-label="Actions">
                        <Button variant={row.issues.length === 0 && !row.draft ? 'primary' : 'subtle'}
                          size="sm" icon="zap" onClick={() => openJson(row)}>IRN JSON</Button>
                        <Button variant="ghost" size="sm" icon="box" onClick={() => openEwb(row.inv)}>E-way bill</Button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <p className="ef-foot">
            A B2C bill of supply and invoices to unregistered buyers below the notification threshold do not need an IRN.
            Every payload here is built in your browser from the invoice and its line items — signing and IRN generation
            stay at the NIC/GSP end, so the document you print always carries the portal&apos;s own signature.
          </p>
        </>
      )}

      {inspect && (
        <div className="ef-scrim" role="dialog" aria-modal="true" aria-label={`Fixes needed on ${inspect.inv.invoice_number}`}
          onClick={() => setInspect(null)}>
          <div className="ef-modal ef-modal-narrow" onClick={e => e.stopPropagation()}>
            <div className="ef-modal-head">
              <h2>Before NIC will accept {inspect.inv.invoice_number}</h2>
              <button type="button" className="ef-close" onClick={() => setInspect(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            <p className="ef-modal-note">
              {inspect.input.buyer.name || 'This buyer'} · {money(Number(inspect.inv.grand_total))} ·{' '}
              {DOC_KIND[inspect.inv.invoice_type] || 'Tax invoice'} ({inspect.typeLabel})
            </p>

            <ul className="ef-issues">
              {inspect.issues.map((iss, i) => (
                <li key={i}>{iss}</li>
              ))}
            </ul>

            <div className="ef-modal-actions">
              <Button variant="ghost" size="sm" href={`/invoices/${inspect.inv.id}`}>Open invoice</Button>
              <Button variant="subtle" size="sm" icon="x" onClick={() => setInspect(null)}>Close</Button>
              <Button variant="primary" size="sm" icon="zap" onClick={() => openJson(inspect)}>
                Build the JSON anyway
              </Button>
            </div>
          </div>
        </div>
      )}

      {jsonModal && (
        <div className="ef-scrim" role="dialog" aria-modal="true" aria-label={jsonModal.title} onClick={closeModal}>
          <div className="ef-modal" onClick={e => e.stopPropagation()}>
            <div className="ef-modal-head">
              <h2>{jsonModal.title}</h2>
              <button type="button" className="ef-close" onClick={closeModal} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {jsonModal.issues.length > 0 && (
              <div className="ef-alert is-warn" style={{ marginTop: 0, marginBottom: 12 }}>
                <Icon name="alert" size={15} />
                <span>
                  <strong>NIC will reject this until fixed:</strong>{' '}
                  {jsonModal.issues.join(' ')}
                </span>
              </div>
            )}

            <pre className="ef-json">{JSON.stringify(jsonModal.data, null, 2)}</pre>

            {copied && (
              <div className="ef-alert is-success" style={{ marginTop: 12 }}>
                <Icon name="check" size={15} />
                <span>Copied — paste it into your GSP&apos;s e-invoice JSON tab.</span>
              </div>
            )}

            <div className="ef-modal-actions">
              <Button variant="ghost" size="sm" icon="x" onClick={closeModal}>Close</Button>
              <Button variant="subtle" size="sm" icon="clipboard" onClick={() => {
                navigator.clipboard.writeText(JSON.stringify(jsonModal.data, null, 2))
                setCopied(true)
              }}>Copy JSON</Button>
              <Button variant="primary" size="sm" icon="download"
                onClick={() => downloadJson(jsonModal.filename, jsonModal.data)}>
                Download {jsonModal.filename}
              </Button>
            </div>
          </div>
        </div>
      )}

      {ewbFor && (
        <div className="ef-scrim" role="dialog" aria-modal="true"
          aria-label={`E-way bill for ${ewbFor.invoice_number}`} onClick={() => setEwbFor(null)}>
          <div className="ef-modal ef-modal-narrow" onClick={e => e.stopPropagation()}>
            <div className="ef-modal-head">
              <h2>E-way bill — {ewbFor.invoice_number}</h2>
              <button type="button" className="ef-close" onClick={() => setEwbFor(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="ef-grid">
              <label className="ef-field">
                <span>Dispatch place</span>
                <input className="tf-input" value={ewbForm.fromPlace}
                  onChange={e => setEwbForm({ ...ewbForm, fromPlace: e.target.value })} />
              </label>
              <label className="ef-field">
                <span>Dispatch pincode</span>
                <input className="tf-input" inputMode="numeric" maxLength={6} value={ewbForm.fromPincode}
                  onChange={e => setEwbForm({ ...ewbForm, fromPincode: e.target.value })} />
              </label>
              <label className="ef-field">
                <span>Delivery place — {stateNameFor(ewbFor.place_of_supply) || 'destination'}</span>
                <input className="tf-input" value={ewbForm.toPlace}
                  onChange={e => setEwbForm({ ...ewbForm, toPlace: e.target.value })} />
              </label>
              <label className="ef-field">
                <span>Distance (km)</span>
                <input className="tf-input" type="number" min={0} value={ewbForm.distanceKm}
                  placeholder="e.g. 240"
                  onChange={e => setEwbForm({ ...ewbForm, distanceKm: e.target.value })} />
              </label>
              <label className="ef-field">
                <span>Transport mode</span>
                <select className="tf-input" value={ewbForm.transportMode}
                  onChange={e => setEwbForm({ ...ewbForm, transportMode: e.target.value as EwbInput['transportMode'] })}>
                  <option>Road</option><option>Rail</option><option>Air</option><option>Ship</option>
                </select>
              </label>
              <label className="ef-field">
                <span>Vehicle type</span>
                <select className="tf-input" value={ewbForm.vehicleType}
                  onChange={e => setEwbForm({ ...ewbForm, vehicleType: e.target.value as NonNullable<EwbInput['vehicleType']> })}>
                  <option>Regular</option><option>Hired</option><option>Consignor own</option><option>Consignee own</option>
                </select>
              </label>
              <label className="ef-field">
                <span>Vehicle / transport doc no.</span>
                <input className="tf-input" value={ewbForm.vehicleNumber} placeholder="MH12AB1234 or LR no."
                  onChange={e => setEwbForm({ ...ewbForm, vehicleNumber: e.target.value })} />
              </label>
              <label className="ef-field">
                <span>Transaction type</span>
                <select className="tf-input" value={ewbForm.transactionType}
                  onChange={e => setEwbForm({ ...ewbForm, transactionType: e.target.value as EwbInput['transactionType'] })}>
                  <option value="O">Outward (sale)</option>
                  <option value="C">Supply on sale / approval</option>
                  <option value="D">Inward</option>
                  <option value="E">Export</option>
                </select>
              </label>
            </div>

            <p className="ef-modal-note">
              Buyer pincode, GSTIN and the item HSN/quantity summary are pulled from the invoice and the customer
              master — only the movement details are asked for here.
            </p>

            {ewbResult && (
              <div className="ef-alert is-success">
                <Icon name="check" size={15} />
                <span>
                  <strong>
                    {ewbResult.mock && <Badge tone="amber" dot={false}>MOCK</Badge>}
                    {' '}E-way bill generated
                  </strong>
                  <br />
                  <span className="ef-mono">EWB No: {ewbResult.ewbNo}</span>
                  <br />
                  Valid till {ewbResult.validityEndDate}
                  {ewbResult.mock && (
                    <>
                      <br />
                      <span className="ef-warn-text">Simulated only — no e-way bill exists on the government system yet.</span>
                    </>
                  )}
                </span>
              </div>
            )}

            {ewbError && (
              <div className="ef-alert is-error">
                <Icon name="alert" size={15} />
                <span>{ewbError}</span>
              </div>
            )}

            <div className="ef-modal-actions">
              <label className="ef-channel">
                <span>Channel</span>
                <select className="tf-input" value={gspProvider} onChange={e => setGspProvider(e.target.value)}
                  aria-label="GSP provider">
                  <option value="mock">Mock GSP (local simulator)</option>
                </select>
              </label>
              <Button variant="subtle" size="sm" icon="download" onClick={generateEwb}>Download request JSON</Button>
              <Button variant="primary" size="sm" icon="upload" onClick={submitToGsp} disabled={ewbSubmitting}>
                {ewbSubmitting ? 'Submitting…' : 'Submit to GSP'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .ef-alert {
          display: flex; gap: 8px; align-items: flex-start; font-size: 12px; line-height: 1.65;
          border: 1px solid var(--line); border-radius: var(--radius); padding: 11px 13px; margin-bottom: 14px;
        }
        .ef-alert svg { flex-shrink: 0; margin-top: 2px; }
        .ef-alert.is-info { background: var(--cyan-soft); color: #0e7490; }
        .ef-alert.is-warn { background: var(--amber-soft); color: #b45309; }
        .ef-alert.is-error { background: var(--red-soft); color: #b91c1c; }
        .ef-alert.is-success { background: var(--green-soft); color: #15803d; }
        .ef-alert code {
          font-family: var(--mono); font-size: 11px;
          background: var(--surface); padding: 1px 5px; border-radius: 4px;
        }

        .ef-card { margin-bottom: 1rem; }
        .ef-metrics {
          display: grid; gap: 0.9rem; margin-bottom: 1rem;
          grid-template-columns: repeat(auto-fit, minmax(196px, 1fr));
        }
        .ef-tabs { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
        .ef-tabs-note { font-size: 11.5px; color: var(--faint); }

        .ef-frame { overflow: hidden; }
        .ef-cols {
          display: grid; gap: 10px; padding: 10px 1.3rem; align-items: center;
          font-size: 12px; color: var(--ink-2);
        }
        .ef-head {
          background: var(--surface-2);
          border-bottom: 1px solid var(--line-soft);
          font-size: 10.5px; font-weight: 700; color: var(--faint);
          text-transform: uppercase; letter-spacing: 0.05em;
        }
        .ef-head .is-right, .ef-td.is-right { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .ef-row { border-bottom: 1px solid var(--line-soft); }
        .ef-row:last-child { border-bottom: none; }
        .ef-lead strong, .ef-buyer strong { display: block; font-size: 12.5px; font-weight: 600; color: var(--ink); }
        .ef-lead em, .ef-buyer em {
          display: block; font-style: normal; font-size: 11px; color: var(--faint);
          font-family: var(--mono);
        }
        .ef-doc { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
        .ef-doc em { font-style: normal; font-size: 11px; color: var(--muted); }
        .ef-fixbtn {
          display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
          font-family: inherit; background: none; border: none; padding: 0; color: var(--faint);
        }
        .ef-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
        .ef-mono { font-family: var(--mono); font-size: 12px; word-break: break-all; }
        .ef-warn-text { font-size: 11.5px; color: #b45309; }

        .ef-scrim {
          position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); z-index: 100;
          display: flex; align-items: center; justify-content: center; padding: 1rem;
        }
        .ef-modal {
          background: var(--surface); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);
          width: 100%; max-width: 760px; max-height: 90vh; overflow-y: auto; padding: 1.4rem 1.5rem;
        }
        .ef-modal-narrow { max-width: 600px; }
        .ef-modal-head {
          display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px;
        }
        .ef-modal-head h2 { font-size: 16px; font-weight: 650; color: var(--ink); margin: 0; }
        .ef-close {
          background: none; border: none; color: var(--faint); cursor: pointer;
          padding: 5px; border-radius: 6px; display: flex;
        }
        .ef-close:hover { background: var(--slate-soft); color: var(--ink-2); }
        .ef-modal-note { font-size: 11.5px; color: var(--muted); line-height: 1.6; margin: 0 0 12px; }
        .ef-modal-actions {
          display: flex; gap: 8px; justify-content: flex-end; align-items: flex-end;
          flex-wrap: wrap; margin-top: 16px;
        }
        .ef-issues { margin: 0; padding-left: 1.1rem; font-size: 12.5px; color: var(--ink-2); line-height: 1.9; }
        .ef-json {
          margin: 0; padding: 14px 16px; max-height: 46vh; overflow: auto;
          background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-sm);
          font-family: var(--mono); font-size: 11.5px; line-height: 1.6;
          color: var(--ink-2); white-space: pre; tab-size: 2;
        }
        .ef-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .ef-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .ef-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .ef-channel { display: flex; flex-direction: column; gap: 4px; margin-right: auto; }
        .ef-channel > span { font-size: 11px; font-weight: 550; color: var(--faint); }
        .ef-channel select { min-width: 190px; font-size: 12px; }
        .ef-foot { font-size: 11.5px; color: var(--faint); line-height: 1.7; margin-top: 14px; }

        @media (max-width: 768px) {
          .ef-metrics { grid-template-columns: 1fr 1fr; }
          .ef-cols { grid-template-columns: 1fr !important; gap: 5px; padding: 12px 14px; }
          /* .table-frame goes transparent on mobile, so each row has to card itself. */
          .ef-row {
            border: 1px solid var(--line); border-radius: var(--radius);
            background: var(--surface); margin: 0 0 10px;
          }
          .ef-row:last-child { margin-bottom: 0; }
          .ef-head { display: none !important; }
          .ef-td {
            display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
            text-align: left; white-space: normal; overflow: visible;
          }
          /* .is-right sets nowrap on desktop; match its specificity or the amount cannot wrap. */
          .ef-td.is-right { white-space: normal; }
          .ef-td.is-lead { display: block; }
          .ef-td.is-lead::before { content: none; }
          .ef-td::before {
            content: attr(data-label); font-size: 10.5px; font-weight: 700; color: var(--faint);
            text-transform: uppercase; letter-spacing: 0.05em; flex-shrink: 0;
          }
          .ef-actions { justify-content: flex-start; }
          .ef-grid { grid-template-columns: 1fr; }
          .ef-channel { margin-right: 0; width: 100%; }
          .ef-modal-actions .tf-btn { flex: 1; justify-content: center; }
        }
      `}</style>
    </div>
  )
}
