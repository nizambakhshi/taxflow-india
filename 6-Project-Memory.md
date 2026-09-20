# TaxFlow India — Project Memory

**Version:** 1.0  
**Date:** September 2026  
**Purpose:** Track everything built, every decision made, every issue fixed.  
Update this file at the end of every development session.

---

## Project Identity

| Item | Value |
|------|-------|
| Product name | TaxFlow India |
| Live URL | https://taxflow-india.vercel.app |
| GitHub repo | https://github.com/[your-username]/taxflow-india |
| Local path | ~/Desktop/taxflow-india |
| Supabase project | taxflow-india |
| Supabase region | South Asia (Mumbai) |
| Next.js version | 15.x (App Router) |
| @supabase/ssr version | 0.12.7 |
| Node.js version | 20.x |
| Developer OS | Mac Mini M4 |
| Code editor | Cursor |

---

## Architecture Decisions

### ADR-001 — Technology Stack
**Decision:** Next.js + Supabase + Vercel  
**Date:** September 2026  
**Reason:** Free tier covers MVP, beginner-friendly, one language (TypeScript) throughout, Supabase handles auth + database + storage.  
**Alternatives considered:** React + Node + PostgreSQL (more complex), Django + React (two languages)

### ADR-002 — Multi-tenancy Model
**Decision:** Shared database, application-level isolation via organization_id  
**Date:** September 2026  
**Reason:** Simpler to implement for MVP. Every query filters by organization_id.  
**Future:** Row Level Security (RLS) in Phase 14 for database-level enforcement

### ADR-003 — RLS Disabled During Development
**Decision:** Supabase Row Level Security is disabled on all tables  
**Date:** September 2026  
**Reason:** @supabase/ssr version 0.12.7 + Next.js 15 caused session cookie issues, leading to 403 errors on INSERT. RLS policies correctly written but session not passed correctly to database.  
**Risk:** Low during development (single developer, test data only)  
**Fix:** Phase 14 — properly configure RLS with correct @supabase/ssr 0.12.x API  
**Affected tables:** organizations, org_members, gst_registrations, profiles, customers, vendors, products, invoices, invoice_items, purchase_bills, purchase_bill_items, expenses, payments, stock_movements, invoice_sequences, gst_return_periods, warehouses

### ADR-004 — No Direct GST Filing
**Decision:** App prepares GST return data, does not file directly  
**Date:** September 2026  
**Reason:** Direct GSTN integration requires GSP (GST Suvidha Provider) authorization. Not feasible for MVP.  
**Future:** Integrate with authorized GSP in Version 2

### ADR-005 — Client-Side GST Calculation
**Decision:** GST calculation happens in browser (TypeScript), not server  
**Date:** September 2026  
**Reason:** Instant feedback as user types. No server round-trip needed for calculations.  
**Location:** src/lib/gst-engine.ts

### ADR-006 — Invoice Data Immutability
**Decision:** Invoice line items store all values at time of creation  
**Date:** September 2026  
**Reason:** Product prices change over time. Historical invoices must show original prices.  
**Implementation:** invoice_items stores item_name, hsn_sac, rate, gst_rate as copies, not references

### ADR-007 — Invoice Number Format
**Decision:** INV-{FY}-{4-digit-number}  
**Example:** INV-2026-27-0001  
**Date:** September 2026  
**Reason:** Includes financial year for easy identification. Sequential within FY.  
**Table:** invoice_sequences (one row per org per FY)

### ADR-008 — Financial Year (India)
**Decision:** April to March  
**Example:** FY 2026-27 starts April 2026, ends March 2027  
**Implementation:** getFinancialYear() in gst-engine.ts — if month >= 3 (April), current year is FY start

### ADR-009 — Proxy/Middleware Approach
**Decision:** Deleted proxy.ts (Next.js 15 uses proxy, not middleware)  
**Date:** September 2026  
**Reason:** Next.js 15 deprecated middleware in favor of proxy. Caused errors. Removed to simplify.

### ADR-010 — URL-Based ID Resolution
**Decision:** Use window.location.pathname to get invoice ID instead of params  
**Date:** September 2026  
**Reason:** Next.js 15 made params a Promise. useParams() also async. window.location is synchronous.  
**Implementation:** In /invoices/[id]/page.tsx: `const id = window.location.pathname.split('/').pop()`

### ADR-011 — Draft Invoice Cannot Be Marked Paid
**Decision:** Only invoices with status 'sent' can be marked as paid  
**Date:** September 2026  
**Reason:** Draft invoices are not yet confirmed/sent to customer. Should not be marked paid.  
**Implementation:** Check `invoice.status === 'sent'` before showing Mark as Paid button

### ADR-012 — Expense GST Calculation (Tax-Inclusive)
**Decision:** Expenses use tax-inclusive GST calculation  
**Date:** September 2026  
**Reason:** Business receipts/bills typically show total including GST. App backs out the GST.  
**Formula:** gst_amount = total − (total / (1 + gst_rate/100))

---

## GST Compliance Decisions

### GCD-001 — CGST+SGST vs IGST Rule
**Rule:** Same state code (supplier vs place of supply) → CGST + SGST. Different state → IGST.  
**Exception:** Export and SEZ always use IGST regardless of state.  
**Source:** GST Act, verified at implementation

### GCD-002 — GST Rates in Database
**Decision:** All GST rates stored in products table (gst_rate column), not hard-coded  
**Configurable:** Yes — user sets rate per product  
**Rates supported:** 0%, 5%, 12%, 18%, 28%

### GCD-003 — GSTIN Validation
**Format:** 2-digit state code + 5-char PAN letters + 4-char PAN digits + 1 entity + Z + 1 checksum  
**Regex:** `/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/`  
**Note:** This validates format only. GSTN portal verification required for actual validity.

### GCD-004 — HSN vs SAC
**Decision:** Goods use HSN codes, Services use SAC codes  
**Field:** hsn_sac (single field for both)  
**Note:** HSN code requirement varies by turnover — verify current threshold at cbic.gov.in

### GCD-005 — ITC Eligibility
**Decision:** ITC eligible flag per purchase bill and expense — user controlled  
**Reason:** ITC eligibility has conditions (Section 16, CGST Act). Not all purchases qualify.  
**Warning shown:** App shows ITC amounts but advises CA verification

---

## Completed Sessions

### Session 1 — September 2026
**What was built:**
- Project setup (Node, Git, Cursor, GitHub, Supabase, Vercel)
- Next.js application created
- Login, signup, dashboard pages
- Supabase auth connected
- Phase 1 complete and deployed

**Issues resolved:**
- None major

---

### Session 2 — September 2026
**What was built:**
- Database tables (profiles, organizations, org_members, gst_registrations)
- RLS policies (later disabled due to 403 errors)
- Business setup wizard (2 steps)
- GSTIN validation and state detection
- Dashboard showing org name and GSTIN

**Issues resolved:**
- `infinite recursion detected in policy for relation "org_members"` — Fixed by rewriting RLS policies to avoid self-reference
- `new row violates row-level security policy for table "organizations"` — Resolved by disabling RLS (ADR-003)
- `params is a Promise` error — Resolved using window.location.pathname (ADR-010)

---

### Session 3 — September 2026
**What was built:**
- constants.ts (Indian states, business types, GST types, GSTIN validator)
- Customer management (list, add, edit, search)
- Vendor management (list, add, edit, search)
- Product/service management (list, add, edit, filter)
- Sidebar navigation with all sections
- (app) layout group with shared layout
- Placeholder pages for all sidebar links
- Database tables: customers, vendors, products

**Issues resolved:**
- Two parallel pages at /dashboard — deleted old src/app/dashboard/page.tsx

---

### Session 4 — September 2026
**What was built:**
- Invoice database tables (invoices, invoice_items, invoice_sequences)
- GST calculation engine (gst-engine.ts)
- Invoice creation form with live calculation
- CGST+SGST vs IGST auto-detection
- Invoice list page
- Invoice detail/view page
- Print to PDF
- Mark as Paid (sent only)
- Cancel invoice

**Issues resolved:**
- `params is a Promise` — Used window.location.pathname instead of params/useParams

---

### Session 5 — September 2026
**What was built:**
- Purchase bill database tables
- Expense database table
- Purchase bills page with ITC tracking
- Expenses page with GST calculation
- ITC summary cards on bills page

**No major issues**

---

### Session 6 — September 2026
**What was built:**
- Payments database table
- Payments page (receivables + payables tabs)
- Ageing buckets (current, 30d, 60d, 90d+)
- Record payment modal (full and partial)
- Payment history
- Summary cards

**No major issues**

---

### Session 7 — September 2026
**What was built:**
- Stock movements table
- Warehouses table
- record_stock_movement() database function
- Inventory page (stock levels + movements tabs)
- Manual stock adjustment
- Auto-reduce stock on invoice
- Auto-increase stock on purchase bill

**No major issues**

---

### Session 8 — September 2026
**What was built:**
- gst_return_periods table
- GST Dashboard (output tax, ITC, net payable)
- Return status tracker with update dropdown
- GSTR-1 report (B2B, B2C, Export, HSN tabs)
- GSTR-3B report (sections 3.1, 4, 6.1)
- CSV export on both returns
- Live dashboard with real data
- 6-month sales bar chart
- Business Reports (sales, purchase, GST, profit)
- Period selector (month, quarter, FY)

**No major issues**

---

### Session 9 — September 2026
**What was built:**
- 6 project documentation files
  1. PRD (Product Requirements)
  2. System Architecture
  3. Development Rules
  4. Design System
  5. Project Tasks
  6. Project Memory

**No issues**

---

## Files Created (Complete List)

### Source Files
```
src/
├── app/
│   ├── (app)/
│   │   ├── layout.tsx              ← Sidebar + nav wrapper
│   │   ├── dashboard/page.tsx      ← Live dashboard
│   │   ├── invoices/
│   │   │   ├── page.tsx            ← Invoice list
│   │   │   ├── new/page.tsx        ← Create invoice
│   │   │   └── [id]/page.tsx       ← Invoice detail + print
│   │   ├── customers/page.tsx      ← Customer management
│   │   ├── vendors/page.tsx        ← Vendor management
│   │   ├── products/page.tsx       ← Product management
│   │   ├── inventory/page.tsx      ← Inventory + stock movements
│   │   ├── bills/page.tsx          ← Purchase bills
│   │   ├── expenses/page.tsx       ← Expenses
│   │   ├── payments/page.tsx       ← Receivables + payables
│   │   ├── quotations/page.tsx     ← Placeholder
│   │   ├── credit-notes/page.tsx   ← Placeholder
│   │   ├── gst/
│   │   │   ├── page.tsx            ← GST dashboard
│   │   │   ├── gstr1/page.tsx      ← GSTR-1 report
│   │   │   └── gstr3b/page.tsx     ← GSTR-3B report
│   │   └── reports/page.tsx        ← Business reports
│   ├── login/page.tsx              ← Login page
│   ├── signup/page.tsx             ← Signup page
│   ├── setup/page.tsx              ← Business setup wizard
│   └── page.tsx                    ← Redirects to /login
└── lib/
    ├── supabase.ts                 ← Supabase client
    ├── gst-engine.ts               ← GST calculation engine
    └── constants.ts                ← States, types, validator
```

### Database Tables (Supabase)
```
auth.users                (Supabase managed)
profiles
organizations
org_members
gst_registrations
customers
vendors
products
invoice_sequences
invoices
invoice_items
purchase_bills
purchase_bill_items
expenses
payments
warehouses
stock_movements
gst_return_periods
```

### Database Functions (Supabase)
```
handle_new_user()              ← Auto-create profile on signup
is_org_member(org_id)         ← Check membership (RLS helper)
is_org_owner(org_id)          ← Check owner role (RLS helper)
record_stock_movement(...)    ← Update stock + record movement
```

---

## Pending Decisions (Need Discussion)

| Decision | Options | Priority |
|----------|---------|---------|
| Settings page scope | Invoice prefix, logo, bank details | High |
| Email provider | Resend, SendGrid, Supabase SMTP | Medium |
| PDF library | Browser print (current) vs react-pdf | Medium |
| RLS fix approach | Wait for Supabase docs vs workaround | High |
| SaaS pricing | Free/Starter/Pro tiers | Low |
| Custom domain | taxflowindia.com | Low |

---

## Passwords and Credentials (Store Separately)

**DO NOT store actual credentials here.**
Store them in:
- Mac: Notes app or Keychain
- Recommended: 1Password or Bitwarden (free)

Items to store safely:
- Supabase database password
- Supabase URL and anon key
- GitHub account credentials
- Vercel account credentials
- Future: Razorpay API keys

---

## Quick Commands Reference

### Local development
```bash
cd ~/Desktop/taxflow-india
npm run dev
# Open: http://localhost:3000
```

### Deploy to production
```bash
cd ~/Desktop/taxflow-india
git add .
git commit -m "Description of what changed"
git push
# Vercel auto-deploys in 2-3 minutes
```

### Check package versions
```bash
npm list @supabase/ssr
npm list next
node --version
```

### Install a new package
```bash
npm install package-name
```

### Check for errors
```bash
npm run build
# Shows TypeScript and build errors before deploy
```

---

## Next Steps (Priority Order)

1. **Option A — Settings Page** (recommended next)
   - Invoice prefix customization
   - Company logo upload
   - Bank details on invoices

2. **Option B — Quotations**
   - Create quotation → convert to invoice workflow

3. **Option C — Phase 14 Security**
   - Fix RLS for @supabase/ssr 0.12.x
   - Audit logs

4. **Option D — Multi-user**
   - Invite accountant/staff
   - Role-based access

5. **Option E — Phase 13 SaaS**
   - Subscription plans
   - Razorpay billing

---

## Important Reminders

1. **RLS is disabled** — Do not add real customer data until Phase 14 security is done
2. **GST filing** — App prepares data only, does not file returns
3. **GSTIN validation** — Format validation only, not GSTN portal lookup
4. **ITC eligibility** — User-controlled, advise CA verification
5. **Profit report** — Indicative only, not a certified P&L statement
6. **Test GSTIN** — Use `27AABCU9603R1ZX` for testing (valid format, not a real GSTIN)
