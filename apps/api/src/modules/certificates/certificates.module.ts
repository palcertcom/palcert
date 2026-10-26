import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { CertificateReviewController } from './controllers/certificate-review.controller';
import { CertificatesController } from './controllers/certificates.controller';
import { PublicCertificatesController } from './controllers/public-certificates.controller';
import { CertificatesCoreModule } from './certificates-core.module';

/**
 * Phase 15, with its three HTTP surfaces.
 *
 * Three rather than one, because they answer to three different authorities:
 * the subject reading their own certificate, the institution reading and
 * withdrawing what its approval produced, and anybody at all holding a
 * verification code.
 */
@Module({
  imports: [CertificatesCoreModule, OrganizationsModule, AuthModule],
  controllers: [CertificatesController, CertificateReviewController, PublicCertificatesController],
  exports: [CertificatesCoreModule],
})
export class CertificatesModule {}
