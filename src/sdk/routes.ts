import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { authenticatePublicKey } from '../auth/api-key-auth';
import multipart from '@fastify/multipart';
import { uploadToS3 } from '../services/aws/s3';
import { extractAndParseDocument } from '../ocr/document-parser';
import type { DocumentType } from '../ocr/document-parser';
import { jobQueue } from '../services/queue/job-queue';

const createVerificationSchema = z.object({
  country: z.string().min(1),
  documentType: z.enum(['passport', 'aadhaar', 'pan']),
});

export async function sdkRoutes(fastify: FastifyInstance) {
  await fastify.register(multipart);

  fastify.post('/api/v1/verifications', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const apiKeyAuth = await authenticatePublicKey(request);
      if (!apiKeyAuth) {
        return reply.code(401).send({ error: 'Unauthorized: Invalid public key' });
      }

      const body = createVerificationSchema.parse(request.body);

      const client = await pool.connect();
      try {
        const verificationUuid = uuidv4();
        const verificationId = `ver_${verificationUuid.replace(/-/g, '')}`;
        await client.query(
          `INSERT INTO verifications (id, organization_id, id_type, status)
           VALUES ($1, $2, $3, $4)`,
          [
            verificationUuid,
            apiKeyAuth.organizationId,
            body.documentType,
            'pending',
          ]
        );

        return reply.send({
          verificationId,
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        fastify.log.error(error);
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

  fastify.post('/api/v1/verifications/:verificationId/documents', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { verificationId } = request.params as { verificationId: string };
      
      const apiKeyAuth = await authenticatePublicKey(request);
      if (!apiKeyAuth) {
        return reply.code(401).send({ error: 'Unauthorized: Invalid public key' });
      }

      const verificationUuid = verificationId.startsWith('ver_') 
        ? verificationId.replace('ver_', '').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
        : verificationId;

      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: 'No file uploaded' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const verificationCheck = await client.query(
          `SELECT id, organization_id, status, id_type FROM verifications WHERE id = $1`,
          [verificationUuid]
        );

        if (verificationCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'Verification not found' });
        }

        const verification = verificationCheck.rows[0];
        if (verification.organization_id !== apiKeyAuth.organizationId) {
          await client.query('ROLLBACK');
          return reply.code(403).send({ error: 'Forbidden' });
        }

        const buffer = await data.toBuffer();
        const fileName = data.filename || 'document.jpg';
        const contentType = data.mimetype || 'image/jpeg';
        
        const documentUpload = await uploadToS3(
          buffer,
          fileName,
          contentType,
          verification.organization_id,
          verificationUuid,
          'document'
        );

        const documentImageId = `img_document_${uuidv4().replace(/-/g, '')}`;

        const documentImages = {
          document: {
            id: documentImageId,
            url: documentUpload.url,
            s3Key: documentUpload.key,
            bucket: documentUpload.bucket,
            uploadedAt: new Date().toISOString(),
          },
        };

        let parsedDocument = null;
        try {
          const documentType = verification.id_type as DocumentType;
          parsedDocument = await extractAndParseDocument(
            documentUpload.key,
            documentType,
            true
          );
        } catch (ocrError) {
          fastify.log.error({ error: ocrError }, 'OCR extraction failed');
        }

        const existingPii = await client.query(
          `SELECT verification_id FROM verification_pii WHERE verification_id = $1`,
          [verificationUuid]
        );

        if (existingPii.rows.length > 0) {
          await client.query(
            `UPDATE verification_pii 
             SET document_images = $1,
                 full_name = COALESCE($2, full_name),
                 dob = COALESCE($3, dob),
                 id_number = COALESCE($4, id_number),
                 address = COALESCE($5, address),
                 extracted_fields = COALESCE($6, extracted_fields)
             WHERE verification_id = $7`,
            [
              JSON.stringify(documentImages),
              parsedDocument?.fullName || null,
              parsedDocument?.dob || null,
              parsedDocument?.idNumber || null,
              parsedDocument?.address || null,
              JSON.stringify(parsedDocument?.extractedFields || {}),
              verificationUuid,
            ]
          );
        } else {
          await client.query(
            `INSERT INTO verification_pii 
             (verification_id, document_images, full_name, dob, id_number, address, extracted_fields)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              verificationUuid,
              JSON.stringify(documentImages),
              parsedDocument?.fullName || null,
              parsedDocument?.dob || null,
              parsedDocument?.idNumber || null,
              parsedDocument?.address || null,
              JSON.stringify(parsedDocument?.extractedFields || {}),
            ]
          );
        }

        await client.query(
          `UPDATE verifications SET status = $1, updated_at = NOW() WHERE id = $2`,
          ['documents_uploaded', verificationUuid]
        );

        await client.query('COMMIT');

        return reply.send({
          verificationId,
          documentUpload: {
            imageId: documentImageId,
          },
          status: 'documents_uploaded',
        });
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
  });

  fastify.post('/api/v1/verifications/:verificationId/liveness', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { verificationId } = request.params as { verificationId: string };
      
      const apiKeyAuth = await authenticatePublicKey(request);
      if (!apiKeyAuth) {
        return reply.code(401).send({ error: 'Unauthorized: Invalid public key' });
      }

      const verificationUuid = verificationId.startsWith('ver_') 
        ? verificationId.replace('ver_', '').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
        : verificationId;

      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: 'No file uploaded' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const verificationCheck = await client.query(
          `SELECT id, organization_id, status FROM verifications WHERE id = $1`,
          [verificationUuid]
        );

        if (verificationCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'Verification not found' });
        }

        const verification = verificationCheck.rows[0];
        if (verification.organization_id !== apiKeyAuth.organizationId) {
          await client.query('ROLLBACK');
          return reply.code(403).send({ error: 'Forbidden' });
        }

        const buffer = await data.toBuffer();
        const fileName = data.filename || (data.mimetype?.startsWith('video/') ? 'liveness.mp4' : 'liveness.jpg');
        const contentType = data.mimetype || 'image/jpeg';
        const mediaType = data.mimetype?.startsWith('video/') ? 'video' : 'image';

        const livenessUpload = await uploadToS3(
          buffer,
          fileName,
          contentType,
          verification.organization_id,
          verificationUuid,
          'liveness'
        );

        const mediaId = `media_liveness_${uuidv4().replace(/-/g, '')}`;

        const existingPii = await client.query(
          `SELECT verification_id, document_images FROM verification_pii WHERE verification_id = $1`,
          [verificationUuid]
        );

        const livenessData = {
          liveness: {
            id: mediaId,
            type: mediaType,
            url: livenessUpload.url,
            s3Key: livenessUpload.key,
            bucket: livenessUpload.bucket,
            uploadedAt: new Date().toISOString(),
          },
        };
        
        if (existingPii.rows.length > 0) {
          const currentData = existingPii.rows[0]?.document_images || {};
          const updatedData = { ...currentData, ...livenessData };
          await client.query(
            `UPDATE verification_pii SET document_images = $1 WHERE verification_id = $2`,
            [JSON.stringify(updatedData), verificationUuid]
          );
        } else {
          await client.query(
            `INSERT INTO verification_pii (verification_id, document_images)
             VALUES ($1, $2)`,
            [verificationUuid, JSON.stringify(livenessData)]
          );
        }

        await client.query(
          `UPDATE verifications SET status = $1, updated_at = NOW() WHERE id = $2`,
          ['liveness_uploaded', verificationUuid]
        );

        await client.query('COMMIT');

        return reply.send({
          verificationId,
          livenessUpload: {
            mediaId,
            type: mediaType,
          },
          status: 'liveness_uploaded',
        });
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
  });

  fastify.post('/api/v1/verifications/:verificationId/process', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { verificationId } = request.params as { verificationId: string };
      
      const apiKeyAuth = await authenticatePublicKey(request);
      if (!apiKeyAuth) {
        return reply.code(401).send({ error: 'Unauthorized: Invalid public key' });
      }

      const verificationUuid = verificationId.startsWith('ver_') 
        ? verificationId.replace('ver_', '').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
        : verificationId;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const verificationCheck = await client.query(
          `SELECT id, organization_id, status FROM verifications WHERE id = $1`,
          [verificationUuid]
        );

        if (verificationCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.code(404).send({ error: 'Verification not found' });
        }

        if (verificationCheck.rows[0].organization_id !== apiKeyAuth.organizationId) {
          await client.query('ROLLBACK');
          return reply.code(403).send({ error: 'Forbidden' });
        }

        const currentStatus = verificationCheck.rows[0].status;
        if (currentStatus !== 'liveness_uploaded' && currentStatus !== 'documents_uploaded') {
          await client.query('ROLLBACK');
          return reply.code(400).send({ error: 'Verification not ready for processing' });
        }

        await client.query(
          `UPDATE verifications SET status = $1, updated_at = NOW() WHERE id = $2`,
          ['processing', verificationUuid]
        );

        await client.query('COMMIT');

        await jobQueue.add('process_verification', { verificationId: verificationUuid });

        return reply.send({
          verificationId,
          status: 'processing',
          processingSteps: {
            documentAuthenticity: { status: 'processing' },
            faceMatching: { status: 'pending' },
            securityScreening: { status: 'pending' },
          },
        });
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
  });

  fastify.get('/api/v1/verifications/:verificationId', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { verificationId } = request.params as { verificationId: string };
      
      const apiKeyAuth = await authenticatePublicKey(request);
      if (!apiKeyAuth) {
        return reply.code(401).send({ error: 'Unauthorized: Invalid public key' });
      }

      const verificationUuid = verificationId.startsWith('ver_') 
        ? verificationId.replace('ver_', '').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
        : verificationId;

      const client = await pool.connect();
      try {
        const verificationResult = await client.query(
          `SELECT v.*, ai.checks, ai.risk_signals, ai.raw_response
           FROM verifications v
           LEFT JOIN verification_ai_results ai ON v.id = ai.verification_id
           WHERE v.id = $1 AND v.organization_id = $2`,
          [verificationUuid, apiKeyAuth.organizationId]
        );

        if (verificationResult.rows.length === 0) {
          return reply.code(404).send({ error: 'Verification not found' });
        }

        const row = verificationResult.rows[0];
        const checks = row.checks || {};
        const riskSignals = row.risk_signals || {};

        const processingSteps: any = {};
        const submissionStatus: any = {};

        if (row.status === 'processing' || row.status === 'completed' || row.status === 'failed') {
          processingSteps.documentAuthenticity = {
            status: checks.documentValid !== undefined ? 'completed' : 'processing',
            ...(checks.documentValid !== undefined && {
              result: {
                isAuthentic: checks.documentValid,
                confidence: checks.documentValid ? 0.95 : 0.5,
              },
            }),
          };

          processingSteps.faceMatching = {
            status: checks.faceMatch !== undefined ? 'completed' : 'pending',
            ...(checks.faceMatch !== undefined && {
              result: {
                matchScore: typeof checks.faceMatch === 'string' 
                  ? parseFloat(checks.faceMatch.replace('%', '')) / 100 
                  : checks.faceMatch,
                isMatch: checks.faceMatch !== undefined && (typeof checks.faceMatch === 'string' ? parseFloat(checks.faceMatch.replace('%', '')) > 0.6 : checks.faceMatch > 0.6),
              },
            }),
          };

          processingSteps.securityScreening = {
            status: riskSignals.verified !== undefined ? 'completed' : 'pending',
            ...(riskSignals.verified !== undefined && {
              result: {
                verified: riskSignals.verified,
              },
            }),
          };

          submissionStatus.documentVerification = {
            status: checks.documentValid !== undefined ? 'completed' : 'under_review',
          };
          submissionStatus.faceMatchAnalysis = {
            status: checks.faceMatch !== undefined ? 'completed' : 'submitted',
          };
          submissionStatus.securityScreening = {
            status: riskSignals.verified !== undefined ? 'completed' : 'pending',
          };
        }

        const formattedVerificationId = `ver_${row.id.replace(/-/g, '')}`;
        return reply.send({
          verificationId: formattedVerificationId,
          status: row.status,
          ...(Object.keys(submissionStatus).length > 0 && { submissionStatus }),
          ...(Object.keys(processingSteps).length > 0 && { processingSteps }),
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.code(500).send({ error: 'Internal server error' });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}
