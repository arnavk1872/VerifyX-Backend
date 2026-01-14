import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { authenticatePublicKey } from '../utils/api-key-auth';
import jwt from 'jsonwebtoken';

const sessionSchema = z.object({
  idType: z.string().min(1),
  displayName: z.string().optional(),
});

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

const jwtSecret: string = JWT_SECRET;

export async function sdkRoutes(fastify: FastifyInstance) {
  fastify.post('/v1/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const apiKeyAuth = await authenticatePublicKey(request);
      if (!apiKeyAuth) {
        return reply.code(401).send({ error: 'Unauthorized: Invalid public key' });
      }

      const body = sessionSchema.parse(request.body);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const verificationId = uuidv4();
        await client.query(
          `INSERT INTO verifications (id, organization_id, id_type, display_name, status)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            verificationId,
            apiKeyAuth.organizationId,
            body.idType,
            body.displayName || null,
            'Pending',
          ]
        );

        const uploadToken = jwt.sign(
          {
            verificationId,
            organizationId: apiKeyAuth.organizationId,
            type: 'upload',
          },
          jwtSecret,
          { expiresIn: '1h' }
        );

        await client.query('COMMIT');

        return reply.send({
          sessionId: verificationId,
          uploadToken,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request body', details: error.errors });
      }
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}

