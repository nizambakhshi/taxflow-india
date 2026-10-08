// Statement share links are meant for one recipient, not for search engines —
// keep the whole /portal surface out of indexes.
import type { ReactNode } from 'react'

export const metadata = {
  title: 'Statement of account — TaxFlow India',
  robots: { index: false, follow: false },
}

export default function PortalLayout({ children }: { children: ReactNode }) {
  return children
}
