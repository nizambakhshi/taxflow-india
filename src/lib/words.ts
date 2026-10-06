/**
 * Indian numeral wording for invoice totals — the line GST invoices are expected
 * to carry ("Two Lakh Fifty Thousand Rupees Only").
 */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

/** Handles 0..99,999,999 (one crore minus one) — the range any single invoice falls in. */
function wordsBelowCrore(n: number): string {
  if (n === 0) return ''
  const parts: string[] = []

  const lakh = Math.floor(n / 100000)
  n %= 100000
  if (lakh) parts.push(`${belowThousand(lakh)} Lakh`)

  const thousand = Math.floor(n / 1000)
  n %= 1000
  if (thousand) parts.push(`${belowThousand(thousand)} Thousand`)

  const hundred = Math.floor(n / 100)
  n %= 100
  if (hundred) parts.push(`${ONES[hundred]} Hundred`)

  if (n > 0) {
    if (parts.length && parts[parts.length - 1].endsWith('Hundred')) parts.push('and')
    parts.push(n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`)
  }
  return parts.filter(Boolean).join(' ')
}

function belowThousand(n: number): string {
  const hundred = Math.floor(n / 100)
  const rest = n % 100
  const head = hundred ? `${ONES[hundred]} Hundred` : ''
  const tail = rest === 0 ? '' : rest < 20 ? ONES[rest] : `${TENS[Math.floor(rest / 10)]}${rest % 10 ? ` ${ONES[rest % 10]}` : ''}`
  if (head && tail) return `${head} and ${tail}`
  return head || tail
}

/** ₹1,23,456.50 → "One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees and Fifty Paise Only" */
export function amountInWords(amount: number | string): string {
  const value = Number(amount)
  if (!Number.isFinite(value)) return ''

  const negative = value < 0
  const abs = Math.abs(value)
  const rupees = Math.floor(abs)
  const paise = Math.round((abs - rupees) * 100)

  if (rupees === 0 && paise === 0) return 'Zero Rupees Only'

  const out: string[] = []
  if (rupees > 0) {
    const crore = Math.floor(rupees / 10000000)
    const rest = rupees % 10000000
    const chunks: string[] = []
    if (crore) chunks.push(`${wordsBelowCrore(crore)} Crore`)
    if (rest) chunks.push(wordsBelowCrore(rest))
    const phrase = chunks.join(' ').replace(/\s+/g, ' ').trim()
    out.push(rupees === 1 ? 'One Rupee' : `${phrase} Rupees`)
  }
  if (paise > 0) {
    const phrase = paise === 1 ? 'One' : wordsBelowCrore(paise)
    out.push(`${out.length ? 'and ' : ''}${phrase} Paise`)
  }

  return `${negative ? 'Minus ' : ''}${out.join(' ')} Only`
}
