// ============================================================
// POST /api/contacts/[id]/capi — dashboard trigger for CAPI fires
// ("Mark qualified" / "Mark converted" buttons).
//
// Session auth, min role: agent — operators judge contact quality;
// viewers are read-only. Body:
//   { kind: 'qualify' }                                     → Lead
//   { kind: 'convert', event_name?, value?, currency? }     → Purchase|Schedule
//   plus refire?: boolean on either.
//
// Uses the service-role client for the fire itself: capi_events has
// no client INSERT policy (writes are server-only by design), and the
// same fireCapiEvent core also serves the public v1 routes. Tenancy
// is enforced by passing ctx.accountId into every query the core runs.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { FireCapiError, fireCapiEvent } from '@/lib/capi/fire-event';
import type { CapiEventName } from '@/lib/capi/meta-capi';

const CONVERT_EVENT_NAMES = ['Purchase', 'Schedule'] as const;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    const kind = body.kind;
    if (kind !== 'qualify' && kind !== 'convert') {
      return NextResponse.json(
        { error: "'kind' must be 'qualify' or 'convert'" },
        { status: 400 }
      );
    }

    let eventName: CapiEventName = 'Lead';
    let value: number | undefined;
    let currency: string | undefined;

    if (kind === 'qualify') {
      if (body.event_name !== undefined) {
        return NextResponse.json(
          { error: "'event_name' is not valid for qualify — it always fires Lead" },
          { status: 400 }
        );
      }
    } else {
      eventName = 'Purchase';
      if (body.event_name !== undefined) {
        if (
          typeof body.event_name !== 'string' ||
          !(CONVERT_EVENT_NAMES as readonly string[]).includes(body.event_name)
        ) {
          return NextResponse.json(
            { error: "'event_name' must be 'Purchase' or 'Schedule'" },
            { status: 400 }
          );
        }
        eventName = body.event_name as CapiEventName;
      }
      if (body.value !== undefined) {
        if (
          typeof body.value !== 'number' ||
          !Number.isFinite(body.value) ||
          body.value < 0
        ) {
          return NextResponse.json(
            { error: "'value' must be a non-negative number" },
            { status: 400 }
          );
        }
        value = body.value;
      }
      if (body.currency !== undefined) {
        if (
          typeof body.currency !== 'string' ||
          !/^[A-Za-z]{3}$/.test(body.currency)
        ) {
          return NextResponse.json(
            { error: "'currency' must be a 3-letter ISO code (e.g. INR)" },
            { status: 400 }
          );
        }
        currency = body.currency.toUpperCase();
      }
    }

    const result = await fireCapiEvent({
      supabase: supabaseAdmin(),
      accountId: ctx.accountId,
      contactId: id,
      kind,
      eventName,
      value,
      currency,
      refire: body?.refire === true,
      firedBy: ctx.userId,
    });

    return NextResponse.json({
      event_id: result.eventId,
      event_name: result.eventName,
      fired_at: result.firedAt,
    });
  } catch (err) {
    if (err instanceof FireCapiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    console.error('[contacts/capi] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
