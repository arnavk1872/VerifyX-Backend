-- Country code for each verification (needed for document registry: IN vs SG passport, etc.)
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS country_code VARCHAR(2);

-- Backfill: nric -> SG, everything else -> IN
UPDATE verifications
SET country_code = CASE
  WHEN LOWER(id_type) = 'nric' THEN 'SG'
  ELSE 'IN'
END
WHERE country_code IS NULL;

-- New rows will be set by application; leave nullable for backward compatibility or set default
-- ALTER TABLE verifications ALTER COLUMN country_code SET NOT NULL;
