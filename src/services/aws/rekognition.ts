import { RekognitionClient, CompareFacesCommand } from '@aws-sdk/client-rekognition';

const AWS_REGION = process.env.AWS_REGION || process.env.S3_REGION || 'us-east-1';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

if (!S3_BUCKET_NAME) {
  // eslint-disable-next-line no-console
  console.warn('S3_BUCKET_NAME not set - Rekognition face comparison will fail');
}

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
  similarityThreshold: number
): Promise<FaceMatchResult> {
  if (!S3_BUCKET_NAME) {
    throw new Error('S3_BUCKET_NAME environment variable is required for Rekognition');
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

  try {
    const response = await rekognitionClient.send(command);

    const faceMatches = response.FaceMatches ?? [];
    const bestMatch = faceMatches[0];

    if (!bestMatch || typeof bestMatch.Similarity !== 'number') {
      return {
        similarity: 0,
        isMatch: false,
        confidence: 0,
      };
    }

    const similarity = bestMatch.Similarity;
    const isMatch = similarity >= similarityThreshold;

    return {
      similarity,
      isMatch,
      confidence: similarity,
    };
  } catch (error: any) {
    // eslint-disable-next-line no-console
    console.error('[Rekognition] compareFaces failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

