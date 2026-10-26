'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import type { StandardsMessages } from '@/i18n/standards-messages';
import type { RuleResponse } from '@/lib/api-client';

/**
 * The rule list, with reordering.
 *
 * Reordering is **buttons and arrow keys**, never drag-and-drop alone. Drag is
 * unusable with a keyboard, with a screen reader, and on a touch device with
 * a long list — and rule order is not decoration: it is the order findings
 * appear in a report, which is part of what the standard says. An author who
 * cannot use a mouse must still be able to set it.
 *
 * The list is a `listbox`: each row is focusable, the active row is announced,
 * and Arrow Up/Down move the focused rule. `aria-live` reports the move, since
 * a purely visual reorder tells a screen-reader user nothing.
 */
export function RuleList({
  rules,
  messages,
  editable,
  onEdit,
  onDelete,
  onReorder,
}: {
  rules: readonly RuleResponse[];
  messages: StandardsMessages;
  editable: boolean;
  onEdit: (rule: RuleResponse) => void;
  onDelete: (rule: RuleResponse) => void;
  onReorder: (ruleIds: readonly string[]) => void;
}) {
  const [order, setOrder] = useState<readonly string[]>(() => rules.map((rule) => rule.id));
  const [announcement, setAnnouncement] = useState('');

  // The server is the source of truth; re-sync whenever it hands back a new
  // set, so a rejected reorder does not leave the UI showing an order that was
  // never saved.
  useEffect(() => {
    setOrder(rules.map((rule) => rule.id));
  }, [rules]);

  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const ordered = order
    .map((id) => byId.get(id))
    .filter((rule): rule is RuleResponse => rule !== undefined);

  function move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;

    const next = [...order];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    setOrder(next);

    const rule = byId.get(moved!);
    setAnnouncement(`${rule?.ruleCode ?? ''} ${String(target + 1)} / ${String(next.length)}`);
    onReorder(next);

    // Keep focus on the row that moved, so a keyboard user can move it again
    // without hunting for it.
    queueMicrotask(() => {
      document.getElementById(`rule-row-${moved!}`)?.focus();
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLLIElement>, index: number): void {
    if (!editable) return;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(index, -1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(index, 1);
    }
  }

  if (ordered.length === 0) {
    return <p className="pc-empty">{messages.noRules}</p>;
  }

  return (
    <>
      {editable && <p className="pc-hint">{messages.reorderHint}</p>}

      <ul className="pc-rule-list" role="listbox" aria-label={messages.rules}>
        {ordered.map((rule, index) => (
          <li
            key={rule.id}
            id={`rule-row-${rule.id}`}
            className="pc-rule-row"
            role="option"
            aria-selected={false}
            aria-posinset={index + 1}
            aria-setsize={ordered.length}
            tabIndex={0}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <div className="pc-rule-summary">
              <code className="pc-rule-code">{rule.ruleCode}</code>
              <span className="pc-rule-title">{rule.titleEn}</span>
              <span className="pc-rule-title" dir="rtl">
                {rule.titleAr}
              </span>
            </div>

            <div className="pc-rule-meta">
              <span>{messages.categories[rule.category] ?? rule.category}</span>
              <span>{messages.severities[rule.severity] ?? rule.severity}</span>
              <span>{messages.evaluationModes[rule.evaluationMode] ?? rule.evaluationMode}</span>
              {rule.blocking && <span className="pc-badge">{messages.blocking}</span>}
            </div>

            {editable && (
              <div className="pc-rule-actions">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={`${messages.moveUp}: ${rule.ruleCode}`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === ordered.length - 1}
                  aria-label={`${messages.moveDown}: ${rule.ruleCode}`}
                >
                  ↓
                </button>
                <button type="button" onClick={() => onEdit(rule)}>
                  {messages.editRule}
                </button>
                <button type="button" onClick={() => onDelete(rule)}>
                  {messages.deleteRule}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <p className="pc-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </>
  );
}
