import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { hashPassword, verifyPassword } from '../auth/password';
import { generateToken } from '../auth/jwt';
import { SignupBody, LoginBody } from '../types/auth';
import { generateApiKeyPair, hashSecretKey } from '../auth/api-keys';
import { sendPasswordResetCode } from '../services/email';

const signupSchema = z.object({
  organization_name: z.string().min(1).max(255),
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6).regex(/^\d+$/),
  password: z.string().min(8),
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
          [userId, organizationId, body.email, passwordHash, true, 'KYC_ADMIN']
        );

        const { publicKey, secretKey } = generateApiKeyPair();
        const secretKeyHash = await hashSecretKey(secretKey);

        await client.query(
          'INSERT INTO api_keys (id, organization_id, public_key, secret_key_hash) VALUES ($1, $2, $3, $4)',
          [uuidv4(), organizationId, publicKey, secretKeyHash]
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
          apiKeys: {
            publicKey,
            secretKey,
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

  fastify.post('/auth/forgot-password', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = forgotPasswordSchema.parse(request.body);

      const client = await pool.connect();
      try {
        const userResult = await client.query(
          'SELECT id, email FROM users WHERE email = $1',
          [body.email]
        );

        if (userResult.rows.length === 0) {
          return reply.send({ 
            message: 'If that email exists, a password reset link has been sent.' 
          });
        }

        const user = userResult.rows[0];

        await client.query('BEGIN');

        await client.query(
          `UPDATE password_resets SET used_at = NOW() 
           WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
          [user.id]
        );

        const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + 15);

        await client.query(
          `INSERT INTO password_resets (id, user_id, token, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [uuidv4(), user.id, resetCode, expiresAt]
        );

        await client.query('COMMIT');

        try {
          await sendPasswordResetCode(user.email, resetCode);
        } catch (error: any) {
          fastify.log.error('Failed to send password reset email:', error);
          fastify.log.error('Error details:', error.message || error);
          return reply.code(500).send({ 
            error: 'Failed to send password reset email. Please try again later.' 
          });
        }

        return reply.send({ 
          message: 'If that email exists, a password reset code has been sent.',
        });
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

  fastify.post('/auth/reset-password', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = resetPasswordSchema.parse(request.body);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const userResult = await client.query(
          'SELECT id FROM users WHERE email = $1',
          [body.email]
        );

        if (userResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'Invalid email or code' });
        }

        const userId = userResult.rows[0].id;

        const resetResult = await client.query(
          `SELECT user_id, expires_at, used_at
           FROM password_resets
           WHERE user_id = $1 AND token = $2 AND used_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1`,
          [userId, body.code]
        );

        if (resetResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'Invalid or expired reset code' });
        }

        const reset = resetResult.rows[0];

        if (new Date(reset.expires_at) < new Date()) {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'Reset code has expired' });
        }

        const passwordHash = await hashPassword(body.password);

        await client.query(
          'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
          [passwordHash, userId]
        );

        await client.query(
          'UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND token = $2',
          [userId, body.code]
        );

        await client.query('COMMIT');

        return reply.send({ 
          message: 'Password has been reset successfully' 
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

