'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'

/**
 * A list page's search box, seeded from ?q= so a command-palette row lands on a
 * filtered list rather than the whole table. Typing never rewrites the URL — only
 * an inbound link sets it, and arriving without one clears the box.
 */
export function useSearchDeepLink(): [string, (value: string) => void] {
  const params = useSearchParams()
  const inbound = params?.get('q') ?? ''
  const [search, setSearch] = useState(inbound)

  useEffect(() => { setSearch(inbound) }, [inbound])

  return [search, setSearch]
}

/** Matches the palette's own `.or(...)` columns, so a hit never lands on emptiness. */
export function matchesAny(needle: string, fields: (string | null | undefined)[]): boolean {
  const q = needle.trim().toLowerCase()
  if (!q) return true
  return fields.some(f => String(f ?? '').toLowerCase().includes(q))
}
