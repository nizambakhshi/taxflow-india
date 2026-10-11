// Single online write-path for creating an invoice: sequence number → invoice
// row → line items → stock movements. Used by the invoice form, the POS counter,
// and the offline outbox replay so every route produces identical rows.
//
// Since R3-2 the *shape* of the number is the shop's: the business-setup register
// (setup.ts) answers the prefix, the padding and whether the financial year sits
// inside it. The counter itself stays exactly where it always was — the
// `invoice_sequences` row per org per FY — so changing the shape never re-issues
// a number: the row counts, the register dresses.
//
// Since R3-5 this path also *asks the seal* before it does anything else
// (`requireOpenSeal`, audit.ts). Every route that can raise an invoice — the form,
// the POS counter, a recurring catch-up, a quotation or challan being converted, a
// Tally voucher, an offline replay — comes through this one door, so a date inside
// a sealed period is refused here rather than at whichever page happened to host
// the button. The refusal is on the trail, and the caller shows the sentence.

import { getFinancialYear } from '@/lib/gst-engine'
import { recordSale } from '@/lib/batches'
import { composeNumber, loadSetup, resolveSeries } from '@/lib/setup'
import { requireOpenSeal, todayISO } from '@/lib/audit'

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
  // The seal first, the sequence second: a refused save must not burn a number.
  requireOpenSeal(orgId, {
    date: invoiceDate || todayISO(),
    target: 'invoice',
    ref: (invoiceFields.invoice_number as string) || '',
  })
  const fy = getFinancialYear(invoiceDate ? new Date(invoiceDate) : new Date())
  const fmt = resolveSeries(loadSetup(orgId), 'invoice')

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
      .insert({ organization_id: orgId, prefix: fmt.prefix, financial_year: fy, last_number: 1 })
    nextNumber = 1
  }

  const invoiceNumber = composeNumber(fmt, nextNumber, fy)

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
