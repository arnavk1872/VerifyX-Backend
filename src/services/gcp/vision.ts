import { ImageAnnotatorClient } from '@google-cloud/vision';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../aws/s3';

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

const visionClient = new ImageAnnotatorClient();

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

export interface FaceMatchResult {
  similarity: number;
  isMatch: boolean;
  confidence: number;
}

function normalizeLandmarks(landmarks: any[]): Record<string, { x: number; y: number; z: number }> {
  const normalized: Record<string, { x: number; y: number; z: number }> = {};
  
  for (const landmark of landmarks) {
    if (landmark.type && landmark.position) {
      normalized[landmark.type] = {
        x: landmark.position.x || 0,
        y: landmark.position.y || 0,
        z: landmark.position.z || 0,
      };
    }
  }
  
  return normalized;
}

function calculateFaceSimilarity(
  sourceLandmarks: Record<string, { x: number; y: number; z: number }>,
  targetLandmarks: Record<string, { x: number; y: number; z: number }>
): number {
  const commonTypes = Object.keys(sourceLandmarks).filter(type => targetLandmarks[type]);
  
  if (commonTypes.length === 0) {
    return 0;
  }

  let totalDistance = 0;
  for (const type of commonTypes) {
    const source = sourceLandmarks[type];
    const target = targetLandmarks[type];
    
    if (!source || !target) continue;
    
    const distance = Math.sqrt(
      Math.pow(source.x - target.x, 2) +
      Math.pow(source.y - target.y, 2) +
      Math.pow(source.z - target.z, 2)
    );
    
    totalDistance += distance;
  }

  const avgDistance = totalDistance / commonTypes.length;
  const maxExpectedDistance = 0.3;
  const similarity = Math.max(0, Math.min(100, (1 - Math.min(avgDistance / maxExpectedDistance, 1)) * 100));
  
  return similarity;
}

export async function compareFaces(
  sourceImageKey: string,
  targetImageKey: string,
  similarityThreshold: number = 80
): Promise<FaceMatchResult> {
  const sourceBuffer = await downloadFromS3(sourceImageKey);
  const targetBuffer = await downloadFromS3(targetImageKey);

  try {
    const [sourceResult] = await visionClient.faceDetection({
      image: { content: sourceBuffer },
    });

    const [targetResult] = await visionClient.faceDetection({
      image: { content: targetBuffer },
    });

    const sourceFaces = sourceResult.faceAnnotations || [];
    const targetFaces = targetResult.faceAnnotations || [];

    if (sourceFaces.length === 0 || targetFaces.length === 0) {
      return {
        similarity: 0,
        isMatch: false,
        confidence: 0,
      };
    }

    const sourceFace = sourceFaces[0];
    const targetFace = targetFaces[0];

    if (!sourceFace || !targetFace || !sourceFace.detectionConfidence || !targetFace.detectionConfidence) {
      return {
        similarity: 0,
        isMatch: false,
        confidence: 0,
      };
    }

    const sourceLandmarks = normalizeLandmarks(sourceFace.landmarks || []);
    const targetLandmarks = normalizeLandmarks(targetFace.landmarks || []);

    if (Object.keys(sourceLandmarks).length === 0 || Object.keys(targetLandmarks).length === 0) {
      const avgConfidence = (sourceFace.detectionConfidence + targetFace.detectionConfidence) / 2;
      return {
        similarity: 0,
        isMatch: false,
        confidence: avgConfidence * 100,
      };
    }

    const similarity = calculateFaceSimilarity(sourceLandmarks, targetLandmarks);
    const avgConfidence = (sourceFace.detectionConfidence + targetFace.detectionConfidence) / 2;

    return {
      similarity,
      isMatch: similarity >= similarityThreshold,
      confidence: avgConfidence * 100,
    };
  } catch (error: any) {
    console.error(`[Vision API] compareFaces failed:`, error);
    throw error;
  }
}

export async function detectFaces(imageKey: string): Promise<{ faceCount: number; hasFace: boolean }> {
  const imageBuffer = await downloadFromS3(imageKey);

  try {
    const [result] = await visionClient.faceDetection({
      image: { content: imageBuffer },
    });

    const faceCount = result.faceAnnotations?.length || 0;

    return {
      faceCount,
      hasFace: faceCount > 0,
    };
  } catch (error: any) {
    console.error(`[Vision API] detectFaces failed:`, error);
    throw error;
  }
}
