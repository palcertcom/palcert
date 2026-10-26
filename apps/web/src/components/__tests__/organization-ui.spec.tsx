import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OrganizationSwitcher } from '../organization-switcher';
import { OrganizationNav } from '../organization-nav';
import { VerificationBadge } from '../verified-badge';
import { permissionsForRoles } from '../organization-shell';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import type { UserOrganizationResponse } from '@/lib/api-client';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/en/organizations/org-1',
  useParams: () => ({ locale: 'en', organizationId: 'org-1' }),
}));

function organization(id: string, name: string, status = 'ACTIVE'): UserOrganizationResponse {
  return {
    organization: {
      id,
      slug: name.toLowerCase(),
      displayName: name,
      type: 'UNIVERSITY',
      status: 'ACTIVE',
      verificationStatus: 'UNVERIFIED',
      countryCode: 'PS',
    },
    membershipId: `m-${id}`,
    membershipStatus: status,
    roles: ['ORGANIZATION_ADMIN'],
    joinedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('OrganizationSwitcher', () => {
  const messages = getOrganizationMessages('en');

  it('is a labelled, keyboard-operable native control', () => {
    render(
      <OrganizationSwitcher
        organizations={[organization('org-1', 'Alpha'), organization('org-2', 'Beta')]}
        currentId="org-1"
        locale="en"
        messages={messages}
      />,
    );

    const select = screen.getByLabelText(messages.switchOrganization);
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('org-1');
  });

  it('lists only the organizations it was given', () => {
    render(
      <OrganizationSwitcher
        organizations={[organization('org-1', 'Alpha'), organization('org-2', 'Beta')]}
        currentId="org-1"
        locale="en"
        messages={messages}
      />,
    );

    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('option', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Beta' })).toBeInTheDocument();
  });

  it('marks a suspended membership so the state is visible', () => {
    render(
      <OrganizationSwitcher
        organizations={[organization('org-1', 'Alpha', 'SUSPENDED')]}
        currentId="org-1"
        locale="en"
        messages={messages}
      />,
    );

    expect(screen.getByRole('option', { name: /Suspended/ })).toBeInTheDocument();
  });

  it('renders nothing when the user belongs to no organization', () => {
    const { container } = render(
      <OrganizationSwitcher organizations={[]} currentId="" locale="en" messages={messages} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('translates into Arabic', () => {
    const arabic = getOrganizationMessages('ar');
    render(
      <OrganizationSwitcher
        organizations={[organization('org-1', 'Alpha')]}
        currentId="org-1"
        locale="ar"
        messages={arabic}
      />,
    );

    expect(screen.getByLabelText(arabic.switchOrganization)).toBeInTheDocument();
  });
});

describe('OrganizationNav', () => {
  const messages = getOrganizationMessages('en');

  it('shows only sections the caller can use', () => {
    render(
      <OrganizationNav
        locale="en"
        organizationId="org-1"
        messages={messages}
        permissions={permissionsForRoles(['ORGANIZATION_REVIEWER'])}
      />,
    );

    expect(screen.getByRole('link', { name: messages.navOverview })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: messages.navTeam })).toBeInTheDocument();
    // A reviewer has no invite permission, so that section is not offered.
    expect(screen.getByRole('link', { name: messages.navInvitations })).toBeInTheDocument();
  });

  it('marks the active section for assistive technology', () => {
    render(
      <OrganizationNav
        locale="en"
        organizationId="org-1"
        messages={messages}
        permissions={permissionsForRoles(['ORGANIZATION_OWNER'])}
      />,
    );

    const current = screen.getByRole('link', { current: 'page' });
    expect(current).toHaveTextContent(messages.navOverview);
  });

  it('renders no sections at all for a member with no permissions', () => {
    render(
      <OrganizationNav
        locale="en"
        organizationId="org-1"
        messages={messages}
        permissions={new Set()}
      />,
    );

    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('offers the standards sections to a role that can author them', () => {
    render(
      <OrganizationNav
        locale="en"
        organizationId="org-1"
        messages={messages}
        permissions={permissionsForRoles(['TEMPLATE_MANAGER'])}
      />,
    );

    expect(screen.getByRole('link', { name: 'Standards' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Document types' })).toBeInTheDocument();
  });

  it('does not offer sections from phases that have not shipped', () => {
    render(
      <OrganizationNav
        locale="en"
        organizationId="org-1"
        messages={messages}
        permissions={permissionsForRoles(['ORGANIZATION_OWNER'])}
      />,
    );

    for (const absent of ['Documents', 'Checks', 'Reports']) {
      expect(screen.queryByRole('link', { name: absent })).toBeNull();
    }
    expect(screen.getByRole('link', { name: 'Issued certificates' })).toHaveAttribute(
      'href',
      '/en/organizations/org-1/certificates',
    );
  });

  it('hides the standards sections from a role without the read permission', () => {
    // A courtesy, not a control — the API authorizes every request regardless —
    // but a link that always 403s is a bug report waiting to happen.
    render(
      <OrganizationNav
        locale="en"
        organizationId="org-1"
        messages={messages}
        permissions={new Set(['organization:profile:read'])}
      />,
    );

    expect(screen.queryByRole('link', { name: 'Standards' })).toBeNull();
  });
});

describe('VerificationBadge', () => {
  const messages = getOrganizationMessages('en');

  it('shows the verified label with the semantics as a tooltip', () => {
    render(<VerificationBadge status="VERIFIED" messages={messages} />);

    const badge = screen.getByText(messages.verifiedBadge);
    expect(badge).toHaveAttribute('title', messages.verificationSemantics);
    expect(badge.getAttribute('title')).toContain('not an assessment');
  });

  it('shows the translated status when not verified', () => {
    render(<VerificationBadge status="PENDING" messages={messages} />);
    expect(screen.getByText('Under review')).toBeInTheDocument();
  });

  it('translates into Arabic', () => {
    const arabic = getOrganizationMessages('ar');
    render(<VerificationBadge status="VERIFIED" messages={arabic} />);
    expect(screen.getByText(arabic.verifiedBadge)).toBeInTheDocument();
  });
});

describe('permissionsForRoles', () => {
  it('gives the owner ownership transfer and the admin not', () => {
    expect(permissionsForRoles(['ORGANIZATION_OWNER'])).toContain(
      'organization:ownership:transfer',
    );
    expect(permissionsForRoles(['ORGANIZATION_ADMIN'])).not.toContain(
      'organization:ownership:transfer',
    );
  });

  it('keeps a reviewer read-only', () => {
    const permissions = permissionsForRoles(['ORGANIZATION_REVIEWER']);
    expect(permissions).toContain('organization:member:read');
    expect(permissions).not.toContain('organization:member:invite');
    expect(permissions).not.toContain('organization:profile:update');
  });

  it('unions the permissions of multiple roles', () => {
    const permissions = permissionsForRoles(['ORGANIZATION_REVIEWER', 'ORGANIZATION_ADMIN']);
    expect(permissions).toContain('organization:member:invite');
  });

  it('ignores a role it does not know', () => {
    expect(permissionsForRoles(['FUTURE_ROLE']).size).toBe(0);
  });
});
