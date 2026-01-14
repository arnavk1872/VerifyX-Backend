import { FastifyRequest, FastifyReply } from 'fastify';

export function requireApiKeyAuth(request: FastifyRequest, reply: FastifyReply): string | null {
  if (!request.organizationId) {
    reply.code(401).send({ error: 'Unauthorized: API key required' });
    return null;
  }
  return request.organizationId;
}

export function requireSecretKey(request: FastifyRequest, reply: FastifyReply): string | null {
  const authHeader = request.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Unauthorized: Secret key required' });
    return null;
  }

  const token = authHeader.substring(7).trim();
  
  if (!token.startsWith('sk_live_')) {
    reply.code(401).send({ error: 'Unauthorized: Invalid secret key format' });
    return null;
  }

  if (!request.organizationId) {
    reply.code(401).send({ error: 'Unauthorized: Invalid secret key' });
    return null;
  }

  return request.organizationId;
}

