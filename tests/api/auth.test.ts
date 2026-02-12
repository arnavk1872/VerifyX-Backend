import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/app';

describe('Auth API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({ registerJobHandler: false });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /auth/signup', () => {
    it('returns 201 with token and apiKeys for valid body', async () => {
      const email = `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: {
          organization_name: 'Test Org',
          email,
          password: 'Password123!',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.token).toBeDefined();
      expect(body.user).toBeDefined();
      expect(body.user.email).toBe(email);
      expect(body.apiKeys).toBeDefined();
      expect(body.apiKeys.publicKey).toMatch(/^pk_live_/);
      expect(body.apiKeys.secretKey).toMatch(/^sk_live_/);
    });

    it('returns 409 for duplicate email', async () => {
      const email = `dup-${Date.now()}@example.com`;
      await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: {
          organization_name: 'Org 1',
          email,
          password: 'Password123!',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: {
          organization_name: 'Org 2',
          email,
          password: 'Password123!',
        },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Email already exists');
    });

    it('returns 400 for invalid request body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: {
          organization_name: '',
          email: 'invalid-email',
          password: 'short',
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /auth/login', () => {
    it('returns 200 with token for valid credentials', async () => {
      const email = `login-${Date.now()}@example.com`;
      await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: {
          organization_name: 'Login Test Org',
          email,
          password: 'Password123!',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: 'Password123!' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.token).toBeDefined();
      expect(body.user.email).toBe(email);
    });

    it('returns 401 for invalid password', async () => {
      const email = `wrongpw-${Date.now()}@example.com`;
      await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: {
          organization_name: 'Wrong PW Org',
          email,
          password: 'Password123!',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: 'WrongPassword' },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Invalid email or password');
    });

    it('returns 401 for non-existent email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'nonexistent@example.com',
          password: 'Password123!',
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /auth/forgot-password', () => {
    it('returns 200 with generic message', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'any@example.com' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.message).toBeDefined();
    });
  });

  describe('POST /auth/reset-password', () => {
    it('returns 400 for invalid code', async () => {
      const email = `reset-${Date.now()}@example.com`;
      await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: {
          organization_name: 'Reset Org',
          email,
          password: 'Password123!',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: {
          email,
          code: '000000',
          password: 'NewPassword123!',
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
