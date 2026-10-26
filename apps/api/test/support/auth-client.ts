import type { INestApplication } from '@nestjs/common';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from '@palcert/contracts';
import request from 'supertest';
import type { TestContext } from './test-app';

export const API = '/api/v1';
export const TRUSTED_ORIGIN = 'http://localhost:3000';

/**
 * A browser-like client.
 *
 * It stores cookies and echoes the CSRF cookie into the header the way a real
 * front end must, so the tests exercise the genuine request shape rather than
 * a privileged shortcut.
 */
export class AuthClient {
  private cookies = new Map<string, string>();

  constructor(
    private readonly app: INestApplication,
    private origin: string | null = TRUSTED_ORIGIN,
  ) {}

  get sessionCookie(): string | undefined {
    return this.cookies.get(SESSION_COOKIE_NAME);
  }

  get csrfCookie(): string | undefined {
    return this.cookies.get(CSRF_COOKIE_NAME);
  }

  setOrigin(origin: string | null): void {
    this.origin = origin;
  }

  /** Adopt a session token directly, to simulate a stolen or planted cookie. */
  adoptSession(token: string, csrfToken?: string): void {
    this.cookies.set(SESSION_COOKIE_NAME, token);
    if (csrfToken !== undefined) this.cookies.set(CSRF_COOKIE_NAME, csrfToken);
  }

  clearCookies(): void {
    this.cookies.clear();
  }

  async get(path: string): Promise<request.Response> {
    return this.send('get', path);
  }

  async post(path: string, body?: unknown, options?: RequestOptions): Promise<request.Response> {
    return this.send('post', path, body, options);
  }

  async patch(path: string, body?: unknown, options?: RequestOptions): Promise<request.Response> {
    return this.send('patch', path, body, options);
  }

  async put(path: string, body?: unknown, options?: RequestOptions): Promise<request.Response> {
    return this.send('put', path, body, options);
  }

  async delete(path: string, body?: unknown, options?: RequestOptions): Promise<request.Response> {
    return this.send('delete', path, body, options);
  }

  private async send(
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<request.Response> {
    let call = request(this.app.getHttpServer())[method](path);

    const cookieHeader = [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    if (cookieHeader.length > 0) call = call.set('Cookie', cookieHeader);

    const origin = options.origin !== undefined ? options.origin : this.origin;
    if (origin !== null) call = call.set('Origin', origin);

    if (method !== 'get' && options.omitCsrf !== true) {
      const csrf = options.csrfToken ?? this.csrfCookie;
      if (csrf !== undefined) call = call.set(CSRF_HEADER_NAME, csrf);
    }

    for (const [header, value] of Object.entries(options.headers ?? {})) {
      call = call.set(header, value);
    }

    if (body !== undefined) call = call.send(body as object);

    const response = await call;
    this.captureCookies(response);
    return response;
  }

  private captureCookies(response: request.Response): void {
    const setCookie = response.headers['set-cookie'];
    if (setCookie === undefined) return;

    for (const raw of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const [pair] = raw.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (pair === undefined || separator < 0) continue;

      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value === '' || raw.includes('Expires=Thu, 01 Jan 1970')) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }
}

export interface RequestOptions {
  readonly omitCsrf?: boolean;
  readonly csrfToken?: string;
  readonly origin?: string | null;
  readonly headers?: Record<string, string>;
}

export interface RegisteredUser {
  readonly email: string;
  readonly password: string;
  readonly userId: string;
}

/** Register and verify an account, leaving it ready to sign in. */
export async function registerAndVerify(
  context: TestContext,
  email: string,
  password = 'a-correct-horse-battery-staple',
  locale: 'en' | 'ar' = 'en',
): Promise<RegisteredUser> {
  const client = new AuthClient(context.app);
  const registered = await client.post(`${API}/auth/register`, { email, password, locale });
  if (registered.status !== 202) {
    throw new Error(
      `Registration failed (${registered.status}): ${JSON.stringify(registered.body)}`,
    );
  }

  const token = lastVerificationToken(context, email);
  const verified = await client.post(`${API}/auth/email/verify`, { token });
  if (verified.status !== 200) {
    throw new Error(`Verification failed (${verified.status}): ${JSON.stringify(verified.body)}`);
  }

  const user = await context.prisma.user.findFirstOrThrow({
    where: { normalizedEmail: email.toLowerCase() },
  });
  return { email, password, userId: user.id };
}

export function lastVerificationToken(context: TestContext, email: string): string {
  const message = context.outbox.lastTo(email, 'EMAIL_VERIFICATION');
  if (message === undefined) throw new Error(`No verification mail for ${email}`);
  return message.variables.token!;
}

export function lastResetToken(context: TestContext, email: string): string {
  const message = context.outbox.lastTo(email, 'PASSWORD_RESET');
  if (message === undefined) throw new Error(`No reset mail for ${email}`);
  return message.variables.token!;
}

/** Sign in and return the browser-like client holding the session. */
export async function signIn(
  context: TestContext,
  email: string,
  password: string,
): Promise<AuthClient> {
  const client = new AuthClient(context.app);
  const response = await client.post(`${API}/auth/login`, { email, password });
  if (response.status !== 200) {
    throw new Error(`Login failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
  return client;
}

/** Grant a global role directly, bypassing the API — used to set up fixtures. */
export async function grantGlobalRole(
  context: TestContext,
  userId: string,
  roleCode: string,
): Promise<void> {
  const role = await context.prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  await context.prisma.userRole.create({
    data: { userId, roleId: role.id, organizationId: null, scope: 'GLOBAL' },
  });
}

export function parseSetCookie(
  response: request.Response,
  name: string,
): Record<string, string> | null {
  const setCookie = response.headers['set-cookie'];
  if (setCookie === undefined) return null;

  const entries: string[] = Array.isArray(setCookie) ? setCookie : [setCookie];
  const raw = entries.find((entry) => entry.startsWith(`${name}=`));
  if (raw === undefined) return null;

  const attributes: Record<string, string> = {};
  const parts: string[] = raw.split(';').map((part: string) => part.trim());
  const [first, ...rest] = parts;
  attributes.value = first!.slice(name.length + 1);

  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq < 0) attributes[part.toLowerCase()] = 'true';
    else attributes[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1);
  }
  return attributes;
}
