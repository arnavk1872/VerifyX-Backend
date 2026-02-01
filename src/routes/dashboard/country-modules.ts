import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { requireAuth } from '../../middleware/role-guard';

const INDIA_DOCS = ['aadhaar', 'pan', 'passport'];
const SINGAPORE_DOCS = ['nric', 'passport'];

const countryModuleSchema = z.object({
  enabled: z.boolean(),
  documents: z.array(z.string()),
});

const putCountryModulesSchema = z.object({
  india: countryModuleSchema.optional(),
  singapore: countryModuleSchema.optional(),
});

function normalizeModules(body: z.infer<typeof putCountryModulesSchema>) {
  const modules: Record<string, { enabled: boolean; documents: string[] }> = {};
  if (body.india) {
    const docs = body.india.documents.filter((d) => INDIA_DOCS.includes(d));
    modules['IN'] = { enabled: body.india.enabled, documents: [...new Set(docs)] };
  }
  if (body.singapore) {
    const docs = body.singapore.documents.filter((d) => SINGAPORE_DOCS.includes(d));
    modules['SG'] = { enabled: body.singapore.enabled, documents: [...new Set(docs)] };
  }
  return modules;
}

const DEFAULT_MODULES: Record<string, { enabled: boolean; documents: string[] }> = {
  IN: { enabled: true, documents: [...INDIA_DOCS] },
  SG: { enabled: true, documents: [...SINGAPORE_DOCS] },
};

function rowToResponse(row: { country_modules?: unknown } | null) {
  const raw = (row?.country_modules as Record<string, { enabled: boolean; documents: string[] }>) || {};
  if (Object.keys(raw).length === 0) {
    return {
      india: DEFAULT_MODULES['IN'],
      singapore: DEFAULT_MODULES['SG'],
    };
  }
  return {
    india: raw['IN'] ?? { enabled: true, documents: INDIA_DOCS },
    singapore: raw['SG'] ?? { enabled: true, documents: SINGAPORE_DOCS },
  };
}

export async function registerCountryModuleRoutes(fastify: FastifyInstance) {
  fastify.get('/api/dashboard/country-modules', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          'SELECT country_modules FROM organizations WHERE id = $1',
          [user.organizationId]
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

    try {
      const body = putCountryModulesSchema.parse(request.body || {});
      const client = await pool.connect();
      try {
        const result = await client.query(
          'SELECT country_modules FROM organizations WHERE id = $1',
          [user.organizationId]
        );
        const existing = (result.rows[0]?.country_modules as Record<string, unknown>) || {};
        const updates = normalizeModules(body);
        const merged = { ...existing, ...updates };
        await client.query(
          'UPDATE organizations SET country_modules = $1 WHERE id = $2',
          [JSON.stringify(merged), user.organizationId]
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
