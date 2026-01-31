-- Store verifications timestamps in UTC so node-pg returns correct Date and clients can show local time.
-- Treat existing timestamp without time zone values as UTC (server timezone is often UTC).
ALTER TABLE verifications
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN verified_at TYPE TIMESTAMPTZ USING verified_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
