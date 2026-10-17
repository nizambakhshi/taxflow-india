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

**Write path:** one helper per document type, shared by every screen that creates that document — `create-invoice.ts` (invoice form, POS, recurring catch-up, offline replay, order and challan conversion, Tally import) and `create-bill.ts` (bills page, bill scanner, purchase-order conversion, Tally import), with `creditnote.ts` the single path for both note registers. A feature never re-implements a save — and since R3-5 that is also where the period seal lives: each helper calls `requireOpenSeal()` as its first statement, before a sequence number is spent, so every page routing through it is sealed by the same door without mentioning a seal.

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
│   │       │   ├── reconciliation/  einvoice/  calendar/  job-work/  exports/  filings/
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
│   │       ├── journal/            the manual journal — heads that name a statement line, entries that balance, the seal asked before a leg is read
│   │       ├── tally/              Tally import plan and voucher export
│   │       ├── tds/                withholding workpaper and deposit calendar
│   │       ├── offline/            outbox status and replay
│   │       ├── ai/scan-bill/       OCR bill capture
│   │       ├── ai/ask/             natural-language reporting
│   │       └── settings/
│   ├── components/
│   │   ├── ui.tsx                  Card, StatCard, DeltaPill, Badge, Button, PageHeader…
│   │   ├── Icons.tsx               the app's stroke SVG set
│   │   ├── CommandPalette.tsx      ⌘K overlay (live search over order-flow + filings + exports)
│   │   ├── BarcodeScanner.tsx      camera + keyboard-wedge fallback
│   │   ├── InvoiceDocument.tsx     modern / minimal print skins
│   │   ├── OrderRegister.tsx  OrderDocument.tsx   one register, both order directions
│   │   ├── SealNotice.tsx          the one red banner a date field grows when its window is sealed — it only *reads* the seal (`sealGuard`), so a banner never lands on the trail
│   │   ├── AuthShell.tsx           the shared chrome for login / signup / setup
│   │   └── PwaRegister.tsx
│   └── lib/                        pure, testable, no React
│       ├── supabase.ts  constants.ts  format.ts  words.ts  pdf-export.ts
│       ├── gst-engine.ts  gst-rates.ts   the tax engine and its rate tables
│       ├── create-invoice.ts  create-bill.ts   the only document write paths — each asks the seal first
│       ├── gstr2b.ts  gstr9.ts  gstr4.ts  einvoice.ts  registers.ts  compliance.ts
│       ├── ledger.ts  party-ledger.ts  reports.ts  targets.ts  reorder.ts
│       ├── payments.ts  barcode.ts  outbox.ts  ocr.ts  bill-text.ts  ask.ts
│       ├── commands.ts  nav.ts  deep-link-search.ts  bank-statement.ts
│       ├── tds.ts                  withholding workpaper
│       ├── orderflow.ts            challans, sales orders, purchase orders, conversion
│       ├── batches.ts  serials.ts  godowns.ts    lot, unit and place registers
│       ├── recurring.ts  fx.ts  jobwork.ts        cadence, currency deals, rule 45 / s.143
│       ├── costcentres.ts  projects.ts  tally.ts   the share register, the hour register, the file bridge
│       ├── creditnote.ts            one write path for both note registers (page forms + Tally bridge), seal first
│       ├── bom.ts                  recipes, builds, dated shop rates, full-cost legs, where-used explosion, FEFO lot issuance, the shortage fold + vendor-grouped shopping plan
│       ├── exports.ts              zero-rating routes, dated FEMA bands, realisation join to /fx, the shipping-bill refund track read off /gst/filings
│       ├── payroll.ts              the salary register: dated PF/ESI bands, the 192 year-walk, dues, hour
│       │                           cost, and the shop-sheet reader (paste → lost days, sheet text never stored)
│       ├── attendance.ts           the day book: a mark per person per day, the tap cycle, the pasted
│       │                           page bridged to marks by refusal kind, the pull through validateInput
│       ├── payslip.ts              the month as paper: the engine's own figures laid out as a slip —
│       │                           no rupee re-derived, dashes named, refusals printed, a pack per month
│       ├── audit.ts                the append-only trail and the period seal: `seq`-numbered events `verifyChain()`
│       │                           walks by number, a month or FY closed only after it ended, a release stamped
│       │                           rather than deleted, and the seal asked three ways — `sealGuard()` reads it
│       │                           (a banner), `askSeal()` reads it and logs the attempt (a refusal), and
│       │                           `requireOpenSeal()` throws `SealedWriteError` from inside a money writer
│       │                           and the three shared writers call it first; since R3-21 the seal also keeps a
│       │                           **photograph** (`SealSnapshot`) of the close reading's own figures — `parseSnapshot()`
│       │                           rebuilds it in fixed key order, accepts only finite numbers, and a photograph this
│       │                           register cannot read keeps saying so (`snapshot_unreadable`) through every re-save
│       │                           rather than decaying into *never photographed*; `AUDIT_VERSION` still 1, the seals
│       │                           CSV grown 11 → 16 columns at the tail so an old file still reads
│       ├── setup.ts                the business register: branches (a GSTIN and the state code it starts with, or the
│       │                           row is refused; head handover before close or delete; `[branch CODE]` stamped into
│       │                           invoice notes) and the six document series dressed over the counters that stayed
│       │                           in Supabase / each register — prefix ≤ 8, pad 1–8, FY in or out, prefix collisions refused
│       ├── journal.ts              the manual journal: heads that each name one statement line, entries of two or
│       │                           more legs that must balance to the paisa, the draft → posted → reversed lifecycle
│       │                           (a posting is answered by a mirror, never edited or deleted), a used head closed
│       │                           rather than removed, and `askSeal()` asked before a leg is even read; since
│       │                           R3-14 also `trialBalance()`, a read-only foot over **this register's own** posted
│       │                           legs — a head that no longer exists keeps its rupees on a labelled line
│       ├── filings.ts              the filings register: six forms and three cadences, one row per (form, period) that
│       │                           transcribes what the return states — the due date beside the rule that dated it, the
│       │                           figures the return declares, the fee paid — beside the three amendment clocks, the
│       │                           section-59(6) windows, the books-vs-stated variance and the seal read through audit.ts;
│       │                           since R3-7 also `depositFor()`, which folds a QRMP quarter's filed 3B into the
│       │                           PMT-06 sum the calendar prints — as a labelled ceiling while only the return's
│       │                           stated total is known; it files nothing and posts nothing, it is a history the shop keeps
│       ├── invoice-template.ts     the invoice template id + its loader (shared by the vault spec)
│       ├── vault.ts                the books vault: 35 register specs (30 restorable), checksums, plan-then-restore, and since R3-9 a per-book fingerprint at backup so the device can say which books moved since the last file
│       ├── persistence.ts          R3-13's read-only register-persistence inventory: draws the register *list* live from `vault.ts`'s `REGISTERS` (Rule 37 — never a copy) and sorts all 35 by one question asked of the device alone (what a browser wipe destroys) into authoritative / decision-input / reconstructible / device-by-design, marking 24 as needing a server copy; a period-seal column cross-checks its 8 "asks the seal" claims against `/audit`'s `GUARDED` by the suite (Rule 42), and filings is the one seal-is-a-read-not-a-door row (Rule 41). A reading, not a migration — no key, no route, no `.sql`, no RLS, no row; the destinations are prose plans for the R3-3 backend round still blocked on the owner's Supabase project (ADR-013 / Rule 21 hold)
│       ├── period-close.ts       R3-19's period close: a **reading with no door** over one calendar window. The page hands it the rows —— four document tables, the journal, the order registers, the filings register, the trail — and it folds them through the derivations the financial statements already use (`computeProfitLoss()` + `journalRows()` + `paise()`), so a close cannot disagree with `/accounting`. It prints the money the window holds, the paper inside it that is not finished (journal drafts, challans and orders never converted, returns transcribed `not_filed`), the seal's own answer beside its own state, and `unread` for every register it was not handed (Rule 27). No store loader imported, no `localStorage` written, no seal asked or moved, no event appended, nothing filed; sealing stays `sealPeriod()`'s. It was a live fold and printed that boundary with its figures (**Rule 56 / ADR-053**) — and since R3-21 the same fold also **draws the photograph** (`sealSnapshotOf()`: a spread-and-copy of exactly these figures, captioned with the month it looked at and the day it was taken) and **reads it back against today** (`closeDrift()`: 14 money/paper lines plus the findings matched by `key`, `null` where no seal stands, no photograph stands, the photograph captions a different window, or either side of a money line was never loaded — a comparison that cannot be drawn is named, never drawn as zero). **Rule 58 / ADR-055**; the file still stores nothing itself
│       ├── portal.ts               the statement encoded inside its own share link
│       └── gsp/                    provider adapter: types, index, mock
├── public/
│   ├── sw.js                       service worker (offline shell)
│   ├── offline.html                offline fallback page
│   └── icons/                      PWA icons
├── tests/                          the assertion suites, in version control since R3-16
│   ├── hooks.mjs                   resolve() hook: `@/…` → `src/…(.ts|.tsx|/index.ts)`
│   ├── register.mjs                the two-statement registrar `--import` needs
│   ├── copy16.test.mjs             R3-16's 70 assertions over the copy round (68 at ship; two pins amended in the open at R3-22 when the sweep retired the fixed importer count they carried)
│   ├── wip17.test.mjs              R3-17's 92 assertions over the WIP pair
│   ├── mono18.test.mjs             R3-18's 18 assertions: the token, and the debt at zero
│   ├── close19.test.mjs            R3-19's 209 assertions over the close reading (207 at ship; two pins were legitimately amended by R3-21, whose round narrowed the sentence they pinned)
│   ├── drive20.test.mjs            R3-20's 71 assertions pinning the six page-side repairs the signed-in drive found (70 at ship; one pin amended at R3-22, which re-worded the sentence it read)
│   ├── seal21.test.mjs             R3-21's 174 assertions over the photograph: spread fidelity, `sealPeriod`'s refusals, save→load (including the damaged-photo decay it caught), `closeDrift`'s nulls and its 14 lines, the 16-column sheet, the page pins
│   └── plural22.test.mjs           R3-22's 50 assertions over the last hand-spelled nouns: the grammar identity, the one-home pins, the census in both directions, the cadence sentences, the shape of every call, and the verb fence G1–G5
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
| `format.ts` | `formatCompactINR` (lakh/crore), `formatDateIN`, `changePct`, `initials`, `plural` (figure + noun in one decision, 73 lines / 6 exports), `pluralNoun` (the noun alone, for a figure some other formatter already printed — `plural(n, u)` is `` `${n} ${pluralNoun(n, u)}` ``, so the ending has one home) | Compact figures are for KPI tiles, not for a statutory column; **a count never hedges** — `plural(1, 'period')` prints `1 period`, and `(s)` in a sentence is a noun the writer refused to count (Rule 53). Three rules, no more: `y→ies`, a hiss `s/x/z/ch/sh→es`, else `+s`. **The kit agrees nouns only** — a verb, a pronoun and an irregular stay the sentence's business (R3-22, Rule 59) |
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
| `taxflow:compliance:<orgId>` / `taxflow:compliance-profile:<orgId>` | Compliance calendar | Filing profile and per-event filed state — and, since R3-7, the quarter's shop-stated cash tax under a `cash:<quarter>` key on the same envelope (`isCashTaxKey()` keeps it out of the filed-return count, so the vault never reads a rupee as a filing) |
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
| `taxflow:exports:<orgId>` | Exports | Undertakings, the shipping-bill / advance / refund paperwork a consignment has to prove, and the realisation credits typed here — **never the invoice value or the IGST paid**, which are re-read from `invoices`. Where `/fx` holds a deal for the same invoice number, its receipts are the counted figure and a credit typed here is printed as *not counted*. R3-10's refund track added **no field and no key** (`EXP_VERSION` still 1): it derives per-bill rupees and states on every open from this store, the invoice books, and `taxflow:filings:<orgId>` read read-only |
| `taxflow:payroll:<orgId>` | Payroll | Each person's **structure** — six monthly components with their PF/ESI flags, age band, state, joining and leaving dates, hours a day, a professional-tax figure — plus four exceptions per month (lost days, arrears, bonus, recovery). **No rupee is stored at all**: gross, both statutory legs, net pay, the employer's cost and the salary tax are recomputed on every load, the tax by walking the financial year (section 192) rather than by deducting a monthly percentage, and the rates are dated bands that read the ceiling in force on the run's own month (ADR-034). Since R2-32 the lost-day figure may arrive from a pasted shop sheet, but the sheet's text is never stored: what lands there is one `lop_days` number per person plus a `[attendance <month>]` sentence in that month row's note — re-importing a month replaces that sentence rather than stacking a second one, and hand-typed text after the em dash survives. Since R2-34 it also keeps the **day book** — one `attendance` mark per person per day (`{employee_id, date, mark, source: 'hand' | 'sheet', note, written_at}`), the month ruled with dates and written by a tap, bridged from a date-ruled pasted page, or cleared by the per-person eraser. The marks **carry no rupee**: one deliberate pull counts each person's lost days and pushes every candidate row through the same `validateInput()` the month form runs, a person the book never wrote is left **untouched rather than zeroed**, and an empty book refuses to pull at all — additive under the same `PAYROLL_VERSION = 1`. Since R2-33 it also holds the **letterhead** — 15 typed lines, 4 of them statutory identifiers — because a slip's heading is part of the salary register, not a register of its own: no new key, `PAYROLL_VERSION` stays 1, and **no slip is stored**, since a payslip is a reading of the month re-laid out (`src/lib/payslip.ts`). Since R2-37 the day book is also **evidence a project can draw hours from**: `/projects` reads the same marks through `markWork()` — a present day proposes an hours row at the register's own `hours_per_day`, half a mark proposes half, every other mark is refused with the register's own sentence — and a drawn row lands in the project's register; the book itself is never touched by a draw |
| `taxflow:audit:<orgId>` | Audit trail & period lock | The append-only **trail** (`seq` from 1, kind `sealed | released | refused | note`) and the **period seals** (a `month` or a whole `FY` window closed by the shop). It **holds no rupee**: a seal is a date range and an event is a sentence, and the money stays in the documents the seal only governs. `verifyChain()` reads by number so a hand-edit shows as a gap, a duplicate or a reorder; `sealPeriod()` refuses a period that has not ended and a window that overlaps a seal standing; `releaseSeal()` never removes the row — it stamps `released_at` and demands a `release_reason`, so a silent unlock is impossible; `sealGuard(orgId, date)` is the door read as a question — the banner a date field grows calls it and writes nothing; `askSeal()` reads the same answer and appends the attempt as a `refused` event; `requireOpenSeal()` is the throwing form a money writer calls, so a refusal cannot be forgotten by the page above it. **Since R3-5 the door is on the writers, not on the forms**: `create-invoice.ts`, `create-bill.ts` and `creditnote.ts` each ask it as their first statement, before a sequence number is spent, so 12 document paths inherit the seal without mentioning it (the invoice form, `/pos`, the `/recurring` catch-up, the `/offline` replay, `/sales-orders` and `/purchase-orders` converting, a challan becoming an invoice, the `/tally` import, the scanned bill, `/bills`, `/credit-notes`, `/debit-notes`), 1 is closed inside its own register library (`journal.ts`, asked before the legs are even read, and a draft dated inside a seal is refused too, because a draft dated there is a future posting dated there), and 6 are carried by the page that types straight into its table (expenses, payments, the paid/cancel stamps on `/invoices` and `/bills`, a `/quotations` conversion, the scanned-receipt half of `/ai/scan-bill`). `/audit` prints all 21 of those rows with the hand that asks each one, plus the 2 it leaves open by name — a master record and a return's filing status — rather than dropping them from the list. Joined the vault in the same round it was created (Rule 31, ADR-013) |
| `taxflow:journal:<orgId>` | Manual journal | The shop's own **heads** — each one declaring the single statement line it moves, out of fifteen slots (`revenue · purchases · expense · receivables · inventory · cash · bank · fixedAssets · otherAsset · payables · outstandingExpenses · gstLiability · loans · otherLiability · capital`) — and every **entry** struck against them: two or more legs that must balance to the paisa, each leg a **signed rupee in the head's own natural direction** (Rule 28, so no second sign is applied downstream), the `draft → posted → reversed` lifecycle, and the register's own high-water `seq` map the number is taken from (`kind:FY`, or `kind:all` once the shop's series drops the year — and the walk reads **every shape the kind has worn** through `seriesHistory()`/`usedNumber()`, so changing the prefix mid-year cannot re-issue a number, exactly as the order registers do under Rule 39). Unlike the registers above, this one **does hold rupees** — a hand-written depreciation charge has no document anywhere to be re-read from, so the entry's legs are the record — but it holds them as *stated movements on named statement lines*, never as a cash figure: the documents' own receipts, payments and tax arithmetics stay in Supabase, and the statements add the journal's lines to theirs rather than replacing them. A posted row is never edited or deleted (only reversed by a mirrored entry that re-summones the original's legs), a head with postings is closed rather than deleted, and every write asks the seal (`askSeal()`, Rule 38 — R3-5 left that door in the library, so the sentence a refusal prints is the engine's). Joined the vault in the round it was created (Rule 31, ADR-013, ADR-037). Since R3-17 a **work-in-progress pair drafted at `/inventory/recipes` lands here too** — through `writeEntry`, never beside it — each entry carrying the run's `JOB-<FY>-NNNN` number in `reference`, so the shelf and the books tie on one string |
| `taxflow:setup:<orgId>` | Business setup | The **branch register** and the **document-series register**. A branch is a registration: a 15-character GSTIN (the same shape rule the e-invoice builder checks — checksum digits are verified nowhere without a GSP, and the code says so), the state code the GSTIN starts with, and the pair is refused when they disagree, because place of supply and the CGST/SGST split read it. One head (the row the header prints by default), one code, one GSTIN per row; the head cannot close or delete until handed over, and a branch whose code is still stamped `[branch CODE]` in invoice notes can only be deactivated — `deleteBranch()` takes the reference check as an argument the page reads from the books, so the refusal comes from what the documents say, not from the modal asking. A series row dresses one kind (`invoice · quotation · challan · sales_order · purchase_order · journal` — the sixth joined in R3-2b and renders on `/business` with no page edit, since the page maps `SERIES_KINDS`) with prefix (≤ 8 chars, letters/digits/inner dashes), pad (1–8) and `include_fy` — and **counts nothing**: the invoice counter is the Supabase `invoice_sequences` row (whose own `prefix` column now stores the dressed prefix), the order kinds keep their registers' high-water marks, the journal keeps its own `seq` map, papers already issued keep the shape they were born with, and two kinds sharing one prefix are refused because they would issue the same number twice. **No rupee lives here** — opening balances stay on `/accounting`. Joined the vault in the same round it was created (Rule 31, ADR-013) |
| `taxflow:filings:<orgId>` | Filings & amendments | A **transcript, not a posting**: one row per `(form, period)` for the six kinds this register dresses (`gstr1 · gstr1a · gstr3b · cmp08 · gstr4 · gstr9`) and three cadences (`monthly · qrmp · composition`), each stating its status (`not_filed · filed · nil`), the day it was due **beside the rule that dated it**, the figures the return declares, and the fee and interest recorded as paid — plus, alongside, every **amendment** it carries (`gstr1a · table9a · invoice_omitted · note_omitted · itc_late`, each `open · carried · lapsed`) and the statutory window that governs it. **Dates are snapshotted then audited**: `expectedRows()` reads the shop's filing profile out of `compliance.ts` (since R3-6 that profile carries the `stateCode` that decides which of rule 61(1)(ii)'s two days a quarter falls on), while a **Q4 quarter carries the calendar year its months fall in**, so a 2025-FY Q4 return is due in April **2026**, not 2025. (Before R3-6 the emitter printed twelve **monthly** summary rows for a quarterly filer and this register folded them into four and disclosed the fold; R3-6 fixed the emitter, so `eventPeriod()` now folds a period **key** only — a row saved against any month of a quarter still lands in the quarter that owns it.) A late fee is a **slab, not a headline** (Notifications 19/20/21/2021 dated 01.06.2021 and 07/2023 dated 31.03.2023; the composition ceilings are labelled *this register's reading*), the three amendment clocks run off Circular 237/31/2024-GST dated 15.10.2024, and the section-59(6) bars — (a), (b), (d) — are printed as the reason a window has `lapsed`; an empty register legitimately prints the 59(6)(a) bar rather than a fake due date. The books-vs-stated **variance** names a head only when the gap is more than ₹1 and reports it as *books minus stated* (a positive diff means the books hold more than the return said). **A filing record is a transcript, not a book entry, so this register does not ask `sealGuard()` before it writes** — unlike the journal, which does. It instead **reads** the seals (`sealForPeriod()`, which since R3-5 is the one period→seal path and is built on `audit.ts`'s `sealForDate()` — the register's second spelling of the same question was folded into it rather than kept beside it): a period already under a standing seal is shown as closed paper and its row wears a lock badge, and `sealFilingsPeriod()` **hands** a close request to `audit.ts`'s own `sealPeriod()` — which keeps its rules (an ended period, no overlap), so this register never re-implements the lock and never keeps a second copy of it. A quarter is not a seal kind, so asking for one refuses with the months it would take and points at `/audit`. `deleteFiling()` refuses while an amendment still points at the row, and a removal is journalled as *removed from the filings register*. It **files nothing** — no row here is a GSP submission and no return is read from it — and **posts nothing** into `ledger.ts`; the figures are the shop's statement of what the portal holds, kept for history. Five outward figures a shop might expect are marked `NOT_TRACKED` rather than invented. Joined the vault as its **35th spec (30th restorable)** in the round it was created (Rule 31, ADR-013) |
| `taxflow:palette-recents:<orgId>` | ⌘K | Recently opened records |
| `taxflow:vault:<orgId>` | The books vault's own log | `VaultLog` — the last **30** backup and restore events (`at`, `kind`, registers, rows, chars, and a restore's `refused` count), which is where "days since the last backup" is measured from. **Deliberately never inside a vault file**: a backup that recorded its own backups would grow every time it was restored. Since **R3-9** a `backup` event also carries `fingerprints` — a `{rows, checksum}` per register, the *same* FNV-1a the file's block was packed with — so `registerFreshness()` can answer *which books moved since the last file* by comparing this browser's content against that memory, in seven states (`fresh · changed · new-since · cleared · nothing · unrecorded · never`). The fingerprints are a statement about **this device**: they do not travel in the file, so a second laptop restoring the same backup inherits the books and not the claim, and a backup taken before R3-9 — or a log hand-edited into a shape the loader does not recognise — degrades to `unrecorded` ("Cannot tell") instead of a guess. Holds no rupee; `loadVaultLog()` sanitises every event on the way in (Rule 46, ADR-043) |

Rules that make this safe:
- The key is namespaced by `orgId`, so a shared browser cannot leak one business's plan into another.
- Money records are never stored here. If a number belongs on a return, it comes from the database; local storage holds opinions, settings and declarations. Five registers are held to a stricter reading of that rule because their whole subject is money-shaped judgement: a cost centre stores a **share**, a project stores **measurements** — an hours row and, since R2-36, the id of the person whose hours they were, which is still an id and not a wage: the rupees it costs at are re-read from the payroll register's own figure for the entry's own month — and since R2-37 some of those rows are *drawn* from the payroll day book, which is still evidence: the mark prices nothing, and the drawn hour is the project's own row — a recipe stores **quantities and minutes**, a salary register stores **structure and exceptions** (and, since R2-34, the day book — evidence marks that carry no figure at all), and the audit register stores a **sentence and a window** (a sealed period is a date range, an event is prose; the rupees the seal protects are not in this file). The first three re-read their rupees from the documents on load (a cost centre and a project through one shared reader, `costcentres.bookDocs`, so a cancelled row or a signed credit note cannot have two opinions about what they mean; a recipe from `products.purchase_price`, so a price corrected on the master re-values every recipe that uses it), the fourth recomputes every figure on a slip from its own components, the dated rate bands and a walk of the financial year, and the fifth prices nothing at all — it only records that something was decided. **The journal register is the one deliberate exception, and the exception is stated rather than smuggled in**: `taxflow:journal:<orgId>` stores signed rupees, because a hand-written depreciation charge, a loan that arrived without a bill or drawing taken from the till has *no document anywhere to be re-read from* — the entry is the only record of it. What the rule still holds on is direction: the journal stores **stated movements against named statement lines**, never a balance, never a cash position, and never a figure the documents already carry. Its own proof of that is `plugProof()` — a balanced entry changes both sides of the ledger by the same amount, so it moves the lines it names and provably cannot move the derived "Capital account (derived)" figure — and its rupees stay the shop's: no return, no portal and no GST workpaper reads this register (Rule 40). Nothing saved here can rot: a journal row is a dated statement of what was decided on that day, and the day it was wrong is answered by a reversal rather than by an edit that would silently rewrite history.
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
| `/gst/calendar` | `compliance.ts`, `filings.ts` (read-only: `loadFilings` + `depositFor`), `jobwork.ts`, `exports.ts`, `payroll.ts` | Filing profile → FY of due dates → late-fee estimate; a QRMP year emits the four quarters, eight IFF windows and eight PMT-06 deposits rule 61/59 name, and each deposit's rupee is folded from the filings register's own filed 3B (a labelled **ceiling**) or from the shop's stated cash tax (a **ready** challan); the rows a register owns are **read from that register** — job work, exports, and since R2-31 the salary dues (`payrollEvents()`), whose arrival retires the profile's guessed monthly PF/PT tick-box for every month the books ran. **Since R3-6 a QRMP year emits the period the rule names** — four GSTR-1/GSTR-3B quarters rather than twelve monthly summary rows, plus eight IFF windows (rule 59(2), the 13th) and eight PMT-06 deposits (rule 61(3), the 25th); `qrmpCategory(stateCode)` places the shop in rule 61(1)(ii)'s 22nd/24th row and is shared with `filings.ts`, the state prefilled from the primary `gst_registrations` row and an unnamed one printing the earlier day as *unchecked* (Rule 43) |
| `/gst/gstr9` | `gstr9.ts` | Annual tables from documents + declared 3B, 180-day watch, 9C recon |
| `/gst/gstr4` | `gstr4.ts`, `gstr9.ts` | Quarterly CMP-08 grids from documents, composition rate ceilings |
| `/reports/registers` | `registers.ts` | Party-wise, HSN/SAC, B2B, state-wise, e-way bill registers |
| `/reports/targets` | `targets.ts` | Festival-weighted split, prorated pace, product goals |
| `/ledger` | `party-ledger.ts` | Document-first payment linking, running balance, statements |
| `/accounting` | `ledger.ts`, `journal.ts` (rows via `journalRows()`), `costcentres.ts` | P&L and always-balancing balance sheet. Since R3-2 the opening register grew `bank · receivables · payables · as_of` beside the original four: `computeBalanceSheet` gates the three new money lines behind `openingStood` (they count only once the day the books were picked up has arrived), prints the opening receivable/payable as named sub-lines inside the totals, and states the honest limit beside the figure — a payment grows `cash` but cannot reduce an opening receivable, because the engine will not guess which pre-books paper it settled. Since R3-2b the same page hands **one** `journalLines` array to both derivations — the P&L reads it inside the chosen window, the balance sheet reads it up to `asOf` — and prints the journal's contribution as *from the journal* sub-lines beside the documents' own figures rather than merging them (Rule 33). `plugProof()` runs over the postings up to the window end and the proof prints on the page: the entries balance, the residual is ₹0.00, and the derived capital line is unchanged by the rupees the register moved |
| `/journal` | `journal.ts`, `audit.ts` (`askSeal` inside the library; `sealGuard` for the banners on the page), `ledger.ts` (the reader, not a writer), `setup.ts` (the series shape) | The one place a shop may state a movement no document raised. **Heads** declare which statement line they move (fifteen slots, each with a group, a natural side and where it lands) and are **closed rather than deleted** once a posting has named them; **entries** are two or more legs that must balance to the paisa — an unbalanced pair is refused at posting with the difference named, a ₹0 leg, a sub-paisa leg, the same head on both sides and a leg naming a closed head each carry their own sentence — and live `draft → posted → reversed`, where **a posted entry is answered by a mirror, never edited**: `reverseEntry()` re-summons the original's legs with every side flipped, demands a reason, takes a fresh number, and leaves both halves on the register netting to nothing. `askSeal()` is asked **before the legs are read** — a draft dated inside a standing seal is refused too, because a draft dated there is a future posting dated there — and the refusal logs the attempt as a `refused` event, so the attempt lands on the trail (Rule 38). Numbers come from the journal's own `seq` map and are dressed by the business register's `journal` series (Rule 39 — `/business` shapes it, this register counts it), previewed by `peekNumber()` which allocates nothing — and since R3-8 a draft may arrive from the **Tally import** as well, through this register's own `writeEntry`, only when every leg names a head that already stands here — and since R3-17 a built run's **work-in-progress pair** arrives the same way, its `reference` carrying the job number so `/journal?q=JOB-…` opens a run's paper (the pairing, the opt-in time leg and every refusal sentence live in `wip.ts`, a reading with no door of its own). Two tabs (the register, heads) grew a third at **R3-14** — `?tab=trial`, `trialBalance(store)` read-only over this register's **own posted legs**, and the boundary it lifted is stated on the card rather than assumed (ADR-037 amended by ADR-048: a trial balance *of these rows*, not *of the company*) — so three tabs and three CSVs (11 columns for the postings, 7 for the heads, 10 for the trial balance), two ⌘K actions, a sidebar row under *Reports & AI* beside *Financial Statements*, a vault spec, and two boundary columns printed on the screen — the statement lines this year's entries actually moved, each tagged *from the journal*, and four facts about what the register is not: no return reads it, it invents no document, it lives in this browser at `taxflow:journal:<org>`, and a posted entry is only ever reversed |
| `/payments/links` | `payments.ts` | UPI deep links, WhatsApp reminder copy |
| `/bank` | `bank-statement.ts` | Statement layout, line direction, scored candidates and confidence tier |
| `/tds` | `tds.ts` | Section table, threshold modes, deposit calendar, interest and 26Q fee |
| `/inventory/reorder` | `reorder.ts` | Demand window, (s, S) policy, supplier grouping |
| `/challans` | `orderflow.ts`, `setup.ts` (`resolveSeries` + `loadSetup`) | Rule 55 reason sets, delivery Challan → invoice on the same flow; since R3-2 the number's **shape** (prefix / pad / FY inside) is read from the business register and handed to `peekNumber()`/`takeNumber()`, while the counter stays in this kind's own store; since R3-8 a draft may also arrive from the **Tally import** through this kind's own `appendDraft` — untaxed lines, reason `other` until a human reads it |
| `/sales-orders`, `/purchase-orders` | `orderflow.ts` (via `components/OrderRegister`) | One register, both directions; conversion writes a real invoice or bill |
| `/inventory/batches` | `batches.ts`, `godowns.ts` | Lot-level in/out, FEFO draw order, expiry watch |
| `/inventory/serials` | `serials.ts` | One row per unit; warranty read from the latest sale |
| `/inventory/godowns` | `godowns.ts`, `batches.ts` | A transfer is a lot split, never a second stock ledger |
| `/inventory/recipes` | `bom.ts`, `batches.ts`, `orderflow.ts` (`loadStore` / `saveStore` / `newDoc` / `validateDoc` / `raiseDrafts`), and since R3-17 `wip.ts` + `journal.ts` (`loadJournal` / `newEntry` / `newLeg` / `writeEntry`) | A recipe stores **quantities and minutes** and re-reads cost from `products.purchase_price` plus the dated shop-rate rows in `taxflow:bom:<orgId>` — each leg priced at the rate in force on its own day; a build stores what was drawn **from which lot** (FEFO proposed, overrulable), moves shelf stock only through `record_stock_movement`, and mirrors each draw into `taxflow:batchmoves:` as an `adjust` move carrying the job number, while the finished units land as their own lot in `taxflow:batches:`. Since R2-30 the materials board also reads `vendors` + `purchase_bills` + `purchase_bill_items` **on demand** and writes purchase-order drafts through `raiseDrafts()` — the order register's numbering, not its own — storing nothing new. And since R3-17, a built run's cost can become paper: `wip.ts` composes the work-in-progress pair — the run debits Work-in-progress and credits raw stock (plus, **only when the shop names an expense head**, the priced shop minutes), the finish hands the same rupee out to finished stock so WIP nets to nil across the pair — and the page lands both halves as *drafts* through `journal.ts`'s own `writeEntry`, creating no head, asking no second seal, and refusing with the engine's own sentence wherever a rupee or a head is missing |
| `/recurring` | `recurring.ts`, `orderflow.ts` | Cadence → a real invoice, billed back into the FY it belonged to |
| `/fx` | `fx.ts` | Dated rate ledger; realised and unrealised kept beside, not inside, the rupee books |
| `/gst/job-work` | `jobwork.ts` | Section 143 return clock and the four ITC-04 grids |
| `/gst/exports` | `exports.ts`, `fx.ts`, `recurring.ts` (`addMonthsISO`, `daysBetween`), `filings.ts` (read-only: `loadFilings` on the page, and `periodLabel` / `periodRange` / `FilingsStore` inside the library — never saved back) | Three clocks per consignment: the undertaking that made it zero-rated, the dated FEMA window the proceeds have to land inside, and — since R3-10 — **the refund track**: `refundTrack(views, filings)` groups goods files by the trimmed shipping-bill number (a file with no number is its own row, never merged with another unnamed consignment), and answers per bill which return the money travels on is missing or short. The statute files no application on that route — the bill *is* it — so the engine reads **GSTR-1 tables 6A/6B and GSTR-3B table 3.1(b)** instead of raising a form, resolving each period by **date containment** (`coveringRecord` against `periodRange`) so a QRMP quarter and a monthly return both match and a month beats a quarter as the narrower reading. Six `ScreenKind`s take the supplies the mechanism does not cover, each with the reason printed; an empty filings register makes every readable bill **`unread`** — counted apart from at-risk / waiting / clear, and worded as the app's own ignorance rather than a claim about the portal. Because a filings row stores a return's **total** stated IGST while the portal compares parts of it, the soundness runs one way: over the total is provably short, inside it proves nothing, so `clear` prints *Nothing here blocks it*. Every figure is re-derived on open — `EXP_VERSION` is still **1**, no field, key or route was added, and the tab writes nothing anywhere. Band tables carry their instrument and their disagreement; the calendar reads the same `watchRows()`; five tabs, seven CSVs. Since **R3-11** the register is reachable from ⌘K — its files become `export_file` record rows (`registerRecordCommands`; a goods file carrying a bill lands on `?tab=track&q=<bill>`, a service or bill-less file on `?q=<invoice>`), a `IGST refund track` action opens `?tab=track`, and the page reads `?tab=` through the same five-value guard its tab strip uses (Rule 48, ADR-045) |
| `/gst/filings` | `filings.ts`, `compliance.ts` (the filing profile + the year's events), `audit.ts` (a row's seal read through `sealForDate()` inside `registerRows()`, and `sealPeriod` handed only when the shop clicks through `sealFilingsPeriod()`), the outward documents read the way `/gst/gstr9` reads them (the books side of the variance) | The **history of what each return stated and the paper that missed its window** — a transcript, not a posting and not a submission. One row per `(form, period)` over six forms (`gstr1 · gstr1a · gstr3b · cmp08 · gstr4 · gstr9`) and three cadences (`monthly · qrmp · composition`), each stating its `not_filed · filed · nil` status, the due day **beside the rule that dated it**, the figures it declares and the fee paid; due dates are **snapshotted from `compliance.ts` then re-derived by `statutoryDue()`** and every disagreement prints as drift (the profile carries the `stateCode` that dates a QRMP quarter since R3-6, and a **Q4 carries the calendar year its months fall in**), with `eventPeriod()` folding a row's period **key** into the quarter that owns it; since R3-7 this store is also **read by `/gst/calendar`**, where `depositFor()` folds the base quarter's filed GSTR-3B row into that screen's PMT-06 ceiling, and since R3-10 by **`/gst/exports`**, where `refundTrack()` reads each period's filed GSTR-1 and GSTR-3B totals to decide whether a shipping bill's refund can move — in both cases loaded through `loadFilings()` and never saved back. A late fee is a **slab** (Notifications 19/20/21/2021, 07/2023) not a headline; the three **amendment clocks** (Circular 237/31/2024-GST) and the section-59(6) bars decide whether a missed correction is `open`, `carried` or `lapsed`; the books-vs-stated **variance** names a head only past ₹1 as *books minus stated*; a sealed period is read and badged and a close is **handed** to `/audit`; deletion is refused while an open amendment points at the period and is journalled. Three tabs (`returns · amendments · variance`), **four** CSVs (27 / 17 / 10 / 16 columns), `?tab= ?period= ?new=1 ?settings=1` deep links, two ⌘K actions **plus, since R3-11, `filing` and `amendment` record rows in ⌘K live search** (a period found by form, an amendment by kind, each landing on `?q=` / `?tab=amendments` the page already reads), a GST-hub card, a sidebar row, and the `filing` glyph. **Since R3-12 the amendments tab also prints what each waiting correction costs** — a **read-only** fold (`amendmentCosts` / `amendmentCostTotals`) over the same rows, with no new field or key (`FILINGS_VERSION` still **1**): an omitted document runs under **rule 88B(2)** on the **gross tax that remains unpaid** (the register cannot see the electronic cash/credit ledgers, so it never borrows the net-cash base rule 88B(1) uses for a late-filed *return*), measured from the corrected period's own GSTR-3B due day — read in a preferred order the register can stand behind (the filed row's `due`, then its `filed_on`, then `statutoryDue()` re-derived, then *nothing*, which is the `cannot_tell` state and never a zero) — to today, at the register's own 18% simple-interest convention. Six states, only two of them money: `running` and `carried_undated` add up, while `reduce_takes_tax_out`, `no_tax_to_run_on`, `not_due_yet` and `cannot_tell` each print a labelled reason and are counted *out of* the sum; a carried row the register cannot stop on a payment date prints the same arithmetic **to today as an upper bound beside the reason**, never a lower figure it cannot support. Eight citations back it: **6 read verbatim from the CBIC *Handbook on Interest, Late Fee and Penalties under GST*** (rule 88B(2)'s gross language, its p. 5 commentary, rule 88B(1) and the Notification 14/2022-CT insertion, the 18% rate under Notification 13/2017-C.T., section 50(2)'s day-succeeding start), **2 the register's own `Reading:`** (the ÷365 convention, the upper-bound rule). It files nothing and posts nothing into `ledger.ts`; six outward figures stay `NOT_TRACKED` (R3-12 added *the date a correction tax actually left*) (Rule 49, ADR-046) |
| `/cost-centres` | `costcentres.ts` | Stores a **share**; rupees re-read from documents through `bookDocs` |
| `/projects` | `projects.ts`, `costcentres.ts` (`bookDocs`), `payroll.ts` (page-side only: `costPerHourFor`, `employeeById`, `offRosterWhy`), `attendance.ts` (page-side only: `dayBook`, `markWork`) | Stores hours and document ids; labour priced at the billable rate, and — since R2-36 — *costed* wherever a row names its payroll person: the page asks `costPerHourFor` for each (person, entry-month) and hands the rows to `costHours()`, which joins each entry's hours to its person's own figure — `HourCostRow` is a structural subset of payroll's `HourCost`, so the **library** imports no payroll code — folding a refusal with the register's own words where the figure is missing (`offRosterWhy`). The cost prints as *after named hours* beside contribution, marked partial while hours remain unpriced, and never folded in (rule 47 window cited not settled). Since R2-37 the timesheet can also **draw** hours from the kept day book: the page reads a person-month of marks through `markWork()` and folds them into structural `BookWorkDay[]` rows for `drawHours()` — present days proposed at the register's own `hours_per_day`, half a mark proposed as half, every other mark refused with the register's own sentence, a day already on the project un-tickable, hours already recorded elsewhere on that date tickable but not proposed, and `ticks: null` meaning *proposal, never row* — and only the shop's tick reaches `upsertEntries()`, still through `validateEntry`. The library imports neither `attendance.ts` nor `payroll.ts` |
| `/payroll` | `payroll.ts`, `attendance.ts`, `bank-statement.ts` | Stores structure and exceptions and **no rupee**: components → gross → PF/ESI → net → tax are recomputed per load, the tax by walking the financial year under section 192 (elapsed months actual, later months projected, the balance spread over the months left), the rates from dated bands that read the ceiling in force on the run's own month; dues, ESI returns and Form 16 emerge as calendar events, and the month's employer cost divides into the hour cost this register prints on its own Cost tab — which `/projects` reads as data since R2-36 (`costPerHourFor`, per person per entry-month), where a named hour is costed beside contribution and never inside it. The month tab also reads the shop's attendance sheet — a paste, not a table — and for that it borrows `detectDelimiter()` and `splitRow()` from `bank-statement.ts` rather than writing a third CSV reader: the same two functions that score a bank's statement score a supervisor's sheet (R2-32). Since R2-34 the same page keeps the days: `attendance.ts` rules the month into a **day book** — a tap writes one mark per person per day, a date-ruled pasted page bridges into marks (a refusal stops the whole page by its machine-readable `kind`; a blank row is noted and skipped, never read as a month of presents), each person-month is erasable, and one deliberate **pull** re-counts lost days through the month form's own `validateInput()`, leaving an unwritten person untouched rather than zeroed. Its Month tab and every open slip link out to `/payroll/payslip` for the paper version of the same figures. Since R2-37 the day book is also evidence a project draws from: `/projects` reads the same marks through `markWork()` — a present day proposes an hours row at the register's own `hours_per_day`, half a mark proposes half, every other mark is refused with the register's own sentence — and the drawn row lands in the project's register, never back in the book |
| `/payroll/payslip` | `payslip.ts`, `payroll.ts`, `pdf-export.ts`, `words.ts`, `format.ts` | The register as A4 paper, storing **no figure**: `buildPayslip()` lays out the `Payslip` that `payslipOf()` computed, so a slip cannot disagree with the screen, and the only writer here is `saveLetterhead()` (15 lines, 4 of them statutory identifiers, held inside `taxflow:payroll:<orgId>`). *Net payable* never *paid*, four standing boundary sentences on every sheet, a dash with its reason wherever a figure is absent or a code was never typed, **no deduction or employer block laid out for a month the register refuses** (`printable: false`, Print/PDF disabled with the reason), the exceptions kept in a `.no-print` strip on the owner's side of the paper, and `monthPack()` writing the computable slips as one PDF — a page per person — with every refused person printed beside the pack instead of dropped |
| `/audit` | `audit.ts`; the seal is asked through `requireOpenSeal()` inside the three shared writers, through `askSeal()` on the six page-carried paths, and the banner every one of them grows is `components/SealNotice.tsx` | Stores a **sentence and a window**: a `seq`-numbered trail `verifyChain()` reads by number so a hand-edit is a gap, a duplicate or a reorder, and a `month` or `FY` seal a write path can ask. `sealPeriod()` refuses a period that has not ended and a window that overlaps a seal standing; `releaseSeal()` never removes a row — it stamps `released_at` and demands a reason, because a silent unlock is exactly what an auditor looks for. A refusal has two halves: the write is stopped and `recordRefusal()` appends the *attempt* as a `refused` event, so the edit that never happened is still evidence. `/journal` asks it one step earlier, before its legs are read, and refuses a **draft** dated inside a seal too, because a draft dated there is a future posting dated there. The stat card counts render as strings so `StatCard`'s default `formatCompactINR` never turns a count into a rupee. **The coverage is printed, from the list, not from prose** (R3-5): the page keeps one `GUARDED` list — 21 rows, each tagged with the hand that asks (`the writer` / `its own engine` / `this page`), and the paths deliberately left open (*GSTR-1 filing status*, *Master records*) stay on the list tagged `not wired` — and its sentences are counted off that list (`sealedDoors()`, `doorsWriter`/`doorsEngine`/`doorsPage`), so a claim of coverage cannot outrun the wiring, a new door changes the sentence by itself, and the suite fails if a listed href stops being a route or a door marked guarded has no guard in its source. Since **R3-19** a third tab, `?tab=close` (with `?month=YYYY-MM`), is the page's first and only server read: it fetches the four dated document tables for one window and hands them, plus the journal, orderflow, filings and trail it already holds, to `period-close.ts`, which answers *what is still moving in this period*. The tab prints rupees — through `ledger.ts`'s own `computeProfitLoss()`, so `/audit` and `/accounting` cannot disagree — the unfinished paper with a link to the register that owns it, the returns rows that cover the month, the trail's own history of the window, and the seal's state beside the close's state rather than instead of it. Its one button is `openSealFor(month)`, which presets the **existing** seal dialog; the reading never calls `sealPeriod()`, never appends an event, stores nothing, and prints `unread` where a register could not be read (**Rule 56 / ADR-053**; no new key, route, glyph, component or spec — `67 / 57 / 10 / 74 / 35`, build table **69 rows**). Since **R3-21** the dialog it presets hands `sealPeriod()` a **photograph** of that reading — the same money, counts, findings and `unread` list, dated — and the tab then prints **As sealed** against **Read today** with the drift on each of 14 lines plus the findings matched by `key`, keeping a money line back with its own sentence when either side holds no document figure, and saying *"No photograph stands on this seal"* where an older seal kept none. The reading still stores nothing: the *store that owns the seal* keeps the picture, and `sealPeriod()` refuses one that arrives unasked (**Rule 58 / ADR-055**; still no key, route, glyph, component, spec, `.sql` or row, `AUDIT_VERSION` **1**, and the ledger unmoved at `67 / 57 / 10 / 74 / 35`, build table **69 rows**) |
| `/business` | `setup.ts` | The **branch register** and the **document-series register**, and deliberately neither a counter nor a till. A branch row is a registration — 15-character GSTIN and the state code it starts with, refused as a pair when they disagree, one code and one GSTIN each — with a single head that cannot be closed or deleted until handed over; `/invoices/new` offers an *Issuing branch* that swaps the printed seller header and stamps `[branch CODE]` into the invoice notes (replace-never-stack), and the print page reads the stamp back, printing a named fallback banner when the register can no longer answer. `deleteBranch()` refuses a branch documents still name — the page reads that from the invoice rows themselves, not from its own modal. A series row dresses one kind's number — six kinds now, `invoice · quotation · challan · sales_order · purchase_order` and, since R3-2b, `journal` (born `JR-<FY>-NNNN`), which the page renders off `SERIES_KINDS` with no page edit (prefix ≤ 8, pad 1–8, FY in or out), refuses a prefix two kinds would share, and **counts nothing**: `create-invoice.ts`, the quotation register (its own numbers *and* the invoice it converts into), `orderflow.ts` (challans, both order registers, and the recipes board's `raiseDrafts`), and `journal.ts` (through `resolveSeries()` on every write, its own `seq` map still the counter) all take the dressed format, while `peekNumber` previews allocate nothing. **No rupee lives on this page** — opening balances are `/accounting`'s |
| `/tally` | `tally.ts`, `create-invoice.ts`, `create-bill.ts`, `creditnote.ts`, `journal.ts`, `orderflow.ts` | Parse → plan with blocked rows and reasons → replay through the normal write path; note vouchers plan against the document they name — register or same file, never invented — and write through the same creators the note pages use; since R3-8 a journal voucher plans legs only onto heads the journal register already holds and writes as a **draft** through that register's own `writeEntry` (seal asked, no number burned until posting), a delivery-challan voucher raises a **challan draft** through orderflow's own `appendDraft` (number from that series' high-water mark in the shop's series shape), and cash/bank legs, unbalanced vouchers, unknown heads, parties and items block rather than being invented; export builds the XML envelope |
| `/vault` | `vault.ts` (every register's `save*`/`load*`), and since R3-13 `persistence.ts` (read-only: `persistencePlan()` folded over `vault.ts`'s `REGISTERS`) | Thirty-five named specs — thirty restorable, five evidence-only — into one portable file; restore writes through the owner and reads back through its own loader, `from → seen` per register. The journal spec counts heads *and* postings, and requires both arrays by shape before anything is written, because its parser drops a leg naming a head the file never carried and a wrong-version file would otherwise restore as a shorter register and print as a success; the filings spec (R3-4) counts returns *and* amendments and likewise requires both arrays by shape, since `parseFilings` keeps the first row per `(form, period)` and a wrong-version file would restore as an empty register that prints as a success. Since **R3-9** the Registers tab carries a *Since your file* column and a *What moved since your last backup* card, both fed by `registerFreshness(orgId)` — called in exactly the two places the page's snapshot is built (the load effect and `refresh()`), so the existing `recordBackup → refresh()` path re-answers the question on the same click a backup is taken — with `atRiskRows()` naming the books a browser wipe would take, and the *Last backup taken* stat counting them (**Rule 46 / ADR-043**; no new key, spec, route, glyph or component). Since **R3-13** a fifth tab, `?tab=persistence` "Server plan", folds `persistencePlan()` — the read-only register-persistence inventory that draws its list live from `REGISTERS` (Rule 37) and sorts all 35 books by what a browser wipe destroys (17 authoritative / 7 decision-input / 3 reconstructible / 8 device-by-design; 24 need a server, 30 already restore) — into a four-class summary with counted chips, a 12-column CSV, a seal cross-check over the 8 `asked-*` claims each naming an `/audit` `GUARDED` door the suite re-reads (Rule 42), and three labelled `read: 'own'` readings; `persistence.ts` is the round's one new library, and because it is a **reading, not a migration** — no new register, key, route, glyph, component, spec, `.sql`, RLS or row — the `/vault` tab lives in a page that already exists, so the route table stays at **69 rows** (**Rule 50 / ADR-047**) |
| `/portal` (public) | `portal.ts` | The whole statement encoded in the URL fragment — nothing stored server-side |
| `/pos` | `barcode.ts`, `create-invoice.ts` | GS1 check digits, EAN/UPC variants, cash sale write — and since R3-5 the sale inherits the period seal from the writer, so a counter bill dated inside a closed month is refused and the seal's sentence prints in the form's own error line |
| `/offline` | `outbox.ts`, `create-invoice.ts` | Queue, replay, sequence numbering — replay goes through the same writer, so a queued invoice whose date has since fallen inside a seal is refused on the way in and the refusal is kept on the entry rather than the row being forced through |
| `/ai/scan-bill` | `bill-text.ts`, `ocr.ts`, `create-bill.ts`, `audit.ts` (`askSeal`) | Field extraction, GST cross-validation, confidence. The bill half inherits the seal from `create-bill.ts`; the receipt-kept-as-an-expense half types into `expenses`, so the page asks the door itself |
| `/ai/ask` | `ask.ts` | Intent + period parsing, filters, 17 report intents |
| ⌘K anywhere | `commands.ts`, `nav.ts`, `deep-link-search.ts` | Ranking, entity search, `?q=` / `?tab=` deep links. Three synchronous live sources over localStorage — order-flow docs (`orderRecordCommands`) and, since **R3-11**, the filings register and export files (`registerRecordCommands`: `filing` / `amendment` / `export_file` groups) — each row printing only the register's own meta labels and landing on a tab / `?q=` the page already honours (Rule 48, ADR-045) |

---

## 15. Verification

A feature is not done until it has been seen working:

```bash
npx tsc --noEmit
npm run build          # watch the route table: static / prerendered / dynamic
npx eslint <touched files>
node --experimental-strip-types --no-warnings --import ./tests/register.mjs ./tests/<suite>.test.mjs
```

Run that from the repo root with the Node this project is developed on (nvm v24): the `node` on `PATH` is Homebrew v20 and refuses `--experimental-strip-types`. Suites live in `tests/` and are committed — seven of them at the close of R3-22 (`plural22` 50 · `seal21` 174 · `close19` 209 · `wip17` 92 · `copy16` 70 · `drive20` 71 · `mono18` 18 = **684 assertions, 0 failing**). `/tmp` has destroyed the assertion stack three times, most recently in the days before R3-16, taking the eight suites that stood at R3-15 (1,000 assertions) with them.

Then in the browser at `http://localhost:3000`: load the page, exercise the golden path with real data, check the console for errors, and check the layout at both a desktop width and a phone width. Pages that prerender and use `useSearchParams` need the `XPageInner` + `<Suspense>` split.

The phone check is **ancestor-aware**: an element whose `scrollWidth` exceeds its `clientWidth` is only a problem if no ancestor clips or scrolls horizontally (`overflow: hidden` on a header swallows its own decorative `::after`; an `overflow-x: auto` tab bar is allowed to scroll). Measure the *document* — `docScrollWidth == clientWidth` at 355px — and pin a same-origin iframe at the target width to read it, rather than blaming the widest child.

When the driver cannot measure — the in-app surface is unattached and reports `window.innerWidth === 0`, so screenshots, pointer clicks and any width pass are impossible — say so in the round's ledger and substitute a **static** audit of the page's own CSS (every token the new rules reference resolves, breakpoints named, no new hex literals), and drive the golden path through `evaluate_script` with DOM `.click()` plus native value setters and bubbling `input`/`change` events. A static check is not a measured pass; never record it as one.

**A suite is not the browser (R3-15, Rule 52 / ADR-049).** The signed-in live drive that R3-4 → R3-14 each printed as owed was run read-only over an org whose `taxflow:*` registers had been cleared from outside the app (the session itself lives in the `sb-*-auth-token` **cookie**, so a cookie-signed profile with zero registers renders every register empty — which is the state to look at, not a state to avoid). It found seven defects no `/tmp` suite had, all of the same species: **an engine that answers the empty case truthfully while the page renders that answer as a verdict.** `verifyChain([]) → {ok: true, count: 0}`, `trialBalance(empty) → foots: true` at 0 = 0 and `plugProof([]) → legs: 0` are all correct; `/audit`, `/journal` ×2 had dressed those answers as green ticks, and the repair is the **sentence, not the arithmetic** — every proof card now names a third state (*proven / contradicted / nothing to prove*) through an `is-nil` dot and an existing glyph. Two further findings were this repo's own written conventions regressing because only the eye enforced them: a count reaching `StatCard` as a number prints **₹0.00** (the kit routes numeric values through `formatCompactINR`; pass counts as `String(...)`, or use `StatRow`, which takes a `ReactNode` and formats nothing), and a label that types a register count is a second copy of that number (`All 30` stood over **35** — Rule 37, met in a string). Route-table counting carries its own trap: pipe `npm run build` to a file, strip ANSI with `sed -e 's/\x1b\[[0-9;]*m//g'` and set `LC_ALL=en_US.UTF-8`, or a loose parse of an unstripped log reads **1** row instead of **69**. Viewport emulation is still unavailable on the connected surface, so a width claim from a container squeeze (`body` pinned to 375 px) is a **static read**, not a measured pass.

**A hedge is a noun the writer refused to count (R3-16, Rule 53 / ADR-050).** R3-15's drive named four copy defects and deliberately left them; R3-16 closed all four in-repo, with no new register, key, route, glyph, component, spec, `.sql`, RLS rule or row. The largest was also the one whose *figure* was wrong: the backlog said **125 `(s)` across 29 files**, and that number came from `grep -o "(s)" src | wc -l`, while the sentence quoting it credited `grep -rc "(s)" src`, which draws **112 matching lines** — two instruments, one quoted. Re-measured in both trees with the same instrument, 125 was real but **44 of those occurrences are not copy**: they are call sites on the one-letter identifier `s` (`{c.render(s)}`, `openSplit(s)`, `Number(s)`, `/^(\d{5})(\.\d+)?$/.exec(s)`), which no pluraliser can reach and no test should chase. The removable hedges were **81 sites across 14 files**, and every one of them is gone — `tally` (36), `/gst/filings` (18), `/bank` (6), `lib/attendance.ts` (6), `/expenses` (3), `lib/bank-statement.ts` (9→5), `/recurring` (4→3) and seven singletons — leaving exactly the 44 call sites (`grep -o` in the working tree: 44 / 17 files, all identifier usage). The pluraliser has **one home**, `plural(count, unit)` in `src/lib/format.ts` (37→52 lines, 4→5 exports), promoted from the helper that was private to `vault.ts` (1,597→1,587) and now imported by 15 files; inline `count === 1` ternaries remain only where the number and the noun print apart. *(Amended at **R3-22 / Rule 59**: that last clause was the escape hatch, and the tree drove through it — **249 suffix lines across 46 files** plus **43 whole-word `one`/`many` pairs across 12** at this round's base, libraries as much as pages. `format.ts` is now **73 lines / 6 exports** with `pluralNoun(count, unit)` beside `plural()` for exactly the apart-printing case, the hand-spelled count is **0**, and what stays inline is **10 verb-suffix lines in 8 files** plus 4 `person`/`people` choices — verbs and irregulars, which the kit does not own and the sentence does.)* The other three: `/journal`'s three starter-head offers share one module-scope `STARTER_LABEL` and one `icon="plus"` (a duplicate label was a second name for one action); the filings card is *"At risk this year"* and its sub-line states three truths with no `(s)` in it, its empty branch reachable through `exposureOf()` rather than asserted only in source; and ⌘K now answers *"March"* because `PERIOD_KEYWORDS` in `src/lib/commands.ts` (1,049→1,071) tells the palette which two pages print **computed** periods — `/gst/calendar` and `/gst/filings` — instead of making the synchronous search recompute the calendar board, which would have meant a fourth `RegisterEntity` and a lie about what the palette indexes. The palette says its own boundary in its own copy (`CommandPalette.tsx` 323→328, `.tf-cmd-none-sub` in `globals.css` 1,011→1,020). And the round's suite is **committed**, not scratch: `tests/hooks.mjs` (48) + `tests/register.mjs` (8) + `tests/copy16.test.mjs` (68 assertions, 197 lines) sit in the repo because `/tmp` has now deleted the assertion stack three times — the last wipe took R3-15's eight suites (1,000 assertions) days before this round ran, so the carried counts are each round's own record and re-run never. What the eye still owes: the four repairs are **typechecked, lint-neutral, built (69 rows), suite-green, and on three prerendered (`○`) routes**, but the browser session was lost mid-round (`/gst/filings` → `/login`), so no signed-in look at them happened; that drive is task **#278**, in the same honest shape as #216 → #217.

**A reading may become paper only through the door of the register that owns the paper (R3-17, Rule 54 / ADR-051).** §8 #10's last clause — *no work-in-progress posting: the labour and overhead legs are readings, not journal entries* — named its blocker honestly: a posting engine, and a posting engine is `/journal`. That engine shipped at R3-2b and footed itself at R3-14, so R3-17 closes the clause the only honest way: `src/lib/wip.ts` (the 56th library, 387 lines) is a **pure reading** that composes, for a built-and-moved run, the pair of balanced entries a completed build *is* — the run puts material (and, only when the shop itself names an expense head, its priced shop minutes) into Work-in-progress; the finish hands the same rupee out to finished stock, so WIP nets to nil across the pair — with every hole in the shop's data answered by a refusal sentence rather than a partial total, all arithmetic in `journal.ts`'s own `paise()`, and heads checked on the register, open, in the right slot, used once. The page owns no arithmetic and **no door of its own**: both entries land through `writeEntry`, which asks the seal before anything else — so a sealed build date refuses a WIP draft exactly as it refuses a typed entry — and burn no number until the shop posts them on `/journal`. The tie is the job number: `reference` carries `JOB-<FY>-NNNN`, the same string the movement notes carry, so `/journal?q=JOB-…` and the run's own row cannot disagree about which paper is which shelf event — and a cancelled run with live paper is pointed at that register to delete or reverse it, never quietly unwritten from here. R3-8's import discipline repeats at this door: **this page creates no head**; an empty picker sends the shop to `/journal` to name one. Scope: no new `localStorage` key (the drafts live in `taxflow:journal:`), no new route, glyph, component, vault spec, `.sql`, RLS rule or row — the ledger moved exactly one line: **55 → 56 libraries**, 67 route files / 10 components / 74 glyphs / 35 specs unchanged. Verification: `tsc` 0, `eslint` 0 on both touched files against the HEAD worktree baseline (which was also 0), build exit 0 with the route table at **69 rows** and `/inventory/recipes` still prerendered `○`, and the round's suite **committed** as `tests/wip17.test.mjs` — **92 assertions, 0 failing**, alongside `tests/copy16.test.mjs` 68/68 — run from the repo root with nvm's Node 24. **Owed:** the signed-in drive of the pair (#278's backlog grows a surface), and the `?tab=`/cross-link polish if the drive finds any.


**A token no finished page reads is a promise, not a design system (R3-18, Rule 55 / ADR-052).** R3-5 put `--mono` in `:root` and thirteen rounds re-measured the **64 monospace spellings across 37 files** that did not read it; R3-18 spent a round on nothing but the sweep. Three regex substitutions — a CSS `font-family: ui-monospace … monospace`, a `fontFamily: 'ui-monospace …'` literal, a bare `fontFamily: 'monospace'` — became `var(--mono)`, and the diff is exactly **64 lines out / 64 in with no file's length moved**; `ui-monospace` now survives in `src/` only at the token's own definition. The architecture consequence is that nothing else moved: **the ledger changes by no line** (67 route files / 56 libraries / 10 components / 74 glyphs / 35 specs, route table 69 rows), no module gained or lost an import, and every page still renders the face it rendered before — every swept stack led with `ui-monospace` and the token keeps Menlo and SFMono-Regular, so the variants cannot resolve differently. The exception that had kept the invoice paper out (`ADR-024`'s artefact argument) is **withdrawn**: with one house stack, per-page recipes on the legal artefact are drift, not ceremony. **68 lines — 49 class rules + 19 inline props — in 40 files** read the token, pinned by `tests/mono18.test.mjs` (18 assertions) alongside `wip17` 92 and `copy16` 68 = **178, 0 failing**. Two instrument facts belong to the rules file rather than the architecture, and are recorded there: §4's documented `font-family:[^;}]*monospace` grep is blind inside a JSX template literal (a newline, not a semicolon, ends the line — it missed `.jn-mono`, `.dep-fig`, `.dep-input-field`), and a sweep's file set is not re-derivable from post-sweep content, because a file that already read the token is indistinguishable from one the sweep converted. **Owed:** the same signed-in drive (#278) now also spot-checks a swept page's computed `font-family`.


**A reading that prints money prints the statements' own money, and names what it was not handed (R3-19, Rule 56 / ADR-053).** `/audit` has always answered *is this window closed* and *who tried to edit it after it was*, and never **what is still moving in there** — so a shop could seal a half-finished month and the first thing the seal did was refuse its own unfinished paper. `src/lib/period-close.ts` (**639 lines / 19 exports**, the **57th library**) is the R3-17 shape turned the other way: R3-17 was a reading whose result becomes paper through the register that owns the paper; this is a reading that owns **no** paper and takes nothing through any door. Architecturally that means three things. **(1) The derivation is imported, never restated:** the window's revenue, purchases, expenses and net profit are `ledger.ts`'s `computeProfitLoss(invoices, bills, expenses, from, to, rowsInWindow(journalRows(journal), {start: from, end: to}))`, and every rupee the file sums itself goes through `journal.ts`'s `paise()`; the trial balance (R3-14) and the WIP pair (R3-17) already obeyed this, and the close is the first time one screen has folded *four* registers at once, so the discipline is what keeps `/audit?tab=close` from becoming a second opinion about a month. **(2) The rows are arguments, so the server stays on the page:** the library imports no store loader and writes no `localStorage`; the tab's effect fetches the four dated document tables (`invoices`, `purchase_bills`, `expenses`, `payments`) for one window at a time — the page's first and only server read — and the registers already held in memory (journal, orderflow, filings, audit) are passed in. A register the page could not hand over is returned in `unread` and printed as unread, never folded in as an empty list: **Rule 27** applied to a fold instead of a figure. **(3) A reading beside a decision keeps the decision's door:** the tab's single button is the page's own `openSealFor(month)`, which presets the existing seal dialog to the month just read; `sealPeriod()` stays `/audit`'s act under its note and date check, the close appends no trail event and moves no seal, and the card prints the close's state (`not-loaded` / `in-progress` / `nothing-here` / `unfinished` / `ready`) **beside** the seal's (`open` / `sealed` / `released`) — a sealed month that still holds drafts is two true answers and the card keeps both. What this is *not* is printed as six `CLOSE_BOUNDARIES` sentences under the findings rather than left to the reader: **not a photograph** (nothing in the app stores what a period held at the moment it was sealed, so a sealed window's figures are today's reading of it — a live fold an auditor should expect to have moved), not a closer, not a filing, not a valuation of the future (a payment dated in October settles September's receivable without touching September's paper, so the outstanding line is labelled *as the books read it today*), not the company's statement, and not the trail's evidence — the trail rows in the window are the only part of the reading that is evidence rather than arithmetic. Scope: **the ledger moves by exactly one line — 56 → 57 libraries** — with no new `localStorage` key (Rule 31 untriggered, vault unchanged at **35 specs / 30 restorable**), no new route, glyph, component, `.sql`, RLS rule, row or citation (a reading of the shop's own books is bookkeeping, not law). `src/app/(app)/audit/page.tsx` **775 → 1,115**, `src/lib/commands.ts` **1,071 → 1,081** (one action, `action:period-close` → `/audit?tab=close`). Verification: `tsc` 0, eslint parity with the HEAD worktree, build **69 rows** with `/audit` still `○`, and `tests/close19.test.mjs` **207 assertions / 0 failing** alongside the carried `wip17` 92, `copy16` 68 and `mono18` 18 — **385 across four committed suites**. **Owed:** the signed-in look at the third tab joins **#278**; `copy16`'s pinned `(s)` census (44 / 17, all identifier uses) is why the engine's callback parameter is `x` rather than `s` — a shipped instrument is a contract.

**A drive round fixes the sentence and never the arithmetic (R3-20, Rule 57 / ADR-054).** R3-15 proved that a signed-in walk finds what a suite cannot; R3-20 re-ran that instrument over everything R3-16→R3-19 shipped — `/audit?tab=close`, `/journal` both tabs, `/inventory/recipes` with the R3-17 block, `/gst/filings`, `/vault`'s three surfaces and ⌘K — in the owner's own session, read-only, and found six defects that are all one kind: **a figure and the sentence beside it disagreeing, or two figures on one screen wearing one phrase.** `/inventory/recipes`' doctrine footer still denied a work-in-progress account that R3-17 shipped on that very page; the run log printed `3` over "0 built · 0 planned" so the reader had to invent the cancelled third state; a cancelled run's branch invited a shop to draft paper for a cost that no longer exists; `/journal` printed `1` over "1 reversed" while a posted reversal sat uncounted; `/gst/filings` set "5 returns past their date" beside "11 periods past their date", two correct populations whose shared phrase invited a subtraction; `/vault`'s subtitle said 30 where the card's own `REGISTERS.length` said 35. Every repair is **page-side**: `postedReversals` is derived in `/journal` rather than folded into `journal.ts`, because `livePostings()` excluding a posted reversal is *correct* and changing it would change what the statements read — the same discipline R3-15 applied when it left `verifyChain([])` alone. `journal.ts`, `filings.ts`, `wip.ts`, `period-close.ts` and `vault.ts` are byte-identical to the round before. Verification: `tsc` 0; whole-tree eslint **byte-identical to a detached `git worktree` of HEAD** at 294 pre-existing problems, none of them on the four pages; build **69 rows** with all four repaired pages `○`; `tests/drive20.test.mjs` **70/70** new, one `copy16` pin amended openly because the sentence it pinned was legitimately re-worded — **455 assertions across five committed suites, 0 failing**. **The ledger moves by no line — 67 route source files / 57 libraries / 10 component files / 74 glyphs / 35 specs (30 restorable) / build table 69 rows** — no key, route, glyph, component, spec, `.sql`, RLS rule, row or citation. **This closes #278**, owed since R3-16 and added to by R3-17, R3-18 and R3-19.

**A reading hands its figures to the register that owns the seal, and the store decides whether they may be kept (R3-21, Rule 58 / ADR-055 — an amendment to Rule 56's first boundary sentence, not a crossing of it).** R3-19 printed a limitation on its own card: *nothing in this app stores what a period contained when it was sealed*, so a sealed month's rupees were always today's live fold of it. R3-20 read that sentence as a task. The shape this round had to get right is the **hand-over**: `period-close.ts` draws the photograph (`sealSnapshotOf()` — spread-and-copy of the reading's own money, counts, findings, `unread` list, state word and headline, captioned with the month it looked at and the day the page took it) and `audit.ts` decides whether it is kept — `sealPeriod()` refuses a snapshot that arrives with no month seal, on a year seal, or carrying a figure it cannot name, and `parseSnapshot()` rebuilds it in a fixed key order accepting only finite numbers. Neither half could live in the other file: a store that computed a close would be a second engine, and a reading that wrote to `localStorage` would reopen R3-19's boundary. Nothing was re-derived and nothing migrated — the field is added **by reading**, so `AUDIT_VERSION` stays **1**, every seal written before this round loads unchanged with no photograph and says *"No photograph stands on this seal"*, and the seals CSV grows **11 → 16 columns** only at the tail so an old export still parses. Where the comparison cannot be drawn the page names it instead of drawing it: a money line whose sealed side or today's side was never loaded is **withheld with its own sentence**, and a photograph this register cannot parse keeps its `snapshot_unreadable` stamp through every later re-save rather than decaying into *never photographed* — **Rule 27**'s forbidden transition, which this round's own suite caught in the engine and fixed with one `|| s.snapshot_unreadable === true`. The live reading is still not an archive: `closeDrift()` returns `null` for no seal, no photograph or a month mismatch, so the then-and-now table appears only over the window the page is actually holding. Verification: `tsc` 0, whole-tree eslint multiset-identical to a detached worktree of `ff4ec1d` at 294 pre-existing problems, build **69 rows** with `/audit` still `○`, `tests/seal21.test.mjs` **174/174** new and `tests/close19.test.mjs` legitimately amended **207 → 209** (two of its pins pinned the very sentence this round narrowed) — **631 assertions across six committed suites, 0 failing**. **The ledger moves by no line — 67 route source files / 57 libraries / 10 component files / 74 glyphs / 35 specs (30 restorable) / build table 69 rows** — no key, route, glyph, component, spec, `.sql`, RLS rule, row or citation, because a photograph of a shop's own books is bookkeeping, not law. Line counts: `audit.ts` **673 → 834 / 41 exports**, `period-close.ts` **639 → 793 / 19 → 24**, `/audit` **1,115 → 1,294**. **Owed:** the photographed branch has never been driven through a real month end; it is fenced by `seal21`'s save→load assertions and left for the shop's next closing.

**A kit that owns an ending is owed every noun in the tree, and the word can be bought without the figure (R3-22, Rule 59 / ADR-056 — an amendment to Rule 53 / ADR-050, not a second pluraliser).** R3-16 promoted `plural()` into `format.ts` and left behind it a written-out escape hatch — *inline `count === 1` ternaries remain only where the number and the noun print apart*. That clause was a door, and the tree had walked through it: re-measured at this round's base, **249 hand-spelled plural lines across 46 files** plus **43 whole-word `one`/`many` pairs across 12**, in the libraries as much as on the pages. Architecturally the round is a sweep with one small addition to the shared surface. `format.ts` goes **52 → 73 lines / 5 → 6 exports**: `pluralNoun(count, unit)` is the grammar itself, and `plural(n, u)` is now `` `${n} ${pluralNoun(n, u)}` ``, so the figure-plus-word call and the word-only call cannot spell the same plural two ways — the word-only half exists because a page often prints the number from somewhere else (a quantity formatter, a rupee string, an element two lines up) and only the noun has to agree; three real sites use it (`/portal`'s entry count, `/journal`'s trial-balance postings, `/ledger`'s open-invoice share). The grammar gained a rule: a word ending on a hiss (`s x z ch sh`) takes `es`, because `branchs` cannot be said out loud — `branch` is the tree's only sibilant unit, so no existing reading moves. Two hand-rolled homes closed rather than migrated: `recurring.ts`'s `{one, many}` table (**778 → 784**) became a single `unit` per frequency so `cadenceLine()` reads the kit, and `/inventory/reorder`'s page-local `count()` was deleted, which is why that file is **2 lines shorter** and `/gst/job-work` 1 shorter. What the kit deliberately does *not* own is the round's real finding: **a verb, a pronoun and an irregular stay the sentence's business.** Routing a noun through the kit left 27 finite verbs in 14 files agreeing with a word the kit had just pluralised — a class invisible to `tsc` (a template literal is a string), to eslint, and to every suite shipped before it — repaired in the sentence, fenced in both directions by `tests/plural22.test.mjs` **G1–G5**. Scope: **the ledger moves by no line — 67 route source files / 57 libraries / 10 component files / 74 glyphs / 35 specs (30 restorable) / build table 69 rows** — no key, route, glyph, component, spec, `.sql`, RLS rule, row or citation. 62 files changed: 3 test files and 59 source files (**39 shell pages + `portal` + 19 libraries**), of which **31 kept their exact length and 24 gained one import line**; after the sweep the tree reads **398 `plural(` occurrences across 59 files** (41 `.tsx` / 18 `.ts`) and **50 `pluralNoun(` across 19 beyond its own definition**, with a residue of **10 verb-suffix lines in 8 files plus 4 `person`/`people` choices** — the noun census is 0. Verification: `tsc` 0, whole-tree eslint a **(file, rule) multiset identical to a detached worktree of `67043a2`** at **294 with 0 diff lines** — the claim that a 59-file text transform touched no hook, cast or import cycle — build **69 rows**, and `plural22` **50/50** carried beside `seal21` 174, `close19` 209, `wip17` 92, `drive20` 71, `copy16` 70, `mono18` 18 = **684 assertions across seven committed suites, 0 failing**. **Not driven live:** the four sites where a sweep changes a sentence's meaning, and all 27 verbs, are owed the eye #278 gave R3-16's copy.
