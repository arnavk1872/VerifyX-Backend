CREATE TABLE IF NOT EXISTS verification_behavior (
  verification_id UUID PRIMARY KEY REFERENCES verifications(id) ON DELETE CASCADE,
  signals JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verification_behavior_verification_id
  ON verification_behavior(verification_id);

