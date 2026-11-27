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

## Recording

These fix the `recorder-requirements` timeout named in F19. Both depart from Reference B on purpose:

- Selector uniqueness now counts matches inside open shadow roots. A bare `button` also matched the toolbox's own buttons, so selectors can now be longer, such as `form > button`.
- The toolbox applies its CSS through `adoptedStyleSheets`, with the CSS text unchanged. `/demo`'s CSP blocked a `<style>` element, so the toolbox grew with long step names and covered `#message`.

## MCP servers and agents

- Saved stdio connections do not keep environment variables. Part 6 section 18 asks for them, but Reference C and 3.0 drop them from settings, the References take priority, and `storage.mjs` does not seal an `env` field. A stdio server that needs secrets in its environment must get them from the environment Studio was started in.
- Only the two presets in Reference C are offered: Microsoft Playwright MCP and Atlassian MCP.
- Generated agent profiles over 2,000 characters are rejected, following Reference E and Part 6 section 33 over Reference C's 12,000. A 400-word model answer can exceed this and would then need regenerating.
- `mcp-server.mjs` signs in only when a tool first needs it, so `tools/list` works while Studio is stopped.
- MCP clients default to a 60-second request timeout, so anything calling `studio_ai_draft_test` must raise it. The tool's own 1,600-second deadline has not been run in full. It was tested against a 310-second header delay.

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

- `requirement-module.test.mjs` no longer runs `generateRequirementDraft` with provider `reasonx`. Part 2 removes that unreachable branch and takes priority over Reference E, so the function now refuses `reasonx`. ReasonX requirements go through `runRequirementAgent`, which has its own tests.
- `test-case-app.test.mjs` now uses `#requirement-feedback` instead of an ambiguous alert selector (F19).

## QA Studio

- Test case details have a "Copy test case" button. Part 6 requires copying, and Reference D does not list a control for it.
- Closing a manual run saves unsaved notes first.

## Requirement generation

These differ from 3.0 on purpose:

- The agent review error follows Reference C and reads `…; Repair limit reached.`. 3.0 has no semicolon there.
- A requirement containing only `.` returns 0 cases. In 3.0 it threw a validation error because of an empty clause.
- Generator warnings are capped at 30, per Reference E. In rare cases this drops the "first 20 notes" line.
- Inspected control labels are trimmed, as field labels already were.

## Raising bugs from test results

- **Spec change, requested by the project owner on 2026-11-04.** Part 2 section 19 said reports support summary and description only, with no screenshot uploads, and that Report issue appears only on QA details. Reports now also send issue type, priority, severity and attachments, and Automation Studio has a Raise bug button on run history and the test case page.
- Run evidence is never sent automatically. The popup ticks only the failed step's screenshot, and the user can untick it before reporting.
- Severity uses a Jira field named Severity when the issue type has a usable one. Otherwise it is written at the top of the description.
- Popup options are read from Jira when it opens, so no new connection check is needed and existing connections keep working. An account without Create Attachments permission can still report, but cannot attach files.
- Attachments are limited to 10 MB each. The HTML run report is the only `.html` file allowed, because Studio generates it; users cannot upload their own.
- A case's dataset rows share one bug per report. Raise bug appears once per case in a run.
- QA Studio's button keeps its label, stays available for any result and stays hidden until Jira connects. Automation Studio shows Raise bug disabled instead, with a prompt to connect Jira.
- Created issues use the project's default status. Jira reports the shared connection account as reporter, so the Studio user's name goes in Run details.

## Run report design

- **Spec change, requested by the project owner on 2026-11-05.** Reference B Appendix A gave the report CSS verbatim. The HTML and PDF run reports now use a document-style design instead, so that CSS and its markup no longer apply.
- The pass rate rounds down, so a run with any failure can never read as 100%.
- Tests that are not passed, failed or skipped, such as blocked or interrupted ones, count as Not completed instead of being left out of the totals.
- Reports stay self-contained, with no web fonts, scripts or external files, because they are downloaded, printed and attached to Jira issues.

## Interactive reports and Playwright JSON

- **Added at the project owner's request on 2026-11-05.** Runs and test cases also have a Monocart interactive report and a Playwright JSON download. The HTML and PDF reports stay, because PDFs and Jira attachments need a static document.
- Studio's runner is not `@playwright/test`, so Monocart's reporter hooks never fire. The run is mapped to Playwright's JSON format, then to Monocart's data, and passed to its `merge` API. A Monocart upgrade can change that data format, so check the interactive report after upgrading.
- The JSON copies fields by name. Runs also hold stored variables, database profiles and dataset values, none of which may leave in a report.
- Blocked, interrupted and unfinished tests use Playwright's `interrupted` result, which Playwright counts as skipped. The `qa-status` annotation and the Result column keep the real status.
- The interactive report runs scripts, so it is served in a CSP sandbox without `allow-same-origin`. Do not add that flag: report scripts would then run with Studio's origin. Monocart's Timeline section and system details are removed because they describe the server.
- Traces are left out of the interactive report, because Monocart opens them through the external trace.playwright.dev viewer.
- Screenshots are limited to 25 MB per report, with failed steps' screenshots kept first.

## Related documents

- **Added at the project owner's request on 2026-11-05.** The Requirement page has a Related Document button. It opens an upload window while the project has no documents, and a list with preview and delete once it has some.
- Documents belong to the project, not to one requirement, because they describe the whole product. Up to 20 per project, 10 MB each: PDF, DOCX, XLSX, CSV, TXT and MD.
- Files and their extracted text are sealed in `data/project-documents`, as separate files so generation does not decrypt the originals. The list is kept in `store.projectDocuments`, so uploads do not change the project revision or interrupt someone editing a requirement. Workspace backup files hold only the list, and restoring one leaves documents as they are, so back up `data/project-documents` with the rest of `data`.
- Every AI generation mode reads the documents automatically; Local rules does not use AI, so it does not. Automation Studio's AI does not read them yet. The upload window warns that cloud engines receive the text. This is the one exception to not sending data without review, because reading documents is the point of uploading them.
- Each engine has its own limit: 40,000 characters for Claude, ChatGPT and Settings providers, 12,000 for Qwen and 700 for ReasonX, whose requests are limited to about 6,000. A warning names any document that did not fully fit.
- Document text is labelled as untrusted in prompts, because a document can contain text written to steer the AI.
- A scanned or password-protected file is kept for preview and marked as unreadable by the AI. There is no OCR. Only PDFs preview in their original layout; the other types preview as text and can be downloaded.

## ReasonX location

- The default ReasonX folder is `../../For Ai/aiResoningAgent`, not the spec's `../../../For Ai/aiResoningAgent`. The spec's path was correct for 3.0, which sits one folder deeper; from 4.0 it pointed at `D:\For Ai`. `REASONX_HOME` still overrides it.

## Hardening (Phase 11)

- **zod 4.** `npm audit --omit=dev --audit-level=high` reported GHSA-mrhx-c7xc-m3w5 (memory exhaustion while validating oversized collections), fixed only in zod 4.6.6 and later. zod is now `^4.6.7` instead of Part 4's `^3.25.76`. Both SDKs accept zod 4. Error messages are unchanged, because the code that turns zod issues into messages now reads zod 4's field names (`origin`, `invalid_value`, `int`).
- `GET /api/automation/execution-overview` without `projectId` returns 400 `projectId is required.`, per Reference A 1.4. Before this, it returned 403 or 404, depending on the user.
- A `credentials.key` that is well formed but cannot decrypt the workspace now fails with a clear message and changes nothing (F11). Before this, it surfaced Node's raw AES-GCM error.
- F1 says database passwords are never returned in ordinary responses, but also that administrators and automation users keep 3.0's behaviour. In 3.0 they receive `jdbcProfiles[].password`: the PostgreSQL editor fills the field from it, and `POST /api/jdbc/query` takes the profile from the client. 4.0 keeps that for those users, hides passwords from QA-only users, and blanks them in project export.
- The Environments & globals hint said values are "stored locally in plain text". `storage.mjs` encrypts `variables` and `globalVariables`, and Reference D section 9 item 11 flagged the wording, so the hint now says the values are stored encrypted.
- The Jira panel text now names every place bugs can be raised, following the 2026-11-04 change.
- `[data-action="bug-settings"]` was removed from `ADMIN_ONLY_SELECTOR`. Nothing renders it (Reference D section 9).
- The restore drill's closing note now also lists `project-documents` and `local-test-files`, which backups do not contain.
- Two features in the working tree are not in the spec: **Process automation** (record a flow once and run it 1 to 1,000 times, as `mode: "process"` runs) and an **NVIDIA API Catalog** model provider. They are documented in the user manual and API reference as built.

## Changes to ported tests (Phase 11)

- `history-page.test.mjs` read `#history-page-label` straight after `page.reload()`, before the page had rendered it, so the predicate threw instead of waiting. It failed the same way on the Phase 10 commit. The predicate now uses `?.` and waits for the element. What it checks is unchanged.

## Hosted mode

- **Added at the project owner's request on 2026-11-25** to deploy on Render. Part 2 requires a `127.0.0.1` bind, and that stays the default. `HOST` changes the bind address, and `STUDIO_PUBLIC_URL` adds exactly one public host and origin to the local-request guard. Without `STUDIO_PUBLIC_URL`, a `0.0.0.0` bind still rejects every non-local request.
- A hosted site creates its first administrator from `STUDIO_ADMIN_USERNAME` and `STUDIO_ADMIN_PASSWORD`, so the first visitor cannot claim the site through first-run setup. Without them it creates the owner's administrator from the password hash in `server.mjs` (requested on 2026-11-25).
- With an `https:` public URL the session cookie gets `Secure`.
- **Render deployment.** The `Dockerfile` uses `mcr.microsoft.com/playwright:v1.64.1-noble`, which must track the `playwright` version in `package-lock.json`, and adds Google Chrome for the seed test. `scripts/docker-start.sh` `exec`s Node so SIGTERM reaches the shutdown handler. It starts no virtual screen, so the container uses the no-screen behaviour described below. `render.yaml` uses the `standard` plan with a disk at `/var/data`, because disks need a paid plan and browsers need more memory than the smallest instance. When `STUDIO_PUBLIC_URL` is not set, the public URL falls back to Render's `RENDER_EXTERNAL_URL`. The image was not built on the development PC, which has no Docker.
- **Browsers on Render's Node runtime.** That runtime cannot install Google Chrome, which needs root, and keeps only the project folder from build to run. `package.json` therefore gains a `postinstall` script, beyond Part 4's list. Only when `RENDER` is set, it downloads Playwright's Chromium into `.browsers/`. `hosting.mjs`, imported first by `server.mjs`, points Playwright there. On Linux, a missing Chrome or Edge falls back to Playwright's Chromium (same engine) instead of failing; Windows behaviour is unchanged. Without a display, Replay and Debug run headless and Record Web uses the recording window.
- **Recording without a screen.** On a server without a display (Linux without `DISPLAY`, or `STUDIO_NO_SCREEN=1`), Record Web runs its browser headless. The Record Web page shows it as JPEG frames from `GET /api/recordings/:id/screen` and sends clicks, pointer moves, scrolling, text and a fixed list of keys through `POST /api/recordings/:id/input`. Both need Automation Studio access, as every recording route does. Input events are not written to the work log. Frames are same-origin images, so the CSP is unchanged. Replay and Debug launch headless on such servers. File-chooser dialogs cannot be shown remotely; file uploads still need a local-path variable.
