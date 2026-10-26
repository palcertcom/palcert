import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  ROLE_DEFINITIONS,
  RoleScope,
  getRoleDefinition,
  type Permission,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface EffectiveAuthorization {
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<string>;
  /** True when any held role demands a second factor. */
  readonly requiresMfa: boolean;
}

/**
 * Role and permission resolution.
 *
 * The catalogue lives in `@palcert/contracts` and is seeded by migration. At
 * boot this service verifies the database agrees with the code, so a missed
 * migration surfaces as a loud startup warning rather than as silently missing
 * authority at request time.
 */
@Injectable()
export class RbacService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RbacService.name);
  }

  async onModuleInit(): Promise<void> {
    await this.verifyCatalogueIntegrity();
  }

  /**
   * Compare the seeded database catalogue against the code catalogue.
   * Reports rather than repairs: silently rewriting authorization data at boot
   * would be a dangerous amount of implicit power.
   */
  async verifyCatalogueIntegrity(): Promise<{ missingRoles: string[]; mismatched: string[] }> {
    const dbRoles = await this.prisma.role.findMany({
      include: { permissions: { include: { permission: true } } },
    });
    const byCode = new Map(dbRoles.map((role) => [role.code, role]));

    const missingRoles: string[] = [];
    const mismatched: string[] = [];

    for (const definition of ROLE_DEFINITIONS) {
      const dbRole = byCode.get(definition.code);
      if (dbRole === undefined) {
        missingRoles.push(definition.code);
        continue;
      }
      if (dbRole.scope !== definition.scope || dbRole.requiresMfa !== definition.requiresMfa) {
        mismatched.push(definition.code);
        continue;
      }
      const dbPermissions = new Set(dbRole.permissions.map((rp) => rp.permission.code));
      const expected = new Set<string>(definition.permissions);
      if (
        dbPermissions.size !== expected.size ||
        [...expected].some((code) => !dbPermissions.has(code))
      ) {
        mismatched.push(definition.code);
      }
    }

    if (missingRoles.length > 0 || mismatched.length > 0) {
      this.logger.error(
        { missingRoles, mismatched },
        'Role catalogue in the database does not match the code catalogue — run migrations',
      );
    }

    return { missingRoles, mismatched };
  }

  /** Resolve everything authorization needs for a user, in a single query. */
  async resolveAuthorization(userId: string): Promise<EffectiveAuthorization> {
    const assignments = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });

    const roles: string[] = [];
    const permissions = new Set<string>();
    let requiresMfa = false;

    for (const assignment of assignments) {
      roles.push(assignment.role.code);
      if (assignment.role.requiresMfa) requiresMfa = true;
      for (const rolePermission of assignment.role.permissions) {
        permissions.add(rolePermission.permission.code);
      }
    }

    return { roles, permissions, requiresMfa };
  }

  /**
   * Grant a global role.
   *
   * Organization-scoped roles are rejected here: they are meaningless without
   * an organization, which Phase 2 introduces. The database enforces the same
   * rule, so a bug or a crafted payload cannot bypass it.
   */
  async assignGlobalRole(params: {
    userId: string;
    roleCode: string;
    grantedByUserId: string;
  }): Promise<void> {
    const definition = getRoleDefinition(params.roleCode);
    if (definition === undefined) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'Unknown role.',
        details: { roleCode: params.roleCode },
      });
    }

    if (definition.scope !== RoleScope.GLOBAL) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'Organization-scoped roles cannot be granted globally.',
        details: { roleCode: params.roleCode, scope: definition.scope },
      });
    }

    const role = await this.prisma.role.findUnique({ where: { code: params.roleCode } });
    if (role === null) {
      throw new AppError(PalCertErrorCode.NOT_FOUND, { message: 'Unknown role.' });
    }

    // Prisma cannot express a compound unique whose member is NULL, so the
    // grant is made idempotent explicitly. The database's NULLS NOT DISTINCT
    // index is still the real guarantee against a duplicate.
    const existing = await this.prisma.userRole.findFirst({
      where: { userId: params.userId, roleId: role.id, organizationId: null },
    });
    if (existing !== null) return;

    await this.prisma.userRole.create({
      data: {
        userId: params.userId,
        roleId: role.id,
        organizationId: null,
        scope: RoleScope.GLOBAL,
        grantedByUserId: params.grantedByUserId,
      },
    });
  }

  async removeGlobalRole(userId: string, roleCode: string): Promise<boolean> {
    const role = await this.prisma.role.findUnique({ where: { code: roleCode } });
    if (role === null) return false;

    const result = await this.prisma.userRole.deleteMany({
      where: { userId, roleId: role.id, organizationId: null },
    });
    return result.count > 0;
  }

  static hasPermission(
    authorization: EffectiveAuthorization,
    required: readonly Permission[],
  ): boolean {
    return required.every((permission) => authorization.permissions.has(permission));
  }
}
