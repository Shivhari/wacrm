/**
 * The single CAPI fire pipeline — used by both the dashboard route
 * (session auth) and the public v1 routes (API-key auth) so the two
 * surfaces can never drift on guard rules.
 *
 * Ordering rule: the audit row is written for EVERY attempt that
 * reaches Meta (success or failure), but the contact timestamp is
 * stamped only on success — a failed fire must leave the contact
 * exactly as it was so the operator can retry.
 */

import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'
import {
  hashPhoneForCapi,
  sendCapiEvent,
  type CapiEventName,
} from './meta-capi'

export type FireCapiErrorCode =
  | 'contact_not_found'
  | 'no_ctwa_clid'
  | 'no_capi_credentials'
  | 'already_fired'
  | 'meta_error'
  | 'internal'

const STATUS_BY_CODE: Record<FireCapiErrorCode, number> = {
  contact_not_found: 404,
  no_ctwa_clid: 422,
  no_capi_credentials: 422,
  already_fired: 409,
  meta_error: 502,
  internal: 500,
}

export class FireCapiError extends Error {
  readonly code: FireCapiErrorCode
  readonly status: number

  constructor(code: FireCapiErrorCode, message: string) {
    super(message)
    this.name = 'FireCapiError'
    this.code = code
    this.status = STATUS_BY_CODE[code]
  }
}

export interface FireCapiOptions {
  /** Service-role client — capi_events has no client INSERT policy. */
  supabase: SupabaseClient
  accountId: string
  contactId: string
  kind: 'qualify' | 'convert'
  eventName: CapiEventName
  value?: number
  currency?: string
  refire: boolean
  firedBy: string | null
}

export interface FireCapiResult {
  eventId: string
  eventName: CapiEventName
  firedAt: string
}

export async function fireCapiEvent(
  options: FireCapiOptions
): Promise<FireCapiResult> {
  const { supabase, accountId, contactId, kind } = options

  const { data: contact, error: contactError } = await supabase
    .from('contacts')
    .select('id, phone, ctwa_clid, qualified_at, converted_at')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (contactError) {
    console.error('[capi] contact read failed:', contactError)
    throw new FireCapiError('internal', 'Failed to load contact')
  }
  if (!contact) {
    throw new FireCapiError('contact_not_found', 'Contact not found')
  }
  if (!contact.ctwa_clid) {
    throw new FireCapiError(
      'no_ctwa_clid',
      'This contact has no captured click id (ctwa_clid); CAPI events are blocked for them'
    )
  }

  const timestampColumn = kind === 'qualify' ? 'qualified_at' : 'converted_at'
  if (contact[timestampColumn] && !options.refire) {
    throw new FireCapiError(
      'already_fired',
      `Contact is already marked ${kind === 'qualify' ? 'qualified' : 'converted'}; pass refire to send again`
    )
  }

  const { data: config, error: configError } = await supabase
    .from('whatsapp_config')
    .select('capi_dataset_id, capi_access_token, capi_test_event_code')
    .eq('account_id', accountId)
    .maybeSingle()

  if (configError) {
    console.error('[capi] config read failed:', configError)
    throw new FireCapiError('internal', 'Failed to load CAPI configuration')
  }
  if (!config?.capi_dataset_id || !config?.capi_access_token) {
    throw new FireCapiError(
      'no_capi_credentials',
      'CAPI credentials are not configured for this account'
    )
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.capi_access_token)
  } catch (err) {
    // Rotated/mismatched ENCRYPTION_KEY. Same remedy as missing creds
    // (re-save them in settings), but log the real cause distinctly.
    console.error('[capi] access token decryption failed:', err)
    throw new FireCapiError(
      'no_capi_credentials',
      'Stored CAPI access token cannot be decrypted — re-save it in settings'
    )
  }

  const eventId = randomUUID()
  const firedAt = new Date().toISOString()

  const audit = {
    account_id: accountId,
    contact_id: contactId,
    event_name: options.eventName,
    event_id: eventId,
    value: options.value ?? null,
    currency: options.value !== undefined ? (options.currency ?? 'INR') : null,
    fired_by: options.firedBy,
  }

  try {
    await sendCapiEvent({
      datasetId: config.capi_dataset_id,
      accessToken,
      eventName: options.eventName,
      eventId,
      ctwaClid: contact.ctwa_clid,
      hashedPhone: hashPhoneForCapi(contact.phone),
      eventTime: Math.floor(Date.parse(firedAt) / 1000),
      value: options.value,
      currency: options.value !== undefined ? (options.currency ?? 'INR') : undefined,
      testEventCode: config.capi_test_event_code,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta CAPI error'
    const { error: auditError } = await supabase
      .from('capi_events')
      .insert({ ...audit, status: 'failed', error: message })
    if (auditError) {
      console.error('[capi] failed-attempt audit insert failed:', auditError)
    }
    throw new FireCapiError('meta_error', message)
  }

  const { error: auditError } = await supabase
    .from('capi_events')
    .insert({ ...audit, status: 'success', error: null })
  if (auditError) {
    // The event DID reach Meta — surface loudly but don't pretend it failed.
    console.error('[capi] success audit insert failed:', auditError)
  }

  const { error: stampError } = await supabase
    .from('contacts')
    .update({ [timestampColumn]: firedAt })
    .eq('id', contactId)
    .eq('account_id', accountId)
  if (stampError) {
    console.error('[capi] contact timestamp update failed:', stampError)
    throw new FireCapiError(
      'internal',
      'Event was sent to Meta but recording it on the contact failed'
    )
  }

  return { eventId, eventName: options.eventName, firedAt }
}
