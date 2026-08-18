# Meta CAPI Conversion Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Silent `ctwa_clid` capture from inbound WhatsApp messages plus human-triggered Meta Conversions API events ("Mark qualified" → Lead, "Mark converted" → Purchase/Schedule) with per-account CAPI credentials and public API endpoints.

**Architecture:** One shared `fireCapiEvent()` core (guards → decrypt → Meta call → audit row + contact timestamp) consumed by both a session-auth dashboard route and two API-key-auth public v1 routes. Credentials live as three new columns on `whatsapp_config` (AES-256-GCM token via the existing `encrypt()`/`decrypt()`). A new `capi_events` table records every fire attempt. The webhook stores `referral.ctwa_clid` on the contact, silently.

**Tech Stack:** Next.js App Router (see `node_modules/next/dist/docs/` before writing code — this repo's Next has breaking changes), Supabase (Postgres + RLS), Vitest (node environment, colocated tests), next-intl, Meta Graph API v21.0.

**Spec:** `docs/superpowers/specs/2026-08-18-capi-events-design.md` (read it first; it carries the PRD decisions).

## Global Constraints

- Graph API version: reuse the existing `v21.0` pin style — CAPI client defines `const META_API_VERSION = 'v21.0'` matching `src/lib/whatsapp/meta-api.ts`.
- Every exported Meta-client function takes a **single named-options object**, never positional args (repo rule, `src/lib/whatsapp/meta-api.ts:1-10`).
- Migration must be idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`), with a `-- ====` rationale header and `COMMENT ON COLUMN` for every new column. Template: `supabase/migrations/039_inbound_media_mirror.sql`.
- Phone hashing: SHA-256 hex over `normalizePhone(phone)` (digits-only incl. country code) from `src/lib/whatsapp/phone-utils.ts`.
- Public v1 responses use the envelope helpers in `src/lib/api/v1/respond.ts` (`ok`, `fail`, `toApiErrorResponse`). Cross-account contact = 404, never 403.
- Dashboard routes use `requireRole()` from `src/lib/auth/account.ts` + `toErrorResponse`.
- The CAPI access token is never returned to the client after save (only a boolean "set" flag).
- Tests: Vitest, colocated `foo.test.ts` next to `foo.ts`. Run a single file with `npx vitest run <path>`; full suite `npm test`.
- Commit after each task. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- i18n: user-facing strings go in `messages/en.json` AND `messages/ko.json` via `next-intl`.

---

### Task 1: Migration 040 + Contact type

**Files:**
- Create: `supabase/migrations/040_capi_events.sql`
- Modify: `src/types/index.ts` (Contact interface, ~line 99)

**Interfaces:**
- Produces: `contacts.ctwa_clid`, `contacts.ctwa_clid_captured_at`, `contacts.qualified_at`, `contacts.converted_at`; `whatsapp_config.capi_dataset_id`, `capi_access_token`, `capi_test_event_code`; table `capi_events` (columns below). Later tasks read/write these exact names.

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- 040_capi_events
--
-- Meta Conversions API (CAPI) conversion events, spec:
-- docs/product/features/capi-events.md. Three pieces:
--
--   1. contacts — ctwa_clid capture target (silently written by the
--      inbound webhook when a message carries referral.ctwa_clid)
--      plus the two human-triggered outcome timestamps. Timestamps
--      are set ONLY on a successful CAPI fire, never on failure.
--
--   2. whatsapp_config — per-account CAPI credentials. dataset id is
--      not secret (plaintext); the access token is AES-256-GCM
--      ciphertext produced by src/lib/whatsapp/encryption.ts, same
--      as access_token on this table. test_event_code, when set,
--      routes every fire into Events Manager test mode.
--
--   3. capi_events — audit log, one row per fire ATTEMPT. Failed
--      attempts are kept (status='failed' + error text) so an
--      operator can see why a fire bounced; contact timestamps are
--      untouched by failures. event_id is the dedupe key sent to
--      Meta — an explicit "fire again" generates a fresh one.
--
-- RLS: members read their account's events; there are deliberately
-- NO client INSERT/UPDATE/DELETE policies — rows are written only
-- by server code holding the service role.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. contacts
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ctwa_clid TEXT,
  ADD COLUMN IF NOT EXISTS ctwa_clid_captured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;

COMMENT ON COLUMN contacts.ctwa_clid IS
  'Latest click-to-WhatsApp click id captured from an inbound message''s '
  'referral object. A newer inbound value overwrites. NULL = the contact '
  'never arrived through a CTWA ad, so CAPI fires are blocked for them.';
COMMENT ON COLUMN contacts.ctwa_clid_captured_at IS
  'When ctwa_clid was last written. Set together with ctwa_clid.';
COMMENT ON COLUMN contacts.qualified_at IS
  'When the last successful CAPI Lead fire happened ("Mark qualified"). '
  'NULL until the first success; updated again on an explicit re-fire.';
COMMENT ON COLUMN contacts.converted_at IS
  'When the last successful CAPI Purchase/Schedule fire happened '
  '("Mark converted"). Same semantics as qualified_at.';

-- ============================================================
-- 2. whatsapp_config
-- ============================================================
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS capi_dataset_id TEXT,
  ADD COLUMN IF NOT EXISTS capi_access_token TEXT,
  ADD COLUMN IF NOT EXISTS capi_test_event_code TEXT;

COMMENT ON COLUMN whatsapp_config.capi_dataset_id IS
  'Meta dataset (pixel) id CAPI events are sent to. Plaintext — not a '
  'secret. NULL = CAPI not configured; qualify/convert are blocked.';
COMMENT ON COLUMN whatsapp_config.capi_access_token IS
  'CAPI access token, AES-256-GCM ciphertext (iv:ct:tag) from '
  'src/lib/whatsapp/encryption.ts — same scheme as access_token. Never '
  'returned to the client after save; the settings GET exposes only a '
  'boolean "set" flag.';
COMMENT ON COLUMN whatsapp_config.capi_test_event_code IS
  'Optional Events Manager test_event_code. When set it is sent with '
  'every CAPI fire so events land in test mode; NULL/blank = live.';

-- ============================================================
-- 3. capi_events
-- ============================================================
CREATE TABLE IF NOT EXISTS capi_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL CHECK (event_name IN ('Lead', 'Purchase', 'Schedule')),
  event_id UUID NOT NULL,
  value NUMERIC,
  currency TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  error TEXT,
  fired_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE capi_events IS
  'Audit log of Meta CAPI fire attempts — one row per attempt, failures '
  'included. Written exclusively by server code (service role); clients '
  'only read.';
COMMENT ON COLUMN capi_events.event_id IS
  'Dedupe key sent to Meta as data[0].event_id. A fresh uuid per '
  'attempt; "fire again" therefore produces a distinct Meta event.';
COMMENT ON COLUMN capi_events.error IS
  'Meta error message when status=failed; NULL on success.';
COMMENT ON COLUMN capi_events.fired_by IS
  'User who triggered the fire. For public-API fires this is the '
  'audit user (WhatsApp config owner) or NULL when unresolvable.';

CREATE INDEX IF NOT EXISTS idx_capi_events_contact_created
  ON capi_events (contact_id, created_at DESC);

ALTER TABLE capi_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "capi_events_select_member" ON capi_events;
CREATE POLICY "capi_events_select_member" ON capi_events
  FOR SELECT USING (is_account_member(account_id));
```

- [ ] **Step 2: Add the new fields to the Contact type**

In `src/types/index.ts`, inside `export interface Contact` (after `avatar_url?: string;`):

```ts
  /** Latest click-to-WhatsApp click id from an inbound message's
   *  referral object (migration 040). NULL = never arrived via a CTWA
   *  ad; CAPI qualify/convert are blocked without it. */
  ctwa_clid?: string | null;
  ctwa_clid_captured_at?: string | null;
  /** Set on the last successful CAPI Lead fire ("Mark qualified"). */
  qualified_at?: string | null;
  /** Set on the last successful CAPI Purchase/Schedule fire. */
  converted_at?: string | null;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no new errors).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/040_capi_events.sql src/types/index.ts
git commit -m "feat: add CAPI schema — contact clid/timestamps, config creds, capi_events audit table"
```

---

### Task 2: API scopes

**Files:**
- Modify: `src/lib/api-keys/scopes.ts`
- Test: `src/lib/api-keys/scopes.test.ts` (exists — extend)

**Interfaces:**
- Produces: scopes `'contacts:qualify'` and `'contacts:convert'` usable as `requireApiKey(request, 'contacts:qualify')`.

- [ ] **Step 1: Write the failing test**

Read `src/lib/api-keys/scopes.test.ts` first and append a test in its existing style. The assertions to add:

```ts
it('includes the CAPI qualify/convert scopes', () => {
  expect(API_SCOPES).toContain('contacts:qualify');
  expect(API_SCOPES).toContain('contacts:convert');
  expect(SCOPE_DESCRIPTIONS['contacts:qualify']).toBeTruthy();
  expect(SCOPE_DESCRIPTIONS['contacts:convert']).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/api-keys/scopes.test.ts`
Expected: FAIL (scopes missing).

- [ ] **Step 3: Add the scopes**

In `src/lib/api-keys/scopes.ts`, append to `API_SCOPES` (after `'webhooks:manage'`):

```ts
  'contacts:qualify',
  'contacts:convert',
```

And to `SCOPE_DESCRIPTIONS`:

```ts
  'contacts:qualify': 'Mark contacts qualified (fires a Meta CAPI Lead event)',
  'contacts:convert': 'Mark contacts converted (fires a Meta CAPI Purchase/Schedule event)',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/api-keys/scopes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api-keys/scopes.ts src/lib/api-keys/scopes.test.ts
git commit -m "feat: add contacts:qualify and contacts:convert API scopes"
```

---

### Task 3: CAPI Graph client + phone hashing

**Files:**
- Create: `src/lib/capi/meta-capi.ts`
- Test: `src/lib/capi/meta-capi.test.ts`

**Interfaces:**
- Consumes: `normalizePhone` from `@/lib/whatsapp/phone-utils`.
- Produces:
  - `hashPhoneForCapi(phone: string): string` — sha256 hex of the digits-only phone.
  - `sendCapiEvent(options: SendCapiEventOptions): Promise<void>` — throws `Error` with Meta's message on failure.
  - `type CapiEventName = 'Lead' | 'Purchase' | 'Schedule'`

- [ ] **Step 1: Write the failing tests**

`src/lib/capi/meta-capi.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/capi/meta-capi.test.ts`
Expected: FAIL ("Cannot find module './meta-capi'" or similar).

- [ ] **Step 3: Implement the client**

`src/lib/capi/meta-capi.ts`:

```ts
/**
 * Meta Conversions API (CAPI) client for click-to-WhatsApp events.
 *
 * Same conventions as src/lib/whatsapp/meta-api.ts: single named-options
 * object per exported function, Bearer auth, Meta's error message
 * surfaced verbatim. Kept separate from meta-api.ts because CAPI talks
 * to a dataset (pixel), not a phone number, and uses its own
 * credentials (whatsapp_config.capi_*).
 *
 * Payload shape per Meta's business-messaging spec: CTWA attribution
 * requires action_source 'business_messaging' + messaging_channel
 * 'whatsapp' + user_data.ctwa_clid; ph is the SHA-256 of the
 * E.164-digits phone. Wrong normalization silently breaks matching,
 * so hashing lives here next to the payload it feeds.
 */

import { createHash } from 'crypto'

import { normalizePhone } from '@/lib/whatsapp/phone-utils'

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export type CapiEventName = 'Lead' | 'Purchase' | 'Schedule'

export interface SendCapiEventOptions {
  datasetId: string
  /** Already decrypted. */
  accessToken: string
  eventName: CapiEventName
  /** Dedupe key — a fresh uuid per fire attempt. */
  eventId: string
  ctwaClid: string
  /** From hashPhoneForCapi(). */
  hashedPhone: string
  /** Unix seconds. */
  eventTime: number
  value?: number
  currency?: string
  testEventCode?: string | null
}

interface MetaErrorResponse {
  error?: { message?: string; code?: number; type?: string }
}

/** SHA-256 hex over the digits-only phone (Meta's `ph` normalization). */
export function hashPhoneForCapi(phone: string): string {
  return createHash('sha256').update(normalizePhone(phone)).digest('hex')
}

export async function sendCapiEvent(options: SendCapiEventOptions): Promise<void> {
  const event: Record<string, unknown> = {
    event_name: options.eventName,
    event_time: options.eventTime,
    event_id: options.eventId,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: {
      ctwa_clid: options.ctwaClid,
      ph: [options.hashedPhone],
    },
  }
  if (options.value !== undefined) {
    event.custom_data = { value: options.value, currency: options.currency }
  }

  const body: Record<string, unknown> = { data: [event] }
  if (options.testEventCode) {
    body.test_event_code = options.testEventCode
  }

  const response = await fetch(`${META_API_BASE}/${options.datasetId}/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    let message = `Meta CAPI error: ${response.status}`
    try {
      const data = (await response.json()) as MetaErrorResponse
      if (data.error?.message) message = data.error.message
    } catch {
      // non-JSON body — keep the status fallback
    }
    throw new Error(message)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/capi/meta-capi.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/capi/meta-capi.ts src/lib/capi/meta-capi.test.ts
git commit -m "feat: add Meta CAPI client with CTWA payload and phone hashing"
```

---

### Task 4: fireCapiEvent business core

**Files:**
- Create: `src/lib/capi/fire-event.ts`
- Test: `src/lib/capi/fire-event.test.ts`

**Interfaces:**
- Consumes: `sendCapiEvent`, `hashPhoneForCapi`, `CapiEventName` from `./meta-capi`; `decrypt` from `@/lib/whatsapp/encryption`.
- Produces (used verbatim by Tasks 5 and 6):

```ts
export type FireCapiErrorCode =
  | 'contact_not_found'   // 404
  | 'no_ctwa_clid'        // 422
  | 'no_capi_credentials' // 422
  | 'already_fired'       // 409
  | 'meta_error'          // 502
  | 'internal'            // 500

export class FireCapiError extends Error {
  readonly code: FireCapiErrorCode
  readonly status: number
}

export interface FireCapiOptions {
  supabase: SupabaseClient      // service-role client
  accountId: string
  contactId: string
  kind: 'qualify' | 'convert'
  eventName: CapiEventName      // forced to 'Lead' by callers when kind==='qualify'
  value?: number
  currency?: string
  refire: boolean
  firedBy: string | null
}

export interface FireCapiResult {
  eventId: string
  eventName: CapiEventName
  firedAt: string               // ISO timestamp written to the contact
}

export function fireCapiEvent(options: FireCapiOptions): Promise<FireCapiResult>
```

- [ ] **Step 1: Write the failing tests**

`src/lib/capi/fire-event.test.ts`. The Supabase stub is a per-table dispatcher: `from(table)` returns a chainable object whose terminal methods resolve canned data.

```ts
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
}) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.maybeSingle = async () => {
        if (table === 'contacts') return { data: state.contact, error: null };
        if (table === 'whatsapp_config') return { data: state.config, error: null };
        return { data: null, error: null };
      };
      chain.insert = (row: Record<string, unknown>) => {
        state.inserted.push({ table, ...row });
        return Promise.resolve({ error: state.insertError ?? null });
      };
      chain.update = (row: Record<string, unknown>) => {
        state.updated.push({ table, ...row });
        return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
      };
      return chain;
    },
  } as never;
}

function baseState() {
  return {
    contact: { ...CONTACT },
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/capi/fire-event.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement fire-event**

`src/lib/capi/fire-event.ts`:

```ts
/**
 * The single CAPI fire pipeline — used by both the dashboard route
 * (session auth) and the public v1 routes (API-key auth) so the two
 * surfaces can never drift on guard rules.
 *
 * Ordering rule: the audit row is written for EVERY attempt that
 * reaches Meta (success or failure), but the contact timestamp is
 * stamped only on success — a failed fire must leave the contact
 * exactly as it was so the operator can retry.
 */

import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'
import {
  hashPhoneForCapi,
  sendCapiEvent,
  type CapiEventName,
} from './meta-capi'

export type FireCapiErrorCode =
  | 'contact_not_found'
  | 'no_ctwa_clid'
  | 'no_capi_credentials'
  | 'already_fired'
  | 'meta_error'
  | 'internal'

const STATUS_BY_CODE: Record<FireCapiErrorCode, number> = {
  contact_not_found: 404,
  no_ctwa_clid: 422,
  no_capi_credentials: 422,
  already_fired: 409,
  meta_error: 502,
  internal: 500,
}

export class FireCapiError extends Error {
  readonly code: FireCapiErrorCode
  readonly status: number

  constructor(code: FireCapiErrorCode, message: string) {
    super(message)
    this.name = 'FireCapiError'
    this.code = code
    this.status = STATUS_BY_CODE[code]
  }
}

export interface FireCapiOptions {
  /** Service-role client — capi_events has no client INSERT policy. */
  supabase: SupabaseClient
  accountId: string
  contactId: string
  kind: 'qualify' | 'convert'
  eventName: CapiEventName
  value?: number
  currency?: string
  refire: boolean
  firedBy: string | null
}

export interface FireCapiResult {
  eventId: string
  eventName: CapiEventName
  firedAt: string
}

export async function fireCapiEvent(
  options: FireCapiOptions
): Promise<FireCapiResult> {
  const { supabase, accountId, contactId, kind } = options

  const { data: contact } = await supabase
    .from('contacts')
    .select('id, phone, ctwa_clid, qualified_at, converted_at')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (!contact) {
    throw new FireCapiError('contact_not_found', 'Contact not found')
  }
  if (!contact.ctwa_clid) {
    throw new FireCapiError(
      'no_ctwa_clid',
      'This contact has no captured click id (ctwa_clid); CAPI events are blocked for them'
    )
  }

  const timestampColumn = kind === 'qualify' ? 'qualified_at' : 'converted_at'
  if (contact[timestampColumn] && !options.refire) {
    throw new FireCapiError(
      'already_fired',
      `Contact is already marked ${kind === 'qualify' ? 'qualified' : 'converted'}; pass refire to send again`
    )
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('capi_dataset_id, capi_access_token, capi_test_event_code')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!config?.capi_dataset_id || !config?.capi_access_token) {
    throw new FireCapiError(
      'no_capi_credentials',
      'CAPI credentials are not configured for this account'
    )
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.capi_access_token)
  } catch (err) {
    // Rotated/mismatched ENCRYPTION_KEY. Same remedy as missing creds
    // (re-save them in settings), but log the real cause distinctly.
    console.error('[capi] access token decryption failed:', err)
    throw new FireCapiError(
      'no_capi_credentials',
      'Stored CAPI access token cannot be decrypted — re-save it in settings'
    )
  }

  const eventId = randomUUID()
  const firedAt = new Date().toISOString()

  const audit = {
    account_id: accountId,
    contact_id: contactId,
    event_name: options.eventName,
    event_id: eventId,
    value: options.value ?? null,
    currency: options.value !== undefined ? (options.currency ?? 'INR') : null,
    fired_by: options.firedBy,
  }

  try {
    await sendCapiEvent({
      datasetId: config.capi_dataset_id,
      accessToken,
      eventName: options.eventName,
      eventId,
      ctwaClid: contact.ctwa_clid,
      hashedPhone: hashPhoneForCapi(contact.phone),
      eventTime: Math.floor(Date.parse(firedAt) / 1000),
      value: options.value,
      currency: options.value !== undefined ? (options.currency ?? 'INR') : undefined,
      testEventCode: config.capi_test_event_code,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta CAPI error'
    const { error: auditError } = await supabase
      .from('capi_events')
      .insert({ ...audit, status: 'failed', error: message })
    if (auditError) {
      console.error('[capi] failed-attempt audit insert failed:', auditError)
    }
    throw new FireCapiError('meta_error', message)
  }

  const { error: auditError } = await supabase
    .from('capi_events')
    .insert({ ...audit, status: 'success', error: null })
  if (auditError) {
    // The event DID reach Meta — surface loudly but don't pretend it failed.
    console.error('[capi] success audit insert failed:', auditError)
  }

  const { error: stampError } = await supabase
    .from('contacts')
    .update({ [timestampColumn]: firedAt })
    .eq('id', contactId)
    .eq('account_id', accountId)
  if (stampError) {
    console.error('[capi] contact timestamp update failed:', stampError)
    throw new FireCapiError(
      'internal',
      'Event was sent to Meta but recording it on the contact failed'
    )
  }

  return { eventId, eventName: options.eventName, firedAt }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/capi/fire-event.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/capi/fire-event.ts src/lib/capi/fire-event.test.ts
git commit -m "feat: add shared fireCapiEvent pipeline with guards and audit logging"
```

---

### Task 5: Public v1 qualify + convert routes

**Files:**
- Create: `src/app/api/v1/contacts/[id]/qualify/route.ts`
- Create: `src/app/api/v1/contacts/[id]/convert/route.ts`
- Test: `src/app/api/v1/contacts/[id]/qualify/route.test.ts`
- Test: `src/app/api/v1/contacts/[id]/convert/route.test.ts`
- Modify: `docs/public-api.md`

**Interfaces:**
- Consumes: `requireApiKey` (`@/lib/auth/api-context`), `ok`/`fail`/`toApiErrorResponse` (`@/lib/api/v1/respond`), `resolveAuditUserId` (`@/lib/api/v1/contacts`), `fireCapiEvent`/`FireCapiError` (`@/lib/capi/fire-event`).
- Produces: `POST /api/v1/contacts/{id}/qualify` body `{ refire?: boolean }`; `POST /api/v1/contacts/{id}/convert` body `{ event_name?: 'Purchase'|'Schedule', value?: number, currency?: string, refire?: boolean }`. Success: `{ data: { event_id, event_name, fired_at } }`.

- [ ] **Step 1: Write the failing tests**

`src/app/api/v1/contacts/[id]/qualify/route.test.ts` (mock style from `src/app/api/contacts/[id]/tags/route.test.ts` — hoisted mocks BEFORE the route import):

```ts
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
```

`src/app/api/v1/contacts/[id]/convert/route.test.ts` — same mock scaffold (repeat it in full; do not import from the qualify test), with `scopes: ['contacts:convert']`, URL `.../convert`, `fireCapiEvent` resolving `{ eventId: 'event-1', eventName: 'Purchase', firedAt: '2026-08-18T10:00:00.000Z' }`, and these cases:

```ts
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

  it('maps FireCapiError onto the envelope', async () => {
    mocks.fireCapiEvent.mockRejectedValue(
      new FireCapiError('no_ctwa_clid', 'no clid')
    );
    const res = await POST(request({}), params);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('no_ctwa_clid');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run "src/app/api/v1/contacts/[id]/qualify/route.test.ts" "src/app/api/v1/contacts/[id]/convert/route.test.ts"`
Expected: FAIL (routes missing).

- [ ] **Step 3: Implement the qualify route**

`src/app/api/v1/contacts/[id]/qualify/route.ts`:

```ts
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
```

- [ ] **Step 4: Implement the convert route**

`src/app/api/v1/contacts/[id]/convert/route.ts`:

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run "src/app/api/v1/contacts/[id]/qualify/route.test.ts" "src/app/api/v1/contacts/[id]/convert/route.test.ts"`
Expected: PASS.

- [ ] **Step 6: Document the endpoints**

Read `docs/public-api.md` and append, following its existing per-endpoint format, entries for both endpoints: method+path, required scope, request body fields (as in the route headers above), success payload `{ data: { event_id, event_name, fired_at } }`, and the error codes `not_found` 404, `no_ctwa_clid` 422, `no_capi_credentials` 422, `already_fired` 409, `meta_error` 502, `bad_request` 400. Note the qualify tier always fires `Lead`, and the two new scopes.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/v1/contacts/[id]/qualify" "src/app/api/v1/contacts/[id]/convert" docs/public-api.md
git commit -m "feat: add public v1 qualify/convert CAPI endpoints"
```

---

### Task 6: Dashboard fire route

**Files:**
- Create: `src/app/api/contacts/[id]/capi/route.ts`
- Test: `src/app/api/contacts/[id]/capi/route.test.ts`

**Interfaces:**
- Consumes: `requireRole`, `toErrorResponse` (`@/lib/auth/account`); `supabaseAdmin` (`@/lib/flows/admin-client`); `fireCapiEvent`/`FireCapiError` (`@/lib/capi/fire-event`).
- Produces: `POST /api/contacts/{id}/capi` (session auth, min role `agent`) body `{ kind: 'qualify'|'convert', event_name?: 'Purchase'|'Schedule', value?: number, currency?: string, refire?: boolean }`. Success 200: `{ event_id, event_name, fired_at }` (dashboard routes use the plain internal shape, not the v1 envelope). Errors: `{ error, code }` with FireCapiError statuses.

- [ ] **Step 1: Write the failing test**

`src/app/api/contacts/[id]/capi/route.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/api/contacts/[id]/capi/route.test.ts"`
Expected: FAIL (route missing).

- [ ] **Step 3: Implement the route**

`src/app/api/contacts/[id]/capi/route.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/api/contacts/[id]/capi/route.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/contacts/[id]/capi"
git commit -m "feat: add dashboard CAPI fire route for qualify/convert buttons"
```

---

### Task 7: Webhook ctwa_clid capture

**Files:**
- Modify: `src/app/api/whatsapp/webhook/route.ts` (message type ~line 72; `processMessage` ~line 602)
- Test: `src/app/api/whatsapp/webhook/route.test.ts` (exists — extend)

**Interfaces:**
- Consumes: the existing `WhatsAppMessage` interface and `processMessage` flow.
- Produces: `contacts.ctwa_clid` + `ctwa_clid_captured_at` written on inbound messages carrying `referral.ctwa_clid`.

- [ ] **Step 1: Read the existing test file's harness**

Read `src/app/api/whatsapp/webhook/route.test.ts` fully first. It mocks the webhook's dependencies and builds Meta payloads; the new tests MUST use the same builders/mocks. The inbound message fixture gains a `referral` field:

```ts
referral: {
  ctwa_clid: 'test-clid-123',
  source_type: 'ad',
  source_id: '120212345678901234',
  headline: 'Chat with us',
}
```

- [ ] **Step 2: Write the failing tests**

Add cases (adapted to the file's existing harness — same mock Supabase, same POST invocation style):

1. **Capture:** an inbound text message whose payload includes `referral.ctwa_clid: 'test-clid-123'` → assert the contacts table received an update setting `ctwa_clid: 'test-clid-123'` and a non-null `ctwa_clid_captured_at`.
2. **Overwrite:** a message with `referral.ctwa_clid: 'newer-clid'` for a contact that already has one → assert the update carries `'newer-clid'` (the code path is unconditional; assert the update happens regardless of existing value).
3. **No referral:** a plain inbound message without `referral` → assert NO contacts update containing a `ctwa_clid` key occurred.
4. **Never breaks processing:** make the ctwa_clid update mock reject/error → assert the webhook still returns 200 and message processing completed (message insert still happened).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/app/api/whatsapp/webhook/route.test.ts`
Expected: new cases FAIL; every pre-existing case still PASSES.

- [ ] **Step 4: Implement capture**

In `src/app/api/whatsapp/webhook/route.ts`:

(a) Add to `interface WhatsAppMessage` (after `context?: { id: string }`):

```ts
  /**
   * Present when this message originated from a click-to-WhatsApp ad.
   * ctwa_clid is the attribution key for Meta Conversions API events
   * (migration 040) — captured silently onto the contact; nothing is
   * fired automatically.
   */
  referral?: {
    source_url?: string
    source_type?: string
    source_id?: string
    headline?: string
    body?: string
    ctwa_clid?: string
  }
```

(b) In `processMessage`, right after `const contactRecord = contactOutcome.contact` (before the conversation lookup — capture applies to reactions' contacts too, and must run before any short-circuit):

```ts
  // Silent ctwa_clid capture (spec: docs/product/features/capi-events.md).
  // Newest message wins — an unconditional overwrite, by design. Failure
  // must never break message processing, so errors only log.
  const ctwaClid = message.referral?.ctwa_clid
  if (ctwaClid) {
    const { error: clidError } = await supabaseAdmin()
      .from('contacts')
      .update({
        ctwa_clid: ctwaClid,
        ctwa_clid_captured_at: new Date().toISOString(),
      })
      .eq('id', contactRecord.id)
    if (clidError) {
      console.error('[webhook] ctwa_clid capture failed:', clidError.message)
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/app/api/whatsapp/webhook/route.test.ts`
Expected: PASS (all cases, old and new).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/whatsapp/webhook/route.ts src/app/api/whatsapp/webhook/route.test.ts
git commit -m "feat: capture ctwa_clid silently from inbound message referrals"
```

---

### Task 8: CAPI settings API

**Files:**
- Create: `src/app/api/whatsapp/config/capi/route.ts`
- Test: `src/app/api/whatsapp/config/capi/route.test.ts`

**Interfaces:**
- Consumes: `getCurrentAccount`, `requireRole`, `toErrorResponse` (`@/lib/auth/account`); `encrypt` (`@/lib/whatsapp/encryption`); `supabaseAdmin` (`@/lib/flows/admin-client`).
- Produces:
  - `GET /api/whatsapp/config/capi` (any member) → `{ dataset_id: string|null, test_event_code: string|null, access_token_set: boolean, whatsapp_configured: boolean }`
  - `PUT /api/whatsapp/config/capi` (admin+) body `{ dataset_id: string|null, access_token?: string, test_event_code?: string|null }` → `{ success: true }`. Omitted/empty `access_token` keeps the stored one; `dataset_id: null` with `access_token: null` is how creds get cleared. Requires an existing `whatsapp_config` row (409 `whatsapp_not_configured` otherwise).

Design note (small deviation from the spec, for the reviewer): the spec said "extend `config/route.ts`", but that file's GET is a Meta connection *test* and its POST requires the WhatsApp token every call — bolting CAPI fields onto those verbs would force re-entering WhatsApp credentials to save a pixel id. A nested `config/capi/route.ts` keeps the same URL surface (`/api/whatsapp/config/...`), same table, and clean verbs. The token stays write-only to the client either way.

- [ ] **Step 1: Write the failing test**

`src/app/api/whatsapp/config/capi/route.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/whatsapp/config/capi/route.test.ts`
Expected: FAIL (route missing).

- [ ] **Step 3: Implement the route**

`src/app/api/whatsapp/config/capi/route.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/whatsapp/config/capi/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/whatsapp/config/capi
git commit -m "feat: add CAPI credentials settings API (write-only token)"
```

---

### Task 9: Settings UI section

**Files:**
- Create: `src/components/settings/capi-settings-section.tsx`
- Modify: `src/components/settings/whatsapp-config.tsx` (render the section at the bottom of the panel)
- Modify: `messages/en.json`, `messages/ko.json`

**Interfaces:**
- Consumes: `GET`/`PUT /api/whatsapp/config/capi` (Task 8 shapes).
- Produces: `<CapiSettingsSection />` — self-contained client component (fetches its own state), rendered inside the WhatsApp settings panel.

- [ ] **Step 1: Read the surrounding panel**

Read `src/components/settings/whatsapp-config.tsx` (full) to match its card/section markup, admin-gating pattern, toast usage, and i18n namespace (`useTranslations(...)` keys). Reuse its visual building blocks.

- [ ] **Step 2: Implement the section component**

`src/components/settings/capi-settings-section.tsx` — adapt classNames/wrappers to what Step 1 found; the behavior contract is:

```tsx
'use client';

// ============================================================
// CapiSettingsSection — Meta Conversions API credentials, rendered
// at the bottom of the WhatsApp settings panel (same table row).
//
// Token handling mirrors the WhatsApp access token: password-type
// input, write-only — after save the field clears and a "token
// saved" hint (from access_token_set) is shown instead. Submitting
// with the field blank keeps the stored token (server contract).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface CapiState {
  dataset_id: string | null;
  test_event_code: string | null;
  access_token_set: boolean;
  whatsapp_configured: boolean;
}

export function CapiSettingsSection({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations('Settings.capi');
  const [state, setState] = useState<CapiState | null>(null);
  const [datasetId, setDatasetId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [testEventCode, setTestEventCode] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/whatsapp/config/capi');
    if (!res.ok) return;
    const data = (await res.json()) as CapiState;
    setState(data);
    setDatasetId(data.dataset_id ?? '');
    setTestEventCode(data.test_event_code ?? '');
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/config/capi', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset_id: datasetId.trim() || null,
          // blank = keep stored token (server contract)
          access_token: accessToken,
          test_event_code: testEventCode.trim() || null,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      setAccessToken('');
      await load();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  if (!state) return null;

  return (
    <div className="mt-6 border-t border-border pt-6">
      <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t('description')}</p>

      {!state.whatsapp_configured ? (
        <p className="mt-3 text-xs text-muted-foreground">{t('connectFirst')}</p>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="space-y-2">
            <Label>{t('datasetId')}</Label>
            <Input
              value={datasetId}
              onChange={(e) => setDatasetId(e.target.value)}
              placeholder={t('datasetIdPlaceholder')}
              disabled={!isAdmin}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('accessToken')}</Label>
            <Input
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder={
                state.access_token_set
                  ? t('tokenSavedPlaceholder')
                  : t('tokenPlaceholder')
              }
              disabled={!isAdmin}
            />
            {state.access_token_set && (
              <p className="text-xs text-muted-foreground">{t('tokenSavedHint')}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label>{t('testEventCode')}</Label>
            <Input
              value={testEventCode}
              onChange={(e) => setTestEventCode(e.target.value)}
              placeholder={t('testEventCodePlaceholder')}
              disabled={!isAdmin}
            />
            <p className="text-xs text-muted-foreground">{t('testEventCodeHint')}</p>
          </div>
          {isAdmin && (
            <Button onClick={handleSave} disabled={saving}>
              {saving ? t('saving') : t('save')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Mount it in the WhatsApp panel**

In `src/components/settings/whatsapp-config.tsx`, render `<CapiSettingsSection isAdmin={...} />` at the bottom of the panel, passing the same admin flag the surrounding form already computes (find how it gates its own save controls in Step 1 and reuse that exact source).

- [ ] **Step 4: Add i18n strings**

`messages/en.json`, under `Settings` (match existing nesting style), key `capi`:

```json
"capi": {
  "title": "Meta Conversions API",
  "description": "Send Lead and Purchase events for click-to-WhatsApp contacts to your Meta dataset.",
  "connectFirst": "Connect WhatsApp above first — conversion events need the inbound webhook.",
  "datasetId": "Dataset (Pixel) ID",
  "datasetIdPlaceholder": "e.g. 1234567890",
  "accessToken": "CAPI access token",
  "tokenPlaceholder": "Paste your Conversions API token",
  "tokenSavedPlaceholder": "••••••••  (token saved)",
  "tokenSavedHint": "A token is saved. Leave blank to keep it; paste a new one to replace it.",
  "testEventCode": "Test event code (optional)",
  "testEventCodePlaceholder": "e.g. TEST12345",
  "testEventCodeHint": "When set, events land in Events Manager test mode. Clear it to go live.",
  "save": "Save CAPI settings",
  "saving": "Saving…",
  "saved": "CAPI settings saved",
  "saveFailed": "Failed to save CAPI settings"
}
```

`messages/ko.json`, same keys:

```json
"capi": {
  "title": "Meta 전환 API",
  "description": "클릭 투 WhatsApp 연락처의 Lead 및 Purchase 이벤트를 Meta 데이터셋으로 전송합니다.",
  "connectFirst": "먼저 위에서 WhatsApp을 연결하세요 — 전환 이벤트에는 수신 웹훅이 필요합니다.",
  "datasetId": "데이터셋(픽셀) ID",
  "datasetIdPlaceholder": "예: 1234567890",
  "accessToken": "CAPI 액세스 토큰",
  "tokenPlaceholder": "전환 API 토큰을 붙여넣으세요",
  "tokenSavedPlaceholder": "••••••••  (토큰 저장됨)",
  "tokenSavedHint": "토큰이 저장되어 있습니다. 유지하려면 비워 두고, 교체하려면 새 토큰을 붙여넣으세요.",
  "testEventCode": "테스트 이벤트 코드 (선택)",
  "testEventCodePlaceholder": "예: TEST12345",
  "testEventCodeHint": "설정하면 이벤트가 Events Manager 테스트 모드로 전송됩니다. 지우면 실제 전송됩니다.",
  "save": "CAPI 설정 저장",
  "saving": "저장 중…",
  "saved": "CAPI 설정이 저장되었습니다",
  "saveFailed": "CAPI 설정 저장에 실패했습니다"
}
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all PASS. Then `npm run dev`, open Settings → WhatsApp, confirm: section renders, non-admin sees disabled inputs, save round-trips, token field clears after save and shows the saved hint.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/capi-settings-section.tsx src/components/settings/whatsapp-config.tsx messages/en.json messages/ko.json
git commit -m "feat: add CAPI credentials section to WhatsApp settings"
```

---

### Task 10: Contact action buttons (CapiActions)

**Files:**
- Create: `src/components/capi/capi-actions.tsx`
- Modify: `src/components/inbox/contact-sidebar.tsx` (render after the Deals section)
- Modify: `src/components/contacts/contact-detail-view.tsx` (render in the detail layout near the other contact actions)
- Modify: `messages/en.json`, `messages/ko.json`

**Interfaces:**
- Consumes: `POST /api/contacts/{id}/capi` (Task 6 shapes), `GET /api/whatsapp/config/capi` (Task 8), `Contact` type fields from Task 1.
- Produces: `<CapiActions contact={Contact} />` — self-contained; both surfaces just mount it.

- [ ] **Step 1: Implement CapiActions**

`src/components/capi/capi-actions.tsx`:

```tsx
'use client';

// ============================================================
// CapiActions — "Mark qualified" / "Mark converted" buttons, shared
// by the inbox contact sidebar and the contact detail view so the
// gating logic lives exactly once.
//
// Gating (spec docs/product/features/capi-events.md):
//   - no ctwa_clid on the contact         → disabled + reason
//   - account has no CAPI credentials     → disabled + reason
//   - already fired                        → inert state + "Fire again"
// Qualify confirms via window.confirm (no inputs); convert opens a
// Dialog collecting event name / value / currency. Failures leave
// the button active for manual retry — no queue by design.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Megaphone, RefreshCw } from 'lucide-react';

import type { Contact } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type ConvertEventName = 'Purchase' | 'Schedule';

interface FireResponse {
  event_id: string;
  event_name: string;
  fired_at: string;
  error?: string;
  code?: string;
}

export function CapiActions({ contact }: { contact: Contact }) {
  const t = useTranslations('Contacts.capi');

  // Local overrides so a successful fire flips the UI without the
  // parent re-fetching the contact row.
  const [qualifiedAt, setQualifiedAt] = useState<string | null>(
    contact.qualified_at ?? null
  );
  const [convertedAt, setConvertedAt] = useState<string | null>(
    contact.converted_at ?? null
  );
  const [capiReady, setCapiReady] = useState<boolean | null>(null);
  const [firing, setFiring] = useState<'qualify' | 'convert' | null>(null);

  const [convertOpen, setConvertOpen] = useState(false);
  const [convertRefire, setConvertRefire] = useState(false);
  const [eventName, setEventName] = useState<ConvertEventName>('Purchase');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState('INR');

  useEffect(() => {
    setQualifiedAt(contact.qualified_at ?? null);
    setConvertedAt(contact.converted_at ?? null);
  }, [contact.id, contact.qualified_at, contact.converted_at]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/whatsapp/config/capi')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setCapiReady(Boolean(data.access_token_set && data.dataset_id));
      })
      .catch(() => {
        if (!cancelled) setCapiReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasClid = Boolean(contact.ctwa_clid);
  const blockedReason = !hasClid
    ? t('noClidHint')
    : capiReady === false
      ? t('noCredsHint')
      : null;
  const disabled = blockedReason != null || capiReady == null;

  const fire = useCallback(
    async (body: Record<string, unknown>): Promise<FireResponse | null> => {
      const res = await fetch(`/api/contacts/${contact.id}/capi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as FireResponse;
      if (!res.ok) {
        toast.error(payload.error || t('fireFailed'));
        return null;
      }
      return payload;
    },
    [contact.id, t]
  );

  async function handleQualify(refire: boolean) {
    if (!window.confirm(refire ? t('confirmQualifyAgain') : t('confirmQualify'))) return;
    setFiring('qualify');
    const result = await fire({ kind: 'qualify', refire });
    setFiring(null);
    if (result) {
      setQualifiedAt(result.fired_at);
      toast.success(t('qualifiedToast'));
    }
  }

  function openConvert(refire: boolean) {
    setConvertRefire(refire);
    setEventName('Purchase');
    setValue('');
    setCurrency('INR');
    setConvertOpen(true);
  }

  async function handleConvertSubmit() {
    const trimmed = value.trim();
    let parsedValue: number | undefined;
    if (trimmed !== '') {
      parsedValue = Number(trimmed);
      if (!Number.isFinite(parsedValue) || parsedValue < 0) {
        toast.error(t('invalidValue'));
        return;
      }
    }
    if (!/^[A-Za-z]{3}$/.test(currency.trim())) {
      toast.error(t('invalidCurrency'));
      return;
    }
    setFiring('convert');
    const result = await fire({
      kind: 'convert',
      event_name: eventName,
      value: parsedValue,
      currency: parsedValue !== undefined ? currency.trim().toUpperCase() : undefined,
      refire: convertRefire,
    });
    setFiring(null);
    if (result) {
      setConvertedAt(result.fired_at);
      setConvertOpen(false);
      toast.success(t('convertedToast'));
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Megaphone className="h-3 w-3" />
        {t('sectionTitle')}
      </div>

      {/* Qualify */}
      {qualifiedAt ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
            {t('qualifiedAt', { date: new Date(qualifiedAt).toLocaleDateString() })}
          </span>
          <button
            onClick={() => handleQualify(true)}
            disabled={disabled || firing != null}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
            title={t('fireAgain')}
          >
            <RefreshCw className="h-3 w-3" />
            {t('fireAgain')}
          </button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={disabled || firing != null}
          onClick={() => handleQualify(false)}
          title={blockedReason ?? undefined}
        >
          {firing === 'qualify' ? t('firing') : t('markQualified')}
        </Button>
      )}

      {/* Convert */}
      {convertedAt ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
            {t('convertedAt', { date: new Date(convertedAt).toLocaleDateString() })}
          </span>
          <button
            onClick={() => openConvert(true)}
            disabled={disabled || firing != null}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
            title={t('fireAgain')}
          >
            <RefreshCw className="h-3 w-3" />
            {t('fireAgain')}
          </button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={disabled || firing != null}
          onClick={() => openConvert(false)}
          title={blockedReason ?? undefined}
        >
          {firing === 'convert' ? t('firing') : t('markConverted')}
        </Button>
      )}

      {blockedReason && (
        <p className="px-1 text-xs text-muted-foreground">{blockedReason}</p>
      )}

      <Dialog open={convertOpen} onOpenChange={setConvertOpen}>
        <DialogContent className="bg-popover border-border sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {convertRefire ? t('convertAgainTitle') : t('convertTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('convertDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('eventName')}</Label>
              <Select
                value={eventName}
                onValueChange={(v) => v && setEventName(v as ConvertEventName)}
              >
                <SelectTrigger className="w-full bg-muted border-border text-foreground">
                  <SelectValue>{eventName}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Purchase">Purchase</SelectItem>
                  <SelectItem value="Schedule">Schedule</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('value')}{' '}
                <span className="text-xs">{t('optional')}</span>
              </Label>
              <Input
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="0.00"
                className="bg-muted border-border text-foreground"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('currency')}</Label>
              <Input
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                maxLength={3}
                className="bg-muted border-border text-foreground"
              />
            </div>
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setConvertOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleConvertSubmit}
              disabled={firing != null}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {firing === 'convert' ? t('firing') : t('fireEvent')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 2: Mount in the inbox sidebar**

In `src/components/inbox/contact-sidebar.tsx`, after the Deals section (after its closing `</div>`, before the Notes divider), add a divider + the component:

```tsx
          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* CAPI conversion actions */}
          <CapiActions contact={contact} />
```

with `import { CapiActions } from '@/components/capi/capi-actions';` at the top. Note the sidebar's contact prop must include the new columns — verify the query that produces it selects `*` (the inbox conversation query does); if it enumerates columns, add the four new ones.

- [ ] **Step 3: Mount in the contact detail view**

Read `src/components/contacts/contact-detail-view.tsx` around its action buttons (~line 436 and the right-hand details column) and render `<CapiActions contact={contact} />` in the details column, matching surrounding section markup. Same import.

- [ ] **Step 4: Add i18n strings**

`messages/en.json`, under `Contacts` (create the namespace level if the file keys them differently — follow existing structure), key `capi`:

```json
"capi": {
  "sectionTitle": "Conversions",
  "markQualified": "Mark qualified",
  "markConverted": "Mark converted",
  "firing": "Sending…",
  "fireAgain": "Fire again",
  "fireEvent": "Fire event",
  "qualifiedAt": "Qualified {date}",
  "convertedAt": "Converted {date}",
  "qualifiedToast": "Lead event sent to Meta",
  "convertedToast": "Conversion event sent to Meta",
  "fireFailed": "Failed to send the event — try again",
  "confirmQualify": "Send a Lead event to Meta for this contact?",
  "confirmQualifyAgain": "Send the Lead event again with a new event id?",
  "convertTitle": "Mark converted",
  "convertAgainTitle": "Fire conversion again",
  "convertDesc": "Sends a conversion event with this contact's click id to your Meta dataset.",
  "eventName": "Event",
  "value": "Value",
  "optional": "(optional)",
  "currency": "Currency",
  "cancel": "Cancel",
  "invalidValue": "Value must be a non-negative number",
  "invalidCurrency": "Currency must be a 3-letter code (e.g. INR)",
  "noClidHint": "No click id captured — this contact didn't arrive through a click-to-WhatsApp ad.",
  "noCredsHint": "CAPI credentials are not configured. Set them in Settings → WhatsApp."
}
```

`messages/ko.json`, same keys:

```json
"capi": {
  "sectionTitle": "전환",
  "markQualified": "적격으로 표시",
  "markConverted": "전환으로 표시",
  "firing": "전송 중…",
  "fireAgain": "다시 전송",
  "fireEvent": "이벤트 전송",
  "qualifiedAt": "{date} 적격 처리됨",
  "convertedAt": "{date} 전환 처리됨",
  "qualifiedToast": "Lead 이벤트가 Meta로 전송되었습니다",
  "convertedToast": "전환 이벤트가 Meta로 전송되었습니다",
  "fireFailed": "이벤트 전송에 실패했습니다 — 다시 시도하세요",
  "confirmQualify": "이 연락처의 Lead 이벤트를 Meta로 전송할까요?",
  "confirmQualifyAgain": "새 이벤트 ID로 Lead 이벤트를 다시 전송할까요?",
  "convertTitle": "전환으로 표시",
  "convertAgainTitle": "전환 이벤트 다시 전송",
  "convertDesc": "이 연락처의 클릭 ID와 함께 전환 이벤트를 Meta 데이터셋으로 전송합니다.",
  "eventName": "이벤트",
  "value": "금액",
  "optional": "(선택)",
  "currency": "통화",
  "cancel": "취소",
  "invalidValue": "금액은 0 이상의 숫자여야 합니다",
  "invalidCurrency": "통화는 3자리 코드여야 합니다 (예: INR)",
  "noClidHint": "클릭 ID가 없습니다 — 이 연락처는 클릭 투 WhatsApp 광고를 통해 유입되지 않았습니다.",
  "noCredsHint": "CAPI 자격 증명이 설정되지 않았습니다. 설정 → WhatsApp에서 설정하세요."
}
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all PASS. Then `npm run dev` and manually confirm in the inbox sidebar and contact detail view: buttons disabled with hint when no clid / no creds; convert dialog collects fields; success flips to the inert timestamp row with "Fire again".

- [ ] **Step 6: Commit**

```bash
git add src/components/capi src/components/inbox/contact-sidebar.tsx src/components/contacts/contact-detail-view.tsx messages/en.json messages/ko.json
git commit -m "feat: add Mark qualified / Mark converted CAPI actions to contact UI"
```

---

### Task 11: Full verification pass

**Files:** none new.

- [ ] **Step 1: Full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: everything PASSES. Fix anything that doesn't before proceeding.

- [ ] **Step 2: Spec walk-through**

Re-read `docs/product/features/capi-events.md` acceptance checkboxes and confirm each maps to shipped behavior. In particular: capture is silent (no event fired anywhere in the webhook path), buttons inert after success with explicit fire-again, both endpoints enforce identical rules through `fireCapiEvent`, token never round-trips to the client, `test_event_code` sent on every fire when set.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "test: CAPI feature verification fixes"
```
