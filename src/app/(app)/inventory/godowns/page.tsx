'use client'

// Godown register — every place stock is kept, what stands in each one, and what
// has been moved between them.
//
// The engine (src/lib/godowns.ts) owns the model: a virtual Main godown that
// unplaced lots read as standing in, per-place figures derived from the batch
// register (never stored twice), and transfers expressed as a split — a signed
// movement off the source lot plus a new lot at the destination carrying the
// same batch identity. This page is the register itself: the places, their
// contents, and the move dialog.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN } from '@/lib/format'
import { fmtQty } from '@/lib/reorder'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import {
  BATCH_STATUS_LABEL, BATCH_STATUS_TONE, EXPIRY_CRITICAL_DAYS, batchViews, loadBatches, loadMoves, todayISO,
  type Batch, type BatchMove,
} from '@/lib/batches'
import {
  archiveGodown, GODOWN_CSV_HEADERS, godownById, godownCsvRows, godownOf, godownStock, isMain,
  loadGodowns, lotsAt, mainGodown, newGodown, recordTransfer,
  TRANSFER_CSV_HEADERS, transferCsvRows, transferHistory, unarchiveGodown, upsertGodown,
  validateGodown, validateTransfer, GODOWN_MAIN, type Godown, type GodownStock, type TransferRow,
} from '@/lib/godowns'
import {
  Badge, Button, Card, EmptyState, PageHeader, ProgressBar, SearchInput, Segmented, StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'

type ViewFilter = 'active' | 'holding' | 'empty' | 'archived' | 'all'

const VIEWS: { value: ViewFilter; label: string }[] = [
  { value: 'active', label: 'Open places' },
  { value: 'holding', label: 'Holding stock' },
  { value: 'empty', label: 'Empty' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' },
]

function matchesView(s: GodownStock, view: ViewFilter): boolean {
  if (view === 'all') return true
  if (view === 'archived') return s.godown.archived
  if (s.godown.archived) return false
  if (view === 'active') return true
  if (view === 'holding') return s.liveLots > 0
  return s.liveLots === 0
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const money = (n: number) => `₹${inr.format(Math.round(Number(n) || 0))}`

interface EditorState { godown: Godown; isNew: boolean }
interface TransferState { fromId: string; batchId: string; qty: string; toId: string; date: string; ref: string; note: string }

function GodownsPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)

  const [batches, setBatches] = useState<Batch[]>([])
  const [moves, setMoves] = useState<BatchMove[]>([])
  const [godowns, setGodowns] = useState<Godown[]>([mainGodown()])

  const [search, setSearch] = useSearchDeepLink()
  const [view, setView] = useState<ViewFilter>('active')
  const [openPlace, setOpenPlace] = useState('')
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [editorError, setEditorError] = useState('')
  const [transfer, setTransfer] = useState<TransferState | null>(null)
  const [transferError, setTransferError] = useState('')

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

      setBatches(loadBatches(oid))
      setMoves(loadMoves(oid))
      setGodowns(loadGodowns(oid))

      // ?new=1 — the palette's "Add godown" action lands here with the editor open.
      if (searchParams.get('new') === '1') {
        setEditor({ godown: newGodown(), isNew: true })
        setEditorError('')
      }
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const today = todayISO()
  const views = useMemo(() => batchViews(batches, moves, today), [batches, moves, today])
  const stock = useMemo(() => godownStock(godowns, views, today), [godowns, views, today])
  const history = useMemo(() => transferHistory(moves, batches, godowns), [moves, batches, godowns])

  const visible = useMemo(() => stock.filter(s =>
    matchesView(s, view) &&
    matchesAny(search, [s.godown.name, s.godown.code, s.godown.address])), [stock, view, search])

  const totals = useMemo(() => {
    const open = stock.filter(s => !s.godown.archived)
    return {
      places: open.length,
      archived: stock.length - open.length,
      value: open.reduce((s, x) => s + x.valueLeft, 0),
      units: open.reduce((s, x) => s + x.unitsLeft, 0),
      liveLots: open.reduce((s, x) => s + x.liveLots, 0),
      holding: open.filter(s => s.liveLots > 0).length,
      expired: open.reduce((s, x) => s + x.expired, 0),
      critical: open.reduce((s, x) => s + x.critical, 0),
      unplaced: open.find(s => isMain(s.godown.id))?.unplaced || 0,
    }
  }, [stock])

  const topValue = Math.max(1, ...stock.map(s => s.valueLeft))

  function flash(message: string) { setNotice({ msg: message, bad: false }) }
  function warn(message: string) { setNotice({ msg: message, bad: true }) }

  // ── editor ─────────────────────────────────────────────────────────────────
  function openEditor(godown: Godown, isNew: boolean) {
    setEditor({ godown, isNew })
    setEditorError('')
  }

  function patchEditor(patch: Partial<Godown>) {
    setEditor(e => (e ? { ...e, godown: { ...e.godown, ...patch } } : e))
  }

  function saveGodown() {
    if (!editor) return
    const problems = validateGodown(editor.godown, godowns)
    if (problems.length) { setEditorError(problems.join(' · ')); return }
    setGodowns(upsertGodown(orgId, editor.godown))
    flash(editor.isNew ? `${editor.godown.name.trim()} added to the register.` : `${editor.godown.name.trim()} updated.`)
    setEditor(null)
    setEditorError('')
  }

  function closePlace(s: GodownStock) {
    const result = archiveGodown(orgId, s.godown.id, s.liveLots)
    if (typeof result === 'string') { warn(result); return }
    setGodowns(result)
    flash(`${s.godown.name} archived — its history still reads as that place.`)
  }

  function reopenPlace(g: Godown) {
    setGodowns(unarchiveGodown(orgId, g.id))
    flash(`${g.name} is open again.`)
  }

  // ── transfer ───────────────────────────────────────────────────────────────
  function openTransfer(fromId = '') {
    const start = fromId || GODOWN_MAIN
    const firstLots = lotsAt(views, godowns, start)
    setTransfer({
      fromId: start,
      batchId: firstLots[0]?.id || '',
      qty: '',
      toId: godowns.find(g => !g.archived && g.id !== start)?.id || '',
      date: todayISO(),
      ref: '',
      note: '',
    })
    setTransferError('')
  }

  function patchTransfer(patch: Partial<TransferState>) {
    setTransfer(t => (t ? { ...t, ...patch } : t))
    setTransferError('')
  }

  const transferBatch = transfer ? batches.find(b => b.id === transfer.batchId) || null : null
  const transferCheck = useMemo(() => {
    if (!transfer || !transferBatch) return null
    return validateTransfer({
      batch: transferBatch, qty: Number(transfer.qty), toId: transfer.toId,
      date: transfer.date, ref: transfer.ref, note: transfer.note,
    }, views, godowns)
  }, [transfer, transferBatch, views, godowns])

  function saveTransfer() {
    if (!transfer || !transferBatch) { setTransferError('Pick a lot to move'); return }
    const result = recordTransfer(orgId, {
      batch: transferBatch, qty: Number(transfer.qty), toId: transfer.toId,
      date: transfer.date, ref: transfer.ref, note: transfer.note,
    }, views, godowns)
    if (!result.ok) { setTransferError(result.error); return }
    setBatches(result.batches)
    setMoves(result.moves)
    const plan = result.plan
    const dest = godownOf(plan.lot, godowns).name
    flash(`${fmtQty(plan.lot.qty, plan.lot.unit)} of ${plan.lot.product_name || plan.lot.batch_no} moved to ${dest} as lot ${plan.lot.batch_no}.`)
    setTransfer(null)
    setTransferError('')
  }

  function exportCsv() {
    download(`taxflow-godowns-${today}.csv`, toCsv(GODOWN_CSV_HEADERS, godownCsvRows(visible)))
  }

  function exportTransfers() {
    download(`taxflow-transfers-${today}.csv`, toCsv(TRANSFER_CSV_HEADERS, transferCsvRows(history)))
  }

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the godown register…</div>
  }

  const noLots = batches.length === 0

  return (
    <div className="page-container gd" style={{ maxWidth: 1180 }}>
      <PageHeader
        eyebrow={`${orgName.toUpperCase() || 'INVENTORY'} · WHERE THE STOCK STANDS`}
        title="Godowns"
        subtitle="Every place you keep stock, what stands in it, and what has moved between them. Lot figures come from the batch register — nothing is counted twice."
        actions={
          <>
            <Button variant="ghost" size="sm" icon="download" onClick={exportCsv} disabled={visible.length === 0}>CSV</Button>
            <Button variant="ghost" size="sm" icon="swap" onClick={() => openTransfer()}>Move stock</Button>
            <Button icon="plus" onClick={() => openEditor(newGodown(), true)}>Add godown</Button>
          </>
        }
      />

      <div className="gd-stats">
        <StatCard
          label="Open places" value={String(totals.places)}
          sub={totals.archived ? `${totals.archived} archived · ${totals.holding} holding stock` : `${totals.holding} holding stock`}
          icon="warehouse" tone="blue" delay={0}
        />
        <StatCard
          label="Value on the register" value={money(totals.value)}
          sub={totals.liveLots ? `${totals.liveLots} lot${totals.liveLots === 1 ? '' : 's'} · ${totals.units.toLocaleString('en-IN')} units` : 'nothing registered yet'}
          icon="scale" tone="cyan" delay={40}
        />
        <StatCard
          label="Never placed" value={String(totals.unplaced)}
          sub={totals.unplaced ? `lot${totals.unplaced === 1 ? '' : 's'} read as standing in ${godowns[0].name}` : 'every lot has a home'}
          icon={totals.unplaced ? 'alert' : 'check'} tone={totals.unplaced ? 'amber' : 'green'} delay={80}
        />
        <StatCard
          label="Expiry across places" value={String(totals.expired + totals.critical)}
          sub={totals.expired + totals.critical
            ? `${totals.expired} past expiry · ${totals.critical} inside ${EXPIRY_CRITICAL_DAYS} days`
            : 'nothing past or near its date'}
          icon="clock" tone={totals.expired ? 'red' : totals.critical ? 'amber' : 'green'} delay={120}
        />
      </div>

      <div className="gd-toolbar">
        <Segmented options={VIEWS} value={view} onChange={v => setView(v as ViewFilter)} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Place, code or address…"
          ariaLabel="Search godowns"
          style={{ flex: '1 1 240px', maxWidth: 320, marginLeft: 'auto' }}
        />
      </div>

      {notice && (
        <div className={`gd-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
          <Icon name={notice.bad ? 'alert' : 'check'} size={14} strokeWidth={notice.bad ? 2.2 : 2.4} />
          <span>{notice.msg}</span>
          <button type="button" className="gd-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {noLots && (
        <div className="gd-note" style={{ marginBottom: 12 }}>
          <Icon name="alert" size={14} strokeWidth={2.2} />
          <span>
            Nothing is on the <Link href="/inventory/batches">batch register</Link> yet, so every place below reads as empty.
            A godown is worth adding once lots arrive — a lot carries the place it stands in.
          </span>
        </div>
      )}

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon="warehouse"
            title={stock.length > 1 ? 'No place in this view' : 'Only the Main godown exists'}
            message={stock.length > 1
              ? 'Clear the search or pick another view to see the rest of the register.'
              : 'Unplaced lots already read as standing in the Main godown. Add a second place when stock goes out to another address, then move lots between them.'}
            action={stock.length > 1
              ? undefined
              : <Button size="sm" icon="plus" onClick={() => openEditor(newGodown(), true)}>Add godown</Button>}
          />
        </Card>
      ) : (
        <div className="gd-grid">
          {visible.map(s => {
            const g = s.godown
            const open = openPlace === g.id
            const lots = lotsAt(views, godowns, g.id)
            return (
              <div key={g.id} className={`gd-card ${g.archived ? 'is-archived' : ''} ${open ? 'is-open' : ''}`}>
                <div className="gd-card-head">
                  <div className="gd-card-title">
                    <span className="gd-card-name">
                      <Icon name="warehouse" size={15} />
                      {g.name}
                    </span>
                    <span className="gd-card-sub">
                      {g.code ? `${g.code} · ` : ''}{g.address || (isMain(g.id) ? 'the place unplaced lots read as standing in' : 'no address recorded')}
                    </span>
                  </div>
                  <div className="gd-card-badges">
                    {isMain(g.id) && <Badge tone="violet" dot={false}>Main</Badge>}
                    {g.archived && <Badge tone="grey" dot={false}>Archived</Badge>}
                    {!g.archived && s.liveLots === 0 && <Badge tone="grey" dot={false}>Empty</Badge>}
                  </div>
                </div>

                <div className="gd-card-stats">
                  <StatRow label="Lots / live" value={`${s.lots} / ${s.liveLots}`} />
                  <StatRow label="Items" value={String(s.items)} />
                  <StatRow label="Units left" value={fmtQty(s.unitsLeft, '')} />
                  <StatRow label="Value left" value={s.valueLeft ? money(s.valueLeft) : '—'} strong />
                  {(s.expired > 0 || s.critical > 0) && (
                    <StatRow label="Expiry watch" tone={s.expired ? 'red' : 'amber'}
                      value={`${s.expired ? `${s.expired} expired` : ''}${s.expired && s.critical ? ' · ' : ''}${s.critical ? `${s.critical} soon` : ''}`} />
                  )}
                </div>

                <div className="gd-share">
                  <ProgressBar value={s.valueLeft} max={topValue}
                    color={isMain(g.id) ? 'var(--violet)' : g.archived ? 'var(--faint)' : 'var(--brand)'} />
                  <span className="gd-share-label">
                    {totals.value ? `${Math.round((s.valueLeft / totals.value) * 100)}% of the value on the register` : 'no value registered'}
                  </span>
                </div>

                {s.unplaced > 0 && (
                  <div className="gd-unplaced">
                    <Icon name="alert" size={13} strokeWidth={2.2} />
                    {s.unplaced} lot{s.unplaced === 1 ? '' : 's'} never placed — booked before godowns existed, or added without a place.
                  </div>
                )}

                {open && (
                  <div className="gd-lots">
                    {lots.length === 0 ? (
                      <p className="gd-lots-empty">No live lot stands here.</p>
                    ) : (
                      <>
                        <div className="gd-lots-head">In first-expiry order — what would leave this place</div>
                        {lots.map(v => (
                          <div key={v.id} className="gd-lot">
                            <span className="gd-lot-item">
                              <span className="gd-lot-name">{v.product_name || '—'}</span>
                              <span className="gd-lot-sub">lot {v.batch_no || '—'}{v.vendor ? ` · ${v.vendor}` : ''}</span>
                            </span>
                            <span className="gd-lot-exp">
                              <Badge tone={BATCH_STATUS_TONE[v.status]} dot={false}>{BATCH_STATUS_LABEL[v.status]}</Badge>
                              <span className="gd-lot-sub">{v.expiry_date ? formatDateIN(v.expiry_date) : 'no expiry'}</span>
                            </span>
                            <span className="gd-lot-right">
                              <span className="gd-lot-qty">{fmtQty(v.left, v.unit)}</span>
                              <span className="gd-lot-sub">{money(v.value)}</span>
                            </span>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}

                <div className="gd-card-foot">
                  <Button variant="ghost" size="sm" icon="list"
                    onClick={() => setOpenPlace(open ? '' : g.id)}>{open ? 'Hide lots' : 'See lots'}</Button>
                  <span className="gd-card-actions">
                    {!g.archived && s.liveLots > 0 && (
                      <Button variant="ghost" size="sm" icon="swap" title={`Move stock out of ${g.name}`}
                        onClick={() => openTransfer(g.id)}>Move out</Button>
                    )}
                    <Button variant="ghost" size="sm" icon="edit" title={`Edit ${g.name}`}
                      onClick={() => openEditor({ ...g }, false)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                    {g.archived
                      ? <Button variant="ghost" size="sm" icon="undo" title={`Reopen ${g.name}`}
                          onClick={() => reopenPlace(g)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                      : <Button variant="danger" size="sm" icon="x" title={`Archive ${g.name}`}
                          onClick={() => closePlace(s)} style={{ width: 32, padding: 0 }}>{' '}</Button>}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="gd-section">
        <div className="gd-section-head">
          <h2>
            <Icon name="truck" size={15} />
            Stock moves
          </h2>
          <span className="gd-section-sub">
            A move is a split: the units leave one lot and open another at the destination with the same batch, expiry and cost.
          </span>
          <Button variant="ghost" size="sm" icon="download" onClick={exportTransfers}
            disabled={history.length === 0} style={{ marginLeft: 'auto' }}>CSV</Button>
        </div>

        {history.length === 0 ? (
          <Card>
            <EmptyState icon="truck" title="Nothing has moved between places"
              message="Use Move out on a place, or Move stock at the top, to shift units from one godown to another. The movement log builds itself from those transfers." />
          </Card>
        ) : (
          <div className="table-frame">
            <div className="responsive-table">
              <div className="table-header gd-row gd-head">
                <span data-label="Date">Date</span>
                <span data-label="Item">Item / lot</span>
                <span className="gd-right" data-label="Qty">Qty</span>
                <span data-label="From">From</span>
                <span data-label="To">To</span>
                <span data-label="Ref">Ref</span>
              </div>
              {history.map((r: TransferRow, i) => (
                <div key={`${r.date}-${r.batch_no}-${r.ref}-${i}`} className="table-row gd-row">
                  <span data-label="Date" className="gd-mono">{formatDateIN(r.date)}</span>
                  <span data-label="Item" className="gd-item">
                    <span className="gd-item-name">{r.product}</span>
                    <span className="gd-sub">lot {r.batch_no}</span>
                  </span>
                  <span className="gd-right gd-num" data-label="Qty">{fmtQty(r.qty, r.unit)}</span>
                  <span data-label="From">{r.from}</span>
                  <span data-label="To" className="gd-to">
                    <Icon name="arrow-right" size={12} />{r.to}
                  </span>
                  <span data-label="Ref" className="gd-mono gd-sub">{r.ref || '—'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="gd-foot">
        <span>
          {stock.length} place{stock.length === 1 ? '' : 's'} · {totals.liveLots} live lot{totals.liveLots === 1 ? '' : 's'}
          {history.length ? ` · ${history.length} move${history.length === 1 ? '' : 's'} recorded` : ''}
        </span>
        <span className="gd-foot-links">
          <Link href="/inventory/batches">Batch register →</Link>
          <Link href="/inventory">Shelf counts →</Link>
          <Link href="/products">Products →</Link>
        </span>
      </div>

      {/* ── Godown editor ──────────────────────────────────────────────────── */}
      {editor && (
        <div className="gd-scrim" role="dialog" aria-modal="true"
          aria-label={editor.isNew ? 'Add godown' : `Edit ${editor.godown.name}`}>
          <div className="gd-modal" style={{ maxWidth: 560 }}>
            <div className="gd-modal-head">
              <div>
                <h2>{editor.isNew ? 'Add godown' : `Edit ${editor.godown.name}`}</h2>
                <p>A place is anywhere stock physically stands — a shop back-room, a rented godown, a third-party warehouse.</p>
              </div>
              <button type="button" className="gd-close" onClick={() => setEditor(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {editorError && (
              <div className="gd-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{editorError}</div>
            )}

            <div className="gd-grid2">
              <label className="gd-field">
                <span>Name *</span>
                <input className="tf-input" value={editor.godown.name}
                  onChange={e => patchEditor({ name: e.target.value })} placeholder="Andheri godown" autoFocus />
              </label>
              <label className="gd-field">
                <span>Code</span>
                <input className="tf-input" value={editor.godown.code}
                  onChange={e => patchEditor({ code: e.target.value })} placeholder="MH-02" />
              </label>
            </div>

            <label className="gd-field">
              <span>Address</span>
              <input className="tf-input" value={editor.godown.address}
                onChange={e => patchEditor({ address: e.target.value })} placeholder="Street, city, state" />
            </label>

            <label className="gd-field">
              <span>Contact</span>
              <input className="tf-input" value={editor.godown.contact}
                onChange={e => patchEditor({ contact: e.target.value })} placeholder="Keeper's name or phone" />
            </label>

            <label className="gd-field">
              <span>Notes</span>
              <textarea className="tf-input" rows={2} value={editor.godown.notes}
                onChange={e => patchEditor({ notes: e.target.value })}
                placeholder="Rented till March, cold storage, 2 bays…" style={{ resize: 'vertical' }} />
            </label>

            {isMain(editor.godown.id) && (
              <div className="gd-note">
                <Icon name="shield" size={13} strokeWidth={2.2} />
                This is the Main godown — lots with no place of their own read as standing here, so it can be renamed but never archived.
              </div>
            )}

            <div className="gd-save">
              <Button variant="ghost" onClick={() => setEditor(null)}>Cancel</Button>
              <Button icon="check" onClick={saveGodown}>{editor.isNew ? 'Add godown' : 'Save changes'}</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Move stock ─────────────────────────────────────────────────────── */}
      {transfer && (
        <div className="gd-scrim" role="dialog" aria-modal="true" aria-label="Move stock between godowns">
          <div className="gd-modal" style={{ maxWidth: 620 }}>
            <div className="gd-modal-head">
              <div>
                <h2>Move stock</h2>
                <p>Units leave a lot here and open as a lot at the destination — same batch number, same expiry, same cost.</p>
              </div>
              <button type="button" className="gd-close" onClick={() => setTransfer(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {transferError && (
              <div className="gd-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{transferError}</div>
            )}

            <div className="gd-grid2">
              <label className="gd-field">
                <span>From</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value={transfer.fromId}
                  onChange={e => {
                    const fromId = e.target.value
                    const first = lotsAt(views, godowns, fromId)[0]
                    patchTransfer({
                      fromId,
                      batchId: first?.id || '',
                      toId: transfer.toId === fromId ? '' : transfer.toId,
                    })
                  }}>
                  {godowns.filter(g => !g.archived).map(g => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </label>
              <label className="gd-field">
                <span>To *</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value={transfer.toId}
                  onChange={e => patchTransfer({ toId: e.target.value })}>
                  <option value="">Select destination…</option>
                  {godowns.filter(g => g.id !== transfer.fromId).map(g => (
                    <option key={g.id} value={g.id}>{g.name}{g.archived ? ' (archived)' : ''}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="gd-field">
              <span>Lot *</span>
              <select className="tf-input" style={{ cursor: 'pointer' }} value={transfer.batchId}
                onChange={e => patchTransfer({ batchId: e.target.value })}>
                {lotsAt(views, godowns, transfer.fromId).map(v => (
                  <option key={v.id} value={v.id}>
                    {v.product_name || '—'} · lot {v.batch_no} · {fmtQty(v.left, v.unit)} left
                    {v.expiry_date ? ` · exp ${formatDateIN(v.expiry_date)}` : ''}
                  </option>
                ))}
                {lotsAt(views, godowns, transfer.fromId).length === 0 && (
                  <option value="">No live lot at {godownById(godowns, transfer.fromId).name}</option>
                )}
              </select>
            </label>

            <div className="gd-grid2">
              <label className="gd-field">
                <span>Quantity *</span>
                <input className="tf-input" type="number" min="0" step="any" value={transfer.qty}
                  onChange={e => patchTransfer({ qty: e.target.value })} placeholder="0" />
              </label>
              <label className="gd-field">
                <span>Date</span>
                <input className="tf-input" type="date" value={transfer.date}
                  onChange={e => patchTransfer({ date: e.target.value })} />
              </label>
            </div>

            <div className="gd-grid2">
              <label className="gd-field">
                <span>Reference</span>
                <input className="tf-input" value={transfer.ref}
                  onChange={e => patchTransfer({ ref: e.target.value })}
                  placeholder="Vehicle no., e-way bill, chit…" />
              </label>
              <label className="gd-field">
                <span>Note</span>
                <input className="tf-input" value={transfer.note}
                  onChange={e => patchTransfer({ note: e.target.value })} placeholder="Why it moved" />
              </label>
            </div>

            {transferBatch && (
              <div className="gd-preview">
                <div className="gd-preview-head">
                  <span>This is what gets written</span>
                  <span className="gd-preview-total">
                    {transferCheck && transferCheck.ok
                      ? `${fmtQty(transferCheck.plan.sourceLeft, transferBatch.unit)} left behind`
                      : 'nothing yet'}
                  </span>
                </div>
                {transferCheck && transferCheck.ok ? (
                  <ul className="gd-preview-list">
                    <li>
                      <span className="gd-dot gd-dot-red" />
                      Lot {transferBatch.batch_no} at {godownOf(transferBatch, godowns).name} draws{' '}
                      {fmtQty(Number(transfer.qty), transferBatch.unit)} out
                      <span className="gd-preview-take">−{fmtQty(Number(transfer.qty), transferBatch.unit)}</span>
                    </li>
                    <li>
                      <span className="gd-dot gd-dot-green" />
                      New lot {transferBatch.batch_no} opens at {godownById(godowns, transfer.toId).name}
                      <span className="gd-preview-take">+{fmtQty(Number(transfer.qty), transferBatch.unit)}</span>
                    </li>
                    {transferBatch.expiry_date && (
                      <li>
                        <span className="gd-dot gd-dot-blue" />
                        Expiry travels with the units — {formatDateIN(transferBatch.expiry_date)}
                      </li>
                    )}
                  </ul>
                ) : (
                  <p className="gd-preview-empty">{transferCheck ? transferCheck.error : 'Pick a lot, a destination and a quantity.'}</p>
                )}
              </div>
            )}

            <div className="gd-note">
              <Icon name="alert" size={13} strokeWidth={2.2} />
              Sales billed in TaxFlow still draw lots first-expiry-first-out across every place. Narrowing a sale to one godown is a
              manual “Sell from stock” on the batch register.
            </div>

            <div className="gd-save">
              <Button variant="ghost" onClick={() => setTransfer(null)}>Cancel</Button>
              <Button icon="check" onClick={saveTransfer}
                disabled={!(transferCheck && transferCheck.ok)}>Record move</Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .gd-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .gd-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }

        .gd-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px;
          font-size: 12.5px; color: var(--green); background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 10px; }
        .gd-notice svg { flex-shrink: 0; }
        .gd-notice.is-bad { color: var(--amber); background: var(--amber-soft);
          border-color: color-mix(in srgb, var(--amber) 26%, white); }
        .gd-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; border-radius: 6px; min-height: 0; }
        .gd-notice-x:hover { background: rgba(0,0,0,0.05); }

        .gd-note { display: flex; align-items: flex-start; gap: 7px; padding: 9px 12px; border-radius: 10px;
          font-size: 12px; color: var(--muted); background: var(--surface-2); border: 1px solid var(--line-soft); line-height: 1.55; }
        .gd-note svg { flex-shrink: 0; margin-top: 2px; }
        .gd-note a { color: var(--brand); }

        .gd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
        .gd-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg);
          padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-xs); }
        .gd-card.is-archived { background: var(--surface-2); opacity: 0.86; }
        .gd-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .gd-card-title { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .gd-card-name { display: flex; align-items: center; gap: 7px; font-size: 14.5px; font-weight: 650; color: var(--ink); }
        .gd-card-name svg { color: var(--brand); flex-shrink: 0; }
        .gd-card-sub { font-size: 11.5px; color: var(--faint); line-height: 1.5; }
        .gd-card-badges { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
        .gd-card-stats { display: flex; flex-direction: column; }
        .gd-card-stats > div:last-child { border-bottom: none; }

        .gd-share { display: flex; flex-direction: column; gap: 5px; }
        .gd-share-label { font-size: 11px; color: var(--faint); }
        .gd-unplaced { display: flex; align-items: flex-start; gap: 6px; font-size: 11.5px; color: var(--amber);
          background: var(--amber-soft); border-radius: 8px; padding: 8px 10px; line-height: 1.5; }
        .gd-unplaced svg { flex-shrink: 0; margin-top: 1px; }

        .gd-lots { border-top: 1px dashed var(--line); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
        .gd-lots-head { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .gd-lots-empty { font-size: 12px; color: var(--faint); margin: 0; }
        .gd-lot { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto; gap: 8px; align-items: center;
          padding: 7px 9px; background: var(--surface-2); border-radius: 9px; font-size: 12px; }
        .gd-lot-item, .gd-lot-exp, .gd-lot-right { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .gd-lot-right { align-items: flex-end; }
        .gd-lot-name { font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
        .gd-lot-qty { font-weight: 650; color: var(--ink); font-variant-numeric: tabular-nums; }
        .gd-lot-sub { font-size: 10.5px; color: var(--faint); }

        .gd-card-foot { display: flex; align-items: center; gap: 6px; margin-top: auto; }
        .gd-card-actions { display: flex; gap: 6px; margin-left: auto; }

        .gd-section { margin-top: 26px; display: flex; flex-direction: column; gap: 10px; }
        .gd-section-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
        .gd-section-head h2 { display: flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 650; color: var(--ink); margin: 0; }
        .gd-section-head h2 svg { color: var(--brand); }
        .gd-section-sub { font-size: 11.5px; color: var(--faint); max-width: 620px; line-height: 1.5; }

        .gd-row { display: grid; grid-template-columns: 110px minmax(0, 1.4fr) 90px minmax(0, 1fr) minmax(0, 1fr) 130px;
          gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .gd-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .gd-right { text-align: right; justify-content: flex-end; }
        .gd-num { font-variant-numeric: tabular-nums; color: var(--ink-2); }
        .gd-mono { font-family: var(--mono); font-size: 11.5px; }
        .gd-sub { font-size: 11px; color: var(--faint); }
        .gd-item { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .gd-item-name { font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
        .gd-to { display: flex; align-items: center; gap: 6px; color: var(--ink-2); }
        .gd-to svg { color: var(--brand); flex-shrink: 0; }

        .gd-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          font-size: 11.5px; color: var(--faint); margin-top: 14px; }
        .gd-foot-links { display: flex; gap: 12px; }
        .gd-foot-links a { color: var(--brand); text-decoration: none; }

        .gd-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .gd-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .gd-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .gd-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .gd-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; max-width: 460px; line-height: 1.5; }
        .gd-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; flex-shrink: 0; min-height: 0; }
        .gd-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .gd-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .gd-alert svg { flex-shrink: 0; }

        .gd-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
        .gd-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .gd-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }

        .gd-preview { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--surface-2); }
        .gd-preview-head { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .gd-preview-total { color: var(--brand); font-variant-numeric: tabular-nums; }
        .gd-preview-empty { font-size: 12.5px; color: var(--red); margin: 8px 0 0; }
        .gd-preview-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .gd-preview-list li { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; color: var(--ink-2); line-height: 1.5; }
        .gd-preview-take { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 650; color: var(--ink); }
        .gd-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; }
        .gd-dot-red { background: var(--red); }
        .gd-dot-green { background: var(--green); }
        .gd-dot-blue { background: var(--brand); }

        .gd-save { display: flex; gap: 10px; justify-content: flex-end; }

        @media (max-width: 1100px) { .gd-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .gd-row { grid-template-columns: 1fr; gap: 6px; }
          .gd-head { display: none; }
          .gd-right { text-align: left; }
          .gd-stats { grid-template-columns: 1fr 1fr; }
          .gd-grid { grid-template-columns: 1fr; }
          .gd-grid2 { grid-template-columns: 1fr; }
          .gd-scrim { align-items: flex-end; padding: 0; }
          .gd-scrim .gd-modal { max-width: none !important; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .gd-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}

export default function GodownsPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <GodownsPageInner />
    </Suspense>
  )
}
