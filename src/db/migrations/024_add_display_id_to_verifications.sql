-- User-viewable unique ID for each verification (e.g. VRF-000001)
CREATE SEQUENCE IF NOT EXISTS verification_display_id_seq;

ALTER TABLE verifications ADD COLUMN IF NOT EXISTS display_id VARCHAR(16);

-- Backfill existing rows with VRF-000001, VRF-000002, ...
UPDATE verifications v
SET display_id = sub.did
FROM (
  SELECT id, 'VRF-' || LPAD(row_number() OVER (ORDER BY created_at)::text, 6, '0') AS did
  FROM verifications
) sub
WHERE v.id = sub.id AND v.display_id IS NULL;

-- Set sequence so next value is max + 1
SELECT setval(
  'verification_display_id_seq',
  COALESCE(
    (SELECT MAX(CAST(SUBSTRING(display_id FROM 5) AS INTEGER)) FROM verifications WHERE display_id ~ '^VRF-\d+$'),
    0
  ) + 1
);

ALTER TABLE verifications ALTER COLUMN display_id SET NOT NULL;
ALTER TABLE verifications ALTER COLUMN display_id SET DEFAULT ('VRF-' || LPAD(nextval('verification_display_id_seq')::text, 6, '0'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_verifications_display_id ON verifications(display_id);
