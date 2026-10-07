# TODOS

## CAPI: in-product reader for the `capi_events` audit table
- **What:** Minimal "recent conversion events" list (last ~5 fires: event, status, error, test_mode, time) on the contact detail / CapiActions area, backed by a small account-scoped read (RLS SELECT policy already exists).
- **Why:** The audit table is write-only at launch; failure detail lives only in a transient toast, then requires SQL. Migration 040's comments promise operator visibility.
- **Pros:** Failures debuggable in-product; fulfills the schema's own rationale; index `(contact_id, created_at DESC)` already built for this read.
- **Cons:** One more route + component + i18n; low urgency until the first real failure investigation.
- **Context (2026-08-19, /plan-eng-review D14):** Ship of `docs/superpowers/plans/2026-08-18-capi-events.md` deliberately deferred this. Start point: `capi_events` table (migration 040), `CapiActions` in `src/components/capi/capi-actions.tsx`.
- **Depends on / blocked by:** CAPI feature merged (migration 040 + CapiActions in place).

## CAPI: "Clear credentials" button in settings
- **What:** Admin-only destructive action in the CAPI settings section: confirm → `PUT /api/whatsapp/config/capi` with `{ dataset_id: null, access_token: null, test_event_code: null }`.
- **Why:** The server supports clearing, but the form's blank-token-means-keep contract makes the null path unreachable; a leaked/revoked token can only be overwritten, not removed.
- **Pros:** Completes the credential lifecycle (set / rotate / remove); ~one button + confirm + 2 i18n strings; server contract already implemented and tested.
- **Cons:** One more destructive action to gate and copy to maintain.
- **Context (2026-08-19, /plan-eng-review D18):** Deliberately deferred at review. Start point: `src/components/settings/capi-settings-section.tsx`, PUT handler in `src/app/api/whatsapp/config/capi/route.ts` (clearing path already covered by its route test).
- **Depends on / blocked by:** CAPI settings section merged (plan Task 9).

## Broadcast recipients: `UNIQUE (broadcast_id, contact_id)` index
- **What:** Add a `UNIQUE (broadcast_id, contact_id)` index on `broadcast_recipients` in a new migration as the last line of defence against a contact being enqueued twice.
- **Why:** The unique index is missing today (checked migrations 001/003/005/037/038 — only the wamid index exists), so a duplicate enqueue is a double WhatsApp send rather than an insert error.
- **Pros:** The index makes any future duplicate an insert error instead of a double WhatsApp send.
- **Cons:** The index needs a backfill check for existing duplicate rows before it can be created.
- **Context (2026-09-27, /review of the wizard pagination fix; trimmed 2026-10-08):** The paging half of this entry was superseded by upstream #630 (merged 2026-10-08 via PR #1), which chunks every `.in()` list and pages with `.range()`; `fetch-all.ts` is gone. Related: CSV audiences apply exclude tags at send time but the estimate cannot reflect them (needs a phone → contact lookup); documented in `audience-estimate.ts`.
- **Depends on / blocked by:** Nothing.
