import { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyToken } from '../auth/jwt';
import { authenticateSecretKey, authenticatePublicKey } from '../auth/api-key-auth';

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

    const publicKeyAuth = await authenticatePublicKey(request);
    if (publicKeyAuth) {
      request.organizationId = publicKeyAuth.organizationId;
      return;
    }

    const secretKeyAuth = await authenticateSecretKey(request);
    if (secretKeyAuth) {
      request.organizationId = secretKeyAuth.organizationId;
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

