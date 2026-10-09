// Shared write paths for the two note registers: sequence number → note row →
// item rows. Used by the credit-notes and debit-notes forms and by the Tally
// bridge, so every route produces identical rows. A note is a signed document
// that reduces the period it is dated in — it never inverts an invoice.

import { getFinancialYear } from '@/lib/gst-engine'

export type NoteFields = Record<string, unknown>
export type NoteItemFields = Record<string, unknown>

export interface CreatedNote {
  noteId: string
  noteNumber: string
}

interface NoteSpec {
  seqTable: string
  docTable: string
  itemsTable: string
  prefix: string
  numberField: string
  dateField: string
  idField: string
}

const CREDIT: NoteSpec = {
  seqTable: 'credit_note_sequences',
  docTable: 'credit_notes',
  itemsTable: 'credit_note_items',
  prefix: 'CN',
  numberField: 'credit_note_number',
  dateField: 'credit_note_date',
  idField: 'credit_note_id',
}

const DEBIT: NoteSpec = {
  seqTable: 'debit_note_sequences',
  docTable: 'debit_notes',
  itemsTable: 'debit_note_items',
  prefix: 'DN',
  numberField: 'debit_note_number',
  dateField: 'debit_note_date',
  idField: 'debit_note_id',
}

async function createNote(
  supabase: any,
  spec: NoteSpec,
  orgId: string,
  fields: NoteFields,
  items: NoteItemFields[],
): Promise<CreatedNote> {
  const date = fields[spec.dateField] as string | undefined
  // The note is numbered in the financial year it is dated in, the way
  // createInvoice numbers an invoice — not in the year today happens to fall in.
  const fy = getFinancialYear(date ? new Date(date) : new Date())

  const { data: seq } = await supabase
    .from(spec.seqTable)
    .select('*')
    .eq('organization_id', orgId)
    .eq('financial_year', fy)
    .single()

  let nextNumber = 1
  if (seq) {
    nextNumber = seq.last_number + 1
    await supabase
      .from(spec.seqTable)
      .update({ last_number: nextNumber })
      .eq('id', seq.id)
  } else {
    await supabase
      .from(spec.seqTable)
      .insert({ organization_id: orgId, prefix: spec.prefix, financial_year: fy, last_number: 1 })
  }

  const noteNumber = `${spec.prefix}-${fy}-${String(nextNumber).padStart(4, '0')}`

  const { data: note, error: noteError } = await supabase
    .from(spec.docTable)
    .insert({ ...fields, organization_id: orgId, [spec.numberField]: noteNumber, status: (fields.status as string) || 'active' })
    .select()
    .single()
  if (noteError) throw noteError

  const { error: itemsError } = await supabase
    .from(spec.itemsTable)
    .insert(items.map((item, idx) => ({
      ...item,
      organization_id: orgId,
      [spec.idField]: note.id,
      sort_order: idx,
    })))
  if (itemsError) throw itemsError

  return { noteId: note.id, noteNumber }
}

export function createCreditNote(
  supabase: any,
  orgId: string,
  fields: NoteFields,
  items: NoteItemFields[],
): Promise<CreatedNote> {
  return createNote(supabase, CREDIT, orgId, fields, items)
}

export function createDebitNote(
  supabase: any,
  orgId: string,
  fields: NoteFields,
  items: NoteItemFields[],
): Promise<CreatedNote> {
  return createNote(supabase, DEBIT, orgId, fields, items)
}
