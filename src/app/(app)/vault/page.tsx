'use client'

// The books vault — one file holding every register this browser keeps.
//
// Why this page exists: the documents (invoices, bills, customers, products) live in Supabase and
// come back with the login. What does *not* come back is the judgement — the LUT numbers, the batch
// and serial registers, the godowns, the recipes, the cost-centre splits, the job-work lots, the
// ITC-reversal figures, the TDS section choices, the targets, the calendar's done-flags. Twenty-five
// registers and five evidence logs live under `taxflow:<name>:<orgId>` on one device (ADR-013).
// Clear the browser, change the machine, and a year of workpapers is gone — including the ones no
// return can reconstruct.
//
// The engine (src/lib/vault.ts) owns four properties plus one memory, and this page shows each one
// rather than lean on it:
//
//  * The file is built from a **named list** of registers, never from a sweep of localStorage, so a
//    Supabase session key cannot ride into a backup. The Registers tab prints that list.
//  * A restore goes **through the module that owns the key** — so the page prints the rows the app
//    can *see* after the write, which may be fewer than the rows the file held. "Read back 2" is on
//    the report, not buried in it.
//  * Every block carries its own **checksum**, so a truncated download or a hand-edit loses one
//    register, not the book. The plan prints "Refused" against that one row.
//  * The five logs are **shown, never restored** — a restore would replay a pending sync or re-claim
//    an e-way bill number the portal owns.
//  * Since R3-9 the vault's own log remembers a **fingerprint per register** at the moment a backup
//    is taken. The Registers tab reads this browser against those fingerprints and answers the
//    question a wipe makes urgent — *is my newest file still the newest copy?* — by checksum, never
//    by timestamp, and never from the file itself (that copy is elsewhere and this screen cannot know
//    what it became).
//
// Nothing here files anything or touches the database. The button downloads a file; the picker reads
// one; the restore writes the registers and then says what the pages could read back.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN } from '@/lib/format'
import {
  LARGE_VAULT_CHARS, NOT_IN_THE_VAULT, PLAN_STATE_META, REGISTERS, VAULT_FAULT_COPY,
  applyRestore, atRiskRows, browseRegisters, collectVault, daysSinceBackup, defaultSelection, downloadVault,
  FRESHNESS_META, loadVaultLog, planRestore, readFileText, readVault, recordBackup, registerFreshness,
  serializeVault, vaultFilename,
  type FreshRow, type FreshnessReport, type PlanRow, type RegisterBrowse, type RestorePlan,
  type RestoreReport, type VaultEvent, type VaultFile, type VaultGroup,
} from '@/lib/vault'
import {
  Badge, Button, Card, EmptyState, PageHeader, SectionTitle, Segmented, StatCard, StatRow, SearchInput,
} from '@/components/ui'
import Icon from '@/components/Icons'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import {
  CLASS_META, PERSISTENCE_BOUNDARIES, PERSISTENCE_CSV_HEADERS, PERSISTENCE_READINGS, SEAL_META,
  persistenceCsvRows, persistencePlan, persistenceTotals, readNotDoorRows, sealClaimGaps, sealClaims,
  type PersistenceClass,
} from '@/lib/persistence'

type Tab = 'backup' | 'restore' | 'registers' | 'inside' | 'persistence'

const TABS: { value: Tab; label: string }[] = [
  { value: 'backup', label: 'Backup' },
  { value: 'restore', label: 'Restore' },
  { value: 'registers', label: 'Registers' },
  { value: 'inside', label: 'Not in this file' },
  { value: 'persistence', label: 'Server plan' },
]

type GroupFilter = 'all' | VaultGroup

const GROUP_FILTERS: { value: GroupFilter; label: string }[] = [
  { value: 'all', label: `All ${REGISTERS.length}` },
  { value: 'inventory', label: 'Stock' },
  { value: 'paperwork', label: 'Paperwork' },
  { value: 'workpapers', label: 'Workpapers' },
  { value: 'settings', label: 'Settings' },
  { value: 'evidence', label: 'Evidence' },
]

const GROUP_ORDER: VaultGroup[] = ['inventory', 'paperwork', 'workpapers', 'settings', 'evidence']

const GROUP_TONE: Record<VaultGroup, 'cyan' | 'blue' | 'violet' | 'amber' | 'grey'> = {
  inventory: 'cyan',
  paperwork: 'blue',
  workpapers: 'violet',
  settings: 'amber',
  evidence: 'grey',
}

const GROUP_LABEL: Record<VaultGroup, string> = {
  inventory: 'The stock you count',
  paperwork: 'The paperwork you raise',
  workpapers: 'The workpapers you file',
  settings: 'The settings you chose',
  evidence: 'The logs a backup can only show',
}

/** The four persistence classes in the order a shop should read them — fastest to a server first —
 *  and the badge colour each one wears. Ordered by `CLASS_META.rank`, so a re-ranked class reorders
 *  the whole tab without this page being touched. */
const CLASS_ORDER = (Object.keys(CLASS_META) as PersistenceClass[])
  .sort((a, b) => CLASS_META[a].rank - CLASS_META[b].rank)

const CLASS_TONE: Record<PersistenceClass, 'red' | 'amber' | 'violet' | 'grey'> = {
  authoritative: 'red',
  'decision-input': 'amber',
  reconstructible: 'violet',
  'device-by-design': 'grey',
}

/** Every plan state in the order a person should read them: what changes, then what does not. */
const STATE_ORDER: (keyof typeof PLAN_STATE_META)[] = [
  'new', 'replace', 'blank', 'damaged', 'foreign', 'unknown', 'same', 'absent', 'evidence',
]

const size = (chars: number) => (chars >= 1024
  ? `${(chars / 1024).toFixed(chars >= 102_400 ? 0 : 1)} KB`
  : `${chars} B`)

const when = (iso: string) => (iso ? formatDateIN(iso.slice(0, 10)) : '—')

const stamp = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * The table's second line under a state badge. The badge already carries the verdict, so this prints
 * the two figures the verdict was made from — never a third reading of them. `nothing` and
 * `unrecorded` print nothing: an empty register and a backup that predates the record are both fully
 * said by their badge, and a sentence would only repeat it.
 */
function freshnessNote(fr: FreshRow): string | null {
  const here = fr.rows
  const inFile = fr.fileRows ?? 0
  switch (fr.state) {
    case 'fresh': return `${here} here · the file carries the same ${inFile}`
    case 'changed': return `${here} here · your file carries ${inFile}; they are not the same content`
    case 'new-since': return `${here} here · your file carried none of this book`
    case 'cleared': return `your file carries ${inFile} · this browser holds none`
    case 'never': return `${here} here · in no file you have taken`
    default: return null
  }
}

interface Snapshot {
  preview: VaultFile | null
  inventory: RegisterBrowse[]
  history: VaultEvent[]
  lastBackupDays: number | null
  /** This browser read against the fingerprints the last recorded backup left; null before the first load. */
  freshness: FreshnessReport | null
}

const EMPTY_SNAPSHOT: Snapshot = {
  preview: null, inventory: [], history: [], lastBackupDays: null, freshness: null,
}

function VaultPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)

  const [tab, setTab] = useState<Tab>('backup')
  const [snap, setSnap] = useState<Snapshot>(EMPTY_SNAPSHOT)
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)

  // the restore side: a file that has been picked, the plan it makes, the report it produced
  const [loaded, setLoaded] = useState<{ vault: VaultFile; name: string } | null>(null)
  const [loadFault, setLoadFault] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [confirm, setConfirm] = useState(false)
  const [report, setReport] = useState<RestoreReport | null>(null)
  const [busy, setBusy] = useState(false)

  const [groupFilter, setGroupFilter] = useState<GroupFilter>('all')
  const [search, setSearch] = useState('')

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
      const name = (membership.organizations as { name?: string } | null)?.name || ''
      setOrgId(oid)
      setOrgName(name)
      // read-only collection: nothing is written here, and the vault's own log stays out of the file
      setSnap({
        preview: collectVault(oid, name),
        inventory: browseRegisters(oid),
        history: loadVaultLog(oid).events,
        lastBackupDays: daysSinceBackup(oid),
        freshness: registerFreshness(oid),
      })

      const inbound = searchParams.get('tab')
      if (inbound && TABS.some(t => t.value === inbound)) setTab(inbound as Tab)
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function refresh(oid = orgId, name = orgName) {
    if (!oid) return
    setSnap({
      preview: collectVault(oid, name),
      inventory: browseRegisters(oid),
      history: loadVaultLog(oid).events,
      lastBackupDays: daysSinceBackup(oid),
      // after a backup this re-reads against the fingerprint that backup just left, so the
      // Registers tab answers about *this* file the moment the download starts
      freshness: registerFreshness(oid),
    })
  }

  const plan = useMemo<RestorePlan | null>(
    () => (loaded && orgId ? planRestore(loaded.vault, orgId) : null),
    [loaded, orgId],
  )

  const storedCount = snap.inventory.filter(r => r.present).length
  const restorable = REGISTERS.filter(r => r.write).length
  const heaviest = useMemo(() => {
    const blocks = Object.entries(snap.preview?.registers ?? {})
    const top = blocks
      .map(([id, block]) => ({ id, label: REGISTERS.find(s => s.id === id)?.label || id, ...block }))
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 3)
    const max = top[0]?.chars ?? 1
    return top.map(r => ({ ...r, share: Math.max(4, (r.chars / max) * 100) }))
  }, [snap.preview])

  // ── the server plan (R3-13) — a reading of the vault's own register list, so it needs no browser
  // data and never re-reads a value; it is the shape of a future migration, not its contents. ──────
  const plan_ = useMemo(() => persistencePlan(), [])
  const pTotals = useMemo(() => persistenceTotals(plan_), [plan_])
  const pSealClaims = useMemo(() => sealClaims(plan_), [plan_])
  const pSealGaps = useMemo(() => sealClaimGaps(plan_), [plan_])
  const pReadNotDoor = useMemo(() => readNotDoorRows(plan_), [plan_])
  // Rows grouped by class, in the reading order the summary uses, so the table can print one section
  // per class with its own header instead of a single flat list.
  const pByClass = useMemo(() => CLASS_ORDER
    .map(cls => ({ cls, rows: plan_.filter(r => r.cls === cls) }))
    .filter(s => s.rows.length > 0), [plan_])

  function flash(msg: string) { setNotice({ msg, bad: false }) }
  function warn(msg: string) { setNotice({ msg, bad: true }) }

  function changeTab(next: string) {
    setTab(next as Tab)
    router.replace(`/vault?tab=${next}`, { scroll: false })
  }

  // ── backup ────────────────────────────────────────────────────────────────
  function takeBackup() {
    const preview = snap.preview
    if (!preview || !orgId) return
    if (preview.counts.registers === 0) {
      warn('Nothing is stored here yet — the registers fill up as you use the pages that write them.')
      return
    }
    const name = vaultFilename(preview, new Date())
    downloadVault(name, serializeVault(preview))
    recordBackup(orgId, preview)
    refresh()
    flash(`${name} — ${preview.counts.registers} registers, ${preview.counts.rows} rows, ${size(preview.counts.chars)}. Keep the copy somewhere the browser is not.`)
  }

  // ── restore ───────────────────────────────────────────────────────────────
  async function onPickFile(file: File | null) {
    if (!file || !orgId) return
    setBusy(true)
    setReport(null)
    setConfirm(false)
    try {
      const text = await readFileText(file)
      const read = readVault(text)
      if (read.fault || !read.vault) {
        setLoaded(null)
        setPicked([])
        setLoadFault(read.fault
          ? `${VAULT_FAULT_COPY[read.fault]}${read.detail ? ` — ${read.detail}` : ''}`
          : 'This file could not be read.')
        return
      }
      const v = read.vault
      setLoadFault(null)
      setLoaded({ vault: v, name: file.name })
      const next = planRestore(v, orgId)
      setPicked(defaultSelection(next))
      if (!next.sameOrg) warn('That file was taken against a different business, so nothing in it can be restored here.')
      else if (next.counts.new + next.counts.replace + next.counts.blank === 0) flash('Nothing in that file would change this browser.')
    } catch (e) {
      setLoadFault(`The file could not be read: ${(e as Error).message}`)
      setLoaded(null)
      setPicked([])
    } finally {
      setBusy(false)
    }
  }

  function toggleRow(id: string) {
    setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))
    setConfirm(false)
  }

  function runRestore() {
    if (!loaded || !plan || picked.length === 0) return
    const r = applyRestore(loaded.vault, orgId, picked)
    setReport(r)
    setPicked([])
    setConfirm(false)
    refresh()
    if (r.refused === 0 && r.dropped === 0) flash(`Restored ${r.restored} registers — every row read back through the page that owns it.`)
    else if (r.restored > 0) warn(`Restored ${r.restored} registers: ${r.refused} refused and ${r.dropped} rows dropped by a register's own parser. The report says which.`)
    else warn('Nothing was restored. Every chosen register refused the file, and the report says why.')
  }

  const risky = !!plan && (plan.counts.replace + plan.counts.blank) > 0
  const canRestore = !!plan && plan.sameOrg && picked.length > 0 && (!risky || confirm)

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return snap.inventory.filter(r => (groupFilter === 'all' || r.group === groupFilter) &&
      (!q || r.label.toLowerCase().includes(q) || r.what.toLowerCase().includes(q) ||
        r.module.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)))
  }, [snap.inventory, groupFilter, search])

  const sections = useMemo(
    () => GROUP_ORDER
      .map(g => ({ group: g, rows: visibleRows.filter(r => r.group === g) }))
      .filter(x => x.rows.length > 0),
    [visibleRows],
  )

  /** The freshness answer for each inventory row, joined by register id. */
  const freshById = useMemo(
    () => new Map((snap.freshness?.rows ?? []).map(r => [r.id, r] as const)),
    [snap.freshness],
  )

  const atRisk = useMemo(() => (snap.freshness ? atRiskRows(snap.freshness) : []), [snap.freshness])

  /** The one sentence the card prints: what the shop would miss if this browser died today. */
  const freshLine = useMemo(() => {
    const f = snap.freshness
    if (!f) return null
    const c = f.counts
    const at = f.at ? `${when(f.at)} (${f.days === null ? '—' : f.days === 0 ? 'today' : `${f.days} day${f.days === 1 ? '' : 's'} ago`})` : ''
    return {
      at,
      counts: c,
      summary: f.rows.length === 0
        ? 'Nothing to compare yet.'
        : f.unrecorded
          ? 'This browser cannot tell — your last backup was taken before it started keeping per-book fingerprints.'
          : !f.at
            ? 'No backup has ever been recorded in this browser.'
            : `${c.fresh} in your file · ${c.changed} changed · ${c['new-since']} new · ${c.cleared} only in your file · ${c.nothing} empty`,
    }
  }, [snap.freshness])

  if (loading) {
    return (
      <div className="page-container">
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>Reading this browser…</p>
      </div>
    )
  }

  return (
    <div className="page-container">
      <PageHeader
        eyebrow="Your registers, off the device"
        title="The books vault"
        subtitle={
          <>
            Documents live in the database and come back when you sign in. The {restorable} registers this app keeps on{' '}
            <em>this browser</em> do not — batches, serials, LUTs, splits, workpapers. This page writes them into one
            file and puts them back through the pages that own them.
          </>
        }
        actions={
          <>
            <Button variant="ghost" icon="upload" onClick={() => changeTab('restore')}>Restore from a file</Button>
            <Button
              variant="primary"
              icon="download"
              onClick={takeBackup}
              disabled={!snap.preview || snap.preview.counts.registers === 0}
            >
              Download the vault
            </Button>
          </>
        }
        right={<Segmented options={TABS} value={tab} onChange={changeTab} />}
      />

      {notice && (
        <div className={`tfv-notice ${notice.bad ? 'is-bad' : ''}`}>
          <Icon name={notice.bad ? 'alert' : 'check'} size={15} />
          <span>{notice.msg}</span>
          <button type="button" className="tfv-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      <div className="tfv-stats">
        <StatCard
          label="Registers stored here"
          value={`${storedCount} / ${REGISTERS.length}`}
          sub={`${restorable} can be put back · ${REGISTERS.length - restorable} travel as evidence only`}
          icon="layers"
          tone="blue"
        />
        <StatCard
          label="Rows in the file"
          value={String(snap.preview?.counts.rows ?? 0)}
          sub={`across ${snap.preview?.counts.registers ?? 0} registers with content`}
          icon="list"
          tone="green"
          delay={40}
        />
        <StatCard
          label="Size of the next file"
          value={size(snap.preview?.counts.chars ?? 0)}
          sub={snap.preview && snap.preview.counts.chars > LARGE_VAULT_CHARS
            ? 'large — a mail client may refuse it'
            : 'plain JSON, readable in any editor'}
          icon="file-check"
          tone={snap.preview && snap.preview.counts.chars > LARGE_VAULT_CHARS ? 'amber' : 'cyan'}
          delay={80}
        />
        <StatCard
          label="Last backup taken"
          value={snap.lastBackupDays === null ? 'Never' : snap.lastBackupDays === 0 ? 'Today' : `${snap.lastBackupDays} days ago`}
          sub={snap.lastBackupDays === null
            ? 'a browser wipe would take the workpapers with it'
            : snap.freshness?.unrecorded
              ? 'cannot tell yet — that backup predates this browser’s per-book record'
              : `${atRisk.length} ${atRisk.length === 1 ? 'book holds' : 'books hold'} work your newest file does not · the Registers tab names them`}
          icon="clock"
          tone={snap.lastBackupDays === null ? 'red' : atRisk.length > 0 ? 'amber' : snap.lastBackupDays > 30 ? 'amber' : 'grey'}
          delay={120}
        />
      </div>

      {/* ── BACKUP ─────────────────────────────────────────────────────────── */}
      {tab === 'backup' && (
        <div className="tfv-stack">
          <Card>
            <SectionTitle icon="shield">What this file is, and what it is not</SectionTitle>
            <div className="tfv-decisions">
              {[
                {
                  icon: 'list',
                  title: 'A named list, not a sweep',
                  body: 'The vault walks the 30 keys this app writes and never reads localStorage as a whole, so a Supabase session key or anything an extension left behind cannot be copied into a backup.',
                },
                {
                  icon: 'undo',
                  title: 'Restored through the owner',
                  body: 'Every write calls that register\'s own save function, so its version check, its row parsing and its business stamping run exactly as they do when a page saves.',
                },
                {
                  icon: 'check',
                  title: 'Proved by reading back',
                  body: 'After a write the register is loaded the way its page loads it. If the file held 212 rows and the register reads 198, the report says 198.',
                },
                {
                  icon: 'alert',
                  title: 'One damaged page, not a damaged book',
                  body: 'Each block carries a checksum. A truncated download or a hand-edit loses that one register; the other 29 still restore.',
                },
              ].map(d => (
                <div key={d.title} className="tfv-decision">
                  <span className="tfv-decision-icon"><Icon name={d.icon} size={15} /></span>
                  <div>
                    <div className="tfv-decision-title">{d.title}</div>
                    <div className="tfv-decision-body">{d.body}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {!snap.preview || snap.preview.counts.registers === 0 ? (
            <Card>
              <EmptyState
                icon="box"
                title="Nothing is stored in this browser yet"
                message="The registers fill up as you use the pages that write them — lots on /inventory/batches, undertakings on /gst/exports, splits on /cost-centres."
                action={<Button variant="subtle" href="/inventory/batches" icon="arrow-right">Open a register</Button>}
              />
            </Card>
          ) : (
            <>
              <Card>
                <SectionTitle
                  icon="download"
                  action={<Button variant="primary" size="sm" icon="download" onClick={takeBackup}>Download</Button>}
                >
                  This browser, right now
                </SectionTitle>
                <StatRow label="File it would write" value={vaultFilename(snap.preview, new Date())} />
                <StatRow label="Business" value={snap.preview.org_name || snap.preview.org_id.slice(0, 8)} />
                <StatRow label="Taken" value={when(snap.preview.created_at)} />
                <StatRow label="Registers with content" value={`${snap.preview.counts.registers} of ${REGISTERS.length}`} />
                <StatRow label="Rows counted from the shape" value={snap.preview.counts.rows} tone="green" />
                <StatRow label="Size" value={size(snap.preview.counts.chars)} strong />
                {snap.preview.counts.chars > LARGE_VAULT_CHARS && (
                  <div className="tfv-note is-hot">
                    <Icon name="alert" size={14} />
                    <span>
                      That is a large file. It downloads fine, but a mail client or a CA upload form may not. Keep the
                      copy on a drive rather than in an inbox.
                    </span>
                  </div>
                )}
                <div className="tfv-heaviest">
                  <div className="tfv-heaviest-title">The three heaviest registers</div>
                  {heaviest.map(h => (
                    <div key={h.id} className="tfv-heaviest-row">
                      <span className="tfv-heaviest-name">{h.label}</span>
                      <span className="tfv-heaviest-bar"><i style={{ width: `${h.share}%` }} /></span>
                      <span className="tfv-num tfv-heaviest-size">{size(h.chars)} · {h.rows} rows</span>
                    </div>
                  ))}
                </div>
              </Card>

              <Card>
                <SectionTitle
                  icon="layers"
                  action={
                    <Button variant="subtle" size="sm" icon="arrow-right" onClick={() => changeTab('registers')}>
                      All {REGISTERS.length} registers
                    </Button>
                  }
                >
                  What goes in, by group
                </SectionTitle>
                <div className="tfv-groups">
                  {GROUP_ORDER.map(g => {
                    const list = snap.inventory.filter(r => r.group === g)
                    const present = list.filter(r => r.present)
                    return (
                      <div key={g} className="tfv-group">
                        <div className="tfv-group-head">
                          <Badge tone={GROUP_TONE[g]} dot={false}>{GROUP_LABEL[g]}</Badge>
                          <span className="tfv-group-count">{present.length} of {list.length} have content</span>
                        </div>
                        <div className="tfv-group-rows">
                          {list.map(r => (
                            <div key={r.id} className={`tfv-group-row ${r.present ? '' : 'is-empty'}`}>
                              <Link href={r.pageHref} className="tfv-group-name">{r.label}</Link>
                              <span className="tfv-group-size">{r.present ? size(r.chars) : '—'}</span>
                              <span className="tfv-group-detail">{r.present ? r.detail : 'nothing stored'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </Card>
            </>
          )}

          <Card>
            <SectionTitle icon="clock">This browser’s vault history</SectionTitle>
            {snap.history.length === 0 ? (
              <div className="tfv-note">
                <Icon name="book" size={14} />
                <span>
                  Nothing taken or restored yet. The log is this page’s own record — deliberately not inside the file,
                  because a backup that records its own backups grows every time it is restored.
                </span>
              </div>
            ) : (
              <div className="table-frame">
                <div className="responsive-table">
                  <div className="table-header tfv-row tfv-hist">
                    <span data-label="When">When</span>
                    <span data-label="What">What happened</span>
                    <span className="tfv-right" data-label="Registers">Registers</span>
                    <span className="tfv-right" data-label="Rows">Rows</span>
                    <span className="tfv-right" data-label="Refused">Refused</span>
                  </div>
                  {snap.history.slice(0, 8).map((e, i) => (
                    <div key={`${e.at}-${i}`} className="table-row tfv-row tfv-hist">
                      <span data-label="When" className="tfv-num">{stamp(e.at)}</span>
                      <span data-label="What">
                        <Badge tone={e.kind === 'backup' ? 'blue' : 'violet'} dot={false}>
                          {e.kind === 'backup' ? 'Backup downloaded' : 'Restore applied'}
                        </Badge>
                        {e.chars > 0 && <span className="tfv-sub">{size(e.chars)} written</span>}
                      </span>
                      <span className="tfv-right tfv-num" data-label="Registers">{e.registers}</span>
                      <span className="tfv-right tfv-num" data-label="Rows">{e.rows}</span>
                      <span className="tfv-right tfv-num" data-label="Refused">{e.refused ?? '—'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ── RESTORE ────────────────────────────────────────────────────────── */}
      {tab === 'restore' && (
        <div className="tfv-stack">
          <Card>
            <SectionTitle icon="upload">1 · Choose the file</SectionTitle>
            <div className="tfv-pick">
              <label className="tfv-file" htmlFor="tfv-vault-file">
                <Icon name="file-check" size={17} />
                <span className="tfv-file-text">{busy ? 'Reading…' : loaded ? loaded.name : 'Pick a .json vault file'}</span>
                <input
                  id="tfv-vault-file"
                  type="file"
                  accept="application/json,.json"
                  disabled={busy || !orgId}
                  onChange={ev => onPickFile(ev.target.files?.[0] ?? null)}
                />
              </label>
              {(loaded || loadFault) && (
                <Button
                  variant="subtle"
                  size="sm"
                  icon="x"
                  onClick={() => {
                    setLoaded(null); setLoadFault(null); setPicked([]); setReport(null); setConfirm(false)
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
            <div className="tfv-note">
              <Icon name="shield" size={14} />
              <span>
                Only a file that says <code>{'"kind": "taxflow.vault"'}</code> is read. A CSV, a Tally XML dump or a report
                is refused with the reason printed, and a file written by a newer build is refused rather than guessed
                at.
              </span>
            </div>
          </Card>

          {loadFault && (
            <Card>
              <div className="tfv-fault">
                <Icon name="alert" size={16} />
                <div>
                  <div className="tfv-fault-title">That file was not accepted</div>
                  <div className="tfv-fault-body">{loadFault}</div>
                </div>
              </div>
            </Card>
          )}

          {loaded && plan && (
            <>
              <Card>
                <SectionTitle icon="layers">2 · What the file holds, and what this browser would do</SectionTitle>
                <div className="tfv-filestats">
                  <StatRow
                    label="Business on the file"
                    value={plan.vault.org_name || plan.vault.org_id.slice(0, 8)}
                    tone={plan.sameOrg ? 'green' : 'red'}
                  />
                  <StatRow label="Taken" value={when(plan.vault.created_at)} />
                  <StatRow
                    label="In the file"
                    value={`${plan.vault.counts.registers} registers · ${plan.vault.counts.rows} rows · ${size(plan.vault.counts.chars)}`}
                  />
                </div>
                <div className="tfv-states">
                  {STATE_ORDER.map(s => (
                    <div key={s} className={`tfv-state ${PLAN_STATE_META[s].tone} ${plan.counts[s] ? 'is-on' : ''}`}>
                      <span className="tfv-state-n">{plan.counts[s]}</span>
                      <span className="tfv-state-label">{PLAN_STATE_META[s].label}</span>
                      <span className="tfv-state-why">{PLAN_STATE_META[s].why}</span>
                    </div>
                  ))}
                </div>
                {!plan.sameOrg && (
                  <div className="tfv-fault">
                    <Icon name="alert" size={16} />
                    <div>
                      <div className="tfv-fault-title">This file belongs to another business</div>
                      <div className="tfv-fault-body">
                        It was taken against <strong>{plan.vault.org_id.slice(0, 8)}…</strong> and you are on{' '}
                        <strong>{orgId.slice(0, 8)}…</strong>. Restoring would overwrite this business’s registers with
                        another’s, so every row is refused. Sign in to the organisation the file was made for.
                      </div>
                    </div>
                  </div>
                )}
                {plan.unknown.length > 0 && (
                  <div className="tfv-note">
                    <Icon name="alert" size={14} />
                    <span>
                      The file carries registers this build does not know: {plan.unknown.join(', ')}. They stay in the
                      file and are untouched here — a newer app can read them; this one will not invent a shape for them.
                    </span>
                  </div>
                )}
              </Card>

              <Card pad={false}>
                <div className="tfv-plan-head">
                  <div className="tfv-plan-title">
                    <Icon name="list" size={15} />
                    <span>3 · Choose what to put back</span>
                  </div>
                  <div className="tfv-plan-actions">
                    <Button variant="subtle" size="sm" icon="check" onClick={() => { setPicked(defaultSelection(plan)); setConfirm(false) }}>
                      Select what is new
                    </Button>
                    <Button variant="subtle" size="sm" icon="undo" onClick={() => { setPicked([]); setConfirm(false) }}>
                      Clear
                    </Button>
                  </div>
                </div>
                <div className="responsive-table">
                  <div className="table-header tfv-row tfv-plan-row">
                    <span data-label="Pick" />
                    <span data-label="Register">Register</span>
                    <span data-label="Decision">Decision</span>
                    <span className="tfv-right" data-label="File to here">File → here</span>
                    <span data-label="Detail">Detail</span>
                  </div>
                  {plan.rows.map((r: PlanRow) => {
                    const on = picked.includes(r.id)
                    return (
                      <div key={r.id} className={`table-row tfv-row tfv-plan-row ${on ? 'is-picked' : ''}`}>
                        <span data-label="Pick">
                          {r.selectable ? (
                            <input
                              type="checkbox"
                              className="tfv-check"
                              checked={on}
                              onChange={() => toggleRow(r.id)}
                              aria-label={`Restore ${r.label}`}
                            />
                          ) : (
                            <span className="tfv-check-off" title={PLAN_STATE_META[r.state].why}>
                              <Icon name={r.state === 'same' ? 'check' : 'x'} size={12} />
                            </span>
                          )}
                        </span>
                        <span data-label="Register">
                          <span className="tfv-name">{r.label}</span>
                          <span className="tfv-sub">
                            <Badge tone={GROUP_TONE[r.group]} dot={false}>{r.group}</Badge> · <Link href={r.pageHref}>{r.pageLabel}</Link>
                          </span>
                        </span>
                        <span data-label="Decision">
                          <Badge tone={PLAN_STATE_META[r.state].tone}>{PLAN_STATE_META[r.state].label}</Badge>
                          {(r.warning || r.note) && (
                            <span className={`tfv-sub ${r.warning ? 'is-warn' : ''}`}>{r.warning || r.note}</span>
                          )}
                        </span>
                        <span className="tfv-right tfv-num" data-label="File to here">
                          {r.fileRows === null ? '—' : r.fileRows} → {r.browserRows}
                        </span>
                        <span data-label="Detail"><span className="tfv-detail">{r.detail}</span></span>
                      </div>
                    )
                  })}
                </div>
                <div className="tfv-plan-foot">
                  {risky && (
                    <label className="tfv-confirm">
                      <input type="checkbox" className="tfv-check" checked={confirm} onChange={ev => setConfirm(ev.target.checked)} />
                      <span>
                        I understand this replaces {plan.counts.replace} register{plan.counts.replace === 1 ? '' : 's'} that
                        already hold content
                        {plan.counts.blank > 0 ? ` and clears ${plan.counts.blank} the file left empty` : ''} — the browser
                        copy cannot be got back after this.
                      </span>
                    </label>
                  )}
                  <div className="tfv-plan-foot-row">
                    <span className="tfv-foot-hint">
                      {picked.length
                        ? `${picked.length} register${picked.length === 1 ? '' : 's'} chosen · each is written through its own page's save and read back`
                        : 'Nothing chosen yet'}
                    </span>
                    <Button variant="danger" icon="undo" disabled={!canRestore} onClick={runRestore}>
                      Restore {picked.length ? `${picked.length} register${picked.length === 1 ? '' : 's'}` : ''}
                    </Button>
                  </div>
                </div>
              </Card>
            </>
          )}

          {report && (
            <Card>
              <SectionTitle icon="doc-check">The report — what the pages could read back</SectionTitle>
              <div className="tfv-report-summary">
                <Badge tone={report.restored ? 'green' : 'grey'}>{report.restored} restored</Badge>
                <Badge tone={report.refused ? 'red' : 'grey'}>{report.refused} refused</Badge>
                <Badge tone={report.dropped ? 'amber' : 'grey'}>{report.dropped} rows dropped by a parser</Badge>
                <span className="tfv-sub is-inline">{stamp(report.at)}</span>
              </div>
              <div className="tfv-report-rows">
                {report.results.map(r => (
                  <div key={r.id} className={`tfv-report-row ${r.ok ? '' : 'is-bad'}`}>
                    <Icon name={r.ok ? 'check' : 'x'} size={13} />
                    <span className="tfv-report-label">{r.label}</span>
                    <span className="tfv-num tfv-report-count">{r.ok ? `${r.from} → ${r.seen}` : '—'}</span>
                    <span className="tfv-report-note">{r.note}</span>
                  </div>
                ))}
              </div>
              {report.dropped > 0 && (
                <div className="tfv-note">
                  <Icon name="alert" size={14} />
                  <span>
                    A dropped row is the owning register refusing a shape it cannot read — usually because the file came
                    from an older build. Open the pages above and check the register; the rows that survived are already there.
                  </span>
                </div>
              )}
            </Card>
          )}
        </div>
      )}

      {/* ── REGISTERS ──────────────────────────────────────────────────────── */}
      {tab === 'registers' && (
        <div className="tfv-stack">
          <Card>
            <SectionTitle icon="list">The inventory — every key the vault walks</SectionTitle>
            <div className="tfv-toolbar">
              <SearchInput
                value={search}
                onChange={setSearch}
                ariaLabel="Search registers"
                placeholder="Search by name, page or module…"
                style={{ flex: '1 1 260px', minWidth: 200 }}
              />
              <Segmented options={GROUP_FILTERS} value={groupFilter} onChange={v => setGroupFilter(v as GroupFilter)} />
            </div>
            <div className="tfv-note">
              <Icon name="shield" size={14} />
              <span>
                This list <em>is</em> the security property. A key that is not named here is never read, including the
                Supabase session keys under <code>sb-*</code>. Two rows are written by a page rather than a library; that
                is printed, not hidden, because it is exactly why they cannot be restored.
              </span>
            </div>
          </Card>

          {/* ── WHAT MOVED SINCE THE LAST BACKUP ─────────────────────────────── */}
          {snap.freshness && freshLine && (
            <Card>
              <SectionTitle icon="compare">What moved since your last backup</SectionTitle>
              <div className="tfv-note">
                <Icon name="clock" size={14} />
                <span>
                  {!snap.freshness.at
                    ? 'No backup has ever been recorded in this browser, so the books below are on this device and in no file you have taken. Nothing here is compared — that is the honest answer, not a clean one.'
                    : snap.freshness.unrecorded
                      ? 'Your last backup was taken before this browser kept a fingerprint per book, so there is nothing to compare against. Take one new backup and this table starts answering the question.'
                      : <>Compared against the backup taken <strong>{freshLine.at}</strong>. The file itself is not read here — it is in a folder or a mail and this screen cannot know what happened to it after it left. The answer comes from what <em>this browser</em> holds, checksum against the fingerprint that backup recorded when it was taken.</>}
                </span>
              </div>

              {!snap.freshness.unrecorded && snap.freshness.at && (
                <div className="tfv-fresh-stats">
                  {(['fresh', 'changed', 'new-since', 'cleared', 'never'] as const)
                    .filter(s => freshLine.counts[s] > 0)
                    .map(s => (
                      <span key={s} className="tfv-fresh-chip">
                        <Badge tone={FRESHNESS_META[s].tone} dot={false}>{FRESHNESS_META[s].label}</Badge>
                        <b>{freshLine.counts[s]}</b>
                        <span className="tfv-fresh-why">{FRESHNESS_META[s].why}</span>
                      </span>
                    ))}
                  {freshLine.counts.nothing > 0 && (
                    <span className="tfv-fresh-chip">
                      <Badge tone="grey" dot={false}>Empty</Badge>
                      <b>{freshLine.counts.nothing}</b>
                      <span className="tfv-fresh-why">nothing stored here and nothing in your file</span>
                    </span>
                  )}
                </div>
              )}

              {atRisk.length > 0 && (
                <div className="tfv-risk">
                  <div className="tfv-risk-head">
                    <Icon name="alert" size={13} />
                    <span>What a wipe would take with it — {atRisk.length} book{atRisk.length === 1 ? '' : 's'} with content newer than any file you have taken</span>
                  </div>
                  {atRisk.map(r => (
                    <div key={r.id} className="tfv-risk-row">
                      <span className="tfv-name">{r.label}</span>
                      <span className="tfv-detail">
                        {r.rows} {r.rows === 1 ? r.unit : `${r.unit}s`} in this browser
                        {r.fileRows !== null && r.fileRows !== undefined && r.state === 'changed'
                          ? ` · your file carries ${r.fileRows}` : ''}
                        {r.state === 'new-since' ? ' · your file never carried any' : ''}
                        {r.state === 'never' ? ' · in no file yet' : ''}
                      </span>
                      <Link href={r.pageHref} className="tfv-exclude-link">{r.pageLabel}<Icon name="arrow-right" size={12} /></Link>
                    </div>
                  ))}
                  <div className="tfv-risk-foot">
                    <Button variant="subtle" size="sm" icon="download" onClick={() => changeTab('backup')}>Take a backup now</Button>
                  </div>
                </div>
              )}
            </Card>
          )}

          {sections.map(section => (
            <div key={section.group} className="tfv-section">
              <div className="tfv-section-head">
                <h2><Icon name={section.group === 'evidence' ? 'book' : 'layers'} size={14} />{GROUP_LABEL[section.group]}</h2>
                <span className="tfv-section-sub">{section.rows.length} register{section.rows.length === 1 ? '' : 's'} shown</span>
              </div>
              <div className="table-frame">
                <div className="responsive-table">
                  <div className="table-header tfv-row tfv-inv">
                    <span data-label="Register">Register</span>
                    <span data-label="What it holds">What it holds</span>
                    <span className="tfv-right" data-label="Rows">Rows</span>
                    <span className="tfv-right" data-label="Size">Size</span>
                    <span data-label="Written by">Written by</span>
                    <span data-label="Restorable">Restorable</span>
                    <span data-label="Since your file">Since your file</span>
                  </div>
                  {section.rows.map(r => (
                    <div key={r.id} className={`table-row tfv-row tfv-inv ${r.present ? '' : 'is-empty'}`}>
                      <span data-label="Register">
                        <span className="tfv-name">{r.label}</span>
                        <span className="tfv-sub tfv-mono">{r.id}</span>
                      </span>
                      <span data-label="What it holds">
                        <span className="tfv-detail">{r.present ? r.detail : 'nothing stored in this browser'}</span>
                        <span className="tfv-sub">{r.what}</span>
                      </span>
                      <span className="tfv-right tfv-num" data-label="Rows">{r.rows}</span>
                      <span className="tfv-right tfv-num" data-label="Size">{r.present ? size(r.chars) : '—'}</span>
                      <span data-label="Written by"><span className="tfv-mono tfv-detail">{r.module}</span></span>
                      <span data-label="Restorable">
                        {r.restorable ? <Badge tone="green">Yes</Badge> : <Badge tone="amber">Shown only</Badge>}
                        {r.reason && <span className="tfv-sub">{r.reason}</span>}
                      </span>
                      <span data-label="Since your file">
                        {(() => {
                          const fr = freshById.get(r.id)
                          if (!fr) return <span className="tfv-sub">—</span>
                          const meta = FRESHNESS_META[fr.state]
                          return (
                            <>
                              <Badge tone={meta.tone} dot={false}>{meta.label}</Badge>
                              {freshnessNote(fr) && <span className="tfv-sub">{freshnessNote(fr)}</span>}
                            </>
                          )
                        })()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}

          {sections.length === 0 && (
            <Card>
              <EmptyState
                icon="search"
                title="No register matches that"
                message="Try a page name such as “batches”, or clear the group filter."
                action={<Button variant="subtle" icon="undo" onClick={() => { setSearch(''); setGroupFilter('all') }}>Reset</Button>}
              />
            </Card>
          )}
        </div>
      )}

      {/* ── NOT IN THIS FILE ──────────────────────────────────────────────── */}
      {tab === 'inside' && (
        <div className="tfv-stack">
          <Card>
            <SectionTitle icon="shield">What the vault deliberately leaves out</SectionTitle>
            <div className="tfv-note">
              <Icon name="book" size={14} />
              <span>
                A backup that carried everything would carry the things that must not be replayed. These four are the
                boundary of the file, printed here so nobody has to guess whether the vault is the whole account.
              </span>
            </div>
            <div className="tfv-grid">
              {NOT_IN_THE_VAULT.map(x => (
                <div key={x.title} className="tfv-exclude">
                  <div className="tfv-exclude-title"><Icon name="x" size={13} />{x.title}</div>
                  <p className="tfv-exclude-body">{x.body}</p>
                  <Link href={x.href} className="tfv-exclude-link">{x.hrefLabel}<Icon name="arrow-right" size={12} /></Link>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle icon="book">The five logs that travel as evidence</SectionTitle>
            <div className="tfv-evidence">
              {REGISTERS.filter(r => !r.write).map(r => (
                <div key={r.id} className="tfv-evidence-row">
                  <div className="tfv-evidence-head">
                    <span className="tfv-name">{r.label}</span>
                    <Link href={r.pageHref} className="tfv-exclude-link">{r.pageLabel}<Icon name="arrow-right" size={12} /></Link>
                  </div>
                  <div className="tfv-sub">{r.what}</div>
                  <div className="tfv-evidence-reason"><Icon name="alert" size={12} />{r.reason}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle icon="cloud">Where the rest of the account lives</SectionTitle>
            <div className="tfv-adr">
              <p>
                Invoices, bills, payments, customers, vendors and products are rows in the database. They are not in this
                file on purpose: a second copy would be a second way to write money, and a restore could invent a receipt
                or clear a debt. Sign in and they are there.
              </p>
              <p>
                The registers <em>are</em> in the file because the app keeps them on the device (ADR-013). That choice
                buys offline work and a workpaper you hold the way you hold paper; it costs portability, and this page is
                the portability.
              </p>
              <div className="tfv-adr-links">
                <Button variant="subtle" size="sm" icon="settings" href="/settings">Business settings</Button>
                <Button variant="subtle" size="sm" icon="cloud" href="/offline">Offline sync</Button>
                <Button variant="subtle" size="sm" icon="tally" href="/tally">Tally bridge</Button>
                <Button variant="subtle" size="sm" icon="download" onClick={() => changeTab('backup')}>Take a backup</Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ── SERVER PLAN (R3-13) ─────────────────────────────────────────────── */}
      {tab === 'persistence' && (
        <div className="tfv-stack">
          <Card>
            <SectionTitle
              icon="cloud"
              action={<Button variant="subtle" size="sm" icon="download"
                onClick={() => download('taxflow-persistence-inventory.csv', toCsv(PERSISTENCE_CSV_HEADERS, persistenceCsvRows(plan_)))}>
                Export the inventory</Button>}
            >
              Which of these books must reach a server
            </SectionTitle>
            <div className="tfv-note">
              <Icon name="book" size={14} />
              <span>
                The vault already answers <em>which books exist</em>. This tab answers the next question a backend round
                has to be planned against — <em>which of them are the only copy</em>, asked of a single test: what is
                lost if this browser is wiped and no backup file is there to bring it back. The register list is read
                live from the vault’s own inventory, so this page cannot disagree with the {pTotals.total} books it
                counts; only the priority, the reason and a <em>proposed</em> home are added here. This is a reading,
                not a migration — no schema, no <code>.sql</code>, no row is written (ADR-013 / Rule 21).
              </span>
            </div>

            <div className="tfv-fresh-stats">
              {CLASS_ORDER.filter(c => pTotals.byClass.find(b => b.cls === c)?.count).map(c => {
                const b = pTotals.byClass.find(x => x.cls === c)!
                return (
                  <span key={c} className="tfv-fresh-chip">
                    <Badge tone={CLASS_TONE[c]} dot={false}>{b.label}</Badge>
                    <b>{b.count}</b>
                    <span className="tfv-fresh-why">{CLASS_META[c].means}</span>
                  </span>
                )
              })}
              <span className="tfv-fresh-chip">
                <Badge tone="cyan" dot={false}>Needs a server copy</Badge>
                <b>{pTotals.needsServer}</b>
                <span className="tfv-fresh-why">the only copy of a record or a decision — the two classes that belong on a server</span>
              </span>
              <span className="tfv-fresh-chip">
                <Badge tone="grey" dot={false}>Restorable today</Badge>
                <b>{pTotals.restorable}</b>
                <span className="tfv-fresh-why">what the vault can already put back through its owning page</span>
              </span>
            </div>
          </Card>

          {/* ── THE FOUR CLASSES ───────────────────────────────────────────── */}
          <Card>
            <SectionTitle icon="layers">The four classes, and the one question that sorts them</SectionTitle>
            <div className="tfv-decisions">
              {CLASS_ORDER.map(c => (
                <div key={c} className="tfv-decision">
                  <span className="tfv-decision-icon"><Icon name={CLASS_META[c].serverBound ? 'cloud' : 'shield'} size={15} /></span>
                  <div>
                    <div className="tfv-decision-title">{CLASS_META[c].label} · {pTotals.byClass.find(b => b.cls === c)?.count ?? 0}</div>
                    <div className="tfv-decision-body">{CLASS_META[c].means}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* ── THE PERIOD-SEAL CROSS-CHECK ────────────────────────────────── */}
          <Card>
            <SectionTitle icon="lock">The seal column — what the wiring has actually earned</SectionTitle>
            <div className="tfv-note">
              <Icon name="shield" size={14} />
              <span>
                A register’s class answers the <em>backup</em> question; a period seal answers a different one — does a
                dated money write pass a lock before it saves. <strong>{pSealClaims.length}</strong> of these registers
                say yes: {pSealClaims.filter(s => s.seal === 'asked-through-a-writer').length} become paper through a
                shared writer and {pSealClaims.filter(s => s.seal === 'asked-at-own-engine').length} calls the seal in its
                own engine. Each claim names a route on the <Link href="/audit">audit page’s guarded-doors list</Link>,
                and the test suite re-reads that list and refuses this count if a route is not really there — so this
                sentence cannot outrun the wiring (Rule 42).
                {pSealGaps.length > 0
                  ? <> Right now {pSealGaps.length} claim{pSealGaps.length === 1 ? ' has' : 's have'} no route to stand on — printed below in red rather than hidden.</>
                  : ' Every claim here carries its route; none is floating.'}
              </span>
            </div>
            {pReadNotDoor.length > 0 && (
              <div className="tfv-note">
                <Icon name="book" size={14} />
                <span>
                  {pReadNotDoor.map(r => r.label).join(', ')} {pReadNotDoor.length === 1 ? 'reads' : 'read'} a period’s
                  seal and shows it as closed paper, but guard no door — a transcript moves no rupee (Rule 41). The
                  seal is offered there, never asked.
                </span>
              </div>
            )}
            <div className="table-frame">
              <div className="responsive-table">
                <div className="table-header tfv-row tfv-per-seal">
                  <span data-label="Register">Register</span>
                  <span data-label="Seal state">Period seal</span>
                  <span data-label="Proof route">Proof route</span>
                  <span data-label="Carried by">Carried by</span>
                </div>
                {pSealClaims.map(s => (
                  <div key={s.id} className="table-row tfv-row tfv-per-seal">
                    <span data-label="Register"><span className="tfv-name">{s.label}</span></span>
                    <span data-label="Seal state"><Badge tone={s.seal === 'asked-at-own-engine' ? 'blue' : 'green'} dot={false}>{SEAL_META[s.seal].label}</Badge></span>
                    <span data-label="Proof route"><span className="tfv-mono tfv-detail">{s.href}</span></span>
                    <span data-label="Carried by"><span className="tfv-detail">{s.by}</span></span>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* ── THE INVENTORY, ONE BLOCK PER CLASS ─────────────────────────── */}
          {pByClass.map(section => (
            <div key={section.cls} className="tfv-section">
              <div className="tfv-section-head">
                <h2><Icon name={CLASS_META[section.cls].serverBound ? 'cloud' : 'shield'} size={14} />{CLASS_META[section.cls].label}</h2>
                <span className="tfv-section-sub">{section.rows.length} register{section.rows.length === 1 ? '' : 's'} · {CLASS_META[section.cls].serverBound ? 'belongs on a server' : 'stays on the device'}</span>
              </div>
              <div className="table-frame">
                <div className="responsive-table">
                  <div className="table-header tfv-row tfv-per">
                    <span data-label="Register">Register</span>
                    <span data-label="Why this class">Why this class</span>
                    <span data-label="Server copy">Server</span>
                    <span data-label="Period seal">Period seal</span>
                    <span data-label="Proposed destination">Proposed destination</span>
                    <span data-label="Restorable">Restorable</span>
                  </div>
                  {section.rows.map(r => (
                    <div key={r.id} className={`table-row tfv-row tfv-per ${r.unclassified ? 'is-warn' : ''}`}>
                      <span data-label="Register">
                        <span className="tfv-name">{r.label}</span>
                        <span className="tfv-sub tfv-mono">{r.id}</span>
                      </span>
                      <span data-label="Why this class"><span className="tfv-detail">{r.why}</span></span>
                      <span data-label="Server copy">{r.serverBound ? <Badge tone="cyan" dot={false}>Needed</Badge> : <Badge tone="grey" dot={false}>No</Badge>}</span>
                      <span data-label="Period seal"><Badge tone="grey" dot={false}>{SEAL_META[r.seal].label}</Badge></span>
                      <span data-label="Proposed destination"><span className="tfv-detail">{r.destination}</span></span>
                      <span data-label="Restorable">{r.restorable ? <Badge tone="green" dot={false}>Yes</Badge> : <Badge tone="amber" dot={false}>Evidence only</Badge>}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}

          {pTotals.unclassified.length > 0 && (
            <Card>
              <div className="tfv-note is-hot">
                <Icon name="alert" size={14} />
                <span>
                  {pTotals.unclassified.length} register{pTotals.unclassified.length === 1 ? ' is' : 's are'} in the vault
                  without a persistence judgement ({pTotals.unclassified.join(', ')}). The inventory reads the vault’s list
                  rather than a copy, so a new book shows up here as a gap instead of vanishing — write its class beside it.
                </span>
              </div>
            </Card>
          )}

          {/* ── THE READINGS ───────────────────────────────────────────────── */}
          <Card>
            <SectionTitle icon="book">What this page is allowed to claim, and in whose words</SectionTitle>
            {PERSISTENCE_READINGS.map((r, i) => (
              <div key={i} className="tfv-note">
                <Icon name="shield" size={14} />
                <span>{r.text}</span>
              </div>
            ))}
          </Card>

          {/* ── THE BOUNDARIES ─────────────────────────────────────────────── */}
          <Card>
            <SectionTitle icon="x">The boundary of this inventory</SectionTitle>
            <div className="tfv-grid">
              {PERSISTENCE_BOUNDARIES.map((b, i) => (
                <div key={i} className="tfv-exclude">
                  <div className="tfv-exclude-title"><Icon name="x" size={13} />Boundary {i + 1}</div>
                  <p className="tfv-exclude-body">{b}</p>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      <style>{`
        .tfv-stack { display: flex; flex-direction: column; gap: 14px; }
        .tfv-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1.1rem; }
        .tfv-right { text-align: right; }
        .tfv-num { font-variant-numeric: tabular-nums; }
        .tfv-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; }
        .tfv-sub { display: block; font-size: 11px; color: var(--faint); line-height: 1.5; margin-top: 3px; }
        .tfv-sub.is-warn { color: var(--red); font-weight: 600; }
        .tfv-sub.is-inline { display: inline; margin-top: 0; }
        .tfv-name { font-size: 13px; font-weight: 650; color: var(--ink); }
        .tfv-detail { font-size: 12px; color: var(--ink-2); line-height: 1.5; }

        .tfv-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px;
          font-size: 12.5px; color: var(--green); background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 10px; }
        .tfv-notice svg { flex-shrink: 0; }
        .tfv-notice.is-bad { color: var(--amber); background: var(--amber-soft);
          border-color: color-mix(in srgb, var(--amber) 26%, white); }
        .tfv-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer;
          padding: 2px; border-radius: 6px; min-height: 0; }
        .tfv-notice-x:hover { background: rgba(0,0,0,0.05); }

        .tfv-note { display: flex; align-items: flex-start; gap: 7px; padding: 9px 12px; border-radius: 10px;
          font-size: 12px; color: var(--muted); background: var(--surface-2); border: 1px solid var(--line-soft);
          line-height: 1.55; margin-top: 10px; }
        .tfv-note svg { flex-shrink: 0; margin-top: 2px; }
        .tfv-note code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--ink-2); }
        .tfv-note.is-hot { color: var(--red); background: var(--red-soft); border-color: color-mix(in srgb, var(--red) 24%, white); }

        .tfv-decisions { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
        .tfv-decision { display: flex; gap: 9px; padding: 11px 12px; background: var(--surface-2);
          border: 1px solid var(--line-soft); border-radius: 11px; }
        .tfv-decision-icon { flex-shrink: 0; width: 26px; height: 26px; border-radius: 8px; display: grid;
          place-items: center; background: var(--brand-soft); color: var(--brand); }
        .tfv-decision-title { font-size: 12.5px; font-weight: 650; color: var(--ink); margin-bottom: 3px; }
        .tfv-decision-body { font-size: 11.5px; color: var(--muted); line-height: 1.55; }

        .tfv-heaviest { margin-top: 14px; display: flex; flex-direction: column; gap: 7px; }
        .tfv-heaviest-title { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); }
        .tfv-heaviest-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 2fr) auto; gap: 10px; align-items: center; }
        .tfv-heaviest-name { font-size: 12px; color: var(--ink-2); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tfv-heaviest-bar { display: block; height: 6px; border-radius: 99px; background: var(--slate-soft); overflow: hidden; }
        .tfv-heaviest-bar i { display: block; height: 100%; border-radius: 99px; background: var(--brand); }
        .tfv-heaviest-size { font-size: 11px; color: var(--faint); white-space: nowrap; }

        .tfv-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
        .tfv-group { border: 1px solid var(--line-soft); border-radius: 12px; padding: 11px 12px; background: var(--surface-2); }
        .tfv-group-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
        .tfv-group-count { font-size: 11px; color: var(--faint); }
        .tfv-group-rows { display: flex; flex-direction: column; }
        .tfv-group-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 10px; padding: 6px 0;
          border-bottom: 1px dashed var(--line-soft); align-items: baseline; }
        .tfv-group-row:last-child { border-bottom: none; }
        .tfv-group-row.is-empty { opacity: 0.55; }
        .tfv-group-name { font-size: 12px; font-weight: 600; color: var(--ink-2); text-decoration: none; }
        .tfv-group-name:hover { color: var(--brand); }
        .tfv-group-size { font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
        .tfv-group-detail { grid-column: 1 / span 2; font-size: 11px; color: var(--faint); line-height: 1.45; }

        .tfv-pick { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .tfv-file { display: flex; align-items: center; gap: 8px; padding: 13px 16px; border-radius: 12px; cursor: pointer;
          border: 1px dashed color-mix(in srgb, var(--brand) 45%, transparent); background: var(--brand-soft);
          color: var(--brand); font-size: 13px; font-weight: 600; flex: 1 1 320px; min-width: 0; }
        .tfv-file:hover { border-style: solid; }
        .tfv-file input { display: none; }
        .tfv-file-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .tfv-fault { display: flex; gap: 10px; padding: 12px 14px; border-radius: 12px; margin-top: 12px;
          background: var(--red-soft); border: 1px solid color-mix(in srgb, var(--red) 24%, transparent); color: var(--red); }
        .tfv-fault svg { flex-shrink: 0; margin-top: 2px; }
        .tfv-fault-title { font-size: 13px; font-weight: 700; margin-bottom: 3px; }
        .tfv-fault-body { font-size: 12px; line-height: 1.6; color: var(--ink-2); }

        .tfv-filestats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0 18px; }

        .tfv-states { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; margin-top: 14px; }
        .tfv-state { padding: 9px 11px; border-radius: 11px; background: var(--surface-2); border: 1px solid var(--line-soft);
          opacity: 0.5; }
        .tfv-state.is-on { opacity: 1; }
        .tfv-state-n { display: block; font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--ink); }
        .tfv-state-label { display: block; font-size: 11.5px; font-weight: 650; color: var(--ink-2); margin-top: 1px; }
        .tfv-state-why { display: block; font-size: 10.5px; color: var(--faint); line-height: 1.45; margin-top: 3px; }
        .tfv-state.green .tfv-state-n { color: var(--green); }
        .tfv-state.blue .tfv-state-n { color: var(--brand); }
        .tfv-state.red .tfv-state-n { color: var(--red); }
        .tfv-state.amber .tfv-state-n { color: var(--amber); }
        .tfv-state.violet .tfv-state-n { color: var(--violet); }
        .tfv-state.cyan .tfv-state-n { color: var(--cyan); }

        .tfv-plan-head { display: flex; align-items: center; justify-content: space-between; gap: 10px;
          padding: 13px 16px; flex-wrap: wrap; border-bottom: 1px solid var(--line-soft); }
        .tfv-plan-title { display: flex; align-items: center; gap: 7px; font-size: 13.5px; font-weight: 650; color: var(--ink); }
        .tfv-plan-title svg { color: var(--brand); }
        .tfv-plan-actions { display: flex; gap: 6px; flex-wrap: wrap; }
        .tfv-plan-foot { padding: 12px 16px; border-top: 1px solid var(--line-soft); display: flex; flex-direction: column; gap: 10px; }
        .tfv-plan-foot-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
        .tfv-foot-hint { font-size: 11.5px; color: var(--faint); }
        .tfv-confirm { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--amber);
          background: var(--amber-soft); border-radius: 10px; padding: 9px 11px; line-height: 1.55; cursor: pointer; }

        .tfv-row { display: grid; gap: 10px; padding: 10px 16px; align-items: start; font-size: 12px; }
        .tfv-row .table-header, .table-header.tfv-row { font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
          text-transform: uppercase; color: var(--faint); }
        .tfv-plan-row { grid-template-columns: 26px minmax(0, 1.3fr) minmax(0, 1fr) 92px minmax(0, 1.1fr); }
        .tfv-hist { grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr) 92px 72px 78px; }
        .tfv-inv { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.6fr) 52px 66px minmax(0, 1.1fr) minmax(0, 1.1fr) minmax(0, 1.25fr); }
        /* R3-13 server-plan tables: the seal cross-check (4 columns) and the class-grouped inventory (6). */
        .tfv-per-seal { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1fr); }
        .tfv-per { grid-template-columns: minmax(0, 1fr) minmax(0, 2.1fr) 84px minmax(0, 1fr) minmax(0, 1.7fr) 104px; }
        .table-row.tfv-row.is-warn { background: var(--amber-soft); }
        .table-row.tfv-row { border-bottom: 1px solid var(--line-soft); color: var(--ink-2); }
        .table-row.tfv-row:hover { background: var(--surface-2); }
        .table-row.tfv-row.is-empty { opacity: 0.65; }
        .tfv-plan-row.is-picked { background: var(--brand-soft); }
        .tfv-check { width: 16px; height: 16px; accent-color: var(--brand); cursor: pointer; }
        .tfv-check-off { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 5px;
          background: var(--slate-soft); color: var(--faint); }
        .tfv-row a { color: var(--brand); text-decoration: none; font-size: 11px; }
        .tfv-row a:hover { text-decoration: underline; }

        .tfv-toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 4px; }
        .tfv-section { display: flex; flex-direction: column; gap: 10px; }
        .tfv-section-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
        .tfv-section-head h2 { display: flex; align-items: center; gap: 7px; font-size: 13.5px; font-weight: 650; color: var(--ink); margin: 0; }
        .tfv-section-head h2 svg { color: var(--brand); }
        .tfv-section-sub { font-size: 11.5px; color: var(--faint); }

        .tfv-fresh-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; margin-top: 12px; }
        .tfv-fresh-chip { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; padding: 9px 11px;
          border-radius: 11px; background: var(--surface-2); border: 1px solid var(--line-soft); }
        .tfv-fresh-chip b { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--ink); }
        .tfv-fresh-why { flex: 1 1 100%; font-size: 10.5px; color: var(--faint); line-height: 1.45; }

        .tfv-risk { margin-top: 13px; padding-top: 12px; border-top: 1px solid var(--line-soft); }
        .tfv-risk-head { display: flex; align-items: flex-start; gap: 7px; font-size: 12.5px; font-weight: 650;
          color: var(--ink); margin-bottom: 8px; }
        .tfv-risk-head svg { flex-shrink: 0; margin-top: 2px; color: var(--red); }
        .tfv-risk-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr) auto; gap: 10px;
          align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--line-soft); }
        .tfv-risk-row:last-of-type { border-bottom: none; }
        .tfv-risk-foot { display: flex; justify-content: flex-end; margin-top: 9px; }

        .tfv-report-summary { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
        .tfv-report-rows { display: flex; flex-direction: column; gap: 5px; }
        .tfv-report-row { display: grid; grid-template-columns: 18px minmax(0, 1.2fr) 84px minmax(0, 2fr); gap: 9px;
          align-items: baseline; padding: 7px 10px; border-radius: 9px; background: var(--surface-2); font-size: 12px; }
        .tfv-report-row svg { color: var(--green); align-self: center; }
        .tfv-report-row.is-bad svg { color: var(--red); }
        .tfv-report-label { font-weight: 600; color: var(--ink-2); min-width: 0; overflow-wrap: anywhere; }
        .tfv-report-count { font-size: 11px; color: var(--faint); white-space: nowrap; }
        .tfv-report-note { color: var(--muted); line-height: 1.5; }

        .tfv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 12px; }
        .tfv-exclude { padding: 12px 13px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface-2);
          display: flex; flex-direction: column; gap: 7px; }
        .tfv-exclude-title { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 700; color: var(--ink); }
        .tfv-exclude-title svg { color: var(--red); flex-shrink: 0; }
        .tfv-exclude-body { font-size: 11.5px; color: var(--muted); line-height: 1.6; margin: 0; }
        .tfv-exclude-link { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 600;
          color: var(--brand); text-decoration: none; margin-top: auto; }
        .tfv-exclude-link:hover { text-decoration: underline; }

        .tfv-evidence { display: flex; flex-direction: column; }
        .tfv-evidence-row { padding: 11px 0; border-bottom: 1px solid var(--line-soft); }
        .tfv-evidence-row:last-child { border-bottom: none; }
        .tfv-evidence-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
        .tfv-evidence-reason { display: flex; align-items: flex-start; gap: 6px; margin-top: 5px; font-size: 11.5px;
          color: var(--amber); line-height: 1.55; }
        .tfv-evidence-reason svg { flex-shrink: 0; margin-top: 2px; }

        .tfv-adr p { font-size: 12.5px; color: var(--muted); line-height: 1.65; margin: 0 0 10px; }
        .tfv-adr-links { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }

        @media (max-width: 900px) {
          .tfv-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 560px) {
          .tfv-stats { grid-template-columns: 1fr; }
          .tfv-heaviest-row { grid-template-columns: minmax(0, 1fr) auto; }
          .tfv-heaviest-bar { display: none; }
          .tfv-report-row { grid-template-columns: 18px minmax(0, 1fr); }
          .tfv-report-count, .tfv-report-note { grid-column: 2; }
          .tfv-risk-row { grid-template-columns: minmax(0, 1fr); gap: 3px; }
        }
      `}</style>
    </div>
  )
}

export default function VaultPage() {
  return (
    <Suspense fallback={
      <div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>
    }>
      <VaultPageInner />
    </Suspense>
  )
}
