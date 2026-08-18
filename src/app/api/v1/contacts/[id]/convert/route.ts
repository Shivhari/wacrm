// ============================================================
// POST /api/v1/contacts/{id}/convert — fire a Meta CAPI conversion
// (scope: contacts:convert)
//
// Body: {
//   event_name?: 'Purchase' | 'Schedule'   // default Purchase
//   value?: number                          // optional, finite, >= 0
//   currency?: string                       // 3-letter code, default INR when value present
//   refire?: boolean
// }
// Same guard semantics as /qualify. Lead is NOT valid here — that's
// the qualify tier.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { FireCapiError, fireCapiEvent } from '@/lib/capi/fire-event';

const CONVERT_EVENT_NAMES = ['Purchase', 'Schedule'] as const;
type ConvertEventName = (typeof CONVERT_EVENT_NAMES)[number];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:convert');
    const { id } = await params;

    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    let eventName: ConvertEventName = 'Purchase';
    if (body.event_name !== undefined) {
      if (
        typeof body.event_name !== 'string' ||
        !(CONVERT_EVENT_NAMES as readonly string[]).includes(body.event_name)
      ) {
        return fail(
          'bad_request',
          "'event_name' must be 'Purchase' or 'Schedule'",
          400
        );
      }
      eventName = body.event_name as ConvertEventName;
    }

    let value: number | undefined;
    if (body.value !== undefined) {
      if (typeof body.value !== 'number' || !Number.isFinite(body.value) || body.value < 0) {
        return fail('bad_request', "'value' must be a non-negative number", 400);
      }
      value = body.value;
    }

    let currency: string | undefined;
    if (body.currency !== undefined) {
      if (
        typeof body.currency !== 'string' ||
        !/^[A-Za-z]{3}$/.test(body.currency)
      ) {
        return fail(
          'bad_request',
          "'currency' must be a 3-letter ISO code (e.g. INR)",
          400
        );
      }
      currency = body.currency.toUpperCase();
    }

    const firedBy = await resolveAuditUserId(ctx.supabase, ctx.accountId).catch(
      () => null
    );

    const result = await fireCapiEvent({
      supabase: ctx.supabase,
      accountId: ctx.accountId,
      contactId: id,
      kind: 'convert',
      eventName,
      value,
      currency,
      refire: body?.refire === true,
      firedBy,
    });

    return ok({
      event_id: result.eventId,
      event_name: result.eventName,
      fired_at: result.firedAt,
    });
  } catch (err) {
    if (err instanceof FireCapiError) {
      return fail(err.code, err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
