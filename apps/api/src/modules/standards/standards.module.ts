import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import {
  DocumentTypesController,
  RuleSchemaController,
  StandardsController,
} from './standards.controller';
import { DocumentTypeService } from './services/document-type.service';
import { RuleService } from './services/rule.service';
import { StandardHasherService } from './services/standard-hasher.service';
import { StandardService } from './services/standard.service';
import { StandardVersionService } from './services/standard-version.service';
import { StandardTransferService } from './services/standard-transfer.service';
import { StandardTransferController } from './standard-transfer.controller';

/**
 * Standards authoring (Phase 3).
 *
 * Registers no guards of its own: the tenant guards are already global, and
 * every route here carries `@OrganizationScoped()` plus the organization
 * permission it needs. Adding a second, module-local guard would create a
 * second place for the tenant boundary to be decided, which is exactly what
 * ADR-0017 exists to prevent.
 */
@Module({
  imports: [AuthModule, OrganizationsModule],
  controllers: [
    DocumentTypesController,
    StandardsController,
    StandardTransferController,
    RuleSchemaController,
  ],
  providers: [
    DocumentTypeService,
    StandardService,
    StandardVersionService,
    RuleService,
    StandardHasherService,
    StandardTransferService,
  ],
  exports: [StandardService, StandardVersionService, RuleService, StandardHasherService],
})
export class StandardsModule {}
