# TaxFlow India — Development Rules

**Version:** 1.0  
**Date:** September 2026  

---

## Rule 1 — Build One Thing at a Time

Never try to build multiple features simultaneously.
Complete one feature fully, test it, then move to the next.

```
✅ CORRECT: Build invoice form → test → confirm working → move to next
❌ WRONG: Build invoice form + PDF + email all at once
```

---

## Rule 2 — Test Before Moving On

Every feature must be tested before the next phase begins.
Use the TEST THIS checklist at the end of each feature.
If something fails, fix it before continuing.

---

## Rule 3 — Deploy After Every Phase

After every phase is tested and working:
```
git add .
git commit -m "Phase X - description"
git push
```
Vercel auto-deploys. Always have a working live version.

---

## Rule 4 — Never Hard-Code GST Rules

GST rates, thresholds, and rules change via government notifications.

```typescript
// ❌ WRONG — hard-coded
const gstRate = 18

// ✅ CORRECT — from product master (configurable)
const gstRate = product.gst_rate
```

All GST rates live in the database. Historical invoices retain the rate at time of creation.

---

## Rule 5 — Always Filter by organization_id

Every database query that returns business data MUST filter by organization_id.
No exceptions.

```typescript
// ❌ WRONG — returns all invoices from all businesses
const { data } = await supabase.from('invoices').select('*')

// ✅ CORRECT — only this business's invoices
const { data } = await supabase
  .from('invoices')
  .select('*')
  .eq('organization_id', orgId)
```

---

## Rule 6 — Store Invoice Data at Time of Creation

Invoice line items must store the product name, HSN, rate and tax at the time the invoice was created. Never reference the product master for historical invoice display.

```
Why: If a product's price changes next month,
old invoices must still show the original price.
```

```typescript
// ✅ CORRECT — store all values in invoice_items
{
  item_name: product.name,      // copied, not referenced
  hsn_sac: product.hsn_sac,    // copied
  rate: product.selling_price,  // copied
  gst_rate: product.gst_rate,   // copied
}
```

---

## Rule 7 — Handle Errors Gracefully

Every database call must handle errors. Never let an error crash the page silently.

```typescript
// ✅ CORRECT
try {
  const { data, error } = await supabase.from('invoices').insert(...)
  if (error) throw error
  // success
} catch (err: any) {
  setError(err.message || 'Something went wrong')
} finally {
  setSaving(false)
}
```

---

## Rule 8 — Loading States on Every Action

Every button that triggers a database call must show a loading state.

```typescript
const [saving, setSaving] = useState(false)

// Button
<button disabled={saving}>
  {saving ? 'Saving...' : 'Save Invoice'}
</button>
```

---

## Rule 9 — Validate Before Saving

Validate all required fields before making any database call.

```typescript
// ✅ CORRECT — validate first
if (!customerId) { setError('Please select a customer'); return }
if (!placeOfSupply) { setError('Please select place of supply'); return }
if (validItems.length === 0) { setError('Please add at least one item'); return }

// Then save
await supabase.from('invoices').insert(...)
```

---

## Rule 10 — GSTIN Format Validation

Always validate GSTIN format before saving. Use the validateGSTIN() function from constants.ts.

```typescript
import { validateGSTIN } from '@/lib/constants'

if (gstin && !validateGSTIN(gstin)) {
  setError('Invalid GSTIN format')
  return
}
```

GSTIN format: 2-digit state code + 10-char PAN + 1 entity + Z + 1 checksum = 15 characters.

---

## Rule 11 — Never Directly File GST Returns

The app prepares data for GST returns. It does NOT file returns directly.

Always show this warning on GST reports:
```
⚠️ This report is prepared from your books of accounts.
Always verify figures against the official GST portal before filing.
```

---

## Rule 12 — Financial Calculations Use 2 Decimal Places

All monetary amounts are stored and displayed with exactly 2 decimal places.
Use the round2() helper for intermediate calculations.

```typescript
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
```

Grand total is rounded to the nearest whole rupee. Round-off difference is stored separately.

---

## Rule 13 — File and Folder Naming

| Type | Convention | Example |
|------|-----------|---------|
| Pages | lowercase with hyphens | `credit-notes/page.tsx` |
| Components | PascalCase | `InvoiceForm.tsx` |
| Utilities | camelCase | `gst-engine.ts` |
| Constants | camelCase | `constants.ts` |

---

## Rule 14 — TypeScript Types

Always define types for data structures. Never use `any` unless absolutely necessary.

```typescript
// ✅ CORRECT
type Invoice = {
  id: string
  invoice_number: string
  grand_total: number
  payment_status: 'unpaid' | 'partial' | 'paid'
}

// ❌ AVOID
const invoice: any = ...
```

---

## Rule 15 — Environment Variables

Never commit `.env.local` to GitHub.
Always use `NEXT_PUBLIC_` prefix for variables that need to be accessible in the browser.

```
# .env.local (never commit)
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

Set the same variables in Vercel dashboard for production.

---

## Rule 16 — No Unnecessary Libraries

Before adding a new npm library, ask:
- Can this be done with what we already have?
- Is this library well-maintained?
- Does it significantly simplify the code?

Current approved libraries:
- `@supabase/supabase-js` — database
- `@supabase/ssr` — server-side auth
- `next` — framework
- `react`, `react-dom` — UI
- `typescript` — types
- `tailwindcss` — utility styles

---

## Rule 17 — Sidebar Navigation Updates

When adding a new page, always add it to the sidebar in `src/app/(app)/layout.tsx`.

```typescript
// Add to appropriate NAV_ITEMS section
{ label: 'New Feature', href: '/new-feature', icon: '🔧' }
```

---

## Rule 18 — Stock Movement Recording

Any operation that changes stock must use the `record_stock_movement` database function. Never update `products.current_stock` directly.

```typescript
await supabase.rpc('record_stock_movement', {
  p_organization_id: orgId,
  p_product_id: productId,
  p_movement_type: 'sale',
  p_quantity: -qty,  // negative for stock out
  ...
})
```

---

## Rule 19 — GST Compliance Warning

All pages that display GST return data must include this warning:

```
⚠️ Important: This report is prepared from your books of accounts.
Always verify figures against the official GST portal before filing.
GST rules and return schemas may change — verify at gstn.gov.in.
```

---

## Rule 20 — Commit Message Format

```
Phase X - Short description of what was built

Examples:
Phase 4 - Sales invoice with GST calculation
Phase 5 - Purchase bills and expense tracking
fix - Invoice number not generating correctly
update - Add bank details to invoice PDF
```

---

## Code Quality Checklist

Before marking any feature complete, verify:

- [ ] All required fields validated
- [ ] Loading states on buttons
- [ ] Error messages displayed to user
- [ ] organization_id filter on all queries
- [ ] TypeScript types defined
- [ ] Tested locally
- [ ] Deployed and tested on Vercel
- [ ] No console errors
- [ ] Mobile display acceptable

---

## GST Compliance Checklist

Before any GST feature goes live:

- [ ] Tax rates from database, not hard-coded
- [ ] CGST+SGST applied for same state
- [ ] IGST applied for different state / export
- [ ] GST compliance warning displayed
- [ ] GSTIN validation in place
- [ ] Historical invoices unaffected by rate changes
