'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import Link from 'next/link'

const NAV_ITEMS = [
  {
    section: 'Main',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: '📊' },
    ]
  },
  {
    section: 'Sales',
    items: [
      { label: 'Invoices', href: '/invoices', icon: '🧾' },
      { label: 'Quotations', href: '/quotations', icon: '📋' },
      { label: 'Credit Notes', href: '/credit-notes', icon: '📝' },
    ]
  },
  {
    section: 'Purchases',
    items: [
      { label: 'Bills', href: '/bills', icon: '🛒' },
      { label: 'Expenses', href: '/expenses', icon: '💸' },
    ]
  },
  {
    section: 'Masters',
    items: [
      { label: 'Customers', href: '/customers', icon: '👥' },
      { label: 'Vendors', href: '/vendors', icon: '🏭' },
      { label: 'Products', href: '/products', icon: '📦' },
    ]
  },
  {
    section: 'GST',
    items: [
      { label: 'GST Dashboard', href: '/gst', icon: '🏛️' },
      { label: 'GSTR-1', href: '/gst/gstr1', icon: '📤' },
      { label: 'GSTR-3B', href: '/gst/gstr3b', icon: '📑' },
    ]
  },
  {
    section: 'Reports',
    items: [
      { label: 'Reports', href: '/reports', icon: '📈' },
    ]
  },
]

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const supabase = createClient()

  const [orgName, setOrgName] = useState('')
  const [gstin, setGstin] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadLayout() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      setUserEmail(user.email || '')

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id, organizations(name)')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { router.push('/setup'); return }

      const org = membership.organizations as any
      setOrgName(org?.name || '')

      const { data: gstReg } = await supabase
        .from('gst_registrations')
        .select('gstin')
        .eq('organization_id', membership.organization_id)
        .eq('is_primary', true)
        .single()

      if (gstReg) setGstin(gstReg.gstin)
      setLoading(false)
    }
    loadLayout()
  }, [])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f8fafc'
      }}>
        <p style={{ color: '#64748b', fontSize: '14px' }}>Loading...</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8fafc' }}>
      {/* Sidebar */}
      <div style={{
        width: '220px',
        background: 'white',
        borderRight: '1px solid #e2e8f0',
        display: 'flex',
        flexDirection: 'column',
        position: 'fixed',
        top: 0,
        left: 0,
        height: '100vh',
        overflowY: 'auto',
        zIndex: 20
      }}>
        {/* Logo */}
        <div style={{
          padding: '1.25rem 1rem',
          borderBottom: '1px solid #e2e8f0'
        }}>
          <div style={{
            fontSize: '16px',
            fontWeight: '700',
            color: '#2563eb'
          }}>
            TaxFlow India
          </div>
          <div style={{
            fontSize: '11px',
            color: '#64748b',
            marginTop: '2px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}>
            {orgName}
          </div>
          {gstin && (
            <div style={{
              fontSize: '10px',
              color: '#94a3b8',
              fontFamily: 'monospace',
              marginTop: '2px'
            }}>
              {gstin}
            </div>
          )}
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '0.75rem 0' }}>
          {NAV_ITEMS.map((section) => (
            <div key={section.section} style={{ marginBottom: '0.5rem' }}>
              <div style={{
                fontSize: '10px',
                fontWeight: '600',
                color: '#94a3b8',
                padding: '6px 1rem 4px',
                textTransform: 'uppercase',
                letterSpacing: '0.05em'
              }}>
                {section.section}
              </div>
              {section.items.map((item) => {
                const isActive = pathname === item.href
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '7px 1rem',
                      fontSize: '13px',
                      color: isActive ? '#2563eb' : '#374151',
                      background: isActive ? '#eff6ff' : 'transparent',
                      fontWeight: isActive ? '600' : '400',
                      textDecoration: 'none',
                      borderRight: isActive ? '2px solid #2563eb' : '2px solid transparent',
                      transition: 'all 0.1s'
                    }}
                  >
                    <span>{item.icon}</span>
                    <span>{item.label}</span>
                  </Link>
                )
              })}
            </div>
          ))}
        </nav>

        {/* Bottom user section */}
        <div style={{
          padding: '1rem',
          borderTop: '1px solid #e2e8f0'
        }}>
          <div style={{
            fontSize: '12px',
            color: '#64748b',
            marginBottom: '8px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}>
            {userEmail}
          </div>
          <button
            onClick={handleLogout}
            style={{
              width: '100%',
              padding: '7px',
              background: '#f1f5f9',
              border: '1px solid #e2e8f0',
              borderRadius: '8px',
              fontSize: '12px',
              cursor: 'pointer',
              color: '#374151'
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Main content area */}
      <div style={{ marginLeft: '220px', flex: 1, minHeight: '100vh' }}>
        {children}
      </div>
    </div>
  )
}