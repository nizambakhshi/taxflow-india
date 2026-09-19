'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'

export default function DashboardPage() {
  const router = useRouter()
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [orgName, setOrgName] = useState('')

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id, organizations(name)')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { router.push('/setup'); return }

      const org = membership.organizations as any
      setOrgName(org?.name || '')
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>
      Loading...
    </div>
  )

  return (
    <div style={{ padding: '2rem', maxWidth: '1100px' }}>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
          Dashboard
        </h1>
        <p style={{ fontSize: '14px', color: '#64748b' }}>
          {orgName} · FY 2026–27
        </p>
      </div>

      {/* Metric cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '1rem',
        marginBottom: '2rem'
      }}>
        {[
          { label: 'Total Sales', value: '₹0', sub: 'This month', color: '#2563eb' },
          { label: 'GST Collected', value: '₹0', sub: 'Output tax', color: '#7c3aed' },
          { label: 'ITC Available', value: '₹0', sub: 'Input tax credit', color: '#059669' },
          { label: 'Net GST Payable', value: '₹0', sub: 'After ITC', color: '#dc2626' },
          { label: 'Receivables', value: '₹0', sub: 'Outstanding', color: '#d97706' },
          { label: 'Payables', value: '₹0', sub: 'To vendors', color: '#0891b2' },
        ].map((card) => (
          <div key={card.label} style={{
            background: 'white',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            padding: '1.25rem',
            borderTop: `3px solid ${card.color}`
          }}>
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>
              {card.label}
            </div>
            <div style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b' }}>
              {card.value}
            </div>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
              {card.sub}
            </div>
          </div>
        ))}
      </div>

      {/* GST Return status */}
      <div style={{
        background: 'white',
        border: '1px solid #e2e8f0',
        borderRadius: '12px',
        padding: '1.5rem',
        marginBottom: '1rem'
      }}>
        <h2 style={{ fontSize: '15px', fontWeight: '600', marginBottom: '1rem', color: '#1e293b' }}>
          GST Return Status
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
          {[
            { name: 'GSTR-1', period: 'Aug 2026', due: '11 Sep 2026', status: 'Not Started' },
            { name: 'GSTR-3B', period: 'Aug 2026', due: '20 Sep 2026', status: 'Not Started' },
            { name: 'GSTR-1', period: 'Sep 2026', due: '11 Oct 2026', status: 'Upcoming' },
          ].map((ret) => (
            <div key={ret.name + ret.period} style={{
              border: '1px solid #e2e8f0',
              borderRadius: '8px',
              padding: '1rem'
            }}>
              <div style={{ fontWeight: '600', fontSize: '14px', marginBottom: '4px' }}>
                {ret.name}
              </div>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>
                {ret.period} · Due {ret.due}
              </div>
              <span style={{
                fontSize: '11px',
                padding: '3px 8px',
                borderRadius: '99px',
                background: ret.status === 'Upcoming' ? '#fef9c3' : '#fee2e2',
                color: ret.status === 'Upcoming' ? '#854d0e' : '#991b1b'
              }}>
                {ret.status}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={{
        background: '#eff6ff',
        border: '1px solid #bfdbfe',
        borderRadius: '12px',
        padding: '1rem 1.25rem',
        fontSize: '13px',
        color: '#1d4ed8'
      }}>
        🚀 <strong>Next up:</strong> Add your customers, vendors and products to start creating invoices.
      </div>
    </div>
  )
}