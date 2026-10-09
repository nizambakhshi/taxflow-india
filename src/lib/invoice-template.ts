// The invoice document skin — one choice per organisation, remembered in this browser.
//
// This key used to live inside `src/components/InvoiceDocument.tsx`, which meant the app's only
// copy of "which layout does this browser print with" was welded to a `.tsx`. A preference a
// backup has to walk is data, so it sits with the other client-side state (ADR-013) and both the
// document and the vault read it through these two functions.
//
// The value is stored **bare** — `modern`, not `"modern"` — because that is how the component
// wrote it for a year and a half. `taxflow:vault:` (ADR-033) carries it as a JSON string, which
// is the same text once it is quoted by the file format.

export type InvoiceTemplate = 'classic' | 'modern' | 'minimal'

const TEMPLATE_KEY = 'taxflow:invoice-template:'

export const INVOICE_TEMPLATES: { id: InvoiceTemplate; name: string; blurb: string }[] = [
  { id: 'classic', name: 'Classic ledger', blurb: 'Ruled Tally-style sheet accountants recognise' },
  { id: 'modern', name: 'Modern band', blurb: 'Colour header, soft table, bold total block' },
  { id: 'minimal', name: 'Minimal', blurb: 'Quiet white document for services and consultants' },
]

/** The names that mean something; anything else in storage reads as the default skin. */
export const INVOICE_TEMPLATE_IDS: string[] = INVOICE_TEMPLATES.map(t => t.id)

export function isInvoiceTemplate(v: unknown): v is InvoiceTemplate {
  return typeof v === 'string' && INVOICE_TEMPLATE_IDS.includes(v)
}

export function loadInvoiceTemplate(oid: string): InvoiceTemplate {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(TEMPLATE_KEY + oid) : null
  return isInvoiceTemplate(saved) && saved !== 'classic' ? saved : 'classic'
}

export function saveInvoiceTemplate(oid: string, template: InvoiceTemplate) {
  try { localStorage.setItem(TEMPLATE_KEY + oid, template) } catch { /* branding preference */ }
}
