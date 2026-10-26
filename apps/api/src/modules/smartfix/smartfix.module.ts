import { Module } from '@nestjs/common';
import { SmartFixController } from './controllers/smartfix.controller';
import { SmartFixCoreModule } from './smartfix-core.module';

/**
 * SmartFix (Phase 12), with its HTTP surface.
 *
 * Planning is free and synchronous; correcting is paid and durable. The module
 * owns neither the mutation nor the recheck — the first belongs to the Python
 * engine and the second is an ordinary check — which is what keeps the whole
 * correction inside machinery PalCert already trusts.
 */
@Module({
  imports: [SmartFixCoreModule],
  controllers: [SmartFixController],
  exports: [SmartFixCoreModule],
})
export class SmartFixModule {}
