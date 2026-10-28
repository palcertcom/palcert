import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AccountReportView, ReportTable } from '@palcert/contracts';
import { reportLabels } from './report-labels';

const load = (name: string) => readFileSync(createRequire(__filename).resolve(name));
const fonts = {
  latin: load('@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff'),
  'latin-bold': load('@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff'),
  arabic: load('@expo-google-fonts/noto-sans-arabic/400Regular/NotoSansArabic_400Regular.ttf'),
  'arabic-bold': load('@expo-google-fonts/noto-sans-arabic/700Bold/NotoSansArabic_700Bold.ttf'),
};
const arabic = (text: string) => /[\u0600-\u06ff\u0750-\u077f]/u.test(text);

@Injectable()
export class ReportPdfRenderer {
  async render(report: AccountReportView): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 28,
      bufferPages: true,
      info: {
        Title: `${report.title} — ${report.subject}`,
        Author: 'PalCert',
        CreationDate: new Date(report.generatedAt),
        ModDate: new Date(report.generatedAt),
      },
    });
    for (const [name, bytes] of Object.entries(fonts)) doc.registerFont(name, bytes);
    const chunks: Buffer[] = [];
    const completed = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });
    const margin = 28;
    const width = doc.page.width - margin * 2;
    const bottom = doc.page.height - 42;
    let y = margin;
    const rtl = report.locale === 'ar';
    const l = reportLabels[report.locale];
    const lineHeight = 18;
    function font(text: string, bold = false) {
      doc.font(`${arabic(text) ? 'arabic' : 'latin'}${bold ? '-bold' : ''}`).fontSize(8);
    }
    // PDFKit's word layout is LTR. A complete NBSP-separated logical line lets
    // Fontkit shape the RTL run correctly. Never reverse Arabic code points.
    function shaped(text: string) {
      return arabic(text) ? text.replace(/ /g, '\u00a0') : text;
    }
    // Isolate Latin/numeric runs so the Arabic shaper cannot reverse a date,
    // currency code, reference or amount embedded in an Arabic heading.
    function runs(text: string): string[] {
      return text.split(/([A-Za-z0-9][A-Za-z0-9.,:/_+()\- ]*)/u).filter(Boolean);
    }
    function measure(text: string, bold = false): number {
      return runs(text).reduce((total, run) => {
        font(run, bold);
        return total + doc.widthOfString(shaped(run));
      }, 0);
    }
    function wrap(text: string, available: number, bold = false): string[] {
      const clean = Array.from(text)
        .map((character) => {
          const code = character.codePointAt(0)!;
          return code < 32 ||
            code === 127 ||
            code === 0x200e ||
            code === 0x200f ||
            (code >= 0x202a && code <= 0x202e) ||
            (code >= 0x2066 && code <= 0x2069)
            ? ' '
            : character;
        })
        .join('')
        .trim();
      const lines: string[] = [];
      let pending = '';
      for (const word of clean.split(/\s+/u)) {
        const candidate = pending ? `${pending} ${word}` : word;
        if (measure(candidate, bold) <= available) {
          pending = candidate;
          continue;
        }
        if (pending) {
          lines.push(pending);
          pending = '';
        }
        for (const character of word) {
          if (pending && measure(pending + character, bold) > available) {
            lines.push(pending);
            pending = '';
          }
          pending += character;
        }
      }
      if (pending) lines.push(pending);
      return lines.length ? lines : [''];
    }
    function line(text: string, x: number, at: number, available: number, bold = false) {
      const rightToLeft = arabic(text);
      let cursor = rightToLeft ? x + available : x;
      for (const run of runs(text)) {
        font(run, bold);
        const value = shaped(run);
        const runWidth = doc.widthOfString(value);
        if (rightToLeft) cursor -= runWidth;
        doc.text(value, cursor, at + 11, { lineBreak: false, baseline: 'alphabetic' });
        if (!rightToLeft) cursor += runWidth;
      }
    }
    function newPage() {
      doc.addPage();
      y = margin;
    }
    function paragraph(text: string, bold = false) {
      for (const textLine of wrap(text, width, bold)) {
        if (y + lineHeight > bottom) newPage();
        line(textLine, margin, y, width, bold);
        y += lineHeight;
      }
      y += 5;
    }
    paragraph(`PalCert · ${report.title}`, true);
    paragraph(report.subject, true);
    paragraph(report.period);
    paragraph(report.filters);
    paragraph(`${l.generated}: ${report.generatedAt} · ${l.total}: ${report.total}`);
    for (const note of report.notes) paragraph(note);
    function table(table: ReportTable) {
      if (y + 85 > bottom) newPage();
      paragraph(table.title, true);
      const count = table.columns.length;
      const weights =
        count === 11
          ? [1.1, 1.5, 1.2, 1.5, 1.1, 1.1, 0.7, 0.8, 0.8, 0.8, 0.8]
          : table.columns.map((_, i) => (count === 6 && i === 1 ? 1.7 : 1));
      const sum = weights.reduce((a, b) => a + b, 0);
      const widths = weights.map((w) => (width * w) / sum);
      function row(values: readonly string[], header = false) {
        const lines = values.map((v, i) => wrap(v, widths[i]! - 10, header));
        const height = Math.max(...lines.map((a) => a.length)) * lineHeight + 10;
        if (!header && y + height > bottom) {
          newPage();
          row(table.columns, true);
        }
        let x = rtl ? margin + width : margin;
        values.forEach((_, i) => {
          const w = widths[i]!;
          if (rtl) x -= w;
          doc
            .save()
            .rect(x, y, w, height)
            .fillAndStroke(header ? '#e7edf5' : '#ffffff', '#cdd5df')
            .restore();
          doc.fillColor('#172234');
          lines[i]!.forEach((textLine, j) =>
            line(textLine, x + 5, y + 4 + j * lineHeight, w - 10, header),
          );
          if (!rtl) x += w;
        });
        y += height;
      }
      row(table.columns, true);
      for (const values of table.rows) row(values);
      if (!table.rows.length) paragraph(l.empty);
      y += 14;
    }
    for (const summary of report.summaries) table(summary);
    table(report.detail);
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      line(`${l.page} ${i + 1} / ${pages.count}`, margin, doc.page.height - 30, width);
    }
    doc.end();
    return completed;
  }
}
