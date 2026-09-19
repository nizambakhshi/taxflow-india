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

  // Get ID from URL directly — avoids params Promise issue
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

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1000px' }}>

      {/* Action bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: '1.5rem'
      }}>
        <button
          onClick={() => router.push('/invoices')}
          style={{
            background: 'none', border: 'none', color: '#2563eb',
            fontSize: '13px', cursor: 'pointer', padding: 0
          }}
        >
          ← Back to Invoices
        </button>

        <div style={{ display: 'flex', gap: '8px' }}>
          {invoice.status !== 'sent' && invoice.payment_status !== 'paid' && (
            <button
              onClick={handleMarkPaid}
              style={{
                padding: '8px 16px', background: '#f0fdf4',
                color: '#166534', border: '1px solid #bbf7d0',
                borderRadius: '8px', fontSize: '13px',
                fontWeight: '500', cursor: 'pointer'
              }}
            >
              ✓ Mark as Paid
            </button>
          )}
          <button
            onClick={() => window.print()}
            style={{
              padding: '8px 16px', background: '#f1f5f9',
              color: '#374151', border: '1px solid #e2e8f0',
              borderRadius: '8px', fontSize: '13px', cursor: 'pointer'
            }}
          >
            🖨️ Print / PDF
          </button>
          {invoice.status !== 'cancelled' && (
            <button
              onClick={handleCancel}
              style={{
                padding: '8px 16px', background: '#fef2f2',
                color: '#dc2626', border: '1px solid #fecaca',
                borderRadius: '8px', fontSize: '13px', cursor: 'pointer'
              }}
            >
              Cancel Invoice
            </button>
          )}
        </div>
      </div>

      {/* Cancelled banner */}
      {invoice.status === 'cancelled' && (
        <div style={{
          background: '#fef2f2', border: '1px solid #fecaca',
          color: '#dc2626', padding: '10px 16px',
          borderRadius: '8px', marginBottom: '1rem',
          fontSize: '13px', fontWeight: '500'
        }}>
          ⚠️ This invoice has been cancelled
        </div>
      )}

      {/* Invoice document */}
      <div id="invoice-print" style={{
        background: 'white', border: '1px solid #e2e8f0',
        borderRadius: '12px', padding: '2rem'
      }}>

        {/* Top header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'flex-start', marginBottom: '1.5rem',
          paddingBottom: '1.5rem', borderBottom: '2px solid #2563eb'
        }}>
          <div>
            <div style={{
              fontSize: '22px', fontWeight: '700',
              color: '#2563eb', marginBottom: '4px'
            }}>
              TAX INVOICE
            </div>
            {invoice.is_reverse_charge && (
              <div style={{ fontSize: '12px', color: '#dc2626', fontWeight: '500' }}>
                Reverse Charge: Yes
              </div>
            )}
          </div>
          <div style={{ textAlign: 'right' as const }}>
            <div style={{ fontSize: '18px', fontWeight: '700', color: '#1e293b' }}>
              {invoice.invoice_number}
            </div>
            <div style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>
              Date: {new Date(invoice.invoice_date).toLocaleDateString('en-IN', {
                day: '2-digit', month: 'short', year: 'numeric'
              })}
            </div>
            {invoice.due_date && (
              <div style={{ fontSize: '13px', color: '#64748b' }}>
                Due: {new Date(invoice.due_date).toLocaleDateString('en-IN', {
                  day: '2-digit', month: 'short', year: 'numeric'
                })}
              </div>
            )}
            <div style={{ marginTop: '8px' }}>
              <span style={{
                fontSize: '11px', padding: '3px 10px',
                borderRadius: '99px', fontWeight: '600',
                textTransform: 'uppercase' as const,
                background:
                  invoice.payment_status === 'paid' ? '#f0fdf4' :
                  invoice.payment_status === 'partial' ? '#fef9c3' : '#fef2f2',
                color:
                  invoice.payment_status === 'paid' ? '#166634' :
                  invoice.payment_status === 'partial' ? '#854d0e' : '#dc2626',
              }}>
                {invoice.payment_status}
              </span>
            </div>
          </div>
        </div>

        {/* Seller & Buyer */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr',
          gap: '2rem', marginBottom: '1.5rem'
        }}>
          <div>
            <div style={{
              fontSize: '11px', fontWeight: '700', color: '#94a3b8',
              marginBottom: '6px', textTransform: 'uppercase' as const
            }}>From</div>
            <div style={{ fontWeight: '700', fontSize: '15px', color: '#1e293b' }}>
              {org?.name}
            </div>
            {gstReg?.gstin && (
              <div style={{ fontSize: '12px', color: '#374151', marginTop: '2px' }}>
                GSTIN: <span style={{ fontFamily: 'monospace', fontWeight: '600' }}>
                  {gstReg.gstin}
                </span>
              </div>
            )}
            {org?.address_line1 && (
              <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                {[org.address_line1, org.address_line2, org.city, org.state, org.pincode]
                  .filter(Boolean).join(', ')}
              </div>
            )}
            {org?.phone && (
              <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                Ph: {org.phone}
              </div>
            )}
            {org?.email && (
              <div style={{ fontSize: '12px', color: '#64748b' }}>{org.email}</div>
            )}
          </div>

          <div>
            <div style={{
              fontSize: '11px', fontWeight: '700', color: '#94a3b8',
              marginBottom: '6px', textTransform: 'uppercase' as const
            }}>Bill To</div>
            <div style={{ fontWeight: '700', fontSize: '15px', color: '#1e293b' }}>
              {invoice.customer_name}
            </div>
            {invoice.customer_gstin && (
              <div style={{ fontSize: '12px', color: '#374151', marginTop: '2px' }}>
                GSTIN: <span style={{ fontFamily: 'monospace', fontWeight: '600' }}>
                  {invoice.customer_gstin}
                </span>
              </div>
            )}
            {invoice.customer_address && (
              <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                {invoice.customer_address}
              </div>
            )}
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
              Place of Supply: {invoice.place_of_supply_name} ({invoice.place_of_supply})
            </div>
          </div>
        </div>

        {/* Line items table */}
        <div style={{ overflowX: 'auto', marginBottom: '1.5rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {[
                  '#', 'Item', 'HSN/SAC', 'Qty', 'Rate', 'Taxable Value',
                  ...(showCGST ? ['CGST'] : []),
                  ...(showSGST ? ['SGST'] : []),
                  ...(showIGST ? ['IGST'] : []),
                  'Total'
                ].map(h => (
                  <th key={h} style={{
                    padding: '8px 10px',
                    border: '1px solid #e2e8f0',
                    fontWeight: '600', color: '#374151', fontSize: '12px',
                    textAlign: ['Rate', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total']
                      .includes(h) ? 'right' as const : 'left' as const
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => (
                <tr key={item.id} style={{ background: idx % 2 === 0 ? 'white' : '#fafafa' }}>
                  <td style={{ padding: '8px 10px', border: '1px solid #e2e8f0', color: '#64748b' }}>
                    {idx + 1}
                  </td>
                  <td style={{ padding: '8px 10px', border: '1px solid #e2e8f0' }}>
                    <div style={{ fontWeight: '500', color: '#1e293b' }}>{item.item_name}</div>
                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>{item.unit}</div>
                  </td>
                  <td style={{
                    padding: '8px 10px', border: '1px solid #e2e8f0',
                    fontFamily: 'monospace', fontSize: '12px', textAlign: 'center' as const
                  }}>
                    {item.hsn_sac || '—'}
                  </td>
                  <td style={{
                    padding: '8px 10px', border: '1px solid #e2e8f0',
                    textAlign: 'center' as const
                  }}>
                    {item.quantity}
                  </td>
                  <td style={{
                    padding: '8px 10px', border: '1px solid #e2e8f0',
                    textAlign: 'right' as const
                  }}>
                    ₹{formatINR(item.rate)}
                  </td>
                  <td style={{
                    padding: '8px 10px', border: '1px solid #e2e8f0',
                    textAlign: 'right' as const
                  }}>
                    ₹{formatINR(item.taxable_value)}
                    {Number(item.discount_percent) > 0 && (
                      <div style={{ fontSize: '11px', color: '#64748b' }}>
                        Disc: {item.discount_percent}%
                      </div>
                    )}
                  </td>
                  {showCGST && (
                    <td style={{
                      padding: '8px 10px', border: '1px solid #e2e8f0',
                      textAlign: 'right' as const
                    }}>
                      <div>₹{formatINR(item.cgst_amount)}</div>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>{item.cgst_rate}%</div>
                    </td>
                  )}
                  {showSGST && (
                    <td style={{
                      padding: '8px 10px', border: '1px solid #e2e8f0',
                      textAlign: 'right' as const
                    }}>
                      <div>₹{formatINR(item.sgst_amount)}</div>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>{item.sgst_rate}%</div>
                    </td>
                  )}
                  {showIGST && (
                    <td style={{
                      padding: '8px 10px', border: '1px solid #e2e8f0',
                      textAlign: 'right' as const
                    }}>
                      <div>₹{formatINR(item.igst_amount)}</div>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>{item.igst_rate}%</div>
                    </td>
                  )}
                  <td style={{
                    padding: '8px 10px', border: '1px solid #e2e8f0',
                    textAlign: 'right' as const, fontWeight: '600'
                  }}>
                    ₹{formatINR(item.total_amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1.5rem' }}>
          <div style={{ width: '300px' }}>
            {[
              { label: 'Subtotal', value: invoice.subtotal, show: true },
              { label: 'Discount', value: -invoice.discount_amount, show: Number(invoice.discount_amount) > 0 },
              { label: 'Taxable Amount', value: invoice.taxable_amount, show: true },
              { label: 'CGST', value: invoice.cgst_amount, show: showCGST },
              { label: 'SGST', value: invoice.sgst_amount, show: showSGST },
              { label: 'IGST', value: invoice.igst_amount, show: showIGST },
              { label: 'Cess', value: invoice.cess_amount, show: Number(invoice.cess_amount) > 0 },
              { label: 'Round Off', value: invoice.round_off, show: Number(invoice.round_off) !== 0 },
            ].filter(r => r.show).map(row => (
              <div key={row.label} style={{
                display: 'flex', justifyContent: 'space-between',
                padding: '5px 0', fontSize: '13px',
                borderBottom: '1px solid #f1f5f9', color: '#64748b'
              }}>
                <span>{row.label}</span>
                <span style={{ color: Number(row.value) < 0 ? '#dc2626' : '#374151' }}>
                  ₹{formatINR(Math.abs(Number(row.value)))}
                </span>
              </div>
            ))}

            <div style={{
              display: 'flex', justifyContent: 'space-between',
              padding: '10px 0 4px', fontSize: '16px',
              fontWeight: '700', color: '#1e293b',
              borderTop: '2px solid #1e293b', marginTop: '4px'
            }}>
              <span>Grand Total</span>
              <span style={{ color: '#2563eb' }}>₹{formatINR(invoice.grand_total)}</span>
            </div>

            {Number(invoice.amount_paid) > 0 && (
              <>
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  padding: '4px 0', fontSize: '13px', color: '#166534'
                }}>
                  <span>Amount Paid</span>
                  <span>₹{formatINR(invoice.amount_paid)}</span>
                </div>
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  padding: '4px 0', fontSize: '13px',
                  fontWeight: '600', color: '#dc2626'
                }}>
                  <span>Balance Due</span>
                  <span>₹{formatINR(invoice.balance_due)}</span>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Amount in words */}
        <div style={{
          background: '#f8fafc', border: '1px solid #e2e8f0',
          borderRadius: '8px', padding: '10px 14px',
          fontSize: '12px', color: '#374151', marginBottom: '1.5rem'
        }}>
          <strong>Amount in Words:</strong> {numberToWords(Number(invoice.grand_total))}
        </div>

        {/* Notes & Terms */}
        {(invoice.notes || invoice.terms) && (
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr',
            gap: '1rem', marginBottom: '1.5rem'
          }}>
            {invoice.notes && (
              <div>
                <div style={{
                  fontSize: '11px', fontWeight: '700', color: '#94a3b8',
                  marginBottom: '4px', textTransform: 'uppercase' as const
                }}>Notes</div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>{invoice.notes}</div>
              </div>
            )}
            {invoice.terms && (
              <div>
                <div style={{
                  fontSize: '11px', fontWeight: '700', color: '#94a3b8',
                  marginBottom: '4px', textTransform: 'uppercase' as const
                }}>Terms & Conditions</div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>{invoice.terms}</div>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div style={{
          borderTop: '1px solid #e2e8f0', paddingTop: '1rem',
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'flex-end'
        }}>
          <div style={{ fontSize: '11px', color: '#94a3b8' }}>
            This is a computer generated invoice
          </div>
          <div style={{ textAlign: 'center' as const }}>
            <div style={{
              borderTop: '1px solid #374151', paddingTop: '4px',
              width: '160px', fontSize: '12px', color: '#374151'
            }}>
              Authorised Signatory
            </div>
            <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
              {org?.name}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @media print {
          nav, button, .no-print { display: none !important; }
          body { background: white !important; }
          #invoice-print {
            border: none !important;
            border-radius: 0 !important;
            padding: 1rem !important;
          }
        }
      `}</style>
    </div>
  )
}