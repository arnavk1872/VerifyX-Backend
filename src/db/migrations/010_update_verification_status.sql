ALTER TABLE verifications 
DROP CONSTRAINT IF EXISTS verifications_status_check;

ALTER TABLE verifications 
ALTER COLUMN status TYPE VARCHAR(50);

