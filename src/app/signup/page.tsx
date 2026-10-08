'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase'
import Link from 'next/link'
import AuthShell from '@/components/AuthShell'
import { Button } from '@/components/ui'
import Icon from '@/components/Icons'

export default function SignupPage() {
  const supabase = createClient()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName }
      }
    })

    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      setSuccess(true)
      setLoading(false)
    }
  }

  if (success) {
    return (
      <AuthShell subtitle="GST Billing & Compliance">
        <div className="auth-done">
          <span className="auth-done-mark">
            <Icon name="check" size={22} strokeWidth={2.6} />
          </span>
          <h1 className="auth-title">Check your email</h1>
          <p className="auth-sub">
            We sent a confirmation link to <strong>{email}</strong>. Click it to
            activate your account, then sign in.
          </p>
          <Button variant="ghost" href="/login" style={{ width: '100%', justifyContent: 'center' }}>
            Go to login
          </Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell subtitle="GST Billing & Compliance">
      <h1 className="auth-title">Create your free account</h1>

      <form onSubmit={handleSignup} className="auth-form" style={{ marginTop: '1.25rem' }}>
        <div className="auth-field">
          <span>Full name</span>
          <input
            type="text"
            className="tf-input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            placeholder="Rajesh Kumar"
          />
        </div>

        <div className="auth-field">
          <span>Email address</span>
          <input
            type="email"
            className="tf-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="you@company.com"
          />
        </div>

        <div className="auth-field">
          <span>Password</span>
          <input
            type="password"
            className="tf-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            placeholder="Minimum 6 characters"
            minLength={6}
          />
        </div>

        {error && (
          <div className="auth-error" role="alert">
            <Icon name="alert" size={14} strokeWidth={2.2} />
            <span>{error}</span>
          </div>
        )}

        <Button
          type="submit"
          disabled={loading}
          style={{ width: '100%' }}
        >
          {loading ? 'Creating account…' : 'Create free account'}
        </Button>
      </form>

      <p className="auth-alt">
        Already have an account?{' '}
        <Link href="/login">Sign in</Link>
      </p>
    </AuthShell>
  )
}
