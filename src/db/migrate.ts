import { readFileSync } from 'fs';
import { join } from 'path';
import { pool } from './pool';

async function runMigrations() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const migration1 = readFileSync(join(__dirname, 'migrations/001_create_organizations.sql'), 'utf-8');
    await client.query(migration1);
    console.log('✓ Migration 001: organizations table created');

    const migration2 = readFileSync(join(__dirname, 'migrations/002_create_users.sql'), 'utf-8');
    await client.query(migration2);
    console.log('✓ Migration 002: users table created');

    const migration3 = readFileSync(join(__dirname, 'migrations/003_add_role_to_users.sql'), 'utf-8');
    await client.query(migration3);
    console.log('✓ Migration 003: added role to users table');

    const migration4 = readFileSync(join(__dirname, 'migrations/004_create_verifications.sql'), 'utf-8');
    await client.query(migration4);
    console.log('✓ Migration 004: verifications table created');

    const migration5 = readFileSync(join(__dirname, 'migrations/005_create_verification_pii.sql'), 'utf-8');
    await client.query(migration5);
    console.log('✓ Migration 005: verification_pii table created');

    const migration6 = readFileSync(join(__dirname, 'migrations/006_create_verification_ai_results.sql'), 'utf-8');
    await client.query(migration6);
    console.log('✓ Migration 006: verification_ai_results table created');

    const migration7 = readFileSync(join(__dirname, 'migrations/007_create_audit_logs.sql'), 'utf-8');
    await client.query(migration7);
    console.log('✓ Migration 007: audit_logs table created');

    const migration8 = readFileSync(join(__dirname, 'migrations/008_create_api_keys.sql'), 'utf-8');
    await client.query(migration8);
    console.log('✓ Migration 008: api_keys table created');

    const migration9 = readFileSync(join(__dirname, 'migrations/009_create_password_resets.sql'), 'utf-8');
    await client.query(migration9);
    console.log('✓ Migration 009: password_resets table created');

    await client.query('COMMIT');
    console.log('✓ All migrations completed successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('✗ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((error) => {
  console.error('Migration error:', error);
  process.exit(1);
});

