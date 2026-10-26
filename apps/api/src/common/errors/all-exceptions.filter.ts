import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Injectable,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  REQUEST_ID_HEADER,
  type PublicErrorBody,
} from '@palcert/contracts';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

/**
 * Single exit point for every error leaving the API (§47).
 *
 * Contract:
 *  - Clients receive a stable `code`, a safe message and their `requestId`.
 *  - Stack traces, driver errors and internal context are logged only.
 *  - Unrecognized errors are reported as INTERNAL_ERROR with a generic message,
 *    so implementation details can never leak through an unhandled path.
 */
@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request & { id?: string }>();
    const response = ctx.getResponse<Response>();
    const requestId = this.resolveRequestId(request);

    const { status, body, internalContext } = this.normalize(exception, requestId);

    const logPayload = {
      requestId,
      errorCode: body.error.code,
      statusCode: status,
      method: request.method,
      path: request.url,
      ...(internalContext ? { context: internalContext } : {}),
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({ ...logPayload, err: exception }, 'Unhandled request failure');
    } else {
      this.logger.warn({ ...logPayload, err: exception }, 'Request rejected');
    }

    if (!response.headersSent) {
      response.setHeader(REQUEST_ID_HEADER, requestId);
    }
    response.status(status).json(body);
  }

  private resolveRequestId(request: Request & { id?: string }): string {
    if (typeof request.id === 'string' && request.id.length > 0) return request.id;
    const header = request.headers[REQUEST_ID_HEADER];
    return typeof header === 'string' ? header : 'unknown';
  }

  private normalize(
    exception: unknown,
    requestId: string,
  ): { status: number; body: PublicErrorBody; internalContext?: Record<string, unknown> } {
    if (AppError.isAppError(exception)) {
      return {
        status: exception.httpStatus,
        body: exception.toPublicJSON(requestId),
        ...(exception.internalContext ? { internalContext: exception.internalContext } : {}),
      };
    }

    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        body: this.fromHttpException(exception, requestId),
      };
    }

    // Unknown failure: expose nothing.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: PalCertErrorCode.INTERNAL_ERROR,
          message: 'An unexpected error occurred.',
          requestId,
        },
      },
    };
  }

  private fromHttpException(exception: HttpException, requestId: string): PublicErrorBody {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    const code = HTTP_STATUS_TO_ERROR_CODE[status] ?? PalCertErrorCode.INTERNAL_ERROR;

    // `ValidationPipe` returns { message: string[] } — surface those as details.
    if (typeof payload === 'object' && payload !== null && 'message' in payload) {
      const message = (payload as { message: unknown }).message;
      if (Array.isArray(message)) {
        return {
          error: {
            code: PalCertErrorCode.VALIDATION_FAILED,
            message: 'Request validation failed.',
            details: { issues: message },
            requestId,
          },
        };
      }
      if (typeof message === 'string' && status < HttpStatus.INTERNAL_SERVER_ERROR) {
        return { error: { code, message, requestId } };
      }
    }

    return {
      error: {
        code,
        message:
          status < HttpStatus.INTERNAL_SERVER_ERROR
            ? exception.message
            : 'An unexpected error occurred.',
        requestId,
      },
    };
  }
}

const HTTP_STATUS_TO_ERROR_CODE: Record<number, PalCertErrorCode> = {
  [HttpStatus.BAD_REQUEST]: PalCertErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: PalCertErrorCode.UNAUTHENTICATED,
  [HttpStatus.PAYMENT_REQUIRED]: PalCertErrorCode.PAYMENT_FAILED,
  [HttpStatus.FORBIDDEN]: PalCertErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: PalCertErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: PalCertErrorCode.CONFLICT,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: PalCertErrorCode.UNSUPPORTED_DOCUMENT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: PalCertErrorCode.VALIDATION_FAILED,
  [HttpStatus.TOO_MANY_REQUESTS]: PalCertErrorCode.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: PalCertErrorCode.SERVICE_UNAVAILABLE,
};
