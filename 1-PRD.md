# TaxFlow India — Product Requirements Document (PRD)

**Version:** 1.0  
**Date:** September 2026  
**Status:** MVP Complete — Expanding  

---

## 1. Product Overview

### Product Name
TaxFlow India

### Tagline
GST Billing, Invoicing & Compliance for Indian Businesses

### What is it?
TaxFlow India is a web-based SaaS application that helps Indian small and medium businesses manage their GST billing, invoicing, purchases, expenses, payments, inventory, and GST return preparation — all in one place.

### Who is it for?
| Customer Type | Example |
|---------------|---------|
| Small traders | Shop owners, wholesalers, distributors |
| Service businesses | Consultants, agencies, freelancers |
| Manufacturers | Small factories, workshops |
| Professionals | CAs, lawyers, doctors |
| Accountants | Managing multiple client businesses |

### Core Problem it Solves
Indian businesses struggle with:
- Creating GST-compliant invoices correctly
- Tracking CGST / SGST / IGST separately
- Preparing GSTR-1 and GSTR-3B data every month
- Tracking who owes them money and who they owe
- Managing purchases and claiming ITC correctly
- Keeping inventory in sync with sales and purchases

### Unique Selling Points
1. Built specifically for Indian GST — not adapted from foreign software
2. Auto-detects CGST+SGST vs IGST based on state
3. Generates GSTR-1 and GSTR-3B ready data instantly
4. Free to start — no credit card needed
5. Simple enough for a non-accountant to use

---

## 2. Product Versions

### MVP (Built — Current)
Everything a business needs to operate day-to-day:
- Business setup with GSTIN
- Customer, vendor, product management
- GST sales invoices (B2B, B2C, Export, SEZ)
- Purchase bills with ITC tracking
- Expense tracking
- Payment recording (receivables + payables)
- Inventory with stock movements
- GST Dashboard (output tax, ITC, net payable)
- GSTR-1 data preparation
- GSTR-3B data preparation
- Business reports (sales, purchase, GST, profit)
- PDF invoice printing

### Version 1 (Next — 3 months)
- Quotations → convert to invoice
- Credit notes and debit notes
- Email invoices directly from app
- Company logo on invoices
- Bank details on invoices
- Settings page (invoice prefix, FY settings)
- Multi-user with roles (invite accountant/staff)
- Better PDF invoice templates

### Version 2 (6 months)
- E-invoice integration (IRN generation via GSP)
- E-way bill generation
- GSTR-4 (Composition scheme)
- GSTR-9 annual return preparation
- WhatsApp invoice sharing
- Payment links (Razorpay/PayU)
- Bank statement import
- OCR bill scanning

### Enterprise / Future
- Multi-company management
- Accountant portal (manage multiple clients)
- API access
- Mobile app (iOS + Android)
- AI-powered expense categorization
- AI GST error detection
- Payroll
- TDS / TCS management
- Advanced accounting (P&L, Balance Sheet)

---

## 3. Feature Requirements

### 3.1 Authentication
- Email + password signup
- Email confirmation
- Secure login/logout
- Session management
- Password reset (future)

### 3.2 Business Setup
- Legal business name
- Trade name
- PAN
- Business type (Proprietorship, Pvt Ltd, etc.)
- Complete address with state and pincode
- GSTIN with format validation
- Auto-detect state from GSTIN
- GST registration type (Regular, Composition, SEZ, etc.)
- Registration date
- Multiple GSTIN support (future)

### 3.3 Customer Management
- Contact name + business name
- GSTIN with format validation
- PAN
- Customer type (B2B, B2C, Export, SEZ)
- Complete address with state
- Phone and email
- Payment terms (days)
- Notes
- Active/inactive toggle
- Search and filter

### 3.4 Vendor Management
- Same fields as customers
- Track outstanding payable
- Purchase history

### 3.5 Product & Service Master
- Name, description, SKU
- Type: Goods or Service
- HSN code (goods) / SAC code (services)
- Unit of measurement
- Purchase price and selling price
- GST rate (0%, 5%, 12%, 18%, 28%)
- Cess rate
- Inventory tracking toggle
- Opening stock, minimum stock

### 3.6 Sales Invoice
**Header:**
- Auto-generated sequential invoice number
- Invoice date and due date
- Seller details (auto from profile)
- Customer selection with auto-fill
- Place of supply with auto-detect from customer state
- Supply type (B2B, B2C, Export, SEZ)
- Reverse charge flag

**Line Items:**
- Product selection with auto-fill
- Item name, description, HSN/SAC
- Quantity, unit, rate
- Discount percentage
- Auto-calculated: taxable value, CGST, SGST, IGST, cess
- Multiple lines

**GST Engine:**
- Same state → CGST + SGST
- Different state → IGST
- Export/SEZ → IGST
- Live calculation as user types
- Round-off to nearest rupee

**Footer:**
- Subtotal, discount, taxable amount
- CGST, SGST, IGST breakdown
- Grand total
- Amount in words
- Notes and terms

**Actions:**
- Save as draft
- Save as sent
- Mark as paid (sent invoices only)
- Cancel invoice
- Print / PDF

### 3.7 Purchase Bills
- Vendor bill number (external)
- Vendor selection with auto-fill
- Place of supply
- ITC eligible toggle
- Line items with GST calculation
- ITC summary
- Mark as paid

### 3.8 Expenses
- Date, category, description
- Vendor (optional)
- Bill number
- Total amount with GST rate
- Auto-calculate GST from total (tax-inclusive)
- ITC eligible flag
- Payment mode and status

### 3.9 Payments
- Receivables tab: all unpaid/partial invoices
- Payables tab: all unpaid/partial bills
- Ageing buckets (current, 30d, 60d, 90d+)
- Record full or partial payment
- Payment mode, reference number
- Recent payment history

### 3.10 Inventory
- Stock level dashboard
- Low stock and out-of-stock alerts
- Stock value (at selling price)
- Manual adjustment (add/remove)
- Movement history per product
- Auto-update on invoice (reduce)
- Auto-update on purchase bill (increase)

### 3.11 GST Dashboard
- Period selector (by month)
- Output tax (CGST, SGST, IGST collected)
- ITC available (from eligible purchases)
- Net GST payable
- Return filing status tracker
- Links to GSTR-1 and GSTR-3B

### 3.12 GSTR-1
- B2B invoices tab
- B2C invoices tab
- Export/SEZ invoices tab
- HSN/SAC summary tab
- Period and summary cards
- Export to CSV
- GST compliance warning

### 3.13 GSTR-3B
- Section 3.1: Outward supplies breakdown
- Section 4: ITC available
- Section 6.1: Net tax payable
- CGST/SGST/IGST columns
- Export to CSV
- Compliance warning

### 3.14 Reports
- Sales report (by customer, product, state)
- Purchase report (by vendor)
- GST summary (output vs ITC vs payable)
- Profit overview (revenue, costs, margin)
- Period selector (month, quarter, FY)
- CSV export

### 3.15 Dashboard
- Real-time metrics (sales, purchases, expenses)
- GST summary for current month
- Outstanding receivables and payables
- 6-month sales bar chart
- GST return status
- Recent invoices

---

## 4. Non-Functional Requirements

### Performance
- Page load under 3 seconds
- Invoice calculation instant (client-side)
- Reports load under 5 seconds

### Security
- All data isolated per organization
- No organization can see another's data
- Secure authentication via Supabase
- HTTPS only
- Input validation on all forms

### GST Compliance
- All GST rules must be configurable, not hard-coded
- Rules stored in database with effective dates
- Historical invoices retain the tax rate at time of creation
- Compliance warnings on all GST reports
- Always verify against gstn.gov.in before actual filing

### Reliability
- 99%+ uptime via Vercel
- Database backups via Supabase
- Error handling on all API calls

---

## 5. Out of Scope (Current Version)
- Direct GST portal filing (requires GSP authorization)
- E-invoicing (requires IRP integration)
- E-way bills
- Bank integrations
- Payroll
- TDS / TCS
- Multi-currency
- Mobile app
