'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN } from '@/lib/format'
import { Badge, Button, EmptyState, PageHeader, StatCard } from '@/components/ui'
import Icon from '@/components/Icons'
import {
  listOutbox,
  removeOutboxEntry,
  syncOutbox,
  type OutboxEntry,
  type SyncOutcome,
} from '@/lib/outbox'

const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const money = (v: number) => inr0.format(Number(v) || 0)

const num = (v: unknown) => Number(v ?? 0) || 0

/** "07 Oct 26, 18:04" — the queue timestamp is read against the invoice date, so both use the same shape. */
function formatDateTimeIN(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return `${formatDateIN(d.toISOString())}, ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}`
}

function OfflinePageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [loading, setLoading] = useState(true)
  const [entries, setEntries] = useState<OutboxEntry[]>([])
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  const [syncing, setSyncing] = useState(false)
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null)

  // The invoice form returns here with ?queued=1; the banner is that flag, nothing more.
  const justQueued = searchParams.get('queued') === '1'

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
      setOnline(navigator.onLine)
      setLoading(false)
    }
    init()
  }, [])

  const refreshEntries = useCallback((oid: string) => {
    setEntries(listOutbox(oid))
  }, [])

  useEffect(() => {
    const goOnline = () => {
      setOnline(true)
      if (orgId) runSync()
    }
    const goOffline = () => setOnline(false)
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
    if (!confirm(`Discard ${entry.tempNumber}? It never reached the server, so this invoice will be gone from this device.`)) return
    removeOutboxEntry(orgId, entry.id)
    refreshEntries(orgId)
  }

  const summary = useMemo(() => {
    const value = entries.reduce((sum, e) => sum + num((e.invoice as Record<string, unknown>).grand_total), 0)
    const failed = entries.filter(e => e.status === 'error').length
    return { count: entries.length, value, failed }
  }, [entries])

  const canSync = online && !syncing && entries.length > 0

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the queue on this device…</div>
  }

  return (
    <div className="page-container of" style={{ maxWidth: 1100 }}>
      <PageHeader
        eyebrow="Counter"
        title="Offline Sync"
        subtitle="Invoices billed without a connection are written to this device, not to the server. They stay here — with their own temporary number — until a sync can push them through."
        actions={
          <Button size="sm" icon="cloud" onClick={runSync} disabled={!canSync}
            title={entries.length === 0 ? 'Nothing queued' : online ? 'Push the queue to the server' : 'No connection'}>
            {syncing ? 'Syncing…' : 'Sync now'}
          </Button>
        }
        right={<Badge tone={online ? 'green' : 'red'} dot>{online ? 'Online' : 'Offline'}</Badge>}
      />

      <div className="of-stats">
        <StatCard label="Queued here" value={String(summary.count)}
          sub={summary.count ? 'not on the server yet' : 'nothing waiting'}
          icon="box" tone={summary.count ? 'amber' : 'grey'} delay={0} />
        <StatCard label="Value waiting" value={money(summary.value)}
          sub={`${summary.count} invoice(s) to push`} icon="invoice" tone="blue" delay={40} />
        <StatCard label="Failed" value={String(summary.failed)}
          sub={summary.failed ? 'still queued, safe to retry' : 'nothing blocked'}
          icon="alert" tone={summary.failed ? 'red' : 'green'} delay={80} />
        <StatCard label="Connection" value={online ? 'Online' : 'Offline'}
          sub={online ? 'the queue syncs when you press Sync now' : 'billing keeps working, the queue keeps growing'}
          icon="cloud" tone={online ? 'green' : 'red'} delay={120} />
      </div>

      {justQueued && (
        <div className="of-alert of-alert-blue">
          <Icon name="check" size={14} />
          <span>Invoice saved to this device. It will sync when you press Sync now or when the connection returns.</span>
        </div>
      )}

      {outcome && (
        <div className={`of-alert ${outcome.synced.length > 0 ? 'of-alert-green' : outcome.failed.length > 0 ? 'of-alert-red' : 'of-alert-amber'}`}>
          <Icon name={outcome.synced.length > 0 ? 'check' : 'alert'} size={14} />
          <div>
            {outcome.synced.length > 0 && (
              <div>
                Synced {outcome.synced.length} invoice{outcome.synced.length === 1 ? '' : 's'}: {' '}
                {outcome.synced.map(s => s.invoiceNumber).join(', ')}
              </div>
            )}
            {outcome.failed.length > 0 && (
              <div className="of-alert-sub">
                {outcome.failed.length} could not be synced — the error is shown on the invoice below and it stays queued.
              </div>
            )}
            {outcome.stoppedEarly && outcome.synced.length === 0 && outcome.failed.length === 0 && (
              <div>Connection dropped — the remaining invoices stay queued.</div>
            )}
          </div>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="of-panel">
          <EmptyState
            icon="check"
            title="Nothing to sync"
            message="Invoices billed while this device had no connection appear here, with their line items, totals and a temporary number, until they reach the server."
            action={<Button size="sm" variant="subtle" icon="pos" href="/pos">Open the counter</Button>}
          />
        </div>
      ) : (
        <div className="table-frame">
          <div className="responsive-table">
            <div className="table-header of-row of-head">
              <span data-label="Number">Queue reference</span>
              <span data-label="Customer">Customer</span>
              <span data-label="Items">Items</span>
              <span data-label="Amount">Total</span>
              <span data-label="Date">Invoice date</span>
              <span data-label="Status">Status</span>
              <span className="of-right" data-label="Actions">Actions</span>
            </div>
            {entries.map(entry => {
              const inv = entry.invoice as Record<string, unknown>
              const failed = entry.status === 'error'
              const itemCount = entry.items.length
              return (
                <div key={entry.id} className={`table-row of-row ${failed ? 'of-failed' : ''}`}>
                  <span data-label="Number" className="of-main">
                    <span className="of-mono">{entry.tempNumber}</span>
                    <span className="of-sub">Queued {formatDateTimeIN(entry.createdAt)}</span>
                  </span>
                  <span data-label="Customer">{String(inv.customer_name ?? '—')}</span>
                  <span data-label="Items">{itemCount} item{itemCount === 1 ? '' : 's'}</span>
                  <span data-label="Amount" className="of-amt">{money(num(inv.grand_total))}</span>
                  <span data-label="Date">{formatDateIN(String(inv.invoice_date ?? ''))}</span>
                  <span data-label="Status">
                    {failed ? <Badge tone="red">Failed</Badge> : <Badge tone="amber">Pending</Badge>}
                    {failed && Boolean(entry.error) && <div className="of-error">{String(entry.error)}</div>}
                  </span>
                  <span className="of-right of-actions" data-label="Actions">
                    <Button size="sm" variant="danger" onClick={() => discard(entry)}>Discard</Button>
                    <Button size="sm" variant="subtle" onClick={() => router.push('/invoices')}>Invoices</Button>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="of-vault">
        <Icon name="shield" size={15} />
        <span>
          This queue is not the only device-only data — the batch, serial, godown, LUT and workpaper registers sit on this
          browser too. <Link href="/vault" className="of-vault-link">The books vault</Link> writes those into one file you
          can keep somewhere the browser is not. The queue itself travels as <em>evidence only</em>: putting a pending
          invoice back would replay a sync and bill the same sale twice, so the vault prints this queue and never restores
          it.
        </span>
      </div>

      <div className="of-foot">
        <span>Queued here: {entries.length} · {money(summary.value)}</span>
        <span>The queue lives in this browser only — clearing site data before a sync discards these invoices, and they cannot be recovered from the server.</span>
      </div>

      <style>{`
        .of { display: flex; flex-direction: column; }
        .of-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }

        .of-alert { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; border-radius: var(--radius-sm);
          padding: 10px 12px; margin-bottom: 10px; border-left: 3px solid transparent; }
        .of-alert svg { flex-shrink: 0; margin-top: 1px; }
        .of-alert-green { background: var(--green-soft); color: var(--green); border-left-color: var(--green); }
        .of-alert-red { background: var(--red-soft); color: var(--red); border-left-color: var(--red); }
        .of-alert-amber { background: var(--amber-soft); color: var(--amber); border-left-color: var(--amber); }
        .of-alert-blue { background: var(--brand-soft); color: var(--brand); border-left-color: var(--brand); }
        .of-alert-sub { margin-top: 4px; }

        .of-panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
        .of-row { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.2fr) 76px 116px 104px 150px 156px;
          gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; color: var(--ink-2); }
        .of-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .of-right { text-align: right; }
        .of-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .of-mono { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--ink);
          font-weight: 600; overflow-wrap: anywhere; }
        .of-sub { font-size: 11px; color: var(--faint); }
        .of-amt { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--ink); }
        .of-error { font-size: 10.5px; color: var(--red); margin-top: 3px; overflow-wrap: anywhere; }
        .of-failed { background: var(--red-soft); }
        .of-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }

        .of-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 11.5px;
          color: var(--faint); margin-top: 12px; }

        .of-vault { display: flex; align-items: flex-start; gap: 8px; margin-top: 14px; padding: 10px 12px;
          border-radius: var(--radius-sm); font-size: 12px; line-height: 1.6; color: var(--muted);
          background: var(--brand-soft); border: 1px solid color-mix(in srgb, var(--brand) 18%, transparent); }
        .of-vault svg { flex-shrink: 0; margin-top: 2px; color: var(--brand); }
        .of-vault-link { color: var(--brand); font-weight: 650; text-decoration: none; }
        .of-vault-link:hover { text-decoration: underline; }

        @media (max-width: 1100px) { .of-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .of-row { grid-template-columns: 1fr; gap: 6px; }
          .of-head { display: none; }
          .of-right { text-align: left; }
          .of-actions { justify-content: flex-start; }
          .of-stats { grid-template-columns: 1fr 1fr; }
        }
      `}</style>
    </div>
  )
}

export default function OfflinePage() {
  return (
    <Suspense fallback={<div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}>
      <OfflinePageInner />
    </Suspense>
  )
}
