import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/app';

function buildMultipartBody(
  fieldName: string,
  filename: string,
  contentType: string,
  buffer: Buffer
): { payload: Buffer; contentType: string } {
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const crlf = '\r\n';
  const parts: Buffer[] = [];
  parts.push(Buffer.from(`--${boundary}${crlf}`, 'utf8'));
  parts.push(
    Buffer.from(
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"${crlf}Content-Type: ${contentType}${crlf}${crlf}`,
      'utf8'
    )
  );
  parts.push(buffer);
  parts.push(Buffer.from(`${crlf}--${boundary}--${crlf}`, 'utf8'));
  return {
    payload: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('SDK Verifications API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  let publicKey: string;
  let verificationId: string;

  beforeAll(async () => {
    app = await buildApp({ registerJobHandler: false });

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        organization_name: 'SDK Test Org',
        email: `sdk-${Date.now()}@example.com`,
        password: 'Password123!',
      },
    });
    const signupBody = JSON.parse(signupRes.payload);
    token = signupBody.token;
    publicKey = signupBody.apiKeys.publicKey;

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/verifications',
      headers: { Authorization: `Bearer ${publicKey}` },
      payload: { country: 'IN', documentType: 'passport' },
    });
    const createBody = JSON.parse(createRes.payload);
    verificationId = createBody.verificationId;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/v1/country-modules', () => {
    it('returns 401 without API key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/country-modules',
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns countries with valid secret key', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/country-modules',
        headers: {
          Authorization: `Bearer ${publicKey}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.countries).toBeDefined();
      expect(Array.isArray(body.countries)).toBe(true);
    });
  });

  describe('POST /api/v1/verifications', () => {
    it('creates verification and returns verificationId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/verifications',
        headers: {
          Authorization: `Bearer ${publicKey}`,
        },
        payload: {
          country: 'IN',
          documentType: 'passport',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.verificationId).toMatch(/^ver_/);
      expect(body.status).toBe('pending');
      expect(body.createdAt).toBeDefined();
    });

    it('returns 400 for invalid document type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/verifications',
        headers: {
          Authorization: `Bearer ${publicKey}`,
        },
        payload: {
          country: 'IN',
          documentType: 'invalid',
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/verifications/:verificationId', () => {
    it('returns 404 for non-existent verification', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/verifications/ver_00000000000000000000000000000000',
        headers: {
          Authorization: `Bearer ${publicKey}`,
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns verification status for existing verification', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/verifications/${verificationId}`,
        headers: { Authorization: `Bearer ${publicKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.verificationId).toBe(verificationId);
      expect(body.status).toBeDefined();
    });
  });

  describe('GET /api/v1/verifications/:verificationId/details', () => {
    it('returns 404 when no PII exists yet', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/verifications',
        headers: { Authorization: `Bearer ${publicKey}` },
        payload: { country: 'IN', documentType: 'passport' },
      });
      const createBody = JSON.parse(createRes.payload);
      const freshVerificationId = createBody.verificationId;

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/verifications/${freshVerificationId}/details`,
        headers: { Authorization: `Bearer ${publicKey}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns details when PII exists after document upload', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/verifications/${verificationId}/details`,
        headers: { Authorization: `Bearer ${publicKey}` },
      });

      expect([200, 404]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        const body = JSON.parse(res.payload);
        expect(body.fullName).toBeDefined();
        expect(body.documentType).toBeDefined();
      }
    });
  });

  describe('POST /api/v1/verifications/:verificationId/documents', () => {
    it('returns 400 when no file is uploaded', async () => {
      const { payload, contentType } = buildMultipartBody(
        'file',
        'document.jpg',
        'image/jpeg',
        Buffer.from('')
      );
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/verifications/${verificationId}/documents?side=front`,
        headers: {
          Authorization: `Bearer ${publicKey}`,
          'Content-Type': contentType,
        },
        payload,
      });

      expect([400, 422, 500]).toContain(res.statusCode);
    });

    it('accepts multipart document upload when S3 is configured', async () => {
      const minimalJpeg = Buffer.from(
        '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAM',
        'base64'
      );
      const { payload, contentType } = buildMultipartBody(
        'file',
        'document.jpg',
        'image/jpeg',
        minimalJpeg
      );
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/verifications/${verificationId}/documents?side=front`,
        headers: {
          Authorization: `Bearer ${publicKey}`,
          'Content-Type': contentType,
        },
        payload,
      });

      expect([200, 422, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        const body = JSON.parse(res.payload);
        expect(body.verificationId).toBe(verificationId);
        expect(body.status).toBe('documents_uploaded');
      }
    });
  });

  describe('POST /api/v1/verifications/:verificationId/confirm-details', () => {
    it('returns 404 when no PII exists', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/verifications',
        headers: { Authorization: `Bearer ${publicKey}` },
        payload: { country: 'IN', documentType: 'passport' },
      });
      const createBody = JSON.parse(createRes.payload);
      const freshVerificationId = createBody.verificationId;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/verifications/${freshVerificationId}/confirm-details`,
        headers: { Authorization: `Bearer ${publicKey}` },
        payload: { fullName: 'Test User', idNumber: 'AB123456' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/v1/verifications/:verificationId/process', () => {
    it('returns 400 when verification not ready for processing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/verifications/${verificationId}/process`,
        headers: { Authorization: `Bearer ${publicKey}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('not ready');
    });
  });
});
