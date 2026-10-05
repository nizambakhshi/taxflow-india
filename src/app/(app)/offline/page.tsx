'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import {
  listOutbox,
  removeOutboxEntry,
  syncOutbox,
  type OutboxEntry,
  type SyncOutcome,
} from '@/lib/outbox'

function OfflinePageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [loading, setLoading] = useState(true)
  const [entries, setEntries] = useState<OutboxEntry[]>([])
  const [online, setOnline] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null)
  const [justQueued, setJustQueued] = useState(false)

  useEffect(() => {
    async function init() {
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
      setEntries(listOutbox(membership.organization_id))
      setLoading(false)
    }
    init()
  }, [])

  useEffect(() => {
    if (searchParams.get('queued') === '1') setJustQueued(true)
  }, [searchParams])

  const refreshEntries = useCallback((oid: string) => {
    setEntries(listOutbox(oid))
  }, [])

  useEffect(() => {
    const goOnline = () => {
      setOnline(true)
      if (orgId) runSync()
    }
    const goOffline = () => setOnline(false)
    setOnline(navigator.onLine)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId])

  async function runSync() {
    if (!orgId || syncing) return
    setSyncing(true)
    setOutcome(null)
    const result = await syncOutbox(supabase, orgId)
    setOutcome(result)
    refreshEntries(orgId)
    setSyncing(false)
  }

  function discard(entry: OutboxEntry) {
    if (!orgId) return
    removeOutboxEntry(orgId, entry.id)
    refreshEntries(orgId)
  }

  if (loading) {
    return <div className="page-container"><p style={{ color: '#64748b', fontSize: '13px' }}>Loading…</p></div>
  }

  return (
    <div className="page-container" style={{ maxWidth: '900px' }}>
      <div className="page-header" style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '20px', fontWeight: '600', color: '#1e293b' }}>Offline Sync</h1>
        <p style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>
          Invoices created without an internet connection are stored on this device and synced here once you're back online.
        </p>
      </div>

      {/* Connectivity + queue status */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: '12px', flexWrap: 'wrap',
        padding: '14px 16px', borderRadius: '10px',
        background: online ? '#f0fdf4' : '#fef2f2',
        border: `1px solid ${online ? '#bbf7d0' : '#fecaca'}`,
        marginBottom: '1.25rem'
      }}>
        <div style={{ fontSize: '13px', fontWeight: '500', color: online ? '#166534' : '#991b1b' }}>
          {online ? '● Online' : '● Offline'} — {entries.length} invoice{entries.length === 1 ? '' : 's'} in queue
        </div>
        <button
          onClick={runSync}
          disabled={!online || syncing || entries.length === 0}
          style={{
            padding: '8px 18px', background: '#2563eb', color: 'white',
            border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: '500',
            cursor: !online || syncing || entries.length === 0 ? 'not-allowed' : 'pointer',
            opacity: !online || syncing || entries.length === 0 ? 0.5 : 1
          }}
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {justQueued && (
        <div style={{
          padding: '12px 16px', borderRadius: '8px', background: '#eff6ff',
          border: '1px solid #bfdbfe', fontSize: '13px', color: '#1e40af', marginBottom: '1rem'
        }}>
          Invoice saved to this device. It will sync when you're online.
        </div>
      )}

      {outcome && (
        <div style={{
          padding: '12px 16px', borderRadius: '8px', fontSize: '13px', marginBottom: '1rem',
          background: outcome.synced.length > 0 ? '#f0fdf4' : '#fefce8',
          border: `1px solid ${outcome.synced.length > 0 ? '#bbf7d0' : '#fde68a'}`,
          color: outcome.synced.length > 0 ? '#166534' : '#854d0e'
        }}>
          {outcome.synced.length > 0 && (
            <div>
              Synced {outcome.synced.length} invoice{outcome.synced.length === 1 ? '' : 's'}:
              {' '}
              {outcome.synced.map(s => s.invoiceNumber).join(', ')}
            </div>
          )}
          {outcome.failed.length > 0 && (
            <div style={{ marginTop: outcome.synced.length > 0 ? '6px' : 0, color: '#991b1b' }}>
              {outcome.failed.length} could not be synced — see the error on the invoice below.
            </div>
          )}
          {outcome.stoppedEarly && outcome.synced.length === 0 && outcome.failed.length === 0 && (
            <div>Connection dropped — remaining invoices stay queued.</div>
          )}
        </div>
      )}

      {entries.length === 0 ? (
        <div style={{
          padding: '2.5rem 1rem', textAlign: 'center', background: 'white',
          border: '1px solid #e2e8f0', borderRadius: '10px'
        }}>
          <div style={{ fontSize: '28px', marginBottom: '8px' }}>✓</div>
          <div style={{ fontSize: '14px', fontWeight: '500', color: '#374151' }}>Nothing to sync</div>
          <div style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>
            Invoices saved while offline will appear here.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {entries.map(entry => {
            const inv = entry.invoice as Record<string, any>
            const itemCount = entry.items.length
            return (
              <div key={entry.id} style={{
                padding: '14px 16px', background: 'white',
                border: `1px solid ${entry.status === 'error' ? '#fecaca' : '#e2e8f0'}`,
                borderRadius: '10px'
              }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                  gap: '12px', flexWrap: 'wrap'
                }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                      <span style={{ fontSize: '14px', fontWeight: '600', color: '#1e293b' }}>
                        {entry.tempNumber}
                      </span>
                      <span style={{
                        fontSize: '11px', fontWeight: '500', padding: '2px 8px', borderRadius: '999px',
                        background: entry.status === 'error' ? '#fef2f2' : '#fff7ed',
                        color: entry.status === 'error' ? '#991b1b' : '#9a3412'
                      }}>
                        {entry.status === 'error' ? 'Failed' : 'Pending'}
                      </span>
                    </div>
                    <div style={{ fontSize: '13px', color: '#475569' }}>
                      {inv.customer_name} — {itemCount} item{itemCount === 1 ? '' : 's'} — {formatINR(Number(inv.grand_total) || 0)}
                    </div>
                    <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>
                      Invoice date {inv.invoice_date} · Queued {new Date(entry.createdAt).toLocaleString('en-IN')}
                    </div>
                    {entry.status === 'error' && entry.error && (
                      <div style={{ fontSize: '12px', color: '#991b1b', marginTop: '6px' }}>
                        {entry.error}
                      </div>
                    )}
                  </div>
                  <div className="btn-group" style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => discard(entry)}
                      style={{
                        padding: '7px 14px', background: 'white', color: '#dc2626',
                        border: '1px solid #fecaca', borderRadius: '7px',
                        fontSize: '12px', fontWeight: '500', cursor: 'pointer'
                      }}
                    >
                      Discard
                    </button>
                    <button
                      onClick={() => router.push('/invoices')}
                      style={{
                        padding: '7px 14px', background: 'white', color: '#374151',
                        border: '1px solid #e2e8f0', borderRadius: '7px',
                        fontSize: '12px', fontWeight: '500', cursor: 'pointer'
                      }}
                    >
                      View invoices
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function OfflinePage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: '#64748b', fontSize: '13px' }}>Loading…</p></div>}>
      <OfflinePageInner />
    </Suspense>
  )
}
