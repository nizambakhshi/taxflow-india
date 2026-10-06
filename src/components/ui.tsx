'use client'

import type { CSSProperties, ReactNode } from 'react'
import Link from 'next/link'
import Icon from '@/components/Icons'
import { formatCompactINR } from '@/lib/format'

/** Lets us set CSS custom properties from inline styles without fighting TS. */
function vars(defs: Record<string, string>): CSSProperties {
  return defs as CSSProperties
}

export type Tone = 'blue' | 'green' | 'red' | 'amber' | 'violet' | 'cyan' | 'grey'

const TONE_COLORS: Record<Tone, { fg: string; soft: string }> = {
  blue: { fg: 'var(--brand)', soft: 'var(--brand-soft)' },
  green: { fg: 'var(--green)', soft: 'var(--green-soft)' },
  red: { fg: 'var(--red)', soft: 'var(--red-soft)' },
  amber: { fg: 'var(--amber)', soft: 'var(--amber-soft)' },
  violet: { fg: 'var(--violet)', soft: 'var(--violet-soft)' },
  cyan: { fg: 'var(--cyan)', soft: 'var(--cyan-soft)' },
  grey: { fg: 'var(--muted)', soft: 'var(--slate-soft)' },
}

export function Card({
  children, className = '', pad = true, hover = false, style,
}: {
  children: ReactNode
  className?: string
  pad?: boolean
  hover?: boolean
  style?: CSSProperties
}) {
  return (
    <div
      className={`tf-card ${pad ? 'tf-card-pad' : ''} ${hover ? 'tf-card-hover' : ''} ${className}`}
      style={style}
    >
      {children}
    </div>
  )
}

export function SectionTitle({
  children, icon, action,
}: {
  children: ReactNode
  icon?: string
  action?: ReactNode
}) {
  return (
    <div className="tf-row-between" style={{ marginBottom: '0.9rem' }}>
      <div className="tf-row" style={{ gap: 7 }}>
        {icon && <Icon name={icon} size={15} style={{ color: 'var(--brand)' }} />}
        <span className="tf-section-title">{children}</span>
      </div>
      {action}
    </div>
  )
}

export function StatCard({
  label, value, sub, icon, tone = 'blue', delta, deltaSuffix = 'vs last month', href, delay = 0,
}: {
  label: string
  value: number | string
  sub?: string
  icon?: string
  tone?: Tone
  delta?: number | null
  deltaSuffix?: string
  href?: string
  delay?: number
}) {
  const c = TONE_COLORS[tone]
  const body = (
    <div
      className="tf-stat tf-rise"
      style={{ ...vars({ '--accent': c.fg }), animationDelay: `${delay}ms` }}
    >
      <div className="tf-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="tf-stat-label">{label}</div>
          <div className="tf-stat-value" style={{ marginTop: 6 }}>
            {typeof value === 'number' ? formatCompactINR(value) : value}
          </div>
        </div>
        {icon && (
          <span className="tf-chip" style={vars({ '--chip-bg': c.soft, '--chip-fg': c.fg })}>
            <Icon name={icon} size={17} />
          </span>
        )}
      </div>
      <div className="tf-row" style={{ marginTop: 8, gap: 6, flexWrap: 'wrap' }}>
        {delta !== undefined && delta !== null && <DeltaPill delta={delta} />}
        {(sub || (delta != null && deltaSuffix)) && (
          <span className="tf-stat-sub">{sub ?? deltaSuffix}</span>
        )}
      </div>
    </div>
  )

  return href
    ? <Link href={href} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>{body}</Link>
    : body
}

export function DeltaPill({ delta }: { delta: number }) {
  const up = delta > 0.05
  const down = delta < -0.05
  const cls = up ? 'tf-delta tf-delta-up' : down ? 'tf-delta tf-delta-down' : 'tf-delta tf-delta-flat'
  return (
    <span className={cls}>
      <Icon name={up ? 'arrow-up' : down ? 'arrow-down' : 'trend'} size={11} strokeWidth={2.4} />
      {Math.abs(delta).toFixed(Math.abs(delta) >= 100 ? 0 : 1)}%
    </span>
  )
}

export function Badge({
  children, tone = 'grey', dot = true,
}: {
  children: ReactNode
  tone?: Tone
  dot?: boolean
}) {
  return <span className={`tf-badge tf-badge-${tone} ${dot ? '' : 'tf-badge-plain'}`}>{children}</span>
}

export function Button({
  children, variant = 'primary', size, icon, iconRight, onClick, href, type = 'button', disabled, style, title,
}: {
  children: ReactNode
  variant?: 'primary' | 'ghost' | 'subtle' | 'danger'
  size?: 'sm'
  icon?: string
  iconRight?: string
  onClick?: () => void
  href?: string
  type?: 'button' | 'submit'
  disabled?: boolean
  style?: CSSProperties
  title?: string
}) {
  const cls = `tf-btn tf-btn-${variant} ${size === 'sm' ? 'tf-btn-sm' : ''}`
  const inner = (
    <>
      {icon && <Icon name={icon} size={size === 'sm' ? 13 : 15} strokeWidth={2} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 13 : 15} strokeWidth={2} />}
    </>
  )
  if (href) {
    return <Link href={href} className={cls} style={style} title={title}>{inner}</Link>
  }
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled} style={style} title={title}>
      {inner}
    </button>
  )
}

export function PageHeader({
  title, subtitle, eyebrow, actions, right,
}: {
  title: ReactNode
  subtitle?: ReactNode
  eyebrow?: string
  actions?: ReactNode
  right?: ReactNode
}) {
  return (
    <div className="tf-pagehead tf-row-between tf-wrap" style={{ marginBottom: '1.15rem' }}>
      <div style={{ minWidth: 0 }}>
        {eyebrow && (
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'rgba(180,208,255,0.85)' }}>
            {eyebrow}
          </div>
        )}
        <h1 style={{ marginTop: eyebrow ? 4 : 0 }}>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="tf-row tf-wrap" style={{ gap: 8, position: 'relative', zIndex: 1 }}>
        {actions}
        {right}
      </div>
    </div>
  )
}

export function EmptyState({
  icon = 'box', title, message, action,
}: {
  icon?: string
  title: string
  message?: string
  action?: ReactNode
}) {
  return (
    <div className="tf-empty">
      <span className="tf-chip" style={{ ...vars({ '--chip-bg': 'var(--slate-soft)', '--chip-fg': 'var(--faint)' }), margin: '0 auto 12px', width: 46, height: 46 }}>
        <Icon name={icon} size={22} />
      </span>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 4 }}>{title}</div>
      {message && <div style={{ maxWidth: 360, margin: '0 auto 14px' }}>{message}</div>}
      {action}
    </div>
  )
}

export function Segmented({
  options, value, onChange,
}: {
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="tab-bar" style={{
      background: 'var(--slate-soft)', borderRadius: 10, padding: 3, gap: 3, display: 'inline-flex',
    }}>
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            fontFamily: 'inherit', fontSize: 12, fontWeight: 600, padding: '6px 13px',
            border: 'none', borderRadius: 8, cursor: 'pointer',
            background: value === o.value ? 'var(--surface)' : 'transparent',
            color: value === o.value ? 'var(--brand)' : 'var(--muted)',
            boxShadow: value === o.value ? 'var(--shadow-xs)' : 'none',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function StatRow({
  label, value, tone = 'grey', strong = false,
}: {
  label: ReactNode
  value: ReactNode
  tone?: Tone
  strong?: boolean
}) {
  return (
    <div className="tf-row-between" style={{
      padding: '9px 0', fontSize: 13, borderBottom: '1px solid var(--line-soft)',
    }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="tf-num" style={{
        fontWeight: strong ? 700 : 550,
        color: tone === 'grey' ? 'var(--ink)' : TONE_COLORS[tone].fg,
      }}>{value}</span>
    </div>
  )
}

export function ProgressBar({
  value, max = 100, color = 'var(--brand)', height = 7,
}: {
  value: number
  max?: number
  color?: string
  height?: number
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <div className="tf-bar-track" style={{ height }}>
      <div className="tf-bar-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

/**
 * Dependency-free SVG column chart: gradient bars, hover tooltip, value axis
 * drawn from the largest series value.
 */
export function BarChart({
  data, height = 150, color = '#2563eb', format = formatCompactINR,
}: {
  data: { label: string; value: number; sublabel?: string }[]
  height?: number
  color?: string
  format?: (n: number) => string
}) {
  const max = Math.max(...data.map(d => d.value), 1)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height, padding: '0 2px' }}>
      {data.map((d, i) => {
        const h = Math.max(3, (d.value / max) * (height - 34))
        const last = i === data.length - 1
        return (
          <div key={`${d.label}-${i}`} style={{
            flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: 5, position: 'relative',
          }}>
            <div title={`${d.sublabel ?? d.label}: ${format(d.value)}`} style={{
              width: '100%', maxWidth: 42, height: h, borderRadius: '6px 6px 3px 3px',
              background: last
                ? `linear-gradient(180deg, ${color}, ${color}cc)`
                : `linear-gradient(180deg, ${color}55, ${color}22)`,
              transformOrigin: 'bottom', animation: 'tf-grow 0.5s cubic-bezier(0.22,1,0.36,1) both',
              animationDelay: `${i * 45}ms`, cursor: 'default',
            }} />
            <div style={{
              fontSize: 10, color: last ? 'var(--ink-2)' : 'var(--faint)',
              fontWeight: last ? 650 : 500, whiteSpace: 'nowrap',
            }}>
              {d.label}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Horizontal stacked distribution, e.g. ageing buckets or GST split. */
export function StackedBar({
  segments, height = 10,
}: {
  segments: { label: string; value: number; color: string }[]
  height?: number
}) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  if (!total) return <div className="tf-bar-track" style={{ height }} />
  return (
    <div style={{ display: 'flex', gap: 2, height, borderRadius: 99, overflow: 'hidden' }}>
      {segments.filter(s => s.value > 0).map(s => (
        <div
          key={s.label}
          title={`${s.label}: ${formatCompactINR(s.value)}`}
          style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
        />
      ))}
    </div>
  )
}
