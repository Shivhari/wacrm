// ============================================================
// GET/PUT /api/whatsapp/config/capi — per-account Meta CAPI creds.
//
// Lives on the whatsapp_config row (one per account) next to the
// WhatsApp token, but with its own verbs: the parent config route's
// GET is a Meta connection test and its POST demands the WhatsApp
// token on every save — coupling CAPI fields to those would force
// admins to re-enter WhatsApp credentials to change a pixel id.
//
// GET  — any member. Powers both the settings form and the inbox
//        buttons' disabled state. Returns access_token_set, never
//        the token (write-only to the client, like the parent).
// PUT  — admin+. Empty/omitted access_token keeps the stored one;
//        explicit nulls clear. 409 until WhatsApp itself is
//        configured — CAPI events are meaningless without the
//        webhook that captures ctwa_clid.
//
// Uses the service-role client so RLS policy differences on
// whatsapp_config can't shadow-break the write; tenancy is the
// .eq('account_id') filter, same as the fire pipeline.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';

export async function GET() {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  const { data: config, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('capi_dataset_id, capi_access_token, capi_test_event_code')
    .eq('account_id', ctx.accountId)
    .maybeSingle();

  if (error) {
    console.error('[config/capi GET] fetch failed:', error);
    return NextResponse.json({ error: 'Failed to load CAPI settings' }, { status: 500 });
  }

  return NextResponse.json({
    dataset_id: config?.capi_dataset_id ?? null,
    test_event_code: config?.capi_test_event_code ?? null,
    access_token_set: Boolean(config?.capi_access_token),
    whatsapp_configured: config != null,
  });
}

export async function PUT(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  try {
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Request body must be a JSON object' },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();
    const { data: config, error: readError } = await admin
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (readError) {
      console.error('[config/capi PUT] fetch failed:', readError);
      return NextResponse.json({ error: 'Failed to load CAPI settings' }, { status: 500 });
    }
    if (!config) {
      return NextResponse.json(
        {
          error: 'Connect WhatsApp first — CAPI events need the inbound webhook that captures click ids.',
          code: 'whatsapp_not_configured',
        },
        { status: 409 }
      );
    }

    const updates: Record<string, unknown> = {};

    if ('dataset_id' in body) {
      if (body.dataset_id !== null && typeof body.dataset_id !== 'string') {
        return NextResponse.json(
          { error: "'dataset_id' must be a string or null" },
          { status: 400 }
        );
      }
      updates.capi_dataset_id =
        typeof body.dataset_id === 'string' && body.dataset_id.trim() !== ''
          ? body.dataset_id.trim()
          : null;
    }

    if ('access_token' in body) {
      if (body.access_token === null) {
        updates.capi_access_token = null;
      } else if (typeof body.access_token === 'string') {
        // Empty string = "unchanged" (the form's password field is
        // blank after save; submitting it untouched must not wipe
        // the stored token).
        if (body.access_token.trim() !== '') {
          updates.capi_access_token = encrypt(body.access_token.trim());
        }
      } else {
        return NextResponse.json(
          { error: "'access_token' must be a string or null" },
          { status: 400 }
        );
      }
    }

    if ('test_event_code' in body) {
      if (body.test_event_code !== null && typeof body.test_event_code !== 'string') {
        return NextResponse.json(
          { error: "'test_event_code' must be a string or null" },
          { status: 400 }
        );
      }
      updates.capi_test_event_code =
        typeof body.test_event_code === 'string' && body.test_event_code.trim() !== ''
          ? body.test_event_code.trim()
          : null;
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { error: updateError } = await admin
        .from('whatsapp_config')
        .update(updates)
        .eq('account_id', ctx.accountId);
      if (updateError) {
        console.error('[config/capi PUT] update failed:', updateError);
        return NextResponse.json(
          { error: 'Failed to save CAPI settings' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[config/capi PUT] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
