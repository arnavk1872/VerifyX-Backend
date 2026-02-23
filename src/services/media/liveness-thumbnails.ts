import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getSignedS3Url, uploadToS3 } from '../aws/s3';

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath as string);
}
// fluent-ffmpeg needs ffprobe for probing video (e.g. screenshots); ffmpeg-static does not include it
if (ffprobePath?.path) {
  ffmpeg.setFfprobePath(ffprobePath.path);
}

export interface LivenessFrameEntry {
  id: string;
  s3Key: string;
  bucket: string;
  url: string;
  uploadedAt: string;
}

export async function generateLivenessThumbnails(
  s3Key: string,
  organizationId: string,
  verificationId: string,
  count: number = 3
): Promise<Record<string, LivenessFrameEntry>> {
  const signedUrl = await getSignedS3Url(s3Key, 600);

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verifyx-liveness-'));

  // Use fixed timemarks (seconds) so we don't need input duration — probing fails for S3 HTTP URLs
  // Skip t=0 (often black). Use 0.25s for first frame, keep 1 and 2 for good spread across the video.
  const timemarks = [0.35, 1, 2].slice(0, Math.max(1, count));

  const inputFormat = s3Key.toLowerCase().endsWith('.webm') ? 'webm' : s3Key.toLowerCase().endsWith('.mp4') ? 'mp4' : 'webm';
  await new Promise<void>((resolve, reject) => {
    ffmpeg(signedUrl)
      .inputOptions([`-f ${inputFormat}`])
      .on('end', () => resolve())
      .on('error', (err: unknown) => reject(err))
      .screenshots({
        timemarks,
        folder: tmpDir,
        filename: 'frame-%i.jpg',
        size: '640x?'
      });
  });

  const files = (await fs.promises.readdir(tmpDir))
    .filter((f) => f.toLowerCase().endsWith('.jpg'))
    .sort();

  const now = new Date().toISOString();
  const frames: Record<string, LivenessFrameEntry> = {};

  let index = 1;
  for (const file of files) {
    const fullPath = path.join(tmpDir, file);
    const buffer = await fs.promises.readFile(fullPath);
    const upload = await uploadToS3(
      buffer,
      file,
      'image/jpeg',
      organizationId,
      verificationId,
      'liveness'
    );

    const key = `liveness_frame_${index}`;
    frames[key] = {
      id: `${key}_${path.basename(upload.key)}`,
      s3Key: upload.key,
      bucket: upload.bucket,
      url: upload.url,
      uploadedAt: now,
    };

    index++;
  }

  // clean up temp dir best-effort
  try {
    await Promise.all(files.map((f) => fs.promises.unlink(path.join(tmpDir, f))));
    await fs.promises.rmdir(tmpDir);
  } catch {
    // ignore
  }

  return frames;
}

/**
 * Extracts a single representative frame from a liveness video and uploads it to S3.
 * Used for video face comparison when thumbnails are not yet available.
 */
export async function extractSingleLivenessFrame(
  s3Key: string,
  organizationId: string,
  verificationId: string
): Promise<string> {
  const signedUrl = await getSignedS3Url(s3Key, 600);
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verifyx-liveness-single-'));

  const inputFormat = s3Key.toLowerCase().endsWith('.webm')
    ? 'webm'
    : s3Key.toLowerCase().endsWith('.mp4')
      ? 'mp4'
      : 'webm';

  await new Promise<void>((resolve, reject) => {
    ffmpeg(signedUrl)
      .inputOptions([`-f ${inputFormat}`])
      .on('end', () => resolve())
      .on('error', (err: unknown) => reject(err))
      .screenshots({
        timemarks: [1], // ~1s into the video
        folder: tmpDir,
        filename: 'frame-%i.jpg',
        size: '640x?',
      });
  });

  const files = (await fs.promises.readdir(tmpDir))
    .filter((f) => f.toLowerCase().endsWith('.jpg'))
    .sort();

  const frameFile = files[0];
  if (!frameFile) {
    try {
      await fs.promises.rmdir(tmpDir);
    } catch {
      // ignore
    }
    throw new Error('No frame extracted from liveness video');
  }

  const framePath = path.join(tmpDir, frameFile);
  const buffer = await fs.promises.readFile(framePath);
  const upload = await uploadToS3(
    buffer,
    'liveness_face_match_frame.jpg',
    'image/jpeg',
    organizationId,
    verificationId,
    'liveness'
  );

  try {
    await Promise.all(files.map((f) => fs.promises.unlink(path.join(tmpDir, f))));
    await fs.promises.rmdir(tmpDir);
  } catch {
    console.error('Error deleting temporary directory', tmpDir);
  }

  return upload.key;
}


