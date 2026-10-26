import { Module } from '@nestjs/common';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { DocumentsController } from './documents.controller';
import { DocumentService } from './services/document.service';
import { DocumentVersionService } from './services/document-version.service';
import { UploadSessionSweeper } from './services/upload-session-sweeper';

/**
 * Documents and uploads (Phase 5).
 *
 * Nothing here is organization-scoped: the routes carry no tenant guard and
 * the services take no organization. That is the product rule (ADR-0031),
 * not an omission.
 */
@Module({
  imports: [AuthModule, OrganizationsModule, StorageModule, QueueModule],
  controllers: [DocumentsController],
  providers: [DocumentService, DocumentVersionService, UploadSessionSweeper],
  exports: [DocumentService, DocumentVersionService],
})
export class DocumentsModule {}
