import { ImageAnnotatorClient } from '@google-cloud/vision';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../aws/s3';
import { getGcpCredentials } from '../gcp/credentials';

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

const visionClient = new ImageAnnotatorClient(
  getGcpCredentials() ? { credentials: getGcpCredentials() as any } : {}
);

async function downloadFromS3(s3Key: string): Promise<Buffer> {
  if (!S3_BUCKET_NAME) {
    throw new Error('S3_BUCKET_NAME environment variable is required');
  }

  const command = new GetObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: s3Key,
  });

  const response = await s3Client.send(command);
  if (!response.Body) {
    throw new Error('Failed to download file from S3');
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as any) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export interface SpoofDetectionResult {
  spoofRiskScore: number;
  signals: string[];
}

async function analyzeSingleImage(imageKey: string): Promise<SpoofDetectionResult> {
  const imageBuffer = await downloadFromS3(imageKey);

  try {
    const [result] = await visionClient.annotateImage({
      image: { content: imageBuffer },
      features: [
        { type: 'LABEL_DETECTION', maxResults: 10 },
      ],
    });

    const signals: string[] = [];
    let riskScore = 0;

    const labels = result.labelAnnotations || [];
    const hasScreenLikeLabel = labels.some((label) => {
      const description = (label.description || '').toLowerCase();
      const score = label.score || 0;
      return (
        score >= 0.7 &&
        (description.includes('screen') ||
          description.includes('monitor') ||
          description.includes('display') ||
          description.includes('lcd') ||
          description.includes('computer'))
      );
    });

    if (hasScreenLikeLabel) {
      signals.push('screen_capture_suspected');
      riskScore += 70;
    }

    return {
      spoofRiskScore: Math.min(100, riskScore),
      signals,
    };
  } catch (error: any) {
    console.error(`[SpoofDetection] Vision annotateImage failed for ${imageKey}:`, error);
    throw error;
  }
}

export async function analyzeSpoofSignalsForImages(
  imageKeys: string[]
): Promise<SpoofDetectionResult> {
  if (imageKeys.length === 0) {
    return { spoofRiskScore: 0, signals: [] };
  }

  const results = await Promise.all(
    imageKeys.map(async (key) => {
      try {
        return await analyzeSingleImage(key);
      } catch {
        return { spoofRiskScore: 0, signals: [] };
      }
    })
  );

  let maxScore = 0;
  const combinedSignals = new Set<string>();

  for (const res of results) {
    if (res.spoofRiskScore > maxScore) {
      maxScore = res.spoofRiskScore;
    }
    res.signals.forEach((s) => combinedSignals.add(s));
  }

  return {
    spoofRiskScore: maxScore,
    signals: Array.from(combinedSignals),
  };
}

