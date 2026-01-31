import { pool } from '../../db/pool';

const EVENT_TO_CONFIG_KEY: Record<string, string> = {
  verification_approved: 'verificationApproved',
  verification_rejected: 'verificationRejected',
  manual_review_required: 'manualReviewRequired',
  document_uploaded: 'documentUploaded',
  verification_started: 'verificationStarted',
};

const DELIVERY_TIMEOUT_MS = 8000;

export async function deliverWebhook(
  organizationId: string,
  event: string,
  payload: Record<string, any>
): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT url, events FROM webhook_config WHERE organization_id = $1`,
      [organizationId]
    );
    if (result.rows.length === 0) {
      console.warn(`[webhook] no config for org ${organizationId}, event ${event}`);
      return;
    }
    const row = result.rows[0];
    const url = row?.url?.trim();
    if (!url) {
      console.warn(`[webhook] org ${organizationId} has no url, event ${event}`);
      return;
    }
    const events = typeof row.events === 'object' && row.events !== null ? row.events : {};
    const configKey = EVENT_TO_CONFIG_KEY[event];
    if (configKey && events[configKey] === false) {
      console.warn(`[webhook] event ${event} disabled for org ${organizationId}`);
      return;
    }

    const body = {
      event,
      timestamp: new Date().toISOString(),
      ...payload,
    };

    console.warn(`[webhook] sending ${event} to ${url}`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        console.warn(`[webhook] ${event} delivery to ${url} failed: ${res.status}`);
      } else {
        console.warn(`[webhook] ${event} delivered to ${url} ${res.status}`);
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err?.name === 'AbortError') {
        console.warn(`[webhook] ${event} delivery to ${url} timed out`);
      } else {
        console.warn(`[webhook] ${event} delivery to ${url} error:`, err?.message ?? err);
      }
    }
  } finally {
    client.release();
  }
}
