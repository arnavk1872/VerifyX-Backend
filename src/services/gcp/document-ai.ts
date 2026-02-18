import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../aws/s3';
import { getGcpCredentials } from './credentials';

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCP_LOCATION = process.env.GCP_LOCATION || 'us';
const GCP_PROCESSOR_ID = process.env.GCP_PROCESSOR_ID;
const GCP_GENERAL_PROCESSOR_ID = process.env.GCP_GENERAL_PROCESSOR_ID || 'general-processor';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

const documentAiClient = new DocumentProcessorServiceClient(getGcpCredentials() ? { credentials: getGcpCredentials() as any } : {});

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

function detectMimeType(s3Key: string): string {
  const ext = s3Key.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'pdf': 'application/pdf',
  };
  return mimeTypes[ext || ''] || 'image/jpeg';
}

export async function extractTextFromS3(s3Key: string): Promise<string> {
  if (!GCP_PROJECT_ID) {
    throw new Error('GCP_PROJECT_ID environment variable is required');
  }

  const imageBuffer = await downloadFromS3(s3Key);
  const mimeType = detectMimeType(s3Key);

  const name = `projects/${GCP_PROJECT_ID}/locations/${GCP_LOCATION}/processors/${GCP_GENERAL_PROCESSOR_ID}`;

  try {
    const [result] = await documentAiClient.processDocument({
      name,
      rawDocument: {
        content: imageBuffer,
        mimeType,
      },
    });

    const text = result.document?.text || '';
    console.log(`[Document AI] extractTextFromS3: Extracted ${text.length} characters from ${s3Key}`);
    return text;
  } catch (error: any) {
    console.error(`[Document AI] extractTextFromS3 failed for ${s3Key}:`, error);
    throw error;
  }
}

/**
 * Runs the document fraud detection processor (GCP_PROCESSOR_ID) for fraud signals only.
 * Call this after extraction; do not use for field extraction.
 * Returns null if GCP_PROCESSOR_ID is not set.
 */
export async function runDocumentFraudDetection(
  s3Key: string
): Promise<{ signals: Record<string, string> } | null> {
  if (!GCP_PROJECT_ID || !GCP_PROCESSOR_ID) {
    return null;
  }

  const imageBuffer = await downloadFromS3(s3Key);
  const mimeType = detectMimeType(s3Key);
  const name = `projects/${GCP_PROJECT_ID}/locations/${GCP_LOCATION}/processors/${GCP_PROCESSOR_ID}`;

  try {
    const [result] = await documentAiClient.processDocument({
      name,
      rawDocument: {
        content: imageBuffer,
        mimeType,
      },
    });

    const signals: Record<string, string> = {};
    const entities = result.document?.entities ?? [];
    for (const entity of entities) {
      if (entity.type && entity.mentionText) {
        signals[entity.type] = entity.mentionText;
      }
    }
    if (Object.keys(signals).length > 0) {
      console.log(`[Document AI] runDocumentFraudDetection: ${entities.length} signals for ${s3Key}`);
    }
    return { signals };
  } catch (error: any) {
    console.error(`[Document AI] runDocumentFraudDetection failed for ${s3Key}:`, error?.message);
    return null;
  }
}
