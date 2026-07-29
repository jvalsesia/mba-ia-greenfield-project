import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoQueueService } from './video-queue.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

/**
 * Video upload, delivery and lifecycle.
 *
 * Note what is absent: the BullMQ `@Processor`. This module produces jobs but
 * never consumes them — consumption belongs to the worker graph
 * (`WorkerModule`), which is the process separation `TD-04` decides.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    QueueModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoQueueService],
  exports: [TypeOrmModule, VideosService],
})
export class VideosModule {}
