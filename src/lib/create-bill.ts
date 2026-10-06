// Single write-path for a purchase bill: bill row → line items → inward stock
// movements. Used by the bills form and by the bill scanner so a scanned bill
// lands in exactly the same shape as a typed one.

export type BillFields = Record<string, unknown>
export type BillItemFields = Record<string, unknown>

export interface CreatedBill {
  billId: string
  billNumber: string
}

export async function createPurchaseBill(
  supabase: any,
  orgId: string,
  billFields: BillFields,
  items: BillItemFields[],
): Promise<CreatedBill> {
  const { data: bill, error: billError } = await supabase
    .from('purchase_bills')
    .insert({ ...billFields, organization_id: orgId })
    .select()
    .single()
  if (billError) throw billError

  const billNumber = String(billFields.bill_number || '')

  const { error: itemsError } = await supabase
    .from('purchase_bill_items')
    .insert(items.map((item, idx) => ({
      ...item,
      organization_id: orgId,
      bill_id: bill.id,
      sort_order: idx,
    })))
  if (itemsError) throw itemsError

  // Best-effort: the bill is committed, so a failing stock RPC must not be
  // reported as a save failure.
  for (const item of items) {
    const productId = item.product_id as string | null
    if (!productId) continue
    try {
      const { data: product } = await supabase
        .from('products')
        .select('track_inventory')
        .eq('id', productId)
        .single()
      if (product?.track_inventory) {
        const { data: { user } } = await supabase.auth.getUser()
        await supabase.rpc('record_stock_movement', {
          p_organization_id: orgId,
          p_product_id: productId,
          p_movement_type: 'purchase',
          p_quantity: Number(item.quantity) || 0,
          p_reference_type: 'bill',
          p_reference_id: bill.id,
          p_reference_number: billNumber,
          p_notes: `Purchase — ${billNumber}`,
          p_created_by: user?.id,
        })
      }
    } catch {
      /* stock drift can be corrected manually */
    }
  }

  return { billId: bill.id, billNumber }
}
