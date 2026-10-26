import {
  applyDecorators,
  SetMetadata,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../../auth/decorators/auth.decorators';
import type { ApiClientOperation } from '@palcert/contracts';
import type { MachinePrincipal, MachineRequest } from '../machine-principal';

/**
 * The machine-access allow-list, expressed as an opt-in (Phase 19).
 *
 * A route is closed to API clients until it names the operation it implements.
 * Not a path pattern, not a prefix, not a module: a name, on the handler, that
 * a reviewer can grep for and count. Adding a route therefore never widens
 * machine access, which is the failure this design exists to prevent — and
 * there are exactly as many reachable operations as there are usages of this
 * decorator.
 */
export const API_CLIENT_OPERATION_KEY = 'palcert:api-client-operation';
export const MachineOperation = (operation: ApiClientOperation) =>
  SetMetadata(API_CLIENT_OPERATION_KEY, operation);

/**
 * Marks a route as reachable *only* by a machine.
 *
 * The integration API lives at its own paths rather than sharing the human
 * ones. Sharing looked tempting — one controller, two callers — and it is the
 * shape in which a change made for a person quietly reaches a machine. Separate
 * controllers make the machine surface something you can read in one file.
 */
export const MACHINE_ONLY_KEY = 'palcert:machine-only';

/**
 * Composed with `@Public()` rather than requiring both to be written.
 *
 * `SessionGuard` runs on every route and would reject a machine for having no
 * session cookie — before `ApiClientGuard` ever sees the credential. Marking
 * the route public is what lets machine authentication happen instead, and
 * composing it here means the two can never be written inconsistently: there
 * is no machine route that forgot the opt-out, and no route that opted out of
 * sessions without becoming a machine route.
 *
 * "Public" is the session guard's word for "not authenticated by a cookie". It
 * is not "unauthenticated": `ApiClientGuard` refuses anything without a valid
 * credential, and refuses it before the handler exists.
 */
export const MachineOnly = () =>
  applyDecorators(SetMetadata(MACHINE_ONLY_KEY, true), SetMetadata(IS_PUBLIC_KEY, true));

/** The authenticated machine. Fails loudly if the guard did not run. */
export const CurrentMachine = createParamDecorator(
  (_data: unknown, context: ExecutionContext): MachinePrincipal => {
    const request = context.switchToHttp().getRequest<MachineRequest>();
    if (request.machine === undefined) {
      throw new Error('CurrentMachine used on a route the ApiClientGuard did not authenticate');
    }
    return request.machine;
  },
);
