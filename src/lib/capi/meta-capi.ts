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
  /** From hashPhoneForCapi(). */
  hashedPhone: string
  /** Unix seconds. */
  eventTime: number
  value?: number
  currency?: string
  testEventCode?: string | null
}

interface MetaErrorResponse {
  error?: { message?: string; code?: number; type?: string }
}

/** SHA-256 hex over the digits-only phone (Meta's `ph` normalization). */
export function hashPhoneForCapi(phone: string): string {
  return createHash('sha256').update(normalizePhone(phone)).digest('hex')
}

export async function sendCapiEvent(options: SendCapiEventOptions): Promise<void> {
  const event: Record<string, unknown> = {
    event_name: options.eventName,
    event_time: options.eventTime,
    event_id: options.eventId,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: {
      ctwa_clid: options.ctwaClid,
      ph: [options.hashedPhone],
    },
  }
  if (options.value !== undefined) {
    event.custom_data = { value: options.value, currency: options.currency }
  }

  const body: Record<string, unknown> = { data: [event] }
  if (options.testEventCode) {
    body.test_event_code = options.testEventCode
  }

  const response = await fetch(`${META_API_BASE}/${options.datasetId}/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    let message = `Meta CAPI error: ${response.status}`
    try {
      const data = (await response.json()) as MetaErrorResponse
      if (data.error?.message) message = data.error.message
    } catch {
      // non-JSON body — keep the status fallback
    }
    throw new Error(message)
  }
}
