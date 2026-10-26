'use client';

import { useMemo, useState, type FormEvent } from 'react';
import type { StandardsMessages } from '@/i18n/standards-messages';
import type { RuleResponse, RuleSchemaResponse } from '@/lib/api-client';

/**
 * The rule builder.
 *
 * Three properties this form is built around:
 *
 *  1. **No raw JSON.** Authors never type a `scope` or `expected` object. The
 *     form composes them from typed controls, so a rule is data by
 *     construction and there is no path by which an expression could be
 *     entered.
 *  2. **Conditional fields.** Which controls appear is derived from the
 *     server's own schema descriptor — the operator/value compatibility matrix
 *     — so the form can only ever offer combinations the API accepts. A
 *     hand-copied list here would drift the first time an operator is added.
 *  3. **Errors beside the field.** The API returns each problem with a dotted
 *     `path`; those are indexed and rendered next to the control that caused
 *     them, rather than as one opaque banner at the top.
 */

export interface RuleDraft {
  ruleCode: string;
  category: string;
  evaluationMode: string;
  scopeKind: string;
  sectionKey: string;
  elementType: string;
  headingLevel: string;
  metadataField: string;
  pages: string;
  property: string;
  operator: string;
  valueType: string;
  numberValue: string;
  textValue: string;
  booleanValue: string;
  minValue: string;
  maxValue: string;
  listValues: string;
  patternName: string;
  patternArgument: string;
  unit: string;
  tolerance: string;
  severity: string;
  blocking: boolean;
  autofix: string;
  origin: string;
  originReference: string;
  titleEn: string;
  titleAr: string;
  descriptionEn: string;
  descriptionAr: string;
  guidanceEn: string;
  guidanceAr: string;
}

export function emptyRuleDraft(schema: RuleSchemaResponse): RuleDraft {
  return {
    ruleCode: '',
    category: schema.categories[0] ?? 'MARGINS',
    evaluationMode: 'DETERMINISTIC',
    scopeKind: 'DOCUMENT',
    sectionKey: '',
    elementType: schema.elementTypes[0] ?? 'HEADING',
    headingLevel: '',
    metadataField: '',
    pages: 'ALL',
    property: '',
    operator: 'EQUALS',
    valueType: 'NUMBER',
    numberValue: '',
    textValue: '',
    booleanValue: 'true',
    minValue: '',
    maxValue: '',
    listValues: '',
    patternName: schema.patterns[0]?.name ?? 'DOI',
    patternArgument: '',
    unit: 'COUNT',
    tolerance: '',
    severity: 'MAJOR',
    blocking: false,
    autofix: 'NONE',
    origin: 'ORGANIZATION_POLICY',
    originReference: '',
    titleEn: '',
    titleAr: '',
    descriptionEn: '',
    descriptionAr: '',
    guidanceEn: '',
    guidanceAr: '',
  };
}

/** Turn a stored rule back into the form's flat draft shape. */
export function draftFromRule(rule: RuleResponse, schema: RuleSchemaResponse): RuleDraft {
  const scope = rule.scope as Record<string, unknown>;
  const expected = rule.expected as Record<string, unknown>;
  const base = emptyRuleDraft(schema);

  return {
    ...base,
    ruleCode: rule.ruleCode,
    category: rule.category,
    evaluationMode: rule.evaluationMode,
    scopeKind: String(scope.kind ?? 'DOCUMENT'),
    sectionKey: String(scope.sectionKey ?? ''),
    elementType: String(scope.elementType ?? base.elementType),
    headingLevel: scope.level === undefined ? '' : String(scope.level),
    metadataField: String(scope.field ?? ''),
    pages: String(scope.pages ?? 'ALL'),
    property: String(scope.property ?? ''),
    operator: rule.operator,
    valueType: String(expected.type ?? 'NUMBER'),
    numberValue: expected.number === undefined ? '' : String(expected.number),
    textValue: String(expected.text ?? ''),
    booleanValue: expected.boolean === true ? 'true' : 'false',
    minValue: expected.min === undefined ? '' : String(expected.min),
    maxValue: expected.max === undefined ? '' : String(expected.max),
    listValues: Array.isArray(expected.values) ? (expected.values as unknown[]).join('\n') : '',
    patternName: String(expected.pattern ?? base.patternName),
    patternArgument: String(expected.argument ?? ''),
    unit: rule.unit ?? '',
    tolerance: rule.tolerance === null ? '' : String(rule.tolerance),
    severity: rule.severity,
    blocking: rule.blocking,
    autofix: rule.autofix,
    origin: rule.origin,
    originReference: rule.originReference ?? '',
    titleEn: rule.titleEn,
    titleAr: rule.titleAr,
    descriptionEn: rule.descriptionEn ?? '',
    descriptionAr: rule.descriptionAr ?? '',
    guidanceEn: rule.guidanceEn ?? '',
    guidanceAr: rule.guidanceAr ?? '',
  };
}

/**
 * Compose the wire payload from the draft.
 *
 * Only the fields the chosen scope and value type actually use are emitted, so
 * a leftover value from a control the author switched away from can never be
 * sent. `forbidNonWhitelisted` on the API would reject it anyway; not sending
 * it is what keeps the two in agreement.
 */
export function ruleDraftToPayload(draft: RuleDraft): Record<string, unknown> {
  const scope: Record<string, unknown> = { kind: draft.scopeKind };
  switch (draft.scopeKind) {
    case 'SECTION':
      scope.sectionKey = draft.sectionKey;
      scope.property = draft.property;
      break;
    case 'ELEMENT':
      scope.elementType = draft.elementType;
      if (draft.elementType === 'HEADING' && draft.headingLevel !== '') {
        scope.level = Number.parseInt(draft.headingLevel, 10);
      }
      scope.property = draft.property;
      break;
    case 'METADATA':
      scope.field = draft.metadataField;
      break;
    case 'PAGE':
      scope.pages = draft.pages;
      scope.property = draft.property;
      break;
    default:
      scope.property = draft.property;
  }

  let expected: Record<string, unknown>;
  switch (draft.valueType) {
    case 'STRING':
      expected = { type: 'STRING', text: draft.textValue };
      break;
    case 'BOOLEAN':
      expected = { type: 'BOOLEAN', boolean: draft.booleanValue === 'true' };
      break;
    case 'NUMBER_RANGE':
      expected = {
        type: 'NUMBER_RANGE',
        min: toNumber(draft.minValue),
        max: toNumber(draft.maxValue),
      };
      break;
    case 'STRING_LIST':
      expected = { type: 'STRING_LIST', values: splitLines(draft.listValues) };
      break;
    case 'NUMBER_LIST':
      expected = { type: 'NUMBER_LIST', values: splitLines(draft.listValues).map(toNumber) };
      break;
    case 'PATTERN':
      expected = {
        type: 'PATTERN',
        pattern: draft.patternName,
        ...(draft.patternArgument === '' ? {} : { argument: draft.patternArgument }),
      };
      break;
    case 'NONE':
      expected = { type: 'NONE' };
      break;
    default:
      expected = { type: 'NUMBER', number: toNumber(draft.numberValue) };
  }

  const numeric = ['NUMBER', 'NUMBER_RANGE', 'NUMBER_LIST'].includes(draft.valueType);

  return {
    ruleCode: draft.ruleCode,
    category: draft.category,
    evaluationMode: draft.evaluationMode,
    scope,
    operator: draft.operator,
    expected,
    ...(numeric && draft.unit !== '' ? { unit: draft.unit } : {}),
    ...(draft.tolerance === '' ? {} : { tolerance: toNumber(draft.tolerance) }),
    severity: draft.severity,
    blocking: draft.blocking,
    autofix: draft.autofix,
    origin: draft.origin,
    ...(draft.originReference === '' ? {} : { originReference: draft.originReference }),
    titleEn: draft.titleEn,
    titleAr: draft.titleAr,
    ...(draft.descriptionEn === '' ? {} : { descriptionEn: draft.descriptionEn }),
    ...(draft.descriptionAr === '' ? {} : { descriptionAr: draft.descriptionAr }),
    ...(draft.guidanceEn === '' ? {} : { guidanceEn: draft.guidanceEn }),
    ...(draft.guidanceAr === '' ? {} : { guidanceAr: draft.guidanceAr }),
  };
}

function toNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

export function RuleBuilder({
  schema,
  messages,
  initial,
  issues,
  submitting,
  ruleSchemaVersion,
  onSubmit,
  onCancel,
}: {
  schema: RuleSchemaResponse;
  messages: StandardsMessages;
  initial: RuleDraft;
  issues: readonly FieldIssue[];
  submitting: boolean;
  /**
   * The schema version of the draft being edited, which is not necessarily the
   * one this release writes: a draft cloned from a version 1 standard is still
   * judged by version 1's invariants, and the form has to offer exactly what
   * that version allows.
   */
  ruleSchemaVersion: number;
  onSubmit: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(initial);

  /**
   * Whether a rule may block certification in any evaluation mode.
   *
   * From version 2 on it may: a journal can legitimately require an ethics
   * statement or blind-review anonymization before it will certify, and
   * judging those needs a model or a person. The safety property did not go
   * away — it moved to evaluation, where a non-deterministic blocking rule
   * yields INDETERMINATE and holds the compliance decision open until someone
   * resolves it.
   */
  const blockingAllowedInAnyMode = ruleSchemaVersion >= schema.blockingAnyModeFromSchemaVersion;

  const operator = useMemo(
    () => schema.operators.find((entry) => entry.operator === draft.operator),
    [draft.operator, schema.operators],
  );

  /**
   * Value types the chosen operator accepts.
   *
   * Straight from the server's matrix, so an operator added on the server
   * appears here with the right operand choices and no frontend change.
   */
  const allowedValueTypes = operator?.valueTypes ?? [];
  const unary = operator?.unary === true;
  const numeric = ['NUMBER', 'NUMBER_RANGE', 'NUMBER_LIST'].includes(draft.valueType);
  const toleranceAllowed = operator?.supportsTolerance === true && numeric;
  const patternNeedsArgument =
    schema.patterns.find((entry) => entry.name === draft.patternName)?.requiresArgument === true;

  // Index the issues by path so each control can render its own.
  const issuesByPath = useMemo(() => {
    const index = new Map<string, string[]>();
    for (const issue of issues) {
      index.set(issue.path, [...(index.get(issue.path) ?? []), issue.message]);
    }
    return index;
  }, [issues]);

  function set<K extends keyof RuleDraft>(key: K, value: RuleDraft[K]): void {
    setDraft((current) => {
      const next = { ...current, [key]: value };

      // Changing the operator can strand an operand shape it does not accept.
      // Snapping to the first accepted type keeps the form in a state the API
      // would accept, rather than showing an error the author did not cause.
      if (key === 'operator') {
        const entry = schema.operators.find((row) => row.operator === value);
        if (entry !== undefined && !entry.valueTypes.includes(next.valueType)) {
          next.valueType = entry.valueTypes[0] ?? 'NUMBER';
        }
      }

      // Under version 1 a blocking rule must be deterministic. Moving off that
      // mode with the box still ticked would leave a form that cannot be saved
      // and whose offending control is disabled, so the flag is cleared with
      // the change that invalidated it.
      if (
        key === 'evaluationMode' &&
        !blockingAllowedInAnyMode &&
        next.evaluationMode !== 'DETERMINISTIC'
      ) {
        next.blocking = false;
      }
      return next;
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit(ruleDraftToPayload(draft));
  }

  return (
    <form className="pc-form pc-rule-builder" onSubmit={handleSubmit} noValidate>
      <fieldset>
        <legend>{messages.editRule}</legend>

        <Field
          label={messages.ruleCode}
          name="ruleCode"
          issues={issuesByPath}
          hint={messages.ruleCodeHint}
        >
          {(control) => (
            <input
              {...control}
              name="ruleCode"
              value={draft.ruleCode}
              onChange={(event) => set('ruleCode', event.target.value.toUpperCase())}
              required
            />
          )}
        </Field>

        <Field label={messages.category} name="category" issues={issuesByPath}>
          {(control) => (
            <select
              {...control}
              value={draft.category}
              onChange={(event) => set('category', event.target.value)}
            >
              {schema.categories.map((value) => (
                <option key={value} value={value}>
                  {messages.categories[value] ?? value}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label={messages.evaluationMode} name="evaluationMode" issues={issuesByPath}>
          {(control) => (
            <select
              {...control}
              value={draft.evaluationMode}
              onChange={(event) => set('evaluationMode', event.target.value)}
            >
              {schema.evaluationModes.map((value) => (
                <option key={value} value={value}>
                  {messages.evaluationModes[value] ?? value}
                </option>
              ))}
            </select>
          )}
        </Field>
      </fieldset>

      <fieldset>
        <legend>{messages.scopeKind}</legend>

        <Field label={messages.scopeKind} name="scope.kind" issues={issuesByPath}>
          {(control) => (
            <select
              {...control}
              value={draft.scopeKind}
              onChange={(event) => set('scopeKind', event.target.value)}
            >
              {schema.scopeKinds.map((value) => (
                <option key={value} value={value}>
                  {messages.scopeKinds[value] ?? value}
                </option>
              ))}
            </select>
          )}
        </Field>

        {draft.scopeKind === 'SECTION' && (
          <Field label={messages.sectionKey} name="scope.sectionKey" issues={issuesByPath}>
            {(control) => (
              <input
                {...control}
                value={draft.sectionKey}
                onChange={(event) => set('sectionKey', event.target.value.toUpperCase())}
                placeholder="ABSTRACT"
              />
            )}
          </Field>
        )}

        {draft.scopeKind === 'ELEMENT' && (
          <>
            <Field label={messages.elementType} name="scope.elementType" issues={issuesByPath}>
              {(control) => (
                <select
                  {...control}
                  value={draft.elementType}
                  onChange={(event) => set('elementType', event.target.value)}
                >
                  {schema.elementTypes.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            {draft.elementType === 'HEADING' && (
              <Field label={messages.headingLevel} name="scope.level" issues={issuesByPath}>
                {(control) => (
                  <input
                    {...control}
                    type="number"
                    min={1}
                    max={9}
                    value={draft.headingLevel}
                    onChange={(event) => set('headingLevel', event.target.value)}
                  />
                )}
              </Field>
            )}
          </>
        )}

        {draft.scopeKind === 'PAGE' && (
          <Field label={messages.pages} name="scope.pages" issues={issuesByPath}>
            {(control) => (
              <select
                {...control}
                value={draft.pages}
                onChange={(event) => set('pages', event.target.value)}
              >
                {schema.pageSelectors.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}

        {draft.scopeKind === 'METADATA' ? (
          <Field label={messages.metadataField} name="scope.field" issues={issuesByPath}>
            {(control) => (
              <input
                {...control}
                value={draft.metadataField}
                onChange={(event) => set('metadataField', event.target.value)}
                placeholder="title"
              />
            )}
          </Field>
        ) : (
          <Field label={messages.property} name="scope.property" issues={issuesByPath}>
            {(control) => (
              <input
                {...control}
                value={draft.property}
                onChange={(event) => set('property', event.target.value)}
                placeholder="marginTop"
              />
            )}
          </Field>
        )}
      </fieldset>

      <fieldset>
        <legend>{messages.expectedValue}</legend>

        <Field label={messages.operator} name="operator" issues={issuesByPath}>
          {(control) => (
            <select
              {...control}
              value={draft.operator}
              onChange={(event) => set('operator', event.target.value)}
            >
              {schema.operators.map((entry) => (
                <option key={entry.operator} value={entry.operator}>
                  {messages.operators[entry.operator] ?? entry.operator}
                </option>
              ))}
            </select>
          )}
        </Field>

        {unary ? (
          <p className="pc-hint">{messages.noOperandNeeded}</p>
        ) : (
          <>
            {allowedValueTypes.length > 1 && (
              <Field label={messages.valueType} name="expected.type" issues={issuesByPath}>
                {(control) => (
                  <select
                    {...control}
                    value={draft.valueType}
                    onChange={(event) => set('valueType', event.target.value)}
                  >
                    {allowedValueTypes.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}

            {draft.valueType === 'NUMBER' && (
              <Field label={messages.expectedValue} name="expected.number" issues={issuesByPath}>
                {(control) => (
                  <input
                    {...control}
                    type="number"
                    step="any"
                    value={draft.numberValue}
                    onChange={(event) => set('numberValue', event.target.value)}
                  />
                )}
              </Field>
            )}

            {draft.valueType === 'STRING' && (
              <Field label={messages.expectedValue} name="expected.text" issues={issuesByPath}>
                {(control) => (
                  <input
                    {...control}
                    value={draft.textValue}
                    onChange={(event) => set('textValue', event.target.value)}
                  />
                )}
              </Field>
            )}

            {draft.valueType === 'BOOLEAN' && (
              <Field label={messages.expectedValue} name="expected.boolean" issues={issuesByPath}>
                {(control) => (
                  <select
                    {...control}
                    value={draft.booleanValue}
                    onChange={(event) => set('booleanValue', event.target.value)}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                )}
              </Field>
            )}

            {draft.valueType === 'NUMBER_RANGE' && (
              <>
                <Field label={messages.minimum} name="expected.min" issues={issuesByPath}>
                  {(control) => (
                    <input
                      {...control}
                      type="number"
                      step="any"
                      value={draft.minValue}
                      onChange={(event) => set('minValue', event.target.value)}
                    />
                  )}
                </Field>
                <Field label={messages.maximum} name="expected.max" issues={issuesByPath}>
                  {(control) => (
                    <input
                      {...control}
                      type="number"
                      step="any"
                      value={draft.maxValue}
                      onChange={(event) => set('maxValue', event.target.value)}
                    />
                  )}
                </Field>
              </>
            )}

            {(draft.valueType === 'STRING_LIST' || draft.valueType === 'NUMBER_LIST') && (
              <Field
                label={messages.listValues}
                name="expected.values"
                issues={issuesByPath}
                hint={messages.listValuesHint}
              >
                {(control) => (
                  <textarea
                    {...control}
                    rows={4}
                    value={draft.listValues}
                    onChange={(event) => set('listValues', event.target.value)}
                  />
                )}
              </Field>
            )}

            {draft.valueType === 'PATTERN' && (
              <>
                <Field label={messages.pattern} name="expected.pattern" issues={issuesByPath}>
                  {(control) => (
                    <select
                      {...control}
                      value={draft.patternName}
                      onChange={(event) => set('patternName', event.target.value)}
                    >
                      {schema.patterns.map((entry) => (
                        <option key={entry.name} value={entry.name}>
                          {entry.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                {patternNeedsArgument && (
                  <Field
                    label={messages.patternArgument}
                    name="expected.argument"
                    issues={issuesByPath}
                  >
                    {(control) => (
                      <input
                        {...control}
                        value={draft.patternArgument}
                        onChange={(event) => set('patternArgument', event.target.value)}
                      />
                    )}
                  </Field>
                )}
              </>
            )}

            {numeric && (
              <Field label={messages.unit} name="unit" issues={issuesByPath}>
                {(control) => (
                  <select
                    {...control}
                    value={draft.unit}
                    onChange={(event) => set('unit', event.target.value)}
                  >
                    {schema.units.map((value) => (
                      <option key={value} value={value}>
                        {messages.units[value] ?? value}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}

            {toleranceAllowed && (
              <Field
                label={messages.tolerance}
                name="tolerance"
                issues={issuesByPath}
                hint={messages.toleranceHint}
              >
                {(control) => (
                  <input
                    {...control}
                    type="number"
                    step="any"
                    min={0}
                    value={draft.tolerance}
                    onChange={(event) => set('tolerance', event.target.value)}
                  />
                )}
              </Field>
            )}
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>{messages.severity}</legend>

        <Field label={messages.severity} name="severity" issues={issuesByPath}>
          {(control) => (
            <select
              {...control}
              value={draft.severity}
              onChange={(event) => set('severity', event.target.value)}
            >
              {schema.severities.map((value) => (
                <option key={value} value={value}>
                  {messages.severities[value] ?? value}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          label={messages.blocking}
          name="blocking"
          issues={issuesByPath}
          hint={
            blockingAllowedInAnyMode
              ? draft.evaluationMode === 'DETERMINISTIC'
                ? messages.blockingHint
                : messages.blockingReviewHint
              : messages.blockingDeterministicOnlyHint
          }
        >
          {(control) => (
            <input
              {...control}
              type="checkbox"
              checked={draft.blocking}
              // Under version 1 only a measured rule may block, so the control
              // is disabled rather than left to fail server-side with an error
              // the author cannot connect to what they did. Under version 2 it
              // stays enabled and the hint explains the consequence instead:
              // refusing the choice would deny a requirement the product is
              // meant to support.
              disabled={!blockingAllowedInAnyMode && draft.evaluationMode !== 'DETERMINISTIC'}
              onChange={(event) => set('blocking', event.target.checked)}
            />
          )}
        </Field>

        <Field label={messages.autofix} name="autofix" issues={issuesByPath}>
          {(control) => (
            <select
              {...control}
              value={draft.autofix}
              onChange={(event) => set('autofix', event.target.value)}
              disabled={draft.evaluationMode === 'MANUAL'}
            >
              {schema.autofixCapabilities.map((value) => (
                <option key={value} value={value}>
                  {messages.autofixCapabilities[value] ?? value}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label={messages.origin} name="origin" issues={issuesByPath}>
          {(control) => (
            <select
              {...control}
              value={draft.origin}
              onChange={(event) => set('origin', event.target.value)}
            >
              {schema.origins.map((value) => (
                <option key={value} value={value}>
                  {messages.origins[value] ?? value}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label={messages.originReference} name="originReference" issues={issuesByPath}>
          {(control) => (
            <input
              {...control}
              value={draft.originReference}
              onChange={(event) => set('originReference', event.target.value)}
            />
          )}
        </Field>
      </fieldset>

      <fieldset>
        <legend>{messages.titleEn}</legend>

        <Field label={messages.titleEn} name="titleEn" issues={issuesByPath}>
          {(control) => (
            <input
              {...control}
              value={draft.titleEn}
              onChange={(event) => set('titleEn', event.target.value)}
              required
            />
          )}
        </Field>
        <Field label={messages.titleAr} name="titleAr" issues={issuesByPath}>
          {(control) => (
            <input
              {...control}
              dir="rtl"
              value={draft.titleAr}
              onChange={(event) => set('titleAr', event.target.value)}
              required
            />
          )}
        </Field>
        <Field label={messages.descriptionEn} name="descriptionEn" issues={issuesByPath}>
          {(control) => (
            <textarea
              {...control}
              rows={2}
              value={draft.descriptionEn}
              onChange={(event) => set('descriptionEn', event.target.value)}
            />
          )}
        </Field>
        <Field label={messages.descriptionAr} name="descriptionAr" issues={issuesByPath}>
          {(control) => (
            <textarea
              {...control}
              dir="rtl"
              rows={2}
              value={draft.descriptionAr}
              onChange={(event) => set('descriptionAr', event.target.value)}
            />
          )}
        </Field>
        <Field label={messages.guidanceEn} name="guidanceEn" issues={issuesByPath}>
          {(control) => (
            <textarea
              {...control}
              rows={2}
              value={draft.guidanceEn}
              onChange={(event) => set('guidanceEn', event.target.value)}
            />
          )}
        </Field>
        <Field label={messages.guidanceAr} name="guidanceAr" issues={issuesByPath}>
          {(control) => (
            <textarea
              {...control}
              dir="rtl"
              rows={2}
              value={draft.guidanceAr}
              onChange={(event) => set('guidanceAr', event.target.value)}
            />
          )}
        </Field>
      </fieldset>

      <div className="pc-actions">
        <button type="submit" disabled={submitting}>
          {messages.save}
        </button>
        <button type="button" onClick={onCancel}>
          {messages.cancel}
        </button>
      </div>
    </form>
  );
}

/**
 * One labelled control, with any server-reported problems rendered beneath it.
 *
 * `aria-describedby` and `aria-invalid` are set from the same index, so the
 * message reaches a screen reader as part of the field rather than as loose
 * text elsewhere on the page.
 */
export interface FieldControlProps {
  readonly id: string;
  readonly 'aria-invalid'?: true;
  readonly 'aria-describedby'?: string;
}

function Field({
  label,
  name,
  issues,
  hint,
  children,
}: {
  label: string;
  name: string;
  issues: Map<string, string[]>;
  hint?: string;
  /**
   * Receives the id and ARIA attributes to spread onto the control itself.
   *
   * A render prop rather than plain children, because the wiring has to land
   * on the input: a label whose `htmlFor` does not match the control's id
   * associates nothing, and `aria-invalid` on a wrapping div tells a screen
   * reader about the div rather than about the field.
   */
  children: (props: FieldControlProps) => React.ReactNode;
}) {
  const messages = issues.get(name) ?? [];
  const errorId = `${name}-error`;
  const hintId = `${name}-hint`;
  const describedBy = [hint === undefined ? null : hintId, messages.length > 0 ? errorId : null]
    .filter((value) => value !== null)
    .join(' ');

  const controlProps: FieldControlProps = {
    id: name,
    ...(messages.length > 0 ? { 'aria-invalid': true as const } : {}),
    ...(describedBy === '' ? {} : { 'aria-describedby': describedBy }),
  };

  return (
    <div className="pc-field" data-invalid={messages.length > 0 ? 'true' : undefined}>
      <label htmlFor={name}>{label}</label>
      {children(controlProps)}
      {hint !== undefined && (
        <p className="pc-hint" id={hintId}>
          {hint}
        </p>
      )}
      {messages.length > 0 && (
        <ul className="pc-field-errors" id={errorId} role="alert">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
