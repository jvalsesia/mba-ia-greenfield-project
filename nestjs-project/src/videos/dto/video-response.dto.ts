import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class UploadPartTargetDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ description: 'Presigned PUT target for this part.' })
  url: string;
}

export class CreateUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  videoId: string;

  @ApiProperty({ description: 'Short public identifier used in URLs.' })
  publicId: string;

  @ApiProperty({ description: 'Storage multipart upload identifier.' })
  uploadId: string;

  @ApiProperty({ example: 67108864 })
  partSizeBytes: number;

  @ApiProperty({ type: [UploadPartTargetDto] })
  parts: UploadPartTargetDto[];

  @ApiProperty({ description: 'Seconds until the part URLs expire.' })
  expiresIn: number;
}

export class CompleteUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  videoId: string;

  @ApiProperty()
  publicId: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.PROCESSING })
  status: VideoStatus;
}

export class VideoChannelDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  nickname: string;
}

export class VideoResponseDto {
  @ApiProperty()
  publicId: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ nullable: true, example: 620 })
  durationSeconds: number | null;

  @ApiProperty({ nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Direct public URL — thumbnails live in a public-read bucket, so no signing round-trip is needed.',
  })
  thumbnailUrl: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Serialized as a string: Postgres bigint exceeds JS safe integers.',
    example: '10737418240',
  })
  sizeBytes: string | null;

  @ApiProperty({ type: VideoChannelDto })
  channel: VideoChannelDto;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}
