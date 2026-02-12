import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/app';

describe('Dashboard Webhooks API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;

  beforeAll(async () => {
    app = await buildApp({ registerJobHandler: false });

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        organization_name: 'Webhooks Test Org',
        email: `webhooks-${Date.now()}@example.com`,
        password: 'Password123!',
      },
    });
    const signupBody = JSON.parse(signupRes.payload);
    token = signupBody.token;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/dashboard/webhooks', () => {
    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/dashboard/webhooks',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns config or null with valid JWT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/dashboard/webhooks',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('PUT /api/dashboard/webhooks', () => {
    it('updates webhook config', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/dashboard/webhooks',
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          url: 'https://webhook.example.com/verifyx',
          events: {
            verificationApproved: true,
            verificationRejected: true,
          },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
    });
  });
});
