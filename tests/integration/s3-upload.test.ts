import { describe, it, expect, vi } from 'vitest';

const mockSend = vi.fn().mockResolvedValue({});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: vi.fn(),
}));

describe('S3 Upload Integration', () => {
  it('produces key with correct format and calls S3', async () => {
    process.env.S3_BUCKET_NAME = 'test-bucket';

    const { uploadToS3 } = await import('../../src/services/aws/s3');

    const buffer = Buffer.from('test image');
    const result = await uploadToS3(
      buffer,
      'document.jpg',
      'image/jpeg',
      'org-123',
      'ver-456',
      'document'
    );

    expect(result.key).toMatch(/^organizations\/org-123\/verifications\/ver-456\/document_\d+\.jpg$/);
    expect(result.bucket).toBe('test-bucket');
    expect(result.url).toContain('test-bucket');
    expect(mockSend).toHaveBeenCalled();
  });
});
