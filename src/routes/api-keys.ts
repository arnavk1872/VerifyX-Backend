import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/role-guard';
import { generateApiKeyPair, hashSecretKey } from '../auth/api-keys';

export async function apiKeyRoutes(fastify: FastifyInstance) {
  fastify.get('/api/api-keys', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    try {
      const client = await pool.connect();
      try {
        let result = await client.query(
          `SELECT id, public_key, status, created_at, last_used_at
           FROM api_keys
           WHERE organization_id = $1
           ORDER BY created_at DESC`,
          [user.organizationId]
        );

        if (result.rows.length === 0) {
          const { publicKey, secretKey } = generateApiKeyPair();
          const secretKeyHash = await hashSecretKey(secretKey);

          await client.query(
            `INSERT INTO api_keys (id, organization_id, public_key, secret_key_hash)
             VALUES ($1, $2, $3, $4)`,
            [uuidv4(), user.organizationId, publicKey, secretKeyHash]
          );

          result = await client.query(
            `SELECT id, public_key, status, created_at, last_used_at
             FROM api_keys
             WHERE organization_id = $1
             ORDER BY created_at DESC`,
            [user.organizationId]
          );
        }

        return reply.send({
          keys: result.rows.map((row) => ({
            id: row.id,
            publicKey: row.public_key,
            status: row.status,
            createdAt: row.created_at.toISOString(),
            lastUsedAt: row.last_used_at?.toISOString() || null,
          })),
          warning: 'Secret keys are only shown once during creation or rotation. If you lose your secret key, you must rotate your keys.',
        });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/api/api-keys/rotate', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const existingKeys = await client.query(
          `SELECT id FROM api_keys 
           WHERE organization_id = $1 AND status = 'active'`,
          [user.organizationId]
        );

        if (existingKeys.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ 
            error: 'No active API keys found',
            message: 'Cannot rotate keys when no active keys exist. API keys are created automatically during signup.'
          });
        }

        for (const keyRow of existingKeys.rows) {
          await client.query(
            `UPDATE api_keys SET status = 'inactive' WHERE id = $1`,
            [keyRow.id]
          );
        }

        const { publicKey, secretKey } = generateApiKeyPair();
        const secretKeyHash = await hashSecretKey(secretKey);

        await client.query(
          `INSERT INTO api_keys (id, organization_id, public_key, secret_key_hash)
           VALUES ($1, $2, $3, $4)`,
          [uuidv4(), user.organizationId, publicKey, secretKeyHash]
        );

        const ipAddress = request.ip || (request.headers['x-forwarded-for'] as string) || 'unknown';
        await client.query(
          `INSERT INTO audit_logs (id, user_id, organization_id, action, target_id, ip_address)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            uuidv4(),
            user.userId,
            user.organizationId,
            'api_key_rotated',
            null,
            ipAddress,
          ]
        );

        await client.query('COMMIT');

        return reply.send({
          publicKey,
          secretKey,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}

