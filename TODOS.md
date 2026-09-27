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

## Broadcast resume + detail page: unpaginated recipient reads past 1 000
- **What:** Page the `broadcast_recipients` reads in `planBroadcastResume` (`src/lib/whatsapp/broadcast-resume.ts`, the `.in('status', …).order('created_at')` select) and on the broadcast detail page (`src/app/(dashboard)/broadcasts/[id]/page.tsx`, the recipients query behind `pendingCount`) with `fetchAllRows` from `src/lib/supabase/fetch-all.ts`. Add a `UNIQUE (broadcast_id, contact_id)` index on `broadcast_recipients` in a new migration as the last line of defence against a contact being enqueued twice.
- **Why:** PostgREST caps both reads at 1 000 rows silently. Resume slices `RESUME_MAX_PER_REQUEST` off a list that is already capped, so `remaining` reports 0 for a backlog over 1 000 and the UI says the whole backlog is queued; the detail page under-reports `pendingCount` and hides the Resume button once a stuck campaign exceeds 1 000 pending. Only the wizard's reads were paged on 2026-09-27; these were out of that diff. The unique index is missing today (checked migrations 001/003/005/037/038 — only the wamid index exists).
- **Pros:** Same helper, mechanical change; the index makes any future duplicate an insert error instead of a double WhatsApp send.
- **Cons:** Detail page is a server component with its own query shape; the index needs a backfill check for existing duplicate rows before it can be created.
- **Context (2026-09-27, /review of the wizard pagination fix):** Flagged by the adversarial pass as load-bearing for the wizard's "Use Resume to continue" error path. Related: CSV audiences apply exclude tags at send time but the estimate cannot reflect them (needs a phone → contact lookup); documented in `audience-estimate.ts`.
- **Depends on / blocked by:** Wizard pagination fix landed (fetch-all.ts, resolve-audience.ts).
