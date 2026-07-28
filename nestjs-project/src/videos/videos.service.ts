import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  UnsupportedVideoTypeException,
  UploadCompletionFailedException,
  VideoNotFoundException,
  VideoNotInDraftException,
  VideoNotReadyException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { thumbnailKey, videoSourceKey } from '../storage/storage.keys';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import type { CreateUploadDto } from './dto/create-upload.dto';
import type {
  CompleteUploadResponseDto,
  CreateUploadResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { VideoQueueService } from './video-queue.service';
import { SUPPORTED_VIDEO_MIME_TYPES } from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';

/** Bounded retry on the astronomically unlikely public_id collision. */
const PUBLIC_ID_MAX_ATTEMPTS = 5;

type PostgresQueryFailedError = QueryFailedError & {
  code?: string;
  detail?: string;
};

function isPublicIdCollision(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const pgError = error as PostgresQueryFailedError;
  return (
    pgError.code === PG_UNIQUE_VIOLATION &&
    typeof pgError.detail === 'string' &&
    pgError.detail.includes('public_id')
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoQueueService: VideoQueueService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * First leg of the upload handshake (`TD-02`): pre-register the video as a
   * draft, open the multipart upload, and hand back one presigned target per
   * part. No video byte reaches this process.
   */
  async initiateUpload(
    userId: string,
    dto: CreateUploadDto,
  ): Promise<CreateUploadResponseDto> {
    if (!SUPPORTED_VIDEO_MIME_TYPES.includes(dto.mimeType)) {
      throw new UnsupportedVideoTypeException();
    }
    if (dto.sizeBytes > this.config.uploadMaxSizeBytes) {
      throw new VideoTooLargeException(this.config.uploadMaxSizeBytes);
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const video = await this.insertDraft(channel.id, dto);

    const key = videoSourceKey(video.id, dto.filename);
    const uploadId = await this.storageService.createMultipartUpload(
      key,
      dto.mimeType,
    );

    const partSize = this.config.uploadPartSizeBytes;
    const partCount = Math.max(1, Math.ceil(dto.sizeBytes / partSize));
    const parts = await this.storageService.presignUploadParts(
      key,
      uploadId,
      partCount,
    );

    await this.videoRepository.update(video.id, {
      storage_key: key,
      upload_id: uploadId,
    });

    return {
      videoId: video.id,
      publicId: video.public_id,
      uploadId,
      partSizeBytes: partSize,
      parts,
      expiresIn: this.config.uploadUrlTtlSeconds,
    };
  }

  /**
   * Inserts the draft row, retrying on a `public_id` collision.
   *
   * The unique constraint is the authority on uniqueness — not the generator's
   * entropy — so the collision path is a real branch, however rarely taken.
   */
  private async insertDraft(
    channelId: string,
    dto: CreateUploadDto,
  ): Promise<Video> {
    let lastError: unknown;

    for (let attempt = 0; attempt < PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            public_id: generatePublicId(),
            channel_id: channelId,
            title: dto.title,
            original_filename: dto.filename,
            mime_type: dto.mimeType,
            size_bytes: String(dto.sizeBytes),
            status: VideoStatus.DRAFT,
          }),
        );
      } catch (error) {
        if (!isPublicIdCollision(error)) throw error;
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('Could not allocate a unique public_id for the video');
  }

  /**
   * Second leg of the handshake (`TD-02`): assemble the parts, confirm the
   * stored object, move the video to `processing` and enqueue the job.
   */
  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findOwnedVideo(userId, videoId);

    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotInDraftException();
    }
    const storageKey = video.storage_key;
    if (!storageKey) {
      throw new VideoNotInDraftException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        storageKey,
        video.upload_id,
        dto.parts,
      );
    } catch {
      throw new UploadCompletionFailedException();
    }

    // Trust the object, not the client's declaration.
    const actualSize = await this.storageService.headObjectSize(
      this.storageService.videosBucket,
      storageKey,
    );

    await this.videoRepository.update(video.id, {
      status: VideoStatus.PROCESSING,
      upload_id: null,
      size_bytes: actualSize ?? video.size_bytes,
    });

    // Status first, enqueue second: a job that arrived before the row said
    // `processing` would read a draft and fail spuriously.
    await this.videoQueueService.enqueueProcessing(video.id);

    return {
      videoId: video.id,
      publicId: video.public_id,
      status: VideoStatus.PROCESSING,
    };
  }

  /**
   * Cancel path (`TD-12`): release the multipart parts and drop the draft row.
   */
  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedVideo(userId, videoId);

    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotInDraftException();
    }

    if (video.storage_key && video.upload_id) {
      await this.storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id,
      );
    }

    await this.videoRepository.delete(video.id);
  }

  /**
   * Resolves a video by its public id under the `TD-11` authorization model.
   *
   * A non-`ready` video is visible only to the channel that owns it; everyone
   * else gets `VideoNotFoundException` — 404 rather than 403, so an
   * unprocessed upload's existence is not disclosed.
   */
  async findByPublicId(
    publicId: string,
    viewerUserId?: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: { channel: true },
    });

    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status === VideoStatus.READY) {
      return video;
    }
    if (viewerUserId && (await this.ownsVideo(viewerUserId, video))) {
      return video;
    }

    throw new VideoNotFoundException();
  }

  async getVideoResponse(
    publicId: string,
    viewerUserId?: string,
  ): Promise<VideoResponseDto> {
    const video = await this.findByPublicId(publicId, viewerUserId);
    return this.toResponse(video);
  }

  /** Presigned playback target — the API stays out of the byte path (`TD-08`). */
  async getStreamUrl(publicId: string, viewerUserId?: string): Promise<string> {
    const video = await this.requireReadyVideo(publicId, viewerUserId);

    return this.storageService.presignGetForClient(
      this.storageService.videosBucket,
      video.storage_key!,
    );
  }

  /** Same object, delivered as an attachment under its original filename. */
  async getDownloadUrl(
    publicId: string,
    viewerUserId?: string,
  ): Promise<string> {
    const video = await this.requireReadyVideo(publicId, viewerUserId);

    return this.storageService.presignGetForClient(
      this.storageService.videosBucket,
      video.storage_key!,
      {
        responseContentDisposition: `attachment; filename="${video.original_filename}"`,
      },
    );
  }

  private async requireReadyVideo(
    publicId: string,
    viewerUserId?: string,
  ): Promise<Video> {
    const video = await this.findByPublicId(publicId, viewerUserId);

    // Reachable only for the owner: a stranger already got a 404 above.
    if (video.status !== VideoStatus.READY || !video.storage_key) {
      throw new VideoNotReadyException();
    }

    return video;
  }

  private async findOwnedVideo(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    // Another channel's video is reported exactly like a missing one.
    if (!video || video.channel_id !== channel.id) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  private async ownsVideo(userId: string, video: Video): Promise<boolean> {
    const channel = await this.channelsService.findByUserId(userId);
    return channel?.id === video.channel_id;
  }

  private toResponse(video: Video): VideoResponseDto {
    return {
      publicId: video.public_id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      thumbnailUrl: video.thumbnail_key
        ? this.storageService.thumbnailPublicUrl(video.thumbnail_key)
        : null,
      sizeBytes: video.size_bytes,
      channel: {
        id: video.channel.id,
        nickname: video.channel.nickname,
      },
      createdAt: video.created_at.toISOString(),
    };
  }

  /** Key a video's thumbnail will occupy once the worker generates it. */
  thumbnailKeyFor(videoId: string): string {
    return thumbnailKey(videoId);
  }
}
