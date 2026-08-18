// ============================================================
// POST /api/v1/contacts/{id}/qualify — fire a Meta CAPI Lead event
// (scope: contacts:qualify)
//
// Body: { refire?: boolean }. Same rules as the dashboard button:
// blocked without ctwa_clid (422) or CAPI credentials (422); a repeat
// without refire is 409; Meta rejection is 502 with Meta's message.
// Account-scoped: another account's contact is 404, never 403.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { FireCapiError, fireCapiEvent } from '@/lib/capi/fire-event';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:qualify');
    const { id } = await params;

    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    // Attribute the fire to the account's audit user (the WhatsApp
    // config owner — same convention as every other public-API write);
    // fall back to null rather than failing the fire over attribution.
    const firedBy = await resolveAuditUserId(ctx.supabase, ctx.accountId).catch(
      () => null
    );

    const result = await fireCapiEvent({
      supabase: ctx.supabase,
      accountId: ctx.accountId,
      contactId: id,
      kind: 'qualify',
      eventName: 'Lead',
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
