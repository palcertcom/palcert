# ADR-0118: Workflow mail gets its own port, so it cannot carry a credential

- **Status:** Accepted
- **Date:** 2026-09-16
- **Phase:** 16

## Context

Phase 1 built `MailDeliveryPort` for verification, password-reset and
invitation mail. Every one of those messages carries a single-use credential:
the token *is* the authority the message grants.

Phase 16 needs to send mail too. Reusing the existing port is the obvious
economy — one transport, one set of credentials, one place to configure. It is
also how a reset token ends up in a notification template. Not by anybody
deciding to put it there: by a shared `variables: Record<string, string>` that
takes whatever a caller passes, and a template registry that both paths reach.

## Decision

**Two ports. Phase 1's is untouched.**

`NotificationEmailProviderPort` is a separate boundary with a separate message
type, separate configuration (`NOTIFICATION_EMAIL_*`, never `AUTH_*`) and
separate adapters. The notification path has no type through which a token
could travel, so "a credential ended up in a notification" is not a bug that
can be written — there is nowhere to put it.

**The message surface is five fields**: `to`, `subject`, `text`, `html`,
`messageId`. Deliberately absent:

- `from` — the sender belongs to the deployment, not the message. The adapter
  composes it from validated configuration, so no caller can influence the one
  header PalCert builds from an operator-supplied string.
- `raw`, `attachments`, `alternatives`, `icalEvent`, `amp`, `watchHtml`,
  `path`, `href` — every one is a way to put arbitrary bytes, a local file or a
  fetched URL into outbound mail, and none is needed to tell somebody their
  submission was approved.
- `cc`, `bcc`, `replyTo`, `envelope` — a notification goes to one person.

The SMTP adapter writes its object literal out in full rather than spreading
the message, sets `disableFileAccess` and `disableUrlAccess`, and an adapter
test asserts the exact key set that reaches the library.

**The recipient is the bare verified address.** Never `Display Name <address>`:
a display name is attacker-influenced text in a header field with its own
quoting rules, and joining the two is where a header injection starts. It also
removes the only reason the adapter would need to know a person's name.

**`nodemailer` is pinned exactly, without `@types/nodemailer`.** Version 10
ships its own types; the DefinitelyTyped package describes an older library,
and installing it would let the adapter compile against a shape the runtime
does not have.

**Failures become one of four codes and one of PalCert's own sentences.** A
bounce banner routinely echoes the envelope back, including the recipient
address, and the failure string is logged and stored on the delivery row.

## Consequences

- Two transports to configure in a deployment that wants both. Accepted: it
  also means workflow mail can be switched off entirely without disabling the
  mail that lets people recover their accounts.
- `NOTIFICATION_EMAIL_PROVIDER=disabled` is the default and a legitimate
  production choice. PalCert is usable with in-app notifications alone, and a
  deployment without a relay records `CHANNEL_DISABLED` skips rather than
  accumulating retries against a transport that was never going to exist.

## Amendment (ADR-0146, 2026-10-02)

The two ports remain separate and workflow mail still cannot carry a
credential. What is now shared is the bottom layer only — the admin-managed
provider configuration, the sealed provider credential and the Resend HTTPS
client in `infrastructure/email`. The separation spec asserts that this layer
never imports authentication code, never accepts a `variables` bag and never
names a credential token. See [ADR-0146](0146-admin-managed-transactional-email.md).
