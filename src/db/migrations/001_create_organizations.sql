CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  status VARCHAR(32) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT now()
);


