import { describe, it, expect, vi } from 'vitest';

vi.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: vi.fn(),
  S3Client: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({
      Body: (async function* () {
        yield Buffer.from('mock image');
      })(),
    }),
  })),
}));

vi.mock('@google-cloud/vision', () => ({
  ImageAnnotatorClient: vi.fn().mockImplementation(() => ({
    annotateImage: vi.fn().mockResolvedValue([
      {
        labelAnnotations: [],
      },
    ]),
  })),
}));

describe('Spoof Detection', () => {
  it('analyzeSpoofSignalsForImages returns empty for empty array', async () => {
    const { analyzeSpoofSignalsForImages } = await import('../../../src/services/ai/spoof-detection');
    const result = await analyzeSpoofSignalsForImages([]);
    expect(result.spoofRiskScore).toBe(0);
    expect(result.signals).toEqual([]);
  });
});
