import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/app';

describe('Dashboard Verifications API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;

  beforeAll(async () => {
    app = await buildApp({ registerJobHandler: false });

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        organization_name: 'Dashboard Verifications Test Org',
        email: `dash-ver-${Date.now()}@example.com`,
        password: 'Password123!',
      },
    });
    const signupBody = JSON.parse(signupRes.payload);
    token = signupBody.token;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/dashboard/verifications', () => {
    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/dashboard/verifications',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns list with valid JWT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/dashboard/verifications',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toBeDefined();
      expect(body.totalCount).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('accepts filter query params', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/dashboard/verifications?status=All&page=1&limit=10',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
