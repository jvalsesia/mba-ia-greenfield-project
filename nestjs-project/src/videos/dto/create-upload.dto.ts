import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  SUPPORTED_VIDEO_MIME_TYPES,
  type SupportedVideoMimeType,
} from '../videos.constants';

export class CreateUploadDto {
  @ApiProperty({ maxLength: 255, example: 'My holiday video' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @ApiProperty({ maxLength: 255, example: 'holiday.mp4' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  @ApiProperty({
    enum: SUPPORTED_VIDEO_MIME_TYPES,
    example: 'video/mp4',
  })
  @IsString()
  @IsIn(SUPPORTED_VIDEO_MIME_TYPES)
  mimeType: SupportedVideoMimeType;

  @ApiProperty({
    description:
      'Declared size in bytes. Validated against the 10 GiB ceiling before any multipart upload is opened; the stored size is re-read from storage on completion.',
    example: 1073741824,
  })
  @IsInt()
  @IsPositive()
  sizeBytes: number;
}
