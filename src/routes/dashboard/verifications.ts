import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../../db/pool';
import { requireAuth, requireRole } from '../../middleware/role-guard';
import { getSignedS3Url } from '../../services/aws/s3';
import { deliverWebhook } from '../../services/webhooks/deliver';
import { decisionSchema } from './schemas';
import { sanitizeDocumentImages } from './utils';

export async function registerVerificationRoutes(fastify: FastifyInstance) {
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
        // Map UI status to DB values: pending = in-progress, Approved/Rejected/Completed/Flagged = exact match
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
          if (['pending', 'documents_uploaded', 'liveness_uploaded', 'processing'].includes(s)) return 'Pending';
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
                  v.status, v.created_at, v.verified_at, v.is_auto_approved, v.admin_comment, v.failure_reason,
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
          adminComment: row.admin_comment || null,
          failureReason: row.failure_reason || null,
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
          // Include any generated liveness frame images (liveness_frame_1, liveness_frame_2, ...)
          for (const key of Object.keys(documentImages)) {
            if (!key.startsWith('liveness_frame_')) continue;
            const entry = documentImages[key];
            const s3Key = entry?.s3Key;
            if (s3Key && typeof s3Key === 'string') {
              try {
                result[key] = await getSignedS3Url(s3Key, expiresIn);
              } catch (err) {
                fastify.log.warn({ err, key, verificationId: id }, 'Presign failed for liveness frame key');
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
             SET status = $1, verified_at = NOW(), updated_at = NOW(), failure_reason = $4, admin_comment = $5
             WHERE id = $2 AND organization_id = $3`,
            [body.status, id, user.organizationId, failureReason, body.adminComment || null]
          );

          const ipAddress = request.ip || (request.headers['x-forwarded-for'] as string) || 'unknown';
          await client.query(
            `INSERT INTO audit_logs(id, user_id, organization_id, action, target_id, ip_address)
             VALUES($1, $2, $3, $4, $5, $6)`,
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

          if (body.status === 'Approved') {
            deliverWebhook(user.organizationId, 'verification_approved', {
              verificationId: id,
              verificationStatus: 'Approved',
              failureReason: null,
            }).catch(() => { });
          } else if (body.status === 'Rejected') {
            deliverWebhook(user.organizationId, 'verification_rejected', {
              verificationId: id,
              verificationStatus: 'Rejected',
              failureReason: failureReason ?? null,
            }).catch(() => { });
          } else if (body.status === 'Flagged') {
            deliverWebhook(user.organizationId, 'manual_review_required', {
              verificationId: id,
              verificationStatus: 'Flagged',
              failureReason: failureReason ?? null,
            }).catch(() => { });
          }

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
            `INSERT INTO audit_logs(id, user_id, organization_id, action, target_id, ip_address)
             VALUES($1, $2, $3, $4, $5, $6)`,
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
}
