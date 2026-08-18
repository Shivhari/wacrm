---
feature: capi-events
title: Meta CAPI conversion events (ctwa_clid capture, qualify, convert)
status: draft
created: 2026-08-18
---

> **Build rules (for the coding agent):** Build only what's in scope below. If you hit anything under **Open questions**, stop and ask — do not guess. Reuse existing notes in `/concepts`; if you need a new concept, flag it before creating it. Omit any empty section rather than padding it.

## What we're building

Human-triggered Meta Conversions API events on contacts: silent ctwa_clid capture from
inbound WhatsApp messages, plus operator actions "Mark qualified" (Lead) and "Mark
converted" (Purchase/Schedule) that fire CAPI events with ctwa_clid + hashed phone.

## User stories

- As an `operator`, I want the system to capture ctwa_clid silently from inbound messages.
  - [ ] Webhook handler extracts `referral.ctwa_clid` from inbound messages and stores it on the contact with a captured-at timestamp.
  - [ ] A newer ctwa_clid from a later message overwrites the stored one.
  - [ ] Capture is silent — no UI interruption, no automatic event fired.

- As an `operator`, I want to mark a contact qualified and fire the Lead event.
  - [ ] "Mark qualified" (contact sidebar + contact detail view) opens a plain confirm dialog, then fires a CAPI `Lead` event with ctwa_clid + hashed phone.
  - [ ] On success, `qualified_at` and event details are recorded; the button becomes inert.
  - [ ] Re-firing requires an explicit "fire again" action that generates a new `event_id`.
  - [ ] Button is disabled when the contact has no ctwa_clid or the account has no CAPI credentials.

- As an `operator`, I want to mark a contact converted and fire the conversion event.
  - [ ] "Mark converted" opens a confirm dialog: event name (`Purchase` default, `Schedule` selectable), value (numeric, optional), currency (default `INR`) — then fires the CAPI event with ctwa_clid + hashed phone.
  - [ ] On success, `converted_at` and event details are recorded; the button becomes inert.
  - [ ] Re-firing requires an explicit "fire again" action that generates a new `event_id`.
  - [ ] Button is disabled when the contact has no ctwa_clid or the account has no CAPI credentials.

- As an `operator`, I want to configure CAPI credentials per WhatsApp account.
  - [ ] Settings UI stores dataset (pixel) ID and access token per account.
  - [ ] Token is stored server-side and never returned in full to the client after saving.

- As an `api-client`, I want qualify and convert as authenticated endpoints.
  - [ ] `POST /api/v1/contacts/{id}/qualify` and `POST /api/v1/contacts/{id}/convert` behind `requireApiKey()` with scopes `contacts:qualify` / `contacts:convert`.
  - [ ] Endpoints enforce the same rules as the UI (inert-after-success, fire-again semantics, blocked without ctwa_clid).

## Decisions

- **Q:** Which CAPI events fire automatically?
  **→** None. Both tiers are human-triggered: Mark qualified → Lead, Mark converted → Purchase (or Schedule). The only automatic job is silent ctwa_clid capture.
  **why:** Tiered-events strategy — the human judges quality at both tiers; keeps unqualified contacts out of the dataset.
  **edges:** Service never decides anything about a contact on its own.

- **Q:** Conversion event name tiers?
  **→** `Purchase` (default) and `Schedule`, selectable in the confirm dialog.
  **why:** Both outcomes exist in the business; one dropdown costs nothing.

- **Q:** Contact has no ctwa_clid — fire with hashed phone only?
  **→** Block. Buttons/endpoints disabled without ctwa_clid.
  **why:** Keeps the dataset purely click-attributed. Phone-only firing noted in backlog.
  **edges:** UI shows why the button is disabled.

- **Q:** CAPI request fails (Meta down, bad token)?
  **→** Show error, record nothing on the contact, button stays active for manual retry. No retry queue.
  **why:** Human is right there; queue infra not worth it at this volume.

- **Q:** Qualify re-fire?
  **→** Same as convert: inert after success, explicit "fire again" with a new `event_id`.
  **why:** Consistent behavior across both tiers; escape hatch if a fire needs re-sending.

- **Q:** Must qualify precede convert?
  **→** No — tiers are independent.
  **why:** Human judgment; no enforced funnel order.

- **Q:** Tie into the existing deals/pipeline system?
  **→** No — contact-level actions only; deals untouched.
  **why:** Simple, matches source design; deal integration can come later.

- **Q:** Where do CAPI credentials live?
  **→** Per-account settings (dataset ID + access token), editable in settings UI.
  **why:** CRM is multi-account; each account may have its own Meta dataset.

- **Q:** Support Meta `test_event_code`?
  **→** Yes — optional per-account settings field; when set, it's sent with every fire so events land in Events Manager test mode.
  **why:** Lets fires be verified before going live; clearing the field switches to live delivery.
  **edges:** Field left blank = normal live events.

- **Q:** Phone hashing?
  **→** SHA-256 over E.164-normalized phone (digits only, country code, no `+`), per Meta CAPI spec.
  **why:** Meta's required normalization; wrong normalization silently breaks matching.

## Out of scope

- Automatic event firing of any kind (welcome/keyword-triggered, deal-won-triggered).
- Firing events for contacts without ctwa_clid (hashed-phone-only) — backlogged.
- Retry queue / background delivery for failed CAPI calls — manual retry instead.
- Deal/pipeline integration — conversion does not touch deal status.
- Un-qualify / un-convert (clearing the timestamps).
- Currency selection beyond a default — INR default, editable free-text ISO code in the dialog.

## Data & parameters

| field | type | allowed values / notes |
|-------|------|------------------------|
| `contacts.ctwa_clid` | text, nullable | latest captured click ID |
| `contacts.ctwa_clid_captured_at` | timestamptz, nullable | |
| `contacts.qualified_at` | timestamptz, nullable | set on successful Lead fire |
| `contacts.converted_at` | timestamptz, nullable | set on successful conversion fire |
| `capi_events.event_name` | text | `Lead` \| `Purchase` \| `Schedule` |
| `capi_events.event_id` | uuid | dedupe key sent to Meta; new one per "fire again" |
| `capi_events.value` / `currency` | numeric / text | currency default `INR` |
| `capi_events.status` | text | `success` \| `failed` (failed rows kept for audit) |
| account CAPI settings | | `dataset_id` (text), `access_token` (text, write-only to client), `test_event_code` (text, nullable) |
| API scopes | | `contacts:qualify`, `contacts:convert` |
| CAPI endpoint | | Meta Graph API `POST /{dataset_id}/events`, latest stable version |

## Linked

- [[contact]]
- [[account]]
- [[capi-event]]
- [[ctwa-clid]]
