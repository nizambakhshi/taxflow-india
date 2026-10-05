// Client-side UPI deep-link + WhatsApp reminder helpers.
// No third-party payment gateway, no DB writes — builds shareable links
// from a seller VPA + invoice data so the customer can pay via any UPI app.

export interface UpiLinkInput {
  vpa: string          // payee UPI id, e.g. business@okhdfcbank
  payeeName: string    // displayed payee name (max 255)
  amount: number       // fixed ₹ amount (> 0)
  transactionRef?: string // invoice number, shown as reference
  note?: string        // transaction note
}

// UPI amount must be a plain decimal string; guard against float artifacts.
function upiAmount(amount: number): string {
  const rounded = Math.round(amount * 100) / 100
  if (!isFinite(rounded) || rounded <= 0) return ''
  return rounded.toFixed(2)
}

export function validateVpa(vpa: string): string | null {
  const t = vpa.trim()
  if (!t) return 'UPI ID (VPA) is required'
  // handle@bank style: name part, '@', alphanumeric bank handle
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9.]{2,63}$/.test(t)) {
    return 'Enter a valid UPI ID like name@bank'
  }
  return null
}

export interface UpiLinkResult {
  link: string
  error: string | null
}

export function buildUpiDeepLink(input: UpiLinkInput): UpiLinkResult {
  const vpaErr = validateVpa(input.vpa)
  if (vpaErr) return { link: '', error: vpaErr }

  const amt = upiAmount(input.amount)
  if (!amt) return { link: '', error: 'Enter a valid amount greater than zero' }

  const params = new URLSearchParams()
  params.set('pa', input.vpa.trim())
  params.set('pn', (input.payeeName || '').trim().slice(0, 255))
  params.set('am', amt)
  params.set('cu', 'INR')
  if (input.transactionRef) params.set('tr', input.transactionRef.trim().slice(0, 35))
  if (input.note) params.set('tn', input.note.trim().slice(0, 80))

  return { link: `upi://pay?${params.toString()}`, error: null }
}

// ── WhatsApp ─────────────────────────────────────────────
// Normalizes an Indian phone number to wa.me format (country code + number,
// no '+', no spaces). Accepts 10-digit local, 11-digit with leading 0, or
// already-international 91XXXXXXXXXX / +91 forms.
export function normalizeIndianPhone(raw: string): string | null {
  const digits = (raw || '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 10) return `91${digits}`
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`
  if (digits.length === 12 && digits.startsWith('91')) return digits
  // Anything else (e.g. non-IN numbers) — pass through only if plausible length.
  if (digits.length >= 8 && digits.length <= 15) return digits
  return null
}

export interface WaLinkResult {
  link: string
  error: string | null
}

export function buildWhatsAppLink(phone: string, message: string): WaLinkResult {
  const normalized = normalizeIndianPhone(phone)
  if (!normalized) return { link: '', error: 'Customer has no valid phone number' }
  const text = (message || '').trim()
  if (!text) return { link: '', error: 'Reminder message is empty' }
  return { link: `https://wa.me/${normalized}?text=${encodeURIComponent(text)}`, error: null }
}

// ── Reminder templates ───────────────────────────────────
export interface ReminderContext {
  customer: string
  businessName: string
  invoiceNumber: string
  amount: string
  dueDate: string
  payLink: string
}

export const PLACEHOLDER_HELP =
  'Placeholders: {customer}, {business}, {invoice}, {amount}, {due}, {link}'

export const DEFAULT_REMINDER_TEMPLATES: { key: string; label: string; body: string }[] = [
  {
    key: 'friendly',
    label: 'Friendly',
    body:
      `Hi {customer}, this is a gentle reminder from {business} for invoice {invoice}. ` +
      `Amount due: ₹{amount}. Request you to pay by {due}.\nYou can pay instantly here: {link}\nThank you!`,
  },
  {
    key: 'standard',
    label: 'Standard',
    body:
      `Dear {customer},\n\nInvoice {invoice} from {business} for ₹{amount} is pending and was due on {due}.\n` +
      `Kindly complete the payment using this link: {link}\n\nRegards,\n{business}`,
  },
  {
    key: 'overdue',
    label: 'Overdue',
    body:
      `Hello {customer},\n\nInvoice {invoice} (₹{amount}) from {business} is now overdue (due date: {due}).` +
      `\nPlease arrange payment at the earliest: {link}\n\nIf already paid, ignore this reminder.\nThanks,\n{business}`,
  },
]

export function renderReminder(template: string, ctx: ReminderContext): string {
  return template
    .replace(/\{customer\}/g, ctx.customer)
    .replace(/\{business\}/g, ctx.businessName)
    .replace(/\{invoice\}/g, ctx.invoiceNumber)
    .replace(/\{amount\}/g, ctx.amount)
    .replace(/\{due\}/g, ctx.dueDate)
    .replace(/\{link\}/g, ctx.payLink)
}

// localStorage key scoping VPA/business name per organization.
const UPI_SETTINGS_PREFIX = 'taxflow:upi:'

export interface UpiSettings {
  vpa: string
  payeeName: string
  templateKey: string
}

export function loadUpiSettings(orgId: string): UpiSettings {
  const fallback: UpiSettings = { vpa: '', payeeName: '', templateKey: 'standard' }
  if (typeof window === 'undefined' || !orgId) return fallback
  try {
    const raw = localStorage.getItem(UPI_SETTINGS_PREFIX + orgId)
    if (!raw) return fallback
    return { ...fallback, ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

export function saveUpiSettings(orgId: string, settings: UpiSettings): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    localStorage.setItem(UPI_SETTINGS_PREFIX + orgId, JSON.stringify(settings))
  } catch {
    /* storage full or unavailable — settings are non-critical, ignore */
  }
}
