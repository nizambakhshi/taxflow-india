'use client'

// Business setup — where the shop operates, and what its papers are called.
//
// The engine (src/lib/setup.ts) owns the model: a branch register and a document-series
// register, kept in this browser under `taxflow:setup:<orgId>`. This page is the shop's
// own desk for both — the branches it issues from, the shapes its numbers wear, and the
// refusals the engine prints when a row would cost the books their honesty.
//
// Three boundaries are printed rather than implied:
//
//  * **The counters stayed where they were.** This register dresses a number; it does not
//    count. Change a prefix mid-year and documents already issued keep the numbers they were
//    born with — the high-water read covers every shape a kind has worn.
//  * **This is what the paper prints, not what the government holds.** The durable GST record
//    is the primary registration in Settings; statutory pages (GSTR-1, e-invoicing) still sign
//    with it. A branch row is the shop's own statement of where it operates — which is exactly
//    why its GSTIN and state code must agree with each other before it may stamp a document.
//  * **No rupee lives here.** The opening balances the balance sheet starts on — including the
//    bank, receivable and payable lines and the day the books opened — are edited on the
//    Financial statements page. This register answers *where* and *what it is called*, never *how much*.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { getFinancialYear } from '@/lib/gst-engine'
import { INDIAN_STATES } from '@/lib/constants'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import {
  BRANCH_CSV_HEADERS, SERIES_CSV_HEADERS, branchCsvRows, clearSeries, deleteBranch, headBranch,
  isOverridden, loadSetup, newBranch, resolveSeries, seriesCsvRows, seriesSentence,
  setBranchActive, setHead, writeBranch, writeSeries,
  type Branch, type SeriesKind, type SeriesRow, type SeriesFormat, type SetupStore,
  SERIES_KINDS, SERIES_KIND_LABEL, composeNumber,
} from '@/lib/setup'
import {
  Badge, Button, Card, EmptyState, PageHeader, SearchInput, SectionTitle, Segmented, StatCard,
  useDialog,
} from '@/components/ui'
import Icon from '@/components/Icons'

type Tab = 'branches' | 'series'

const TABS: { value: Tab; label: string }[] = [
  { value: 'branches', label: 'Branches' },
  { value: 'series', label: 'Document series' },
]

const stateName = (code: string) => INDIAN_STATES.find(s => s.value === code)?.label || code

function BranchRowCard({ b, onEdit, onHead, onClose, onOpen, onDelete }: {
  b: Branch
  onEdit: () => void
  onHead: () => void
  onClose: () => void
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <div className={`bu-card ${b.active ? '' : 'is-closed'}`}>
      <div className="bu-card-head">
        <div className="bu-card-title">
          <Icon name="building" size={17} />
          <div>
            <div className="bu-card-name">{b.code} — {b.name}</div>
            <div className="bu-card-sub">
              <span className="bu-mono">{b.gstin}</span> · {stateName(b.state_code)}
              {b.city ? ` · ${b.city}` : ''}
            </div>
          </div>
        </div>
        <div className="bu-card-badges">
          {b.is_head && <Badge tone="blue" dot={false}>Head office</Badge>}
          <Badge tone={b.active ? 'green' : 'grey'}>{b.active ? 'Open' : 'Closed'}</Badge>
        </div>
      </div>

      {b.address && <div className="bu-card-addr">{b.address}{b.city ? `, ${b.city}` : ''}</div>}
      {b.phone && <div className="bu-card-sub">Phone {b.phone}</div>}
      {b.notes && <div className="bu-card-note">{b.notes}</div>}

      <div className="bu-card-foot">
        <Button variant="ghost" size="sm" icon="edit" onClick={onEdit}>Edit</Button>
        {!b.is_head && b.active && (
          <Button variant="ghost" size="sm" onClick={onHead}>Make head</Button>
        )}
        {b.active && !b.is_head && (
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        )}
        {!b.active && <Button variant="ghost" size="sm" onClick={onOpen}>Reopen</Button>}
        <span className="bu-del"><Button variant="ghost" size="sm" onClick={onDelete}>Delete</Button></span>
      </div>
    </div>
  )
}

function BusinessPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [loading, setLoading] = useState(true)
  const [store, setStore] = useState<SetupStore>({ version: 1, updatedAt: '', orgId: '', branches: [], series: [] })

  const [tab, setTab] = useState<Tab>('branches')
  const [search, setSearch] = useSearchDeepLink()
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)

  // Branch editor — `draft` non-null means the modal is open.
  const [draft, setDraft] = useState<Branch | null>(null)
  const branchDialog = useDialog(() => setDraft(null))
  const [branchProblems, setBranchProblems] = useState<string[]>([])

  // Series editor — `editRow` is the working copy of one kind's format.
  const [editRow, setEditRow] = useState<SeriesRow | null>(null)
  const seriesDialog = useDialog(() => setEditRow(null))
  const [seriesProblems, setSeriesProblems] = useState<string[]>([])

  const fy = getFinancialYear()

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

      const oid = membership.organization_id
      setOrgId(oid)
      setStore(loadSetup(oid))

      const t = searchParams.get('tab')
      if (t === 'branches' || t === 'series') setTab(t)
      // ?new=1 — open the branch editor straight away (palette / deep link).
      if (searchParams.get('new') === '1') openCreate(loadSetup(oid))
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const head = useMemo(() => headBranch(store), [store])
  const openCount = useMemo(() => store.branches.filter(b => b.active).length, [store])
  const overrides = useMemo(() => store.series.length, [store])

  const visibleBranches = useMemo(
    () => store.branches.filter(b => matchesAny(search,
      [b.code, b.name, b.gstin, b.city, b.address, b.notes, stateName(b.state_code)]))
      .slice().sort((x, y) => Number(y.is_head) - Number(x.is_head) || x.code.localeCompare(y.code)),
    [store, search],
  )

  function flash(msg: string, bad = false) {
    setNotice({ msg, bad })
    setTimeout(() => setNotice(null), 5000)
  }

  // ── branches ────────────────────────────────────────────────────────────────

  function openCreate(current: SetupStore = store) {
    const b = newBranch()
    // The first branch on an empty register is the head — there is no other office yet.
    if (current.branches.length === 0) b.is_head = true
    setDraft(b)
    setBranchProblems([])
  }

  function openEdit(b: Branch) {
    setDraft({ ...b })
    setBranchProblems([])
  }

  function saveBranch() {
    if (!draft || !orgId) return
    const res = writeBranch(orgId, draft)
    if (!res.ok) { setBranchProblems(res.problems); return }
    setStore(res.store)
    setDraft(null)
    // writeBranch just upserted it, so the row is on the register by construction — name it, do not re-check.
    flash(`${draft.code || draft.name} is on the register.`)
  }

  function makeHead(b: Branch) {
    if (!orgId) return
    const res = setHead(orgId, b.id)
    if (!res.ok) { flash(res.problem, true); return }
    setStore(res.store)
    flash(`${b.code} is now the head office — new documents print under it by default.`)
  }

  function setOpen(b: Branch, active: boolean) {
    if (!orgId) return
    const res = setBranchActive(orgId, b.id, active)
    if (!res.ok) { flash(res.problem, true); return }
    setStore(res.store)
    flash(active
      ? `${b.code} is open again — the invoice form offers it.`
      : `${b.code} is closed. Old papers still resolve to it; history does not go out of business.`, !active)
  }

  // Delete is only honest once no document names the branch — and the invoice notes are the
  // stamp's home, so the answer is read from the books, not from the modal that asks for it.
  async function removeBranch(b: Branch) {
    if (!orgId) return
    if (!confirm(`Delete branch ${b.code} — ${b.name}? Documents already stamped with it are never rewritten.`)) return
    const { data } = await supabase
      .from('invoices')
      .select('id')
      .eq('organization_id', orgId)
      .ilike('notes', `%[branch ${b.code}]%`)
    const res = deleteBranch(orgId, b.id, (data?.length ?? 0) > 0)
    if (!res.ok) {
      setBranchProblems(res.problems)
      setDraft(b) // open the editor with the refusal printed — the shop reads it before retrying
      setTab('branches')
      return
    }
    setStore(res.store)
    flash(`${b.code} was removed — no document carried its name.`)
  }

  function exportBranches() {
    download(`taxflow-branches-${fy}.csv`, toCsv(BRANCH_CSV_HEADERS, branchCsvRows(store.branches)))
  }

  // ── series ──────────────────────────────────────────────────────────────────

  function openSeriesEdit(kind: SeriesKind) {
    const fmt = resolveSeries(store, kind)
    setEditRow({ kind, ...fmt, updated_at: '' })
    setSeriesProblems([])
  }

  function saveSeries() {
    if (!editRow || !orgId) return
    const res = writeSeries(orgId, editRow)
    if (!res.ok) { setSeriesProblems(res.problems); return }
    setStore(res.store)
    const pluralLabel = SERIES_KIND_LABEL[editRow.kind].plural
    setEditRow(null)
    flash(`${pluralLabel} now wear ${res.store.series.find(s => s.kind === editRow.kind)?.prefix}… — from the next number onwards.`)
  }

  function revertSeries(kind: SeriesKind) {
    if (!orgId) return
    setStore(clearSeries(orgId, kind))
    flash(`${SERIES_KIND_LABEL[kind].plural} are back to the shape they were born with.`)
  }

  function exportSeries() {
    download(`taxflow-document-series-${fy}.csv`, toCsv(SERIES_CSV_HEADERS, seriesCsvRows(store, fy)))
  }

  if (loading) {
    return <div className="bu-wrap"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the register…</p></div>
  }

  const editPreview: SeriesFormat = editRow
    ? { prefix: (editRow.prefix || '').trim().toUpperCase() || '…', pad: editRow.pad, include_fy: editRow.include_fy }
    : { prefix: '', pad: 4, include_fy: true }

  return (
    <div className="bu-wrap">
      <PageHeader
        eyebrow="Account"
        title="Business setup"
        subtitle="The offices the shop issues from, and the shapes its document numbers wear. The counters keep counting where they always did — this register only dresses them."
        actions={
          tab === 'branches'
            ? <Button icon="building" onClick={() => openCreate()}>Add branch</Button>
            : <Button icon="edit" onClick={() => openSeriesEdit('invoice')}>Edit a series</Button>
        }
      />

      {notice && (
        <div className={`bu-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
          <Icon name={notice.bad ? 'alert' : 'check'} size={14} strokeWidth={2.2} />
          <span>{notice.msg}</span>
          <button type="button" className="bu-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      <div className="bu-stats">
        <StatCard label="Branches" value={String(store.branches.length)} icon="building" tone="blue"
          sub={openCount === store.branches.length ? 'all open' : `${openCount} open · ${store.branches.length - openCount} closed`} delay={0} />
        <StatCard label="Head office" value={head ? head.code : '—'} icon="lock" tone={head ? 'green' : 'grey'}
          sub={head ? head.name : 'no head yet — first branch becomes one'} delay={60} />
        <StatCard label="Series overrides" value={String(overrides)} icon="invoice" tone={overrides ? 'violet' : 'grey'}
          sub={overrides ? 'dressed by the shop' : 'all wearing the built-in shape'} delay={120} />
        <StatCard label="Financial year" value={fy} icon="calendar" tone="amber"
          sub="April → March; FY-shaped series reset with it" delay={180} />
      </div>

      <div className="bu-toolbar">
        <Segmented options={TABS} value={tab} onChange={v => setTab(v as Tab)} />
        <SearchInput value={search} onChange={setSearch} ariaLabel="Search the register"
          placeholder={tab === 'branches' ? 'Search branches…' : 'Search the series table…'} style={{ width: 240 }} />
        <span className="bu-export">
          <Button variant="ghost" size="sm" icon="download"
            onClick={tab === 'branches' ? exportBranches : exportSeries}
            disabled={tab === 'branches' ? store.branches.length === 0 : true}>
            Export {tab === 'branches' ? 'branches' : 'series'}
          </Button>
        </span>
      </div>

      {/* ── Branches ─────────────────────────────────────────────────────── */}
      {tab === 'branches' && (
        visibleBranches.length === 0
          ? (
            <EmptyState icon="building"
              title={store.branches.length === 0 ? 'No branch on the register' : 'Nothing matches'}
              message={store.branches.length === 0
                ? 'One office per GSTIN: a branch is a full registration — its 15-character GSTIN and the state code that GSTIN starts with, or the row is refused. A shop with a single registration does not need this page at all.'
                : 'No branch matches this search.'}
              action={store.branches.length === 0
                ? <Button icon="building" onClick={() => openCreate()}>Add branch</Button>
                : <Button variant="ghost" onClick={() => setSearch('')}>Clear search</Button>} />
          ) : (
            <div className="bu-grid">
              {visibleBranches.map(b => (
                <BranchRowCard key={b.id} b={b}
                  onEdit={() => openEdit(b)}
                  onHead={() => makeHead(b)}
                  onClose={() => setOpen(b, false)}
                  onOpen={() => setOpen(b, true)}
                  onDelete={() => removeBranch(b)} />
              ))}
            </div>
          )
      )}

      {/* ── Series ───────────────────────────────────────────────────────── */}
      {tab === 'series' && (
        <Card className="bu-stable">
          <SectionTitle icon="invoice">The five kinds this app numbers</SectionTitle>
          {SERIES_KINDS.map(kind => {
            const overridden = isOverridden(store, kind)
            return (
              <div key={kind} className="bu-srow">
                <div className="bu-skind">
                  <div className="bu-sname">
                    {SERIES_KIND_LABEL[kind].label}
                    <Link href={SERIES_KIND_LABEL[kind].href} className="bu-slink">{SERIES_KIND_LABEL[kind].plural} →</Link>
                  </div>
                  <div className="bu-ssent">{seriesSentence(store, kind, fy)}</div>
                </div>
                <Badge tone={overridden ? 'blue' : 'grey'} dot={false}>{overridden ? 'Your shape' : 'As built'}</Badge>
                <span className="bu-sact">
                  <Button variant="ghost" size="sm" icon="edit" onClick={() => openSeriesEdit(kind)}>Edit</Button>
                  {overridden && <Button variant="ghost" size="sm" onClick={() => revertSeries(kind)}>Default</Button>}
                </span>
              </div>
            )
          })}
          <p className="bu-snote">
            Changing a shape is safe mid-year: numbers already issued keep the shape they were born with, and the
            high-water read covers every shape a kind has worn — so nothing gets numbered twice. Credit and debit
            notes and purchase bills are still typed by hand (the portal or the supplier numbers those), and the
            financial year itself stays April → March.
          </p>
        </Card>
      )}

      {/* ── What this register is not ─────────────────────────────────────── */}
      <div className="bu-bounds">
        <div className="bu-bounds-col">
          <SectionTitle icon="building">Where the branch prints</SectionTitle>
          <p className="bu-bounds-note">
            The invoice form offers the <strong>Issuing branch</strong> under the seller card. Picking one swaps the
            printed name, GSTIN, state and address, and stamps the notes with <span className="bu-mono">[branch CODE]</span>
            — the durable record is the document plus that tag. The print page reads the stamp back; a branch deleted
            after its papers leaves the page <em>showing a named fallback</em>, never a silent substitution.
          </p>
        </div>
        <div className="bu-bounds-col">
          <SectionTitle icon="alert">What this register is not</SectionTitle>
          <div className="bu-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>It holds no rupee — the opening balances and the day the books opened live on the <Link href="/accounting">Financial statements</Link> page.</span></div>
          <div className="bu-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>It is not the government’s record. The primary registration in Settings still signs the statutory pages (GSTR-1, e-invoicing); a branch here is what your paper prints.</span></div>
          <div className="bu-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>It counts nothing. The sequence rows in Supabase and the order registers’ own counters stayed exactly where they were.</span></div>
          <div className="bu-fact"><Icon name="x" size={13} strokeWidth={2.2} /><span>It lives in this browser (ADR-013) and travels inside the <Link href="/vault">books vault</Link>, never on its own.</span></div>
        </div>
      </div>

      <div className="bu-foot">
        <span>Branches and series are stored in this browser at <span className="bu-mono">taxflow:setup:&lt;org&gt;</span>.</span>
        <span className="bu-foot-links">
          <Link href="/vault">Books vault →</Link>
          <Link href="/invoices/new">New invoice →</Link>
          <Link href="/accounting">Opening balances →</Link>
        </span>
      </div>

      {/* ── Branch editor ─────────────────────────────────────────────────── */}
      {draft && (
        <div ref={branchDialog} className="bu-scrim" role="dialog" aria-modal="true" aria-label="Branch details">
          <div className="bu-modal">
            <div className="bu-modal-head">
              <div>
                <h2>{store.branches.some(b => b.id === draft.id) ? `Edit ${draft.code}` : 'A new branch'}</h2>
                <p>
                  A branch is a registration: its own 15-character GSTIN, and the state code the GSTIN starts with —
                  the pair that place of supply and the CGST/SGST split read. The engine refuses a row where they disagree.
                </p>
              </div>
              <button type="button" className="bu-close" onClick={() => setDraft(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {branchProblems.length > 0 && (
              <div className="bu-alert" role="alert">
                {branchProblems.map(p => <div key={p}><Icon name="alert" size={13} strokeWidth={2.2} /> {p}</div>)}
              </div>
            )}

            <div className="bu-fields">
              <label className="bu-field bu-w1">
                <span>Code *</span>
                <input className="tf-input" value={draft.code} placeholder="BLR"
                  onChange={e => setDraft({ ...draft, code: e.target.value.toUpperCase() })} autoFocus />
                <span className="bu-hint">Short, caps — it is what a document stamps.</span>
              </label>
              <label className="bu-field bu-w2">
                <span>Branch name *</span>
                <input className="tf-input" value={draft.name} placeholder="Bengaluru warehouse office"
                  onChange={e => setDraft({ ...draft, name: e.target.value })} />
                <span className="bu-hint">Printed as the seller name on documents issued here.</span>
              </label>
              <label className="bu-field bu-w2">
                <span>GSTIN *</span>
                <input className="tf-input bu-mono" value={draft.gstin} placeholder="29ABCDE1234F1Z5" maxLength={15}
                  onChange={e => {
                    const gstin = e.target.value.toUpperCase()
                    // the state is read out of the GSTIN — editable only to agree with it
                    setDraft({ ...draft, gstin, state_code: /^[0-9]{2}/.test(gstin) ? gstin.slice(0, 2) : draft.state_code })
                  }} />
                <span className="bu-hint">15 characters, shape-checked here; the checksum digit is the portal’s call.</span>
              </label>
              <label className="bu-field bu-w1">
                <span>State</span>
                <select className="tf-input" value={draft.state_code}
                  onChange={e => setDraft({ ...draft, state_code: e.target.value })}>
                  <option value="">— from the GSTIN —</option>
                  {INDIAN_STATES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
                <span className="bu-hint">Locked to the GSTIN’s first two digits while it types.</span>
              </label>
              <label className="bu-field bu-w3">
                <span>Address</span>
                <input className="tf-input" value={draft.address} placeholder="12 Industrial Layout, Stage 2"
                  onChange={e => setDraft({ ...draft, address: e.target.value })} />
              </label>
              <label className="bu-field bu-w1">
                <span>City</span>
                <input className="tf-input" value={draft.city} onChange={e => setDraft({ ...draft, city: e.target.value })} />
              </label>
              <label className="bu-field bu-w1">
                <span>Phone</span>
                <input className="tf-input" value={draft.phone} onChange={e => setDraft({ ...draft, phone: e.target.value })} />
              </label>
              <label className="bu-field bu-w3">
                <span>Notes</span>
                <textarea className="tf-input" rows={2} value={draft.notes} style={{ resize: 'vertical' }}
                  placeholder="Warehouse hours, the person who signs here…"
                  onChange={e => setDraft({ ...draft, notes: e.target.value })} />
              </label>
              <label className="bu-check">
                <input type="checkbox" checked={draft.is_head}
                  onChange={e => setDraft({ ...draft, is_head: e.target.checked })} />
                <span>Head office — ticking this hands the head over in one write; the invoice form prints it by default.</span>
              </label>
            </div>

            <div className="bu-save">
              <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
              <Button icon="check" onClick={saveBranch}>Save branch</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Series editor ─────────────────────────────────────────────────── */}
      {editRow && (
        <div ref={seriesDialog} className="bu-scrim" role="dialog" aria-modal="true" aria-label={`Series for ${SERIES_KIND_LABEL[editRow.kind].label}`}>
          <div className="bu-modal" style={{ maxWidth: 500 }}>
            <div className="bu-modal-head">
              <div>
                <h2>{SERIES_KIND_LABEL[editRow.kind].plural} — the shape of the number</h2>
                <p>
                  Three dials: what it starts with, how many digits the count wears, and whether the financial year sits
                  inside it. The counter itself does not move — the next document simply gets the same count in this shape.
                </p>
              </div>
              <button type="button" className="bu-close" onClick={() => setEditRow(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {seriesProblems.length > 0 && (
              <div className="bu-alert" role="alert">
                {seriesProblems.map(p => <div key={p}><Icon name="alert" size={13} strokeWidth={2.2} /> {p}</div>)}
              </div>
            )}

            <div className="bu-fields">
              <label className="bu-field bu-w2">
                <span>Prefix *</span>
                <input className="tf-input bu-mono" value={editRow.prefix} placeholder="INV"
                  onChange={e => setEditRow({ ...editRow, prefix: e.target.value.toUpperCase() })} autoFocus />
                <span className="bu-hint">Letters, digits and inner dashes; up to eight characters. Two kinds with one prefix would issue the same number twice — refused.</span>
              </label>
              <label className="bu-field bu-w1">
                <span>Count digits</span>
                <input className="tf-input" type="number" min={1} max={8} value={editRow.pad}
                  onChange={e => setEditRow({ ...editRow, pad: Number(e.target.value) || 0 })} />
                <span className="bu-hint">1 to 8 — 0001 is four digits.</span>
              </label>
              <label className="bu-check">
                <input type="checkbox" checked={editRow.include_fy}
                  onChange={e => setEditRow({ ...editRow, include_fy: e.target.checked })} />
                <span>Year inside the number — resets each April. Unticked, the series carries one running count across years.</span>
              </label>
            </div>

            <div className="bu-preview">
              <span className="bu-preview-label">A number in this shape</span>
              <span className="bu-preview-num bu-mono">{composeNumber(editPreview, 1, fy)}</span>
            </div>

            <div className="bu-save">
              <Button variant="ghost" onClick={() => setEditRow(null)}>Cancel</Button>
              <Button icon="check" onClick={saveSeries}>Save series</Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .bu-wrap { display: flex; flex-direction: column; }
        .bu-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }

        .bu-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px;
          font-size: 12.5px; color: var(--green); background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 10px; }
        .bu-notice svg { flex-shrink: 0; }
        .bu-notice.is-bad { color: var(--amber); background: var(--amber-soft);
          border-color: color-mix(in srgb, var(--amber) 26%, white); }
        .bu-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; border-radius: 6px; min-height: 0; }
        .bu-notice-x:hover { background: rgba(0,0,0,0.05); }

        .bu-alert { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .bu-alert div { display: flex; align-items: flex-start; gap: 7px; line-height: 1.5; }
        .bu-alert svg { flex-shrink: 0; margin-top: 2px; }

        .bu-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
        .bu-export { margin-left: auto; }

        .bu-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
        .bu-card { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--brand);
          border-radius: var(--radius-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; box-shadow: var(--shadow-xs); }
        .bu-card.is-closed { border-left-color: var(--faint); background: var(--surface-2); opacity: 0.92; }
        .bu-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .bu-card-title { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
        .bu-card-title svg { color: var(--brand); flex-shrink: 0; margin-top: 2px; }
        .bu-card.is-closed .bu-card-title svg { color: var(--faint); }
        .bu-card-name { font-size: 14.5px; font-weight: 650; color: var(--ink); overflow-wrap: anywhere; }
        .bu-card-sub { font-size: 11.5px; color: var(--faint); }
        .bu-card-addr { font-size: 12px; color: var(--ink-2); line-height: 1.5; }
        .bu-card-note { font-size: 12px; color: var(--ink-2); line-height: 1.55; background: var(--surface-2);
          border-radius: 9px; padding: 8px 10px; }
        .bu-card-badges { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; }
        .bu-card-foot { display: flex; align-items: center; gap: 8px; margin-top: 2px; flex-wrap: wrap; }
        .bu-del { margin-left: auto; }

        .bu-stable { margin-bottom: 1rem; }
        .bu-srow { display: flex; align-items: center; gap: 12px; padding: 11px 0; border-top: 1px solid var(--line-soft); }
        .bu-skind { min-width: 0; flex: 1; }
        .bu-sname { font-size: 13.5px; font-weight: 650; color: var(--ink); display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
        .bu-slink { font-size: 11px; font-weight: 600; color: var(--faint); text-decoration: none; }
        .bu-slink:hover { color: var(--brand); }
        .bu-ssent { font-size: 11.5px; color: var(--muted); margin-top: 3px; line-height: 1.5; }
        .bu-sact { display: flex; gap: 6px; flex-shrink: 0; }
        .bu-snote { font-size: 11.5px; color: var(--muted); line-height: 1.6; margin: 12px 0 0;
          border-top: 1px dashed var(--line); padding-top: 10px; }

        .bu-bounds { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 1.15rem 0 0; }
        .bu-bounds-col { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 15px 16px; }
        .bu-bounds-note { font-size: 12px; color: var(--muted); line-height: 1.65; margin: 0; }
        .bu-bounds-note strong { color: var(--ink-2); font-weight: 650; }
        .bu-bounds-note em { color: var(--ink-2); }
        .bu-fact { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--muted); line-height: 1.55; padding: 6px 0; }
        .bu-fact svg { flex-shrink: 0; margin-top: 2px; color: var(--faint); }
        .bu-fact a { color: var(--brand); }

        .bu-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          font-size: 11.5px; color: var(--faint); margin-top: 18px; }
        .bu-foot-links { display: flex; gap: 12px; flex-wrap: wrap; }
        .bu-mono { font-family: var(--mono); font-size: 0.94em; }

        .bu-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .bu-modal { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg);
          padding: 1.4rem 1.5rem; width: 100%; max-width: 620px; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .bu-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .bu-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .bu-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; line-height: 1.55; }
        .bu-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px;
          border-radius: 6px; flex-shrink: 0; min-height: 0; }
        .bu-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .bu-fields { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
        .bu-field { display: flex; flex-direction: column; gap: 4px; }
        .bu-field > span:first-child { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .bu-w1 { grid-column: span 2; }
        .bu-w2 { grid-column: span 4; }
        .bu-w3 { grid-column: span 6; }
        .bu-hint { font-size: 10.5px; color: var(--faint); line-height: 1.5; }
        .bu-check { grid-column: span 6; display: flex; align-items: flex-start; gap: 9px; font-size: 12px;
          color: var(--ink-2); line-height: 1.5; cursor: pointer; }
        .bu-check input { margin-top: 2px; flex-shrink: 0; }

        .bu-preview { display: flex; align-items: center; justify-content: space-between; gap: 10px;
          border: 1px dashed var(--line); border-radius: 10px; padding: 10px 14px; background: var(--surface-2); }
        .bu-preview-label { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .bu-preview-num { font-size: 15px; font-weight: 700; color: var(--brand); }
        .bu-save { display: flex; gap: 10px; justify-content: flex-end; }

        @media (max-width: 1100px) { .bu-stats { grid-template-columns: 1fr 1fr; } .bu-bounds { grid-template-columns: 1fr; } }
        @media (max-width: 768px) {
          .bu-grid { grid-template-columns: 1fr; }
          .bu-srow { flex-wrap: wrap; }
          .bu-sact { margin-left: auto; }
          .bu-export { margin-left: 0; }
          .bu-scrim { align-items: flex-end; padding: 0; }
          .bu-scrim .bu-modal { max-width: none; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .bu-fields { grid-template-columns: 1fr; }
          .bu-w1, .bu-w2, .bu-w3 { grid-column: span 1; }
          .bu-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}

export default function BusinessPage() {
  return (
    <Suspense fallback={<div className="bu-wrap"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <BusinessPageInner />
    </Suspense>
  )
}
