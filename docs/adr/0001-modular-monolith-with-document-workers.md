# ADR-0001: Modular monolith with independent document workers

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 0

## Context

PalCert spans fifteen-plus functional areas (auth, organizations, standards,
rules, documents, checks, AI, SmartFix, billing, submissions, certificates,
notifications, audit, admin). Document analysis and SmartFix are CPU- and
memory-heavy and can take minutes on a large thesis; they must never block an
HTTP request (§17). The team is small and the domain boundaries are not yet
proven by production traffic.

## Decision

Build the core backend as a **modular monolith** (`apps/api`, NestJS) with
strictly separated feature modules, plus **independent workers** that consume
jobs from Redis and call the Python document engine.

Module boundaries are enforced by convention and lint rules: a module exposes a
service interface and never reaches into another module's repositories.

## Alternatives considered

- **Microservices from day one.** Rejected: distributed transactions across
  billing, checks and documents would dominate the effort, and the boundaries
  would be guesses. §33 explicitly forbids premature microservices.
- **Single process including document analysis.** Rejected: a 300-page DOCX
  parse would occupy an API worker and jeopardize request latency and memory.

## Consequences

- One deployable API artifact; simple local development and testing.
- Workers scale independently of the API on document-processing load.
- Module boundaries must be policed in review; a violated boundary is cheap to
  create and expensive to undo.
- If a module later needs independent scaling, its service interface is already
  the extraction seam.
