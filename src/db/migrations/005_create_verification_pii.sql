CREATE TABLE IF NOT EXISTS verification_pii (
  verification_id UUID PRIMARY KEY REFERENCES verifications(id) ON DELETE CASCADE,

  full_name TEXT,
  dob DATE,
  id_number TEXT,
  address TEXT,

  face_embedding BYTEA,
  document_images JSONB,
  extracted_fields JSONB,

  encrypted_at TIMESTAMP DEFAULT NOW()
);

