import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { requireAuth } from '../../middleware/role-guard';
import { webhookConfigSchema } from './schemas';

export async function registerWebhookRoutes(fastify: FastifyInstance) {
  fastify.get('/api/dashboard/webhooks', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT url, events, created_at, updated_at FROM webhook_config WHERE organization_id = $1`,
          [user.organizationId]
        );
        if (result.rows.length === 0) {
          return reply.send(null);
        }
        const row = result.rows[0];
        const events = typeof row.events === 'object' && row.events !== null
          ? row.events
          : {
              verificationApproved: true,
              verificationRejected: true,
              manualReviewRequired: true,
              documentUploaded: false,
              verificationStarted: false,
            };
        return reply.send({
          url: row.url,
          events: {
            verificationApproved: events.verificationApproved !== false,
            verificationRejected: events.verificationRejected !== false,
            manualReviewRequired: events.manualReviewRequired !== false,
            documentUploaded: !!events.documentUploaded,
            verificationStarted: !!events.verificationStarted,
          },
          createdAt: row.created_at?.toISOString?.(),
          updatedAt: row.updated_at?.toISOString?.(),
        });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  fastify.put('/api/dashboard/webhooks', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    try {
      const body = webhookConfigSchema.parse(request.body);
      const events = body.events ?? {};
      const eventsJson = {
        verificationApproved: events.verificationApproved !== false,
        verificationRejected: events.verificationRejected !== false,
        manualReviewRequired: events.manualReviewRequired !== false,
        documentUploaded: !!events.documentUploaded,
        verificationStarted: !!events.verificationStarted,
      };

      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO webhook_config (organization_id, url, events, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (organization_id) DO UPDATE SET url = $2, events = $3, updated_at = NOW()`,
          [user.organizationId, body.url, JSON.stringify(eventsJson)]
        );
        return reply.send({ success: true });
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
