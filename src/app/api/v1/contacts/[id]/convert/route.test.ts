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
  scopes: ['contacts:convert'],
  createdBy: null,
};

function request(body: unknown) {
  return new Request('http://localhost/api/v1/contacts/contact-1/convert', {
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
    eventName: 'Purchase',
    firedAt: '2026-08-18T10:00:00.000Z',
  });
});

describe('POST /api/v1/contacts/{id}/convert', () => {
  it('requires the contacts:convert scope', async () => {
    await POST(request({}), params);
    expect(mocks.requireApiKey).toHaveBeenCalledWith(
      expect.anything(),
      'contacts:convert'
    );
  });

  it('defaults to Purchase with no body fields', async () => {
    const res = await POST(request({}), params);
    expect(res.status).toBe(200);
    expect(mocks.fireCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'convert', eventName: 'Purchase' })
    );
  });

  it('accepts Schedule with value and currency', async () => {
    await POST(request({ event_name: 'Schedule', value: 1500, currency: 'inr' }), params);
    expect(mocks.fireCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'Schedule',
        value: 1500,
        currency: 'INR', // uppercased
      })
    );
  });

  it('rejects an unknown event_name', async () => {
    const res = await POST(request({ event_name: 'Lead' }), params);
    expect(res.status).toBe(400);
    expect(mocks.fireCapiEvent).not.toHaveBeenCalled();
  });

  it('rejects a negative or non-finite value', async () => {
    expect((await POST(request({ value: -1 }), params)).status).toBe(400);
    expect((await POST(request({ value: 'x' }), params)).status).toBe(400);
    expect(mocks.fireCapiEvent).not.toHaveBeenCalled();
  });

  it('rejects a malformed currency', async () => {
    const res = await POST(request({ value: 10, currency: 'RUPEES' }), params);
    expect(res.status).toBe(400);
  });

  it('passes refire through to fireCapiEvent', async () => {
    await POST(request({ refire: true }), params);
    expect(mocks.fireCapiEvent).toHaveBeenCalledWith(
      expect.objectContaining({ refire: true })
    );
  });

  it('maps FireCapiError onto the envelope', async () => {
    mocks.fireCapiEvent.mockRejectedValue(
      new FireCapiError('no_ctwa_clid', 'no clid')
    );
    const res = await POST(request({}), params);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('no_ctwa_clid');
  });
});
