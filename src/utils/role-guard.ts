import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthUser, UserRole } from '../types/auth';

export function requireAuth(request: FastifyRequest, reply: FastifyReply): AuthUser | null {
  if (!request.user) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return request.user;
}

export function requireRole(allowedRoles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = requireAuth(request, reply);
    if (!user) {
      return;
    }

    if (!allowedRoles.includes(user.role)) {
      reply.code(403).send({ error: 'Forbidden: insufficient permissions' });
      return;
    }
  };
}

