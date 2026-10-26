import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { API, type AuthClient } from './auth-client';

/**
 * A machine caller (Phase 19).
 *
 * Holds a client id and a secret and nothing else: no cookie jar, no CSRF
 * token, no origin. That is the point of the helper — a test using it cannot
 * accidentally borrow a human session, so anything it reaches, it reached with
 * the credential.
 */
export class MachineClient {
  constructor(
    private readonly app: INestApplication,
    readonly clientId: string,
    private secret: string,
  ) {}

  /** For rotation tests: keep calling with the secret we started with. */
  withSecret(secret: string): MachineClient {
    return new MachineClient(this.app, this.clientId, secret);
  }

  get authorization(): string {
    return `Basic ${Buffer.from(`${this.clientId}:${this.secret}`, 'utf8').toString('base64')}`;
  }

  async get(path: string): Promise<request.Response> {
    return request(this.app.getHttpServer()).get(path).set('Authorization', this.authorization);
  }

  /** A raw call, for malformed-credential cases the typed helper cannot express. */
  static async raw(
    app: INestApplication,
    path: string,
    authorization?: string,
  ): Promise<request.Response> {
    const call = request(app.getHttpServer()).get(path);
    return authorization === undefined ? call : call.set('Authorization', authorization);
  }
}

export interface CreatedApiClient {
  readonly apiClientId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly machine: MachineClient;
}

export async function createApiClient(
  app: INestApplication,
  admin: AuthClient,
  organizationId: string,
  scopes: string[],
  overrides: { displayName?: string; expiresAt?: string } = {},
): Promise<CreatedApiClient> {
  const response = await admin.post(
    `${API}/organizations/${organizationId}/api-clients`,
    {
      displayName: overrides.displayName ?? 'Student records integration',
      scopes,
      ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
    },
    { headers: { 'idempotency-key': randomUUID() } },
  );
  if (response.status !== 201) {
    throw new Error(
      `create api client failed (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }
  const body = response.body as {
    client: { apiClientId: string; clientId: string };
    clientSecret: string;
  };
  return {
    apiClientId: body.client.apiClientId,
    clientId: body.client.clientId,
    clientSecret: body.clientSecret,
    machine: new MachineClient(app, body.client.clientId, body.clientSecret),
  };
}

export const INTEGRATION = `${API}/integration/v1`;
