/**
 * Meta Conversions API (CAPI) client for click-to-WhatsApp events.
 *
 * Same conventions as src/lib/whatsapp/meta-api.ts: single named-options
 * object per exported function, Bearer auth, Meta's error message
 * surfaced verbatim. Kept separate from meta-api.ts because CAPI talks
 * to a dataset (pixel), not a phone number, and uses its own
 * credentials (whatsapp_config.capi_*).
 *
 * Payload shape per Meta's business-messaging spec: CTWA attribution
 * requires action_source 'business_messaging' + messaging_channel
 * 'whatsapp' + user_data.ctwa_clid; ph is the SHA-256 of the
 * E.164-digits phone. Wrong normalization silently breaks matching,
 * so hashing lives here next to the payload it feeds.
 */

import { createHash } from 'crypto'

import { normalizePhone } from '@/lib/whatsapp/phone-utils'

import { logCapiAttempt } from './capi-logger'

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export type CapiEventName = 'Lead' | 'Purchase' | 'Schedule'

export interface SendCapiEventOptions {
  datasetId: string
  /** Already decrypted. */
  accessToken: string
  eventName: CapiEventName
  /** Dedupe key — a fresh uuid per fire attempt. */
  eventId: string
  ctwaClid: string
  /**
   * From hashPhoneForCapi(). Omitted for contacts that have no phone —
   * WhatsApp business-scoped user IDs (migration 040) let a username-only
   * sender exist with `phone = ''`, and a hash of '' would be a bogus
   * match key. ctwa_clid is the primary key for CTWA matching anyway.
   */
  hashedPhone?: string
  /** Unix seconds. */
  eventTime: number
  value?: number
  currency?: string
  testEventCode?: string | null
  /** WhatsApp Business Account id, added to user_data when known. */
  wabaId?: string | null
}

/** Identifies this integration to Meta on every CAPI request. */
const PARTNER_AGENT = 'wacrm'

interface MetaErrorResponse {
  error?: { message?: string; code?: number; type?: string }
}

/**
 * SHA-256 hex over the digits-only phone (Meta's `ph` normalization), or
 * undefined when there are no digits to hash.
 */
export function hashPhoneForCapi(phone: string | null | undefined): string | undefined {
  const digits = normalizePhone(phone ?? '')
  if (!digits) return undefined
  return createHash('sha256').update(digits).digest('hex')
}

export async function sendCapiEvent(options: SendCapiEventOptions): Promise<void> {
  const userData: Record<string, unknown> = {
    ctwa_clid: options.ctwaClid,
  }
  if (options.hashedPhone) {
    userData.ph = [options.hashedPhone]
  }
  if (options.wabaId) {
    userData.whatsapp_business_account_id = options.wabaId
  }

  const event: Record<string, unknown> = {
    event_name: options.eventName,
    event_time: options.eventTime,
    event_id: options.eventId,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: userData,
  }
  if (options.value !== undefined) {
    event.custom_data = { value: options.value, currency: options.currency }
  }

  const body: Record<string, unknown> = {
    data: [event],
    partner_agent: PARTNER_AGENT,
  }
  if (options.testEventCode) {
    body.test_event_code = options.testEventCode
  }

  const url = `${META_API_BASE}/${options.datasetId}/events`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error'
    logCapiAttempt({
      datasetId: options.datasetId,
      url,
      body,
      outcome: 'failed',
      error: message,
    })
    throw err
  }

  // Parse once for both paths. A 200 body still matters: Meta reports
  // events_received / messages / fbtrace_id, and warnings ride in
  // `messages` even when the HTTP request itself was accepted.
  let responseData: unknown
  try {
    responseData = await response.json()
  } catch {
    // non-JSON body — leave undefined
  }

  if (!response.ok) {
    let message = `Meta CAPI error: ${response.status}`
    const metaError = (responseData as MetaErrorResponse | undefined)?.error
    if (metaError?.message) message = metaError.message
    logCapiAttempt({
      datasetId: options.datasetId,
      url,
      body,
      outcome: 'failed',
      httpStatus: response.status,
      error: message,
      response: responseData,
    })
    throw new Error(message)
  }

  logCapiAttempt({
    datasetId: options.datasetId,
    url,
    body,
    outcome: 'success',
    httpStatus: response.status,
    response: responseData,
  })
}
