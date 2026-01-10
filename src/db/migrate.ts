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

