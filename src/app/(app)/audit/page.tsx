'use client'

// The audit trail and the period seal — evidence of what was decided, and a window closed.
//
// The engine (src/lib/audit.ts) owns the model: a standing list of sealed periods and an
// append-only trail of every seal, release, refusal and note, kept in this browser under
// `taxflow:audit:<orgId>`. This page is the register itself — the seals, the trail, the
// integrity verdict on that trail, and the two dialogs (close a period, lift a seal) that
// are the only ways anything is written from here.
//
// Three boundaries are printed on the screen rather than left to the reader to assume,
// because each one is where a "audit log" feature elsewhere quietly overreaches:
//
//  * **This register holds no rupee.** A seal is a window, an event is a sentence. The money
//    stays in the invoices and bills; nothing here charges, debits or files anything.
//  * **The trail is a checksum, not a signature.** The page says "the trail is unbroken" —
//    that the `seq` numbers run 1..n with no gap, duplicate or reorder. That is what a
//    hand-edit leaves behind. It cannot say *who* held the keyboard; only the actor each
//    write path chose to stamp is as good as that write path's own login.
//  * **The seal only closes the doors that ask it.** Today the invoice creation form asks
//    `sealGuard` before it saves, so a document dated in a sealed month is refused and the
//    attempt is logged here. Every other path is printed by name, not implied. A lock that
//    covers some doors and says nothing is worse than a smaller lock that is honest.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN } from '@/lib/format'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import {
  activeSeals, type AuditEvent, type AuditStore, EVENT_META, fyLabel, fyStartOf, loadAudit,
  monthLabel, monthSealability, type PeriodSeal, SEAL_CSV_HEADERS, sealCsvRows, sealGuard, sealPeriod,
  type SealKind, trailCsvRows, trailStats, TRAIL_CSV_HEADERS, releaseSeal, recordNote, todayISO, verifyChain,
} from '@/lib/audit'
import {
  Badge, Button, Card, EmptyState, PageHeader, SearchInput, SectionTitle, Segmented, StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'

type Tab = 'seals' | 'trail'

const TABS: { value: Tab; label: string }[] = [
  { value: 'seals', label: 'Period seals' },
  { value: 'trail', label: 'The trail' },
]

// The doors, named. A seal is only as strong as the paths that consult it, so the page prints
// them rather than let "period lock" imply a coverage the wiring has not earned.
const GUARDED: { href: string; label: string; live: boolean }[] = [
  { href: '/invoices/new', label: 'New invoice', live: true },
  { href: '/bills/new', label: 'New purchase bill', live: false },
  { href: '/payments', label: 'Payment received', live: false },
  { href: '/gst/gstr1', label: 'GSTR-1 filing', live: false },
]

function stamp(isoStr: string): string {
  if (!isoStr) return '—'
  const d = new Date(isoStr)
  if (Number.isNaN(d.getTime())) return isoStr
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

/** The FY window a year seal would close — shown so the shop reads the span before it acts. */
function fyWindow(startYear: number): string {
  return `1 Apr ${startYear} – 31 Mar ${startYear + 1}`
}

interface SealDraft { year: number; kind: SealKind; month: string; note: string }
interface ReleaseDraft { seal: PeriodSeal; reason: string }

function AuditPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)

  const [store, setStore] = useState<AuditStore>({ version: 1, updatedAt: '', orgId: '', seals: [], events: [] })

  const [tab, setTab] = useState<Tab>('seals')
  const [search, setSearch] = useSearchDeepLink()
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)

  const [seal, setSeal] = useState<SealDraft | null>(null)
  const [sealError, setSealError] = useState('')
  const [release, setRelease] = useState<ReleaseDraft | null>(null)
  const [releaseError, setReleaseError] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')

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

      const oid = membership.organization_id
      setOrgId(oid)
      setOrgName((membership.organizations as { name?: string } | null)?.name || '')
      setStore(loadAudit(oid))

      const t = searchParams.get('tab')
      if (t === 'trail' || t === 'seals') setTab(t)
      // ?new=1 — the palette's "Seal a period" action lands here with the dialog open.
      if (searchParams.get('new') === '1') openSeal()
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stats = useMemo(() => trailStats(store), [store])
  const chain = useMemo(() => verifyChain(store), [store])

  const standing = useMemo(() => activeSeals(store), [store])
  const orderedSeals = useMemo(() => {
    const a = standing.slice().sort((x, y) => (y.sealed_at || '').localeCompare(x.sealed_at || ''))
    const r = store.seals.filter(s => s.released_at !== null)
      .sort((x, y) => (y.released_at || '').localeCompare(x.released_at || ''))
    return [...a, ...r]
  }, [store, standing])

  const visibleSeals = useMemo(
    () => orderedSeals.filter(s => matchesView(s, tab) && matchesAny(search,
      [s.label, s.note, s.sealed_by, s.release_reason, s.from, s.to])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orderedSeals, search],
  )

  const newestFirst = useMemo(() => store.events.slice().reverse(), [store])
  const visibleEvents = useMemo(
    () => newestFirst.filter(e =>
      matchesAny(search, [e.ref, e.target, e.actor, e.note, EVENT_META[e.kind].label, e.date])),
    [newestFirst, search],
  )

  // Which dates in the current view are inside a standing seal — the mini-calendar marks them.
  const monthRows = useMemo(() => (seal ? monthSealability(seal.year) : []), [seal])

  function openSeal() {
    const today = todayISO()
    const year = fyStartOf(today) ?? Number(today.slice(0, 4))
    setSeal({ year, kind: 'month', month: '', note: '' })
    setSealError('')
  }

  function runSeal() {
    if (!seal || !orgId) return
    const result = sealPeriod(orgId, {
      kind: seal.kind,
      month: seal.kind === 'month' ? seal.month : undefined,
      year: seal.kind === 'year' ? seal.year : undefined,
      note: seal.note,
      actor: orgName,
    })
    if (!result.ok) { setSealError(result.why); return }
    setStore(result.store)
    setSeal(null)
    setSealError('')
    setTab('seals')
    setNotice({ msg: `The period is sealed. Documents dated inside it are now refused at the invoice form.`, bad: false })
  }

  function runRelease() {
    if (!release || !orgId) return
    const result = releaseSeal(orgId, release.seal.id, release.reason, todayISO(), orgName)
    if (!result.ok) { setReleaseError(result.why); return }
    setStore(result.store)
    const label = release.seal.label
    setRelease(null)
    setReleaseError('')
    setNotice({ msg: `${label} is open again — the seal stays on the trail as a released seal, never deleted.`, bad: true })
  }

  function runNote() {
    if (!orgId || !noteText.trim()) return
    setStore(recordNote(orgId, noteText, orgName))
    setNoteText('')
    setNoteOpen(false)
    setTab('trail')
    setNotice({ msg: 'A line was added to the trail.', bad: false })
  }

  function exportSeals() {
    download(`taxflow-period-seals-${todayISO()}.csv`, toCsv(SEAL_CSV_HEADERS, sealCsvRows(store)))
  }
  function exportTrail() {
    download(`taxflow-audit-trail-${todayISO()}.csv`, toCsv(TRAIL_CSV_HEADERS, trailCsvRows(store)))
  }

  if (loading) {
    return <div className="au-wrap"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the register…</p></div>
  }

  const guardToday = orgId ? sealGuard(orgId, todayISO()) : { sealed: false, label: '', why: '' }
  const canSealSave = !!seal && (seal.kind === 'year' || !!seal.month)

  return (
    <div className="au-wrap">
      <PageHeader
        eyebrow="Evidence & locks"
        title="Audit trail and period seals"
        subtitle="Who closed what, and whether a filed period can still be typed over. This register keeps the decisions; the rupees stay in the documents."
        actions={
          <>
            <Button variant="ghost" icon="edit" onClick={() => setNoteOpen(true)}>Add a note</Button>
            <Button icon="lock" onClick={openSeal}>Seal a period</Button>
          </>
        }
      />

      {notice && (
        <div className={`au-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
          <Icon name={notice.bad ? 'unlock' : 'check'} size={14} strokeWidth={notice.bad ? 2.2 : 2.4} />
          <span>{notice.msg}</span>
          <button type="button" className="au-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {/* ── The four numbers, and the verdict on the trail ────────────────────── */}
      {/* A count, never a rupee: this register keeps decisions, not money (so the
          StatCard value is a string, bypassing its default formatCompactINR). */}
      <div className="au-stats">
        <StatCard label="Standing seals" value={String(stats.active)} icon="lock" tone="green"
          sub={stats.active ? 'closed to edits' : 'nothing locked'} delay={0} />
        <StatCard label="Released" value={String(stats.released)} icon="unlock" tone="amber"
          sub="lifted, still on record" delay={60} />
        <StatCard label="Trail events" value={String(stats.events)} icon="clock" tone="blue"
          sub="seals, releases, refusals, notes" delay={120} />
        <StatCard label="Writes refused" value={String(stats.refused)} icon="shield" tone="red"
          sub="attempts to edit a closed period" delay={180} />
      </div>

      <Card pad={false} className="au-integrity">
        <div className="au-integrity-body">
          <span className={`au-seal-dot ${chain.ok ? 'is-ok' : 'is-bad'}`}>
            <Icon name={chain.ok ? 'check' : 'alert'} size={18} strokeWidth={2.4} />
          </span>
          <div className="au-integrity-text">
            <div className="au-integrity-head">
              {chain.ok
                ? <>The trail is <strong>unbroken</strong> — {chain.count} event{chain.count === 1 ? '' : 's'} numbered 1 to {chain.count || 0} with no gap, duplicate or reorder.</>
                : <>The trail <strong>shows a break</strong> at sequence {chain.broken.join(', ')} — a row was added, removed or re-sorted by hand.</>}
            </div>
            <p>
              This is a checksum over the <span className="au-mono">seq</span> numbers, not a signature. It proves the file was
              edited by something other than the register; it cannot name who. {orgId && `Last written ${formatDateIN(store.updatedAt)}.`}
            </p>
          </div>
          <div className="au-integrity-side">
            {guardToday.sealed
              ? <Badge tone="red" dot={false}>Today is inside {guardToday.label}</Badge>
              : <Badge tone="grey" dot={false}>Today is open</Badge>}
          </div>
        </div>
      </Card>

      {/* ── Which doors the seal actually closes ──────────────────────────────── */}
      <div className="au-bounds">
        <div className="au-bounds-col">
          <SectionTitle icon="lock">What a seal stops</SectionTitle>
          <ul className="au-doors">
            {GUARDED.map(d => (
              <li key={d.href} className={d.live ? 'is-live' : 'is-dormant'}>
                <span className={`au-door-dot ${d.live ? 'is-live' : 'is-dormant'}`} />
                <Link href={d.href} className="au-door-link">{d.label}</Link>
                <span className="au-door-tag">{d.live ? 'asks the seal' : 'not yet wired'}</span>
              </li>
            ))}
          </ul>
          <p className="au-bounds-note">
            Only the paths marked <em>asks the seal</em> consult it before they save — and when one is stopped, the attempt is
            written here as a <strong>Write refused</strong> event, so the edit that never happened is still on the record.
          </p>
        </div>
        <div className="au-bounds-col">
          <SectionTitle icon="alert">What this register is not</SectionTitle>
          <div className="au-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>It holds no rupee — a seal is a window, an event is a sentence.</span></div>
          <div className="au-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>It files nothing. The seals are your shop’s decision, not the portal’s.</span></div>
          <div className="au-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>It lives in this browser (ADR-013). It travels only inside the books vault, never on its own.</span></div>
          <div className="au-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>Releasing a seal keeps it — a silent unlock is exactly what an auditor looks for, so a reason is required.</span></div>
        </div>
      </div>

      {/* ── Toolbar ───────────────────────────────────────────────────────────── */}
      <div className="au-toolbar">
        <Segmented options={TABS} value={tab} onChange={v => setTab(v as Tab)} />
        <SearchInput value={search} onChange={setSearch} ariaLabel="Search seals and the trail"
          placeholder={tab === 'seals' ? 'Search periods…' : 'Search the trail…'} style={{ width: 240 }} />
        <span className="au-export">
          <Button variant="ghost" size="sm" icon="download"
            onClick={tab === 'seals' ? exportSeals : exportTrail}
            disabled={tab === 'seals' ? store.seals.length === 0 : store.events.length === 0}>
            Export {tab === 'seals' ? 'seals' : 'trail'}
          </Button>
        </span>
      </div>

      {/* ── Seals ─────────────────────────────────────────────────────────────── */}
      {tab === 'seals' && (
        visibleSeals.length === 0
          ? (
            <EmptyState icon="lock"
              title={store.seals.length === 0 ? 'No period is sealed' : 'Nothing matches'}
              message={store.seals.length === 0
                ? 'A seal closes a GST period that has fully ended. Until one stands, every past month can still be typed over.'
                : 'No seal matches this search.'}
              action={store.seals.length === 0
                ? <Button icon="lock" onClick={openSeal}>Seal a period</Button>
                : <Button variant="ghost" onClick={() => setSearch('')}>Clear search</Button>} />
          ) : (
            <div className="au-grid">
              {visibleSeals.map(s => <SealCard key={s.id} seal={s}
                onRelease={() => { setRelease({ seal: s, reason: '' }); setReleaseError('') }} />)}
            </div>
          )
      )}

      {/* ── Trail ─────────────────────────────────────────────────────────────── */}
      {tab === 'trail' && (
        visibleEvents.length === 0
          ? (
            <EmptyState icon="clock"
              title={store.events.length === 0 ? 'The trail is empty' : 'Nothing matches'}
              message={store.events.length === 0
                ? 'Every seal, release, refused write and note lands here, numbered in order. It fills as the register is used.'
                : 'No event matches this search.'}
              action={store.events.length === 0
                ? <Button variant="ghost" icon="edit" onClick={() => setNoteOpen(true)}>Add a note</Button>
                : <Button variant="ghost" onClick={() => setSearch('')}>Clear search</Button>} />
          ) : (
            <Card pad={false}>
              <div className="au-head au-event-row">
                <span>#</span><span>Event</span><span>When</span><span>About</span><span>By</span><span>Detail</span>
              </div>
              {visibleEvents.map(e => <EventRow key={e.id} e={e} />)}
            </Card>
          )
      )}

      <div className="au-foot">
        <span>Seals and events are stored in this browser at <span className="au-mono">taxflow:audit:&lt;org&gt;</span>. Nothing here reaches a return.</span>
        <span className="au-foot-links">
          <Link href="/vault">Books vault →</Link>
          <Link href="/invoices/new">New invoice →</Link>
        </span>
      </div>

      {/* ── Seal a period ─────────────────────────────────────────────────────── */}
      {seal && (
        <div className="au-scrim" role="dialog" aria-modal="true" aria-label="Seal a period">
          <div className="au-modal">
            <div className="au-modal-head">
              <div>
                <h2>Seal a period</h2>
                <p>Close a GST period that has fully ended. A month still in progress, or one that overlaps a seal already standing, is refused.</p>
              </div>
              <button type="button" className="au-close" onClick={() => setSeal(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {sealError && <div className="au-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} /><span>{sealError}</span></div>}

            <Segmented options={[{ value: 'month', label: 'A month' }, { value: 'year', label: 'The financial year' }]}
              value={seal.kind} onChange={v => setSeal({ ...seal, kind: v as SealKind, month: '' })} />

            <div className="au-yearpick">
              <button type="button" className="au-ybtn" aria-label="Previous year"
                onClick={() => setSeal({ ...seal, year: seal.year - 1, month: '' })}><Icon name="chevron-left" size={16} /></button>
              <span className="au-year-label">
                {seal.kind === 'year' ? `FY ${fyLabel(seal.year)}` : `FY ${fyLabel(seal.year)} · months`}
              </span>
              <button type="button" className="au-ybtn" aria-label="Next year"
                onClick={() => setSeal({ ...seal, year: seal.year + 1, month: '' })}><Icon name="chevron-right" size={16} /></button>
            </div>

            {seal.kind === 'month' ? (
              <div className="au-months">
                {monthRows.map(m => {
                  const chosen = seal.month === m.month
                  return (
                    <button key={m.month} type="button"
                      className={`au-mchip ${chosen ? 'is-chosen' : ''} ${m.sealable ? '' : 'is-off'}`}
                      disabled={!m.sealable}
                      title={m.sealable ? 'Close this month' : 'Not finished yet — a period is sealed only once it has ended'}
                      onClick={() => setSeal({ ...seal, month: m.month })}>
                      {m.label.replace(/\s\d{4}$/, '')}
                      <span className="au-mchip-year">{m.month.slice(0, 4)}</span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="au-note-box">
                <Icon name="lock" size={14} />
                <span>Closes <strong>{fyWindow(seal.year)}</strong> as one period. The engine refuses it if the year has not ended or it crosses a seal already standing.</span>
              </div>
            )}

            <label className="au-field">
              <span>Note (optional)</span>
              <input className="tf-input" value={seal.note} onChange={e => setSeal({ ...seal, note: e.target.value })}
                placeholder="Filed GSTR-3B for the quarter, reconciled to the books…" autoFocus />
            </label>

            <div className="au-preview">
              <div className="au-preview-head">
                <span>What sealing writes</span>
                <span className="au-preview-total">
                  {seal.kind === 'year' ? `FY ${fyLabel(seal.year)}` : (seal.month ? monthLabel(seal.month) : 'no month yet')}
                </span>
              </div>
              <ul className="au-preview-list">
                <li>A standing seal on the period<span className="au-preview-take">a locked window</span></li>
                <li>New invoices dated inside it are refused at the form<span className="au-preview-take">lock</span></li>
                <li>A line on the trail<span className="au-preview-take">+1 event</span></li>
              </ul>
            </div>

            <div className="au-save">
              <Button variant="ghost" onClick={() => setSeal(null)}>Cancel</Button>
              <Button icon="lock" onClick={runSeal} disabled={!canSealSave}>Seal it</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Release a seal ────────────────────────────────────────────────────── */}
      {release && (
        <div className="au-scrim" role="dialog" aria-modal="true" aria-label={`Release ${release.seal.label}`}>
          <div className="au-modal" style={{ maxWidth: 500 }}>
            <div className="au-modal-head">
              <div>
                <h2>Release {release.seal.label}</h2>
                <p>This reopens the period to edits. The seal is <em>not</em> deleted — it stays on the trail and on this page as a released seal, with your reason beside it.</p>
              </div>
              <button type="button" className="au-close" onClick={() => setRelease(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {releaseError && <div className="au-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} /><span>{releaseError}</span></div>}

            <div className="au-facts">
              <StatRow label="Window" value={`${formatDateIN(release.seal.from)} → ${formatDateIN(release.seal.to)}`} />
              <StatRow label="Sealed" value={`${release.seal.sealed_by || 'this device'}, ${formatDateIN((release.seal.sealed_at || '').slice(0, 10))}`} tone="green" />
            </div>

            <label className="au-field">
              <span>Why is the period being reopened? *</span>
              <textarea className="tf-input" rows={3} value={release.reason}
                onChange={e => setRelease({ ...release, reason: e.target.value })}
                placeholder="A credit note dated in the month surfaced after filing; the period must be corrected…"
                style={{ resize: 'vertical' }} autoFocus />
              <span className="au-hint">An empty reason is a silent unlock — the register refuses it.</span>
            </label>

            <div className="au-save">
              <Button variant="ghost" onClick={() => setRelease(null)}>Keep it sealed</Button>
              <Button variant="danger" icon="unlock" onClick={runRelease} disabled={!release.reason.trim()}>Release seal</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add a note ────────────────────────────────────────────────────────── */}
      {noteOpen && (
        <div className="au-scrim" role="dialog" aria-modal="true" aria-label="Add a note to the trail">
          <div className="au-modal" style={{ maxWidth: 480 }}>
            <div className="au-modal-head">
              <div>
                <h2>Add a line to the trail</h2>
                <p>A note changes no seal and writes no document. It is a decision recorded beside the numbers — filed a return, agreed a correction, closed a book.</p>
              </div>
              <button type="button" className="au-close" onClick={() => setNoteOpen(false)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>
            <label className="au-field">
              <span>Note</span>
              <textarea className="tf-input" rows={3} value={noteText} onChange={e => setNoteText(e.target.value)}
                placeholder="FY 2025-26 GSTR-9 filed 11 Oct, per CA sign-off…" style={{ resize: 'vertical' }} autoFocus />
            </label>
            <div className="au-save">
              <Button variant="ghost" onClick={() => setNoteOpen(false)}>Cancel</Button>
              <Button icon="edit" onClick={runNote} disabled={!noteText.trim()}>Add note</Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .au-wrap { display: flex; flex-direction: column; }
        .au-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }

        .au-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px;
          font-size: 12.5px; color: var(--green); background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 10px; }
        .au-notice svg { flex-shrink: 0; }
        .au-notice.is-bad { color: var(--amber); background: var(--amber-soft);
          border-color: color-mix(in srgb, var(--amber) 26%, white); }
        .au-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; border-radius: 6px; min-height: 0; }
        .au-notice-x:hover { background: rgba(0,0,0,0.05); }

        .au-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px; margin-bottom: 12px;
          padding: 10px 12px; background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .au-alert svg { flex-shrink: 0; }

        .au-integrity { margin-bottom: 1rem; }
        .au-integrity-body { display: flex; align-items: flex-start; gap: 13px; padding: 14px 16px; }
        .au-seal-dot { width: 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .au-seal-dot.is-ok { color: var(--green); background: var(--green-soft); }
        .au-seal-dot.is-bad { color: var(--red); background: var(--red-soft); }
        .au-integrity-text { min-width: 0; flex: 1; }
        .au-integrity-head { font-size: 13.5px; color: var(--ink); line-height: 1.5; }
        .au-integrity-head strong { font-weight: 700; }
        .au-integrity-text p { font-size: 11.5px; color: var(--muted); line-height: 1.55; margin: 5px 0 0; }
        .au-integrity-side { flex-shrink: 0; align-self: center; }

        .au-bounds { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 1.15rem; }
        .au-bounds-col { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 15px 16px; }
        .au-doors { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .au-doors li { display: flex; align-items: center; gap: 9px; font-size: 12.5px; }
        .au-door-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .au-door-dot.is-live { background: var(--green); }
        .au-door-dot.is-dormant { background: var(--faint); }
        .au-door-link { color: var(--ink-2); font-weight: 600; text-decoration: none; }
        .au-door-link:hover { color: var(--brand); }
        .au-door-tag { margin-left: auto; font-size: 10.5px; color: var(--faint); }
        .au-doors li.is-live .au-door-tag { color: var(--green); }
        .au-bounds-note { font-size: 11.5px; color: var(--muted); line-height: 1.6; margin: 11px 0 0; }
        .au-bounds-note em { color: var(--green); font-style: normal; font-weight: 650; }
        .au-bounds-note strong { color: var(--ink-2); font-weight: 650; }
        .au-fact { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--muted); line-height: 1.55; padding: 6px 0; }
        .au-fact svg { flex-shrink: 0; margin-top: 2px; color: var(--faint); }

        .au-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
        .au-export { margin-left: auto; }

        .au-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
        .au-card { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--green);
          border-radius: var(--radius-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-xs); }
        .au-card.is-released { border-left-color: var(--amber); background: var(--surface-2); opacity: 0.92; }
        .au-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .au-card-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .au-card-title svg { color: var(--green); flex-shrink: 0; }
        .au-card.is-released .au-card-title svg { color: var(--amber); }
        .au-card-name { font-size: 14.5px; font-weight: 650; color: var(--ink); overflow-wrap: anywhere; }
        .au-card-sub { font-size: 11.5px; color: var(--faint); }
        .au-card-note { font-size: 12px; color: var(--ink-2); line-height: 1.55; background: var(--surface-2);
          border-radius: 9px; padding: 8px 10px; }
        .au-card.is-released .au-card-note { background: var(--surface); }
        .au-card-foot { display: flex; align-items: center; gap: 8px; margin-top: 2px; flex-wrap: wrap; }
        .au-reason { font-size: 11.5px; color: var(--amber); line-height: 1.5; margin-top: 6px;
          border-top: 1px dashed var(--line); padding-top: 8px; }
        .au-reason strong { color: var(--ink-2); }

        .au-event-row { display: grid; gap: 10px; align-items: center; padding: 9px 16px;
          grid-template-columns: 40px 140px 150px 130px 120px minmax(0, 1.6fr); }
        .au-event-row.is-row { font-size: 12.5px; border-top: 1px solid var(--line-soft); padding: 11px 16px; }
        .au-head { background: var(--surface-2); font-size: 11px; font-weight: 650; color: var(--faint);
          text-transform: uppercase; letter-spacing: 0.05em; }
        .au-seq { font-variant-numeric: tabular-nums; color: var(--faint); font-size: 12px; }
        .au-ev-what { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .au-ev-ref { font-size: 11px; color: var(--faint); overflow-wrap: anywhere; }
        .au-ev-when, .au-ev-by { font-size: 11.5px; color: var(--muted); }
        .au-ev-note { font-size: 12px; color: var(--ink-2); line-height: 1.5; overflow-wrap: anywhere; }

        .au-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          font-size: 11.5px; color: var(--faint); margin-top: 18px; }
        .au-foot-links { display: flex; gap: 12px; flex-wrap: wrap; }
        .au-mono { font-family: ui-monospace, Menlo, monospace; font-size: 0.94em; }

        .au-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .au-modal { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg);
          padding: 1.4rem 1.5rem; width: 100%; max-width: 560px; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .au-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .au-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .au-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; line-height: 1.55; }
        .au-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px;
          border-radius: 6px; flex-shrink: 0; min-height: 0; }
        .au-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .au-yearpick { display: flex; align-items: center; justify-content: center; gap: 14px; }
        .au-ybtn { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; color: var(--ink-2);
          cursor: pointer; padding: 6px; min-height: 0; display: flex; align-items: center; }
        .au-ybtn:hover { background: var(--slate-soft); }
        .au-year-label { font-size: 13px; font-weight: 650; color: var(--ink); }

        .au-months { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
        .au-mchip { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
          padding: 9px 11px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface);
          font-family: inherit; font-size: 12.5px; font-weight: 600; color: var(--ink-2); cursor: pointer; text-align: left; }
        .au-mchip:hover:not(:disabled) { border-color: var(--brand); }
        .au-mchip.is-chosen { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); }
        .au-mchip.is-off, .au-mchip:disabled { opacity: 0.45; cursor: not-allowed; }
        .au-mchip-year { font-size: 10px; font-weight: 500; color: var(--faint); }

        .au-note-box { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--muted);
          background: var(--surface-2); border-radius: 10px; padding: 10px 12px; line-height: 1.55; }
        .au-note-box svg { flex-shrink: 0; margin-top: 2px; color: var(--brand); }
        .au-note-box strong { color: var(--ink-2); }

        .au-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .au-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .au-hint { font-size: 11px; color: var(--faint); }
        .au-facts { display: flex; flex-direction: column; }

        .au-preview { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--surface-2); }
        .au-preview-head { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .au-preview-total { color: var(--brand); font-variant-numeric: tabular-nums; text-transform: none; letter-spacing: 0; }
        .au-preview-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .au-preview-list li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--ink-2); line-height: 1.5; flex-wrap: wrap; }
        .au-preview-take { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 650; color: var(--ink); }
        .au-save { display: flex; gap: 10px; justify-content: flex-end; }

        @media (max-width: 1100px) { .au-stats { grid-template-columns: 1fr 1fr; } .au-bounds { grid-template-columns: 1fr; } }
        @media (max-width: 768px) {
          .au-grid { grid-template-columns: 1fr; }
          .au-months { grid-template-columns: 1fr 1fr; }
          .au-event-row { grid-template-columns: 1fr; gap: 6px; }
          .au-head { display: none; }
          .au-export { margin-left: 0; }
          .au-scrim { align-items: flex-end; padding: 0; }
          .au-scrim .au-modal { max-width: none !important; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .au-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}

function matchesView(s: PeriodSeal, tab: Tab): boolean {
  // The seals tab shows every seal (standing first, released after); the trail tab has no seal rows.
  return tab === 'seals' ? true : s.released_at === null
}

function SealCard({ seal, onRelease }: { seal: PeriodSeal; onRelease: () => void }) {
  const released = seal.released_at !== null
  return (
    <div className={`au-card ${released ? 'is-released' : ''}`}>
      <div className="au-card-head">
        <div className="au-card-title">
          <Icon name={released ? 'unlock' : 'lock'} size={17} />
          <div>
            <div className="au-card-name">{seal.label}</div>
            <div className="au-card-sub">{seal.kind === 'year' ? 'Financial year' : 'Month'} · {formatDateIN(seal.from)} → {formatDateIN(seal.to)}</div>
          </div>
        </div>
        <Badge tone={released ? 'amber' : 'green'}>{released ? 'Released' : 'Sealed'}</Badge>
      </div>

      {seal.note && <div className="au-card-note">{seal.note}</div>}

      <div className="au-card-foot">
        <span className="au-card-sub">
          {released ? 'Released' : 'Sealed'} {seal.sealed_by ? `by ${seal.sealed_by}, ` : ''}
          {formatDateIN(((released ? seal.released_at : seal.sealed_at) || '').slice(0, 10))}
        </span>
        {!released && <Button variant="ghost" size="sm" icon="unlock" onClick={onRelease} style={{ marginLeft: 'auto' }}>Release</Button>}
      </div>

      {released && seal.release_reason && (
        <div className="au-reason"><strong>Why reopened:</strong> {seal.release_reason}</div>
      )}
    </div>
  )
}

function EventRow({ e }: { e: AuditEvent }) {
  const meta = EVENT_META[e.kind]
  const icon = e.kind === 'sealed' ? 'lock' : e.kind === 'released' ? 'unlock' : e.kind === 'refused' ? 'shield' : 'edit'
  return (
    <div className="au-event-row is-row">
      <span className="au-seq">#{e.seq}</span>
      <span className="au-ev-what">
        <Badge tone={meta.tone}><Icon name={icon} size={11} /> {meta.label}</Badge>
      </span>
      <span className="au-ev-when">{stamp(e.at)}</span>
      <span className="au-ev-what">
        <span className="au-ev-ref">{e.date ? formatDateIN(e.date) : '—'}</span>
        <span className="au-ev-ref">{e.target || '—'}{e.ref ? ` · ${e.ref}` : ''}</span>
      </span>
      <span className="au-ev-by">{e.actor || 'this device'}</span>
      <span className="au-ev-note">{e.note}</span>
    </div>
  )
}

export default function AuditPage() {
  return (
    <Suspense fallback={<div className="au-wrap"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <AuditPageInner />
    </Suspense>
  )
}
