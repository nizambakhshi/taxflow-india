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
// account, no batch or serial issuance into a build (a build draws quantities; lots and units are
// drawn at the counter by `/inventory/batches` and `/inventory/serials`), no scrap *sale* —
// offcuts sold are an ordinary invoice — and no back-flush. The ERP habit called back-flushing
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

import { newId, todayISO } from '@/lib/batches'
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

export interface BuildLine {
  product_id: string
  /** What the shop actually drew. Stored, because the drum said what it said. */
  qty: number
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

function parseLine(raw: unknown): BuildLine | null {
  if (!raw || typeof raw !== 'object') return null
  const l = raw as Record<string, unknown>
  if (!str(l.product_id) || !(num(l.qty) > 0)) return null
  return { product_id: str(l.product_id), qty: roundQty(num(l.qty)) }
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
  /** What the recipe asked for, and what was drawn — the wastage the register exists to show. */
  wanted: BuildLine[]
  variance: { product_id: string; name: string; wanted: number; drawn: number; diff: number }[]
  findings: Finding[]
}

export function buildView(build: Build, store: BomStore, products: BomProduct[]): BuildView {
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

  return {
    build,
    recipe,
    output: recipe ? index.get(recipe.output_product_id) : undefined,
    units: build.units,
    cost_today: roll,
    full,
    wanted,
    variance,
    findings,
  }
}

export function buildViews(store: BomStore, products: BomProduct[]): BuildView[] {
  return store.builds.map(b => buildView(b, store, products))
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

  const shortageMap = new Map<string, { name: string; unit: string; short: number }>()
  for (const v of views) {
    for (const s of v.plan.shortages) {
      const prev = shortageMap.get(s.product_id)
      shortageMap.set(s.product_id, { name: s.name, unit: s.unit, short: roundQty((prev?.short ?? 0) + s.short) })
    }
  }
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
    shortage_rows: shortageMap.size,
    components_short: [...shortageMap.values()].sort((a, b) => b.short - a.short || a.name.localeCompare(b.name)),
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

export const BUILD_CSV_HEADERS = ['Job', 'Date', 'Recipe', 'Finished product', 'Units', 'Status', 'Movements written', 'Materials', 'Cost today (full)', 'Uncosted', 'Note']

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
