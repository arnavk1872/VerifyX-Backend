import dotenv from 'dotenv';
import path from 'path';

process.env.NODE_ENV = 'test';

// Load .env.test first, fallback to .env for local development
dotenv.config({ path: path.resolve(process.cwd(), '.env.test') });
dotenv.config();

// Ensure JWT_SECRET is set for tests (required by jwt.ts)
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-jwt-secret-for-ci';
}

// Default test DB URL so pool module doesn't throw at import.
// Override via .env.test for your local test database.
// API/integration tests require a running PostgreSQL instance.
if (!process.env.DB_CONNECTION_STRING) {
  process.env.DB_CONNECTION_STRING = 'postgresql://localhost:5432/verifyx_test';
}
