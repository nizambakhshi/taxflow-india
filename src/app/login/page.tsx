'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import Link from 'next/link'
import AuthShell from '@/components/AuthShell'
import { Button } from '@/components/ui'
import Icon from '@/components/Icons'

export default function LoginPage() {
  const router = useRouter()
  const supabase = createClient()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/dashboard')
    }
  }

  return (
    <AuthShell subtitle="GST Billing & Compliance">
      <h1 className="auth-title">Sign in to your account</h1>

      <form onSubmit={handleLogin} className="auth-form" style={{ marginTop: '1.25rem' }}>
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
            placeholder="••••••••"
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
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <p className="auth-alt">
        Don&apos;t have an account?{' '}
        <Link href="/signup">Sign up free</Link>
      </p>
    </AuthShell>
  )
}
