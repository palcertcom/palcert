import { ValidationPipe, VersioningType } from '@nestjs/common';
import { registerStandardImportBodyParser } from './modules/standards/transfer-body-parser';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  API_VERSION,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from '@palcert/contracts';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ApiConfigService } from './config/api-config.service';

export const OPENAPI_PATH = 'api/docs';

/**
 * The OpenAPI document's configuration.
 *
 * Exported so the contract test asserts against the schemes the server
 * actually publishes, rather than against a copy of them that could drift.
 */
export function buildOpenApiConfig(version: string) {
  return (
    new DocumentBuilder()
      .setTitle('PalCert API')
      .setDescription(
        'PalCert — document compliance, correction, verification and certification platform.',
      )
      .setVersion(version)
      .addCookieAuth(SESSION_COOKIE_NAME, {
        type: 'apiKey',
        in: 'cookie',
        name: SESSION_COOKIE_NAME,
        description:
          'Opaque server-side session. Set by POST /api/v1/auth/login as an HttpOnly, ' +
          'SameSite cookie (Secure in production). Unsafe requests must also echo the ' +
          `${CSRF_COOKIE_NAME} cookie value in the ${CSRF_HEADER_NAME} header.`,
      })
      .addBearerAuth()
      // Phase 19: the public integration API. HTTP Basic carries the client id
      // as the username and the secret as the password — the one scheme every
      // HTTP client on every platform already implements correctly, which
      // matters more for an integration credential than novelty does. It is
      // declared here so `@ApiBasicAuth()` on the integration controller
      // resolves to a real scheme rather than a dangling reference.
      .addBasicAuth(
        {
          type: 'http',
          scheme: 'basic',
          description:
            'Client id as the username, client secret as the password, over TLS. PalCert never ' +
            'reads a credential from a query string or a body field. A refusal is always 401 ' +
            'with API_CLIENT_AUTHENTICATION_FAILED, identically for an unknown client, a wrong ' +
            'secret, a revoked or disabled client and a suspended organization — telling them ' +
            'apart would let a caller enumerate which credentials exist.',
        },
        'api-client',
      )
      .build()
  );
}

/**
 * Build a fully configured application instance.
 * Exported separately from `main` so e2e tests boot the identical stack.
 */
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Phase 10: a payment provider signs the exact bytes it sent, so the raw
    // body must survive parsing. Without this every webhook signature would
    // fail verification — safely, but silently, and no balance would ever be
    // credited (§48).
    rawBody: true,
  });

  app.useLogger(app.get(Logger));
  const config = app.get(ApiConfigService);

  // --- Security baseline (§38) ---------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  app.disable('x-powered-by');

  // Who may assert a client's address (Phase 20 Checkpoint 7).
  //
  // `X-Forwarded-For` is written by whoever sent the request, and PalCert makes
  // two security decisions from the address it yields — the per-IP login
  // throttle and the per-IP public-verification guard — besides recording it on
  // every audit event.
  //
  // This was `1`: trust one hop, from anybody. Correct behind the release
  // proxy, and broader than that topology needs — any caller able to reach the
  // API port directly was trusted for a hop, which is precisely how Checkpoint
  // 20.6's load generator presented 131 072 client identities to a rate
  // limiter. Now only the configured upstreams are believed, and the default is
  // to believe none: `req.ip` is then the address that opened the socket, which
  // cannot be forged by a header.
  app.set('trust proxy', config.trustedProxies);

  // Must precede the guards: SessionGuard and CsrfGuard both read req.cookies.
  app.use(cookieParser());
  // Portable standard packages are the only bodies allowed past the default
  // 100 kB limit, and only on their two routes.
  registerStandardImportBodyParser(app);

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    maxAge: 600,
  });

  // --- API surface (§35) ---------------------------------------------------
  // Operational endpoints sit outside the product API's prefix and versioning:
  // a probe or a scrape URL must stay stable across API versions, and neither
  // is part of the contract PalCert publishes (Phase 20 Checkpoints 2 and 3).
  app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready', 'metrics'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION.replace('v', '') });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableShutdownHooks();

  if (config.docsEnabled) {
    const openApiConfig = buildOpenApiConfig(config.appVersion);
    const document = SwaggerModule.createDocument(app, openApiConfig);
    SwaggerModule.setup(OPENAPI_PATH, app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  return app;
}
