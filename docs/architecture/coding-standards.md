# Coding standards

Derived from §46 and §47 of the master prompt. These are enforced by tooling
wherever possible; the rest is enforced in review.

## 1. TypeScript

- `strict: true`, plus `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noImplicitReturns` and `noFallthroughCasesInSwitch`.
- `any` is an ESLint **error**. Use `unknown` and narrow, or write the type.
- Type-only imports use inline `type` syntax (auto-fixable).
- `console.log` is an error — use the injected logger. `console.error` is
  permitted only in `main.ts`, before the logger exists.

## 2. Python

- Fully typed; `mypy --strict` must pass.
- Ruff for lint and format, including `ANN` (annotations) and `S` (bandit
  security) rule sets.

## 3. Structure

- Small, cohesive modules. No god classes; no 1000-line service files.
- Dependency injection everywhere — never construct a dependency inside a
  service.
- Business logic never lives in React components.
- Business logic is never duplicated across modules; extract a shared service.
- A feature module exposes a service interface and never reaches into another
  module's repositories.

## 4. Configuration

- Configuration is read once, validated, and exposed through a typed service.
- `process.env` is read only inside `@palcert/config` (and `NEXT_PUBLIC_*` in
  the web app, where the value is public by definition).
- No magic strings for configuration keys, error codes or rule codes — use the
  exported constants in `@palcert/contracts`.

## 5. Errors

- Throw `AppError` with a `PalCertErrorCode`. Never throw bare strings.
- Client-safe information goes in `message`/`details`; everything diagnostic
  goes in `internalContext` or `cause`.
- Never catch an error and silently continue. Either handle it meaningfully or
  let it propagate to the global filter.

## 6. Logging

- Structured only: `logger.info({ checkId, durationMs }, 'check.completed')`.
- Never log document contents, extracted text, full request bodies or secrets.
- Every log line carries a correlation ID automatically — do not add one
  manually.

## 7. Database

Before implementing any feature that persists data (§44):

1. Show the affected entities.
2. Explain the relations.
3. Create migrations.
4. Add indexes.
5. Consider tenant boundaries.
6. Consider auditability.
7. Consider retention and deletion behavior.

Prefer strongly typed relational structures. Use `JSONB` only where flexibility
is genuinely valuable — never as a substitute for a table.

## 8. Migrations (§45)

Migrations are versioned, repeatable across environments, reviewable and safe.
**An applied migration is never edited.** Corrections are new migrations.

## 9. Tests

- Every phase ships unit, integration, contract, e2e, security and (from
  Phase 6) golden document tests as applicable.
- Tests assert behavior and security properties, not implementation details.
- A phase is never completed with knowingly failing tests (§39).

## 10. Naming

- Domain names come from the product vocabulary: `Organization` (never
  `University`), `Customer Credit Balance` (never "wallet"), `StandardVersion`,
  `Finding`, `MachineReport`.
- Rule codes are dotted and uppercase: `BODY.FONT.SIZE`, `PAGE.MARGIN.LEFT`.
- Error codes are `UPPER_SNAKE_CASE` and stable forever.
