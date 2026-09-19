// =============================================
// GST CALCULATION ENGINE
// TaxFlow India — Phase 4
// =============================================
// 
// IMPORTANT GST RULES IMPLEMENTED:
// 1. Same state (supplier state = place of supply) → CGST + SGST
// 2. Different state → IGST only
// 3. Export / SEZ → IGST (or zero rated)
// 4. Rates split equally: GST 18% = CGST 9% + SGST 9%
//
// NOTE: GST rules can change via government notifications.
// All rates are passed in as parameters — never hard-coded.
// Verify current rates at cbic.gov.in before going live.
// =============================================

export type GSTType = 'cgst_sgst' | 'igst'

export type LineItemInput = {
  quantity: number
  rate: number
  discount_percent?: number
  gst_rate: number        // e.g. 18 for 18%
  cess_rate?: number      // e.g. 0
}

export type LineItemResult = {
  quantity: number
  rate: number
  discount_percent: number
  discount_amount: number
  taxable_value: number
  gst_rate: number
  gst_type: GSTType
  cgst_rate: number
  sgst_rate: number
  igst_rate: number
  cgst_amount: number
  sgst_amount: number
  igst_amount: number
  cess_rate: number
  cess_amount: number
  total_amount: number
}

export type InvoiceTotals = {
  subtotal: number          // sum of (qty * rate) before discount
  discount_amount: number   // total discount
  taxable_amount: number    // subtotal - discount
  cgst_amount: number
  sgst_amount: number
  igst_amount: number
  cess_amount: number
  total_tax: number
  round_off: number
  grand_total: number
}

// Determine if CGST+SGST or IGST applies
// Based on: supplier state vs place of supply
export function determineGSTType(
  supplierStateCode: string,
  placeOfSupplyCode: string,
  supplyType: string        // b2b, b2c, export, sez
): GSTType {
  // Exports and SEZ always use IGST
  if (supplyType === 'export' || supplyType === 'sez') {
    return 'igst'
  }
  
  // Same state = CGST + SGST
  if (supplierStateCode === placeOfSupplyCode) {
    return 'cgst_sgst'
  }
  
  // Different state = IGST
  return 'igst'
}

// Round to 2 decimal places
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// Calculate tax for one line item
export function calculateLineItem(
  item: LineItemInput,
  gstType: GSTType
): LineItemResult {
  const quantity = item.quantity || 0
  const rate = item.rate || 0
  const discount_percent = item.discount_percent || 0
  const gst_rate = item.gst_rate || 0
  const cess_rate = item.cess_rate || 0

  // Taxable value
  const gross = round2(quantity * rate)
  const discount_amount = round2(gross * discount_percent / 100)
  const taxable_value = round2(gross - discount_amount)

  // GST amounts
  let cgst_rate = 0
  let sgst_rate = 0
  let igst_rate = 0
  let cgst_amount = 0
  let sgst_amount = 0
  let igst_amount = 0

  if (gstType === 'cgst_sgst') {
    cgst_rate = round2(gst_rate / 2)
    sgst_rate = round2(gst_rate / 2)
    cgst_amount = round2(taxable_value * cgst_rate / 100)
    sgst_amount = round2(taxable_value * sgst_rate / 100)
  } else {
    igst_rate = gst_rate
    igst_amount = round2(taxable_value * igst_rate / 100)
  }

  const cess_amount = round2(taxable_value * cess_rate / 100)
  const total_amount = round2(taxable_value + cgst_amount + sgst_amount + igst_amount + cess_amount)

  return {
    quantity,
    rate,
    discount_percent,
    discount_amount,
    taxable_value,
    gst_rate,
    gst_type: gstType,
    cgst_rate,
    sgst_rate,
    igst_rate,
    cgst_amount,
    sgst_amount,
    igst_amount,
    cess_rate,
    cess_amount,
    total_amount,
  }
}

// Calculate totals for entire invoice
export function calculateInvoiceTotals(
  lineItems: LineItemResult[]
): InvoiceTotals {
  const subtotal = round2(lineItems.reduce((s, i) => s + round2(i.quantity * i.rate), 0))
  const discount_amount = round2(lineItems.reduce((s, i) => s + i.discount_amount, 0))
  const taxable_amount = round2(lineItems.reduce((s, i) => s + i.taxable_value, 0))
  const cgst_amount = round2(lineItems.reduce((s, i) => s + i.cgst_amount, 0))
  const sgst_amount = round2(lineItems.reduce((s, i) => s + i.sgst_amount, 0))
  const igst_amount = round2(lineItems.reduce((s, i) => s + i.igst_amount, 0))
  const cess_amount = round2(lineItems.reduce((s, i) => s + i.cess_amount, 0))
  const total_tax = round2(cgst_amount + sgst_amount + igst_amount + cess_amount)

  const raw_total = round2(taxable_amount + total_tax)
  const grand_total = Math.round(raw_total) // round to nearest rupee
  const round_off = round2(grand_total - raw_total)

  return {
    subtotal,
    discount_amount,
    taxable_amount,
    cgst_amount,
    sgst_amount,
    igst_amount,
    cess_amount,
    total_tax,
    round_off,
    grand_total,
  }
}

// Get current financial year string
// India FY: April to March
export function getFinancialYear(date: Date = new Date()): string {
  const month = date.getMonth() // 0-indexed, April = 3
  const year = date.getFullYear()
  if (month >= 3) { // April onwards = current FY
    return `${year}-${String(year + 1).slice(2)}`
  } else {
    return `${year - 1}-${String(year).slice(2)}`
  }
}

// Format amount in Indian number system
export function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

// Convert number to words (for invoice)
export function numberToWords(amount: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven',
    'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen',
    'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty',
    'Sixty', 'Seventy', 'Eighty', 'Ninety']

  function convert(n: number): string {
    if (n === 0) return ''
    if (n < 20) return ones[n] + ' '
    if (n < 100) return tens[Math.floor(n / 10)] + ' ' + ones[n % 10] + ' '
    if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred ' + convert(n % 100)
    if (n < 100000) return convert(Math.floor(n / 1000)) + 'Thousand ' + convert(n % 1000)
    if (n < 10000000) return convert(Math.floor(n / 100000)) + 'Lakh ' + convert(n % 100000)
    return convert(Math.floor(n / 10000000)) + 'Crore ' + convert(n % 10000000)
  }

  const rupees = Math.floor(amount)
  const paise = Math.round((amount - rupees) * 100)

  let result = 'Rupees ' + convert(rupees).trim()
  if (paise > 0) result += ' and ' + convert(paise).trim() + ' Paise'
  result += ' Only'
  return result
}