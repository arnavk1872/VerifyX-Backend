import { TextractClient, DetectDocumentTextCommand, AnalyzeIDCommand } from '@aws-sdk/client-textract';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

const textractClient = new TextractClient({
  region: AWS_REGION,
  ...(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && {
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  }),
});

export interface ExtractedFields {
  fullName?: string;
  dob?: string;
  idNumber?: string;
  address?: string;
  rawText?: string;
  extractedFields?: Record<string, any>;
}

export async function extractTextFromS3(s3Key: string): Promise<string> {
  if (!S3_BUCKET_NAME) {
    throw new Error('S3_BUCKET_NAME environment variable is required');
  }

  const command = new DetectDocumentTextCommand({
    Document: {
      S3Object: {
        Bucket: S3_BUCKET_NAME,
        Name: s3Key,
      },
    },
  });

  const response = await textractClient.send(command);

  if (!response.Blocks) {
    return '';
  }

  const textBlocks = response.Blocks
    .filter(block => block.BlockType === 'LINE')
    .map(block => block.Text || '')
    .filter(text => text.length > 0);

  return textBlocks.join('\n');
}

export async function analyzeIDFromS3(s3Key: string): Promise<ExtractedFields> {
  if (!S3_BUCKET_NAME) {
    throw new Error('S3_BUCKET_NAME environment variable is required');
  }

  const command = new AnalyzeIDCommand({
    DocumentPages: [
      {
        S3Object: {
          Bucket: S3_BUCKET_NAME,
          Name: s3Key,
        },
      },
    ],
  });

  const response = await textractClient.send(command);

  const extractedFields: ExtractedFields = {
    extractedFields: {},
  };

  if (response.IdentityDocuments && response.IdentityDocuments.length > 0) {
    const document = response.IdentityDocuments[0];
    
    if (document && document.IdentityDocumentFields) {
      for (const field of document.IdentityDocumentFields) {
        if (field.Type && field.ValueDetection) {
          const fieldType = field.Type.Text?.toLowerCase() || '';
          const fieldValue = field.ValueDetection.Text || '';

          extractedFields.extractedFields![fieldType] = fieldValue;

          if (fieldType.includes('name') || fieldType.includes('given name') || fieldType.includes('family name')) {
            if (!extractedFields.fullName) {
              extractedFields.fullName = fieldValue;
            } else {
              extractedFields.fullName += ' ' + fieldValue;
            }
          } else if (fieldType.includes('date of birth') || fieldType.includes('dob') || fieldType.includes('birth')) {
            extractedFields.dob = fieldValue;
          } else if (fieldType.includes('document number') || fieldType.includes('id number') || fieldType.includes('passport number')) {
            extractedFields.idNumber = fieldValue;
          } else if (fieldType.includes('address')) {
            extractedFields.address = fieldValue;
          }
        }
      }
    }
  }

  return extractedFields;
}

