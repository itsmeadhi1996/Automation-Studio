# QA Studio 4.0

QA Studio is a local, single-machine test management application with a connected Automation Studio browser-automation workspace. QA Studio manages projects, requirements, test cases, test plans, manual execution and reports. Automation Studio authors, records, debugs, runs and schedules real browser tests against the same cases. Both studios share one server, one store and one identity for each case.

This is a new build written from `app prompt.md`. It does not use the 3.0 source or 3.0 data. See [DECISIONS.md](DECISIONS.md).

## Requirements

- Node.js 22 or newer (`"engines": { "node": ">=22" }`).
- Windows 11. The encrypted workspace key uses Windows DPAPI and belongs to the Windows account that started Studio.
- Google Chrome. The seed test runs with `channel: 'chrome'`. If Chrome is missing, `npx playwright install chrome` supplies it. Microsoft Edge and Playwright Firefox are also supported for execution.

## Port and address

- The default port is **3300**. Set `PORT` to use another port.
- The server binds to `127.0.0.1` only. Requests whose `Host` or `Origin` is not `127.0.0.1:<port>` or `localhost:<port>` get `403 Local requests only`.
- 4.0 runs beside QA Studio 3.0, which uses port 3200. Port 3300 keeps the 4.0 launcher from finding 3.0 and treating it as an outdated 4.0 server.

Open http://127.0.0.1:3300 after starting. Automation Studio is at http://127.0.0.1:3300/automation.

## Install, set up and start

```powershell
npm install
npm run setup
npm start
```

- `npm install` installs the dependencies.
- `npm run setup` runs `playwright install chromium firefox`. Chromium is used for inspection and report PDFs. Firefox is used for Firefox runs and for the `locator-focus` tests.
- `npm start` runs the server in the foreground. Press Ctrl+C to stop it.

On the first visit, create the administrator account. There are no default credentials. See [Accounts and studio permissions](docs/ACCESS-CONTROL.md).

### Windows launchers

- **Start QA Studio.cmd** runs `Restart QA Studio.ps1 -UpgradeOnly`, which runs `node launch.mjs --upgrade --open`. It starts Studio in the background if it is not running and opens the browser. If a running server's source version differs from the installed files, it restarts that server through the safe restart checks. A current server is opened without a restart.
- **Restart QA Studio.cmd** runs `Restart QA Studio.ps1`, which runs `node launch.mjs --restart --open` and always restarts a running server.

When the running server needs an administrator sign-in, the launcher exits with code 3. The PowerShell script then asks in the console for a **QA Studio administrator** username and a masked password. These are application credentials, not your Windows password. A blank username cancels, and the server is not stopped. The credentials are set only for that process and are restored afterwards. They are never passed to the background server.

Run the launchers from your normal Windows desktop session, under the Windows account that owns the workspace. See [Backup, recovery and health](docs/RECOVERY.md) for the restart checks.

### npm scripts

| Script | Command | What it does |
| --- | --- | --- |
| `npm start` | `node server.mjs` | Starts the server in the foreground. |
| `npm run dev` | `node --watch server.mjs` | Starts the server and restarts it when source files change. |
| `npm run setup` | `playwright install chromium firefox` | Installs the Playwright Chromium and Firefox browsers. |
| `npm run mcp` | `node mcp-server.mjs` | Starts Studio's own MCP server on stdio. It offers nine tools: eight `studio_*` tools, which need a running Studio and a sign-in, and `generate_test_cases`. |
| `npm test` | `node --test --test-concurrency=1 test/*.test.mjs` | Runs the full test suite, one file at a time. |
| `npm run check` | `node scripts/check.mjs` | Runs `node --check` on every `.mjs` and `.js` file, skipping `node_modules`, `.test-output`, `.playwright-mcp`, `data`, `artifacts`, `fixtures` and `.git`. |
| `npm run run-tests` | `node studio-cli.mjs` | Command-line run client for a running Studio. Use `npm run run-tests -- --help` for options. Default URL `http://127.0.0.1:3300`, or `STUDIO_URL`. |
| `npm run doctor` | `node doctor.mjs` | Prints the Node version and folder, tries to launch Chrome, Edge and Firefox, prints the OpenVPN status, and prints the URL for the configured port. |
| `npm run launch` | `node launch.mjs` | Starts Studio in the background. Flags: `--open` opens the browser, `--upgrade` restarts an outdated server, `--restart` always restarts. Example: `npm run launch -- --open`. |
| `npm run mcp:test-cases` | `node test-case-mcp.mjs` | Starts the Local rules MCP server on stdio, with one tool, `generate_test_cases`. Studio does not need to be running. See [TEST-CASE-MCP](docs/TEST-CASE-MCP.md). |
| `npm run agents` | `node studio-agents.mjs` | Lists, checks and runs the six ReasonX agent profiles in `.agents/`. See [REASONX-AGENTS](docs/REASONX-AGENTS.md). |
| `npm run clean` | `node scripts/clean-test-output.mjs` | Removes disposable test workspaces under `.test-output`. Add `-- --dry-run` to see what would be removed. |
| `npm run restore-drill` | `node scripts/restore-drill.mjs` | Checks that every backup parses and that the key files are present. It changes nothing. See [RECOVERY](docs/RECOVERY.md). |

`npm run mcp` and `npm run mcp:test-cases` wait silently on stdin for JSON-RPC. An MCP client normally starts them.

## Data folder

Studio keeps its data in `data/` and its screenshots and traces in `artifacts/`, both under the app folder. Set `STUDIO_STORAGE_DIR` to keep both under another folder instead. The launchers pass the folder they used on to the background server.

| Path | Contents |
| --- | --- |
| `data/studio.json` | Projects, runs, settings, assignments and the working log. Secret fields are encrypted. |
| `data/users.json` | Accounts and password hashes. Not encrypted. |
| `data/credentials.key` | The encryption key, protected with DPAPI for the Windows account that created it. |
| `data/backup-*.json` | Copies of `studio.json`. The newest 20 are kept. |
| `data/recording.json` | The current recording draft. |
| `data/local-test-files/` | Uploaded local test data files, encrypted. |
| `data/project-documents/` | Related documents for requirements and their extracted text, encrypted. |
| `data/studio.lock` | The process ID of the server that has the folder open. |
| `artifacts/` | Screenshots and traces. Not encrypted. |

Only one server can open a data folder at a time. A second server stops with `This workspace is already open in another Studio server.`

A fresh install starts with an empty `data/` folder and the **Getting started** seed project. 4.0 does not read 3.0's data. To bring a 3.0 project across, export it as project JSON in 3.0 and import it in 4.0 with **Automation Studio > Settings & connections > Import project**. Importing needs the **Create projects** permission. Exports leave out variable values, dataset rows, local data values, database passwords and values marked sensitive, so enter those again after import.

## The two studios

The QA Studio navigation label for requirements is **Requirement** (singular).

Automation steps support these locator types (`locatorTypes` in `model.mjs`): CSS, XPath, ID, name, text, label, placeholder, test ID, custom, and object repository entries. There is no role locator type.

### Requirement generation methods

| Method | `generationMode` | Uses |
| --- | --- | --- |
| Use ReasonX agents | `agent` | The ReasonX agent workflow. |
| AI - configured provider | `ai` | The shared provider in Model settings. It uses the ReasonX agent pipeline only when that provider is `reasonx`. |
| Claude or ChatGPT, my API key | `claude`, `chatgpt` | The user's own key from **My account**. |
| Qwen3 14B | `qwen` | Ollama on this machine. |
| Local rules | `rules` | `test-case-generator.mjs`. No model or key. |

Defaults differ between the API and the screen:

- **API:** a requirement saved without `generationMode` uses `rules` (Local rules).
- **Screen:** a new requirement starts with **Use ReasonX agents** (`agent`), which is first in the list. If the user chose Claude or ChatGPT as their QA Studio engine in **My account**, the new requirement starts with that engine. A saved requirement keeps its saved method.
- **AI - configured provider** appears in the list only for a requirement already saved with `ai`.

Generated cases are drafts. Nothing is added to Test cases until a draft is approved.

## Known limits

- **Recording literals.** Password inputs are never recorded literally, but other typed values stay readable in `data/recording.json`. `test/recorder.test.mjs` reads them there. Mark a step as sensitive to have its value encrypted.
- **Stdio MCP connections do not keep environment variables.** A stdio MCP server that needs secrets in its environment must get them from the environment Studio was started in.
- **No OCR for related documents.** A scanned or password-protected file is kept for preview but marked unreadable by the AI.
- **Back up `data/project-documents` with `data/`.** Workspace backups hold only the document list, and restoring one leaves the documents as they are.
- **PostgreSQL `sslmode: prefer` has no live TLS test.** It tries TLS and falls back to plain only when the server says it does not support SSL. This was checked against a fake server, not a real TLS connection.
- **`studio_ai_draft_test` needs a longer MCP timeout.** MCP clients default to a 60-second request timeout, so a client calling this tool must raise it. The tool's own deadline is 1,600 seconds and has not been run in full.
- Backups contain project definitions only. They do not include `users.json`, `credentials.key`, `artifacts/`, `local-test-files/` or `project-documents/`. See [RECOVERY](docs/RECOVERY.md).
- One automation run executes at a time. There are no distributed workers or offline system service; schedules need the server running.
- Traces are not redacted.
- Cancelling a run closes its browser. A database query already running can take its configured timeout to finish.
- An OpenVPN connect request does not prove the tunnel authenticated. Check the desktop client.
- The server listens on loopback only. Network hosting is not provided.

## Documentation

- [User manual](docs/USER-MANUAL.md)
- [QA API](docs/QA-API.md)
- [Accounts and studio permissions](docs/ACCESS-CONTROL.md)
- [Backup, recovery and health](docs/RECOVERY.md)
- [ReasonX agents](docs/REASONX-AGENTS.md)
- [Local test case generation and MCP](docs/TEST-CASE-MCP.md)
- [Decisions](DECISIONS.md)
- [Verification](VERIFICATION.md)

## Verification

```powershell
npm run check
npm test
```

`npm test` runs serially. For disposable test workspaces in a Windows session without DPAPI, set `QA_TEST_PORTABLE_VAULT=1` first. Only `test/support.mjs` reads this variable. It writes portable test keys under `.test-output` and refuses other paths. Production code never reads it. CI sets it too. Test results are recorded in [VERIFICATION.md](VERIFICATION.md).
