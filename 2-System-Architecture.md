# TaxFlow India — System Architecture

**Version:** 2.0  
**Date:** October 2026  

---

## 1. Architecture Overview

TaxFlow India is a **multi-tenant SaaS** application. One application serves many businesses simultaneously, but each business sees only its own data — completely isolated.

```
USER
  ↓ logs in
ORGANIZATION (their business)
  ↓ owns
ALL DATA (invoices, customers, products, etc.)
```

Two layers hold state, and the split is deliberate:

- **Supabase Postgres** — the financial record. Documents, masters, payments, stock. Schema is hand-managed in the Supabase dashboard; the app never runs migrations.
- **Browser `localStorage`** — everything a feature adds on top of that record: settings, owner-declared numbers, plans, logs, drafts, queues. Keyed `taxflow:<feature>:<orgId>` so two organisations in one browser never cross over.

The rule that follows from this: **a new feature rides on existing tables plus local storage.** It keeps the money record untouched, works offline, and can ship without waiting on a schema change.

---

## 2. Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Next.js 16.3.5 (App Router, Turbopack) | React framework, handles both UI and API |
| UI runtime | React 19 | Server components + client pages |
| Language | TypeScript (strict) | Catches errors before they happen |
| Styling | Design system in `src/app/globals.css` (CSS variables + `.tf-*` classes) + Tailwind v4 | Tokens instead of per-page inline styles |
| Components | Hand-rolled kit in `src/components/ui.tsx` + `Icons.tsx` | No component library dependency |
| Database | PostgreSQL (via Supabase) | Reliable, SQL, free tier |
| Authentication | Supabase Auth + `@supabase/ssr` (browser client) | Sessions, email verification, secure |
| File Storage | Supabase Storage | Business logos |
| PDF export | `jspdf` + `html2canvas` | Invoice/document download in the browser |
| OCR | `tesseract.js` (images), `pdfjs-dist` (PDF text) | Bill scan runs client-side; worker served from `/api/pdf-worker` so it stays version-locked |
| Offline | Service worker (`public/sw.js`) + `app/manifest.ts` | Installable PWA, offline invoice outbox |
| Barcode | Browser `BarcodeDetector` + `getUserMedia` | Camera POS scanning, keyboard-wedge fallback |
| Hosting | Vercel | Free tier, auto-deploys from GitHub |
| Version Control | GitHub | Code history, collaboration |

**Monthly cost at current scale: ₹0.** The only two API routes are `/api/gsp/ewaybill` (GSP adapter, mocked) and `/api/pdf-worker`; everything else is browser-side.

---

## 3. Application Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        BROWSER                               │
│                                                              │
│  Next.js pages (src/app/(app)/*)                             │
│    design system: globals.css + components/ui.tsx + Icons    │
│    shell: sidebar · ⌘K palette · bottom nav · PWA install    │
│                                                              │
│  Pure domain libraries (src/lib/*)  ← all calculation lives  │
│    gst-engine  gstr2b  gstr9  einvoice  registers  here      │
│    ledger  party-ledger  targets  reorder  payroll           │
│    ask  bill-text  ocr  barcode  payments  words  format     │
│                                                              │
│  localStorage  taxflow:<feature>:<orgId>                     │
│  service worker  network-first pages, cache-first statics    │
│  offline outbox  → replayed through the normal save path     │
└──────────┬────────────────────────────────────┬──────────────┘
           │ Supabase browser client            │ HTTPS (2 routes only)
┌──────────▼──────────────────────┐  ┌──────────▼──────────────┐
│            Supabase             │  │ /api/gsp/ewaybill       │
│  PostgreSQL  Auth  Storage      │  │ /api/pdf-worker         │
│  (RLS policies hand-managed)    │  │ (GSP adapter, mock)     │
└─────────────────────────────────┘  └─────────────────────────┘
```

**Read path:** a page creates the Supabase client in `useMemo`, selects an explicit column list, filters on `organization_id`, and hands the rows to a `src/lib` function. The library is pure — no React, no I/O — so it can be tested with the TS loader and reused by the palette, the exporter, and another page.

**Write path:** one helper per document type, shared by every screen that creates that document — `create-invoice.ts` (invoice form, POS, offline replay) and `create-bill.ts` (bills page, bill scanner). A feature never re-implements a save.

---

## 4. Folder Structure

```
taxflow-india/
├── src/
│   ├── app/
│   │   ├── layout.tsx              root layout, fonts, metadata
│   │   ├── manifest.ts             PWA manifest
│   │   ├── globals.css             design tokens + .tf-* utilities
│   │   ├── page.tsx                redirects to /login
│   │   ├── login/  signup/  setup/ public pages (setup = business wizard)
│   │   ├── portal/                 public statement of account, read from the URL fragment
│   │   ├── api/
│   │   │   ├── gsp/ewaybill/       GSP adapter route (mock provider)
│   │   │   └── pdf-worker/         version-locked pdf.js worker for bill scan
│   │   └── (app)/                  all protected pages
│   │       ├── layout.tsx          sidebar, mobile nav, ⌘K palette, PWA register
│   │       ├── dashboard/          KPIs, 6-month chart, ageing, due-date countdowns
│   │       ├── invoices/           list · new · [id] (print, PDF, template choice)
│   │       ├── pos/                counter sale with camera barcode scan
│   │       ├── quotations/  credit-notes/  debit-notes/
│   │       ├── bills/  expenses/
│   │       ├── challans/           delivery challans (rule 55) · [id]
│   │       ├── sales-orders/  purchase-orders/   order registers · [id] detail pages
│   │       ├── payments/           receivables + payables
│   │       ├── payments/links/     UPI deep links + WhatsApp reminders
│   │       ├── bank/               statement import and auto-match
│   │       ├── customers/  vendors/  products/
│   │       ├── inventory/          stock levels and movements
│   │       ├── inventory/reorder/  (s,S) suggestions, supplier-wise POs
│   │       ├── inventory/batches/  lot-level in/out, FEFO, expiry watch
│   │       ├── inventory/serials/  one row per physical unit, warranty trail
│   │       ├── inventory/godowns/  named places, per-place stock, transfers as splits
│   │       ├── inventory/recipes/  recipes, build log, materials board, where-used, shop rates
│   │       ├── gst/                GST hub
│   │       │   ├── gstr1/  gstr3b/  gstr9/  gstr4/
│   │       │   ├── reconciliation/  einvoice/  calendar/  job-work/  exports/
│   │       ├── reports/            business reports
│   │       ├── reports/registers/  statutory registers
│   │       ├── reports/targets/    plan vs achievement
│   │       ├── ledger/             party statements of account
│   │       ├── accounting/         P&L and balance sheet
│   │       ├── recurring/          recurring invoice schedules and catch-up runs
│   │       ├── fx/                 foreign-currency deals and the rate ledger
│   │       ├── cost-centres/       document splits held as shares
│   │       ├── projects/           jobs, hours, unbilled register, attached documents
│   │       ├── payroll/            salary register: people, month run (the shop's sheet read there), the day book, dues, annual sheet, hour cost
│   │       │   └── payslip/        the month as A4 paper — one slip or the whole month, letterhead typed here
│   │       ├── audit/              append-only trail and the period seal — a GST window closed to edits, the refusal on the record
│   │       ├── business/           branch register and document series — where papers print from and what the number wears; the counters stayed in the registers
│   │       ├── tally/              Tally import plan and voucher export
│   │       ├── tds/                withholding workpaper and deposit calendar
│   │       ├── offline/            outbox status and replay
│   │       ├── ai/scan-bill/       OCR bill capture
│   │       ├── ai/ask/             natural-language reporting
│   │       └── settings/
│   ├── components/
│   │   ├── ui.tsx                  Card, StatCard, DeltaPill, Badge, Button, PageHeader…
│   │   ├── Icons.tsx               the app's stroke SVG set
│   │   ├── CommandPalette.tsx      ⌘K overlay
│   │   ├── BarcodeScanner.tsx      camera + keyboard-wedge fallback
│   │   ├── InvoiceDocument.tsx     modern / minimal print skins
│   │   ├── OrderRegister.tsx  OrderDocument.tsx   one register, both order directions
│   │   ├── AuthShell.tsx           the shared chrome for login / signup / setup
│   │   └── PwaRegister.tsx
│   └── lib/                        pure, testable, no React
│       ├── supabase.ts  constants.ts  format.ts  words.ts  pdf-export.ts
│       ├── gst-engine.ts  gst-rates.ts   the tax engine and its rate tables
│       ├── create-invoice.ts  create-bill.ts   the only document write paths
│       ├── gstr2b.ts  gstr9.ts  gstr4.ts  einvoice.ts  registers.ts  compliance.ts
│       ├── ledger.ts  party-ledger.ts  reports.ts  targets.ts  reorder.ts
│       ├── payments.ts  barcode.ts  outbox.ts  ocr.ts  bill-text.ts  ask.ts
│       ├── commands.ts  nav.ts  deep-link-search.ts  bank-statement.ts
│       ├── tds.ts                  withholding workpaper
│       ├── orderflow.ts            challans, sales orders, purchase orders, conversion
│       ├── batches.ts  serials.ts  godowns.ts    lot, unit and place registers
│       ├── recurring.ts  fx.ts  jobwork.ts        cadence, currency deals, rule 45 / s.143
│       ├── costcentres.ts  projects.ts  tally.ts   the share register, the hour register, the file bridge
│       ├── creditnote.ts            one write path for both note registers (page forms + Tally bridge)
│       ├── bom.ts                  recipes, builds, dated shop rates, full-cost legs, where-used explosion, FEFO lot issuance, the shortage fold + vendor-grouped shopping plan
│       ├── exports.ts              zero-rating routes, dated FEMA bands, realisation join to /fx
│       ├── payroll.ts              the salary register: dated PF/ESI bands, the 192 year-walk, dues, hour
│       │                           cost, and the shop-sheet reader (paste → lost days, sheet text never stored)
│       ├── attendance.ts           the day book: a mark per person per day, the tap cycle, the pasted
│       │                           page bridged to marks by refusal kind, the pull through validateInput
│       ├── payslip.ts              the month as paper: the engine's own figures laid out as a slip —
│       │                           no rupee re-derived, dashes named, refusals printed, a pack per month
│       ├── audit.ts                the append-only trail and the period seal: `seq`-numbered events `verifyChain()`
│       │                           walks by number, a month or FY closed only after it ended, a release stamped
│       │                           rather than deleted, and `sealGuard()` the write path asks before saving
│       ├── setup.ts                the business register: branches (a GSTIN and the state code it starts with, or the
│       │                           row is refused; head handover before close or delete; `[branch CODE]` stamped into
│       │                           invoice notes) and the five document series dressed over the counters that stayed
│       │                           in Supabase / each register — prefix ≤ 8, pad 1–8, FY in or out, prefix collisions refused
│       ├── invoice-template.ts     the invoice template id + its loader (shared by the vault spec)
│       ├── vault.ts                the books vault: 33 register specs (28 restorable), checksums, plan-then-restore
│       ├── portal.ts               the statement encoded inside its own share link
│       └── gsp/                    provider adapter: types, index, mock
├── public/
│   ├── sw.js                       service worker (offline shell)
│   ├── offline.html                offline fallback page
│   └── icons/                      PWA icons
├── 1-PRD.md … 7-Competitor-Comparison.md  project documentation
├── AGENTS.md                       read by the coding agent before every change
├── .env.local                      Supabase credentials (never commit)
├── package.json
└── next.config.ts
```

Feature folders are route-local by design: a page keeps its own markup and CSS next to its route, while anything that computes, validates or formats moves to `src/lib` so it can be tested without a browser.

---

## 5. Database Architecture

### Tables and Relationships

```
auth.users (Supabase managed)
    │
    ├── profiles (1:1 with users)
    │
    └── org_members (many users → many orgs)
            │
            └── organizations
                    │
                    ├── gst_registrations
                    ├── logos                        ← business logo per org
                    ├── customers
                    ├── vendors
                    ├── products
                    │       └── stock_movements
                    ├── warehouses
                    ├── invoices
                    │       ├── invoice_items
                    │       └── invoice_sequences    ← INV number per FY
                    ├── quotations
                    │       ├── quotation_items
                    │       └── quotation_sequences
                    ├── credit_notes
                    │       ├── credit_note_items
                    │       └── credit_note_sequences
                    ├── debit_notes
                    │       ├── debit_note_items
                    │       └── debit_note_sequences
                    ├── purchase_bills
                    │       └── purchase_bill_items
                    ├── expenses
                    ├── payments                     ← see note below
                    └── gst_return_periods
```

**Two things the schema forces on the code:**

1. `payments` stores `party_name` / `party_type` and an optional `invoice_id` / `bill_id` — there is **no party id column**. Anything that builds a party ledger or a statement links a payment through its document first and through a normalised party-name key second, and drops receipts pointing at a cancelled or missing document so a party never looks overpaid.
2. `invoices.customer_id` nullability is not guaranteed, so a walk-in/POS sale is written against an auto-created cash customer rather than a null FK.

Credit and debit notes are **signed documents**. Wherever a report totals turnover, a credit note reduces the period it is dated in (`document_type: 'credit_note'` → −1). Using `Math.abs()` on those rows is a bug.

---

### Table Definitions

#### profiles
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Same as auth.users.id |
| full_name | text | User's full name |
| phone | text | Phone number |
| created_at | timestamptz | |

#### organizations
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| name | text | Legal business name |
| trade_name | text | Trade/brand name |
| pan | text | PAN number |
| business_type | text | Proprietorship, Pvt Ltd, etc. |
| address_line1/2 | text | Address |
| city, state, state_code | text | Location |
| pincode, phone, email | text | Contact |
| financial_year_start | text | April (India default) |
| logo_url | text | Company logo (future) |

#### org_members
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| organization_id | uuid | FK → organizations |
| user_id | uuid | FK → auth.users |
| role | text | owner, accountant, staff |
| is_active | boolean | |

#### gst_registrations
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| organization_id | uuid | FK → organizations |
| gstin | text | 15-character GSTIN |
| legal_name | text | Name on GST certificate |
| registration_type | text | Regular, Composition, SEZ, etc. |
| state, state_code | text | State of registration |
| registration_date | date | |
| is_primary | boolean | Primary GSTIN flag |
| is_active | boolean | |

#### customers
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| organization_id | uuid | FK → organizations |
| name | text | Contact name |
| business_name | text | Company name |
| gstin | text | Customer GSTIN |
| pan | text | PAN |
| customer_type | text | b2b, b2c, export, sez |
| address fields | text | Full address |
| phone, email | text | Contact |
| payment_terms | integer | Days |
| is_active | boolean | |

#### vendors
Same structure as customers.

#### products
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| organization_id | uuid | FK → organizations |
| name | text | Product/service name |
| type | text | goods, service |
| hsn_sac | text | HSN (goods) or SAC (services) |
| unit | text | NOS, KG, MTR, etc. |
| purchase_price | numeric(14,2) | |
| selling_price | numeric(14,2) | |
| gst_rate | numeric(5,2) | 0, 5, 12, 18, 28 |
| cess_rate | numeric(5,2) | |
| track_inventory | boolean | |
| opening_stock | numeric(10,2) | |
| current_stock | numeric(10,2) | Updated automatically |
| minimum_stock | numeric(10,2) | Alert threshold |

#### invoices
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| organization_id | uuid | FK → organizations |
| invoice_number | text | Auto-generated |
| invoice_type | text | tax_invoice, proforma, etc. |
| invoice_date | date | |
| due_date | date | |
| customer_id | uuid | FK → customers |
| customer_name | text | Copied at time of invoice |
| customer_gstin | text | Column is `customer_gstin`, not `gstin` — a list page that asks for `gstin` 400s |
| place_of_supply | text | State code |
| supply_type | text | b2b, b2c, export, sez |
| is_reverse_charge | boolean | |
| subtotal | numeric(14,2) | |
| discount_amount | numeric(14,2) | |
| taxable_amount | numeric(14,2) | |
| cgst_amount | numeric(14,2) | |
| sgst_amount | numeric(14,2) | |
| igst_amount | numeric(14,2) | |
| cess_amount | numeric(14,2) | |
| total_tax | numeric(14,2) | |
| round_off | numeric(5,2) | |
| grand_total | numeric(14,2) | |
| amount_paid | numeric(14,2) | |
| balance_due | numeric(14,2) | |
| payment_status | text | unpaid, partial, paid |
| status | text | draft, sent, cancelled |

#### invoice_items
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| invoice_id | uuid | FK → invoices |
| product_id | uuid | FK → products (nullable) |
| item_name | text | Stored at time of invoice |
| hsn_sac | text | |
| quantity | numeric(10,3) | |
| unit | text | |
| rate | numeric(14,2) | |
| discount_percent | numeric(5,2) | |
| discount_amount | numeric(14,2) | |
| taxable_value | numeric(14,2) | |
| gst_rate | numeric(5,2) | |
| cgst_rate/amount | numeric | |
| sgst_rate/amount | numeric | |
| igst_rate/amount | numeric | |
| cess_rate/amount | numeric | |
| total_amount | numeric(14,2) | |

#### purchase_bills + purchase_bill_items
Same structure as invoices/invoice_items, adapted for purchases.

#### expenses
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| organization_id | uuid | FK → organizations |
| expense_date | date | |
| category | text | Office Supplies, Travel, etc. |
| description | text | |
| vendor_id | uuid | FK → vendors (nullable) |
| amount | numeric(14,2) | Total including GST |
| gst_rate | numeric(5,2) | |
| gst_amount | numeric(14,2) | |
| taxable_amount | numeric(14,2) | |
| itc_eligible | boolean | |
| payment_mode | text | Cash, Bank, UPI, etc. |
| payment_status | text | paid, unpaid |

#### payments
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| organization_id | uuid | FK → organizations |
| payment_date | date | |
| payment_type | text | received, made |
| payment_mode | text | Cash, Bank, UPI, etc. |
| invoice_id | uuid | FK → invoices (nullable) |
| bill_id | uuid | FK → purchase_bills (nullable) |
| party_name | text | Free-text customer or vendor name |
| party_type | text | customer / vendor |
| amount | numeric(14,2) | |
| reference_number | text | UTR, cheque no, UPI ref |

**Dual purpose:** a payment row is either (a) settlement of a specific document, via `invoice_id` / `bill_id`, or (b) a standalone receipt/pay-out, via `party_name` + `party_type`. There is **no party id column**, so anything that builds a party ledger or a statement links a payment through its document first and through a normalised party-name key second — and drops receipts pointing at a cancelled or missing document, so a party never looks overpaid. `/pos` and `/payments/links` settle against a document; `/accounting` and `/ledger` read both kinds.

#### stock_movements
| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| organization_id | uuid | FK → organizations |
| product_id | uuid | FK → products |
| movement_type | text | opening, purchase, sale, adjustment_in/out |
| quantity | numeric(10,3) | Positive = in, Negative = out |
| balance_after | numeric(10,3) | Stock level after this movement |
| reference_type | text | invoice, bill, manual |
| reference_id | uuid | ID of source document |
| reference_number | text | Invoice/bill number |

#### invoice_sequences
| Column | Type | Description |
|--------|------|-------------|
| organization_id | uuid | |
| prefix | text | Born as `INV` — since R3-2 the row is created with the *dressed* prefix from the business register (`taxflow:setup:`), and `last_number` counts on unchanged: the row counts, the register dresses |
| financial_year | text | 2026-27 |
| last_number | integer | Last used number |

#### gst_return_periods
| Column | Type | Description |
|--------|------|-------------|
| organization_id | uuid | |
| return_type | text | GSTR1, GSTR3B, etc. |
| financial_year | text | 2026-27 |
| period | text | 2026-09 |
| status | text | not_started, draft, ready, filed |
| tax_liability | numeric(14,2) | |
| itc_claimed | numeric(14,2) | |
| net_payable | numeric(14,2) | |
| due_date | date | |
| filed_date | date | |

#### Tables added after the MVP
Same pattern as the documents above — header + `_items` + `_sequences`, all filtered by `organization_id`, all soft-deleted by `status`.

| Table | Notes |
|-------|-------|
| `quotations`, `quotation_items`, `quotation_sequences` | Quote → convert to invoice; own sequence per FY |
| `credit_notes`, `credit_note_items`, `credit_note_sequences` | Signed reduction. `credit_note_items` aliases `credit_note_id as invoice_id` so register code can read either document type |
| `debit_notes`, `debit_note_items`, `debit_note_sequences` | Signed increase |
| `logos` | Business logo (Supabase Storage) |
| `warehouses` | Present in the schema; the app does not use it yet — stock is tracked per product |

Products carry the fields newer features depend on: `sku` is the barcode, `minimum_stock` is the owner's own reorder opinion (the reorder planner honours and labels it), `opening_stock` vs `current_stock` as above.

---

## 6. GST Engine

Located at: `src/lib/gst-engine.ts`

### How it works

```
INPUTS:
- Supplier state code
- Customer state code / Place of supply
- Supply type (B2B, B2C, Export, SEZ)
- Line items (qty, rate, discount, GST rate)

LOGIC:
1. Determine GST type:
   - Same state + not export → CGST + SGST
   - Different state OR export/SEZ → IGST

2. For each line item:
   - Taxable value = qty × rate − discount
   - If CGST/SGST: each = taxable × (GST rate / 2) / 100
   - If IGST: tax = taxable × GST rate / 100

3. Invoice totals:
   - Sum all line items
   - Round grand total to nearest rupee
   - Round-off = rounded − exact total

OUTPUTS:
- Per-line: taxable value, CGST, SGST, IGST, total
- Invoice: subtotal, discount, taxable, all taxes, round-off, grand total
- Amount in words
```

### Key functions
| Function | What it does |
|----------|-------------|
| `determineGSTType()` | Returns 'cgst_sgst' or 'igst' |
| `calculateLineItem()` | Tax for one line item |
| `calculateInvoiceTotals()` | Sums all line items |
| `getFinancialYear()` | Returns current FY e.g. "2026-27" |
| `formatINR()` | Indian number formatting |
| `numberToWords()` | Amount in words (legacy; used by the classic print layout, `/invoices/new` and quotations) |

`src/lib/words.ts` is the newer Indian-numbering amount-in-words (Lakh/Crore, paise-only, negative, singular Rupee/Paise) used by the `modern` and `minimal` document skins. Both exist on purpose — do not "unify" them and change a printed invoice silently.

The same engine drives every downstream figure: GSTR-1, GSTR-3B, the 2B reconciliation, registers, the annual GSTR-9 workpaper, POS, the offline replay, the P&L and the natural-language answers. A feature that needs a GST number calls this; it does not re-derive it.

### Shared primitives

| Module | Provides | Watch out |
|--------|----------|-----------|
| `gst-engine.ts` | Tax split, totals, FY, `formatINR`, legacy `numberToWords` | Do not bypass it for a "simple" percentage |
| `targets.ts` | The financial-year calendar everyone reuses: `fyLabel`, `fyStartYear`, `fyMonths`, `monthOf`, `daysInMonth` | FY runs **April → March**; `SEASONAL_WEIGHTS` is April-ordered (index 6 = October) and must sum to 12 |
| `format.ts` | `formatCompactINR` (lakh/crore), `formatDateIN`, `changePct`, `initials` | Compact figures are for KPI tiles, not for a statutory column |
| `words.ts` | Amount in words for the new print skins | Legacy `numberToWords` still serves the classic layout |
| `party-ledger.ts` | `download()` — the shared file-saver | It prefixes a BOM, so a library that also prefixes one produces a double BOM |
| `deep-link-search.ts` + `nav.ts` | Palette ↔ list-page search contract | A page's filter columns must mirror `ENTITY_SPECS.orColumns`, or a palette hit lands on an empty list |
| `constants.ts` | Indian states, GST rates, state codes | GST rates must stay data-driven, never literal in a page |

Two calendar traps that have already bitten: `iso(y, m, d)` helpers take a **1-based** month while `fyMonth()` returns a **0-based** index, and mixing them shifts every due date by a month. Signed documents (credit notes) must stay signed through totals.

---

## 7. Multi-Tenancy

Every table that holds business data has an `organization_id` column.

Every database query filters by `organization_id`:
```typescript
// Example — only returns THIS org's invoices
const { data } = await supabase
  .from('invoices')
  .select('*')
  .eq('organization_id', orgId)  ← always present
```

**Current security model:** Application-level isolation (`organization_id` filter in every query) plus Supabase RLS policies that are hand-managed in the dashboard. Nothing in the repo describes those policies — if a query returns nothing while the data exists, check the policy before debugging the code.

**Convention:** `.select()` lists the columns a page actually needs (never `*` in a hot path), results are cast `as any[]` because the repo has no generated Supabase types, and soft deletes are expressed as `status != 'cancelled'` rather than a DELETE.

**Still to do:** generated database types, and a single fetch helper per document so pages stop re-declaring column lists.

---

## 8. Authentication Flow

```
User visits app
    ↓
Not logged in → redirect to /login
    ↓
Login with email + password
    ↓
Supabase verifies credentials
    ↓
Session cookie set in browser
    ↓
Every page checks: supabase.auth.getUser()
    ↓
No org found → redirect to /setup
    ↓
Org found → load dashboard
```

---

## 9. Environment Variables

File: `.env.local` (never commit to GitHub)

```
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJxxx...
```

Same variables must be set in Vercel dashboard for production.

---

## 10. Deployment

| Environment | URL | How |
|-------------|-----|-----|
| Local dev | http://localhost:3000 | `npm run dev` |
| Production | https://taxflow-india.vercel.app | Auto-deploy on `git push` |

**Deploy process:**
1. Change the code (local branch, `main` is the working branch for now)
2. `npx tsc --noEmit` and `npm run build` must pass
3. Verify locally at localhost:3000 — golden path plus a phone-width layout check
4. Commit specific files with a message that says what changed and why, then `git push`
5. Vercel auto-deploys; live at taxflow-india.vercel.app

Never `git add .` blindly — `.env.local` stays out, and the repo carries scratch files (`new 1.txt`, `vibe_images/`) that are not part of the app.

---

## 11. Database Functions

### record_stock_movement
Called when:
- Invoice is saved (reduces stock)
- Purchase bill is saved (increases stock)
- Manual adjustment is made
- A build is recorded at `/inventory/recipes` — components out and finished units in as `adjustment_out` / `adjustment_in`, with `p_reference_type: 'manual'`, the `JOB-<FY>-NNNN` number in `reference_number` and spelled out again in `notes` ("Build JOB-… — 3 of Sauce A drawn for 12 of Product X"). The schema has no `build` movement type, and inventing one is a schema change, so the log reads as a named manual adjustment rather than a fiction (ADR-031). Since R2-29 the same run writes a second, device-side trail beside it: each named lot draw is mirrored into `taxflow:batchmoves:` as an `adjust` move with the job in `doc_ref` ("Build JOB-… — Chocolate 1 issued from lot CH-2026-JUL"), and the finished units land as their own lot in `taxflow:batches:`, because the shelf RPC knows nothing about lots. Since R2-35 a third trail records identity: each named serial draw is written as an `issued` event on `taxflow:serialevents:` with the same job in the note ("Build JOB-… — Chocolate TCB-001 issued into the run"), and cancelling the run writes the `restocked` pair for every unit it can still account for — refusing by name when a unit has moved on since (already sold, written off, or restocked by hand)

Does:
1. Gets current stock for product
2. Calculates new stock
3. Inserts row into stock_movements
4. Updates products.current_stock

**Guard:** `current_stock` is seeded on insert only. Editing a product must never rewrite it from `opening_stock` — that silently discards every stock movement since (a real bug that was fixed in the reorder round).

---

## 12. Client-Side State Layer

Features that need somewhere to put information the schema does not have use one `localStorage` key per organisation, never a global key.

| Key | Owner | Holds |
|-----|-------|-------|
| `taxflow:upi:<orgId>` | Payment links | Seller VPA, payee name, reminder tone |
| `taxflow:opening:<orgId>` | Financial statements | Opening balances for the balance sheet — and since R3-2 the shape grew: `cash · bank · receivables · payables · fixedAssets · loans · capital · as_of`. The legacy four fields stand unconditional; the three new money lines and the *day the books were picked up* are gated by `openingStood` — a balance sheet drawn before `as_of` shows the documents it has, not an opening it was not yet standing on — and a payment recorded later grows `cash` but **cannot reduce an opening receivable**: the engine will not guess which pre-books paper it settled, so that limit is printed beside the figure (a settlement that wants to move both sides is an invoice with a number, not an opening figure) |
| `taxflow:outbox:<orgId>` | Offline | Invoices created without a connection, waiting for replay |
| `taxflow:ewb:<orgId>` | E-way bill register | Bills submitted to a GSP |
| `taxflow:compliance:<orgId>` / `taxflow:compliance-profile:<orgId>` | Compliance calendar | Filing profile and per-event filed state |
| `taxflow:targets:<orgId>` | Targets | Monthly sales/expense plan and product goals |
| `taxflow:reorder:<orgId>` | Reorder planner | Lead time, cover window, safety-stock policy |
| `taxflow:invoice-template:<orgId>` | Invoice print | `classic` · `modern` · `minimal` (default `classic`) |
| `taxflow:gstr9:<orgId>` | Annual return | Per-FY declared 3B figures, Rule 42/43 reversals, 9C inputs |
| `taxflow:bank:<orgId>` | Bank matching | Imported statements (rows are reconstructible from the source text) and confirm/set-aside decisions |
| `taxflow:tds:<orgId>` | TDS workpaper | Payer type, section per supplier, per-bill override, challans by deduction month |
| `taxflow:gstr4:<orgId>` | Composition return | Declared CMP-08 deposits and the stock-transfer value for the year |
| `taxflow:challan:<orgId>` · `taxflow:sorder:<orgId>` · `taxflow:porder:<orgId>` | Order flow | Delivery challans, sales orders and purchase orders, each with its own per-FY numbering (born as `DC-<FY>-NNNN`, `SO-<FY>-NNNN`, `PO-<FY>-NNNN` — and since R3-2 the *shape* of those numbers is dressed by the business register: `peekNumber()`/`takeNumber()` take an optional `SeriesFormat` from `setup.ts`, and the high-water walk reads **every shape the kind has worn** (`seriesHistory()`), so a mid-year prefix or padding change never re-issues a number and a series that drops the year inherits the largest count the year-shaped series had reached. The counter itself stayed exactly where it was — no new storage, an untouched shop sees no change). The sequence is **taken, never typed** — `takeNumber()` reads the high-water mark off the store and the documents, so a document raised from another page (`/inventory/recipes` hands its shortage to `raiseDrafts()` since R2-30) gets the same number it would have got here, and no caller can hand-collide two drafts |
| `taxflow:batches:<orgId>` · `taxflow:batchmoves:<orgId>` | Batch & expiry | Lots (with the godown they sit in) and their signed movements — the FEFO drawdown writes here from `create-invoice.ts` |
| `taxflow:serials:<orgId>` · `taxflow:serialevents:<orgId>` | Serial numbers | One row per physical unit and an **append-only** event log; status and warranty come from the latest recorded event, never from an edit. Since R2-35 a build draw is one of those events: a unit a run took goes `issued` — *In a build* — with the job number as its paper, and cancelling the run writes a `restocked` event rather than erasing the `issued` one |
| `taxflow:godowns:<orgId>` | Godowns | Named places stock is kept in, with a virtual `Main` that holds unplaced lots and cannot be archived |
| `taxflow:rec:<orgId>` | Recurring invoices | Schedule rule + template lines + the trail of what was billed — **never the due dates**, those are derived (ADR-025) |
| `taxflow:fx:<orgId>` | Foreign currency | Dated, source-stamped rate ledger + per-invoice deals and remittances, joined to the books by invoice number (ADR-026) |
| `taxflow:jobwork:<orgId>` | Job work | Lots sent out on a rule 55 challan and their dispositions; the section 143 deadline and the four ITC-04 grids are derived, and the calendar reads this register rather than a tick-box (ADR-027) |
| `taxflow:ccentres:<orgId>` | Cost centres | The centre list and, per document, one `{centre → share}` — **percentages only**; the rupees are re-read from five document tables on every load (ADR-028) |
| `taxflow:projects:<orgId>` | Projects & time | Projects, hour rows, and whole documents attached **by id** — **measurements only**; revenue, spend, contribution and the unbilled months are re-read through the same `bookDocs()` the cost centres use, an hour carries the rate you would bill it at, and — since R2-36 — a row may also carry `employee_id`, the person whose hours they were, whose own employer-cost figure for the entry's own month costs that hour as a `costHours()` reading printed *beside* contribution (never folded in; ADR-030 amended). Since R2-37 some of those rows may be **drawn** from the payroll day book: the **page** reads the marks (`dayBook()` + `markWork()`) and hands `drawHours()` structural `BookWorkDay[]` rows, so the library still imports no attendance code — a present day arrives as a proposal at the register's own `hours_per_day`, half a mark as half, every other mark refused with the register's own sentence, and only the shop's tick writes a row (ADR-030 amended again) |
| `taxflow:tally:<orgId>` | Tally bridge | **Only the log** of an import — which file, when, how many of each kind. The parsed dump, the plan and the exported XML live in memory and on disk, never here (ADR-029) |
| `taxflow:bom:<orgId>` | Recipes & builds | Recipes (component **quantities**, output per run, waste) and builds (what the shop actually **drew**, and — since R2-29 — **which lot** each draw came off, as `{batch_id, batch_no, qty, expiry_date}` picks on the build line, and — since R2-35 — **which numbered units** it took, as `{serial_id, serial_no}` picks, plus the `output_batch_id` of the lot the finished units landed in), plus the per-FY `JOB-<FY>-NNNN` high-water mark — **never a rupee**: material value is rolled up from `products.purchase_price` on every load, the same field `/accounting` values stock at, and the lot and unit quantities are a *copy of a decision*, re-checked against `taxflow:batches:` + `taxflow:batchmoves:` and `taxflow:serials:` + `taxflow:serialevents:` before a run is written, never trusted as the lot's balance (ADR-031). **R2-30 stores nothing here**: the shopping plan is a *reading* — `mergedShortages()` over the plans, `shoppingPlan()` joining live `vendors` / `purchase_bills` / `purchase_bill_items` on demand — and the orders it raises are rows of the order-flow register below, never a field of this one |
| `taxflow:exports:<orgId>` | Exports | Undertakings, the shipping-bill / advance / refund paperwork a consignment has to prove, and the realisation credits typed here — **never the invoice value or the IGST paid**, which are re-read from `invoices`. Where `/fx` holds a deal for the same invoice number, its receipts are the counted figure and a credit typed here is printed as *not counted* |
| `taxflow:payroll:<orgId>` | Payroll | Each person's **structure** — six monthly components with their PF/ESI flags, age band, state, joining and leaving dates, hours a day, a professional-tax figure — plus four exceptions per month (lost days, arrears, bonus, recovery). **No rupee is stored at all**: gross, both statutory legs, net pay, the employer's cost and the salary tax are recomputed on every load, the tax by walking the financial year (section 192) rather than by deducting a monthly percentage, and the rates are dated bands that read the ceiling in force on the run's own month (ADR-034). Since R2-32 the lost-day figure may arrive from a pasted shop sheet, but the sheet's text is never stored: what lands there is one `lop_days` number per person plus a `[attendance <month>]` sentence in that month row's note — re-importing a month replaces that sentence rather than stacking a second one, and hand-typed text after the em dash survives. Since R2-34 it also keeps the **day book** — one `attendance` mark per person per day (`{employee_id, date, mark, source: 'hand' | 'sheet', note, written_at}`), the month ruled with dates and written by a tap, bridged from a date-ruled pasted page, or cleared by the per-person eraser. The marks **carry no rupee**: one deliberate pull counts each person's lost days and pushes every candidate row through the same `validateInput()` the month form runs, a person the book never wrote is left **untouched rather than zeroed**, and an empty book refuses to pull at all — additive under the same `PAYROLL_VERSION = 1`. Since R2-33 it also holds the **letterhead** — 15 typed lines, 4 of them statutory identifiers — because a slip's heading is part of the salary register, not a register of its own: no new key, `PAYROLL_VERSION` stays 1, and **no slip is stored**, since a payslip is a reading of the month re-laid out (`src/lib/payslip.ts`). Since R2-37 the day book is also **evidence a project can draw hours from**: `/projects` reads the same marks through `markWork()` — a present day proposes an hours row at the register's own `hours_per_day`, half a mark proposes half, every other mark is refused with the register's own sentence — and a drawn row lands in the project's register; the book itself is never touched by a draw |
| `taxflow:audit:<orgId>` | Audit trail & period lock | The append-only **trail** (`seq` from 1, kind `sealed | released | refused | note`) and the **period seals** (a `month` or a whole `FY` window closed by the shop). It **holds no rupee**: a seal is a date range and an event is a sentence, and the money stays in the documents the seal only governs. `verifyChain()` reads by number so a hand-edit shows as a gap, a duplicate or a reorder; `sealPeriod()` refuses a period that has not ended and a window that overlaps a seal standing; `releaseSeal()` never removes the row — it stamps `released_at` and demands a `release_reason`, so a silent unlock is impossible; `sealGuard(orgId, date)` is the door a write path asks before saving, and when the answer is yes the page refuses the write and `recordRefusal()` appends the attempt as a `refused` event. v1 wires the guard into **only `/invoices/new`** — a boundary printed on the page, not a lock that quietly covers some doors and not others. Joined the vault in the same round it was created (Rule 31, ADR-013) |
| `taxflow:setup:<orgId>` | Business setup | The **branch register** and the **document-series register**. A branch is a registration: a 15-character GSTIN (the same shape rule the e-invoice builder checks — checksum digits are verified nowhere without a GSP, and the code says so), the state code the GSTIN starts with, and the pair is refused when they disagree, because place of supply and the CGST/SGST split read it. One head (the row the header prints by default), one code, one GSTIN per row; the head cannot close or delete until handed over, and a branch whose code is still stamped `[branch CODE]` in invoice notes can only be deactivated — `deleteBranch()` takes the reference check as an argument the page reads from the books, so the refusal comes from what the documents say, not from the modal asking. A series row dresses one kind (`invoice · quotation · challan · sales_order · purchase_order`) with prefix (≤ 8 chars, letters/digits/inner dashes), pad (1–8) and `include_fy` — and **counts nothing**: the invoice counter is the Supabase `invoice_sequences` row (whose own `prefix` column now stores the dressed prefix), the order kinds keep their registers' high-water marks, papers already issued keep the shape they were born with, and two kinds sharing one prefix are refused because they would issue the same number twice. **No rupee lives here** — opening balances stay on `/accounting`. Joined the vault in the same round it was created (Rule 31, ADR-013) |
| `taxflow:palette-recents:<orgId>` | ⌘K | Recently opened records |

Rules that make this safe:
- The key is namespaced by `orgId`, so a shared browser cannot leak one business's plan into another.
- Money records are never stored here. If a number belongs on a return, it comes from the database; local storage holds opinions, settings and declarations. Five registers are held to a stricter reading of that rule because their whole subject is money-shaped judgement: a cost centre stores a **share**, a project stores **measurements** — an hours row and, since R2-36, the id of the person whose hours they were, which is still an id and not a wage: the rupees it costs at are re-read from the payroll register's own figure for the entry's own month — and since R2-37 some of those rows are *drawn* from the payroll day book, which is still evidence: the mark prices nothing, and the drawn hour is the project's own row — a recipe stores **quantities and minutes**, a salary register stores **structure and exceptions** (and, since R2-34, the day book — evidence marks that carry no figure at all), and the audit register stores a **sentence and a window** (a sealed period is a date range, an event is prose; the rupees the seal protects are not in this file). The first three re-read their rupees from the documents on load (a cost centre and a project through one shared reader, `costcentres.bookDocs`, so a cancelled row or a signed credit note cannot have two opinions about what they mean; a recipe from `products.purchase_price`, so a price corrected on the master re-values every recipe that uses it), the fourth recomputes every figure on a slip from its own components, the dated rate bands and a walk of the financial year, and the fifth prices nothing at all — it only records that something was decided. Nothing saved here can rot.
- Every writer keeps a `version` field and a `updatedAt`, so a future shape change can migrate instead of crash.
- Clearing browser storage is a real user risk, so anything a user would grieve losing is either reconstructible from documents (registers, ledger, statements) or surfaced as an export they can keep (CSV, `.ics`, JSON).

---

## 13. Offline and Device Access

```
npm run dev / Vercel
      ↓
app/manifest.ts + public/sw.js          ← installable shell
   network-first: HTML navigations
   cache-first:  hashed statics, icons
   fallback:     public/offline.html
      ↓
src/lib/outbox.ts                        ← offline invoice queue (per org)
   save with temporary OFF- number → replay on reconnect
   → create-invoice.ts (the same path the online form uses)
   → real INV sequence number, line items, stock RPC
      ↓
BarcodeDetector / getUserMedia  ·  tesseract.js / pdfjs-dist
   both degrade gracefully: keyboard-wedge barcode entry, paste-as-text bill scan
```

Because replay uses the production write path, an offline invoice cannot diverge from an online one — there is no second implementation to keep in sync.

---

## 14. Feature Map (page → library)

| Route | Library it is built on | What the library decides |
|-------|------------------------|--------------------------|
| `/gst/reconciliation` | `gstr2b.ts` | Parse the portal's 2B statement, classify each credit |
| `/gst/einvoice` | `einvoice.ts`, `gsp/*` | NIC v1.10 JSON shape, validation, GSP payload |
| `/gst/calendar` | `compliance.ts`, `jobwork.ts`, `exports.ts`, `payroll.ts` | Filing profile → FY of due dates → late-fee estimate; the rows a register owns are **read from that register** — job work, exports, and since R2-31 the salary dues (`payrollEvents()`), whose arrival retires the profile's guessed monthly PF/PT tick-box for every month the books ran |
| `/gst/gstr9` | `gstr9.ts` | Annual tables from documents + declared 3B, 180-day watch, 9C recon |
| `/gst/gstr4` | `gstr4.ts`, `gstr9.ts` | Quarterly CMP-08 grids from documents, composition rate ceilings |
| `/reports/registers` | `registers.ts` | Party-wise, HSN/SAC, B2B, state-wise, e-way bill registers |
| `/reports/targets` | `targets.ts` | Festival-weighted split, prorated pace, product goals |
| `/ledger` | `party-ledger.ts` | Document-first payment linking, running balance, statements |
| `/accounting` | `ledger.ts` | P&L and always-balancing balance sheet. Since R3-2 the opening register grew `bank · receivables · payables · as_of` beside the original four: `computeBalanceSheet` gates the three new money lines behind `openingStood` (they count only once the day the books were picked up has arrived), prints the opening receivable/payable as named sub-lines inside the totals, and states the honest limit beside the figure — a payment grows `cash` but cannot reduce an opening receivable, because the engine will not guess which pre-books paper it settled |
| `/payments/links` | `payments.ts` | UPI deep links, WhatsApp reminder copy |
| `/bank` | `bank-statement.ts` | Statement layout, line direction, scored candidates and confidence tier |
| `/tds` | `tds.ts` | Section table, threshold modes, deposit calendar, interest and 26Q fee |
| `/inventory/reorder` | `reorder.ts` | Demand window, (s, S) policy, supplier grouping |
| `/challans` | `orderflow.ts`, `setup.ts` (`resolveSeries` + `loadSetup`) | Rule 55 reason sets, delivery Challan → invoice on the same flow; since R3-2 the number's **shape** (prefix / pad / FY inside) is read from the business register and handed to `peekNumber()`/`takeNumber()`, while the counter stays in this kind's own store |
| `/sales-orders`, `/purchase-orders` | `orderflow.ts` (via `components/OrderRegister`) | One register, both directions; conversion writes a real invoice or bill |
| `/inventory/batches` | `batches.ts`, `godowns.ts` | Lot-level in/out, FEFO draw order, expiry watch |
| `/inventory/serials` | `serials.ts` | One row per unit; warranty read from the latest sale |
| `/inventory/godowns` | `godowns.ts`, `batches.ts` | A transfer is a lot split, never a second stock ledger |
| `/inventory/recipes` | `bom.ts`, `batches.ts`, `orderflow.ts` (`loadStore` / `saveStore` / `newDoc` / `validateDoc` / `raiseDrafts`) | A recipe stores **quantities and minutes** and re-reads cost from `products.purchase_price` plus the dated shop-rate rows in `taxflow:bom:<orgId>` — each leg priced at the rate in force on its own day; a build stores what was drawn **from which lot** (FEFO proposed, overrulable), moves shelf stock only through `record_stock_movement`, and mirrors each draw into `taxflow:batchmoves:` as an `adjust` move carrying the job number, while the finished units land as their own lot in `taxflow:batches:`. Since R2-30 the materials board also reads `vendors` + `purchase_bills` + `purchase_bill_items` **on demand** and writes purchase-order drafts through `raiseDrafts()` — the order register's numbering, not its own — storing nothing new |
| `/recurring` | `recurring.ts`, `orderflow.ts` | Cadence → a real invoice, billed back into the FY it belonged to |
| `/fx` | `fx.ts` | Dated rate ledger; realised and unrealised kept beside, not inside, the rupee books |
| `/gst/job-work` | `jobwork.ts` | Section 143 return clock and the four ITC-04 grids |
| `/gst/exports` | `exports.ts`, `fx.ts`, `recurring.ts` (`addMonthsISO`, `daysBetween`) | Two clocks per consignment: the undertaking that made it zero-rated and the dated FEMA window the proceeds have to land inside. Band tables carry their instrument and their disagreement; the calendar reads the same `watchRows()` |
| `/cost-centres` | `costcentres.ts` | Stores a **share**; rupees re-read from documents through `bookDocs` |
| `/projects` | `projects.ts`, `costcentres.ts` (`bookDocs`), `payroll.ts` (page-side only: `costPerHourFor`, `employeeById`, `offRosterWhy`), `attendance.ts` (page-side only: `dayBook`, `markWork`) | Stores hours and document ids; labour priced at the billable rate, and — since R2-36 — *costed* wherever a row names its payroll person: the page asks `costPerHourFor` for each (person, entry-month) and hands the rows to `costHours()`, which joins each entry's hours to its person's own figure — `HourCostRow` is a structural subset of payroll's `HourCost`, so the **library** imports no payroll code — folding a refusal with the register's own words where the figure is missing (`offRosterWhy`). The cost prints as *after named hours* beside contribution, marked partial while hours remain unpriced, and never folded in (rule 47 window cited not settled). Since R2-37 the timesheet can also **draw** hours from the kept day book: the page reads a person-month of marks through `markWork()` and folds them into structural `BookWorkDay[]` rows for `drawHours()` — present days proposed at the register's own `hours_per_day`, half a mark proposed as half, every other mark refused with the register's own sentence, a day already on the project un-tickable, hours already recorded elsewhere on that date tickable but not proposed, and `ticks: null` meaning *proposal, never row* — and only the shop's tick reaches `upsertEntries()`, still through `validateEntry`. The library imports neither `attendance.ts` nor `payroll.ts` |
| `/payroll` | `payroll.ts`, `attendance.ts`, `bank-statement.ts` | Stores structure and exceptions and **no rupee**: components → gross → PF/ESI → net → tax are recomputed per load, the tax by walking the financial year under section 192 (elapsed months actual, later months projected, the balance spread over the months left), the rates from dated bands that read the ceiling in force on the run's own month; dues, ESI returns and Form 16 emerge as calendar events, and the month's employer cost divides into the hour cost this register prints on its own Cost tab — which `/projects` reads as data since R2-36 (`costPerHourFor`, per person per entry-month), where a named hour is costed beside contribution and never inside it. The month tab also reads the shop's attendance sheet — a paste, not a table — and for that it borrows `detectDelimiter()` and `splitRow()` from `bank-statement.ts` rather than writing a third CSV reader: the same two functions that score a bank's statement score a supervisor's sheet (R2-32). Since R2-34 the same page keeps the days: `attendance.ts` rules the month into a **day book** — a tap writes one mark per person per day, a date-ruled pasted page bridges into marks (a refusal stops the whole page by its machine-readable `kind`; a blank row is noted and skipped, never read as a month of presents), each person-month is erasable, and one deliberate **pull** re-counts lost days through the month form's own `validateInput()`, leaving an unwritten person untouched rather than zeroed. Its Month tab and every open slip link out to `/payroll/payslip` for the paper version of the same figures. Since R2-37 the day book is also evidence a project draws from: `/projects` reads the same marks through `markWork()` — a present day proposes an hours row at the register's own `hours_per_day`, half a mark proposes half, every other mark is refused with the register's own sentence — and the drawn row lands in the project's register, never back in the book |
| `/payroll/payslip` | `payslip.ts`, `payroll.ts`, `pdf-export.ts`, `words.ts`, `format.ts` | The register as A4 paper, storing **no figure**: `buildPayslip()` lays out the `Payslip` that `payslipOf()` computed, so a slip cannot disagree with the screen, and the only writer here is `saveLetterhead()` (15 lines, 4 of them statutory identifiers, held inside `taxflow:payroll:<orgId>`). *Net payable* never *paid*, four standing boundary sentences on every sheet, a dash with its reason wherever a figure is absent or a code was never typed, **no deduction or employer block laid out for a month the register refuses** (`printable: false`, Print/PDF disabled with the reason), the exceptions kept in a `.no-print` strip on the owner's side of the paper, and `monthPack()` writing the computable slips as one PDF — a page per person — with every refused person printed beside the pack instead of dropped |
| `/audit` | `audit.ts`, and `invoices/new` uses `sealGuard()` + `recordRefusal()` from the same library | Stores a **sentence and a window**: a `seq`-numbered trail `verifyChain()` reads by number so a hand-edit is a gap, a duplicate or a reorder, and a `month` or `FY` seal a write path can ask. `sealPeriod()` refuses a period that has not ended and a window that overlaps a seal standing; `releaseSeal()` never removes a row — it stamps `released_at` and demands a reason, because a silent unlock is exactly what an auditor looks for. `sealGuard(orgId, date)` is the door `/invoices/new` asks before saving; when the answer is yes the page shows a red inline banner with a `/audit?tab=seals` link, refuses the save, and `recordRefusal()` appends the attempt as a `refused` event — the *attempt* on the record even though nothing changed. The stat card counts render as strings so `StatCard`'s default `formatCompactINR` never turns a count into a rupee. **v1 boundary, printed on the page**: only `/invoices/new` currently consults the seal — bills, notes, payments and expenses still save on their own paths, and the copy names which doors are covered rather than implying a lock that covers some quietly |
| `/business` | `setup.ts` | The **branch register** and the **document-series register**, and deliberately neither a counter nor a till. A branch row is a registration — 15-character GSTIN and the state code it starts with, refused as a pair when they disagree, one code and one GSTIN each — with a single head that cannot be closed or deleted until handed over; `/invoices/new` offers an *Issuing branch* that swaps the printed seller header and stamps `[branch CODE]` into the invoice notes (replace-never-stack), and the print page reads the stamp back, printing a named fallback banner when the register can no longer answer. `deleteBranch()` refuses a branch documents still name — the page reads that from the invoice rows themselves, not from its own modal. A series row dresses one kind's number (prefix ≤ 8, pad 1–8, FY in or out), refuses a prefix two kinds would share, and **counts nothing**: `create-invoice.ts`, the quotation register (its own numbers *and* the invoice it converts into), `orderflow.ts` (challans, both order registers, and the recipes board's `raiseDrafts` all take the dressed format), while `peekNumber` previews allocate nothing. **No rupee lives on this page** — opening balances are `/accounting`'s |
| `/tally` | `tally.ts`, `create-invoice.ts`, `create-bill.ts`, `creditnote.ts` | Parse → plan with blocked rows and reasons → replay through the normal write path; note vouchers plan against the document they name — register or same file, never invented — and write through the same creators the note pages use; export builds the XML envelope |
| `/vault` | `vault.ts` (every register's `save*`/`load*`) | Thirty-three named specs — twenty-eight restorable, five evidence-only — into one portable file; restore writes through the owner and reads back through its own loader, `from → seen` per register |
| `/portal` (public) | `portal.ts` | The whole statement encoded in the URL fragment — nothing stored server-side |
| `/pos` | `barcode.ts`, `create-invoice.ts` | GS1 check digits, EAN/UPC variants, cash sale write |
| `/offline` | `outbox.ts`, `create-invoice.ts` | Queue, replay, sequence numbering |
| `/ai/scan-bill` | `bill-text.ts`, `ocr.ts`, `create-bill.ts` | Field extraction, GST cross-validation, confidence |
| `/ai/ask` | `ask.ts` | Intent + period parsing, filters, 17 report intents |
| ⌘K anywhere | `commands.ts`, `nav.ts`, `deep-link-search.ts` | Ranking, entity search, `?q=` deep links |

---

## 15. Verification

A feature is not done until it has been seen working:

```bash
npx tsc --noEmit
npm run build          # watch the route table: static / prerendered / dynamic
npx eslint <touched files>
node --experimental-strip-types --no-warnings --loader /tmp/ts-loader.mjs /tmp/<lib>-test.mjs
```

Then in the browser at `http://localhost:3000`: load the page, exercise the golden path with real data, check the console for errors, and check the layout at both a desktop width and a phone width. Pages that prerender and use `useSearchParams` need the `XPageInner` + `<Suspense>` split.

The phone check is **ancestor-aware**: an element whose `scrollWidth` exceeds its `clientWidth` is only a problem if no ancestor clips or scrolls horizontally (`overflow: hidden` on a header swallows its own decorative `::after`; an `overflow-x: auto` tab bar is allowed to scroll). Measure the *document* — `docScrollWidth == clientWidth` at 355px — and pin a same-origin iframe at the target width to read it, rather than blaming the widest child.

