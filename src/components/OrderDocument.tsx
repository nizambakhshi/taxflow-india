'use client'

// The printable sales order / purchase order. Same anatomy as the challan and
// invoice documents: a sticky action bar (never printed), the document region
// drawn entirely with design tokens, and print styles with @page A4. One
// component, two kinds — the only structural differences are the conversion
// target (an invoice for a sales order, a recorded bill for a purchase order)
// and the copy around them.

import React, { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { determineGSTType, formatINR, numberToWords } from '@/lib/gst-engine'
import { stateNameFor } from '@/lib/einvoice'
import { downloadElementAsPdf } from '@/lib/pdf-export'
import { Button } from '@/components/ui'
import Icon from '@/components/Icons'
import {
  KIND_META, loadStore, saveStore,
  computeTotals, isUsableLine, nextStatus, canConvert, canCancel,
  buildInvoicePayload, buildBillPayload,
  type FlowDoc, type GstType,
} from '@/lib/orderflow'
import { createInvoice } from '@/lib/create-invoice'
import { createPurchaseBill } from '@/lib/create-bill'
import type { OrderKind } from '@/components/OrderRegister'

interface OrgRow {
  name?: string
  trade_name?: string
  logo_url?: string
  address_line1?: string
  address_line2?: string
  city?: string
  state?: string
  pincode?: string
  phone?: string
  email?: string
  state_code?: string
}

interface GstRegRow {
  gstin?: string
  state_code?: string
}

const DOC_TITLE: Record<OrderKind, string> = {
  sales_order: 'Sales Order',
  purchase_order: 'Purchase Order',
}

const todayISO = () => new Date().toISOString().split('T')[0]

export default function OrderDocument({ kind }: { kind: OrderKind }) {
  const router = useRouter()
  const supabase = createClient()
  const params = useParams()
  const id = String(params?.id || '')

  const meta = KIND_META[kind]
  const listHref = kind === 'sales_order' ? '/sales-orders' : '/purchase-orders'

  const [orgId, setOrgId] = useState('')
  const [orgStateCode, setOrgStateCode] = useState('')
  const [org, setOrg] = useState<OrgRow | null>(null)
  const [gstReg, setGstReg] = useState<GstRegRow | null>(null)
  const [doc, setDoc] = useState<FlowDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [converting, setConverting] = useState(false)
  const [downloading, setDownloading] = useState(false)

  // Purchase orders convert by recording the vendor's bill — its number is
  // theirs, not ours, so the user supplies it before the bill is written.
  const [billModal, setBillModal] = useState(false)
  const [billNumber, setBillNumber] = useState('')
  const [billDate, setBillDate] = useState(todayISO())
  const [billError, setBillError] = useState('')

  useEffect(() => {
    if (!id) return
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id, organizations(*)')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { router.push('/setup'); return }
      const oid = membership.organization_id
      setOrgId(oid)
      setOrg(membership.organizations as OrgRow | null)

      const { data: gst } = await supabase
        .from('gst_registrations')
        .select('*')
        .eq('organization_id', oid)
        .eq('is_primary', true)
        .single()
      setGstReg(gst as GstRegRow | null)
      const orgRow = membership.organizations as OrgRow | null
      setOrgStateCode(gst?.state_code || orgRow?.state_code || '')

      const store = loadStore(kind, oid)
      const found = store.docs.find(d => d.id === id)
      if (!found) { router.push(listHref); return }
      setDoc(found)
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  function persistDoc(next: FlowDoc) {
    const store = loadStore(kind, orgId)
    const docs = store.docs.map(d => (d.id === next.id ? next : d))
    saveStore(kind, orgId, { ...store, docs })
    setDoc(next)
  }

  function advance() {
    if (!doc) return
    const adv = nextStatus(kind, doc.status)
    if (!adv) return
    persistDoc({ ...doc, status: adv.to })
  }

  function handleCancel() {
    if (!doc) return
    if (!confirm(`Cancel ${doc.number}? A cancelled ${meta.label.toLowerCase()} keeps its number and stays in the register.`)) return
    persistDoc({ ...doc, status: 'cancelled' })
  }

  async function downloadPDF() {
    if (!doc) return
    setDownloading(true)
    try {
      await downloadElementAsPdf('order-capture', `${doc.number}.pdf`)
    } catch (err) {
      console.error('PDF error:', err)
      alert('PDF download failed. Please try printing instead.')
    } finally {
      setDownloading(false)
    }
  }

  /** Sales order → tax invoice, through the same write path a typed invoice uses. */
  async function handleConvertInvoice() {
    if (!doc) return
    const gstType = determineGSTType(orgStateCode, doc.place_of_supply, doc.supply_type)
    const computed = computeTotals(doc.lines, gstType)
    if (!computed.totals) { alert('Nothing to invoice — add lines to the order first.'); return }
    if (!confirm(`Convert ${doc.number} to a tax invoice?`)) return

    setConverting(true)
    try {
      let partyId = doc.party_id
      // An order can be typed free-hand; the invoice needs a real customer row.
      if (!partyId) {
        const { data: created, error: custErr } = await supabase
          .from('customers')
          .insert({
            organization_id: orgId,
            name: doc.party_name,
            gstin: doc.party_gstin || null,
            state_code: doc.party_state || null,
            address_line1: doc.party_address || null,
            customer_type: doc.supply_type || 'b2b',
            is_active: true,
          })
          .select()
          .single()
        if (custErr) throw custErr
        partyId = created.id
      }

      const { invoiceFields, items } = buildInvoicePayload({ ...doc, party_id: partyId }, computed, todayISO())
      const { invoiceId, invoiceNumber } = await createInvoice(supabase, orgId, invoiceFields, items)

      persistDoc({
        ...doc,
        party_id: partyId,
        status: 'converted',
        converted_to_id: invoiceId,
        converted_to_number: invoiceNumber,
        converted_at: new Date().toISOString(),
      })
      router.push(`/invoices/${invoiceId}`)
    } catch (err) {
      alert('Conversion failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setConverting(false)
    }
  }

  /** Purchase order → purchase bill, carrying the vendor's own bill number. */
  async function handleConvertBill() {
    if (!doc) return
    if (!billNumber.trim()) { setBillError("The vendor's bill number is required — it is what GSTR-2B matches against."); return }
    if (!billDate) { setBillError('Pick the bill date printed on the vendor invoice.'); return }

    const gstType = determineGSTType(orgStateCode, doc.place_of_supply, doc.supply_type)
    const computed = computeTotals(doc.lines, gstType)
    if (!computed.totals) { setBillError('Nothing to bill — add lines to the order first.'); return }

    setConverting(true)
    setBillError('')
    try {
      let partyId = doc.party_id
      // A purchase order can be typed free-hand; the bill needs a real vendor row.
      if (!partyId) {
        const { data: created, error: vendErr } = await supabase
          .from('vendors')
          .insert({
            organization_id: orgId,
            name: doc.party_name,
            gstin: doc.party_gstin || null,
            state_code: doc.party_state || null,
            address_line1: doc.party_address || null,
            is_active: true,
          })
          .select()
          .single()
        if (vendErr) throw vendErr
        partyId = created.id
      }

      const { billFields, items } = buildBillPayload({ ...doc, party_id: partyId }, computed, billNumber, billDate)
      const { billId } = await createPurchaseBill(supabase, orgId, billFields, items)

      persistDoc({
        ...doc,
        party_id: partyId,
        status: 'converted',
        converted_to_id: billId,
        converted_to_number: billNumber.trim(),
        converted_at: new Date().toISOString(),
      })
      setBillModal(false)
      router.push('/bills')
    } catch (err) {
      setBillError('Recording failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setConverting(false)
    }
  }

  if (loading) return (
    <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>
      Loading {meta.label.toLowerCase()}…
    </div>
  )

  if (!doc) return (
    <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>
      Order not found.
    </div>
  )

  const adv = nextStatus(kind, doc.status)
  const gstType: GstType = determineGSTType(orgStateCode, doc.place_of_supply, doc.supply_type)
  const usableLines = doc.lines.filter(isUsableLine)
  const computed = computeTotals(doc.lines, gstType)
  const showCGST = (computed.totals?.cgst_amount ?? 0) > 0
  const showSGST = (computed.totals?.sgst_amount ?? 0) > 0
  const showIGST = (computed.totals?.igst_amount ?? 0) > 0

  const isSO = kind === 'sales_order'
  const partyHeader = isSO ? 'Customer' : 'Vendor'

  const orgFullAddress = [
    org?.address_line1, org?.address_line2, org?.city, org?.state, org?.pincode,
  ].filter(Boolean).join(', ')

  const fmtDate = (d: string) =>
    d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—'

  const metaRows: [string, string][] = [
    [isSO ? 'Order No. :' : 'PO No. :', doc.number],
    ['Order Date :', fmtDate(doc.doc_date)],
    ['Expected Delivery :', doc.due_date ? fmtDate(doc.due_date) : '—'],
    ['Place of Supply :', `${stateNameFor(doc.place_of_supply)}${doc.place_of_supply ? ` (${doc.place_of_supply})` : ''}`],
    ['Supply Type :', (doc.supply_type || 'b2b').toUpperCase()],
  ]

  const th = (extra?: React.CSSProperties): React.CSSProperties => ({
    padding: '5px 4px',
    border: '1px solid var(--faint)',
    textAlign: 'center' as const,
    fontWeight: 700,
    fontSize: '10px',
    background: 'var(--brand-soft)',
    color: 'var(--ink)',
    ...extra,
  })

  const td = (extra?: React.CSSProperties): React.CSSProperties => ({
    padding: '4px 4px',
    border: '1px solid var(--line)',
    textAlign: 'center' as const,
    fontSize: '10px',
    verticalAlign: 'middle' as const,
    color: 'var(--ink)',
    ...extra,
  })

  return (
    <div>

      {/* ── ACTION BAR — never appears in PDF or print ── */}
      <div
        id="action-bar"
        style={{
          position: 'sticky', top: 0, zIndex: 50,
          background: 'var(--surface)', borderBottom: '1px solid var(--line)',
          padding: '12px 2rem',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}
      >
        <button className="od-back" onClick={() => router.push(listHref)}>
          ← Back to {meta.plural.toLowerCase()}
        </button>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
          {doc.status === 'converted' && doc.converted_to_id && (
            <Button variant="ghost" icon={isSO ? 'invoice' : 'cart'}
              onClick={() => router.push(isSO ? `/invoices/${doc.converted_to_id}` : '/bills')}>
              {isSO
                ? `View invoice${doc.converted_to_number ? ` ${doc.converted_to_number}` : ''}`
                : 'View in bills'}
            </Button>
          )}
          {adv && (
            <Button variant="ghost" icon="arrow-right" onClick={advance}>
              {adv.label}
            </Button>
          )}
          {canCancel(doc) && (
            <Button variant="ghost" icon="edit" onClick={() => router.push(`${listHref}?edit=${doc.id}`)}>
              Edit
            </Button>
          )}
          <Button variant="ghost" icon="printer" onClick={() => window.print()}>
            Print
          </Button>
          <Button variant="ghost" icon="download" onClick={downloadPDF} disabled={downloading}>
            {downloading ? 'Generating PDF…' : 'Download PDF'}
          </Button>
          {canCancel(doc) && (
            <Button variant="danger" icon="x" onClick={handleCancel}>
              Cancel
            </Button>
          )}
          {canConvert(doc) && isSO && (
            <Button icon="invoice" onClick={handleConvertInvoice} disabled={converting}>
              {converting ? 'Converting…' : 'Convert to invoice'}
            </Button>
          )}
          {canConvert(doc) && !isSO && (
            <Button icon="cart" onClick={() => { setBillModal(true); setBillError('') }} disabled={converting}>
              Record vendor bill
            </Button>
          )}
        </div>
      </div>

      {/* Status banner */}
      {doc.status === 'cancelled' && (
        <div id="cancel-banner" className="od-banner is-red" role="alert">
          <Icon name="alert" size={14} strokeWidth={2.2} />
          This {meta.label.toLowerCase()} has been cancelled
        </div>
      )}
      {doc.status === 'converted' && (
        <div id="cancel-banner" className="od-banner is-green" role="alert">
          <Icon name="check" size={14} strokeWidth={2.2} />
          {isSO
            ? `Invoiced as ${doc.converted_to_number} — the invoice is the tax record now`
            : `Billed as ${doc.converted_to_number} — the purchase bill is the input-credit record now`}
        </div>
      )}

      {/* ── PAGE WRAPPER ── */}
      <div className="page-container">

        <div className="table-scroll">
        <div
          id="order-capture"
          style={{
            background: 'white',
            padding: '24px',
            maxWidth: '760px',
            minWidth: '700px',
            margin: '0 auto',
            boxSizing: 'border-box' as const,
          }}
        >
          <div
            id="order-document"
            style={{
              background: 'white',
              fontFamily: 'Arial, Helvetica, sans-serif',
              fontSize: '10px',
              color: 'var(--ink)',
              border: '1px solid var(--faint)',
              width: '100%',
            }}
          >

            {/* ── TOP LABEL ROW ── */}
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', padding: '4px 10px',
              borderBottom: '1px solid var(--faint)', background: 'var(--surface-2)',
            }}>
              <span style={{ fontSize: '13px', fontWeight: 700 }}>
                {DOC_TITLE[kind]}
                <span style={{ fontWeight: 400, fontSize: '9px', color: 'var(--muted)', marginLeft: '8px' }}>
                  (not a tax invoice)
                </span>
              </span>
              <span style={{ fontSize: '9px', color: 'var(--muted)' }}>Original</span>
            </div>

            {/* ── SELLER HEADER ── */}
            <div style={{
              display: 'flex', gap: '10px', padding: '8px 10px',
              borderBottom: '1px solid var(--faint)', alignItems: 'flex-start',
            }}>
              <div style={{
                width: '72px', height: '56px', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {org?.logo_url ? (
                  <img src={org.logo_url} alt="Logo"
                    style={{ maxWidth: '72px', maxHeight: '56px', objectFit: 'contain' }} />
                ) : (
                  <div style={{
                    width: '56px', height: '56px',
                    border: '1px solid var(--line)', borderRadius: '4px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--surface-2)', color: 'var(--faint)',
                  }}>
                    <Icon name="building" size={22} strokeWidth={1.6} />
                  </div>
                )}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '9px', color: 'var(--muted)', marginBottom: '1px' }}>
                  GSTIN : {gstReg?.gstin || '—'}
                </div>
                <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--ink)', lineHeight: 1.2 }}>
                  {org?.trade_name || org?.name}
                </div>
                {orgFullAddress && (
                  <div style={{ fontSize: '9px', color: 'var(--ink-2)', marginTop: '2px' }}>{orgFullAddress}</div>
                )}
                {(org?.phone || org?.email) && (
                  <div style={{ fontSize: '9px', color: 'var(--ink-2)', marginTop: '1px' }}>
                    Contact No.: {[org?.phone, org?.email].filter(Boolean).join(' | ')}
                  </div>
                )}
              </div>
            </div>

            {/* ── PARTY + METADATA ── */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--faint)' }}>
              <div style={{ flex: 1, borderRight: '1px solid var(--faint)' }}>
                <div style={{
                  background: 'var(--brand-soft)', padding: '3px 8px',
                  fontWeight: 700, fontSize: '10px', borderBottom: '1px solid var(--faint)',
                }}>
                  {partyHeader}
                </div>
                <div style={{ padding: '5px 8px', fontSize: '10px', minHeight: '86px' }}>
                  <div><strong>Name:</strong> {doc.party_name}</div>
                  {doc.party_address && <div><strong>Address:</strong> {doc.party_address}</div>}
                  {doc.party_state && (
                    <div><strong>State:</strong> {stateNameFor(doc.party_state)} ({doc.party_state})</div>
                  )}
                  {doc.party_gstin && (
                    <div><strong>GSTIN:</strong>{' '}
                      <span style={{ fontFamily: 'var(--mono)' }}>{doc.party_gstin}</span>
                    </div>
                  )}
                  {doc.notes && (
                    <div style={{ marginTop: '4px', color: 'var(--ink-2)' }}>
                      <strong>Notes:</strong> {doc.notes}
                    </div>
                  )}
                </div>
              </div>

              <div style={{ width: '260px', fontSize: '10px' }}>
                {metaRows.map(([label, value], i) => (
                  <div key={i} style={{
                    display: 'flex',
                    borderBottom: i < metaRows.length - 1 ? '1px solid var(--line)' : 'none',
                  }}>
                    <div style={{ padding: '3px 6px', color: 'var(--muted)', width: '110px', flexShrink: 0, fontSize: '9px' }}>
                      {label}
                    </div>
                    <div style={{ padding: '3px 6px', fontWeight: 600, flex: 1, borderLeft: '1px solid var(--line)', fontSize: '10px' }}>
                      {value}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── LINE ITEMS ── */}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
              <thead>
                <tr>
                  <th style={th({ width: '24px' })}>Sr</th>
                  <th style={th({ textAlign: 'left' as const, width: '30%', paddingLeft: '6px' })}>
                    Goods &amp; Service Description
                  </th>
                  <th style={th({ width: '52px' })}>HSN</th>
                  <th style={th({ width: '68px' })}>Quantity</th>
                  <th style={th({ width: '72px' })}>Rate</th>
                  <th style={th({ width: '84px' })}>Taxable</th>
                  <th style={th({ width: '36px' })}>GST %</th>
                  <th style={th({ width: '76px' })}>Tax</th>
                  <th style={th({ width: '82px' })}>Total</th>
                </tr>
              </thead>
              <tbody>
                {usableLines.map((line, idx) => {
                  const r = computed.results[idx]
                  return (
                    <tr key={idx} style={{ background: idx % 2 === 0 ? 'white' : 'var(--surface-2)' }}>
                      <td style={td()}>{idx + 1}</td>
                      <td style={td({ textAlign: 'left' as const, paddingLeft: '6px' })}>
                        <span style={{ fontWeight: 500 }}>{line.item_name}</span>
                      </td>
                      <td style={td({ fontFamily: 'var(--mono)' })}>{line.hsn_sac || '—'}</td>
                      <td style={td()}>
                        {Number(line.quantity).toFixed(2)}<br />
                        <span style={{ fontSize: '9px', color: 'var(--muted)' }}>{line.unit}</span>
                      </td>
                      <td style={td()}>{formatINR(line.rate)}</td>
                      <td style={td()}>{ret0(r?.taxable_value)}</td>
                      <td style={td()}>
                        {showCGST ? `${r?.cgst_rate}%` : ''}
                        {showIGST ? `${r?.igst_rate}%` : ''}
                      </td>
                      <td style={td()}>
                        {showCGST && ret0((r?.cgst_amount ?? 0) + (r?.sgst_amount ?? 0))}
                        {showIGST && ret0(r?.igst_amount)}
                      </td>
                      <td style={td()}>{ret0(r?.total_amount)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: 'var(--surface-2)', fontWeight: 700 }}>
                  <td style={td()}></td>
                  <td style={td({ textAlign: 'right' as const, paddingRight: '6px' })}>Sub-Total :</td>
                  <td style={td()}></td>
                  <td style={td()}>{usableLines.reduce((s, l) => s + Number(l.quantity), 0).toFixed(0)}</td>
                  <td style={td()}></td>
                  <td style={td()}>{ret0(computed.totals?.taxable_amount)}</td>
                  <td style={td()}></td>
                  <td style={td()}>{
                    ret0((computed.totals?.cgst_amount ?? 0) + (computed.totals?.sgst_amount ?? 0) + (computed.totals?.igst_amount ?? 0))
                  }</td>
                  <td style={td()}>{ret0(computed.totals?.grand_total)}</td>
                </tr>
              </tfoot>
            </table>

            {/* ── WORDS + SUMMARY ── */}
            <div style={{ display: 'flex', borderTop: '1px solid var(--faint)' }}>
              <div style={{ flex: 1, borderRight: '1px solid var(--faint)', padding: '7px 8px', fontSize: '10px' }}>
                <div style={{ fontWeight: 700, marginBottom: '2px' }}>Value in Words</div>
                <div style={{ fontStyle: 'italic', color: 'var(--ink-2)', lineHeight: 1.5, fontSize: '9px' }}>
                  {numberToWords(computed.totals?.grand_total ?? 0)}
                </div>

                <div style={{ marginTop: '10px', paddingTop: '6px', borderTop: '1px solid var(--line)' }}>
                  <div style={{ fontWeight: 700, marginBottom: '2px' }}>Declaration</div>
                  <div style={{ color: 'var(--ink-2)', lineHeight: 1.55, fontSize: '9px' }}>
                    {isSO ? (
                      <>
                        <div>This is a sales order, not a tax invoice. It records what the customer has confirmed; the tax invoice will be raised on dispatch.</div>
                        <div>Goods remain the property of {org?.trade_name || org?.name} until billed.</div>
                      </>
                    ) : (
                      <>
                        <div>This is a purchase order, not a tax invoice. Goods will be received against it and the vendor&apos;s tax invoice will be recorded separately as a purchase bill.</div>
                        <div>Tax amounts shown are estimates based on the rates entered; the vendor&apos;s tax invoice governs the actual tax.</div>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ width: '220px', fontSize: '10px' }}>
                <div style={{
                  display: 'flex', background: 'var(--brand-soft)',
                  borderBottom: '1px solid var(--faint)', fontWeight: 700,
                }}>
                  <div style={{ flex: 1, padding: '4px 6px' }}>SUMMARY</div>
                  <div style={{ width: '90px', padding: '4px 6px', borderLeft: '1px solid var(--faint)', textAlign: 'right' as const }}>
                    AMOUNT
                  </div>
                </div>
                {[
                  { label: 'Taxable Value :', value: ret0(computed.totals?.taxable_amount) },
                  showCGST ? { label: 'CGST :', value: ret0(computed.totals?.cgst_amount) } : null,
                  showSGST ? { label: 'SGST :', value: ret0(computed.totals?.sgst_amount) } : null,
                  showIGST ? { label: 'IGST :', value: ret0(computed.totals?.igst_amount) } : null,
                  (computed.totals?.cess_amount ?? 0) > 0 ? { label: 'Cess :', value: ret0(computed.totals?.cess_amount) } : null,
                  (computed.totals?.round_off ?? 0) !== 0 ? { label: 'Round off :', value: ret0(Math.abs(computed.totals?.round_off ?? 0)) } : null,
                ].filter(Boolean).map((row, i) => (
                  <div key={i} style={{ display: 'flex', borderBottom: '1px solid var(--line)' }}>
                    <div style={{ flex: 1, padding: '3px 6px', color: 'var(--muted)' }}>{row!.label}</div>
                    <div style={{ width: '90px', padding: '3px 6px', borderLeft: '1px solid var(--line)', textAlign: 'right' as const, fontWeight: 600 }}>
                      {row!.value}
                    </div>
                  </div>
                ))}
                <div style={{
                  display: 'flex', background: 'var(--brand-soft)',
                  borderTop: '1px solid var(--faint)', fontWeight: 700,
                }}>
                  <div style={{ flex: 1, padding: '4px 6px' }}>Order Value :</div>
                  <div style={{ width: '90px', padding: '4px 6px', borderLeft: '1px solid var(--faint)', textAlign: 'right' as const, fontSize: '10px' }}>
                    ₹{formatINR(computed.totals?.grand_total ?? 0)}
                  </div>
                </div>
                <div style={{
                  padding: '4px 6px', fontSize: '8.5px', color: 'var(--muted)',
                  borderTop: '1px solid var(--line)', lineHeight: 1.5,
                }}>
                  {isSO
                    ? 'Estimated value — the invoice raised from this order carries the same figures.'
                    : "Estimated value — the vendor's tax invoice governs the actual tax."}
                </div>
              </div>
            </div>

            {/* ── SIGNATURES ── */}
            <div style={{ display: 'flex', borderTop: '1px solid var(--faint)' }}>
              <div style={{
                flex: 1, padding: '7px 8px', fontSize: '10px',
                borderRight: '1px solid var(--faint)',
                display: 'flex', flexDirection: 'column' as const, justifyContent: 'space-between',
              }}>
                <div style={{ fontWeight: 600 }}>
                  {isSO ? 'Accepted by the customer' : "Vendor's acceptance"}
                </div>
                <div style={{ borderTop: '1px solid var(--ink-2)', paddingTop: '3px', marginTop: '40px', width: '70%' }}>
                  {isSO ? "Customer's signature & date" : "Vendor's signature & date"}
                </div>
              </div>
              <div style={{
                padding: '7px 10px', fontSize: '10px',
                textAlign: 'right' as const, minWidth: '160px',
                display: 'flex', flexDirection: 'column' as const, justifyContent: 'space-between',
              }}>
                <div style={{ fontWeight: 600 }}>For, {org?.trade_name || org?.name}</div>
                <div style={{ borderTop: '1px solid var(--ink-2)', paddingTop: '3px', marginTop: '40px' }}>
                  Authorised Signatory
                </div>
              </div>
            </div>

            {/* ── FOOTER ── */}
            <div style={{
              textAlign: 'center' as const, padding: '5px 10px',
              fontSize: '10px', fontStyle: 'italic', color: 'var(--ink-2)',
              borderTop: '1px solid var(--faint)', background: 'var(--surface-2)',
            }}>
              {doc.status === 'converted' && doc.converted_to_number
                ? (isSO ? `Invoiced as ${doc.converted_to_number}` : `Billed as ${doc.converted_to_number}`)
                : `${meta.statusLabels[doc.status]}${doc.due_date ? ` · Expected by ${fmtDate(doc.due_date)}` : ''}`}
            </div>

          </div>
        </div>
        {/* end order-capture */}
        </div>

        <p className="od-footnote">
          {isSO
            ? 'Stored in this browser only (localStorage) until converted — converting writes the invoice to your books through the same sequence and stock path as a typed invoice.'
            : "Stored in this browser only (localStorage) until billed — recording the vendor's bill writes through the same path as a typed purchase bill, including inward stock."}
        </p>

      </div>
      {/* end page wrapper */}

      {/* ── PO → BILL CONVERSION MODAL ── */}
      {billModal && (
        <div className="od-scrim" role="dialog" aria-modal="true"
          aria-label={`Record the vendor bill for ${doc.number}`}>
          <div className="od-modal">
            <div className="od-modal-head">
              <div>
                <h2>Record the vendor&apos;s bill</h2>
                <p>{doc.number} · {money(computed.totals?.grand_total ?? 0)} · {doc.party_name}</p>
              </div>
              <button type="button" className="od-close" onClick={() => setBillModal(false)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {billError && (
              <div className="od-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{billError}</div>
            )}

            <div className="od-grid">
              <label className="od-field">
                <span>Vendor bill no. *</span>
                <input className="tf-input" value={billNumber}
                  onChange={e => setBillNumber(e.target.value)}
                  placeholder="As printed on their invoice" />
              </label>
              <label className="od-field">
                <span>Bill date *</span>
                <input className="tf-input" type="date" value={billDate}
                  onChange={e => setBillDate(e.target.value)} />
              </label>
            </div>

            <p className="od-hint">
              The bill number is the vendor&apos;s, not ours — it is what GSTR-2B will match against.
              The bill is recorded with the same lines, GST split and inward stock movements as a typed bill.
            </p>

            <div className="od-save">
              <Button variant="ghost" onClick={() => setBillModal(false)} disabled={converting}>Cancel</Button>
              <Button icon="cart" onClick={handleConvertBill} disabled={converting}>
                {converting ? 'Recording…' : 'Record bill'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── PRINT STYLES ── */}
      <style>{`
        @media (max-width: 768px) {
          #action-bar { padding: 10px 1rem !important; }
        }

        @media print {
          body { margin: 0 !important; background: white !important; }
          #action-bar { display: none !important; }
          #cancel-banner { display: none !important; }
          .od-footnote { display: none !important; }
          .od-scrim { display: none !important; }
          #order-capture {
            padding: 0 !important;
            max-width: 100% !important;
            min-width: 0 !important;
            margin: 0 !important;
          }
          #order-document {
            border: 1px solid var(--faint) !important;
            font-size: 10px !important;
          }
          @page {
            size: A4 portrait;
            margin: 15mm;
          }
          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
        }
      `}</style>

      {/* ── KIT CHROME ── */}
      <style>{`
        .od-back {
          background: none; border: none; padding: 0;
          color: var(--brand); font-size: 12.5px; font-weight: 600; cursor: pointer;
        }
        .od-back:hover { text-decoration: underline; }

        .od-banner {
          display: flex; align-items: center; gap: 8px;
          margin: 1rem 2rem 0;
          padding: 10px 16px; border-radius: 8px;
          font-size: 13px; font-weight: 600;
        }
        .od-banner svg { flex-shrink: 0; }
        .od-banner.is-red { background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .od-banner.is-green { background: var(--green-soft); color: var(--green); border-left: 3px solid var(--green); }

        .od-footnote { max-width: 760px; margin: 12px auto 0; font-size: 11.5px; color: var(--faint); line-height: 1.55; }

        .od-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .od-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-width: 520px; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .od-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .od-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .od-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; }
        .od-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; flex-shrink: 0; }
        .od-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .od-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .od-alert svg { flex-shrink: 0; }

        .od-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
        .od-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .od-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .od-hint { font-size: 11.5px; color: var(--faint); line-height: 1.55; }
        .od-save { display: flex; gap: 10px; justify-content: flex-end; }

        @media (max-width: 768px) {
          .od-banner { margin: 10px 1rem 0; }
          .od-scrim { align-items: flex-end; padding: 0; }
          .od-scrim .od-modal { max-width: none; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .od-grid { grid-template-columns: 1fr; }
          .od-save { flex-direction: column-reverse; }
        }
      `}</style>

    </div>
  )
}

// Whole-rupee helper for the ruled table — the grid has no room for paise.
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
function ret0(v: number | undefined | null): string {
  return inr0.format(Math.round(Number(v) || 0))
}

const money = (v: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v)
