// The books vault — one file holding every register this browser keeps.
//
// Why this exists: the app is a Supabase client for documents (invoices, bills, customers,
// products) and a localStorage client for *judgement*. Twenty-plus registers — LUTs and shipping
// bills, batches, serials, godowns, recipes, cost-centre splits, job-work lots, ITC reversal
// figures, TDS section choices, targets, the compliance calendar's done-flags — live under
// `taxflow:<name>:<orgId>` on one device (ADR-013). They are not in Supabase, so signing in
// somewhere else does not bring them back, and clearing browser data deletes a year of workpapers
// that no return can reconstruct. Every cloud competitor keeps this in their database; we chose
// offline-first, so the user has to be able to carry it. This library is that carrying.
//
// Four decisions do the work, and all four are things a "download all my data" button usually
// gets wrong:
//
//  * **The vault walks a list; it does not empty the browser.** `REGISTERS` names every
//    `taxflow:` key the app writes and says why each one is there. A sweep of `localStorage` would
//    also pick up Supabase's own session keys (`sb-*`) and anything an extension left behind — a
//    backup that quietly copies a live auth token. Listing keys is the difference between a data
//    export and a credential leak, so a key that is not in the list is not in the file, even if it
//    is on the device.
//  * **A register is restored through the module that owns it.** Every write in `applyRestore()`
//    calls that module's own `save*(orgId, value)` — never `localStorage.setItem`. So the store's
//    version check, its row parsing and its `orgId` stamping run on restore exactly as they do when
//    a page saves: a build whose recipe is missing is dropped by `parseBom`, not half-written by a
//    vault that thinks it knows better.
//  * **A restore is proved, not assumed.** After writing, each register is read back through the
//    same `load*` the owning page uses, and the report gives the rows *the app can see* — which may
//    be fewer than the rows in the file. "Wrote 212, the register reads 198" is the honest sentence
//    when a file came from a shape this build does not fully understand.
//  * **A damaged page does not void the book.** Each register carries a FNV-1a checksum over its
//    own serialised content. A block that does not match is refused and named; the other
//    restorable registers — thirty in all — still restore. It is a checksum against truncation and hand-editing, not a
//    signature — nothing here proves who wrote the file, and the page prints "checked" rather than
//    implying a security property it does not have.
//
// What v1 deliberately does NOT do: it does not touch the documents in Supabase (they come back
// with the login, and this library has no business re-inserting rows); it does not restore the
// five keys whose only writers are flows that a restore would *replay* — the offline outbox (those
// invoices are waiting for a network, and writing them back would queue the same invoice twice),
// the e-way bill log (the number belongs to the portal), the Tally import log, the command-palette
// recents and the calendar's profile. Those are collected so a person can see what the file holds,
// and marked as evidence. And the vault's own log (`taxflow:vault:`) is not in the vault — a
// backup that remembers being backed up is a loop, not a record.
//
// Since R3-9 the log does one more thing, and it is still not a loop: each recorded backup leaves a
// *fingerprint* per register (rows and the block's own checksum) on the device, never inside the
// file. `registerFreshness()` compares what this browser holds now against that memory and answers
// the question the file itself cannot — *which books moved since the last backup* — in seven states.
// It is a statement about this browser: a second laptop restoring the same file inherits the books,
// not the claim. A backup taken before fingerprints existed prints *cannot tell*, never a guess.

import { loadAudit, saveAudit } from '@/lib/audit'
import { loadBatches, loadMoves, saveBatches, saveMoves } from '@/lib/batches'
import { loadBank, saveBank } from '@/lib/bank-statement'
import { loadBom, saveBom } from '@/lib/bom'
import { isCashTaxKey, loadStatuses, saveStatuses } from '@/lib/compliance'
import { loadCC, saveCC } from '@/lib/costcentres'
import { loadExp, saveExp } from '@/lib/exports'
import { loadFilings, saveFilings } from '@/lib/filings'
import { plural, pluralNoun } from '@/lib/format'
import { loadFx, saveFx } from '@/lib/fx'
import { loadGodowns, saveGodowns } from '@/lib/godowns'
import * as gstr4 from '@/lib/gstr4'
import * as gstr9 from '@/lib/gstr9'
import { isInvoiceTemplate, loadInvoiceTemplate, saveInvoiceTemplate } from '@/lib/invoice-template'
import { loadJob, saveJob } from '@/lib/jobwork'
import { loadJournal, saveJournal } from '@/lib/journal'
import { loadOpeningBalances, saveOpeningBalances } from '@/lib/ledger'
import { loadStore, saveStore } from '@/lib/orderflow'
import { loadUpiSettings, saveUpiSettings } from '@/lib/payments'
import { loadPayroll, savePayroll } from '@/lib/payroll'
import { loadProjects, saveProjects } from '@/lib/projects'
import { loadEvents, loadUnits, saveEvents, saveUnits } from '@/lib/serials'
import { loadSetup, saveSetup } from '@/lib/setup'
import { loadSchedules, saveSchedules } from '@/lib/recurring'
import { loadSettings as loadReorder, saveSettings as saveReorder } from '@/lib/reorder'
import { loadPlan, savePlan } from '@/lib/targets'
import { loadTds, saveTds } from '@/lib/tds'

export const VAULT_KIND = 'taxflow.vault'
export const VAULT_VERSION = 1
/** The vault's own history — deliberately absent from the file it would otherwise describe. */
const KEY_VAULT_LOG = 'taxflow:vault:'
/** A file this big is a warning, not a failure: a browser download carries it, a CA's mail might not. */
export const LARGE_VAULT_CHARS = 4_000_000

// ── the shape of a register ───────────────────────────────────────────────────

export type VaultGroup = 'inventory' | 'paperwork' | 'workpapers' | 'settings' | 'evidence'

export interface RegisterSpec {
  /** Stable id, used as the key inside the file — never renumbered, only added to. */
  id: string
  /** The localStorage prefix; the org id is appended, exactly as the owning module writes it. */
  prefix: string
  label: string
  /** One line: what a person would miss if this browser were wiped. */
  what: string
  /** Singular noun for a count, so 12 prints as "12 batches". */
  unit: string
  group: VaultGroup
  /** Where the key is written. A page-local key says so, because that is a fact about restoring it. */
  module: string
  pageLabel: string
  pageHref: string
  /** `text` for the one key stored bare (`invoice-template`), `json` for everything else. */
  encoding: 'json' | 'text'
  /** Set when the app cannot put this register back — the reason is printed, not hidden. */
  reason?: string
  /** Rows in a value, counted from its shape. Tolerant, because the value may be unreadable text. */
  count: (value: unknown) => number
  /** A human summary richer than a single count. */
  detail?: (value: unknown) => string
  /** Refuse a value this module could not read back. Returns the reason, or null. */
  accepts?: (value: unknown) => string | null
  /** Write it back through the module that owns the key. */
  write?: (orgId: string, value: unknown) => void
  /** Read it back the way the owning page does; the rows returned are the rows the app can see. */
  verify?: (orgId: string, value: unknown) => number
}

// ── shape helpers every counter is built from ─────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const rec = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {})
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
/** How many entries an object holds — the idiom every map-shaped register counts on. */
export const keyCount = (v: unknown): number => Object.keys(rec(v)).length
const field = (v: unknown, name: string): unknown => rec(v)[name]
const arrCount = (v: unknown, name: string): number => list(field(v, name)).length

/** Two arrays in one envelope is the commonest register shape in this app. */
const twoLists = (a: string, b: string) => (v: unknown) => arrCount(v, a) + arrCount(v, b)

/** `2026-27` → 2026; the FY-keyed workpapers live one label at a time inside one key. */
export function fyStartOf(label: string): number {
  const y = Number.parseInt(label.slice(0, 4), 10)
  return Number.isFinite(y) && y >= 1990 && y <= 2200 ? y : NaN
}

/** One key holding many years: the FY registers count the years that declare something. */
function fyCount(contentField: string) {
  return (v: unknown) => Object.values(rec(v)).filter(s => keyCount(field(s, contentField)) > 0).length
}
function fyDetail(contentField: string) {
  return (v: unknown) => {
    const years = Object.entries(rec(v))
      .filter(([, s]) => keyCount(field(s, contentField)) > 0)
      .map(([fy]) => fy)
    return years.length ? years.join(', ') : 'nothing declared'
  }
}

// ── the inventory ─────────────────────────────────────────────────────────────

/**
 * Every `taxflow:` key the app writes, in the order a person would read them: the stock you
 * count, the paperwork you raise, the workpapers you file, the settings you chose, and the five
 * logs a backup can only show.
 */
export const REGISTERS: RegisterSpec[] = [
  {
    id: 'batches',
    prefix: 'taxflow:batches:',
    label: 'Batch and expiry register',
    what: 'Every lot received — batch number, manufacture and expiry dates, quantity, cost, which godown it stands in',
    unit: 'batch',
    group: 'inventory',
    module: 'src/lib/batches.ts',
    pageLabel: 'Batches',
    pageHref: '/inventory/batches',
    encoding: 'json',
    count: (v) => list(v).length,
    write: (orgId, v) => saveBatches(orgId, v as Parameters<typeof saveBatches>[1]),
    verify: (orgId) => loadBatches(orgId).length,
  },
  {
    id: 'batchmoves',
    prefix: 'taxflow:batchmoves:',
    label: 'Batch movements',
    what: 'The trail behind each lot: sales, transfers and adjustments, one row per movement',
    unit: 'movement',
    group: 'inventory',
    module: 'src/lib/batches.ts',
    pageLabel: 'Batches',
    pageHref: '/inventory/batches',
    encoding: 'json',
    count: (v) => list(v).length,
    write: (orgId, v) => saveMoves(orgId, v as Parameters<typeof saveMoves>[1]),
    verify: (orgId) => loadMoves(orgId).length,
  },
  {
    id: 'serials',
    prefix: 'taxflow:serials:',
    label: 'Serial-number register',
    what: 'One row per unit — serial number, cost, warranty months and the bill it arrived on',
    unit: 'unit',
    group: 'inventory',
    module: 'src/lib/serials.ts',
    pageLabel: 'Serial numbers',
    pageHref: '/inventory/serials',
    encoding: 'json',
    count: (v) => list(v).length,
    write: (orgId, v) => saveUnits(orgId, v as Parameters<typeof saveUnits>[1]),
    verify: (orgId) => loadUnits(orgId).length,
  },
  {
    id: 'serialevents',
    prefix: 'taxflow:serialevents:',
    label: 'Serial movements',
    what: 'What happened to each unit after it arrived: sold, issued into a build, returned, restocked, scrapped',
    unit: 'event',
    group: 'inventory',
    module: 'src/lib/serials.ts',
    pageLabel: 'Serial numbers',
    pageHref: '/inventory/serials',
    encoding: 'json',
    count: (v) => list(v).length,
    write: (orgId, v) => saveEvents(orgId, v as Parameters<typeof saveEvents>[1]),
    verify: (orgId) => loadEvents(orgId).length,
  },
  {
    id: 'godowns',
    prefix: 'taxflow:godowns:',
    label: 'Godown registry',
    what: 'The places stock stands — names, codes, addresses, contacts and which ones are closed',
    unit: 'godown',
    group: 'inventory',
    module: 'src/lib/godowns.ts',
    pageLabel: 'Godowns',
    pageHref: '/inventory/godowns',
    encoding: 'json',
    // Main is virtual until someone edits it, so the registry always reads one row more than the
    // key stores. The file carries what was stored; the page shows what the loader adds back.
    count: (v) => list(v).length,
    detail: (v) => `${plural(list(v).length, 'stored row')} · Main is added back on read`,
    write: (orgId, v) => saveGodowns(orgId, v as Parameters<typeof saveGodowns>[1]),
    // Proof by identity, not by length: this loader hands back the virtual Main as well as the
    // stored rows, so a count would read one higher than the file. The rows that came back are the
    // stored ids that survived the parse and are still on the registry.
    verify: (orgId, v) => {
      const stored = new Set(list(v).map(g => str(rec(g).id)).filter(Boolean))
      return loadGodowns(orgId).filter(g => stored.has(g.id)).length
    },
  },
  {
    id: 'bom',
    prefix: 'taxflow:bom:',
    label: 'Recipes, builds and shop rates',
    what: 'Bill-of-material recipes with their labour and overhead minutes, what each build actually drew and from which lots, the variance against the recipe, the job numbers and the dated shop-rate rows that price the minutes',
    unit: 'row',
    group: 'inventory',
    module: 'src/lib/bom.ts',
    pageLabel: 'Recipes & builds',
    pageHref: '/inventory/recipes',
    encoding: 'json',
    count: (v) => arrCount(v, 'recipes') + arrCount(v, 'builds') + arrCount(v, 'rates'),
    detail: (v) => `${plural(arrCount(v, 'recipes'), 'recipe')} · ${plural(arrCount(v, 'builds'), 'build')} · ${plural(arrCount(v, 'rates'), 'rate row')} · ${keyCount(field(v, 'seq'))} job counters`,
    write: (orgId, v) => saveBom(orgId, v as Parameters<typeof saveBom>[1]),
    verify: (orgId) => { const s = loadBom(orgId); return s.recipes.length + s.builds.length + s.rates.length },
  },
  {
    id: 'challan',
    prefix: 'taxflow:challan:',
    label: 'Delivery challans',
    what: 'Rule 55 challans and stock transfers, with their lines, e-way bill references and the number series behind them',
    unit: 'challan',
    group: 'paperwork',
    module: 'src/lib/orderflow.ts',
    pageLabel: 'Delivery challans',
    pageHref: '/challans',
    encoding: 'json',
    count: (v) => arrCount(v, 'docs'),
    detail: (v) => `${plural(arrCount(v, 'docs'), 'challan')} · ${keyCount(field(v, 'seq'))} number series`,
    write: (orgId, v) => saveStore('challan', orgId, v as Parameters<typeof saveStore>[2]),
    verify: (orgId) => loadStore('challan', orgId).docs.length,
  },
  {
    id: 'sorder',
    prefix: 'taxflow:sorder:',
    label: 'Sales orders',
    what: 'Orders accepted from quotations, their lines, and how far each one has been delivered and billed',
    unit: 'order',
    group: 'paperwork',
    module: 'src/lib/orderflow.ts',
    pageLabel: 'Sales orders',
    pageHref: '/sales-orders',
    encoding: 'json',
    count: (v) => arrCount(v, 'docs'),
    detail: (v) => `${plural(arrCount(v, 'docs'), 'order')} · ${keyCount(field(v, 'seq'))} number series`,
    write: (orgId, v) => saveStore('sales_order', orgId, v as Parameters<typeof saveStore>[2]),
    verify: (orgId) => loadStore('sales_order', orgId).docs.length,
  },
  {
    id: 'porder',
    prefix: 'taxflow:porder:',
    label: 'Purchase orders',
    what: 'Orders placed with vendors, their lines, and what has actually landed against them',
    unit: 'order',
    group: 'paperwork',
    module: 'src/lib/orderflow.ts',
    pageLabel: 'Purchase orders',
    pageHref: '/purchase-orders',
    encoding: 'json',
    count: (v) => arrCount(v, 'docs'),
    detail: (v) => `${plural(arrCount(v, 'docs'), 'order')} · ${keyCount(field(v, 'seq'))} number series`,
    write: (orgId, v) => saveStore('purchase_order', orgId, v as Parameters<typeof saveStore>[2]),
    verify: (orgId) => loadStore('purchase_order', orgId).docs.length,
  },
  {
    id: 'rec',
    prefix: 'taxflow:rec:',
    label: 'Recurring invoice schedules',
    what: 'Which document repeats on what cadence, at what rate, and the next date it is due',
    unit: 'schedule',
    group: 'paperwork',
    module: 'src/lib/recurring.ts',
    pageLabel: 'Recurring invoices',
    pageHref: '/recurring',
    encoding: 'json',
    count: (v) => list(v).length,
    write: (orgId, v) => saveSchedules(orgId, v as Parameters<typeof saveSchedules>[1]),
    verify: (orgId) => loadSchedules(orgId).length,
  },
  {
    id: 'jobwork',
    prefix: 'taxflow:jobwork:',
    label: 'Job-work register',
    what: 'Job workers, the lots sent out on a rule 55 challan, what came back, and the declared turnover ITC-04 runs on',
    unit: 'row',
    group: 'workpapers',
    module: 'src/lib/jobwork.ts',
    pageLabel: 'Job work',
    pageHref: '/gst/job-work',
    encoding: 'json',
    count: (v) => arrCount(v, 'workers') + arrCount(v, 'lots') + arrCount(v, 'dispositions'),
    detail: (v) => `${plural(arrCount(v, 'workers'), 'worker')} · ${plural(arrCount(v, 'lots'), 'lot')} · ${plural(arrCount(v, 'dispositions'), 'outcome')}`,
    write: (orgId, v) => saveJob(orgId, v as Parameters<typeof saveJob>[1]),
    verify: (orgId) => { const s = loadJob(orgId); return s.workers.length + s.lots.length + s.dispositions.length },
  },
  {
    id: 'exports',
    prefix: 'taxflow:exports:',
    label: 'Export register',
    what: 'LUTs, shipping-bill files, the realisation window each consignment is held to, and the refund claim against it',
    unit: 'row',
    group: 'workpapers',
    module: 'src/lib/exports.ts',
    pageLabel: 'Exports',
    pageHref: '/gst/exports',
    encoding: 'json',
    count: twoLists('luts', 'files'),
    detail: (v) => `${plural(arrCount(v, 'luts'), 'LUT')} · ${plural(arrCount(v, 'files'), 'export file')}`,
    write: (orgId, v) => saveExp(orgId, v as Parameters<typeof saveExp>[1]),
    verify: (orgId) => { const s = loadExp(orgId); return s.luts.length + s.files.length },
  },
  {
    id: 'fx',
    prefix: 'taxflow:fx:',
    label: 'Foreign currency register',
    what: 'Dated rate rows with the source they came from, and every foreign-rupee document valued against them',
    unit: 'row',
    group: 'workpapers',
    module: 'src/lib/fx.ts',
    pageLabel: 'Foreign currency',
    pageHref: '/fx',
    encoding: 'json',
    count: twoLists('rates', 'entries'),
    detail: (v) => `${plural(arrCount(v, 'rates'), 'rate')} · ${plural(arrCount(v, 'entries'), 'document')}`,
    write: (orgId, v) => saveFx(orgId, v as Parameters<typeof saveFx>[1]),
    verify: (orgId) => { const s = loadFx(orgId); return s.rates.length + s.entries.length },
  },
  {
    id: 'ccentres',
    prefix: 'taxflow:ccentres:',
    label: 'Cost centres and splits',
    what: 'The centres, and the percentage split of each document between them — shares only, never a rupee',
    unit: 'row',
    group: 'workpapers',
    module: 'src/lib/costcentres.ts',
    pageLabel: 'Cost centres',
    pageHref: '/cost-centres',
    encoding: 'json',
    count: twoLists('centres', 'allocations'),
    detail: (v) => `${plural(arrCount(v, 'centres'), 'centre')} · ${plural(arrCount(v, 'allocations'), 'split')}`,
    write: (orgId, v) => saveCC(orgId, v as Parameters<typeof saveCC>[1]),
    verify: (orgId) => { const s = loadCC(orgId); return s.centres.length + s.allocations.length },
  },
  {
    id: 'projects',
    prefix: 'taxflow:projects:',
    label: 'Projects and time',
    what: 'Projects, the hours booked against them — each optionally naming the payroll-register person whose wages priced it, or drawn from that register\'s kept day book — and the documents attached by number; measurements, never a rupee',
    unit: 'row',
    group: 'workpapers',
    module: 'src/lib/projects.ts',
    pageLabel: 'Projects',
    pageHref: '/projects',
    encoding: 'json',
    count: (v) => arrCount(v, 'projects') + arrCount(v, 'entries') + arrCount(v, 'tags'),
    detail: (v) => `${plural(arrCount(v, 'projects'), 'project')} · ${plural(arrCount(v, 'entries'), 'time entry')}`,
    write: (orgId, v) => saveProjects(orgId, v as Parameters<typeof saveProjects>[1]),
    verify: (orgId) => { const s = loadProjects(orgId); return s.projects.length + s.entries.length + s.tags.length },
  },
  {
    id: 'payroll',
    prefix: 'taxflow:payroll:',
    label: 'Payroll register',
    what: 'The salary structure of each employee, the letterhead a payslip prints under, the month rows behind a slip, and the day book — one attendance mark per person per day, which holds no money until it is pulled into a month row',
    unit: 'row',
    group: 'workpapers',
    module: 'src/lib/payroll.ts',
    pageLabel: 'Payroll',
    pageHref: '/payroll',
    encoding: 'json',
    count: (v) => arrCount(v, 'employees') + arrCount(v, 'inputs') + arrCount(v, 'attendance'),
    detail: (v) => `${plural(arrCount(v, 'employees'), 'employee')} · ${plural(arrCount(v, 'inputs'), 'month row')} · ${plural(arrCount(v, 'attendance'), 'day mark')}`,
    // A store the parser cannot read back comes out empty, so a wrong-version file would restore as
    // a blank register and look like a success. Refused by shape instead.
    accepts: (v) => (isObj(v) && Array.isArray(field(v, 'employees')) && Array.isArray(field(v, 'inputs'))
      ? null
      : 'not a payroll register — employees and month rows are both missing'),
    write: (orgId, v) => savePayroll(orgId, v as Parameters<typeof savePayroll>[1]),
    verify: (orgId) => { const s = loadPayroll(orgId); return s.employees.length + s.inputs.length + s.attendance.length },
  },
  {
    id: 'audit',
    prefix: 'taxflow:audit:',
    label: 'Audit trail and period seals',
    what: 'The append-only record of every period sealed, seal released, refused write and note — who decided, whether a closed period can still be typed over, and the close figures a sealed month kept',
    unit: 'record',
    group: 'workpapers',
    module: 'src/lib/audit.ts',
    pageLabel: 'Audit & locks',
    pageHref: '/audit',
    encoding: 'json',
    count: (v) => arrCount(v, 'seals') + arrCount(v, 'events'),
    detail: (v) => `${plural(arrCount(v, 'seals'), 'seal')} · ${plural(arrCount(v, 'events'), 'event')}`,
    // A store the parser cannot read back comes out empty, so a wrong-version file would restore as a
    // blank trail and look like a success. Refused by shape — seals and events must both be arrays.
    accepts: (v) => (isObj(v) && Array.isArray(field(v, 'seals')) && Array.isArray(field(v, 'events'))
      ? null
      : 'not an audit register — the seals list and the events list are both missing'),
    write: (orgId, v) => saveAudit(orgId, v as Parameters<typeof saveAudit>[1]),
    verify: (orgId) => { const s = loadAudit(orgId); return s.seals.length + s.events.length },
  },
  {
    id: 'journal',
    prefix: 'taxflow:journal:',
    label: 'Journal register',
    what: 'The shop\'s own heads — each naming the statement line it moves — and every manual entry struck against them: drafts, postings, reversals, the number each carried and the series that gave it',
    unit: 'row',
    group: 'workpapers',
    module: 'src/lib/journal.ts',
    pageLabel: 'Journal entries',
    pageHref: '/journal',
    encoding: 'json',
    count: (v) => arrCount(v, 'heads') + arrCount(v, 'entries'),
    detail: (v) => `${plural(arrCount(v, 'heads'), 'head')} · ${plural(arrCount(v, 'entries'), 'posting')}`,
    // The register reads back through `parseJournal`, which drops a leg naming a head the file never
    // carried. A wrong-version file would restore as a shorter register and print as a success, so
    // the two lists are required by shape before anything is written.
    accepts: (v) => (isObj(v) && Array.isArray(field(v, 'heads')) && Array.isArray(field(v, 'entries'))
      ? null
      : 'not a journal register — the head list and the entry list are both missing'),
    write: (orgId, v) => saveJournal(orgId, v as Parameters<typeof saveJournal>[1]),
    verify: (orgId) => { const s = loadJournal(orgId); return s.heads.length + s.entries.length },
  },
  {
    id: 'filings',
    prefix: 'taxflow:filings:',
    label: 'Filings & amendments register',
    what: 'What the shop states each return is — status, the date it was due and where that date came from, the figures the return states, the fee and interest recorded as paid — beside every amendment it carries and the window that governs it',
    unit: 'row',
    group: 'workpapers',
    module: 'src/lib/filings.ts',
    pageLabel: 'Filings & amendments',
    pageHref: '/gst/filings',
    encoding: 'json',
    count: (v) => arrCount(v, 'filings') + arrCount(v, 'amendments'),
    detail: (v) => `${plural(arrCount(v, 'filings'), 'return')} · ${plural(arrCount(v, 'amendments'), 'amendment')}`,
    // The register is one row per form and period, so a hand-edited duplicate would restore as two
    // rows describing the same return. `parseFilings` keeps the first and drops the rest; requiring
    // both arrays by shape means a wrong-version file is refused here rather than restored as an
    // empty register that prints as a success.
    accepts: (v) => (isObj(v) && Array.isArray(field(v, 'filings')) && Array.isArray(field(v, 'amendments'))
      ? null
      : 'not a filings register — the return list and the amendment list are both missing'),
    write: (orgId, v) => saveFilings(orgId, v as Parameters<typeof saveFilings>[1]),
    verify: (orgId) => { const s = loadFilings(orgId); return s.filings.length + s.amendments.length },
  },
  {
    id: 'gstr9',
    prefix: 'taxflow:gstr9:',
    label: 'GSTR-9 / 9C workpaper',
    what: 'Filed month flags, the ITC reversal heads under rules 42/43, and the table 8/9 dues a return states but the books do not',
    unit: 'financial year',
    group: 'workpapers',
    module: 'src/lib/gstr9.ts',
    pageLabel: 'GSTR-9 workpaper',
    pageHref: '/gst/gstr9',
    encoding: 'json',
    count: fyCount('months'),
    detail: fyDetail('months'),
    // Each year is written back through the module's own `saveFy`, so the FY label is re-derived
    // from the calendar rather than trusted from the file.
    write: (orgId, v) => {
      for (const [label, state] of Object.entries(rec(v))) {
        // A year with nothing declared is not restored: `saveFy` would create an empty FY row
        // that the workpaper then shows as a filed-though-blank period.
        if (keyCount(field(state, 'months')) === 0) continue
        const start = fyStartOf(label)
        if (!Number.isNaN(start)) gstr9.saveFy(orgId, start, state as Parameters<typeof gstr9.saveFy>[2])
      }
    },
    verify: (orgId, v) => Object.entries(rec(v))
      .filter(([label]) => !Number.isNaN(fyStartOf(label)))
      .filter(([label]) => gstr9.isDeclared(gstr9.loadFy(orgId, fyStartOf(label)))).length,
  },
  {
    id: 'gstr4',
    prefix: 'taxflow:gstr4:',
    label: 'GSTR-4 / CMP-08 workpaper',
    what: 'Quarterly figures as deposited for a composition dealer, and the stock transferred in from other GSTINs of the same PAN',
    unit: 'financial year',
    group: 'workpapers',
    module: 'src/lib/gstr4.ts',
    pageLabel: 'GSTR-4 workpaper',
    pageHref: '/gst/gstr4',
    encoding: 'json',
    count: fyCount('quarters'),
    detail: fyDetail('quarters'),
    write: (orgId, v) => {
      for (const [label, state] of Object.entries(rec(v))) {
        if (keyCount(field(state, 'quarters')) === 0) continue
        const start = fyStartOf(label)
        if (!Number.isNaN(start)) gstr4.saveFy(orgId, start, state as Parameters<typeof gstr4.saveFy>[2])
      }
    },
    verify: (orgId, v) => Object.entries(rec(v))
      .filter(([label]) => !Number.isNaN(fyStartOf(label)))
      .filter(([label]) => gstr4.isDeclared(gstr4.loadFy(orgId, fyStartOf(label)))).length,
  },
  {
    id: 'tds',
    prefix: 'taxflow:tds:',
    label: 'TDS and 194Q workpaper',
    what: 'Which section each supplier falls under, the payer type, and the challans deposited against each month',
    unit: 'figure',
    group: 'workpapers',
    module: 'src/lib/tds.ts',
    pageLabel: 'TDS / 194Q',
    pageHref: '/tds',
    encoding: 'json',
    count: (v) => keyCount(field(v, 'vendorSection')) + keyCount(field(v, 'billSection')) + keyCount(field(v, 'challans')),
    detail: (v) => `${keyCount(field(v, 'vendorSection')) + keyCount(field(v, 'billSection'))} section choices · ${keyCount(field(v, 'challans'))} challans`,
    write: (orgId, v) => saveTds(orgId, v as Parameters<typeof saveTds>[1]),
    verify: (orgId) => { const s = loadTds(orgId); return Object.keys(s.vendorSection).length + Object.keys(s.billSection).length + Object.keys(s.challans).length },
  },
  {
    id: 'bank',
    prefix: 'taxflow:bank:',
    label: 'Bank statements and matches',
    what: 'The statements parsed in this browser and every line you decided on — matched, unmatched or ignored',
    unit: 'row',
    group: 'workpapers',
    module: 'src/lib/bank-statement.ts',
    pageLabel: 'Bank matching',
    pageHref: '/bank',
    encoding: 'json',
    count: (v) => arrCount(v, 'statements') + keyCount(field(v, 'decisions')),
    detail: (v) => `${plural(arrCount(v, 'statements'), 'statement')} · ${keyCount(field(v, 'decisions'))} decisions`,
    write: (orgId, v) => saveBank(orgId, v as Parameters<typeof saveBank>[1]),
    verify: (orgId) => { const s = loadBank(orgId); return s.statements.length + Object.keys(s.decisions).length },
  },
  {
    id: 'compliance',
    prefix: 'taxflow:compliance:',
    label: 'Compliance calendar ticks',
    what: 'Which return was filed on which day, the reference number typed for it, and — for a QRMP quarter — the cash tax stated against it, which the deposit card on the calendar reads',
    unit: 'kept row',
    group: 'workpapers',
    module: 'src/lib/compliance.ts',
    pageLabel: 'Compliance calendar',
    pageHref: '/gst/calendar',
    encoding: 'json',
    count: (v) => keyCount(v),
    detail: (v) => {
      const keys = Object.keys(rec(v))
      const cash = keys.filter(isCashTaxKey).length
      return `${plural(keys.length - cash, 'return')} marked filed`
        + (cash ? ` · ${plural(cash, 'quarter')} with a stated cash tax` : '')
    },
    write: (orgId, v) => saveStatuses(orgId, v as Parameters<typeof saveStatuses>[1]),
    verify: (orgId) => Object.keys(loadStatuses(orgId)).length,
  },
  {
    id: 'targets',
    prefix: 'taxflow:targets:',
    label: 'Targets and budgets',
    what: 'Month-by-month sales targets, spend budgets, and the product-level goals under them',
    unit: 'figure',
    group: 'settings',
    module: 'src/lib/targets.ts',
    pageLabel: 'Targets',
    pageHref: '/targets',
    encoding: 'json',
    count: (v) => keyCount(field(v, 'sales')) + keyCount(field(v, 'expenses')) + list(field(v, 'products')).length,
    detail: (v) => `${keyCount(field(v, 'sales'))} month targets · ${keyCount(field(v, 'expenses'))} budgets · ${plural(list(field(v, 'products')).length, 'product goal')}`,
    write: (orgId, v) => savePlan(orgId, v as Parameters<typeof savePlan>[1]),
    verify: (orgId) => { const p = loadPlan(orgId); return Object.keys(p.sales).length + Object.keys(p.expenses).length + p.products.length },
  },
  {
    id: 'opening',
    prefix: 'taxflow:opening:',
    label: 'Opening balances',
    what: 'The figures the balance sheet starts from — cash in hand, cash at bank, debtors and creditors carried over, fixed assets, loans, capital — and the day the books were opened',
    unit: 'balance',
    group: 'settings',
    module: 'src/lib/ledger.ts',
    pageLabel: 'Financial statements',
    pageHref: '/accounting',
    encoding: 'json',
    // A stored zero is the same answer as no entry, so only figures that say something count.
    // `as_of` joined in R3-2 and is a date, not a rupee — it counts when it stands.
    count: (v) => Object.values(rec(v)).filter(x => typeof x === 'number' && x !== 0).length
      + (str(field(v, 'as_of')) ? 1 : 0),
    detail: (v) => `cash ${n(field(v, 'cash'))} · bank ${n(field(v, 'bank'))} · debtors ${n(field(v, 'receivables'))}`
      + ` · creditors ${n(field(v, 'payables'))} · assets ${n(field(v, 'fixedAssets'))}`
      + ` · loans ${n(field(v, 'loans'))} · capital ${n(field(v, 'capital'))}`
      + (str(field(v, 'as_of')) ? ` · opened ${str(field(v, 'as_of'))}` : ''),
    write: (orgId, v) => saveOpeningBalances(orgId, v as Parameters<typeof saveOpeningBalances>[1]),
    verify: (orgId) => {
      const o = loadOpeningBalances(orgId) as unknown as Record<string, unknown>
      return Object.values(o).filter(x => typeof x === 'number' && x !== 0).length + (o.as_of ? 1 : 0)
    },
  },
  {
    id: 'setup',
    prefix: 'taxflow:setup:',
    label: 'Business setup — branches & series',
    what: 'The branch register documents are issued under, and the document series that dresses each number — the counters themselves stayed where they were',
    unit: 'record',
    group: 'settings',
    module: 'src/lib/setup.ts',
    pageLabel: 'Business register',
    pageHref: '/business',
    encoding: 'json',
    count: (v) => arrCount(v, 'branches') + arrCount(v, 'series'),
    detail: (v) => {
      const b = arrCount(v, 'branches')
      const s = arrCount(v, 'series')
      return `${plural(b, 'branch')} · ${plural(s, 'series override')}`
    },
    // Refused by shape, like the audit register: the parser reads a wrong-version file as empty,
    // and a blank register restored over a kept one looks like success.
    accepts: (v) => (isObj(v) && Array.isArray(field(v, 'branches')) && Array.isArray(field(v, 'series'))
      ? null
      : 'not a branch & series register — the branches list and the series list are both missing'),
    write: (orgId, v) => saveSetup(orgId, v as Parameters<typeof saveSetup>[1]),
    verify: (orgId) => { const s = loadSetup(orgId); return s.branches.length + s.series.length },
  },
  {
    id: 'reorder',
    prefix: 'taxflow:reorder:',
    label: 'Reorder planner settings',
    what: 'The horizon, lead times and safety factor the planner multiplies the run rate by',
    unit: 'setting',
    group: 'settings',
    module: 'src/lib/reorder.ts',
    pageLabel: 'Reorder planner',
    pageHref: '/inventory/reorder',
    encoding: 'json',
    count: (v) => 1 + keyCount(field(v, 'leadByProduct')),
    detail: (v) => `${n(field(v, 'windowDays'))}-day horizon · ${n(field(v, 'leadDays'))}-day lead · ${keyCount(field(v, 'leadByProduct'))} per-product overrides`,
    write: (orgId, v) => saveReorder(orgId, v as Parameters<typeof saveReorder>[1]),
    verify: (orgId) => 1 + Object.keys(loadReorder(orgId).leadByProduct).length,
  },
  {
    id: 'upi',
    prefix: 'taxflow:upi:',
    label: 'UPI and payment-link settings',
    what: 'The VPA, the payee name a customer sees, and which reminder wording is used',
    unit: 'setting',
    group: 'settings',
    module: 'src/lib/payments.ts',
    pageLabel: 'Payment links',
    pageHref: '/payments/links',
    encoding: 'json',
    count: (v) => (str(field(v, 'vpa')) ? 1 : 0),
    detail: (v) => (str(field(v, 'vpa')) ? `VPA ${str(field(v, 'vpa'))}` : 'no VPA saved'),
    write: (orgId, v) => saveUpiSettings(orgId, v as Parameters<typeof saveUpiSettings>[1]),
    verify: (orgId) => (loadUpiSettings(orgId).vpa ? 1 : 0),
  },
  {
    id: 'invoice-template',
    prefix: 'taxflow:invoice-template:',
    label: 'Invoice document skin',
    what: 'Which of the three layouts this browser prints invoices with',
    unit: 'choice',
    group: 'settings',
    module: 'src/lib/invoice-template.ts',
    pageLabel: 'Invoice document',
    pageHref: '/invoices',
    encoding: 'text',
    // Stored bare — `modern`, not `"modern"` — because that is how the document has always written it.
    count: (v) => (str(v) ? 1 : 0),
    detail: (v) => str(v) || 'classic',
    accepts: (v) => (isInvoiceTemplate(v) ? null : 'not one of the three layout names'),
    write: (orgId, v) => saveInvoiceTemplate(orgId, v as 'classic' | 'modern' | 'minimal'),
    verify: (orgId) => (loadInvoiceTemplate(orgId) ? 1 : 0),
  },
  {
    id: 'outbox',
    prefix: 'taxflow:outbox:',
    label: 'Offline invoice outbox',
    what: 'Invoices created with no network, waiting to be pushed into the books',
    unit: 'invoice',
    group: 'evidence',
    module: 'src/lib/outbox.ts',
    pageLabel: 'Offline sync',
    pageHref: '/offline',
    encoding: 'json',
    reason: 'These are invoices waiting for a connection. A restore would queue the same invoice twice, and the sync already running would write it again.',
    count: (v) => list(v).length,
    detail: (v) => `${plural(list(v).length, 'queued invoice')} · ${list(v).filter(e => field(e, 'status') === 'pending').length} pending, ${list(v).filter(e => field(e, 'status') === 'error').length} errored`,
  },
  {
    id: 'ewb',
    prefix: 'taxflow:ewb:',
    label: 'E-way bill log',
    what: 'Every bill number generated here or typed in, with the date its validity ends',
    unit: 'bill',
    group: 'evidence',
    module: 'src/lib/registers.ts',
    pageLabel: 'Statutory registers',
    pageHref: '/reports/registers',
    encoding: 'json',
    reason: 'The number belongs to the portal, not to this browser. Re-adding one here would claim a bill the transporter side may never have seen.',
    count: (v) => list(v).length,
  },
  {
    id: 'tally',
    prefix: 'taxflow:tally:',
    label: 'Tally import log',
    what: 'Which XML file was imported when, and how many customers, products and invoices it wrote',
    unit: 'import',
    group: 'evidence',
    module: 'src/lib/tally.ts',
    pageLabel: 'Tally bridge',
    pageHref: '/tally',
    encoding: 'json',
    reason: 'A log of files that live on your disk. The rows it wrote are in the database and come back with the login.',
    count: (v) => list(v).length,
  },
  {
    id: 'palette-recents',
    prefix: 'taxflow:palette-recents:',
    label: 'Command palette recents',
    what: 'The last few places this browser was pointed at with ⌘K',
    unit: 'entry',
    group: 'evidence',
    module: 'src/lib/commands.ts',
    pageLabel: 'Command palette',
    pageHref: '/dashboard',
    encoding: 'json',
    reason: 'A list of what you clicked. Carrying it to another machine restores nothing a person would miss.',
    count: (v) => list(v).length,
  },
  {
    id: 'compliance-profile',
    prefix: 'taxflow:compliance-profile:',
    label: 'Calendar profile',
    what: 'Filing frequency, turnover slab and the notifications the calendar is allowed to raise',
    unit: 'setting',
    group: 'evidence',
    // Written by the page, not by a library — which is exactly why the vault cannot put it back.
    module: 'src/app/(app)/gst/calendar/page.tsx',
    pageLabel: 'Compliance calendar',
    pageHref: '/gst/calendar',
    encoding: 'json',
    reason: 'The calendar screen owns this key and writes it from its own state; there is no library save to restore through.',
    count: (v) => keyCount(v),
  },
]

/** Ids the file format is allowed to carry — a future build reads an unknown id and refuses it. */
export const REGISTER_IDS = REGISTERS.map(r => r.id)

export function specById(id: string): RegisterSpec | undefined {
  return REGISTERS.find(r => r.id === id)
}

// ── the checksum ──────────────────────────────────────────────────────────────

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * FNV-1a over the UTF-8 bytes of a serialised register, as eight hex digits.
 *
 * It answers one question — is this block the block that was written? — and answers it well
 * against a truncated download or a hand-edit. It is not a signature: nothing here proves which
 * machine wrote the file, so the page says "checked", never "verified".
 */
export function checksum(text: string): string {
  const bytes: Uint8Array | number[] = typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(text)
    : Array.from(text, c => c.charCodeAt(0) & 0xff)
  let h = FNV_OFFSET
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] & 0xff
    h = Math.imul(h, FNV_PRIME) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ── the file format ───────────────────────────────────────────────────────────

export interface VaultRegister {
  /** Rows counted from the value at the moment the backup was taken. */
  rows: number
  /** Characters of serialised JSON, so a person can see which register is the heavy one. */
  chars: number
  /** FNV-1a over `JSON.stringify(data)` — the exact text a restore re-serialises to check it. */
  checksum: string
  /** The register's own value, or the raw text when it could not be parsed. */
  data: unknown
  /** Set when the stored value was unreadable, so the file keeps the damage instead of hiding it. */
  note?: string
}

export interface VaultFile {
  kind: typeof VAULT_KIND
  version: number
  app: 'TaxFlow India'
  created_at: string
  org_id: string
  org_name: string
  counts: { registers: number; rows: number; chars: number }
  registers: Record<string, VaultRegister>
}

const storage = (): Storage | null => {
  if (typeof window === 'undefined') return null
  try { return window.localStorage } catch { return null }
}

/** The value exactly as the owning module wrote it, before any parsing. */
function rawOf(prefix: string, orgId: string): string | null {
  const s = storage()
  if (!s || !orgId) return null
  try { return s.getItem(prefix + orgId) } catch { return null }
}

/** The checksum of a stored value, computed the same way whether it came from disk or from here. */
function checksumOf(spec: RegisterSpec, raw: string): string {
  if (spec.encoding === 'text') return checksum(JSON.stringify(raw))
  try { return checksum(JSON.stringify(JSON.parse(raw))) } catch { return '' }
}

function pack(spec: RegisterSpec, orgId: string): VaultRegister | null {
  const raw = rawOf(spec.prefix, orgId)
  if (raw === null || raw === '') return null
  if (spec.encoding === 'text') {
    const serial = JSON.stringify(raw)
    return { rows: spec.count(raw), chars: serial.length, checksum: checksum(serial), data: raw }
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    // Keep the broken text rather than dropping the register: a vault that quietly omitted a
    // damaged page would report a smaller file instead of a damaged book.
    const serial = JSON.stringify(raw)
    return {
      rows: 0,
      chars: serial.length,
      checksum: checksum(serial),
      data: raw,
      note: 'this register was not readable as data when the backup ran — kept as text',
    }
  }
  const serial = JSON.stringify(data)
  return { rows: spec.count(data), chars: serial.length, checksum: checksum(serial), data }
}

/** Everything this browser holds, in one object that is safe to write to disk. */
export function collectVault(orgId: string, orgName = '', now = new Date()): VaultFile {
  const registers: Record<string, VaultRegister> = {}
  let rows = 0
  let chars = 0
  for (const spec of REGISTERS) {
    const packed = pack(spec, orgId)
    if (!packed) continue
    registers[spec.id] = packed
    rows += packed.rows
    chars += packed.chars
  }
  return {
    kind: VAULT_KIND,
    version: VAULT_VERSION,
    app: 'TaxFlow India',
    created_at: now.toISOString(),
    org_id: orgId,
    org_name: orgName,
    counts: { registers: Object.keys(registers).length, rows, chars },
    registers,
  }
}

export function serializeVault(vault: VaultFile): string {
  return JSON.stringify(vault, null, 2)
}

/** `taxflow-vault-<org>-2026-10-09.json` — the business is in the name because two of them differ. */
export function vaultFilename(vault: VaultFile, now = new Date()): string {
  const org = (vault.org_name || vault.org_id || 'books')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'books'
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `taxflow-vault-${org}-${d}.json`
}

// ── reading a file back ───────────────────────────────────────────────────────

export type VaultFault = 'empty' | 'not-json' | 'not-a-vault' | 'future-version' | 'no-registers'

export interface VaultRead {
  vault?: VaultFile
  fault?: VaultFault
  /** What was actually seen — the `kind` that arrived, the version number, the first characters. */
  detail?: string
}

export const VAULT_FAULT_COPY: Record<VaultFault, string> = {
  empty: 'The file is empty. A download that never finished looks exactly like this.',
  'not-json': 'This is not JSON. A vault is a .json file; a Tally export is XML and a report is a CSV.',
  'not-a-vault': 'JSON, but not a vault — there is no "kind": "taxflow.vault" at the top of it.',
  'future-version': 'Written by a newer version of the app. Upgrade before restoring, or the registers it describes may not exist here.',
  'no-registers': 'A vault with no registers in it: nothing was stored in that browser when the file was made.',
}

/** Typed refusals only: someone holding a CSV, a Tally dump or a truncated download gets a reason. */
export function readVault(text: string): VaultRead {
  if (!text || !text.trim()) return { fault: 'empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { fault: 'not-json', detail: `${text.trim().slice(0, 40)}… — ${(e as Error).message}` }
  }
  if (!isObj(parsed)) return { fault: 'not-a-vault', detail: 'the file holds a value, not a vault' }
  const o = parsed
  if (str(o.kind) !== VAULT_KIND) {
    return {
      fault: 'not-a-vault',
      detail: o.kind === undefined ? 'no kind — this is not a TaxFlow vault' : `kind is "${str(o.kind)}"`,
    }
  }
  const version = n(o.version)
  if (version > VAULT_VERSION) {
    return { fault: 'future-version', detail: `version ${version}; this build writes ${VAULT_VERSION}` }
  }
  const registers = rec(o.registers)
  if (!Object.keys(registers).length) return { fault: 'no-registers' }
  return {
    vault: {
      kind: VAULT_KIND,
      version: VAULT_VERSION,
      app: 'TaxFlow India',
      created_at: str(o.created_at),
      org_id: str(o.org_id),
      org_name: str(o.org_name),
      counts: {
        registers: Object.keys(registers).length,
        rows: n(rec(o.counts).rows),
        chars: n(rec(o.counts).chars),
      },
      registers: registers as Record<string, VaultRegister>,
    },
  }
}

// ── the plan ──────────────────────────────────────────────────────────────────

export type PlanState =
  | 'new'
  | 'same'
  | 'replace'
  | 'blank'
  | 'evidence'
  | 'damaged'
  | 'foreign'
  | 'absent'
  | 'unknown'

export interface PlanRow {
  id: string
  label: string
  what: string
  unit: string
  group: VaultGroup
  module: string
  pageLabel: string
  pageHref: string
  state: PlanState
  /** Rows in the file for this register; null when the file does not carry it. */
  fileRows: number | null
  /** Rows this browser shows for the same key right now. */
  browserRows: number
  detail: string
  /** Set when restoring would clear content the browser has and the file does not. */
  warning: string
  note: string
  selectable: boolean
}

export interface RestorePlan {
  orgId: string
  vault: VaultFile
  /** False when the file was taken against a different business — then no row is restorable. */
  sameOrg: boolean
  rows: PlanRow[]
  counts: Record<PlanState, number>
  /** Registers the file carries that this build has never heard of. */
  unknown: string[]
  chars: number
}

const EMPTY_COUNTS: Record<PlanState, number> = {
  new: 0, same: 0, replace: 0, blank: 0, evidence: 0, damaged: 0, foreign: 0, absent: 0, unknown: 0,
}

export const PLAN_STATE_META: Record<PlanState, { label: string; tone: 'blue' | 'green' | 'red' | 'amber' | 'violet' | 'cyan' | 'grey'; why: string }> = {
  new: { label: 'Will add', tone: 'green', why: 'the file has this register and this browser does not' },
  same: { label: 'Unchanged', tone: 'grey', why: 'the same checksum is already here' },
  replace: { label: 'Will replace', tone: 'blue', why: 'both hold content, and the file is the copy being restored' },
  blank: { label: 'Will clear', tone: 'red', why: 'the file holds an empty register while this browser holds rows' },
  evidence: { label: 'Shown only', tone: 'amber', why: 'the app keeps this log but has no register save to restore it through' },
  damaged: { label: 'Refused', tone: 'red', why: 'the checksum does not match the content, so this block was edited or truncated' },
  foreign: { label: 'Other business', tone: 'violet', why: 'the file was taken against a different organisation' },
  absent: { label: 'Not in file', tone: 'grey', why: 'the backup predates this register, or it was empty when the backup ran' },
  unknown: { label: 'Unknown key', tone: 'amber', why: 'a newer build wrote something this version cannot name' },
}

/** A value the owning module could not read back is refused block by block, never written. */
function acceptsValue(spec: RegisterSpec, data: unknown): string | null {
  if (spec.encoding === 'json' && typeof data === 'string') {
    return 'the value was unreadable when the backup was taken'
  }
  if (spec.encoding === 'json' && !isObj(data) && !Array.isArray(data)) return 'not an object or a list'
  return spec.accepts ? spec.accepts(data) : null
}

/** One row per register the file or this build knows about, with the decision the app will make. */
export function planRestore(vault: VaultFile, orgId: string): RestorePlan {
  const sameOrg = !vault.org_id || vault.org_id === orgId
  const ids = [...REGISTER_IDS, ...Object.keys(vault.registers).filter(id => !REGISTER_IDS.includes(id))]
  const counts: Record<PlanState, number> = { ...EMPTY_COUNTS }
  const unknown: string[] = []
  const rows: PlanRow[] = []

  for (const id of ids) {
    const spec = specById(id)
    const entry = vault.registers[id]

    if (!spec) {
      unknown.push(id)
      counts.unknown++
      rows.push({
        id, label: `Unrecognised register "${id}"`, what: 'Written by a version of the app newer than this one.',
        unit: 'row', group: 'evidence', module: 'unknown', pageLabel: 'Vault', pageHref: '/vault',
        state: 'unknown', fileRows: entry ? n(entry.rows) : null, browserRows: 0,
        detail: entry ? `${n(entry.chars)} characters held under this name` : '',
        warning: '', note: 'left in the file, untouched here', selectable: false,
      })
      continue
    }

    const browserRaw = rawOf(spec.prefix, orgId)
    let browserRows = 0
    if (browserRaw) {
      try { browserRows = spec.count(spec.encoding === 'text' ? browserRaw : JSON.parse(browserRaw)) } catch { browserRows = 0 }
    }
    const base = {
      id, label: spec.label, what: spec.what, unit: spec.unit, group: spec.group, module: spec.module,
      pageLabel: spec.pageLabel, pageHref: spec.pageHref, browserRows,
    }

    if (!entry) {
      counts.absent++
      rows.push({
        ...base, state: 'absent', fileRows: null,
        detail: browserRows ? plural(browserRows, spec.unit) : 'nothing here either',
        warning: '', note: 'restoring will not touch it', selectable: false,
      })
      continue
    }

    const fileRows = n(entry.rows)
    const detail = spec.detail ? spec.detail(entry.data) : plural(fileRows, spec.unit)

    if (!sameOrg) {
      counts.foreign++
      rows.push({ ...base, state: 'foreign', fileRows, detail, warning: '', note: `taken against ${vault.org_id.slice(0, 8)}…`, selectable: false })
      continue
    }
    if (str(entry.checksum) !== checksum(JSON.stringify(entry.data))) {
      counts.damaged++
      rows.push({ ...base, state: 'damaged', fileRows, detail, warning: '', note: 'checksum does not match — this block alone is refused', selectable: false })
      continue
    }
    const refusal = acceptsValue(spec, entry.data)
    if (refusal) {
      counts.damaged++
      rows.push({ ...base, state: 'damaged', fileRows: 0, detail, warning: '', note: `refused: ${refusal}`, selectable: false })
      continue
    }
    if (!spec.write) {
      counts.evidence++
      rows.push({ ...base, state: 'evidence', fileRows, detail, warning: '', note: spec.reason || 'no register save to restore through', selectable: false })
      continue
    }
    if (fileRows === 0 && browserRows === 0) {
      counts.same++
      rows.push({ ...base, state: 'same', fileRows, detail, warning: '', note: 'nothing to move', selectable: false })
      continue
    }
    if (fileRows === 0 && browserRows > 0) {
      counts.blank++
      rows.push({
        ...base, state: 'blank', fileRows, detail,
        warning: `restoring would clear ${plural(browserRows, spec.unit)} this browser still holds`,
        note: 'left unselected on purpose', selectable: true,
      })
      continue
    }
    if (browserRaw && checksumOf(spec, browserRaw) === str(entry.checksum)) {
      counts.same++
      rows.push({ ...base, state: 'same', fileRows, detail, warning: '', note: 'already here, byte for byte', selectable: false })
      continue
    }
    if (!browserRaw || browserRows === 0) {
      counts.new++
      rows.push({ ...base, state: 'new', fileRows, detail, warning: '', note: '', selectable: true })
      continue
    }
    counts.replace++
    rows.push({
      ...base, state: 'replace', fileRows,
      detail: `${plural(browserRows, spec.unit)} here → ${detail}`,
      warning: '', note: '', selectable: true,
    })
  }

  return { orgId, vault, sameOrg, rows, counts, unknown, chars: vault.counts.chars }
}

/** The rows a person restores without reading the table: content the file has and the browser does not. */
export function defaultSelection(plan: RestorePlan): string[] {
  return plan.rows.filter(r => r.selectable && r.state !== 'blank').map(r => r.id)
}

// ── the restore ───────────────────────────────────────────────────────────────

export interface RestoreResult {
  id: string
  label: string
  ok: boolean
  /** Rows the file carried. */
  from: number
  /** Rows the owning page can read back after the write. */
  seen: number
  note: string
}

export interface RestoreReport {
  results: RestoreResult[]
  restored: number
  refused: number
  /** Rows the modules dropped while reading the file back — the vault reporting its own limits. */
  dropped: number
  at: string
}

/**
 * Put the named registers back, each through its own module, then read it the way that page does.
 *
 * Nothing is batched: a failure in one register is reported and the next is still tried, because a
 * vault is a stack of independent documents, not a transaction.
 */
export function applyRestore(vault: VaultFile, orgId: string, ids: string[]): RestoreReport {
  const results: RestoreResult[] = []
  const at = new Date().toISOString()
  const foreign = !!vault.org_id && vault.org_id !== orgId

  for (const id of ids) {
    const spec = specById(id)
    const entry = vault.registers[id]
    const fail = (label: string, note: string, from = entry ? n(entry.rows) : 0): void => {
      results.push({ id, label, ok: false, from, seen: 0, note })
    }

    if (!spec || !entry) { fail(id, 'this build has no register by that name'); continue }
    if (foreign) { fail(spec.label, 'refused: the file belongs to another business'); continue }
    if (!spec.write) { fail(spec.label, spec.reason || 'not restorable'); continue }
    if (str(entry.checksum) !== checksum(JSON.stringify(entry.data))) {
      fail(spec.label, 'refused: the checksum does not match this block')
      continue
    }
    const refusal = acceptsValue(spec, entry.data)
    if (refusal) { fail(spec.label, `refused: ${refusal}`); continue }

    try {
      spec.write(orgId, entry.data)
    } catch (e) {
      fail(spec.label, `the register refused to save: ${(e as Error).message}`)
      continue
    }
    const seen = spec.verify ? spec.verify(orgId, entry.data) : n(entry.rows)
    const dropped = n(entry.rows) - seen
    results.push({
      id,
      label: spec.label,
      ok: true,
      from: n(entry.rows),
      seen,
      note: dropped > 0
        ? `read back ${seen}; ${dropped} ${pluralNoun(dropped, spec.unit)} dropped by the register's own parser`
        : 'read back through its own loader',
    })
  }

  const report: RestoreReport = {
    results,
    restored: results.filter(r => r.ok).length,
    refused: results.filter(r => !r.ok).length,
    dropped: results.reduce((t, r) => t + Math.max(0, r.from - r.seen), 0),
    at,
  }
  remember(orgId, {
    at,
    kind: 'restore',
    registers: report.restored,
    rows: report.results.reduce((t, r) => t + (r.ok ? r.seen : 0), 0),
    chars: 0,
    refused: report.refused,
  })
  return report
}

// ── the vault's own log ───────────────────────────────────────────────────────

export interface VaultFingerprint {
  /** Rows counted from the value at the moment that backup ran. */
  rows: number
  /** The same FNV-1a the file's block carries — this one stays on the device, in the log. */
  checksum: string
}

export interface VaultEvent {
  at: string
  kind: 'backup' | 'restore'
  registers: number
  rows: number
  chars: number
  refused?: number
  /**
   * Per-register fingerprints taken when this backup ran — added at R3-9 so the vault can answer
   * *which books moved since your last file*, not just *that a file was taken*. Absent on events
   * written by earlier builds; the freshness fold calls those backups honestly unrecorded rather
   * than guessing what they held. It lives in the vault's own log (`taxflow:vault:`), which is
   * deliberately never inside a vault file — so this is a statement about this browser, and a
   * second laptop restores the file without inheriting the claim.
   */
  fingerprints?: Record<string, VaultFingerprint>
}

export interface VaultLog {
  version: 1
  updatedAt: string
  events: VaultEvent[]
}

const MAX_EVENTS = 30

export function emptyVaultLog(): VaultLog {
  return { version: 1, updatedAt: '', events: [] }
}

export function loadVaultLog(orgId: string): VaultLog {
  if (typeof window === 'undefined' || !orgId) return emptyVaultLog()
  try {
    const raw = window.localStorage.getItem(KEY_VAULT_LOG + orgId)
    if (!raw) return emptyVaultLog()
    const parsed = JSON.parse(raw) as Partial<VaultLog>
    return {
      version: 1,
      updatedAt: str(parsed.updatedAt),
      events: Array.isArray(parsed.events)
        ? parsed.events
            .filter(e => isObj(e) && typeof e.at === 'string')
            // A hand-edited fingerprints map must not become a claim the freshness fold repeats.
            // Anything that is not a clean {rows, checksum} row per id is dropped whole.
            .map(e => {
              if (!isObj(e.fingerprints)) return e
              const clean: Record<string, VaultFingerprint> = {}
              for (const [id, f] of Object.entries(rec(e.fingerprints))) {
                if (isObj(f)) clean[id] = { rows: n(f.rows), checksum: str(f.checksum) }
              }
              return { ...e, fingerprints: clean }
            })
        : [],
    }
  } catch {
    return emptyVaultLog()
  }
}

function remember(orgId: string, event: VaultEvent): VaultLog {
  const log = loadVaultLog(orgId)
  const next: VaultLog = { version: 1, updatedAt: event.at, events: [event, ...log.events].slice(0, MAX_EVENTS) }
  try { window.localStorage.setItem(KEY_VAULT_LOG + orgId, JSON.stringify(next)) } catch { /* a log is not a ledger */ }
  return next
}

/**
 * The one thing this page writes for itself, and it is not in the vault: a backup that recorded
 * its own backups would grow every time it was restored, and the answer to "when did you last take
 * this file" has to come from the browser the file was taken in.
 *
 * The event also carries a fingerprint of every register the file holds — the rows and the same
 * checksum the block itself was packed with — because the file is the backup's copy and this log is
 * the only place a *later* browser state can be compared against it. The fingerprints never travel
 * inside the file: they are this device's memory of what it handed out, not part of what was handed.
 */
export function recordBackup(orgId: string, vault: VaultFile): VaultLog {
  const fingerprints: Record<string, VaultFingerprint> = {}
  for (const [id, entry] of Object.entries(vault.registers)) {
    if (!isObj(entry)) continue
    fingerprints[id] = { rows: n(entry.rows), checksum: str(entry.checksum) }
  }
  return remember(orgId, {
    at: new Date().toISOString(),
    kind: 'backup',
    registers: vault.counts.registers,
    rows: vault.counts.rows,
    chars: vault.counts.chars,
    fingerprints,
  })
}

/** The last event of a kind, or null. Days are the honest unit for a backup you forgot to take. */
export function lastEvent(orgId: string, kind: VaultEvent['kind']): VaultEvent | null {
  return loadVaultLog(orgId).events.find(e => e.kind === kind) ?? null
}

export function daysSinceBackup(orgId: string, now = new Date()): number | null {
  const last = lastEvent(orgId, 'backup')
  if (!last) return null
  const then = new Date(last.at)
  if (Number.isNaN(then.getTime())) return null
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86_400_000))
}

// ── browsing ──────────────────────────────────────────────────────────────────

export interface RegisterBrowse {
  id: string
  label: string
  what: string
  unit: string
  group: VaultGroup
  module: string
  pageLabel: string
  pageHref: string
  present: boolean
  rows: number
  chars: number
  detail: string
  updatedAt: string
  restorable: boolean
  reason: string
}

/** What this browser holds right now, register by register — the page's inventory tab. */
export function browseRegisters(orgId: string): RegisterBrowse[] {
  return REGISTERS.map(spec => {
    const raw = rawOf(spec.prefix, orgId)
    let value: unknown = null
    if (raw) {
      if (spec.encoding === 'text') value = raw
      else { try { value = JSON.parse(raw) } catch { value = null } }
    }
    const rows = value === null ? 0 : spec.count(value)
    return {
      id: spec.id,
      label: spec.label,
      what: spec.what,
      unit: spec.unit,
      group: spec.group,
      module: spec.module,
      pageLabel: spec.pageLabel,
      pageHref: spec.pageHref,
      present: !!raw,
      rows,
      chars: raw ? raw.length : 0,
      detail: value !== null && spec.detail ? spec.detail(value) : (raw ? plural(rows, spec.unit) : 'nothing stored here'),
      // Only the envelope stores stamp a date; a bare list has no single answer, and inventing one
      // would be a claim the library cannot support.
      updatedAt: str(rec(value).updatedAt),
      restorable: !!spec.write,
      reason: spec.reason || '',
    }
  })
}

// ── what moved since the last backup ──────────────────────────────────────────

/**
 * A backup answers "what did this browser hand out on that day"; only the device can answer the
 * question a shop actually asks before a wipe — *is my newest file still the newest copy?* The fold
 * compares what each key holds right now, checksum for checksum, against the fingerprint the last
 * recorded backup left in the vault's own log. It never reads a file: the file is elsewhere, in a
 * drawer or a mail, and this screen cannot know what it became after it left.
 */
export type FreshState =
  | 'fresh'        // the device still holds exactly the copy the last file carries
  | 'changed'      // both hold content; they are not the same content
  | 'new-since'    // the device holds rows the last file never carried
  | 'cleared'      // the last file holds this book; this browser no longer does
  | 'nothing'      // neither side holds anything — nothing was ever missed
  | 'unrecorded'   // the last backup predates fingerprints — the honest "cannot tell"
  | 'never'        // no backup has ever been recorded in this browser

export interface FreshRow {
  id: string
  label: string
  unit: string
  group: VaultGroup
  pageLabel: string
  pageHref: string
  /** Whether a restore of this book is even possible — the evidence logs are printed with the flag off. */
  restorable: boolean
  state: FreshState
  /** Rows this browser holds right now. */
  rows: number
  /** Rows the last recorded backup carried; null when the book was not in it. */
  fileRows: number | null
  /** A richer device-side line when the spec has one. */
  detail: string
}

export interface FreshnessReport {
  rows: FreshRow[]
  counts: Record<FreshState, number>
  /** The backup the comparison was made against; empty when there is none. */
  at: string
  /** Whole days between that backup and now; null when unmeasurable. */
  days: number | null
  /** True when the last backup predates fingerprints — every row is `unrecorded`, and the page says so. */
  unrecorded: boolean
}

export const FRESHNESS_META: Record<FreshState, {
  label: string
  tone: 'green' | 'blue' | 'red' | 'amber' | 'grey'
  why: string
}> = {
  fresh: { label: 'In your file', tone: 'green', why: 'this browser still holds exactly the copy your last backup took' },
  changed: { label: 'Changed since', tone: 'blue', why: 'both this browser and your last file hold this book, and they no longer agree' },
  'new-since': { label: 'New since', tone: 'amber', why: 'this browser holds rows your last file never carried' },
  cleared: { label: 'Only in your file', tone: 'red', why: 'your last backup carries this book; this browser no longer does' },
  nothing: { label: 'Nothing to back up', tone: 'grey', why: 'neither this browser nor your last file holds anything here' },
  unrecorded: { label: 'Cannot tell', tone: 'grey', why: 'your last backup was taken before this browser kept per-book fingerprints — take a new backup to start the record' },
  never: { label: 'In no file yet', tone: 'red', why: 'this browser has never recorded a backup, and this book holds rows' },
}

const EMPTY_FRESH_COUNTS: Record<FreshState, number> = {
  fresh: 0, changed: 0, 'new-since': 0, cleared: 0, nothing: 0, unrecorded: 0, never: 0,
}

/** One register's answer against the last recorded backup, by checksum — never by timestamp. */
export function registerFreshness(orgId: string, now = new Date()): FreshnessReport {
  const last = lastEvent(orgId, 'backup')
  const counts: Record<FreshState, number> = { ...EMPTY_FRESH_COUNTS }
  const rows: FreshRow[] = []
  const inventoryById = new Map(browseRegisters(orgId).map(r => [r.id, r]))
  const fingerprints = last?.fingerprints
  const recorded = isObj(fingerprints) ? fingerprints : null
  let days: number | null = null
  if (last) {
    const then = new Date(last.at)
    if (!Number.isNaN(then.getTime())) days = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86_400_000))
  }

  for (const spec of REGISTERS) {
    const inventory = inventoryById.get(spec.id)
    const deviceRows = inventory ? inventory.rows : 0
    const base = {
      id: spec.id, label: spec.label, unit: spec.unit, group: spec.group,
      pageLabel: spec.pageLabel, pageHref: spec.pageHref, restorable: !!spec.write,
      rows: deviceRows, detail: inventory ? inventory.detail : '',
    }

    let state: FreshState
    let fileRows: number | null = null
    if (!last) {
      state = deviceRows > 0 ? 'never' : 'nothing'
    } else if (!recorded) {
      state = 'unrecorded'
    } else {
      const fp = recorded[spec.id]
      const raw = rawOf(spec.prefix, orgId)
      fileRows = fp ? fp.rows : null
      if (!raw) {
        state = fp ? 'cleared' : 'nothing'
      } else if (!fp) {
        state = deviceRows > 0 ? 'new-since' : 'nothing'
      } else {
        state = checksumOf(spec, raw) === fp.checksum ? 'fresh' : 'changed'
      }
    }
    counts[state]++
    rows.push({ ...base, state, fileRows })
  }

  return { rows, counts, at: last ? last.at : '', days, unrecorded: !!last && !recorded }
}

/** The books a person would miss if this browser were wiped *today* — content with no newer file. */
export function atRiskRows(report: FreshnessReport): FreshRow[] {
  return report.rows.filter(r =>
    (r.state === 'changed' || r.state === 'new-since' || r.state === 'never') && r.rows > 0)
}

/** JSON needs no byte-order mark; a BOM in front of `{}` is the classic unreadable backup. */
export function downloadVault(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Read a picked file as text, with the browser's failure kept as a message rather than a crash. */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error(reader.error?.message || 'the file could not be read'))
    reader.readAsText(file)
  })
}

// ── the strip the page prints instead of letting the reader guess ─────────────

export const NOT_IN_THE_VAULT: { title: string; body: string; href: string; hrefLabel: string }[] = [
  {
    title: 'The documents themselves',
    body: 'Invoices, bills, expenses, customers, vendors and products are rows in the database. They come back when you sign in; putting them in a file and reading them out again would create a second way to write money.',
    href: '/invoices', hrefLabel: 'Invoices',
  },
  {
    title: 'Payments and receipts',
    body: 'Every payment is written by /payments and nothing else, so a restore cannot invent a receipt or clear a debt by overwriting a register.',
    href: '/payments', hrefLabel: 'Receivables',
  },
  {
    title: 'The five evidence logs',
    body: 'The offline outbox, the e-way bill log, the Tally import log, the palette recents and the calendar profile are in the file so you can see them. Restoring them would replay a sync or re-claim a number the portal owns.',
    href: '/offline', hrefLabel: 'Offline sync',
  },
  {
    title: 'Any credential, ever',
    body: 'The vault walks a named list of registers — it does not sweep localStorage — so Supabase session keys, the app key and anything a password manager left behind stay outside the file.',
    href: '/settings', hrefLabel: 'Settings',
  },
]
