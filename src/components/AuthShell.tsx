import type { ReactNode } from 'react'
import Icon from './Icons'

/**
 * The shared chrome for the three auth surfaces (login, signup, setup).
 * Same brand mark as the app shell, one card, token-only colours.
 * Form styling lives here too (.auth-*) so the three pages stay markup-thin.
 */
export default function AuthShell({
  subtitle,
  width = 400,
  children,
}: {
  subtitle?: string
  width?: number
  children: ReactNode
}) {
  return (
    <div className="auth-wrap">
      <div className="auth-glow" aria-hidden="true" />
      <div className="auth-col" style={{ maxWidth: width }}>
        <div className="auth-brand">
          <span className="auth-mark">
            <Icon name="zap" size={20} strokeWidth={2.2} />
          </span>
          <div className="auth-wordmark">
            TaxFlow <span>India</span>
          </div>
          {subtitle && <div className="auth-tagline">{subtitle}</div>}
        </div>
        <div className="tf-card auth-card">{children}</div>
      </div>

      <style>{`
        .auth-wrap {
          min-height: 100vh; display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          padding: 2rem 1rem; background: var(--bg);
          position: relative; overflow: hidden;
        }
        .auth-glow {
          position: absolute; inset: -10% -20% auto; height: 60%;
          pointer-events: none;
          background: radial-gradient(560px 300px at 50% 0%,
            color-mix(in srgb, var(--brand) 13%, transparent), transparent 70%);
        }
        .auth-col { position: relative; width: 100%; }

        .auth-brand {
          display: flex; flex-direction: column; align-items: center;
          gap: 10px; margin-bottom: 1.5rem;
        }
        .auth-mark {
          width: 44px; height: 44px; border-radius: 13px;
          display: flex; align-items: center; justify-content: center;
          color: white; background: var(--brand-grad);
          box-shadow: var(--shadow-md);
        }
        .auth-wordmark {
          font-size: 22px; font-weight: 750; letter-spacing: -0.02em;
          color: var(--ink); line-height: 1;
        }
        .auth-wordmark span { color: var(--brand); }
        .auth-tagline { font-size: 13px; color: var(--muted); }

        .auth-card { padding: 2rem; }

        .auth-title {
          font-size: 19px; font-weight: 650; letter-spacing: -0.01em;
          color: var(--ink); margin-bottom: 4px;
        }
        .auth-sub { font-size: 13px; color: var(--muted); margin-bottom: 1.5rem; }

        .auth-form { display: flex; flex-direction: column; gap: 1rem; }
        .auth-field { display: flex; flex-direction: column; gap: 5px; }
        .auth-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .auth-field .tf-input { font-size: 14px; padding: 10px 12px; }

        .auth-error {
          display: flex; align-items: flex-start; gap: 8px;
          background: var(--red-soft);
          border: 1px solid color-mix(in srgb, var(--red) 26%, white);
          color: var(--red); padding: 10px 12px;
          border-radius: var(--radius-sm); font-size: 13px;
        }
        .auth-error svg { flex-shrink: 0; margin-top: 1px; }

        .auth-alt {
          text-align: center; font-size: 13px; color: var(--muted);
          margin-top: 1.5rem;
        }
        .auth-alt a { color: var(--brand); font-weight: 600; text-decoration: none; }
        .auth-alt a:hover { text-decoration: underline; }

        .auth-done {
          display: flex; flex-direction: column; align-items: center;
          text-align: center; gap: 6px;
        }
        .auth-done-mark {
          width: 52px; height: 52px; border-radius: 99px;
          background: var(--green-soft); color: var(--green);
          display: flex; align-items: center; justify-content: center;
          margin-bottom: 6px;
        }
        .auth-done .auth-sub { margin-bottom: 1.25rem; }

        @media (max-width: 480px) {
          .auth-card { padding: 1.5rem 1.25rem; }
          .auth-wrap { padding: 1.5rem 0.75rem; }
        }
      `}</style>
    </div>
  )
}
