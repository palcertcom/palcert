import {
  MembershipStatus,
  OrganizationStatus,
  OrganizationVerificationStatus,
  canTransitionMembershipStatus,
  canTransitionOrganizationStatus,
  canTransitionVerificationStatus,
  membershipPermitsAccess,
  organizationPermitsAccess,
} from '@palcert/contracts';

/**
 * State-machine assertions.
 *
 * These live with the tenant code because getting them wrong is a security
 * problem, not a modelling nicety: a permitted transition into ACTIVE from the
 * wrong state would restore access that was deliberately withdrawn.
 */
describe('organization status machine', () => {
  it('permits only the documented transitions', () => {
    expect(
      canTransitionOrganizationStatus(OrganizationStatus.ACTIVE, OrganizationStatus.SUSPENDED),
    ).toBe(true);
    expect(
      canTransitionOrganizationStatus(OrganizationStatus.SUSPENDED, OrganizationStatus.ACTIVE),
    ).toBe(true);
    expect(
      canTransitionOrganizationStatus(OrganizationStatus.ACTIVE, OrganizationStatus.CLOSED),
    ).toBe(true);
    expect(
      canTransitionOrganizationStatus(OrganizationStatus.SUSPENDED, OrganizationStatus.CLOSED),
    ).toBe(true);
  });

  it('treats CLOSED as terminal', () => {
    for (const target of Object.values(OrganizationStatus)) {
      expect(
        `${target}:${canTransitionOrganizationStatus(OrganizationStatus.CLOSED, target)}`,
      ).toBe(`${target}:false`);
    }
  });

  it('grants access only while ACTIVE', () => {
    expect(organizationPermitsAccess(OrganizationStatus.ACTIVE)).toBe(true);
    expect(organizationPermitsAccess(OrganizationStatus.SUSPENDED)).toBe(false);
    expect(organizationPermitsAccess(OrganizationStatus.CLOSED)).toBe(false);
  });
});

describe('verification status machine', () => {
  it('follows request → decision', () => {
    expect(
      canTransitionVerificationStatus(
        OrganizationVerificationStatus.UNVERIFIED,
        OrganizationVerificationStatus.PENDING,
      ),
    ).toBe(true);
    expect(
      canTransitionVerificationStatus(
        OrganizationVerificationStatus.PENDING,
        OrganizationVerificationStatus.VERIFIED,
      ),
    ).toBe(true);
    expect(
      canTransitionVerificationStatus(
        OrganizationVerificationStatus.PENDING,
        OrganizationVerificationStatus.REJECTED,
      ),
    ).toBe(true);
  });

  it('allows resubmission after a rejection', () => {
    expect(
      canTransitionVerificationStatus(
        OrganizationVerificationStatus.REJECTED,
        OrganizationVerificationStatus.PENDING,
      ),
    ).toBe(true);
  });

  it('does not let an organization skip review', () => {
    expect(
      canTransitionVerificationStatus(
        OrganizationVerificationStatus.UNVERIFIED,
        OrganizationVerificationStatus.VERIFIED,
      ),
    ).toBe(false);
    expect(
      canTransitionVerificationStatus(
        OrganizationVerificationStatus.REJECTED,
        OrganizationVerificationStatus.VERIFIED,
      ),
    ).toBe(false);
  });

  it('treats VERIFIED as terminal until an explicit revocation flow exists', () => {
    for (const target of Object.values(OrganizationVerificationStatus)) {
      expect(
        `${target}:${canTransitionVerificationStatus(OrganizationVerificationStatus.VERIFIED, target)}`,
      ).toBe(`${target}:false`);
    }
  });
});

describe('membership status machine', () => {
  it('permits suspend, reactivate and remove', () => {
    expect(canTransitionMembershipStatus(MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED)).toBe(
      true,
    );
    expect(canTransitionMembershipStatus(MembershipStatus.SUSPENDED, MembershipStatus.ACTIVE)).toBe(
      true,
    );
    expect(canTransitionMembershipStatus(MembershipStatus.ACTIVE, MembershipStatus.REMOVED)).toBe(
      true,
    );
    expect(
      canTransitionMembershipStatus(MembershipStatus.SUSPENDED, MembershipStatus.REMOVED),
    ).toBe(true);
  });

  it('treats REMOVED as terminal — re-joining needs a fresh invitation', () => {
    for (const target of Object.values(MembershipStatus)) {
      expect(`${target}:${canTransitionMembershipStatus(MembershipStatus.REMOVED, target)}`).toBe(
        `${target}:false`,
      );
    }
  });

  it('grants access only while ACTIVE', () => {
    expect(membershipPermitsAccess(MembershipStatus.ACTIVE)).toBe(true);
    expect(membershipPermitsAccess(MembershipStatus.SUSPENDED)).toBe(false);
    expect(membershipPermitsAccess(MembershipStatus.REMOVED)).toBe(false);
  });
});
