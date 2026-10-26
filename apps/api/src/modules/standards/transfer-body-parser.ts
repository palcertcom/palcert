import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppError, PalCertErrorCode, PORTABLE_STANDARD_LIMITS } from '@palcert/contracts';
import { json } from 'body-parser';
import type { NextFunction, Request, Response } from 'express';

/**
 * A larger JSON body limit for exactly the two routes that carry a portable
 * standard package, and nowhere else.
 *
 * The application-wide limit stays at the framework default (100 kB): no other
 * endpoint needs more, and a large default is an easy way to let any route be
 * used to make the API buffer megabytes. A package may be up to 5 MB of text;
 * embedded in a JSON string its newlines and quotes are escaped, so the body
 * limit leaves room for that. The package itself is measured again, in bytes,
 * when it is read.
 *
 * Registered before the framework's own parser, which then sees the body
 * already parsed and leaves it alone.
 */
export const STANDARD_IMPORT_ROUTE =
  /^\/api\/v1\/organizations\/[^/]+\/standards\/import(?:\/preview)?\/?$/;

export function registerStandardImportBodyParser(app: NestExpressApplication): void {
  const parser = json({ limit: Math.ceil(PORTABLE_STANDARD_LIMITS.maxBytes * 1.6), strict: true });
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.method === 'POST' && STANDARD_IMPORT_ROUTE.test(request.path)) {
      // The parser's own errors are plain HTTP errors the exception filter does
      // not know; translate them into PalCert's, so an oversized upload is a 413
      // with a code the client can explain rather than an opaque 500.
      parser(request, response, (error?: unknown) => {
        if (error === undefined || error === null) {
          next();
          return;
        }
        const type = (error as { type?: string }).type;
        next(
          type === 'entity.too.large'
            ? new AppError(PalCertErrorCode.STANDARD_IMPORT_PACKAGE_TOO_LARGE, {
                message: `The file is larger than ${PORTABLE_STANDARD_LIMITS.maxBytes / (1024 * 1024)} MB.`,
              })
            : new AppError(PalCertErrorCode.VALIDATION_FAILED, {
                message: 'The request body is not valid JSON.',
              }),
        );
      });
      return;
    }
    next();
  });
}
