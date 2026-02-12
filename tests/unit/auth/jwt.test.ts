import { describe, it, expect } from 'vitest';
import { generateToken, verifyToken } from '../../../src/auth/jwt';

describe('JWT', () => {
  const payload = {
    userId: 'user-123',
    organizationId: 'org-456',
    email: 'test@example.com',
    role: 'KYC_ADMIN' as const,
  };

  describe('generateToken', () => {
    it('produces a valid JWT string', () => {
      const token = generateToken(payload);
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('produces different tokens for different payloads', () => {
      const token1 = generateToken(payload);
      const token2 = generateToken({ ...payload, userId: 'user-789' });
      expect(token1).not.toBe(token2);
    });
  });

  describe('verifyToken', () => {
    it('returns payload for valid token', () => {
      const token = generateToken(payload);
      const decoded = verifyToken(token);
      expect(decoded).not.toBeNull();
      expect(decoded?.userId).toBe(payload.userId);
      expect(decoded?.organizationId).toBe(payload.organizationId);
      expect(decoded?.email).toBe(payload.email);
      expect(decoded?.role).toBe(payload.role);
    });

    it('returns null for invalid token', () => {
      const decoded = verifyToken('invalid.jwt.token');
      expect(decoded).toBeNull();
    });

    it('returns null for malformed token', () => {
      expect(verifyToken('')).toBeNull();
      expect(verifyToken('not-a-jwt')).toBeNull();
    });
  });
});
