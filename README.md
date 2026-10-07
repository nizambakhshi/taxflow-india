# TaxFlow India

GST billing, invoicing and compliance for Indian businesses (₹2–20 crore) — cloud, no downloads, no per-seat pricing.

**Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Supabase (Postgres + Auth, browser client) · Tailwind v4 tokens + a small custom design system in `src/app/globals.css`.

**Status:** Round 1 (7 competitive features) and Round 2 items R2-1 … R2-9 are shipped. See `5-Project-Tasks.md` for the backlog and `1-PRD.md` for scope.

---

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000
```

Environment (`.env.local`, never committed):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key used by the browser client |

Supabase schema and RLS policies are hand-managed in the Supabase dashboard — there are no migration files in this repo, and the working default is to ship a feature **client-side** (existing tables + `localStorage`) rather than change the schema. See `3-Development-Rules.md` Rule 21.

Checks before committing:

```bash
npx tsc --noEmit
npm run build
npx eslint <files you touched>   # `next lint --file` no longer exists in this Next build
```

Pure libraries under `src/lib` are tested with the TS loader, not a test runner:

```bash
node --experimental-strip-types --no-warnings --loader /tmp/ts-loader.mjs /tmp/<lib>-test.mjs
```

## Documentation

| File | What it holds |
|---|---|
| `1-PRD.md` | Product scope, versions, feature requirements, non-functional rules |
| `2-System-Architecture.md` | Routes, folder map, data model, GST engine, client-side state layer |
| `3-Development-Rules.md` | The conventions a change must follow |
| `4-Design-System.md` | Theme tokens, `.tf-*` utilities, `ui.tsx` primitives, icon set, responsive rules |
| `5-Project-Tasks.md` | Phase-by-phase build history and current backlog |
| `6-Project-Memory.md` | Decision records (ADRs / GCDs) and session log |

## What the app does

**Day-to-day:** business setup, customers, vendors, products, sales invoices (B2B/B2C/Export/SEZ), purchase bills, expenses, payments, quotations, credit/debit notes, inventory with stock movements, settings.

**GST:** dashboard, GSTR-1 and GSTR-3B workpapers, GSTR-2B ↔ books reconciliation, e-invoice (IRN) + e-way bill payloads, GSTR-9/9C annual workpaper, compliance calendar with late-fee estimates, statutory registers (party-wise, HSN/SAC, B2B, state-wise, e-way bill).

**Money:** party ledger & statements of account, P&L and balance sheet derived from documents, receivables/payables ageing, UPI payment links and WhatsApp reminders, targets with festival-weighted pacing, demand-driven reorder suggestions.

**At the counter and on the move:** POS screen with camera barcode scanning, installable PWA shell with an offline invoice outbox that replays through the normal save path, ⌘K command palette over pages, actions and live records.

**AI-ish, deliberately offline:** supplier bill scan (OCR/PDF → structured line items, cross-checked against GST arithmetic) and natural-language reporting over the user's own books. Both run entirely in the browser — no bill is uploaded anywhere, and every figure traces back to the rows it came from.

## Repository layout

```
src/app/            routes (App Router), api/gsp + api/pdf-worker, globals.css
src/components/     BarcodeScanner, CommandPalette, Icons, InvoiceDocument, PwaRegister, ui
src/lib/            pure domain libraries (GST engine, registers, GSTR-9, POS, AI, …)
public/             sw.js, offline.html, manifest assets, icons
```
