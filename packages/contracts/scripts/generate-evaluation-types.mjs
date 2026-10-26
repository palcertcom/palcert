#!/usr/bin/env node
/**
 * Generate TypeScript types from the authoritative JSON Schema.
 *
 * The schema in `contracts/schemas/` is the single source of truth for every
 * contract the TypeScript API and the Python engine both touch. Hand-writing
 * the TypeScript alongside it would guarantee the two drift; generating it
 * means a schema change that nobody mirrored shows up as a diff.
 *
 *   pnpm --filter @palcert/contracts run generate:evaluation
 *
 * CI runs this and fails if the committed output differs (`--check`).
 */
import { compileFromFile } from 'json-schema-to-typescript';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Every shared schema is generated the same way.
 *
 * Phase 6 defined the analysis artifact only in Python, which left Node
 * parsing whatever dictionaries arrived — exactly the drift this step exists
 * to prevent. Phase 7 brings it, and the check report, under the same roof.
 */
const SCHEMAS = [
  {
    schema: 'evaluation.schema.json',
    types: '../src/evaluation/generated.ts',
    constant: '../src/evaluation/schema.generated.ts',
    constantName: 'EVALUATION_JSON_SCHEMA',
    label: 'evaluation',
  },
  {
    schema: 'analysis-artifact.schema.json',
    types: '../src/analysis/generated.ts',
    constant: '../src/analysis/schema.generated.ts',
    constantName: 'ANALYSIS_ARTIFACT_JSON_SCHEMA',
    label: 'analysis artifact',
  },
  {
    schema: 'ai-context.schema.json',
    types: '../src/ai/context.generated.ts',
    constant: '../src/ai/context-schema.generated.ts',
    constantName: 'AI_CONTEXT_JSON_SCHEMA',
    label: 'AI context',
  },
  {
    schema: 'ai-assessment.schema.json',
    types: '../src/ai/assessment.generated.ts',
    constant: '../src/ai/assessment-schema.generated.ts',
    constantName: 'AI_ASSESSMENT_JSON_SCHEMA',
    label: 'AI assessment',
  },
  {
    schema: 'rule-proposal.schema.json',
    types: '../src/extraction/proposal.generated.ts',
    constant: '../src/extraction/proposal-schema.generated.ts',
    constantName: 'RULE_PROPOSAL_JSON_SCHEMA',
    label: 'rule proposal',
  },
  {
    schema: 'check-report.schema.json',
    types: '../src/checks/report.generated.ts',
    constant: '../src/checks/report-schema.generated.ts',
    constantName: 'CHECK_REPORT_JSON_SCHEMA',
    label: 'check report',
  },
  {
    schema: 'smartfix.schema.json',
    types: '../src/smartfix/generated.ts',
    constant: '../src/smartfix/schema.generated.ts',
    constantName: 'SMARTFIX_JSON_SCHEMA',
    label: 'SmartFix',
  },
];

/**
 * Shared data files that are not schemas.
 *
 * The SmartFix capability registry is a *table*, not a shape: it says which
 * document properties PalCert is able to change. Both runtimes have to agree
 * on it exactly — a registry that says "SmartFix can change this" on one side
 * and "it cannot" on the other means the user approved a plan the engine will
 * not honour, or one it will exceed. So it lives in `contracts/registries/`,
 * Python reads that file directly, and the TypeScript copy is generated here.
 */
const REGISTRIES = [
  {
    source: 'registries/smartfix-capabilities.json',
    constant: '../src/smartfix/registry.generated.ts',
    constantName: 'SMARTFIX_CAPABILITY_REGISTRY',
    label: 'SmartFix capability registry',
  },
  {
    source: 'registries/document-property-support.json',
    constant: '../src/analysis/property-support.generated.ts',
    constantName: 'DOCUMENT_PROPERTY_SUPPORT_REGISTRY',
    label: 'document property support registry',
  },
  {
    source: 'registries/citation-projection.json',
    constant: '../src/analysis/citation-projection.generated.ts',
    constantName: 'CITATION_PROJECTION_REGISTRY',
    label: 'citation projection registry',
  },
];

const notice = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: contracts/schemas/evaluation.schema.json
 * Regenerate: pnpm --filter @palcert/contracts run generate:evaluation
 *
 * Editing this by hand would reintroduce exactly the drift the generation step
 * exists to prevent.
 */
`;

// The generated *types* need the blanket disable (json-schema-to-typescript
// emits shapes the lint rules object to); the schema constant is plain data
// and lints clean, and an unused directive is itself a lint warning.
const banner = `/* eslint-disable */\n${notice}`;

async function buildArtefacts() {
  const artefacts = [];
  for (const entry of SCHEMAS) {
    const schemaPath = resolve(here, '../../../contracts/schemas', entry.schema);
    const typesPath = resolve(here, entry.types);
    const constantPath = resolve(here, entry.constant);

    const compiled = await compileFromFile(schemaPath, {
      additionalProperties: false,
      bannerComment: '',
      declareExternallyReferenced: true,
      style: { singleQuote: true, printWidth: 100 },
      unreachableDefinitions: true,
    });

    /*
     * The schema is also emitted as a TypeScript constant.
     *
     * The package compiles to CommonJS and is consumed from a bundler, so
     * resolving a JSON file by path at runtime is unreliable. Embedding it
     * keeps the JSON file the single source of truth — Python reads that same
     * file — while giving the TypeScript validator something it can always
     * load. The drift check below covers the copy.
     */
    const schemaJson = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const constantSource = `${notice}
/** The ${entry.label} JSON Schema, embedded verbatim from the source of truth. */
export const ${entry.constantName} = ${JSON.stringify(schemaJson, null, 2)} as const;
`;

    artefacts.push(
      {
        path: typesPath,
        // Re-formatted with the repository's own Prettier configuration rather
        // than trusted as emitted: json-schema-to-typescript formats with its
        // own options, and the two agree only until a schema produces
        // something they disagree about — a bounded array becomes a union of
        // tuples, and suddenly the committed output fails `prettier --check`
        // for a reason no human introduced.
        content: await formatted(
          typesPath,
          `${banner.replace('contracts/schemas/evaluation.schema.json', `contracts/schemas/${entry.schema}`)}${compiled}`,
        ),
        label: `${entry.label} types`,
        schema: entry.schema,
      },
      {
        path: constantPath,
        content: await formatted(constantPath, constantSource),
        label: `${entry.label} schema constant`,
        schema: entry.schema,
      },
    );
  }

  for (const entry of REGISTRIES) {
    const sourcePath = resolve(here, '../../../contracts', entry.source);
    const constantPath = resolve(here, entry.constant);
    const data = JSON.parse(readFileSync(sourcePath, 'utf8'));
    const source = `${notice.replace('contracts/schemas/evaluation.schema.json', `contracts/${entry.source}`)}
/** The ${entry.label}, embedded verbatim from the source of truth. */
export const ${entry.constantName} = ${JSON.stringify(data, null, 2)} as const;
`;
    artefacts.push({
      path: constantPath,
      content: await formatted(constantPath, source),
      label: entry.label,
      schema: entry.source,
    });
  }

  return artefacts;
}

/**
 * Format with the repository's own Prettier configuration.
 *
 * The committed output has to satisfy `prettier --check` like every other
 * file, and formatting here rather than in a separate step means the drift
 * check compares like with like.
 */
async function formatted(path, content) {
  const options = (await prettier.resolveConfig(path)) ?? {};
  return prettier.format(content, { ...options, filepath: path });
}

const artefacts = await buildArtefacts();

if (process.argv.includes('--check')) {
  let stale = false;
  for (const artefact of artefacts) {
    const existing = existsSync(artefact.path) ? readFileSync(artefact.path, 'utf8') : '';
    if (existing !== artefact.content) {
      console.error(`Generated ${artefact.label} is out of date (${artefact.schema}).`);
      stale = true;
    }
  }
  if (stale) {
    console.error(
      'A shared schema changed without regenerating.\n' +
        'Run: pnpm --filter @palcert/contracts run generate:evaluation',
    );
    process.exit(1);
  }
  process.stdout.write('Generated shared contracts are up to date.\n');
} else {
  for (const artefact of artefacts) {
    mkdirSync(dirname(artefact.path), { recursive: true });
    writeFileSync(artefact.path, artefact.content);
    process.stdout.write(`Wrote ${artefact.path}\n`);
  }
}
