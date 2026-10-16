import { formatINR } from '@/lib/gst-engine'

/** ₹1,23,456 → "₹1.23L"; keeps lakh/crore units businesses actually read. */
export function formatCompactINR(amount: number): string {
  const n = Math.abs(amount)
  const sign = amount < 0 ? '-' : ''
  if (n < 1000) return `${sign}₹${formatINR(amount)}`
  if (n < 100000) return `${sign}₹${trim(n / 1000)}K`
  if (n < 10000000) return `${sign}₹${trim(n / 100000)}L`
  return `${sign}₹${trim(n / 10000000)}Cr`
}

function trim(v: number): string {
  return v >= 100 ? String(Math.round(v)) : v.toFixed(2).replace(/\.?0+$/, '')
}

export function formatDateIN(value?: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
}

/** Percentage change from `previous` to `current`; null when either side is empty. */
export function changePct(current: number, previous: number): number | null {
  if (!previous || !current) return null
  return ((current - previous) / Math.abs(previous)) * 100
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('')
}

/**
 * The counter's English, for the whole app. A bare `+ 's'` is what the vault printed first, and it read
 * as "3 time entrys" — which is the kind of thing a shop notices on a page whose whole job is to look
 * like a bookkeeper wrote it. Two rules cover every unit this app names: a word ending in a consonant
 * and "y" turns it into "ies", anything else takes an "s".
 *
 * The hedge it replaces — a count followed by an optional letter in brackets — says neither. A register
 * that cannot commit to whether it found one row or thirty is not stating a finding, and the number
 * printed beside the hedge already knows.
 */
export function plural(count: number, unit: string): string {
  const many = /[^aeiou]y$/i.test(unit) ? `${unit.slice(0, -1)}ies` : `${unit}s`
  return `${count} ${count === 1 ? unit : many}`
}
