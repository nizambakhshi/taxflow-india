// R3-13 — the register-persistence inventory.
//
// The second external review (`TaxFlow Feature Review_2.pdf`, 14-10-2026) put a P0 backend round next
// on the roadmap and named its first concrete task: *"Identify every client-side financial register
// that needs server persistence."* It also put the reason plainly — *"a browser wipe or device loss
// must not be able to destroy a customer's only copy of financial records"* — and reminded us that the
// vault already answers *which books exist* (ADR-013, thirty restorable registers plus five evidence
// logs). That list is the inventory's raw material, so this library reads it straight from
// `vault.ts`'s `REGISTERS` array (Rule 37 — another register's control is drawn, never duplicated) and
// lays a priority judgement on top of it.
//
// What this is, and what it deliberately is not:
//
//  * **This is a reading, not a migration.** The app has never owned a server migration and this round
//    does not start one. ADR-013 / Rule 21 is still the standing rule — the Postgres schema is
//    hand-managed in the dashboard, nothing here commits a `.sql` file, enables RLS, or writes a row.
//    The review's R3-13 backend half is *blocked on the owner's Supabase project* (our R3-3), and the
//    honest in-repo contribution is the inventory it has to be planned against.
//  * **The priority is the app's own judgement, labelled as such** (Rule 43 / Rule 47). No ChatGPT page
//    is quoted as statute. The *facts* — that a register lives on the device, that it restores, that a
//    write path asks the seal — are read from `vault.ts` and the `/audit` `GUARDED` array; the
//    *classification* (authoritative / decision-input / reconstructible / device-by-design) and the
//    *destination* are this library's reading with a printed reason on every row.
//  * **The destination is a proposal, never a schema.** A string like "a future `stock_movements`
//    table (server)" says where the data *would* go and no more. The suite never treats it as built.
//
// The one thing that keeps the inventory honest against drift is that it takes the register *list* from
// `vault.ts`, not from a copy here. If a sixth evidence log or a new register joins the vault without a
// judgement, `persistencePlan()` returns it flagged in `unclassified` rather than silently dropping it —
// the count stays the vault's count, and the page prints the gap instead of hiding it.

import { REGISTERS, type VaultGroup } from '@/lib/vault'

// ── the four classes ─────────────────────────────────────────────────────────
//
// The axis is a single question, asked of the device alone: **what is lost if this browser is wiped
// and the vault file is not there to bring it back?** The answer sorts every register into one of four
// classes, and the classes are ordered by how fast they should reach a server.

export type PersistenceClass =
  /** The only copy of a dated financial or compliance fact. A wipe destroys a record no return and no
   *  other register can reconstruct. These must be server-backed first. */
  | 'authoritative'
  /** The only copy of a *decision* — a percentage, an hour, a chosen rate, a done-flag — that feeds a
   *  figure the app re-reads from the books. The rupee survives a wipe; the input to it does not. */
  | 'decision-input'
  /** Content the app can re-derive from the Postgres documents plus the registers above it. A loss is
   *  painful and re-keyable, not fatal — once its inputs survive, this can be rebuilt. */
  | 'reconstructible'
  /** A setting or a log meant to stay on the device (ADR-013): a look, a preference, a pending-sync
   *  queue, an evidence trail of a thing the portal or the books already own. Restoring these would be
   *  wrong, not merely unnecessary. */
  | 'device-by-design'

export interface ClassMeta {
  label: string
  /** The question this class answers, printed as the page's own legend. */
  means: string
  /** Whether this class belongs on the server at all — the honesty hinge of the whole inventory. */
  serverBound: boolean
  /** Ordering weight for the summary: the fastest-to-a-server class first. */
  rank: number
}

export const CLASS_META: Record<PersistenceClass, ClassMeta> = {
  authoritative: {
    label: 'Only copy of a record',
    means: 'a dated financial or compliance fact that exists nowhere else — a browser wipe destroys it and no return can rebuild it',
    serverBound: true,
    rank: 0,
  },
  'decision-input': {
    label: 'Only copy of a decision',
    means: 'a percentage, an hour, a chosen rate or a done-flag the app re-reads a rupee against; the money survives a wipe, the input to it does not',
    serverBound: true,
    rank: 1,
  },
  reconstructible: {
    label: 'Rebuildable from the books',
    means: 'a workpaper the app can re-derive from the Postgres documents plus the registers above it — a loss is re-keyable, not fatal',
    serverBound: false,
    rank: 2,
  },
  'device-by-design': {
    label: 'Stays on the device',
    means: 'a setting or an evidence log meant to live here (ADR-013): a look, a preference, a pending-sync queue, a portal-owned number — restoring it would be wrong',
    serverBound: false,
    rank: 3,
  },
}

// ── the seal cross-check ─────────────────────────────────────────────────────
//
// The review's fifth R3-13 bullet is *"Verify all financial write paths against period locks."* On the
// client that is already true and already printed: R3-5 put the door on the shared writers and `/audit`
// lists every guarded path in `GUARDED`. This inventory does not re-derive that claim — it says, per
// register, which of the four seal states applies, and the *suite* re-reads `GUARDED` from source and
// checks every `asked-*` row's `viaHref` is really on it with a matching `by`. So the page's sentence
// cannot outrun the wiring (Rule 42), and no door is invented here.

export type SealState =
  /** The register's own engine calls the seal before it saves (the journal — `its own engine`). */
  | 'asked-at-own-engine'
  /** A save in this register becomes paper through a shared writer that carries the door (`the writer`). */
  | 'asked-through-a-writer'
  /** The register reads a period's seal and shows it as closed paper, but never guards a door — a
   *  transcript moves nothing (filings, Rule 41). */
  | 'seal-is-a-read-not-a-door'
  /** No dated money leaves through this register, so the seal has nothing here to close. */
  | 'opens-no-door'

export interface SealMeta {
  label: string
  /** The sentence the page prints beside the state, so a claim is always carrying its own reason. */
  means: string
}

export const SEAL_META: Record<SealState, SealMeta> = {
  'asked-at-own-engine': { label: 'Seal, in its engine', means: 'this register calls the period seal inside its own library before it saves' },
  'asked-through-a-writer': { label: 'Seal, via a writer', means: 'a save here becomes paper through a shared writer that carries the door' },
  'seal-is-a-read-not-a-door': { label: 'Reads the seal', means: 'a transcript that moves no rupee — it shows a sealed period as closed paper, it does not guard a door' },
  'opens-no-door': { label: 'Opens no door', means: 'no dated money is written through this register, so a period seal has nothing to close here' },
}

// ── the authored reading, keyed by the vault's own spec id ───────────────────

interface Judgement {
  cls: PersistenceClass
  /** Why this class — printed under the row so the judgement always carries its reason (Rule 27). */
  why: string
  /** A *proposed* server home, or the sentence for why it stays on the device. Never a schema. */
  destination: string
  seal: SealState
  /** For an `asked-*` row, the `/audit` route whose `GUARDED` entry is the proof. The suite checks it. */
  viaHref?: string
  /** For an `asked-*` row, the `by` value that route must carry in `GUARDED` to make the claim true. */
  viaBy?: string
}

/**
 * One judgement per register the vault knows. The list, labels, groups and restorability come from
 * `REGISTERS`; only the priority, the reason, the proposed destination and the seal state are authored
 * here. A vault id with no entry below is not dropped — `persistencePlan()` returns it unclassified and
 * the page prints it, which is the whole point of reading the list instead of copying it.
 */
const JUDGEMENTS: Record<string, Judgement> = {
  // ── inventory: the shelf, and everything that moves across it ──
  batches: {
    cls: 'authoritative',
    why: 'each lot — batch number, manufacture and expiry dates, quantity, cost, the godown it stands in — lives on no Postgres column; a wipe loses the shelf’s identity and FEFO has nothing to sort.',
    destination: 'a future `batches` table (server), keyed the way `products.current_stock` is not — one row per lot',
    seal: 'opens-no-door',
  },
  batchmoves: {
    cls: 'authoritative',
    why: 'the append-only movement trail behind every lot; the `left = qty + back − out` invariant and the expired-lot warning are rebuilt only from these rows.',
    destination: 'a future `stock_movements` table (server) — the trail, not the rollup',
    seal: 'asked-through-a-writer',
    viaHref: '/invoices/new',
    viaBy: 'the writer',
  },
  serials: {
    cls: 'authoritative',
    why: 'one row per unit — serial number, cost, warranty months, the bill it arrived on; warranty is derived from the latest sale but the unit itself exists only here.',
    destination: 'a future `serials` table (server), one row per numbered unit',
    seal: 'opens-no-door',
  },
  serialevents: {
    cls: 'authoritative',
    why: 'what happened to each unit after it arrived — sold, issued into a build, returned, restocked, scrapped; the only history a resale or a return reads.',
    destination: 'a future `serial_events` table (server), append-only',
    seal: 'asked-through-a-writer',
    viaHref: '/invoices/new',
    viaBy: 'the writer',
  },
  godowns: {
    cls: 'decision-input',
    why: 'the places stock stands — names, codes, addresses, closures; a master record, but every per-place lot placement hangs on these ids, and Main is only virtual until someone edits it.',
    destination: 'a future `godowns` table (server)',
    seal: 'opens-no-door',
  },
  bom: {
    cls: 'authoritative',
    why: 'a recipe stores quantities the product master could re-speak, but a **build** is a dated physical draw — and the finished lot it lands is the only record that the shop made it.',
    destination: 'a future `bom_recipes` + `bom_builds` pair (server); shop rates alongside them, dated',
    seal: 'asked-through-a-writer',
    viaHref: '/invoices/new',
    viaBy: 'the writer',
  },

  // ── paperwork: the drafts that become statutory paper ──
  challan: {
    cls: 'authoritative',
    why: 'a rule 55 delivery challan is statutory paper with its own dated number, minted from this register’s series when a draft becomes paper.',
    destination: 'a future `challans` table (server)',
    seal: 'asked-through-a-writer',
    viaHref: '/challans',
    viaBy: 'the writer',
  },
  sorder: {
    cls: 'authoritative',
    why: 'a sales order is a promise on a date; converting it to an invoice is a guarded writer, but the order itself and its own number have no Postgres home.',
    destination: 'a future `sales_orders` table (server)',
    seal: 'asked-through-a-writer',
    viaHref: '/sales-orders',
    viaBy: 'the writer',
  },
  porder: {
    cls: 'authoritative',
    why: 'a purchase order carries the vendor’s own bill reference the shop is bound to; only the order register holds it before it becomes a bill.',
    destination: 'a future `purchase_orders` table (server)',
    seal: 'asked-through-a-writer',
    viaHref: '/purchase-orders',
    viaBy: 'the writer',
  },
  rec: {
    cls: 'authoritative',
    why: 'a schedule is a template plus a cadence plus an end rule; the due pile is *derived* so a wipe loses the rule the calendar reads, though not a rupee.',
    destination: 'a future `recurring_schedules` table (server)',
    seal: 'asked-through-a-writer',
    viaHref: '/recurring',
    viaBy: 'the writer',
  },

  // ── workpapers: the judgement-and-obligation registers ──
  jobwork: {
    cls: 'authoritative',
    why: 'section 143’s clock — send dates, stipulated versus statutory periods, ITC-04 movements — reaches backwards across periods; no return reconstructs a lot that never came back.',
    destination: 'a future `jobwork_lots` + `jobwork_movements` pair (server)',
    seal: 'opens-no-door',
  },
  exports: {
    cls: 'authoritative',
    why: 'the LUT undertaking that makes a supply zero-rated (and its renewal by 31 March) and the FEMA window the proceeds must land in — the zero-rated paper a shop has to prove, held nowhere else.',
    destination: 'a future `export_files` table (server)',
    seal: 'opens-no-door',
  },
  fx: {
    cls: 'decision-input',
    why: 'the foreign value and the dated rate you *used* (rule 45); the rupee statutory figures stay in `invoices` and receipts arrive through `/payments`, so the books survive a wipe — the conversion decision does not.',
    destination: 'a future `fx_deals` + `fx_rates` pair (server), the rate a dated row with its source stamp',
    seal: 'opens-no-door',
  },
  ccentres: {
    cls: 'decision-input',
    why: 'a split stores a **percentage** against a document id and re-reads the rupees from the books on every load; lose the register and you lose every allocation while the money itself is safe.',
    destination: 'a future `cost_centres` + `document_shares` pair (server)',
    seal: 'opens-no-door',
  },
  projects: {
    cls: 'decision-input',
    why: 'hours and attached document ids — measurements only; every rupee on the money side re-reads through `bookDocs`. The measurement is the sole copy, the figure is not.',
    destination: 'a future `projects` + `time_entries` pair (server)',
    seal: 'opens-no-door',
  },
  payroll: {
    cls: 'authoritative',
    why: 'structure, exceptions, the per-person professional-tax figure and the kept day-book marks — the section 192 walk re-computes the year’s tax from these inputs, and they exist on no other register and no table.',
    destination: 'a future `employees` + `salary_runs` + `attendance_marks` set (server)',
    seal: 'opens-no-door',
  },
  audit: {
    cls: 'authoritative',
    why: 'the append-only trail and the period seals themselves. A client-side checksum trail is this app’s evidence, not a tamper-proof server log — the review’s own distinction, and the reason this row is P0.',
    destination: 'a server-controlled `audit_events` table + `period_seals` — protected, permission-readable, never hand-editable',
    seal: 'opens-no-door',
  },
  journal: {
    cls: 'authoritative',
    why: 'a hand-written balanced movement that no document raised — the depreciation, the till withdrawal, the loan that arrived with no bill; the derived statements read these rows and nothing else holds them.',
    destination: 'a future `journal_entries` + `journal_legs` pair (server)',
    seal: 'asked-at-own-engine',
    viaHref: '/journal',
    viaBy: 'its own engine',
  },
  filings: {
    cls: 'authoritative',
    why: 'what the shop says it told the portal, the window each correction still has and the 88B(2) cost of a wait — a transcript of a transmission made elsewhere, and the only copy of that transcript.',
    destination: 'a future `filing_records` + `amendments` pair (server)',
    seal: 'seal-is-a-read-not-a-door',
  },
  gstr9: {
    cls: 'reconstructible',
    why: 'the books-versus-filed-3B reconciliation, the Rule 42/43 reversals and the 180-day watch — all of it re-derives from the invoices, bills and payments plus the filings register.',
    destination: 'a saved workpaper row (server), or rebuilt on demand — its inputs are the registers above it',
    seal: 'opens-no-door',
  },
  gstr4: {
    cls: 'reconstructible',
    why: 'the CMP-08 / GSTR-4 composition figures read out of the same documents; correct the bills and the workpaper speaks again.',
    destination: 'a saved workpaper row (server), or rebuilt on demand',
    seal: 'opens-no-door',
  },
  tds: {
    cls: 'reconstructible',
    why: 'the 194Q withholding workpaper is read from the purchase bills; the section choices are the only input, and they are few.',
    destination: 'a saved workpaper row (server), or rebuilt on demand',
    seal: 'opens-no-door',
  },
  bank: {
    cls: 'decision-input',
    why: 'the pasted statement rows and the shop’s manual matches; the documents sit in Postgres, so what is lost is the *linking* — which receipt settled which invoice.',
    destination: 'a future `bank_statement_rows` + `document_matches` pair (server)',
    seal: 'opens-no-door',
  },
  compliance: {
    cls: 'decision-input',
    why: 'the calendar’s done-flags per FY event; the events themselves re-derive from the profile and the registers, but a month you actually filed is a tick the app cannot re-earn.',
    destination: 'a future `compliance_ticks` table (server)',
    seal: 'opens-no-door',
  },

  // ── settings: choices the shop made ──
  targets: {
    cls: 'decision-input',
    why: 'festival-weighted budget rows; achievement re-reads the books on every load, so the loss is the target — the thing being aimed at — not the progress against it.',
    destination: 'a future `targets` table (server)',
    seal: 'opens-no-door',
  },
  opening: {
    cls: 'authoritative',
    why: 'the balances the books were picked up with — receivables, payables, cash, bank, fixed assets, loans, capital, struck as at one day. No document holds them; a wipe erases the opening the whole balance sheet stands on.',
    destination: 'a future `opening_balances` table (server), one set per business per as-at day',
    seal: 'opens-no-door',
  },
  setup: {
    cls: 'authoritative',
    why: 'the branches, the registration each carries, and the document-series shapes a statutory number is minted in — the numbering a refused save still burned through, and the identity no other register restates.',
    destination: 'a future `branches` + `document_series` pair (server)',
    seal: 'opens-no-door',
  },
  reorder: {
    cls: 'device-by-design',
    why: 'planner inputs (the (s, S) policy knobs, lead times) — a preference re-set in minutes, and the plan itself re-derives from the shelf and the order book.',
    destination: 'stays on the device — a preference, not a record',
    seal: 'opens-no-door',
  },
  upi: {
    cls: 'device-by-design',
    why: 'the VPA and payment-link settings behind a reminder; re-typed from the bank in a minute, and money still arrives only through `/payments`.',
    destination: 'stays on the device — a preference',
    seal: 'opens-no-door',
  },
  'invoice-template': {
    cls: 'device-by-design',
    why: 'the document skin — which of three layouts a printed invoice wears. A look, not a rupee; re-picked at `/settings`.',
    destination: 'stays on the device — a look',
    seal: 'opens-no-door',
  },

  // ── evidence: the five logs a backup shows but never restores ──
  outbox: {
    cls: 'device-by-design',
    why: 'a pending offline sync. It is deliberately never restored — putting a queued invoice back into the outbox would replay a save and bill the same sale twice.',
    destination: 'stays on the device — and stays out of a restore by design',
    seal: 'opens-no-door',
  },
  ewb: {
    cls: 'device-by-design',
    why: 'the e-way bill log; the actual number belongs to the portal, so this is a note of what was applied for, not a record to move.',
    destination: 'stays on the device — a log',
    seal: 'opens-no-door',
  },
  tally: {
    cls: 'device-by-design',
    why: 'the log of what was imported; the documents it wrote are already in Postgres, so this only records the reading.',
    destination: 'stays on the device — a log',
    seal: 'opens-no-door',
  },
  'palette-recents': {
    cls: 'device-by-design',
    why: 'the recently-opened commands the ⌘K palette offers; pure convenience, nothing behind it.',
    destination: 'stays on the device — UX state',
    seal: 'opens-no-door',
  },
  'compliance-profile': {
    cls: 'device-by-design',
    why: 'the filing profile that seeds the calendar — turnover band, QRMP opt-in, state. It is shown as evidence and never restored, because it is re-declared on the calendar page when needed.',
    destination: 'stays on the device — a re-declared setting',
    seal: 'opens-no-door',
  },
}

// ── the fold ─────────────────────────────────────────────────────────────────

export interface PersistenceRow {
  id: string
  /** Read from `REGISTERS` — the label the vault page already uses, so the two never disagree. */
  label: string
  /** The one line on what a person would miss, drawn from the vault spec rather than restated. */
  what: string
  group: VaultGroup
  /** Whether the vault can put this book back — `!!spec.write`. Evidence logs read false. */
  restorable: boolean
  cls: PersistenceClass
  why: string
  destination: string
  seal: SealState
  viaHref?: string
  viaBy?: string
  /** True when the class says this belongs on a server; the page prints it as "needs a server copy". */
  serverBound: boolean
  /** True when this id is in `REGISTERS` but has no authored judgement — the drift this design refuses
   *  to hide. A finished inventory has none, and the suite asserts that. */
  unclassified: boolean
}

/**
 * The inventory: every register the vault knows, in the vault's own order, each carrying this library's
 * authored class/reason/destination/seal — and any register that joined the vault without being
 * classified here surfaced as `unclassified` rather than dropped. Nothing here reads a value or a row
 * count; it is the *shape* of the migration, not its data, so it never needs a browser and never writes.
 */
export function persistencePlan(): PersistenceRow[] {
  return REGISTERS.map(spec => {
    const j = JUDGEMENTS[spec.id]
    if (!j) {
      return {
        id: spec.id,
        label: spec.label,
        what: spec.what,
        group: spec.group,
        restorable: !!spec.write,
        cls: 'device-by-design' as PersistenceClass,
        why: 'Not yet classified — this register is in the vault but has no entry in the persistence inventory. The page prints it so the gap shows rather than vanishing.',
        destination: 'To be read — a register added to the vault needs its persistence judgement written beside it',
        seal: 'opens-no-door',
        serverBound: false,
        unclassified: true,
      }
    }
    return {
      id: spec.id,
      label: spec.label,
      what: spec.what,
      group: spec.group,
      restorable: !!spec.write,
      cls: j.cls,
      why: j.why,
      destination: j.destination,
      seal: j.seal,
      viaHref: j.viaHref,
      viaBy: j.viaBy,
      serverBound: CLASS_META[j.cls].serverBound,
      unclassified: false,
    }
  })
}

export interface PersistenceTotals {
  /** Every class, counted — always four entries, so a summary line never has to guess a key. */
  byClass: { cls: PersistenceClass; label: string; count: number; serverBound: boolean }[]
  authoritative: number
  decisionInput: number
  reconstructible: number
  deviceByDesign: number
  /** The registers that must reach a server: authoritative + decision-input. */
  needsServer: number
  /** How many of the whole are actually restorable through the vault (the five logs are not). */
  restorable: number
  /** Every register the vault knows — the count `REGISTERS` prints, so the inventory can be tied to it. */
  total: number
  /** Ids present in `REGISTERS` but absent from the judgement table. The honest hole, if one opens. */
  unclassified: string[]
}

/** The summary the page foots its sentence with. Counts are derived from the rows, never typed. */
export function persistenceTotals(rows: PersistenceRow[]): PersistenceTotals {
  const count = (c: PersistenceClass) => rows.filter(r => r.cls === c).length
  const authoritative = count('authoritative')
  const decisionInput = count('decision-input')
  const reconstructible = count('reconstructible')
  const deviceByDesign = count('device-by-design')
  const byClass = (Object.keys(CLASS_META) as PersistenceClass[])
    .sort((a, b) => CLASS_META[a].rank - CLASS_META[b].rank)
    .map(cls => ({ cls, label: CLASS_META[cls].label, count: count(cls), serverBound: CLASS_META[cls].serverBound }))
  return {
    byClass,
    authoritative,
    decisionInput,
    reconstructible,
    deviceByDesign,
    needsServer: authoritative + decisionInput,
    restorable: rows.filter(r => r.restorable).length,
    total: rows.length,
    unclassified: rows.filter(r => r.unclassified).map(r => r.id),
  }
}

// ── the seal cross-check, expressed against the `/audit` GUARDED array ───────
//
// persistence.ts does not import `/audit`'s page-local `GUARDED` (an engine reaching into a page is
// backwards, and Rule 23 keeps shared libraries clean of screen-specific data). Instead it exposes the
// claims the suite must be able to verify: every `asked-*` row names the route whose `GUARDED` entry
// is its proof, with the `by` that entry has to carry. The suite reads that array straight from
// `src/app/(app)/audit/page.tsx` — exactly how the R3-5 audit suite polices its own coverage claim.

export interface SealClaim {
  id: string
  label: string
  seal: SealState
  /** The `/audit` route the claim points at, or '' when the state needs no door. */
  href: string
  /** The `by` value that route must carry in `GUARDED`, or '' when none is asserted. */
  by: string
}

/** Every register that says it asks the seal — the two `asked-*` states. Their proof is `GUARDED`. */
export function sealClaims(rows: PersistenceRow[]): SealClaim[] {
  return rows
    .filter(r => r.seal === 'asked-at-own-engine' || r.seal === 'asked-through-a-writer')
    .map(r => ({ id: r.id, label: r.label, seal: r.seal, href: r.viaHref ?? '', by: r.viaBy ?? '' }))
}

/**
 * The rows that make a seal claim without a route to stand on. On a finished inventory this is empty —
 * `asked-at-own-engine` and `asked-through-a-writer` must each carry an href the suite can check, and a
 * register that says it opens no door must not quietly carry one. The page could print it; the suite
 * asserts it is empty.
 */
export function sealClaimGaps(rows: PersistenceRow[]): PersistenceRow[] {
  return rows.filter(r => {
    const claimsDoor = r.seal === 'asked-at-own-engine' || r.seal === 'asked-through-a-writer'
    return claimsDoor ? !r.viaHref || !r.viaBy : false
  })
}

/**
 * The registers that read a period's seal but guard no door — filings, and any transcript like it. The
 * page prints these as their own honesty note (Rule 41): a transcript moves nothing, so the seal is
 * offered as closed paper, never asked as a lock. The suite checks that a `seal-is-a-read-not-a-door`
 * row never also carries a `viaHref`.
 */
export function readNotDoorRows(rows: PersistenceRow[]): PersistenceRow[] {
  return rows.filter(r => r.seal === 'seal-is-a-read-not-a-door')
}

// ── the CSV ──────────────────────────────────────────────────────────────────

export const PERSISTENCE_CSV_HEADERS = [
  'Register', 'Label', 'Vault group', 'Restorable', 'Class', 'Needs a server copy',
  'Why this class', 'Proposed destination', 'Period seal', 'Seal route', 'Seal carried by', 'Unclassified',
]

/** Twelve columns; the header row and the body come from the same fold the page renders. */
export function persistenceCsvRows(rows: PersistenceRow[]): string[][] {
  return rows.map(r => [
    r.label,
    r.id,
    r.group,
    r.restorable ? 'yes' : 'no (evidence log)',
    CLASS_META[r.cls].label,
    r.serverBound ? 'yes' : 'no',
    r.why,
    r.destination,
    SEAL_META[r.seal].label,
    r.viaHref || '',
    r.viaBy || '',
    r.unclassified ? 'YES — needs a judgement' : '',
  ])
}

// ── what the page is allowed to claim about the seal, in its own words ────────
//
// Two sentences the page prints so the boundary is on the screen and not in a reader's guess. Both are
// the app's own reading (`read: 'own'`) — Rule 43 / Rule 47: say the source or say it is a reading.

export interface PersistenceReading {
  text: string
  /** Every one of these is the app's own reading; none quotes a vendor page or a statute. */
  read: 'own'
}

export const PERSISTENCE_READINGS: PersistenceReading[] = [
  {
    text: 'Reading: "which register must move to a server" is the app’s own judgement, asked of one '
      + 'question — what is lost if this browser is wiped and the vault file is not there. The four '
      + 'classes (only copy of a record / only copy of a decision / rebuildable / stays on the device) '
      + 'sort by that answer alone. The review that asked for the inventory is a planning input, not a '
      + 'statute; no figure here is quoted from it as authority.',
    read: 'own',
  },
  {
    text: 'Reading: the proposed destinations are a plan, not a schema. TaxFlow has committed no `.sql` '
      + 'migration and manages its Postgres schema by hand in the dashboard (ADR-013 / Rule 21). Naming '
      + 'where a register *would* live is the deliverable of the backend round that has to happen first '
      + '— the RLS, tenant-isolation and migration work that is blocked on the owner’s Supabase project. '
      + 'Nothing on this page migrates, enables RLS, or writes a row.',
    read: 'own',
  },
  {
    text: 'Reading: a register’s class answers the *backup* question (what a wipe destroys); its period-seal '
      + 'state answers a different one (does a dated money write pass a lock before saving). The two are '
      + 'kept in separate columns because they are separate facts — an authoritative register like the '
      + 'journal asks the seal in its own engine, while an authoritative register like the balance-sheet '
      + 'opening does not move dated money at all. The suite re-reads /audit’s GUARDED list and refuses '
      + 'this page any coverage the wiring has not earned.',
    read: 'own',
  },
]

// ── boundary statements, printed as the page's own caveats ───────────────────

export const PERSISTENCE_BOUNDARIES: string[] = [
  'This is an inventory, not a migration. No server route, no `.sql` file, no RLS change is made here — '
    + 'the Postgres schema stays hand-managed in the dashboard (ADR-013 / Rule 21).',
  'The register *list* is read from `src/lib/vault.ts`’s REGISTERS, never copied — so this page can '
    + 'disagree with nothing about how many books there are, and a new vault register shows here as '
    + 'unclassified rather than silently missing.',
  'The proposed destinations are the app’s own reading (see the three readings). They are where the data '
    + '*would* go, phrased as a plan for the backend round that must be authorised against the live Supabase project.',
  'The period-seal column does not re-run the seal. It states which of four states applies, and every '
    + '“asks the seal” claim is cross-checked against /audit’s GUARDED array by the suite — a sentence '
    + 'here cannot outrun the wiring (Rule 42).',
  'The five evidence logs are printed as they are: shown by the vault, never restored, and correctly left '
    + 'on the device. A backup that replayed the outbox would bill a sale twice.',
]
