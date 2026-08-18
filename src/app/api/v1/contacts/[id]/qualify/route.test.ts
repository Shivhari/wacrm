import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  fireCapiEvent: vi.fn(),
  resolveAuditUserId: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: mocks.requireApiKey,
}));

vi.mock('@/lib/capi/fire-event', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/capi/fire-event')>();
  return { ...actual, fireCapiEvent: mocks.fireCapiEvent };
});

vi.mock('@/lib/api/v1/contacts', () => ({
  resolveAuditUserId: mocks.resolveAuditUserId,
}));

import { FireCapiError } from '@/lib/capi/fire-event';
import { POST } from './route';

const ctx = {
  authType: 'api_key',
  supabase: { name: 'service-client' },
  accountId: 'account-1',
  keyId: 'key-1',
  scopes: ['contacts:qualify'],
  createdBy: null,
};

function request(body: unknown) {
  return new Request('http://localhost/api/v1/contacts/contact-1/qualify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: 'contact-1' }) };

beforeEach(() => {
  mocks.requireApiKey.mockReset().mockResolvedValue(ctx);
  mocks.resolveAuditUserId.mockReset().mockResolvedValue('owner-1');
  mocks.fireCapiEvent.mockReset().mockResolvedValue({
    eventId: 'event-1',
    eventName: 'Lead',
    firedAt: '2026-08-18T10:00:00.000Z',
  });
});

describe('POST /api/v1/contacts/{id}/qualify', () => {
  it('requires the contacts:qualify scope', async () => {
    await POST(request({}), params);
    expect(mocks.requireApiKey).toHaveBeenCalledWith(
      expect.anything(),
      'contacts:qualify'
    );
  });

  it('fires a Lead and returns the envelope', async () => {
    const res = await POST(request({}), params);
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.data).toEqual({
      event_id: 'event-1',
      event_name: 'Lead',
      fired_at: '2026-08-18T10:00:00.000Z',
    });
    expect(mocks.fireCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'account-1',
        contactId: 'contact-1',
        kind: 'qualify',
        eventName: 'Lead',
        refire: false,
        firedBy: 'owner-1',
      })
    );
  });

  it('passes refire through', async () => {
    await POST(request({ refire: true }), params);
    expect(mocks.fireCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({ refire: true })
    );
  });

  it('maps FireCapiError code and status onto the envelope', async () => {
    mocks.fireCapiEvent.mockRejectedValue(
      new FireCapiError('already_fired', 'already qualified')
    );
    const res = await POST(request({}), params);
    expect(res.status).toBe(409);
    const payload = await res.json();
    expect(payload.error.code).toBe('already_fired');
  });

  it('nulls fired_by when the audit user cannot be resolved', async () => {
    mocks.resolveAuditUserId.mockRejectedValue(new Error('no owner'));
    const res = await POST(request({}), params);
    expect(res.status).toBe(200);
    expect(mocks.fireCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({ firedBy: null })
    );
  });
});
