'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'

export default function InvoicesPage() {
  const supabase = createClient()
  const router = useRouter()
  const [orgId, setOrgId] = useState('')
  const [invoices, setInvoices] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

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

      const { data } = await supabase
        .from('invoices')
        .select('*')
        .eq('organization_id', membership.organization_id)
        .order('created_at', { ascending: false })

      setInvoices(data || [])
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>

  return (
    <div className="page-container" style={{ maxWidth: '1100px' }}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>Invoices</h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>{invoices.length} invoice{invoices.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => router.push('/invoices/new')}
          style={{
            padding: '9px 18px', background: '#2563eb', color: 'white',
            border: 'none', borderRadius: '8px', fontSize: '14px',
            fontWeight: '600', cursor: 'pointer'
          }}>
          + New Invoice
        </button>
      </div>

      {invoices.length === 0 ? (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px',
          padding: '3rem', textAlign: 'center', color: '#94a3b8'
        }}>
          <div style={{ fontSize: '40px', marginBottom: '1rem' }}>🧾</div>
          <div style={{ fontSize: '16px', fontWeight: '500', color: '#64748b', marginBottom: '8px' }}>No invoices yet</div>
          <div style={{ fontSize: '13px', marginBottom: '1.5rem' }}>Create your first GST invoice</div>
          <button
            onClick={() => router.push('/invoices/new')}
            style={{
              padding: '10px 24px', background: '#2563eb', color: 'white',
              border: 'none', borderRadius: '8px', fontSize: '14px',
              fontWeight: '600', cursor: 'pointer'
            }}>
            Create Invoice
          </button>
        </div>
      ) : (
        <div className="responsive-table table-frame">
          <div className="table-header" style={{
            display: 'grid', gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr 1fr',
            gap: '12px', padding: '10px 16px', background: '#f8fafc',
            fontSize: '12px', fontWeight: '600', color: '#64748b',
            borderBottom: '1px solid #e2e8f0'
          }}>
            <span>Invoice No.</span><span>Customer</span><span>Date</span>
            <span>Amount</span><span>Status</span><span>Payment</span>
          </div>
          {invoices.map((inv) => (
            <div key={inv.id}
              className="table-row"
              onClick={() => router.push(`/invoices/${inv.id}`)}
              style={{
                display: 'grid', gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr 1fr',
                gap: '12px', padding: '12px 16px',
                borderBottom: '1px solid #f1f5f9',
                alignItems: 'center', fontSize: '13px', cursor: 'pointer'
              }}>
              <div data-label="Invoice No." style={{ fontWeight: '600', color: '#2563eb' }}>{inv.invoice_number}</div>
              <div data-label="Customer" style={{ color: '#1e293b' }}>{inv.customer_name}</div>
              <div data-label="Date" style={{ color: '#64748b' }}>{new Date(inv.invoice_date).toLocaleDateString('en-IN')}</div>
              <div data-label="Amount" style={{ fontWeight: '500' }}>₹{Number(inv.grand_total).toLocaleString('en-IN')}</div>
              <div data-label="Status">
                <span style={{
                  fontSize: '11px', padding: '2px 8px', borderRadius: '99px',
                  background: inv.status === 'draft' ? '#f1f5f9' : inv.status === 'sent' ? '#eff6ff' : '#fef2f2',
                  color: inv.status === 'draft' ? '#64748b' : inv.status === 'sent' ? '#1d4ed8' : '#dc2626',
                  textTransform: 'capitalize' as const
                }}>{inv.status}</span>
              </div>
              <div data-label="Payment">
                <span style={{
                  fontSize: '11px', padding: '2px 8px', borderRadius: '99px',
                  background: inv.payment_status === 'paid' ? '#f0fdf4' : inv.payment_status === 'partial' ? '#fef9c3' : '#fef2f2',
                  color: inv.payment_status === 'paid' ? '#166534' : inv.payment_status === 'partial' ? '#854d0e' : '#dc2626',
                  textTransform: 'capitalize' as const
                }}>{inv.payment_status}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}