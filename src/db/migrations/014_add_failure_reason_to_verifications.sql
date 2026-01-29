ALTER TABLE verifications
ADD COLUMN IF NOT EXISTS failure_reason VARCHAR(100);
