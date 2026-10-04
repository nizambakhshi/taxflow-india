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

const EXPENSE_CATEGORIES = [
  'Office Supplies', 'Travel & Transport', 'Meals & Entertainment',
  'Rent', 'Utilities', 'Telephone & Internet', 'Professional Fees',
  'Repairs & Maintenance', 'Advertising & Marketing', 'Software & Subscriptions',
  'Insurance', 'Bank Charges', 'Salaries', 'Printing & Stationery',
  'Courier & Postage', 'Miscellaneous'
]

const PAYMENT_MODES = ['Cash', 'Bank Transfer', 'UPI', 'Credit Card', 'Debit Card', 'Cheque']
const GST_RATES = [0, 5, 12, 18, 28]

export default function ExpensesPage() {
  const supabase = createClient()
  const router = useRouter()

  const [expenses, setExpenses] = useState<any[]>([])
  const [orgId, setOrgId] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [vendors, setVendors] = useState<any[]>([])

  const [form, setForm] = useState({
    expense_date: new Date().toISOString().split('T')[0],
    category: '',
    description: '',
    vendor_id: '',
    vendor_name: '',
    vendor_gstin: '',
    bill_number: '',
    amount: '',
    gst_rate: '0',
    itc_eligible: false,
    payment_mode: 'Bank Transfer',
    payment_status: 'paid',
    notes: '',
  })

  // Calculated GST
  const totalAmount = parseFloat(form.amount) || 0
  const gstRate = parseFloat(form.gst_rate) || 0
  const gstAmount = gstRate > 0
    ? Math.round((totalAmount - totalAmount / (1 + gstRate / 100)) * 100) / 100
    : 0
  const taxableAmount = Math.round((totalAmount - gstAmount) * 100) / 100

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

      const { data: expData } = await supabase
        .from('expenses')
        .select('*')
        .eq('organization_id', membership.organization_id)
        .order('expense_date', { ascending: false })

      setExpenses(expData || [])

      const { data: vendorData } = await supabase
        .from('vendors')
        .select('*')
        .eq('organization_id', membership.organization_id)
        .eq('is_active', true)
        .order('name')

      setVendors(vendorData || [])
      setLoading(false)
    }
    load()
  }, [])

  function resetForm() {
    setForm({
      expense_date: new Date().toISOString().split('T')[0],
      category: '', description: '',
      vendor_id: '', vendor_name: '', vendor_gstin: '',
      bill_number: '', amount: '', gst_rate: '0',
      itc_eligible: false, payment_mode: 'Bank Transfer',
      payment_status: 'paid', notes: '',
    })
    setError('')
  }

  function handleVendorSelect(id: string) {
    const vendor = vendors.find(v => v.id === id)
    setForm(p => ({
      ...p,
      vendor_id: id,
      vendor_name: vendor?.name || '',
      vendor_gstin: vendor?.gstin || '',
    }))
  }

  async function handleSave() {
    if (!form.category) { setError('Please select a category'); return }
    if (!form.amount || parseFloat(form.amount) <= 0) {
      setError('Please enter a valid amount')
      return
    }

    setSaving(true)
    setError('')

    try {
      const { error: expError } = await supabase
        .from('expenses')
        .insert({
          organization_id: orgId,
          expense_date: form.expense_date,
          category: form.category,
          description: form.description,
          vendor_id: form.vendor_id || null,
          vendor_name: form.vendor_name,
          vendor_gstin: form.vendor_gstin,
          bill_number: form.bill_number,
          amount: totalAmount,
          gst_rate: gstRate,
          gst_amount: gstAmount,
          taxable_amount: taxableAmount,
          itc_eligible: form.itc_eligible,
          payment_mode: form.payment_mode,
          payment_status: form.payment_status,
          notes: form.notes,
        })

      if (expError) throw expError

      const { data: expData } = await supabase
        .from('expenses')
        .select('*')
        .eq('organization_id', orgId)
        .order('expense_date', { ascending: false })

      setExpenses(expData || [])
      setShowForm(false)
      resetForm()
    } catch (err: any) {
      setError(err.message || 'Failed to save expense')
    } finally {
      setSaving(false)
    }
  }

  // Summary totals
  const totalExpenses = expenses.reduce((s, e) => s + Number(e.amount), 0)
  const totalGSTPaid = expenses.reduce((s, e) => s + Number(e.gst_amount), 0)
  const totalITC = expenses
    .filter(e => e.itc_eligible)
    .reduce((s, e) => s + Number(e.gst_amount), 0)

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>
  )

  return (
    <div className="page-container" style={{ padding: '2rem', maxWidth: '1100px' }}>
      {/* Header */}
      <div className="page-header" style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: '1.5rem'
      }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
            Expenses
          </h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>
            {expenses.length} expense{expenses.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(true) }}
          style={{
            padding: '9px 18px', background: '#2563eb', color: 'white',
            border: 'none', borderRadius: '8px', fontSize: '14px',
            fontWeight: '600', cursor: 'pointer'
          }}
        >
          + Add Expense
        </button>
      </div>

      {/* Summary cards */}
      {expenses.length > 0 && (
        <div className="metric-grid" style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '1rem', marginBottom: '1.5rem'
        }}>
          {[
            { label: 'Total Expenses', value: totalExpenses, color: '#2563eb' },
            { label: 'GST Paid', value: totalGSTPaid, color: '#7c3aed' },
            { label: 'ITC Claimable', value: totalITC, color: '#059669' },
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
            </div>
          ))}
        </div>
      )}

      {/* Expenses list */}
      {expenses.length === 0 ? (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', padding: '3rem',
          textAlign: 'center', color: '#94a3b8'
        }}>
          <div style={{ fontSize: '36px', marginBottom: '1rem' }}>💸</div>
          <div style={{ fontSize: '16px', fontWeight: '500', color: '#64748b', marginBottom: '8px' }}>
            No expenses yet
          </div>
          <div style={{ fontSize: '13px' }}>
            Track business expenses and claim GST input tax credit
          </div>
        </div>
      ) : (
        <div className="responsive-table table-frame" style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', overflow: 'hidden'
        }}>
          <div className="table-header" style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1.5fr 1.5fr 1fr 1fr 1fr',
            gap: '12px', padding: '10px 16px', background: '#f8fafc',
            fontSize: '12px', fontWeight: '600', color: '#64748b',
            borderBottom: '1px solid #e2e8f0'
          }}>
            <span>Date</span>
            <span>Category</span>
            <span>Description / Vendor</span>
            <span>Amount</span>
            <span>GST / ITC</span>
            <span>Payment</span>
          </div>

          {expenses.map(exp => (
            <div key={exp.id} className="table-row" style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1.5fr 1.5fr 1fr 1fr 1fr',
              gap: '12px', padding: '12px 16px',
              borderBottom: '1px solid #f1f5f9',
              alignItems: 'center', fontSize: '13px'
            }}>
              <div data-label="Date" style={{ color: '#64748b' }}>
                {new Date(exp.expense_date).toLocaleDateString('en-IN')}
              </div>
              <div data-label="Category">
                <span style={{
                  fontSize: '11px', padding: '2px 8px',
                  borderRadius: '99px', background: '#f1f5f9',
                  color: '#374151', fontWeight: '500'
                }}>
                  {exp.category}
                </span>
              </div>
              <div data-label="Description / Vendor">
                <div style={{ color: '#1e293b' }}>{exp.description || '—'}</div>
                {exp.vendor_name && (
                  <div style={{ fontSize: '12px', color: '#64748b' }}>{exp.vendor_name}</div>
                )}
              </div>
              <div data-label="Amount" style={{ fontWeight: '500' }}>₹{formatINR(exp.amount)}</div>
              <div data-label="GST / ITC">
                {Number(exp.gst_amount) > 0 ? (
                  <div>
                    <div style={{ fontSize: '12px' }}>₹{formatINR(exp.gst_amount)}</div>
                    <span style={{
                      fontSize: '11px', padding: '1px 6px',
                      borderRadius: '99px',
                      background: exp.itc_eligible ? '#f0fdf4' : '#f8fafc',
                      color: exp.itc_eligible ? '#166534' : '#94a3b8'
                    }}>
                      {exp.itc_eligible ? 'ITC eligible' : 'No ITC'}
                    </span>
                  </div>
                ) : (
                  <span style={{ color: '#94a3b8', fontSize: '12px' }}>No GST</span>
                )}
              </div>
              <div data-label="Payment">
                <div style={{ fontSize: '12px', color: '#64748b' }}>{exp.payment_mode}</div>
                <span style={{
                  fontSize: '11px', padding: '2px 6px',
                  borderRadius: '99px',
                  background: exp.payment_status === 'paid' ? '#f0fdf4' : '#fef2f2',
                  color: exp.payment_status === 'paid' ? '#166534' : '#dc2626'
                }}>
                  {exp.payment_status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Expense Modal */}
      {showForm && (
        <div className="modal-container" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 100, padding: '1rem'
        }}>
          <div className="modal-content" style={{
            background: 'white', borderRadius: '16px',
            padding: '2rem', width: '100%',
            maxWidth: '580px', maxHeight: '90vh', overflowY: 'auto'
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', marginBottom: '1.5rem'
            }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>
                Add Expense
              </h2>
              <button
                onClick={() => { setShowForm(false); resetForm() }}
                style={{
                  background: 'none', border: 'none',
                  fontSize: '20px', cursor: 'pointer', color: '#94a3b8'
                }}
              >✕</button>
            </div>

            <div className="form-grid-2" style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr',
              gap: '1rem', marginBottom: '1rem'
            }}>
              <div>
                <label style={labelStyle}>Date *</label>
                <input style={inputStyle} type="date"
                  value={form.expense_date}
                  onChange={e => setForm(p => ({ ...p, expense_date: e.target.value }))} />
              </div>
              <div>
                <label style={labelStyle}>Category *</label>
                <select
                  style={{ ...inputStyle, cursor: 'pointer' }}
                  value={form.category}
                  onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
                >
                  <option value="">Select category...</option>
                  {EXPENSE_CATEGORIES.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={labelStyle}>Description</label>
              <input style={inputStyle}
                value={form.description}
                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                placeholder="What was this expense for?" />
            </div>

            <div className="form-grid-2" style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr',
              gap: '1rem', marginBottom: '1rem'
            }}>
              <div>
                <label style={labelStyle}>Vendor (optional)</label>
                <select
                  style={{ ...inputStyle, cursor: 'pointer' }}
                  value={form.vendor_id}
                  onChange={e => handleVendorSelect(e.target.value)}
                >
                  <option value="">Select vendor...</option>
                  {vendors.map(v => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Bill / Invoice Number</label>
                <input style={inputStyle}
                  value={form.bill_number}
                  onChange={e => setForm(p => ({ ...p, bill_number: e.target.value }))}
                  placeholder="Vendor bill number" />
              </div>
            </div>

            <div className="form-grid-2" style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr',
              gap: '1rem', marginBottom: '1rem'
            }}>
              <div>
                <label style={labelStyle}>Total Amount (₹) *</label>
                <input style={inputStyle} type="number"
                  value={form.amount}
                  onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                  placeholder="0.00" min="0" step="0.01" />
              </div>
              <div>
                <label style={labelStyle}>GST Rate (if applicable)</label>
                <select
                  style={{ ...inputStyle, cursor: 'pointer' }}
                  value={form.gst_rate}
                  onChange={e => setForm(p => ({ ...p, gst_rate: e.target.value }))}
                >
                  {GST_RATES.map(r => (
                    <option key={r} value={r}>{r}% {r === 0 ? '(No GST)' : ''}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* GST breakdown */}
            {gstAmount > 0 && (
              <div style={{
                background: '#f8fafc', border: '1px solid #e2e8f0',
                borderRadius: '8px', padding: '10px 14px',
                marginBottom: '1rem', fontSize: '13px'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#64748b' }}>
                  <span>Taxable Amount</span>
                  <span>₹{formatINR(taxableAmount)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#64748b', marginTop: '4px' }}>
                  <span>GST ({form.gst_rate}%)</span>
                  <span>₹{formatINR(gstAmount)}</span>
                </div>
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontWeight: '600', color: '#1e293b',
                  marginTop: '6px', paddingTop: '6px',
                  borderTop: '1px solid #e2e8f0'
                }}>
                  <span>Total</span>
                  <span>₹{formatINR(totalAmount)}</span>
                </div>
              </div>
            )}

            <div className="form-grid-2" style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr',
              gap: '1rem', marginBottom: '1rem'
            }}>
              <div>
                <label style={labelStyle}>Payment Mode</label>
                <select
                  style={{ ...inputStyle, cursor: 'pointer' }}
                  value={form.payment_mode}
                  onChange={e => setForm(p => ({ ...p, payment_mode: e.target.value }))}
                >
                  {PAYMENT_MODES.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Payment Status</label>
                <select
                  style={{ ...inputStyle, cursor: 'pointer' }}
                  value={form.payment_status}
                  onChange={e => setForm(p => ({ ...p, payment_status: e.target.value }))}
                >
                  <option value="paid">Paid</option>
                  <option value="unpaid">Unpaid</option>
                </select>
              </div>
            </div>

            {gstAmount > 0 && (
              <label style={{
                display: 'flex', alignItems: 'center',
                gap: '8px', cursor: 'pointer', marginBottom: '1rem'
              }}>
                <input type="checkbox"
                  checked={form.itc_eligible}
                  onChange={e => setForm(p => ({ ...p, itc_eligible: e.target.checked }))} />
                <span style={{ fontSize: '13px', color: '#374151' }}>
                  ITC eligible — GST of ₹{formatINR(gstAmount)} can be claimed as input tax credit
                </span>
              </label>
            )}

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={labelStyle}>Notes</label>
              <textarea
                style={{ ...inputStyle, height: '60px', resize: 'vertical' as const }}
                value={form.notes}
                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                placeholder="Any additional notes..." />
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
                onClick={handleSave}
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
                {saving ? 'Saving...' : 'Save Expense'}
              </button>
              <button
                onClick={() => { setShowForm(false); resetForm() }}
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