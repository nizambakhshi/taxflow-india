// Work-in-progress for a build — the run's own cost handed to the journal as drafts.
//
// Why this exists: the comparison table has carried the sentence since R2-24 — *no work-in-progress
// account (a priced reading, not a posting)* — and §11 kept naming the blocker honestly: a posting
// engine, "and a posting engine is `/journal`, a different register". `/journal` shipped at R3-2b
// and footed itself at R3-14, so the blocker is gone and this library is what the shop was waiting
// for: the labour and overhead minutes the recipe book prices from dated shop rates, and the
// material value the catalogue reads, stop being a screen-only figure and become entries the
// statements can fold — **if and only if the shop asks for them, in their own words, through the
// journal register's own door.**
//
// The shape is two balanced entries per run, landed as **drafts**, never postings:
//
//   * *the run* — debit **Work-in-progress** for the run's whole cost, credit **raw stock** for the
//     material, and (only when the shop names a time head) credit that head for the labour and
//     overhead the run read on its own date;
//   * *the finish* — debit **finished stock** and credit **Work-in-progress** for the same total.
//
// A build in this register is one event that both consumed and produced, so WIP nets to nil across
// the pair — which is exactly what a completed run *is*: work that passed through. The pair is the
// honesty of the design: capitalising the time without a raw-stock credit would inflate stock by a
// rupee nobody spent, and crediting an expense head that never carried those wages would *reduce*
// an expense line that was never raised. That last sentence is why the time leg is **opt-in on a
// head the shop picks**: the engine refuses to know which of the shop's expense heads holds real
// wages, and an invented one is the kind of rupee this app prints a dash for elsewhere.
//
// What this library deliberately is NOT:
//
//  * **Not a writer.** `wipPlan` is a pure reading; the page hands its legs to `journal.ts`'s own
//    `writeEntry`, which asks the period seal (R3-5) *before* anything is checked and refuses a
//    sealed build date in the seal's own words. No number is burned here — a draft takes its JR
//    number when the shop posts it on `/journal`, and the same job number the movement notes carry
//    travels in the entry's `reference` so the paper and the shelf always tie.
//  * **Not a head-creator.** R3-8's import rule holds for this door too: every leg names a head
//    that already stands on the journal register. A shop with no WIP heads is *told* what to name
//    and sent to `/journal` — this file never calls `writeHead`.
//  * **Not an inventory valuation.** `/accounting` values stock its own way; these entries move the
//    journal's stock-slot lines and are a *second reading* the shop owns, printed beside the first.
//    Nothing here reaches a return (Rules 41/43: a journal row is bookkeeping, not Indian law —
//    hence no citation block in this file, by R3-14's precedent).
//
// All arithmetic is paise through `journal.ts`'s `paise()`, so a rupee cannot round differently on
// the two sides of the same entry, and a run with an unpriced part or an unpriced time leg prints
// **refusals with reasons** — never a partial total, never a zero where a number is missing.

import {
  fullCostOfBuild,
  type BomProduct, type Build, type CostRate, type Recipe,
} from '@/lib/bom'
import { plural } from '@/lib/format'
import {
  SLOT_META, paise,
  type JournalEntry, type JournalHead, type JournalStore, type LegSide, type StatementSlot,
} from '@/lib/journal'

// ── the roles a run's cost needs ──────────────────────────────────────────────

/** The four places a build's rupee can land. `time` is the only optional one. */
export type WipRole = 'wip' | 'raw' | 'finished' | 'time'

export const WIP_ROLES: WipRole[] = ['wip', 'raw', 'finished', 'time']

export interface RoleMeta {
  label: string
  /** The statement line the head must stand on — checked, never guessed past. */
  slot: 'inventory' | 'expense-group'
  required: boolean
  /** What the picker prints when the shop has to go and name a head first. */
  ask: string
}

export const ROLE_META: Record<WipRole, RoleMeta> = {
  wip: {
    label: 'Work-in-progress', slot: 'inventory', required: true,
    ask: 'Name a Stock-on-hand head for work-in-progress on /journal first — it is the account the run passes through.',
  },
  raw: {
    label: 'Raw stock', slot: 'inventory', required: true,
    ask: 'Name the Stock-on-hand head your materials sit in on /journal first — the run takes its rupee out of that line.',
  },
  finished: {
    label: 'Finished stock', slot: 'inventory', required: true,
    ask: 'Name the Stock-on-hand head the finished units land in on /journal first — that is where the run ends up.',
  },
  time: {
    label: 'Shop time (labour + overhead)', slot: 'expense-group', required: false,
    ask: 'Optional: only pick an expense head that actually carries these wages in your books — crediting one that never raised them would shrink an expense line that was never there.',
  },
}

/** The head ids the shop picked, role by role. `''` for `time` means "do not capitalise it". */
export interface WipPicks {
  wip: string
  raw: string
  finished: string
  time: string
}

export function emptyPicks(): WipPicks {
  return { wip: '', raw: '', finished: '', time: '' }
}

/** Which slots a role's picker may offer — read off the journal's own metadata. */
export function roleSlots(role: WipRole, all: StatementSlot[]): StatementSlot[] {
  const meta = ROLE_META[role]
  if (meta.slot === 'inventory') return all.filter(s => s === 'inventory')
  return all.filter(s => SLOT_META[s].group === 'expense')
}

export function headFitsRole(head: JournalHead | undefined, role: WipRole): boolean {
  if (!head) return false
  const meta = ROLE_META[role]
  if (meta.slot === 'inventory') return head.slot === 'inventory'
  return SLOT_META[head.slot].group === 'expense'
}

// ── the plan ──────────────────────────────────────────────────────────────────

export interface WipLeg {
  side: LegSide
  role: WipRole
  headId: string
  /** Rupees, always positive — the side carries the direction, never the sign (Rule 28). */
  amount: number
  /** The sentence this rupee was read from — printed beside the leg, never recomputed by the page. */
  basis: string
}

export interface WipEntryPlan {
  /** Which of the pair this is. */
  kind: 'run' | 'finish'
  date: string
  reference: string
  narration: string
  legs: WipLeg[]
  /** What this entry debits (equals what it credits — checked before anything is returned). */
  total: number
  balanced: boolean
}

export interface WipPlan {
  build_ref: string
  /** The run's own date — both entries are dated the day the work happened, not the day asked. */
  date: string
  run: WipEntryPlan | null
  finish: WipEntryPlan | null
  /** Every reason this run cannot reach the journal *now*, in the engine's own sentences. */
  refusals: string[]
  /** The three rupees the reading is made of, each null where it could not be read. */
  material: number | null
  labour: number | null
  overhead: number | null
  /** Whether the shop asked for the time leg at all. */
  capitalise_time: boolean
  /** The leg-level basis sentence for the time rupee, whether or not it is in the plan. */
  time_note: string
  /** What the pair does to WIP: 'nil' when both entries stand, so the page can say it in one word. */
  wip_nets: 'nil' | 'not_planned'
}

function r2(paiseSum: number): number {
  return paiseSum / 100
}

/**
 * The whole reading: does this run have a posting to make, and what would it say?
 * Pure — takes the register data in, returns legs or reasons, touches no storage, asks no seal
 * (the seal is `writeEntry`'s door, and it refuses a sealed build date exactly as it refuses a
 * typed entry dated there).
 */
export function wipPlan(
  build: Build,
  recipe: Recipe | undefined,
  products: BomProduct[],
  rates: CostRate[],
  picks: WipPicks,
  store: JournalStore,
): WipPlan {
  const refusals: string[] = []
  const full = fullCostOfBuild(build, recipe, products, rates)
  const capitalise = picks.time !== ''

  // A run is only work-in-progress if it physically happened. A plan has consumed nothing; a
  // cancelled run gave it back. Both are refused the same way the stock ledger refuses them —
  // by saying so, not by writing zero.
  if (build.status !== 'built') {
    refusals.push(build.status === 'planned'
      ? `${build.ref} is still a plan — nothing has been consumed, so there is no work to carry into progress.`
      : `${build.ref} was cancelled — the materials went back, and a journal of a run that gave them back would describe a shelf that is not there.`)
  }
  if (build.status === 'built' && !build.moved) {
    refusals.push(`${build.ref} is marked built but its movements never reached the stock ledger — the books should not carry a run the shelf has not seen.`)
  }

  // The rupees. A missing one is a refusal with a name, never a hole in a total.
  const materialP = full.material.value === null ? null : paise(full.material.value)
  if (materialP === null) {
    refusals.push(
      `This run has no material value — ${plural(full.material.unpriced.length, 'component')} ${full.material.unpriced.length === 1 ? 'carries' : 'carry'} no price (${full.material.unpriced.join(', ')}). A posting never invents one.`,
    )
  }
  let timeP: number | null = 0
  if (capitalise) {
    if (full.labour.value === null && full.labour.minutes > 0) {
      refusals.push(`You asked to capitalise shop time, but the labour leg has no rate — ${full.labour.missing}.`)
    } else if (full.overhead.value === null && full.overhead.minutes > 0) {
      refusals.push(`You asked to capitalise shop time, but the overhead leg has no rate — ${full.overhead.missing}.`)
    } else {
      timeP = paise(full.labour.value ?? 0) + paise(full.overhead.value ?? 0)
      if (timeP <= 0) {
        refusals.push('The recipe carries no minutes, so there is no shop time to capitalise — leave the time head unpicked instead.')
      }
    }
  }

  // The heads: on the register, open, right slot, each one used once.
  const roleOrder: WipRole[] = capitalise ? ['wip', 'raw', 'finished', 'time'] : ['wip', 'raw', 'finished']
  const seen = new Map<string, WipRole>()
  for (const role of roleOrder) {
    const id = picks[role]
    if (!id) {
      if (ROLE_META[role].required) refusals.push(ROLE_META[role].ask)
      continue
    }
    const head = store.heads.find(h => h.id === id)
    if (!head) {
      refusals.push(`The ${ROLE_META[role].label.toLowerCase()} pick names a head that is not on the journal register — pick one that stands there.`)
      continue
    }
    if (!head.active) {
      refusals.push(`${head.name} is closed — a closed head is not offered a new rupee. Reopen it on /journal or pick another.`)
      continue
    }
    if (!headFitsRole(head, role)) {
      refusals.push(`${head.name} sits on "${SLOT_META[head.slot].label}" — ${ROLE_META[role].label} has to move ${ROLE_META[role].slot === 'inventory' ? 'the Stock-on-hand line' : 'an expense line'}. Pick a head whose declared line fits, or rename its slot on /journal.`)
      continue
    }
    const clash = seen.get(id)
    if (clash) {
      refusals.push(`${head.name} was picked for both ${ROLE_META[clash].label} and ${ROLE_META[role].label} — one head cannot hand a rupee to itself across the pair.`)
      continue
    }
    seen.set(id, role)
  }

  const timeMinutes = full.labour.minutes + full.overhead.minutes
  const timeNote = capitalise
    ? `labour ${full.labour.value === null ? '—' : `₹${full.labour.value}`} + overhead ${full.overhead.value === null ? '—' : `₹${full.overhead.value}`} for ${plural(timeMinutes, 'minute')} at the rates in force on ${build.date}`
    : 'shop time stays a reading — the run posts its material only'

  if (refusals.length > 0 || materialP === null) {
    return {
      build_ref: build.ref, date: build.date, run: null, finish: null, refusals,
      material: full.material.value, labour: full.labour.value, overhead: full.overhead.value,
      capitalise_time: capitalise, time_note: timeNote, wip_nets: 'not_planned',
    }
  }

  const totalP = materialP + (timeP ?? 0)
  if (totalP <= 0) {
    return {
      build_ref: build.ref, date: build.date, run: null, finish: null,
      refusals: ['The run reads as no rupee at all — a leg of ₹0 says nothing. Fix the reading before the posting.'],
      material: full.material.value, labour: full.labour.value, overhead: full.overhead.value,
      capitalise_time: capitalise, time_note: timeNote, wip_nets: 'not_planned',
    }
  }

  const runLegs: WipLeg[] = [
    {
      side: 'debit', role: 'wip', headId: picks.wip, amount: r2(totalP),
      basis: `material ${full.material.value}${timeP ? ` + shop time ${r2(timeP)}` : ''}, each leg read on the run's own date (${build.date})`,
    },
    {
      side: 'credit', role: 'raw', headId: picks.raw, amount: r2(materialP),
      basis: "the drawn quantities at the prices the catalogue carries today — the register's own material reading",
    },
  ]
  if (capitalise && timeP) {
    runLegs.push({
      side: 'credit', role: 'time', headId: picks.time, amount: r2(timeP),
      basis: timeNote,
    })
  }
  const finishLegs: WipLeg[] = [
    {
      side: 'debit', role: 'finished', headId: picks.finished, amount: r2(totalP),
      basis: 'what the run cost, handed on the day it was made',
    },
    {
      side: 'credit', role: 'wip', headId: picks.wip, amount: r2(totalP),
      basis: 'the same rupee the run put into work — this is what closes it',
    },
  ]

  const runEntry: WipEntryPlan = {
    kind: 'run', date: build.date, reference: build.ref,
    narration: `Build ${build.ref}${recipe?.name ? ` (${recipe.name})` : ''}: materials${capitalise ? ' and shop time' : ''} into work-in-progress`,
    legs: runLegs, total: r2(totalP),
    balanced: runLegs.filter(l => l.side === 'debit').reduce((s, l) => s + paise(l.amount), 0)
      === runLegs.filter(l => l.side === 'credit').reduce((s, l) => s + paise(l.amount), 0),
  }
  const finishEntry: WipEntryPlan = {
    kind: 'finish', date: build.date, reference: build.ref,
    narration: `Build ${build.ref}${recipe?.name ? ` (${recipe.name})` : ''}: finished cost out of work-in-progress`,
    legs: finishLegs, total: r2(totalP), balanced: true,
  }
  return {
    build_ref: build.ref, date: build.date, run: runEntry, finish: finishEntry, refusals: [],
    material: full.material.value, labour: full.labour.value, overhead: full.overhead.value,
    capitalise_time: capitalise, time_note: timeNote, wip_nets: 'nil',
  }
}

// ── the tie back: what the journal already holds for a run ────────────────────

export type WipPaperState = 'none' | 'drafted' | 'posted' | 'partial' | 'reversed'

export interface WipPaper {
  state: WipPaperState
  /** Every entry that carries this job number in its `reference` — both halves of the pair, and any reversal. */
  entries: JournalEntry[]
  drafts: number
  posted: number
  reversed: number
  /** One sentence the page prints beside the state. */
  note: string
}

/**
 * The fold that answers *has this run reached the books*. The tie is the job number the run was
 * named by — the same string the movement notes carry — so `/journal` and `/inventory/recipes`
 * cannot disagree about which entry belongs to which shelf event.
 */
export function wipPaper(store: JournalStore, ref: string): WipPaper {
  const entries = store.entries.filter(e => e.reference === ref)
  const drafts = entries.filter(e => e.status === 'draft').length
  const reversed = entries.filter(e => e.status === 'reversed').length
  const posted = entries.filter(e => e.status === 'posted').length
  let state: WipPaperState = 'none'
  let note = 'no journal row carries this job number yet'
  if (entries.length === 0) {
    // leave as none
  } else if (drafts > 0 && posted === 0 && reversed === 0) {
    state = 'drafted'
    note = `${plural(drafts, 'draft')} on the journal — post them there to give them a number`
  } else if (posted > 0 && drafts === 0 && reversed === 0) {
    state = 'posted'
    note = `${posted} posted — the statements fold them${posted === 2 ? ' and the pair nets WIP to nothing' : ''}`
  } else if (reversed > 0) {
    state = 'reversed'
    note = `${reversed} reversed${posted ? `, ${posted} still standing beside ${drafts ? 'and ' : ''}` : drafts ? ' and ' : ''}${drafts ? `${plural(drafts, 'draft')}` : ''} — the trail keeps both halves`
  } else {
    state = 'partial'
    note = `${posted} posted and ${drafts} still drafted — the pair is not whole yet`
  }
  return { state, entries, drafts, posted, reversed, note }
}

/** The sentence a cancelled run with live paper has to be shown. */
export function wipCancelNote(paper: WipPaper): string {
  if (paper.entries.length === 0) return ''
  if (paper.drafts > 0 && paper.posted === 0 && paper.reversed === 0) {
    return 'The run was cancelled — its journal drafts are still open. Delete them on /journal before the plan reads as money.'
  }
  if (paper.posted > 0 && paper.reversed === 0) {
    return 'The run was cancelled but its journal entries are posted — reverse them on /journal; the books keep both halves and the pair nets to nothing.'
  }
  if (paper.posted > 0 && paper.reversed < paper.posted) {
    return 'The run was cancelled and only part of its paper has been reversed — /journal still shows a standing posting for a run the shelf gave back.'
  }
  return ''
}

// ── the boundaries the page prints, in the library's own voice ────────────────

export const WIP_BOUNDARIES: string[] = [
  'These are drafts until you post them. Posting takes the JR number on /journal — a draft burns no number and punches no hole in a series.',
  'The build\'s own date is the entry\'s date, so a sealed period refuses this exactly as it refuses a typed entry dated there.',
  'Capitalising shop time credits an expense head. Only pick one that actually carries these wages — otherwise the credit shrinks an expense line that was never raised, and profit reads larger than the shop.',
  'The material rupee is today\'s catalogue reading — there is no price history in this schema — so a posting taken months later can differ from the figure the screen printed on the day. The narration names the run, the reference is its job number; the reading beside the leg says what it was based on.',
  'Nothing here files, pays or receipts anything, and no return reads a journal row. This is the shop naming its own work, in the register that already names everything the documents cannot carry.',
]

/** The four role sentences the picker card prints, in one list the suite can pin. */
export function wipPickerHints(): string[] {
  return WIP_ROLES.map(r => `${ROLE_META[r].label}: ${ROLE_META[r].ask}`)
}
