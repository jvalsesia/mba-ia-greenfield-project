import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from './auth/entities/refresh-token.entity';
import { VerificationToken } from './auth/entities/verification-token.entity';
import { Channel } from './channels/entities/channel.entity';
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import { User } from './users/entities/user.entity';
import { Video } from './videos/entities/video.entity';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import { envValidationSchema } from './config/env.validation';
import { VideoProcessingModule } from './videos/processing/video-processing.module';

/**
 * Root module of the video worker process (`phase-03-videos/TD-04`).
 *
 * Same codebase as the API — entities, config and the storage service are
 * shared by import, so the two can never drift — but a different graph: no
 * controllers, no HTTP surface, and the BullMQ `@Processor` that `AppModule`
 * deliberately does not provide.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres' as const,
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        // Listed explicitly rather than auto-loaded. The worker's graph only
        // registers `Video` via forFeature, but `Video` has a relation to
        // `Channel`, which in turn relates to `User` — TypeORM needs metadata
        // for the whole reachable graph or it fails to build at startup.
        entities: [User, Channel, Video, RefreshToken, VerificationToken],
        synchronize: false,
      }),
    }),
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
