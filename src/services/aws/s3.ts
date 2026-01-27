import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const AWS_REGION = process.env.AWS_REGION || process.env.S3_REGION || 'us-east-1';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

if (!S3_BUCKET_NAME) {
  console.warn('S3_BUCKET_NAME not set - S3 uploads will fail');
}

export const s3Client = new S3Client({
  region: AWS_REGION,
  ...(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && {
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  }),
});

export interface UploadResult {
  key: string;
  url: string;
  bucket: string;
}

export async function uploadToS3(
  buffer: Buffer,
  fileName: string,
  contentType: string,
  organizationId: string,
  verificationId: string,
  fileType: 'document' | 'document_front' | 'document_back' | 'liveness'
): Promise<UploadResult> {
  if (!S3_BUCKET_NAME) {
    throw new Error('S3_BUCKET_NAME environment variable is required');
  }

  const timestamp = Date.now();
  const fileExtension = fileName.split('.').pop() || 'jpg';
  const key = `organizations/${organizationId}/verifications/${verificationId}/${fileType}_${timestamp}.${fileExtension}`;

  const command = new PutObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    Metadata: {
      organizationId,
      verificationId,
      fileType,
      uploadedAt: new Date().toISOString(),
    },
  });

  await s3Client.send(command);

  const url = `https://${S3_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;

  return {
    key,
    url,
    bucket: S3_BUCKET_NAME,
  };
}

export async function getSignedS3Url(key: string, expiresIn: number = 3600): Promise<string> {
  if (!S3_BUCKET_NAME) {
    throw new Error('S3_BUCKET_NAME environment variable is required');
  }

  const command = new GetObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: key,
  });

  return await getSignedUrl(s3Client, command, { expiresIn });
}

export function getS3KeyFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    
    if (pathParts.length >= 4 && pathParts[0] === 'organizations') {
      return pathParts.join('/');
    }
    
    return null;
  } catch {
    return null;
  }
}

