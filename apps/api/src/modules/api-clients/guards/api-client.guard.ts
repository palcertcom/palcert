import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AppError,
  PalCertErrorCode,
  scopeForOperation,
  type ApiClientOperation,
} from '@palcert/contracts';
import { requestIdOf } from '../../auth/authenticated-request';
import { API_CLIENT_OPERATION_KEY, MACHINE_ONLY_KEY } from '../decorators/api-client.decorators';
import type { MachineRequest } from '../machine-principal';
import { ApiClientAuthService } from '../services/api-client-auth.service';
import { ApiClientThrottleService } from '../services/api-client-throttle.service';

/**
 * Machine authentication and scope authorization (Phase 19).
 *
 * Runs on `@MachineOnly()` routes in place of the session guard, and the order
 * inside it is deliberate:
 *
 *  1. the route must name an operation — an unnamed route is closed, so a new
 *     controller is inaccessible by default rather than inherited;
 *  2. the operation must map to a scope in the published allow-list;
 *  3. the credential is throttled *before* it is verified, so a guessing
 *     attack cannot spend PalCert's Argon2 budget;
 *  4. the credential is authenticated;
 *  5. the scope is checked.
 *
 * Steps 1 and 2 happen before authentication on purpose: a route no machine may
 * reach answers the same way to an unauthenticated caller as to a valid one,
 * so the allow-list cannot be mapped by trying credentials against it.
 */
@Injectable()
export class ApiClientGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: ApiClientAuthService,
    private readonly throttle: ApiClientThrottleService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(MACHINE_ONLY_KEY, targets) !== true) {
      return true;
    }

    const operation = this.reflector.getAllAndOverride<ApiClientOperation | undefined>(
      API_CLIENT_OPERATION_KEY,
      targets,
    );

    // A machine-only route that forgot to name its operation is a programming
    // mistake, and it fails closed: nothing reaches the handler.
    if (operation === undefined) {
      throw new AppError(PalCertErrorCode.API_CLIENT_OPERATION_NOT_PERMITTED, {
        message: 'This operation is not available to API clients.',
        internalContext: { reason: 'machine-only route declares no operation' },
      });
    }

    const required = scopeForOperation(operation);
    if (required === null) {
      throw new AppError(PalCertErrorCode.API_CLIENT_OPERATION_NOT_PERMITTED, {
        message: 'This operation is not available to API clients.',
        internalContext: { reason: 'operation is absent from the allow-list', operation },
      });
    }

    const request = context.switchToHttp().getRequest<MachineRequest>();
    const presented = this.readCredential(request);

    await this.throttle.attempt(presented.clientId);

    const machine = await this.auth.authenticate(presented, {
      requestId: requestIdOf(request),
      ipAddress: request.ip ?? null,
    });

    await this.throttle.request(machine.apiClientId);

    if (!machine.scopes.has(required)) {
      // Safe to name the scope: the caller has already proved it holds a
      // credential, so it discloses nothing it could not learn by trying — and
      // it saves an integrator a support ticket.
      throw new AppError(PalCertErrorCode.API_CLIENT_SCOPE_INSUFFICIENT, {
        message: `This credential does not hold the ${required} scope.`,
        details: { field: 'scope' },
      });
    }

    request.machine = machine;
    return true;
  }

  /**
   * Read `Authorization: Basic base64(clientId:secret)`.
   *
   * Basic over TLS, and nothing else. Not a query parameter, ever: a URL
   * reaches access logs, proxy logs, browser history and `Referer` headers, and
   * a credential that lands in any of those is a credential that has leaked.
   * Not a custom header either — Basic is what every HTTP client already knows
   * how to send, and an integrator who does not have to write the header by
   * hand is an integrator who cannot get it subtly wrong.
   *
   * A malformed header produces the same refusal as a wrong secret, from the
   * same code path, so probing the parser tells a caller nothing.
   */
  private readCredential(request: MachineRequest): { clientId: string; secret: string } {
    const header = request.headers.authorization;
    const failure = new AppError(PalCertErrorCode.API_CLIENT_AUTHENTICATION_FAILED, {
      message: 'The credential could not be authenticated.',
    });

    if (typeof header !== 'string' || !header.toLowerCase().startsWith('basic ')) throw failure;

    const encoded = header.slice('basic '.length).trim();
    // Bounded before decoding: a caller must not be able to make PalCert
    // allocate a large buffer from a header.
    if (encoded.length === 0 || encoded.length > 512) throw failure;

    let decoded: string;
    try {
      decoded = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      throw failure;
    }

    // `indexOf`, not `split`: a secret containing a colon must not be truncated
    // at it. PalCert's own secrets never do, but a caller pasting something
    // else entirely should get a clean refusal rather than a partial parse.
    const separator = decoded.indexOf(':');
    if (separator <= 0 || separator === decoded.length - 1) throw failure;

    return {
      clientId: decoded.slice(0, separator),
      secret: decoded.slice(separator + 1),
    };
  }
}
