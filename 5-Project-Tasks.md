# TaxFlow India — Project Tasks

**Version:** 1.0  
**Date:** September 2026  
**Last Updated:** September 2026  

---

## How to use this document

- ✅ = Completed and tested
- 🔄 = In progress
- ⏳ = Planned, not started
- ❌ = Blocked or cancelled

Update this file after completing each task.

---

## PHASE 0 — Blueprint ✅

- ✅ Define product vision and target customers
- ✅ Define MVP vs Version 1 vs Version 2
- ✅ Choose technology stack (Next.js + Supabase + Vercel)
- ✅ Design database architecture
- ✅ Plan development phases
- ✅ Create 6 project documents

---

## PHASE 1 — Project Skeleton ✅

- ✅ Install Homebrew on Mac
- ✅ Install Node.js v20
- ✅ Install Git
- ✅ Install Cursor (code editor)
- ✅ Create GitHub account
- ✅ Create Supabase account and project
- ✅ Create Next.js app (taxflow-india)
- ✅ Install Supabase libraries
- ✅ Create .env.local with credentials
- ✅ Create login page
- ✅ Create signup page
- ✅ Create dashboard shell
- ✅ Test auth flow (signup → confirm → login → logout)
- ✅ Deploy to Vercel
- ✅ Test live at taxflow-india.vercel.app

---

## PHASE 2 — Business Setup ✅

### Database
- ✅ Create profiles table
- ✅ Create organizations table
- ✅ Create org_members table
- ✅ Create gst_registrations table
- ✅ Enable Row Level Security (RLS)
- ✅ Fix RLS recursion issue (disabled for now)
- ✅ Add auto-create profile trigger on signup

### Business Setup Wizard
- ✅ Step 1 — Company details form
- ✅ Step 2 — GST registration form
- ✅ GSTIN format validation
- ✅ Auto-detect state from GSTIN
- ✅ Save organization to database
- ✅ Save GST registration to database
- ✅ Redirect new users to /setup automatically
- ✅ Dashboard shows company name + GSTIN

---

## PHASE 3 — Masters ✅

### Database
- ✅ Create customers table
- ✅ Create vendors table
- ✅ Create products table

### Constants
- ✅ All 37 Indian states with GST state codes
- ✅ Business types list
- ✅ GST registration types list
- ✅ validateGSTIN() function
- ✅ getStateFromGSTIN() function

### Customers
- ✅ Customer list page
- ✅ Add customer form (modal)
- ✅ Edit customer
- ✅ GSTIN validation on form
- ✅ State dropdown
- ✅ Search by name, GSTIN, phone, email
- ✅ Customer type badge (B2B, B2C, Export, SEZ)
- ✅ Active/inactive status

### Vendors
- ✅ Vendor list page
- ✅ Add vendor form (modal)
- ✅ Edit vendor
- ✅ Search functionality

### Products
- ✅ Product list page
- ✅ Add product form (modal)
- ✅ Edit product
- ✅ Goods vs Service toggle
- ✅ HSN/SAC field
- ✅ GST rate selector (0, 5, 12, 18, 28%)
- ✅ Inventory tracking toggle
- ✅ Opening stock and minimum stock
- ✅ Filter by type (goods/services)

### Navigation
- ✅ Sidebar with all sections
- ✅ Active page highlighting
- ✅ Organization name and GSTIN in sidebar

---

## PHASE 4 — Invoicing ✅

### Database
- ✅ Create invoices table
- ✅ Create invoice_items table
- ✅ Create invoice_sequences table

### GST Engine
- ✅ determineGSTType() — same state vs interstate
- ✅ calculateLineItem() — per line tax calculation
- ✅ calculateInvoiceTotals() — invoice summary
- ✅ getFinancialYear() — India FY (April-March)
- ✅ formatINR() — Indian number format
- ✅ numberToWords() — amount in words (crores, lakhs)
- ✅ round2() — 2 decimal rounding

### Invoice Creation
- ✅ Invoice number auto-generation (INV-2026-27-0001)
- ✅ Seller details from org profile
- ✅ Customer selection with auto-fill (GSTIN, state)
- ✅ Place of supply with auto-detect
- ✅ Supply type (B2B, B2C, Export, SEZ)
- ✅ GST type indicator (CGST+SGST vs IGST)
- ✅ Reverse charge flag
- ✅ Line items with product selector
- ✅ Live GST calculation as user types
- ✅ Tax breakdown under each line item
- ✅ Discount per line item
- ✅ Invoice summary (right panel)
- ✅ Amount in words
- ✅ Notes and terms
- ✅ Save as draft
- ✅ Save as sent
- ✅ Stock auto-reduces on invoice save

### Invoice List
- ✅ List all invoices
- ✅ Invoice number, customer, date, amount, status
- ✅ Payment status badge
- ✅ Click to open detail

### Invoice Detail
- ✅ Full invoice view (print-ready)
- ✅ TAX INVOICE header
- ✅ Seller and buyer details
- ✅ Line items table with CGST/SGST/IGST columns
- ✅ Totals section
- ✅ Amount in words
- ✅ Notes and terms
- ✅ Authorised signatory section
- ✅ Mark as Paid button (sent invoices only)
- ✅ Cancel invoice
- ✅ Print / PDF button
- ✅ Print styles (hides navigation)

---

## PHASE 5 — Purchases ✅

### Database
- ✅ Create purchase_bills table
- ✅ Create purchase_bill_items table
- ✅ Create expenses table

### Purchase Bills
- ✅ Bill list with ITC summary cards
- ✅ Add bill form (modal)
- ✅ Vendor selection with auto-fill
- ✅ GST calculation (same engine as invoices)
- ✅ ITC eligible toggle
- ✅ ITC amount shown in list
- ✅ Mark bill as paid
- ✅ Stock auto-increases on bill save

### Expenses
- ✅ Expense list with summary cards
- ✅ Add expense form
- ✅ 16 expense categories
- ✅ GST calculation (tax-inclusive — backs out GST from total)
- ✅ ITC eligible flag
- ✅ Payment mode selection
- ✅ Vendor linking (optional)

---

## PHASE 6 — Payments ✅

### Database
- ✅ Create payments table

### Payments Page
- ✅ Summary cards (receivable, payable, overdue, this month)
- ✅ Receivables tab with ageing
- ✅ Payables tab with ageing
- ✅ Ageing buckets (current, 30d, 60d, 90d+)
- ✅ Record payment modal
- ✅ Full payment recording
- ✅ Partial payment recording
- ✅ Payment mode and reference number
- ✅ Invoice/bill updates to paid/partial automatically
- ✅ Paid invoices removed from receivables list
- ✅ Recent payments section
- ✅ Payments added to sidebar

---

## PHASE 7 — Inventory ✅

### Database
- ✅ Create stock_movements table
- ✅ Create warehouses table
- ✅ Add last_stock_update to products
- ✅ Create record_stock_movement() database function

### Inventory Page
- ✅ Summary cards (tracked products, stock value, low stock, out of stock)
- ✅ Stock levels tab
- ✅ Low stock filter
- ✅ Out of stock filter
- ✅ Search products
- ✅ Stock level per product with color coding
- ✅ Manual add stock
- ✅ Manual remove stock
- ✅ Stock preview before confirming
- ✅ Minimum stock alert
- ✅ Stock movements tab
- ✅ Filter movements by product
- ✅ Movement type badges
- ✅ Auto-reduce on invoice save
- ✅ Auto-increase on purchase bill save
- ✅ Inventory added to sidebar

---

## PHASE 8 — GST Reports ✅

### Database
- ✅ Create gst_return_periods table

### GST Dashboard
- ✅ Period selector (last 6 months)
- ✅ Output tax section (total sales, taxable, CGST, SGST, IGST)
- ✅ ITC section (purchases, CGST, SGST, IGST ITC)
- ✅ Net payable card (green if zero, red if payable)
- ✅ Return filing status tracker
- ✅ Update return status (dropdown)
- ✅ Links to GSTR-1 and GSTR-3B

### GSTR-1
- ✅ Period selector
- ✅ Summary cards (invoices, taxable, tax, total)
- ✅ B2B tab (with GSTIN column)
- ✅ B2C tab
- ✅ Export/SEZ tab
- ✅ HSN Summary tab (qty, value, tax by HSN code)
- ✅ Totals row in B2B
- ✅ Export to CSV
- ✅ GST compliance warning

### GSTR-3B
- ✅ Period selector
- ✅ Section 3.1 (outward supplies: B2B, B2C, export, nil)
- ✅ Section 4 (ITC available: IGST, CGST, SGST)
- ✅ Section 6.1 (net tax payable: tax − ITC)
- ✅ CGST/SGST/IGST columns
- ✅ Total row
- ✅ Export to CSV
- ✅ GST compliance warning

---

## PHASE 12 — Reports & Dashboard ✅

### Live Dashboard
- ✅ Real sales, purchases, expenses for current month
- ✅ GST summary (collected, ITC, payable)
- ✅ Outstanding receivables and payables
- ✅ Overdue receivables
- ✅ 6-month sales bar chart
- ✅ GST return status widget
- ✅ Recent invoices (last 5, clickable)
- ✅ Empty state if no invoices

### Reports Page
- ✅ Period selector (month, last month, quarter, FY)
- ✅ Sales tab
  - ✅ Summary cards (total, taxable, tax, count)
  - ✅ Sales by customer (ranked)
  - ✅ Sales by product (ranked)
  - ✅ Sales by state
- ✅ Purchases tab
  - ✅ Summary cards
  - ✅ Purchases by vendor (with ITC)
- ✅ GST Summary tab
  - ✅ Output vs ITC vs Net payable grid
  - ✅ CGST/SGST/IGST breakdown
- ✅ Profit Overview tab
  - ✅ Revenue, purchases, expenses
  - ✅ Gross profit and net profit
  - ✅ Profit margin percentage
  - ✅ Disclaimer note
- ✅ CSV export on all tabs

---

## VERSION 1 — Upcoming Features ⏳

### Settings Page ⏳
- ⏳ Invoice number prefix (change INV to custom)
- ⏳ Company logo upload
- ⏳ Bank account details (for invoice footer)
- ⏳ Default payment terms
- ⏳ Financial year selection
- ⏳ Invoice template selection

### Quotations ⏳
- ⏳ Create quotation
- ⏳ Convert quotation to invoice
- ⏳ Quotation list and detail view
- ⏳ PDF print

### Credit Notes ⏳
- ⏳ Create credit note against invoice
- ⏳ Credit note list
- ⏳ Impact on GSTR-1 (CDN section)

### Debit Notes ⏳
- ⏳ Create debit note
- ⏳ Debit note list

### Email Invoices ⏳
- ⏳ Email invoice PDF to customer
- ⏳ Email templates
- ⏳ Email log

### Multi-User ⏳
- ⏳ Invite user by email
- ⏳ Role selection (owner, accountant, staff)
- ⏳ Role-based access control
- ⏳ Remove user from organization

---

## PHASE 14 — Security ⏳

- ⏳ Fix Supabase RLS for @supabase/ssr 0.12.x
- ⏳ Re-enable RLS on all tables
- ⏳ Test organization isolation with multiple accounts
- ⏳ Add audit log table
- ⏳ Record audit events (create, edit, cancel, delete)
- ⏳ Audit log viewer page
- ⏳ Rate limiting on API routes
- ⏳ Security testing

---

## PHASE 13 — SaaS Subscriptions ⏳

- ⏳ Define plan tiers (Free, Starter, Professional)
- ⏳ Create plans and features table
- ⏳ Usage tracking (invoices per month)
- ⏳ Plan limits enforcement
- ⏳ Razorpay integration
- ⏳ Subscription management page
- ⏳ Upgrade/downgrade flow
- ⏳ Trial period
- ⏳ Invoice for subscription payment

---

## VERSION 2 — Future ⏳

- ⏳ E-invoice (IRN via GSP)
- ⏳ E-way bill generation
- ⏳ GSTR-4 (Composition)
- ⏳ GSTR-9 annual return
- ⏳ WhatsApp invoice sharing
- ⏳ Payment links
- ⏳ Bank statement import
- ⏳ OCR bill scanning
- ⏳ Mobile app

---

## Known Issues / Bugs

| Issue | Status | Notes |
|-------|--------|-------|
| RLS disabled | Pending Phase 14 | App-level isolation active, safe for now |
| @supabase/ssr 0.12.x proxy/middleware | Pending | Fixed by disabling RLS temporarily |
| Invoice PDF styling | Minor | Browser print works, dedicated PDF future |

---

## Testing Checklist (run before each deploy)

- [ ] Can signup a new user
- [ ] Email confirmation works
- [ ] Can login and logout
- [ ] New user redirected to /setup
- [ ] Business setup saves correctly
- [ ] Can add customer, vendor, product
- [ ] Can create invoice with GST calculation
- [ ] CGST+SGST for same state
- [ ] IGST for different state
- [ ] Invoice saves and shows in list
- [ ] Invoice detail opens and prints
- [ ] Can add purchase bill
- [ ] Can add expense
- [ ] Payment recording works
- [ ] Inventory updates on invoice
- [ ] Inventory updates on purchase
- [ ] GST dashboard shows correct numbers
- [ ] GSTR-1 CSV export works
- [ ] GSTR-3B CSV export works
- [ ] Reports show real data
- [ ] Dashboard shows real metrics
