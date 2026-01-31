import { FastifyInstance } from 'fastify';
import { registerUserRoutes } from './user';
import { registerAnalyticsRoutes } from './analytics';
import { registerVerificationRoutes } from './verifications';
import { registerWebhookRoutes } from './webhooks';
import { registerOrganizationRoutes } from './organizations';

export async function dashboardRoutes(fastify: FastifyInstance) {
  await fastify.register(registerUserRoutes);
  await fastify.register(registerAnalyticsRoutes);
  await fastify.register(registerVerificationRoutes);
  await fastify.register(registerWebhookRoutes);
  await fastify.register(registerOrganizationRoutes);
}
