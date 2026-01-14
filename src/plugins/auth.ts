import { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyToken } from '../utils/jwt';
import { authenticateSecretKey } from '../utils/api-key-auth';

export function setupAuth(fastify: FastifyInstance) {
  fastify.decorateRequest('user', null);
  fastify.decorateRequest('organizationId', null);

  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return;
    }

    const token = authHeader.substring(7).trim();
    
    if (!token || token.length === 0) {
      return;
    }

    const apiKeyAuth = await authenticateSecretKey(request);
    if (apiKeyAuth) {
      request.organizationId = apiKeyAuth.organizationId;
      return;
    }

    const payload = verifyToken(token);

    if (payload) {
      request.user = {
        userId: payload.userId,
        organizationId: payload.organizationId,
        email: payload.email,
        role: payload.role,
      };
      request.organizationId = payload.organizationId;
    }
  });
}

