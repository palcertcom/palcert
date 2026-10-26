import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { buildPrismaClientOptions, PrismaClient } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../config/api-config.service';

interface RolePrivileges {
  role_name: string;
  is_superuser: boolean;
  can_bypass_rls: boolean;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger: PinoLogger;

  private readonly config: ApiConfigService;

  constructor(config: ApiConfigService, logger: PinoLogger) {
    super(buildPrismaClientOptions({ databaseUrl: config.databaseUrl }));
    this.config = config;
    this.logger = logger;
    this.logger.setContext(PrismaService.name);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.assertLeastPrivilege();
    this.logger.info('Database connection established');
  }

  /**
   * Refuse to serve traffic if the request-path role can bypass row-level
   * security (§16).
   *
   * Every RLS policy PalCert relies on is inert against a superuser or a role
   * holding BYPASSRLS. A misconfigured connection string would therefore
   * silently remove the tenant boundary while every application-level test
   * continued to pass — exactly the failure mode RLS exists to catch. Checking
   * at boot turns that silent hole into a refusal to start.
   */
  private async assertLeastPrivilege(): Promise<void> {
    const [privileges] = await this.$queryRaw<RolePrivileges[]>`
      SELECT rolname AS role_name,
             rolsuper AS is_superuser,
             rolbypassrls AS can_bypass_rls
      FROM pg_roles
      WHERE rolname = CURRENT_USER
    `;

    if (privileges === undefined) {
      throw new Error('Unable to determine the privileges of the database role');
    }

    const overPrivileged = privileges.is_superuser || privileges.can_bypass_rls;

    if (!overPrivileged) {
      this.logger.info({ databaseRole: privileges.role_name }, 'Database role is least-privileged');
      return;
    }

    const message =
      `The database role "${privileges.role_name}" can bypass row-level security ` +
      `(superuser=${privileges.is_superuser}, bypassrls=${privileges.can_bypass_rls}). ` +
      'Tenant isolation policies would not be enforced. Point DATABASE_URL at the ' +
      'least-privileged application role (see docs/security/database-roles.md).';

    if (this.config.enforceDatabaseLeastPrivilege) {
      throw new Error(message);
    }

    // Only reachable outside production, where the config schema permits the
    // check to be disabled for a local experiment.
    this.logger.error({ databaseRole: privileges.role_name }, message);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.info('Database connection closed');
  }
}
