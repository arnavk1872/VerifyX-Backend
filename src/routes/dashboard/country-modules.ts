import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { requireAuth } from '../../middleware/role-guard';

const INDIA_DOCS = ['aadhaar', 'pan', 'passport'];
const SINGAPORE_DOCS = ['nric', 'passport'];

const countryModuleSchema = z.object({
  enabled: z.boolean(),
  documents: z.array(z.string()),
  lockedBySuperadmin: z.boolean().optional(),
});

const putCountryModulesSchema = z.object({
  india: countryModuleSchema.optional(),
  singapore: countryModuleSchema.optional(),
});

const organizationQuerySchema = z.object({
  organizationId: z.string().optional(),
});

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

function normalizeModules(body: z.infer<typeof putCountryModulesSchema>) {
  const modules: Record<string, { enabled: boolean; documents: string[]; lockedBySuperadmin?: boolean }> = {};
  if (body.india) {
    const docs = body.india.documents.filter((d) => INDIA_DOCS.includes(d));
    const module: { enabled: boolean; documents: string[]; lockedBySuperadmin?: boolean } = {
      enabled: body.india.enabled,
      documents: [...new Set(docs)],
    };
    if (body.india.lockedBySuperadmin !== undefined) {
      module.lockedBySuperadmin = body.india.lockedBySuperadmin;
    }
    modules['IN'] = module;
  }
  if (body.singapore) {
    const docs = body.singapore.documents.filter((d) => SINGAPORE_DOCS.includes(d));
    const module: { enabled: boolean; documents: string[]; lockedBySuperadmin?: boolean } = {
      enabled: body.singapore.enabled,
      documents: [...new Set(docs)],
    };
    if (body.singapore.lockedBySuperadmin !== undefined) {
      module.lockedBySuperadmin = body.singapore.lockedBySuperadmin;
    }
    modules['SG'] = module;
  }
  return modules;
}

const DEFAULT_MODULES: Record<string, { enabled: boolean; documents: string[]; lockedBySuperadmin?: boolean }> = {
  IN: { enabled: true, documents: [...INDIA_DOCS], lockedBySuperadmin: false },
  SG: { enabled: true, documents: [...SINGAPORE_DOCS], lockedBySuperadmin: false },
};

function rowToResponse(row: { country_modules?: unknown } | null) {
  const raw = (row?.country_modules as Record<string, { enabled: boolean; documents: string[]; lockedBySuperadmin?: boolean }>) || {};
  if (Object.keys(raw).length === 0) {
    return {
      india: DEFAULT_MODULES['IN'],
      singapore: DEFAULT_MODULES['SG'],
    };
  }
  return {
    india: raw['IN']
      ? {
          ...raw['IN'],
          enabled: raw['IN'].lockedBySuperadmin ? false : raw['IN'].enabled,
        }
      : { enabled: true, documents: INDIA_DOCS, lockedBySuperadmin: false },
    singapore: raw['SG']
      ? {
          ...raw['SG'],
          enabled: raw['SG'].lockedBySuperadmin ? false : raw['SG'].enabled,
        }
      : { enabled: true, documents: SINGAPORE_DOCS, lockedBySuperadmin: false },
  };
}

export async function registerCountryModuleRoutes(fastify: FastifyInstance) {
  fastify.get('/api/dashboard/country-modules', async (request: FastifyRequest, reply: FastifyReply) => {
    const organizationId = resolveTargetOrganizationId(request, reply);
    if (!organizationId) return;

    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          'SELECT country_modules FROM organizations WHERE id = $1',
          [organizationId]
        );
        const row = result.rows[0] ?? null;
        return reply.send(rowToResponse(row));
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  fastify.put('/api/dashboard/country-modules', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;
    const organizationId = resolveTargetOrganizationId(request, reply);
    if (!organizationId) return;

    try {
      const body = putCountryModulesSchema.parse(request.body || {});
      const client = await pool.connect();
      try {
        const result = await client.query(
          'SELECT country_modules FROM organizations WHERE id = $1',
          [organizationId]
        );
        const existing = (result.rows[0]?.country_modules as Record<string, { enabled: boolean; documents: string[]; lockedBySuperadmin?: boolean }>) || {};
        const updates = normalizeModules(body);
        const merged: Record<string, { enabled: boolean; documents: string[]; lockedBySuperadmin?: boolean }> = {
          ...existing,
          ...updates,
        };

        if (user.role !== 'SUPER_ADMIN') {
          const lockedIn = existing['IN']?.lockedBySuperadmin === true;
          const lockedSg = existing['SG']?.lockedBySuperadmin === true;

          if (lockedIn && updates['IN']?.enabled === true) {
            return reply.code(403).send({ error: 'India disabled by superadmin' });
          }
          if (lockedSg && updates['SG']?.enabled === true) {
            return reply.code(403).send({ error: 'Singapore disabled by superadmin' });
          }

          if (lockedIn && merged['IN']) {
            merged['IN'].enabled = false;
            merged['IN'].lockedBySuperadmin = true;
          }
          if (lockedSg && merged['SG']) {
            merged['SG'].enabled = false;
            merged['SG'].lockedBySuperadmin = true;
          }

          if (merged['IN']) {
            merged['IN'].lockedBySuperadmin = existing['IN']?.lockedBySuperadmin ?? false;
          }
          if (merged['SG']) {
            merged['SG'].lockedBySuperadmin = existing['SG']?.lockedBySuperadmin ?? false;
          }
        } else {
          if (updates['IN']?.lockedBySuperadmin !== undefined && merged['IN']) {
            merged['IN'].lockedBySuperadmin = updates['IN'].lockedBySuperadmin;
          }
          if (updates['SG']?.lockedBySuperadmin !== undefined && merged['SG']) {
            merged['SG'].lockedBySuperadmin = updates['SG'].lockedBySuperadmin;
          }
        }
        await client.query(
          'UPDATE organizations SET country_modules = $1 WHERE id = $2',
          [JSON.stringify(merged), organizationId]
        );
        return reply.send(rowToResponse({ country_modules: merged }));
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
}
