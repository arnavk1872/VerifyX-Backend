ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS verification_rules JSONB DEFAULT '{}';

