import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { requireAuth } from '../../middleware/role-guard';
import { updatePlanSchema } from './schemas';

export async function registerOrganizationRoutes(fastify: FastifyInstance) {
  fastify.get('/api/dashboard/organizations', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    if (user.role !== 'SUPER_ADMIN') {
      return reply.code(403).send({ error: 'Forbidden: Only SUPER_ADMIN can access this endpoint' });
    }

    try {
      const page = parseInt((request.query as any).page || '1', 10);
      const limit = parseInt((request.query as any).limit || '10', 10);
      const offset = (page - 1) * limit;

      const client = await pool.connect();
      try {
        const countResult = await client.query(
          `SELECT COUNT(*) as total FROM organizations o
           WHERE EXISTS (SELECT 1 FROM users u WHERE u.organization_id = o.id AND u.role = 'KYC_ADMIN')`
        );
        const totalOrganizations = parseInt(countResult.rows[0].total, 10);

        const organizationsResult = await client.query(
          `SELECT 
            o.id,
            o.name,
            o.status,
            o.plan,
            o.created_at,
            COUNT(DISTINCT v.id) as total_verifications
          FROM organizations o
          LEFT JOIN verifications v ON o.id = v.organization_id
          WHERE EXISTS (SELECT 1 FROM users u WHERE u.organization_id = o.id AND u.role = 'KYC_ADMIN')
          GROUP BY o.id, o.name, o.status, o.plan, o.created_at
          ORDER BY o.created_at DESC
          LIMIT $1 OFFSET $2`,
          [limit, offset]
        );

        const organizations = organizationsResult.rows.map((row) => ({
          id: row.id,
          name: row.name,
          plan: row.plan ?? 'free',
          subscriptionType: row.plan ?? 'free',
          totalUsers: parseInt(row.total_verifications, 10),
          monthlyVolume: null,
          status: row.status,
          createdAt: row.created_at,
        }));

        return reply.send({
          total: totalOrganizations,
          data: organizations,
          page,
          limit,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  fastify.get('/api/dashboard/organizations/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    if (user.role !== 'SUPER_ADMIN') {
      return reply.code(403).send({ error: 'Forbidden: Only SUPER_ADMIN can access this endpoint' });
    }

    try {
      const { id } = request.params as { id: string };

      const client = await pool.connect();
      try {
        const orgResult = await client.query(
          `SELECT o.id, o.name, o.status, o.plan, o.created_at
           FROM organizations o WHERE o.id = $1`,
          [id]
        );
        if (orgResult.rows.length === 0) {
          return reply.code(404).send({ error: 'Organization not found' });
        }

        const countResult = await client.query(
          'SELECT COUNT(*) as total FROM verifications WHERE organization_id = $1',
          [id]
        );
        const verificationCount = parseInt(countResult.rows[0].total, 10);

        const row = orgResult.rows[0];
        return reply.send({
          id: row.id,
          name: row.name,
          status: row.status,
          plan: row.plan ?? 'free',
          createdAt: row.created_at,
          verificationCount,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  fastify.patch('/api/dashboard/organizations/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    if (user.role !== 'SUPER_ADMIN') {
      return reply.code(403).send({ error: 'Forbidden: Only SUPER_ADMIN can access this endpoint' });
    }

    try {
      const { id } = request.params as { id: string };
      const body = updatePlanSchema.parse(request.body || {});

      const client = await pool.connect();
      try {
        const updateResult = await client.query(
          `UPDATE organizations SET plan = $1 WHERE id = $2 RETURNING id, name, plan, status`,
          [body.plan, id]
        );
        if (updateResult.rows.length === 0) {
          return reply.code(404).send({ error: 'Organization not found' });
        }
        const row = updateResult.rows[0];
        return reply.send({
          id: row.id,
          name: row.name,
          plan: row.plan,
          status: row.status,
        });
      } finally {
        client.release();
      }
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Invalid request body', details: error.errors });
      }
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}
