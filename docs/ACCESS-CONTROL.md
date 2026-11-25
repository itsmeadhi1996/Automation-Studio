# Accounts and studio permissions

QA Studio 4.0 is a local application with administrator-managed accounts. Sign-in is required. The server listens only on `127.0.0.1`. Accounts control access inside the application; they do not make it safe to host on a network. Source: `auth.mjs`, with the routes in `server.mjs`.

## First administrator

Open http://127.0.0.1:3300 after the first start. The first visit opens **Create your administrator**. Choose a username, a display name and a password of 12 to 256 characters. The first account is an administrator with QA Studio and Automation Studio access. Setup works only while no accounts exist; after that it returns 409. There are no default credentials and no public registration.

Usernames are trimmed and lowercased, and must be 3 to 80 characters of letters, numbers, `.`, `_`, `@` or `-`, starting with a letter or number. Display names are 1 to 120 characters.

## Roles

| Role | Access |
| --- | --- |
| Administrator (`admin`) | Every feature and every project, plus user administration, project management, application settings, VPN and bug-tracker configuration, backups, restore and history cleanup. |
| User (`user`) | Only the studios and features granted below, and only in assigned projects. |

At least one active administrator must remain. An update that would leave none fails with 409 `Keep at least one active administrator.`

## Studio permissions

Administrators grant permissions under **Administration > Users & permissions** (`/admin`) and **Administration > Permissions** (`/admin/permissions`). All grants are off for a new user.

| Permission | Allows |
| --- | --- |
| QA Studio (`qa`) | Manage cases, folders, suites, requirements and manual runs in assigned projects. View their dashboards and reports. |
| Automation Studio (`automation`) | Edit and run automation, record, debug, generate tests, use test data and schedule tests. |
| Create projects (`createProjects`) | Create or import projects in an assigned studio. Needs QA Studio or Automation Studio. |
| Use configured MCP servers (`useMcp`) | Discover and call tools on servers an administrator configured, including AI context tools. Needs Automation Studio. |
| Manage MCP connections (`manageMcp`) | Add, edit, remove and configure MCP connections and credentials. Includes Use configured MCP servers. Needs Automation Studio. |

The server applies these rules when it saves permissions:

- Removing Automation Studio clears both MCP grants.
- Granting Manage MCP connections also grants Use configured MCP servers.
- Removing both studios clears Create projects.
- Re-enabling a studio does not restore grants an earlier save cleared.

A regular user needs QA Studio or Automation Studio to sign in. Unknown permission names and non-boolean values are rejected with 400. Every restriction applies to direct API requests as well as the screens.

After sign-in, administrators land on `/admin`, QA Studio users on `/`, Automation Studio-only users on `/automation`, and anyone else on `/account`.

## Edit conflicts

Each account has a revision. The Users and Permissions forms send the revision they loaded. If another administrator changed the account first, the save returns 409 `This user changed. Reload the current user before saving.` An API client that sends no revision is not checked.

## Project assignment

Open **Administration > Project management** (`/admin/projects`) to choose which regular users can open each project.

- A user can open a project only when the account is active and the project is assigned to them. Administrators can open every project.
- A user who creates or imports a project is assigned to it automatically.
- An assignment allows whatever the user's studio permissions allow in that project. It is not a read-only role.
- Assignments have a revision for each project. A save with an old revision returns 409 `Project assignments changed. Refresh before saving.` Two administrators can change different projects at the same time.
- A request for an unassigned project returns 403 `Project access has not been assigned. Contact your administrator.`
- Assignments apply to the next request. Data a user already downloaded cannot be recalled, and work already running can finish.

The working log records assignment changes, with the users granted and removed. It keeps the latest 10,000 entries and shows 50 per page.

### Schedules

A schedule belongs to the user who created it. When it is due, Studio checks that the owner still has Automation Studio and the project. If not, the schedule is turned off with an error asking you to recreate it with an authorized account.

## What QA-only users cannot see

A user without Automation Studio (a QA-only user) can open the project structure, cases and results, but not stored secrets or test values. For these users, every response that carries a project leaves out:

- environment variable values and global variable values,
- database profile passwords,
- dataset rows (`dataRows`, `dataRow`),
- local test data values and source settings (the name, source type and keep-global flag remain),
- stored local values (`localValues`),
- the values of steps marked sensitive.

This applies to tests, prerequisites and processes. Run responses are redacted the same way, so run snapshots do not show `localValues` or sensitive step values to QA-only users. The internal run `context` is removed for everyone.

Saves from a QA-only user change only the project name, folders, suites, test plans and requirements, and, for each case, its name, QA details, folder, suites, prerequisite and plan membership. Stored steps and all the hidden values above are kept from the saved project, so a QA-only save does not erase them.

Administrators and Automation Studio users receive these values, because the automation editor needs them.

## Sign-in throttling

Failed sign-ins are limited by the client's network address. Studio counts every sign-in attempt in a one-minute window that starts at the first attempt and is not extended. A successful sign-in takes one off the count. More than 15 attempts in the window return 429 `Too many sign-in attempts. Try again in a minute.`

Every client connects from loopback, so in practice all users on the machine share one limit.

A wrong password, a disabled account and a regular user with no studio all return the same 401 `Invalid credentials or account access is disabled. Contact your administrator.` If any account changes while a sign-in is being checked, that sign-in fails with `Account changed. Please sign in again.`

## Passwords and sessions

- Passwords are hashed with scrypt and an individual random salt. Accounts are stored in `data/users.json`, which is not part of project backups.
- A successful sign-in sets the `studio_session` cookie: `HttpOnly`, `SameSite=Strict`, `Path=/`, eight-hour lifetime. The lifetime is fixed from sign-in and is not extended by activity. There is no `Secure` flag, because the server uses plain HTTP on loopback.
- API clients can send the token as `Authorization: Bearer <token>` instead of the cookie.
- Each user can have at most 10 sessions. A new sign-in removes the oldest beyond that.
- Sessions are kept in memory only. Restarting the server signs everyone out.

### When sessions end

| Event | Effect |
| --- | --- |
| **Sign out** | Ends the current session only and clears the cookie. |
| **Change password** in My account (`PUT /api/auth/password`) | Ends every session of that user, including the current one, and clears the cookie. |
| **Any administrator edit of a user** (`PUT /api/admin/users/:id` or `PUT /api/admin/users/:id/permissions`) | Ends every session of that user. |
| **Account disabled** | The user's sessions stop working at once. |
| **Server restart** | Ends all sessions. |

Administrator edits end sessions whatever changed. Both edit routes call `auth.update`, and every successful `auth.update` revokes that user's sessions, so changing only the display name also signs the user out. An edit that is rejected, for example for a revision conflict or invalid input, changes nothing and leaves sessions in place. When administrators edit their own account, their session ends but the cookie is not cleared; the next request asks them to sign in again.

## CLI and MCP clients

`studio-cli.mjs`, `mcp-server.mjs` and the launcher sign in through `auth-client.mjs`. Set `STUDIO_SESSION_TOKEN` to send an existing token as a Bearer header, or set `STUDIO_USERNAME` and `STUDIO_PASSWORD` to sign in. They are read from the environment, not from the command line. These sessions end on the same events as browser sessions.

The restart launcher needs an administrator, because it creates a backup before stopping the server. See [RECOVERY](RECOVERY.md).

## Related documents

- [README](../README.md)
- [Backup, recovery and health](RECOVERY.md)
- [QA API](QA-API.md)
- [Decisions](../DECISIONS.md)
