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
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    const segments = window.location.pathname.split('/')
    setId(segments[segments.length - 1])
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
        balance_due: 0,
      })
      .eq('id', id)
    setInvoice((p: any) => ({
      ...p,
      payment_status: 'paid',
      amount_paid: invoice.grand_total,
      balance_due: 0,
    }))
  }

  async function handleCancel() {
    if (!confirm('Cancel this invoice?')) return
    await supabase
      .from('invoices')
      .update({ status: 'cancelled' })
      .eq('id', id)
    setInvoice((p: any) => ({ ...p, status: 'cancelled' }))
  }

  async function downloadPDF() {
    setDownloading(true)
    try {
      const { default: jsPDF } = await import('jspdf')
      const { default: html2canvas } = await import('html2canvas')

      const element = document.getElementById('invoice-document')
      if (!element) return

      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
        windowWidth: element.scrollWidth,
        windowHeight: element.scrollHeight,
      })

      const imgData = canvas.toDataURL('image/png')
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
      })

      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const margin = 12
      const imgWidth = pageWidth - margin * 2
      const imgHeight = (canvas.height * imgWidth) / canvas.width

      let heightLeft = imgHeight
      let position = margin

      pdf.addImage(imgData, 'PNG', margin, position, imgWidth, imgHeight)
      heightLeft -= pageHeight - margin * 2

      while (heightLeft > 0) {
        pdf.addPage()
        position = margin - (imgHeight - heightLeft)
        pdf.addImage(imgData, 'PNG', margin, position, imgWidth, imgHeight)
        heightLeft -= pageHeight - margin * 2
      }

      pdf.save(`${invoice.invoice_number}.pdf`)
    } catch (err) {
      console.error('PDF error:', err)
      alert('PDF download failed. Please try printing instead.')
    } finally {
      setDownloading(false)
    }
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
    org?.address_line1,
    org?.address_line2,
    org?.city,
    org?.state,
    org?.pincode,
  ].filter(Boolean).join(', ')

  const fmtDate = (d: string) =>
    d
      ? new Date(d).toLocaleDateString('en-IN', {
          day: '2-digit',
          month: '2-digit',
          year: '2-digit',
        })
      : '—'

  const metaRows = [
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
  ]

  const taxSummaryRows = [
    showCGST && ['CGST Amt :', formatINR(invoice.cgst_amount)],
    showSGST && ['SGST Amt :', formatINR(invoice.sgst_amount)],
    showIGST && ['IGST Amt :', formatINR(invoice.igst_amount)],
    Number(invoice.cess_amount) > 0 && ['Cess Amt :', formatINR(invoice.cess_amount)],
    Number(invoice.freight_charges) > 0 && ['Freight Charges :', formatINR(invoice.freight_charges)],
    Number(invoice.round_off) !== 0 && ['Round off :', formatINR(Math.abs(Number(invoice.round_off)))],
  ].filter(Boolean) as string[][]

  return (
    <div>
      {/* ── ACTION BAR ── */}
      <div
        id="action-bar"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 50,
          background: 'white',
          borderBottom: '1px solid #e2e8f0',
          padding: '12px 2rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <button
          onClick={() => router.push('/invoices')}
          style={{
            background: 'none', border: 'none',
            color: '#2563eb', fontSize: '13px',
            cursor: 'pointer', padding: 0,
          }}
        >
          ← Back to Invoices
        </button>

        <div style={{ display: 'flex', gap: '8px' }}>
          {invoice.status === 'sent' && invoice.payment_status !== 'paid' && (
            <button
              onClick={handleMarkPaid}
              style={{
                padding: '8px 16px', background: '#f0fdf4',
                color: '#166534', border: '1px solid #bbf7d0',
                borderRadius: '8px', fontSize: '13px',
                fontWeight: '500', cursor: 'pointer',
              }}
            >
              ✓ Mark as Paid
            </button>
          )}
          <button
            onClick={downloadPDF}
            disabled={downloading}
            style={{
              padding: '8px 20px',
              background: downloading ? '#93c5fd' : '#2563eb',
              color: 'white', border: 'none',
              borderRadius: '8px', fontSize: '13px',
              fontWeight: '600',
              cursor: downloading ? 'not-allowed' : 'pointer',
            }}
          >
            {downloading ? '⏳ Generating PDF...' : '⬇ Download PDF'}
          </button>
          <button
            onClick={() => window.print()}
            style={{
              padding: '8px 14px', background: '#f1f5f9',
              color: '#374151', border: '1px solid #e2e8f0',
              borderRadius: '8px', fontSize: '13px', cursor: 'pointer',
            }}
          >
            🖨️ Print
          </button>
          {invoice.status !== 'cancelled' && (
            <button
              onClick={handleCancel}
              style={{
                padding: '8px 14px', background: '#fef2f2',
                color: '#dc2626', border: '1px solid #fecaca',
                borderRadius: '8px', fontSize: '13px', cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Cancelled banner */}
      {invoice.status === 'cancelled' && (
        <div
          id="cancel-banner"
          style={{
            margin: '1rem 2rem 0',
            background: '#fef2f2', border: '1px solid #fecaca',
            color: '#dc2626', padding: '10px 16px',
            borderRadius: '8px', fontSize: '13px', fontWeight: '500',
          }}
        >
          ⚠️ This invoice has been cancelled
        </div>
      )}

      {/* ── INVOICE DOCUMENT ── */}
      <div style={{ padding: '1.5rem 2rem' }}>
        <div
          id="invoice-document"
          style={{
            background: 'white',
            fontFamily: 'Arial, Helvetica, sans-serif',
            fontSize: '11px',
            color: '#000',
            maxWidth: '740px',
            margin: '0 auto',
            border: '1px solid #999',
          }}
        >
          {/* ── TOP LABEL ROW ── */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '5px 12px',
            borderBottom: '1px solid #999',
            background: '#f8fafc',
          }}>
            <span style={{ fontSize: '14px', fontWeight: '700' }}>Tax Invoice</span>
            <span style={{ fontSize: '10px', color: '#555' }}>Original / Duplicate Bill</span>
          </div>

          {/* ── SELLER HEADER ── */}
          <div style={{
            display: 'flex',
            gap: '12px',
            padding: '10px 12px',
            borderBottom: '1px solid #999',
            alignItems: 'flex-start',
          }}>
            <div style={{
              width: '52px', height: '52px',
              border: '1px solid #ddd', borderRadius: '4px',
              display: 'flex', alignItems: 'center',
              justifyContent: 'center', background: '#f8fafc',
              fontSize: '20px', flexShrink: 0,
            }}>
              🏢
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '10px', color: '#666', marginBottom: '1px' }}>
                GSTIN : {gstReg?.gstin || '—'}
              </div>
              <div style={{ fontSize: '16px', fontWeight: '800', color: '#1e293b', lineHeight: 1.2 }}>
                {org?.trade_name || org?.name}
              </div>
              {orgFullAddress && (
                <div style={{ fontSize: '10px', color: '#374151', marginTop: '2px' }}>
                  {orgFullAddress}
                </div>
              )}
              {(org?.phone || org?.email) && (
                <div style={{ fontSize: '10px', color: '#374151', marginTop: '1px' }}>
                  Contact No.: {[org?.phone, org?.email].filter(Boolean).join(' | ')}
                </div>
              )}
            </div>
          </div>

          {/* ── BILL TO / SHIP TO + INVOICE METADATA ── */}
          <div style={{ display: 'flex', borderBottom: '1px solid #999' }}>
            {/* Left column */}
            <div style={{ flex: 1, borderRight: '1px solid #999' }}>
              {/* Bill To */}
              <div style={{
                background: '#dbeafe', padding: '4px 10px',
                fontWeight: '700', fontSize: '11px',
                borderBottom: '1px solid #999',
              }}>
                Bill To
              </div>
              <div style={{ padding: '6px 10px', fontSize: '11px', borderBottom: '1px solid #ccc' }}>
                <div><strong>Name:</strong> {invoice.customer_name}</div>
                {invoice.customer_address && (
                  <div><strong>Address:</strong> {invoice.customer_address}</div>
                )}
                {invoice.customer_state && (
                  <div>
                    <strong>State</strong> {invoice.customer_state} - {invoice.place_of_supply}
                  </div>
                )}
                {invoice.customer_gstin && (
                  <div>
                    <strong>GSTIN:</strong>{' '}
                    <span style={{ fontFamily: 'monospace' }}>{invoice.customer_gstin}</span>
                  </div>
                )}
              </div>

              {/* Ship To */}
              <div style={{
                background: '#dbeafe', padding: '4px 10px',
                fontWeight: '700', fontSize: '11px',
                borderBottom: '1px solid #999',
              }}>
                Shipp To
              </div>
              <div style={{ padding: '6px 10px', fontSize: '11px' }}>
                {invoice.shipping_name || invoice.shipping_address ? (
                  <>
                    <div><strong>Name:</strong> {invoice.shipping_name}</div>
                    <div><strong>Address:</strong> {invoice.shipping_address}</div>
                    {invoice.shipping_state && (
                      <div><strong>State</strong> {invoice.shipping_state}</div>
                    )}
                    {invoice.shipping_gstin && (
                      <div>
                        <strong>GSTIN:</strong>{' '}
                        <span style={{ fontFamily: 'monospace' }}>{invoice.shipping_gstin}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div><strong>Name:</strong> {invoice.customer_name}</div>
                    {invoice.customer_address && (
                      <div><strong>Address:</strong> {invoice.customer_address}</div>
                    )}
                    {invoice.customer_state && (
                      <div>
                        <strong>State</strong> {invoice.customer_state} - {invoice.place_of_supply}
                      </div>
                    )}
                    {invoice.customer_gstin && (
                      <div>
                        <strong>GSTIN:</strong>{' '}
                        <span style={{ fontFamily: 'monospace' }}>{invoice.customer_gstin}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Right column — Invoice metadata */}
            <div style={{ width: '270px', fontSize: '11px' }}>
              {metaRows.map(([label, value], i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    borderBottom: i < metaRows.length - 1 ? '1px solid #ddd' : 'none',
                  }}
                >
                  <div style={{
                    padding: '3px 8px', color: '#555',
                    width: '135px', flexShrink: 0,
                  }}>
                    {label}
                  </div>
                  <div style={{
                    padding: '3px 8px', fontWeight: '600',
                    flex: 1, borderLeft: '1px solid #ddd',
                  }}>
                    {value}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── LINE ITEMS TABLE ── */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
            <thead>
              <tr style={{ background: '#dbeafe' }}>
                <th style={TH({ w: '28px' })}>Sr</th>
                <th style={{ ...TH({}), textAlign: 'left' as const, width: '30%' }}>
                  Goods &amp; Service Description
                </th>
                <th style={TH({ w: '58px' })}>HSN</th>
                <th style={TH({ w: '72px' })}>Quantity</th>
                <th style={TH({ w: '76px' })}>Rate</th>
                <th style={TH({ w: '90px' })}>Taxable</th>
                <th style={TH({ w: '38px' })}>GST %</th>
                <th style={TH({ w: '80px' })}>Amt.</th>
                <th style={TH({ w: '84px' })}>Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => (
                <tr key={item.id} style={{ background: idx % 2 === 0 ? '#fff' : '#f9fafb' }}>
                  <td style={TD()}>{idx + 1}</td>
                  <td style={{ ...TD(), textAlign: 'left' as const, paddingLeft: '8px' }}>
                    <span style={{ fontWeight: '500' }}>{item.item_name}</span>
                    {item.item_description && (
                      <div style={{ fontSize: '10px', color: '#555' }}>{item.item_description}</div>
                    )}
                  </td>
                  <td style={{ ...TD(), fontFamily: 'monospace' }}>{item.hsn_sac || '—'}</td>
                  <td style={TD()}>
                    {Number(item.quantity).toFixed(2)} {item.unit}
                  </td>
                  <td style={TD()}>{formatINR(item.rate)}</td>
                  <td style={TD()}>{formatINR(item.taxable_value)}</td>
                  <td style={TD()}>
                    {showCGST ? `${item.cgst_rate}%` : ''}
                    {showIGST ? `${item.igst_rate}%` : ''}
                  </td>
                  <td style={TD()}>
                    {showCGST
                      ? formatINR(Number(item.cgst_amount) + Number(item.sgst_amount))
                      : ''}
                    {showIGST ? formatINR(item.igst_amount) : ''}
                  </td>
                  <td style={TD()}>{formatINR(item.total_amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: '#f0f4f8', fontWeight: '700' }}>
                <td style={TD()}></td>
                <td style={{ ...TD(), textAlign: 'right' as const, paddingRight: '8px' }}>
                  Sub-Total :
                </td>
                <td style={TD()}></td>
                <td style={TD()}>
                  {items.reduce((s, i) => s + Number(i.quantity), 0).toFixed(0)}
                </td>
                <td style={TD()}></td>
                <td style={TD()}>{formatINR(invoice.taxable_amount)}</td>
                <td style={TD()}></td>
                <td style={TD()}>
                  {formatINR(
                    Number(invoice.cgst_amount) +
                    Number(invoice.sgst_amount) +
                    Number(invoice.igst_amount)
                  )}
                </td>
                <td style={TD()}>{formatINR(invoice.grand_total)}</td>
              </tr>
            </tfoot>
          </table>

          {/* ── BANK DETAILS + TAX SUMMARY ── */}
          <div style={{ display: 'flex', borderTop: '1px solid #999' }}>
            {/* Bank details */}
            <div style={{
              flex: 1,
              borderRight: '1px solid #999',
              padding: '8px 10px',
              fontSize: '11px',
            }}>
              {hasBank ? (
                <>
                  <div style={{ fontWeight: '700', marginBottom: '5px' }}>Our Bank Details</div>
                  {org?.bank_name && (
                    <div style={{ display: 'flex', gap: '4px', marginBottom: '2px' }}>
                      <span style={{ color: '#555', width: '95px', flexShrink: 0 }}>Bank Name :</span>
                      <strong>{org.bank_name}</strong>
                    </div>
                  )}
                  {org?.bank_branch && (
                    <div style={{ display: 'flex', gap: '4px', marginBottom: '2px' }}>
                      <span style={{ color: '#555', width: '95px', flexShrink: 0 }}>Branch :</span>
                      <strong>{org.bank_branch}</strong>
                    </div>
                  )}
                  {org?.bank_account_number && (
                    <div style={{ display: 'flex', gap: '4px', marginBottom: '2px' }}>
                      <span style={{ color: '#555', width: '95px', flexShrink: 0 }}>Account No :</span>
                      <strong>{org.bank_account_number}</strong>
                    </div>
                  )}
                  {org?.bank_ifsc && (
                    <div style={{ display: 'flex', gap: '4px', marginBottom: '2px' }}>
                      <span style={{ color: '#555', width: '95px', flexShrink: 0 }}>IFSC Code :</span>
                      <strong>{org.bank_ifsc}</strong>
                    </div>
                  )}
                  {org?.bank_upi_id && (
                    <div style={{ display: 'flex', gap: '4px', marginBottom: '2px' }}>
                      <span style={{ color: '#555', width: '95px', flexShrink: 0 }}>UPI ID :</span>
                      <strong>{org.bank_upi_id}</strong>
                    </div>
                  )}
                </>
              ) : (
                <div style={{ color: '#94a3b8', fontStyle: 'italic' }}>
                  Add bank details in Settings → Bank Details
                </div>
              )}

              {/* Amount in words */}
              <div style={{
                marginTop: '10px',
                paddingTop: '8px',
                borderTop: '1px solid #eee',
              }}>
                <div style={{ fontWeight: '700', marginBottom: '3px' }}>Invoice Total in Word</div>
                <div style={{ fontStyle: 'italic', color: '#374151', lineHeight: 1.5 }}>
                  {numberToWords(Number(invoice.grand_total))}
                </div>
              </div>
            </div>

            {/* Tax summary */}
            <div style={{ width: '230px', fontSize: '11px' }}>
              {/* Header */}
              <div style={{
                display: 'flex',
                background: '#dbeafe',
                borderBottom: '1px solid #999',
                fontWeight: '700',
              }}>
                <div style={{ flex: 1, padding: '4px 8px' }}>SUMMERY</div>
                <div style={{
                  width: '95px', padding: '4px 8px',
                  borderLeft: '1px solid #999',
                  textAlign: 'right' as const,
                }}>
                  AMOUNT
                </div>
              </div>

              {/* Tax rows */}
              {taxSummaryRows.map((row, i) => (
                <div key={i} style={{
                  display: 'flex',
                  borderBottom: '1px solid #ddd',
                }}>
                  <div style={{ flex: 1, padding: '3px 8px', color: '#555' }}>{row[0]}</div>
                  <div style={{
                    width: '95px', padding: '3px 8px',
                    borderLeft: '1px solid #ddd',
                    textAlign: 'right' as const,
                    fontWeight: '600',
                  }}>
                    {row[1]}
                  </div>
                </div>
              ))}

              {/* Grand total */}
              <div style={{
                display: 'flex',
                background: '#dbeafe',
                borderTop: '1px solid #999',
                fontWeight: '700',
              }}>
                <div style={{ flex: 1, padding: '5px 8px' }}>Total Amount :</div>
                <div style={{
                  width: '95px', padding: '5px 8px',
                  borderLeft: '1px solid #999',
                  textAlign: 'right' as const,
                  fontSize: '12px',
                }}>
                  ₹{formatINR(invoice.grand_total)}
                </div>
              </div>

              {/* Amount paid / balance */}
              {Number(invoice.amount_paid) > 0 && (
                <>
                  <div style={{ display: 'flex', borderTop: '1px solid #ddd' }}>
                    <div style={{ flex: 1, padding: '3px 8px', color: '#059669' }}>
                      Amount Paid :
                    </div>
                    <div style={{
                      width: '95px', padding: '3px 8px',
                      borderLeft: '1px solid #ddd',
                      textAlign: 'right' as const,
                      color: '#059669', fontWeight: '600',
                    }}>
                      {formatINR(invoice.amount_paid)}
                    </div>
                  </div>
                  <div style={{
                    display: 'flex',
                    background: '#fef2f2',
                    borderTop: '1px solid #ddd',
                  }}>
                    <div style={{ flex: 1, padding: '3px 8px', color: '#dc2626', fontWeight: '700' }}>
                      Balance Due :
                    </div>
                    <div style={{
                      width: '95px', padding: '3px 8px',
                      borderLeft: '1px solid #ddd',
                      textAlign: 'right' as const,
                      color: '#dc2626', fontWeight: '700',
                    }}>
                      {formatINR(invoice.balance_due)}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ── DECLARATION + SIGNATURE ── */}
          <div style={{
            display: 'flex',
            borderTop: '1px solid #999',
          }}>
            <div style={{
              flex: 1,
              padding: '8px 10px',
              fontSize: '11px',
              borderRight: '1px solid #999',
            }}>
              <div style={{ fontWeight: '700', marginBottom: '4px' }}>Declaration</div>
              {org?.invoice_declaration
                ? org.invoice_declaration.split('\n').map((line: string, i: number) => (
                    <div key={i}>{line}</div>
                  ))
                : (
                  <>
                    <div>1. Subject to local jurisdiction.</div>
                    <div>2. Terms &amp; conditions are subject to our trade policy.</div>
                    <div>3. E. &amp; O.E.</div>
                  </>
                )
              }
            </div>
            <div style={{
              padding: '8px 12px',
              fontSize: '11px',
              textAlign: 'right' as const,
              minWidth: '170px',
              display: 'flex',
              flexDirection: 'column' as const,
              justifyContent: 'space-between',
            }}>
              <div style={{ fontWeight: '600' }}>
                For, {org?.trade_name || org?.name}
              </div>
              <div style={{
                borderTop: '1px solid #000',
                paddingTop: '4px',
                marginTop: '44px',
              }}>
                Authorised Signatory
              </div>
            </div>
          </div>

          {/* ── FOOTER ── */}
          <div style={{
            textAlign: 'center' as const,
            padding: '5px 12px',
            fontSize: '11px',
            fontStyle: 'italic',
            color: '#374151',
            borderTop: '1px solid #999',
            background: '#f8fafc',
          }}>
            {org?.invoice_footer || 'Thank You For Your Business!'}
          </div>
        </div>
      </div>

      {/* ── PRINT STYLES ── */}
      <style>{`
        @media print {
          /* Hide sidebar, navbar, action bar — everything except invoice */
          body { margin: 0 !important; background: white !important; }

          /* Hide the sidebar layout */
          nav, aside, header, #action-bar, #cancel-banner { display: none !important; }

          /* Target the sidebar wrapper specifically */
          div[style*="width: 220px"],
          div[style*="width:220px"] { display: none !important; }

          /* Make the main content full width */
          div[style*="margin-left: 220px"],
          div[style*="marginLeft: 220px"] { margin-left: 0 !important; }

          /* Hide action bar and padding wrapper, show only invoice-document */
          #action-bar { display: none !important; }
          #cancel-banner { display: none !important; }

          #invoice-document {
            max-width: 100% !important;
            margin: 0 !important;
            border: 1px solid #999 !important;
            font-size: 11px !important;
          }

          @page {
            size: A4 portrait;
            margin: 12mm;
          }

          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
        }
      `}</style>
    </div>
  )
}

// ── STYLE HELPERS ──

function TH({ w }: { w?: string }): React.CSSProperties {
  return {
    padding: '5px 4px',
    border: '1px solid #999',
    textAlign: 'center' as const,
    fontWeight: '700',
    fontSize: '11px',
    background: '#dbeafe',
    width: w,
  }
}

function TD(): React.CSSProperties {
  return {
    padding: '4px 4px',
    border: '1px solid #ddd',
    textAlign: 'center' as const,
    fontSize: '11px',
    verticalAlign: 'middle' as const,
  }
}