export interface AgeingItem {
  amount: number
  /** Preferred ageing anchor — falls back to `issued`. */
  due?: string | null
  issued: string
}

export interface AgeingBucket {
  key: string
  label: string
  amount: number
  count: number
  color: string
}

export interface Ageing {
  buckets: AgeingBucket[]
  total: number
  overdue: number
}

const DEFS: { key: string; label: string; color: string; test: (days: number) => boolean }[] = [
  { key: 'current', label: 'Not due yet', color: '#059669', test: d => d <= 0 },
  { key: 'd30', label: '1–30 days', color: '#d97706', test: d => d <= 30 },
  { key: 'd60', label: '31–60 days', color: '#ea580c', test: d => d <= 60 },
  { key: 'd90', label: '61–90 days', color: '#dc2626', test: d => d <= 90 },
  { key: 'd90p', label: '90+ days', color: '#7f1d1d', test: () => true },
]

const DAY = 86400000

/**
 * Days past the due date. Documents without a due date are treated as due
 * 30 days after issue, which is how most Indian B2B credit terms run.
 */
function daysPastDue(item: AgeingItem, asOf: number): number {
  const anchor = item.due
    ? new Date(item.due).getTime()
    : new Date(item.issued).getTime() + 30 * DAY
  return Math.floor((asOf - anchor) / DAY)
}

export function computeAgeing(items: AgeingItem[], asOfDate: Date = new Date()): Ageing {
  const asOf = asOfDate.getTime()
  const buckets: AgeingBucket[] = DEFS.map(d => ({
    key: d.key, label: d.label, amount: 0, count: 0, color: d.color,
  }))

  for (const item of items) {
    if (!item.amount) continue
    const days = daysPastDue(item, asOf)
    const index = DEFS.findIndex(d => d.test(days))
    buckets[index].amount += item.amount
    buckets[index].count += 1
  }

  const total = buckets.reduce((s, b) => s + b.amount, 0)
  const overdue = buckets.filter(b => b.key !== 'current').reduce((s, b) => s + b.amount, 0)
  return { buckets, total, overdue }
}
