# Backup, recovery and health

Paths below are under the storage folder: the app folder, or `STUDIO_STORAGE_DIR` when it is set.

## What a complete recovery needs

| Item | Location | In backups? | Notes |
| --- | --- | --- | --- |
| Project definitions, runs, settings, assignments, working log | `data/studio.json` | Copied as `data/backup-*.json` | Secret fields are encrypted with the vault key. |
| Accounts | `data/users.json` | No | Copy it separately. |
| Vault key | `data/credentials.key` | No | Protected with DPAPI for the Windows account that created it. |
| Recording draft | `data/recording.json` | No | Encrypted fields. |
| Uploaded local test files | `data/local-test-files/` | No | Encrypted. |
| Related documents | `data/project-documents/` | No | Encrypted. Backups hold only the document list. |
| Evidence | `artifacts/` | No | Screenshots and traces, not encrypted. |

To keep everything, copy the whole `data/` folder and the `artifacts/` folder to a safe place while Studio is stopped. A copy of `studio.json` alone restores project definitions, but not accounts, evidence, documents or the ability to decrypt secrets.

## Backups

A backup is a copy of `data/studio.json` named `backup-<time>-<random>.json` in `data/`. The newest 20 are kept and older ones are deleted.

Studio takes a backup automatically:

- before every project save,
- before every requirement draft approval,
- before a restore,
- after a startup migration of the object repository,
- during a safe restart.

An administrator can also take one with **Automation Studio > Settings & connections > Create backup**, or `POST /api/backups`. A backup first writes any save still waiting in the save timer, so the copy includes recent changes.

Backups contain project definitions only. Because 20 project saves create 20 backups, frequent saving pushes out older restore points. Keep your own copies of `data/` if you need older ones.

## Restore

Administrators restore with **Automation Studio > Settings & connections > Restore projects**, or `POST /api/backups/restore` with `{"name": "backup-....json"}`.

- Restore is refused while a run, browser start, recording, debug session or AI generation (requirement or Automation Studio) is active.
- The backup must contain at least one project.
- Studio takes a safety backup of the current state first.
- Restore replaces the project definitions and the next test number. Each restored project keeps the higher of its backup revision and its current revision, so open editors see a conflict instead of saving over it.
- Restore keeps the current accounts, project assignments, assignment revisions, run history, working log, settings, schedules and related documents.

The backup is decrypted with the current vault key, so restore works only with the key it was made under.

## The vault key: `credentials.key`

Studio creates `data/credentials.key` only when the workspace has no encrypted data. Before creating a key, it looks for encrypted values in `studio.json`, `recording.json`, every `backup-*.json`, and every file in `local-test-files/` and `project-documents/`.

- **No key file and no encrypted data** (a fresh install): Studio creates a new 32-byte key, protects it with DPAPI for the current Windows user, and writes it without overwriting any existing file.
- **No key file but encrypted data exists**: Studio stops with this message and changes nothing:

  > data/credentials.key is missing, but this workspace contains encrypted data that needs it. Nothing was changed. Restore credentials.key from a backup made under the original account. See docs/RECOVERY.md.

- **Key file exists but cannot be unlocked**: Studio stops with the message below and changes nothing.

### "Cannot unlock workspace credentials for this Windows user"

The server was started under a Windows account other than the one that created `credentials.key`, or from a service or sandboxed session without a loaded profile. The same message appears when the key file cannot be read as a valid key.

1. Start the server from the original Windows account, in a normal desktop session, for example with `Start QA Studio.cmd`.
2. If that account is gone, restore `credentials.key` together with its matching `studio.json`, made while the original account was active. A key created under another account cannot decrypt existing data.
3. If neither is possible, the encrypted values (passwords, API keys, variables, datasets, local data, assignments and the working log) cannot be recovered. Start a fresh workspace and import projects from project JSON exports.

Do not delete `credentials.key` to get past this error. Studio will not replace it while encrypted data exists.

## Restore drill

```powershell
npm run restore-drill
```

This runs `scripts/restore-drill.mjs`. It checks that every `backup-*.json` in `data/` parses as JSON and contains a `projects` array, and that `credentials.key`, `users.json` and `studio.json` are present. It prints `OK` or `MISSING` for each file and a count of backups that parsed. It exits with code 1 on any failure. It changes nothing.

- It does not decrypt anything, so it does not prove that the key unlocks the backups.
- It does not read `STUDIO_STORAGE_DIR`. For another storage folder, pass its `data` folder: `node scripts/restore-drill.mjs D:\path\to\storage\data`.
- It needs a `data/` folder, so run it after the first server start.

Run it after changing backups and before upgrades.

## Doctor

```powershell
npm run doctor
```

`doctor.mjs` prints the Node version and the current folder, tries to launch Chrome, Edge and Firefox and reports each as `ready` or with its error, prints the OpenVPN status, and prints the Studio URL for the configured port (`PORT`, default 3300).

## Health

`GET /api/health` needs no sign-in. Like every route, it answers only requests addressed to `127.0.0.1` or `localhost` on Studio's port. It returns:

- `status`: `ok`, or `degraded` when `data/` or `artifacts/` is not writable,
- `dataWritable` and `artifactsWritable`,
- `backups` (count) and `newestBackup` (time of the newest, or `null`),
- `eventLoopDelayMs`,
- `metrics`: uptime, request count, counts by status class, and p50, p95 and max latency over the last 500 requests.

## Safe restart

`Restart QA Studio.cmd`, `Start QA Studio.cmd` when the running server is outdated, and `npm run launch -- --restart` all use `restartStudio` in `studio-restart.mjs`. It needs an administrator account. The `.cmd` launchers ask for one in the console; for `npm run launch` set `STUDIO_USERNAME` and `STUDIO_PASSWORD`, or `STUDIO_SESSION_TOKEN`, in the environment.

The steps run in this order. If any step fails, the server is left running.

1. **Status.** Read `/api/status`. A 401 or 403 makes the launcher exit with code 3, which makes the `.ps1` script ask for credentials.
2. **Idle check.** Refuse while there is an active run, debug session or live recording, while a stopped recording is still saving or has a save error, or **while a generation is running** (`A generation is still running. Finish or cancel it, then restart Studio.`).
3. **Unlock.** Check that this Windows account can open the vault. If `credentials.key` is missing, stop with a message saying Studio was not stopped and nothing was changed. The restart never creates a key.
4. **Recording.** If a stopped recording draft exists, save it and confirm it saved.
5. **Backup.** Ask the server for a backup, which writes pending saves first. A regular user fails here with `Could not back up the workspace. Studio was not stopped.`, because backups need an administrator.
6. **Status again.** Repeat the idle check, and refuse if a new recording appeared.
7. **Stop.** Stop the process named in `data/studio.lock`, then wait up to 10 seconds (40 checks, 250 ms apart) for it to exit. If it is still running, the launcher reports `Studio is still stopping. Wait a moment, then launch it again.`

The launcher then starts a new background server, waits up to 15 seconds for it, and opens the browser if `--open` was given. The new server does not inherit the restart credentials. Everyone signs in again after a restart.

### Windows shutdown path

On Windows, sending `SIGTERM` to a Node process ends it at once, without running Studio's close steps. So on Windows the restart asks the server to stop itself with `POST /api/admin/shutdown`, sending the process ID from `studio.lock`:

- The route is administrator-only.
- If the process ID is not this server's, it returns 409 and does nothing.
- If a run, browser start, debug session, recording or AI generation is active, it returns 409 `Finish active work before stopping Studio.`
- Otherwise it returns 202 and closes: it aborts running generations, stops schedules, closes browsers and MCP connections, writes pending saves, closes the HTTP server, releases `data/studio.lock` and exits. If closing takes more than 8 seconds, the process exits anyway.
- An older server without this route returns 404, and the restart falls back to `process.kill`.

On other systems the restart sends `SIGTERM`. The server also handles `SIGINT` (Ctrl+C) and `SIGTERM` with the same close steps.

## Maintenance

- `npm run check` syntax-checks every source file.
- `npm run clean` removes disposable test workspaces under `.test-output`. `npm run clean -- --dry-run` shows what would be removed.
- CI (`.github/workflows/ci.yml`) runs on every push and pull request on `windows-latest` with Node 22. It runs `npm ci`, installs Playwright **Chromium and Firefox** (`npx playwright install chromium firefox`), then runs `npm run check`, `npm audit --omit=dev --audit-level=high` and `npm test` with `QA_TEST_PORTABLE_VAULT=1`. On failure it uploads `.test-output/**/*.log`.

## Related documents

- [README](../README.md)
- [Accounts and studio permissions](ACCESS-CONTROL.md)
- [Decisions](../DECISIONS.md)
