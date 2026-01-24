import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/role-guard';

const supportTicketSchema = z.object({
  issueType: z.enum(['verification_issue', 'technical_problem', 'document_question', 'account_issue']),
  email: z.string().email(),
  message: z.string().min(10).max(5000),
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
}

