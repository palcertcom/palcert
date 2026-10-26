import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RuleBuilder, draftFromRule, emptyRuleDraft, ruleDraftToPayload } from '../rule-builder';
import { RuleList } from '../rule-list';
import { getStandardsMessages } from '@/i18n/standards-messages';
import type { RuleResponse, RuleSchemaResponse } from '@/lib/api-client';

const messages = getStandardsMessages('en');

/**
 * A schema descriptor shaped exactly like the one the API serves, so the
 * conditional-field logic is exercised against the real contract rather than
 * against a convenient stub.
 */
const schema: RuleSchemaResponse = {
  ruleSchemaVersion: 2,
  supportedRuleSchemaVersions: [1, 2],
  blockingAnyModeFromSchemaVersion: 2,
  categories: ['MARGINS', 'ABSTRACT', 'TYPOGRAPHY'],
  evaluationModes: ['DETERMINISTIC', 'AI_ASSISTED', 'MANUAL'],
  severities: ['INFO', 'MINOR', 'MAJOR', 'CRITICAL'],
  autofixCapabilities: ['NONE', 'SAFE', 'ADVANCED'],
  origins: ['ORGANIZATION_POLICY', 'STYLE_GUIDE'],
  units: ['COUNT', 'MILLIMETRE', 'WORDS'],
  valueTypes: ['NUMBER', 'STRING', 'BOOLEAN', 'NUMBER_RANGE', 'STRING_LIST', 'PATTERN', 'NONE'],
  scopeKinds: ['DOCUMENT', 'SECTION', 'ELEMENT', 'METADATA', 'PAGE'],
  elementTypes: ['HEADING', 'TABLE', 'FIGURE'],
  pageSelectors: ['ALL', 'FIRST', 'LAST'],
  patterns: [
    { name: 'DOI', requiresArgument: false },
    { name: 'STARTS_WITH', requiresArgument: true },
  ],
  operators: [
    {
      operator: 'EQUALS',
      valueTypes: ['NUMBER', 'STRING', 'BOOLEAN'],
      unary: false,
      supportsTolerance: true,
    },
    {
      operator: 'GREATER_THAN_OR_EQUAL',
      valueTypes: ['NUMBER'],
      unary: false,
      supportsTolerance: true,
    },
    { operator: 'BETWEEN', valueTypes: ['NUMBER_RANGE'], unary: false, supportsTolerance: true },
    { operator: 'IN', valueTypes: ['STRING_LIST'], unary: false, supportsTolerance: false },
    {
      operator: 'MATCHES_PATTERN',
      valueTypes: ['PATTERN'],
      unary: false,
      supportsTolerance: false,
    },
    { operator: 'EXISTS', valueTypes: ['NONE'], unary: true, supportsTolerance: false },
  ],
  unitRequiredFor: ['NUMBER', 'NUMBER_RANGE', 'NUMBER_LIST'],
};

function renderBuilder(overrides: Partial<Parameters<typeof RuleBuilder>[0]> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(
    <RuleBuilder
      schema={schema}
      messages={messages}
      initial={emptyRuleDraft(schema)}
      issues={[]}
      submitting={false}
      ruleSchemaVersion={2}
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onSubmit, onCancel };
}

describe('RuleBuilder — conditional fields', () => {
  it('offers only the value types the chosen operator accepts', () => {
    renderBuilder();

    fireEvent.change(screen.getByLabelText(messages.operator), {
      target: { value: 'GREATER_THAN_OR_EQUAL' },
    });

    // One accepted type means no chooser at all: showing a select with a
    // single option is noise.
    expect(screen.queryByLabelText(messages.valueType)).toBeNull();
    expect(screen.getByLabelText(messages.expectedValue)).toBeInTheDocument();
  });

  it('shows a chooser when the operator accepts more than one shape', () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(messages.operator), { target: { value: 'EQUALS' } });

    const chooser = screen.getByLabelText(messages.valueType);
    expect(
      within(chooser as HTMLSelectElement)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['NUMBER', 'STRING', 'BOOLEAN']);
  });

  it('shows a min and a max for a range operator', () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(messages.operator), { target: { value: 'BETWEEN' } });

    expect(screen.getByLabelText(messages.minimum)).toBeInTheDocument();
    expect(screen.getByLabelText(messages.maximum)).toBeInTheDocument();
  });

  it('shows no operand at all for a unary operator', () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(messages.operator), { target: { value: 'EXISTS' } });

    expect(screen.getByText(messages.noOperandNeeded)).toBeInTheDocument();
    expect(screen.queryByLabelText(messages.expectedValue)).toBeNull();
    expect(screen.queryByLabelText(messages.unit)).toBeNull();
  });

  it('snaps the value type when the operator no longer accepts it', () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(messages.operator), { target: { value: 'EQUALS' } });
    fireEvent.change(screen.getByLabelText(messages.valueType), { target: { value: 'STRING' } });

    // Switching to a numeric-only operator must not leave a string operand
    // stranded, which would fail server-side for a reason the author did not
    // cause.
    fireEvent.change(screen.getByLabelText(messages.operator), {
      target: { value: 'GREATER_THAN_OR_EQUAL' },
    });
    expect(screen.getByLabelText(messages.expectedValue)).toHaveAttribute('type', 'number');
  });

  it('asks for a unit only on a numeric rule', () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(messages.operator), { target: { value: 'EQUALS' } });

    expect(screen.getByLabelText(messages.unit)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(messages.valueType), { target: { value: 'STRING' } });
    expect(screen.queryByLabelText(messages.unit)).toBeNull();
  });

  it('offers a tolerance only where it is meaningful', () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(messages.operator), { target: { value: 'EQUALS' } });
    expect(screen.getByLabelText(messages.tolerance)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(messages.operator), { target: { value: 'IN' } });
    expect(screen.queryByLabelText(messages.tolerance)).toBeNull();
  });

  it('asks for a pattern argument only when the pattern takes one', () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(messages.operator), {
      target: { value: 'MATCHES_PATTERN' },
    });

    expect(screen.queryByLabelText(messages.patternArgument)).toBeNull();

    fireEvent.change(screen.getByLabelText(messages.pattern), {
      target: { value: 'STARTS_WITH' },
    });
    expect(screen.getByLabelText(messages.patternArgument)).toBeInTheDocument();
  });

  it('reveals the scope fields the chosen scope kind needs', () => {
    renderBuilder();

    fireEvent.change(screen.getByLabelText(messages.scopeKind), { target: { value: 'SECTION' } });
    expect(screen.getByLabelText(messages.sectionKey)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(messages.scopeKind), { target: { value: 'ELEMENT' } });
    expect(screen.getByLabelText(messages.elementType)).toBeInTheDocument();
    expect(screen.getByLabelText(messages.headingLevel)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(messages.elementType), { target: { value: 'TABLE' } });
    // Heading level applies only to headings.
    expect(screen.queryByLabelText(messages.headingLevel)).toBeNull();

    fireEvent.change(screen.getByLabelText(messages.scopeKind), { target: { value: 'METADATA' } });
    expect(screen.getByLabelText(messages.metadataField)).toBeInTheDocument();
    expect(screen.queryByLabelText(messages.property)).toBeNull();
  });

  it('never offers a raw JSON editor as the normal path', () => {
    renderBuilder();
    const textareas = screen.queryAllByRole('textbox');
    for (const field of textareas) {
      expect(field.getAttribute('id')).not.toBe('scope');
      expect(field.getAttribute('id')).not.toBe('expected');
    }
  });
});

describe('RuleBuilder — safety controls', () => {
  it('disables blocking for an unmeasured rule under schema version 1', () => {
    // The Phase 3 invariant, which version 1 content is still judged by.
    renderBuilder({ ruleSchemaVersion: 1 });
    const blocking = screen.getByLabelText(messages.blocking);

    fireEvent.change(screen.getByLabelText(messages.evaluationMode), {
      target: { value: 'AI_ASSISTED' },
    });
    expect(blocking).toBeDisabled();

    fireEvent.change(screen.getByLabelText(messages.evaluationMode), {
      target: { value: 'DETERMINISTIC' },
    });
    expect(blocking).not.toBeDisabled();
  });

  it('clears blocking when a version 1 rule stops being measured', () => {
    // Otherwise the form holds a ticked box the author cannot untick and the
    // save fails on a field they were not allowed to touch.
    renderBuilder({ ruleSchemaVersion: 1 });
    const blocking = screen.getByLabelText(messages.blocking) as HTMLInputElement;
    fireEvent.click(blocking);
    expect(blocking.checked).toBe(true);

    fireEvent.change(screen.getByLabelText(messages.evaluationMode), {
      target: { value: 'MANUAL' },
    });
    expect(blocking.checked).toBe(false);
  });

  it('explains why blocking is unavailable under schema version 1', () => {
    renderBuilder({ ruleSchemaVersion: 1 });
    expect(screen.getByText(messages.blockingDeterministicOnlyHint)).toBeInTheDocument();
  });

  it('allows an unmeasured rule to block under schema version 2', () => {
    // The amendment: a journal may require an ethics statement before it will
    // certify, and judging that needs a model or a person.
    renderBuilder({ ruleSchemaVersion: 2 });
    const blocking = screen.getByLabelText(messages.blocking) as HTMLInputElement;

    fireEvent.change(screen.getByLabelText(messages.evaluationMode), {
      target: { value: 'AI_ASSISTED' },
    });
    expect(blocking).not.toBeDisabled();

    fireEvent.click(blocking);
    expect(blocking.checked).toBe(true);
  });

  it('warns that an unmeasured blocking rule holds certification open', () => {
    // The safety property did not disappear with the invariant; the author is
    // told where it went, rather than being left to assume the rule decides.
    renderBuilder({ ruleSchemaVersion: 2 });
    fireEvent.change(screen.getByLabelText(messages.evaluationMode), {
      target: { value: 'AI_ASSISTED' },
    });
    expect(screen.getByText(messages.blockingReviewHint)).toBeInTheDocument();
  });

  it('does not show the review warning for a measured rule', () => {
    renderBuilder({ ruleSchemaVersion: 2 });
    expect(screen.queryByText(messages.blockingReviewHint)).not.toBeInTheDocument();
    expect(screen.getByText(messages.blockingHint)).toBeInTheDocument();
  });

  it('disables autofix for a rule a person checks', () => {
    renderBuilder();
    fireEvent.change(screen.getByLabelText(messages.evaluationMode), {
      target: { value: 'MANUAL' },
    });
    expect(screen.getByLabelText(messages.autofix)).toBeDisabled();
  });

  it('requires both title locales', () => {
    renderBuilder();
    expect(screen.getByLabelText(messages.titleEn)).toBeRequired();
    expect(screen.getByLabelText(messages.titleAr)).toBeRequired();
  });

  it('marks the Arabic fields right-to-left', () => {
    renderBuilder();
    expect(screen.getByLabelText(messages.titleAr)).toHaveAttribute('dir', 'rtl');
  });
});

describe('RuleBuilder — server issues', () => {
  it('renders each issue beside the field that caused it', () => {
    renderBuilder({
      issues: [{ path: 'ruleCode', message: 'ruleCode must be UPPERCASE.DOT.SEPARATED.' }],
    });

    const field = screen.getByText('ruleCode must be UPPERCASE.DOT.SEPARATED.');
    expect(field).toBeInTheDocument();
    expect(field.closest('[role="alert"]')).not.toBeNull();
  });

  it('marks the offending field invalid for assistive technology', () => {
    renderBuilder({ issues: [{ path: 'titleAr', message: 'titleAr is required.' }] });

    const wrapper = screen.getByText('titleAr is required.').closest('.pc-field');
    expect(wrapper).toHaveAttribute('data-invalid', 'true');
  });

  it('shows several issues at once rather than only the first', () => {
    renderBuilder({
      issues: [
        { path: 'ruleCode', message: 'bad code' },
        { path: 'titleEn', message: 'bad title' },
      ],
    });

    expect(screen.getByText('bad code')).toBeInTheDocument();
    expect(screen.getByText('bad title')).toBeInTheDocument();
  });
});

describe('ruleDraftToPayload', () => {
  it('composes a scope object from the typed controls', () => {
    const draft = {
      ...emptyRuleDraft(schema),
      scopeKind: 'SECTION',
      sectionKey: 'ABSTRACT',
      property: 'wordCount',
    };
    expect(ruleDraftToPayload(draft).scope).toEqual({
      kind: 'SECTION',
      sectionKey: 'ABSTRACT',
      property: 'wordCount',
    });
  });

  it('omits a heading level for a non-heading element', () => {
    const draft = {
      ...emptyRuleDraft(schema),
      scopeKind: 'ELEMENT',
      elementType: 'TABLE',
      headingLevel: '3',
      property: 'fontSize',
    };
    expect(ruleDraftToPayload(draft).scope).toEqual({
      kind: 'ELEMENT',
      elementType: 'TABLE',
      property: 'fontSize',
    });
  });

  it('omits the unit when the value is not numeric', () => {
    const draft = {
      ...emptyRuleDraft(schema),
      valueType: 'STRING',
      textValue: 'Times New Roman',
      unit: 'MILLIMETRE',
    };
    expect(ruleDraftToPayload(draft).unit).toBeUndefined();
  });

  it('splits list values on newlines and drops blanks', () => {
    const draft = {
      ...emptyRuleDraft(schema),
      valueType: 'STRING_LIST',
      listValues: 'Arial\n\n Times ',
    };
    expect(ruleDraftToPayload(draft).expected).toEqual({
      type: 'STRING_LIST',
      values: ['Arial', 'Times'],
    });
  });

  it('sends no operand for a unary condition', () => {
    const draft = { ...emptyRuleDraft(schema), valueType: 'NONE', operator: 'EXISTS' };
    expect(ruleDraftToPayload(draft).expected).toEqual({ type: 'NONE' });
  });

  it('omits an empty optional rather than sending an empty string', () => {
    const payload = ruleDraftToPayload(emptyRuleDraft(schema));
    expect(payload.descriptionEn).toBeUndefined();
    expect(payload.originReference).toBeUndefined();
  });
});

describe('draftFromRule', () => {
  const rule: RuleResponse = {
    id: 'r1',
    ruleCode: 'MARGIN.TOP.MIN',
    category: 'MARGINS',
    evaluationMode: 'DETERMINISTIC',
    scope: { kind: 'ELEMENT', elementType: 'HEADING', level: 2, property: 'fontSize' },
    operator: 'GREATER_THAN_OR_EQUAL',
    expected: { type: 'NUMBER', number: 25 },
    unit: 'MILLIMETRE',
    tolerance: 0.5,
    severity: 'MAJOR',
    blocking: true,
    autofix: 'SAFE',
    origin: 'ORGANIZATION_POLICY',
    originReference: null,
    titleEn: 'Top margin',
    titleAr: 'الهامش العلوي',
    descriptionEn: null,
    descriptionAr: null,
    guidanceEn: null,
    guidanceAr: null,
    displayOrder: 0,
    ruleSchemaVersion: 1,
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-01T12:00:00.000Z',
  };

  it('round-trips a stored rule back through the payload unchanged', () => {
    // Editing a rule and saving it without touching anything must not alter it.
    const payload = ruleDraftToPayload(draftFromRule(rule, schema));

    expect(payload.scope).toEqual(rule.scope);
    expect(payload.expected).toEqual(rule.expected);
    expect(payload.unit).toBe('MILLIMETRE');
    expect(payload.tolerance).toBe(0.5);
    expect(payload.blocking).toBe(true);
  });
});

describe('RuleList', () => {
  const rules: RuleResponse[] = ['A.ONE', 'B.TWO', 'C.THREE'].map((code, index) => ({
    id: `rule-${String(index)}`,
    ruleCode: code,
    category: 'MARGINS',
    evaluationMode: 'DETERMINISTIC',
    scope: { kind: 'DOCUMENT', property: 'marginTop' },
    operator: 'EQUALS',
    expected: { type: 'NUMBER', number: 1 },
    unit: 'COUNT',
    tolerance: null,
    severity: 'MINOR',
    blocking: false,
    autofix: 'NONE',
    origin: 'ORGANIZATION_POLICY',
    originReference: null,
    titleEn: `Rule ${code}`,
    titleAr: `قاعدة ${code}`,
    descriptionEn: null,
    descriptionAr: null,
    guidanceEn: null,
    guidanceAr: null,
    displayOrder: index,
    ruleSchemaVersion: 1,
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-01T12:00:00.000Z',
  }));

  function renderList(editable = true) {
    const onReorder = vi.fn();
    render(
      <RuleList
        rules={rules}
        messages={messages}
        editable={editable}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onReorder={onReorder}
      />,
    );
    return { onReorder };
  }

  it('reorders with a button, not only with a drag', () => {
    const { onReorder } = renderList();

    fireEvent.click(screen.getByLabelText(`${messages.moveDown}: A.ONE`));
    expect(onReorder).toHaveBeenCalledWith(['rule-1', 'rule-0', 'rule-2']);
  });

  it('reorders with the keyboard', () => {
    const { onReorder } = renderList();

    // The whole point: an author who cannot use a mouse must still be able to
    // set the order findings appear in.
    fireEvent.keyDown(screen.getByText('C.THREE').closest('li')!, { key: 'ArrowUp' });
    expect(onReorder).toHaveBeenCalledWith(['rule-0', 'rule-2', 'rule-1']);
  });

  it('does not move the first rule up or the last one down', () => {
    renderList();
    expect(screen.getByLabelText(`${messages.moveUp}: A.ONE`)).toBeDisabled();
    expect(screen.getByLabelText(`${messages.moveDown}: C.THREE`)).toBeDisabled();
  });

  it('announces each move for a screen reader', () => {
    renderList();
    fireEvent.click(screen.getByLabelText(`${messages.moveDown}: A.ONE`));

    expect(screen.getByRole('status')).toHaveTextContent('A.ONE 2 / 3');
  });

  it('exposes each rule with its position in the set', () => {
    renderList();
    const options = screen.getAllByRole('option');

    expect(options[0]).toHaveAttribute('aria-posinset', '1');
    expect(options[0]).toHaveAttribute('aria-setsize', '3');
    expect(options[0]).toHaveAttribute('tabindex', '0');
  });

  it('offers no reordering controls on a published version', () => {
    renderList(false);
    expect(screen.queryByLabelText(`${messages.moveDown}: A.ONE`)).toBeNull();
    expect(screen.queryByText(messages.reorderHint)).toBeNull();
  });

  it('shows both title locales', () => {
    renderList();
    expect(screen.getByText('Rule A.ONE')).toBeInTheDocument();
    expect(screen.getByText('قاعدة A.ONE')).toBeInTheDocument();
  });
});
