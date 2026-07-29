import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../../queue/queue.module';
import { StorageModule } from '../../storage/storage.module';
import { Video } from '../entities/video.entity';
import { FfmpegRunner } from './ffmpeg-runner';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessor } from './video.processor';

/**
 * The consumer half of the video pipeline.
 *
 * Imported by `WorkerModule` and by nothing else — importing it from
 * `AppModule` would make the API consume jobs too.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Video]), StorageModule, QueueModule],
  providers: [VideoProcessor, VideoProcessingService, FfmpegRunner],
  exports: [VideoProcessingService],
})
export class VideoProcessingModule {}
