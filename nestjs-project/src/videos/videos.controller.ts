import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateUploadDto } from './dto/create-upload.dto';
import {
  CompleteUploadResponseDto,
  CreateUploadResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import { OptionalUser } from './decorators/optional-user.decorator';
import { VideosService } from './videos.service';

const ERROR_SCHEMA = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft and opens a multipart upload, returning one presigned PUT target per part. No video bytes pass through the API — the client uploads each part directly to storage and then calls the completion endpoint.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload started',
    type: CreateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or the declared size exceeds the maximum',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 404,
    description: 'CHANNEL_NOT_FOUND — the user has no channel',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 415,
    description: 'UNSUPPORTED_VIDEO_TYPE',
    schema: ERROR_SCHEMA,
  })
  async createUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateUploadDto,
  ): Promise<CreateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':videoId/uploads/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Finish a video upload',
    description:
      'Assembles the uploaded parts, records the stored size, moves the video to processing and enqueues the background job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; processing enqueued',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'UPLOAD_COMPLETION_FAILED or validation failed',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND — unknown video, or one owned by another channel',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_IN_DRAFT',
    schema: ERROR_SCHEMA,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, videoId, dto);
  }

  @Delete(':videoId/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Cancel a video upload',
    description:
      'Aborts the multipart upload in storage and removes the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_IN_DRAFT',
    schema: ERROR_SCHEMA,
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('videoId') videoId: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, videoId);
  }

  @Public()
  @Get(':publicId')
  @ApiOperation({
    summary: 'Get video metadata',
    description:
      'Public for a ready video. A draft, processing or failed video is reported as 404 to everyone except the channel that owns it.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video found',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: ERROR_SCHEMA,
  })
  async findOne(
    @Param('publicId') publicId: string,
    @OptionalUser() user: JwtPayload | undefined,
  ): Promise<VideoResponseDto> {
    return this.videosService.getVideoResponse(publicId, user?.sub);
  }

  @Public()
  @Get(':publicId/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a short-lived presigned URL. The target answers HTTP Range requests with 206 Partial Content, so playback never requires downloading the whole file — and the API stays out of the byte path.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the presigned URL' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description:
      'VIDEO_NOT_READY — owner requesting their own unprocessed video',
    schema: ERROR_SCHEMA,
  })
  async stream(
    @Param('publicId') publicId: string,
    @OptionalUser() user: JwtPayload | undefined,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getStreamUrl(publicId, user?.sub);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Public()
  @Get(':publicId/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a short-lived presigned URL carrying an attachment content-disposition with the original filename.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the presigned URL' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: ERROR_SCHEMA,
  })
  async download(
    @Param('publicId') publicId: string,
    @OptionalUser() user: JwtPayload | undefined,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDownloadUrl(publicId, user?.sub);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
