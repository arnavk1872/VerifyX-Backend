import { VideoIntelligenceServiceClient, protos } from '@google-cloud/video-intelligence';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../aws/s3';
import { getGcpCredentials } from './credentials';

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

const videoClient = new VideoIntelligenceServiceClient(getGcpCredentials() ? { credentials: getGcpCredentials() as any } : {});

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

export async function detectFacesInVideo(s3Key: string): Promise<{ faceCount: number; hasFace: boolean }> {
  const videoBuffer = await downloadFromS3(s3Key);

  const [operation] = await videoClient.annotateVideo({
    inputContent: videoBuffer,
    features: [protos.google.cloud.videointelligence.v1.Feature.FACE_DETECTION],
  });

  const [results] = await operation.promise();
  const annotationResult = results?.annotationResults?.[0];
  const faceAnnotations = annotationResult?.faceDetectionAnnotations ?? [];

  const faceCount = faceAnnotations.length;

  return {
    faceCount,
    hasFace: faceCount > 0,
  };
}
