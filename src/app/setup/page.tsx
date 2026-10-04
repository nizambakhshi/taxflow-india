'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import {
  INDIAN_STATES,
  BUSINESS_TYPES,
  GST_REGISTRATION_TYPES,
  validateGSTIN,
  getStateFromGSTIN
} from '@/lib/constants'

const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  border: '1px solid #d1d5db',
  borderRadius: '8px',
  fontSize: '14px',
  outline: 'none',
  color: '#1e293b',
  background: 'white',
}

const labelStyle = {
  display: 'block' as const,
  fontSize: '13px',
  fontWeight: '500' as const,
  color: '#374151',
  marginBottom: '6px',
}

const selectStyle = {
  ...inputStyle,
  cursor: 'pointer',
}

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
    <div className="page-container" style={{
      minHeight: '100vh',
      background: '#f8fafc',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem'
    }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <div style={{ fontSize: '22px', fontWeight: '700', color: '#2563eb' }}>
          TaxFlow India
        </div>
        <div style={{ fontSize: '14px', color: '#64748b', marginTop: '4px' }}>
          Let's set up your business
        </div>
      </div>

      {/* Step indicator */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: '8px',
        marginBottom: '2rem'
      }}>
        {[1, 2].map((s) => (
          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              background: step >= s ? '#2563eb' : '#e2e8f0',
              color: step >= s ? 'white' : '#94a3b8',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '13px',
              fontWeight: '600'
            }}>
              {s}
            </div>
            <span style={{
              fontSize: '13px',
              color: step >= s ? '#1e293b' : '#94a3b8',
              fontWeight: step === s ? '600' : '400'
            }}>
              {s === 1 ? 'Company Details' : 'GST Registration'}
            </span>
            {s < 2 && (
              <div style={{
                width: '40px',
                height: '2px',
                background: step > s ? '#2563eb' : '#e2e8f0',
                margin: '0 4px'
              }} />
            )}
          </div>
        ))}
      </div>

      {/* Form card */}
      <div style={{
        background: 'white',
        border: '1px solid #e2e8f0',
        borderRadius: '16px',
        padding: '2rem',
        width: '100%',
        maxWidth: '600px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
      }}>

        {/* STEP 1 */}
        {step === 1 && (
          <form onSubmit={handleStep1Submit}>
            <h2 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '1.5rem', color: '#1e293b' }}>
              Company Details
            </h2>

            <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label style={labelStyle}>Legal Business Name *</label>
                <input
                  style={inputStyle}
                  value={company.name}
                  onChange={e => handleCompanyChange('name', e.target.value)}
                  placeholder="ABC Traders Pvt Ltd"
                  required
                />
              </div>
              <div>
                <label style={labelStyle}>Trade Name</label>
                <input
                  style={inputStyle}
                  value={company.trade_name}
                  onChange={e => handleCompanyChange('trade_name', e.target.value)}
                  placeholder="ABC Traders (if different)"
                />
              </div>
            </div>

            <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label style={labelStyle}>PAN</label>
                <input
                  style={inputStyle}
                  value={company.pan}
                  onChange={e => handleCompanyChange('pan', e.target.value.toUpperCase())}
                  placeholder="AABCU9603R"
                  maxLength={10}
                />
              </div>
              <div>
                <label style={labelStyle}>Business Type *</label>
                <select
                  style={selectStyle}
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

            <div style={{ marginBottom: '1rem' }}>
              <label style={labelStyle}>Address Line 1 *</label>
              <input
                style={inputStyle}
                value={company.address_line1}
                onChange={e => handleCompanyChange('address_line1', e.target.value)}
                placeholder="Shop No / Building / Street"
                required
              />
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={labelStyle}>Address Line 2</label>
              <input
                style={inputStyle}
                value={company.address_line2}
                onChange={e => handleCompanyChange('address_line2', e.target.value)}
                placeholder="Area / Locality"
              />
            </div>

            <div className="form-grid-3" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label style={labelStyle}>City *</label>
                <input
                  style={inputStyle}
                  value={company.city}
                  onChange={e => handleCompanyChange('city', e.target.value)}
                  placeholder="Mumbai"
                  required
                />
              </div>
              <div>
                <label style={labelStyle}>State *</label>
                <select
                  style={selectStyle}
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
              <div>
                <label style={labelStyle}>Pincode *</label>
                <input
                  style={inputStyle}
                  value={company.pincode}
                  onChange={e => handleCompanyChange('pincode', e.target.value)}
                  placeholder="400001"
                  maxLength={6}
                  required
                />
              </div>
            </div>

            <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
              <div>
                <label style={labelStyle}>Phone *</label>
                <input
                  style={inputStyle}
                  value={company.phone}
                  onChange={e => handleCompanyChange('phone', e.target.value)}
                  placeholder="+91 98765 43210"
                  required
                />
              </div>
              <div>
                <label style={labelStyle}>Business Email *</label>
                <input
                  style={inputStyle}
                  type="email"
                  value={company.email}
                  onChange={e => handleCompanyChange('email', e.target.value)}
                  placeholder="accounts@abctraders.com"
                  required
                />
              </div>
            </div>

            {error && (
              <div style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                color: '#dc2626',
                padding: '10px 12px',
                borderRadius: '8px',
                fontSize: '13px',
                marginBottom: '1rem'
              }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                padding: '12px',
                background: loading ? '#93c5fd' : '#2563eb',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: '600',
                cursor: loading ? 'not-allowed' : 'pointer'
              }}
            >
              {loading ? 'Saving...' : 'Continue to GST Setup →'}
            </button>
          </form>
        )}

        {/* STEP 2 */}
        {step === 2 && (
          <form onSubmit={handleStep2Submit}>
            <h2 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '4px', color: '#1e293b' }}>
              GST Registration
            </h2>
            <p style={{ fontSize: '13px', color: '#64748b', marginBottom: '1.5rem' }}>
              Enter your GSTIN details. You can add more registrations later from Settings.
            </p>

            <div style={{ marginBottom: '1rem' }}>
              <label style={labelStyle}>GSTIN *</label>
              <input
                style={{
                  ...inputStyle,
                  border: gstinError
                    ? '1px solid #f87171'
                    : gstinValid
                      ? '1px solid #34d399'
                      : '1px solid #d1d5db',
                  letterSpacing: '1px',
                  fontFamily: 'monospace',
                  fontSize: '15px'
                }}
                value={gst.gstin}
                onChange={e => handleGSTINChange(e.target.value)}
                placeholder="27AABCU9603R1ZX"
                maxLength={15}
                required
              />
              {gstinError && (
                <p style={{ fontSize: '12px', color: '#dc2626', marginTop: '4px' }}>
                  ❌ {gstinError}
                </p>
              )}
              {gstinValid && (
                <p style={{ fontSize: '12px', color: '#16a34a', marginTop: '4px' }}>
                  ✅ Valid GSTIN format — State auto-detected
                </p>
              )}
              <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                15-character GSTIN as on your GST registration certificate
              </p>
            </div>

            <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label style={labelStyle}>Registration Type *</label>
                <select
                  style={selectStyle}
                  value={gst.registration_type}
                  onChange={e => setGst(prev => ({ ...prev, registration_type: e.target.value }))}
                  required
                >
                  {GST_REGISTRATION_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Registration Date</label>
                <input
                  style={inputStyle}
                  type="date"
                  value={gst.registration_date}
                  onChange={e => setGst(prev => ({ ...prev, registration_date: e.target.value }))}
                />
              </div>
            </div>

            {gstinValid && (
              <div style={{
                background: '#f0fdf4',
                border: '1px solid #bbf7d0',
                borderRadius: '8px',
                padding: '12px',
                marginBottom: '1rem',
                fontSize: '13px',
                color: '#166534'
              }}>
                <strong>State detected from GSTIN:</strong> {company.state} (Code: {company.state_code})
              </div>
            )}

            {error && (
              <div style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                color: '#dc2626',
                padding: '10px 12px',
                borderRadius: '8px',
                fontSize: '13px',
                marginBottom: '1rem'
              }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                padding: '12px',
                background: loading ? '#93c5fd' : '#2563eb',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: '600',
                cursor: loading ? 'not-allowed' : 'pointer',
                marginBottom: '12px'
              }}
            >
              {loading ? 'Saving...' : 'Complete Setup & Go to Dashboard →'}
            </button>

            <button
              type="button"
              onClick={skipGST}
              style={{
                width: '100%',
                padding: '12px',
                background: 'white',
                color: '#64748b',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                fontSize: '13px',
                cursor: 'pointer'
              }}
            >
              Skip for now — I'll add GSTIN later
            </button>
          </form>
        )}
      </div>
    </div>
  )
}