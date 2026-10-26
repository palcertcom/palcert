import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';
import { ReportQuery, validateReportQuery } from './report-query';
import { reportMoney } from './report-labels';
import { ReportPdfRenderer } from './report-pdf.renderer';
import {
  PersonalReportsController,
  OrganizationReportsController,
  PlatformReportsController,
} from './reports.controller';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { OrganizationPermissionsGuard } from '../organizations/guards/organization-permissions.guard';
import type { ExecutionContext } from '@nestjs/common';
import type { AccountReportView } from '@palcert/contracts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { openSync, type Font } from 'fontkit';

const query = (patch: Partial<ReportQuery> = {}) =>
  Object.assign(new ReportQuery(), {
    from: '2026-10-01T00:00:00Z',
    to: '2026-11-01T00:00:00Z',
    ...patch,
  });
describe('account reports', () => {
  it.each([
    { from: '2026-11-02T00:00:00Z' },
    { to: '2028-01-01T00:00:00Z' },
    { from: '2026-10-01' },
    { timeZone: 'Not/AZone' },
    { offset: '-1' },
    { service: 'DOCUMENT_CHECK' },
    { status: 'FAILED' },
  ])('rejects ambiguous or unsupported filters %j', (patch) => {
    expect(() => validateReportQuery(query(patch))).toThrow();
  });
  it('accepts an offset-bearing interval and validates service codes before SQL', async () => {
    expect(
      validateReportQuery(query({ from: '2026-10-01T00:00:00+03:00' })).from.toISOString(),
    ).toBe('2026-09-30T21:00:00.000Z');
    expect(
      await validate(query({ kind: 'services', service: "DOCUMENT_CHECK'; DROP TABLE users;--" })),
    ).not.toHaveLength(0);
  });
  it('formats large amounts and three/zero-decimal currencies exactly', () => {
    expect(reportMoney('9007199254740993123', 'USD')).toBe('90071992547409931.23');
    expect(reportMoney('-5005', 'JOD')).toBe('-5.005');
    expect(reportMoney('123', 'JPY')).toBe('123');
    expect(() => reportMoney('123', 'XYZ')).toThrow();
  });
  it.each([PersonalReportsController, PlatformReportsController, OrganizationReportsController])(
    'protects every format on %p',
    (controller) => {
      for (const method of ['report', 'print', 'pdf'] as const) {
        const context = {
          getClass: () => controller,
          getHandler: () => controller.prototype[method],
          switchToHttp: () => ({
            getRequest: () => ({
              principal: { permissions: new Set() },
              tenant: { permissions: new Set() },
            }),
          }),
        } as unknown as ExecutionContext;
        const guard =
          controller === OrganizationReportsController
            ? new OrganizationPermissionsGuard(new Reflector())
            : new PermissionsGuard(new Reflector());
        expect(() => guard.canActivate(context)).toThrow();
      }
    },
  );
});
function sample(locale: 'ar' | 'en'): AccountReportView {
  const ar = locale === 'ar';
  return {
    kind: 'services',
    locale,
    scope: 'organization',
    title: ar ? 'تقرير الخدمات' : 'Service report',
    subject: ar ? 'الجامعة الإسلامية بغزة' : 'Islamic University of Gaza',
    generatedAt: '2026-10-24T19:00:00.000Z',
    period: '2026-10-01 — 2026-11-01 (Asia/Hebron)',
    filters: ar ? 'الخدمة: فحص التنسيق · العملة: USD' : 'Service: Formatting check · Currency: USD',
    notes: [
      ar
        ? 'بداية الفترة مشمولة ونهايتها غير مشمولة. الخدمات مرتبطة بالمؤسسة دون عرض مستندات الأفراد الخاصة.'
        : 'Period start is inclusive; end is exclusive. Private student documents are excluded.',
    ],
    summaries: [
      {
        title: ar ? 'ملخص الفترة' : 'Summary',
        columns: ar ? ['الخدمة', 'الحالة', 'العدد'] : ['Service', 'Status', 'Count'],
        rows: [[ar ? 'فحص التنسيق' : 'Formatting check', ar ? 'مكتمل' : 'Completed', '65']],
      },
    ],
    detail: {
      title: ar ? 'التفاصيل' : 'Details',
      columns: ar
        ? [
            'التاريخ',
            'المرجع',
            'الخدمة',
            'المؤسسة',
            'حالة التنفيذ',
            'حالة الدفع',
            'العملة',
            'السعر',
            'نقدي محصّل',
            'ترويجي محصّل',
            'المسترد',
          ]
        : [
            'Date',
            'Reference',
            'Service',
            'Institution',
            'Execution',
            'Payment',
            'Currency',
            'Price',
            'Cash captured',
            'Promo captured',
            'Refunded',
          ],
      rows: Array.from({ length: 65 }, (_, i) => [
        '2026-10-24 18:30',
        `12345678-1234-4234-8234-${String(i).padStart(12, '0')}`,
        ar ? 'فحص تنسيق رسالة الماجستير' : 'Master’s thesis formatting check',
        ar ? 'الجامعة الإسلامية بغزة' : 'Islamic University of Gaza',
        ar ? 'مكتمل' : 'Completed',
        ar ? 'تم التسليم' : 'Delivered',
        'USD',
        '10.00',
        '10.00',
        '0.00',
        i === 64 ? '10.00' : '0.00',
      ]),
    },
    total: 65,
    offset: 0,
    nextOffset: null,
  };
}
describe('report PDF', () => {
  jest.setTimeout(30_000);
  it('embeds Arabic glyphs and exports every page with locally bundled fonts', async () => {
    const font = openSync(
      createRequire(__filename).resolve(
        '@expo-google-fonts/noto-sans-arabic/400Regular/NotoSansArabic_400Regular.ttf',
      ),
    );
    for (const ch of 'الجامعة الإسلامية بغزة')
      expect((font as Font).hasGlyphForCodePoint(ch.codePointAt(0)!)).toBe(true);
    const renderer = new ReportPdfRenderer();
    for (const locale of ['ar', 'en'] as const) {
      const bytes = await renderer.render(sample(locale));
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      const data = bytes.toString('latin1');
      expect((data.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(2);
      expect(data).toContain('/FontFile2');
      if (process.env.REPORT_VISUAL_QA_DIR) {
        mkdirSync(process.env.REPORT_VISUAL_QA_DIR, { recursive: true });
        writeFileSync(join(process.env.REPORT_VISUAL_QA_DIR, `report-${locale}.pdf`), bytes);
      }
    }
  });
});
