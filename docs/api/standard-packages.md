# Portable standard packages (`PALCERT_STANDARD` v1)

A package moves one standard version's **content** between PalCert
organizations. It is imported as a new **draft**; see
[ADR-0144](../adr/0144-portable-standard-packages.md).

## Endpoints

| Method | Path | Permission | |
|---|---|---|---|
| `GET` | `/organizations/{org}/standards/{standardId}/versions/{versionId}/export` | `standard:definition:read` | Download `<CODE>-<LABEL>.palcert.json` (`application/json`, attachment). Any status. |
| `POST` | `/organizations/{org}/standards/import/preview` | `standard:definition:read`, `standard:version:create`, `standard:rule:write` | `{ "package": "<file text>" }`. Side-effect free. |
| `POST` | `/organizations/{org}/standards/import` | as preview; `standard:definition:create` too for `NEW_STANDARD` | `{ package, packageHash, mode, versionLabel, … }`. Creates a DRAFT. |

Limits: 5 MB of package text, 5 000 rules, nesting depth 12. `__proto__`,
`constructor` and `prototype` are refused anywhere in the file.

## Interface

```ts
interface PortableStandardPackage {
  format: 'PALCERT_STANDARD';
  formatVersion: 1;
  exportedAt: string;              // ISO-8601; excluded from the hash
  contentHash: string;             // sha256:<64 hex>; excluded from the hash
  source: {
    organizationName: string;      // provenance a person reads, never resolved
    standardCode: string;
    standardNameEn: string;
    standardNameAr: string;
    versionLabel: string;
    versionStatus: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED' | 'ARCHIVED'; // informational
  };
  schema: { ruleSchemaVersion: number; canonicalizationVersion: number };
  standard: {
    code: string; nameEn: string; nameAr: string;
    descriptionEn: string | null; descriptionAr: string | null;
  };
  documentType: { systemCategory: DocumentSystemCategory; name: string };
  version: { versionLabel: string; effectiveFrom: string | null; effectiveUntil: string | null };
  rules: RuleDefinition[];         // the rule API's own fields; every field present, nulls as null
  signatures?: { algorithm: string; keyId: string; value: string }[]; // reserved, never interpreted in v1
}
```

`RuleDefinition` is exactly: `ruleCode, category, evaluationMode, scope,
operator, expected, unit, tolerance, severity, blocking, autofix, origin,
originReference, titleEn, titleAr, descriptionEn, descriptionAr, guidanceEn,
guidanceAr, displayOrder`.

## Hash

`contentHash = "sha256:" + hex(SHA-256(canonical(content)))`, where `content`
is the package without `exportedAt`, `contentHash` and `signatures`, with
`rules` ordered by `ruleCode`, and `canonical` is PalCert's standard
canonical JSON (keys sorted by code point, NFC strings, null-valued keys
omitted, no whitespace). Reordering rules or reformatting the file does not
change the hash; changing any value does. The hash proves the file was not
changed after export, not who exported it.

## Errors

| Code | Status | When |
|---|---|---|
| `STANDARD_IMPORT_PACKAGE_INVALID` | 422 | Not JSON, wrong format, wrong shape, forbidden key, invalid metadata. `details.reason` / `details.path`. |
| `STANDARD_IMPORT_PACKAGE_TOO_LARGE` | 413 | Over 5 MB. |
| `STANDARD_IMPORT_INTEGRITY_FAILED` | 422 | Contents do not hash to `contentHash`. |
| `STANDARD_IMPORT_UNSUPPORTED` | 422 | Newer format, rule schema or canonicalization. |
| `STANDARD_IMPORT_RULES_INVALID` | 422 | Any rule fails validation. Nothing is imported. |
| `STANDARD_IMPORT_PACKAGE_CHANGED` | 409 | `packageHash` is not the package sent. |
| `STANDARD_IMPORT_DUPLICATE` | 409 | Imported here before; resend with `acknowledgeDuplicate: true`. |
| `STANDARD_IMPORT_INCOMPATIBLE` | 409 | Target standard or document type is another category. |
| `STANDARD_CODE_TAKEN` / `STANDARD_VERSION_LABEL_TAKEN` | 409 | Never overwritten. |
