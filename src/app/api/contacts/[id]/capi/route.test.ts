import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  fireCapiEvent: vi.fn(),
  supabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/capi/fire-event', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/capi/fire-event')>();
  return { ...actual, fireCapiEvent: mocks.fireCapiEvent };
});

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

import { FireCapiError } from '@/lib/capi/fire-event';
import { POST } from './route';

const context = {
  supabase: { name: 'rls-client' },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'agent',
  account: { id: 'account-1', name: 'Acme' },
};

const adminClient = { name: 'service-client' };

function request(body: unknown) {
  return new Request('http://localhost/api/contacts/contact-1/capi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: 'contact-1' }) };

beforeEach(() => {
  mocks.requireRole.mockReset().mockResolvedValue(context);
  mocks.supabaseAdmin.mockReset().mockReturnValue(adminClient);
  mocks.fireCapiEvent.mockReset().mockResolvedValue({
    eventId: 'event-1',
    eventName: 'Lead',
    firedAt: '2026-08-18T10:00:00.000Z',
  });
});

describe('POST /api/contacts/[id]/capi', () => {
  it('requires at least the agent role', async () => {
    await POST(request({ kind: 'qualify' }), params);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
  });

  it('fires a qualify attributed to the session user via the service client', async () => {
    const res = await POST(request({ kind: 'qualify' }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      event_id: 'event-1',
      event_name: 'Lead',
      fired_at: '2026-08-18T10:00:00.000Z',
    });
    expect(mocks.fireCapiEvent).toHaveBeenCalledWith({
      supabase: adminClient,
      accountId: 'account-1',
      contactId: 'contact-1',
      kind: 'qualify',
      eventName: 'Lead',
      value: undefined,
      currency: undefined,
      refire: false,
      firedBy: 'user-1',
    });
  });

  it('fires a convert with validated fields', async () => {
    await POST(
      request({ kind: 'convert', event_name: 'Schedule', value: 250, currency: 'usd', refire: true }),
      params
    );
    expect(mocks.fireCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'convert',
        eventName: 'Schedule',
        value: 250,
        currency: 'USD',
        refire: true,
      })
    );
  });

  it('rejects a missing or unknown kind', async () => {
    expect((await POST(request({}), params)).status).toBe(400);
    expect((await POST(request({ kind: 'promote' }), params)).status).toBe(400);
    expect(mocks.fireCapiEvent).not.toHaveBeenCalled();
  });

  it('rejects event_name on a qualify', async () => {
    const res = await POST(
      request({ kind: 'qualify', event_name: 'Purchase' }),
      params
    );
    expect(res.status).toBe(400);
  });

  it('rejects a negative value on a convert', async () => {
    const res = await POST(
      request({ kind: 'convert', value: -5 }),
      params
    );
    expect(res.status).toBe(400);
    expect(mocks.fireCapiEvent).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric value on a convert', async () => {
    const res = await POST(
      request({ kind: 'convert', value: 'x' }),
      params
    );
    expect(res.status).toBe(400);
    expect(mocks.fireCapiEvent).not.toHaveBeenCalled();
  });

  it('rejects a malformed currency on a convert', async () => {
    const res = await POST(
      request({ kind: 'convert', currency: 'RUPEES' }),
      params
    );
    expect(res.status).toBe(400);
    expect(mocks.fireCapiEvent).not.toHaveBeenCalled();
  });

  it('passes refire through to fireCapiEvent on a qualify', async () => {
    await POST(request({ kind: 'qualify', refire: true }), params);
    expect(mocks.fireCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'qualify', refire: true })
    );
  });

  it('maps FireCapiError to { error, code } with its status', async () => {
    mocks.fireCapiEvent.mockRejectedValue(
      new FireCapiError('no_capi_credentials', 'not configured')
    );
    const res = await POST(request({ kind: 'qualify' }), params);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'not configured',
      code: 'no_capi_credentials',
    });
  });
});
