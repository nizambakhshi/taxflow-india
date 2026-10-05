'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { pendingOutboxCount } from '@/lib/outbox'
import Link from 'next/link'

const NAV_ITEMS = [
  {
    section: 'Main',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: '📊' },
      { label: 'Offline Sync', href: '/offline', icon: '📶' },
    ]
  },
  {
    section: 'Sales',
    items: [
      { label: 'Invoices', href: '/invoices', icon: '🧾' },
      { label: 'Quotations', href: '/quotations', icon: '📋' },
      { label: 'Credit Notes', href: '/credit-notes', icon: '📝' },
      { label: 'Debit Notes', href: '/debit-notes', icon: '📄' },
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
    section: 'Payments',
    items: [
      { label: 'Receivables & Payables', href: '/payments', icon: '💳' },
      { label: 'Payment Links', href: '/payments/links', icon: '🔗' },
    ]
  },
  {
    section: 'Masters',
    items: [
      { label: 'Customers', href: '/customers', icon: '👥' },
      { label: 'Vendors', href: '/vendors', icon: '🏭' },
      { label: 'Products', href: '/products', icon: '📦' },
      { label: 'Inventory', href: '/inventory', icon: '🏪' },
    ]
  },
  {
    section: 'GST',
    items: [
      { label: 'GST Dashboard', href: '/gst', icon: '🏛️' },
      { label: 'GSTR-1', href: '/gst/gstr1', icon: '📤' },
      { label: 'GSTR-3B', href: '/gst/gstr3b', icon: '📑' },
      { label: '2B Reconciliation', href: '/gst/reconciliation', icon: '🔍' },
      { label: 'E-Invoicing', href: '/gst/einvoice', icon: '⚡' },
    ]
  },
  {
    section: 'Reports',
    items: [
      { label: 'Reports', href: '/reports', icon: '📈' },
      { label: 'Financial Statements', href: '/accounting', icon: '⚖️' },
    ]
  },
  {
    section: 'Account',
    items: [
      { label: 'Settings', href: '/settings', icon: '⚙️' },
    ]
  },
]

// Bottom nav items for mobile (most important only)
const BOTTOM_NAV = [
  { label: 'Home', href: '/dashboard', icon: '📊' },
  { label: 'Invoices', href: '/invoices', icon: '🧾' },
  { label: 'Bills', href: '/bills', icon: '🛒' },
  { label: 'GST', href: '/gst', icon: '🏛️' },
  { label: 'Menu', href: '#menu', icon: '☰' },
]

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const supabase = createClient()

  const [orgName, setOrgName] = useState('')
  const [orgId, setOrgId] = useState('')
  const [gstin, setGstin] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [loading, setLoading] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)

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
      setOrgId(membership.organization_id)
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

  // Close menu when navigating
  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: '#f8fafc'
      }}>
        <p style={{ color: '#64748b', fontSize: '14px' }}>Loading...</p>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc' }}>

      {/* ── DESKTOP SIDEBAR ── */}
      <div style={{
        width: '220px',
        background: 'white',
        borderRight: '1px solid #e2e8f0',
        display: 'flex',
        flexDirection: 'column',
        position: 'fixed',
        top: 0, left: 0,
        height: '100vh',
        overflowY: 'auto',
        zIndex: 20,
      }} className="desktop-sidebar">
        {/* Logo */}
        <div style={{ padding: '1.25rem 1rem', borderBottom: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '16px', fontWeight: '700', color: '#2563eb' }}>
            TaxFlow India
          </div>
          <div style={{
            fontSize: '11px', color: '#64748b', marginTop: '2px',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          }}>
            {orgName}
          </div>
          {gstin && (
            <div style={{
              fontSize: '10px', color: '#94a3b8',
              fontFamily: 'monospace', marginTop: '1px'
            }}>
              {gstin}
            </div>
          )}
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '0.75rem 0' }}>
          {NAV_ITEMS.map(section => (
            <div key={section.section} style={{ marginBottom: '0.5rem' }}>
              <div style={{
                fontSize: '10px', fontWeight: '600', color: '#94a3b8',
                padding: '6px 1rem 4px',
                textTransform: 'uppercase', letterSpacing: '0.05em'
              }}>
                {section.section}
              </div>
              {section.items.map(item => {
                const isActive = pathname === item.href
                return (
                  <Link key={item.href} href={item.href} style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '7px 1rem', fontSize: '13px',
                    color: isActive ? '#2563eb' : '#374151',
                    background: isActive ? '#eff6ff' : 'transparent',
                    fontWeight: isActive ? '600' : '400',
                    textDecoration: 'none',
                    borderRight: isActive ? '2px solid #2563eb' : '2px solid transparent',
                  }}>
                    <span>{item.icon}</span>
                    <span>{item.label}</span>
                  </Link>
                )
              })}
            </div>
          ))}
        </nav>

        {/* Bottom user */}
        <div style={{ padding: '1rem', borderTop: '1px solid #e2e8f0' }}>
          <div style={{
            fontSize: '12px', color: '#64748b', marginBottom: '8px',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          }}>
            {userEmail}
          </div>
          <button onClick={handleLogout} style={{
            width: '100%', padding: '7px',
            background: '#f1f5f9', border: '1px solid #e2e8f0',
            borderRadius: '8px', fontSize: '12px',
            cursor: 'pointer', color: '#374151'
          }}>
            Sign out
          </button>
        </div>
      </div>

      {/* ── MOBILE TOP BAR ── */}
      <div className="mobile-topbar" style={{
        display: 'none',
        position: 'fixed', top: 0, left: 0, right: 0,
        height: '56px', background: 'white',
        borderBottom: '1px solid #e2e8f0',
        zIndex: 30, alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 1rem',
      }}>
        <div>
          <div style={{ fontSize: '15px', fontWeight: '700', color: '#2563eb' }}>
            TaxFlow India
          </div>
          <div style={{ fontSize: '10px', color: '#64748b' }}>{orgName}</div>
        </div>
        <Link href="/invoices/new" style={{
          padding: '7px 14px', background: '#2563eb',
          color: 'white', borderRadius: '8px',
          fontSize: '13px', fontWeight: '600',
          textDecoration: 'none'
        }}>
          + Invoice
        </Link>
      </div>

      {/* ── MOBILE FULL MENU OVERLAY ── */}
      {menuOpen && (
        <div style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.5)',
          zIndex: 40,
        }} onClick={() => setMenuOpen(false)}>
          <div style={{
            position: 'absolute', bottom: '60px', left: 0, right: 0,
            background: 'white',
            borderRadius: '16px 16px 0 0',
            maxHeight: '75vh', overflowY: 'auto',
            padding: '1rem 0',
          }} onClick={e => e.stopPropagation()}>
            {/* Handle bar */}
            <div style={{
              width: '40px', height: '4px', background: '#e2e8f0',
              borderRadius: '99px', margin: '0 auto 1rem',
            }} />

            {/* Org info */}
            <div style={{
              padding: '0 1rem 1rem',
              borderBottom: '1px solid #f1f5f9',
              marginBottom: '0.5rem'
            }}>
              <div style={{ fontWeight: '600', color: '#1e293b', fontSize: '14px' }}>{orgName}</div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>{userEmail}</div>
              {gstin && <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'monospace' }}>{gstin}</div>}
            </div>

            {/* All nav items */}
            {NAV_ITEMS.map(section => (
              <div key={section.section}>
                <div style={{
                  fontSize: '10px', fontWeight: '600', color: '#94a3b8',
                  padding: '8px 1rem 4px',
                  textTransform: 'uppercase', letterSpacing: '0.05em'
                }}>
                  {section.section}
                </div>
                {section.items.map(item => {
                  const isActive = pathname === item.href
                  return (
                    <Link key={item.href} href={item.href}
                      onClick={() => setMenuOpen(false)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '12px',
                        padding: '12px 1rem', fontSize: '14px',
                        color: isActive ? '#2563eb' : '#374151',
                        background: isActive ? '#eff6ff' : 'transparent',
                        fontWeight: isActive ? '600' : '400',
                        textDecoration: 'none',
                      }}>
                      <span style={{ fontSize: '18px' }}>{item.icon}</span>
                      <span>{item.label}</span>
                      {isActive && (
                        <span style={{ marginLeft: 'auto', color: '#2563eb', fontSize: '12px' }}>●</span>
                      )}
                    </Link>
                  )
                })}
              </div>
            ))}

            {/* Sign out */}
            <div style={{ padding: '1rem', borderTop: '1px solid #f1f5f9', marginTop: '0.5rem' }}>
              <button onClick={handleLogout} style={{
                width: '100%', padding: '12px',
                background: '#fef2f2', border: '1px solid #fecaca',
                borderRadius: '8px', fontSize: '14px',
                cursor: 'pointer', color: '#dc2626', fontWeight: '500'
              }}>
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MOBILE BOTTOM NAVIGATION ── */}
      <div className="mobile-bottom-nav" style={{
        display: 'none',
        position: 'fixed', bottom: 0, left: 0, right: 0,
        height: '60px', background: 'white',
        borderTop: '1px solid #e2e8f0',
        zIndex: 30,
        alignItems: 'center',
        justifyContent: 'space-around',
        padding: '0 4px',
      }}>
        {BOTTOM_NAV.map(item => {
          const isActive = pathname === item.href
          const isMenu = item.href === '#menu'
          return (
            <button
              key={item.href}
              onClick={() => {
                if (isMenu) {
                  setMenuOpen(prev => !prev)
                } else {
                  router.push(item.href)
                }
              }}
              style={{
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                gap: '2px', padding: '6px 12px',
                background: 'none', border: 'none',
                cursor: 'pointer', flex: 1,
                borderTop: isActive || (isMenu && menuOpen)
                  ? '2px solid #2563eb' : '2px solid transparent',
              }}
            >
              <span style={{ fontSize: '20px' }}>{item.icon}</span>
              <span style={{
                fontSize: '10px', fontWeight: '500',
                color: isActive || (isMenu && menuOpen) ? '#2563eb' : '#64748b'
              }}>
                {item.label}
              </span>
            </button>
          )
        })}
      </div>

      {/* ── MAIN CONTENT ── */}
      <div className="main-content" style={{
        marginLeft: '220px',
        minHeight: '100vh',
      }}>
        <OfflineBanner orgId={orgId} pathname={pathname} />
        {children}
      </div>

      {/* ── GLOBAL RESPONSIVE STYLES ── */}
      <style>{`
        /* Mobile breakpoint: screens under 768px */
        @media (max-width: 768px) {
          .desktop-sidebar { display: none !important; }
          .mobile-topbar { display: flex !important; }
          .mobile-bottom-nav { display: flex !important; }
          .offline-banner { top: 56px !important; }
          .main-content {
            margin-left: 0 !important;
            padding-top: 56px !important;
            padding-bottom: 70px !important;
          }
        }

        /* Tablet: 768px - 1024px */
        @media (min-width: 769px) and (max-width: 1024px) {
          .desktop-sidebar { width: 180px !important; }
          .main-content { margin-left: 180px !important; }
        }
      `}</style>
    </div>
  )
}

function OfflineBanner({ orgId, pathname }: { orgId: string; pathname: string }) {
  const [online, setOnline] = useState(true)
  const [queued, setQueued] = useState(0)

  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    setOnline(navigator.onLine)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  useEffect(() => {
    if (orgId) setQueued(pendingOutboxCount(orgId))
  }, [orgId, pathname, online])

  if (online || pathname === '/offline') return null

  return (
    <div className="offline-banner" style={{
      position: 'sticky', top: 0, zIndex: 25,
      background: '#fef3c7', borderBottom: '1px solid #fde68a',
      padding: '8px 1rem',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: '12px', flexWrap: 'wrap',
      fontSize: '13px', color: '#92400e', fontWeight: '500'
    }}>
      <span>📶 You&apos;re offline — invoicing still works. New invoices are queued.</span>
      {queued > 0 && (
        <Link href="/offline" style={{
          color: '#2563eb', fontWeight: '600', textDecoration: 'none',
          background: 'white', padding: '3px 10px', borderRadius: '6px',
          border: '1px solid #bfdbfe', fontSize: '12px'
        }}>
          {queued} pending sync — view
        </Link>
      )}
    </div>
  )
}
