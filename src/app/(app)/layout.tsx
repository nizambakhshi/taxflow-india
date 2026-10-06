'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { pendingOutboxCount } from '@/lib/outbox'
import { initials } from '@/lib/format'
import Icon from '@/components/Icons'
import Link from 'next/link'

const NAV_ITEMS = [
  {
    section: 'Overview',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: 'dashboard' },
      { label: 'Offline Sync', href: '/offline', icon: 'cloud' },
    ]
  },
  {
    section: 'Sales',
    items: [
      { label: 'Invoices', href: '/invoices', icon: 'invoice' },
      { label: 'Counter Sale', href: '/pos', icon: 'pos' },
      { label: 'Quotations', href: '/quotations', icon: 'clipboard' },
      { label: 'Credit Notes', href: '/credit-notes', icon: 'credit-note' },
      { label: 'Debit Notes', href: '/debit-notes', icon: 'debit-note' },
    ]
  },
  {
    section: 'Purchases',
    items: [
      { label: 'Bills', href: '/bills', icon: 'cart' },
      { label: 'Expenses', href: '/expenses', icon: 'wallet' },
    ]
  },
  {
    section: 'Payments',
    items: [
      { label: 'Receivables & Payables', href: '/payments', icon: 'swap' },
      { label: 'Payment Links', href: '/payments/links', icon: 'link' },
    ]
  },
  {
    section: 'Masters',
    items: [
      { label: 'Customers', href: '/customers', icon: 'users' },
      { label: 'Vendors', href: '/vendors', icon: 'factory' },
      { label: 'Products', href: '/products', icon: 'box' },
      { label: 'Inventory', href: '/inventory', icon: 'store' },
      { label: 'Reorder Planner', href: '/inventory/reorder', icon: 'cart' },
    ]
  },
  {
    section: 'GST',
    items: [
      { label: 'GST Dashboard', href: '/gst', icon: 'landmark' },
      { label: 'GSTR-1', href: '/gst/gstr1', icon: 'upload' },
      { label: 'GSTR-3B', href: '/gst/gstr3b', icon: 'file-check' },
      { label: '2B Reconciliation', href: '/gst/reconciliation', icon: 'compare' },
      { label: 'E-Invoicing', href: '/gst/einvoice', icon: 'zap' },
      { label: 'GSTR-9 / 9C', href: '/gst/gstr9', icon: 'clipboard' },
      { label: 'Compliance Calendar', href: '/gst/calendar', icon: 'calendar' },
    ]
  },
  {
    section: 'Reports & AI',
    items: [
      { label: 'Reports', href: '/reports', icon: 'chart' },
      { label: 'Targets & Achievement', href: '/reports/targets', icon: 'target' },
      { label: 'Statutory Registers', href: '/reports/registers', icon: 'clipboard' },
      { label: 'Account Ledger', href: '/ledger', icon: 'book' },
      { label: 'Financial Statements', href: '/accounting', icon: 'scale' },
      { label: 'Scan Bill', href: '/ai/scan-bill', icon: 'scan' },
      { label: 'Ask My Books', href: '/ai/ask', icon: 'chat' },
    ]
  },
  {
    section: 'Account',
    items: [
      { label: 'Settings', href: '/settings', icon: 'settings' },
    ]
  },
]

// Bottom nav items for mobile (most important only)
const BOTTOM_NAV = [
  { label: 'Home', href: '/dashboard', icon: 'dashboard' },
  { label: 'Invoices', href: '/invoices', icon: 'invoice' },
  { label: 'Bills', href: '/bills', icon: 'cart' },
  { label: 'GST', href: '/gst', icon: 'landmark' },
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
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 14,
        background: 'var(--bg)'
      }}>
        <BrandMark size={44} />
        <div style={{
          width: 120, height: 3, borderRadius: 99, background: 'var(--line)',
          overflow: 'hidden', position: 'relative'
        }}>
          <div style={{
            position: 'absolute', inset: 0, width: '40%', borderRadius: 99,
            background: 'var(--brand)', animation: 'tf-sweep 1.1s ease-in-out infinite'
          }} />
        </div>
        <style>{`@keyframes tf-sweep{0%{transform:translateX(-110%)}100%{transform:translateX(280%)}}`}</style>
      </div>
    )
  }

  const isActive = (href: string) =>
    pathname === href || (href !== '/dashboard' && pathname.startsWith(href + '/'))

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>

      {/* ── DESKTOP SIDEBAR ── */}
      <aside className="desktop-sidebar">
        <div style={{ padding: '1.1rem 1rem', borderBottom: '1px solid var(--line-soft)' }}>
          <Link href="/dashboard" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
            <BrandMark />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '15px', fontWeight: 750, color: 'var(--ink)', letterSpacing: '-0.02em' }}>
                TaxFlow <span style={{ color: 'var(--brand)' }}>India</span>
              </div>
              <div className="side-org" style={{
                fontSize: '11px', color: 'var(--muted)', marginTop: '1px',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }}>
                {orgName}
              </div>
            </div>
          </Link>
          {gstin && (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: '10px',
              fontSize: '10px', color: 'var(--brand-dark)', background: 'var(--brand-soft)',
              padding: '3px 8px', borderRadius: '99px', fontFamily: 'ui-monospace, monospace',
              fontWeight: 600, letterSpacing: '0.02em'
            }}>
              <span style={{ width: 5, height: 5, borderRadius: 99, background: 'var(--green)' }} />
              {gstin}
            </div>
          )}
        </div>

        <div style={{ padding: '0.85rem 0.75rem 0.35rem' }}>
          <Link href="/invoices/new" className="tf-btn tf-btn-primary" style={{ width: '100%', fontSize: '12.5px', padding: '8px 12px' }}>
            <Icon name="plus" size={15} strokeWidth={2.4} />
            New invoice
          </Link>
        </div>

        <nav style={{ flex: 1, padding: '0.25rem 0.6rem 1rem', overflowY: 'auto' }}>
          {NAV_ITEMS.map(section => (
            <div key={section.section} style={{ marginBottom: '0.85rem' }}>
              <div className="side-section" style={{
                fontSize: '9.5px', fontWeight: 700, color: 'var(--faint)',
                padding: '4px 0.6rem 4px', textTransform: 'uppercase', letterSpacing: '0.09em'
              }}>
                {section.section}
              </div>
              {section.items.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`side-link ${isActive(item.href) ? 'is-active' : ''}`}
                >
                  <span className="side-indicator" />
                  <Icon name={item.icon} size={16} strokeWidth={isActive(item.href) ? 2 : 1.7} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.label}
                  </span>
                </Link>
              ))}
            </div>
          ))}
        </nav>

        <div style={{ padding: '.85rem', borderTop: '1px solid var(--line-soft)' }}>
          <div className="tf-row" style={{ gap: 9 }}>
            <span style={{
              width: 30, height: 30, borderRadius: 9, flexShrink: 0,
              background: 'linear-gradient(135deg,#2563eb,#7c3aed)', color: 'white',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '11px', fontWeight: 700
            }}>
              {initials(orgName || userEmail || 'T')}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: '12px', color: 'var(--ink-2)', fontWeight: 600,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }}>
                {orgName || 'My business'}
              </div>
              <div style={{
                fontSize: '10.5px', color: 'var(--faint)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }}>
                {userEmail}
              </div>
            </div>
            <button
              onClick={handleLogout}
              title="Sign out"
              className="side-link"
              style={{ padding: 6, width: 30, height: 30, justifyContent: 'center' }}
            >
              <Icon name="logout" size={15} />
            </button>
          </div>
        </div>
      </aside>

      {/* ── MOBILE TOP BAR ── */}
      <div className="mobile-topbar">
        <div className="tf-row" style={{ gap: 9, minWidth: 0 }}>
          <BrandMark size={30} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '14px', fontWeight: 750, color: 'var(--ink)', letterSpacing: '-0.02em' }}>
              TaxFlow <span style={{ color: 'var(--brand)' }}>India</span>
            </div>
            <div style={{
              fontSize: '10px', color: 'var(--muted)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}>{orgName}</div>
          </div>
        </div>
        <div className="tf-row" style={{ gap: 8 }}>
          <Link href="/invoices/new" className="tf-btn tf-btn-primary tf-btn-sm" style={{ minHeight: 34 }}>
            <Icon name="plus" size={14} strokeWidth={2.4} /> Invoice
          </Link>
          <button
            className="tf-btn tf-btn-ghost tf-btn-sm"
            style={{ minHeight: 34, padding: '6px 9px' }}
            onClick={() => setMenuOpen(prev => !prev)}
            aria-label="Menu"
          >
            <Icon name={menuOpen ? 'x' : 'menu'} size={17} />
          </button>
        </div>
      </div>

      {/* ── MOBILE FULL MENU OVERLAY ── */}
      {menuOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 40 }}
          onClick={() => setMenuOpen(false)}>
          <div className="sheet" onClick={e => e.stopPropagation()}>
            <div style={{
              width: '40px', height: '4px', background: 'var(--line)',
              borderRadius: '99px', margin: '0 auto 1rem',
            }} />

            <div style={{
              padding: '0 1rem 1rem', borderBottom: '1px solid var(--line-soft)', marginBottom: '0.5rem'
            }}>
              <div style={{ fontWeight: 700, color: 'var(--ink)', fontSize: '14px' }}>{orgName}</div>
              <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{userEmail}</div>
              {gstin && <div style={{ fontSize: '11px', color: 'var(--faint)', fontFamily: 'monospace', marginTop: 2 }}>{gstin}</div>}
            </div>

            {NAV_ITEMS.map(section => (
              <div key={section.section}>
                <div style={{
                  fontSize: '10px', fontWeight: 700, color: 'var(--faint)',
                  padding: '10px 1rem 4px', textTransform: 'uppercase', letterSpacing: '0.09em'
                }}>
                  {section.section}
                </div>
                {section.items.map(item => (
                  <Link key={item.href} href={item.href}
                    onClick={() => setMenuOpen(false)}
                    className={`sheet-link ${isActive(item.href) ? 'is-active' : ''}`}>
                    <Icon name={item.icon} size={18} />
                    <span>{item.label}</span>
                    {isActive(item.href) && <span style={{ marginLeft: 'auto', fontSize: '11px' }}>●</span>}
                  </Link>
                ))}
              </div>
            ))}

            <div style={{ padding: '1rem', borderTop: '1px solid var(--line-soft)', marginTop: '0.5rem' }}>
              <button onClick={handleLogout} className="tf-btn tf-btn-danger" style={{ width: '100%' }}>
                <Icon name="logout" size={15} /> Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MOBILE BOTTOM NAVIGATION ── */}
      <div className="mobile-bottom-nav">
        {BOTTOM_NAV.map(item => {
          const active = isActive(item.href)
          return (
            <button key={item.href} onClick={() => router.push(item.href)} className={`bottom-item ${active ? 'is-active' : ''}`}>
              <Icon name={item.icon} size={20} strokeWidth={active ? 2.2 : 1.7} />
              <span>{item.label}</span>
            </button>
          )
        })}
        <button
          onClick={() => setMenuOpen(prev => !prev)}
          className={`bottom-item ${menuOpen ? 'is-active' : ''}`}
        >
          <Icon name={menuOpen ? 'x' : 'menu'} size={20} strokeWidth={2} />
          <span>Menu</span>
        </button>
      </div>

      {/* ── MAIN CONTENT ── */}
      <div className="main-content">
        <OfflineBanner orgId={orgId} pathname={pathname} />
        {children}
      </div>

      {/* ── SHELL STYLES ── */}
      <style>{`
        .desktop-sidebar {
          width: var(--sidebar-w);
          background: var(--surface);
          border-right: 1px solid var(--line);
          display: flex;
          flex-direction: column;
          position: fixed;
          top: 0; left: 0;
          height: 100vh;
          overflow: hidden;
          z-index: 20;
        }
        .side-link {
          position: relative;
          display: flex; align-items: center; gap: 9px;
          padding: 7px 12px; margin: 1px 0;
          font-size: 12.5px; font-weight: 500;
          color: var(--ink-2);
          background: transparent;
          border: none; border-radius: 9px;
          text-decoration: none; cursor: pointer;
          font-family: inherit;
          transition: background .14s ease, color .14s ease;
        }
        .side-link:hover { background: var(--surface-2); color: var(--ink); }
        .side-link.is-active { background: var(--brand-soft); color: var(--brand-dark); font-weight: 650; }
        .side-indicator {
          position: absolute; left: 3px; top: 50%; transform: translateY(-50%);
          width: 3px; height: 0; border-radius: 99px; background: var(--brand);
          transition: height .18s ease;
        }
        .side-link.is-active .side-indicator { height: 18px; }

        .mobile-topbar {
          display: none;
          position: fixed; top: 0; left: 0; right: 0;
          height: 56px; background: rgba(255,255,255,.92);
          backdrop-filter: saturate(180%) blur(10px);
          border-bottom: 1px solid var(--line);
          z-index: 30; align-items: center;
          justify-content: space-between; padding: 0 1rem; gap: 8px;
        }
        .mobile-bottom-nav {
          display: none;
          position: fixed; bottom: 0; left: 0; right: 0;
          height: 62px; background: rgba(255,255,255,.95);
          backdrop-filter: saturate(180%) blur(10px);
          border-top: 1px solid var(--line);
          z-index: 30; align-items: center;
          justify-content: space-around; padding: 0 4px;
        }
        .bottom-item {
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 3px; padding: 6px 10px; min-height: 0;
          background: none; border: none; border-top: 2px solid transparent;
          cursor: pointer; flex: 1; color: var(--faint); font-family: inherit;
        }
        .bottom-item span { font-size: 10px; font-weight: 600; }
        .bottom-item.is-active { color: var(--brand); border-top-color: var(--brand); }

        .main-content { margin-left: var(--sidebar-w); min-height: 100vh; }

        .sheet {
          position: absolute; bottom: 0; left: 0; right: 0;
          background: var(--surface);
          border-radius: 18px 18px 0 0;
          max-height: 78vh; overflow-y: auto;
          padding: 1rem 0 0.5rem;
          animation: tf-sheet .22s cubic-bezier(0.22,1,0.36,1) both;
        }
        @keyframes tf-sheet { from { transform: translateY(24px); opacity: .6 } to { transform: none; opacity: 1 } }
        .sheet-link {
          display: flex; align-items: center; gap: 12px;
          padding: 12px 1rem; font-size: 14px;
          color: var(--ink-2); text-decoration: none;
        }
        .sheet-link.is-active { color: var(--brand-dark); background: var(--brand-soft); font-weight: 600; }

        @media (max-width: 768px) {
          .desktop-sidebar { display: none; }
          .mobile-topbar { display: flex; }
          .mobile-bottom-nav { display: flex; }
          .offline-banner { top: 56px !important; }
          .main-content {
            margin-left: 0;
            padding-top: 56px;
            padding-bottom: 74px;
          }
        }
        @media (min-width: 769px) and (max-width: 1024px) {
          :root { --sidebar-w: 200px; }
          .side-org, .side-section { display: none; }
          .side-link { justify-content: center; padding: 9px 6px; }
          .side-link span:not(.side-indicator) { display: none; }
          .side-link .side-indicator { left: 2px; }
        }
      `}</style>
    </div>
  )
}

function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: size * 0.28, flexShrink: 0,
      background: 'linear-gradient(135deg, #2563eb 0%, #4f46e5 55%, #7c3aed 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'white', boxShadow: '0 6px 16px -6px rgba(37,99,235,.7)',
    }}>
      <Icon name="zap" size={size * 0.5} strokeWidth={2.2} />
    </span>
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
      background: 'var(--amber-soft)', borderBottom: '1px solid #fde68a',
      padding: '8px 1rem',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: '12px', flexWrap: 'wrap',
      fontSize: '13px', color: '#92400e', fontWeight: 500
    }}>
      <span>📶 You&apos;re offline — invoicing still works. New invoices are queued.</span>
      {queued > 0 && (
        <Link href="/offline" style={{
          color: 'var(--brand)', fontWeight: 600, textDecoration: 'none',
          background: 'white', padding: '3px 10px', borderRadius: '6px',
          border: '1px solid #bfdbfe', fontSize: '12px'
        }}>
          {queued} pending sync — view
        </Link>
      )}
    </div>
  )
}
