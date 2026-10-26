import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ClockPort, SystemClock } from '../../modules/auth/ports/clock.port';
import { OutboxDispatcher } from './outbox-dispatcher';
import { ProcessingJobService } from './processing-job.service';
import { ProcessingQueue } from './processing-queue';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [
    ProcessingQueue,
    ProcessingJobService,
    OutboxDispatcher,
    { provide: ClockPort, useClass: SystemClock },
  ],
  exports: [ProcessingQueue, ProcessingJobService, OutboxDispatcher],
})
export class QueueModule {}
