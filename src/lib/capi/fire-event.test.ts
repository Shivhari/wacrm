import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendCapiEvent: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock('./meta-capi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./meta-capi')>();
  return { ...actual, sendCapiEvent: mocks.sendCapiEvent };
});

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: mocks.decrypt,
}));

import { FireCapiError, fireCapiEvent } from './fire-event';

const CONTACT = {
  id: 'contact-1',
  phone: '37063949836',
  ctwa_clid: 'clid-1',
  qualified_at: null as string | null,
  converted_at: null as string | null,
};

const CONFIG = {
  capi_dataset_id: 'ds-1',
  capi_access_token: 'enc:token',
  capi_test_event_code: null as string | null,
  waba_id: 'waba-1' as string | null,
};

/**
 * Chainable Supabase stub. Reads resolve from `state`; writes are
 * recorded into `state.inserted` / `state.updated`.
 */
function makeSupabase(state: {
  contact: typeof CONTACT | null;
  config: typeof CONFIG | null;
  inserted: Record<string, unknown>[];
  updated: Record<string, unknown>[];
  insertError?: { message: string } | null;
  contactReadError?: { message: string } | null;
  configReadError?: { message: string } | null;
  stampError?: { message: string } | null;
}) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.maybeSingle = async () => {
        if (table === 'contacts') {
          return { data: state.contactReadError ? null : state.contact, error: state.contactReadError ?? null };
        }
        if (table === 'whatsapp_config') {
          return { data: state.configReadError ? null : state.config, error: state.configReadError ?? null };
        }
        return { data: null, error: null };
      };
      chain.insert = (row: Record<string, unknown>) => {
        state.inserted.push({ table, ...row });
        return Promise.resolve({ error: state.insertError ?? null });
      };
      chain.update = (row: Record<string, unknown>) => {
        state.updated.push({ table, ...row });
        return {
          eq: () => ({
            eq: () => Promise.resolve({ error: state.stampError ?? null }),
          }),
        };
      };
      return chain;
    },
  } as never;
}

function baseState() {
  return {
    contact: { ...CONTACT } as typeof CONTACT | null,
    config: { ...CONFIG },
    inserted: [] as Record<string, unknown>[],
    updated: [] as Record<string, unknown>[],
  };
}

function baseOptions(supabase: never) {
  return {
    supabase,
    accountId: 'account-1',
    contactId: 'contact-1',
    kind: 'qualify' as const,
    eventName: 'Lead' as const,
    refire: false,
    firedBy: 'user-1',
  };
}

async function expectFireError(promise: Promise<unknown>, code: string, status: number) {
  const err = await promise.then(
    () => null,
    (e) => e
  );
  expect(err).toBeInstanceOf(FireCapiError);
  expect((err as FireCapiError).code).toBe(code);
  expect((err as FireCapiError).status).toBe(status);
}

beforeEach(() => {
  mocks.sendCapiEvent.mockReset().mockResolvedValue(undefined);
  mocks.decrypt.mockReset().mockReturnValue('decrypted-token');
});

describe('fireCapiEvent guards', () => {
  it('404s when the contact is not in the account', async () => {
    const state = baseState();
    state.contact = null;
    await expectFireError(
      fireCapiEvent(baseOptions(makeSupabase(state))),
      'contact_not_found',
      404
    );
    expect(mocks.sendCapiEvent).not.toHaveBeenCalled();
  });

  it('blocks a contact without ctwa_clid', async () => {
    const state = baseState();
    state.contact = { ...CONTACT, ctwa_clid: null as never };
    await expectFireError(
      fireCapiEvent(baseOptions(makeSupabase(state))),
      'no_ctwa_clid',
      422
    );
  });

  it('blocks when the account has no CAPI credentials', async () => {
    const state = baseState();
    state.config = { ...CONFIG, capi_dataset_id: null as never };
    await expectFireError(
      fireCapiEvent(baseOptions(makeSupabase(state))),
      'no_capi_credentials',
      422
    );
  });

  it('treats an undecryptable token as missing credentials', async () => {
    mocks.decrypt.mockImplementation(() => {
      throw new Error('bad key');
    });
    await expectFireError(
      fireCapiEvent(baseOptions(makeSupabase(baseState()))),
      'no_capi_credentials',
      422
    );
  });

  it('409s a repeat qualify without refire', async () => {
    const state = baseState();
    state.contact = { ...CONTACT, qualified_at: '2026-08-01T00:00:00Z' };
    await expectFireError(
      fireCapiEvent(baseOptions(makeSupabase(state))),
      'already_fired',
      409
    );
  });

  it('allows a repeat qualify WITH refire and generates a new event', async () => {
    const state = baseState();
    state.contact = { ...CONTACT, qualified_at: '2026-08-01T00:00:00Z' };
    const result = await fireCapiEvent({
      ...baseOptions(makeSupabase(state)),
      refire: true,
    });
    expect(result.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mocks.sendCapiEvent).toHaveBeenCalledTimes(1);
  });
});

describe('fireCapiEvent DB read failures', () => {
  it('surfaces a contact read failure as an internal error, not contact_not_found', async () => {
    const state = { ...baseState(), contactReadError: { message: 'connection reset' } };
    await expectFireError(
      fireCapiEvent(baseOptions(makeSupabase(state))),
      'internal',
      500
    );
    expect(mocks.sendCapiEvent).not.toHaveBeenCalled();
  });

  it('surfaces a config read failure as an internal error, not no_capi_credentials', async () => {
    const state = { ...baseState(), configReadError: { message: 'connection reset' } };
    await expectFireError(
      fireCapiEvent(baseOptions(makeSupabase(state))),
      'internal',
      500
    );
    expect(mocks.sendCapiEvent).not.toHaveBeenCalled();
  });
});

describe('fireCapiEvent success path', () => {
  it('sends the event, logs success, stamps the contact', async () => {
    const state = baseState();
    state.config = { ...CONFIG, capi_test_event_code: 'TEST9' };
    const result = await fireCapiEvent(baseOptions(makeSupabase(state)));

    const sent = mocks.sendCapiEvent.mock.calls[0][0];
    expect(sent.datasetId).toBe('ds-1');
    expect(sent.accessToken).toBe('decrypted-token');
    expect(sent.eventName).toBe('Lead');
    expect(sent.ctwaClid).toBe('clid-1');
    expect(sent.testEventCode).toBe('TEST9');
    expect(sent.wabaId).toBe('waba-1');
    expect(sent.hashedPhone).toMatch(/^[0-9a-f]{64}$/);

    const audit = state.inserted.find((r) => r.table === 'capi_events');
    expect(audit).toMatchObject({
      account_id: 'account-1',
      contact_id: 'contact-1',
      event_name: 'Lead',
      status: 'success',
      fired_by: 'user-1',
    });
    expect(audit?.event_id).toBe(result.eventId);

    const stamp = state.updated.find((r) => r.table === 'contacts');
    expect(stamp?.qualified_at).toBe(result.firedAt);
  });

  it('records value and currency for a convert', async () => {
    const state = baseState();
    await fireCapiEvent({
      ...baseOptions(makeSupabase(state)),
      kind: 'convert',
      eventName: 'Purchase',
      value: 999.5,
      currency: 'INR',
    });
    const audit = state.inserted.find((r) => r.table === 'capi_events');
    expect(audit).toMatchObject({ event_name: 'Purchase', value: 999.5, currency: 'INR' });
    const stamp = state.updated.find((r) => r.table === 'contacts');
    expect(stamp).toHaveProperty('converted_at');
    expect(stamp).not.toHaveProperty('qualified_at');
  });
});

describe('fireCapiEvent Meta failure', () => {
  it('logs a failed row, leaves the contact untouched, surfaces meta_error', async () => {
    mocks.sendCapiEvent.mockRejectedValue(new Error('Invalid OAuth access token'));
    const state = baseState();
    await expectFireError(
      fireCapiEvent(baseOptions(makeSupabase(state))),
      'meta_error',
      502
    );
    const audit = state.inserted.find((r) => r.table === 'capi_events');
    expect(audit).toMatchObject({
      status: 'failed',
      error: 'Invalid OAuth access token',
    });
    expect(state.updated).toHaveLength(0);
  });
});

describe('fireCapiEvent audit/stamp failure resilience', () => {
  it('still resolves and stamps the contact when the success audit insert fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = { ...baseState(), insertError: { message: 'insert failed' } };
    const result = await fireCapiEvent(baseOptions(makeSupabase(state)));

    expect(result.eventId).toMatch(/^[0-9a-f-]{36}$/);
    const stamp = state.updated.find((r) => r.table === 'contacts');
    expect(stamp?.qualified_at).toBe(result.firedAt);
  });

  it('defaults currency to INR when value is present but currency is omitted', async () => {
    const state = baseState();
    await fireCapiEvent({
      ...baseOptions(makeSupabase(state)),
      kind: 'convert',
      eventName: 'Purchase',
      value: 250,
    });

    const sent = mocks.sendCapiEvent.mock.calls[0][0];
    expect(sent.currency).toBe('INR');

    const audit = state.inserted.find((r) => r.table === 'capi_events');
    expect(audit).toMatchObject({ value: 250, currency: 'INR' });
  });

  it('surfaces internal/500 when the contact stamp update fails after a successful send, but keeps the success audit row', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = { ...baseState(), stampError: { message: 'update failed' } };
    await expectFireError(
      fireCapiEvent(baseOptions(makeSupabase(state))),
      'internal',
      500
    );

    const audit = state.inserted.find((r) => r.table === 'capi_events');
    expect(audit).toMatchObject({ status: 'success' });
  });
});
