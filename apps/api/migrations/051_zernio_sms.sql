-- Text messages go through Zernio (or Podium). Twilio and Amazon SNS are gone: their saved settings are removed and
-- companies that used them are switched to "none" until Zernio is set up. In-app and push notifications are unaffected.
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_sms_provider_check;
UPDATE tenants SET sms_provider = 'none' WHERE sms_provider IN ('twilio', 'sns');
ALTER TABLE tenants ADD CONSTRAINT tenants_sms_provider_check CHECK (sms_provider IN ('none', 'zernio', 'podium'));

DELETE FROM integration_settings WHERE provider IN ('twilio', 'sns');
ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_provider_check;
ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_provider_check CHECK (provider IN ('ses', 'zernio', 'podium', 'rentman', 'quickbooks', 'academy'));
