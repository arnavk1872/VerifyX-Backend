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

/** Minimum line height (fraction of page height) to keep. Smaller text (icons, watermarks) is excluded. Env OCR_MIN_LINE_HEIGHT_NORMALIZED overrides. */
const MIN_OCR_LINE_HEIGHT_NORMALIZED = Number(process.env.OCR_MIN_LINE_HEIGHT_NORMALIZED ?? '0.02');

type TextSegment = { startIndex: number; endIndex: number };

/**
 * Filters out very small text (e.g. icon/watermark text) from Document AI output using layout.
 * Returns text from lines/blocks/paragraphs whose normalized height >= threshold; otherwise full document.text.
 */
function filterSmallTextFromDocument(document: any): string {
  const fullText = document?.text ?? '';
  if (!fullText) return fullText;

  const pages = document?.pages ?? [];
  if (!Array.isArray(pages) || pages.length === 0) return fullText;

  const segments: TextSegment[] = [];

  for (const page of pages) {
    const elements = page.lines ?? page.blocks ?? page.paragraphs ?? [];
    if (!Array.isArray(elements) || elements.length === 0) continue;

    const pageHeight = page.dimension?.height ?? 1;

    for (const el of elements) {
      const layout = el.layout;
      if (!layout?.textAnchor?.textSegments?.length) continue;

      const seg = layout.textAnchor.textSegments[0];
      const startIndex = Number(seg.startIndex ?? 0);
      const endIndex = Number(seg.endIndex ?? 0);
      if (endIndex <= startIndex) continue;

      const poly = layout.boundingPoly;
      if (!poly) {
        segments.push({ startIndex, endIndex });
        continue;
      }

      const vertices = poly.normalizedVertices ?? poly.vertices ?? [];
      if (vertices.length === 0) {
        segments.push({ startIndex, endIndex });
        continue;
      }

      const ys = vertices.map((v: any) => Number(v.y ?? 0));
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      let heightNorm = maxY - minY;
      const usedNormalized = poly.normalizedVertices && poly.normalizedVertices.length > 0;
      if (!usedNormalized && pageHeight > 0) {
        heightNorm = heightNorm / pageHeight;
      }
      if (heightNorm >= MIN_OCR_LINE_HEIGHT_NORMALIZED) {
        segments.push({ startIndex, endIndex });
      }
    }
  }

  if (segments.length === 0) return fullText;

  segments.sort((a, b) => a.startIndex - b.startIndex);

  const parts: string[] = [];
  let lastEnd = -1;
  for (const { startIndex, endIndex } of segments) {
    if (lastEnd >= 0 && startIndex > lastEnd) {
      parts.push('\n');
    }
    parts.push(fullText.slice(startIndex, endIndex));
    lastEnd = endIndex;
  }
  return parts.join('');
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

    const document = result.document;
    const text = document ? filterSmallTextFromDocument(document) : '';
    const outLen = (text || '').length;
    const fullLen = document?.text?.length ?? 0;
    if (fullLen > 0 && outLen < fullLen) {
      console.log(`[Document AI] extractTextFromS3: Filtered small text ${s3Key} (${outLen}/${fullLen} chars)`);
    } else {
      console.log(`[Document AI] extractTextFromS3: Extracted ${outLen} characters from ${s3Key}`);
    }
    return text || '';
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
