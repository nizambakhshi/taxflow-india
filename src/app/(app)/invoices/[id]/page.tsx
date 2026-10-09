'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR, numberToWords } from '@/lib/gst-engine'
import { Button } from '@/components/ui'
import Icon from '@/components/Icons'
import { downloadElementAsPdf } from '@/lib/pdf-export'
import {
  InvoiceDocument,
} from '@/components/InvoiceDocument'
import {
  INVOICE_TEMPLATES, loadInvoiceTemplate, saveInvoiceTemplate, type InvoiceTemplate,
} from '@/lib/invoice-template'

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
  const [template, setTemplate] = useState<InvoiceTemplate>('classic')

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
      setTemplate(loadInvoiceTemplate(membership.organization_id))

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
    await supabase.from('invoices').update({ status: 'cancelled' }).eq('id', id)
    setInvoice((p: any) => ({ ...p, status: 'cancelled' }))
  }

  async function downloadPDF() {
    setDownloading(true)
    try {
      // Captures the padded wrapper so margins are baked in — see pdf-export.ts.
      await downloadElementAsPdf('invoice-capture', `${invoice.invoice_number}.pdf`)
    } catch (err) {
      console.error('PDF error:', err)
      alert('PDF download failed. Please try printing instead.')
    } finally {
      setDownloading(false)
    }
  }

  if (loading) return (
    <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>
      Loading invoice…
    </div>
  )

  if (!invoice) return (
    <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>
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
    d ? new Date(d).toLocaleDateString('en-IN', {
      day: '2-digit', month: '2-digit', year: '2-digit',
    }) : '—'

  const metaRows: [string, string][] = [
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

  const taxSummaryRows: [string, string][] = [
    ...(showCGST ? [['CGST Amt :', formatINR(invoice.cgst_amount)] as [string, string]] : []),
    ...(showSGST ? [['SGST Amt :', formatINR(invoice.sgst_amount)] as [string, string]] : []),
    ...(showIGST ? [['IGST Amt :', formatINR(invoice.igst_amount)] as [string, string]] : []),
    ...(Number(invoice.cess_amount) > 0 ? [['Cess Amt :', formatINR(invoice.cess_amount)] as [string, string]] : []),
    ...(Number(invoice.freight_charges) > 0 ? [['Freight Charges :', formatINR(invoice.freight_charges)] as [string, string]] : []),
    ...(Number(invoice.round_off) !== 0 ? [['Round off :', formatINR(Math.abs(Number(invoice.round_off)))] as [string, string]] : []),
  ]

  // Shared cell styles
  const th = (extra?: React.CSSProperties): React.CSSProperties => ({
    padding: '5px 4px',
    border: '1px solid #999',
    textAlign: 'center' as const,
    fontWeight: '700',
    fontSize: '10px',
    background: '#dbeafe',
    ...extra,
  })

  const td = (extra?: React.CSSProperties): React.CSSProperties => ({
    padding: '4px 4px',
    border: '1px solid #ddd',
    textAlign: 'center' as const,
    fontSize: '10px',
    verticalAlign: 'middle' as const,
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
        <button className="id-back" onClick={() => router.push('/invoices')}>
          ← Back to invoices
        </button>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
          {invoice.status === 'sent' && invoice.payment_status !== 'paid' && (
            <Button
              variant="ghost"
              icon="check"
              onClick={handleMarkPaid}
              style={{ color: 'var(--green)', borderColor: 'color-mix(in srgb, var(--green) 30%, white)' }}
            >
              Mark as paid
            </Button>
          )}
          <select
            value={template}
            onChange={e => {
              const next = e.target.value as InvoiceTemplate
              setTemplate(next)
              if (org?.id) saveInvoiceTemplate(org.id, next)
            }}
            title="Invoice document layout"
            className="tf-input id-select"
          >
            {INVOICE_TEMPLATES.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <Button icon="download" onClick={downloadPDF} disabled={downloading}>
            {downloading ? 'Generating PDF…' : 'Download PDF'}
          </Button>
          <Button variant="ghost" icon="printer" onClick={() => window.print()}>
            Print
          </Button>
          {invoice.status !== 'cancelled' && (
            <Button variant="danger" icon="x" onClick={handleCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Cancelled banner */}
      {invoice.status === 'cancelled' && (
        <div id="cancel-banner" className="id-cancelled" role="alert">
          <Icon name="alert" size={14} strokeWidth={2.2} />
          This invoice has been cancelled
        </div>
      )}

      {/*
        Export banner — a zero-rated invoice carries two clocks the ledger cannot see: the LUT that
        keeps it tax-free, and the FEMA window the proceeds have to arrive inside. Both live on the
        export register, so this page points there instead of repeating the dates.
      */}
      {invoice.supply_type === 'export' && (
        <div id="export-banner" className="id-export">
          <Icon name="ship" size={15} strokeWidth={2.0} />
          <span>
            Export invoice — its LUT and the realisation window are tracked on the export register,
            not here.
          </span>
          <Button
            size="sm"
            variant="ghost"
            href={`/gst/exports?file=${encodeURIComponent(invoice.invoice_number)}`}
          >
            Open on the export register
          </Button>
        </div>
      )}

      {/* ── PAGE WRAPPER ── */}
      <div className="page-container">

        {/*
          invoice-capture: this is what html2canvas screenshots.
          The 24px padding here becomes the white margin in the PDF.
          min-width keeps the document (and the generated PDF) at a fixed
          layout width; the scroll wrapper lets small screens pan through it.
        */}
        <div className="table-scroll">
        <div
          id="invoice-capture"
          style={{
            background: 'white',
            padding: '24px',
            maxWidth: '760px',
            minWidth: '700px',
            margin: '0 auto',
            boxSizing: 'border-box' as const,
          }}
        >

          {template !== 'classic' && (
            <InvoiceDocument invoice={invoice} items={items} org={org} gstReg={gstReg} template={template} />
          )}

          {/* ── INVOICE DOCUMENT (classic layout) ── */}
          {template === 'classic' && (
          <div
            id="invoice-document"
            style={{
              background: 'white',
              fontFamily: 'Arial, Helvetica, sans-serif',
              fontSize: '10px',
              color: '#000',
              border: '1px solid #999',
              width: '100%',
            }}
          >

            {/* ── TOP LABEL ROW ── */}
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', padding: '4px 10px',
              borderBottom: '1px solid #999', background: '#f8fafc',
            }}>
              <span style={{ fontSize: '13px', fontWeight: '700' }}>Tax Invoice</span>
              <span style={{ fontSize: '9px', color: '#555' }}>Original / Duplicate Bill</span>
            </div>

            {/* ── SELLER HEADER ── */}
            <div style={{
              display: 'flex', gap: '10px', padding: '8px 10px',
              borderBottom: '1px solid #999', alignItems: 'flex-start',
            }}>
                          <div style={{
              width: '72px', height: '56px',
              flexShrink: 0, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
            }}>
              {org?.logo_url ? (
                <img
                  src={org.logo_url}
                  alt="Logo"
                  style={{
                    maxWidth: '72px', maxHeight: '56px',
                    objectFit: 'contain',
                  }}
                />
              ) : (
                <div style={{
                  width: '56px', height: '56px',
                  border: '1px solid #ddd', borderRadius: '4px',
                  display: 'flex', alignItems: 'center',
                  justifyContent: 'center', background: '#f8fafc',
                  fontSize: '20px',
                }}>🏢</div>
              )}
            </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '9px', color: '#666', marginBottom: '1px' }}>
                  GSTIN : {gstReg?.gstin || '—'}
                </div>
                <div style={{ fontSize: '15px', fontWeight: '800', color: '#1e293b', lineHeight: 1.2 }}>
                  {org?.trade_name || org?.name}
                </div>
                {orgFullAddress && (
                  <div style={{ fontSize: '9px', color: '#374151', marginTop: '2px' }}>
                    {orgFullAddress}
                  </div>
                )}
                {(org?.phone || org?.email) && (
                  <div style={{ fontSize: '9px', color: '#374151', marginTop: '1px' }}>
                    Contact No.: {[org?.phone, org?.email].filter(Boolean).join(' | ')}
                  </div>
                )}
              </div>
            </div>

            {/* ── BILL TO / SHIP TO + INVOICE METADATA ── */}
            <div style={{ display: 'flex', borderBottom: '1px solid #999' }}>

              {/* Left — Bill To + Ship To */}
              <div style={{ flex: 1, borderRight: '1px solid #999' }}>

                <div style={{
                  background: '#dbeafe', padding: '3px 8px',
                  fontWeight: '700', fontSize: '10px',
                  borderBottom: '1px solid #999',
                }}>
                  Bill To
                </div>
                <div style={{ padding: '5px 8px', fontSize: '10px', borderBottom: '1px solid #ccc', minHeight: '52px' }}>
                  <div><strong>Name:</strong> {invoice.customer_name}</div>
                  {invoice.customer_address && (
                    <div><strong>Address:</strong> {invoice.customer_address}</div>
                  )}
                  {invoice.customer_state && (
                    <div><strong>State</strong> {invoice.customer_state} - {invoice.place_of_supply}</div>
                  )}
                  {invoice.customer_gstin && (
                    <div><strong>GSTIN:</strong>{' '}
                      <span style={{ fontFamily: 'monospace' }}>{invoice.customer_gstin}</span>
                    </div>
                  )}
                </div>

                <div style={{
                  background: '#dbeafe', padding: '3px 8px',
                  fontWeight: '700', fontSize: '10px',
                  borderBottom: '1px solid #999',
                }}>
                  Shipp To
                </div>
                <div style={{ padding: '5px 8px', fontSize: '10px', minHeight: '52px' }}>
                  {invoice.shipping_name || invoice.shipping_address ? (
                    <>
                      <div><strong>Name:</strong> {invoice.shipping_name}</div>
                      <div><strong>Address:</strong> {invoice.shipping_address}</div>
                      {invoice.shipping_state && (
                        <div><strong>State</strong> {invoice.shipping_state}</div>
                      )}
                    </>
                  ) : (
                    <>
                      <div><strong>Name:</strong> {invoice.customer_name}</div>
                      {invoice.customer_address && (
                        <div><strong>Address:</strong> {invoice.customer_address}</div>
                      )}
                      {invoice.customer_state && (
                        <div><strong>State</strong> {invoice.customer_state} - {invoice.place_of_supply}</div>
                      )}
                      {invoice.customer_gstin && (
                        <div><strong>GSTIN:</strong>{' '}
                          <span style={{ fontFamily: 'monospace' }}>{invoice.customer_gstin}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Right — Invoice metadata */}
              <div style={{ width: '260px', fontSize: '10px' }}>
                {metaRows.map(([label, value], i) => (
                  <div key={i} style={{
                    display: 'flex',
                    borderBottom: i < metaRows.length - 1 ? '1px solid #ddd' : 'none',
                  }}>
                    <div style={{
                      padding: '3px 6px', color: '#555',
                      width: '128px', flexShrink: 0, fontSize: '9px',
                    }}>
                      {label}
                    </div>
                    <div style={{
                      padding: '3px 6px', fontWeight: '600',
                      flex: 1, borderLeft: '1px solid #ddd', fontSize: '10px',
                    }}>
                      {value}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── LINE ITEMS TABLE ── */}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
              <thead>
                <tr>
                  <th style={th({ width: '24px' })}>Sr</th>
                  <th style={th({ textAlign: 'left' as const, width: '28%', paddingLeft: '6px' })}>
                    Goods &amp; Service Description
                  </th>
                  <th style={th({ width: '52px' })}>HSN</th>
                  <th style={th({ width: '68px' })}>Quantity</th>
                  <th style={th({ width: '72px' })}>Rate</th>
                  <th style={th({ width: '88px' })}>Taxable</th>
                  <th style={th({ width: '36px' })}>GST %</th>
                  <th style={th({ width: '76px' })}>Amt.</th>
                  <th style={th({ width: '82px' })}>Total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => (
                  <tr key={item.id} style={{ background: idx % 2 === 0 ? '#fff' : '#f9fafb' }}>
                    <td style={td()}>{idx + 1}</td>
                    <td style={td({ textAlign: 'left' as const, paddingLeft: '6px' })}>
                      <span style={{ fontWeight: '500' }}>{item.item_name}</span>
                      {item.item_description && (
                        <div style={{ fontSize: '9px', color: '#555' }}>{item.item_description}</div>
                      )}
                    </td>
                    <td style={td({ fontFamily: 'monospace' })}>{item.hsn_sac || '—'}</td>
                    <td style={td()}>
                      {Number(item.quantity).toFixed(2)}<br />
                      <span style={{ fontSize: '9px', color: '#555' }}>{item.unit}</span>
                    </td>
                    <td style={td()}>{formatINR(item.rate)}</td>
                    <td style={td()}>{formatINR(item.taxable_value)}</td>
                    <td style={td()}>
                      {showCGST ? `${item.cgst_rate}%` : ''}
                      {showIGST ? `${item.igst_rate}%` : ''}
                    </td>
                    <td style={td()}>
                      {showCGST
                        ? formatINR(Number(item.cgst_amount) + Number(item.sgst_amount))
                        : ''}
                      {showIGST ? formatINR(item.igst_amount) : ''}
                    </td>
                    <td style={td()}>{formatINR(item.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: '#f0f4f8', fontWeight: '700' }}>
                  <td style={td()}></td>
                  <td style={td({ textAlign: 'right' as const, paddingRight: '6px' })}>Sub-Total :</td>
                  <td style={td()}></td>
                  <td style={td()}>{items.reduce((s, i) => s + Number(i.quantity), 0).toFixed(0)}</td>
                  <td style={td()}></td>
                  <td style={td()}>{formatINR(invoice.taxable_amount)}</td>
                  <td style={td()}></td>
                  <td style={td()}>
                    {formatINR(
                      Number(invoice.cgst_amount) +
                      Number(invoice.sgst_amount) +
                      Number(invoice.igst_amount)
                    )}
                  </td>
                  <td style={td()}>{formatINR(invoice.grand_total)}</td>
                </tr>
              </tfoot>
            </table>

            {/* ── BANK DETAILS + TAX SUMMARY ── */}
            <div style={{ display: 'flex', borderTop: '1px solid #999' }}>

              {/* Bank details */}
              <div style={{
                flex: 1, borderRight: '1px solid #999',
                padding: '7px 8px', fontSize: '10px',
              }}>
                {hasBank ? (
                  <>
                    <div style={{ fontWeight: '700', marginBottom: '4px' }}>Our Bank Details</div>
                    {[
                      ['Bank Name :', org?.bank_name],
                      ['Branch :', org?.bank_branch],
                      ['Account No :', org?.bank_account_number],
                      ['IFSC Code :', org?.bank_ifsc],
                      ['UPI ID :', org?.bank_upi_id],
                    ].filter(([, v]) => v).map(([label, value], i) => (
                      <div key={i} style={{ display: 'flex', gap: '4px', marginBottom: '2px' }}>
                        <span style={{ color: '#555', width: '80px', flexShrink: 0, fontSize: '9px' }}>
                          {label}
                        </span>
                        <strong style={{ fontSize: '10px' }}>{value}</strong>
                      </div>
                    ))}
                  </>
                ) : (
                  <div style={{ color: '#94a3b8', fontStyle: 'italic', fontSize: '9px' }}>
                    Add bank details in Settings → Bank Details
                  </div>
                )}

                {/* Amount in words */}
                <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid #eee' }}>
                  <div style={{ fontWeight: '700', marginBottom: '2px' }}>Invoice Total in Word</div>
                  <div style={{ fontStyle: 'italic', color: '#374151', lineHeight: 1.5, fontSize: '9px' }}>
                    {numberToWords(Number(invoice.grand_total))}
                  </div>
                </div>
              </div>

              {/* Tax summary */}
              <div style={{ width: '220px', fontSize: '10px' }}>
                {/* Header */}
                <div style={{
                  display: 'flex', background: '#dbeafe',
                  borderBottom: '1px solid #999', fontWeight: '700',
                }}>
                  <div style={{ flex: 1, padding: '4px 6px' }}>SUMMERY</div>
                  <div style={{
                    width: '90px', padding: '4px 6px',
                    borderLeft: '1px solid #999', textAlign: 'right' as const,
                  }}>
                    AMOUNT
                  </div>
                </div>

                {/* Tax rows */}
                {taxSummaryRows.map(([label, value], i) => (
                  <div key={i} style={{ display: 'flex', borderBottom: '1px solid #ddd' }}>
                    <div style={{ flex: 1, padding: '3px 6px', color: '#555' }}>{label}</div>
                    <div style={{
                      width: '90px', padding: '3px 6px',
                      borderLeft: '1px solid #ddd',
                      textAlign: 'right' as const, fontWeight: '600',
                    }}>
                      {value}
                    </div>
                  </div>
                ))}

                {/* Grand total */}
                <div style={{
                  display: 'flex', background: '#dbeafe',
                  borderTop: '1px solid #999', fontWeight: '700',
                }}>
                  <div style={{ flex: 1, padding: '4px 6px' }}>Total Amount :</div>
                  <div style={{
                    width: '90px', padding: '4px 6px',
                    borderLeft: '1px solid #999',
                    textAlign: 'right' as const, fontSize: '10px',
                  }}>
                    ₹{formatINR(invoice.grand_total)}
                  </div>
                </div>

                {/* Paid / balance due */}
                {Number(invoice.amount_paid) > 0 && (
                  <>
                    <div style={{ display: 'flex', borderTop: '1px solid #ddd' }}>
                      <div style={{ flex: 1, padding: '3px 6px', color: '#059669' }}>Amount Paid :</div>
                      <div style={{
                        width: '90px', padding: '3px 6px',
                        borderLeft: '1px solid #ddd',
                        textAlign: 'right' as const,
                        color: '#059669', fontWeight: '600',
                      }}>
                        {formatINR(invoice.amount_paid)}
                      </div>
                    </div>
                    <div style={{
                      display: 'flex', background: '#fef2f2',
                      borderTop: '1px solid #ddd',
                    }}>
                      <div style={{ flex: 1, padding: '3px 6px', color: '#dc2626', fontWeight: '700' }}>
                        Balance Due :
                      </div>
                      <div style={{
                        width: '90px', padding: '3px 6px',
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
            <div style={{ display: 'flex', borderTop: '1px solid #999' }}>
              <div style={{
                flex: 1, padding: '7px 8px',
                fontSize: '10px', borderRight: '1px solid #999',
              }}>
                <div style={{ fontWeight: '700', marginBottom: '3px' }}>Declaration</div>
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
                padding: '7px 10px', fontSize: '10px',
                textAlign: 'right' as const, minWidth: '160px',
                display: 'flex', flexDirection: 'column' as const,
                justifyContent: 'space-between',
              }}>
                <div style={{ fontWeight: '600' }}>
                  For, {org?.trade_name || org?.name}
                </div>
                <div style={{
                  borderTop: '1px solid #000',
                  paddingTop: '3px', marginTop: '40px',
                }}>
                  Authorised Signatory
                </div>
              </div>
            </div>

            {/* ── FOOTER ── */}
            <div style={{
              textAlign: 'center' as const,
              padding: '5px 10px',
              fontSize: '10px',
              fontStyle: 'italic',
              color: '#374151',
              borderTop: '1px solid #999',
              background: '#f8fafc',
            }}>
              {org?.invoice_footer || 'Thank You For Your Business!'}
            </div>

          </div>
          )}
          {/* end classic invoice-document */}

        </div>
        {/* end invoice-capture */}
        </div>
        {/* end table-scroll */}

      </div>
      {/* end page wrapper */}

      {/* ── PRINT STYLES ── */}
      <style>{`
        @media (max-width: 768px) {
          #action-bar { padding: 10px 1rem !important; }
        }

        @media print {
          body { margin: 0 !important; background: white !important; }
          #action-bar { display: none !important; }
          #cancel-banner { display: none !important; }
          div[style*="width: 220px"] { display: none !important; }
          div[style*="margin-left: 220px"] { margin-left: 0 !important; }
          #invoice-capture {
            padding: 0 !important;
            max-width: 100% !important;
            min-width: 0 !important;
            margin: 0 !important;
          }
          #invoice-document {
            border: 1px solid #999 !important;
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

      {/* ── KIT CHROME STYLES (the document inside #invoice-capture keeps its own palette) ── */}
      <style>{`
        .id-back {
          background: none; border: none; padding: 0;
          color: var(--brand); font-size: 12.5px; font-weight: 600; cursor: pointer;
        }
        .id-back:hover { text-decoration: underline; }

        .id-select {
          width: auto; padding: 8px 10px; font-size: 12.5px;
          color: var(--ink-2); cursor: pointer;
        }

        .id-cancelled {
          display: flex; align-items: center; gap: 8px;
          margin: 1rem 2rem 0;
          background: var(--red-soft); color: var(--red);
          border-left: 3px solid var(--red);
          padding: 10px 16px; border-radius: 8px;
          font-size: 13px; font-weight: 600;
        }
        .id-cancelled svg { flex-shrink: 0; }

        /* The export banner: a route to the register, not a second copy of its dates. */
        .id-export {
          display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
          margin: 1rem 2rem 0;
          background: var(--brand-soft); color: var(--brand-dark);
          border-left: 3px solid var(--brand);
          padding: 9px 14px; border-radius: 8px;
          font-size: 12.5px; font-weight: 600; line-height: 1.5;
        }
        .id-export svg { flex-shrink: 0; color: var(--brand); }
        .id-export span { min-width: 0; }

        @media (max-width: 768px) {
          .id-cancelled { margin: 10px 1rem 0; }
          .id-export { margin: 10px 1rem 0; }
        }
      `}</style>

    </div>
  )
}