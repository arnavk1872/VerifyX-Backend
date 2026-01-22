import { RekognitionClient, CompareFacesCommand, DetectFacesCommand } from '@aws-sdk/client-rekognition';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

const rekognitionClient = new RekognitionClient({
  region: AWS_REGION,
  ...(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && {
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  }),
});

export interface FaceMatchResult {
  similarity: number;
  isMatch: boolean;
  confidence: number;
}

export async function compareFaces(
  sourceImageKey: string,
  targetImageKey: string,
  similarityThreshold: number = 80
): Promise<FaceMatchResult> {
  if (!S3_BUCKET_NAME) {
    throw new Error('S3_BUCKET_NAME environment variable is required');
  }

  const command = new CompareFacesCommand({
    SourceImage: {
      S3Object: {
        Bucket: S3_BUCKET_NAME,
        Name: sourceImageKey,
      },
    },
    TargetImage: {
      S3Object: {
        Bucket: S3_BUCKET_NAME,
        Name: targetImageKey,
      },
    },
    SimilarityThreshold: similarityThreshold,
  });

  const response = await rekognitionClient.send(command);

  if (!response.FaceMatches || response.FaceMatches.length === 0) {
    return {
      similarity: 0,
      isMatch: false,
      confidence: 0,
    };
  }

  const bestMatch = response.FaceMatches[0];
  if (!bestMatch) {
    return {
      similarity: 0,
      isMatch: false,
      confidence: 0,
    };
  }

  const similarity = bestMatch.Similarity || 0;

  return {
    similarity,
    isMatch: similarity >= similarityThreshold,
    confidence: bestMatch.Face?.Confidence || 0,
  };
}

export async function detectFaces(imageKey: string): Promise<{ faceCount: number; hasFace: boolean }> {
  if (!S3_BUCKET_NAME) {
    throw new Error('S3_BUCKET_NAME environment variable is required');
  }

  const command = new DetectFacesCommand({
    Image: {
      S3Object: {
        Bucket: S3_BUCKET_NAME,
        Name: imageKey,
      },
    },
    Attributes: ['ALL'],
  });

  const response = await rekognitionClient.send(command);

  const faceCount = response.FaceDetails?.length || 0;

  return {
    faceCount,
    hasFace: faceCount > 0,
  };
}

