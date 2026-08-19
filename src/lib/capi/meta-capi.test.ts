import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logCapiAttempt: vi.fn(),
}));

vi.mock('./capi-logger', () => ({
  logCapiAttempt: mocks.logCapiAttempt,
}));

import { hashPhoneForCapi, sendCapiEvent } from './meta-capi';

function okResponse() {
  return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
}

const BASE_OPTIONS = {
  datasetId: 'ds-123',
  accessToken: 'token-abc',
  eventName: 'Lead' as const,
  eventId: '11111111-2222-3333-4444-555555555555',
  ctwaClid: 'clid-xyz',
  hashedPhone: 'a'.repeat(64),
  eventTime: 1723958400,
};

beforeEach(() => {
  mocks.logCapiAttempt.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hashPhoneForCapi', () => {
  it('hashes the digits-only form, so formatting never changes the hash', () => {
    const plain = hashPhoneForCapi('37063949836');
    expect(plain).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPhoneForCapi('+370 639 49836')).toBe(plain);
  });
});

describe('sendCapiEvent', () => {
  it('POSTs the CTWA payload shape to /{dataset}/events', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await sendCapiEvent(BASE_OPTIONS);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v21.0/ds-123/events');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer token-abc');
    const body = JSON.parse(init.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      event_name: 'Lead',
      event_time: 1723958400,
      event_id: '11111111-2222-3333-4444-555555555555',
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { ctwa_clid: 'clid-xyz', ph: ['a'.repeat(64)] },
    });
    // no value given → no custom_data key at all
    expect(body.data[0]).not.toHaveProperty('custom_data');
    // no test code configured → key absent, not null
    expect(body).not.toHaveProperty('test_event_code');
    // no wabaId given → key absent from user_data
    expect(body.data[0].user_data).not.toHaveProperty('whatsapp_business_account_id');
    // integration identifier always present at the root
    expect(body.partner_agent).toBe('wacrm');
  });

  it('includes whatsapp_business_account_id in user_data when wabaId is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await sendCapiEvent({ ...BASE_OPTIONS, wabaId: 'waba-77' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.data[0].user_data.whatsapp_business_account_id).toBe('waba-77');
  });

  it('includes custom_data and test_event_code when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await sendCapiEvent({
      ...BASE_OPTIONS,
      eventName: 'Purchase',
      value: 1500,
      currency: 'INR',
      testEventCode: 'TEST123',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.data[0].custom_data).toEqual({ value: 1500, currency: 'INR' });
    expect(body.test_event_code).toBe('TEST123');
  });

  it('throws with Meta error message on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'Invalid OAuth access token', code: 190 } }),
          { status: 401 }
        )
      )
    );

    await expect(sendCapiEvent(BASE_OPTIONS)).rejects.toThrow(
      'Invalid OAuth access token'
    );
  });

  it('falls back to a status message when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('gateway timeout', { status: 504 }))
    );

    await expect(sendCapiEvent(BASE_OPTIONS)).rejects.toThrow('Meta CAPI error: 504');
  });

  it('logs the exact payload with a success outcome, never the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            events_received: 1,
            messages: ['Warning: event_time older than 7 days'],
            fbtrace_id: 'trace-1',
          }),
          { status: 200 }
        )
      )
    );

    await sendCapiEvent({ ...BASE_OPTIONS, testEventCode: 'TEST123' });

    expect(mocks.logCapiAttempt).toHaveBeenCalledTimes(1);
    const entry = mocks.logCapiAttempt.mock.calls[0][0];
    expect(entry.datasetId).toBe('ds-123');
    expect(entry.url).toBe('https://graph.facebook.com/v21.0/ds-123/events');
    expect(entry.outcome).toBe('success');
    expect(entry.httpStatus).toBe(200);
    expect(entry.body.data[0].event_id).toBe(BASE_OPTIONS.eventId);
    expect(entry.body.test_event_code).toBe('TEST123');
    // full Meta response captured — a 200 can still carry warnings
    expect(entry.response).toEqual({
      events_received: 1,
      messages: ['Warning: event_time older than 7 days'],
      fbtrace_id: 'trace-1',
    });
    expect(JSON.stringify(entry)).not.toContain('token-abc');
  });

  it('logs the payload with a failed outcome and Meta error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'Invalid OAuth access token', code: 190 } }),
          { status: 401 }
        )
      )
    );

    await expect(sendCapiEvent(BASE_OPTIONS)).rejects.toThrow();

    const entry = mocks.logCapiAttempt.mock.calls[0][0];
    expect(entry.outcome).toBe('failed');
    expect(entry.httpStatus).toBe(401);
    expect(entry.error).toBe('Invalid OAuth access token');
    expect(entry.body.data[0].user_data.ctwa_clid).toBe('clid-xyz');
    // Meta error body captured too (carries fbtrace_id for support)
    expect(entry.response).toEqual({
      error: { message: 'Invalid OAuth access token', code: 190 },
    });
  });

  it('logs a failed outcome when fetch itself rejects (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));

    await expect(sendCapiEvent(BASE_OPTIONS)).rejects.toThrow('ECONNRESET');

    const entry = mocks.logCapiAttempt.mock.calls[0][0];
    expect(entry.outcome).toBe('failed');
    expect(entry.httpStatus).toBeUndefined();
    expect(entry.error).toBe('ECONNRESET');
  });
});
