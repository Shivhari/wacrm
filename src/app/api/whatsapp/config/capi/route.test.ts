import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  encrypt: vi.fn(),
  supabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: mocks.encrypt,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

import { GET, PUT } from './route';

const context = {
  supabase: {},
  accountId: 'account-1',
  userId: 'user-1',
  role: 'admin',
  account: { id: 'account-1', name: 'Acme' },
};

/** Admin-client stub: reads resolve `state.config`; updates recorded. */
function makeAdmin(state: {
  config: Record<string, unknown> | null;
  updated: Record<string, unknown>[];
}) {
  return {
    from() {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.maybeSingle = async () => ({ data: state.config, error: null });
      chain.update = (row: Record<string, unknown>) => {
        state.updated.push(row);
        return { eq: () => Promise.resolve({ error: null }) };
      };
      return chain;
    },
  };
}

function putRequest(body: unknown) {
  return new Request('http://localhost/api/whatsapp/config/capi', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.getCurrentAccount.mockReset().mockResolvedValue(context);
  mocks.requireRole.mockReset().mockResolvedValue(context);
  mocks.encrypt.mockReset().mockImplementation((v: string) => `enc(${v})`);
  mocks.supabaseAdmin.mockReset();
});

describe('GET /api/whatsapp/config/capi', () => {
  it('returns the non-secret fields and a token flag — never the token', async () => {
    const state = {
      config: {
        capi_dataset_id: 'ds-1',
        capi_access_token: 'iv:ct:tag',
        capi_test_event_code: 'TEST9',
      },
      updated: [],
    };
    mocks.supabaseAdmin.mockReturnValue(makeAdmin(state));

    const res = await GET();
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toEqual({
      dataset_id: 'ds-1',
      test_event_code: 'TEST9',
      access_token_set: true,
      whatsapp_configured: true,
    });
    expect(JSON.stringify(payload)).not.toContain('iv:ct:tag');
  });

  it('reports an unconfigured state when there is no whatsapp_config row', async () => {
    mocks.supabaseAdmin.mockReturnValue(makeAdmin({ config: null, updated: [] }));
    const res = await GET();
    const payload = await res.json();
    expect(payload).toEqual({
      dataset_id: null,
      test_event_code: null,
      access_token_set: false,
      whatsapp_configured: false,
    });
  });
});

describe('PUT /api/whatsapp/config/capi', () => {
  it('requires admin', async () => {
    const state = { config: { id: 'cfg-1' }, updated: [] };
    mocks.supabaseAdmin.mockReturnValue(makeAdmin(state));
    await PUT(putRequest({ dataset_id: 'ds-1', access_token: 't' }));
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it('encrypts the token and saves all three fields', async () => {
    const state = { config: { id: 'cfg-1' }, updated: [] as Record<string, unknown>[] };
    mocks.supabaseAdmin.mockReturnValue(makeAdmin(state));

    const res = await PUT(
      putRequest({ dataset_id: 'ds-1', access_token: 'secret', test_event_code: 'TEST9' })
    );
    expect(res.status).toBe(200);
    expect(state.updated[0]).toMatchObject({
      capi_dataset_id: 'ds-1',
      capi_access_token: 'enc(secret)',
      capi_test_event_code: 'TEST9',
    });
  });

  it('keeps the stored token when access_token is omitted or empty', async () => {
    const state = { config: { id: 'cfg-1' }, updated: [] as Record<string, unknown>[] };
    mocks.supabaseAdmin.mockReturnValue(makeAdmin(state));

    await PUT(putRequest({ dataset_id: 'ds-2', access_token: '' }));
    expect(state.updated[0]).not.toHaveProperty('capi_access_token');
    expect(state.updated[0]).toMatchObject({ capi_dataset_id: 'ds-2' });
  });

  it('clears credentials when dataset_id and access_token are null', async () => {
    const state = { config: { id: 'cfg-1' }, updated: [] as Record<string, unknown>[] };
    mocks.supabaseAdmin.mockReturnValue(makeAdmin(state));

    await PUT(putRequest({ dataset_id: null, access_token: null, test_event_code: null }));
    expect(state.updated[0]).toMatchObject({
      capi_dataset_id: null,
      capi_access_token: null,
      capi_test_event_code: null,
    });
  });

  it('409s when WhatsApp is not configured yet', async () => {
    mocks.supabaseAdmin.mockReturnValue(makeAdmin({ config: null, updated: [] }));
    const res = await PUT(putRequest({ dataset_id: 'ds-1', access_token: 't' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('whatsapp_not_configured');
  });
});
