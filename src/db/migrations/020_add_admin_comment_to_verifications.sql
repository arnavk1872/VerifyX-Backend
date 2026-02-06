ALTER TABLE verifications
ADD COLUMN IF NOT EXISTS admin_comment TEXT;
