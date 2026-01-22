import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool';
import { requireAuth, requireRole } from '../middleware/role-guard';
import { v4 as uuidv4 } from 'uuid';

const decisionSchema = z.object({
  status: z.enum(['Approved', 'Rejected', 'Flagged']),
  reviewNotes: z.string().optional(),
});

export async function dashboardRoutes(fastify: FastifyInstance) {
  fastify.get('/api/dashboard/user', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT u.id, u.email, u.role, o.name as organization_name
           FROM users u
           JOIN organizations o ON u.organization_id = o.id
           WHERE u.id = $1 AND u.organization_id = $2`,
          [user.userId, user.organizationId]
        );

        if (result.rows.length === 0) {
          return reply.code(404).send({ error: 'User not found' });
        }

        const row = result.rows[0];
        return reply.send({
          id: row.id,
          email: row.email,
          role: row.role,
          organizationName: row.organization_name,
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
        const totalResult = await client.query(
          `SELECT COUNT(*) as total FROM verifications WHERE organization_id = $1`,
          [user.organizationId]
        );
        const totalVerifications = parseInt(totalResult.rows[0].total, 10);

        const previousPeriodResult = await client.query(
          `SELECT COUNT(*) as total FROM verifications 
           WHERE organization_id = $1 AND created_at < NOW() - INTERVAL '30 days'`,
          [user.organizationId]
        );
        const previousTotal = parseInt(previousPeriodResult.rows[0].total, 10);
        const change = previousTotal > 0 
          ? `${Math.round(((totalVerifications - previousTotal) / previousTotal) * 100)}%`
          : '0%';

        const pendingResult = await client.query(
          `SELECT COUNT(*) as total FROM verifications 
           WHERE organization_id = $1 AND status = 'Pending'`,
          [user.organizationId]
        );
        const pendingReview = parseInt(pendingResult.rows[0].total, 10);

        const autoApprovedResult = await client.query(
          `SELECT COUNT(*) as total FROM verifications 
           WHERE organization_id = $1 AND is_auto_approved = true`,
          [user.organizationId]
        );
        const autoApproved = parseInt(autoApprovedResult.rows[0].total, 10);

        const flaggedResult = await client.query(
          `SELECT COUNT(*) as total FROM verifications 
           WHERE organization_id = $1 AND risk_level = 'High'`,
          [user.organizationId]
        );
        const flaggedHighRisk = parseInt(flaggedResult.rows[0].total, 10);

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

  fastify.get('/api/dashboard/verifications', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    try {
      const page = parseInt((request.query as any).page || '1', 10);
      const limit = parseInt((request.query as any).limit || '10', 10);
      const status = (request.query as any).status || 'All';
      const risk = (request.query as any).risk;
      const startDate = (request.query as any).startDate;
      const endDate = (request.query as any).endDate;

      const offset = (page - 1) * limit;

      let whereClauses = ['organization_id = $1'];
      const queryParams: any[] = [user.organizationId];
      let paramIndex = 2;

      if (status !== 'All') {
        whereClauses.push(`status = $${paramIndex}`);
        queryParams.push(status);
        paramIndex++;
      }

      if (risk) {
        whereClauses.push(`risk_level = $${paramIndex}`);
        queryParams.push(risk);
        paramIndex++;
      }

      if (startDate) {
        whereClauses.push(`created_at >= $${paramIndex}`);
        queryParams.push(startDate);
        paramIndex++;
      }

      if (endDate) {
        whereClauses.push(`created_at <= $${paramIndex}`);
        queryParams.push(endDate);
        paramIndex++;
      }

      const whereClause = whereClauses.join(' AND ');

      const client = await pool.connect();
      try {
        const countResult = await client.query(
          `SELECT COUNT(*) as total FROM verifications WHERE ${whereClause}`,
          queryParams
        );
        const totalCount = parseInt(countResult.rows[0].total, 10);

        const dataResult = await client.query(
          `SELECT id, display_name, id_type, match_score, risk_level, status, 
                  is_auto_approved, created_at, verified_at
           FROM verifications 
           WHERE ${whereClause}
           ORDER BY created_at DESC
           LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          [...queryParams, limit, offset]
        );

        const data = dataResult.rows.map((row) => ({
          id: row.id,
          displayName: row.display_name,
          date: row.created_at.toISOString().split('T')[0],
          idType: row.id_type,
          matchScore: row.match_score,
          riskLevel: row.risk_level,
          status: row.status,
          isAutoApproved: row.is_auto_approved,
        }));

        return reply.send({
          data,
          totalCount,
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

  fastify.get('/api/dashboard/verifications/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    try {
      const { id } = request.params as { id: string };

      const client = await pool.connect();
      try {
        const verificationResult = await client.query(
          `SELECT v.id, v.display_name, v.id_type, v.match_score, v.risk_level, 
                  v.status, v.created_at, v.verified_at, v.is_auto_approved,
                  ai.checks, ai.risk_signals,
                  pii.document_images
           FROM verifications v
           LEFT JOIN verification_ai_results ai ON v.id = ai.verification_id
           LEFT JOIN verification_pii pii ON v.id = pii.verification_id
           WHERE v.id = $1 AND v.organization_id = $2`,
          [id, user.organizationId]
        );

        if (verificationResult.rows.length === 0) {
          return reply.code(404).send({ error: 'Verification not found' });
        }

        const row = verificationResult.rows[0];
        const aiSummary = row.checks || row.risk_signals ? {
          liveness: row.checks?.liveness || 'unknown',
          faceMatch: row.checks?.faceMatch || 'unknown',
          documentValid: row.checks?.documentValid || false,
        } : null;

        return reply.send({
          id: row.id,
          displayName: row.display_name,
          idType: row.id_type,
          matchScore: row.match_score,
          riskLevel: row.risk_level,
          status: row.status,
          createdAt: row.created_at.toISOString(),
          verifiedAt: row.verified_at?.toISOString() || null,
          isAutoApproved: row.is_auto_approved,
          aiSummary,
          documents: row.document_images || null,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post(
    '/api/dashboard/verifications/:id/decision',
    { preHandler: requireRole(['KYC_ADMIN', 'SUPER_ADMIN']) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      try {
        const { id } = request.params as { id: string };
        const body = decisionSchema.parse(request.body);

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const verificationResult = await client.query(
            `SELECT id FROM verifications WHERE id = $1 AND organization_id = $2`,
            [id, user.organizationId]
          );

          if (verificationResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return reply.code(404).send({ error: 'Verification not found' });
          }

          await client.query(
            `UPDATE verifications 
             SET status = $1, verified_at = NOW(), updated_at = NOW()
             WHERE id = $2 AND organization_id = $3`,
            [body.status, id, user.organizationId]
          );

          const ipAddress = request.ip || (request.headers['x-forwarded-for'] as string) || 'unknown';
          await client.query(
            `INSERT INTO audit_logs (id, user_id, organization_id, action, target_id, ip_address)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              uuidv4(),
              user.userId,
              user.organizationId,
              `verification_${body.status.toLowerCase()}`,
              id,
              ipAddress,
            ]
          );

          await client.query('COMMIT');

          return reply.send({ success: true, status: body.status });
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
    }
  );

  fastify.get(
    '/api/dashboard/verifications/export',
    { preHandler: requireRole(['SUPER_ADMIN']) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      try {
        const format = (request.query as any).format || 'json';

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const result = await client.query(
            `SELECT display_name, id_type, match_score, risk_level, status, 
                    created_at, verified_at, is_auto_approved
             FROM verifications 
             WHERE organization_id = $1
             ORDER BY created_at DESC`,
            [user.organizationId]
          );

          const ipAddress = request.ip || (request.headers['x-forwarded-for'] as string) || 'unknown';
          await client.query(
            `INSERT INTO audit_logs (id, user_id, organization_id, action, target_id, ip_address)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              uuidv4(),
              user.userId,
              user.organizationId,
              'export_verifications',
              null,
              ipAddress,
            ]
          );

          await client.query('COMMIT');

          const data = result.rows.map((row) => ({
            displayName: row.display_name,
            idType: row.id_type,
            score: row.match_score,
            risk: row.risk_level,
            status: row.status,
            createdAt: row.created_at.toISOString(),
            verifiedAt: row.verified_at?.toISOString() || null,
            isAutoApproved: row.is_auto_approved,
          }));

          if (format === 'csv') {
            const headers = ['displayName', 'idType', 'score', 'risk', 'status', 'createdAt', 'verifiedAt', 'isAutoApproved'];
            const csvRows = [
              headers.join(','),
              ...data.map((row) =>
                headers.map((h) => {
                  const val = row[h as keyof typeof row];
                  return typeof val === 'string' && val.includes(',') ? `"${val}"` : val;
                }).join(',')
              ),
            ];
            reply.header('Content-Type', 'text/csv');
            reply.header('Content-Disposition', 'attachment; filename=verifications.csv');
            return reply.send(csvRows.join('\n'));
          }

          return reply.send({ data });
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
    }
  );
}

