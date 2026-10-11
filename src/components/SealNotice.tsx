'use client'

// The seal, drawn beside the date that would break it.
//
// Why this is a component and not a `<div>` on each page: R3-5 put the period seal on the shared
// document writers, so a date inside a closed window is now refused by the engine behind the
// button — invoice, bill, note, POS sale, recurring catch-up, offline replay. A page still wants
// to say so *before* the shop presses Save, and every one of those pages used to draw its own red
// box in its own words. One component means one sentence, one red, and no path that quietly
// shortened it.
//
// It reads the seal (`sealGuard`) and never asks it (`askSeal`): a banner appearing on screen is
// not an attempt to write, and an attempt is the only thing that belongs on the trail. The write
// path itself logs the refusal when the save is actually pressed.
//
// Renders nothing while `orgId` is empty, which is also what keeps the first server render quiet —
// this device's registers are not in the HTML, they are read after mount.

import Icon from '@/components/Icons'
import { sealGuard } from '@/lib/audit'

export default function SealNotice({
  orgId,
  date,
  href = '/audit?tab=seals',
  linkLabel = 'View seals',
}: {
  orgId: string
  /** The date this field is about to write. A missing date has no window to fall inside. */
  date: string
  href?: string
  linkLabel?: string
}) {
  if (!orgId || !date) return null
  const guard = sealGuard(orgId, date)
  if (!guard.sealed) return null

  return (
    <div className="tf-notice" role="alert">
      <Icon name="lock" size={14} strokeWidth={2.2} />
      <span>
        {guard.why}{' '}
        <a href={href} className="tf-notice-link">{linkLabel}</a>
      </span>
    </div>
  )
}
