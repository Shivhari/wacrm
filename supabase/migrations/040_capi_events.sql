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
