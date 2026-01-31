import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool';
import { requireAuth, requireRole } from '../middleware/role-guard';

const supportTicketSchema = z.object({
  issueType: z.enum(['verification_issue', 'technical_problem', 'document_question', 'account_issue']),
  email: z.string().email(),
  message: z.string().min(10).max(5000),
});

const updateTicketStatusSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']),
});

export async function supportRoutes(fastify: FastifyInstance) {
  fastify.post('/api/support', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    try {
      const body = supportTicketSchema.parse(request.body);

      const client = await pool.connect();
      try {
        const result = await client.query(
          `INSERT INTO support_tickets (user_id, organization_id, issue_type, email, message)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, issue_type, email, status, created_at`,
          [user.userId, user.organizationId, body.issueType, body.email, body.message]
        );

        const ticket = result.rows[0];

        return reply.code(201).send({
          ticketId: ticket.id,
          issueType: ticket.issue_type,
          email: ticket.email,
          status: ticket.status,
          createdAt: ticket.created_at,
          message: 'Support ticket created successfully',
        });
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

  fastify.get(
    '/api/support/tickets',
    { preHandler: requireRole(['SUPER_ADMIN']) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      try {
        const client = await pool.connect();
        try {
          const result = await client.query(
            `SELECT id, user_id, organization_id, issue_type, email, message, status, created_at, updated_at
             FROM support_tickets
             ORDER BY created_at DESC`
          );
          const tickets = result.rows.map((row) => ({
            id: row.id,
            ticketId: row.id,
            userId: row.user_id,
            organizationId: row.organization_id,
            issueType: row.issue_type,
            email: row.email,
            message: row.message,
            status: row.status,
            createdAt: row.created_at?.toISOString?.() ?? row.created_at,
            updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
          }));
          return reply.send(tickets);
        } finally {
          client.release();
        }
      } catch (error) {
        fastify.log.error(error);
        return reply.code(500).send({ error: 'Internal server error' });
      }
    }
  );

  fastify.patch(
    '/api/support/tickets/:id',
    { preHandler: requireRole(['SUPER_ADMIN']) },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      try {
        const { id } = request.params as { id: string };
        const body = updateTicketStatusSchema.parse((request as any).body);

        const client = await pool.connect();
        try {
          const result = await client.query(
            `UPDATE support_tickets
             SET status = $1, updated_at = NOW()
             WHERE id = $2
             RETURNING id, user_id, organization_id, issue_type, email, message, status, created_at, updated_at`,
            [body.status, id]
          );
          if (result.rows.length === 0) {
            return reply.code(404).send({ error: 'Ticket not found' });
          }
          const row = result.rows[0];
          return reply.send({
            id: row.id,
            ticketId: row.id,
            userId: row.user_id,
            organizationId: row.organization_id,
            issueType: row.issue_type,
            email: row.email,
            message: row.message,
            status: row.status,
            createdAt: row.created_at?.toISOString?.() ?? row.created_at,
            updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
          });
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

