import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processVerification } from '../../../src/services/ai/processor';

vi.mock('../../../src/db/pool', () => ({
  pool: {
    connect: vi.fn(),
  },
}));

vi.mock('../../../src/services/webhooks/deliver', () => ({
  deliverWebhook: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../src/services/gcp/vision', () => ({
  compareFaces: vi.fn(),
  detectFaces: vi.fn(),
}));

vi.mock('../../../src/services/gcp/video-liveness', () => ({
  detectFacesInVideo: vi.fn(),
}));

vi.mock('../../../src/ocr/document-parser', () => ({
  extractAndParseDocument: vi.fn(),
}));

vi.mock('../../../src/services/ai/spoof-detection', () => ({
  analyzeSpoofSignalsForImages: vi.fn(),
}));

import { pool } from '../../../src/db/pool';

describe('Verification Processor', () => {
  const mockRelease = vi.fn();
  const mockQuery = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: mockQuery,
      release: mockRelease,
    });
  });

  describe('processVerification', () => {
    it('throws when verification not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await expect(processVerification('non-existent-id')).rejects.toThrow('Verification not found');

      expect(mockRelease).toHaveBeenCalled();
    });

    it('processes verification and updates status when data is present', async () => {
      const verificationId = '550e8400-e29b-41d4-a716-446655440000';
      const orgId = 'org-123';

      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: verificationId,
              organization_id: orgId,
              id_type: 'passport',
              status: 'processing',
              document_images: {
                document: { s3Key: 'doc-key' },
                liveness: { s3Key: 'liveness-key', type: 'image' },
              },
              full_name: 'John Doe',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ verification_rules: {} }] })
        .mockResolvedValueOnce({ rows: [{ signals: null }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const { extractAndParseDocument } = await import('../../../src/ocr/document-parser');
      const { compareFaces } = await import('../../../src/services/gcp/vision');

      (extractAndParseDocument as ReturnType<typeof vi.fn>).mockResolvedValue({
        fullName: 'John Doe',
        idNumber: 'AB123456',
        expiryDate: '2030-12-31',
        extractedFields: {},
      });

      (compareFaces as ReturnType<typeof vi.fn>).mockResolvedValue({
        similarity: 95,
        isMatch: true,
        confidence: 0.95,
      });

      await processVerification(verificationId);

      expect(mockQuery).toHaveBeenCalled();
      expect(mockRelease).toHaveBeenCalled();
    });
  });
});
