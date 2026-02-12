import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/app';

describe('Dashboard Analytics API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;

  beforeAll(async () => {
    app = await buildApp({ registerJobHandler: false });

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        organization_name: 'Analytics Test Org',
        email: `analytics-${Date.now()}@example.com`,
        password: 'Password123!',
      },
    });
    const signupBody = JSON.parse(signupRes.payload);
    token = signupBody.token;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/dashboard/analytics', () => {
    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/dashboard/analytics',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns kpis and volume with valid JWT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/dashboard/analytics',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.kpis).toBeDefined();
      expect(body.volume).toBeDefined();
      expect(body.funnel).toBeDefined();
      expect(body.rejectionReasons).toBeDefined();
    });
  });
});
