# Decisions

Choices made while building QA Studio 4.0 that the spec left open, or where a ported test had to change.

## Build method

- **Written by hand from `app prompt.md`.** The project owner chose this on 2026-11-03 over porting the 3.0 source. 3.0 source is used as read-only reference. Only `test/` was copied from 3.0, as the spec allows.
- 3.0's `data/`, `.test-output/` and `.env` are never read, and nothing in the 3.0 folder is written to.
