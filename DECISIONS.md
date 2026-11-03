# Decisions

Choices made while building QA Studio 4.0 that the spec left open, or where a ported test had to change.

## Build method

- **Written by hand from `app prompt.md`.** The project owner chose this on 2026-11-03 over porting the 3.0 source. 3.0 source is used as read-only reference. Only `test/` was copied from 3.0, as the spec allows.
- 3.0's `data/`, `.test-output/` and `.env` are never read, and nothing in the 3.0 folder is written to.
- During Phase 2, both build agents imported and ran 3.0 modules to compare their output with 4.0: `public/locator-templates.js`, `public/run-history.js`, `model`, `qa-model`, `test-plan`, `local-data-schema`, `recorder-names`, `history-query`, `agent-workflow`, `requirements`, `requirement-errors` and `test-case-generator`. That went beyond the read-only access they were given. They report writing nothing to 3.0, and file timestamps agree. Those comparisons do not count as gate evidence, and later agents are told not to run 3.0 code.
- 3.0's `integrations.mjs` has a modified time of 2026-11-03 22:17:24, which is after this spec was saved (22:15:57) and before the first 4.0 commit (22:23:43). This build did not make that change. The spec takes priority over that file wherever they differ.

## Execution engine

- `sslmode: 'prefer'` (F13) uses `rejectUnauthorized: false`, like libpq, and falls back to plain only when the server says it does not support SSL. This was checked against a fake server. A real TLS connection has not been tested.
- A date-only `to` filter covers the whole UTC day, following Reference E over Reference B's plain `<=`.
- An empty browser name reports Chrome, not Firefox.
- Cancelling a run still relabels earlier genuine failures as `interrupted`, reproducing 3.0.
- `report.counts.broken` is removed, per Part 2.

## Sign-in and public pages

- `login.html` loads only public styles (`theme.css`, `auth.css`), because `studio-design.css` needs a session. This also applies the saved dark theme on sign-in (F15).
- `/style.css` stays signed-in only, per Reference A section 1.11. `/demo` is public, so it renders unstyled for a signed-out visitor, including inside test runs. This does not affect the demo's behaviour.
- A missing page or artifact returns `Not found` rather than a message containing a file path.

## Changes to ported tests

- `requirement-module.test.mjs` expected the nav label `Requirements`. Part 2 requires `Requirement` and takes priority, so the assertion changed.
- `qa-history-cache.test.mjs` waited for `.donut svg`, which no longer exists (F19). It now checks the `Show 1 … test cases` buttons.

- Ports were made unique across browser test files (F19): folders 3811, replay 3812, case-history 3813, editor-state 3814, action-readiness 3815, bug-tracker 3816, mcp-catalog 3817, review-regressions 3818, reasonx 3819, auto-generator 3820.
- `action-readiness.test.mjs` raised its 250 ms step timeout to 1000 ms (F19). This gives the click more time and does not loosen what the test checks.
- `editor-state.test.mjs` keeps its colour assertion, because it matches the spec.

## QA Studio

- Test case details have a "Copy test case" button. Part 6 requires copying, and Reference D does not list a control for it.
- Closing a manual run saves unsaved notes first.

## Requirement generation

These differ from 3.0 on purpose:

- The agent review error follows Reference C and reads `…; Repair limit reached.`. 3.0 has no semicolon there.
- A requirement containing only `.` returns 0 cases. In 3.0 it threw a validation error because of an empty clause.
- Generator warnings are capped at 30, per Reference E. In rare cases this drops the "first 20 notes" line.
- Inspected control labels are trimmed, as field labels already were.
