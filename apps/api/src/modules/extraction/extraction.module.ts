import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ExtractionController } from './extraction.controller';
import { ExtractionCoreModule } from './extraction-core.module';

/** The HTTP surface, for the API process only. */
@Module({
  imports: [ExtractionCoreModule, OrganizationsModule],
  controllers: [ExtractionController],
})
export class ExtractionModule {}
