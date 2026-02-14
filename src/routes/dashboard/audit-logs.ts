import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../../db/pool';
import { requireAuth, requireRole } from '../../middleware/role-guard';

export async function registerAuditLogRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/api/dashboard/audit-logs',
    { preHandler: requireRole(['KYC_ADMIN', 'SUPER_ADMIN']) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      try {
        const q = request.query as {
          page?: string;
          limit?: string;
          action?: string;
          startDate?: string;
          endDate?: string;
        };

        const page = Math.max(1, parseInt(q.page || '1', 10));
        const limit = Math.min(100, Math.max(1, parseInt(q.limit || '20', 10)));
        const offset = (page - 1) * limit;

        const whereClauses: string[] = ['al.organization_id = $1'];
        const queryParams: unknown[] = [user.organizationId];
        let paramIndex = 2;

        if (q.action && q.action.trim()) {
          whereClauses.push(`al.action = $${paramIndex}`);
          queryParams.push(q.action.trim());
          paramIndex++;
        }

        if (q.startDate) {
          whereClauses.push(`al.created_at >= $${paramIndex}::timestamptz`);
          queryParams.push(`${q.startDate}T00:00:00.000Z`);
          paramIndex++;
        }

        if (q.endDate) {
          whereClauses.push(`al.created_at <= $${paramIndex}::timestamptz`);
          queryParams.push(`${q.endDate}T23:59:59.999Z`);
          paramIndex++;
        }

        const whereSql = whereClauses.join(' AND ');

        const countResult = await pool.query(
          `SELECT COUNT(*)::int as total FROM audit_logs al WHERE ${whereSql}`,
          queryParams
        );
        const totalCount = countResult.rows[0]?.total ?? 0;

        const dataResult = await pool.query(
          `SELECT al.id, al.action, al.created_at, al.target_id, al.ip_address, u.email as user_email
           FROM audit_logs al
           LEFT JOIN users u ON al.user_id = u.id
           WHERE ${whereSql}
           ORDER BY al.created_at DESC
           LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          [...queryParams, limit, offset]
        );

        const data = dataResult.rows.map((row: { id: string; action: string; created_at: Date; target_id: string | null; ip_address: string | null; user_email: string | null }) => ({
          id: row.id,
          action: row.action || 'unknown',
          createdAt: row.created_at.toISOString(),
          userEmail: row.user_email || 'System',
          ipAddress: row.ip_address || null,
          targetId: row.target_id || null,
        }));

        return reply.send({
          data,
          totalCount,
          page,
          limit,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }
  );
}
