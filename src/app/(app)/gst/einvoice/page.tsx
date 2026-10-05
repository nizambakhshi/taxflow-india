'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import {
  EiInvoiceInput, EiLineItem, EiSeller, EwbInput,
  validateEInvoice, buildEInvoiceJson, buildEwbJson, deriveInvoiceType,
  INVOICE_TYPE_LABELS, downloadJson, safeFilePart, stateNameFor,
} from '@/lib/einvoice'

interface InvoiceRow {
  id: string
  invoice_number: string
  invoice_date: string
  due_date: string | null
  invoice_type: string
  customer_id: string
  customer_name: string
  customer_gstin: string | null
  customer_address: string | null
  customer_state_code: string | null
  place_of_supply: string
  supply_type: string
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
  sort_order: number
}

export default function EInvoicePage() {
  const supabase = createClient()

  const [orgId, setOrgId] = useState('')
  const [seller, setSeller] = useState<EiSeller | null>(null)
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [customers, setCustomers] = useState<Map<string, CustomerRow>>(new Map())
  const [itemsByInvoice, setItemsByInvoice] = useState<Map<string, ItemRow[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [jsonModal, setJsonModal] = useState<{ title: string; json: string; issues: string[]; filename: string } | null>(null)
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

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setError('Not signed in.'); setLoading(false); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id, organizations(name, address_line1, city, state_code, pincode)')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { setError('No organization found.'); setLoading(false); return }
      const org = membership.organizations as any
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
        .select('*')
        .eq('organization_id', membership.organization_id)
        .neq('status', 'cancelled')
        .order('invoice_date', { ascending: false })
        .limit(300)

      const invs = (invData || []) as InvoiceRow[]
      setInvoices(invs)

      if (invs.length > 0) {
        const invIds = invs.map(i => i.id)
        const custIds = [...new Set(invs.map(i => i.customer_id).filter(Boolean))]

        const [itemsRes, custRes] = await Promise.all([
          supabase.from('invoice_items')
            .select('invoice_id, item_name, hsn_sac, quantity, unit, rate, discount_amount, taxable_value, gst_rate, igst_amount, cgst_amount, sgst_amount, cess_amount, sort_order')
            .in('invoice_id', invIds)
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
      }

      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function buildInput(inv: InvoiceRow): EiInvoiceInput {
    const cust = customers.get(inv.customer_id)
    const rawItems = itemsByInvoice.get(inv.id) || []
    const items: EiLineItem[] = rawItems.map(it => ({
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
    return {
      invoiceNumber: inv.invoice_number,
      invoiceDate: inv.invoice_date,
      dueDate: inv.due_date,
      documentType: 'INV',
      reverseCharge: !!inv.is_reverse_charge,
      isExport: pos === '99' || pos === '01',
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

  const rows = useMemo(
    () => invoices.map(inv => ({ inv, issues: seller ? validateEInvoice(seller, buildInput(inv)) : ['Seller not loaded yet.'] })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [invoices, seller, customers, itemsByInvoice]
  )

  const readyCount = rows.filter(r => r.issues.length === 0).length

  function openJson(inv: InvoiceRow, issues: string[]) {
    if (!seller) return
    const input = buildInput(inv)
    const json = buildEInvoiceJson(seller, input)
    setJsonModal({
      title: `e-Invoice JSON — ${inv.invoice_number}`,
      json: JSON.stringify(json, null, 2),
      issues,
      filename: `einvoice_${safeFilePart(inv.invoice_number)}.json`,
    })
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
    setJsonModal({
      title: `E-way bill request — ${ewbFor.invoice_number}`,
      json: JSON.stringify(json, null, 2),
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
    } catch (err) {
      setEwbError(err instanceof Error ? err.message : 'Submission failed.')
    } finally {
      setEwbSubmitting(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: '8px',
    fontSize: '13px', width: '100%', boxSizing: 'border-box', background: 'white',
  }

  if (loading) {
    return <div className="page-container"><p style={{ color: '#64748b' }}>Loading invoices...</p></div>
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">E-Invoicing (IRN)</h1>
          <p className="page-subtitle">
            Generate NIC e-invoice JSON for your invoices and e-way bill request payloads.
            Ready invoices are {readyCount} of {rows.length}.
          </p>
        </div>
      </div>

      <div style={{
        background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '12px',
        padding: '12px 16px', marginBottom: '16px', fontSize: '13px', color: '#1e40af', lineHeight: 1.5,
      }}>
        <strong>How this works:</strong> e-invoicing is mandatory for B2B invoices when aggregate turnover
        exceeds ₹5 crore. For each invoice below we build the standard <code style={{ background: '#dbeafe', padding: '1px 5px', borderRadius: '4px' }}>Ctx 1.10</code> JSON —
        upload or paste it into your GSP / the NIC e-invoice portal (or your accounting integration) to sign it and receive the
        <strong> IRN + QR code</strong>, which you then print on the invoice PDF. Nothing is sent from this app.
      </div>

      {seller && !seller.gstin && (
        <div style={{
          background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '12px',
          padding: '12px 16px', marginBottom: '16px', fontSize: '13px', color: '#991b1b',
        }}>
          No primary GSTIN found for this organization. Add it under Settings → GST registration before generating e-invoices.
        </div>
      )}

      {error && (
        <div style={{
          background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '12px',
          padding: '12px 16px', marginBottom: '16px', fontSize: '13px', color: '#991b1b',
        }}>{error}</div>
      )}

      {rows.length === 0 && (
        <div className="panel" style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
          No invoices found. Create an invoice first — it will appear here for e-invoice generation.
        </div>
      )}

      {rows.length > 0 && (
        <div className="panel" style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', overflow: 'hidden' }}>
          <div className="responsive-table">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr className="table-header" style={{ background: '#f8fafc', textAlign: 'left' }}>
                  <th style={{ padding: '10px 14px' }}>Invoice</th>
                  <th style={{ padding: '10px 14px' }}>Date</th>
                  <th style={{ padding: '10px 14px' }}>Buyer</th>
                  <th style={{ padding: '10px 14px' }}>Value</th>
                  <th style={{ padding: '10px 14px' }}>Type</th>
                  <th style={{ padding: '10px 14px' }}>Readiness</th>
                  <th style={{ padding: '10px 14px' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ inv, issues }) => {
                  const ready = issues.length === 0
                  const invType = deriveInvoiceType(buildInput(inv))
                  return (
                    <tr key={inv.id} className="table-row" style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td className="table-cell" data-label="Invoice" style={{ padding: '10px 14px', fontWeight: 600, color: '#1e293b' }}>
                        {inv.invoice_number}
                      </td>
                      <td className="table-cell" data-label="Date" style={{ padding: '10px 14px', color: '#64748b' }}>
                        {inv.invoice_date}
                      </td>
                      <td className="table-cell" data-label="Buyer" style={{ padding: '10px 14px' }}>
                        <div>{inv.customer_name}</div>
                        <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'monospace' }}>
                          {customers.get(inv.customer_id)?.gstin || inv.customer_gstin || 'Unregistered'}
                        </div>
                      </td>
                      <td className="table-cell" data-label="Value" style={{ padding: '10px 14px' }}>
                        {formatINR(Number(inv.grand_total))}
                      </td>
                      <td className="table-cell" data-label="Type" style={{ padding: '10px 14px' }}>
                        <span style={{
                          fontSize: '11px', padding: '2px 8px', borderRadius: '99px',
                          background: '#f1f5f9', color: '#475569', fontWeight: 600,
                        }}>
                          {INVOICE_TYPE_LABELS[invType] || invType}
                        </span>
                      </td>
                      <td className="table-cell" data-label="Readiness" style={{ padding: '10px 14px' }}>
                        {ready ? (
                          <span style={{
                            fontSize: '11px', padding: '2px 8px', borderRadius: '99px',
                            background: '#dcfce7', color: '#166534', fontWeight: 600,
                          }}>● Ready</span>
                        ) : (
                          <span style={{ cursor: 'help' }} title={issues.join('\n')}>
                            <span style={{
                              fontSize: '11px', padding: '2px 8px', borderRadius: '99px',
                              background: '#fef9c3', color: '#854d0e', fontWeight: 600,
                            }}>⚠ {issues.length} to fix</span>
                          </span>
                        )}
                      </td>
                      <td className="table-cell" data-label="Actions">
                        <div className="btn-group" style={{ padding: '8px 0' }}>
                          <button onClick={() => openJson(inv, issues)} style={{
                            padding: '6px 12px', background: ready ? '#2563eb' : '#eff6ff',
                            color: ready ? 'white' : '#2563eb',
                            border: ready ? 'none' : '1px solid #bfdbfe',
                            borderRadius: '8px', fontSize: '12px', cursor: 'pointer', fontWeight: 600,
                          }}>
                            ⚡ e-Invoice JSON
                          </button>
                          <button onClick={() => openEwb(inv)} style={{
                            padding: '6px 12px', background: 'white',
                            color: '#374151', border: '1px solid #e2e8f0',
                            borderRadius: '8px', fontSize: '12px', cursor: 'pointer',
                          }}>
                            🚚 E-way bill
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '16px' }}>
        Note: B2C (bill of supply) invoices and invoices to unregistered buyers below the threshold do not need IRNs.
        The e-invoice JSON is generated locally in your browser; signing happens at the NIC/GSP end.
      </p>

      {/* ── JSON modal ── */}
      {jsonModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
          zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
        }} onClick={() => setJsonModal(null)}>
          <div style={{
            background: 'white', borderRadius: '16px', width: '100%', maxWidth: '720px',
            maxHeight: '86vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 700, fontSize: '15px', color: '#1e293b' }}>{jsonModal.title}</div>
              <button onClick={() => setJsonModal(null)} style={{
                background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', color: '#94a3b8',
              }}>✕</button>
            </div>

            {jsonModal.issues.length > 0 && (
              <div style={{
                margin: '12px 20px 0', padding: '10px 14px', background: '#fef9c3',
                border: '1px solid #fde68a', borderRadius: '10px', fontSize: '12px', color: '#854d0e',
              }}>
                <strong>NIC will reject this JSON until fixed:</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
                  {jsonModal.issues.map((iss, i) => <li key={i}>{iss}</li>)}
                </ul>
              </div>
            )}

            <div style={{ flex: 1, overflow: 'auto', padding: '12px 20px' }}>
              <pre style={{
                background: '#0f172a', color: '#e2e8f0', borderRadius: '10px',
                padding: '16px', fontSize: '12px', lineHeight: 1.5, overflow: 'auto', margin: 0,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {jsonModal.json}
              </pre>
            </div>

            <div style={{ padding: '14px 20px', borderTop: '1px solid #e2e8f0', display: 'flex', gap: '10px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button onClick={() => { navigator.clipboard.writeText(jsonModal.json) }} style={{
                padding: '9px 16px', background: 'white', color: '#374151',
                border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '13px', cursor: 'pointer', fontWeight: 600,
              }}>
                📋 Copy JSON
              </button>
              <button onClick={() => {
                downloadJson(jsonModal.filename, JSON.parse(jsonModal.json))
              }} style={{
                padding: '9px 16px', background: '#2563eb', color: 'white',
                border: 'none', borderRadius: '8px', fontSize: '13px', cursor: 'pointer', fontWeight: 600,
              }}>
                ↓ Download {jsonModal.filename}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── E-way bill modal ── */}
      {ewbFor && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
          zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
        }} onClick={() => setEwbFor(null)}>
          <div style={{
            background: 'white', borderRadius: '16px', width: '100%', maxWidth: '560px',
            maxHeight: '86vh', overflow: 'auto', padding: '20px',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <div style={{ fontWeight: 700, fontSize: '15px', color: '#1e293b' }}>
                E-way bill — {ewbFor.invoice_number}
              </div>
              <button onClick={() => setEwbFor(null)} style={{
                background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', color: '#94a3b8',
              }}>✕</button>
            </div>

            <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <label style={{ fontSize: '12px', color: '#475569' }}>
                From place (dispatch)
                <input style={inputStyle} value={ewbForm.fromPlace}
                  onChange={e => setEwbForm({ ...ewbForm, fromPlace: e.target.value })} />
              </label>
              <label style={{ fontSize: '12px', color: '#475569' }}>
                From pincode
                <input style={inputStyle} value={ewbForm.fromPincode} maxLength={6}
                  onChange={e => setEwbForm({ ...ewbForm, fromPincode: e.target.value })} />
              </label>
              <label style={{ fontSize: '12px', color: '#475569' }}>
                To place — {stateNameFor(ewbFor.place_of_supply) || 'destination'}
                <input style={inputStyle} value={ewbForm.toPlace}
                  onChange={e => setEwbForm({ ...ewbForm, toPlace: e.target.value })} />
              </label>
              <label style={{ fontSize: '12px', color: '#475569' }}>
                Distance (km)
                <input style={inputStyle} type="number" value={ewbForm.distanceKm}
                  onChange={e => setEwbForm({ ...ewbForm, distanceKm: e.target.value })} />
              </label>
              <label style={{ fontSize: '12px', color: '#475569' }}>
                Transport mode
                <select style={inputStyle} value={ewbForm.transportMode}
                  onChange={e => setEwbForm({ ...ewbForm, transportMode: e.target.value as EwbInput['transportMode'] })}>
                  <option>Road</option><option>Rail</option><option>Air</option><option>Ship</option>
                </select>
              </label>
              <label style={{ fontSize: '12px', color: '#475569' }}>
                Vehicle type
                <select style={inputStyle} value={ewbForm.vehicleType}
                  onChange={e => setEwbForm({ ...ewbForm, vehicleType: e.target.value as NonNullable<EwbInput['vehicleType']> })}>
                  <option>Regular</option><option>Hired</option><option>Consignor own</option><option>Consignee own</option>
                </select>
              </label>
              <label style={{ fontSize: '12px', color: '#475569' }}>
                Vehicle / document number
                <input style={inputStyle} value={ewbForm.vehicleNumber}
                  placeholder="e.g. MH12AB1234 or LR no."
                  onChange={e => setEwbForm({ ...ewbForm, vehicleNumber: e.target.value })} />
              </label>
              <label style={{ fontSize: '12px', color: '#475569' }}>
                Transaction type
                <select style={inputStyle} value={ewbForm.transactionType}
                  onChange={e => setEwbForm({ ...ewbForm, transactionType: e.target.value as EwbInput['transactionType'] })}>
                  <option value="O">Outward (sale)</option>
                  <option value="C">Supply on sale/approval</option>
                  <option value="D">Inward</option>
                  <option value="E">Export</option>
                </select>
              </label>
            </div>

            <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '10px' }}>
              Buyer pincode, GSTIN and item HSN/qty are pulled from the invoice and customer master.
            </p>

            {ewbResult && (
              <div style={{
                marginTop: '14px', padding: '12px 14px', background: '#f0fdf4',
                border: '1px solid #bbf7d0', borderRadius: '10px', fontSize: '13px', color: '#166534',
              }}>
                <div style={{ fontWeight: 700, marginBottom: '4px' }}>
                  {ewbResult.mock && (
                    <span style={{
                      background: '#f59e0b', color: 'white', borderRadius: '6px',
                      padding: '1px 8px', fontSize: '11px', marginRight: '8px', fontWeight: 700,
                    }}>MOCK</span>
                  )}
                  E-way bill generated
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: '12px', wordBreak: 'break-all' }}>EWB No: {ewbResult.ewbNo}</div>
                <div style={{ fontSize: '12px' }}>Valid till: {ewbResult.validityEndDate}</div>
                {ewbResult.mock && (
                  <div style={{ fontSize: '11px', color: '#854d0e', marginTop: '4px' }}>
                    Simulated only — no e-way bill exists on the government system yet.
                  </div>
                )}
              </div>
            )}
            {ewbError && (
              <div style={{
                marginTop: '14px', padding: '10px 14px', background: '#fef2f2',
                border: '1px solid #fecaca', borderRadius: '10px', fontSize: '12px', color: '#991b1b',
              }}>{ewbError}</div>
            )}

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', alignItems: 'center', marginTop: '16px', flexWrap: 'wrap' }}>
              <select value={gspProvider} onChange={e => setGspProvider(e.target.value)} style={{
                padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: '8px',
                fontSize: '12px', background: 'white', color: '#374151',
              }}>
                <option value="mock">Mock GSP (local simulator)</option>
              </select>
              <button onClick={submitToGsp} disabled={ewbSubmitting} style={{
                padding: '9px 16px', background: ewbSubmitting ? '#93c5fd' : '#16a34a', color: 'white',
                border: 'none', borderRadius: '8px', fontSize: '13px', cursor: ewbSubmitting ? 'wait' : 'pointer', fontWeight: 600,
              }}>
                {ewbSubmitting ? 'Submitting...' : '🔌 Submit to GSP'}
              </button>
              <button onClick={() => setEwbFor(null)} style={{
                padding: '9px 16px', background: 'white', color: '#374151',
                border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '13px', cursor: 'pointer',
              }}>Close</button>
              <button onClick={generateEwb} style={{
                padding: '9px 16px', background: '#2563eb', color: 'white',
                border: 'none', borderRadius: '8px', fontSize: '13px', cursor: 'pointer', fontWeight: 600,
              }}>↓ Download request JSON</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
