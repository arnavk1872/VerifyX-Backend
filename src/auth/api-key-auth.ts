import { FastifyRequest } from 'fastify';
import { pool } from '../db/pool';
import { isValidPublicKey, isValidSecretKey, verifySecretKey } from './api-keys';
import { v4 as uuidv4 } from 'uuid';

export async function authenticateSecretKey(
  request: FastifyRequest
): Promise<{ organizationId: string } | null> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7).trim();

  if (!isValidSecretKey(token)) {
    return null;
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT id, organization_id, secret_key_hash, status 
       FROM api_keys 
       WHERE status = 'active'`
    );

    for (const row of result.rows) {
      const isValid = await verifySecretKey(token, row.secret_key_hash);
      if (isValid) {
        await client.query(
          `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
          [row.id]
        );

        const ipAddress = request.ip || (request.headers['x-forwarded-for'] as string) || 'unknown';
        await client.query(
          `INSERT INTO audit_logs (id, user_id, organization_id, action, target_id, ip_address)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            uuidv4(),
            null,
            row.organization_id,
            'api_key_used',
            row.id,
            ipAddress,
          ]
        );

        return { organizationId: row.organization_id };
      }
    }

    return null;
  } finally {
    client.release();
  }
}

export async function authenticatePublicKey(
  request: FastifyRequest
): Promise<{ organizationId: string } | null> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7).trim();

  if (!isValidPublicKey(token)) {
    return null;
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT organization_id, status 
       FROM api_keys 
       WHERE public_key = $1 AND status = 'active'`,
      [token]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return { organizationId: result.rows[0].organization_id };
  } finally {
    client.release();
  }
}

