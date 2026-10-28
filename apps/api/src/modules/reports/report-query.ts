import { IsIn, IsISO8601, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { AppError, PalCertErrorCode, REVENUE_SERVICE_CODES } from '@palcert/contracts';

export class ReportQuery {
  @IsIn(['financial', 'services']) kind: 'financial' | 'services' = 'financial';
  @IsISO8601({ strict: true }) from!: string;
  @IsISO8601({ strict: true }) to!: string;
  @IsOptional() @IsIn(['ar', 'en']) locale: 'ar' | 'en' = 'ar';
  @IsOptional() @IsString() @MaxLength(80) timeZone = 'UTC';
  @IsOptional() @IsString() @Matches(/^[A-Z]{3}$/) currency?: string;
  @IsOptional() @IsIn(REVENUE_SERVICE_CODES) service?: string;
  @IsOptional() @IsString() @Matches(/^[A-Z_]{1,40}$/) status?: string;
  @IsOptional() @IsString() @Matches(/^\d{1,7}$/) offset?: string;
}
export const REPORT_PAGE_SIZE = 50;
export const REPORT_EXPORT_LIMIT = 5000;
export function validateReportQuery(query: ReportQuery) {
  const from = new Date(query.from);
  const to = new Date(query.to);
  const offset = Number(query.offset ?? 0);
  let validZone = true;
  try {
    new Intl.DateTimeFormat('en', { timeZone: query.timeZone }).format(from);
  } catch {
    validZone = false;
  }
  if (
    ![query.from, query.to].every((value) => /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) ||
    !validZone ||
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from >= to ||
    to.getTime() - from.getTime() > 366 * 86400000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000000 ||
    (query.kind === 'financial' && (query.service || query.status))
  ) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message:
        'Choose a valid period of up to 366 days and a valid time zone. Service/status filters apply only to service reports.',
      details: { reportReason: 'INVALID_FILTERS' },
    });
  }
  return { from, to, offset };
}
