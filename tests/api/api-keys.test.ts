import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/app';

describe('API Keys API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;

  beforeAll(async () => {
    app = await buildApp({ registerJobHandler: false });

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        organization_name: 'API Keys Test Org',
        email: `apikeys-${Date.now()}@example.com`,
        password: 'Password123!',
      },
    });
    const signupBody = JSON.parse(signupRes.payload);
    token = signupBody.token;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/api-keys', () => {
    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/api-keys',
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns keys with valid JWT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/api-keys',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.keys).toBeDefined();
      expect(Array.isArray(body.keys)).toBe(true);
      expect(body.warning).toBeDefined();
    });
  });

  describe('POST /api/api-keys/rotate', () => {
    it('returns new keys when rotating', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/api-keys/rotate',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.publicKey).toMatch(/^pk_live_/);
      expect(body.secretKey).toMatch(/^sk_live_/);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/api-keys/rotate',
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
