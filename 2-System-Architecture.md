# TaxFlow India — System Architecture

**Version:** 1.0  
**Date:** September 2026  

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

---

## 2. Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Next.js 15 (App Router) | React framework, handles both UI and API |
| Language | TypeScript | Catches errors before they happen |
| Styling | Inline styles + Tailwind CSS | Simple, no build complexity |
| Database | PostgreSQL (via Supabase) | Reliable, SQL, free tier |
| Authentication | Supabase Auth | Sessions, email verification, secure |
| File Storage | Supabase Storage | PDFs, attachments (future) |
| Hosting | Vercel | Free tier, auto-deploys from GitHub |
| Version Control | GitHub | Code history, collaboration |
| Code Editor | Cursor | AI-assisted, beginner friendly |

**Monthly cost at current scale: ₹0**

---

## 3. Application Architecture

```
┌─────────────────────────────────────────────────┐
│              BROWSER (User's screen)             │
│         Next.js Frontend (React pages)           │
│                                                  │
│  Dashboard / Invoices / GST / Reports / etc.     │
└──────────────────┬──────────────────────────────┘
                   │ HTTPS requests
┌──────────────────▼──────────────────────────────┐
│           Next.js API Routes (Backend)           │
│                                                  │
│  ┌──────────────┐   ┌────────────────────────┐  │
│  │  Auth Layer  │   │     GST Engine         │  │
│  │  (Supabase)  │   │  - CGST/SGST/IGST      │  │
│  └──────────────┘   │  - State detection     │  │
│                     │  - Calculations        │  │
│  ┌──────────────┐   │  - Validation          │  │
│  │   Business   │   └────────────────────────┘  │
│  │    Logic     │                               │
│  └──────────────┘   ┌────────────────────────┐  │
│                     │    PDF Engine          │  │
│                     │  (browser print)       │  │
│                     └────────────────────────┘  │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│                  Supabase                        │
│  ┌───────────┐  ┌──────────┐  ┌─────────────┐   │
│  │PostgreSQL │  │   Auth   │  │   Storage   │   │
│  │(database) │  │(sessions)│  │(files/PDFs) │   │
│  └───────────┘  └──────────┘  └─────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## 4. Folder Structure

```
taxflow-india/
├── src/
│   ├── app/
│   │   ├── (app)/              ← All protected pages (require login)
│   │   │   ├── layout.tsx      ← Sidebar + navbar wrapper
│   │   │   ├── dashboard/      ← Main dashboard
│   │   │   ├── invoices/       ← Invoice list + new + detail
│   │   │   │   ├── page.tsx    ← Invoice list
│   │   │   │   ├── new/        ← Create invoice
│   │   │   │   └── [id]/       ← View/print invoice
│   │   │   ├── customers/      ← Customer management
│   │   │   ├── vendors/        ← Vendor management
│   │   │   ├── products/       ← Product management
│   │   │   ├── inventory/      ← Stock tracking
│   │   │   ├── bills/          ← Purchase bills
│   │   │   ├── expenses/       ← Expense tracking
│   │   │   ├── payments/       ← Receivables + payables
│   │   │   ├── gst/            ← GST dashboard
│   │   │   │   ├── page.tsx    ← GST overview
│   │   │   │   ├── gstr1/      ← GSTR-1 report
│   │   │   │   └── gstr3b/     ← GSTR-3B report
│   │   │   ├── quotations/     ← (placeholder, coming soon)
│   │   │   ├── credit-notes/   ← (placeholder, coming soon)
│   │   │   └── reports/        ← Business reports
│   │   ├── login/              ← Login page (public)
│   │   ├── signup/             ← Signup page (public)
│   │   ├── setup/              ← Business setup wizard (post-signup)
│   │   └── page.tsx            ← Redirects to /login
│   └── lib/
│       ├── supabase.ts         ← Supabase client setup
│       ├── gst-engine.ts       ← GST calculation engine
│       └── constants.ts        ← Indian states, GST rates, etc.
├── .env.local                  ← Supabase credentials (never commit)
├── package.json
└── next.config.ts
```

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
                    ├── customers
                    ├── vendors
                    ├── products
                    │       └── stock_movements
                    ├── warehouses
                    ├── invoices
                    │       └── invoice_items
                    ├── purchase_bills
                    │       └── purchase_bill_items
                    ├── expenses
                    ├── payments
                    ├── invoice_sequences
                    └── gst_return_periods
```

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
| customer_name/gstin | text | Copied at time of invoice |
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
| party_name | text | Customer or vendor name |
| amount | numeric(14,2) | |
| reference_number | text | UTR, cheque no, UPI ref |

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
| prefix | text | INV (configurable) |
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
| `numberToWords()` | Amount in words for invoice |

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

**Current security model:** Application-level isolation (organization_id filter in every query).

**Planned (Phase 14):** Supabase Row Level Security (RLS) — database enforces isolation even if app code has a bug.

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
1. Make changes in Cursor
2. Test locally at localhost:3000
3. `git add . && git commit -m "description" && git push`
4. Vercel auto-deploys in 2-3 minutes
5. Live at taxflow-india.vercel.app

---

## 11. Database Functions

### record_stock_movement
Called when:
- Invoice is saved (reduces stock)
- Purchase bill is saved (increases stock)
- Manual adjustment is made

Does:
1. Gets current stock for product
2. Calculates new stock
3. Inserts row into stock_movements
4. Updates products.current_stock
