// Single online write-path for creating an invoice: sequence number → invoice
// row → line items → stock movements. Used by the invoice form, the POS counter,
// and the offline outbox replay so every route produces identical rows.

import { getFinancialYear } from '@/lib/gst-engine'
import { recordSale } from '@/lib/batches'

export type InvoiceFields = Record<string, unknown>
export type ItemFields = Record<string, unknown>

export interface CreatedInvoice {
  invoiceId: string
  invoiceNumber: string
}

export async function createInvoice(
  supabase: any,
  orgId: string,
  invoiceFields: InvoiceFields,
  items: ItemFields[],
): Promise<CreatedInvoice> {
  const invoiceDate = invoiceFields.invoice_date as string | undefined
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
    await supabase
      .from('invoice_sequences')
      .update({ last_number: nextNumber })
      .eq('id', seq.id)
  } else {
    await supabase
      .from('invoice_sequences')
      .insert({ organization_id: orgId, prefix: 'INV', financial_year: fy, last_number: 1 })
    nextNumber = 1
  }

  const invoiceNumber = `INV-${fy}-${String(nextNumber).padStart(4, '0')}`

  const { data: invoice, error: invError } = await supabase
    .from('invoices')
    .insert({ ...invoiceFields, organization_id: orgId, invoice_number: invoiceNumber })
    .select()
    .single()
  if (invError) throw invError

  const { error: itemsError } = await supabase
    .from('invoice_items')
    .insert(items.map((item, idx) => ({
      ...item,
      organization_id: orgId,
      invoice_id: invoice.id,
      sort_order: idx,
    })))
  if (itemsError) throw itemsError

  // Stock movements are best-effort: the invoice is already committed, so a
  // failing RPC must not surface as a save error.
  for (const item of items) {
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
      /* stock drift can be corrected manually */
    }
  }

  // Batch register (localStorage, ADR-013): when a line's product has lots on
  // record, the sale draws them down FEFO. recordSale is quiet by design — a
  // register hiccup must never surface as a failed invoice.
  recordSale(
    orgId,
    items.map(item => ({
      product_id: (item.product_id as string | null) ?? null,
      quantity: Number(item.quantity) || 0,
    })),
    invoiceNumber,
    (invoiceFields.invoice_date as string | undefined) || new Date().toISOString().slice(0, 10),
  )

  return { invoiceId: invoice.id, invoiceNumber }
}
