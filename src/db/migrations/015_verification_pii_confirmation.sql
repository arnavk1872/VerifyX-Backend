ALTER TABLE verification_pii
ADD COLUMN IF NOT EXISTS confirmation_status VARCHAR(20) CHECK (confirmation_status IN ('not_edited', 'edited')),
ADD COLUMN IF NOT EXISTS edited_fields JSONB,
ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP;
