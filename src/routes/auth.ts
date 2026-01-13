import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { hashPassword, verifyPassword } from '../utils/password';
import { generateToken } from '../utils/jwt';
import { SignupBody, LoginBody } from '../types/auth';

const signupSchema = z.object({
  organization_name: z.string().min(1).max(255),
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/auth/signup', async (request: FastifyRequest<{ Body: SignupBody }>, reply: FastifyReply) => {
    try {
      const body = signupSchema.parse(request.body);

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const emailCheck = await client.query('SELECT id FROM users WHERE email = $1', [body.email]);
        if (emailCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'Email already exists' });
        }

        const orgResult = await client.query(
          'INSERT INTO organizations (id, name) VALUES ($1, $2) RETURNING id',
          [uuidv4(), body.organization_name]
        );
        const organizationId = orgResult.rows[0].id;

        const passwordHash = await hashPassword(body.password);
        const userId = uuidv4();

        const userResult = await client.query(
          'INSERT INTO users (id, organization_id, email, password_hash, is_admin, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, organization_id, role',
          [userId, organizationId, body.email, passwordHash, true, 'SUPER_ADMIN']
        );

        await client.query('COMMIT');

        const user = userResult.rows[0];
        const token = generateToken({
          userId: user.id,
          organizationId: user.organization_id,
          email: user.email,
          role: user.role,
        });

        return reply.code(201).send({
          token,
          user: {
            id: user.id,
            email: user.email,
            organization_id: user.organization_id,
          },
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

  fastify.post('/auth/login', async (request: FastifyRequest<{ Body: LoginBody }>, reply: FastifyReply) => {
    try {
      const body = loginSchema.parse(request.body);

      const result = await pool.query(
        'SELECT id, organization_id, email, password_hash, role FROM users WHERE email = $1',
        [body.email]
      );

      if (result.rows.length === 0) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      const user = result.rows[0];
      const isValidPassword = await verifyPassword(body.password, user.password_hash);

      if (!isValidPassword) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      const token = generateToken({
        userId: user.id,
        organizationId: user.organization_id,
        email: user.email,
        role: user.role,
      });

      return reply.send({
        token,
        user: {
          id: user.id,
          email: user.email,
          organization_id: user.organization_id,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request body', details: error.errors });
      }
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}

