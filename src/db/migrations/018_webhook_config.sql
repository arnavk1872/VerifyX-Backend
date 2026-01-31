CREATE TABLE IF NOT EXISTS webhook_config (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events JSONB NOT NULL DEFAULT '{"verificationApproved":true,"verificationRejected":true,"manualReviewRequired":true,"documentUploaded":false,"verificationStarted":false}',
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_config_org ON webhook_config(organization_id);
