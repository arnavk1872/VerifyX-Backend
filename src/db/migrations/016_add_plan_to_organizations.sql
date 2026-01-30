ALTER TABLE organizations
ADD COLUMN IF NOT EXISTS plan VARCHAR(32) DEFAULT 'free';

UPDATE organizations SET plan = 'free' WHERE plan IS NULL;
