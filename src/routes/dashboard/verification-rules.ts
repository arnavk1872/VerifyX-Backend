import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { requireAuth } from '../../middleware/role-guard';

const verificationRulesSchema = z.object({
  documentExpiryCheckEnabled: z.boolean().optional(),
  ghostSpoofCheckEnabled: z.boolean().optional(),
  behavioralFraudCheckEnabled: z.boolean().optional(),
  templateMatchingEnabled: z.boolean().optional(),
  tamperingDetectionEnabled: z.boolean().optional(),
  ocrValidationEnabled: z.boolean().optional(),
  fieldConsistencyEnabled: z.boolean().optional(),
  crossFieldConsistencyEnabled: z.boolean().optional(),
  mrzChecksumEnabled: z.boolean().optional(),
  imageQualityEnabled: z.boolean().optional(),
});

const organizationQuerySchema = z.object({
  organizationId: z.string().optional(),
});

type VerificationRules = {
  documentExpiryCheckEnabled: boolean;
  ghostSpoofCheckEnabled: boolean;
  behavioralFraudCheckEnabled: boolean;
  templateMatchingEnabled: boolean;
  tamperingDetectionEnabled: boolean;
  ocrValidationEnabled: boolean;
  fieldConsistencyEnabled: boolean;
  crossFieldConsistencyEnabled: boolean;
  mrzChecksumEnabled: boolean;
  imageQualityEnabled: boolean;
};

const DEFAULT_RULES: VerificationRules = {
  documentExpiryCheckEnabled: false,
  ghostSpoofCheckEnabled: false,
  behavioralFraudCheckEnabled: false,
  templateMatchingEnabled: true,
  tamperingDetectionEnabled: true,
  ocrValidationEnabled: true,
  fieldConsistencyEnabled: true,
  crossFieldConsistencyEnabled: true,
  mrzChecksumEnabled: true,
  imageQualityEnabled: true,
};

function resolveTargetOrganizationId(
  request: FastifyRequest,
  reply: FastifyReply
): string | null {
  const user = requireAuth(request, reply);
  if (!user) return null;

  const parsed = organizationQuerySchema.safeParse(request.query ?? {});
  if (!parsed.success) {
    reply.code(400).send({ error: 'Invalid organization query' });
    return null;
  }

  const requestedOrgId = parsed.data.organizationId;
  if (requestedOrgId && user.role !== 'SUPER_ADMIN') {
    reply.code(403).send({ error: 'Forbidden: insufficient permissions' });
    return null;
  }

  return requestedOrgId ?? user.organizationId;
}

function rowToRules(row: { verification_rules?: unknown } | null): VerificationRules {
  const raw = (row?.verification_rules as Partial<VerificationRules>) || {};
  return {
    documentExpiryCheckEnabled: raw.documentExpiryCheckEnabled ?? DEFAULT_RULES.documentExpiryCheckEnabled,
    ghostSpoofCheckEnabled: raw.ghostSpoofCheckEnabled ?? DEFAULT_RULES.ghostSpoofCheckEnabled,
    behavioralFraudCheckEnabled:
      raw.behavioralFraudCheckEnabled ?? DEFAULT_RULES.behavioralFraudCheckEnabled,
    templateMatchingEnabled: raw.templateMatchingEnabled ?? DEFAULT_RULES.templateMatchingEnabled,
    tamperingDetectionEnabled: raw.tamperingDetectionEnabled ?? DEFAULT_RULES.tamperingDetectionEnabled,
    ocrValidationEnabled: raw.ocrValidationEnabled ?? DEFAULT_RULES.ocrValidationEnabled,
    fieldConsistencyEnabled: raw.fieldConsistencyEnabled ?? DEFAULT_RULES.fieldConsistencyEnabled,
    crossFieldConsistencyEnabled:
      raw.crossFieldConsistencyEnabled ?? DEFAULT_RULES.crossFieldConsistencyEnabled,
    mrzChecksumEnabled: raw.mrzChecksumEnabled ?? DEFAULT_RULES.mrzChecksumEnabled,
    imageQualityEnabled: raw.imageQualityEnabled ?? DEFAULT_RULES.imageQualityEnabled,
  };
}

export async function registerVerificationRulesRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/api/dashboard/verification-rules',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = resolveTargetOrganizationId(request, reply);
      if (!organizationId) return;

      try {
        const client = await pool.connect();
        try {
          const result = await client.query(
            'SELECT verification_rules FROM organizations WHERE id = $1',
            [organizationId]
          );
          const row = result.rows[0] ?? null;
          return reply.send(rowToRules(row));
        } finally {
          client.release();
        }
      } catch (error) {
        fastify.log.error(error);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }
  );

  fastify.put(
    '/api/dashboard/verification-rules',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const organizationId = resolveTargetOrganizationId(request, reply);
      if (!organizationId) return;

      try {
        const body = verificationRulesSchema.parse(request.body || {});

        const client = await pool.connect();
        try {
          const result = await client.query(
            'SELECT verification_rules FROM organizations WHERE id = $1',
            [organizationId]
          );
          const existing = (result.rows[0]?.verification_rules as Record<string, any>) || {};
          const merged: VerificationRules = {
            documentExpiryCheckEnabled:
              typeof body.documentExpiryCheckEnabled === 'boolean'
                ? body.documentExpiryCheckEnabled
                : typeof existing.documentExpiryCheckEnabled === 'boolean'
                  ? existing.documentExpiryCheckEnabled
                  : DEFAULT_RULES.documentExpiryCheckEnabled,
            ghostSpoofCheckEnabled:
              typeof body.ghostSpoofCheckEnabled === 'boolean'
                ? body.ghostSpoofCheckEnabled
                : typeof existing.ghostSpoofCheckEnabled === 'boolean'
                  ? existing.ghostSpoofCheckEnabled
                  : DEFAULT_RULES.ghostSpoofCheckEnabled,
            behavioralFraudCheckEnabled:
              typeof body.behavioralFraudCheckEnabled === 'boolean'
                ? body.behavioralFraudCheckEnabled
                : typeof existing.behavioralFraudCheckEnabled === 'boolean'
                  ? existing.behavioralFraudCheckEnabled
                  : DEFAULT_RULES.behavioralFraudCheckEnabled,
            templateMatchingEnabled:
              typeof body.templateMatchingEnabled === 'boolean'
                ? body.templateMatchingEnabled
                : typeof existing.templateMatchingEnabled === 'boolean'
                  ? existing.templateMatchingEnabled
                  : DEFAULT_RULES.templateMatchingEnabled,
            tamperingDetectionEnabled:
              typeof body.tamperingDetectionEnabled === 'boolean'
                ? body.tamperingDetectionEnabled
                : typeof existing.tamperingDetectionEnabled === 'boolean'
                  ? existing.tamperingDetectionEnabled
                  : DEFAULT_RULES.tamperingDetectionEnabled,
            ocrValidationEnabled:
              typeof body.ocrValidationEnabled === 'boolean'
                ? body.ocrValidationEnabled
                : typeof existing.ocrValidationEnabled === 'boolean'
                  ? existing.ocrValidationEnabled
                  : DEFAULT_RULES.ocrValidationEnabled,
            fieldConsistencyEnabled:
              typeof body.fieldConsistencyEnabled === 'boolean'
                ? body.fieldConsistencyEnabled
                : typeof existing.fieldConsistencyEnabled === 'boolean'
                  ? existing.fieldConsistencyEnabled
                  : DEFAULT_RULES.fieldConsistencyEnabled,
            crossFieldConsistencyEnabled:
              typeof body.crossFieldConsistencyEnabled === 'boolean'
                ? body.crossFieldConsistencyEnabled
                : typeof existing.crossFieldConsistencyEnabled === 'boolean'
                  ? existing.crossFieldConsistencyEnabled
                  : DEFAULT_RULES.crossFieldConsistencyEnabled,
            mrzChecksumEnabled:
              typeof body.mrzChecksumEnabled === 'boolean'
                ? body.mrzChecksumEnabled
                : typeof existing.mrzChecksumEnabled === 'boolean'
                  ? existing.mrzChecksumEnabled
                  : DEFAULT_RULES.mrzChecksumEnabled,
            imageQualityEnabled:
              typeof body.imageQualityEnabled === 'boolean'
                ? body.imageQualityEnabled
                : typeof existing.imageQualityEnabled === 'boolean'
                  ? existing.imageQualityEnabled
                  : DEFAULT_RULES.imageQualityEnabled,
          };

          await client.query(
            'UPDATE organizations SET verification_rules = $1 WHERE id = $2',
            [JSON.stringify(merged), organizationId]
          );

          return reply.send(merged);
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
}

