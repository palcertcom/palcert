'use client';

import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  authApi,
  organizationApi,
  type UserOrganizationResponse,
  type UserProfileResponse,
} from '@/lib/api-client';
import { permissionsForRoles } from '@/lib/organization-permissions';
import { isAuthPath, organizationIdFromPath } from '@/lib/shell-navigation';

/** Remembered only to put the user back where they were; it grants nothing. */
const LAST_ORGANIZATION_KEY = 'pc.lastOrganization';

export type ShellStatus = 'loading' | 'signed-in' | 'signed-out';

export interface ShellState {
  readonly status: ShellStatus;
  readonly user: UserProfileResponse | null;
  readonly globalPermissions: ReadonlySet<string>;
  readonly organizations: readonly UserOrganizationResponse[];
  /** The organization the shell is showing: the one in the URL, else the last used. */
  readonly currentOrganization: UserOrganizationResponse | null;
  readonly organizationPermissions: ReadonlySet<string>;
  readonly unreadNotifications: number | null;
  readonly setUnreadNotifications: (count: number | null) => void;
  readonly reload: () => void;
}

const EMPTY: ReadonlySet<string> = new Set();

const ShellContext = createContext<ShellState>({
  status: 'loading',
  user: null,
  globalPermissions: EMPTY,
  organizations: [],
  currentOrganization: null,
  organizationPermissions: EMPTY,
  unreadNotifications: null,
  setUnreadNotifications: () => undefined,
  reload: () => undefined,
});

export function useShell(): ShellState {
  return useContext(ShellContext);
}

function readLastOrganization(): string | null {
  try {
    return window.localStorage.getItem(LAST_ORGANIZATION_KEY);
  } catch {
    return null;
  }
}

function writeLastOrganization(id: string): void {
  try {
    window.localStorage.setItem(LAST_ORGANIZATION_KEY, id);
  } catch {
    // Private window or blocked storage: the shell simply forgets.
  }
}

/**
 * Who is signed in, and in which organizations — loaded once for the shell.
 *
 * This is presentation state only. `/users/me` reports the permissions the
 * server computed from the user's global roles; organization permissions come
 * from the user's roles in that organization via the shared role catalogue.
 * Pages still load what they need and the API still authorizes every request.
 */
export function ShellProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const [status, setStatus] = useState<ShellStatus>('loading');
  const [user, setUser] = useState<UserProfileResponse | null>(null);
  const [organizations, setOrganizations] = useState<readonly UserOrganizationResponse[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [lastOrganizationId, setLastOrganizationId] = useState<string | null>(null);
  // Sign-in and sign-out both pass through an auth page, so leaving or
  // entering one is when "who is signed in" can have changed.
  const authBoundary = isAuthPath(pathname);

  useEffect(() => {
    setLastOrganizationId(readLastOrganization());
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const me: UserProfileResponse | undefined = await authApi.me();
        if (cancelled) return;
        // A response whose body never arrived (a fetch the browser cancelled
        // mid-read while navigating) parses to nothing. That is not a user.
        if (me === undefined || me === null) throw new Error('No profile in the response');
        setUser(me);
        setStatus('signed-in');
        // Memberships are a separate read: a failure here still leaves a
        // working personal shell rather than a signed-out one.
        const mine = await organizationApi.mine().catch(() => []);
        if (!cancelled) setOrganizations(mine);
      } catch {
        // Not signed in, or the API is unreachable: either way the shell
        // offers sign-in, and the page itself reports what went wrong.
        if (cancelled) return;
        setUser(null);
        setOrganizations([]);
        setStatus('signed-out');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [reloadToken, authBoundary]);

  const routeOrganizationId = organizationIdFromPath(pathname);
  useEffect(() => {
    if (routeOrganizationId !== null) {
      writeLastOrganization(routeOrganizationId);
      setLastOrganizationId(routeOrganizationId);
    }
  }, [routeOrganizationId]);

  const currentOrganization = useMemo(() => {
    const wanted = routeOrganizationId ?? lastOrganizationId;
    return (
      organizations.find((entry) => entry.organization.id === wanted) ??
      (routeOrganizationId === null ? (organizations[0] ?? null) : null)
    );
  }, [organizations, routeOrganizationId, lastOrganizationId]);

  const organizationPermissions = useMemo(
    () =>
      // A suspended or pending membership offers no sections; the API would
      // refuse them anyway.
      currentOrganization === null || currentOrganization.membershipStatus !== 'ACTIVE'
        ? EMPTY
        : permissionsForRoles(currentOrganization.roles),
    [currentOrganization],
  );

  const globalPermissions = useMemo(
    () => (user === null ? EMPTY : new Set(user.permissions ?? [])),
    [user],
  );

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  const value = useMemo<ShellState>(
    () => ({
      status,
      user,
      globalPermissions,
      organizations,
      currentOrganization,
      organizationPermissions,
      unreadNotifications,
      setUnreadNotifications,
      reload,
    }),
    [
      status,
      user,
      globalPermissions,
      organizations,
      currentOrganization,
      organizationPermissions,
      unreadNotifications,
      reload,
    ],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
