import { Module } from '@nestjs/common';
import { ChecksCoreModule } from './checks-core.module';
import { CatalogueController } from './controllers/catalogue.controller';
import { ChecksController } from './controllers/checks.controller';

/**
 * Document checks (Phase 7), with their HTTP surface.
 *
 * The module owns the catalogue a user chooses a standard from, the check
 * lifecycle, and reading results back. It owns no evaluation: that runs in the
 * worker, against the Python engine, because a compliance check is not
 * something to do inside an HTTP request (§29).
 */
@Module({
  imports: [ChecksCoreModule],
  controllers: [CatalogueController, ChecksController],
  exports: [ChecksCoreModule],
})
export class ChecksModule {}
