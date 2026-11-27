# QA Studio 4.0 API

QA Studio and Automation Studio share one local server at `http://127.0.0.1:3300`. You can change the port with `PORT`. The server binds to `127.0.0.1` only. This page covers the QA, requirement, test-case, test-plan, manual-run, report and bug-reporting APIs. `server.mjs` is the reference: wherever this page and the code differ, the code is correct.

JSON errors have the shape `{ "error": "message" }`, and may also carry `userMessage` (plain-language guidance), `code` and `issues`. Unless a route says otherwise, a validation failure returns 400, a missing item 404, and an unknown route 404 `{"error":"Not found"}`.

## Requests and sign-in

### Local guard (CSRF and origin)

There is no CSRF token. Every request, including sign-in and health, first passes these checks. If any check fails, the server returns 403 `{"error":"Local requests only"}`.

| Check | Rule |
| --- | --- |
| `Host` | Must be `127.0.0.1:3300` or `localhost:3300` (blocks DNS rebinding) |
| `Origin` | Optional. When present it must be `http://127.0.0.1:3300` or `http://localhost:3300` |
| `Sec-Fetch-Site` | Must not be `cross-site` |
| Session cookie | `SameSite=Strict`, so other sites cannot send it |
| Body routes | Need `Content-Type: application/json`, otherwise 400 `Use Content-Type: application/json`. Uploads are the exception (see below) |

Requests with no `Origin`, such as curl or the CLI, are allowed. A JSON body can be up to 2 MiB; a larger one returns 413 `Request too large`. An empty body is read as `{}`. The body must be a JSON object, not an array or null.

Every response includes `X-Request-Id`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

### Session

| Route | Request / response |
| --- | --- |
| `GET /api/health` | Public. Health object; `degraded` still returns 200 |
| `GET /api/auth/session` | Public. `{setupRequired,user,runtime:{pid,sourceVersion}}`; `user` is `null` when signed out |
| `POST /api/auth/setup` | Public. `{username,name,password}` creates the first administrator only. 201 `{created:true}`, 409 once setup is complete |
| `POST /api/auth/login` | Public. `{username,password}` returns `{user,home}` and sets the session cookie. Returns 401 for wrong credentials and 429 `Too many sign-in attempts. Try again in a minute.` |
| `POST /api/auth/logout` | Public. Ends the session and clears the cookie: `{loggedOut:true}` |
| `PUT /api/auth/password` | `{currentPassword,password}` returns `{changed:true}`, clears the cookie and ends all of the user's sessions |

The cookie is `studio_session=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` (8 hours). Clients may send `Authorization: Bearer <token>` instead.

Without a session, the pages `/`, `/automation`, `/run-history`, `/admin`, `/admin/*` and `/account` redirect with 302 to `/login`. Every other non-public route returns 401 `{"error":"Please sign in to continue."}`.

### Permission tiers

The server checks the route's tier before it checks project access. Administrators pass every tier.

| Tier | Who passes | Used by (examples) |
| --- | --- | --- |
| Public | Anyone on the local guard | health, session, setup, login, logout |
| Signed in | Any session | `PUT /api/auth/password`, `/account` |
| Studio (ST) | `qa` or `automation` | `PUT /api/projects/:id`, `GET /api/runs*`, run reports, `/artifacts/*`, `/api/issues*`, `GET /api/bug-tracker`, `GET /api/settings` |
| QA (Q) | `qa` | `GET /api/state`, `/api/projects/:id/requirements*`, `/api/projects/:id/documents*`, `/api/manual-runs*` |
| Automation (A) | `automation` | `GET /api/state?workspace=automation`, `POST /api/runs`, `/api/runs/:id/cancel`, `/api/automation/*`, `/api/ai/*`, `/api/preflight`, `/api/schedules*`, `/api/debug*`, `/api/recordings*` |
| Create projects | `createProjects` | `POST /api/projects` |
| Use MCP / Manage MCP | `useMcp` / `manageMcp` | `/api/mcp/:id/(tools\|call\|reconnect)` / other `/api/mcp/*` |
| Admin | `role: "admin"` | `/api/admin/*`, `/api/backups*`, `/api/history/retain`, `/api/vpn*`, non-GET `/api/settings` and `/api/bug-tracker(/connect)` |

A missing grant returns 403 `Permission required: <name>.`. A user with neither studio gets 403 `No studio access assigned. Contact your administrator.`. Routes that name a project (in the path, in a `projectId` query parameter or in a body `projectId`) also need a project assignment, otherwise 403 `Project access has not been assigned. Contact your administrator.`. An unknown run id in `/api/runs/:id` or `/api/manual-runs/:id` returns 404 `Run not found`.

### Revisions and `EDIT_CONFLICT`

- Each project has a `revision`, and every successful save increments it. `PUT /api/projects/:id`, and every requirement write, must send the `revision` it last read. A stale revision returns 409 with `code: "EDIT_CONFLICT"` and saves nothing.
- Each manual run has its own `revision`, which starts at 1 and increments on each write. Stale writes return 409 `EDIT_CONFLICT`.
- Accounts and project assignments have separate revisions (see [Accounts and administration](#accounts-and-administration)).

### Protected values (F1, F2)

Users without the `automation` permission receive redacted copies. This applies to every response that carries a project: `GET /api/state`, `POST /api/projects`, `PUT /api/projects/:id`, every requirement response and every manual-run response. It also applies to every run (`/api/state`, `/api/status`, `/api/runs`, `/api/runs/:id`, run reports, issue drafts). In these copies:

- environment variables and `globalVariables` are empty, and database profile `password` is `""`;
- `dataRows` is `[]`, and `dataRow` and `localValues` are removed;
- local test data entries keep only `name`, `source` and `keepGlobal`, with `value: ""` and `config: {}`;
- steps marked `sensitive` have `value: ""`.

QA saves still keep these fields on disk, because the server merges QA input into the stored project. Run `context` is never returned.

## Shared projects

| Route | Tier | Request | Result |
| --- | --- | --- | --- |
| `GET /api/state` | Q (A with `?workspace=automation`) | none | `{features,aiGenerations,agentDrafts,bugTracker,reportedIssues,projects,runs,nextTestNumber,activeRun,activeRecording,activeDebug}`. Supports a weak ETag and 304 |
| `GET /api/status` | ST | none | `{activeGenerations,runs,nextTestNumber,activeRun,activeRecording,activeDebug}`; `?fields=activity` leaves out `runs` |
| `POST /api/projects` | Create projects | project JSON | 201 normalized project. The creator is assigned unless they are an administrator |
| `PUT /api/projects/:id` | ST | full project + `revision` | 200 project. Send `workspace: "automation"` for an Automation Studio save |

`PUT` replaces the project. The studio permission is checked first (403 `You do not have access to this studio.`), then the revision; no backup is written for a rejected request. A save without `automation` keeps only `name`, `folders`, `suites`, `testPlans` and `requirements`. From tests and prerequisites it keeps only `id`, `name`, `qa`, `folderId`, `suiteId`, `additionalSuiteIds`, `prerequisiteId` and `inTestPlan`, and the stored steps are preserved. There is no `GET /api/projects/:id` and no project delete route.

## Requirements

Every requirement endpoint needs QA permission and access to the project. The server checks QA permission again before saving. Every write must send the current project `revision`, otherwise 409 `EDIT_CONFLICT` `This project changed. Reload the requirement and try again. Your existing cases have been kept.`. Base path: `/api/projects/:id/requirements`.

| Method | Route | Body | Success |
| --- | --- | --- | --- |
| GET | `/api/projects/:id/requirements` | none | `{requirements}` |
| GET | `.../requirements/:requirementId` | none | the requirement |
| POST | `.../requirements` | requirement fields + `revision` | 201 `{project,requirement}` |
| PUT | `.../requirements/:requirementId` | changed fields + `revision` | 200 `{project,requirement}` |
| DELETE | `.../requirements/:requirementId` | `{revision}` | 200 `{project,requirement:null}`. Pending drafts go with it; approved cases and run history stay |
| POST | `.../:requirementId/generate` | `{revision}` | 201 `{project,requirement,addedCount,pendingCount,existingCount}` |
| POST | `.../:requirementId/approve` | `{revision,draftIds,editedDrafts?}` | 200 `{project,requirement,approvedCount}` |
| PUT | `.../:requirementId/drafts/:draftId` | `{revision,name?,qa?,...}` | 200 `{project,requirement}` |
| DELETE | `.../:requirementId/drafts/:draftId` | `{revision}` | 200 `{project,requirement}` |
| DELETE | `.../:requirementId/drafts` | `{revision,draftIds}` | 200 `{project,requirement,deletedCount}` |
| POST | `.../:requirementId/cases/:caseId/generate-steps` | `{revision,workflow?}` | 200 `{steps,expectedResult,assumptions,warnings,revision}` |

DELETE requests still need `Content-Type: application/json`. An unknown requirement returns 404 with `userMessage`. Other method and path combinations return 405 `Unsupported requirement operation.`. Requirement errors add a `userMessage` that the app can show. It never contains submitted values, code paths or raw provider responses.

### Fields

| Field | Rules |
| --- | --- |
| `title` | Required, up to 160 characters |
| `url` | Required. HTTP or HTTPS with no embedded credentials, up to 2000 characters |
| `description` | Up to 10,000 characters. Generation needs a non-blank description |
| `moduleName` | Up to 120 characters |
| `pageMetadata` | `{fields?,controls?,constraints?}`, the same contract as the [local test-case MCP tool](TEST-CASE-MCP.md#input-contract). Empty values, JSON text and nested `pageMetadata` wrappers are normalized. Extra annotations are dropped and noted in `metadataWarnings` |
| `categories` | Any of `Positive`, `Negative`, `Functional`, `Validation`, `Boundary`, `Security`, `Performance` (used by local rules) |
| `generationMode` | `rules`, `qwen`, `ai`, `agent`, `claude` or `chatgpt`. If the API omits it, the default is `rules` |
| `inspectBeforeGeneration` | Boolean, default `false` |
| `agentOptions` | `{enabled,repairLimit (0–3),guidance (≤1000),model (≤120),mode ('',auto,fast,standard,deep,expert)}` |

Server-owned fields: `id`, `draftCases`, `testIds`, `metadataWarnings`, `createdAt`, `updatedAt`, `generation` and `needsGeneration`. A project holds up to 500 requirements and 1000 test cases. A requirement holds up to 1000 pending drafts.

For a new requirement, the app selects the user's own QA engine (`claude` or `chatgpt`) when one is set, otherwise `agent`. Existing requirements keep their saved mode.

### Generation modes

| Mode | Engine | Inspects the URL | Reads project documents |
| --- | --- | --- | --- |
| `rules` | Local rule service. Needs no AI key, browser or MCP | Only with `inspectBeforeGeneration` | No |
| `qwen` | Local Ollama `qwen3:14b` at `http://127.0.0.1:11434/api/chat` | Only with `inspectBeforeGeneration` | Yes (12,000 characters) |
| `ai` | Provider from Model settings. With ReasonX selected it runs the agent pipeline | Yes, except on the ReasonX path | Yes (40,000; ReasonX 700) |
| `agent` | Local ReasonX agent | Only with `inspectBeforeGeneration` | Yes (700 characters) |
| `claude`, `chatgpt` | The signed-in user's own key from My account (`USER_AI_KEY_REQUIRED` when missing) | Always | Yes (40,000 characters) |

Only one generation can run per project at a time, and requirement and automation generation share that limit. A second request returns 409 `Generation is already running for this project. Please wait.`. If the project changes during inspection or generation, the server returns 409 `EDIT_CONFLICT` and saves nothing. Cancel a job with `POST /api/generations/:id/cancel` (`{}`, 202 `{status:"cancelling"}`). A cancelled job reports `GENERATION_CANCELLED`, and existing drafts are kept.

Generated cases go to `requirement.draftCases`. They do not appear in `project.tests`, use no TC numbers, and cannot be selected in plans or runs. Deduplication uses `qa.generationId` across linked and pending cases. For cases without one, it compares the lowercase trimmed name. `existingCount` counts generated cases that were already present. `requirement.generation` records `at`, `fingerprint`, `summary`, `warnings` (up to 30), inspected `pages` (each with up to 30 safe navigation `links`) and, for agents, `agent` and `coverage`.

### Approval and drafts

- `draftIds` must hold 1–1000 unique strings. Each must be a pending draft or an already approved id. Repeating an approval adds nothing and returns `approvedCount: 0`.
- `editedDrafts` is optional. Each entry needs a unique `id` from the selected pending drafts. Edits are validated like draft saves and keep the original `qa.generationId`. One invalid edit or a stale revision changes nothing.
- Approved cases move to `project.tests` with normal TC numbers and `inTestPlan: false`, and are linked through `requirement.testIds`. Folder, suite and prerequisite references that no longer exist are cleared.
- `DELETE .../drafts` with an invalid selection returns 400 `Choose at least one draft to delete.`. If a selected id is not pending, it returns 404 `Draft not found.`. Both responses include `userMessage`.

`generate-steps` previews manual steps for a pending draft or a linked approved case. An unlinked id returns 404. `workflow` (up to 10,000 characters) defaults to the case's `qa.workflowDetails`. The preview saves nothing, approves nothing and runs nothing. Save the result through the draft route or a project save.

## Project documents

Documents belong to a project, not to one requirement. A project holds up to 20 documents of 10 MB each, in PDF, DOCX, XLSX, CSV, TXT or MD format. The routes need QA permission and project access (403 `QA Studio access is required.`). Uploads and deletes do not change the project revision.

| Method | Route | Request | Result |
| --- | --- | --- | --- |
| GET | `/api/projects/:id/documents` | none | `{documents}` |
| POST | `/api/projects/:id/documents` | raw file bytes; header `X-File-Name` (URI-encoded) | 201 `{document,documents}` |
| GET | `/api/projects/:id/documents/:documentId` | none | `{document,text,inline}` (extracted text; `inline` is true for PDFs) |
| GET | `/api/projects/:id/documents/:documentId/content[?download=1]` | none | The original file. PDFs are served `inline` unless `download=1` |
| DELETE | `/api/projects/:id/documents/:documentId` | none | `{documents}` |

A document has the fields `{id,name,size,readable,uploadedAt,uploadedBy}`. `readable: false` means no text could be extracted (for example, a scanned or password-protected file), so AI modes skip it. The upload body is not JSON. The server checks the file extension and the content (`%PDF-` and `PK` signatures, no NUL bytes in text files). A larger file returns 413 `Documents can be up to 10 MB each.`. A duplicate name or a full project returns 400. An unknown document returns 404. Other combinations return 405 `Unsupported document operation.`.

## Test cases

Test cases live in `project.tests` and are saved through the revisioned project `PUT`. `inTestPlan` is a boolean with default `false`. If it is omitted on an existing case, the saved value is kept. Saving a test plan in `project.testPlans` forces `inTestPlan: true` on every case it lists.

```json
{
  "qa": {
    "description": "An active user can sign in",
    "preconditions": "An active test account exists",
    "expectedResult": "The dashboard is displayed",
    "priority": "high",
    "type": "functional",
    "owner": "QA tester",
    "executionMode": "manual",
    "generationId": "TCG-0123456789abcdef01234567",
    "module": "Accounts",
    "category": "Positive",
    "requirementReference": "Active customers can sign in.",
    "workflowDetails": "Sign in with valid credentials. Verify the dashboard is displayed.",
    "assumptions": ["Confirm the test account satisfies the business rules."],
    "testData": [{ "field": "Email", "value": "tester@example.test" }],
    "manualSteps": [
      { "id": "step-one", "instruction": "Submit valid credentials", "expectedResult": "Dashboard appears" }
    ]
  }
}
```

| Field | Values / limits |
| --- | --- |
| `priority` | `critical`, `high`, `medium` (default), `low` |
| `type` | `functional` (default), `regression`, `smoke`, `integration`, `performance`, `security`, `usability` |
| `executionMode` | `manual`, `automation` |
| `category` | `Positive`, `Negative`, `Functional` (default), `Validation`, `Boundary`, `Security`, `Performance` |
| `generationId` | Empty, or `TCG-` + 24 hex characters |
| `assumptions` | Up to 20 strings |
| `testData` | Up to 100 `{field,value}` entries |
| `manualSteps` | Up to 1000 steps, each with a non-blank `instruction` and a unique `id` |
| `createdAt`, `updatedAt` | Set by the server |

If `module`, `category`, `requirementReference`, `workflowDetails`, `assumptions`, `testData` or `generationId` is omitted, the saved value is kept. `test.steps` holds executable automation, and `test.qa.manualSteps` holds manual instructions. A manual run falls back to automation step names when a case has no manual steps.

### Test plans

`project.testPlans[]` entries have the fields `{id,name,testIds,assignedTo,release,status,createdBy,createdAt,type:"Specific"}`. `status` is `open`, `closed` or `archived`. The server sets `createdBy` and `createdAt`. A project can hold up to 1000 plans.

## Run selection

Manual runs, automation runs, preflight, debug and schedule creation all use `selectPlannedTests(project, {testId, testIds, suiteId, planId}, {requirePlan})`. Manual runs pass `requirePlan: true`. Automation runs, preflight, debug and schedules pass `requirePlan: false`.

1. **With `planId`**, the plan must exist (`Unknown test plan`) and be `open` (`Reopen this test plan before execution`). Every plan case must exist in the project (`Configure automation for every case in this test plan first`). `testId` and `testIds` must be inside the plan (`Test case is outside this test plan` / `Test cases are outside this test plan`). Without `testIds`, the selection is the whole plan.
2. `testId` and every id in `testIds` must exist, `testIds` must be a non-empty array (`Choose existing test cases`), and `suiteId` must exist (`Unknown suite`).
3. The selectors intersect. A suite matches a case's `suiteId` or `additionalSuiteIds`. If you omit every selector, the whole project is selected. An empty result returns 400 `No tests selected`.
4. **With `requirePlan: false` and no `planId`**, the selected cases are returned as they are. Automation can run cases that are not in the Test plan.
5. **Otherwise:**
   - With `testId` or `testIds`, every selected case must have `inTestPlan: true`, otherwise 400 `Transfer every selected test case to the Test plan from Test cases before execution.`.
   - Only planned cases are kept, and if none remain the server returns 400 `No test cases in the Test plan for this selection. Transfer cases from Test cases before execution.`. This covers suite-only and whole-project selections.

The QA Studio screens also block unplanned cases before they send a run request. A scheduled run sends only `{projectId,testId}` when it fires, so the case is selected again at that time.

## Manual execution

| Route | Request | Result |
| --- | --- | --- |
| `POST /api/manual-runs` | `projectId`, optional `testId`, `testIds`, `suiteId`, `planId`, `name` | 201 manual run snapshot (`mode: "manual"`, `revision: 1`) |
| `PUT /api/manual-runs/:id/steps` | `revision`, `testId`, `stepIndex`, `status`, optional `actualResult` | 200 updated run |
| `POST /api/manual-runs/:id/complete` | `revision` | 200 completed run |
| `POST /api/manual-runs/:id/cancel` | `revision` | 200 run with status `interrupted` |

- The selection follows [Run selection](#run-selection) with `requirePlan: true`. Every selected case, and its prerequisite, needs steps. Prerequisite steps come first, prefixed `<prerequisite> / `. Case definitions and expectations are copied into the run when it starts.
- Step `status` is `passed`, `failed`, `blocked` or `skipped`. `actualResult` can be up to 10,000 characters. Each write is saved at once.
- A stale `revision` returns 409 `EDIT_CONFLICT`. Writing to a finished run returns 409 `This run is already complete`.
- `complete` needs a result for every step (400 `Record a result for every step before completing the run`). Any failure makes the status `failed`; otherwise any blocked step makes it `blocked`; otherwise any pass makes it `passed`; otherwise it is `skipped`.
- `cancel` marks unfinished steps `skipped` and the run `interrupted`. Finished runs record `finishedAt` and `duration`.
- Manual runs survive restarts and do not hold the browser lock.

Read runs with `GET /api/state`, `GET /api/status`, `GET /api/runs` or `GET /api/runs/:id`.

## Runs, reports and artifacts

| Route | Tier | Request | Result |
| --- | --- | --- | --- |
| `GET /api/runs` | ST | Query: `projectId`, `testId`, `scope=case\|individual-case`, `offset`, `limit` (default 50, max 100), `testName`, `suiteName`, `status`, `from`, `to` | `{total,offset,limit,runs,filters:{testNames,suiteNames,statuses}}` |
| `GET /api/runs/:id` | ST | none | the run, without `context` |
| `DELETE /api/runs/:id` | ST | none | `{deleted:id}`, 409 if active. Removes artifacts no other run uses |
| `POST /api/runs` | A | `projectId`, optional `testId`, `testIds`, `suiteId`, `planId`, `name` (≤120), `trace`, `replay`, or `processId` + `runCount` | 202 run (`mode: "automation"`, or `"process"`). 409 while a run, recording, debug session or VPN request is active. 400 with preflight errors joined by newlines |
| `POST /api/runs/:id/cancel` | A | `{}` | 202 `{status:"cancelling"}` |
| `POST /api/preflight` | A | the selection fields + optional `checkBrowser`, `checkTarget` | `{ok,errors,browser,testCount,stepCount}` + optional `browserAvailable`, `targetStatus`, `targetSkipped` |

A `scope` of `case` or `individual-case` needs `testId`. A date-only `to` covers the whole UTC day.

### Run reports

Every report route accepts `?testId=` to report on one case. If that case is not in the run, the route returns 404 `This test case is not part of the run`.

| Route | Content |
| --- | --- |
| `GET /api/runs/:id/report` | Self-contained HTML. CSP `default-src 'none'; img-src data:; style-src 'unsafe-inline'` |
| `GET /api/runs/:id/report.pdf` | PDF attachment `run-<id>.pdf` (A4) |
| `GET /api/runs/:id/report.json` | Playwright JSON reporter format, attachment `run-<id>.json`. Fields are copied by name, so stored variables, database profiles and dataset values are left out |
| `GET /api/runs/:id/report/interactive` | Monocart interactive HTML report, with up to 30 earlier runs of the same project (or case) as history. Served with CSP `sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; worker-src blob:` (no `allow-same-origin`) |

In Playwright JSON, blocked, interrupted and unfinished tests appear as `interrupted`. The `qa-status` annotation keeps the real status.

### Artifacts

`GET /artifacts/<name>.png` and `GET /artifacts/<name>.zip` (name `[\w-]+`) return `image/png` or `application/zip`. They need studio access and a reference to the file from an assigned project, a visible run or the visible recording, otherwise 403 `Artifact access denied`. A missing file returns 404.

### Execution overview

`GET /api/automation/execution-overview` (tier A) needs `projectId`; without it the route returns 400 `projectId is required.`.

| Query | Meaning |
| --- | --- |
| `from`, `to` | Date range on `startedAt` (`from` must not be after `to`) |
| `status` | `passed`, `failed`, `blocked`, `skipped`, `interrupted`, `running` or `pending` |
| `mode` | `manual` or `automation` |
| `search`, `suite` | Text search over case name, number, assignee and run name; exact suite name (`No suite` for none) |
| `limit`, `offset` | Default 25, max 100; the offset is clamped to the last page |
| `export=csv` | Every matching row as `tc-execution-report.csv` (`text/csv; charset=utf-8`, with BOM) |

The response is `{total,offset,limit,summary:{counts,runs,cases,passRate,averageDuration,suites},suites,rows}`.

## Automation handoff and AI generation

QA Studio opens Automation Studio with `/automation?projectId=PROJECT&testId=TEST`. Optional parameters: `intent=execute` (removed from the URL after it is used), `testIds=ID1,ID2`, `runName`, `planId`, and `view=settings` or `view=ai`. `POST /api/automation/handoff` (A, `{projectId,...}`) returns the handoff result with `created` and `project` (the Automation Studio view of the project). It saves only when it created something.

`POST /api/ai/create` (A) generates automation steps for a new or existing case.

| Input | Rules |
| --- | --- |
| `projectId` | Required |
| `prompt` | 1–12,000 characters |
| `engine` | `studio`, `claude` or `chatgpt`. Defaults to the user's Automation engine, then `studio`. Claude and ChatGPT use the user's own key |
| `testId` | Optional. The case must exist and have `qa.manualSteps`. Its steps are replaced |
| `agentOptions` | Optional `{enabled,repairLimit,guidance,model,mode}`. Agents need the `studio` engine and the ReasonX provider |
| `mcpServerIds` | Up to 10 ids. Needs `useMcp` (otherwise 403), and an unknown id returns 400 |
| `regenerateFrom` | Optional step index. Keeps the steps before it and regenerates the rest; needs `testId` |

The result is 201 `{test,generationId,projectRevision,explanation,warnings,inspection:{title,elementCount,scope},status:"not_run"}`. When agents are enabled it is 201 `{preview,status:"review"}`, and `POST /api/ai/apply` with `{id}` applies the preview. A generation already running for the project returns 409 `GENERATION_IN_PROGRESS`. `POST /api/ai/draft` takes the same inputs and returns a draft without saving.

## Jira bug tracking

| Route | Tier | Request | Result |
| --- | --- | --- | --- |
| `GET /api/bug-tracker` | ST | none | `{provider:"jira",siteUrl,email,projectKey,issueTypeName,hasApiKey,connected,verifiedAt,projectName,accountName}`; never the token |
| `PUT /api/bug-tracker` | Admin | `{siteUrl,email,apiKey,projectKey,issueTypeName}` | Public config. Clears verification. A blank token keeps the saved one only for the same site and email |
| `POST /api/bug-tracker/connect` | Admin | `{}` | Verified public config. Checks the account, project, Browse Projects and Create Issues permissions, and issue type; creates no issue |
| `DELETE /api/bug-tracker` | Admin | `{}` | Empty public config. Reported issue links are kept |
| `GET /api/issues/draft` | ST | Query: `projectId`, `testId`, optional `runId` | `{testId,runId,draft:{summary,stepsToReproduce,results,runDetails},evidence,maxAttachmentBytes,existing}` |
| `GET /api/issues/options` | ST | Query: optional `issueTypeId` | `{issueTypes:[{id,name}],issueTypeId,priority,severity:{inJira,options},canAttach}` |
| `POST /api/issues` | ST | `{projectId,testId,requestId,summary,description?,runId?,issueTypeId?,priorityId?,severity?}` | 201 issue entry; 200 with the earlier entry if that request already created one |
| `POST /api/issues/:requestId/attachments` | ST | Raw file (`Content-Type: application/octet-stream`, `X-File-Name`) or JSON `{evidenceId}` | `{name,attachments}` |

- `requestId` is a UUID generated once per report form. A pending or unconfirmed earlier request returns 409. The connection must be verified first.
- If `description` is omitted, the server builds it from `stepsToReproduce`, `results` and `runDetails`. Summary is limited to 255 characters and description to 20,000.
- Severity goes in a Jira field named Severity when the issue type has one. Otherwise it is added to the top of the description. The default choices are `Critical`, `Major`, `Minor` and `Trivial`.
- `evidence` lists only files from that run: `{id,name,label,size,checked,tooLarge}`. Only the failed step's screenshot starts checked. The id `report` is the HTML run report.
- Attachments: up to 10 MB each (413 above that). Allowed types are png, jpg, jpeg, gif, webp, mp4, webm, mov, txt, log, json, csv, pdf and zip; the only `.html` file allowed is the generated run report. The issue must be `created` and visible to the user, otherwise 404 `Issue not found`. A file name that was already attached is not sent again.
- Created entries hold `{requestId,projectId,testId,runId,status,summary,key,url,createdAt,attachments?}`. `GET /api/state` returns created and visible entries as `reportedIssues`.

## MCP, settings and schedules

- `GET /api/settings` (ST) returns public settings, `userAi`, `bugTracker`, `mcpCatalog` (empty without `manageMcp`) and `studioMcp:{command,args}`. Without `useMcp`, `mcpServers` and `aiMcpServerIds` are empty. Tokens are never returned; authenticated servers expose `hasApiKey`.
- `POST /api/mcp/presets/playwright` and `POST /api/mcp/presets/atlassian` (Manage MCP, `{}`) add the preset once and return settings with `addedServerId`.
- `PUT /api/mcp/servers` (Manage MCP) accepts only `{mcpServers:[...]}`.
- `POST /api/mcp/:id/tools`, `POST /api/mcp/:id/reconnect` and `POST /api/mcp/:id/call` with `{name,arguments}` need Use MCP. An unknown server returns 404 `MCP server not found` (F18).
- `GET /api/schedules`, `POST /api/schedules` with `{projectId,testId,intervalMinutes}` (1–525,600; up to 100 schedules; 201 schedule), and `DELETE /api/schedules/:id` (`{deleted:true}`). An unknown schedule returns 404 `Schedule not found` (F18). All three need tier A.

## Accounts and administration

| Route | Request / response |
| --- | --- |
| `GET /api/account/ai` | ST. `{engines:{qa,automation},models:{claude,chatgpt},hasApiKey:{claude,chatgpt},defaultModels}` |
| `PUT /api/account/ai` | ST. `{engines?,models?,apiKeys?,clearApiKeys?}` |
| `POST /api/account/ai/test` | ST. `{engine:"claude"\|"chatgpt"}` returns `{ok,model,name}` |
| `GET /api/admin/users` | `{users}`, each with account `revision` |
| `POST /api/admin/users` | `{username,name,password,role?,active?,permissions?}` returns 201 user |
| `PUT /api/admin/users/:id` | Account fields + optional `revision`; ends that user's sessions |
| `GET /api/admin/permissions` | `{permissions,adminOnly}` |
| `PUT /api/admin/users/:id/permissions` | Only `{permissions:{qa,automation,createProjects,useMcp,manageMcp},revision}`; ends that user's sessions |
| `GET /api/admin/projects` | `{projects:[{id,name,memberIds,revision,tests,suites,runs}],users,logStartedAt}` |
| `PUT /api/admin/projects/:id/members` | `{userIds,revision}` returns `{memberIds,revision}`; 409 `Project assignments changed. Refresh before saving.` |
| `GET /api/admin/work-log?projectId=&userId=&action=&offset=` | `{entries,total,offset,limit:50,startedAt}`, newest first |

All `/api/admin/*` routes are administrator-only. An account revision is optional. When it is sent it must be a positive safe integer that matches the current revision, otherwise 409. The assignment `revision` is required, and is separate from the project-content revision. Administrators always have project access and do not appear in `userIds`.

## Examples

Sign in and keep the cookie:

```sh
curl -c jar.txt -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YOUR_PASSWORD"}' \
  http://127.0.0.1:3300/api/auth/login
```

Create a requirement, then generate drafts. Read `revision` from `GET /api/state` first, and use the new revision returned in each `project`:

```sh
curl -b jar.txt -H "Content-Type: application/json" \
  -d '{"revision":7,"title":"Sign in","url":"https://app.example.test/login","description":"Active users can sign in with email and password.","generationMode":"rules"}' \
  http://127.0.0.1:3300/api/projects/PROJECT_ID/requirements

curl -b jar.txt -H "Content-Type: application/json" -d '{"revision":8}' \
  http://127.0.0.1:3300/api/projects/PROJECT_ID/requirements/REQUIREMENT_ID/generate
```

Delete two pending drafts:

```sh
curl -b jar.txt -X DELETE -H "Content-Type: application/json" \
  -d '{"revision":9,"draftIds":["DRAFT_A","DRAFT_B"]}' \
  http://127.0.0.1:3300/api/projects/PROJECT_ID/requirements/REQUIREMENT_ID/drafts
```

Start a manual run for a plan, then record a step:

```sh
curl -b jar.txt -H "Content-Type: application/json" \
  -d '{"projectId":"PROJECT_ID","planId":"PLAN_ID"}' \
  http://127.0.0.1:3300/api/manual-runs

curl -b jar.txt -X PUT -H "Content-Type: application/json" \
  -d '{"revision":1,"testId":"TEST_ID","stepIndex":0,"status":"passed"}' \
  http://127.0.0.1:3300/api/manual-runs/RUN_ID/steps
```

Upload a related document, and download a run as Playwright JSON:

```sh
curl -b jar.txt -H "X-File-Name: product-rules.pdf" --data-binary @product-rules.pdf \
  http://127.0.0.1:3300/api/projects/PROJECT_ID/documents

curl -b jar.txt -o run.json http://127.0.0.1:3300/api/runs/RUN_ID/report.json
```
