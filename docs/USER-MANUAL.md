# QA Studio 4.0 user manual

QA Studio 4.0 is a local test management application. It has two connected workspaces that share one server, one set of projects and one identity for each test case:

- **QA Studio** manages requirements, test cases, test plans, manual runs and reports.
- **Automation Studio 4.0** builds, records, debugs, runs and schedules real browser tests for the same cases.

This manual uses the labels shown in the application. A few labels look unusual but are deliberate: **Requirement** (singular, in the QA Studio menu), **Prequenties** (reusable prerequisite steps), **Add File** (creates a folder) and **Add Test Run** (opens Test cases).

## Contents

Getting started

1. [Start QA Studio 4.0](#1-start-qa-studio-40)
2. [First-run administrator setup and sign-in](#2-first-run-administrator-setup-and-sign-in)
3. [Themes, icons and feedback](#3-themes-icons-and-feedback)
4. [Administration: users, permissions and projects](#4-administration-users-permissions-and-projects)
5. [My account: personal AI keys and password](#5-my-account-personal-ai-keys-and-password)

QA Studio

6. [The QA Studio workspace](#6-the-qa-studio-workspace)
7. [Requirements and generated test cases](#7-requirements-and-generated-test-cases)
8. [Related documents](#8-related-documents)
9. [Create and organize test cases](#9-create-and-organize-test-cases)
10. [Reusable preconditions](#10-reusable-preconditions)
11. [Test plans](#11-test-plans)
12. [Run tests manually](#12-run-tests-manually)
13. [Test runs and reports](#13-test-runs-and-reports)

Automation Studio

14. [The Automation Studio workspace](#14-the-automation-studio-workspace)
15. [Create and run your first automated test](#15-create-and-run-your-first-automated-test)
16. [Edit steps and locators](#16-edit-steps-and-locators)
17. [Variables, test data and reusable setup](#17-variables-test-data-and-reusable-setup)
18. [Record Web](#18-record-web)
19. [Replay, debug and suites](#19-replay-debug-and-suites)
20. [Datasets and schedules](#20-datasets-and-schedules)
21. [Process automation](#21-process-automation)
22. [Run history and TC Execution overview](#22-run-history-and-tc-execution-overview)
23. [Generate automation with AI](#23-generate-automation-with-ai)
24. [Validate PostgreSQL data](#24-validate-postgresql-data)
25. [MCP servers](#25-mcp-servers)
26. [OpenVPN](#26-openvpn)
27. [Settings & connections](#27-settings--connections)

Shared features

28. [Reports: HTML, PDF, interactive and Playwright JSON](#28-reports-html-pdf-interactive-and-playwright-json)
29. [Raise bugs in Jira](#29-raise-bugs-in-jira)
30. [Save, export, back up and restore](#30-save-export-back-up-and-restore)
31. [Run tests from the command line](#31-run-tests-from-the-command-line)
32. [Troubleshooting](#32-troubleshooting)

---

## 1. Start QA Studio 4.0

### Normal start

1. Open the QA Studio 4.0 folder.
2. Double-click **Start QA Studio.cmd**. Keep the server running while you work.
3. Open **http://127.0.0.1:3300** for QA Studio, or **http://127.0.0.1:3300/automation** for Automation Studio.

QA Studio 4.0 uses port **3300**, so it can run beside a 3.0 installation on port 3200. Set the `PORT` environment variable before starting if you need a different port. The server listens on `127.0.0.1` only, so other computers cannot reach it.

Closing the browser tab does not stop the server. Schedules, recordings and runs need the server to stay running.

### Restart after an update

Double-click **Restart QA Studio.cmd**. The console asks for your **QA Studio administrator** username and password. Use your application login, not your Windows password. The password is masked. Leave the username blank to cancel; the running server is then left alone.

The helper checks for active work, creates a backup and then restarts. A restart is refused while a test case generation is running.

### First installation on a new computer

Install Node.js 22 or newer and Google Chrome. Then open PowerShell in the QA Studio 4.0 folder:

```powershell
npm install
npm run setup
npm run doctor
npm start
```

- `npm run setup` installs Playwright's Chromium and Firefox. Chromium is also used to make PDF reports.
- `npm run doctor` checks Node.js, the browsers and the configured port.
- `npm start` runs the server in this window. Press **Ctrl+C** to stop it. Finish active work first.
- `npm run launch` starts the server in the background. `npm run launch -- --open` also opens the browser.

The toolbar browser in Automation Studio decides which browser runs tests. Chrome and Edge use the installed desktop browsers. If a browser is missing, install it, for example:

```powershell
npx playwright install chrome
npx playwright install msedge
```

### Data and the credentials key

Your work is stored in the `data` and `artifacts` folders. Secrets in `data` are encrypted with `data/credentials.key`, which is protected for the Windows user who runs the server. Always start QA Studio from that same Windows account. Never delete `credentials.key`: if encrypted data exists and the key is missing or wrong, the server stops with a clear message and changes nothing.

A fresh installation starts with an empty workspace and one sample project, **Getting started**.

## 2. First-run administrator setup and sign-in

### Create the first administrator

The first visit opens **Create your administrator**.

1. Enter a **Display name** and **Username**.
2. Enter a **Password** of at least 12 characters, and repeat it in **Confirm password**.
3. Select **Create administrator**.

There is no default administrator password. You are signed in and taken to Administration.

### Sign in and sign out

Later visits show **Sign in**. Enter the username and password your administrator gave you. After sign-in you go to the area your account can use: administrators to Administration, QA users to QA Studio, automation-only users to Automation Studio.

To sign out, select **Sign out** at the bottom of the sidebar in either studio, or on My account or Administration. A session lasts up to 8 hours. Saving changes to your account, permissions or password signs you out of existing sessions.

## 3. Themes, icons and feedback

### Choose normal or dark mode

Select the bulb button next to the app name. It is on every page, including Sign in, My account and Administration.

- A lit bulb means normal (light) mode. The light theme is ivory, charcoal and gold: a gray frame, an ivory workspace, charcoal buttons and golden highlights for selected items.
- An unlit bulb means dark mode. Dark mode uses an evergreen sidebar. The evergreen sidebar appears only in dark mode.

Your choice is saved in this browser and applies to both studios and to other open tabs. The button also works with Enter or Space.

### Icons, tooltips and loading feedback

Buttons use simple line icons in the same colour as their text, together with a text label or a tooltip. Icon colour does not carry meaning. Hover over or focus an icon-only button to see its description.

A loading spinner appears while the workspace opens. Longer actions show a short status message, such as "Saving your changes" or "Generating test cases", that clears when the action finishes. Success messages close after a few seconds; error messages stay until you dismiss them. Page changes are instant; there are no navigation animations. If your system asks for reduced motion, the remaining small animations, such as dialogs opening, are turned off.

## 4. Administration: users, permissions and projects

Administrators open **Administration** from the account area of either studio sidebar. It has three pages: **Users**, **Permissions** and **Project management**.

### Create a user

1. Open **Users**. Under **Create user**, enter a **Display name**, **Username** (3 to 80 characters) and **Password** (at least 12 characters).
2. Choose the **Role**: **User** or **Administrator**.
3. Under **Studio access**, tick **QA Studio — cases and manual testing**, **Automation Studio — scripts and execution**, or both.
4. Leave **Account enabled** ticked, then select **Create user**.

To change a user, select **Edit** in the user list. Leave **Reset password (leave blank to keep)** empty to keep the password. Untick **Account enabled** to revoke access without deleting the account. At least one active administrator must remain.

### Grant permissions

1. Open **Permissions** and choose the **User**.
2. Tick the permissions to grant:
   - **QA Studio** and **Automation Studio** (studio access).
   - **Create projects**. Needs at least one studio.
   - **Use configured MCP servers** and **Manage MCP connections**. Both need Automation Studio. Managing MCP connections includes using them.
3. Select **Save permissions**.

Removing Automation Studio clears the MCP permissions. Removing both studios clears Create projects. You must tick them again later if needed. Administrators always have full access, so their permissions cannot be edited here.

### Assign projects

A user needs both a studio permission and a project assignment to see a project.

1. Open **Project management** and choose the **Project**.
2. Under **Who can access this project?**, tick **Allow access** for each user.
3. Select **Save project access**. New requests use the new assignments straight away.

**Current effective access** lists who can use the project now. **Open overview dashboard** opens the project in QA Studio.

### Review the working log

The **Working log** on Project management lists project changes and execution activity. Filter it by project, user or action text and select **Filter log**. Use **Previous** and **Next** to page. The latest 10,000 entries are kept. Times use your browser's time zone.

### When two administrators edit at once

If another administrator saved the same user first, you see a conflict message. On Permissions select **Refresh users**; on Users select **Edit** again; on Project management select **Refresh**. Review the saved values, then apply your change again. Refreshing discards unsaved selections.

## 5. My account: personal AI keys and password

Open **My account** from the account area of the sidebar.

### Use your own Claude or ChatGPT key

You can connect personal Anthropic (Claude) and OpenAI (ChatGPT) API keys. These are separate from the administrator's shared Model settings.

1. Under **AI test generation**, enter the **Model** and **API key** for Claude (default `claude-opus-5-5`) or ChatGPT (default `gpt-4.1-mini`). Leave the key blank to keep a saved key.
2. Under **Default engine**, choose the engine for **QA Studio test case generation** and **Automation Studio step generation**. **Studio settings (ReasonX, Qwen or local rules)** means you choose per requirement, and Automation Studio uses its Model settings.
3. Select **Save AI settings**.
4. Select **Test connection** to check that the key can reach the model. It saves the form first and does not generate anything.

**Remove key** deletes a saved key. Keys are encrypted, never shown again and used only for your own generations. API billing is separate from Claude.ai and ChatGPT subscriptions.

### Change your password

Under **Change password**, enter your **Current password**, a **New password** of at least 12 characters and **Confirm new password**, then select **Change password**. This signs you out of all sessions.

---

## 6. The QA Studio workspace

The QA Studio sidebar has: **Overview**, **Requirement**, **Test cases**, **Test plan**, **Test runs**, **Test suites**, **Preconditions** and **Reports**, followed by links to **Automation Studio** and **Settings**. Settings opens Automation Studio's Settings & connections and is shown to administrators only.

The top bar has the **Project** picker, **New project** (with Create projects permission), the workspace search and **Quick start guide**. Press `/` anywhere outside a text field to jump to Test cases search. The footer shows the connection state and **QA Studio 4.0**. If the server becomes unreachable, a banner offers **Retry now** and the last loaded data stays visible.

### Create a project

1. Select **New project** beside the project picker.
2. Enter a **Project name** and, optionally, an **Application URL (optional)**. The URL becomes `BASE_URL` in a new **Test environment**.
3. Select **Create project**. You get access to the new project automatically.

### Overview

**Project overview** shows four figures: **Test cases**, **Need attention** (failed or blocked latest results), **Execution coverage** and **Pass rate**. Below are the cases that need attention first, an **Execution overview** of the latest result per case, and the **Latest test run**. Select a result row, such as "Show 1 failed test cases", to open Test cases filtered by that result.

If you have no projects, the page shows **No project access assigned**. Ask an administrator to assign one.

## 7. Requirements and generated test cases

Use **Requirement** to describe a workflow and generate draft test cases from it.

### Add a requirement

1. Select **Requirement** in the sidebar, then **Add requirement**.
2. Enter the **Requirement title**, the starting **URL** and a **Description** of the workflow, business rules, valid and invalid inputs and expected outcomes.
3. Optionally enter **Module (optional)**.
4. Choose a **Generation method** (see below).
5. Choose the **Test case categories** to generate: Positive, Negative, Functional, Validation, Boundary, Security and Performance. All are selected by default.
6. Optionally tick **Inspect URL before generation (optional)**, and add **Page metadata** under **Fields, controls, and constraints (optional)**.
7. Select **Save requirement** to keep the draft, or **Generate Test Cases** to save and generate.

The status beside the buttons reads **New requirement**, **Unsaved changes** or **Saved requirement**. While generation runs, the form is locked and a timer shows progress. Select **Cancel generation** to stop it.

### Generation methods

| Method in the list | What it uses |
| --- | --- |
| **Use ReasonX agents** | Local ReasonX agents analyse acceptance criteria, design cases, repair invalid drafts and check coverage. An administrator must select ReasonX and save its API key in Model settings. Options are under **ReasonX agent options**: **Agent model**, **Agent reasoning mode**, **Repair limit** (0 to 3, default 1) and **Agent workflow guidance (optional)**. |
| **Claude — my API key** / **ChatGPT — my API key** | Your personal key from My account. "(not connected)" is shown when you have not saved a key. The URL is inspected when provided. |
| **Qwen3 14B — local AI** | `qwen3:14b` running in Ollama on this computer. No key is needed. |
| **Local rules — no AI key required** | Built-in rules that turn explicit constraints into cases. No AI model, key or network is used. |
| **AI - configured provider** | Shown only on requirements already saved with this method. It uses ReasonX agents when the administrator's Model settings provider is ReasonX. With any other provider (Gemini, OpenAI, Groq or NVIDIA) it uses that provider. |

Which method is selected first:

- A new requirement form selects your QA default engine from My account when it is Claude or ChatGPT. Otherwise it selects **Use ReasonX agents**.
- A saved requirement keeps its saved method. A requirement created through the API without a method uses **Local rules**.

AI generation can take several minutes. Selected categories guide ReasonX agents and local rules.

### Page metadata and local rules

Local rules generate cases from explicit statements. For example, `Email is required. Password must have 8 to 64 characters.` produces cases for a missing email and for password lengths at and beyond those limits. You can also supply fields, controls and constraints as JSON in **Page metadata**, for example:

```json
{"fields":[{"name":"Email","type":"email","constraints":{"required":true}}],"controls":[{"name":"Save","type":"submit"}]}
```

If the description and page metadata disagree, generation continues and shows reconciliation notes. Rules in the description take priority. See [TEST-CASE-MCP.md](TEST-CASE-MCP.md) for the supported rule forms.

**Inspect URL before generation** opens the URL in the project's browser and reads the starting page and up to five ordinary linked pages on the same site. It does not fill or submit forms.

### Review and approve drafts

Generated cases appear under **Test cases** on the requirement page as **Pending approval** drafts. Only approved cases appear on the main Test cases page.

The table shows **TC No.** ("Draft N" until approved), **Title**, **Steps**, **Expected result** and **Approval**. Use the category filter to narrow the list, and **Export CSV** to download it.

To approve one draft:

1. Select **Approve** on its row. The **Review and approve test case** popup opens.
2. Check the details, numbered steps and expected results. Edit anything that is wrong.
3. If detailed steps are missing, add optional **Workflow details (optional)** such as `Sign in with valid credentials. Click Leave on the Dashboard. Verify the Leaves page is displayed.`, then select **Generate test steps**. Review the result.
4. Select **Confirm approval**. The case is saved, gets its permanent TC number and appears on Test cases. **Cancel** leaves the draft unchanged.

Other options:

- Select a draft's title to open **Review test case**, edit it and select **Save changes**. The draft stays pending.
- Tick drafts and use **Approve selected (N)** or **Delete selected (N)**.
- **Approve shown drafts** approves every pending draft that matches the current category filter, without a popup.
- **Delete** removes one draft.

Generating again keeps matching drafts, approved cases and your edits. If you change a requirement after generating, a notice says it changed; generate again to add missing scenarios. **Delete requirement** removes its pending drafts but keeps approved cases and their run history.

Generated cases are unexecuted scenarios. They do not count as passed tests and do not claim complete coverage. **Requirement coverage** and **Inspection and coverage** panels show which criteria the drafts map to and which pages were inspected.

## 8. Related documents

You can upload documents about the product, such as specifications, user guides or business rules. AI generation reads them for every requirement in the project.

### Upload documents

1. On the **Requirement** list or a requirement form, select **Related Document**.
2. If the project has no documents, **Upload related documents** opens. Select **Choose files or drop them here**, or drag files onto the box.
3. Check the chosen files, remove any you do not want, then select **Upload**.

Limits:

- PDF, DOCX, XLSX, CSV, TXT or MD only.
- Up to 10 MB per file.
- Up to 20 documents per project.

**Before you upload:** document text is sent to the AI engine selected on the requirement. Claude, ChatGPT and other cloud engines receive it over the internet, so check documents for confidential data first.

### Manage documents

Once the project has documents, **Related Document** opens **Related documents (N)**. For each document you can:

- **Preview** it. PDFs show in their original layout. Other types show as text. Select **Download** to open the original.
- **Delete** it. The AI stops using it for new generations. Cases already generated are kept.

Select **Upload more** to add files.

### How generation uses documents

- Every AI method reads the documents automatically: ReasonX agents, Claude, ChatGPT, Qwen and AI - configured provider. **Local rules** does not use them.
- Automation Studio's AI Assistance and Auto generator do not read them.
- Each engine has a text limit: 40,000 characters for Claude, ChatGPT and the Model settings providers, 12,000 for Qwen and 700 for ReasonX agents. If a document does not fully fit, the generation notes name it. Put the rules that matter most in the requirement description.
- Document text is marked as untrusted in prompts, because a document can contain text written to steer the AI.
- Scanned or password-protected files are kept for preview but marked **AI cannot read this file**. There is no text recognition (OCR).

Documents belong to the project and are stored encrypted in `data/project-documents`. Workspace backups do not include them, so back up the whole `data` folder.

## 9. Create and organize test cases

### Create a test case

1. Open **Test cases** and select **Create test case**.
2. Enter a **Test case title** and, optionally, a **Description**.
3. Choose **Priority**, **Test type**, **Folder**, **Test suite**, **Assignee** and **Preferred execution** (**Manual testing** or **Automation Studio**).
4. Optionally add **Module**, **Category**, **Requirement reference**, **Test data (JSON array)**, **Assumptions (one per line)**, **Preconditions** and a **Reusable precondition**. Use dummy values for credentials in test data.
5. Under **Test steps**, enter each **Action / instruction** and its **Expected result**. Use **Add step** for more. Reorder with the drag handle or the arrow buttons. Tick steps and use **Copy selected (N)** to duplicate them.
6. Add an **Overall expected result** if useful, then select **Create test case** or **Save changes**.

The case opens on its details page. Choosing **Automation Studio** as preferred execution and saving opens the case in the automation editor.

### Test case details

The details page shows the overview, preconditions, case context, steps and a **Details** list with **Last run status**, the latest run and **View latest run**. From here you can:

- **Edit case**.
- **Run test case**. This is available only after the case is in a test plan.
- **Copy test case**. The copy is not in any test plan.
- **Open in Automation Studio** to automate the case.
- **Report issue** when Jira is connected (see [Raise bugs in Jira](#29-raise-bugs-in-jira)).
- **Delete test case**. Run results stay in history.

### Find cases

Search by title, ID, description or assignee. Under **Filters**, filter by **Result**, **Priority**, **Category** and **Suite**. **Clear filters** resets them. The list shows 50 cases per page. **Export CSV** downloads the cases that match the current filters.

### Folders

The folder tree is on the left under **Browse folders**.

- Select the **+** beside the tree heading or a folder. **Add File** creates a folder (choose its parent to nest it). **Add Test Case** creates a case in that folder.
- Expand or collapse folders with their arrows. Selecting a folder shows its cases and those in its subfolders. **All test cases** clears the folder filter; **Unfiled** shows cases without a folder.
- In the case editor you can choose **＋ Add folder…** in the Folder list to create a folder on the spot.

Folder paths read like `Release / Login / Errors`. Automation Studio shows the same folders.

### Suites

Open **Test suites** and select **Create suite**. Assign cases to a suite in the case editor. **View cases** filters Test cases by the suite. **Run suite** runs the suite's cases that are in a test plan. **New folder** on this page creates a folder.

## 10. Reusable preconditions

A reusable precondition is a shared setup, such as signing in, that many cases can use.

1. Open **Preconditions** and select **New precondition**.
2. Enter a **Precondition name**, a description and its **Setup steps** with expected results. Select **Create precondition**.
3. Link it to a case: in **Edit case**, choose it under **Reusable precondition**, or select **New precondition** on the case details page to create and link one at once.
4. For automated setup, select **Configure in Automation Studio**. This opens the same item under **Prequenties** in Automation Studio, where you add browser actions.

Manual runs show the precondition's steps before the case steps. Automated runs execute its browser steps first, in the same browser session. Written instructions alone do not run automatically. Deleting a precondition unlinks it from its cases; past run results are kept.

## 11. Test plans

A case must be in a test plan before you can run it from QA Studio.

### Create a plan

1. On **Test cases**, tick the cases to include.
2. Select **Transfer to Test plan**.
3. Enter a **Test plan name**, and optionally **Assign to**, **Release** and status.
4. Select **Save test plan**.

### Work with plans

**Test plan & results** lists each plan with its creator, case count, created date and a progress bar for its latest run.

- Filter by status (Open is shown by default), release, **Search By TestRun**, **Assign to** and **Selection type**. **Clear filters** resets everything, including status.
- Select the case count or title to see the cases.
- Row actions: run (open plans with cases only), results of the latest run, copy, edit and delete.
- **Archive** sets plans to archived. **Export** and **Date Export** download plans as CSV.
- **Add Test Run** opens Test cases, where you select cases for a new plan.

A case can be in several plans. Deleting a plan keeps its cases and run history. Automation Studio runs cases directly and does not need a test plan.

## 12. Run tests manually

1. Start a run in one of these ways:
   - Select the run action on a test plan row.
   - Open a planned case and select **Run test case**.
   - Select **New test run** on Overview or Test runs.
   - Select **Run suite** on Test suites.
2. In **Start a test run**, check the **Execution name** and cases, choose **Manual testing**, then select **Start execution**.
3. For each step, do the instruction in the application under test. Type what happened in **Actual result / notes**, then select **Pass**, **Fail**, **Block** or **Skip**.
4. When every step has a result, select **Complete run**. To stop early, select **End run**: recorded results are kept, unfinished steps are marked skipped and the run is marked interrupted.

Each result saves immediately. A run keeps a snapshot of the case steps as they were when it started, so later edits do not change it. Active manual runs survive a server restart.

Choosing **Automation Studio** instead opens the cases in Automation Studio. Cases with automation steps start running; cases without them open in the editor for you to configure.

## 13. Test runs and reports

**Test runs** lists manual and automated runs with mode, result, progress and start time. Select a run to open it. The run screen lists the cases on the left and each step's result, notes, errors and screenshots on the right. While an automated run is active, **Cancel run** stops it.

When a run has finished, the run screen offers **HTML report**, **PDF report**, **Interactive report** and **Playwright JSON**.

**Reports** shows summary figures and the same runs with **HTML**, **PDF**, **Interactive** and **JSON** links. **Export summary** downloads a CSV of the loaded runs.

Both lists start with the most recent runs. Select **Load older runs** to load more. See [Reports](#28-reports-html-pdf-interactive-and-playwright-json) for what each report contains.

---

## 14. The Automation Studio workspace

Open Automation Studio from the QA Studio sidebar or at `http://127.0.0.1:3300/automation`.

### Top bar

| Control | Purpose |
| --- | --- |
| **Workspace** | Show or hide the sidebar. Your choice is remembered. |
| **PROJECT** | Switch project. |
| **ENVIRONMENT** | Choose the variable set for the application under test. |
| **BROWSER** | Choose Chrome, Firefox or Edge. |
| **AI Assistance** | Describe a workflow and generate a test. |
| **New project** | Create a project (with Create projects permission). |
| **Save** (Ctrl+S) | Save your edits. |
| **Run suite** | Open Suites. |
| **Stop debug** | Shown during a debug session. |
| **Run test** | Run the selected test. |

### Sidebar

**TC Execution overview**, **Test cases**, **Suites**, **Run history**, **Process automation**, **Prequenties**, **Object repository**, **PostgreSQL**, **Environments & globals** and **MCP servers**. At the bottom are your account, **Back to QA Studio**, **OpenVPN** and **Settings & connections**. OpenVPN and Settings are for administrators. MCP servers needs the MCP permission.

The footer shows the save state (**Saving…**, **Unsaved changes** or **All changes saved**), the connection state and **Automation Studio 4.0**.

### Saving

Edits need **Save** or **Ctrl+S**. Running, debugging, recording, scheduling and generating save first. If another tab saved the project first, you see a conflict message: export your edits, reload and reconcile.

### Test cases list

**Test cases** shows the same cases as QA Studio. Choose a folder or **Unfiled**, search, and filter by result, priority and suite. Pages hold 10, 25, 50 or 100 cases (25 by default).

- Select a title to open it in the **Test editor**.
- Row actions: **Run**, **Copy**, **Move** and **Delete**. Deleting an automation case keeps the QA Studio case and its run history.
- Tick cases and select **Run selected**. Every selected case needs automation steps.
- **Create test case** and **New folder** add items.

Automation Studio has no test plan page; it runs cases directly.

## 15. Create and run your first automated test

The **Getting started** project contains **Complete the welcome form**, which tests the built-in demo page.

1. Open **Environments & globals** and check that the **Local** environment has:

   ```json
   { "BASE_URL": "http://127.0.0.1:3300/demo" }
   ```

2. Select that environment in the top bar, and choose **Chrome**.
3. Open **Test cases** and select **Complete the welcome form**. Its steps are:

| Step name | Action | Locator type | Locator / input | Value source | Value / expected / URL |
| --- | --- | --- | --- | --- | --- |
| Open the demo application | Navigate | | | Environment | `BASE_URL` |
| Enter your name | Fill input | Label | `Your name` | Static value | `Alex` |
| Submit the form | Click | Exact text | `Get started` | | |
| Check the welcome message | Assert text | Element ID | `message` | Static value | `Welcome, Alex!` |

4. Select **Check readiness**. Fix any reported browser, variable or URL problem. Readiness checks are preliminary; passing them does not guarantee every step passes.
5. Select **Run test**.
6. Open **Run history** and expand the run. All four steps should pass.
7. Select **Replay** to watch the same test in a visible browser.

To build your own test, select **Create test case**, add steps with **Add step**, and save.

## 16. Edit steps and locators

### The Test editor

The editor shows the case's QA Studio requirements in a collapsible panel, the **Test case details** (name, **Folder**, **Suite** and **Prequenties**) and the **Test steps** table. Steps run from top to bottom. Drag a step or use the arrow buttons to reorder. Row buttons also save a locator to the repository, open step settings, duplicate and remove. A test can have up to 100 steps added in the editor; recordings and imports allow up to 1,000. The table shows 10 steps per page by default.

Editor actions: **Check readiness**, **Local Test Data**, **Test options**, **Schedule**, **Record Web**, **Replay**, **Debug test**, **Duplicate** and **Delete**. The latest result badge and, for failed results, **Raise bug** appear at the start of the row.

If the case has QA Studio instructions, each step has a **QA Studio requirement** list. Mapping a step sets its name to that instruction. Mapped names are read-only here; edit the instruction in QA Studio.

### Locator types

| Locator type | What to enter | Example |
| --- | --- | --- |
| CSS selector | A CSS selector | `#email` or `[data-testid="submit"]` |
| XPath | An XPath expression | `//button[@id='submit']` |
| Element ID | The id, without `#` | `message` |
| Name | The `name` attribute | `email` |
| Exact text | The element's exact visible text | `Get started` |
| Label | The form label text | `Your name` |
| Placeholder | The input placeholder | `Enter your name` |
| Test ID | The test ID value | `submit-button` |
| Custom | A Playwright selector passed as written | `text=Sign in` |
| Repository object | A saved object from the Object repository | Choose it from the list |

There is no role locator type. Choose a locator that matches exactly one element. During debugging, **Check next locator** shows how many elements match.

CSS, XPath and Custom locators can contain the placeholder `XXX` (or the older `{{value}}`). A replacement box then appears for the value to use in that step.

### Actions

| Action | Value or expected result |
| --- | --- |
| Navigate | Full URL, or a variable that holds it. |
| Click / Double click / Hover | No value. |
| Fill input | Text to enter. |
| Select option | The option's value. For several options, use Step settings. |
| Check / Uncheck | No value. |
| Press key | A key such as `Enter`, `Tab` or `Control+A`. |
| Upload file | Full path of a file on the Studio computer. |
| Set date / Set date & time | For example `2026-10-01` or `2026-10-01T09:30`. |
| Assert visible / Assert hidden | No value. |
| Assert text | Text the element should contain. |
| Assert value | The exact expected input value. |
| Assert URL | The exact expected page URL. |
| Assert heading | Expected heading text. |
| Validate UI | Rules such as `Email = a@b.com; Name ~ Ann; Terms : checked`. |
| Wait | Delay in milliseconds. Prefer an assertion when waiting for a result. |
| Screenshot | Captures the page. |
| Database query / Validate database | See [PostgreSQL](#24-validate-postgresql-data). |

### Step settings

Select a step's settings button to set:

- **Element label**.
- **Timeout override (ms)**: 100 to 120,000.
- **After action**: **Automatically wait for page activity**, **Wait for redirect** or **Continue without an extra wait**. With Wait for redirect you can enter **Expected destination URL (optional)**, such as `**/dashboard`. If no redirect happens, the step fails with a timeout.
- **Browser tab index (first tab is 0)**.
- **Page URL (context)** and **Container selector (optional CSS)**.
- **Frame selector path**: a JSON array such as `["#outer-frame", "#inner-frame"]`.
- **Multiple selection values**: a JSON array such as `["red", "blue"]`.
- **Sensitive input**: protects the stored value and masks the element in screenshots.

### Locator focus and screenshots

During runs, replay and debugging, the target element is scrolled into view and outlined in red before its action. Each visible target gets a **Locator screenshot**, and each step gets a screenshot afterwards. Passwords and sensitive fields stay masked.

### Object repository

**Object repository** stores reusable CSS and XPath locators, grouped by test case. Each case owns its own mappings, so editing one does not change another case.

- **Add object**: choose the **Test case**, **Locator type** and **Locator template**. The element name is generated.
- **Convert HTML**: paste an element's HTML, such as `<button id="submit">Continue</button>`, and select **Create locator**.
- **Save locator to repository** on a CSS or XPath step converts it into a repository reference.
- **Remove** is blocked while a step uses the object.

Templates such as `[name="XXX"]` are shared as **genericCSSNameOnly**, and `[id="XXX"]` as **genericCSSIdOnly**. Recordings save their CSS and XPath locators to the repository automatically.

## 17. Variables, test data and reusable setup

### Environments and globals

Use environments for values that change between targets, such as test and staging URLs. Use globals for values shared by every environment in the project.

1. Open **Environments & globals**. Select **New environment**, or **Edit** on an environment, or **Edit variables** on Global variables.
2. Enter the variables as a JSON object of strings, for example `{"BASE_URL": "https://your-app.example", "USERNAME": "test-user"}`.
3. Select **Use environment** (or pick it in the top bar).
4. In a step, set **Value source** to **Environment** or **Global variable** and enter only the name, such as `USERNAME`. Do not type `${USERNAME}`.

Names are case-sensitive. AI generation receives variable names, not values.

### Local Test Data

Select **Local Test Data** in the editor to manage variables for one test.

1. Select **Add variable** and enter a **Variable name** such as `CUSTOMER_EMAIL`.
2. Choose the **Value source**:

| Source | Configuration |
| --- | --- |
| Manual value | Enter the text. |
| Random | UUID, letters and numbers, whole number, email (`@example.test`) or date. |
| Database | A PostgreSQL connection, a SELECT query, a column and a row. |
| Excel / CSV / JSON | Upload a file (up to 1 MB) or enter a path on the Studio computer, then choose a worksheet, column and row. |
| Global variable | A project global, read at run time. |
| Environment variable | A variable from the active environment. |

3. Select **Preview value** to check it. Preview does not change globals.
4. Optionally tick **Keep in global variable** to copy the value into a project global before the steps run.
5. Select **Save variable**, then **Back to test editor**.
6. In a step, set **Value source** to **Local Test Data** and choose the variable.

Values are collected fresh once per execution, including replay, debug, schedules, CLI runs and each dataset row. Choose **Random data row** for a different row each time. Files can have a header and up to 100 data rows and 100 columns; the first data row is 1. Database results are limited to 25 rows, 40 columns and 128 characters per cell. Save `.xls` workbooks as `.xlsx` first.

An uploaded file is a copy: upload it again after editing the original. A file path is read again at every run. Local data is encrypted in local storage. Project export keeps the variable names but clears their sources.

### Prequenties: reusable prerequisite steps

1. Open **Prequenties** and select **New prerequisite**.
2. Select **Edit steps** and add its steps, such as navigation and sign-in.
3. Open a test and choose the prerequisite in its **Prequenties** list.
4. Save and run.

The prerequisite runs before the test in the same browser session. Each test starts with a fresh browser context, so do not rely on another test having signed in. QA Studio preconditions configured for automation appear here.

## 18. Record Web

### Record a workflow

1. Select the test to record into, and the environment and browser. Connect your VPN first if needed.
2. Select **Record Web**, check the **Starting URL**, then select **Start recording**.
3. Use the visible browser normally: click, type, choose options and submit forms. Each interaction is saved automatically.
4. Use **Pause** for actions you do not want to record, and **Resume** to continue. Restore the page state before resuming.
5. Select **Stop and review**.
6. Check each step's **QA Studio requirement** mapping. Matching requirements are added automatically; you can change them or choose **Not mapped**.
7. Select **Replace test steps** or **Append to test**. Appending also adds the recording's starting Navigate step; remove it if not needed.
8. Review the steps and select **Replay**.

**Discard recording** deletes the recording draft.

### Recording on a hosted site

When Studio runs on a server without a screen, such as Render, the recording browser runs on the server and Start recording opens it in a separate **recording window**. Allow pop-ups for the site if your browser asks; if the window is blocked or closed, select **Open recording window** on the Record Web page. Click in the window to use the page, scroll with the mouse wheel, and type after clicking it. Ctrl+V pastes text. Everything you do there is recorded as in a visible browser, and the window closes when the recording stops. Replay and Debug run without a window on such a server; follow them through the step screenshots.

Each recorded click outlines the clicked element in red for a moment, in the visible browser and in the recording window, so you can see which element the step uses.

### Record expected results

A click alone does not prove the application worked. Add a check:

1. Change **Recording mode** to **Verify visible**, **Verify text** or **Verify field value**.
2. Click the element in the recording browser. A red outline and a message confirm the capture. The click does not trigger the element.
3. Switch back to **Record actions**.

Each verification saves a screenshot with the target outlined. Open it with **View captured screenshot**.

### Passwords and files

- Password fields become environment references such as `RECORDED_PASSWORD`. Set them in the environment before replay.
- File inputs become references such as `RECORDED_FILE_1`. Set them to a full file path on the Studio computer.
- Other typed values are recorded as written. Review them before sharing a test.

### Limits

Recordings survive a page refresh and a server restart (the browser session does not). Up to 1,000 steps. Frames, new tabs, open shadow DOM and multiple selections are supported. Closed shadow roots, operating-system dialogs and drag-and-drop are not. Address-bar navigation and Back/Forward are not recorded; add **Navigate** steps yourself.

## 19. Replay, debug and suites

| Control | Use it to |
| --- | --- |
| **Check readiness** | Check configuration, browser and the starting URL before running. |
| **Run test** | Run normally. |
| **Replay** | Watch the saved steps in a visible browser, in slow motion with red outlines. |
| **Debug test** | Step through one action at a time. |
| **Run suite** / **Run this suite** | Run every test in a suite. |

Only one recording, debug session or run can be active at a time.

### Replay

Replay saves a new result marked as a replay. Stop it with **Stop replay** in Run history.

### Debug a failing step

1. Select **Debug test**. A browser opens and **Stop debug** appears in the top bar.
2. Select **Step to next action →** to run the next step.
3. Inspect the browser and the screenshot in Studio.
4. Before a step with a locator, select **Check next locator** to see how many elements match.
5. To fix a step, stop debugging, edit and save, then debug again. A session uses the test as it was when it started.
6. Finish with **Stop debugging** or **Close debug session**.

### Suites

Open **Suites** and select **New suite** (or the + in the sidebar). Assign a test with its **Suite** list, or add more suites in **Test options**. Select **Run this suite** to run it. Removing a test from a suite does not delete the test.

## 20. Datasets and schedules

### Run a test with several data rows

Open **Test options** and enter a dataset as a JSON array of objects with text values:

```json
[
  { "NAME": "Alex", "GREETING": "Welcome, Alex!" },
  { "NAME": "Sam", "GREETING": "Welcome, Sam!" }
]
```

Or enter CSV in **Optional CSV dataset (overrides JSON)**. In your steps, set **Value source** to **Data row** and enter the column name. Each row runs in a fresh browser context and gets its own result. Up to 100 rows.

**Test options** also holds the **Default project timeout (ms)**, **Additional suites** and **Save and run with trace**. Traces can contain page content and network data.

### Schedule a test

1. Select the project, environment, browser and test.
2. Select **Schedule**, enter **Run every (minutes)** (1 to 525,600), then **Enable schedule**.
3. To review or remove schedules, open **Settings & connections** and select **Schedules**, then **Remove schedule**.

The server must be running. A busy session delays a scheduled run. After a restart, an overdue schedule runs once. To change a schedule, remove it and create a new one. Connect any VPN yourself.

## 21. Process automation

Process automation records a repetitive business process once and runs it many times.

1. Open **Process automation** and select **New process**.
2. Select **Record** and record the flow in the browser. Select **Stop and review**, then **Replace process steps** or **Append to process**.
3. Set **Run count** (1 to 1,000).
4. Select **Run N times**.

Without Repeat marks, the whole process runs the chosen number of times, each in a fresh browser session. To repeat only part of it, select **Edit steps** and tick **Repeat** on a block of adjacent steps. The steps before the block run once, the block repeats, and the steps after it run once at the end, all in one browser session. If a step fails, the rest are skipped. Process runs appear in Run history.

## 22. Run history and TC Execution overview

### Run history

**Run history** lists the project's runs, newest first. Expand a run, then a test, to see steps, errors, screenshots, **Download execution trace** and **Browser diagnostics**.

- Filter by **From date**, **Through date**, **TC name**, **Status** and **Suite name**, then select **Apply filters**. **Clear filters** shows everything. Dates cover whole days in your local time zone.
- Use **Previous**, **Next** and **Runs per page** (10, 25, 50 or 100). **Refresh** reloads.
- A running run refreshes every few seconds. Expand it to use **Stop run** or **Stop replay**.
- Each run has **HTML report**, **PDF report**, **Interactive report** and **Playwright JSON**.
- Failed, blocked or interrupted tests show **Raise bug**.

### TC Execution overview

**TC Execution overview** gives detailed results for each case across the project's manual and automated runs.

1. Set **From date**, **Through date**, **Test case** (name, TC ID, assignee or run), **Status**, **Execution mode** and **Suite**.
2. Select **Apply filters**.

The summary shows **Case executions**, **Runs**, **Pass rate** and **Average duration**, a status breakdown and a suite table. Pass rate leaves out pending and running executions. Each result opens to show steps, expected and actual results, screenshots and traces, with **Case HTML report**, **Case PDF report**, **Case interactive report**, **Case Playwright JSON** and **Full run report**. The list shows 25 results per page.

Select **Export CSV** to download every execution that matches the filters. **Refresh** reloads; the page also refreshes itself every 15 seconds.

## 23. Generate automation with AI

### Choose the engine

An administrator sets the shared provider in **Settings & connections** (see [Model settings](#model-settings)). Each user can also use their own Claude or ChatGPT key from My account.

### AI Assistance: create a new test

1. Select the environment and browser. Configure `BASE_URL` or include the full starting URL in your description.
2. Select **AI Assistance** in the top bar.
3. Choose the **Generation engine**: **Studio model settings**, or Claude or ChatGPT with your own key.
4. Describe the workflow and expected result in **Workflow description**, or start from **Welcome form**, **Sign-in flow** or **Search results**.
5. Select **Generate test** (or press Ctrl+Enter).
6. Select **Open test editor**, review the steps, then **Run test**.

Example:

> Open BASE_URL, fill the Your name field with Alex, click Get started, and verify that the greeting contains Welcome, Alex!.

### Auto generator: automate an existing QA case

When a case has QA Studio instructions but no automation steps, or its instructions changed, the requirements panel in the editor shows **Auto generator**. It builds the prompt from the case's steps and expected results and keeps the case number and links. Select **Generate steps**.

### ReasonX agents

When the provider is ReasonX, the page shows **ReasonX automation agent** with its status, **Check connection**, and a **Reasoning mode** choice (Auto, Fast, Standard, Deep, Expert). Administrators can select **Turn on ReasonX** to start it, or **Use ReasonX agents** to switch the provider. Under **ReasonX agent workflow** you can set the model, mode, repair limit and guidance, then **Save agent options**. An agent draft is shown for review first: select **Apply reviewed draft** to save it.

With Claude or ChatGPT, the ReasonX review stage is not used. Studio still inspects the starting page and checks locators before saving.

### Context tools

Under **Context tools**, tick MCP servers whose read-only tools may give context, such as Jira or Confluence. Up to 25 read-only tools are used, with up to three tool calls. Tool output is treated as untrusted data.

### What to expect

Studio inspects the starting page in a fresh browser session, without your normal sign-ins, and does not fill or submit forms. Pages after sign-in or search are not inspected, so check those locators by running or debugging. A generated test has not been run. Only one generation per project runs at a time. Use variable names, not real passwords, in descriptions.

## 24. Validate PostgreSQL data

1. Open **PostgreSQL** and select **Add connection**.
2. Enter the name, host, port, database, username, password and **TLS** setting (**Disabled** or **Required (verify certificate)**).
3. Save, then select **Test connection**.
4. Select **Use** to make it the project's active connection.
5. Select **Query** to try a read-only SELECT, for example `SELECT id, name FROM test_users ORDER BY id`.

In a test, **Database query** runs a query and **Validate database** compares the result with expected rows. Enter the SQL as the step value. For validation select **Set expected results** and enter a JSON array of string arrays:

```json
[["1", "Alex"], ["2", "Sam"]]
```

Use `ORDER BY` for a stable row order and `"NULL"` for null cells. Use a read-only database account. Omit trailing semicolons and do not use WITH queries.

## 25. MCP servers

MCP servers give Studio extra tools, such as browser control or Jira access. They are separate from Studio's own recorder and runner. You need **Use configured MCP servers** to use them and **Manage MCP connections** to add or change them.

### Recommended servers

- **Add & connect Playwright** sets up Microsoft Playwright MCP with a headless, isolated Chrome session. Google Chrome must be installed.
- **Set up Atlassian** sets up Atlassian MCP for Jira and Confluence. Choose **Basic** with your Atlassian email and a scoped API token, or **Bearer** with a service account key. Your Atlassian administrator must allow API-token access.

### Add your own server

1. Select **Add server**.
2. Choose **Transport**: **Local process (stdio)** with an executable and JSON arguments, or **Streamable HTTP** with an endpoint and authentication (none, Basic or Bearer). Authenticated remote endpoints must use HTTPS.
3. Save, then select **Connect & discover**.
4. Select **Open** on a tool, enter JSON arguments and select **Call tool**.

**Reconnect** starts a fresh connection. Tokens are encrypted and never shown again. Stdio servers do not keep saved environment variables; they use the environment Studio was started in. Legacy SSE endpoints are not supported.

### Connect an external agent

The **Connect an external agent to this Studio** panel shows a JSON configuration that lets an MCP client use Studio's own tools through `npm run mcp`.

## 26. OpenVPN

Studio uses an existing **OpenVPN Connect** profile on Windows. Import the profile in the OpenVPN Connect desktop app first, under the same Windows user that runs Studio.

1. Finish any recording, debugging or run.
2. Open **OpenVPN** and select **Refresh profiles**.
3. Choose the profile under **Existing VPN profile** and select **Save profile selection**.
4. Select **Connect saved profile**.
5. Complete any prompts in OpenVPN Connect and check that it shows **Connected**.

Studio stores the profile choice, not your VPN password. A request shown in Studio does not prove the tunnel is up; check OpenVPN Connect. **Disconnect VPN** disconnects the active tunnel, even one started outside Studio. If OpenVPN Connect is installed elsewhere, set `OPENVPN_CONNECT_PATH` before starting Studio.

## 27. Settings & connections

**Settings & connections** is for administrators. Its header has **OpenVPN settings**, **Export project**, **Import project**, **Create backup**, **Restore projects**, **Schedules** and **Clean history**.

### Model settings

1. Choose the **LLM provider**: **Google AI Studio · Gemini free tier**, **OpenAI**, **Groq**, **NVIDIA API Catalog** or **ReasonX - Local model**.
2. Enter the **Model** ID. Defaults: `gemini-3.8-flash`, `gpt-4.1-mini`, `openai/gpt-oss-20b` (Groq), `meta/muse-glimmer-30b` (NVIDIA) and `reasonx-v1`.
3. Enter the API key. Leave it blank to keep a saved key. **Clear saved key** removes it.
4. Select the **Save … connection** button.

For ReasonX, also set the **API base URL** (default `http://127.0.0.1:8080/v1`) and **Reasoning mode**, and use **Check local server**. ReasonX needs Ollama running. Groq and NVIDIA keys can also come from `GROQ_API_KEY` and `NVIDIA_API_KEY`. Keys are encrypted and never returned to the browser.

### Bug tracking configuration

See [Raise bugs in Jira](#29-raise-bugs-in-jira).

### Clean history

**Clean history** keeps the chosen number of completed runs across all projects (default 100) and deletes older ones with their screenshots and traces. Check the number before you select **Delete older runs**.

---

## 28. Reports: HTML, PDF, interactive and Playwright JSON

Every finished run, and each case in a run, offers four outputs.

### HTML and PDF reports

The HTML and PDF reports are documents designed for reading, printing and attaching to Jira. They contain:

- The project name, overall verdict, start time, browser, duration and run ID.
- The pass rate and counts of **Passed**, **Failed**, **Skipped** and **Not completed**. Blocked and interrupted tests count as Not completed. The pass rate rounds down, so a run with any failure never shows 100%.
- **Needs attention**, listing failed cases with their first error line.
- Each case with its steps, errors and screenshots.

Reports are self-contained, with no web fonts, scripts or external files. Test values are left out. The PDF is A4 with every section expanded.

### Interactive report

**Interactive report** opens a Monocart report in a new tab. You can sort, filter and search results, view screenshots and see trends from earlier runs of the same project or case. Limits:

- Screenshots are limited to 25 MB per report; failed steps' screenshots are kept first.
- Traces are not included. Download them from Run history.
- The report runs in a sandbox and cannot act as Studio.

### Playwright JSON

**Playwright JSON** downloads the run in Playwright's JSON report format, for other tools. Blocked, interrupted and unfinished tests are written as Playwright's `interrupted` result, which Playwright counts as skipped. A `qa-status` annotation keeps the real status. Stored variables, database profiles and dataset values are never included.

### Where to find them

| Place | Links |
| --- | --- |
| QA Studio run screen (finished run) | HTML report, PDF report, Interactive report, Playwright JSON |
| QA Studio Reports | HTML, PDF, Interactive, JSON |
| Automation Studio Run history | HTML report, PDF report, Interactive report, Playwright JSON |
| TC Execution overview | Case HTML report, Case PDF report, Case interactive report, Case Playwright JSON, Full run report |

Screenshots and traces can contain page content. Check them before sharing.

## 29. Raise bugs in Jira

### Connect Jira (administrator)

1. Open **Settings & connections** and find **Bug tracking configuration**.
2. Enter the **Jira site URL** (`https://your-team.atlassian.net`), **Jira account email**, **Jira project key** and **Jira issue type** (normally **Bug**).
3. Enter a **Jira API token** without scopes. Leave it blank to keep a saved token.
4. Select **Save & test connection**. The status changes to **Connected**.

The check confirms the account, project access, Browse Projects and Create Issues permissions and the issue type. **Disconnect Jira** removes the saved credentials. This connection is separate from the Atlassian MCP server.

### Where to raise a bug

- **QA Studio:** the test case details page shows a **Report issue** panel once Jira is connected. It is available for any result.
- **Automation Studio:** **Raise bug** appears next to the case status in the Test editor and on each test in Run history when the result is failed, blocked or interrupted. If Jira is not connected the button is disabled, with **Connect Jira in Settings** for administrators or "Ask an admin to connect Jira" for others.

For a case with dataset rows, one bug covers all its rows, so **Raise bug** appears once per case in a run.

### Fill in the bug

**Raise bug in Jira** loads its options from Jira when it opens.

1. Choose the **Issue type**.
2. Check the **Bug title** (required, up to 255 characters).
3. Choose **Priority**, if the Jira project offers it, and **Severity** (or **Not set**). If the issue type has no Severity field, severity is written at the top of the description.
4. Check **Steps to reproduce** (required), **Expected vs actual** and **Run details**. These are pre-filled from the case and run.
5. Under **Attachments**, tick the run evidence to send: step screenshots, locator screenshots, the execution trace and the **HTML run report**. Only the failed step's screenshot is ticked to start with. Nothing is sent unless it is ticked.
6. Optionally use **Add your own files**: images, video, text, logs, JSON, CSV, PDF or zip, up to 10 MB each. You cannot upload your own `.html` files.
7. Select **Report as issue**.

If the case already has bugs, they are listed under **Already raised for this test case**. After creation the issue key appears as a link next to the button. If some files fail to upload, the issue still exists: select **Retry failed files**.

Notes:

- If the Jira account cannot add attachments, the popup says so and you can still report without files.
- Issues use the Jira project's default status. Jira shows the connection account as the reporter, so your Studio name is added to Run details.
- Screenshots and traces can show test data. Check them before sending.

## 30. Save, export, back up and restore

### Export and import a project

1. In **Settings & connections**, select **Export project**. A `studio-project.json` file downloads.
2. On the other Studio, select **Import project**, paste the JSON and select **Import**. A new project is created.
3. Enter environment and global values, datasets, database passwords and sensitive values again. They are left out of exports.

Review the file before sharing: ordinary step values are still included.

### Backups and restore

Project saves create automatic backups, and **Create backup** makes one on demand. The latest 20 are kept.

To restore:

1. Finish any run, debug session or recording.
2. Select **Restore projects**, choose a backup and confirm.

Restore replaces all project definitions. It keeps run history, settings, accounts, project assignments and the working log, and makes a safety backup first. Unsaved edits are lost. Related documents, screenshots and traces are not restored from a backup.

### Full backup

Stop the server and copy the whole `data` and `artifacts` folders, including `data/credentials.key`, `data/users.json`, `data/local-test-files` and `data/project-documents`. The key works only for the same Windows user, so to move to another computer or account use project export and import and enter credentials again. `npm run restore-drill` checks that the backup files in `data` can be read.

## 31. Run tests from the command line

The server must be running. The CLI needs an enabled account with Automation Studio access and the project assigned. It reads `STUDIO_USERNAME` and `STUDIO_PASSWORD`, or `STUDIO_SESSION_TOKEN`.

Find project and test IDs in PowerShell:

```powershell
$credential = Get-Credential -Message 'Sign in to QA Studio'
$env:STUDIO_USERNAME = $credential.UserName
$env:STUDIO_PASSWORD = $credential.GetNetworkCredential().Password
$login = @{ username = $env:STUDIO_USERNAME; password = $env:STUDIO_PASSWORD } | ConvertTo-Json
Invoke-RestMethod 'http://127.0.0.1:3300/api/auth/login' -Method Post -ContentType 'application/json' -Body $login -SessionVariable session | Out-Null
$state = Invoke-RestMethod 'http://127.0.0.1:3300/api/state?workspace=automation' -WebSession $session
$state.projects | Select-Object id, name
$state.projects[0].tests | Select-Object id, tcNumber, name
```

Use the `id` values, not the `TC-0001` numbers. Then run:

```powershell
npm run run-tests -- --project PROJECT_ID --test TEST_ID --json results.json --junit results.xml
```

- Use `--suite SUITE_ID` instead of `--test` for a suite.
- Add `--url http://127.0.0.1:3300` to name the server, or set `STUDIO_URL`.
- Repeat while the command runs: `--every-minutes 60 --count 8`.
- `npm run run-tests -- --help` lists the options.

Exit codes: `0` passed, `1` failed or interrupted, `2` setup or command error, `130` cancelled. **Ctrl+C** tries to cancel the active run.

## 32. Troubleshooting

| Problem | What to do |
| --- | --- |
| Page will not open | Start **Start QA Studio.cmd** and open `http://127.0.0.1:3300`. Check `server.stderr.log`, or run `npm start` to see the error. Start from the Windows account that owns the data. |
| Stored data cannot be decrypted | Keep `data` and `credentials.key` as they are. Use the original Windows account. Do not delete or replace the key. |
| Old behaviour after an update | Use **Restart QA Studio.cmd**. Refreshing the browser does not reload server code. |
| "No project access assigned" | Ask an administrator to grant a studio in Permissions and assign the project in Project management. Then sign in again. |
| Conflict when saving users, permissions or projects | Use **Refresh users**, **Edit** again or **Refresh**, review and retry. |
| "This project changed in another tab" | Export or copy your edits, reload and reapply them. |
| Run test case is disabled in QA Studio | Transfer the case to a test plan first. |
| Browser missing | Run `npm run doctor` and install the browser it names. Check the toolbar browser. |
| Locator matches zero or several elements | Debug and use **Check next locator**. Check the tab, frame, page state and selector. |
| Test times out | Look at the failed step and screenshot. Fix the target or expected state before raising the timeout. |
| Missing variable | Check the value source, the selected environment and the exact variable name. |
| Recorded password or file does not replay | Set `RECORDED_PASSWORD` or `RECORDED_FILE_1` (or the numbered name in the step). File paths must exist on the Studio computer. |
| Another session is active | Finish the recording, debug session or run first. |
| Generation fails | Check the provider, model ID, key, network and quota. For ReasonX, use **Check local server** and make sure Ollama is running. |
| A document was not fully used | The notes name it. Put the important rules in the requirement description. |
| "AI cannot read this file" | The file is scanned or protected. Upload a text-based copy. |
| Raise bug is disabled | Ask an administrator to connect Jira in Bug tracking configuration. |
| Attachments failed after the issue was created | Select **Retry failed files**. Check Jira before reporting again. |
| MCP connection unavailable | Start the external server, or check the stdio command, then **Connect & discover**. |
| VPN requested but site unreachable | Finish the prompts in OpenVPN Connect and check it shows Connected. |
| Schedule did not run | Keep the server running and check **Schedules** for the next time or an error. |

When you report a problem, include what you did, the error message, the browser and the failed step or report. Remove passwords, keys and sensitive page data first.
