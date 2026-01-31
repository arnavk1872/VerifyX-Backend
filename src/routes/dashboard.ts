import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool';
import { requireAuth, requireRole } from '../middleware/role-guard';
import { v4 as uuidv4 } from 'uuid';
import { getSignedS3Url } from '../services/aws/s3';

const decisionSchema = z.object({
  status: z.enum(['Approved', 'Rejected', 'Flagged']),
  reviewNotes: z.string().optional(),
});

function sanitizeDocumentImages(doc: Record<string, any> | null): Record<string, any> | null {
  if (!doc || typeof doc !== 'object') return doc;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v && typeof v === 'object' && v.s3Key) {
      out[k] = { ...v, url: undefined };
    }
  }
  return Object.keys(out).length ? out : null;
}

export async function dashboardRoutes(fastify: FastifyInstance) {
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
            COUNT(*) FILTER (WHERE status = 'Pending') as pending,
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
      const search = typeof (request.query as any).search === 'string' ? (request.query as any).search.trim() : '';

      const offset = (page - 1) * limit;

      let whereClauses = ['v.organization_id = $1'];
      const queryParams: any[] = [user.organizationId];
      let paramIndex = 2;

      if (status !== 'All') {
        const dbStatus = status === 'Approved' ? 'completed' : status === 'Rejected' ? 'failed' : status;
        whereClauses.push(`v.status = $${paramIndex}`);
        queryParams.push(dbStatus);
        paramIndex++;
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

      const client = await pool.connect();
      try {
        const countResult = await client.query(
          `SELECT COUNT(*) as total FROM verifications v
           LEFT JOIN verification_pii pii ON v.id = pii.verification_id
           WHERE ${whereClause}`,
          queryParams
        );
        const totalCount = parseInt(countResult.rows[0].total, 10);

        const dataResult = await client.query(
          `SELECT v.id, v.id_type, v.match_score, v.risk_level, v.status, 
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
          if (s === 'completed') return 'Approved';
          if (s === 'failed') return 'Rejected';
          return s;
        };

        const data = dataResult.rows.map((row) => {
          const iso = row.created_at_utc ?? (row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at as string).toISOString());
          const isoNorm = iso.endsWith('Z') ? iso : iso.replace(/\.?\d*$/, '') + 'Z';
          return {
          id: row.id,
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
          `SELECT v.id, v.id_type, v.match_score, v.risk_level, 
                  v.status, v.created_at, v.verified_at, v.is_auto_approved,
                  ai.checks, ai.risk_signals, ai.raw_response,
                  pii.document_images, pii.full_name, pii.dob, pii.id_number, pii.address, pii.extracted_fields
           FROM verifications v
           LEFT JOIN verification_ai_results ai ON v.id = ai.verification_id
           LEFT JOIN verification_pii pii ON v.id = pii.verification_id
           WHERE v.id = $1 AND v.organization_id = $2`,
          [id, user.organizationId]
        );

        const auditLogsResult = await client.query(
          `SELECT al.action, al.created_at, u.email as user_email
           FROM audit_logs al
           LEFT JOIN users u ON al.user_id = u.id
           WHERE al.target_id = $1 AND al.organization_id = $2
           ORDER BY al.created_at DESC
           LIMIT 10`,
          [id, user.organizationId]
        );

        if (verificationResult.rows.length === 0) {
          return reply.code(404).send({ error: 'Verification not found' });
        }

        const row = verificationResult.rows[0];
        const formatIdType = (idType: string | null): string => {
          if (!idType) return 'N/A';
          return idType.charAt(0).toUpperCase() + idType.slice(1).toLowerCase();
        };

        const rawResponse = row.raw_response || {};
        const ocrData = rawResponse.ocr || {};
        const extracted = ocrData.extracted || {};
        
        const faceMatchValue = row.checks?.faceMatch;
        let faceMatchPercentage = null;
        if (faceMatchValue === 'detected') {
          faceMatchPercentage = 100;
        } else if (faceMatchValue && typeof faceMatchValue === 'string' && faceMatchValue.includes('%')) {
          faceMatchPercentage = parseFloat(faceMatchValue.replace('%', ''));
        } else if (row.match_score !== null) {
          faceMatchPercentage = row.match_score;
        }

        return reply.send({
          id: row.id,
          displayName: row.full_name || 'N/A',
          idType: formatIdType(row.id_type),
          matchScore: row.match_score ?? null,
          riskLevel: row.risk_level ?? null,
          status: row.status || 'Pending',
          createdAt: row.created_at.toISOString(),
          verifiedAt: row.verified_at?.toISOString() || null,
          isAutoApproved: row.is_auto_approved || false,
          aiSummary: row.checks || row.risk_signals ? {
            liveness: row.checks?.liveness || 'unknown',
            faceMatch: row.checks?.faceMatch || 'unknown',
            documentValid: row.checks?.documentValid || false,
          } : null,
          documents: sanitizeDocumentImages(row.document_images),
          ocrData: {
            extracted: {
              fullName: extracted.fullName || row.full_name || null,
              idNumber: extracted.idNumber || row.id_number || null,
              dob: extracted.dob || row.dob || null,
              address: extracted.address || row.address || null,
            },
            rawText: ocrData.rawText || null,
            extractedFields: row.extracted_fields || {},
          },
          checks: row.checks || {},
          riskSignals: row.risk_signals || {},
          rawResponse: row.raw_response || {},
          faceMatchPercentage,
          activityLog: auditLogsResult.rows.map(log => ({
            action: log.action || 'Unknown action',
            timestamp: log.created_at.toISOString(),
            user: log.user_email || 'System',
          })),
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
    '/api/dashboard/verifications/:id/documents/presigned-urls',
    { preHandler: requireRole(['KYC_ADMIN', 'SUPER_ADMIN']) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      try {
        const { id } = request.params as { id: string };
        const client = await pool.connect();
        try {
          const verificationResult = await client.query(
            `SELECT pii.document_images FROM verifications v
             LEFT JOIN verification_pii pii ON v.id = pii.verification_id
             WHERE v.id = $1 AND v.organization_id = $2`,
            [id, user.organizationId]
          );
          if (verificationResult.rows.length === 0) {
            return reply.code(404).send({ error: 'Verification not found' });
          }
          const documentImages = verificationResult.rows[0]?.document_images || {};
          const expiresIn = 600;
          const result: Record<string, string> = {};
          for (const key of ['document', 'liveness', 'document_front', 'document_back']) {
            const entry = documentImages[key];
            const s3Key = entry?.s3Key;
            if (s3Key && typeof s3Key === 'string') {
              try {
                result[key] = await getSignedS3Url(s3Key, expiresIn);
              } catch (err) {
                fastify.log.warn({ err, key, verificationId: id }, 'Presign failed for key');
              }
            }
          }
          return reply.send(result);
        } finally {
          client.release();
        }
      } catch (error) {
        fastify.log.error(error);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }
  );

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

          const failureReason =
            body.status === 'Rejected' || body.status === 'Flagged'
              ? (body.reviewNotes?.trim() || null)
              : null;
          await client.query(
            `UPDATE verifications 
             SET status = $1, verified_at = NOW(), updated_at = NOW(), failure_reason = $4
             WHERE id = $2 AND organization_id = $3`,
            [body.status, id, user.organizationId, failureReason]
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
            `SELECT v.id_type, v.match_score, v.risk_level, v.status, 
                    v.created_at, v.verified_at, v.is_auto_approved,
                    pii.full_name
             FROM verifications v
             LEFT JOIN verification_pii pii ON v.id = pii.verification_id
             WHERE v.organization_id = $1
             ORDER BY v.created_at DESC`,
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
            displayName: row.full_name || 'N/A',
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

  const updatePlanSchema = z.object({
    plan: z.enum(['free', 'pro', 'custom']),
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

