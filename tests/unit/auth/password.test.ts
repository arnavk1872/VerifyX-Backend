import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../../src/auth/password';

describe('Password', () => {
  const password = 'SecurePassword123!';

  describe('hashPassword', () => {
    it('produces a hash string', async () => {
      const hash = await hashPassword(password);
      expect(typeof hash).toBe('string');
      expect(hash).not.toBe(password);
      expect(hash.length).toBeGreaterThan(20);
    });

    it('produces different hashes for same password (salted)', async () => {
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyPassword', () => {
    it('returns true for correct password', async () => {
      const hash = await hashPassword(password);
      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('returns false for wrong password', async () => {
      const hash = await hashPassword(password);
      const isValid = await verifyPassword('WrongPassword', hash);
      expect(isValid).toBe(false);
    });
  });
});
