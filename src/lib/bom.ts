// Manufacturing — what a thing is made of, and what making it did to the stock.
//
// The stock ledger knows a quantity. It does not know that the 40 gift boxes that left today
// were 40 boxes, 1.2 kg of chocolate, 8 ribbons and 40 labels, and it certainly does not know
// that the chocolate went short so the shop only made 26. That is the gap this register fills:
// a **recipe** (what goes in, per how many come out, with the waste a shop actually gets) and a
// **build** (what was drawn on the day). Indian SMEs are full of this — box makers, sweet
// shops, hardware assemblers, tailors, compounding units — and the incumbents that serve them
// (Busy, ClearTax, Refrens) stop at a bill of materials that prints; nobody tells you *what you
// cannot make today* because a ₹9 component is out of stock.
//
// So this register lives on localStorage (ADR-013, `taxflow:bom:<orgId>`) and holds
// *relationships and quantities*, which is the design decision that keeps it honest:
//
//  * **A recipe stores quantities, never a rupee.** The material value of a build is rolled up
//    on every load from the component's own cost in `products` — the field the balance sheet
//    already values stock at, so a price corrected on the product master re-values every recipe
//    that uses it without anything being re-typed here. What a build *costs* on the day is a
//    reading, not a ledger posting: there is no cost-layer engine in this schema (no weighted
//    average, no WIP account), so the page prints the roll-up and names its source rather than
//    pretending to an accountant's figure.
//  * **A component with no cost yields no rupee figure, not a ₹0 one.** Same rule as an
//    unpriced hour in `/projects`: ₹0 reads as "this costs nothing", which is a different —
//    and wrong — statement from "nobody has recorded what this costs".
//  * **A build records what physically happened.** The components it drew are stored, not
//    re-derived from the recipe, because the shop measured the drum and it said 1.3 kg, not the
//    1.2 the recipe hoped for. The difference between the two is printed as a variance rather
//    than smoothed away — that number is wastage, and wastage is the thing recipes lie about.
//  * **Stock moves only through `record_stock_movement`.** The build writes components out and
//    the finished units in through the same RPC `/inventory` uses, with the existing
//    `adjustment_out` / `adjustment_in` movement types — the schema has no `build` movement
//    type, and inventing one would be a schema change (ADR-013), so the movement log shows a
//    manual adjustment *named after the job* instead of a fiction. The movement trail is the
//    proof; the register is the explanation.
//  * **A build is not a supply.** Nothing here reaches a return: making something inside your
//    own registered place moves no GST, and the tax happens when the finished good is *sold* at
//    `/invoices/new` — at the HSN/SAC and rate of the finished good, not of its parts. The
//    register therefore checks that the output has an HSN/SAC at all, and says so while there
//    is still time to fix the master.
//  * **Materials sent out to somebody else are not a build.** That is job work, it is a supply
//    on schedule I, and it lives on `/gst/job-work` with the section 143 return clock attached.
//    This page makes things out of things you own.
//
// What v1 deliberately does NOT claim: no production plan, no scheduling, no work-in-progress
// account, no serial *minting* (a run produces units, not numbers — `/inventory/serials` numbers
// what came out at the counter; R2-35 names the units a draw *took*, the other end of the same
// run) — no scrap *sale*, because offcuts sold are an ordinary invoice — and no back-flush.
// The ERP habit called back-flushing
// consumes materials automatically when a finished unit is sold or received; this register refuses
// it on purpose, because a unit on the shelf may equally have come from opening stock or a
// purchase, and guessing which is exactly how stock books get cooked. The build form fills its
// draws from the recipe as a convenience and the shop corrects them — the drum, not the hope,
// is what gets recorded.
//
// What R2-28 added: **labour and overhead, as minutes priced by dated shop rates.** The recipe
// stores `labour_minutes` and `overhead_minutes` per run — quantities, like everything else here —
// and the register holds a small table of dated rates (`rates`, `CostRate`): ₹ per labour hour and
// ₹ per overhead hour, each row stamped with the day it starts applying, the way `/fx` keeps its
// quotes. The cost of a run is read on every load as parts (from the catalogue's `purchase_price`)
// plus minutes × the rate **in force on the run's own date** — so a run from last quarter costs at
// last quarter's rate, which is more history than the material leg can offer (there is no price
// history on `products`, so a past build's material figure is a *reading of today*; the page says
// so and never adds the two bases into one sum). A rate of ₹0 is refused: absence of a rate prints
// a dash and a reason, because ₹0 claims the work costs nothing and a dash admits nobody recorded
// it.

// What R2-29 added: **a build draws lots, not only quantities.** Each drawn line may carry the
// physical batches it came off (`BuildLine.lots`), allocated first-expiry-first-out **by
// `batches.ts`'s own `allocateFefo()`** — this register never restates that maths, so the counter
// and the plant cannot rotate stock differently. Recording a run that names lots appends the
// matching moves through the batch register's own owners and lands the finished units as **their
// own lot** (`Build.output_batch_id`), dated the day of the run and costed at the cost the run
// read that day. Two refusals hold the line honest: a lot that cannot cover what the line says was
// drawn blocks the issue rather than drawing the remainder from thin air, and cancelling a run
// whose finished lot has already been sold from is refused — putting back units that left the
// building would be the stock fiction this register exists to avoid.
//
// What R2-30 added: **the shopping list becomes paper.** The board has always known which
// components the shelf cannot cover; `mergedShortages()` folds those rows into one line per
// component — the same list the stat card counts *and* the orders are raised from, so the two can
// never disagree about what is short — and `shoppingPlan()` arranges it by the vendor each
// component last came in from, at the rate that bill paid (the product master's price when no bill
// names one), each line naming the recipes waiting on it. A component nobody has ever supplied,
// whose supplier has since left the vendor list, or whose vendor card carries no state to place
// the supply in, is not quietly dropped: it lands in `unrouted` with the reason printed — the
// order register would refuse those drafts anyway, and a refusal on the board beats a rejection
// on the register's own page. An order with one unpriced line has **no** value rather than a
// partial one, because a sum of the priced lines would read as *the* figure. Raising the paper
// stays the order register's own job — `orderflow.appendDraft()` takes the number through the
// high-water mark the register keeps — so a draft born on this board is indistinguishable from one typed at
// `/purchase-orders`: same series, same editor, same convert-to-bill path.
//
// What R2-35 added: **a build can name the numbered units its draw took.** A shop that keeps the
// serial register for a costly part — a motor, a board, a bench — knows which unit went into the
// machine, and that is the trace an after-sales question ("which unit is under this job?") asks
// for. So a drawn line may carry the units it consumed (`BuildLine.serials`), proposed oldest-on-
// the-shelf first from the register's own shelf reading and validated against the register's own
// state at the moment of writing. The lot refusals hold here in unit terms: the units named must
// cover the whole draw or none of it, and cancelling a run whose issued unit has moved on since
// (scrapped, or put back by hand) is refused rather than written over — one unit, one history.
// The finished units are still not numbered here: a run makes a quantity, and the counter
// numbers what it made.
//

import { allocateFefo, newId, todayISO, type Batch, type BatchMove } from '@/lib/batches'
import { SERIAL_STATUS_LABEL, shelfUnitsOf, viewOf, type SerialEvent, type SerialStatus, type SerialUnit } from '@/lib/serials'
import { round2 } from '@/lib/costcentres'
import { fyLabel, fyStartYear } from '@/lib/targets'

const KEY_BOM = 'taxflow:bom:'
/**
 * Today's shape. A stored envelope with a different version is read as empty, not guessed at —
 * which is why an *additive* field (`rates`, the recipe's minutes) ships under the same version:
 * an old app reading a new envelope drops the fields it never knew, a new app reading an old
 * envelope reads zero minutes and no rates, and neither side invents a figure. Bumping the version
 * for an additive change would read every existing register as empty, which is the one outcome
 * the stamp exists to prevent.
 */
const BOM_VERSION = 1

/** A run is a batch of the recipe. Ten thousand batches of one item is a typo, not a plan. */
export const MAX_UNITS_PER_BUILD = 100000
/** Waste above this stops being wastage and starts being a decimal point in the wrong place. */
export const MAX_WASTE_PCT = 100
/** Beyond this the component's quantity is a unit error (someone typed grams instead of kg). */
export const MAX_QTY_PER_COMPONENT = 1000000
/** Sub-assembly explosion stops here. A real product tree is shallow; a cycle is not. */
export const MAX_EXPLODE_DEPTH = 12
/** A recipe longer than this is not a recipe, it is a price list pretending to be one. */
export const MAX_COMPONENTS = 200
/** Minutes of one kind in a run. A run that takes 69 days of labour is a decimal point astray. */
export const MAX_MINUTES_PER_RUN = 100000
/** ₹ per hour above this is not a wage, it is a typo with the decimal point in another country. */
export const MAX_RATE_PER_HOUR = 10000000

/** The prefix a build reference carries. Per-FY, high-water, never reused (`JOB-2026-27-0001`). */
export const BUILD_PREFIX = 'JOB'

// ── the register ──────────────────────────────────────────────────────────────

export type RecipeStatus = 'draft' | 'active' | 'archived'
export type BuildStatus = 'planned' | 'built' | 'cancelled'

export interface StatusMeta {
  label: string
  tone: 'green' | 'amber' | 'grey'
  note: string
}

export const RECIPE_STATUS_META: Record<RecipeStatus, StatusMeta> = {
  draft: { label: 'Draft', tone: 'amber', note: 'Written down but not in use — it cannot be built against.' },
  active: { label: 'In use', tone: 'green', note: 'Builds can be recorded against it and its stock is planned.' },
  archived: { label: 'Archived', tone: 'grey', note: 'Kept for the record. Nothing new builds against it.' },
}

export const RECIPE_STATUSES = (Object.keys(RECIPE_STATUS_META) as RecipeStatus[]).map(value => ({
  value,
  label: RECIPE_STATUS_META[value].label,
}))

export const BUILD_STATUS_META: Record<BuildStatus, StatusMeta> = {
  planned: { label: 'Planned', tone: 'amber', note: 'A promise about materials. It has moved no stock.' },
  built: { label: 'Built', tone: 'green', note: 'The movements went through — components out, finished units in.' },
  cancelled: { label: 'Cancelled', tone: 'grey', note: 'Reversed. The original run and its reversal both stay on the log.' },
}

export const BUILD_STATUSES = (Object.keys(BUILD_STATUS_META) as BuildStatus[]).map(value => ({
  value,
  label: BUILD_STATUS_META[value].label,
}))

/**
 * The columns this register reads about a product. Everything the maths needs, and nothing it
 * does not: `current_stock` is the RPC's own running figure, `purchase_price` is the field
 * `/accounting` values stock at, so the roll-up here and the balance sheet there cannot disagree.
 */
export interface BomProduct {
  id: string
  name: string
  sku?: string | null
  unit?: string | null
  hsn_sac?: string | null
  track_inventory?: boolean | null
  current_stock?: number | null
  purchase_price?: number | null
  selling_price?: number | null
}

export type ProductIndex = Map<string, BomProduct>

export interface RecipeComponent {
  id: string
  product_id: string
  /** Drawn for one full run of the recipe — which makes `output_qty` units, not one. */
  qty: number
  /** Percent over the drawn quantity that never reaches a finished unit. */
  waste_pct: number
  note: string
}

export interface Recipe {
  id: string
  name: string
  /** The finished good this recipe makes. */
  output_product_id: string
  /** How many units one run produces. A tray of 24 is 24, and the components are per tray. */
  output_qty: number
  status: RecipeStatus
  notes: string
  components: RecipeComponent[]
  /** Paid labour one full run takes, in minutes. A quantity — the rupee comes from the rates table. */
  labour_minutes: number
  /** Machine, power and rent time one full run absorbs, in minutes. Same rule. */
  overhead_minutes: number
  created_at: string
}

/**
 * One dated row of the shop rates. A rate is a dated row with a source stamp, never a constant —
 * the same discipline `/fx` keeps for exchange rates — so a run from last quarter is costed at the
 * rate that was in force when it ran. Either figure may be left unrecorded on a row; a leg with
 * minutes but no figure in force prints a dash and a reason, never ₹0.
 */
export interface CostRate {
  id: string
  /** The day this row starts applying. One row per day; the latest row that has started wins. */
  from_date: string
  /** ₹ per labour hour, or null while nobody has recorded it. */
  labour_per_hour: number | null
  /** ₹ per overhead hour (machine, power, rent), or null. */
  overhead_per_hour: number | null
  note: string
}

/**
 * One drawn quantity traced to the physical lot it came off — the batch register's row, copied
 * here so the run is readable without re-deriving it. Optional on purpose: a shop that keeps no
 * lots for a bought-in part draws by quantity alone, and an old run written before R2-29 reads
 * back as exactly that.
 */
export interface LotPick {
  /** `batches.ts`'s own lot id — the link, never a re-issued number. */
  batch_id: string
  /** The batch number as the register prints it, so a movement note is readable on its own. */
  batch_no: string
  qty: number
  /** The lot's expiry date at draw time, '' when the part does not perish. A past date is *named*, not hidden. */
  expiry_date: string
}

/**
 * One numbered unit a draw consumed — the serial register's row, copied here the same way
 * `LotPick` copies a lot: the run is readable without re-deriving it, and the link back is the
 * register's own id. Each pick is exactly one unit; a line of three motors names three picks.
 */
export interface SerialPick {
  /** `serials.ts`'s own unit id — the link, never a re-issued number. */
  serial_id: string
  /** The number as printed on the unit, so a movement note reads on its own. */
  serial_no: string
}

export interface BuildLine {
  product_id: string
  /** What the shop actually drew. Stored, because the drum said what it said. */
  qty: number
  /**
   * Which lots that quantity came off, FEFO. Absent = this draw names no physical batch:
   * either the part is not batch-tracked, or the run predates R2-29.
   */
  lots?: LotPick[]
  /**
   * Which numbered units that quantity consumed, oldest on the shelf first. Absent = this draw
   * names no unit: either the part is not tracked by the serial register, or the run predates
   * R2-35. All-or-nothing, like `lots`: a line that names any must name the whole draw.
   */
  serials?: SerialPick[]
}

export interface Build {
  id: string
  /** `JOB-<FY>-NNNN`, allocated by this register, never by an invoice sequence. */
  ref: string
  recipe_id: string
  date: string
  /** Finished units produced. */
  units: number
  status: BuildStatus
  lines: BuildLine[]
  /** The movements reached `record_stock_movement`. A built run that never wrote is a plan, not a fact. */
  moved: boolean
  /**
   * The lot the finished units landed in — `batches.ts`'s row, created when a run with a
   * batch-tracked output was recorded. Absent for a plan, for an untracked output, and for every
   * run written before R2-29.
   */
  output_batch_id?: string
  notes: string
  created_at: string
}

export interface BomStore {
  version: number
  updatedAt: string
  orgId: string
  recipes: Recipe[]
  builds: Build[]
  /** Dated shop rates the labour and overhead legs are priced from. */
  rates: CostRate[]
  /** Per-FY high-water mark for the job number, keyed by FY label (`2026-27` → 4). */
  seq: Record<string, number>
}

export function emptyBom(orgId = ''): BomStore {
  return { version: BOM_VERSION, updatedAt: todayISO(), orgId, recipes: [], builds: [], rates: [], seq: {} }
}

export function newRecipe(status: RecipeStatus = 'active'): Recipe {
  return {
    id: newId(),
    name: '',
    output_product_id: '',
    output_qty: 1,
    status,
    notes: '',
    components: [],
    labour_minutes: 0,
    overhead_minutes: 0,
    created_at: new Date().toISOString(),
  }
}

export function newComponent(productId = ''): RecipeComponent {
  return { id: newId(), product_id: productId, qty: 1, waste_pct: 0, note: '' }
}

export function newBuild(recipeId: string, ref: string, date = todayISO()): Build {
  return {
    id: newId(),
    ref,
    recipe_id: recipeId,
    date,
    units: 0,
    status: 'planned',
    lines: [],
    moved: false,
    notes: '',
    created_at: new Date().toISOString(),
  }
}

export function newRate(from = todayISO()): CostRate {
  return { id: newId(), from_date: from, labour_per_hour: null, overhead_per_hour: null, note: '' }
}

// ── parsing and storage ───────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

function isRecipeStatus(v: unknown): v is RecipeStatus {
  return v === 'draft' || v === 'active' || v === 'archived'
}

function isBuildStatus(v: unknown): v is BuildStatus {
  return v === 'planned' || v === 'built' || v === 'cancelled'
}

/** A real calendar day, not twelve digits with dashes in them. */
export function isDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const max = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0
  return m >= 1 && m <= 12 && d >= 1 && d <= max
}

/** Quantities keep four decimals — a recipe speaks in fractions of a unit — money keeps two. */
function roundQty(v: number): number {
  return Math.round((Number(v) || 0) * 10000) / 10000
}

/** 45 → "45 min", 135 → "2 h 15 min" — minutes read as time once they grow. */
export function fmtMinutes(mins: number): string {
  const m = Math.round(mins)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} h ${rest} min` : `${h} h`
}

function parseComponent(raw: unknown): RecipeComponent | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  const id = str(c.id)
  // A line pointing at nothing is not a material; a zero quantity is not a draw either.
  if (!id || !str(c.product_id) || !(num(c.qty) > 0)) return null
  return {
    id,
    product_id: str(c.product_id),
    qty: roundQty(num(c.qty)),
    waste_pct: Math.min(MAX_WASTE_PCT, Math.max(0, num(c.waste_pct))),
    note: str(c.note),
  }
}

/** Minutes keep the quantity rounding; a leg of zero minutes is an honest zero, not a gap. */
function clampMinutes(v: unknown): number {
  return Math.min(MAX_MINUTES_PER_RUN, Math.max(0, roundQty(num(v))))
}

function parseRecipe(raw: unknown): Recipe | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id || !str(r.output_product_id)) return null
  const output_qty = roundQty(num(r.output_qty))
  if (!(output_qty > 0)) return null
  const components = Array.isArray(r.components)
    ? r.components.map(parseComponent).filter((c): c is RecipeComponent => c !== null)
    : []
  return {
    id,
    name: str(r.name),
    output_product_id: str(r.output_product_id),
    output_qty,
    // A status this register has never heard of is read as **in use**, the way `projects.ts` reads
    // an unknown project status as active: hiding a recipe the shop wrote down is the silent
    // failure, and an unreadable value must not quietly remove a product from every plan. A *run*
    // falls the other way — to `planned` — because there an optimistic read would claim stock that
    // no movement trail has ever recorded.
    status: isRecipeStatus(r.status) ? r.status : 'active',
    notes: str(r.notes),
    // One row per component product, whatever the envelope held — two lines for the same screw
    // is a recipe nobody can read, and the maths would silently add them.
    components: [...new Map(components.map(c => [c.product_id, c])).values()],
    // Minutes arrived with R2-28; an envelope written before them reads as zero minutes, which is
    // what the shop had recorded when the field did not exist.
    labour_minutes: clampMinutes(r.labour_minutes),
    overhead_minutes: clampMinutes(r.overhead_minutes),
    created_at: str(r.created_at) || new Date().toISOString(),
  }
}

function parsePick(raw: unknown): LotPick | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const batch_id = str(p.batch_id)
  const qty = num(p.qty)
  if (!batch_id || !(qty > 0)) return null
  const expiry = str(p.expiry_date)
  return { batch_id, batch_no: str(p.batch_no), qty: roundQty(qty), expiry_date: isDate(expiry) ? expiry : '' }
}

function parseSerialPick(raw: unknown): SerialPick | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const serial_id = str(p.serial_id)
  if (!serial_id) return null
  return { serial_id, serial_no: str(p.serial_no) }
}

function parseLine(raw: unknown): BuildLine | null {
  if (!raw || typeof raw !== 'object') return null
  const l = raw as Record<string, unknown>
  if (!str(l.product_id) || !(num(l.qty) > 0)) return null
  const line: BuildLine = { product_id: str(l.product_id), qty: roundQty(num(l.qty)) }
  // Two picks naming one lot would double-count the same physical units: merged, not kept.
  const picks = Array.isArray(l.lots) ? l.lots.map(parsePick).filter((p): p is LotPick => p !== null) : []
  if (picks.length) {
    const merged = new Map<string, LotPick>()
    for (const p of picks) {
      const prev = merged.get(p.batch_id)
      if (prev) prev.qty = roundQty(prev.qty + p.qty)
      else merged.set(p.batch_id, { ...p })
    }
    line.lots = [...merged.values()]
  }
  // One pick per unit; the same unit named twice would claim one physical unit went into the
  // run twice, so a repeat is dropped rather than kept.
  const serials = Array.isArray(l.serials) ? l.serials.map(parseSerialPick).filter((p): p is SerialPick => p !== null) : []
  if (serials.length) line.serials = [...new Map(serials.map(p => [p.serial_id, p])).values()]
  return line
}

function parseBuild(raw: unknown): Build | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const id = str(b.id)
  if (!id || !str(b.recipe_id) || !isDate(b.date)) return null
  const units = roundQty(num(b.units))
  if (!(units > 0)) return null
  const lines = Array.isArray(b.lines) ? b.lines.map(parseLine).filter((l): l is BuildLine => l !== null) : []
  return {
    id,
    ref: str(b.ref),
    recipe_id: str(b.recipe_id),
    date: b.date,
    units,
    status: isBuildStatus(b.status) ? b.status : 'planned',
    lines: [...new Map(lines.map(l => [l.product_id, l])).values()],
    moved: b.moved === true,
    // A build that names no lot simply has no `output_batch_id` — an empty string would read as
    // "a lot exists and its id is blank", which is a broken link rather than an absent one.
    ...(str(b.output_batch_id) ? { output_batch_id: str(b.output_batch_id) } : {}),
    notes: str(b.notes),
    created_at: str(b.created_at) || new Date().toISOString(),
  }
}

function parseRate(raw: unknown): CostRate | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id || !isDate(r.from_date)) return null
  const clamp = (v: unknown) => {
    const n = num(v)
    return n > 0 && n <= MAX_RATE_PER_HOUR ? round2(n) : null
  }
  const labour = clamp(r.labour_per_hour)
  const overhead = clamp(r.overhead_per_hour)
  // A row with no figure on either leg is not a rate, it is a placeholder — drop it rather than
  // let it shadow a real row that starts the same day.
  if (labour === null && overhead === null) return null
  return { id, from_date: r.from_date, labour_per_hour: labour, overhead_per_hour: overhead, note: str(r.note) }
}

export function parseBom(raw: string | null): BomStore {
  if (!raw) return emptyBom()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyBom()
  }
  if (!parsed || typeof parsed !== 'object') return emptyBom()
  const s = parsed as Record<string, unknown>
  const orgId = str(s.orgId)
  if (s.version !== BOM_VERSION) return emptyBom(orgId)
  const recipes = Array.isArray(s.recipes) ? s.recipes.map(parseRecipe).filter((r): r is Recipe => r !== null) : []
  const builds = Array.isArray(s.builds) ? s.builds.map(parseBuild).filter((b): b is Build => b !== null) : []
  const ratesIn = Array.isArray(s.rates) ? s.rates.map(parseRate).filter((r): r is CostRate => r !== null) : []
  const seqIn = s.seq && typeof s.seq === 'object' ? (s.seq as Record<string, unknown>) : {}
  const seq: Record<string, number> = {}
  for (const [k, v] of Object.entries(seqIn)) {
    const n = Number(v ?? 0)
    if (Number.isFinite(n) && n > 0) seq[k] = Math.floor(n)
  }
  return {
    version: BOM_VERSION,
    updatedAt: str(s.updatedAt) || todayISO(),
    orgId,
    // One row per recipe id, whatever the envelope held; two live recipes for one product are
    // legitimate (a cheaper substitute run) and nothing else is deduped.
    recipes: [...new Map(recipes.map(r => [r.id, r])).values()],
    // A build whose recipe is not in the envelope is dropped — it cannot be planned, priced or
    // reversed, and half a movement trail is worse than a shorter one.
    builds: builds.filter(b => recipes.some(r => r.id === b.recipe_id)),
    // One rate per start-day (the last one wins), because `rateFor` would otherwise have two
    // answers for the same day and the costing would depend on array order.
    rates: [...new Map(ratesIn.map(r => [r.from_date, r])).values()].sort((a, b) => (a.from_date < b.from_date ? -1 : 1)),
    seq,
  }
}

export function loadBom(orgId: string): BomStore {
  if (typeof window === 'undefined' || !orgId) return emptyBom()
  try {
    const store = parseBom(window.localStorage.getItem(KEY_BOM + orgId))
    return { ...store, orgId }
  } catch {
    return emptyBom(orgId)
  }
}

export function saveBom(orgId: string, store: BomStore): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(
      KEY_BOM + orgId,
      JSON.stringify({ ...store, orgId, version: BOM_VERSION, updatedAt: todayISO() }),
    )
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

function mutate(orgId: string, fn: (store: BomStore) => BomStore): BomStore {
  const next = fn(loadBom(orgId))
  saveBom(orgId, next)
  return next
}

// ── writing the register ──────────────────────────────────────────────────────

export function upsertRecipe(orgId: string, recipe: Recipe): Recipe[] {
  return mutate(orgId, s => ({
    ...s,
    recipes: s.recipes.some(r => r.id === recipe.id)
      ? s.recipes.map(r => (r.id === recipe.id ? recipe : r))
      : [recipe, ...s.recipes],
  })).recipes
}

export function upsertBuild(orgId: string, build: Build): Build[] {
  return mutate(orgId, s => ({
    ...s,
    builds: s.builds.some(b => b.id === build.id)
      ? s.builds.map(b => (b.id === build.id ? build : b))
      : [build, ...s.builds],
  })).builds
}

export function upsertRate(orgId: string, rate: CostRate): CostRate[] {
  return mutate(orgId, s => ({
    ...s,
    rates: [...s.rates.filter(r => r.id !== rate.id), rate].sort((a, b) => (a.from_date < b.from_date ? -1 : 1)),
  })).rates
}

export function removeRate(orgId: string, id: string): CostRate[] {
  return mutate(orgId, s => ({ ...s, rates: s.rates.filter(r => r.id !== id) })).rates
}

export interface Refusal {
  ok: boolean
  reason?: string
}

/** A recipe with builds on it is history. Archiving keeps the recipe and stops new runs. */
export function removeRecipe(orgId: string, id: string): Refusal {
  const store = loadBom(orgId)
  const used = store.builds.filter(b => b.recipe_id === id).length
  if (used > 0) {
    return {
      ok: false,
      reason: `${used} build${used === 1 ? '' : 's'} on the log were made from this recipe — archive it instead of deleting it.`,
    }
  }
  mutate(orgId, s => ({ ...s, recipes: s.recipes.filter(r => r.id !== id) }))
  return { ok: true }
}

/**
 * A run that reached the stock ledger cannot be edited away — the movements are already in the
 * trail, and rewriting them would make the physical stock disagree with the papers. It is
 * cancelled instead, which is a *new* pair of movements putting everything back. The register
 * only flips the status here: writing that reversal is the screen's job, because the register
 * has no Supabase client and must not invent one.
 */
export function cancelBuild(orgId: string, id: string): Refusal {
  const store = loadBom(orgId)
  const build = store.builds.find(b => b.id === id)
  if (!build) return { ok: false, reason: 'That build is not on the register.' }
  if (build.status === 'cancelled') return { ok: false, reason: 'Already cancelled.' }
  mutate(orgId, s => ({ ...s, builds: s.builds.map(b => (b.id === id ? { ...b, status: 'cancelled' } : b)) }))
  return { ok: true }
}

/** Remove a *planned* run that never touched stock. A built run is only ever reversed. */
export function removeBuild(orgId: string, id: string): Refusal {
  const build = loadBom(orgId).builds.find(b => b.id === id)
  if (!build) return { ok: false, reason: 'That build is not on the register.' }
  if (build.moved || build.status === 'built') {
    return { ok: false, reason: 'Its movements are already in the stock ledger — cancel it and let the reversal put them back.' }
  }
  mutate(orgId, s => ({ ...s, builds: s.builds.filter(b => b.id !== id) }))
  return { ok: true }
}

// ── job numbering ─────────────────────────────────────────────────────────────

function maxUsedInBuilds(store: BomStore, fy: string): number {
  const re = new RegExp(`^${BUILD_PREFIX}-${fy}-(\\d+)$`)
  let max = 0
  for (const b of store.builds) {
    const m = re.exec(b.ref)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return max
}

/** The number the next build on this date would get. Allocates nothing. */
export function peekRef(store: BomStore, date = todayISO()): string {
  const fy = fyLabel(fyStartYear(new Date(`${date}T00:00:00`)))
  const last = Math.max(store.seq[fy] ?? 0, maxUsedInBuilds(store, fy))
  return `${BUILD_PREFIX}-${fy}-${String(last + 1).padStart(4, '0')}`
}

/** Take the number and move the high-water mark. The caller saves what comes back. */
export function allocateRef(store: BomStore, date = todayISO()): { ref: string; store: BomStore } {
  const ref = peekRef(store, date)
  const fy = ref.split('-').slice(1, 3).join('-')
  const n = parseInt(ref.split('-')[3] ?? '0', 10) || 0
  return { ref, store: { ...store, seq: { ...store.seq, [fy]: Math.max(store.seq[fy] ?? 0, n) } } }
}

// ── the shape of a recipe ─────────────────────────────────────────────────────

export function indexProducts(products: BomProduct[]): ProductIndex {
  return new Map(products.map(p => [p.id, p]))
}

function nameOf(index: ProductIndex, id: string): string {
  return index.get(id)?.name?.trim() || ''
}

/** Drawn per finished unit, waste included — the number the shortage maths runs on. */
export function perUnitNeed(component: RecipeComponent, recipe: Recipe): number {
  if (!(recipe.output_qty > 0)) return 0
  return roundQty((component.qty * (1 + component.waste_pct / 100)) / recipe.output_qty)
}

/** What one run of `units` needs of every component, waste included. */
export function requirement(recipe: Recipe, units: number): BuildLine[] {
  if (!(units > 0)) return []
  return recipe.components.map(c => ({
    product_id: c.product_id,
    qty: roundQty(perUnitNeed(c, recipe) * units),
  }))
}

/**
 * The path that makes a product need itself, or null if there is none. A cycle is a real mistake
 * in a recipe book — a sleeve of screws feeding the box that holds the sleeve — and the planner
 * would recurse forever, so it is refused at the door rather than caught mid-explosion.
 */
export function findCycle(recipes: Recipe[], outputProductId: string, from: string[] = []): string[] | null {
  for (const r of recipes) {
    if (r.status === 'archived') continue
    if (r.output_product_id !== outputProductId) continue
    for (const c of r.components) {
      if (from.includes(c.product_id)) return [...from, c.product_id, outputProductId]
      const deeper = findCycle(recipes, c.product_id, [...from, outputProductId])
      if (deeper) return deeper
    }
  }
  return null
}

/**
 * Refusals only — things that make the register wrong rather than ugly. A missing cost or a
 * missing HSN is not here: those are findings, because the recipe may be perfectly written and
 * the *master* is what needs the fix, and a shop must still be able to save it.
 */
export function validateRecipe(recipe: Recipe, recipes: Recipe[], products: BomProduct[]): string[] {
  const errs: string[] = []
  const index = indexProducts(products)
  if (!recipe.name.trim()) errs.push('Give the recipe a name — two unnamed recipes cannot be told apart.')
  if (!recipe.output_product_id) errs.push('Choose the finished product this recipe makes.')
  else if (!index.has(recipe.output_product_id)) errs.push('The finished product is not in the catalogue.')
  if (!(recipe.output_qty > 0)) errs.push('One run has to make at least one unit.')
  if (recipe.output_qty > MAX_UNITS_PER_BUILD) errs.push(`One run cannot make more than ${MAX_UNITS_PER_BUILD} units.`)
  if (recipe.labour_minutes < 0 || recipe.overhead_minutes < 0) errs.push('Minutes cannot be negative — a run cannot take back time.')
  if (recipe.labour_minutes > MAX_MINUTES_PER_RUN || recipe.overhead_minutes > MAX_MINUTES_PER_RUN) {
    errs.push(`A run cannot take more than ${MAX_MINUTES_PER_RUN} minutes of one kind — that is a unit error, not a shift.`)
  }
  if (!recipe.components.length) errs.push('A recipe with nothing in it is a note, not a recipe.')
  if (recipe.components.length > MAX_COMPONENTS) errs.push(`Up to ${MAX_COMPONENTS} components in a recipe.`)

  const seen = new Set<string>()
  for (const c of recipe.components) {
    const label = nameOf(index, c.product_id) || c.product_id
    if (seen.has(c.product_id)) errs.push(`"${label}" appears twice — one line per component, add the quantities together.`)
    seen.add(c.product_id)
    if (!index.has(c.product_id)) errs.push(`"${label}" is not in the catalogue.`)
    if (!(c.qty > 0)) errs.push(`"${label}" needs a quantity above zero.`)
    if (c.qty > MAX_QTY_PER_COMPONENT) errs.push(`"${label}" at ${c.qty} is a unit error, not a recipe.`)
    if (c.waste_pct < 0 || c.waste_pct > MAX_WASTE_PCT) errs.push(`"${label}" cannot waste more than everything.`)
  }
  if (recipe.output_product_id && seen.has(recipe.output_product_id)) {
    errs.push('A product cannot be made out of itself.')
  }
  // The self-check above is one hop; a sub-assembly can close the loop three hops away.
  if (recipe.output_product_id) {
    const without = recipes.filter(r => r.id !== recipe.id)
    const cycle = findCycle([...without, recipe], recipe.output_product_id)
    if (cycle) errs.push(`This recipe loops back on itself: ${cycle.map(id => nameOf(index, id) || id).join(' → ')}.`)
  }
  if (recipe.status === 'archived' && recipe.components.some(c => !c.qty)) {
    errs.push('Archived and incomplete at the same time — decide which it is.')
  }
  return errs
}

/**
 * Refusals for a rate row. A rate of zero is refused, not clamped: the register's honesty rule is
 * that absence prints a dash and zero prints a claim, so a row that wants to say "the work costs
 * nothing" has to stay unrecorded instead. A row with neither figure is not a rate.
 */
export function validateRate(rate: CostRate, rates: CostRate[]): string[] {
  const errs: string[] = []
  if (!isDate(rate.from_date)) errs.push('A rate needs the day it starts applying.')
  if (rate.labour_per_hour === null && rate.overhead_per_hour === null) {
    errs.push('A rate row with neither figure is not a rate — put the day back until there is something to price with it.')
  }
  if (rate.labour_per_hour !== null && !(rate.labour_per_hour > 0)) {
    errs.push('A labour rate of ₹0 claims the work costs nothing — leave the figure out if nobody is paid for it.')
  }
  if (rate.overhead_per_hour !== null && !(rate.overhead_per_hour > 0)) {
    errs.push('An overhead rate of ₹0 claims the machine and rent cost nothing — leave the figure out instead.')
  }
  if (rate.labour_per_hour !== null && rate.labour_per_hour > MAX_RATE_PER_HOUR) errs.push('That labour rate is not a wage, it is a typo.')
  if (rate.overhead_per_hour !== null && rate.overhead_per_hour > MAX_RATE_PER_HOUR) errs.push('That overhead rate is not an absorption figure, it is a typo.')
  if (isDate(rate.from_date) && rates.some(r => r.id !== rate.id && r.from_date === rate.from_date)) {
    errs.push('A row already starts on that day — edit it instead of adding a second answer for the same day.')
  }
  return errs
}

/**
 * The rate row in force on a day: the latest row whose start does not come after it. Null when no
 * row has started yet — a rate that begins tomorrow prices nothing today.
 */
export function rateFor(rates: CostRate[], date: string): CostRate | null {
  let found: CostRate | null = null
  for (const r of rates) {
    if (r.from_date <= date && (!found || r.from_date >= found.from_date)) found = r
  }
  return found
}

/**
 * Refusals for a run. A build that draws more than is on hand is refused, because it would put
 * the finished units in and take raw material the shop does not have out — a negative stock the
 * ledger would believe. The plan screen shows the shortfall and links to buy it instead.
 */
export function validateBuild(build: Build, recipe: Recipe | undefined, products: BomProduct[]): string[] {
  const errs: string[] = []
  const index = indexProducts(products)
  if (!recipe) errs.push('Choose the recipe this run was made from.')
  else if (recipe.status !== 'active') errs.push(`A ${RECIPE_STATUS_META[recipe.status].label.toLowerCase()} recipe cannot be built — activate it first.`)
  if (!isDate(build.date)) errs.push('The build needs a real date.')
  else if (build.date > todayISO()) errs.push('A run cannot be recorded for a day that has not happened yet.')
  if (!(build.units > 0)) errs.push('Say how many units were made.')
  if (build.units > MAX_UNITS_PER_BUILD) errs.push(`${build.units} units in one run is a typo, not a batch.`)
  for (const l of build.lines) {
    if (!index.has(l.product_id)) errs.push(`A drawn line points at "${l.product_id}", which is not in the catalogue.`)
    if (!(l.qty > 0)) errs.push('Every drawn line needs a quantity above zero.')
  }
  return errs
}

// ── planning ──────────────────────────────────────────────────────────────────

export type PlanTone = 'ok' | 'short' | 'unknown'

export interface PlanRow {
  product_id: string
  name: string
  unit: string
  /** Finished units this row is drawn for — 1 for a bought-in part at the top level. */
  for_units: number
  need: number
  on_hand: number
  short: number
  /** A component the shop does not track cannot be planned; that is stated, not assumed away. */
  tracked: boolean
  tone: PlanTone
  /** Depth 0 is the recipe's own components; deeper rows come from a sub-assembly. */
  level: number
  made_by_recipe: boolean
}

export interface MaterialPlan {
  rows: PlanRow[]
  /** How many units the whole recipe could be run for, right now, on the stock in hand. */
  buildable_units: number
  /** The component that decided `buildable_units`, named — the answer to "what is holding me up". */
  limited_by: string
  shortages: PlanRow[]
  untracked: string[]
  can_run: boolean
}

function stockOf(index: ProductIndex, id: string): number {
  const p = index.get(id)
  if (!p || p.track_inventory === false) return 0
  return roundQty(num(p.current_stock))
}

function isTracked(index: ProductIndex, id: string): boolean {
  const p = index.get(id)
  // A product the shop never counted cannot be short: say so instead of reporting zero on hand.
  return !!p && p.track_inventory !== false
}

export interface PlanOptions {
  /**
   * Expand components that have their own recipe down to the parts that must actually be bought.
   * Default: explode to the leaves, which is what a materials board wants.
   */
  explode?: boolean
}

const NO_LIMIT = Number.MAX_SAFE_INTEGER

/**
 * The plan a build needs: what each component (or, through a sub-assembly, each part) wants,
 * what is on the shelf, and how much of the shortfall is the reason you cannot run today.
 *
 * Explosion is greedy by design: a component that has an active recipe is treated as *made*, so
 * its own components are what has to be on the shelf. A shop that also buys the sub-assembly
 * should archive its recipe — the register cannot know which the shop intends, so it asks for
 * the choice to be recorded rather than guessing it twice a day.
 *
 * The consequence for the two headline figures: a made row is printed (it is part of the product
 * tree, and its shelf figure tells the shop how much of the sub-assembly is already there), but it
 * is never the `limited_by` answer and never a `shortages` row. Emptying the shelf of something
 * you are about to make is not a blocker; running out of the part you buy in is.
 */
export function planBuild(
  recipe: Recipe,
  units: number,
  products: BomProduct[],
  recipes: Recipe[],
  opts: PlanOptions = {},
): MaterialPlan {
  const explode = opts.explode !== false
  const index = indexProducts(products)
  const active = recipes.filter(r => r.status === 'active' && r.id !== recipe.id)
  const byOutput = new Map(active.map(r => [r.output_product_id, r]))

  const rows: PlanRow[] = []
  const push = (product_id: string, need: number, level: number, for_units: number, made: boolean) => {
    const p = index.get(product_id)
    const tracked = isTracked(index, product_id)
    const on_hand = tracked ? stockOf(index, product_id) : 0
    const q = roundQty(need)
    rows.push({
      product_id,
      name: p?.name?.trim() || product_id,
      unit: p?.unit?.trim() || '',
      for_units,
      need: q,
      on_hand,
      short: roundQty(Math.max(0, q - on_hand)),
      tracked,
      tone: !tracked ? 'unknown' : q - on_hand > 0.0000001 ? 'short' : 'ok',
      level,
      made_by_recipe: made,
    })
  }

  const walk = (r: Recipe, unitsFor: number, level: number, trail: string[]) => {
    for (const c of r.components) {
      const need = roundQty(perUnitNeed(c, r) * unitsFor)
      const sub = explode && level + 1 < MAX_EXPLODE_DEPTH && !trail.includes(c.product_id)
        ? byOutput.get(c.product_id)
        : undefined
      if (sub) {
        // The sub-assembly is itself made: its own units are what the shelf cannot hold, so the
        // parent row is printed as a made row and the parts below it are what gets shorted.
        push(c.product_id, need, level, unitsFor, true)
        walk(sub, need, level + 1, [...trail, c.product_id])
      } else {
        push(c.product_id, need, level, unitsFor, false)
      }
    }
  }

  walk(recipe, units, 0, [recipe.output_product_id])

  // Two lines for one product — the sub-assembly and a direct draw — become one row: the shelf
  // holds one number and it has to cover both demands.
  const merged = new Map<string, PlanRow>()
  for (const r of rows) {
    const prev = merged.get(r.product_id)
    if (!prev) {
      merged.set(r.product_id, { ...r })
      continue
    }
    prev.need = roundQty(prev.need + r.need)
    prev.short = roundQty(Math.max(0, prev.need - prev.on_hand))
    prev.tone = !prev.tracked ? 'unknown' : prev.short > 0.0000001 ? 'short' : 'ok'
    prev.level = Math.min(prev.level, r.level)
    prev.made_by_recipe = prev.made_by_recipe || r.made_by_recipe
  }
  // Shallow first, then the state: a shortfall is the row the shop needs to see at the top of the
  // board, and an unknown (untracked) figure sits between a shortfall and an all-clear.
  const toneRank: Record<PlanTone, number> = { short: 0, unknown: 1, ok: 2 }
  const final = [...merged.values()].sort((a, b) =>
    a.level !== b.level ? a.level - b.level : toneRank[a.tone] !== toneRank[b.tone] ? toneRank[a.tone] - toneRank[b.tone] : a.name.localeCompare(b.name),
  )

  // How many units *could* run: the tightest bought-in, stock-tracked component decides. Made
  // rows are skipped — their shelf figure is stock you are about to build, not a constraint (the
  // parts under them are), and untracked ones cannot decide anything, so they are excluded rather
  // than read as zero on hand.
  let buildable = NO_LIMIT
  let limited_by = ''
  for (const r of merged.values()) {
    if (!r.tracked || r.made_by_recipe || !(r.need > 0)) continue
    const perUnit = r.need / (units > 0 ? units : 1)
    const possible = perUnit > 0 ? Math.floor((r.on_hand / perUnit) * 10000) / 10000 : NO_LIMIT
    if (possible < buildable) {
      buildable = possible
      limited_by = r.name
    }
  }

  const shortages = final.filter(r => r.tone === 'short' && !r.made_by_recipe)
  return {
    rows: final,
    buildable_units: buildable === NO_LIMIT ? units : buildable,
    limited_by: buildable === NO_LIMIT ? '' : limited_by,
    shortages,
    untracked: [...new Set(recipe.components.filter(c => !isTracked(index, c.product_id)).map(c => nameOf(index, c.product_id) || c.product_id))],
    can_run: shortages.length === 0,
  }
}

// ── money, read from the books ───────────────────────────────────────────────

export interface RollUp {
  /** Null when anything is unpriced — a partial total would be read as the whole one. */
  value: number | null
  /** Component names with no cost recorded, so the page can say *which* price is missing. */
  unpriced: string[]
  /** Σ of the priced rows, for the honest "so far" figure the page may print beside the gap. */
  partial: number
}

/**
 * The material value of a set of drawn quantities, read from the cost the catalogue carries —
 * `purchase_price`, which is the same field `/accounting` multiplies by `current_stock` to value
 * stock. Nothing is stored here, so a corrected price on a component reprices every recipe and
 * every past build's *today* figure by itself. A past build's *historical* cost cannot be
 * re-read — there is no price history in this schema — which is why a build stamps what it read
 * at the time (see `stampCost`).
 */
export function rollUpCost(lines: BuildLine[], products: BomProduct[]): RollUp {
  const index = indexProducts(products)
  let total = 0
  const unpriced: string[] = []
  for (const l of lines) {
    const p = index.get(l.product_id)
    const price = num(p?.purchase_price)
    if (!(price > 0)) {
      unpriced.push(p?.name?.trim() || l.product_id)
      continue
    }
    total += price * l.qty
  }
  return {
    value: unpriced.length ? null : round2(total),
    unpriced,
    partial: round2(total),
  }
}

/** A recipe's material cost per finished unit, at the prices the catalogue carries today. */
export function costPerUnit(recipe: Recipe, products: BomProduct[]): { per_unit: number | null; roll: RollUp } {
  const roll = rollUpCost(requirement(recipe, 1), products)
  return { per_unit: roll.value === null ? null : round2(roll.value), roll }
}

// ── labour and overhead, priced by dated shop rates ───────────────────────────

export type CostLegName = 'labour' | 'overhead'

/** One cost leg of a run: the minutes it took and what those minutes read as, or null. */
export interface CostLeg {
  minutes: number
  /** ₹ the leg reads as — null while no rate in force carries a figure for it. */
  value: number | null
  /** The ₹/hour in force, when there is one — the page prints it beside the rupees. */
  rate: number | null
  /** Why the leg prints a dash, when it does. */
  missing: string
}

function costLeg(minutes: number, rates: CostRate[], date: string, which: CostLegName): CostLeg {
  if (!(minutes > 0)) return { minutes: 0, value: 0, rate: null, missing: '' }
  const row = rateFor(rates, date)
  const rate = row ? row[which === 'labour' ? 'labour_per_hour' : 'overhead_per_hour'] : null
  if (!(rate !== null && rate > 0)) {
    return {
      minutes,
      value: null,
      rate: null,
      missing: row
        ? `no ${which} figure on the rate row in force (${row.from_date})`
        : `no shop rate in force on ${date}`,
    }
  }
  // Minutes are time and the rate is per hour: 45 minutes at ₹120/hour is ₹90, not ₹5,400.
  return { minutes, value: round2((minutes / 60) * rate), rate, missing: '' }
}

/** The whole cost of one run of a recipe: parts, labour and overhead, each with its own basis. */
export interface FullCost {
  material: RollUp
  labour: CostLeg
  overhead: CostLeg
  /**
   * Parts + labour + overhead for the whole run. Null while any leg that carries minutes is
   * unpriced or a component has no cost — a partial total would be read as the whole one.
   */
  value: number | null
  /** `value` divided over the units one run makes. */
  per_unit: number | null
  /** Which legs could not be read: component names for parts, 'labour'/'overhead' for rates. */
  missing: string[]
}

export function fullCostOfRun(recipe: Recipe, products: BomProduct[], rates: CostRate[], date: string): FullCost {
  // One run means output_qty units of parts — requirement(recipe, 1) would be per-unit and mix
  // bases against the per-run minutes below.
  const material = rollUpCost(requirement(recipe, recipe.output_qty), products)
  const labour = costLeg(recipe.labour_minutes, rates, date, 'labour')
  const overhead = costLeg(recipe.overhead_minutes, rates, date, 'overhead')
  const missing = [...material.unpriced]
  if (labour.missing) missing.push(`labour — ${labour.missing}`)
  if (overhead.missing) missing.push(`overhead — ${overhead.missing}`)
  const value =
    material.value !== null && labour.value !== null && overhead.value !== null
      ? round2(material.value + labour.value + overhead.value)
      : null
  return {
    material,
    labour,
    overhead,
    value,
    per_unit: value === null || !(recipe.output_qty > 0) ? null : round2(value / recipe.output_qty),
    missing,
  }
}

/**
 * What a recorded run cost, at the minutes the recipe carries scaled to the units it made and the
 * rates in force **on the run's own date**. The material leg is still today's reading — there is
 * no price history on `products` — which is why nothing here adds the legs into one figure without
 * the caller saying so.
 */
export function fullCostOfBuild(build: Build, recipe: Recipe | undefined, products: BomProduct[], rates: CostRate[]): FullCost {
  if (!recipe || !(recipe.output_qty > 0)) {
    const material = rollUpCost(build.lines, products)
    return { material, labour: { minutes: 0, value: 0, rate: null, missing: '' }, overhead: { minutes: 0, value: 0, rate: null, missing: '' }, value: material.value, per_unit: material.value === null || !(build.units > 0) ? null : round2(material.value / build.units), missing: [...material.unpriced] }
  }
  const runs = build.units / recipe.output_qty
  const material = rollUpCost(build.lines, products)
  const labour = costLeg(roundQty(recipe.labour_minutes * runs), rates, build.date, 'labour')
  const overhead = costLeg(roundQty(recipe.overhead_minutes * runs), rates, build.date, 'overhead')
  const missing = [...material.unpriced]
  if (labour.missing) missing.push(`labour — ${labour.missing}`)
  if (overhead.missing) missing.push(`overhead — ${overhead.missing}`)
  const value =
    material.value !== null && labour.value !== null && overhead.value !== null
      ? round2(material.value + labour.value + overhead.value)
      : null
  return {
    material,
    labour,
    overhead,
    value,
    per_unit: value === null || !(build.units > 0) ? null : round2(value / build.units),
    missing,
  }
}

/**
 * What the run was worth when it was written down, leg by leg. The material figure is a reading of
 * *today's* catalogue (there is no price history), so it is stamped as of now; the labour and
 * overhead legs are read at the rates in force on the run's own date and stay re-readable — but
 * the stamp carries them so the screen can print the split at the moment of writing. Stamped as a
 * *reading*, not a posting: this register is not the general ledger and no account was touched.
 */
export interface CostStamp {
  /** Full cost per unit — parts, labour and overhead — or null while a leg is unpriced. */
  per_unit: number | null
  total: number | null
  /** Component names that had no cost when the run was recorded. */
  unpriced: string[]
  /** The three legs, each null while it could not be read; parts may be absent and still priced. */
  material: number | null
  labour: number | null
  overhead: number | null
  /** Rate-leg reasons when labour/overhead printed a dash. */
  unpriced_legs: string[]
  on: string
}

export function stampCost(build: Build, recipe: Recipe | undefined, products: BomProduct[], rates: CostRate[]): CostStamp {
  const full = fullCostOfBuild(build, recipe, products, rates)
  return {
    per_unit: full.per_unit,
    total: full.value,
    unpriced: full.material.unpriced,
    material: full.material.value,
    labour: full.labour.value,
    overhead: full.overhead.value,
    unpriced_legs: full.missing.filter(m => m.startsWith('labour') || m.startsWith('overhead')),
    on: todayISO(),
  }
}

// ── the views the page draws ──────────────────────────────────────────────────

export type FindingTone = 'red' | 'amber' | 'grey'

export interface Finding {
  text: string
  tone: FindingTone
}

export interface RecipeView {
  recipe: Recipe
  output?: BomProduct
  component_count: number
  /** Units made on runs that were built, and the number of runs behind them. */
  units_built: number
  build_count: number
  last_built: string
  planned_runs: number
  cost: { per_unit: number | null; roll: RollUp }
  /** Parts + labour + overhead for one run, each leg with its own basis. */
  full: FullCost
  /** Selling price less the full cost when that is priced; else less the material roll-up alone. */
  margin_per_unit: number | null
  margin_pct: number | null
  /** Which cost the margin was taken against, so the card can say so. */
  margin_basis: 'full' | 'material' | ''
  plan: MaterialPlan
  /** The variance the last built run showed against what its recipe wanted. */
  variance: number | null
  findings: Finding[]
}

function buildsOf(store: BomStore, recipeId: string): Build[] {
  return store.builds.filter(b => b.recipe_id === recipeId && b.status !== 'cancelled')
}

/**
 * One row per recipe: what it makes, what it needs, whether the shop can run it today, and every
 * reason it might not be telling the truth. Everything is derived — a recipe holds no rupees and
 * no stock figures, so nothing here can go stale against the catalogue.
 */
export function recipeView(recipe: Recipe, store: BomStore, products: BomProduct[]): RecipeView {
  const index = indexProducts(products)
  const output = index.get(recipe.output_product_id)
  const cost = costPerUnit(recipe, products)
  const full = fullCostOfRun(recipe, products, store.rates, todayISO())
  const builds = buildsOf(store, recipe.id)
  const built = builds.filter(b => b.status === 'built')
  const units_built = roundQty(built.reduce((s, b) => s + b.units, 0))
  const last_built = built.map(b => b.date).sort().reverse()[0] || ''
  const plan = planBuild(recipe, recipe.output_qty, products, store.recipes)

  const price = num(output?.selling_price)
  // Margin against the full cost when the register can read one; otherwise against parts alone,
  // with the basis named so nobody reads a parts-only figure as the whole truth. A recipe that
  // carries no minutes at all reports the material basis even though the full cost is priced —
  // its full cost *is* the parts, and "parts alone" is the whole truth, not a fallback.
  const has_minutes = recipe.labour_minutes > 0 || recipe.overhead_minutes > 0
  const margin_full = full.per_unit !== null && price > 0 ? round2(price - full.per_unit) : null
  const margin_material = cost.per_unit !== null && price > 0 ? round2(price - cost.per_unit) : null
  const margin = margin_full ?? margin_material
  const margin_basis: 'full' | 'material' | '' = margin_full !== null && has_minutes ? 'full' : margin_material !== null ? 'material' : ''

  // Variance: the most recent built run, its recipe's wanted quantities against what was drawn.
  let variance: number | null = null
  const newest = [...built].sort((a, b) => (a.date === b.date ? a.created_at.localeCompare(b.created_at) : a.date < b.date ? 1 : -1))[0]
  if (newest) {
    const wanted = requirement(recipe, newest.units)
    const drawn = new Map(newest.lines.map(l => [l.product_id, l.qty]))
    let sum = 0
    for (const w of wanted) sum += roundQty((drawn.get(w.product_id) ?? 0) - w.qty)
    variance = roundQty(sum)
  }

  const findings: Finding[] = []
  if (!output) findings.push({ text: 'The product this recipe makes is no longer in the catalogue.', tone: 'red' })
  else if (output.track_inventory === false) {
    findings.push({ text: `${output.name || 'It'} is not stock-tracked, so a run of this recipe moves no finished units.`, tone: 'amber' })
  }
  if (output && !str(output.hsn_sac).trim()) {
    findings.push({ text: 'The finished product has no HSN/SAC — an invoice for it cannot be filed correctly.', tone: 'amber' })
  }
  for (const c of recipe.components) {
    const p = index.get(c.product_id)
    if (!p) findings.push({ text: `A component (${c.product_id}) is no longer in the catalogue.`, tone: 'red' })
    else if (p.track_inventory === false) findings.push({ text: `${p.name} is not stock-tracked, so its shortage cannot be planned.`, tone: 'grey' })
    else if (!(num(p.purchase_price) > 0)) findings.push({ text: `${p.name} has no cost recorded, so this recipe cannot be priced.`, tone: 'amber' })
  }
  if (margin !== null && margin < 0) {
    findings.push(
      margin_basis === 'full'
        ? { text: 'The selling price is below what making it costs — parts, labour and overhead together lose money on every unit.', tone: 'red' }
        : { text: 'The selling price is below the material cost — this loses money on parts alone, before any labour is counted.', tone: 'red' },
    )
  }
  if (recipe.labour_minutes > 0 && full.labour.missing) {
    findings.push({ text: `${fmtMinutes(recipe.labour_minutes)} of labour a run, but ${full.labour.missing} — record it on the Shop rates tab.`, tone: 'amber' })
  }
  if (recipe.overhead_minutes > 0 && full.overhead.missing) {
    findings.push({ text: `${fmtMinutes(recipe.overhead_minutes)} of overhead a run, but ${full.overhead.missing} — record it on the Shop rates tab.`, tone: 'amber' })
  }
  if (!(recipe.labour_minutes > 0) && !(recipe.overhead_minutes > 0)) {
    findings.push({ text: 'No labour or overhead time on this recipe — the cost is parts alone.', tone: 'grey' })
  }
  if (plan.shortages.length) {
    findings.push({
      text: `Short of ${plan.shortages.length} component${plan.shortages.length === 1 ? '' : 's'} — ${plan.shortages.slice(0, 3).map(s => s.name).join(', ')}${plan.shortages.length > 3 ? '…' : ''}`,
      tone: 'red',
    })
  }
  if (recipe.status === 'draft') findings.push({ text: 'Still a draft: no run can be recorded against it.', tone: 'grey' })
  if (variance !== null && Math.abs(variance) > 0.0001) {
    findings.push({
      text: `The last run drew ${Math.abs(variance)} more than the recipe asked for — wastage, or the recipe is wrong.`,
      tone: 'amber',
    })
  }

  return {
    recipe,
    output,
    component_count: recipe.components.length,
    units_built,
    build_count: built.length,
    last_built,
    planned_runs: builds.filter(b => b.status === 'planned').length,
    cost,
    full,
    margin_per_unit: margin,
    margin_pct: margin === null || !(price > 0) ? null : round2((margin / price) * 100),
    margin_basis,
    plan,
    variance,
    findings,
  }
}

export function recipeViews(store: BomStore, products: BomProduct[]): RecipeView[] {
  return store.recipes.map(r => recipeView(r, store, products))
}

export function sortRecipeViews(views: RecipeView[]): RecipeView[] {
  const rank = (v: RecipeView) => (v.recipe.status === 'archived' ? 2 : v.recipe.status === 'draft' ? 1 : 0)
  return [...views].sort((a, b) =>
    rank(a) !== rank(b) ? rank(a) - rank(b) : a.recipe.name.localeCompare(b.recipe.name),
  )
}

export interface BuildView {
  build: Build
  recipe?: Recipe
  output?: BomProduct
  units: number
  /** What the drawn materials are worth at the prices the catalogue carries today. */
  cost_today: RollUp
  /** Parts + labour + overhead of the run, the rate legs at the rates in force on the run's date. */
  full: FullCost
  /** Which physical lots the draw came off — `count: 0` means the run drew by quantity alone. */
  lots: { count: number; picks: LotPick[]; lines: string[] }
  /** Which numbered units the draw took — `count: 0` means the run named no unit of any part. */
  serials: { count: number; picks: SerialPick[]; lines: string[] }
  /** What the recipe asked for, and what was drawn — the wastage the register exists to show. */
  wanted: BuildLine[]
  variance: { product_id: string; name: string; wanted: number; drawn: number; diff: number }[]
  findings: Finding[]
}

export interface BuildViewOptions {
  /**
   * Product ids the batch register holds a lot for *today*. Supplied, a built run that named no
   * lot gets an amber finding rather than silence; omitted, the view stays quiet, because absence
   * of the list is not evidence that the shop keeps no lots — it is evidence that nobody asked.
   */
  batchedProducts?: string[]
  /**
   * Product ids the serial register holds units for *today*, in any status. The same rule as
   * `batchedProducts`: supplied, a draw that could have named units and named none is told so.
   */
  serialledProducts?: string[]
}

export function buildView(build: Build, store: BomStore, products: BomProduct[], opts: BuildViewOptions = {}): BuildView {
  const index = indexProducts(products)
  const recipe = store.recipes.find(r => r.id === build.recipe_id)
  const wanted = recipe ? requirement(recipe, build.units) : []
  const full = fullCostOfBuild(build, recipe, products, store.rates)
  const drawn = new Map(build.lines.map(l => [l.product_id, l.qty]))
  const ids = [...new Set([...wanted.map(w => w.product_id), ...build.lines.map(l => l.product_id)])]
  const variance = ids
    .map(product_id => {
      const w = wanted.find(x => x.product_id === product_id)
      const d = drawn.get(product_id) ?? 0
      const diff = roundQty(d - (w?.qty ?? 0))
      return { product_id, name: nameOf(index, product_id) || product_id, wanted: w?.qty ?? 0, drawn: d, diff }
    })
    .filter(v => Math.abs(v.diff) > 0.0001 || v.wanted === 0)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))

  const findings: Finding[] = []
  if (build.status === 'planned' && !build.moved) findings.push({ text: 'A plan, not a fact: no stock has moved.', tone: 'grey' })
  if (build.status === 'built' && !build.moved) findings.push({ text: 'Marked built but its movements never reached the stock ledger.', tone: 'red' })
  if (build.status === 'cancelled' && build.moved) findings.push({ text: 'Cancelled — the reversal has to be written before the stock is true again.', tone: 'amber' })
  if (!recipe) findings.push({ text: 'Its recipe is no longer on the register.', tone: 'red' })
  if (variance.length) findings.push({ text: `${variance.length} line${variance.length === 1 ? '' : 's'} drawn differently from the recipe.`, tone: 'amber' })
  const roll = rollUpCost(build.lines, products)
  if (roll.unpriced.length) findings.push({ text: `${roll.unpriced.length} component${roll.unpriced.length === 1 ? '' : 's'} with no cost, so this run has no material value.`, tone: 'amber' })
  if (full.labour.missing) findings.push({ text: `Labour unpriced on this run — ${full.labour.missing}.`, tone: 'amber' })
  if (full.overhead.missing) findings.push({ text: `Overhead unpriced on this run — ${full.overhead.missing}.`, tone: 'amber' })
  const lots = lotTrail(build)
  if (!lots.count && build.moved && opts.batchedProducts?.some(id => build.lines.some(l => l.product_id === id))) {
    findings.push({ text: 'Its components have lots on the register, but this draw names none — the batch ledger will not know the run took them.', tone: 'amber' })
  }
  if (lots.picks.some(p => p.expiry_date && p.expiry_date < build.date)) {
    findings.push({ text: 'A lot that had passed its expiry on the run date was drawn. The register records what left the shelf; this is the one that should have been pulled first.', tone: 'red' })
  }
  const serials = serialTrail(build)
  if (!serials.count && build.moved && opts.serialledProducts?.some(id => build.lines.some(l => l.product_id === id))) {
    findings.push({ text: 'Its components are numbered units on the register, but this draw names none — the serial ledger will not know the run took them.', tone: 'amber' })
  }
  if (build.status === 'cancelled' && build.output_batch_id) {
    findings.push({ text: 'Cancelled — the finished lot it landed in has to be zeroed back off, and if units left it already, that lot is the record of it.', tone: 'amber' })
  }

  return {
    build,
    recipe,
    output: recipe ? index.get(recipe.output_product_id) : undefined,
    units: build.units,
    cost_today: roll,
    full,
    lots,
    serials,
    wanted,
    variance,
    findings,
  }
}

export function buildViews(store: BomStore, products: BomProduct[], opts: BuildViewOptions = {}): BuildView[] {
  return store.builds.map(b => buildView(b, store, products, opts))
}

export function sortBuilds(builds: Build[]): Build[] {
  return [...builds].sort((a, b) => (a.date === b.date ? b.created_at.localeCompare(a.created_at) : a.date < b.date ? 1 : -1))
}

export interface BomSummary {
  recipes: number
  active: number
  /** Recipes the shop could run right now, at least once, on the stock in hand. */
  runnable: number
  blocked: number
  units_built_fy: number
  value_built_fy: number | null
  /**
   * Labour and overhead absorbed by the runs of the year, each at the rates in force on the day
   * the run happened. Kept apart from `value_built_fy` because the bases differ — material is
   * re-read at today's prices, the rate legs at their own dates — and two bases never add.
   */
  labour_fy: number | null
  overhead_fy: number | null
  shortage_rows: number
  components_short: { name: string; unit: string; short: number }[]
  unpriced_components: string[]
}

/**
 * The four cards. `value_built_fy` is a *roll-up of runs taken in this financial year at the
 * prices carried today*, which is what the register can honestly say — it is not a valuation of
 * what the shop spent, and the page prints it with that sentence beside it.
 */
export function summarise(views: RecipeView[], store: BomStore, products: BomProduct[], today = todayISO()): BomSummary {
  const fy = fyStartYear(new Date(`${today}T00:00:00`))
  const inFy = (d: string) => {
    const y = Number(d.slice(0, 4))
    const m = Number(d.slice(5, 7))
    return (m >= 4 ? y : y - 1) === fy
  }
  // Same component drawn on several runs folds into one line before it is priced, so the figure
  // is the material the shop took in the year, not a sum of per-run readings.
  const merged = new Map<string, number>()
  for (const b of store.builds.filter(x => x.status === 'built' && inFy(x.date))) {
    for (const l of b.lines) merged.set(l.product_id, roundQty((merged.get(l.product_id) ?? 0) + l.qty))
  }
  const roll = rollUpCost([...merged].map(([product_id, qty]) => ({ product_id, qty })), products)

  // The rate legs of the year, each run priced at its own date. Null the moment one run carries
  // minutes its date has no rate for — a partial absorption figure would read as the whole one.
  const builtFy = store.builds.filter(x => x.status === 'built' && inFy(x.date))
  const rateLegFy = (which: CostLegName): number | null => {
    let total: number | null = 0
    for (const b of builtFy) {
      const recipe = store.recipes.find(r => r.id === b.recipe_id)
      if (!recipe || !(recipe.output_qty > 0)) continue
      const minutes = roundQty((which === 'labour' ? recipe.labour_minutes : recipe.overhead_minutes) * (b.units / recipe.output_qty))
      const leg = costLeg(minutes, store.rates, b.date, which)
      if (leg.value === null) return null
      total = round2(total + leg.value)
    }
    return total
  }
  const labourFy = rateLegFy('labour')
  const overheadFy = rateLegFy('overhead')

  // The same maths the shopping list runs on, so the stat card and the orders a board raises can
  // never disagree about what is short.
  const short = mergedShortages(views)
  const unpriced = [...new Set(views.flatMap(v => v.cost.roll.unpriced))].sort()

  return {
    recipes: views.length,
    active: views.filter(v => v.recipe.status === 'active').length,
    runnable: views.filter(v => v.recipe.status === 'active' && v.plan.can_run).length,
    blocked: views.filter(v => v.recipe.status === 'active' && !v.plan.can_run).length,
    units_built_fy: roundQty(store.builds.filter(b => b.status === 'built' && inFy(b.date)).reduce((s, b) => s + b.units, 0)),
    value_built_fy: roll.value,
    labour_fy: labourFy,
    overhead_fy: overheadFy,
    shortage_rows: short.length,
    components_short: short.map(s => ({ name: s.name, unit: s.unit, short: s.short })),
    unpriced_components: unpriced,
  }
}

// ── where a component goes, and what it cost ──────────────────────────────────

export interface WhereUsed {
  recipe: Recipe
  /** Drawn per finished unit of that recipe, waste included. */
  per_unit: number
}

/** The reverse BOM — the question every manufacturer asks when a supplier discontinues a part. */
export function whereUsed(productId: string, recipes: Recipe[]): WhereUsed[] {
  return recipes
    .filter(r => r.status !== 'archived')
    .map(r => {
      const c = r.components.find(x => x.product_id === productId)
      return c ? { recipe: r, per_unit: perUnitNeed(c, r) } : null
    })
    .filter((x): x is WhereUsed => x !== null)
    .sort((a, b) => b.per_unit - a.per_unit || a.recipe.name.localeCompare(b.recipe.name))
}

/** How much of one component the runs in a period drew. Materials consumption, in units. */
export function consumedOf(productId: string, builds: Build[], from: string, to: string): number {
  return roundQty(
    builds
      .filter(b => b.status === 'built' && b.date >= from && b.date <= to)
      .flatMap(b => b.lines)
      .filter(l => l.product_id === productId)
      .reduce((s, l) => s + l.qty, 0),
  )
}

// ── what the page writes to the stock ledger ─────────────────────────────────

/**
 * A movement this register asks `/inventory`'s own RPC to write. `movement_type` is deliberately
 * one of the two the manual adjustment form already uses: the schema has no `build` movement
 * type, and inventing a value there would be a schema change (ADR-013). The job reference rides
 * in `notes`, which is what makes the trail readable.
 */
export interface StockWrite {
  product_id: string
  product_name: string
  /** Signed: components out, finished units in. */
  quantity: number
  movement_type: 'adjustment_in' | 'adjustment_out'
  reference_number: string
  notes: string
}

export function movementsFor(build: Build, recipe: Recipe | undefined, products: BomProduct[]): StockWrite[] {
  const index = indexProducts(products)
  const out: StockWrite[] = []
  for (const l of build.lines) {
    const p = index.get(l.product_id)
    if (p?.track_inventory === false) continue
    out.push({
      product_id: l.product_id,
      product_name: p?.name?.trim() || l.product_id,
      quantity: -roundQty(l.qty),
      movement_type: 'adjustment_out',
      reference_number: build.ref,
      notes: `Build ${build.ref} — ${p?.name?.trim() || 'component'} drawn for ${build.units} of ${recipe?.name?.trim() || 'a recipe'}`,
    })
  }
  if (recipe) {
    const made = index.get(recipe.output_product_id)
    if (made && made.track_inventory !== false) {
      out.push({
        product_id: made.id,
        product_name: made.name?.trim() || made.id,
        quantity: roundQty(build.units),
        movement_type: 'adjustment_in',
        reference_number: build.ref,
        notes: `Build ${build.ref} — ${build.units} of ${made.name?.trim() || 'finished good'} made`,
      })
    }
  }
  return out
}

/** The reversal, which is what cancelling a built run writes. Same rule, opposite signs. */
export function reverseMovementsFor(build: Build, recipe: Recipe | undefined, products: BomProduct[]): StockWrite[] {
  return movementsFor(build, recipe, products).map(m => ({
    ...m,
    quantity: -m.quantity,
    movement_type: m.movement_type === 'adjustment_in' ? 'adjustment_out' : 'adjustment_in',
    notes: m.notes.replace(/^Build /, 'Cancel '),
  }))
}

// ── lots: which physical batch a draw came off ───────────────────────────────
//
// A quantity says how much left the shelf; a lot says *which* units left it, and for a shop that
// keeps the batch register that difference is the whole point of FEFO. So the drawdown is planned
// here and executed there: this register asks `batches.ts`'s own `allocateFefo()` for the picks —
// it never restates the rotation, so the counter and the plant cannot disagree about which lot
// goes first — and the page appends the moves through the batch register's own owners.
//
// Two refusals hold the line honest, and both are the same idea: a build may not claim units that
// no lot can produce, and a cancelled run may not put back finished units that have already left.

export interface LotRow {
  product_id: string
  name: string
  unit: string
  /** What the line says was drawn. */
  need: number
  /** False when the batch register holds no lot for this product at all — the part is not batch-tracked. */
  batched: boolean
  /** FEFO picks, in the order they were taken. Empty for an unbatched part. */
  picks: LotPick[]
  covered: number
  shortfall: number
  /** Batch numbers whose expiry date has passed — drawn when they came first, and named for it. */
  expired: string[]
  ok: boolean
}

/**
 * Splits a build's drawn lines across the lots that would have to give them up, first expiry first
 * out. Two lines for one product allocate against a **running** move list, exactly as `recordSale`
 * does, so the same units cannot be issued to both.
 *
 * `where` narrows the places to draw from — the godown filter `/inventory/godowns` hands the
 * allocator a predicate; left out, every lot in the books is a candidate.
 */
export function allocateLots(
  lines: BuildLine[],
  products: BomProduct[],
  batches: Batch[],
  moves: BatchMove[],
  today = todayISO(),
  where?: (b: Batch) => boolean,
): LotRow[] {
  const index = indexProducts(products)
  const tracked = new Set(batches.map(b => b.product_id).filter((id): id is string => Boolean(id)))
  let working = moves
  const rows: LotRow[] = []
  for (const l of lines) {
    const batched = tracked.has(l.product_id)
    const base = {
      product_id: l.product_id,
      name: nameOf(index, l.product_id) || l.product_id,
      unit: index.get(l.product_id)?.unit?.trim() || '',
      need: roundQty(l.qty),
      batched,
    }
    if (!batched) {
      rows.push({ ...base, picks: [], covered: 0, shortfall: 0, expired: [], ok: true })
      continue
    }
    const alloc = allocateFefo(batches, working, l.product_id, l.qty, where)
    const picks: LotPick[] = alloc.picks.map(p => ({
      batch_id: p.batch.id,
      batch_no: p.batch.batch_no || p.batch.id,
      qty: roundQty(p.take),
      expiry_date: p.batch.expiry_date || '',
    }))
    // Write each pick back against the working list as a negative move, so the next line of the
    // same product sees a shelf that has already given these units away. These are not stored —
    // they are the running figure the next `allocateFefo` call reads, and `plan:` says so in the id.
    working = [...working, ...picks.map(p => ({
      id: `plan:${p.batch_id}`,
      batch_id: p.batch_id,
      date: today,
      qty: -p.qty,
      kind: 'adjust' as const,
      doc_ref: '',
      note: '',
      created_at: new Date().toISOString(),
    }))]
    rows.push({
      ...base,
      picks,
      covered: roundQty(alloc.covered),
      shortfall: roundQty(alloc.shortfall),
      expired: picks.filter(p => p.expiry_date && p.expiry_date < today).map(p => p.batch_no),
      ok: alloc.shortfall <= 0,
    })
  }
  return rows
}

/** One move this register asks the batch register to append. Mirrors `StockWrite` in shape. */
export interface BatchWrite {
  batch_id: string
  /** The lot's own number, so the note reads as paper rather than as a uuid. */
  batch_no: string
  product_id: string
  /** Signed: negative leaves the lot, positive returns to it. */
  qty: number
  date: string
  /** Always `adjust` — the batch register has three kinds and none of them is `issue`. A fourth
   *  would be a shape change, and an unknown kind would be read back as `adjust` anyway. */
  kind: 'adjust'
  /** The job number, riding as `doc_ref` the way an invoice number rides on a sale move. */
  doc_ref: string
  note: string
}

export function lotWritesFor(build: Build, products: BomProduct[]): BatchWrite[] {
  const index = indexProducts(products)
  const out: BatchWrite[] = []
  for (const l of build.lines) {
    for (const p of l.lots || []) {
      out.push({
        batch_id: p.batch_id,
        batch_no: p.batch_no,
        product_id: l.product_id,
        qty: -roundQty(p.qty),
        date: build.date,
        kind: 'adjust',
        doc_ref: build.ref,
        note: `Build ${build.ref} — ${nameOf(index, l.product_id) || 'component'} ${roundQty(p.qty)} issued from lot ${p.batch_no || 'unnamed'}`,
      })
    }
  }
  return out
}

/** The reversal: the drawn units go back to the lots they came from. Same rule, opposite signs. */
export function reverseLotWritesFor(build: Build, products: BomProduct[]): BatchWrite[] {
  return lotWritesFor(build, products).map(w => ({
    ...w,
    qty: -w.qty,
    // The paper keeps its shape — job, part, lot — and only the verb turns round, because a move
    // that puts units back reads as a return and not as a second issue.
    note: w.note.replace(/^Build /, 'Cancel ').replace(' issued from lot ', ' went back to lot '),
  }))
}

/** What a run issued, as one readable line for the log and the flash message. */
export function lotTrail(build: Build): { count: number; picks: LotPick[]; lines: string[] } {
  const picks = build.lines.flatMap(l => l.lots || [])
  return {
    count: picks.length,
    picks,
    lines: build.lines
      .filter(l => (l.lots || []).length)
      .map(l => l.lots!.map(p => `${p.batch_no || 'unnamed lot'} ${roundQty(p.qty)}`).join(' + ')),
  }
}

/**
 * The lot the finished units land in — the batch register's row, described here so the plant's
 * decision (this run made this lot, on this day, at this cost reading) is in one place. The page
 * hands it to `newBatch()` and `upsertBatch()`; nothing here writes.
 *
 * `expiry_date` is deliberately empty: this register knows the day the run happened, not the shelf
 * life of the thing it made, and inventing an expiry would be a fabricated date on a lot the
 * expiry clock is supposed to be trusted for. The batch page can date it later.
 *
 * `godown_id` is empty for the same reason — a build names no place. Unplaced reads as Main
 * (godowns.ts), and the page says so rather than guessing where the run happened.
 */
export interface ProducedLot {
  product_id: string
  product_name: string
  sku: string
  unit: string
  batch_no: string
  mfg_date: string
  expiry_date: string
  qty: number
  /** ₹ per unit as the run read it, or 0 with a note saying nobody recorded one — `Batch.cost` has no null. */
  cost: number
  bill_ref: string
  notes: string
  godown_id: string
}

export function producedLot(
  build: Build,
  recipe: Recipe,
  product: BomProduct | undefined,
  perUnitCost: number | null,
): ProducedLot {
  const cost = perUnitCost === null || !Number.isFinite(perUnitCost) || perUnitCost <= 0
    ? 0
    : round2(perUnitCost)
  const where = product?.name?.trim() || recipe.output_product_id
  return {
    product_id: product?.id || recipe.output_product_id,
    product_name: where,
    sku: product?.sku?.trim() || '',
    unit: product?.unit?.trim() || '',
    // The job number *is* the batch number of the run: one build, one lot, and the trace a shop
    // actually asks for ("which batch was this?") answers with the run that made it.
    batch_no: build.ref,
    mfg_date: build.date,
    expiry_date: '',
    qty: roundQty(build.units),
    cost,
    bill_ref: build.ref,
    notes: [
      `Made by build ${build.ref} — recipe ${recipe.name?.trim() || 'unnamed'} (${roundQty(recipe.output_qty)} per run).`,
      cost > 0
        ? `Costed ${round2(cost)}/unit from the catalogue and the shop rates in force on ${build.date}; a reading, not a ledger posting.`
        : `No cost recorded — a component price or a shop rate was missing on ${build.date}. Enter it on the batch page when it is known.`,
      'No expiry date and no godown: the run recorded neither, so this lot stands unplaced (Main) until the shop says otherwise.',
    ].join(' '),
    godown_id: '',
  }
}

/** What the finished lot holds that this run did not put there — the sale or adjustment to check before a cancel. */
export function drawnElsewhereFrom(batchId: string, buildRef: string, moves: BatchMove[]): BatchMove[] {
  return moves.filter(m => m.batch_id === batchId && m.qty < 0 && m.doc_ref !== buildRef)
}

/**
 * A stored draw has to be one the batch register can honour. Each refusal names the missing word
 * the way the Tally planner does, because "it will not fit" is not something a shop can act on.
 */
export function validateLotIssues(build: Build, batches: Batch[], products: BomProduct[]): string[] {
  const index = indexProducts(products)
  const byId = new Map(batches.map(b => [b.id, b]))
  const problems: string[] = []
  for (const l of build.lines) {
    const picks = l.lots || []
    if (!picks.length) continue
    const part = nameOf(index, l.product_id) || 'A component'
    let sum = 0
    for (const p of picks) {
      const lot = byId.get(p.batch_id)
      if (!lot) {
        problems.push(`${part} names lot ${p.batch_no || p.batch_id}, which is not on the batch register.`)
        continue
      }
      if (lot.product_id && lot.product_id !== l.product_id) {
        problems.push(`Lot ${lot.batch_no || p.batch_id} belongs to ${lot.product_name || 'another product'}, not to ${part} — a draw cannot name someone else's batch.`)
        continue
      }
      sum += p.qty
    }
    const diff = roundQty(roundQty(sum) - roundQty(l.qty))
    if (Math.abs(diff) > 0.0000001) {
      problems.push(`The lots on ${part} cover ${roundQty(sum)} of the ${roundQty(l.qty)} drawn — ${diff > 0 ? 'more than was drawn.' : 'the rest names no lot. Issue the whole draw or none of it.'}`)
    }
  }
  return problems
}

// ── serials: which numbered units a draw took ───────────────────────────────
//
// A lot says which batch a quantity came off; a serial says which *unit*. For the parts a shop
// keeps numbers for — a motor, a board, a bench — that is the trace after-sales actually asks
// for ("which unit is under this job?"), and it belongs in the same envelope. The draw is planned
// here from the serial register's own shelf reading (`shelfUnitsOf` — the register never restates
// which unit comes first), and the events are appended there by the register's own owners,
// exactly as the lot moves are. The two refusals are the lot refusals in unit terms: the units
// named must cover the whole draw, and a cancel may not write over a unit that has moved on.

export interface SerialRow {
  product_id: string
  name: string
  unit: string
  /** What the line says was drawn. */
  need: number
  /** Units of this product the register holds in *any* status — what makes a part one to number. */
  tracked: boolean
  /** What the shelf holds today, oldest received first — the candidates for the draw. */
  on_shelf: SerialUnit[]
  /** The oldest units, up to the draw — the proposal, not a decision. Empty for an untracked part. */
  picks: SerialPick[]
  /** True when the draw is a whole number of units — a fractional draw cannot name whole units. */
  whole: boolean
  shortfall: number
  ok: boolean
}

/**
 * Proposes which units a draw would take: the ones longest on the shelf first, one pick per unit.
 * A part the register holds no unit of reads as untracked — `on_shelf: []`, `ok: true` — the same
 * quiet `allocateLots` gives an unbatched component: nothing to name is not a shortfall.
 */
export function allocateSerials(
  lines: BuildLine[],
  products: BomProduct[],
  units: SerialUnit[],
  events: SerialEvent[],
  today = todayISO(),
): SerialRow[] {
  const index = indexProducts(products)
  const tracked = new Set(units.map(u => u.product_id).filter((id): id is string => Boolean(id)))
  return lines.map(l => {
    const need = roundQty(l.qty)
    const whole = Number.isInteger(need)
    const on_shelf = shelfUnitsOf(units, events, l.product_id, today)
    const base = {
      product_id: l.product_id,
      name: nameOf(index, l.product_id) || l.product_id,
      unit: index.get(l.product_id)?.unit?.trim() || '',
      need,
      tracked: tracked.has(l.product_id),
      on_shelf,
      whole,
    }
    if (!base.tracked) return { ...base, picks: [], shortfall: 0, ok: true }
    const take = whole ? Math.min(Math.trunc(need), on_shelf.length) : 0
    const picks = on_shelf.slice(0, take).map(u => ({ serial_id: u.id, serial_no: u.serial_no }))
    return { ...base, picks, shortfall: roundQty(need - picks.length), ok: whole && picks.length >= need }
  })
}

/** One serial event this register asks the serial register to append. Mirrors `BatchWrite` in shape. */
export interface SerialWrite {
  serial_id: string
  /** The number as printed, so the note reads as paper rather than as a uuid. */
  serial_no: string
  product_id: string
  date: string
  /** `issued` is the draw; `restocked` is the cancel putting the unit back — the register's own kinds. */
  kind: 'issued' | 'restocked'
  /** The job number, riding as `doc_ref` the way an invoice number rides on a sale event. */
  doc_ref: string
  note: string
}

export function serialWritesFor(build: Build, products: BomProduct[]): SerialWrite[] {
  const index = indexProducts(products)
  const out: SerialWrite[] = []
  for (const l of build.lines) {
    for (const p of l.serials || []) {
      out.push({
        serial_id: p.serial_id,
        serial_no: p.serial_no,
        product_id: l.product_id,
        date: build.date,
        kind: 'issued',
        doc_ref: build.ref,
        note: `Build ${build.ref} — ${nameOf(index, l.product_id) || 'component'} ${p.serial_no || 'unnamed unit'} issued into the run`,
      })
    }
  }
  return out
}

/** The reversal: the issued units go back on the shelf. Same rule, the verb turns round. */
export function reverseSerialWritesFor(build: Build, products: BomProduct[]): SerialWrite[] {
  return serialWritesFor(build, products).map(w => ({
    ...w,
    kind: 'restocked' as const,
    // The paper keeps its shape — job, part, unit — and only the verb turns round, because a
    // unit going back reads as a return and not as a second issue.
    note: w.note.replace(/^Build /, 'Cancel ').replace(' issued into the run', ' went back on the shelf'),
  }))
}

/** What a run issued, as readable lines for the log and the flash message. */
export function serialTrail(build: Build): { count: number; picks: SerialPick[]; lines: string[] } {
  const picks = build.lines.flatMap(l => l.serials || [])
  return {
    count: picks.length,
    picks,
    lines: build.lines
      .filter(l => (l.serials || []).length)
      .map(l => l.serials!.map(p => p.serial_no || 'unnamed unit').join(', ')),
  }
}

/** The register's verdict on one unit as it stands now — never the stored draw's word for it. */
function currentStatus(unit: SerialUnit, events: SerialEvent[], today: string): SerialStatus {
  return viewOf(unit, events, today).status
}

/**
 * A stored draw's units have to be the serial register's own rows, held now. Each refusal names
 * the unit, the way the lot refusals name the lot, because "it does not fit" is not something a
 * shop can act on. Run before recording, when every named unit should still be in stock.
 */
export function validateSerialIssues(build: Build, units: SerialUnit[], events: SerialEvent[], products: BomProduct[]): string[] {
  const index = indexProducts(products)
  const byId = new Map(units.map(u => [u.id, u]))
  const named = new Set<string>()
  const problems: string[] = []
  for (const l of build.lines) {
    const picks = l.serials || []
    if (!picks.length) continue
    const part = nameOf(index, l.product_id) || 'A component'
    if (!Number.isInteger(roundQty(l.qty))) {
      problems.push(`${part} draws ${roundQty(l.qty)} but names whole units — a fractional draw cannot name units. Issue the whole draw or none of it.`)
      continue
    }
    for (const p of picks) {
      const u = byId.get(p.serial_id)
      if (!u) {
        problems.push(`${part} names unit ${p.serial_no || p.serial_id}, which is not on the serial register.`)
        continue
      }
      if (named.has(p.serial_id)) {
        problems.push(`Unit ${p.serial_no || p.serial_id} is named twice on this run — one physical unit cannot go in twice.`)
        continue
      }
      named.add(p.serial_id)
      if (u.product_id !== l.product_id) {
        problems.push(`Unit ${p.serial_no || p.serial_id} is booked against ${u.product_name || 'another item'}, not against ${part} — a draw cannot take someone else's unit.`)
        continue
      }
      const status = currentStatus(u, events, build.date)
      if (status !== 'in_stock') {
        problems.push(`Unit ${p.serial_no || p.serial_id} is ${SERIAL_STATUS_LABEL[status].toLowerCase()} — not on the shelf, so the draw cannot take it.`)
      }
    }
    const count = picks.length
    if (count !== roundQty(l.qty)) {
      problems.push(`The units on ${part} cover ${count} of the ${roundQty(l.qty)} drawn — ${count > l.qty ? 'more than was drawn.' : 'the rest names no unit. Issue the whole draw or none of it.'}`)
    }
  }
  return problems
}

/**
 * The units this run issued that have moved on since — scrapped, or put back by hand. A cancel
 * may not write over that history: restocking a unit that has been written off would resurrect
 * it, and restocking one that already stands on the shelf would say the cancel did what a hand
 * did. Either way the shop decides; this register refuses and names the unit.
 */
export function serialMovedOn(
  build: Build,
  units: SerialUnit[],
  events: SerialEvent[],
  today = todayISO(),
): { serial_id: string; serial_no: string; status: SerialStatus }[] {
  const byId = new Map(units.map(u => [u.id, u]))
  const out: { serial_id: string; serial_no: string; status: SerialStatus }[] = []
  for (const l of build.lines) {
    for (const p of l.serials || []) {
      const u = byId.get(p.serial_id)
      if (!u) continue
      const status = currentStatus(u, events, today)
      if (status !== 'issued') out.push({ serial_id: p.serial_id, serial_no: p.serial_no || u.serial_no, status })
    }
  }
  return out
}

// ── demand that already exists: the orders the shop has taken ─────────────────

export interface DemandLine {
  product_id: string
  quantity: number
}

export interface DemandRow {
  product_id: string
  name: string
  unit: string
  /** Units committed on the documents handed in. */
  demanded: number
  /** Units made on runs built since — the shop may already have it on the shelf. */
  made: number
  /** Still to make: demand less what is already built, floored at zero — over-building is not a negative plan. */
  to_build: number
  recipe?: Recipe
  /** How many it *can* build now, and what is holding it up. */
  buildable: number
  limited_by: string
}

/**
 * Order-to-shop: the open demand for finished goods that have a recipe. Demand arrives as plain
 * lines so this module does not depend on the order register — the page hands it the lines of the
 * open sales orders it already loads (R2-14), which is where the two features meet.
 */
export function demandAgainstRecipes(
  demand: DemandLine[],
  recipes: Recipe[],
  builds: Build[],
  products: BomProduct[],
): DemandRow[] {
  const index = indexProducts(products)
  const active = new Map<string, Recipe>()
  for (const r of recipes) {
    if (r.status !== 'active') continue
    // Two live recipes for one product: the first by name is used and the row says which.
    if (!active.has(r.output_product_id)) active.set(r.output_product_id, r)
  }
  const byProduct = new Map<string, number>()
  for (const d of demand) {
    if (!(d.quantity > 0) || !d.product_id) continue
    byProduct.set(d.product_id, roundQty((byProduct.get(d.product_id) ?? 0) + d.quantity))
  }
  const rows: DemandRow[] = []
  for (const [product_id, demanded] of byProduct) {
    const recipe = active.get(product_id)
    if (!recipe) continue
    const p = index.get(product_id)
    const made = roundQty(
      builds.filter(b => b.status === 'built' && b.recipe_id === recipe.id).reduce((s, b) => s + b.units, 0),
    )
    const plan = planBuild(recipe, Math.max(0, demanded - made), products, recipes)
    rows.push({
      product_id,
      name: p?.name?.trim() || product_id,
      unit: p?.unit?.trim() || '',
      demanded,
      made,
      to_build: roundQty(Math.max(0, demanded - made)),
      recipe,
      buildable: plan.buildable_units,
      limited_by: plan.limited_by,
    })
  }
  return rows.sort((a, b) => b.to_build - a.to_build || a.name.localeCompare(b.name))
}

// ── the shopping list becomes paper ───────────────────────────────────────────

/**
 * One shortage per component, whatever number of recipes are short of it. `summarise` draws its
 * stat card from this and `shoppingPlan` raises its orders from it, so the number a shop sees on
 * the board and the number that reaches a vendor can never be two different sums.
 */
export interface Shortage {
  product_id: string
  name: string
  unit: string
  short: number
  /** Every recipe that cannot run until this arrives — the reason a buyer quotes on the phone. */
  for_recipes: string[]
}

export function mergedShortages(views: RecipeView[]): Shortage[] {
  const map = new Map<string, Shortage>()
  for (const v of views) {
    for (const s of v.plan.shortages) {
      const prev = map.get(s.product_id)
      const recipe = v.recipe.name?.trim() || 'unnamed recipe'
      const waiting = prev?.for_recipes ?? []
      map.set(s.product_id, {
        product_id: s.product_id,
        name: s.name,
        unit: s.unit,
        short: roundQty((prev?.short ?? 0) + s.short),
        for_recipes: waiting.includes(recipe) ? waiting : [...waiting, recipe],
      })
    }
  }
  return [...map.values()].sort((a, b) => b.short - a.short || a.name.localeCompare(b.name))
}

/**
 * A purchase line as this register needs it: who sold it, when, at what rate. The page reads it
 * out of the bills it already trusts (`purchase_bills` joined to `purchase_bill_items`); nothing
 * here is stored, so a corrected bill corrects the next order raised from it.
 */
export interface SupplyReading {
  product_id: string
  vendor_id?: string | null
  vendor_name?: string | null
  rate?: number | null
  date?: string | null
}

/** A vendor the shop can actually write an order to — the live rows off the vendor master. */
export interface SupplierParty {
  vendor_id: string
  vendor_name: string
  gstin?: string | null
  state_code?: string | null
  address?: string | null
}

export interface BuyLine {
  product_id: string
  name: string
  unit: string
  hsn_sac: string
  qty: number
  /** `null` when neither a bill nor the product master carries a price — the draft then says so. */
  rate: number | null
  rate_source: 'last bill' | 'product master' | null
  for_recipes: string[]
}

export interface BuyOrder {
  vendor_id: string
  vendor_name: string
  gstin: string
  state_code: string
  address: string
  lines: BuyLine[]
  /**
   * `null` the moment one line is unpriced. A sum of the priced lines would read as the value of
   * the order, and an order with a hole in it is not worth that number — same two-bases rule as
   * the cost legs: an absent figure prints a dash, a present one prints the figure.
   */
  value: number | null
  /** Names of the lines with no price, so the card can say which to go and set. */
  unpriced: string[]
}

export interface ShoppingPlan {
  /** One draft purchase order per vendor, biggest first. */
  orders: BuyOrder[]
  /** Short components nobody can be ordered from yet — with the reason, printed not hidden. */
  unrouted: { line: BuyLine; why: string }[]
}

/** The newest line that names a supplier; ties go to the last one read, as `/inventory/reorder` does. */
function latestSupplier(supply: SupplyReading[]): Map<string, SupplyReading> {
  const out = new Map<string, SupplyReading>()
  for (const s of supply) {
    if (!s.product_id || !s.vendor_name?.trim()) continue
    const seen = out.get(s.product_id)
    if (!seen || (s.date || '') >= (seen.date || '')) out.set(s.product_id, s)
  }
  return out
}

/**
 * What the board cannot cover, arranged as the paper that fixes it: the shortage list grouped by
 * the vendor each component last came from, at the rate the shop last paid for it (or the price
 * the master carries when no bill names one), each line saying which recipes are waiting.
 *
 * A line is only routed when that vendor is still a vendor the shop trades with *and* the vendor
 * card carries a state — without one there is no place of supply, and the order register would
 * refuse the draft it would otherwise raise. A bill whose supplier has since left the master goes
 * to `unrouted` with its reason rather than raising an order addressed to nobody. Nothing here is
 * written: `orderNote` and the order register's own `appendDraft` do that, through the numbering
 * the register already owns.
 */
export function shoppingPlan(
  views: RecipeView[],
  products: BomProduct[],
  supply: SupplyReading[],
  parties: SupplierParty[] = [],
): ShoppingPlan {
  const index = indexProducts(products)
  const last = latestSupplier(supply)
  const byId = new Map(parties.map(p => [p.vendor_id, p]))
  const byName = new Map(parties.map(p => [p.vendor_name.trim().toLowerCase(), p]))

  const orders = new Map<string, BuyOrder>()
  const unrouted: ShoppingPlan['unrouted'] = []

  for (const s of mergedShortages(views)) {
    const p = index.get(s.product_id)
    const src = last.get(s.product_id) ?? null
    const billRate = num(src?.rate) > 0 ? round2(num(src?.rate)) : null
    const masterRate = num(p?.purchase_price) > 0 ? round2(num(p?.purchase_price)) : null
    const rate = billRate ?? masterRate
    const line: BuyLine = {
      product_id: s.product_id,
      name: s.name,
      unit: s.unit,
      hsn_sac: str(p?.hsn_sac),
      // A shortage row is what the shelf lacks for one run of every recipe waiting on it; ordering
      // the sum is the honest minimum, and the draft is editable — the page never hides that.
      qty: s.short,
      rate,
      rate_source: rate === null ? null : billRate !== null ? 'last bill' : 'product master',
      for_recipes: s.for_recipes,
    }

    let party: SupplierParty | null = null
    if (src?.vendor_id) party = byId.get(src.vendor_id) ?? null
    if (!party && src?.vendor_name) party = byName.get(src.vendor_name.trim().toLowerCase()) ?? null
    if (!src) {
      unrouted.push({ line, why: 'No purchase bill has ever named a supplier for it' })
      continue
    }
    if (!party) {
      unrouted.push({ line, why: `The bill that supplied it names ${src.vendor_name}, who is no longer on your vendor list` })
      continue
    }
    // The order register will not save a document without a place of supply, and a vendor card with
    // no state cannot give one. Refusing here is honest: the line stays on the board with the
    // reason, instead of raising a draft that the register would reject on its own page.
    if (!str(party.state_code).trim()) {
      unrouted.push({ line, why: `${party.vendor_name} has no state on the vendor card, so there is no place of supply to write` })
      continue
    }

    const order = orders.get(party.vendor_id) ?? {
      vendor_id: party.vendor_id,
      vendor_name: party.vendor_name,
      gstin: str(party.gstin),
      state_code: str(party.state_code),
      address: str(party.address),
      lines: [],
      value: null,
      unpriced: [],
    }
    order.lines.push(line)
    if (line.rate === null) order.unpriced.push(line.name)
    orders.set(party.vendor_id, order)
  }

  return {
    orders: [...orders.values()].map(o => {
      const lines = [...o.lines].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name))
      // One unpriced line and the order has no value: a sum of the priced lines would read as
      // *the* figure, which is the claim this file refuses to make from partial data.
      const value = lines.some(l => l.rate === null)
        ? null
        : round2(lines.reduce((s, l) => s + (l.qty * (l.rate ?? 0)), 0))
      return { ...o, lines, value }
    }).sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.vendor_name.localeCompare(b.vendor_name)),
    unrouted: unrouted.sort((a, b) => b.line.qty - a.line.qty || a.line.name.localeCompare(b.line.name)),
  }
}

/** The sentence that goes on the draft: why these lines, and what still has no price. */
export function orderNote(order: BuyOrder, today = todayISO()): string {
  const parts = order.lines.map(l =>
    `${l.name} ${roundQty(l.qty)}${l.unit ? ` ${l.unit}` : ''} — for ${l.for_recipes.join(', ') || 'the recipe book'}`)
  const head = `Raised from the recipe board on ${today}: ${parts.join('; ')}.`
  return order.unpriced.length
    ? `${head} No price recorded for ${order.unpriced.join(', ')} — the draft carries 0 until you set it.`
    : head
}

export const SHOPPING_CSV_HEADERS = [
  'Vendor', 'Component', 'Unit', 'To order', 'Rate', 'Rate read from', 'Est. value', 'Recipes waiting', 'Why it cannot be ordered',
]

export function shoppingCsvRows(plan: ShoppingPlan): (string | number)[][] {
  const rows: (string | number)[][] = []
  for (const o of plan.orders) {
    for (const l of o.lines) {
      rows.push([
        o.vendor_name, l.name, l.unit, l.qty, l.rate ?? '', l.rate_source ?? '',
        l.rate === null ? '' : round2(l.qty * l.rate), l.for_recipes.join(' | '), '',
      ])
    }
  }
  for (const u of plan.unrouted) {
    rows.push(['', u.line.name, u.line.unit, u.line.qty, u.line.rate ?? '', u.line.rate_source ?? '', '', u.line.for_recipes.join(' | '), u.why])
  }
  return rows
}

// ── CSV ───────────────────────────────────────────────────────────────────────

export const RECIPE_CSV_HEADERS = [
  'Recipe',
  'Makes',
  'HSN/SAC of output',
  'Units per run',
  'Components',
  'Material cost / unit',
  'Labour / unit',
  'Overhead / unit',
  'Cost / unit (full)',
  'Uncosted',
  'Selling price',
  'Margin / unit',
  'Buildable now',
  'Held up by',
  'Status',
  'Runs built',
  'Units built',
  'Last build',
]

export function recipeCsvRows(views: RecipeView[]): (string | number)[][] {
  return views.map(v => [
    v.recipe.name,
    v.output?.name || v.recipe.output_product_id,
    str(v.output?.hsn_sac),
    v.recipe.output_qty,
    v.component_count,
    v.cost.per_unit ?? '',
    v.full.labour.value === null ? '' : round2(v.full.labour.value / (v.recipe.output_qty || 1)),
    v.full.overhead.value === null ? '' : round2(v.full.overhead.value / (v.recipe.output_qty || 1)),
    v.full.per_unit ?? '',
    v.full.missing.join(' | '),
    num(v.output?.selling_price) || '',
    v.margin_per_unit ?? '',
    v.plan.can_run ? Math.min(v.plan.buildable_units, MAX_UNITS_PER_BUILD) : v.plan.buildable_units,
    v.plan.limited_by,
    RECIPE_STATUS_META[v.recipe.status].label,
    v.build_count,
    v.units_built,
    v.last_built,
  ])
}

export const BUILD_CSV_HEADERS = ['Job', 'Date', 'Recipe', 'Finished product', 'Units', 'Status', 'Movements written', 'Materials', 'Lots drawn', 'Units drawn', 'Cost today (full)', 'Uncosted', 'Note']

export function buildCsvRows(views: BuildView[], products: BomProduct[]): (string | number)[][] {
  const index = indexProducts(products)
  return views.map(v => [
    v.build.ref,
    v.build.date,
    v.recipe?.name || '',
    v.output?.name || '',
    v.build.units,
    BUILD_STATUS_META[v.build.status].label,
    v.build.moved ? 'Yes' : 'No',
    v.build.lines.map(l => `${nameOf(index, l.product_id) || l.product_id} ${l.qty}`).join(' | '),
    // The physical lots the draw named, so an exported run reads as what left which shelf. A run
    // before R2-29, or a plan that never allocated, exports an empty cell — not a zero.
    v.lots.lines.join(' | '),
    // The numbered units the draw took, on the same rule — a run before R2-35 exports an empty cell.
    v.serials.lines.join(' | '),
    v.full.value ?? '',
    v.full.missing.join(' | '),
    v.build.notes,
  ])
}

export const PLAN_CSV_HEADERS = ['Recipe', 'Component', 'Unit', 'Needed for', 'Need', 'On hand', 'Short', 'Level', 'Made or bought', 'State']

export function planCsvRows(views: RecipeView[]): (string | number)[][] {
  const rows: (string | number)[][] = []
  for (const v of views) {
    for (const r of v.plan.rows) {
      rows.push([
        v.recipe.name,
        r.name,
        r.unit,
        r.for_units,
        r.need,
        r.on_hand,
        r.short,
        r.level,
        r.made_by_recipe ? 'Made here' : 'Bought in',
        r.tone === 'short' ? 'Short' : r.tone === 'unknown' ? 'Not stock-tracked' : 'Enough',
      ])
    }
  }
  return rows
}
