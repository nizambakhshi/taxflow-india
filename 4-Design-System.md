# TaxFlow India — Design System

**Version:** 1.0  
**Date:** September 2026  

---

## 1. Design Principles

1. **Clarity over cleverness** — Every element should be immediately understandable
2. **Data first** — Financial data must be readable at a glance
3. **Indian context** — Rupee symbol, Indian number formatting, familiar patterns
4. **Desktop first** — Primary use is on desktop/laptop, mobile is secondary
5. **Professional** — Suitable for a business environment, not playful

---

## 2. Colors

### Primary Brand Color
```
Blue: #2563eb (Tailwind blue-600)
Used for: Logo, primary buttons, links, active nav, invoice header
```

### Semantic Colors
```
Success (green):
  Text:       #166534
  Background: #f0fdf4
  Border:     #bbf7d0
  Fill:       #059669

Warning (amber):
  Text:       #854d0e
  Background: #fef9c3
  Border:     #fde68a

Danger (red):
  Text:       #dc2626
  Background: #fef2f2
  Border:     #fecaca

Info (blue):
  Text:       #1d4ed8
  Background: #eff6ff
  Border:     #bfdbfe
```

### Neutral Colors
```
Page background:  #f8fafc
Card background:  white (#ffffff)
Surface:          #f1f5f9
Border:           #e2e8f0
Border strong:    #cbd5e1

Text primary:     #1e293b
Text secondary:   #374151
Text muted:       #64748b
Text placeholder: #94a3b8
```

### GST-Specific Colors
```
Output tax (collected): #dc2626 (red — money owed to government)
ITC (input credit):     #059669 (green — money saved)
Net payable:            #d97706 (amber — action required)
CGST:                   #7c3aed (purple)
SGST:                   #7c3aed (purple — same as CGST)
IGST:                   #0891b2 (cyan)
```

### Status Badge Colors
```
Paid:        bg #f0fdf4, text #166534
Unpaid:      bg #fef2f2, text #dc2626
Partial:     bg #fef9c3, text #854d0e
Draft:       bg #f1f5f9, text #64748b
Sent:        bg #eff6ff, text #1d4ed8
Cancelled:   bg #f1f5f9, text #94a3b8
Filed:       bg #f0fdf4, text #166534
Not started: bg #f1f5f9, text #64748b
```

---

## 3. Typography

### Font
System font stack (no external font needed):
```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
```

### Font Sizes
```
Page title (h1):     22px, weight 600
Section title (h2):  18px, weight 600
Card title:          15px, weight 600
Body text:           14px, weight 400
Table text:          13px, weight 400
Label text:          12-13px, weight 500
Small/meta:          11-12px, weight 400
Badge/tag:           11px, weight 600
Monospace (GSTIN):   font-family: monospace
```

### Number Display
```
Large metric:   22-28px, weight 700
Table amount:   13px, weight 500
Grand total:    16px, weight 700
Indian format:  ₹1,23,456.78 (use formatINR())
```

---

## 4. Spacing

```
Page padding:         2rem (32px) all sides
Card padding:         1.25rem (20px)
Form padding:         2rem (32px)
Gap between cards:    1rem (16px)
Gap between rows:     12px
Gap between labels:   6px
Section gap:          1.5rem (24px)
```

---

## 5. Components

### Page Layout
```
Sidebar width:    220px (fixed left)
Main content:     margin-left: 220px
Max content width: 1100-1200px
```

### Sidebar
```
Background:     white
Border:         1px solid #e2e8f0
Logo section:   padding 1.25rem 1rem
Nav sections:   uppercase labels, 10px, color #94a3b8
Nav items:      13px, padding 7px 1rem
Active item:    background #eff6ff, color #2563eb, border-right 2px solid #2563eb
```

### Top Navbar (used in some pages)
```
Height:         60px
Background:     white
Border-bottom:  1px solid #e2e8f0
Sticky top
z-index:        10
```

### Cards
```css
background: white;
border: 1px solid #e2e8f0;
border-radius: 12px;
padding: 1.25rem;
```

### Metric Cards (with colored top border)
```css
background: white;
border: 1px solid #e2e8f0;
border-radius: 12px;
padding: 1.25rem;
border-top: 3px solid {color};  /* colored accent */
```

### Buttons

**Primary (blue):**
```css
padding: 9px 18px;
background: #2563eb;
color: white;
border: none;
border-radius: 8px;
font-size: 14px;
font-weight: 600;
cursor: pointer;
```

**Secondary (outline):**
```css
padding: 9px 18px;
background: white;
color: #374151;
border: 1px solid #e2e8f0;
border-radius: 8px;
font-size: 14px;
cursor: pointer;
```

**Danger (red):**
```css
background: #fef2f2;
color: #dc2626;
border: 1px solid #fecaca;
```

**Success (green):**
```css
background: #f0fdf4;
color: #166534;
border: 1px solid #bbf7d0;
```

**Disabled state:**
```css
background: #93c5fd;  /* lighter blue */
cursor: not-allowed;
```

### Input Fields
```css
width: 100%;
padding: 9px 12px;
border: 1px solid #d1d5db;
border-radius: 8px;
font-size: 14px;
outline: none;
color: #1e293b;
background: white;
```

**Focus state:** border-color: #2563eb

**Read-only:**
```css
background: #f8fafc;
```

**Validation states:**
```css
/* Valid */
border: 1px solid #34d399;

/* Invalid */
border: 1px solid #f87171;
```

### Labels
```css
display: block;
font-size: 13px;
font-weight: 500;
color: #374151;
margin-bottom: 6px;
```

### Tables

**Header row:**
```css
background: #f8fafc;
font-size: 12px;
font-weight: 600;
color: #64748b;
padding: 10px 16px;
border-bottom: 1px solid #e2e8f0;
```

**Data rows:**
```css
font-size: 13px;
padding: 12px 16px;
border-bottom: 1px solid #f1f5f9;
```

**Hover:**
```css
background: #f8fafc;
```

**Total/summary row:**
```css
background: #f8fafc;
font-weight: 700;
border-top: 2px solid #e2e8f0;
```

### Status Badges
```css
font-size: 11px;
padding: 2px 8px;
border-radius: 99px;
font-weight: 600;
/* color and background from status color system above */
```

### Modal / Form Overlay
```css
/* Backdrop */
position: fixed;
inset: 0;
background: rgba(0,0,0,0.4-0.5);
display: flex;
align-items: center;
justify-content: center;
z-index: 100;

/* Modal container */
background: white;
border-radius: 16px;
padding: 2rem;
width: 100%;
max-width: 580-820px;  /* depends on content */
max-height: 90vh;
overflow-y: auto;
```

### Section Headers (inside cards)
```css
font-size: 11px;
font-weight: 700;
color: #94a3b8;
text-transform: uppercase;
letter-spacing: 0.05em;
margin-bottom: 1rem;
```

### Alert / Info Boxes

**Info (blue):**
```css
background: #eff6ff;
border: 1px solid #bfdbfe;
color: #1d4ed8;
padding: 10px 14px;
border-radius: 8px;
font-size: 13px;
```

**Warning (amber):**
```css
background: #fef9c3;
border: 1px solid #fde68a;
color: #854d0e;
```

**Error (red):**
```css
background: #fef2f2;
border: 1px solid #fecaca;
color: #dc2626;
```

**Success (green):**
```css
background: #f0fdf4;
border: 1px solid #bbf7d0;
color: #166534;
```

---

## 6. Invoice Design

### Invoice Header
```
"TAX INVOICE" — 22px, weight 700, color #2563eb
Bottom border: 2px solid #2563eb
```

### Invoice Layout
```
From (seller) | Invoice number, date, status
Bill To (customer) | Place of supply
─────────────────────────────────────────────
Line items table (striped rows)
─────────────────────────────────────────────
                    | Totals (right-aligned)
Amount in words box
Notes | Terms
─────────────────────────────────────────────
"Computer generated invoice" | Authorised Signatory
```

### Print Styles
```css
@media print {
  .no-print { display: none !important; }
  body { background: white !important; }
  #invoice-print {
    border: none !important;
    border-radius: 0 !important;
  }
}
```

---

## 7. Icons

Using emoji icons for navigation (no icon library needed):

```
Dashboard:   📊
Invoices:    🧾
Quotations:  📋
Credit Notes: 📝
Bills:       🛒
Expenses:    💸
Customers:   👥
Vendors:     🏭
Products:    📦
Inventory:   🏪
GST:         🏛️
GSTR-1:      📤
GSTR-3B:     📑
Reports:     📈
Settings:    ⚙️
Payments:    💳
```

---

## 8. Empty States

Every list page must have an empty state when no data exists:

```
Large emoji (36-48px)
Heading: "No X yet" (16px, weight 500, color #64748b)
Description: What to do (13px, color #94a3b8)
Optional: Primary action button
```

---

## 9. Form Layout Patterns

### Two-column grid (most forms)
```css
display: grid;
grid-template-columns: 1fr 1fr;
gap: 1rem;
```

### Three-column grid (address fields)
```css
display: grid;
grid-template-columns: 1fr 1fr 1fr;
gap: 1rem;
```

### Line items grid (invoice)
```css
display: grid;
grid-template-columns: 2fr 1fr 0.8fr 1fr 0.7fr 0.7fr 1fr 36px;
gap: 6px;
```

---

## 10. Number Formatting

Always use `formatINR()` from gst-engine.ts:
```typescript
formatINR(1234567.89)  →  "12,34,567.89"
```

Always show ₹ symbol before amounts:
```
₹12,34,567.89
```

For large dashboard metrics:
```
₹12.3L  (lakhs)
₹1.2Cr  (crores)
```
(implement in future — currently show full amount)

---

## 11. Responsive Breakpoints

Primary target: Desktop 1280px+
Secondary: Tablet 768px+
Tertiary: Mobile 375px+

Currently desktop-first. Mobile improvements in Version 1.
