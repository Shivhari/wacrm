# Meta CAPI Conversion Events — Design

**Date:** 2026-08-18
**Status:** approved-pending-review
**Source PRD:** `docs/product/features/capi-events.md`

Human-triggered Meta Conversions API events on contacts: silent `ctwa_clid`
capture from inbound WhatsApp messages, operator actions "Mark qualified"
(Lead) and "Mark converted" (Purchase/Schedule), per-account CAPI
credentials, and authenticated public API endpoints.

## Decisions made during design (beyond the PRD)

| Question | Decision |
|---|---|
| Where do CAPI creds live? | Columns on `whatsapp_config` (already one-row-per-account, already stores encrypted Meta tokens). No new table. |
| Settings UI placement | Section inside the existing WhatsApp settings panel (`whatsapp-config.tsx`). No new settings tab. |
| Who can fire events in the UI? | Agent role and above (viewers are read-only; firing is an external write). UI hides/disables the buttons for viewers. Creds editing stays admin-only (existing WhatsApp config gating). Amended 2026-08-19 by eng review D15. |
| Graph API version | Reuse the repo's single `v21.0` pin from `src/lib/whatsapp/meta-api.ts`. |
| Qualify confirm dialog | `window.confirm` (repo's plain-confirm pattern; no inputs needed). Convert uses a controlled `Dialog` because it collects inputs. |
| Phone hashing input | `normalizePhone()` from `src/lib/whatsapp/phone-utils.ts` (digits-only incl. country code) — matches Meta's `ph` normalization spec. SHA-256 hex via `node:crypto`. |

## 1. Data — migration `supabase/migrations/040_capi_events.sql`

Idempotent, with rationale header and `COMMENT ON COLUMN` for every new
column (template: migration 039).

**`contacts` — 4 new nullable columns**

| column | type | notes |
|---|---|---|
| `ctwa_clid` | text | latest captured click ID; newer inbound value overwrites |
| `ctwa_clid_captured_at` | timestamptz | set whenever `ctwa_clid` is written |
| `qualified_at` | timestamptz | set on successful Lead fire only |
| `converted_at` | timestamptz | set on successful Purchase/Schedule fire only |

**`whatsapp_config` — 3 new nullable columns**

| column | type | notes |
|---|---|---|
| `capi_dataset_id` | text | Meta dataset (pixel) ID, plaintext (not secret) |
| `capi_access_token` | text | AES-256-GCM ciphertext via `src/lib/whatsapp/encryption.ts`, same as `access_token`; never returned to the client after save |
| `capi_test_event_code` | text | when set, sent with every fire (Events Manager test mode); blank = live |

**New table `capi_events`** — audit log, one row per fire attempt
(success and failure both recorded):

| column | type | notes |
|---|---|---|
| `id` | uuid pk default `gen_random_uuid()` | |
| `account_id` | uuid NOT NULL FK `accounts` ON DELETE CASCADE | |
| `contact_id` | uuid NOT NULL FK `contacts` ON DELETE CASCADE | |
| `event_name` | text NOT NULL | `Lead` \| `Purchase` \| `Schedule` (CHECK constraint) |
| `event_id` | uuid NOT NULL | dedupe key sent to Meta; new one per "fire again" |
| `value` | numeric null | convert only |
| `currency` | text null | convert only, default `INR` supplied by UI |
| `status` | text NOT NULL | `success` \| `failed` (CHECK constraint) |
| `error` | text null | Meta error message on failure, for audit |
| `fired_by` | uuid null | auth user id; null when fired via API key without a resolvable user |
| `created_at` | timestamptz NOT NULL default now() | |

Index: `(contact_id, created_at DESC)` for the contact-history read.

RLS: enable; `is_account_member(account_id)` for SELECT only. No
client-side INSERT/UPDATE/DELETE policies — rows are written exclusively
by server code using the service-role client.

## 2. CAPI client — `src/lib/capi/meta-capi.ts`

Mirrors `meta-api.ts` conventions: single named-options object per
exported function, `Bearer` auth header, error parsing identical to
`throwMetaError` (parse `{ error: { message, code } }`, fall back to
status text, throw plain `Error`).

```ts
sendCapiEvent(options: {
  datasetId: string
  accessToken: string        // already decrypted
  eventName: 'Lead' | 'Purchase' | 'Schedule'
  eventId: string            // uuid
  ctwaClid: string
  hashedPhone: string        // sha256 hex of normalizePhone(contact.phone)
  eventTime: number          // unix seconds, now at fire time
  value?: number
  currency?: string
  testEventCode?: string | null
}): Promise<void>            // throws on non-2xx or Meta error body
```

Request: `POST {META_API_BASE}/{datasetId}/events` (reuses the `v21.0`
base). Body:

```json
{
  "data": [{
    "event_name": "...",
    "event_time": 1723958400,
    "event_id": "<uuid>",
    "action_source": "business_messaging",
    "messaging_channel": "whatsapp",
    "user_data": {
      "ctwa_clid": "<clid>",
      "ph": ["<sha256-hex>"]
    },
    "custom_data": { "value": 1500, "currency": "INR" }
  }],
  "test_event_code": "<optional>"
}
```

`custom_data` omitted entirely when no value given; `currency` sent only
alongside `value`. `test_event_code` key omitted when not configured.

Also in `src/lib/capi/`: `hashPhoneForCapi(phone: string): string` —
`sha256(normalizePhone(phone))` hex, exported for tests.

## 3. Silent capture — webhook handler

`src/app/api/whatsapp/webhook/route.ts`:

1. Add `referral?: { ctwa_clid?: string; source_id?: string; source_type?: string; source_url?: string; headline?: string; body?: string }`
   to the inbound message type (~line 72).
2. In `processMessage`, immediately after contact resolution (~line 602,
   before the reaction short-circuit): if
   `message.referral?.ctwa_clid` is a non-empty string, update the
   contact row with `ctwa_clid` + `ctwa_clid_captured_at = now()`.
   Unconditional overwrite — newest message wins, per PRD.
3. Failure to write the clid logs and continues — capture must never
   break message processing (mirrors the `flagBroadcastReplyIfAny`
   never-throws pattern).
4. No event fired, no UI notification. Capture only.

## 4. Business logic — `src/lib/capi/fire-event.ts`

One shared function used by both the dashboard routes and the public v1
routes, so UI and API cannot drift:

```ts
fireCapiEvent(options: {
  supabase: SupabaseClient   // service-role
  accountId: string
  contactId: string
  kind: 'qualify' | 'convert'
  eventName: 'Lead' | 'Purchase' | 'Schedule'   // Lead iff qualify
  value?: number
  currency?: string
  refire: boolean            // explicit "fire again"
  firedBy: string | null
}): Promise<FireResult>
```

Flow:

1. Load contact by id scoped to `accountId` → 404-style error if absent.
2. Guards (each a distinct typed error so routes/UI map them to clear
   messages):
   - no `ctwa_clid` → `no_ctwa_clid`
   - no `capi_dataset_id` / `capi_access_token` on the account's
     `whatsapp_config` → `no_capi_credentials`
   - `kind: 'qualify'` and `qualified_at` already set and `!refire` →
     `already_fired` (same for convert/`converted_at`)
3. Decrypt token, generate fresh `event_id` (uuid), call
   `sendCapiEvent` with `eventTime = now`.
4. On success (single transaction-ish sequence, service role):
   insert `capi_events` row (`status: 'success'`), set
   `qualified_at`/`converted_at` on the contact (also on re-fire —
   timestamp reflects the latest successful fire).
5. On Meta failure: insert `capi_events` row (`status: 'failed'`,
   `error` = message), **do not** touch contact timestamps, return the
   error to the caller. No retry queue — caller retries manually.

Validation: `value` must be a finite number ≥ 0 when present; `currency`
a 3-letter code (uppercased, free text per PRD); `eventName` restricted
to `Purchase` | `Schedule` for convert, forced to `Lead` for qualify.

## 5. API routes

**Public v1** (pattern: `src/app/api/v1/contacts/[id]/route.ts`):

- `POST /api/v1/contacts/{id}/qualify` — `requireApiKey(request, 'contacts:qualify')`
- `POST /api/v1/contacts/{id}/convert` — `requireApiKey(request, 'contacts:convert')`
  body: `{ event_name?: 'Purchase' | 'Schedule', value?: number, currency?: string, refire?: boolean }`

Both: resolve contact scoped to `ctx.accountId` (404 not 403
cross-account), call `fireCapiEvent`, map guard errors →
409 `already_fired`, 422 `no_ctwa_clid` / `no_capi_credentials`,
502 for Meta failure. Responses via `src/lib/api/v1/respond.ts`.
`fired_by` = `resolveAuditUserId` where available, else null.

New scopes in `src/lib/api-keys/scopes.ts`: `contacts:qualify`,
`contacts:convert` + descriptions. Document both endpoints in
`docs/public-api.md`.

**Dashboard (session-auth) route** for the UI buttons:
`POST /api/contacts/[id]/capi` with body
`{ kind, event_name?, value?, currency?, refire? }`, using the repo's
existing session-auth + account-membership pattern (any member role).
Same `fireCapiEvent` core, same error mapping.

**Settings route:** extend `src/app/api/whatsapp/config/route.ts` to
GET/PUT the three CAPI fields (same table, same shaping conventions).
GET returns `capi_dataset_id`, `capi_test_event_code`, and
`capi_access_token_set: boolean` — never the token itself. PUT is
admin-gated (`requireRole('admin')`), encrypts the token when provided,
leaves it unchanged when the field is submitted empty.

## 6. UI

**Buttons** in both `src/components/inbox/contact-sidebar.tsx` and
`src/components/contacts/contact-detail-view.tsx`:

- "Mark qualified": `window.confirm` → POST dashboard route
  (`kind: 'qualify'`). On success button becomes inert, replaced by a
  qualified-at indicator + small "Fire again" affordance which confirms
  and posts with `refire: true`.
- "Mark converted": controlled `Dialog` (pattern:
  `invite-member-dialog.tsx`) with event-name select
  (`Purchase` default / `Schedule`), optional numeric value, currency
  text input defaulting `INR`. Submit → POST (`kind: 'convert'`).
  Same inert + "Fire again" behavior after success.
- Disabled states with tooltip/hint text explaining why:
  contact has no `ctwa_clid`, or account has no CAPI credentials.
  The credentials flag comes from the settings GET
  (`capi_access_token_set && capi_dataset_id`); the clid comes from the
  contact row.
- Failure: toast/error text from the route; button stays active for
  manual retry.
- Shared piece: a small `CapiActions` component used by both surfaces so
  the logic lives once; sidebar and detail view render it in their own
  layout.

**Settings section** appended inside
`src/components/settings/whatsapp-config.tsx`: three fields
(dataset ID, access token — password-type input showing only
"token saved" state after save, test event code) + save button.
Admin-only, matching the surrounding form's gating.

**Types:** add `ctwa_clid`, `ctwa_clid_captured_at`, `qualified_at`,
`converted_at` to `Contact` in `src/types/index.ts`. i18n strings in
`messages/*` via `next-intl`.

## 7. Error handling summary

| Failure | Behavior |
|---|---|
| Meta API down / bad token / rejected event | `capi_events` row `failed` + error text; contact untouched; UI shows error, button active; API returns 502 with Meta message |
| Contact lacks ctwa_clid | Blocked before any call — UI disabled with reason, API 422 |
| No CAPI credentials | Same — UI disabled with reason, API 422 |
| Already fired, no `refire` | API 409; UI shows inert state + "Fire again" |
| clid capture DB write fails | Logged, message processing continues |
| Decryption fails (rotated key) | Treated as `no_capi_credentials`-class failure with distinct log |

## 8. Testing (Vitest, colocated)

- `src/lib/capi/meta-capi.test.ts` — payload shape (hash, ph array,
  action_source/messaging_channel, custom_data omission,
  test_event_code omission), error parsing. Mock `fetch`.
- `src/lib/capi/fire-event.test.ts` — all guards, success writes
  (event row + timestamp), failure writes (failed row, no timestamp),
  refire generates new event_id, Lead forced for qualify.
- `src/app/api/v1/contacts/[id]/qualify/route.test.ts` and
  `convert/route.test.ts` — auth/scope, 404 cross-account, error-code
  mapping (pattern: `src/app/api/contacts/[id]/tags/route.test.ts`).
- Webhook capture cases in `src/app/api/whatsapp/webhook/route.test.ts`:
  referral present → stored; newer overwrites; absent → untouched;
  capture failure doesn't break processing.
- `src/lib/api-keys/scopes.test.ts` — new scopes present.
- Migration validated by the existing CI migration check.

## 9. File set

| Concern | Path |
|---|---|
| Migration | `supabase/migrations/040_capi_events.sql` |
| CAPI client + hashing | `src/lib/capi/meta-capi.ts` (+ test) |
| Business logic | `src/lib/capi/fire-event.ts` (+ test) |
| Scopes | `src/lib/api-keys/scopes.ts` |
| Public routes | `src/app/api/v1/contacts/[id]/qualify/route.ts`, `.../convert/route.ts` (+ tests) |
| Dashboard route | `src/app/api/contacts/[id]/capi/route.ts` (+ test) |
| Webhook capture | `src/app/api/whatsapp/webhook/route.ts` (+ existing test file) |
| Settings API | `src/app/api/whatsapp/config/route.ts` (extend) |
| Settings UI | `src/components/settings/whatsapp-config.tsx` (extend) |
| Contact UI | `src/components/capi/capi-actions.tsx` (new shared), `contact-sidebar.tsx`, `contact-detail-view.tsx` |
| Types / i18n / docs | `src/types/index.ts`, `messages/*`, `docs/public-api.md` |

## Out of scope (restating PRD)

No automatic firing, no phone-only firing, no retry queue, no
deal/pipeline integration, no un-qualify/un-convert, currency stays a
free-text ISO field with `INR` default.
