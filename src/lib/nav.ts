// The app's navigation, as data. Both the sidebar shell and the command palette
// read this, so a page can never appear in one and be missing from the other.

export interface NavLeaf {
  label: string
  href: string
  icon: string
}

export interface NavSection {
  section: string
  items: NavLeaf[]
}

export const NAV_ITEMS: NavSection[] = [
  {
    section: 'Overview',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: 'dashboard' },
      { label: 'Offline Sync', href: '/offline', icon: 'cloud' },
    ]
  },
  {
    section: 'Sales',
    items: [
      { label: 'Invoices', href: '/invoices', icon: 'invoice' },
      { label: 'Recurring Invoices', href: '/recurring', icon: 'repeat' },
      { label: 'Counter Sale', href: '/pos', icon: 'pos' },
      { label: 'Quotations', href: '/quotations', icon: 'clipboard' },
      { label: 'Sales Orders', href: '/sales-orders', icon: 'bag' },
      { label: 'Delivery Challans', href: '/challans', icon: 'truck' },
      { label: 'Credit Notes', href: '/credit-notes', icon: 'credit-note' },
      { label: 'Debit Notes', href: '/debit-notes', icon: 'debit-note' },
    ]
  },
  {
    section: 'Purchases',
    items: [
      { label: 'Purchase Orders', href: '/purchase-orders', icon: 'clipboard-check' },
      { label: 'Bills', href: '/bills', icon: 'cart' },
      { label: 'Expenses', href: '/expenses', icon: 'wallet' },
    ]
  },
  {
    section: 'Payments',
    items: [
      { label: 'Receivables & Payables', href: '/payments', icon: 'swap' },
      { label: 'Payment Links', href: '/payments/links', icon: 'link' },
      { label: 'Bank Matching', href: '/bank', icon: 'landmark' },
      { label: 'Foreign Currency', href: '/fx', icon: 'globe' },
    ]
  },
  {
    section: 'Masters',
    items: [
      { label: 'Customers', href: '/customers', icon: 'users' },
      { label: 'Vendors', href: '/vendors', icon: 'factory' },
      { label: 'Products', href: '/products', icon: 'box' },
      { label: 'Inventory', href: '/inventory', icon: 'store' },
      { label: 'Reorder Planner', href: '/inventory/reorder', icon: 'cart' },
      { label: 'Batches & Expiry', href: '/inventory/batches', icon: 'clock' },
      { label: 'Godowns', href: '/inventory/godowns', icon: 'warehouse' },
      { label: 'Serial Numbers', href: '/inventory/serials', icon: 'hash' },
    ]
  },
  {
    section: 'GST',
    items: [
      { label: 'GST Dashboard', href: '/gst', icon: 'landmark' },
      { label: 'GSTR-1', href: '/gst/gstr1', icon: 'upload' },
      { label: 'GSTR-3B', href: '/gst/gstr3b', icon: 'file-check' },
      { label: '2B Reconciliation', href: '/gst/reconciliation', icon: 'compare' },
      { label: 'E-Invoicing', href: '/gst/einvoice', icon: 'zap' },
      { label: 'Annual Return GSTR-9', href: '/gst/gstr9', icon: 'file-check' },
      { label: 'Composition GSTR-4', href: '/gst/gstr4', icon: 'percent' },
      { label: 'Compliance Calendar', href: '/gst/calendar', icon: 'calendar' },
      { label: 'TDS & 194Q Workpaper', href: '/tds', icon: 'percent' },
    ]
  },
  {
    section: 'Reports & AI',
    items: [
      { label: 'Reports', href: '/reports', icon: 'chart' },
      { label: 'Targets & Achievement', href: '/reports/targets', icon: 'target' },
      { label: 'Statutory Registers', href: '/reports/registers', icon: 'clipboard' },
      { label: 'Account Ledger', href: '/ledger', icon: 'book' },
      { label: 'Financial Statements', href: '/accounting', icon: 'scale' },
      { label: 'Scan Bill', href: '/ai/scan-bill', icon: 'scan' },
      { label: 'Ask My Books', href: '/ai/ask', icon: 'chat' },
    ]
  },
  {
    section: 'Account',
    items: [
      { label: 'Settings', href: '/settings', icon: 'settings' },
    ]
  },
]

// Bottom nav items for mobile (most important only)
export const BOTTOM_NAV: NavLeaf[] = [
  { label: 'Home', href: '/dashboard', icon: 'dashboard' },
  { label: 'Invoices', href: '/invoices', icon: 'invoice' },
  { label: 'Bills', href: '/bills', icon: 'cart' },
  { label: 'GST', href: '/gst', icon: 'landmark' },
]
