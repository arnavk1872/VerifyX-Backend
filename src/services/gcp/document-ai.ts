import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../aws/s3';

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCP_LOCATION = process.env.GCP_LOCATION || 'us';
const GCP_PROCESSOR_ID = process.env.GCP_PROCESSOR_ID;
const GCP_GENERAL_PROCESSOR_ID = process.env.GCP_GENERAL_PROCESSOR_ID || 'general-processor';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

const documentAiClient = new DocumentProcessorServiceClient();

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

export interface ExtractedFields {
  fullName?: string;
  dob?: string;
  idNumber?: string;
  address?: string;
  rawText?: string;
  extractedFields?: Record<string, any>;
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

export async function analyzeIDFromS3(s3Key: string): Promise<ExtractedFields> {
  if (!GCP_PROJECT_ID || !GCP_PROCESSOR_ID) {
    throw new Error('GCP_PROJECT_ID and GCP_PROCESSOR_ID environment variables are required');
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

    const rawText = result.document?.text || '';
    
    const extractedFields: ExtractedFields = {
      extractedFields: {},
      rawText,
    };

    if (!result.document?.entities || result.document.entities.length === 0) {
      console.log(`[Document AI] analyzeIDFromS3: No entities found for ${s3Key}, returning rawText (${rawText.length} chars)`);
      return extractedFields;
    }

    console.log(`[Document AI] analyzeIDFromS3: Found ${result.document.entities.length} entities for ${s3Key}`);

    for (const entity of result.document.entities) {
      if (!entity.type || !entity.mentionText) {
        continue;
      }

      const fieldType = entity.type.toLowerCase();
      const fieldValue = entity.mentionText;

      extractedFields.extractedFields![fieldType] = fieldValue;

      if (fieldType.includes('name') || fieldType.includes('given_name') || fieldType.includes('family_name')) {
        if (!extractedFields.fullName) {
          extractedFields.fullName = fieldValue;
        } else {
          extractedFields.fullName += ' ' + fieldValue;
        }
      } else if (fieldType.includes('date_of_birth') || fieldType.includes('dob') || fieldType.includes('birth')) {
        extractedFields.dob = fieldValue;
      } else if (fieldType.includes('document_number') || fieldType.includes('id_number') || fieldType.includes('passport_number')) {
        extractedFields.idNumber = fieldValue;
      } else if (fieldType.includes('address')) {
        extractedFields.address = fieldValue;
      }
    }

    return extractedFields;
  } catch (error: any) {
    console.error(`[Document AI] analyzeIDFromS3 failed:`, error);
    throw error;
  }
}
