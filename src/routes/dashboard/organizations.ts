import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { requireAuth, requireRole } from '../../middleware/role-guard';
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

  fastify.get(
    '/api/dashboard/organizations/:id/verifications',
    { preHandler: requireRole(['SUPER_ADMIN']) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      try {
        const { id: orgId } = request.params as { id: string };
        const page = parseInt((request.query as any).page || '1', 10);
        const limit = parseInt((request.query as any).limit || '10', 10);
        const status = (request.query as any).status || 'All';
        const risk = (request.query as any).risk;
        const startDate = (request.query as any).startDate;
        const endDate = (request.query as any).endDate;
        const search = typeof (request.query as any).search === 'string' ? (request.query as any).search.trim() : '';

        const offset = (page - 1) * limit;

        const client = await pool.connect();
        try {
          const orgCheck = await client.query('SELECT id FROM organizations WHERE id = $1', [orgId]);
          if (orgCheck.rows.length === 0) {
            return reply.code(404).send({ error: 'Organization not found' });
          }

          let whereClauses = ['v.organization_id = $1'];
          const queryParams: any[] = [orgId];
          let paramIndex = 2;

          if (status !== 'All') {
            if (status === 'Pending') {
              whereClauses.push(`v.status IN ('pending','documents_uploaded','liveness_uploaded','processing')`);
            } else {
              whereClauses.push(`v.status = $${paramIndex}`);
              queryParams.push(status);
              paramIndex++;
            }
          }
          if (risk) {
            whereClauses.push(`v.risk_level = $${paramIndex}`);
            queryParams.push(risk);
            paramIndex++;
          }
          if (startDate) {
            whereClauses.push(`v.created_at >= $${paramIndex}::date`);
            queryParams.push(startDate);
            paramIndex++;
          }
          if (endDate) {
            whereClauses.push(`v.created_at < ($${paramIndex}::date + interval '1 day')`);
            queryParams.push(endDate);
            paramIndex++;
          }
          if (search) {
            whereClauses.push(`pii.full_name ILIKE $${paramIndex}`);
            queryParams.push(`%${search}%`);
            paramIndex++;
          }

          const whereClause = whereClauses.join(' AND ');

          const countResult = await client.query(
            `SELECT COUNT(*) as total FROM verifications v
             LEFT JOIN verification_pii pii ON v.id = pii.verification_id
             WHERE ${whereClause}`,
            queryParams
          );
          const totalCount = parseInt(countResult.rows[0].total, 10);

          const dataResult = await client.query(
            `SELECT v.id, v.display_id, v.id_type, v.match_score, v.risk_level, v.status,
                    v.is_auto_approved, v.verified_at, v.failure_reason,
                    pii.full_name,
                    to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at_utc
             FROM verifications v
             LEFT JOIN verification_pii pii ON v.id = pii.verification_id
             WHERE ${whereClause}
             ORDER BY v.created_at DESC
             LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            [...queryParams, limit, offset]
          );

          const formatIdType = (idType: string | null): string => {
            if (!idType) return 'N/A';
            return idType.charAt(0).toUpperCase() + idType.slice(1).toLowerCase();
          };
          const normalizeStatus = (s: string | null): string => {
            if (!s) return 'Pending';
            if (['pending', 'documents_uploaded', 'liveness_uploaded', 'processing'].includes(s)) return 'Pending';
            return s;
          };

          const data = dataResult.rows.map((row: any) => {
            const iso = row.created_at_utc ?? (row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString());
            const isoNorm = (typeof iso === 'string' && iso.endsWith('Z')) ? iso : (typeof iso === 'string' ? iso.replace(/\.?\d*$/, '') + 'Z' : new Date(iso).toISOString());
            return {
              id: row.id,
              displayId: row.display_id || null,
              displayName: row.full_name || 'N/A',
              date: isoNorm.split('T')[0],
              createdAt: isoNorm,
              idType: formatIdType(row.id_type),
              matchScore: row.match_score ?? null,
              riskLevel: row.risk_level ?? null,
              status: normalizeStatus(row.status),
              failureReason: row.failure_reason ?? null,
              isAutoApproved: row.is_auto_approved || false,
            };
          });

          return reply.send({ data, totalCount, page, limit });
        } finally {
          client.release();
        }
      } catch (error) {
        fastify.log.error(error);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }
  );

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
