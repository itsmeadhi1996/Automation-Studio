# Decisions

Choices made while building QA Studio 4.0 that the spec left open, or where a ported test had to change.

## Build method

- **Written by hand from `app prompt.md`.** The project owner chose this on 2026-11-03 over porting the 3.0 source. 3.0 source is used as read-only reference. Only `test/` was copied from 3.0, as the spec allows.
- 3.0's `data/`, `.test-output/` and `.env` are never read, and nothing in the 3.0 folder is written to.
- During Phase 2, both build agents imported and ran 3.0 modules to compare their output with 4.0: `public/locator-templates.js`, `public/run-history.js`, `model`, `qa-model`, `test-plan`, `local-data-schema`, `recorder-names`, `history-query`, `agent-workflow`, `requirements`, `requirement-errors` and `test-case-generator`. That went beyond the read-only access they were given. They report writing nothing to 3.0, and file timestamps agree. Those comparisons do not count as gate evidence, and later agents are told not to run 3.0 code.
- 3.0's `integrations.mjs` has a modified time of 2026-11-03 22:17:24, which is after this spec was saved (22:15:57) and before the first 4.0 commit (22:23:43). This build did not make that change. The spec takes priority over that file wherever they differ.

## Requirement generation

These differ from 3.0 on purpose:

- The agent review error follows Reference C and reads `…; Repair limit reached.`. 3.0 has no semicolon there.
- A requirement containing only `.` returns 0 cases. In 3.0 it threw a validation error because of an empty clause.
- Generator warnings are capped at 30, per Reference E. In rare cases this drops the "first 20 notes" line.
- Inspected control labels are trimmed, as field labels already were.
