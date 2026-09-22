'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR, numberToWords } from '@/lib/gst-engine'

export default function InvoiceDetailPage() {
  const router = useRouter()
  const supabase = createClient()

  const [id, setId] = useState<string>('')
  const [invoice, setInvoice] = useState<any>(null)
  const [items, setItems] = useState<any[]>([])
  const [org, setOrg] = useState<any>(null)
  const [gstReg, setGstReg] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const segments = window.location.pathname.split('/')
    const invoiceId = segments[segments.length - 1]
    setId(invoiceId)
  }, [])

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
      setOrg(membership.organizations)

      const { data: gst } = await supabase
        .from('gst_registrations')
        .select('*')
        .eq('organization_id', membership.organization_id)
        .eq('is_primary', true)
        .single()

      setGstReg(gst)

      const { data: inv } = await supabase
        .from('invoices')
        .select('*')
        .eq('id', id)
        .eq('organization_id', membership.organization_id)
        .single()

      if (!inv) { router.push('/invoices'); return }
      setInvoice(inv)

      const { data: lineItems } = await supabase
        .from('invoice_items')
        .select('*')
        .eq('invoice_id', id)
        .order('sort_order')

      setItems(lineItems || [])
      setLoading(false)
    }
    load()
  }, [id])

  async function handleMarkPaid() {
    await supabase
      .from('invoices')
      .update({
        payment_status: 'paid',
        amount_paid: invoice.grand_total,
        balance_due: 0
      })
      .eq('id', id)

    setInvoice((prev: any) => ({
      ...prev,
      payment_status: 'paid',
      amount_paid: invoice.grand_total,
      balance_due: 0
    }))
  }

  async function handleCancel() {
    if (!confirm('Are you sure you want to cancel this invoice?')) return
    await supabase
      .from('invoices')
      .update({ status: 'cancelled' })
      .eq('id', id)
    setInvoice((prev: any) => ({ ...prev, status: 'cancelled' }))
  }

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>
      Loading invoice...
    </div>
  )

  if (!invoice) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>
      Invoice not found.
    </div>
  )

  const showCGST = Number(invoice.cgst_amount) > 0
  const showSGST = Number(invoice.sgst_amount) > 0
  const showIGST = Number(invoice.igst_amount) > 0
  const hasBank = org?.bank_name || org?.bank_account_number || org?.bank_upi_id

  const orgFullAddress = [
    org?.address_line1, org?.address_line2,
    org?.city, org?.state, org?.pincode
  ].filter(Boolean).join(', ')

  const fmtDate = (d: string) => d
    ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: '2-digit' })
    : ''

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1000px' }}>

      {/* Action bar — hidden on print */}
      <div className="no-print" style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: '1.5rem'
      }}>
        <button onClick={() => router.push('/invoices')} style={{
          background: 'none', border: 'none', color: '#2563eb',
          fontSize: '13px', cursor: 'pointer', padding: 0
        }}>← Back to Invoices</button>

        <div style={{ display: 'flex', gap: '8px' }}>
          {invoice.status === 'sent' && invoice.payment_status !== 'paid' && (
            <button onClick={handleMarkPaid} style={{
              padding: '8px 16px', background: '#f0fdf4',
              color: '#166534', border: '1px solid #bbf7d0',
              borderRadius: '8px', fontSize: '13px',
              fontWeight: '500', cursor: 'pointer'
            }}>✓ Mark as Paid</button>
          )}
          <button onClick={() => window.print()} style={{
            padding: '8px 16px', background: '#f1f5f9',
            color: '#374151', border: '1px solid #e2e8f0',
            borderRadius: '8px', fontSize: '13px', cursor: 'pointer'
          }}>🖨️ Print / PDF</button>
          {invoice.status !== 'cancelled' && (
            <button onClick={handleCancel} style={{
              padding: '8px 16px', background: '#fef2f2',
              color: '#dc2626', border: '1px solid #fecaca',
              borderRadius: '8px', fontSize: '13px', cursor: 'pointer'
            }}>Cancel Invoice</button>
          )}
        </div>
      </div>

      {/* Cancelled banner */}
      {invoice.status === 'cancelled' && (
        <div className="no-print" style={{
          background: '#fef2f2', border: '1px solid #fecaca',
          color: '#dc2626', padding: '10px 16px',
          borderRadius: '8px', marginBottom: '1rem',
          fontSize: '13px', fontWeight: '500'
        }}>
          ⚠️ This invoice has been cancelled
        </div>
      )}

      {/* ===== INVOICE DOCUMENT ===== */}
      <div id="invoice-print" style={{
        background: 'white',
        border: '1px solid #ccc',
        fontFamily: 'Arial, sans-serif',
        fontSize: '12px',
        color: '#000',
        padding: '16px',
      }}>

        {/* Top label row */}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', marginBottom: '8px'
        }}>
          <div style={{ fontSize: '14px', fontWeight: '600' }}>Tax Invoice</div>
          <div style={{ fontSize: '11px' }}>Original / Duplicate Bill</div>
        </div>

        {/* Seller header */}
        <div style={{
          border: '1px solid #000',
          padding: '10px 12px',
          marginBottom: '0',
          display: 'flex', gap: '16px', alignItems: 'flex-start'
        }}>
          {/* Logo placeholder */}
          <div style={{
            width: '60px', height: '60px',
            border: '1px solid #ddd', borderRadius: '4px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, background: '#f8fafc', fontSize: '24px'
          }}>
            🏢
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '11px', color: '#555', marginBottom: '2px' }}>
              GSTIN : {gstReg?.gstin || '—'}
            </div>
            <div style={{ fontSize: '18px', fontWeight: '700', color: '#1e293b', marginBottom: '2px' }}>
              {org?.trade_name || org?.name}
            </div>
            <div style={{ fontSize: '11px', color: '#374151' }}>{orgFullAddress}</div>
            {(org?.phone || org?.email) && (
              <div style={{ fontSize: '11px', color: '#374151', marginTop: '2px' }}>
                Contact No.: {org?.phone}{org?.email ? ` | ${org?.email}` : ''}
              </div>
            )}
          </div>
        </div>

        {/* Bill To + Invoice Details row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', border: '1px solid #000', borderTop: 'none' }}>
          {/* Left — Bill To + Ship To */}
          <div style={{ borderRight: '1px solid #000' }}>
            {/* Bill To */}
            <div style={{ borderBottom: '1px solid #000', padding: '6px 10px', background: '#e8f4f8' }}>
              <strong>Bill To</strong>
            </div>
            <div style={{ padding: '6px 10px', borderBottom: '1px solid #ccc', fontSize: '12px' }}>
              <div><strong>Name:</strong> {invoice.customer_name}</div>
              {invoice.customer_address && (
                <div><strong>Address:</strong> {invoice.customer_address}</div>
              )}
              {invoice.customer_state && (
                <div><strong>State</strong> {invoice.customer_state} - {invoice.customer_state_code || invoice.place_of_supply}</div>
              )}
              {invoice.customer_gstin && (
                <div><strong>GSTIN:</strong> <span style={{ fontFamily: 'monospace' }}>{invoice.customer_gstin}</span></div>
              )}
            </div>

            {/* Ship To */}
            <div style={{ borderBottom: '1px solid #000', padding: '6px 10px', background: '#e8f4f8' }}>
              <strong>Shipp To</strong>
            </div>
            <div style={{ padding: '6px 10px', fontSize: '12px' }}>
              {invoice.shipping_name || invoice.shipping_address ? (
                <>
                  {invoice.shipping_name && <div><strong>Name:</strong> {invoice.shipping_name}</div>}
                  {invoice.shipping_address && <div><strong>Address:</strong> {invoice.shipping_address}</div>}
                  {invoice.shipping_state && <div><strong>State</strong> {invoice.shipping_state}</div>}
                  {invoice.shipping_gstin && <div><strong>GSTIN:</strong> {invoice.shipping_gstin}</div>}
                </>
              ) : (
                <>
                  <div><strong>Name:</strong> {invoice.customer_name}</div>
                  {invoice.customer_address && <div><strong>Address:</strong> {invoice.customer_address}</div>}
                  {invoice.customer_state && <div><strong>State</strong> {invoice.customer_state} - {invoice.place_of_supply}</div>}
                  {invoice.customer_gstin && <div><strong>GSTIN:</strong> <span style={{ fontFamily: 'monospace' }}>{invoice.customer_gstin}</span></div>}
                </>
              )}
            </div>
          </div>

          {/* Right — Invoice metadata */}
          <div style={{ fontSize: '12px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
              {[
                ['# Inv. No. :', invoice.invoice_number],
                ['Inv. Date :', fmtDate(invoice.invoice_date)],
                ['Payment Mode :', invoice.payment_mode || '—'],
                ['Reverse Charge :', invoice.is_reverse_charge ? 'YES' : 'NO'],
                ["Buyer's Order No :", invoice.buyer_order_number || '—'],
                ["Supplier's Ref. :", invoice.supplier_ref || '—'],
                ['Vehicle Number :', invoice.vehicle_number || '—'],
                ['Delivery Date :', invoice.delivery_date ? fmtDate(invoice.delivery_date) : '—'],
                ['Transport Details :', invoice.transport_details || '—'],
                ['Terms Of Delivery :', invoice.terms_of_delivery || '—'],
              ].map(([label, value], i) => (
                <React.Fragment key={i}>
                  <div style={{
                    padding: '4px 8px',
                    borderBottom: i < 8 ? '1px solid #ccc' : 'none',
                    color: '#555', fontWeight: '500'
                  }}>
                    {label}
                  </div>
                  <div style={{
                    padding: '4px 8px',
                    borderBottom: i < 8 ? '1px solid #ccc' : 'none',
                    borderLeft: '1px solid #ccc', fontWeight: '600'
                  }}>
                    {value}
                  </div>
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>

        {/* Line Items Table */}
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          fontSize: '11px', border: '1px solid #000', borderTop: 'none'
        }}>
          <thead>
            <tr style={{ background: '#f0f4f8' }}>
              <th style={th}>Sr</th>
              <th style={{ ...th, textAlign: 'left' as const, width: '35%' }}>Goods & Service Description</th>
              <th style={th}>HSN</th>
              <th style={th}>Quantity</th>
              <th style={th}>Rate</th>
              <th style={th}>Taxable</th>
              <th style={{ ...th, borderRight: 'none' }}>GST %</th>
              <th style={{ ...th, borderLeft: '1px solid #999' }}>Amt.</th>
              <th style={th}>Total</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <tr key={item.id} style={{ background: idx % 2 === 0 ? 'white' : '#fafafa' }}>
                <td style={td}>{idx + 1}</td>
                <td style={{ ...td, textAlign: 'left' as const }}>
                  <div style={{ fontWeight: '500' }}>{item.item_name}</div>
                </td>
                <td style={{ ...td, fontFamily: 'monospace' }}>{item.hsn_sac || '—'}</td>
                <td style={td}>{Number(item.quantity).toFixed(0)} {item.unit}</td>
                <td style={td}>{formatINR(item.rate)}</td>
                <td style={td}>{formatINR(item.taxable_value)}</td>
                <td style={{ ...td, borderRight: 'none' }}>
                  {showCGST && `${item.cgst_rate}%`}
                  {showIGST && `${item.igst_rate}%`}
                </td>
                <td style={{ ...td, borderLeft: '1px solid #999' }}>
                  {showCGST && formatINR(Number(item.cgst_amount) + Number(item.sgst_amount))}
                  {showIGST && formatINR(item.igst_amount)}
                </td>
                <td style={td}>{formatINR(item.total_amount)}</td>
              </tr>
            ))}
            {/* Empty rows to fill space */}
            {items.length < 8 && Array.from({ length: Math.max(0, 8 - items.length) }).map((_, i) => (
              <tr key={`empty-${i}`} style={{ height: '22px' }}>
                <td style={tdEmpty}></td>
                <td style={{ ...tdEmpty, textAlign: 'left' as const }}></td>
                <td style={tdEmpty}></td>
                <td style={tdEmpty}></td>
                <td style={tdEmpty}></td>
                <td style={tdEmpty}></td>
                <td style={{ ...tdEmpty, borderRight: 'none' }}></td>
                <td style={{ ...tdEmpty, borderLeft: '1px solid #999' }}></td>
                <td style={tdEmpty}></td>
              </tr>
            ))}
          </tbody>
          {/* Subtotal row */}
          <tfoot>
            <tr style={{ background: '#f0f4f8', fontWeight: '700' }}>
              <td style={td}></td>
              <td style={{ ...td, textAlign: 'right' as const }}>Sub-Total:</td>
              <td style={td}></td>
              <td style={td}>{items.reduce((s, i) => s + Number(i.quantity), 0).toFixed(0)}</td>
              <td style={td}></td>
              <td style={td}>{formatINR(invoice.taxable_amount)}</td>
              <td style={{ ...td, borderRight: 'none' }}></td>
              <td style={{ ...td, borderLeft: '1px solid #999' }}>
                {formatINR(Number(invoice.cgst_amount) + Number(invoice.sgst_amount) + Number(invoice.igst_amount))}
              </td>
              <td style={td}>{formatINR(invoice.grand_total)}</td>
            </tr>
          </tfoot>
        </table>

        {/* Bottom section: Bank + Summary */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr',
          border: '1px solid #000', borderTop: 'none'
        }}>
          {/* Left — Bank details */}
          <div style={{ borderRight: '1px solid #000', padding: '8px 10px', fontSize: '11px' }}>
            {hasBank ? (
              <>
                <div style={{ fontWeight: '700', marginBottom: '6px' }}>Our Bank Details</div>
                {org?.bank_name && <div>Bank Name : <strong>{org.bank_name}</strong></div>}
                {org?.bank_branch && <div>Branch : &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<strong>{org.bank_branch}</strong></div>}
                {org?.bank_account_number && <div>Account No : <strong>{org.bank_account_number}</strong></div>}
                {org?.bank_ifsc && <div>IFSC Code : &nbsp;&nbsp;<strong>{org.bank_ifsc}</strong></div>}
                {org?.bank_upi_id && <div>UPI ID : &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<strong>{org.bank_upi_id}</strong></div>}
              </>
            ) : (
              <div style={{ color: '#94a3b8', fontStyle: 'italic' }}>
                Add bank details in Settings → Bank Details
              </div>
            )}

            {/* Amount in words */}
            <div style={{ marginTop: '12px' }}>
              <div style={{ fontWeight: '700', marginBottom: '4px' }}>Invoice Total in Word</div>
              <div style={{ fontStyle: 'italic', color: '#374151' }}>
                {numberToWords(Number(invoice.grand_total))}
              </div>
            </div>
          </div>

          {/* Right — Tax summary */}
          <div style={{ fontSize: '11px' }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr',
              borderBottom: '1px solid #ccc',
              background: '#f0f4f8'
            }}>
              <div style={{ padding: '5px 8px', fontWeight: '700' }}>SUMMERY</div>
              <div style={{ padding: '5px 8px', fontWeight: '700', borderLeft: '1px solid #ccc', textAlign: 'right' as const }}>AMOUNT</div>
            </div>

            {[
              showCGST && ['CGST Amt :', formatINR(invoice.cgst_amount)],
              showSGST && ['SGST Amt :', formatINR(invoice.sgst_amount)],
              showIGST && ['IGST Amt :', formatINR(invoice.igst_amount)],
              Number(invoice.cess_amount) > 0 && ['Cess Amt :', formatINR(invoice.cess_amount)],
              Number(invoice.freight_charges) > 0 && ['Freight Packing Charges :', formatINR(invoice.freight_charges)],
              Number(invoice.round_off) !== 0 && ['Round off :', formatINR(Math.abs(Number(invoice.round_off)))],
            ].filter(Boolean).map((row: any, i) => (
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr',
                borderBottom: '1px solid #ccc'
              }}>
                <div style={{ padding: '4px 8px', color: '#555' }}>{row[0]}</div>
                <div style={{ padding: '4px 8px', borderLeft: '1px solid #ccc', textAlign: 'right' as const, fontWeight: '600' }}>{row[1]}</div>
              </div>
            ))}

            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr',
              background: '#e8f4f8'
            }}>
              <div style={{ padding: '6px 8px', fontWeight: '700' }}>Total Amount :</div>
              <div style={{ padding: '6px 8px', borderLeft: '1px solid #ccc', textAlign: 'right' as const, fontWeight: '700', fontSize: '13px' }}>
                {formatINR(invoice.grand_total)}
              </div>
            </div>
          </div>
        </div>

        {/* Declaration + Signature */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr auto',
          border: '1px solid #000', borderTop: 'none',
          padding: '8px 10px', gap: '20px'
        }}>
          <div style={{ fontSize: '11px' }}>
            <div style={{ fontWeight: '700', marginBottom: '4px' }}>Declaration</div>
            {org?.invoice_declaration
              ? org.invoice_declaration.split('\n').map((line: string, i: number) => (
                  <div key={i}>{line}</div>
                ))
              : (
                <>
                  <div>1. Subject to local jurisdiction.</div>
                  <div>2. Terms & conditions are subject to our trade policy.</div>
                  <div>3. E. & O.E.</div>
                </>
              )
            }
          </div>
          <div style={{ textAlign: 'right' as const, fontSize: '11px', minWidth: '150px' }}>
            <div style={{ fontWeight: '600', marginBottom: '40px' }}>
              For, {org?.trade_name || org?.name}
            </div>
            <div style={{ borderTop: '1px solid #000', paddingTop: '4px' }}>
              Authorised Signatory
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          textAlign: 'center' as const,
          padding: '6px',
          fontSize: '11px',
          fontStyle: 'italic',
          color: '#374151',
          borderTop: '1px solid #e2e8f0'
        }}>
          {org?.invoice_footer || 'Thank You For Your Business!'}
        </div>
      </div>

      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; margin: 0; }
          #invoice-print {
            border: none !important;
            padding: 8px !important;
            margin: 0 !important;
            max-width: 100% !important;
          }
          @page { margin: 1cm; size: A4; }
        }
      `}</style>
    </div>
  )
}

// Table header cell style
const th: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid #999',
  textAlign: 'center',
  fontWeight: '700',
  fontSize: '11px',
  background: '#f0f4f8'
}

// Table data cell style
const td: React.CSSProperties = {
  padding: '5px 8px',
  border: '1px solid #ddd',
  textAlign: 'center',
  fontSize: '11px'
}

// Empty row cell style
const tdEmpty: React.CSSProperties = {
  padding: '5px 8px',
  border: '1px solid #eee',
  textAlign: 'center',
  fontSize: '11px',
  height: '22px'
}