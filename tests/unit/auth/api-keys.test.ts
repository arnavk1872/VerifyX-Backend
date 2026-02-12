import { describe, it, expect } from 'vitest';
import {
  generateApiKeyPair,
  hashSecretKey,
  verifySecretKey,
  isValidPublicKey,
  isValidSecretKey,
} from '../../../src/auth/api-keys';

describe('API Keys', () => {
  describe('generateApiKeyPair', () => {
    it('returns publicKey with pk_live_ prefix', () => {
      const { publicKey } = generateApiKeyPair();
      expect(publicKey).toMatch(/^pk_live_/);
      expect(publicKey.length).toBeGreaterThan(10);
    });

    it('returns secretKey with sk_live_ prefix', () => {
      const { secretKey } = generateApiKeyPair();
      expect(secretKey).toMatch(/^sk_live_/);
      expect(secretKey.length).toBeGreaterThan(10);
    });

    it('returns different keys on each call', () => {
      const pair1 = generateApiKeyPair();
      const pair2 = generateApiKeyPair();
      expect(pair1.publicKey).not.toBe(pair2.publicKey);
      expect(pair1.secretKey).not.toBe(pair2.secretKey);
    });
  });

  describe('isValidPublicKey', () => {
    it('returns true for valid format', () => {
      const { publicKey } = generateApiKeyPair();
      expect(isValidPublicKey(publicKey)).toBe(true);
    });

    it('returns false for invalid prefix', () => {
      expect(isValidPublicKey('pk_test_abc')).toBe(false);
      expect(isValidPublicKey('sk_live_abc')).toBe(false);
    });

    it('returns false for wrong length', () => {
      expect(isValidPublicKey('pk_live_short')).toBe(false);
    });
  });

  describe('isValidSecretKey', () => {
    it('returns true for valid format', () => {
      const { secretKey } = generateApiKeyPair();
      expect(isValidSecretKey(secretKey)).toBe(true);
    });

    it('returns false for invalid prefix', () => {
      expect(isValidSecretKey('pk_live_abc')).toBe(false);
    });
  });

  describe('hashSecretKey and verifySecretKey', () => {
    it('can verify secret key after hashing', async () => {
      const { secretKey } = generateApiKeyPair();
      const hash = await hashSecretKey(secretKey);
      const isValid = await verifySecretKey(secretKey, hash);
      expect(isValid).toBe(true);
    });

    it('returns false for wrong secret key', async () => {
      const { secretKey } = generateApiKeyPair();
      const hash = await hashSecretKey(secretKey);
      const isValid = await verifySecretKey('wrong_secret_key', hash);
      expect(isValid).toBe(false);
    });
  });
});
