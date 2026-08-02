-- ============================================================
-- whatsapp_config: add YCloud as a second WhatsApp provider
--
-- wacrm was Meta-Cloud-API-only: `phone_number_id` (Meta's numeric
-- id) + `access_token` (Meta long-lived token) were both NOT NULL,
-- and every inbound/outbound path assumed Meta.
--
-- YCloud is a WhatsApp BSP that doesn't require a Meta Business
-- Manager app/WABA setup — an account can go live with just an
-- API key. It routes on the WhatsApp number itself (E.164), not a
-- Meta phone_number_id.
--
-- This migration:
--   1. Adds `provider` ('meta' default | 'ycloud').
--   2. Adds `ycloud_api_key` (encrypted, same AES-256-GCM scheme as
--      `access_token` — see src/lib/whatsapp/encryption.ts) and
--      `ycloud_whatsapp_number` (E.164, unique — the YCloud analogue
--      of `phone_number_id`, used to route inbound webhooks to the
--      right account).
--   3. Relaxes `phone_number_id` / `access_token` to nullable — a
--      ycloud-only row never has Meta credentials.
--   4. Adds a CHECK constraint so a row is always internally
--      consistent for whichever provider it declares.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS ycloud_api_key TEXT,
  ADD COLUMN IF NOT EXISTS ycloud_whatsapp_number TEXT,
  -- Shared secret (random token, encrypted at rest like the other
  -- fields here) appended as `?key=` on the YCloud webhook URL YCloud
  -- POSTs to. YCloud's inbound webhook has no Meta-style HMAC signature
  -- confirmed yet, so this query-param secret is the auth boundary —
  -- see src/app/api/whatsapp/ycloud-webhook/route.ts.
  ADD COLUMN IF NOT EXISTS ycloud_webhook_secret TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_check
      CHECK (provider IN ('meta', 'ycloud'));
  END IF;
END $$;

-- Meta credentials are no longer universally required — only when
-- provider = 'meta' (enforced by the CHECK constraint below).
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_ycloud_whatsapp_number_key'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    -- Postgres UNIQUE allows multiple NULLs, so meta-only rows
    -- (ycloud_whatsapp_number IS NULL) don't conflict with each other.
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_ycloud_whatsapp_number_key
      UNIQUE (ycloud_whatsapp_number);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_fields_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_fields_check
      CHECK (
        (provider = 'meta' AND phone_number_id IS NOT NULL AND access_token IS NOT NULL)
        OR
        (provider = 'ycloud' AND ycloud_api_key IS NOT NULL AND ycloud_whatsapp_number IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_ycloud_number
  ON whatsapp_config (ycloud_whatsapp_number)
  WHERE ycloud_whatsapp_number IS NOT NULL;
