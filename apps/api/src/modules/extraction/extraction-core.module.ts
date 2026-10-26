import { Module } from '@nestjs/common';
import { FinanceCoreModule } from '../finance/finance-core.module';
import { AIProviderModule } from '../../infrastructure/ai/ai-provider.module';
import { DocumentEngineModule } from '../../infrastructure/document-engine/document-engine.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort, SystemClock } from '../auth/ports/clock.port';
import { SecurityEventService } from '../auth/services/security-event.service';
import { OrganizationAIConsentService } from './services/organization-ai-consent.service';
import { ProposalValidationService } from './services/proposal-validation.service';
import { RuleExtractionService } from './services/rule-extraction.service';
import { RuleProposalService } from './services/rule-proposal.service';
import { StandardSourceService } from './services/standard-source.service';
import { TemplateObservationEngine } from './services/template-observation.service';

/**
 * Phase 9 services, without the HTTP surface.
 *
 * Split the same way Phase 8 is: the worker needs the template observation
 * engine and the proposal validator, and importing a module full of controllers
 * to get them would mount routes in a process that has no callers.
 */
@Module({
  imports: [StorageModule, QueueModule, DocumentEngineModule, AIProviderModule, FinanceCoreModule],
  providers: [
    TenantPrismaService,
    SecurityEventService,
    { provide: ClockPort, useClass: SystemClock },
    StandardSourceService,
    OrganizationAIConsentService,
    ProposalValidationService,
    TemplateObservationEngine,
    RuleExtractionService,
    RuleProposalService,
  ],
  exports: [
    StandardSourceService,
    OrganizationAIConsentService,
    ProposalValidationService,
    TemplateObservationEngine,
    RuleExtractionService,
    RuleProposalService,
  ],
})
export class ExtractionCoreModule {}
