import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { requireAuth } from '../../middleware/role-guard';

const verificationRulesSchema = z.object({
  documentExpiryCheckEnabled: z.boolean().optional(),
  ghostSpoofCheckEnabled: z.boolean().optional(),
  behavioralFraudCheckEnabled: z.boolean().optional(),
});

const organizationQuerySchema = z.object({
  organizationId: z.string().optional(),
});

type VerificationRules = {
  documentExpiryCheckEnabled: boolean;
  ghostSpoofCheckEnabled: boolean;
  behavioralFraudCheckEnabled: boolean;
};

const DEFAULT_RULES: VerificationRules = {
  documentExpiryCheckEnabled: false,
  ghostSpoofCheckEnabled: false,
  behavioralFraudCheckEnabled: false,
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

