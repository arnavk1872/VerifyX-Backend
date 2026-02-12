import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/app';
import { pool } from '../../src/db/pool';
import { v4 as uuidv4 } from 'uuid';

vi.mock('../../src/services/gcp/vision', () => ({
  compareFaces: vi.fn().mockResolvedValue({ similarity: 95, isMatch: true, confidence: 0.95 }),
  detectFaces: vi.fn().mockResolvedValue({ hasFace: true, faceCount: 1 }),
}));

vi.mock('../../src/services/gcp/video-liveness', () => ({
  detectFacesInVideo: vi.fn().mockResolvedValue({ hasFace: true, faceCount: 1 }),
}));

vi.mock('../../src/ocr/document-parser', () => ({
  extractAndParseDocument: vi.fn().mockResolvedValue({
    fullName: 'Test User',
    idNumber: 'AB123456',
    expiryDate: '2030-12-31',
    extractedFields: {},
  }),
}));

vi.mock('../../src/services/ai/spoof-detection', () => ({
  analyzeSpoofSignalsForImages: vi.fn().mockResolvedValue({ spoofRiskScore: 0, signals: [] }),
}));

vi.mock('../../src/services/webhooks/deliver', () => ({
  deliverWebhook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/aws/s3', () => ({
  uploadToS3: vi.fn().mockResolvedValue({ key: 'test-key', url: 'https://test.com', bucket: 'test' }),
  getSignedS3Url: vi.fn().mockResolvedValue('https://signed-url.test'),
}));

describe('Verification Pipeline Integration', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId: string;
  let verificationId: string;

  beforeAll(async () => {
    app = await buildApp({ registerJobHandler: true });

    const client = await pool.connect();
    try {
      orgId = uuidv4();
      verificationId = uuidv4();
      await client.query(
        `INSERT INTO organizations (id, name, plan) VALUES ($1, $2, 'free')`,
        [orgId, 'Test Org']
      );
      await client.query(
        `INSERT INTO verifications (id, organization_id, id_type, status)
         VALUES ($1, $2, 'passport', 'liveness_uploaded')`,
        [verificationId, orgId]
      );
      await client.query(
        `INSERT INTO verification_pii (verification_id, document_images, full_name, id_number)
         VALUES ($1, $2, $3, $4)`,
        [
          verificationId,
          JSON.stringify({
            document: { s3Key: 'doc-key' },
            liveness: { s3Key: 'liveness-key', type: 'image' },
          }),
          'Test User',
          'AB123456',
        ]
      );
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM verification_pii WHERE verification_id = $1', [verificationId]);
      await client.query('DELETE FROM verifications WHERE id = $1', [verificationId]);
      await client.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    } finally {
      client.release();
    }
    await app.close();
  });

  it('processes verification and updates status', async () => {
    const { processVerification } = await import('../../src/services/ai/processor');
    await processVerification(verificationId);

    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT status, match_score, risk_level FROM verifications WHERE id = $1',
        [verificationId]
      );
      expect(result.rows[0].status).toMatch(/Completed|Rejected/);
      expect(result.rows[0].match_score).toBeDefined();
      expect(result.rows[0].risk_level).toBeDefined();
    } finally {
      client.release();
    }
  });
});
