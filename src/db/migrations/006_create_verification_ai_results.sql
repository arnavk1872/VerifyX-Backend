CREATE TABLE IF NOT EXISTS verification_ai_results (
  verification_id UUID PRIMARY KEY REFERENCES verifications(id) ON DELETE CASCADE,

  provider VARCHAR(50),
  raw_response JSONB,
  checks JSONB,
  risk_signals JSONB,

  created_at TIMESTAMP DEFAULT NOW()
);

