import { Module } from '@nestjs/common';
import { ApiConfigService } from '../../config/api-config.service';
import { ConfigModule } from '../../config/config.module';
import { MetricsService } from '../metrics/metrics.service';
import { ObjectStoragePort } from './object-storage.port';
import { S3ObjectStorage } from './s3-object-storage';

/**
 * Binds the storage port to the S3-compatible adapter.
 *
 * Tests override `ObjectStoragePort` with the in-memory adapter (unit) or
 * wrap the real adapter with fault injection (end-to-end); the application
 * code never knows which it has.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: ObjectStoragePort,
      inject: [ApiConfigService, MetricsService],
      useFactory: (config: ApiConfigService, metrics: MetricsService): ObjectStoragePort => {
        const storage = config.storage;
        return new S3ObjectStorage({
          endpoint: storage.endpoint,
          publicEndpoint: storage.publicEndpoint,
          region: storage.region,
          accessKeyId: storage.accessKeyId,
          secretAccessKey: storage.secretAccessKey,
          forcePathStyle: storage.forcePathStyle,
          buckets: {
            quarantine: storage.quarantineBucket,
            clean: storage.cleanBucket,
            derived: storage.derivedBucket,
          },
          serverSideEncryption: storage.serverSideEncryption,
          kmsKeyId: storage.kmsKeyId,
          requestTimeoutMs: storage.requestTimeoutMs,
          observe: (operation, outcome) => metrics.storageOperations.inc({ operation, outcome }),
        });
      },
    },
  ],
  exports: [ObjectStoragePort],
})
export class StorageModule {}
