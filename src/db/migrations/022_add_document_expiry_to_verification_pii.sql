ALTER TABLE verification_pii
ADD COLUMN IF NOT EXISTS document_expiry_date DATE;

ALTER TABLE verification_pii
ADD COLUMN IF NOT EXISTS document_expired BOOLEAN;

