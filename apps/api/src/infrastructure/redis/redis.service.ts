import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../config/api-config.service';

/**
 * Redis connection used for caching and, from Phase 5 onward, as the queue
 * backend for document-processing workers (§32).
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;

  constructor(
    config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RedisService.name);
    this.client = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    this.client.on('error', (error: Error) => {
      this.logger.error({ err: error }, 'Redis connection error');
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.logger.info('Redis connection established');
  }

  async onModuleDestroy(): Promise<void> {
    this.client.removeAllListeners();
    await this.client.quit();
    this.logger.info('Redis connection closed');
  }

  async ping(): Promise<string> {
    return this.client.ping();
  }
}
