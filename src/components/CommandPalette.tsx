'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import Icon from '@/components/Icons'
import {
  ENTITY_SPECS, RECORDS_PER_GROUP, SUPABASE_RECORD_ORDER,
  buildActionCommands, buildPageCommands, clampIndex, flattenVisible, groupBySection,
  isActiveHref, loadRecents, nextIndex, normalizeQuery, orFilter, orderRecordCommands, registerRecordCommands,
  pushRecent, rankCommands, toCommand,
  type Command, type EntityKind, type EntityRow,
} from '@/lib/commands'

const DEBOUNCE_MS = 150
const MIN_QUERY = 2

interface Props {
  orgId: string
  pathname: string
  open: boolean
  setOpen: (v: boolean) => void
}

export default function CommandPalette({ orgId, pathname, open, setOpen }: Props) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const inputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const openRef = useRef(open)
  const cache = useRef(new Map<string, Command[]>())
  // Responses are matched to the newest query, so a slow table cannot overwrite
  // results the user has already moved past.
  const batch = useRef(0)

  const [query, setQuery] = useState('')
  const [recents, setRecents] = useState<Command[]>([])
  const [records, setRecords] = useState<Command[]>([])
  const [pending, setPending] = useState<Set<EntityKind>>(new Set())
  const [active, setActive] = useState(0)

  const pages = useMemo(() => buildPageCommands(), [])
  const actions = useMemo(() => buildActionCommands(), [])

  useEffect(() => { openRef.current = open }, [open])

  useEffect(() => {
    if (!open) {
      cache.current.clear()
      return
    }
    setRecents(loadRecents(orgId))
    setQuery('')
    setActive(0)
    setRecords([])
    setPending(new Set())
    // Tab is trapped inside the panel, so the element that opened it gets focus
    // back on close — otherwise the keyboard user lands on <body>.
    const opener = document.activeElement as HTMLElement | null
    const id = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => {
      window.clearTimeout(id)
      if (opener && document.contains(opener)) opener.focus()
    }
  }, [open, orgId])

  // The only keyboard surface in the app: ⌘K opens, Escape closes. Bound here so
  // there is one place to look when a shortcut misbehaves.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(!openRef.current)
      } else if (e.key === 'Escape' && openRef.current) {
        // Page modals below do not listen for Escape; stop it reaching them.
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setOpen])

  // Lock the page behind, compensating for the scrollbar the rail would jump by.
  useEffect(() => {
    if (!open) return
    const body = document.body
    const prevOverflow = body.style.overflow
    const prevPadding = body.style.paddingRight
    const gap = window.innerWidth - document.documentElement.clientWidth
    body.style.overflow = 'hidden'
    if (gap > 0) body.style.paddingRight = `${gap}px`
    return () => {
      body.style.overflow = prevOverflow
      body.style.paddingRight = prevPadding
    }
  }, [open])

  useEffect(() => {
    if (!open || !orgId) return
    const q = normalizeQuery(query)
    if (q.length < MIN_QUERY) {
      setRecords([])
      setPending(new Set())
      return
    }
    const cached = cache.current.get(q)
    if (cached) {
      setRecords(cached)
      setPending(new Set())
      return
    }

    const id = ++batch.current
    setPending(new Set(SUPABASE_RECORD_ORDER))

    const timer = window.setTimeout(async () => {
      const settled: Command[] = []
      const done = new Set<EntityKind>()
      await Promise.all(SUPABASE_RECORD_ORDER.map(async entity => {
        const spec = ENTITY_SPECS[entity]
        const or = orFilter(entity, q)
        if (!or) return
        const base = supabase.from(spec.table).select(spec.columns).eq('organization_id', orgId)
        const filtered = spec.life === 'document' ? base.neq('status', 'cancelled') : base.eq('is_active', true)
        const { data, error } = await filtered
          .or(or)
          .order(spec.order, { ascending: spec.orderAsc })
          .limit(RECORDS_PER_GROUP)
        if (id !== batch.current) return
        done.add(entity)
        if (!error) {
          // The select list is built at runtime, so postgrest's types fall back to
          // an error shape; the columns are declared in ENTITY_SPECS.
          const rows = ((data || []) as unknown as EntityRow[])
            .map(r => toCommand(entity, r))
            .filter((c): c is Command => c !== null)
          settled.push(...rows)
        }
        setPending(new Set(done))
      }))
      if (id !== batch.current) return
      cache.current.set(q, settled)
      setRecords(settled)
      setPending(new Set())
    }, DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [query, open, orgId, supabase])

  // Order-flow documents (challans, sales/purchase orders) live in localStorage,
  // so they match synchronously — no debounce, no spinner, same ranker as the rest.
  const localRecords = useMemo(
    () => (open && normalizeQuery(query).length >= MIN_QUERY
      ? [...orderRecordCommands(orgId, query), ...registerRecordCommands(orgId, query)] : []),
    [open, query, orgId]
  )

  const ranked = useMemo(() => {
    const pool = [...recents, ...actions, ...pages, ...localRecords, ...records]
    return normalizeQuery(query) ? rankCommands(query, pool) : pool
  }, [query, recents, actions, pages, localRecords, records])

  const groups = useMemo(() => groupBySection(ranked), [ranked])
  const visible = useMemo(() => flattenVisible(groups), [groups])
  const positions = useMemo(() => {
    const m = new Map<Command, number>()
    visible.forEach((c, i) => m.set(c, i))
    return m
  }, [visible])

  useEffect(() => { setActive(a => clampIndex(a, visible.length)) }, [visible.length])
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }) }, [active])

  const run = useCallback((cmd: Command) => {
    if (cmd.href === pathname) { setOpen(false); return }
    setRecents(pushRecent(orgId, cmd))
    setOpen(false)
    router.push(cmd.href)
  }, [orgId, pathname, router, setOpen])

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Tab') { e.preventDefault(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => nextIndex(a, visible.length, 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => nextIndex(a, visible.length, -1)) }
    else if (e.key === 'Enter') { e.preventDefault(); const cmd = visible[active]; if (cmd) run(cmd) }
  }

  if (!open) return null
  const searching = pending.size > 0
  const q = normalizeQuery(query)
  const activeCmd = visible[active]
  const activeTitle = activeCmd ? groups.find(g => g.items.includes(activeCmd))?.title ?? '' : ''

  return (
    <div
      className="tf-cmd-layer"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={() => setOpen(false)}
    >
      <div className="tf-cmd" onClick={e => e.stopPropagation()}>
        <div className="tf-cmd-bar">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            className="tf-cmd-input"
            value={query}
            onChange={e => { setQuery(e.target.value); setActive(0) }}
            onKeyDown={onInputKey}
            role="combobox"
            aria-expanded="true"
            aria-controls="tf-cmd-listbox"
            aria-autocomplete="list"
            aria-label="Search pages, invoices, parties and products"
            placeholder="Search pages, invoice numbers, GSTIN, parties…"
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="search"
          />
          {query ? (
            <button type="button" className="tf-cmd-clear" onClick={() => setQuery('')} aria-label="Clear search">
              <Icon name="x" size={15} />
            </button>
          ) : (
            <kbd className="tf-cmd-kbd">esc</kbd>
          )}
        </div>

        <div
          id="tf-cmd-listbox"
          className="tf-cmd-list"
          role="listbox"
          aria-label="Results"
          aria-activedescendant={visible.length ? `tf-cmd-opt-${active}` : undefined}
        >
          {groups.map(group => (
            <div key={group.title} className="tf-cmd-section" role="group" aria-label={group.title}>
              <div className="tf-cmd-group">
                {group.title}
                {group.entity && pending.has(group.entity) && <span className="tf-cmd-spin" aria-hidden="true" />}
              </div>

              {group.items.map(cmd => {
                const i = positions.get(cmd) ?? -1
                const here = cmd.kind === 'page' && isActiveHref(pathname, cmd.href)
                return (
                  <div
                    key={cmd.id}
                    id={`tf-cmd-opt-${i}`}
                    ref={i === active ? activeRef : null}
                    role="option"
                    aria-selected={i === active}
                    className={`tf-cmd-row ${i === active ? 'is-active' : ''}`}
                    data-kind={cmd.kind}
                    onMouseMove={() => setActive(i)}
                    onClick={() => run(cmd)}
                  >
                    <span className="tf-cmd-icon"><Icon name={cmd.icon} size={16} /></span>
                    <span className="tf-cmd-text">
                      <span className="tf-cmd-label">{cmd.label}</span>
                      {cmd.sublabel && <span className="tf-cmd-sub">{cmd.sublabel}</span>}
                    </span>
                    {here
                      ? <span className="tf-cmd-tag is-here">Here</span>
                      : cmd.badge ? <span className="tf-cmd-tag">{cmd.badge}</span> : null}
                  </div>
                )
              })}

              {/* Loaders hold the height real results will take, so nothing jumps. */}
              {group.entity && pending.has(group.entity) && !group.items.length && (
                <>
                  <div className="tf-cmd-row is-busy" aria-hidden="true">
                    <span className="tf-cmd-icon" />
                    <span className="tf-cmd-sk" style={{ width: 168 }} />
                    <span className="tf-cmd-sk" style={{ width: 96, marginLeft: 'auto' }} />
                  </div>
                  <div className="tf-cmd-row is-busy" aria-hidden="true">
                    <span className="tf-cmd-icon" />
                    <span className="tf-cmd-sk" style={{ width: 124 }} />
                    <span className="tf-cmd-sk" style={{ width: 76, marginLeft: 'auto' }} />
                  </div>
                </>
              )}

              {group.moreHref && q && (
                <button
                  type="button"
                  className="tf-cmd-more"
                  onClick={() => { setOpen(false); router.push(group.moreHref!) }}
                >
                  {group.moreLabel} <Icon name="arrow-right" size={13} />
                </button>
              )}
            </div>
          ))}

          {!groups.length && (
            <div className="tf-cmd-none">
              {searching
                ? 'Searching your books…'
                : <>No match for <strong>“{query}”</strong> — try an invoice number, GSTIN or party name.</>}
              {/* The boundary R3-15's drive found: a period nobody recorded is not a record, so no record
                  search can reach it. Month names now route to the two pages that print those periods, and
                  this says where the rest live rather than leaving "nothing found" as a claim about the
                  books. */}
              {!searching && <div className="tf-cmd-none-sub">The palette reads pages, actions and the records on this device — a due date nobody wrote down is not missing, it is computed, and the Compliance Calendar prints it.</div>}
            </div>
          )}
        </div>

        <div className="tf-cmd-foot">
          <span><kbd className="tf-cmd-kbd">↑</kbd><kbd className="tf-cmd-kbd">↓</kbd> move</span>
          <span><kbd className="tf-cmd-kbd">⏎</kbd> open</span>
          <span><kbd className="tf-cmd-kbd">esc</kbd> close</span>
          <span className="tf-cmd-foot-hint">Documents open themselves; parties, products and other names open their list, filtered.</span>
        </div>

        <span className="tf-cmd-live" aria-live="polite">
          {activeCmd ? `${activeCmd.label}, ${activeTitle}` : ''}
        </span>
      </div>
    </div>
  )
}
