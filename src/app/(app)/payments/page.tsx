'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'

const inputStyle = {
  width: '100%', padding: '8px 10px',
  border: '1px solid #d1d5db', borderRadius: '6px',
  fontSize: '13px', outline: 'none',
  color: '#1e293b', background: 'white',
}

const labelStyle = {
  display: 'block' as const,
  fontSize: '12px', fontWeight: '500' as const,
  color: '#374151', marginBottom: '4px',
}

export default function PaymentsPage() {
  const supabase = createClient()
  const router = useRouter()

  const [tab, setTab] = useState<'receivables' | 'payables'>('receivables')
  const [orgId, setOrgId] = useState('')
  const [loading, setLoading] = useState(true)

  const [invoices, setInvoices] = useState<any[]>([])
  const [bills, setBills] = useState<any[]>([])
  const [payments, setPayments] = useState<any[]>([])

  // Payment form
  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [selectedInvoice, setSelectedInvoice] = useState<any>(null)
  const [selectedBill, setSelectedBill] = useState<any>(null)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentDate, setPaymentDate] = useState(
    new Date().toISOString().split('T')[0]
  )
  const [paymentMode, setPaymentMode] = useState('Bank Transfer')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [paymentNotes, setPaymentNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { router.push('/setup'); return }
      setOrgId(membership.organization_id)

      await loadData(membership.organization_id)
      setLoading(false)
    }
    load()
  }, [])

  async function loadData(oid: string) {
    const { data: invData } = await supabase
      .from('invoices')
      .select('*')
      .eq('organization_id', oid)
      .in('payment_status', ['unpaid', 'partial'])
      .neq('status', 'cancelled')
      .order('invoice_date', { ascending: false })

    const { data: billData } = await supabase
      .from('purchase_bills')
      .select('*')
      .eq('organization_id', oid)
      .in('payment_status', ['unpaid', 'partial'])
      .neq('status', 'cancelled')
      .order('bill_date', { ascending: false })

    const { data: payData } = await supabase
      .from('payments')
      .select('*')
      .eq('organization_id', oid)
      .order('payment_date', { ascending: false })
      .limit(20)

    setInvoices(invData || [])
    setBills(billData || [])
    setPayments(payData || [])
  }

  function openPaymentForm(invoice?: any, bill?: any) {
    setSelectedInvoice(invoice || null)
    setSelectedBill(bill || null)
    setPaymentAmount(
      invoice ? String(invoice.balance_due) :
      bill ? String(bill.balance_due) : ''
    )
    setPaymentDate(new Date().toISOString().split('T')[0])
    setPaymentMode('Bank Transfer')
    setReferenceNumber('')
    setPaymentNotes('')
    setError('')
    setShowPaymentForm(true)
  }

  async function handleRecordPayment() {
    const amount = parseFloat(paymentAmount)
    if (!amount || amount <= 0) {
      setError('Please enter a valid amount')
      return
    }

    const maxAmount = selectedInvoice
      ? selectedInvoice.balance_due
      : selectedBill?.balance_due

    if (amount > maxAmount) {
      setError(`Amount cannot exceed balance due of ₹${formatINR(maxAmount)}`)
      return
    }

    setSaving(true)
    setError('')

    try {
      // Record payment
      await supabase.from('payments').insert({
        organization_id: orgId,
        payment_date: paymentDate,
        payment_type: selectedInvoice ? 'received' : 'made',
        payment_mode: paymentMode,
        invoice_id: selectedInvoice?.id || null,
        bill_id: selectedBill?.id || null,
        party_name: selectedInvoice?.customer_name || selectedBill?.vendor_name,
        party_type: selectedInvoice ? 'customer' : 'vendor',
        amount,
        reference_number: referenceNumber,
        notes: paymentNotes,
      })

      // Update invoice or bill
      if (selectedInvoice) {
        const newPaid = Number(selectedInvoice.amount_paid) + amount
        const newBalance = Number(selectedInvoice.grand_total) - newPaid
        const newStatus = newBalance <= 0 ? 'paid' : 'partial'

        await supabase
          .from('invoices')
          .update({
            amount_paid: newPaid,
            balance_due: Math.max(0, newBalance),
            payment_status: newStatus,
          })
          .eq('id', selectedInvoice.id)
      }

      if (selectedBill) {
        const newPaid = Number(selectedBill.amount_paid) + amount
        const newBalance = Number(selectedBill.grand_total) - newPaid
        const newStatus = newBalance <= 0 ? 'paid' : 'partial'

        await supabase
          .from('purchase_bills')
          .update({
            amount_paid: newPaid,
            balance_due: Math.max(0, newBalance),
            payment_status: newStatus,
          })
          .eq('id', selectedBill.id)
      }

      await loadData(orgId)
      setShowPaymentForm(false)
    } catch (err: any) {
      setError(err.message || 'Failed to record payment')
    } finally {
      setSaving(false)
    }
  }

  // Ageing buckets
  function getAgeing(dateStr: string) {
    const days = Math.floor(
      (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24)
    )
    if (days <= 0) return { label: 'Not due', color: '#166534', bg: '#f0fdf4' }
    if (days <= 30) return { label: `${days}d overdue`, color: '#854d0e', bg: '#fef9c3' }
    if (days <= 60) return { label: `${days}d overdue`, color: '#c2410c', bg: '#fff7ed' }
    return { label: `${days}d overdue`, color: '#dc2626', bg: '#fef2f2' }
  }

  const totalReceivable = invoices.reduce((s, i) => s + Number(i.balance_due), 0)
  const totalPayable = bills.reduce((s, b) => s + Number(b.balance_due), 0)

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>
  )

  return (
    <div className="page-container" style={{ maxWidth: '1100px' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
          Payments
        </h1>
        <p style={{ fontSize: '14px', color: '#64748b' }}>
          Track receivables and payables
        </p>
      </div>

      {/* Summary cards */}
      <div className="metric-grid" style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '1rem', marginBottom: '1.5rem'
      }}>
        {[
          { label: 'Total Receivable', value: totalReceivable, color: '#2563eb', count: invoices.length, unit: 'invoices' },
          { label: 'Total Payable', value: totalPayable, color: '#dc2626', count: bills.length, unit: 'bills' },
          {
            label: 'Overdue (>30 days)',
            value: invoices
              .filter(i => {
                const days = Math.floor((Date.now() - new Date(i.invoice_date).getTime()) / 86400000)
                return days > 30
              })
              .reduce((s, i) => s + Number(i.balance_due), 0),
            color: '#d97706', count: null, unit: ''
          },
          {
            label: 'Payments This Month',
            value: payments
              .filter(p => new Date(p.payment_date).getMonth() === new Date().getMonth())
              .reduce((s, p) => s + Number(p.amount), 0),
            color: '#059669', count: null, unit: ''
          },
        ].map(card => (
          <div key={card.label} style={{
            background: 'white', border: '1px solid #e2e8f0',
            borderRadius: '12px', padding: '1rem',
            borderTop: `3px solid ${card.color}`
          }}>
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
              {card.label}
            </div>
            <div style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>
              ₹{formatINR(card.value)}
            </div>
            {card.count !== null && (
              <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                {card.count} {card.unit}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="tab-bar" style={{
        display: 'flex', gap: '4px',
        borderBottom: '1px solid #e2e8f0', marginBottom: '1rem'
      }}>
        {([
          { key: 'receivables', label: `Receivables (${invoices.length})` },
          { key: 'payables', label: `Payables (${bills.length})` },
        ] as const).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 20px', background: 'none',
            border: 'none', cursor: 'pointer',
            fontSize: '14px', fontWeight: tab === t.key ? '600' : '400',
            color: tab === t.key ? '#2563eb' : '#64748b',
            borderBottom: tab === t.key ? '2px solid #2563eb' : '2px solid transparent',
            marginBottom: '-1px'
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Receivables */}
      {tab === 'receivables' && (
        <>
          {invoices.length === 0 ? (
            <div style={{
              background: 'white', border: '1px solid #e2e8f0',
              borderRadius: '12px', padding: '3rem',
              textAlign: 'center', color: '#94a3b8'
            }}>
              <div style={{ fontSize: '32px', marginBottom: '1rem' }}>✅</div>
              <div style={{ fontSize: '15px', fontWeight: '500', color: '#64748b' }}>
                No outstanding receivables
              </div>
              <div style={{ fontSize: '13px', marginTop: '6px' }}>
                All invoices are paid
              </div>
            </div>
          ) : (
            <div className="responsive-table table-frame" style={{
              background: 'white', border: '1px solid #e2e8f0',
              borderRadius: '12px', overflow: 'hidden'
            }}>
              <div className="table-header" style={{
                display: 'grid',
                gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr 1fr 100px',
                gap: '12px', padding: '10px 16px', background: '#f8fafc',
                fontSize: '12px', fontWeight: '600', color: '#64748b',
                borderBottom: '1px solid #e2e8f0'
              }}>
                <span>Invoice</span>
                <span>Customer</span>
                <span>Date</span>
                <span>Total</span>
                <span>Balance Due</span>
                <span>Ageing</span>
                <span>Action</span>
              </div>

              {invoices.map(inv => {
                const age = getAgeing(inv.due_date || inv.invoice_date)
                return (
                  <div key={inv.id} className="table-row" style={{
                    display: 'grid',
                    gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr 1fr 100px',
                    gap: '12px', padding: '12px 16px',
                    borderBottom: '1px solid #f1f5f9',
                    alignItems: 'center', fontSize: '13px'
                  }}>
                    <div data-label="Invoice" style={{ fontWeight: '600', color: '#2563eb' }}>
                      {inv.invoice_number}
                    </div>
                    <div data-label="Customer" style={{ color: '#1e293b' }}>{inv.customer_name}</div>
                    <div data-label="Date" style={{ color: '#64748b' }}>
                      {new Date(inv.invoice_date).toLocaleDateString('en-IN')}
                    </div>
                    <div data-label="Total">₹{formatINR(inv.grand_total)}</div>
                    <div data-label="Balance Due" style={{ fontWeight: '600', color: '#dc2626' }}>
                      ₹{formatINR(inv.balance_due)}
                    </div>
                    <div data-label="Ageing">
                      <span style={{
                        fontSize: '11px', padding: '2px 8px',
                        borderRadius: '99px',
                        background: age.bg, color: age.color
                      }}>
                        {age.label}
                      </span>
                    </div>
                    <div data-label="Actions" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => openPaymentForm(inv, undefined)}
                        style={{
                          width: '100%', padding: '5px 12px', background: '#2563eb',
                          color: 'white', border: 'none',
                          borderRadius: '6px', fontSize: '12px',
                          cursor: 'pointer', fontWeight: '500'
                        }}
                      >
                        + Payment
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* Payables */}
      {tab === 'payables' && (
        <>
          {bills.length === 0 ? (
            <div style={{
              background: 'white', border: '1px solid #e2e8f0',
              borderRadius: '12px', padding: '3rem',
              textAlign: 'center', color: '#94a3b8'
            }}>
              <div style={{ fontSize: '32px', marginBottom: '1rem' }}>✅</div>
              <div style={{ fontSize: '15px', fontWeight: '500', color: '#64748b' }}>
                No outstanding payables
              </div>
              <div style={{ fontSize: '13px', marginTop: '6px' }}>
                All bills are paid
              </div>
            </div>
          ) : (
            <div className="responsive-table table-frame" style={{
              background: 'white', border: '1px solid #e2e8f0',
              borderRadius: '12px', overflow: 'hidden'
            }}>
              <div className="table-header" style={{
                display: 'grid',
                gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr 1fr 100px',
                gap: '12px', padding: '10px 16px', background: '#f8fafc',
                fontSize: '12px', fontWeight: '600', color: '#64748b',
                borderBottom: '1px solid #e2e8f0'
              }}>
                <span>Bill No.</span>
                <span>Vendor</span>
                <span>Date</span>
                <span>Total</span>
                <span>Balance Due</span>
                <span>Ageing</span>
                <span>Action</span>
              </div>

              {bills.map(bill => {
                const age = getAgeing(bill.due_date || bill.bill_date)
                return (
                  <div key={bill.id} className="table-row" style={{
                    display: 'grid',
                    gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr 1fr 100px',
                    gap: '12px', padding: '12px 16px',
                    borderBottom: '1px solid #f1f5f9',
                    alignItems: 'center', fontSize: '13px'
                  }}>
                    <div data-label="Bill No." style={{ fontWeight: '600', color: '#374151' }}>
                      {bill.bill_number}
                    </div>
                    <div data-label="Vendor" style={{ color: '#1e293b' }}>{bill.vendor_name}</div>
                    <div data-label="Date" style={{ color: '#64748b' }}>
                      {new Date(bill.bill_date).toLocaleDateString('en-IN')}
                    </div>
                    <div data-label="Total">₹{formatINR(bill.grand_total)}</div>
                    <div data-label="Balance Due" style={{ fontWeight: '600', color: '#dc2626' }}>
                      ₹{formatINR(bill.balance_due)}
                    </div>
                    <div data-label="Ageing">
                      <span style={{
                        fontSize: '11px', padding: '2px 8px',
                        borderRadius: '99px',
                        background: age.bg, color: age.color
                      }}>
                        {age.label}
                      </span>
                    </div>
                    <div data-label="Actions" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => openPaymentForm(undefined, bill)}
                        style={{
                          width: '100%', padding: '5px 12px', background: '#7c3aed',
                          color: 'white', border: 'none',
                          borderRadius: '6px', fontSize: '12px',
                          cursor: 'pointer', fontWeight: '500'
                        }}
                      >
                        + Payment
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* Recent payments */}
      {payments.length > 0 && (
        <div style={{ marginTop: '2rem' }}>
          <h2 style={{
            fontSize: '15px', fontWeight: '600',
            color: '#1e293b', marginBottom: '1rem'
          }}>
            Recent Payments
          </h2>
          <div className="responsive-table table-frame" style={{
            background: 'white', border: '1px solid #e2e8f0',
            borderRadius: '12px', overflow: 'hidden'
          }}>
            <div className="table-header" style={{
              display: 'grid',
              gridTemplateColumns: '1fr 2fr 1fr 1fr 1fr',
              gap: '12px', padding: '10px 16px', background: '#f8fafc',
              fontSize: '12px', fontWeight: '600', color: '#64748b',
              borderBottom: '1px solid #e2e8f0'
            }}>
              <span>Date</span>
              <span>Party</span>
              <span>Mode</span>
              <span>Type</span>
              <span>Amount</span>
            </div>
            {payments.map(p => (
              <div key={p.id} className="table-row" style={{
                display: 'grid',
                gridTemplateColumns: '1fr 2fr 1fr 1fr 1fr',
                gap: '12px', padding: '10px 16px',
                borderBottom: '1px solid #f1f5f9',
                alignItems: 'center', fontSize: '13px'
              }}>
                <div data-label="Date" style={{ color: '#64748b' }}>
                  {new Date(p.payment_date).toLocaleDateString('en-IN')}
                </div>
                <div data-label="Party" style={{ color: '#1e293b' }}>{p.party_name}</div>
                <div data-label="Mode" style={{ color: '#64748b', fontSize: '12px' }}>
                  {p.payment_mode}
                </div>
                <div data-label="Type">
                  <span style={{
                    fontSize: '11px', padding: '2px 8px',
                    borderRadius: '99px',
                    background: p.payment_type === 'received' ? '#f0fdf4' : '#fef2f2',
                    color: p.payment_type === 'received' ? '#166534' : '#dc2626'
                  }}>
                    {p.payment_type === 'received' ? '↓ Received' : '↑ Made'}
                  </span>
                </div>
                <div data-label="Amount" style={{ fontWeight: '600', color: '#1e293b' }}>
                  ₹{formatINR(p.amount)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Record Payment Modal */}
      {showPaymentForm && (
        <div className="modal-container" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 100, padding: '1rem'
        }}>
          <div className="modal-content" style={{
            background: 'white', borderRadius: '16px',
            padding: '2rem', width: '100%', maxWidth: '480px',
            maxHeight: '90vh', overflowY: 'auto'
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', marginBottom: '1.5rem'
            }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>
                Record Payment
              </h2>
              <button
                onClick={() => setShowPaymentForm(false)}
                style={{
                  background: 'none', border: 'none',
                  fontSize: '20px', cursor: 'pointer', color: '#94a3b8'
                }}
              >✕</button>
            </div>

            {/* Invoice/Bill info */}
            <div style={{
              background: '#f8fafc', border: '1px solid #e2e8f0',
              borderRadius: '8px', padding: '12px 14px', marginBottom: '1.5rem'
            }}>
              <div style={{ fontSize: '13px', color: '#374151', marginBottom: '4px' }}>
                <strong>
                  {selectedInvoice
                    ? `Invoice ${selectedInvoice.invoice_number}`
                    : `Bill ${selectedBill?.bill_number}`}
                </strong>
                {' — '}
                {selectedInvoice?.customer_name || selectedBill?.vendor_name}
              </div>
              <div className="toolbar" style={{ display: 'flex', gap: '16px', fontSize: '12px', color: '#64748b' }}>
                <span>Total: ₹{formatINR(selectedInvoice?.grand_total || selectedBill?.grand_total)}</span>
                <span>Already paid: ₹{formatINR(selectedInvoice?.amount_paid || selectedBill?.amount_paid || 0)}</span>
                <span style={{ color: '#dc2626', fontWeight: '600' }}>
                  Balance: ₹{formatINR(selectedInvoice?.balance_due || selectedBill?.balance_due)}
                </span>
              </div>
            </div>

            <div className="form-grid-2" style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr',
              gap: '1rem', marginBottom: '1rem'
            }}>
              <div>
                <label style={labelStyle}>Payment Date *</label>
                <input style={inputStyle} type="date"
                  value={paymentDate}
                  onChange={e => setPaymentDate(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Amount (₹) *</label>
                <input style={inputStyle} type="number"
                  value={paymentAmount}
                  onChange={e => setPaymentAmount(e.target.value)}
                  min="0" step="0.01" />
              </div>
            </div>

            <div className="form-grid-2" style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr',
              gap: '1rem', marginBottom: '1rem'
            }}>
              <div>
                <label style={labelStyle}>Payment Mode</label>
                <select
                  style={{ ...inputStyle, cursor: 'pointer' }}
                  value={paymentMode}
                  onChange={e => setPaymentMode(e.target.value)}
                >
                  {['Cash', 'Bank Transfer', 'UPI', 'Credit Card',
                    'Debit Card', 'Cheque'].map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Reference No.</label>
                <input style={inputStyle}
                  value={referenceNumber}
                  onChange={e => setReferenceNumber(e.target.value)}
                  placeholder="UTR / Cheque / UPI ref" />
              </div>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={labelStyle}>Notes</label>
              <input style={inputStyle}
                value={paymentNotes}
                onChange={e => setPaymentNotes(e.target.value)}
                placeholder="Optional notes" />
            </div>

            {error && (
              <div style={{
                background: '#fef2f2', border: '1px solid #fecaca',
                color: '#dc2626', padding: '10px 12px',
                borderRadius: '8px', fontSize: '13px', marginBottom: '1rem'
              }}>{error}</div>
            )}

            <div className="btn-group" style={{ display: 'flex', gap: '12px' }}>
              <button
                onClick={handleRecordPayment}
                disabled={saving}
                style={{
                  flex: 1, padding: '11px',
                  background: saving ? '#93c5fd' : '#2563eb',
                  color: 'white', border: 'none',
                  borderRadius: '8px', fontSize: '14px',
                  fontWeight: '600',
                  cursor: saving ? 'not-allowed' : 'pointer'
                }}
              >
                {saving ? 'Saving...' : 'Record Payment'}
              </button>
              <button
                onClick={() => setShowPaymentForm(false)}
                style={{
                  padding: '11px 20px', background: 'white',
                  color: '#374151', border: '1px solid #e2e8f0',
                  borderRadius: '8px', fontSize: '14px', cursor: 'pointer'
                }}
              >Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}