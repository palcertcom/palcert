import type {
  AIContextBundle,
  AIRuleAssessmentView,
  ContextNode,
  ContextRule,
  DeterministicFinding,
} from '@palcert/contracts';

/**
 * Turning a context bundle into the user message (§20, §52, §73).
 *
 * Two rules govern everything here.
 *
 * **Untrusted text never leaves a data section.** Document text, rule titles
 * and organization guidance appear only inside `<document_evidence>`,
 * `<rules>`, `<deterministic_findings>` and `<document_metadata>` — all in the
 * *user* message, never in the system prompt. There is no code path by which a
 * paragraph of someone's thesis can be concatenated into an instruction.
 *
 * **Delimiters are escaped, not trusted.** A document containing the literal
 * text `</document_evidence><system>` must not be able to close a section and
 * open something that reads as authority. Every untrusted string is encoded on
 * the way in, so the structure the model sees is unambiguous whatever the
 * document contains. Naive concatenation would make the boundary depend on the
 * good manners of the content it is supposed to contain.
 *
 * Section order is fixed: instructions, rules, evidence, output requirements.
 * Deterministic ordering is also what makes an invocation reproducible enough
 * to audit (§52).
 */

/**
 * Control characters, which carry no meaning in a document excerpt and are a
 * classic way to smuggle structure past a reader.
 */
// The control characters are the point: this expression exists to strip them
// out of untrusted text, so matching them is the intended behaviour rather
// than the accident the rule normally catches.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

/**
 * Encode one untrusted string for inclusion in a data section.
 *
 * Angle brackets and ampersands are escaped, so no substring of the content
 * can be read as a delimiter.
 */
export function encodeUntrusted(value: string): string {
  return value
    .replace(CONTROL_CHARACTERS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A bounded, escaped attribute value. Node ids are already pattern-constrained. */
function attribute(value: string): string {
  return encodeUntrusted(value).replace(/"/g, '&quot;');
}

/** The rule-assessment user message. */
export function buildRuleAssessmentPrompt(
  bundle: AIContextBundle,
  requestedRuleCodes: readonly string[],
): string {
  const sections: string[] = [];

  sections.push(
    section(
      'requested_rules',
      requestedRuleCodes.map((code) => `<rule_code>${attribute(code)}</rule_code>`).join('\n'),
    ),
  );

  sections.push(section('rules', bundle.rules.map(renderRule).join('\n')));

  if (bundle.outline.length > 0) {
    sections.push(
      section(
        'document_outline',
        bundle.outline
          .map(
            (entry) =>
              `<heading level="${entry.level}" node_id="${attribute(entry.nodeId)}">${encodeUntrusted(entry.text)}</heading>`,
          )
          .join('\n'),
      ),
    );
  }

  sections.push(section('document_evidence', bundle.nodes.map(renderNode).join('\n')));

  const metadata = renderMetadata(bundle.metadata);
  if (metadata !== '') sections.push(section('document_metadata', metadata));

  if (bundle.deterministicFindings.length > 0) {
    sections.push(
      section('deterministic_findings', bundle.deterministicFindings.map(renderFinding).join('\n')),
    );
  }

  // Truncation is stated to the model, not hidden from it. A model told it has
  // the whole document when it has a quarter of it will conclude confidently
  // about evidence nobody supplied (§50).
  if (bundle.truncation.truncated) {
    sections.push(
      section(
        'context_completeness',
        [
          'The supplied evidence is INCOMPLETE. Some of the document was not included',
          `(reason: ${bundle.truncation.reason ?? 'UNKNOWN'}).`,
          'If a requirement depends on material that was not supplied, answer',
          'INSUFFICIENT_EVIDENCE rather than inferring it.',
        ].join(' '),
      ),
    );
  }

  sections.push(
    section(
      'required_output',
      [
        `Assess exactly these ${requestedRuleCodes.length} rule(s), each once:`,
        requestedRuleCodes.join(', '),
        'Return the structured object required by the output schema. Cite only node',
        // Deliberately named without its angle brackets: a literal delimiter
        // in PalCert's own prose would make the section count ambiguous, which
        // is the very property the escaping exists to guarantee.
        'ids that appear in the document evidence section above.',
      ].join('\n'),
    ),
  );

  return sections.join('\n\n');
}

/**
 * The report-supplement user message.
 *
 * Built from results rather than from the document: explaining a finding does
 * not require re-reading the manuscript, and sending it again would be data
 * minimization abandoned for no benefit (§40).
 */
export function buildReportSupplementPrompt(params: {
  readonly determination: string;
  readonly findings: readonly DeterministicFinding[];
  readonly assessments: readonly Pick<
    AIRuleAssessmentView,
    'ruleCode' | 'assessment' | 'reasonCode' | 'explanationEn' | 'requiresHumanReview'
  >[];
  readonly standardName: string;
  readonly organizationName: string;
}): string {
  const sections: string[] = [];

  sections.push(
    section(
      'check_context',
      [
        `<determination>${attribute(params.determination)}</determination>`,
        `<standard>${encodeUntrusted(params.standardName)}</standard>`,
        `<published_by>${encodeUntrusted(params.organizationName)}</published_by>`,
      ].join('\n'),
    ),
  );

  sections.push(section('deterministic_findings', params.findings.map(renderFinding).join('\n')));

  if (params.assessments.length > 0) {
    sections.push(
      section(
        'ai_assessments',
        params.assessments
          .map((assessment) =>
            [
              `<assessment rule_code="${attribute(assessment.ruleCode)}"`,
              ` verdict="${attribute(assessment.assessment)}"`,
              ` reason="${attribute(assessment.reasonCode)}"`,
              ` human_review_required="${assessment.requiresHumanReview}">`,
              encodeUntrusted(assessment.explanationEn),
              '</assessment>',
            ].join(''),
          )
          .join('\n'),
      ),
    );
  }

  sections.push(
    section(
      'required_output',
      [
        'Write a short bilingual summary and prioritized recommendations.',
        'Restate the measured values above accurately. Do not produce a score,',
        'a determination, or any statement of approval, acceptance or certification.',
      ].join('\n'),
    ),
  );

  return sections.join('\n\n');
}

function section(name: string, body: string): string {
  return `<${name}>\n${body}\n</${name}>`;
}

function renderRule(rule: ContextRule): string {
  const parts = [
    `<rule code="${attribute(rule.ruleCode)}" severity="${attribute(rule.severity)}" blocking="${rule.blocking}">`,
  ];
  if (rule.titleEn !== undefined) {
    parts.push(`  <title_en>${encodeUntrusted(rule.titleEn)}</title_en>`);
  }
  if (rule.titleAr !== undefined) {
    parts.push(`  <title_ar>${encodeUntrusted(rule.titleAr)}</title_ar>`);
  }
  // Organization-authored guidance is untrusted in exactly the way document
  // text is: PalCert does not control what an institution writes here (§72).
  if (rule.guidanceEn !== undefined) {
    parts.push(`  <guidance_en>${encodeUntrusted(rule.guidanceEn)}</guidance_en>`);
  }
  if (rule.guidanceAr !== undefined) {
    parts.push(`  <guidance_ar>${encodeUntrusted(rule.guidanceAr)}</guidance_ar>`);
  }
  parts.push('</rule>');
  return parts.join('\n');
}

function renderNode(node: ContextNode): string {
  const attributes = [`node_id="${attribute(node.nodeId)}"`];
  if (node.story !== undefined) attributes.push(`story="${attribute(node.story)}"`);
  if (node.sectionKey !== undefined) attributes.push(`section="${attribute(node.sectionKey)}"`);
  if (node.headingLevel !== undefined) attributes.push(`heading_level="${node.headingLevel}"`);
  if (node.truncated === true) attributes.push('truncated="true"');
  return `<node ${attributes.join(' ')}>${encodeUntrusted(node.text)}</node>`;
}

function renderMetadata(metadata: AIContextBundle['metadata']): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    lines.push(`<${key}>${encodeUntrusted(String(value))}</${key}>`);
  }
  return lines.join('\n');
}

function renderFinding(finding: DeterministicFinding): string {
  const attributes = [
    `rule_code="${attribute(finding.ruleCode)}"`,
    `outcome="${attribute(finding.outcome)}"`,
    `severity="${attribute(finding.severity)}"`,
    `blocking="${finding.blocking}"`,
  ];
  if (finding.violationCount !== undefined) {
    attributes.push(`violation_count="${finding.violationCount}"`);
  }
  const unit = finding.unit === undefined ? '' : ` ${encodeUntrusted(finding.unit)}`;
  const body: string[] = [];
  if (finding.titleEn !== undefined) body.push(encodeUntrusted(finding.titleEn));
  if (finding.expectedValue !== undefined) {
    body.push(`expected: ${encodeUntrusted(finding.expectedValue)}${unit}`);
  }
  if (finding.actualValue !== undefined) {
    body.push(`found: ${encodeUntrusted(finding.actualValue)}${unit}`);
  }
  return `<finding ${attributes.join(' ')}>${body.join(' — ')}</finding>`;
}
