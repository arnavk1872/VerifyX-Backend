import { VideoIntelligenceServiceClient, protos } from '@google-cloud/video-intelligence';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../aws/s3';
import { getGcpCredentials } from './credentials';

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

/** Minimum number of distinct timestamps at which a face must be detected. */
const MIN_TIMESTAMPS_WITH_FACE = 2;
/** Minimum time gap (seconds) between two timestamps to count as distinct. */
const MIN_TIME_GAP_SECONDS = 0.5;
/** Minimum L2 distance (normalized 0–1) between bbox centers to count as movement. */
const MOVEMENT_THRESHOLD = 0.05;

const videoClient = new VideoIntelligenceServiceClient(
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

function durationToSeconds(d: unknown): number {
  if (!d || typeof d !== 'object') return 0;
  const o = d as { seconds?: number | string | null; nanos?: number | null };
  const s = Number(o.seconds ?? 0);
  const n = Number(o.nanos ?? 0);
  return s + n / 1e9;
}

function bboxCenter(box: unknown): { x: number; y: number } | null {
  if (!box || typeof box !== 'object') return null;
  const b = box as { left?: number | null; top?: number | null; right?: number | null; bottom?: number | null };
  const left = b.left ?? 0;
  const top = b.top ?? 0;
  const right = typeof b.right === 'number' ? b.right : left;
  const bottom = typeof b.bottom === 'number' ? b.bottom : top;
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

export interface DetectFacesInVideoResult {
  facePresent: boolean;
  movementDetected: boolean;
  faceCount?: number;
}

export async function detectFacesInVideo(s3Key: string): Promise<DetectFacesInVideoResult> {
  const videoBuffer = await downloadFromS3(s3Key);

  const [operation] = await videoClient.annotateVideo({
    inputContent: videoBuffer,
    features: [protos.google.cloud.videointelligence.v1.Feature.FACE_DETECTION],
    videoContext: {
      faceDetectionConfig: {
        includeBoundingBoxes: true,
      },
    },
  });

  const [results] = await operation.promise();
  const annotationResult = results?.annotationResults?.[0];
  const faceAnnotations = annotationResult?.faceDetectionAnnotations ?? [];

  const faceCount = faceAnnotations.length;

  if (faceCount === 0) {
    return { facePresent: false, movementDetected: false, faceCount: 0 };
  }

  type TimeBbox = { timeSeconds: number; center: { x: number; y: number } };
  const allTimeBboxes: TimeBbox[] = [];

  for (const faceAnn of faceAnnotations) {
    const tracks = faceAnn.tracks ?? [];
    for (const track of tracks) {
      const segment = track.segment;
      const timestampedObjects = track.timestampedObjects ?? [];

      if (timestampedObjects.length > 0) {
        for (const obj of timestampedObjects) {
          const timeSeconds = durationToSeconds(obj.timeOffset);
          const center = bboxCenter(obj.normalizedBoundingBox);
          if (center != null) {
            allTimeBboxes.push({ timeSeconds, center });
          }
        }
      } else if (segment) {
        const startSeconds = durationToSeconds(segment.startTimeOffset);
        const endSeconds = durationToSeconds(segment.endTimeOffset);
        if (startSeconds !== endSeconds) {
          allTimeBboxes.push({ timeSeconds: startSeconds, center: { x: 0.5, y: 0.5 } });
          allTimeBboxes.push({ timeSeconds: endSeconds, center: { x: 0.5, y: 0.5 } });
        } else {
          allTimeBboxes.push({ timeSeconds: startSeconds, center: { x: 0.5, y: 0.5 } });
        }
      }
    }
  }

  const sortedByTime = [...allTimeBboxes].sort((a, b) => a.timeSeconds - b.timeSeconds);
  const distinctTimestamps: number[] = [];
  let lastT = -Infinity;
  for (const { timeSeconds } of sortedByTime) {
    if (timeSeconds - lastT >= MIN_TIME_GAP_SECONDS) {
      distinctTimestamps.push(timeSeconds);
      lastT = timeSeconds;
    }
  }

  const facePresent = distinctTimestamps.length >= MIN_TIMESTAMPS_WITH_FACE;

  let movementDetected = false;
  if (sortedByTime.length >= 2) {
    const first = sortedByTime[0];
    const last = sortedByTime[sortedByTime.length - 1];
    if (first != null && last != null && last.timeSeconds - first.timeSeconds >= MIN_TIME_GAP_SECONDS) {
      const dx = last.center.x - first.center.x;
      const dy = last.center.y - first.center.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      movementDetected = distance > MOVEMENT_THRESHOLD;
    }
  }

  return {
    facePresent,
    movementDetected,
    faceCount,
  };
}
