// Offline invoice outbox.
// When the device has no connection, invoices/new queues the full invoice +
// line items here (localStorage, per org). When back online, syncOutbox
// replays each entry exactly like the online save path: assign the real
// sequence number, insert invoice + items, and record stock movements.

import { getFinancialYear } from '@/lib/gst-engine'

export interface OutboxEntry {
  id: string
  createdAt: string          // ISO timestamp
  tempNumber: string         // display-only placeholder until synced
  invoice: Record<string, unknown> // invoice row without invoice_number
  items: Record<string, unknown>[] // invoice_items rows without invoice_id
  status: 'pending' | 'error'
  error?: string
}

const OUTBOX_PREFIX = 'taxflow:outbox:'

function keyFor(orgId: string) {
  return OUTBOX_PREFIX + orgId
}

export function listOutbox(orgId: string): OutboxEntry[] {
  if (typeof window === 'undefined' || !orgId) return []
  try {
    const raw = localStorage.getItem(keyFor(orgId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeOutbox(orgId: string, entries: OutboxEntry[]) {
  try {
    localStorage.setItem(keyFor(orgId), JSON.stringify(entries))
  } catch {
    /* quota — should not happen for small payloads */
  }
}

export function makeTempNumber(): string {
  return `OFF-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
}

export function queueOfflineInvoice(
  orgId: string,
  invoice: Record<string, unknown>,
  items: Record<string, unknown>[],
): OutboxEntry {
  const entry: OutboxEntry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    tempNumber: makeTempNumber(),
    invoice,
    items,
    status: 'pending',
  }
  writeOutbox(orgId, [...listOutbox(orgId), entry])
  return entry
}

export function removeOutboxEntry(orgId: string, id: string): void {
  writeOutbox(orgId, listOutbox(orgId).filter(e => e.id !== id))
}

export function pendingOutboxCount(orgId: string): number {
  return listOutbox(orgId).length
}

export function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /failed to fetch|networkerror|load failed|err_|internet/i.test(msg)
}

export interface SyncOutcome {
  synced: { tempNumber: string; invoiceNumber: string }[]
  failed: { tempNumber: string; error: string }[]
  stoppedEarly: boolean // true when the connection dropped mid-sync
}

// Replays one queued entry through the same path as the online save.
async function syncEntry(supabase: any, orgId: string, entry: OutboxEntry): Promise<string> {
  const invoiceDate = entry.invoice.invoice_date as string
  const fy = getFinancialYear(invoiceDate ? new Date(invoiceDate) : new Date())

  // Get or create the sequence, then take the next number.
  let { data: seq } = await supabase
    .from('invoice_sequences')
    .select('*')
    .eq('organization_id', orgId)
    .eq('financial_year', fy)
    .single()

  let nextNumber = 1
  if (seq) {
    nextNumber = seq.last_number + 1
    await supabase.from('invoice_sequences').update({ last_number: nextNumber }).eq('id', seq.id)
  } else {
    await supabase
      .from('invoice_sequences')
      .insert({ organization_id: orgId, prefix: 'INV', financial_year: fy, last_number: 1 })
    nextNumber = 1
  }

  const invoiceNumber = `INV-${fy}-${String(nextNumber).padStart(4, '0')}`

  const { data: invoice, error: invError } = await supabase
    .from('invoices')
    .insert({ ...entry.invoice, organization_id: orgId, invoice_number: invoiceNumber })
    .select()
    .single()
  if (invError) throw invError

  const itemsToInsert = entry.items.map((it, idx) => ({
    ...it,
    invoice_id: invoice.id,
    organization_id: orgId,
    sort_order: idx,
  }))
  const { error: itemsError } = await supabase.from('invoice_items').insert(itemsToInsert)
  if (itemsError) throw itemsError

  // Stock movements for tracked products (non-fatal if the RPC fails).
  for (const item of entry.items) {
    const productId = item.product_id as string | null
    if (!productId) continue
    try {
      const { data: product } = await supabase
        .from('products')
        .select('track_inventory, current_stock')
        .eq('id', productId)
        .single()
      if (product?.track_inventory) {
        const { data: { user } } = await supabase.auth.getUser()
        await supabase.rpc('record_stock_movement', {
          p_organization_id: orgId,
          p_product_id: productId,
          p_movement_type: 'sale',
          p_quantity: -(Number(item.quantity) || 0),
          p_reference_type: 'invoice',
          p_reference_id: invoice.id,
          p_reference_number: invoiceNumber,
          p_notes: `Sale — ${invoiceNumber}`,
          p_created_by: user?.id,
        })
      }
    } catch {
      /* invoice already synced; stock drift can be corrected manually */
    }
  }

  return invoiceNumber
}

export async function syncOutbox(supabase: any, orgId: string): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { synced: [], failed: [], stoppedEarly: false }
  const entries = listOutbox(orgId)

  for (const entry of entries) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      outcome.stoppedEarly = true
      break
    }
    try {
      const invoiceNumber = await syncEntry(supabase, orgId, entry)
      removeOutboxEntry(orgId, entry.id)
      outcome.synced.push({ tempNumber: entry.tempNumber, invoiceNumber })
    } catch (err) {
      if (isNetworkError(err)) {
        // Still offline / connection dropped — leave it queued, stop trying.
        outcome.stoppedEarly = true
        break
      }
      const remaining = listOutbox(orgId).map(e =>
        e.id === entry.id ? { ...e, status: 'error' as const, error: err instanceof Error ? err.message : String(err) } : e
      )
      writeOutbox(orgId, remaining)
      outcome.failed.push({ tempNumber: entry.tempNumber, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return outcome
}
