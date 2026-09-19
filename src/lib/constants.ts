export const INDIAN_STATES = [
    { value: '01', label: 'Jammu & Kashmir' },
    { value: '02', label: 'Himachal Pradesh' },
    { value: '03', label: 'Punjab' },
    { value: '04', label: 'Chandigarh' },
    { value: '05', label: 'Uttarakhand' },
    { value: '06', label: 'Haryana' },
    { value: '07', label: 'Delhi' },
    { value: '08', label: 'Rajasthan' },
    { value: '09', label: 'Uttar Pradesh' },
    { value: '10', label: 'Bihar' },
    { value: '11', label: 'Sikkim' },
    { value: '12', label: 'Arunachal Pradesh' },
    { value: '13', label: 'Nagaland' },
    { value: '14', label: 'Manipur' },
    { value: '15', label: 'Mizoram' },
    { value: '16', label: 'Tripura' },
    { value: '17', label: 'Meghalaya' },
    { value: '18', label: 'Assam' },
    { value: '19', label: 'West Bengal' },
    { value: '20', label: 'Jharkhand' },
    { value: '21', label: 'Odisha' },
    { value: '22', label: 'Chhattisgarh' },
    { value: '23', label: 'Madhya Pradesh' },
    { value: '24', label: 'Gujarat' },
    { value: '25', label: 'Daman & Diu' },
    { value: '26', label: 'Dadra & Nagar Haveli' },
    { value: '27', label: 'Maharashtra' },
    { value: '28', label: 'Andhra Pradesh (Old)' },
    { value: '29', label: 'Karnataka' },
    { value: '30', label: 'Goa' },
    { value: '31', label: 'Lakshadweep' },
    { value: '32', label: 'Kerala' },
    { value: '33', label: 'Tamil Nadu' },
    { value: '34', label: 'Puducherry' },
    { value: '35', label: 'Andaman & Nicobar Islands' },
    { value: '36', label: 'Telangana' },
    { value: '37', label: 'Andhra Pradesh' },
    { value: '38', label: 'Ladakh' },
  ]
  
  export const BUSINESS_TYPES = [
    { value: 'proprietorship', label: 'Proprietorship' },
    { value: 'partnership', label: 'Partnership' },
    { value: 'llp', label: 'LLP (Limited Liability Partnership)' },
    { value: 'private_limited', label: 'Private Limited Company' },
    { value: 'public_limited', label: 'Public Limited Company' },
    { value: 'one_person_company', label: 'One Person Company (OPC)' },
    { value: 'trust', label: 'Trust' },
    { value: 'society', label: 'Society' },
    { value: 'huf', label: 'HUF (Hindu Undivided Family)' },
    { value: 'government', label: 'Government Entity' },
    { value: 'other', label: 'Other' },
  ]
  
  export const GST_REGISTRATION_TYPES = [
    { value: 'regular', label: 'Regular Taxpayer' },
    { value: 'composition', label: 'Composition Scheme' },
    { value: 'sez_unit', label: 'SEZ Unit' },
    { value: 'sez_developer', label: 'SEZ Developer' },
    { value: 'casual', label: 'Casual Taxable Person' },
    { value: 'non_resident', label: 'Non-Resident Taxable Person' },
    { value: 'isd', label: 'Input Service Distributor (ISD)' },
    { value: 'tds', label: 'TDS Deductor' },
    { value: 'tcs', label: 'TCS Collector (E-Commerce)' },
    { value: 'uin', label: 'UIN Holder' },
  ]
  
  // Validate GSTIN format (basic structural check)
  // Format: 2 digit state code + 10 char PAN + 1 digit entity + Z + 1 checksum
  export function validateGSTIN(gstin: string): boolean {
    const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/
    return gstinRegex.test(gstin.toUpperCase())
  }
  
  // Extract state code from GSTIN
  export function getStateFromGSTIN(gstin: string): { code: string; state: string } | null {
    if (!validateGSTIN(gstin)) return null
    const code = gstin.substring(0, 2)
    const state = INDIAN_STATES.find(s => s.value === code)
    return state ? { code, state: state.label } : null
  }