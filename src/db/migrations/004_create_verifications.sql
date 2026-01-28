CREATE TABLE IF NOT EXISTS verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),

  id_type VARCHAR(50) NOT NULL,
  match_score INTEGER CHECK (match_score BETWEEN 0 AND 100),
  risk_level VARCHAR(10) CHECK (risk_level IN ('Low', 'Medium', 'High')),
  status VARCHAR(20) CHECK (status IN ('Approved', 'Pending', 'Flagged', 'Rejected')),

  is_auto_approved BOOLEAN DEFAULT FALSE,

  created_at TIMESTAMP DEFAULT NOW(),
  verified_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verifications_org ON verifications(organization_id);
CREATE INDEX IF NOT EXISTS idx_verifications_status ON verifications(status);
CREATE INDEX IF NOT EXISTS idx_verifications_risk ON verifications(risk_level);
CREATE INDEX IF NOT EXISTS idx_verifications_created ON verifications(created_at);

