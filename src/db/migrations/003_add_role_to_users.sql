ALTER TABLE users 
ADD COLUMN IF NOT EXISTS name VARCHAR(255),
ADD COLUMN IF NOT EXISTS role VARCHAR(50);

UPDATE users 
SET role = CASE 
  WHEN is_admin = true THEN 'SUPER_ADMIN'
  ELSE 'KYC_ADMIN'
END
WHERE role IS NULL;

ALTER TABLE users 
ALTER COLUMN role SET NOT NULL;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'check_role' 
    AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users 
    ADD CONSTRAINT check_role CHECK (role IN ('KYC_ADMIN', 'SUPER_ADMIN', 'AUDITOR'));
  END IF;
END $$;

