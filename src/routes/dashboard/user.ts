import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../../db/pool';
import { requireAuth } from '../../middleware/role-guard';

export async function registerUserRoutes(fastify: FastifyInstance) {
  fastify.get('/api/dashboard/user', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT u.id, u.email, u.role, o.name as organization_name, o.plan as organization_plan
           FROM users u
           JOIN organizations o ON u.organization_id = o.id
           WHERE u.id = $1 AND u.organization_id = $2`,
          [user.userId, user.organizationId]
        );

        if (result.rows.length === 0) {
          return reply.code(404).send({ error: 'User not found' });
        }

        const row = result.rows[0];
        const plan = row.role === 'SUPER_ADMIN' ? null : (row.organization_plan ?? 'free');
        let verificationCount: number | null = null;
        if (row.role !== 'SUPER_ADMIN') {
          const countResult = await client.query(
            `SELECT COUNT(*) as total FROM verifications
             WHERE organization_id = $1 AND created_at >= date_trunc('month', NOW())`,
            [user.organizationId]
          );
          verificationCount = parseInt(countResult.rows[0].total, 10);
        }
        return reply.send({
          id: row.id,
          email: row.email,
          role: row.role,
          organizationName: row.organization_name,
          plan,
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

  fastify.get('/api/dashboard/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    try {
      const client = await pool.connect();
      try {
        const statsResult = await client.query(
          `SELECT 
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '30 days') as previous_total,
            COUNT(*) FILTER (WHERE status = 'Completed') as pending,
            COUNT(*) FILTER (WHERE is_auto_approved = true) as auto_approved,
            COUNT(*) FILTER (WHERE risk_level = 'High') as flagged
           FROM verifications 
           WHERE organization_id = $1`,
          [user.organizationId]
        );

        const row = statsResult.rows[0];
        const totalVerifications = parseInt(row.total, 10);
        const previousTotal = parseInt(row.previous_total, 10);
        const change = previousTotal > 0 
          ? `${Math.round(((totalVerifications - previousTotal) / previousTotal) * 100)}%`
          : '0%';
        const pendingReview = parseInt(row.pending, 10);
        const autoApproved = parseInt(row.auto_approved, 10);
        const flaggedHighRisk = parseInt(row.flagged, 10);

        return reply.send({
          totalVerifications,
          totalVerificationsChange: change,
          pendingReview,
          autoApproved,
          flaggedHighRisk,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}
