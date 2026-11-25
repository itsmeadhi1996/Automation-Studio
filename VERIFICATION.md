# Verification

Evidence for Part 3 (Definition of done) of `app prompt.md`, recorded on 2026-11-25 on Windows 11 Pro (10.0.26200) with Node v24.19.0. Chrome, Edge and Firefox were installed (`npm run doctor`).

## Verified here

| Part 3 item | Result | Evidence |
| --- | --- | --- |
| 2. `npm run check` | Pass | `167/167 files passed syntax check` |
| 3. `npm test`, serial | Pass | `tests 510, pass 510, fail 0, cancelled 0, skipped 0` (about 661 s). Log: `.test-output/full-run.log` |
| 4. Reference E inventory | Pass | Every test file under a Reference E heading exists in `test/`. Part 2 regressions are in `test/part2-regressions.test.mjs`, `restart.test.mjs`, `studio-agents.test.mjs` and `reasonx-regressions.test.mjs` |
| 5. User journeys | 9 pass, 1 partial (see below) | Screenshots, reports and CSVs in `.test-output/acceptance/shots/`; details in `.test-output/acceptance/RESULTS.md` |
| 6. Scripts | Pass, except `launch --open` (see below) | `npm run doctor` printed port 3300 and browser readiness. `run-tests -- --help` printed usage. `mcp` `tools/list` returned 9 tools and `mcp:test-cases` returned 1, both through an MCP stdio client. `agents` listed 6 agents. `clean -- --dry-run` printed "Would remove 50 disposable test workspace(s)." `restore-drill` reported key, users and studio OK, and 20/20 backups parse |
| 7. Reference A routes | Pass | All 99 routes in sections 1.1 to 1.10, the pipeline, authorize order and the 41 static entries were checked against `server.mjs`. Where Part 2 overrides Reference A (F18 404s), the code follows Part 2. The missing `projectId` 400 on the execution overview was fixed and has a test |
| 8. `GET /api/health` | Pass | `{"status":"ok",...}` |
| 9. `npm audit --omit=dev --audit-level=high` | Pass | `found 0 vulnerabilities` after the zod 4.6.7 upgrade (see `DECISIONS.md`) |
| 10. Documents | Present | `README.md`, `docs/USER-MANUAL.md`, `docs/QA-API.md`, `docs/ACCESS-CONTROL.md`, `docs/RECOVERY.md`, `DECISIONS.md` and this file |

### Journeys (Part 3 item 5)

These were driven in a real browser against `node server.mjs` started on its own, with `PORT=3330` and storage in `.test-output/acceptance/storage`. Port 3330 was used because the owner's own Studio was running on 3300 with real data. Test runs ran in Chrome (`channel:'chrome'`).

| Journey | Result |
| --- | --- |
| First-run setup, sign in, sign out, change password | Pass. The old password returns 401 after the change |
| User with one studio and one project | Pass. The user sees only the assigned project; `/automation` and `/api/admin/users` return 403 |
| Requirement, Local rules, approve | Pass. 6 drafts; the approved case appears as `TC-0002` |
| Test plan, manual run, HTML and PDF reports | Pass. HTML 200 (9,407 bytes); PDF `application/pdf`, starts `%PDF-1.4` |
| Seed welcome test in Chrome on `/demo` | Pass. 4/4 steps with screenshots, HTML and interactive reports |
| Record Web, save, run | Partial: see **Verified with mocks only** |
| Debug step by step, replay | Pass. A double click on "Step to next action" now advances exactly one step with no failed request (fixed in this phase) |
| Run history and TC Execution overview filters, CSV | Pass. The CSV respects the active filter |
| Backup and restore, project export and import | Pass. Restore kept runs and users; export blanked `BASE_URL` |
| Light and dark themes | Pass on 10 screens, including login and account |

## Verified with mocks only

- **Record Web.** On the real server, recording started and opened a visible Chrome window that Playwright cannot drive. Recording was then verified the way `test/recorder.test.mjs` does it: `startRecording` headless in-process, driven through the real UI, saved and run (3/3 passed). The same steps also passed 3/3 in Chrome on the real server.
- **Jira, ReasonX, Ollama/Qwen, Claude, ChatGPT, Gemini, Groq, NVIDIA, MCP servers and PostgreSQL.** Covered by the test suite with fake servers and injected fetchers only.
- **`sslmode: 'prefer'`** was checked against a fake server; no real TLS connection was made.
- **`studio_ai_draft_test`** was tested against a 310-second header delay, not its full 1,600-second deadline.

## Not run here

- **`npm run launch -- --open`.** The owner's Studio was running on 3300, and the launcher restarts an outdated server on that port. It was not run, so that server was not stopped.
- **Clean checkout (item 1).** `npm install`, `npm run setup` and `npm start` were not repeated from a fresh clone. The working tree's server started and answered (journeys above), and the owner's server answered `/api/health` on 3300.

## Needs the user's own configuration

- A live Jira Cloud site, an OpenVPN Connect install with a profile (`doctor` reports OpenVPN not installed), a PostgreSQL server, a ReasonX installation (`REASONX_HOME`), Ollama with `qwen3:14b`, and cloud API keys.
- Model IDs not exercised live: `claude-opus-5-5`, `gpt-4.1-mini`, `gemini-3.8-flash`, `openai/gpt-oss-20b`, `reasonx-v1`, `qwen3:14b` and the NVIDIA default `meta/muse-glimmer-30b`. All are editable in Settings.
