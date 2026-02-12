import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { pool } from '../../src/db/pool';
import { deliverWebhook } from '../../src/services/webhooks/deliver';
import { v4 as uuidv4 } from 'uuid';

describe('Webhook Delivery Integration', () => {
  let orgId: string;
  const webhookUrl = 'https://webhook.test.example.com/verifyx';
  const mockFetch = vi.fn();

  beforeAll(async () => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    orgId = uuidv4();
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO organizations (id, name, plan) VALUES ($1, $2, 'free')`,
        [orgId, 'Webhook Test Org']
      );
      await client.query(
        `INSERT INTO webhook_config (organization_id, url, events, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (organization_id) DO UPDATE SET url = $2, events = $3, updated_at = NOW()`,
        [
          orgId,
          webhookUrl,
          JSON.stringify({
            verificationApproved: true,
            verificationRejected: true,
            manualReviewRequired: true,
          }),
        ]
      );
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM webhook_config WHERE organization_id = $1', [orgId]);
      await client.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    } finally {
      client.release();
    }
  });

  it('sends webhook POST with correct payload', async () => {
    mockFetch.mockClear();

    await deliverWebhook(orgId, 'verification_approved', {
      verificationId: 'ver_123',
      verificationStatus: 'Approved',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(webhookUrl, expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.event).toBe('verification_approved');
    expect(body.timestamp).toBeDefined();
    expect(body.verificationId).toBe('ver_123');
  });
});
