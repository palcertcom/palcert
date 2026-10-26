import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { SubmissionReviewController } from './controllers/submission-review.controller';
import { SubmissionsController } from './controllers/submissions.controller';
import { SubmissionsCoreModule } from './submissions-core.module';

/**
 * Phase 14, with both HTTP surfaces.
 *
 * Two controllers rather than one, because they answer to two different
 * authorities and the split is the whole architecture: the author's routes are
 * self-scoped and reach their own private rows; the institution's are
 * organization-scoped and reach only what was explicitly handed to them.
 */
@Module({
  imports: [SubmissionsCoreModule, OrganizationsModule],
  controllers: [SubmissionsController, SubmissionReviewController],
  exports: [SubmissionsCoreModule],
})
export class SubmissionsModule {}
