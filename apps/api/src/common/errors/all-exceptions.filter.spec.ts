import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { AppError, PalCertErrorCode, REQUEST_ID_HEADER } from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { AllExceptionsFilter } from './all-exceptions.filter';

interface CapturedResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

function createHost(request: Record<string, unknown> = {}): {
  host: ArgumentsHost;
  captured: CapturedResponse;
} {
  const captured: CapturedResponse = { status: 0, body: undefined, headers: {} };

  const response = {
    headersSent: false,
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  };

  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', url: '/api/v1/things', headers: {}, ...request }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return { host, captured };
}

function createFilter(): { filter: AllExceptionsFilter; logger: PinoLogger } {
  const logger = {
    setContext: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as PinoLogger;
  return { filter: new AllExceptionsFilter(logger), logger };
}

describe('AllExceptionsFilter', () => {
  it('maps an AppError to its code and HTTP status', () => {
    const { filter } = createFilter();
    const { host, captured } = createHost({ id: 'req_abc' });

    filter.catch(
      new AppError(PalCertErrorCode.INSUFFICIENT_BALANCE, { message: 'Not enough credit' }),
      host,
    );

    expect(captured.status).toBe(402);
    expect(captured.body).toEqual({
      error: {
        code: 'INSUFFICIENT_BALANCE',
        message: 'Not enough credit',
        requestId: 'req_abc',
      },
    });
    expect(captured.headers[REQUEST_ID_HEADER]).toBe('req_abc');
  });

  it('logs internal context but never returns it to the client', () => {
    const { filter, logger } = createFilter();
    const { host, captured } = createHost({ id: 'req_abc' });

    filter.catch(
      new AppError(PalCertErrorCode.CHECK_FAILED, {
        internalContext: { dsn: 'postgres://user:hunter2@db' },
      }),
      host,
    );

    expect(JSON.stringify(captured.body)).not.toContain('hunter2');
    expect(logger.error).toHaveBeenCalled();
    const [payload] = (logger.error as jest.Mock).mock.calls[0] as [Record<string, unknown>];
    expect(JSON.stringify(payload)).toContain('hunter2');
  });

  it('never leaks details of an unknown error', () => {
    const { filter } = createFilter();
    const { host, captured } = createHost({ id: 'req_abc' });

    filter.catch(new Error('SELECT * FROM users WHERE secret = "abc"'), host);

    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        requestId: 'req_abc',
      },
    });
  });

  it('hides the message of a 5xx HttpException', () => {
    const { filter } = createFilter();
    const { host, captured } = createHost({ id: 'req_abc' });

    filter.catch(
      new HttpException('upstream credentials rejected', HttpStatus.INTERNAL_SERVER_ERROR),
      host,
    );

    expect(captured.status).toBe(500);
    expect(JSON.stringify(captured.body)).not.toContain('credentials');
  });

  it('converts ValidationPipe output into VALIDATION_FAILED details', () => {
    const { filter } = createFilter();
    const { host, captured } = createHost({ id: 'req_abc' });

    filter.catch(
      new BadRequestException(['email must be an email', 'name should not be empty']),
      host,
    );

    expect(captured.status).toBe(400);
    expect(captured.body).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        details: { issues: ['email must be an email', 'name should not be empty'] },
        requestId: 'req_abc',
      },
    });
  });

  it.each([
    [new NotFoundException('Missing'), 404, PalCertErrorCode.NOT_FOUND],
    [new ForbiddenException('Nope'), 403, PalCertErrorCode.FORBIDDEN],
  ])('maps %#: Nest HTTP exceptions to PalCert codes', (exception, status, code) => {
    const { filter } = createFilter();
    const { host, captured } = createHost({ id: 'req_abc' });

    filter.catch(exception, host);

    expect(captured.status).toBe(status);
    expect((captured.body as { error: { code: string } }).error.code).toBe(code);
  });

  it('falls back to the request header when no request id was generated', () => {
    const { filter } = createFilter();
    const { host, captured } = createHost({ headers: { [REQUEST_ID_HEADER]: 'from-header' } });

    filter.catch(new AppError(PalCertErrorCode.NOT_FOUND), host);

    expect((captured.body as { error: { requestId: string } }).error.requestId).toBe('from-header');
  });

  it('logs 4xx at warn level and 5xx at error level', () => {
    const { filter, logger } = createFilter();
    const { host } = createHost({ id: 'req_abc' });

    filter.catch(new AppError(PalCertErrorCode.NOT_FOUND), host);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();

    filter.catch(new AppError(PalCertErrorCode.INTERNAL_ERROR), host);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
