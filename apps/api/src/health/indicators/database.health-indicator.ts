import { Injectable } from '@nestjs/common';
import { HealthStatus, type HealthDependency } from '@palcert/contracts';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Fails the readiness probe if the database cannot answer within this budget. */
const PROBE_TIMEOUT_MS = 2_000;

export async function withTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} probe timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Injectable()
export class DatabaseHealthIndicator {
  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<HealthDependency> {
    const startedAt = Date.now();
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, PROBE_TIMEOUT_MS, 'database');
      return { name: 'database', status: HealthStatus.OK, latencyMs: Date.now() - startedAt };
    } catch {
      return {
        name: 'database',
        status: HealthStatus.ERROR,
        latencyMs: Date.now() - startedAt,
        // Deliberately generic: probe responses are unauthenticated and must
        // not leak connection strings, hostnames or driver internals.
        message: 'unreachable',
      };
    }
  }
}
