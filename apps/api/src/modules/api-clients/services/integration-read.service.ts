import { Injectable } from '@nestjs/common';
import { AppError, PalCertErrorCode } from '@palcert/contracts';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import type { MachinePrincipal } from '../machine-principal';

/**
 * Everything a machine may read (Phase 19).
 *
 * Its own service rather than a reuse of the human read services, and the
 * reason is worth stating: those take a `TenantContext` carrying a `userId`,
 * and several of them legitimately use it — "my own submissions", "the
 * submitter's identity", "was this me?". A machine has no user, so passing a
 * blank one would work until a service asked a question about it, and then it
 * would answer something false rather than refusing.
 *
 * So the machine surface queries for itself, in one file a reviewer can read
 * end to end, and every query filters on the credential's own organization.
 *
 * **The tenant context carries no user id.** That is not a shortcut: the
 * Phase-14 submission policy reads
 * `owner_user_id = app_current_user_id() OR organization_id = app_current_organization()`,
 * so an empty user id means a machine sees exactly the organization branch and
 * none of the personal one. A machine cannot see a person's own submissions
 * even inside its own organization, and RLS is what makes that true rather
 * than a `where` clause somebody has to remember.
 */
@Injectable()
export class IntegrationReadService {
  constructor(private readonly tenant: TenantPrismaService) {}

  private async scoped<T>(
    machine: MachinePrincipal,
    work: (tx: TenantClient) => Promise<T>,
  ): Promise<T> {
    return this.tenant.withTenant({ organizationId: machine.organizationId, userId: '' }, work);
  }

  async organization(machine: MachinePrincipal) {
    const row = await this.scoped(machine, (tx) =>
      tx.organization.findFirst({
        where: { id: machine.organizationId },
        select: {
          id: true,
          slug: true,
          displayName: true,
          type: true,
          status: true,
          verificationStatus: true,
          createdAt: true,
        },
      }),
    );
    if (row === null) {
      throw new AppError(PalCertErrorCode.ORGANIZATION_NOT_FOUND, {
        message: 'Organization not found.',
      });
    }
    return {
      organizationId: row.id,
      slug: row.slug,
      displayName: row.displayName,
      type: row.type,
      status: row.status,
      verificationStatus: row.verificationStatus,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Published standard versions only.
   *
   * A draft is an institution's work in progress. An integration asking "what
   * are your requirements?" is asking about what is in force, and a draft
   * answering that question would let an external system act on rules nobody
   * has approved.
   */
  async standards(machine: MachinePrincipal) {
    const rows = await this.scoped(machine, (tx) =>
      tx.standard.findMany({
        where: { organizationId: machine.organizationId },
        orderBy: { code: 'asc' },
        include: {
          versions: {
            where: { status: 'PUBLISHED' },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              versionLabel: true,
              status: true,
              contentHash: true,
              publishedAt: true,
            },
          },
        },
      }),
    );
    return rows.map((standard) => ({
      standardId: standard.id,
      code: standard.code,
      nameEn: standard.nameEn,
      nameAr: standard.nameAr,
      status: standard.status,
      publishedVersions: standard.versions.map((version) => ({
        standardVersionId: version.id,
        versionLabel: version.versionLabel,
        contentHash: version.contentHash,
        publishedAt: version.publishedAt?.toISOString() ?? null,
      })),
    }));
  }

  async standard(machine: MachinePrincipal, standardId: string) {
    const all = await this.standards(machine);
    const found = all.find((standard) => standard.standardId === standardId);
    if (found === undefined) {
      throw new AppError(PalCertErrorCode.STANDARD_NOT_FOUND, {
        message: 'Standard not found.',
      });
    }
    return found;
  }

  /**
   * Submissions this organization received.
   *
   * Metadata and decision state, and deliberately nothing about the person who
   * submitted beyond what the organization already sees in its own queue — no
   * email, no contact detail, no identity a machine could join against another
   * dataset.
   */
  async submissions(machine: MachinePrincipal) {
    const rows = await this.scoped(machine, (tx) =>
      tx.submissionRevision.findMany({
        where: { organizationId: machine.organizationId },
        orderBy: [{ createdAt: 'desc' }],
        take: 200,
        select: {
          id: true,
          submissionId: true,
          revisionNumber: true,
          institutionDecisionStatus: true,
          standardCode: true,
          standardVersionLabel: true,
          determination: true,
          submittedAt: true,
          decidedAt: true,
          createdAt: true,
        },
      }),
    );
    return rows.map((revision) => ({
      submissionId: revision.submissionId,
      revisionId: revision.id,
      revisionNumber: revision.revisionNumber,
      institutionDecisionStatus: revision.institutionDecisionStatus,
      determination: revision.determination,
      standardCode: revision.standardCode,
      standardVersionLabel: revision.standardVersionLabel,
      submittedAt: (revision.submittedAt ?? revision.createdAt).toISOString(),
      decidedAt: revision.decidedAt?.toISOString() ?? null,
    }));
  }

  async submission(machine: MachinePrincipal, submissionId: string) {
    const row = await this.scoped(machine, (tx) =>
      tx.officialSubmission.findFirst({
        where: { id: submissionId, organizationId: machine.organizationId },
        include: { revisions: { orderBy: { revisionNumber: 'desc' } } },
      }),
    );
    if (row === null) {
      // Identical to "belongs to another organization". The RLS policy already
      // makes them the same query; this makes them the same answer.
      throw new AppError(PalCertErrorCode.SUBMISSION_NOT_FOUND, {
        message: 'That submission does not exist.',
      });
    }
    return {
      submissionId: row.id,
      documentTypeId: row.documentTypeId,
      documentTypeName: row.documentTypeName,
      createdAt: row.createdAt.toISOString(),
      revisions: row.revisions.map((revision) => ({
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        institutionDecisionStatus: revision.institutionDecisionStatus,
        determination: revision.determination,
        standardCode: revision.standardCode,
        standardVersionLabel: revision.standardVersionLabel,
        submittedAt: (revision.submittedAt ?? revision.createdAt).toISOString(),
        decidedAt: revision.decidedAt?.toISOString() ?? null,
      })),
    };
  }

  async revisionHistory(machine: MachinePrincipal, revisionId: string) {
    const rows = await this.scoped(machine, (tx) =>
      tx.submissionDecisionEvent.findMany({
        where: { submissionRevisionId: revisionId, organizationId: machine.organizationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          eventSource: true,
          fromStatus: true,
          toStatus: true,
          reasonCode: true,
          createdAt: true,
        },
      }),
    );
    return rows.map((event) => ({
      eventId: event.id,
      // SYSTEM for PalCert's own handoff, ORGANIZATION for a reviewer's
      // decision. Deliberately not the reviewer: which named person decided is
      // the organization's internal business, and an integration tracking a
      // case does not need it.
      eventSource: event.eventSource,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      reasonCode: event.reasonCode,
      occurredAt: event.createdAt.toISOString(),
    }));
  }

  /**
   * Certificate records this organization's approvals produced.
   *
   * The record, never the artifact and never the verification code. A
   * certificate's PDF is the thing a person shows an employer; an integration
   * asking "was one issued?" does not need the document, and the verification
   * code is a secret that Phase 15 deliberately does not keep in plaintext.
   */
  async certificate(machine: MachinePrincipal, certificateId: string) {
    const row = await this.scoped(machine, (tx) =>
      tx.complianceCertificate.findFirst({
        where: { id: certificateId, organizationId: machine.organizationId },
        select: {
          id: true,
          issuanceStatus: true,
          issuedAt: true,
          validUntil: true,
          revokedAt: true,
          revocationReason: true,
          submissionRevisionId: true,
        },
      }),
    );
    if (row === null) {
      throw new AppError(PalCertErrorCode.CERTIFICATE_NOT_FOUND, {
        message: 'Certificate not found.',
      });
    }
    return {
      certificateId: row.id,
      // Never the verification code and never its hash: the code is the
      // capability a holder shows, and Phase 15 keeps only a one-way digest
      // precisely so a read of the table discloses none of it.
      issuanceStatus: row.issuanceStatus,
      revisionId: row.submissionRevisionId,
      issuedAt: row.issuedAt?.toISOString() ?? null,
      validUntil: row.validUntil?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      revocationReason: row.revocationReason,
    };
  }

  async certificateEvents(machine: MachinePrincipal, certificateId: string) {
    await this.certificate(machine, certificateId);
    const rows = await this.scoped(machine, (tx) =>
      tx.certificateEvent.findMany({
        where: { certificateId, organizationId: machine.organizationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, eventType: true, eventSource: true, createdAt: true },
      }),
    );
    return rows.map((event) => ({
      eventId: event.id,
      eventType: event.eventType,
      eventSource: event.eventSource,
      occurredAt: event.createdAt.toISOString(),
    }));
  }

  /**
   * The organization's outbound integrations, without any of their material.
   *
   * No URL, no signing secret, no ciphertext. An integration checking "are our
   * webhooks configured and healthy?" needs the status and the description; it
   * does not need — and Phase 17 does not hand out — where the events go.
   */
  async webhookEndpoints(machine: MachinePrincipal) {
    const rows = await this.scoped(machine, (tx) =>
      tx.webhookEndpoint.findMany({
        where: { organizationId: machine.organizationId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, description: true, status: true, createdAt: true, disabledAt: true },
      }),
    );
    return rows.map((endpoint) => ({
      endpointId: endpoint.id,
      description: endpoint.description,
      status: endpoint.status,
      createdAt: endpoint.createdAt.toISOString(),
      disabledAt: endpoint.disabledAt?.toISOString() ?? null,
    }));
  }
}
