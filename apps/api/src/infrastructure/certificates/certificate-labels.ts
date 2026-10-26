import type { CertificateLabels } from './certificate-renderer.port';

/**
 * What the certificate says, in both languages (§38, §39, §114).
 *
 * The wording is the most carefully constrained part of the whole phase,
 * because a certificate is read by people who were not party to any of it and
 * who will take its sentences at face value.
 *
 * It says what PalCert and the institution each did, and stops. It never says
 * PalCert approved a thesis, awarded a degree, accepted research, or judged
 * scientific merit — and it does not claim the institution signed anything,
 * because in Phase 15 no institution signs anything.
 *
 * The Arabic keeps the two authorities in separate words. `نتيجة الامتثال
 * التقني` is PalCert's technical compliance result; `قرار المؤسسة` is the
 * institution's decision. Collapsing both into one generic "approval" would
 * erase in translation the distinction the whole architecture exists to keep.
 */
export const CERTIFICATE_LABELS: CertificateLabels = {
  title: 'PalCert Technical Compliance Certificate',
  titleAr: 'شهادة الامتثال التقني من بالسيرت',

  statement:
    'PalCert confirms that the referenced official submission achieved the PalCert technical ' +
    'compliance determination “Compliant” and that the receiving organization recorded the ' +
    'institution decision “Approved.”',
  statementAr:
    'يؤكد بالسيرت أن التقديم الرسمي المشار إليه حقق نتيجة الامتثال التقني: مطابق، ' +
    'وأن الجهة المستلمة سجّلت قرار المؤسسة: مقبول.',

  disclaimer:
    'PalCert technical compliance is a measurement against a published standard. It is not an ' +
    'assessment of scientific merit, novelty, research validity or peer-review quality. The ' +
    'institution decision is recorded separately and remains the institution’s own.',
  disclaimerAr:
    'الامتثال التقني من بالسيرت قياس وفق معيار منشور، وليس تقييمًا للجدارة العلمية أو الأصالة أو ' +
    'صحة البحث أو جودة مراجعة الأقران. ويُسجَّل قرار المؤسسة على حدة ويبقى قرارها وحدها.',

  fields: {
    technicalResult: 'PalCert Technical Result',
    institutionDecision: 'Institution Decision',
    organization: 'Organization',
    documentType: 'Document type',
    documentFormat: 'Format',
    standard: 'Standard',
    standardVersion: 'Standard version',
    issued: 'Issued',
    validity: 'Valid until',
    documentHash: 'Document SHA-256',
    reportHash: 'Report hash',
    standardHash: 'Standard content hash',
    evidenceHash: 'Submission evidence hash',
    claimHash: 'Certificate claim hash',
    verify: 'Verify this certificate at',
  },
};
