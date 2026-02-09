import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4, validate as validateUuid } from 'uuid';
import { pool } from '../db/pool';
import { authenticatePublicKey } from '../auth/api-key-auth';
import multipart from '@fastify/multipart';
import { uploadToS3 } from '../services/aws/s3';
import { deliverWebhook } from '../services/webhooks/deliver';
import { extractAndParseDocument } from '../ocr/document-parser';
import type { DocumentType } from '../ocr/document-parser';
import { jobQueue } from '../services/queue/job-queue';
import { generateLivenessThumbnails } from '../services/media/liveness-thumbnails';

const createVerificationSchema = z.object({
  country: z.string().min(1),
  documentType: z.enum(['passport', 'aadhaar', 'pan', 'nric']),
});

const DOC_NAMES: Record<string, string> = {
  aadhaar: 'Aadhaar Card',
  pan: 'PAN Card',
  passport: 'Passport',
  nric: 'NRIC (National Registration Identity Card)',
};

function normalizeCountryCode(country: string): string {
  const c = country.trim().toUpperCase();
  if (c === 'INDIA' || c === 'IN') return 'IN';
  if (c === 'SINGAPORE' || c === 'SG') return 'SG';
  return country;
}

function toDateOnly(value: string | null | undefined): string | null {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (iso.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseVerificationId(verificationId: string): string | null {
  const trimmedId = verificationId.trim();
  let verificationUuid: string;
  if (trimmedId.startsWith('ver_')) {
    const uuidWithoutPrefix = trimmedId.replace('ver_', '');
    if (uuidWithoutPrefix.length !== 32) {
      return null;
    }
    verificationUuid = uuidWithoutPrefix.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  } else {
    verificationUuid = trimmedId;
  }
  if (!validateUuid(verificationUuid)) {
    return null;
  }

  return verificationUuid;
}

export async function sdkRoutes(fastify: FastifyInstance) {
  await fastify.register(multipart, {
    limits: {
      fileSize: 2 * 1024 * 1024,
    },
  });

  fastify.get('/api/v1/country-modules', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const apiKeyAuth = await authenticatePublicKey(request);
      if (!apiKeyAuth) {
        return reply.code(401).send({ error: 'Unauthorized: Invalid public key' });
      }
      const client = await pool.connect();
      try {
        const result = await client.query(
          'SELECT country_modules FROM organizations WHERE id = $1',
          [apiKeyAuth.organizationId]
        );
        const raw = (result.rows[0]?.country_modules as Record<string, { enabled: boolean; documents: string[]; lockedBySuperadmin?: boolean }>) || {};
        const countries: { code: string; name: string; documents: { id: string; name: string }[] }[] = [];
        const inConfig = raw['IN'];
        const sgConfig = raw['SG'];
        const inEnabled = inConfig?.enabled !== false && inConfig?.lockedBySuperadmin !== true;
        const inDocs = Array.isArray(inConfig?.documents) && inConfig.documents.length > 0 ? inConfig.documents : ['aadhaar', 'pan', 'passport'];
        const sgEnabled = sgConfig?.enabled !== false && sgConfig?.lockedBySuperadmin !== true;
        const sgDocs = Array.isArray(sgConfig?.documents) && sgConfig.documents.length > 0 ? sgConfig.documents : ['nric', 'passport'];
        if (inEnabled) {
          countries.push({
            code: 'IN',
            name: 'India',
            documents: inDocs.map((id) => ({ id, name: DOC_NAMES[id] || id })),
          });
        }
        if (sgEnabled) {
          countries.push({
            code: 'SG',
            name: 'Singapore',
            documents: sgDocs.map((id) => ({ id, name: DOC_NAMES[id] || id })),
          });
        }
        return reply.send({ countries });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/api/v1/verifications', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const apiKeyAuth = await authenticatePublicKey(request);
      if (!apiKeyAuth) {
        return reply.code(401).send({ error: 'Unauthorized: Invalid public key' });
      }

      const body = createVerificationSchema.parse(request.body);
      const countryCode = normalizeCountryCode(body.country);

      const client = await pool.connect();
      try {
        const orgResult = await client.query(
          'SELECT country_modules FROM organizations WHERE id = $1',
          [apiKeyAuth.organizationId]
        );
        const raw = (orgResult.rows[0]?.country_modules as Record<string, { enabled: boolean; documents: string[]; lockedBySuperadmin?: boolean }>) || {};
        
        const defaultDocs: Record<string, string[]> = {
          IN: ['aadhaar', 'pan', 'passport'],
          SG: ['nric', 'passport'],
        };
        
        const countryConfig = raw[countryCode];
        const isEnabled = countryConfig?.enabled !== false && countryConfig?.lockedBySuperadmin !== true;
        const allowedDocs = Array.isArray(countryConfig?.documents) && countryConfig.documents.length > 0
          ? countryConfig.documents
          : defaultDocs[countryCode] || [];

        if (!isEnabled || allowedDocs.length === 0) {
          return reply.code(400).send({
            error: 'Country not enabled for verification',
            code: 'country_not_enabled',
          });
        }
        if (!allowedDocs.includes(body.documentType)) {
          return reply.code(400).send({
            error: 'Document type not enabled for this country',
            code: 'document_type_not_enabled',
          });
        }

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

        deliverWebhook(apiKeyAuth.organizationId, 'verification_started', {
          verificationId,
          idType: body.documentType,
        }).catch(() => {});

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
      const rawSide = (request.query as { side?: string })?.side;
      const side = rawSide === 'back' ? 'back' : 'front';

      const apiKeyAuth = await authenticatePublicKey(request);
      if (!apiKeyAuth) {
        return reply.code(401).send({ error: 'Unauthorized: Invalid public key' });
      }

      const verificationUuid = parseVerificationId(verificationId);
      if (!verificationUuid) {
        return reply.code(400).send({ error: 'Invalid verification ID format', details: 'Verification ID must be in format ver_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx or a valid UUID' });
      }

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
        const fileType = side === 'back' ? 'document_back' : 'document_front';

        const documentUpload = await uploadToS3(
          buffer,
          fileName,
          contentType,
          verification.organization_id,
          verificationUuid,
          fileType
        );

        const documentImageId = `img_document_${uuidv4().replace(/-/g, '')}`;
        const newEntry = {
          id: documentImageId,
          url: documentUpload.url,
          s3Key: documentUpload.key,
          bucket: documentUpload.bucket,
          uploadedAt: new Date().toISOString(),
        };

        const existingPii = await client.query(
          `SELECT verification_id, document_images, full_name, id_number FROM verification_pii WHERE verification_id = $1`,
          [verificationUuid]
        );
        const existingRow = existingPii.rows[0];
        const currentImages = (existingRow?.document_images as Record<string, unknown>) || {};
        const documentImages = {
          ...currentImages,
          [side === 'back' ? 'document_back' : 'document_front']: newEntry,
          ...(side === 'front' ? { document: newEntry } : {}),
        };

        if (side === 'front') {
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

          const existingHasMinimal =
            existingRow?.full_name?.trim() && existingRow?.id_number?.trim();
          const thisUploadHasMinimal =
            parsedDocument?.fullName?.trim() && parsedDocument?.idNumber?.trim();
          if (!thisUploadHasMinimal && !existingHasMinimal) {
            await client.query('ROLLBACK');
            return reply.code(422).send({
              error: "We couldn't read your document clearly. Please upload a valid ID with full name and document number visible.",
              code: 'document_extraction_failed',
            });
          }

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
        } else {
          if (existingPii.rows.length > 0) {
            await client.query(
              `UPDATE verification_pii SET document_images = $1 WHERE verification_id = $2`,
              [JSON.stringify(documentImages), verificationUuid]
            );
          } else {
            await client.query(
              `INSERT INTO verification_pii (verification_id, document_images) VALUES ($1, $2)`,
              [verificationUuid, JSON.stringify(documentImages)]
            );
          }
        }

        await client.query(
          `UPDATE verifications SET status = $1, updated_at = NOW() WHERE id = $2`,
          ['documents_uploaded', verificationUuid]
        );

        await client.query('COMMIT');

        deliverWebhook(verification.organization_id, 'document_uploaded', {
          verificationId,
        }).catch(() => {});

        return reply.send({
          verificationId,
          documentUpload: {
            imageId: documentImageId,
          },
          status: 'documents_uploaded',
        });
      } catch (error: any) {
        await client.query('ROLLBACK');
        if (error.code === '22P02') {
          return reply.code(400).send({ error: 'Invalid verification ID format' });
        }
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      if (error.code === '22P02') {
        return reply.code(400).send({ error: 'Invalid verification ID format' });
      }
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  const confirmDetailsSchema = z.object({
    fullName: z.string().optional(),
    dob: z.string().optional(),
    idNumber: z.string().optional(),
  });

  fastify.get('/api/v1/verifications/:verificationId/details', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { verificationId } = request.params as { verificationId: string };
      const apiKeyAuth = await authenticatePublicKey(request);
      if (!apiKeyAuth) {
        return reply.code(401).send({ error: 'Unauthorized: Invalid public key' });
      }
      const verificationUuid = parseVerificationId(verificationId);
      if (!verificationUuid) {
        return reply.code(400).send({ error: 'Invalid verification ID format' });
      }
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT v.id_type, pii.full_name, pii.dob, pii.id_number, pii.address, pii.extracted_fields
           FROM verifications v
           LEFT JOIN verification_pii pii ON v.id = pii.verification_id
           WHERE v.id = $1 AND v.organization_id = $2`,
          [verificationUuid, apiKeyAuth.organizationId]
        );
        if (result.rows.length === 0) {
          return reply.code(404).send({ error: 'Verification not found' });
        }
        const row = result.rows[0];
        const docType = row.id_type as string;
        const documentTypeLabel =
          docType === 'passport' ? 'Passport' : docType === 'aadhaar' ? 'Aadhaar' : docType === 'pan' ? 'PAN' : docType || '';
        const ef = row.extracted_fields || {};
        return reply.send({
          fullName: row.full_name ?? '',
          dob: row.dob ? String(row.dob).slice(0, 10) : '',
          idNumber: row.id_number ?? '',
          address: row.address ?? '',
          documentType: documentTypeLabel,
          nationality: ef.nationality ?? null,
        });
      } finally {
        client.release();
      }
    } catch (error: any) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  fastify.post('/api/v1/verifications/:verificationId/confirm-details', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { verificationId } = request.params as { verificationId: string };
      const apiKeyAuth = await authenticatePublicKey(request);
      if (!apiKeyAuth) {
        return reply.code(401).send({ error: 'Unauthorized: Invalid public key' });
      }
      const verificationUuid = parseVerificationId(verificationId);
      if (!verificationUuid) {
        return reply.code(400).send({ error: 'Invalid verification ID format' });
      }
      const body = confirmDetailsSchema.parse(request.body || {});
      const client = await pool.connect();
      try {
        const existing = await client.query(
          `SELECT pii.full_name, pii.dob, pii.id_number
           FROM verifications v
           JOIN verification_pii pii ON v.id = pii.verification_id
           WHERE v.id = $1 AND v.organization_id = $2`,
          [verificationUuid, apiKeyAuth.organizationId]
        );
        if (existing.rows.length === 0) {
          return reply.code(404).send({ error: 'Verification or details not found' });
        }
        const orig = existing.rows[0];
        const origFullName = orig.full_name ?? '';
        const origDob = orig.dob ? String(orig.dob).slice(0, 10) : '';
        const origIdNumber = orig.id_number ?? '';
        const newFullName = body.fullName !== undefined ? String(body.fullName).trim() : origFullName;
        const newDobRaw = body.dob !== undefined ? String(body.dob).trim() : origDob;
        const newDob = toDateOnly(newDobRaw) ?? (orig.dob ? String(orig.dob).slice(0, 10) : null);
        const newIdNumber = body.idNumber !== undefined ? String(body.idNumber).trim() : origIdNumber;
        const editedFields: Record<string, { original: string; edited: string }> = {};
        if (newFullName !== origFullName) editedFields.fullName = { original: origFullName, edited: newFullName };
        if (newDobRaw !== (orig.dob ? String(orig.dob).slice(0, 10) : '')) editedFields.dob = { original: origDob, edited: newDobRaw };
        if (newIdNumber !== origIdNumber) editedFields.idNumber = { original: origIdNumber, edited: newIdNumber };
        const confirmationStatus = Object.keys(editedFields).length > 0 ? 'edited' : 'not_edited';
        await client.query(
          `UPDATE verification_pii
           SET full_name = $1, dob = $2, id_number = $3,
               confirmation_status = $4, edited_fields = $5, confirmed_at = NOW()
           WHERE verification_id = $6`,
          [
            newFullName || null,
            newDob,
            newIdNumber || null,
            confirmationStatus,
            Object.keys(editedFields).length > 0 ? JSON.stringify(editedFields) : null,
            verificationUuid,
          ]
        );
        return reply.send({
          verificationId: `ver_${verificationUuid.replace(/-/g, '')}`,
          confirmationStatus,
          editedFields: Object.keys(editedFields).length > 0 ? editedFields : undefined,
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

  fastify.post('/api/v1/verifications/:verificationId/liveness', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { verificationId } = request.params as { verificationId: string };
      
      const apiKeyAuth = await authenticatePublicKey(request);
      if (!apiKeyAuth) {
        return reply.code(401).send({ error: 'Unauthorized: Invalid public key' });
      }

      const verificationUuid = parseVerificationId(verificationId);
      if (!verificationUuid) {
        return reply.code(400).send({ error: 'Invalid verification ID format', details: 'Verification ID must be in format ver_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx or a valid UUID' });
      }

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
        const contentType = data.mimetype || 'image/jpeg';
        const mediaType = contentType.startsWith('video/') ? 'video' : 'image';
        // Use extension that matches content so ffmpeg can read the file (webm vs mp4)
        const videoExt = contentType.includes('webm') ? 'webm' : 'mp4';
        const fileName =
          data.filename && data.filename.includes('.')
            ? data.filename
            : mediaType === 'video'
              ? `liveness.${videoExt}`
              : 'liveness.jpg';

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
        let documentImages = livenessData as any;

        if (existingPii.rows.length > 0) {
          const currentData = existingPii.rows[0]?.document_images || {};
          documentImages = { ...currentData, ...livenessData };
          await client.query(
            `UPDATE verification_pii SET document_images = $1 WHERE verification_id = $2`,
            [JSON.stringify(documentImages), verificationUuid]
          );
        } else {
          await client.query(
            `INSERT INTO verification_pii (verification_id, document_images)
             VALUES ($1, $2)`,
            [verificationUuid, JSON.stringify(documentImages)]
          );
        }

        await client.query(
          `UPDATE verifications SET status = $1, updated_at = NOW() WHERE id = $2`,
          ['liveness_uploaded', verificationUuid]
        );

        await client.query('COMMIT');

        // Best-effort async thumbnail generation for video liveness
        if (mediaType === 'video') {
          generateLivenessThumbnails(
            livenessUpload.key,
            verification.organization_id,
            verificationUuid
          )
            .then(async (frames) => {
              const client2 = await pool.connect();
              try {
                const existing = await client2.query(
                  `SELECT document_images FROM verification_pii WHERE verification_id = $1`,
                  [verificationUuid]
                );
                const currentImages =
                  (existing.rows[0]?.document_images as Record<string, any>) || {};
                const updated = { ...currentImages, ...frames };
                await client2.query(
                  `UPDATE verification_pii SET document_images = $1 WHERE verification_id = $2`,
                  [JSON.stringify(updated), verificationUuid]
                );
              } finally {
                client2.release();
              }
            })
            .catch((err) => {
              fastify.log.warn(
                { err, verificationId, s3Key: livenessUpload.key },
                'Failed to generate liveness thumbnails'
              );
            });
        }

        return reply.send({
          verificationId,
          livenessUpload: {
            mediaId,
            type: mediaType,
          },
          status: 'liveness_uploaded',
        });
      } catch (error: any) {
        await client.query('ROLLBACK');
        if (error.code === '22P02') {
          return reply.code(400).send({ error: 'Invalid verification ID format' });
        }
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      if (error.code === '22P02') {
        return reply.code(400).send({ error: 'Invalid verification ID format' });
      }
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

      const verificationUuid = parseVerificationId(verificationId);
      if (!verificationUuid) {
        return reply.code(400).send({ error: 'Invalid verification ID format', details: 'Verification ID must be in format ver_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx or a valid UUID' });
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

        if (verificationCheck.rows[0].organization_id !== apiKeyAuth.organizationId) {
          await client.query('ROLLBACK');
          return reply.code(403).send({ error: 'Forbidden' });
        }

        const currentStatus = verificationCheck.rows[0].status;
        if (currentStatus === 'processing' || currentStatus === 'completed') {
          await client.query('ROLLBACK');
          return reply.send({
            verificationId,
            status: currentStatus,
            message: currentStatus === 'processing' ? 'Verification is already being processed' : 'Verification is already completed',
          });
        }
        if (currentStatus !== 'liveness_uploaded' && currentStatus !== 'documents_uploaded') {
          await client.query('ROLLBACK');
          fastify.log.warn({ verificationId: verificationUuid, currentStatus }, 'Verification not ready for processing');
          return reply.code(400).send({ 
            error: 'Verification not ready for processing',
            currentStatus,
            requiredStatus: ['liveness_uploaded', 'documents_uploaded']
          });
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
      } catch (error: any) {
        await client.query('ROLLBACK');
        if (error.code === '22P02') {
          return reply.code(400).send({ error: 'Invalid verification ID format' });
        }
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      if (error.code === '22P02') {
        return reply.code(400).send({ error: 'Invalid verification ID format' });
      }
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

      const verificationUuid = parseVerificationId(verificationId);
      if (!verificationUuid) {
        return reply.code(400).send({ error: 'Invalid verification ID format', details: 'Verification ID must be in format ver_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx or a valid UUID' });
      }

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
          ...(row.status === 'failed' && row.failure_reason && { failureReason: row.failure_reason }),
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
