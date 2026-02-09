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
  const timemarks = [0, 1, 2].slice(0, Math.max(1, count));
  // Hint format for URL input (browser liveness is usually webm); helps when extension/content-type is ambiguous
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

