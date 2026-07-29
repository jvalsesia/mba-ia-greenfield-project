import { Module } from '@nestjs/common';
import {
  s3InternalClientProvider,
  s3PublicClientProvider,
} from './s3-client.provider';
import { StorageService } from './storage.service';

/**
 * Owns every object-storage concern: the two S3 clients, the multipart
 * primitives, the presigners and the bucket bootstrap. Imported by both the
 * API graph and the worker graph.
 */
@Module({
  providers: [s3InternalClientProvider, s3PublicClientProvider, StorageService],
  exports: [StorageService],
})
export class StorageModule {}
