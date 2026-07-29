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
  /** Title shown for the video. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  /** Original filename; its extension shapes the storage key and the download name. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /** Container type. Anything outside the supported set is rejected before storage is touched. */
  @IsString()
  @IsIn(SUPPORTED_VIDEO_MIME_TYPES)
  mimeType: SupportedVideoMimeType;

  /**
   * Declared size in bytes, used to derive the part count. The 10 GiB ceiling
   * is enforced in `VideosService.initiateUpload` against the configured
   * `UPLOAD_MAX_SIZE_BYTES`, not by a decorator here, so the limit stays
   * configurable per environment. The stored size is re-read from storage on
   * completion, so a dishonest declaration cannot corrupt the record.
   */
  @IsInt()
  @IsPositive()
  sizeBytes: number;
}
