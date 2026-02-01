ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS country_modules JSONB DEFAULT '{}';
