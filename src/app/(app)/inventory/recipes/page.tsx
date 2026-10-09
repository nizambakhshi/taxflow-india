'use client'

// Recipes & builds — what a thing is made of, and what making it did to the shelf.
//
// The engine (`src/lib/bom.ts`) owns the model: a recipe that stores quantities and re-reads every
// rupee from the catalogue, a build that records what was *drawn* rather than what the recipe hoped
// for, a material plan that answers "what can I not make today, and because of which part". This
// page is the register: the recipe book, the run log, the materials board, and the reverse lookup
// that tells you where a component goes.
//
// Three things the screen is careful about, because the library is:
//  * **Rupees are read, never typed.** The cost on a recipe card is rolled up from the components'
//    own cost in `products` — the same field `/accounting` values stock at — so the card and the
//    balance sheet cannot drift. A missing price prints as a gap, not as ₹0.
//  * **Stock moves through the one RPC that may move it.** Recording a build writes the same
//    `adjustment_out` / `adjustment_in` movements the manual adjustment form at `/inventory` writes,
//    with the job number carried in the note. If a write fails half way the rows already applied are
//    reversed and the run stays a plan: the register never claims a fact the ledger does not hold.
//  * **A build is not a supply.** Nothing here touches a return; the tax happens when the finished
//    good is sold. The page says so on the footer, and sends materials handed to somebody else to
//    `/gst/job-work`, where the section 143 clock lives.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN } from '@/lib/format'
import { fmtQty } from '@/lib/reorder'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import { fyLabel, fyStartYear } from '@/lib/targets'
import { loadStore, type FlowDoc } from '@/lib/orderflow'
import {
  BUILD_CSV_HEADERS, BUILD_STATUS_META, MAX_MINUTES_PER_RUN, MAX_UNITS_PER_BUILD, PLAN_CSV_HEADERS,
  RECIPE_CSV_HEADERS, RECIPE_STATUSES, RECIPE_STATUS_META, allocateRef, buildCsvRows, buildViews,
  cancelBuild, consumedOf, demandAgainstRecipes, findCycle, fmtMinutes, indexProducts, loadBom,
  movementsFor, newBuild, newComponent, newRate, newRecipe, peekRef, perUnitNeed, planBuild, planCsvRows,
  rateFor, recipeCsvRows, recipeView, recipeViews, removeBuild, removeRate, removeRecipe, requirement,
  reverseMovementsFor, saveBom, sortBuilds, sortRecipeViews, stampCost, summarise, upsertBuild,
  upsertRate, upsertRecipe, validateBuild, validateRate, validateRecipe, whereUsed,
  type BomProduct, type BomStore, type Build, type BuildView, type CostRate, type PlanRow,
  type Recipe, type RecipeView, type StockWrite,
} from '@/lib/bom'
import {
  Badge, Button, Card, EmptyState, PageHeader, ProgressBar, SearchInput, Segmented, StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'

type Tab = 'recipes' | 'builds' | 'materials' | 'whereused' | 'rates'
type RecipeFilter = 'all' | 'active' | 'draft' | 'blocked' | 'archived'
type BuildFilter = 'all' | 'planned' | 'built' | 'cancelled'
type Period = 'this_fy' | 'prev_fy' | 'all'

const TABS: { value: string; label: string }[] = [
  { value: 'recipes', label: 'Recipe book' },
  { value: 'builds', label: 'Build log' },
  { value: 'materials', label: 'Materials board' },
  { value: 'whereused', label: 'Where used' },
  { value: 'rates', label: 'Shop rates' },
]

const RECIPE_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'In use' },
  { value: 'blocked', label: 'Cannot run' },
  { value: 'draft', label: 'Drafts' },
  { value: 'archived', label: 'Archived' },
]

const BUILD_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All runs' },
  { value: 'planned', label: 'Planned' },
  { value: 'built', label: 'Built' },
  { value: 'cancelled', label: 'Cancelled' },
]

const PERIODS: { value: Period; label: string }[] = [
  { value: 'this_fy', label: 'This FY' },
  { value: 'prev_fy', label: 'Last FY' },
  { value: 'all', label: 'All time' },
]

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const money = (n: number) => `₹${inr.format(Math.round(Number(n) || 0))}`
/** A cost that is not there prints as a dash, never as ₹0 — ₹0 is a claim, a dash is an absence. */
const price = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? money(n) : '—')
const percent = (n: number | null | undefined) => (typeof n === 'number' ? `${n.toFixed(Math.abs(n) >= 10 ? 0 : 1)}%` : '—')

function windowOf(period: Period, today: string): { from: string; to: string } {
  if (period === 'all') return { from: '0000-01-01', to: '9999-12-31' }
  const fy = fyStartYear(new Date(`${today}T00:00:00`)) - (period === 'prev_fy' ? 1 : 0)
  return { from: `${fy}-04-01`, to: `${fy + 1}-03-31` }
}

/** The board's rows, shallowest first — a sub-assembly's parts read as hanging under it. */
function rowsOf(v?: RecipeView): PlanRow[] {
  if (!v) return []
  return [...v.plan.rows].sort((a, b) => a.level - b.level || b.short - a.short || a.name.localeCompare(b.name))
}

function matchesFilter(v: RecipeView, filter: RecipeFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'blocked') return v.recipe.status === 'active' && !v.plan.can_run
  return v.recipe.status === filter
}

interface RecipeEditorState { recipe: Recipe; isNew: boolean }
interface BuildDraft {
  id: string
  recipeId: string
  units: string
  date: string
  notes: string
  /** Typed as text: an empty box must not become a draw of zero. */
  lines: { product_id: string; qty: string }[]
}

function RecipesPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [userId, setUserId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [store, setStore] = useState<BomStore>({ version: 1, updatedAt: '', orgId: '', recipes: [], builds: [], rates: [], seq: {} })
  const [products, setProducts] = useState<BomProduct[]>([])
  const [orders, setOrders] = useState<FlowDoc[]>([])

  const [tab, setTab] = useState<Tab>('recipes')
  const [search, setSearch] = useSearchDeepLink()
  const [recipeFilter, setRecipeFilter] = useState<RecipeFilter>('all')
  const [buildFilter, setBuildFilter] = useState<BuildFilter>('all')
  const [period, setPeriod] = useState<Period>('this_fy')
  const [openRecipe, setOpenRecipe] = useState('')
  const [planRecipe, setPlanRecipe] = useState('all')
  const [componentId, setComponentId] = useState('')
  const [busy, setBusy] = useState('')

  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)
  const [editor, setEditor] = useState<RecipeEditorState | null>(null)
  const [editorError, setEditorError] = useState('')
  const [draft, setDraft] = useState<BuildDraft | null>(null)
  const [draftError, setDraftError] = useState('')
  const [rateEdit, setRateEdit] = useState<CostRate | null>(null)
  const [rateError, setRateError] = useState('')

  async function loadProducts(oid: string) {
    // Every product, not only the stock-tracked ones: a recipe's output may be a service line and a
    // component's cost is read from masters that do carry stock. The card says which are tracked.
    const { data, error: err } = await supabase
      .from('products')
      .select('id, name, sku, unit, hsn_sac, track_inventory, current_stock, purchase_price, selling_price')
      .eq('organization_id', oid)
      .eq('is_active', true)
      .order('name')
    if (err) setError(`Could not read the product catalogue: ${err.message}`)
    else setError('')
    return (data || []) as BomProduct[]
  }

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      setUserId(user.id)

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
      setProducts(await loadProducts(oid))
      const bom = loadBom(oid)
      setStore(bom)
      // Only confirmed orders are demand; a draft is a quote the customer has not signed.
      setOrders(loadStore('sales_order', oid).docs.filter(d => d.status === 'active'))

      // Deep links, read inside the load effect: the functions further down this component do not
      // exist yet when it runs, so the state is set inline (same idiom as /inventory/godowns).
      const view = searchParams.get('view')
      if (view === 'builds' || view === 'materials' || view === 'whereused' || view === 'rates' || view === 'recipes') setTab(view as Tab)
      const open = searchParams.get('open')
      if (open) { setOpenRecipe(open); setTab('recipes') }
      const component = searchParams.get('component')
      if (component) { setComponentId(component); setTab('whereused') }
      if (searchParams.get('build') === '1') {
        const first = bom.recipes.find(r => r.status === 'active')
        setTab('builds')
        setDraft({
          id: '',
          recipeId: first?.id || '',
          units: first ? String(first.output_qty) : '',
          date: today(),
          notes: '',
          lines: first ? requirement(first, first.output_qty).map(l => ({ product_id: l.product_id, qty: String(l.qty) })) : [],
        })
        setDraftError('')
      }
      if (searchParams.get('new') === '1') {
        setTab('recipes')
        setEditor({ recipe: newRecipe(), isNew: true })
        setEditorError('')
      }
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function today(): string {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  const day = today()
  const win = windowOf(period, day)
  const index = useMemo(() => indexProducts(products), [products])

  const views = useMemo(() => sortRecipeViews(recipeViews(store, products)), [store, products])
  const buildList = useMemo(() => sortBuilds(store.builds), [store.builds])
  const runs = useMemo(() => buildViews(store, products), [store, products])
  const summary = useMemo(() => summarise(views, store, products, day), [views, store, products, day])
  const demand = useMemo(() => {
    const lines = orders.flatMap(d => d.lines
      .filter(l => l.product_id && l.quantity > 0)
      .map(l => ({ product_id: l.product_id as string, quantity: l.quantity })))
    return demandAgainstRecipes(lines, store.recipes, store.builds, products)
  }, [orders, store, products])

  const visibleRecipes = useMemo(() => views.filter(v =>
    matchesFilter(v, recipeFilter) &&
    matchesAny(search, [v.recipe.name, v.output?.name, v.output?.sku, ...v.recipe.components.map(c => index.get(c.product_id)?.name)])),
  [views, recipeFilter, search, index])

  const visibleRuns = useMemo(() => runs.filter(r =>
    (buildFilter === 'all' || r.build.status === buildFilter) &&
    (win.from <= r.build.date && r.build.date <= win.to) &&
    matchesAny(search, [r.build.ref, r.recipe?.name, r.output?.name, r.build.notes])),
  [runs, buildFilter, win, search])

  /** Every product any recipe draws — the left rail of the where-used lookup. */
  const componentList = useMemo(() => {
    const agg = new Map<string, { used_by: number; per_unit: number }>()
    for (const v of views) {
      for (const c of v.recipe.components) {
        const prev = agg.get(c.product_id) || { used_by: 0, per_unit: 0 }
        agg.set(c.product_id, { used_by: prev.used_by + 1, per_unit: prev.per_unit + perUnitNeed(c, v.recipe) })
      }
    }
    return [...agg.entries()]
      .map(([id, agg2]) => ({ id, name: index.get(id)?.name || id, unit: index.get(id)?.unit || '', ...agg2 }))
      .filter(c => matchesAny(search, [c.name, index.get(c.id)?.sku, index.get(c.id)?.hsn_sac]))
      .sort((a, b) => b.used_by - a.used_by || a.name.localeCompare(b.name))
  }, [views, index, search])

  const picked = useMemo(() => {
    if (componentList.length === 0) return null
    return componentList.find(c => c.id === componentId) || componentList[0]
  }, [componentList, componentId])

  const attention = useMemo(() => views.filter(v => v.findings.some(f => f.tone === 'red')), [views])
  const maxBuildable = Math.max(1, ...views.filter(v => v.recipe.status === 'active').map(v => v.plan.buildable_units))

  const planViews = useMemo(() => (planRecipe === 'all'
    ? views.filter(v => v.recipe.status === 'active')
    : views.filter(v => v.recipe.id === planRecipe)), [views, planRecipe])

  // Merged shortage across the recipes on the board, so "All recipes" reads as one shelf.
  const boardShort = useMemo(() => {
    const map = new Map<string, { id: string; name: string; unit: string; short: number; for: string[] }>()
    for (const v of planViews) {
      for (const s of v.plan.shortages) {
        const prev = map.get(s.product_id) || { id: s.product_id, name: s.name, unit: s.unit, short: 0, for: [] }
        prev.short += s.short
        prev.for.push(v.recipe.name || 'Untitled')
        map.set(s.product_id, prev)
      }
    }
    return [...map.values()].sort((a, b) => b.short - a.short || a.name.localeCompare(b.name))
  }, [planViews])

  function flash(message: string) { setNotice({ msg: message, bad: false }) }
  function warn(message: string) { setNotice({ msg: message, bad: true }) }

  function refreshStore() { setStore(loadBom(orgId)) }

  // ── the recipe editor ───────────────────────────────────────────────────────
  function openRecipeEditor(recipe: Recipe, isNew: boolean) {
    setEditor({ recipe, isNew })
    setEditorError('')
  }

  function patchRecipe(patch: Partial<Recipe>) {
    setEditor(e => (e ? { ...e, recipe: { ...e.recipe, ...patch } } : e))
  }

  function patchComponent(id: string, patch: Partial<Recipe['components'][number]>) {
    setEditor(e => (e ? { ...e, recipe: { ...e.recipe, components: e.recipe.components.map(c => (c.id === id ? { ...c, ...patch } : c)) } } : e))
  }

  function saveRecipe() {
    if (!editor || !orgId) return
    const problems = validateRecipe(editor.recipe, store.recipes, products)
    if (problems.length) { setEditorError(problems.join(' · ')); return }
    upsertRecipe(orgId, editor.recipe)
    refreshStore()
    flash(editor.isNew
      ? `${editor.recipe.name.trim() || 'Recipe'} is on the register.`
      : `${editor.recipe.name.trim() || 'Recipe'} updated — the card re-reads its cost from the catalogue.`)
    setEditor(null)
    setEditorError('')
  }

  function archiveRecipe(v: RecipeView) {
    const next: Recipe = { ...v.recipe, status: v.recipe.status === 'archived' ? 'active' : 'archived' }
    upsertRecipe(orgId, next)
    refreshStore()
    flash(next.status === 'archived'
      ? `${v.recipe.name} archived — its runs stay on the log, new runs cannot be recorded against it.`
      : `${v.recipe.name} is in use again.`)
  }

  function deleteRecipe(v: RecipeView) {
    const result = removeRecipe(orgId, v.recipe.id)
    if (!result.ok) { warn(result.reason || 'That recipe cannot be deleted.'); return }
    refreshStore()
    flash(`${v.recipe.name} removed — it had no runs on the log.`)
  }

  // ── the shop rates editor ───────────────────────────────────────────────────
  function patchRate(patch: Partial<CostRate>) {
    setRateEdit(r => (r ? { ...r, ...patch } : r))
  }

  function saveRate() {
    if (!rateEdit || !orgId) return
    const problems = validateRate(rateEdit, store.rates)
    if (problems.length) { setRateError(problems.join(' · ')); return }
    upsertRate(orgId, rateEdit)
    refreshStore()
    flash(`Rate row saved from ${formatDateIN(rateEdit.from_date)} — every run from that day reads its labour and overhead here.`)
    setRateEdit(null)
    setRateError('')
  }

  function deleteRateRow(rate: CostRate) {
    removeRate(orgId, rate.id)
    refreshStore()
    flash(`The ${formatDateIN(rate.from_date)} rate row removed — runs from that day re-read their rate legs from the row before it.`)
  }

  // ── the build editor ────────────────────────────────────────────────────────
  const activeRecipes = useMemo(() => store.recipes.filter(r => r.status === 'active'), [store.recipes])

  function openBuildEditor(build?: Build, override?: Recipe) {
    if (build) {
      setDraft({
        id: build.id,
        recipeId: build.recipe_id,
        units: String(build.units || ''),
        date: build.date,
        notes: build.notes,
        lines: build.lines.map(l => ({ product_id: l.product_id, qty: String(l.qty) })),
      })
      setDraftError('')
      return
    }
    const recipe = override || activeRecipes[0]
    const units = recipe ? String(recipe.output_qty) : ''
    setDraft({
      id: '',
      recipeId: recipe?.id || '',
      units,
      date: day,
      notes: '',
      lines: recipe ? requirement(recipe, recipe.output_qty).map(l => ({ product_id: l.product_id, qty: String(l.qty) })) : [],
    })
    setDraftError('')
  }

  function patchDraft(patch: Partial<BuildDraft>) {
    setDraft(d => (d ? { ...d, ...patch } : d))
    setDraftError('')
  }

  function pickDraftRecipe(recipeId: string) {
    const recipe = store.recipes.find(r => r.id === recipeId)
    const units = recipe ? String(recipe.output_qty) : ''
    setDraft(d => (d ? {
      ...d,
      recipeId,
      units,
      lines: recipe ? requirement(recipe, recipe.output_qty).map(l => ({ product_id: l.product_id, qty: String(l.qty) })) : [],
    } : d))
    setDraftError('')
  }

  function fillFromRecipe() {
    if (!draft) return
    const recipe = store.recipes.find(r => r.id === draft.recipeId)
    const units = Number(draft.units)
    if (!recipe || !(units > 0)) { setDraftError('Say how many units the run made before filling the draws from the recipe.'); return }
    patchDraft({ lines: requirement(recipe, units).map(l => ({ product_id: l.product_id, qty: String(l.qty) })) })
  }

  const draftRecipe = draft ? store.recipes.find(r => r.id === draft.recipeId) : undefined
  const draftExisting = draft?.id ? store.builds.find(b => b.id === draft.id) : undefined

  /** The run the form currently describes — the same object the save would write. */
  const candidate = useMemo<Build | null>(() => {
    if (!draft) return null
    const units = Number(draft.units) || 0
    const base = draftExisting || newBuild(draft.recipeId, peekRef(store, draft.date), draft.date)
    return {
      ...base,
      id: draft.id || base.id,
      recipe_id: draft.recipeId,
      date: draft.date,
      units,
      notes: draft.notes,
      lines: draft.lines
        .filter(l => l.product_id && Number(l.qty) > 0)
        .map(l => ({ product_id: l.product_id, qty: Number(l.qty) })),
    }
  }, [draft, draftExisting, store])

  const draftCheck = useMemo(() => {
    if (!draft || !candidate) return null
    const errs = validateBuild(candidate, draftRecipe, products)
    // The library refuses nonsense; the shelf is this screen's check, because only the screen knows
    // the run is about to move real stock.
    const over: string[] = []
    for (const l of candidate.lines) {
      const p = index.get(l.product_id)
      if (!p || p.track_inventory === false) continue
      if (l.qty > (Number(p.current_stock) || 0) + 0.0000001) {
        over.push(`${p.name}: drew ${fmtQty(l.qty, p.unit || '')}, the shelf holds ${fmtQty(Number(p.current_stock) || 0, p.unit || '')}`)
      }
    }
    const plan = draftRecipe ? planBuild(draftRecipe, candidate.units, products, store.recipes) : null
    return {
      errs,
      over,
      plan,
      writes: movementsFor(candidate, draftRecipe, products),
      stamp: stampCost(candidate, draftRecipe, products, store.rates),
      ok: errs.length === 0 && over.length === 0,
    }
  }, [draft, candidate, draftRecipe, products, index, store.recipes, store.rates])

  const draftPlanRows = useMemo<PlanRow[]>(() => {
    if (!draftCheck?.plan) return []
    return draftCheck.plan.rows.filter(r => r.need > 0)
  }, [draftCheck])

  // ── writing the stock ledger ────────────────────────────────────────────────
  async function writeMovement(w: StockWrite): Promise<string> {
    const { error: err } = await supabase.rpc('record_stock_movement', {
      p_organization_id: orgId,
      p_product_id: w.product_id,
      p_movement_type: w.movement_type,
      p_quantity: w.quantity,
      p_reference_type: 'manual',
      p_reference_id: null,
      p_reference_number: w.reference_number,
      p_notes: w.notes,
      p_created_by: userId,
    })
    return err ? `${w.product_name}: ${err.message}` : ''
  }

  /**
   * All or nothing. A build that moved half its components would leave the shelf disagreeing with
   * the register, so an early failure reverses what went through and the run stays a plan.
   */
  async function writeAll(writes: StockWrite[]): Promise<string> {
    const applied: StockWrite[] = []
    for (const w of writes) {
      const failure = await writeMovement(w)
      if (!failure) { applied.push(w); continue }
      for (const done of applied.reverse()) {
        await writeMovement({
          ...done,
          quantity: -done.quantity,
          movement_type: done.movement_type === 'adjustment_in' ? 'adjustment_out' : 'adjustment_in',
          notes: `Undo ${done.reference_number} — ${done.product_name} put back after a failed build`,
        })
      }
      return failure
    }
    return ''
  }

  async function saveBuild(asBuilt: boolean) {
    if (!candidate || !orgId) return
    const check = draftCheck
    if (!check) return
    if (check.errs.length) { setDraftError(check.errs.join(' · ')); return }
    if (asBuilt && check.over.length) {
      setDraftError(`${check.over.join(' · ')} — save it as a plan and buy the material first, or correct what was drawn.`)
      return
    }

    setBusy(asBuilt ? 'Writing the stock movements…' : 'Saving the plan…')
    const ref = draftExisting?.ref || candidate.ref
    let moved = false
    if (asBuilt && check.writes.length) {
      const failure = await writeAll(check.writes)
      if (failure) {
        setBusy('')
        setDraftError(`The shelf could not take that movement — ${failure}. The run is left as a plan so nothing is claimed that the ledger does not hold.`)
        const kept = { ...candidate, ref, status: 'planned' as const, moved: false }
        upsertBuild(orgId, kept)
        refreshStore()
        setProducts(await loadProducts(orgId))
        return
      }
      moved = true
    }

    const saved: Build = { ...candidate, ref, status: asBuilt ? 'built' : 'planned', moved }
    const allocated = !draftExisting
    if (allocated) {
      const { store: bumped } = allocateRef(store, candidate.date)
      saveBom(orgId, bumped)
    }
    upsertBuild(orgId, saved)
    refreshStore()
    if (moved) setProducts(await loadProducts(orgId))
    setBusy('')
    setDraft(null)
    setDraftError('')
    flash(moved
      ? `${saved.ref} recorded — ${check.writes.length} movement${check.writes.length === 1 ? '' : 's'} written to the stock ledger${check.stamp.total === null ? '' : `, worth ${money(check.stamp.total)} as the catalogue and the rate rows read`}.`
      : `${saved.ref} is a plan on the log. No stock has moved.`)
  }

  async function recordRun(view: BuildView) {
    const build = view.build
    const recipe = store.recipes.find(r => r.id === build.recipe_id)
    const writes = movementsFor(build, recipe, products)
    const over: string[] = []
    for (const l of build.lines) {
      const p = index.get(l.product_id)
      if (!p || p.track_inventory === false) continue
      if (l.qty > (Number(p.current_stock) || 0) + 0.0000001) {
        over.push(`${p.name}: asks ${fmtQty(l.qty, p.unit || '')}, the shelf holds ${fmtQty(Number(p.current_stock) || 0, p.unit || '')}`)
      }
    }
    if (over.length) { warn(`${build.ref} cannot be recorded — ${over.join(' · ')}.`); return }

    setBusy(`Writing ${build.ref} to the stock ledger…`)
    const failure = await writeAll(writes)
    setBusy('')
    if (failure) { warn(`The movement failed — ${failure}. ${build.ref} stays a plan.`); return }
    upsertBuild(orgId, { ...build, status: 'built', moved: true })
    refreshStore()
    setProducts(await loadProducts(orgId))
    flash(`${build.ref} moved — ${writes.length} movement${writes.length === 1 ? '' : 's'} on the stock ledger.`)
  }

  async function cancelRun(view: BuildView) {
    const build = view.build
    const recipe = store.recipes.find(r => r.id === build.recipe_id)
    if (build.moved) {
      const reversals = reverseMovementsFor(build, recipe, products)
      setBusy(`Reversing ${build.ref}…`)
      const failure = await writeAll(reversals)
      setBusy('')
      if (failure) { warn(`The reversal failed — ${failure}. ${build.ref} is still on the shelf as built.`); return }
      upsertBuild(orgId, {
        ...build,
        status: 'cancelled',
        moved: false,
        notes: [build.notes, `Reversed ${day} — the drawn units went back and the finished units came off`].filter(Boolean).join(' · '),
      })
      refreshStore()
      setProducts(await loadProducts(orgId))
      flash(`${build.ref} cancelled and reversed — the original run and its reversal both stay in the movement log.`)
      return
    }
    const result = cancelBuild(orgId, build.id)
    if (!result.ok) { warn(result.reason || 'That run cannot be cancelled.'); return }
    refreshStore()
    flash(`${build.ref} cancelled — it never moved stock, so there was nothing to reverse.`)
  }

  function deleteRun(build: Build) {
    const result = removeBuild(orgId, build.id)
    if (!result.ok) { warn(result.reason || 'That run cannot be deleted.'); return }
    refreshStore()
    flash(`${build.ref} removed — a plan that never touched the shelf.`)
  }

  // ── exports ─────────────────────────────────────────────────────────────────
  function exportRecipes() {
    download(`taxflow-recipes-${day}.csv`, toCsv(RECIPE_CSV_HEADERS, recipeCsvRows(visibleRecipes)))
  }

  function exportRuns() {
    download(`taxflow-builds-${day}.csv`, toCsv(BUILD_CSV_HEADERS, buildCsvRows(visibleRuns, products)))
  }

  function exportBoard() {
    download(`taxflow-materials-${day}.csv`, toCsv(PLAN_CSV_HEADERS, planCsvRows(planViews)))
  }

  function exportWhereUsed() {
    if (!picked) return
    const used = whereUsed(picked.id, store.recipes)
    const rows = used.map(u => [
      picked.name,
      picked.unit,
      u.recipe.name,
      RECIPE_STATUS_META[u.recipe.status].label,
      u.per_unit,
      index.get(u.recipe.output_product_id)?.name || u.recipe.output_product_id,
      u.recipe.components.length,
      consumedOf(picked.id, store.builds, win.from, win.to),
    ])
    download(`taxflow-where-used-${picked.name.replace(/[^\w-]+/g, '_') || 'component'}-${day}.csv`,
      toCsv(['Component', 'Unit', 'Recipe', 'Recipe status', 'Drawn per finished unit', 'Makes', 'Components in recipe', `Consumed in ${period === 'all' ? 'all time' : `FY ${fyLabel(fyStartYear(new Date(`${win.from}T00:00:00`)))}`}`],
        rows.length ? rows : [[picked.name, picked.unit, '', '', '', '', 0, 0]]))
  }

  // A modal closes on Escape — the register is typed in, and the keyboard should never feel trapped.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (editor) { setEditor(null); setEditorError('') }
      else if (draft) { setDraft(null); setDraftError('') }
      else if (rateEdit) { setRateEdit(null); setRateError('') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editor, draft, rateEdit])

  if (loading) {
    return <div className="page-container rc"><p className="rc-load">Reading your catalogue and this browser’s recipe book…</p></div>
  }

  const noProducts = products.length === 0
  const noRecipes = store.recipes.length === 0
  // The two FY figures never add: material is read at today's prices, the rate legs at each run's
  // own date. The card keeps them apart in the same sentence rather than summing the bases.
  const builtSub = summary.value_built_fy === null
    ? 'materials drawn cannot be valued yet — a component has no cost'
    : `${money(summary.value_built_fy)} of materials drawn, at the prices carried today`
  const labourSub = summary.labour_fy === null
    ? 'labour time absorbed, but a run has no rate in force'
    : summary.labour_fy > 0 || (summary.overhead_fy ?? 0) > 0
      ? `labour ${money(summary.labour_fy)} · overhead ${money(summary.overhead_fy ?? 0)} absorbed, at the rates in force on each day`
      : ''

  return (
    <div className="page-container rc" style={{ maxWidth: 1180 }}>
      <PageHeader
        eyebrow={`${orgName.toUpperCase() || 'TAXFLOW'} · MANUFACTURING`}
        title="Recipes & builds"
        subtitle="What each finished good is made of, how much of it the shelf can cover today, and what every run actually drew. Parts are priced from your catalogue on every load, labour and overhead from your dated rate rows — this register stores quantities, minutes and dated figures, never a guessed price."
        actions={
          <>
            {tab === 'recipes' && <Button variant="ghost" size="sm" icon="download" onClick={exportRecipes} disabled={visibleRecipes.length === 0}>Recipe CSV</Button>}
            {tab === 'builds' && <Button variant="ghost" size="sm" icon="download" onClick={exportRuns} disabled={visibleRuns.length === 0}>Log CSV</Button>}
            {tab === 'materials' && <Button variant="ghost" size="sm" icon="download" onClick={exportBoard} disabled={planViews.length === 0}>Board CSV</Button>}
            {tab === 'whereused' && <Button variant="ghost" size="sm" icon="download" onClick={exportWhereUsed} disabled={!picked}>Lookup CSV</Button>}
            <Button variant="ghost" size="sm" icon="play" onClick={() => openBuildEditor()} disabled={activeRecipes.length === 0}>New build</Button>
            <Button icon="plus" onClick={() => openRecipeEditor(newRecipe(), true)}>New recipe</Button>
          </>
        }
      />

      <div className="rc-stats">
        <StatCard
          label="Recipes on the register" value={String(summary.recipes)}
          sub={summary.recipes ? `${summary.active} in use · ${views.filter(v => v.recipe.status === 'draft').length} draft${views.filter(v => v.recipe.status === 'draft').length === 1 ? '' : 's'}` : 'nothing written down yet'}
          icon="recipe" tone="blue" delay={0}
        />
        <StatCard
          label="What the shelf can run" value={`${summary.runnable} / ${summary.active}`}
          sub={summary.blocked ? `${summary.blocked} recipe${summary.blocked === 1 ? '' : 's'} held up by ${summary.shortage_rows} component${summary.shortage_rows === 1 ? '' : 's'}` : summary.active ? 'every live recipe can be run now' : 'no live recipe to plan'}
          icon={summary.blocked ? 'alert' : 'shield'} tone={summary.blocked ? 'red' : summary.active ? 'green' : 'grey'} delay={40}
        />
        <StatCard
          label={`Built in FY ${fyLabel(fyStartYear(new Date(`${day}T00:00:00`)))}`}
          value={fmtQty(summary.units_built_fy, '')}
          sub={labourSub ? `${builtSub} · ${labourSub}` : builtSub}
          icon="box" tone="violet" delay={80}
        />
        <StatCard
          label="Runs on the log" value={String(buildList.length)}
          sub={buildList.length
            ? `${buildList.filter(b => b.status === 'built').length} built · ${buildList.filter(b => b.status === 'planned').length} planned${demand.length ? ` · ${demand.length} order${demand.length === 1 ? '' : 's'} waiting` : ''}`
            : 'no run recorded yet'}
          icon="list" tone={demand.length ? 'amber' : 'cyan'} delay={120}
        />
      </div>

      <div className="rc-toolbar">
        <Segmented options={TABS} value={tab} onChange={v => { setTab(v as Tab); setSearch('') }} />
        {tab === 'recipes' && <Segmented options={RECIPE_FILTERS} value={recipeFilter} onChange={v => { setRecipeFilter(v as RecipeFilter); setOpenRecipe('') }} />}
        {tab === 'builds' && <Segmented options={BUILD_FILTERS} value={buildFilter} onChange={v => setBuildFilter(v as BuildFilter)} />}
        {tab === 'materials' && (
          <label className="rc-select">
            <span>Recipe</span>
            <select className="tf-input" value={planRecipe} onChange={e => setPlanRecipe(e.target.value)}>
              <option value="all">All live recipes</option>
              {store.recipes.filter(r => r.status !== 'archived').map(r => (
                <option key={r.id} value={r.id}>{r.name || 'Untitled recipe'}</option>
              ))}
            </select>
          </label>
        )}
        {(tab === 'builds' || tab === 'whereused') && (
          <select className="tf-input rc-period" value={period} onChange={e => setPeriod(e.target.value as Period)} aria-label="Period">
            {PERIODS.map(p => (
              <option key={p.value} value={p.value}>
                {p.value === 'all' ? 'All time' : `${p.label} · FY ${fyLabel(p.value === 'this_fy' ? fyStartYear(new Date(`${day}T00:00:00`)) : fyStartYear(new Date(`${day}T00:00:00`)) - 1)}`}
              </option>
            ))}
          </select>
        )}
        <SearchInput value={search} onChange={setSearch}
          placeholder={tab === 'whereused' ? 'Component, SKU or HSN…' : tab === 'builds' ? 'Job, recipe or product…' : 'Recipe, product or component…'}
          ariaLabel="Search the register" style={{ flex: '1 1 200px', maxWidth: 300, marginLeft: 'auto' }} />
      </div>

      {notice && (
        <div className={`rc-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
          <Icon name={notice.bad ? 'alert' : 'check'} size={14} strokeWidth={notice.bad ? 2.2 : 2.4} />
          <span>{notice.msg}</span>
          <button type="button" className="rc-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {error && (
        <div className="rc-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{error}</div>
      )}

      {noProducts && (
        <div className="rc-note">
          <Icon name="alert" size={14} strokeWidth={2.2} />
          <span>
            Your catalogue is empty, so there is nothing a recipe could be made of and nothing to price a run with.
            Start at <Link href="/products">products</Link> — a recipe is a relationship between two rows of that list,
            and its cost is read from them every time this page loads.
          </span>
        </div>
      )}

      {busy && (
        <div className="rc-busy" role="status"><Icon name="clock" size={14} /><span>{busy}</span></div>
      )}

      {summary.unpriced_components.length > 0 && tab !== 'whereused' && (
        <div className="rc-note">
          <Icon name="scale" size={13} strokeWidth={2.2} />
          <span>
            <strong>{summary.unpriced_components.length} component{summary.unpriced_components.length === 1 ? ' has' : 's have'} no cost</strong> —{' '}
            {summary.unpriced_components.slice(0, 4).join(', ')}{summary.unpriced_components.length > 4 ? '…' : ''}. Every recipe that draws them prints no material value
            rather than a wrong one. {' '}
            <Link href="/products">Record the cost on the product</Link>; the card below re-prices itself on the next load.
          </span>
        </div>
      )}

      {/* ── recipe book ──────────────────────────────────────────────────────── */}
      {tab === 'recipes' && (
        <>
          {attention.length > 0 && (
            <div className="rc-note is-hot">
              <Icon name="alert" size={14} strokeWidth={2.2} />
              <span>
                <strong>{attention.length} recipe{attention.length === 1 ? ' has' : 's have'} something blocking them</strong> —
                {' '}{attention.map((v, i) => (
                  <span key={v.recipe.id}>
                    <button type="button" className="rc-inline" onClick={() => { setOpenRecipe(v.recipe.id); setRecipeFilter('all') }}>{v.recipe.name || 'Untitled'}</button>
                    {i < attention.length - 1 ? ', ' : '. '}
                  </span>
                ))}
                Each prints its reason on the card. None of them is a tax figure — a build moves quantity, not value,
                and the tax happens when the finished good is sold at <Link href="/invoices">invoices</Link>.
              </span>
            </div>
          )}

          {noRecipes ? (
            <Card>
              <EmptyState icon="recipe" title="No recipe written down yet"
                message="A recipe says what goes into one run and how many units that run makes. Write one and the page tells you what the shelf can cover, what a finished unit costs in materials, and which part is holding you up."
                action={<Button size="sm" icon="plus" onClick={() => openRecipeEditor(newRecipe(), true)}>New recipe</Button>} />
            </Card>
          ) : visibleRecipes.length === 0 ? (
            <Card>
              <EmptyState icon="filter" title="No recipe in this view"
                message="Clear the search or pick another filter — the whole book is still on the register." />
            </Card>
          ) : (
            <div className="rc-grid">
              {visibleRecipes.map(v => {
                const recipe = v.recipe
                const open = openRecipe === recipe.id
                const isMade = views.some(x => x.recipe.id !== recipe.id && x.recipe.output_product_id === recipe.output_product_id)
                return (
                  <div key={recipe.id} className={`rc-card is-${recipe.status} ${open ? 'is-open' : ''}`}>
                    <div className="rc-card-head">
                      <div className="rc-card-title">
                        <span className="rc-card-name">
                          <Icon name="recipe" size={15} />
                          {recipe.name || 'Untitled recipe'}
                        </span>
                        <span className="rc-card-sub">
                          makes {fmtQty(recipe.output_qty, v.output?.unit || '')} of {v.output?.name || 'a product no longer in the catalogue'}
                          {v.output?.hsn_sac ? ` · HSN/SAC ${v.output.hsn_sac}` : ' · no HSN/SAC'}
                        </span>
                      </div>
                      <div className="rc-card-badges">
                        <Badge tone={RECIPE_STATUS_META[recipe.status].tone} dot={false}>{RECIPE_STATUS_META[recipe.status].label}</Badge>
                        {isMade && <Badge tone="violet" dot={false}>Sub-assembly</Badge>}
                      </div>
                    </div>

                    <div className="rc-card-stats">
                      <StatRow label="Cost / unit, full" strong
                        value={v.full.per_unit === null ? `— (${v.full.missing.length} gap${v.full.missing.length === 1 ? '' : 's'})` : price(v.full.per_unit)}
                        tone={v.full.per_unit === null ? 'amber' : 'grey'} />
                      {v.full.per_unit !== null && (v.recipe.labour_minutes > 0 || v.recipe.overhead_minutes > 0) && (
                        <StatRow label="Parts · labour · overhead" tone="grey"
                          value={[
                            v.recipe.output_qty > 0 ? price((v.full.material.value ?? 0) / v.recipe.output_qty) : price(v.full.material.value ?? 0),
                            v.recipe.labour_minutes > 0 ? `${fmtMinutes(v.recipe.labour_minutes / (v.recipe.output_qty || 1))} · ${price((v.full.labour.value ?? 0) / (v.recipe.output_qty || 1))}` : '',
                            v.recipe.overhead_minutes > 0 ? `${fmtMinutes(v.recipe.overhead_minutes / (v.recipe.output_qty || 1))} · ${price((v.full.overhead.value ?? 0) / (v.recipe.output_qty || 1))}` : '',
                          ].filter(Boolean).join(' · ')} />
                      )}
                      <StatRow label={v.margin_basis === 'material' ? 'Margin / unit, parts alone' : 'Margin / unit, full cost'}
                        value={v.margin_per_unit === null ? '—' : `${price(v.margin_per_unit)} · ${percent(v.margin_pct)}`}
                        tone={v.margin_per_unit === null ? 'grey' : v.margin_per_unit < 0 ? 'red' : 'green'} />
                      <StatRow label="Can make now"
                        value={v.recipe.status === 'active' ? `${fmtQty(v.plan.buildable_units, '')} units` : 'not while it is a draft'}
                        tone={v.recipe.status !== 'active' ? 'grey' : v.plan.can_run ? 'green' : 'red'} />
                      <StatRow label="Built · runs"
                        value={v.build_count ? `${fmtQty(v.units_built, '')} on ${v.build_count} run${v.build_count === 1 ? '' : 's'}${v.last_built ? ` · last ${formatDateIN(v.last_built)}` : ''}` : 'nothing yet'} />
                      {v.variance !== null && Math.abs(v.variance) > 0.0001 && (
                        <StatRow label="Last run against recipe" tone="amber"
                          value={`${v.variance > 0 ? '+' : ''}${fmtQty(v.variance, '')} drawn`} />
                      )}
                    </div>

                    {recipe.status === 'active' && (
                      <div className="rc-share">
                        <ProgressBar value={Math.min(v.plan.buildable_units, maxBuildable)} max={maxBuildable}
                          color={v.plan.can_run ? 'var(--green)' : 'var(--amber)'} />
                        <span className="rc-share-label">
                          {v.plan.limited_by ? `held up by ${v.plan.limited_by}` : 'nothing on the shelf is holding this run'}
                        </span>
                      </div>
                    )}

                    {v.findings.length > 0 && (
                      <ul className="rc-findings">
                        {v.findings.map((f, i) => (
                          <li key={i} className={`rc-finding rc-finding-${f.tone}`}>
                            <span className={`rc-dot rc-dot-${f.tone}`} />
                            {f.text}
                          </li>
                        ))}
                      </ul>
                    )}

                    {open && (
                      <div className="rc-parts">
                        <div className="rc-parts-head">
                          <span>Per unit</span>
                          <span>Drawn per run</span>
                          <span>On the shelf</span>
                          <span>State</span>
                        </div>
                        {v.recipe.components.map(c => {
                          const p = index.get(c.product_id)
                          const row = planViews.find(x => x.recipe.id === recipe.id)?.plan.rows.find(r => r.product_id === c.product_id)
                            || v.plan.rows.find(r => r.product_id === c.product_id)
                          return (
                            <div key={c.id} className="rc-part">
                              <span className="rc-part-name">
                                <button type="button" className="rc-inline" onClick={() => { setComponentId(c.product_id); setTab('whereused'); setSearch('') }}
                                  title={`See where ${p?.name || 'this component'} is used`}>
                                  {p?.name || c.product_id}
                                </button>
                                <span className="rc-part-sub">
                                  {c.waste_pct > 0 ? `${c.waste_pct}% wastage` : 'no wastage recorded'}{c.note ? ` · ${c.note}` : ''}
                                </span>
                              </span>
                              <span className="rc-num">{fmtQty(perUnitNeed(c, recipe), p?.unit || '')}</span>
                              <span className="rc-num">{fmtQty(c.qty, p?.unit || '')}</span>
                              <span className="rc-num">{p ? (p.track_inventory === false ? 'not tracked' : fmtQty(Number(p.current_stock) || 0, p?.unit || '')) : '—'}</span>
                              <span>
                                <Badge tone={row ? (row.tone === 'short' ? 'red' : row.tone === 'unknown' ? 'grey' : 'green') : 'grey'} dot={false}>
                                  {row ? (row.tone === 'short' ? `short ${fmtQty(row.short, row.unit)}` : row.tone === 'unknown' ? 'unknown' : 'enough') : '—'}
                                </Badge>
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    <div className="rc-card-foot">
                      <Button variant="ghost" size="sm" icon="list" onClick={() => setOpenRecipe(open ? '' : recipe.id)}>
                        {open ? 'Hide parts' : `${v.component_count} part${v.component_count === 1 ? '' : 's'}`}
                      </Button>
                      <span className="rc-card-actions">
                        {recipe.status === 'active' && (
                          <Button variant="ghost" size="sm" icon="play" title={`Record a run of ${recipe.name}`}
                            onClick={() => { openBuildEditor(undefined, recipe); setTab('builds') }}>Build</Button>
                        )}
                        <Button variant="ghost" size="sm" icon="layers" title="Open on the materials board"
                          onClick={() => { setPlanRecipe(recipe.id); setTab('materials'); setSearch('') }}>{' '}</Button>
                        <Button variant="ghost" size="sm" icon="edit" title={`Edit ${recipe.name}`}
                          onClick={() => openRecipeEditor({ ...recipe, components: recipe.components.map(c => ({ ...c })) }, false)}
                          style={{ width: 32, padding: 0 }}>{' '}</Button>
                        <Button variant={recipe.status === 'archived' ? 'ghost' : 'danger'} size="sm"
                          icon={recipe.status === 'archived' ? 'undo' : 'x'}
                          title={recipe.status === 'archived' ? `Reactivate ${recipe.name}` : `Delete ${recipe.name}`}
                          onClick={() => (recipe.status === 'archived' ? archiveRecipe(v) : deleteRecipe(v))}
                          style={{ width: 32, padding: 0 }}>{' '}</Button>
                      </span>
                    </div>
                    {recipe.status !== 'archived' && (
                      <button type="button" className="rc-archive" onClick={() => archiveRecipe(v)}>
                        {recipe.status === 'draft' ? 'Mark in use' : 'Archive this recipe'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* ── build log ────────────────────────────────────────────────────────── */}
      {tab === 'builds' && (
        <>
          {store.builds.some(b => b.status === 'planned') && buildFilter === 'all' && (
            <div className="rc-note">
              <Icon name="clock" size={13} strokeWidth={2.2} />
              <span>
                {store.builds.filter(b => b.status === 'planned').length} planned run
                {store.builds.filter(b => b.status === 'planned').length === 1 ? '' : 's'} on the log — a plan is a promise about materials
                and has moved nothing. “Move stock” writes its movements; until then the shelf does not know about it.
              </span>
            </div>
          )}

          {buildList.length === 0 ? (
            <Card>
              <EmptyState icon="play" title="No run recorded yet"
                message="Record a build when the shop actually makes something: the components go out and the finished units come in, both through the same movement trail /inventory writes, under a job number this register keeps."
                action={activeRecipes.length
                  ? <Button size="sm" icon="play" onClick={() => openBuildEditor()}>New build</Button>
                  : <Button size="sm" icon="plus" onClick={() => openRecipeEditor(newRecipe(), true)}>New recipe</Button>} />
            </Card>
          ) : visibleRuns.length === 0 ? (
            <Card>
              <EmptyState icon="filter" title="No run in this view"
                message="Widen the period or clear the filter — runs are kept on the log even after they are cancelled, because the reversal is part of the story." />
            </Card>
          ) : (
            <div className="table-frame">
              <div className="responsive-table">
                <div className="table-header rc-row rc-head">
                  <span data-label="Job">Job / date</span>
                  <span data-label="Recipe">Recipe · made</span>
                  <span className="rc-right" data-label="Units">Units</span>
                  <span className="rc-right" data-label="Materials">Cost today</span>
                  <span data-label="Draw">Drawn vs recipe</span>
                  <span data-label="Status">State</span>
                  <span className="rc-right" data-label="Actions">Actions</span>
                </div>
                {visibleRuns.map(r => {
                  const open = openRecipe === r.build.id
                  return (
                    <div key={r.build.id} className={`rc-run ${open ? 'is-open' : ''}`}>
                      <div className="table-row rc-row">
                        <span data-label="Job" className="rc-col-job">
                          <span className="rc-mono">{r.build.ref}</span>
                          <span className="rc-sub">{formatDateIN(r.build.date)} · {r.build.moved ? 'movements written' : 'no movements'}</span>
                        </span>
                        <span data-label="Recipe" className="rc-item">
                          <span className="rc-item-name">{r.recipe?.name || 'recipe no longer on the register'}</span>
                          <span className="rc-sub">{r.output?.name || '—'}{r.recipe ? ` · makes ${fmtQty(r.recipe.output_qty, r.output?.unit || '')}` : ''}</span>
                        </span>
                        <span className="rc-right rc-num" data-label="Units">{fmtQty(r.build.units, r.output?.unit || '')}</span>
                        <span className="rc-right rc-num" data-label="Materials" title="Parts at the catalogue's prices today, plus labour and overhead at the rates in force on the run's own date">
                          {r.full.value === null
                            ? (r.full.missing.length ? `— (${r.full.missing.length} gap${r.full.missing.length === 1 ? '' : 's'})` : '—')
                            : money(r.full.value)}
                        </span>
                        <span data-label="Draw" className="rc-variance">
                          {r.variance.length
                            ? <button type="button" className="rc-inline" onClick={() => setOpenRecipe(open ? '' : r.build.id)}>
                              {r.variance.length} line{r.variance.length === 1 ? '' : 's'} drawn differently
                            </button>
                            : <span className="rc-sub">exactly the recipe</span>}
                        </span>
                        <span data-label="Status">
                          <Badge tone={BUILD_STATUS_META[r.build.status].tone} dot={false}>{BUILD_STATUS_META[r.build.status].label}</Badge>
                        </span>
                        <span className="rc-right rc-acts" data-label="Actions">
                          {r.build.status === 'planned' && (
                            <>
                              <Button variant="ghost" size="sm" icon="edit" title={`Edit ${r.build.ref}`}
                                onClick={() => openBuildEditor(r.build)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                              <Button variant="ghost" size="sm" icon="file-check" title={`Write ${r.build.ref} to the stock ledger`}
                                disabled={!!busy} onClick={() => recordRun(r)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                              <Button variant="danger" size="sm" icon="x" title={`Delete the plan ${r.build.ref}`}
                                onClick={() => deleteRun(r.build)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                            </>
                          )}
                          {r.build.status !== 'cancelled' && (
                            <Button variant="danger" size="sm" icon="undo" title={`Cancel ${r.build.ref}${r.build.moved ? ' and write the reversal' : ''}`}
                              disabled={!!busy} onClick={() => cancelRun(r)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                          )}
                        </span>
                      </div>

                      {(open || (r.build.notes && r.build.status !== 'built')) && (
                        <div className="rc-detail">
                          {r.variance.length > 0 && (
                            <>
                              <div className="rc-detail-title">What the shop drew against what the recipe asked</div>
                              {r.variance.map(v => (
                                <div key={v.product_id} className="rc-vrow">
                                  <span className="rc-item-name">{v.name}</span>
                                  <span className="rc-sub">recipe {fmtQty(v.wanted, index.get(v.product_id)?.unit || '')}</span>
                                  <span className="rc-sub">drawn {fmtQty(v.drawn, index.get(v.product_id)?.unit || '')}</span>
                                  <span className={`rc-num ${v.diff > 0 ? 'rc-over' : 'rc-under'}`}>{v.diff > 0 ? '+' : ''}{fmtQty(v.diff, index.get(v.product_id)?.unit || '')}</span>
                                </div>
                              ))}
                            </>
                          )}
                          {r.build.lines.length > 0 && (
                            <>
                              <div className="rc-detail-title">Lines on this run</div>
                              {r.build.lines.map(l => (
                                <div key={l.product_id} className="rc-vrow">
                                  <span className="rc-item-name">{index.get(l.product_id)?.name || l.product_id}</span>
                                  <span className="rc-sub">{index.get(l.product_id)?.track_inventory === false ? 'not stock-tracked' : `cost ${price(index.get(l.product_id)?.purchase_price)} / unit`}</span>
                                  <span />
                                  <span className="rc-num">{fmtQty(l.qty, index.get(l.product_id)?.unit || '')}</span>
                                </div>
                              ))}
                            </>
                          )}
                          {r.findings.length > 0 && (
                            <ul className="rc-findings">
                              {r.findings.map((f, i) => (
                                <li key={i} className={`rc-finding rc-finding-${f.tone}`}>
                                  <span className={`rc-dot rc-dot-${f.tone}`} />{f.text}
                                </li>
                              ))}
                            </ul>
                          )}
                          {r.build.notes && <p className="rc-detail-note">Note on the run — {r.build.notes}</p>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── materials board ──────────────────────────────────────────────────── */}
      {tab === 'materials' && (
        <>
          {demand.length > 0 && (
            <div className="rc-section">
              <div className="rc-section-head">
                <h2><Icon name="bag" size={15} />Orders waiting on the shop</h2>
                <span className="rc-section-sub">
                  Confirmed sales orders for goods that have a recipe — demanded, already built, and what the shelf can cover today.
                </span>
                <Link href="/sales-orders" className="rc-section-link">Order register →</Link>
              </div>
              <div className="rc-grid rc-grid-wide">
                {demand.map(d => (
                  <Card key={d.product_id} className="rc-demand">
                    <div className="rc-demand-head">
                      <span className="rc-item-name">{d.name}</span>
                      <Badge tone={d.to_build > 0 ? (d.buildable >= d.to_build ? 'green' : 'amber') : 'grey'} dot={false}>
                        {d.to_build > 0 ? (d.buildable >= d.to_build ? 'can cover' : 'short of parts') : 'already made'}
                      </Badge>
                    </div>
                    <div className="rc-demand-figs">
                      <span><em>{fmtQty(d.demanded, d.unit)}</em>ordered</span>
                      <span><em>{fmtQty(d.made, d.unit)}</em>built</span>
                      <span><em>{fmtQty(d.to_build, d.unit)}</em>still to make</span>
                      <span><em>{fmtQty(d.buildable, d.unit)}</em>the shelf can run</span>
                    </div>
                    {d.limited_by && <p className="rc-demand-hold">held up by {d.limited_by}</p>}
                    <div className="rc-demand-foot">
                      <Button variant="ghost" size="sm" icon="play" onClick={() => {
                        if (!d.recipe) return
                        const recipe = d.recipe
                        const units = Math.max(1, Math.min(d.to_build || 1, d.buildable || d.to_build || 1))
                        setDraft({
                          id: '', recipeId: recipe.id, units: String(units), date: day, notes: `Against orders for ${d.name}`,
                          lines: requirement(recipe, units).map(l => ({ product_id: l.product_id, qty: String(l.qty) })),
                        })
                        setDraftError('')
                      }}>Start this run</Button>
                      <Button variant="ghost" size="sm" icon="layers" onClick={() => { setPlanRecipe(d.recipe?.id || 'all'); setSearch('') }}>Parts board</Button>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {planViews.length === 0 ? (
            <Card>
              <EmptyState icon="layers" title="Nothing live to plan"
                message="The board plans recipes that are in use. Write a recipe, mark it in use, and this becomes the answer to “what can we not make today, and because of which part?”"
                action={<Button size="sm" icon="plus" onClick={() => openRecipeEditor(newRecipe(), true)}>New recipe</Button>} />
            </Card>
          ) : planRecipe === 'all' ? (
            <div className="rc-section">
              <div className="rc-section-head">
                <h2><Icon name="cart" size={15} />Short of these, on every live recipe</h2>
                <span className="rc-section-sub">
                  The same component asked for by several recipes folds into one line — the shelf holds one number and it has to cover all of them.
                </span>
              </div>
              {boardShort.length === 0 ? (
                <div className="rc-clear">
                  <Icon name="shield" size={14} strokeWidth={2.2} />
                  Nothing is short. Every live recipe can be run at least once on the stock you have.
                </div>
              ) : (
                <div className="rc-grid">
                  {boardShort.map(s => (
                    <div key={s.id} className="rc-short">
                      <div className="rc-short-head">
                        <span className="rc-item-name">{s.name}</span>
                        <span className="rc-short-qty">short {fmtQty(s.short, s.unit)}</span>
                      </div>
                      <p className="rc-short-for">wanted by {s.for.join(' · ')}</p>
                      <div className="rc-short-foot">
                        <Button variant="ghost" size="sm" icon="search" onClick={() => { setComponentId(s.id); setTab('whereused'); setSearch('') }}>Where used</Button>
                        <Button variant="ghost" size="sm" icon="cart" href="/inventory/reorder">Reorder planner</Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="rc-recipes-strip">
                {planViews.map(v => (
                  <button key={v.recipe.id} type="button" className="rc-strip" onClick={() => setPlanRecipe(v.recipe.id)}>
                    <span className="rc-item-name">{v.recipe.name || 'Untitled'}</span>
                    <span className={`rc-num ${v.plan.can_run ? 'rc-under' : 'rc-over'}`}>{fmtQty(v.plan.buildable_units, '')} units</span>
                    <span className="rc-sub">{v.plan.limited_by || 'nothing holding it'}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="rc-section">
              <div className="rc-section-head">
                <h2><Icon name="layers" size={15} />{planViews[0]?.recipe.name || 'Recipe'} — what the shelf must hold</h2>
                <span className="rc-section-sub">
                  Planned for {fmtQty(planViews[0]?.recipe.output_qty || 1, planViews[0]?.output?.unit || '')} per run. A part of a sub-assembly sits below it, indented, and the two levels add into one shelf figure.
                </span>
                <Button variant="ghost" size="sm" onClick={() => setPlanRecipe('all')} style={{ marginLeft: 'auto' }}>All recipes</Button>
              </div>
              <div className="table-frame">
                <div className="responsive-table">
                  <div className="table-header rc-prow rc-phead">
                    <span data-label="Component">Component</span>
                    <span className="rc-right" data-label="Need">Need</span>
                    <span className="rc-right" data-label="On hand">On the shelf</span>
                    <span className="rc-right" data-label="Short">Short</span>
                    <span data-label="State">State</span>
                  </div>
                  {rowsOf(planViews[0]).map(row => (
                    <div key={`${row.product_id}-${row.level}`} className="table-row rc-prow">
                      <span data-label="Component" className={`rc-pname ${row.level ? `rc-indent${Math.min(row.level, 3)}` : ''}`}>
                        <span className="rc-item-name">{row.name}</span>
                        <span className="rc-sub">
                          {row.made_by_recipe ? 'made here — its own parts are listed below' : 'bought in'}
                          {row.for_units !== (planViews[0]?.recipe.output_qty || 1) ? ` · needed for ${fmtQty(row.for_units, '')}` : ''}
                        </span>
                      </span>
                      <span className="rc-right rc-num" data-label="Need">{fmtQty(row.need, row.unit)}</span>
                      <span className="rc-right rc-num" data-label="On hand">{row.tracked ? fmtQty(row.on_hand, row.unit) : 'not tracked'}</span>
                      <span className="rc-right rc-num" data-label="Short">{row.short ? fmtQty(row.short, row.unit) : '—'}</span>
                      <span data-label="State">
                        <Badge tone={row.tone === 'short' ? 'red' : row.tone === 'unknown' ? 'grey' : 'green'} dot={false}>
                          {row.tone === 'short' ? 'short' : row.tone === 'unknown' ? 'no count kept' : 'enough'}
                        </Badge>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              {planViews[0] && (
                <div className={`rc-verdict ${planViews[0].plan.can_run ? 'is-clear' : 'is-blocked'}`}>
                  <Icon name={planViews[0].plan.can_run ? 'shield' : 'alert'} size={14} strokeWidth={2.2} />
                  <span>
                    {planViews[0].plan.can_run
                      ? <>This run can be made <strong>{fmtQty(planViews[0].plan.buildable_units, '')} times over</strong> on the stock in hand{planViews[0].plan.untracked.length ? `, apart from ${planViews[0].plan.untracked.length} part${planViews[0].plan.untracked.length === 1 ? '' : 's'} with no count kept` : ''}.</>
                      : <>The shelf cannot cover a run — <strong>{planViews[0].plan.limited_by}</strong> is the reason. Buy it in at <Link href="/bills">bills</Link> or <Link href="/purchase-orders">purchase orders</Link>, then come back.</>}
                  </span>
                </div>
              )}
            </div>
          )}

          {orders.length > 0 && demand.length === 0 && (
            <div className="rc-note">
              <Icon name="bag" size={13} strokeWidth={2.2} />
              <span>
                You have {orders.length} confirmed order{orders.length === 1 ? '' : 's'}, none of them for a product with a live recipe.
                A recipe on the finished good turns the order register into a production plan on this board.
              </span>
            </div>
          )}
        </>
      )}

      {/* ── where used ───────────────────────────────────────────────────────── */}
      {tab === 'whereused' && (
        componentList.length === 0 ? (
          <Card>
            <EmptyState icon="search" title="No component to look up"
              message="Once a recipe has parts in it, this answers the question the catalogue cannot: if I use this drum up, which finished goods stop being makeable?" />
          </Card>
        ) : (
          <div className="rc-lookup">
            <div className="rc-lookup-rail">
              <div className="rc-lookup-rail-head">Components on the register</div>
              {componentList.map(c => (
                <button key={c.id} type="button"
                  className={`rc-lookup-item ${picked?.id === c.id ? 'is-picked' : ''}`}
                  onClick={() => setComponentId(c.id)}>
                  <span className="rc-item-name">{c.name}</span>
                  <span className="rc-sub">
                    {c.used_by} recipe{c.used_by === 1 ? '' : 's'} · {fmtQty(c.per_unit, c.unit)} per unit
                  </span>
                </button>
              ))}
            </div>

            {picked && (() => {
              const p = index.get(picked.id)
              const used = whereUsed(picked.id, store.recipes)
              const makes = store.recipes.filter(r => r.output_product_id === picked.id)
              const consumed = consumedOf(picked.id, store.builds, win.from, win.to)
              const onRuns = store.builds.filter(b => b.status === 'built' && b.date >= win.from && b.date <= win.to && b.lines.some(l => l.product_id === picked.id)).length
              return (
                <div className="rc-lookup-body">
                  <div className="rc-lookup-head">
                    <div>
                      <h2>{picked.name}</h2>
                      <p>
                        {p?.sku ? `SKU ${p.sku} · ` : ''}{p?.hsn_sac ? `HSN/SAC ${p.hsn_sac} · ` : ''}
                        {p ? (p.track_inventory === false ? 'no stock count kept here' : `${fmtQty(Number(p.current_stock) || 0, picked.unit)} on the shelf`) : 'not in the catalogue'}
                        {' · '}cost {price(p?.purchase_price)}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" icon="edit" href="/products">Product master</Button>
                  </div>

                  <div className="rc-lookup-figs">
                    <StatRow label="Recipes that draw it" value={String(used.length)} />
                    <StatRow label="Total draw per unit made" value={fmtQty(picked.per_unit, picked.unit)} />
                    <StatRow label={`Consumed ${period === 'all' ? 'on record' : `since ${formatDateIN(win.from)}`}`} strong
                      value={consumed ? `${fmtQty(consumed, picked.unit)} on ${onRuns} run${onRuns === 1 ? '' : 's'}` : '—'}
                      tone={consumed > 0 ? 'violet' : 'grey'} />
                    {p && p.track_inventory !== false && (
                      <StatRow label="Runs the shelf could still cover"
                        value={picked.per_unit > 0 ? `${Math.floor((Number(p.current_stock) || 0) / picked.per_unit)} units` : '—'}
                        tone={(Number(p.current_stock) || 0) < picked.per_unit ? 'red' : 'green'} />
                    )}
                  </div>

                  {makes.length > 0 && (
                    <div className="rc-note">
                      <Icon name="recipe" size={13} strokeWidth={2.2} />
                      <span>
                        It is also made here — {makes.length} recipe{makes.length === 1 ? '' : 's'} produce{makes.length === 1 ? 's' : ''} it,
                        so a planner treats it as a <strong>sub-assembly</strong> and looks at its own parts: {makes.map(r => r.name || 'Untitled').join(', ')}.
                      </span>
                    </div>
                  )}

                  {used.length === 0 ? (
                    <div className="rc-clear">
                      <Icon name="alert" size={14} strokeWidth={2.2} />
                      No recipe on the register draws it. It may be sold as it is, or bought and never written into a recipe.
                    </div>
                  ) : (
                    <div className="rc-lookup-list">
                      {used.map(u => {
                        const v = views.find(x => x.recipe.id === u.recipe.id)
                        const out = index.get(u.recipe.output_product_id)
                        return (
                          <div key={u.recipe.id} className="rc-used">
                            <span className="rc-used-name">
                              <button type="button" className="rc-inline" onClick={() => { setOpenRecipe(u.recipe.id); setTab('recipes'); setRecipeFilter('all'); setSearch('') }}>
                                {u.recipe.name || 'Untitled recipe'}
                              </button>
                              <span className="rc-sub">makes {fmtQty(u.recipe.output_qty, out?.unit || '')} of {out?.name || '—'} · {RECIPE_STATUS_META[u.recipe.status].label}</span>
                            </span>
                            <span className="rc-num">{fmtQty(u.per_unit, picked.unit)} / unit</span>
                            <span className="rc-sub">
                              {v ? `${fmtQty(v.units_built, '')} made on ${v.build_count} run${v.build_count === 1 ? '' : 's'}` : ''}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        )
      )}

      {/* ── shop rates ───────────────────────────────────────────────────────── */}
      {tab === 'rates' && (() => {
        const sorted = [...store.rates].sort((a, b) => (a.from_date < b.from_date ? 1 : -1))
        const todayRate = rateFor(store.rates, day)
        return (
          <>
            <div className="rc-note">
              <Icon name="scale" size={13} strokeWidth={2.2} />
              <span>
                <strong>What labour and overhead cost here, as dated rows.</strong> A recipe stores minutes; this table stores the
                ₹/hour those minutes read as, stamped with the day each figure starts applying — the way <Link href="/fx">/fx</Link> keeps
                its exchange rates. A run from last quarter is costed at the row that was in force when it ran. A rate of ₹0 is refused:
                leave the figure out if nobody records it, and the card prints a dash with the reason instead of a claim.
              </span>
            </div>

            <Card>
              <div className="rc-rate-head">
                <div>
                  <h2 className="rc-section-title">Rate rows on the register</h2>
                  <p className="rc-section-sub">
                    {todayRate
                      ? <>In force today ({formatDateIN(day)}): labour {todayRate.labour_per_hour === null ? '—' : `${money(todayRate.labour_per_hour)}/hr`} · overhead {todayRate.overhead_per_hour === null ? '—' : `${money(todayRate.overhead_per_hour)}/hr`} from {formatDateIN(todayRate.from_date)}.</>
                      : 'No row is in force today — recipes with minutes print their rate legs as dashes until one starts.'}
                  </p>
                </div>
                <Button size="sm" icon="plus" onClick={() => { setRateEdit(newRate(day)); setRateError('') }}>Add rate row</Button>
              </div>

              {sorted.length === 0 ? (
                <EmptyState icon="clock" title="No rate row yet"
                  message="Record the first dated row — the day it starts applying, what an hour of paid labour reads, and what an hour of machine, power and rent absorbs. Recipes then carry minutes and this register does the arithmetic on every load."
                  action={<Button size="sm" icon="plus" onClick={() => { setRateEdit(newRate(day)); setRateError('') }}>Add rate row</Button>} />
              ) : (
                <div className="rc-rate-list">
                  {sorted.map(r => (
                    <div key={r.id} className="rc-rate-row">
                      <span className="rc-rate-day">
                        <span className="rc-item-name">{formatDateIN(r.from_date)}</span>
                        <span className="rc-sub">from this day{r.from_date <= day ? ' · in force' : ' · not started'}</span>
                      </span>
                      <span className="rc-num">{r.labour_per_hour === null ? '—' : `${money(r.labour_per_hour)}/hr`}<span className="rc-sub"> labour</span></span>
                      <span className="rc-num">{r.overhead_per_hour === null ? '—' : `${money(r.overhead_per_hour)}/hr`}<span className="rc-sub"> overhead</span></span>
                      <span className="rc-sub rc-rate-note">{r.note || '—'}</span>
                      <span className="rc-acts">
                        <Button variant="ghost" size="sm" icon="edit" title="Edit this rate row"
                          onClick={() => { setRateEdit({ ...r }); setRateError('') }} style={{ width: 32, padding: 0 }}>{' '}</Button>
                        <Button variant="danger" size="sm" icon="x" title="Remove this rate row — runs after this day re-read from the row before it"
                          onClick={() => deleteRateRow(r)} style={{ width: 32, padding: 0 }}>{' '}</Button>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="rc-note" style={{ marginBottom: 0 }}>
                <Icon name="shield" size={13} strokeWidth={2.2} />
                <span>
                  Removing a row is not forbidden — it re-reads every run from that day at the row before it, the same way a corrected
                  price on the product master re-values its recipes. The register prints readings; the ledger is where postings live.
                </span>
              </div>
            </Card>
          </>
        )
      })()}

      <div className="rc-foot">
        <span>
          {summary.recipes} recipe{summary.recipes === 1 ? '' : 's'} · {buildList.length} run{buildList.length === 1 ? '' : 's'}
          {demand.length ? ` · ${demand.length} order line${demand.length === 1 ? '' : 's'} waiting on the shop` : ''}
          {' · '}stored in this browser, not a server: recipes hold quantities and minutes; rupees come from the catalogue&apos;s prices and the dated shop rates.
        </span>
        <span className="rc-foot-links">
          <Link href="/inventory">Shelf counts →</Link>
          <Link href="/inventory/reorder">Reorder planner →</Link>
          <Link href="/gst/job-work">Materials sent out →</Link>
          <Link href="/accounting">Stock valuation →</Link>
        </span>
      </div>

      <div className="rc-doctrine">
        <Icon name="shield" size={13} strokeWidth={2.2} />
        <span>
          <strong>Making something inside your own registered place moves no GST.</strong> The tax happens when the finished good is
          sold, at the HSN/SAC and rate of <em>that</em> good — not of its parts, which is why every card above checks the output has a
          code at all. Materials handed to somebody else to work on are a different thing entirely: that is job work, a supply on
          schedule I, and it belongs on <Link href="/gst/job-work">job work</Link> with its section 143 return clock.
          Cost here is <strong>parts plus minutes priced by your dated rate rows</strong> — a reading, not a posting: there is still no
          work-in-progress account, and nothing consumes materials by itself when an invoice is raised, because a finished unit may have
          come from opening stock or a purchase just as well as from a run. The build form, not the invoice, records what a run took.
        </span>
      </div>

      {/* ── recipe editor ────────────────────────────────────────────────────── */}
      {editor && (() => {
        const preview = recipeView(editor.recipe, store, products)
        const cycle = editor.recipe.output_product_id
          ? findCycle([...store.recipes.filter(r => r.id !== editor.recipe.id), editor.recipe], editor.recipe.output_product_id)
          : null
        const chosen = new Set(editor.recipe.components.map(c => c.product_id))
        return (
          <div className="rc-scrim" role="dialog" aria-modal="true"
            aria-label={editor.isNew ? 'New recipe' : `Edit ${editor.recipe.name}`}>
            <div className="rc-modal" style={{ maxWidth: 720 }}>
              <div className="rc-modal-head">
                <div>
                  <h2>{editor.isNew ? 'Write a recipe' : `Edit ${editor.recipe.name || 'recipe'}`}</h2>
                  <p>Quantities and minutes only. Parts are priced from the product master; labour and overhead are minutes here, priced by the dated rows on the Shop rates tab.</p>
                </div>
                <button type="button" className="rc-close" onClick={() => setEditor(null)} aria-label="Close">
                  <Icon name="x" size={16} />
                </button>
              </div>

              {editorError && (
                <div className="rc-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{editorError}</div>
              )}

              <div className="rc-grid2">
                <label className="rc-field">
                  <span>Recipe name *</span>
                  <input className="tf-input" value={editor.recipe.name} onChange={e => patchRecipe({ name: e.target.value })}
                    placeholder="Festive gift box, 250 g" autoFocus />
                </label>
                <label className="rc-field">
                  <span>Status</span>
                  <select className="tf-input" style={{ cursor: 'pointer' }} value={editor.recipe.status}
                    onChange={e => patchRecipe({ status: e.target.value as Recipe['status'] })}>
                    {RECIPE_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </label>
              </div>

              <div className="rc-grid2">
                <label className="rc-field">
                  <span>Finished product *</span>
                  <select className="tf-input" style={{ cursor: 'pointer' }} value={editor.recipe.output_product_id}
                    onChange={e => patchRecipe({ output_product_id: e.target.value })}>
                    <option value="">Select what this recipe makes…</option>
                    {products.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.unit ? ` (${p.unit})` : ''}{p.hsn_sac ? ` · ${p.hsn_sac}` : ' · no HSN/SAC'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="rc-field">
                  <span>One run makes *</span>
                  <div className="rc-inline-field">
                    <input className="tf-input" type="number" min="1" max={MAX_UNITS_PER_BUILD} step="any" value={editor.recipe.output_qty}
                      onChange={e => patchRecipe({ output_qty: Number(e.target.value) || 0 })} />
                    <span className="rc-unit">{preview.output?.unit || 'units'}</span>
                  </div>
                </label>
              </div>

              <div className="rc-grid2">
                <label className="rc-field">
                  <span>Labour minutes / run</span>
                  <input className="tf-input" type="number" min="0" max={MAX_MINUTES_PER_RUN} step="any" value={editor.recipe.labour_minutes}
                    onChange={e => patchRecipe({ labour_minutes: Number(e.target.value) || 0 })} />
                  <span className="rc-sub">paid time one run takes — priced at the labour rate in force when a run happens, never typed in rupees</span>
                </label>
                <label className="rc-field">
                  <span>Overhead minutes / run</span>
                  <input className="tf-input" type="number" min="0" max={MAX_MINUTES_PER_RUN} step="any" value={editor.recipe.overhead_minutes}
                    onChange={e => patchRecipe({ overhead_minutes: Number(e.target.value) || 0 })} />
                  <span className="rc-sub">machine, power and rent time the run absorbs — same rule, its own rate</span>
                </label>
              </div>

              <div className="rc-parts-editor">
                <div className="rc-parts-head rc-parts-head-edit">
                  <span>Component</span>
                  <span>Drawn per run</span>
                  <span>Waste %</span>
                  <span>Note</span>
                  <span />
                </div>
                {editor.recipe.components.map(c => {
                  const p = index.get(c.product_id)
                  return (
                    <div key={c.id} className="rc-part-edit">
                      <select className="tf-input" style={{ cursor: 'pointer' }} value={c.product_id}
                        onChange={e => patchComponent(c.id, { product_id: e.target.value })}>
                        <option value="">Select a component…</option>
                        {products.map(pr => (
                          <option key={pr.id} value={pr.id} disabled={pr.id !== c.product_id && (chosen.has(pr.id) || pr.id === editor.recipe.output_product_id)}>
                            {pr.name}{pr.unit ? ` (${pr.unit})` : ''}
                          </option>
                        ))}
                      </select>
                      <input className="tf-input" type="number" min="0" step="any" value={c.qty}
                        onChange={e => patchComponent(c.id, { qty: Number(e.target.value) || 0 })} />
                      <input className="tf-input" type="number" min="0" max="100" step="any" value={c.waste_pct}
                        onChange={e => patchComponent(c.id, { waste_pct: Number(e.target.value) || 0 })} />
                      <input className="tf-input" value={c.note} onChange={e => patchComponent(c.id, { note: e.target.value })}
                        placeholder="one sheet, two coats…" />
                      <button type="button" className="rc-remove" onClick={() => patchRecipe({ components: editor.recipe.components.filter(x => x.id !== c.id) })}
                        aria-label={`Remove ${p?.name || 'component'}`}>
                        <Icon name="x" size={13} />
                      </button>
                    </div>
                  )
                })}
                {editor.recipe.components.length === 0 && (
                  <p className="rc-parts-empty">Nothing in it yet — a recipe is the list of what the shop draws.</p>
                )}
                <div className="rc-add-part">
                  <Button variant="ghost" size="sm" icon="plus" onClick={() => patchRecipe({ components: [...editor.recipe.components, newComponent()] })}>
                    Add component
                  </Button>
                  <span className="rc-sub">per run, waste included on the maths · up to 200 lines</span>
                </div>
              </div>

              <label className="rc-field">
                <span>Notes</span>
                <textarea className="tf-input" rows={2} value={editor.recipe.notes} style={{ resize: 'vertical' }}
                  onChange={e => patchRecipe({ notes: e.target.value })}
                  placeholder="Sizes this version covers, the machine it runs on, the substitute when a part is out…" />
              </label>

              <div className="rc-preview">
                <div className="rc-preview-head">
                  <span>What the register reads from this</span>
                  <span className="rc-preview-total">
                    {preview.full.per_unit === null
                      ? (preview.full.missing.length ? 'no full value yet — see the gaps below' : `${price(preview.cost.per_unit)} of material per unit`)
                      : `${price(preview.full.per_unit)} a unit, parts + labour + overhead`}
                  </span>
                </div>
                <ul className="rc-preview-list">
                  <li>
                    <span className="rc-dot rc-dot-blue" />
                    {editor.recipe.components.length} component{editor.recipe.components.length === 1 ? '' : 's'} · one run makes {fmtQty(editor.recipe.output_qty, preview.output?.unit || '')}
                    {editor.recipe.labour_minutes > 0 && <> · {fmtMinutes(editor.recipe.labour_minutes)} of labour</>}
                    {editor.recipe.overhead_minutes > 0 && <> · {fmtMinutes(editor.recipe.overhead_minutes)} of overhead</>}
                    {preview.margin_per_unit !== null && <> · margin {price(preview.margin_per_unit)} ({percent(preview.margin_pct)}) at the selling price on the master{preview.margin_basis === 'material' ? ', parts alone' : ''}</>}
                  </li>
                  <li>
                    <span className={`rc-dot rc-dot-${preview.plan.can_run ? 'green' : 'amber'}`} />
                    the shelf can cover {fmtQty(preview.plan.buildable_units, '')} unit{preview.plan.buildable_units === 1 ? '' : 's'} now
                    {preview.plan.limited_by ? `, held up by ${preview.plan.limited_by}` : ''}
                  </li>
                  {preview.full.labour.missing && (
                    <li>
                      <span className="rc-dot rc-dot-amber" />
                      labour minutes recorded, but {preview.full.labour.missing} — add a rate row on the Shop rates tab
                    </li>
                  )}
                  {preview.full.overhead.missing && (
                    <li>
                      <span className="rc-dot rc-dot-amber" />
                      overhead minutes recorded, but {preview.full.overhead.missing} — add a rate row on the Shop rates tab
                    </li>
                  )}
                  {preview.cost.roll.unpriced.length > 0 && (
                    <li>
                      <span className="rc-dot rc-dot-amber" />
                      no cost recorded on {preview.cost.roll.unpriced.join(', ')} — the card prints a dash, not ₹0
                    </li>
                  )}
                  {preview.output && !preview.output.hsn_sac && (
                    <li>
                      <span className="rc-dot rc-dot-amber" />
                      the finished good has no HSN/SAC — fix it on the master before an invoice is raised
                    </li>
                  )}
                  {cycle && (
                    <li>
                      <span className="rc-dot rc-dot-red" />
                      this loops back on itself: {cycle.map(id => index.get(id)?.name || id).join(' → ')}
                    </li>
                  )}
                </ul>
              </div>

              <div className="rc-note">
                <Icon name="shield" size={13} strokeWidth={2.2} />
                A recipe with runs on the log is history — archive it rather than delete it. Nothing here is a ledger posting: the cost
                is a reading of your catalogue, and the movements of a run are written by the build form.
              </div>

              <div className="rc-save">
                <Button variant="ghost" onClick={() => setEditor(null)}>Cancel</Button>
                <Button icon="check" onClick={saveRecipe}>{editor.isNew ? 'Add recipe' : 'Save changes'}</Button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── rate editor ──────────────────────────────────────────────────────── */}
      {rateEdit && (
        <div className="rc-scrim" role="dialog" aria-modal="true" aria-label="Shop rate row">
          <div className="rc-modal" style={{ maxWidth: 560 }}>
            <div className="rc-modal-head">
              <div>
                <h2>A dated rate row</h2>
                <p>The day each figure starts applying. Runs are priced at the newest row that has started by the run&apos;s own date — a rate is never a constant.</p>
              </div>
              <button type="button" className="rc-close" onClick={() => { setRateEdit(null); setRateError('') }} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {rateError && (
              <div className="rc-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{rateError}</div>
            )}

            <label className="rc-field">
              <span>Starts applying from *</span>
              <input className="tf-input" type="date" value={rateEdit.from_date}
                onChange={e => patchRate({ from_date: e.target.value })} />
            </label>

            <div className="rc-grid2">
              <label className="rc-field">
                <span>Labour, ₹ per hour</span>
                <input className="tf-input" type="number" min="0" step="any" value={rateEdit.labour_per_hour ?? ''}
                  onChange={e => patchRate({ labour_per_hour: e.target.value === '' ? null : Number(e.target.value) })}
                  placeholder="leave out if not recorded" />
                <span className="rc-sub">paid time — the minutes recipes carry</span>
              </label>
              <label className="rc-field">
                <span>Overhead, ₹ per hour</span>
                <input className="tf-input" type="number" min="0" step="any" value={rateEdit.overhead_per_hour ?? ''}
                  onChange={e => patchRate({ overhead_per_hour: e.target.value === '' ? null : Number(e.target.value) })}
                  placeholder="leave out if not recorded" />
                <span className="rc-sub">machine, power, rent — a recipe&apos;s other minutes</span>
              </label>
            </div>

            <label className="rc-field">
              <span>Note</span>
              <input className="tf-input" value={rateEdit.note} onChange={e => patchRate({ note: e.target.value })}
                placeholder="the wage revision, the new power tariff…" />
            </label>

            <div className="rc-note">
              <Icon name="scale" size={13} strokeWidth={2.2} />
              A figure of ₹0 is refused: absence prints a dash with the reason, ₹0 prints a claim. Leave a leg out and recipes with those
              minutes read that leg as unpriced — the gap is the finding, not a zero.
            </div>

            <div className="rc-save">
              <Button variant="ghost" onClick={() => { setRateEdit(null); setRateError('') }}>Cancel</Button>
              <Button icon="check" onClick={saveRate}>Save rate row</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── build editor ─────────────────────────────────────────────────────── */}
      {draft && (
        <div className="rc-scrim" role="dialog" aria-modal="true" aria-label="Record a build">
          <div className="rc-modal" style={{ maxWidth: 760 }}>
            <div className="rc-modal-head">
              <div>
                <h2>{draftExisting ? `Edit ${draftExisting.ref}` : 'Record a run'}</h2>
                <p>The lines below are what the shop <em>drew</em>, not what the recipe hoped for. Leave a difference visible —
                  that number is wastage, and it is the reason this register exists.</p>
              </div>
              <button type="button" className="rc-close" onClick={() => setDraft(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {draftError && (
              <div className="rc-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{draftError}</div>
            )}

            <div className="rc-grid2">
              <label className="rc-field">
                <span>Recipe *</span>
                <select className="tf-input" style={{ cursor: 'pointer' }} value={draft.recipeId}
                  onChange={e => pickDraftRecipe(e.target.value)}>
                  <option value="">Select a recipe…</option>
                  {activeRecipes.map(r => (
                    <option key={r.id} value={r.id}>{r.name || 'Untitled'} — makes {fmtQty(r.output_qty, index.get(r.output_product_id)?.unit || '')}</option>
                  ))}
                  {activeRecipes.length === 0 && <option value="">No recipe is in use</option>}
                </select>
              </label>
              <label className="rc-field">
                <span>Job number</span>
                <input className="tf-input rc-mono" value={draftExisting?.ref || peekRef(store, draft.date)} readOnly
                  title="Allocated by this register, per financial year, never reused" />
              </label>
            </div>

            <div className="rc-grid2">
              <label className="rc-field">
                <span>Units made *</span>
                <input className="tf-input" type="number" min="1" max={MAX_UNITS_PER_BUILD} step="any" value={draft.units}
                  onChange={e => patchDraft({ units: e.target.value })} placeholder="0" />
              </label>
              <label className="rc-field">
                <span>Date *</span>
                <input className="tf-input" type="date" value={draft.date} max={day}
                  onChange={e => patchDraft({ date: e.target.value })} />
              </label>
            </div>

            <div className="rc-parts-editor">
              <div className="rc-parts-head rc-parts-head-draw">
                <span>Component drawn</span>
                <span>Recipe asked</span>
                <span>Drew</span>
                <span>On the shelf</span>
              </div>
              {draft.lines.map((l, i) => {
                const p = index.get(l.product_id)
                const asked = draftRecipe ? requirement(draftRecipe, Number(draft.units) || 0).find(w => w.product_id === l.product_id) : undefined
                const over = p && p.track_inventory !== false && Number(l.qty) > (Number(p.current_stock) || 0)
                return (
                  <div key={`${l.product_id}-${i}`} className="rc-draw">
                    <span className="rc-item-name">
                      {p?.name || l.product_id}
                      <span className="rc-sub">{p?.track_inventory === false ? 'no stock count kept' : `${fmtQty(Number(p?.current_stock) || 0, p?.unit || '')} on the shelf · cost ${price(p?.purchase_price)}`}</span>
                    </span>
                    <span className={`rc-num ${asked && Number(l.qty) !== asked.qty ? 'rc-over' : ''}`}>{asked ? fmtQty(asked.qty, p?.unit || '') : 'off the recipe'}</span>
                    <input className={`tf-input ${over ? 'rc-input-bad' : ''}`} type="number" min="0" step="any" value={l.qty}
                      onChange={e => patchDraft({ lines: draft.lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)) })}
                      aria-label={`Quantity drawn of ${p?.name || 'component'}`} />
                    <span className={`rc-num ${over ? 'rc-over' : 'rc-sub'}`}>{over ? 'more than the shelf holds' : '—'}</span>
                  </div>
                )
              })}
              {draft.lines.length === 0 && (
                <p className="rc-parts-empty">
                  {draftRecipe ? 'Choose a recipe and units to lay the draws out, or add them by hand for a substitute run.' : 'Pick the recipe this run was made from.'}
                </p>
              )}
              <div className="rc-add-part">
                <Button variant="ghost" size="sm" icon="repeat" onClick={fillFromRecipe}
                  disabled={!draftRecipe || !(Number(draft.units) > 0)}>Fill from recipe</Button>
                <Button variant="ghost" size="sm" icon="plus" onClick={() => {
                  const rest = products.filter(p => !draft.lines.some(l => l.product_id === p.id))
                  if (!rest[0]) return
                  patchDraft({ lines: [...draft.lines, { product_id: rest[0].id, qty: '1' }] })
                }}>Add a draw</Button>
                <span className="rc-sub">extra parts drawn — a substitute, or something the recipe forgot</span>
              </div>
            </div>

            <label className="rc-field">
              <span>Note</span>
              <input className="tf-input" value={draft.notes} onChange={e => patchDraft({ notes: e.target.value })}
                placeholder="why the drum said 1.3 kg, which order it was for…" />
            </label>

            {draftPlanRows.filter(r => r.tone === 'short').length > 0 && (
              <div className="rc-note is-hot">
                <Icon name="alert" size={13} strokeWidth={2.2} />
                <span>
                  At {fmtQty(candidate?.units || 0, '')} units the shelf is short of{' '}
                  {draftPlanRows.filter(r => r.tone === 'short').slice(0, 3).map(r => `${r.name} (${fmtQty(r.short, r.unit)})`).join(', ')}
                  {draftPlanRows.filter(r => r.tone === 'short').length > 3 ? ' and more' : ''}. Recording the run anyway would take out
                  material the count does not have.
                </span>
              </div>
            )}

            {candidate && draftCheck && (
              <div className="rc-preview">
                <div className="rc-preview-head">
                  <span>This is what gets written</span>
                  <span className="rc-preview-total">
                    {draftCheck.stamp.total === null
                      ? (draftCheck.stamp.unpriced_legs[0]
                        ? `no full value yet — ${draftCheck.stamp.unpriced_legs[0]}`
                        : `${draftCheck.stamp.unpriced.length || 'no'} component${draftCheck.stamp.unpriced.length === 1 ? '' : 's'} unpriced`)
                      : `${money(draftCheck.stamp.total)} a run${candidate.units > 0 ? ` · ${money(draftCheck.stamp.total / candidate.units)} a unit` : ''}`}
                  </span>
                </div>
                {draftCheck.writes.length === 0 ? (
                  <p className="rc-preview-empty">Nothing yet — a run with no lines moves no stock.</p>
                ) : (
                  <ul className="rc-preview-list">
                    {draftCheck.writes.map((w, i) => (
                      <li key={`${w.product_id}-${i}`}>
                        <span className={`rc-dot rc-dot-${w.quantity > 0 ? 'green' : 'red'}`} />
                        {w.movement_type === 'adjustment_in' ? 'Finished units in · ' : 'Drawn out · '}{w.product_name}
                        <span className="rc-preview-take">{w.quantity > 0 ? '+' : ''}{fmtQty(w.quantity, index.get(w.product_id)?.unit || '')}</span>
                      </li>
                    ))}
                    <li>
                      <span className="rc-dot rc-dot-blue" />
                      every row goes through the same movement RPC <Link href="/inventory">/inventory</Link> writes, under {candidate.ref} —
                      the schema has no build movement type, so the job rides in the note
                    </li>
                    {draftRecipe && (draftRecipe.labour_minutes > 0 || draftRecipe.overhead_minutes > 0) && candidate.units > 0 && draftRecipe.output_qty > 0 && (
                      <li>
                        <span className="rc-dot rc-dot-blue" />
                        not a movement — priced, not posted: {draftRecipe.labour_minutes > 0 && <>labour {fmtMinutes(draftRecipe.labour_minutes * candidate.units / draftRecipe.output_qty)}{draftCheck.stamp.labour === null ? ' with no rate in force' : ` · ${money(draftCheck.stamp.labour)}`}</>}
                        {draftRecipe.labour_minutes > 0 && draftRecipe.overhead_minutes > 0 && ' · '}
                        {draftRecipe.overhead_minutes > 0 && <>overhead {fmtMinutes(draftRecipe.overhead_minutes * candidate.units / draftRecipe.output_qty)}{draftCheck.stamp.overhead === null ? ' with no rate in force' : ` · ${money(draftCheck.stamp.overhead)}`}</>}
                        {' '}at the rates in force on {candidate.date}
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}

            {activeRecipes.length === 0 && (
              <div className="rc-alert" role="alert">
                <Icon name="alert" size={14} strokeWidth={2.2} />
                No recipe is marked in use, so there is nothing a run could be recorded against.
              </div>
            )}

            <div className="rc-save">
              <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
              <Button variant="subtle" icon="clock" onClick={() => saveBuild(false)} disabled={!!busy || !draftCheck || draftCheck.errs.length > 0}>
                {draftExisting?.status === 'planned' ? 'Save the plan' : 'Save as plan'}
              </Button>
              <Button icon="file-check" onClick={() => saveBuild(true)} disabled={!!busy || !draftCheck || !draftCheck.ok || activeRecipes.length === 0}>
                {draftExisting?.status === 'built' ? 'Movements already written' : 'Record build & move stock'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .rc-load { color: var(--muted); font-size: 13px; }
        .rc-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .rc-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .rc-select { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--faint); }
        .rc-select select { min-width: 190px; }
        .rc-period { max-width: 190px; }

        .rc-notice { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px;
          font-size: 12.5px; color: var(--green); background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 10px; }
        .rc-notice svg { flex-shrink: 0; }
        .rc-notice.is-bad { color: var(--amber); background: var(--amber-soft);
          border-color: color-mix(in srgb, var(--amber) 26%, white); }
        .rc-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; border-radius: 6px; min-height: 0; }
        .rc-notice-x:hover { background: rgba(0,0,0,0.05); }
        .rc-busy { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 9px 12px; font-size: 12.5px;
          color: var(--brand); background: var(--brand-soft); border-radius: 10px; }

        .rc-alert { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .rc-alert svg { flex-shrink: 0; }

        .rc-note { display: flex; align-items: flex-start; gap: 7px; padding: 9px 12px; border-radius: 10px; margin-bottom: 12px;
          font-size: 12px; color: var(--muted); background: var(--surface-2); border: 1px solid var(--line-soft); line-height: 1.55; }
        .rc-note svg { flex-shrink: 0; margin-top: 2px; }
        .rc-note a { color: var(--brand); }
        .rc-note strong { color: var(--ink-2); }
        .rc-note.is-hot { color: var(--red); background: var(--red-soft); border-color: color-mix(in srgb, var(--red) 22%, white); }
        .rc-note.is-hot strong { color: var(--red); }
        .rc-inline { background: none; border: none; padding: 0; font: inherit; color: var(--brand); cursor: pointer;
          text-decoration: underline; text-underline-offset: 2px; min-height: 0; }
        .rc-inline:hover { color: var(--brand-dark); }

        .rc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 12px; }
        .rc-grid-wide { grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
        .rc-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg);
          padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-xs); }
        .rc-card.is-archived { background: var(--surface-2); opacity: 0.85; }
        .rc-card.is-draft { border-style: dashed; }
        .rc-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
        .rc-card-title { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .rc-card-name { display: flex; align-items: center; gap: 7px; font-size: 14.5px; font-weight: 650; color: var(--ink); overflow-wrap: anywhere; }
        .rc-card-name svg { color: var(--brand); flex-shrink: 0; }
        .rc-card-sub { font-size: 11.5px; color: var(--faint); line-height: 1.5; }
        .rc-card-badges { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
        .rc-card-stats { display: flex; flex-direction: column; }
        .rc-card-stats > div:last-child { border-bottom: none; }
        .rc-card-foot { display: flex; align-items: center; gap: 6px; margin-top: auto; }
        .rc-card-actions { display: flex; gap: 6px; margin-left: auto; }
        .rc-archive { align-self: flex-start; background: none; border: none; padding: 0; font-size: 11px; color: var(--faint);
          cursor: pointer; text-decoration: underline; text-underline-offset: 2px; min-height: 0; }
        .rc-archive:hover { color: var(--brand); }

        .rc-share { display: flex; flex-direction: column; gap: 5px; }
        .rc-share-label { font-size: 11px; color: var(--faint); }

        .rc-findings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
        .rc-finding { display: flex; align-items: flex-start; gap: 7px; font-size: 11.5px; line-height: 1.5; }
        .rc-finding-red { color: var(--red); }
        .rc-finding-amber { color: var(--amber); }
        .rc-finding-grey { color: var(--faint); }
        .rc-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; background: var(--faint); }
        .rc-dot-red { background: var(--red); }
        .rc-dot-amber { background: var(--amber); }
        .rc-dot-green { background: var(--green); }
        .rc-dot-blue { background: var(--brand); }
        .rc-dot-grey { background: var(--faint); }

        .rc-parts { border-top: 1px dashed var(--line); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
        .rc-parts-head { display: grid; grid-template-columns: minmax(0, 1.6fr) 74px 74px 64px; gap: 8px; font-size: 10.5px;
          font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .rc-parts-head span:nth-child(n+2) { text-align: right; }
        .rc-parts-head-draw { grid-template-columns: minmax(0, 1.6fr) 92px 110px 96px; }
        .rc-parts-head-edit { grid-template-columns: minmax(0, 1.5fr) 84px 62px minmax(0, 1fr) 26px; }
        .rc-part { display: grid; grid-template-columns: minmax(0, 1.6fr) 74px 74px 64px; gap: 8px; align-items: center;
          padding: 7px 9px; background: var(--surface-2); border-radius: 9px; font-size: 12px; }
        .rc-part-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .rc-part-sub { font-size: 10.5px; color: var(--faint); }
        .rc-parts-empty { font-size: 12px; color: var(--faint); margin: 4px 0; }

        .rc-row { display: grid; grid-template-columns: 150px minmax(0, 1.3fr) 92px 120px minmax(0, 1fr) 96px 104px;
          gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .rc-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .rc-right { text-align: right; justify-content: flex-end; }
        .rc-num { font-variant-numeric: tabular-nums; color: var(--ink-2); text-align: right; }
        .rc-mono { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; }
        .rc-sub { font-size: 10.5px; color: var(--faint); line-height: 1.45; }
        .rc-item { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .rc-item-name { font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
        .rc-col-job { display: flex; flex-direction: column; gap: 2px; }
        .rc-variance { display: flex; flex-direction: column; gap: 2px; }
        .rc-acts { display: flex; gap: 6px; justify-content: flex-end; }
        .rc-over { color: var(--red); }
        .rc-under { color: var(--green); }

        .rc-run { border-bottom: 1px solid var(--line-soft); }
        .rc-run:last-child { border-bottom: none; }
        .rc-run.is-open > .rc-row { background: var(--surface-2); }
        .rc-detail { padding: 10px 14px 14px; background: var(--surface-2); border-top: 1px dashed var(--line);
          display: flex; flex-direction: column; gap: 6px; }
        .rc-detail-title { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); margin-top: 4px; }
        .rc-detail-note { font-size: 11.5px; color: var(--muted); margin: 6px 0 0; line-height: 1.5; }
        .rc-vrow { display: grid; grid-template-columns: minmax(0, 1.6fr) 1fr 1fr 90px; gap: 8px; align-items: baseline;
          font-size: 12px; padding: 5px 0; border-bottom: 1px solid var(--line-soft); }
        .rc-vrow:last-child { border-bottom: none; }

        .rc-section { margin-top: 22px; display: flex; flex-direction: column; gap: 10px; }
        .rc-section-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
        .rc-section-head h2 { display: flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 650; color: var(--ink); margin: 0; }
        .rc-section-head h2 svg { color: var(--brand); }
        .rc-section-title { font-size: 14px; font-weight: 650; color: var(--ink); margin: 0; }
        .rc-section-sub { font-size: 11.5px; color: var(--faint); max-width: 640px; line-height: 1.5; }
        .rc-section-link { font-size: 11.5px; color: var(--brand); text-decoration: none; margin-left: auto; }

        .rc-rate-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
        .rc-rate-list { display: flex; flex-direction: column; }
        .rc-rate-row { display: grid; grid-template-columns: 150px 130px 130px minmax(0, 1fr) 76px; gap: 10px; align-items: center;
          padding: 9px 4px; border-bottom: 1px solid var(--line-soft); font-size: 12.5px; }
        .rc-rate-row:last-child { border-bottom: none; }
        .rc-rate-day { display: flex; flex-direction: column; gap: 2px; }
        .rc-rate-note { overflow-wrap: anywhere; }

        .rc-demand { display: flex; flex-direction: column; gap: 9px; }
        .rc-demand-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .rc-demand-figs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; }
        .rc-demand-figs span { display: flex; flex-direction: column; font-size: 10.5px; color: var(--faint);
          background: var(--surface-2); border-radius: 8px; padding: 6px 8px; }
        .rc-demand-figs em { font-style: normal; font-size: 13px; font-weight: 650; color: var(--ink); font-variant-numeric: tabular-nums; }
        .rc-demand-hold { font-size: 11px; color: var(--amber); margin: 0; }
        .rc-demand-foot { display: flex; gap: 6px; flex-wrap: wrap; margin-top: auto; }

        .rc-short { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg);
          padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; box-shadow: var(--shadow-xs); }
        .rc-short-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
        .rc-short-qty { font-size: 12.5px; font-weight: 700; color: var(--red); font-variant-numeric: tabular-nums; }
        .rc-short-for { font-size: 11px; color: var(--faint); margin: 0; line-height: 1.5; }
        .rc-short-foot { display: flex; gap: 6px; flex-wrap: wrap; margin-top: auto; }

        .rc-recipes-strip { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
        .rc-strip { flex: 0 0 auto; display: flex; flex-direction: column; gap: 2px; text-align: left; cursor: pointer;
          background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 9px 12px; min-height: 0; }
        .rc-strip:hover { border-color: var(--brand); }

        .rc-prow { display: grid; grid-template-columns: minmax(0, 2fr) 110px 120px 100px 130px; gap: 12px;
          align-items: center; padding: 10px 14px; font-size: 12.5px; }
        .rc-phead { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .rc-pname { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .rc-indent1 { padding-left: 18px; border-left: 2px solid var(--line); }
        .rc-indent2 { padding-left: 32px; border-left: 2px solid var(--line); }
        .rc-indent3 { padding-left: 46px; border-left: 2px solid var(--line); }

        .rc-verdict { display: flex; align-items: flex-start; gap: 8px; padding: 11px 13px; border-radius: 11px; font-size: 12.5px; line-height: 1.55; }
        .rc-verdict svg { flex-shrink: 0; margin-top: 2px; }
        .rc-verdict a { color: inherit; }
        .rc-verdict.is-clear { color: var(--green); background: var(--green-soft); }
        .rc-verdict.is-blocked { color: var(--red); background: var(--red-soft); }
        .rc-clear { display: flex; align-items: center; gap: 8px; padding: 11px 13px; border-radius: 11px; font-size: 12.5px;
          color: var(--green); background: var(--green-soft); }
        .rc-clear svg { flex-shrink: 0; }

        .rc-lookup { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 12px; align-items: start; }
        .rc-lookup-rail { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg);
          padding: 10px; display: flex; flex-direction: column; gap: 4px; max-height: 620px; overflow-y: auto; }
        .rc-lookup-rail-head { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
          color: var(--faint); padding: 4px 6px 6px; }
        .rc-lookup-item { display: flex; flex-direction: column; gap: 2px; text-align: left; align-items: flex-start;
          background: none; border: none; border-left: 2px solid transparent; border-radius: 8px; padding: 7px 9px;
          cursor: pointer; font: inherit; min-height: 0; }
        .rc-lookup-item:hover { background: var(--surface-2); }
        .rc-lookup-item.is-picked { background: var(--brand-soft); border-left-color: var(--brand); }
        .rc-lookup-body { display: flex; flex-direction: column; gap: 12px; }
        .rc-lookup-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
        .rc-lookup-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); margin: 0; }
        .rc-lookup-head p { font-size: 12px; color: var(--muted); margin: 3px 0 0; line-height: 1.55; }
        .rc-lookup-figs { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 2px 14px; }
        .rc-lookup-figs > div:last-child { border-bottom: none; }
        .rc-lookup-list { display: flex; flex-direction: column; gap: 6px; }
        .rc-used { display: grid; grid-template-columns: minmax(0, 1.8fr) 120px minmax(0, 1fr); gap: 10px; align-items: center;
          padding: 9px 12px; background: var(--surface-2); border-radius: 10px; font-size: 12px; }
        .rc-used-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }

        .rc-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          font-size: 11.5px; color: var(--faint); margin-top: 20px; }
        .rc-foot-links { display: flex; gap: 12px; flex-wrap: wrap; }
        .rc-foot-links a { color: var(--brand); text-decoration: none; }

        .rc-doctrine { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 12px 14px;
          border: 1px solid var(--line-soft); border-radius: 12px; background: var(--surface-2);
          font-size: 11.5px; color: var(--muted); line-height: 1.6; }
        .rc-doctrine svg { flex-shrink: 0; margin-top: 2px; color: var(--brand); }
        .rc-doctrine strong { color: var(--ink-2); }
        .rc-doctrine em { font-style: italic; color: var(--ink-2); }
        .rc-doctrine a { color: var(--brand); }

        .rc-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .rc-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .rc-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .rc-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); margin: 0; }
        .rc-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; max-width: 560px; line-height: 1.5; }
        .rc-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; flex-shrink: 0; min-height: 0; }
        .rc-close:hover { background: var(--slate-soft); color: var(--ink-2); }

        .rc-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
        .rc-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
        .rc-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .rc-inline-field { display: flex; align-items: center; gap: 8px; }
        .rc-inline-field input { flex: 1; }
        .rc-unit { font-size: 11.5px; color: var(--faint); white-space: nowrap; }

        .rc-parts-editor { display: flex; flex-direction: column; gap: 8px; padding: 11px 12px;
          border: 1px solid var(--line); border-radius: 12px; background: var(--surface-2); }
        .rc-part-edit { display: grid; grid-template-columns: minmax(0, 1.5fr) 84px 62px minmax(0, 1fr) 26px; gap: 8px; align-items: center; }
        .rc-draw { display: grid; grid-template-columns: minmax(0, 1.6fr) 92px 110px 96px; gap: 8px; align-items: center; }
        .rc-draw .rc-item-name { display: flex; flex-direction: column; gap: 2px; }
        .rc-input-bad { border-color: var(--red) !important; }
        .rc-remove { background: none; border: 1px solid var(--line); border-radius: 8px; color: var(--faint); cursor: pointer;
          width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; min-height: 0; }
        .rc-remove:hover { color: var(--red); border-color: var(--red); }
        .rc-add-part { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

        .rc-preview { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--surface-2); }
        .rc-preview-head { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); flex-wrap: wrap; }
        .rc-preview-total { color: var(--brand); font-variant-numeric: tabular-nums; font-weight: 650; }
        .rc-preview-empty { font-size: 12.5px; color: var(--faint); margin: 8px 0 0; }
        .rc-preview-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .rc-preview-list li { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; color: var(--ink-2); line-height: 1.5; }
        .rc-preview-list a { color: var(--brand); }
        .rc-preview-take { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 650; color: var(--ink); }

        .rc-save { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }

        @media (max-width: 1100px) {
          .rc-stats { grid-template-columns: 1fr 1fr; }
          .rc-lookup { grid-template-columns: 1fr; }
          .rc-lookup-rail { max-height: 260px; }
        }
        @media (max-width: 768px) {
          .rc-row, .rc-prow { grid-template-columns: 1fr; gap: 6px; }
          .rc-head, .rc-phead { display: none; }
          .rc-right { text-align: left; justify-content: flex-start; }
          .rc-num { text-align: left; }
          .rc-acts { justify-content: flex-start; }
          .rc-stats { grid-template-columns: 1fr 1fr; }
          .rc-grid, .rc-grid-wide { grid-template-columns: 1fr; }
          .rc-grid2, .rc-part, .rc-parts-head, .rc-parts-head-edit, .rc-parts-head-draw, .rc-part-edit, .rc-draw, .rc-vrow, .rc-used { grid-template-columns: 1fr; }
          .rc-rate-row { grid-template-columns: 1fr 1fr; }
          .rc-parts-head span:nth-child(n+2) { text-align: left; }
          .rc-parts-head { display: none; }
          .rc-scrim { align-items: flex-end; padding: 0; }
          .rc-scrim .rc-modal { max-width: none !important; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .rc-save { flex-direction: column-reverse; }
          .rc-indent1, .rc-indent2, .rc-indent3 { padding-left: 10px; }
        }
      `}</style>
    </div>
  )
}

export default function RecipesPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <RecipesPageInner />
    </Suspense>
  )
}
