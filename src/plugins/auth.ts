import { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyToken } from '../utils/jwt';
import { AuthUser } from '../types/auth';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export function setupAuth(fastify: FastifyInstance) {
  fastify.decorateRequest('user', null);

  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return;
    }

    const token = authHeader.substring(7);
    
    if (!token || token.trim().length === 0) {
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
    }
  });
}

