'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import AuthShell from '@/components/AuthShell'
import { Button } from '@/components/ui'
import Icon from '@/components/Icons'
import {
  INDIAN_STATES,
  BUSINESS_TYPES,
  GST_REGISTRATION_TYPES,
  validateGSTIN,
  getStateFromGSTIN
} from '@/lib/constants'

export default function SetupPage() {
  const router = useRouter()
  const supabase = createClient()
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [orgId, setOrgId] = useState('')

  // Step 1 — Company details
  const [company, setCompany] = useState({
    name: '',
    trade_name: '',
    pan: '',
    business_type: '',
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    state_code: '',
    pincode: '',
    phone: '',
    email: '',
    website: '',
  })

  // Step 2 — GST Registration
  const [gst, setGst] = useState({
    gstin: '',
    registration_type: 'regular',
    registration_date: '',
  })

  const [gstinError, setGstinError] = useState('')
  const [gstinValid, setGstinValid] = useState(false)

  useEffect(() => {
    // Check user is logged in
    async function checkAuth() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) router.push('/login')
    }
    checkAuth()
  }, [])

  function handleCompanyChange(field: string, value: string) {
    setCompany(prev => ({ ...prev, [field]: value }))
  }

  function handleStateChange(value: string) {
    const state = INDIAN_STATES.find(s => s.value === value)
    setCompany(prev => ({
      ...prev,
      state_code: value,
      state: state?.label || ''
    }))
  }

  function handleGSTINChange(value: string) {
    const upper = value.toUpperCase()
    setGst(prev => ({ ...prev, gstin: upper }))

    if (upper.length === 15) {
      const isValid = validateGSTIN(upper)
      if (isValid) {
        const stateInfo = getStateFromGSTIN(upper)
        setGstinValid(true)
        setGstinError('')
        if (stateInfo) {
          setCompany(prev => ({
            ...prev,
            state_code: stateInfo.code,
            state: stateInfo.state
          }))
        }
      } else {
        setGstinValid(false)
        setGstinError('Invalid GSTIN format. Please check and re-enter.')
      }
    } else {
      setGstinValid(false)
      setGstinError('')
    }
  }

  async function handleStep1Submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not logged in')

      // Create organization
      const { data: org, error: orgError } = await supabase
        .from('organizations')
        .insert({
          name: company.name,
          trade_name: company.trade_name,
          pan: company.pan.toUpperCase(),
          business_type: company.business_type,
          address_line1: company.address_line1,
          address_line2: company.address_line2,
          city: company.city,
          state: company.state,
          state_code: company.state_code,
          pincode: company.pincode,
          phone: company.phone,
          email: company.email,
          website: company.website,
        })
        .select()
        .single()

      if (orgError) throw orgError

      // Add user as owner
      const { error: memberError } = await supabase
        .from('org_members')
        .insert({
          organization_id: org.id,
          user_id: user.id,
          role: 'owner',
        })

      if (memberError) throw memberError

      setOrgId(org.id)
      setStep(2)
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleStep2Submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    if (!validateGSTIN(gst.gstin)) {
      setError('Please enter a valid GSTIN before continuing.')
      setLoading(false)
      return
    }

    try {
      const stateInfo = getStateFromGSTIN(gst.gstin)

      const { error: gstError } = await supabase
        .from('gst_registrations')
        .insert({
          organization_id: orgId,
          gstin: gst.gstin,
          legal_name: company.name,
          trade_name: company.trade_name,
          registration_type: gst.registration_type,
          state: stateInfo?.state || company.state,
          state_code: stateInfo?.code || company.state_code,
          registration_date: gst.registration_date || null,
          is_primary: true,
        })

      if (gstError) throw gstError

      router.push('/dashboard')
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function skipGST() {
    router.push('/dashboard')
  }

  return (
    <AuthShell subtitle="Let's set up your business" width={600}>
      {/* Step indicator */}
      <div className="su-steps">
        {[1, 2].map((s) => (
          <div key={s} className={`su-step ${step >= s ? 'is-on' : ''}`}>
            <span className="su-step-dot">
              {step > s ? <Icon name="check" size={13} strokeWidth={3} /> : s}
            </span>
            <span className="su-step-name">
              {s === 1 ? 'Company Details' : 'GST Registration'}
            </span>
            {s < 2 && <span className={`su-step-line ${step > s ? 'is-on' : ''}`} />}
          </div>
        ))}
      </div>

      {/* STEP 1 */}
      {step === 1 && (
        <form onSubmit={handleStep1Submit} className="auth-form">
          <h2 className="auth-title" style={{ marginBottom: '0.5rem' }}>Company Details</h2>

          <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="auth-field">
              <span>Legal Business Name *</span>
              <input
                className="tf-input"
                value={company.name}
                onChange={e => handleCompanyChange('name', e.target.value)}
                placeholder="ABC Traders Pvt Ltd"
                required
              />
            </div>
            <div className="auth-field">
              <span>Trade Name</span>
              <input
                className="tf-input"
                value={company.trade_name}
                onChange={e => handleCompanyChange('trade_name', e.target.value)}
                placeholder="ABC Traders (if different)"
              />
            </div>
          </div>

          <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="auth-field">
              <span>PAN</span>
              <input
                className="tf-input"
                value={company.pan}
                onChange={e => handleCompanyChange('pan', e.target.value.toUpperCase())}
                placeholder="AABCU9603R"
                maxLength={10}
              />
            </div>
            <div className="auth-field">
              <span>Business Type *</span>
              <select
                className="tf-input"
                style={{ cursor: 'pointer' }}
                value={company.business_type}
                onChange={e => handleCompanyChange('business_type', e.target.value)}
                required
              >
                <option value="">Select type...</option>
                {BUSINESS_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="auth-field">
            <span>Address Line 1 *</span>
            <input
              className="tf-input"
              value={company.address_line1}
              onChange={e => handleCompanyChange('address_line1', e.target.value)}
              placeholder="Shop No / Building / Street"
              required
            />
          </div>

          <div className="auth-field">
            <span>Address Line 2</span>
            <input
              className="tf-input"
              value={company.address_line2}
              onChange={e => handleCompanyChange('address_line2', e.target.value)}
              placeholder="Area / Locality"
            />
          </div>

          <div className="form-grid-3" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
            <div className="auth-field">
              <span>City *</span>
              <input
                className="tf-input"
                value={company.city}
                onChange={e => handleCompanyChange('city', e.target.value)}
                placeholder="Mumbai"
                required
              />
            </div>
            <div className="auth-field">
              <span>State *</span>
              <select
                className="tf-input"
                style={{ cursor: 'pointer' }}
                value={company.state_code}
                onChange={e => handleStateChange(e.target.value)}
                required
              >
                <option value="">Select state...</option>
                {INDIAN_STATES.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
            <div className="auth-field">
              <span>Pincode *</span>
              <input
                className="tf-input"
                value={company.pincode}
                onChange={e => handleCompanyChange('pincode', e.target.value)}
                placeholder="400001"
                maxLength={6}
                required
              />
            </div>
          </div>

          <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="auth-field">
              <span>Phone *</span>
              <input
                className="tf-input"
                value={company.phone}
                onChange={e => handleCompanyChange('phone', e.target.value)}
                placeholder="+91 98765 43210"
                required
              />
            </div>
            <div className="auth-field">
              <span>Business Email *</span>
              <input
                className="tf-input"
                type="email"
                value={company.email}
                onChange={e => handleCompanyChange('email', e.target.value)}
                placeholder="accounts@abctraders.com"
                required
              />
            </div>
          </div>

          {error && (
            <div className="auth-error" role="alert">
              <Icon name="alert" size={14} strokeWidth={2.2} />
              <span>{error}</span>
            </div>
          )}

          <Button type="submit" disabled={loading} style={{ width: '100%' }}>
            {loading ? 'Saving…' : 'Continue to GST Setup →'}
          </Button>
        </form>
      )}

      {/* STEP 2 */}
      {step === 2 && (
        <form onSubmit={handleStep2Submit} className="auth-form">
          <div>
            <h2 className="auth-title">GST Registration</h2>
            <p className="auth-sub" style={{ marginBottom: 0 }}>
              Enter your GSTIN details. You can add more registrations later from Settings.
            </p>
          </div>

          <div className="auth-field">
            <span>GSTIN *</span>
            <input
              className="tf-input"
              style={{
                fontFamily: 'var(--mono)',
                letterSpacing: '1px',
                fontSize: '15px',
                borderColor: gstinError
                  ? 'color-mix(in srgb, var(--red) 55%, white)'
                  : gstinValid
                    ? 'color-mix(in srgb, var(--green) 55%, white)'
                    : undefined,
              }}
              value={gst.gstin}
              onChange={e => handleGSTINChange(e.target.value)}
              placeholder="27AABCU9603R1ZX"
              maxLength={15}
              required
            />
            {gstinError && (
              <p className="su-hint is-err">
                <Icon name="alert" size={12} strokeWidth={2.4} /> {gstinError}
              </p>
            )}
            {gstinValid && (
              <p className="su-hint is-ok">
                <Icon name="check" size={12} strokeWidth={3} /> Valid GSTIN format — State auto-detected
              </p>
            )}
            <p className="su-hint is-muted">
              15-character GSTIN as on your GST registration certificate
            </p>
          </div>

          <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="auth-field">
              <span>Registration Type *</span>
              <select
                className="tf-input"
                style={{ cursor: 'pointer' }}
                value={gst.registration_type}
                onChange={e => setGst(prev => ({ ...prev, registration_type: e.target.value }))}
                required
              >
                {GST_REGISTRATION_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="auth-field">
              <span>Registration Date</span>
              <input
                className="tf-input"
                type="date"
                value={gst.registration_date}
                onChange={e => setGst(prev => ({ ...prev, registration_date: e.target.value }))}
              />
            </div>
          </div>

          {gstinValid && (
            <div className="su-note">
              <strong>State detected from GSTIN:</strong> {company.state} (Code: {company.state_code})
            </div>
          )}

          {error && (
            <div className="auth-error" role="alert">
              <Icon name="alert" size={14} strokeWidth={2.2} />
              <span>{error}</span>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Button type="submit" disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Saving…' : 'Complete Setup & Go to Dashboard →'}
            </Button>
            <Button type="button" variant="ghost" onClick={skipGST} style={{ width: '100%' }}>
              Skip for now — I&apos;ll add GSTIN later
            </Button>
          </div>
        </form>
      )}

      <style>{`
        .su-steps {
          display: flex; align-items: center; justify-content: center;
          flex-wrap: wrap; gap: 8px; margin-bottom: 1.35rem;
        }
        .su-step { display: flex; align-items: center; gap: 8px; }
        .su-step-dot {
          width: 30px; height: 30px; border-radius: 99px;
          display: inline-flex; align-items: center; justify-content: center;
          font-size: 12px; font-weight: 650;
          background: var(--slate-soft); color: var(--faint);
          transition: background .18s ease, color .18s ease;
        }
        .su-step.is-on .su-step-dot {
          background: var(--brand); color: white;
          box-shadow: 0 4px 10px -4px var(--brand-ring);
        }
        .su-step-name { font-size: 13px; color: var(--faint); }
        .su-step.is-on .su-step-name { color: var(--ink); font-weight: 600; }
        .su-step-line { width: 36px; height: 2px; border-radius: 2px; background: var(--line); }
        .su-step-line.is-on { background: var(--brand); }

        .su-hint { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; margin-top: 2px; }
        .su-hint.is-err { color: var(--red); }
        .su-hint.is-ok { color: var(--green); }
        .su-hint.is-muted { color: var(--faint); font-size: 11px; }

        .su-note {
          background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white);
          border-radius: var(--radius-sm); padding: 11px 12px;
          font-size: 13px; color: var(--green);
        }

        @media (max-width: 480px) {
          .su-step-line { width: 22px; }
        }
      `}</style>
    </AuthShell>
  )
}
