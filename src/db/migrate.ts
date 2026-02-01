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

    const migration10 = readFileSync(join(__dirname, 'migrations/010_update_verification_status.sql'), 'utf-8');
    await client.query(migration10);
    console.log('✓ Migration 010: updated verification status field');

    const migration11 = readFileSync(join(__dirname, 'migrations/011_create_support_tickets.sql'), 'utf-8');
    await client.query(migration11);
    console.log('✓ Migration 011: support_tickets table created');

    const migration12 = readFileSync(join(__dirname, 'migrations/012_remove_display_name_from_verifications.sql'), 'utf-8');
    await client.query(migration12);
    console.log('✓ Migration 012: removed display_name from verifications table');

    const migration13 = readFileSync(join(__dirname, 'migrations/013_backfill_match_score_risk_level.sql'), 'utf-8');
    await client.query(migration13);
    console.log('✓ Migration 013: backfilled match_score and risk_level from AI results');

    const migration14 = readFileSync(join(__dirname, 'migrations/014_add_failure_reason_to_verifications.sql'), 'utf-8');
    await client.query(migration14);
    console.log('✓ Migration 014: added failure_reason to verifications');

    const migration15 = readFileSync(join(__dirname, 'migrations/015_verification_pii_confirmation.sql'), 'utf-8');
    await client.query(migration15);
    console.log('✓ Migration 015: verification_pii confirmation fields');

    const migration16 = readFileSync(join(__dirname, 'migrations/016_add_plan_to_organizations.sql'), 'utf-8');
    await client.query(migration16);
    console.log('✓ Migration 016: added plan to organizations');

    const migration17 = readFileSync(join(__dirname, 'migrations/017_verifications_timestamptz.sql'), 'utf-8');
    await client.query(migration17);
    console.log('✓ Migration 017: verifications timestamps to TIMESTAMPTZ');

    const migration18 = readFileSync(join(__dirname, 'migrations/018_webhook_config.sql'), 'utf-8');
    await client.query(migration18);
    console.log('✓ Migration 018: webhook_config table created');

    const migration19 = readFileSync(join(__dirname, 'migrations/019_add_country_modules_to_organizations.sql'), 'utf-8');
    await client.query(migration19);
    console.log('✓ Migration 019: country_modules added to organizations');

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

