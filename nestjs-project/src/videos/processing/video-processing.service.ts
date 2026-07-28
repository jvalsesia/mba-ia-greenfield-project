import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../../storage/storage.service';
import { thumbnailKey } from '../../storage/storage.keys';
import { FfmpegRunner } from './ffmpeg-runner';
import {
  parseFfprobeOutput,
  thumbnailTimestampSeconds,
  type VideoMetadata,
} from './video-metadata';

export interface ProcessingResult extends VideoMetadata {
  thumbnailKey: string;
}

/**
 * Extracts metadata and generates a thumbnail for an uploaded video
 * (`phase-03-videos/TD-05`, `TD-06`).
 *
 * The source is never downloaded. FFmpeg is handed a presigned URL and reads
 * it over HTTP with range requests, so a 10GB video costs a few range reads
 * rather than a full transfer — the same principle that keeps the upload out
 * of the API.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    private readonly storageService: StorageService,
    private readonly ffmpegRunner: FfmpegRunner,
  ) {}

  async process(
    videoId: string,
    storageKey: string,
  ): Promise<ProcessingResult> {
    const sourceUrl = await this.storageService.presignGetForWorker(
      this.storageService.videosBucket,
      storageKey,
    );

    const metadata = await this.probe(sourceUrl);
    const key = thumbnailKey(videoId);
    await this.generateThumbnail(sourceUrl, metadata.durationSeconds, key);

    return { ...metadata, thumbnailKey: key };
  }

  private async probe(sourceUrl: string): Promise<VideoMetadata> {
    const { stdout } = await this.ffmpegRunner.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      sourceUrl,
    ]);

    return parseFfprobeOutput(stdout);
  }

  private async generateThumbnail(
    sourceUrl: string,
    durationSeconds: number | null,
    key: string,
  ): Promise<void> {
    const timestamp = thumbnailTimestampSeconds(durationSeconds);
    const outputPath = join(tmpdir(), `thumb-${randomUUID()}.jpg`);

    try {
      await this.ffmpegRunner.run('ffmpeg', [
        // -ss before -i is input seeking: FFmpeg jumps to the timestamp
        // instead of decoding from the start. This is what makes the operation
        // fast on a large file read over HTTP.
        '-ss',
        timestamp.toFixed(3),
        '-i',
        sourceUrl,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '-f',
        'image2',
        '-y',
        outputPath,
      ]);

      await this.storageService.putThumbnail(key, await readFile(outputPath));
    } finally {
      // The temp file must go even when the upload throws, or a failing worker
      // slowly fills its own disk.
      await rm(outputPath, { force: true }).catch((error: unknown) => {
        this.logger.warn(
          `Could not remove temporary thumbnail ${outputPath}: ${String(error)}`,
        );
      });
    }
  }
}
