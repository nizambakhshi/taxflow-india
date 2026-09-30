'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'

export default function InvoicesPage() {
  const supabase = createClient()
  const router = useRouter()

  const [orgId, setOrgId] = useState('')
  const [invoices, setInvoices] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')

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

  const filtered = invoices
    .filter(inv => {
      if (filter === 'unpaid') return inv.payment_status === 'unpaid'
      if (filter === 'paid') return inv.payment_status === 'paid'
      if (filter === 'draft') return inv.status === 'draft'
      return true
    })
    .filter(inv =>
      inv.invoice_number?.toLowerCase().includes(search.toLowerCase()) ||
      inv.customer_name?.toLowerCase().includes(search.toLowerCase())
    )

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>
  )

  return (
    <div style={{ padding: '1.5rem' }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: '1rem',
      }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: '600', color: '#1e293b', marginBottom: '2px' }}>
            Invoices
          </h1>
          <p style={{ fontSize: '13px', color: '#64748b' }}>
            {invoices.length} total
          </p>
        </div>
        <button
          onClick={() => router.push('/invoices/new')}
          style={{
            padding: '9px 16px', background: '#2563eb', color: 'white',
            border: 'none', borderRadius: '8px', fontSize: '13px',
            fontWeight: '600', cursor: 'pointer',
          }}
        >
          + New Invoice
        </button>
      </div>

      {/* Search + filters */}
      <div style={{ marginBottom: '1rem' }}>
        <input
          style={{
            width: '100%', padding: '10px 12px',
            border: '1px solid #d1d5db', borderRadius: '8px',
            fontSize: '14px', outline: 'none', marginBottom: '8px',
          }}
          placeholder="Search by invoice number or customer..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '2px' }}>
          {[
            { key: 'all', label: 'All' },
            { key: 'unpaid', label: 'Unpaid' },
            { key: 'paid', label: 'Paid' },
            { key: 'draft', label: 'Draft' },
          ].map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)} style={{
              padding: '6px 14px', whiteSpace: 'nowrap',
              background: filter === f.key ? '#2563eb' : 'white',
              color: filter === f.key ? 'white' : '#374151',
              border: '1px solid #e2e8f0', borderRadius: '99px',
              fontSize: '12px', cursor: 'pointer', fontWeight: '500',
              flexShrink: 0,
            }}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Empty state */}
      {filtered.length === 0 ? (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', padding: '3rem', textAlign: 'center',
        }}>
          <div style={{ fontSize: '40px', marginBottom: '1rem' }}>🧾</div>
          <div style={{ fontSize: '15px', fontWeight: '500', color: '#64748b', marginBottom: '8px' }}>
            No invoices found
          </div>
          <button
            onClick={() => router.push('/invoices/new')}
            style={{
              padding: '10px 20px', background: '#2563eb', color: 'white',
              border: 'none', borderRadius: '8px', fontSize: '13px',
              fontWeight: '600', cursor: 'pointer',
            }}
          >
            Create Invoice
          </button>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="desktop-table" style={{
            background: 'white', border: '1px solid #e2e8f0',
            borderRadius: '12px', overflow: 'hidden',
          }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr 1fr',
              gap: '12px', padding: '10px 16px', background: '#f8fafc',
              fontSize: '12px', fontWeight: '600', color: '#64748b',
              borderBottom: '1px solid #e2e8f0',
            }}>
              <span>Invoice No.</span><span>Customer</span>
              <span>Date</span><span>Amount</span>
              <span>Status</span><span>Payment</span>
            </div>
            {filtered.map(inv => (
              <div key={inv.id} onClick={() => router.push(`/invoices/${inv.id}`)} style={{
                display: 'grid',
                gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr 1fr',
                gap: '12px', padding: '12px 16px',
                borderBottom: '1px solid #f1f5f9',
                alignItems: 'center', fontSize: '13px', cursor: 'pointer',
              }}>
                <div style={{ fontWeight: '600', color: '#2563eb' }}>{inv.invoice_number}</div>
                <div style={{ color: '#1e293b' }}>{inv.customer_name}</div>
                <div style={{ color: '#64748b' }}>{new Date(inv.invoice_date).toLocaleDateString('en-IN')}</div>
                <div style={{ fontWeight: '500' }}>₹{formatINR(inv.grand_total)}</div>
                <span style={{
                  fontSize: '11px', padding: '2px 8px', borderRadius: '99px',
                  background: inv.status === 'draft' ? '#f1f5f9' : inv.status === 'sent' ? '#eff6ff' : '#fef2f2',
                  color: inv.status === 'draft' ? '#64748b' : inv.status === 'sent' ? '#1d4ed8' : '#dc2626',
                  textTransform: 'capitalize',
                }}>{inv.status}</span>
                <span style={{
                  fontSize: '11px', padding: '2px 8px', borderRadius: '99px',
                  background: inv.payment_status === 'paid' ? '#f0fdf4' : inv.payment_status === 'partial' ? '#fef9c3' : '#fef2f2',
                  color: inv.payment_status === 'paid' ? '#166534' : inv.payment_status === 'partial' ? '#854d0e' : '#dc2626',
                }}>{inv.payment_status}</span>
              </div>
            ))}
          </div>

          {/* Mobile cards */}
          <div className="mobile-cards">
            {filtered.map(inv => (
              <div key={inv.id} onClick={() => router.push(`/invoices/${inv.id}`)} style={{
                background: 'white', border: '1px solid #e2e8f0',
                borderRadius: '12px', padding: '1rem',
                marginBottom: '8px', cursor: 'pointer',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontWeight: '700', color: '#2563eb', fontSize: '14px' }}>
                    {inv.invoice_number}
                  </span>
                  <span style={{ fontWeight: '700', fontSize: '14px', color: '#1e293b' }}>
                    ₹{formatINR(inv.grand_total)}
                  </span>
                </div>
                <div style={{ fontSize: '13px', color: '#374151', marginBottom: '8px' }}>
                  {inv.customer_name}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', color: '#64748b' }}>
                    {new Date(inv.invoice_date).toLocaleDateString('en-IN')}
                  </span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <span style={{
                      fontSize: '11px', padding: '2px 8px', borderRadius: '99px',
                      background: inv.status === 'draft' ? '#f1f5f9' : '#eff6ff',
                      color: inv.status === 'draft' ? '#64748b' : '#1d4ed8',
                    }}>{inv.status}</span>
                    <span style={{
                      fontSize: '11px', padding: '2px 8px', borderRadius: '99px',
                      background: inv.payment_status === 'paid' ? '#f0fdf4' : inv.payment_status === 'partial' ? '#fef9c3' : '#fef2f2',
                      color: inv.payment_status === 'paid' ? '#166534' : inv.payment_status === 'partial' ? '#854d0e' : '#dc2626',
                    }}>{inv.payment_status}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <style>{`
        @media (max-width: 768px) {
          .desktop-table { display: none !important; }
          .mobile-cards { display: block !important; }
        }
        @media (min-width: 769px) {
          .mobile-cards { display: none !important; }
        }
      `}</style>
    </div>
  )
}