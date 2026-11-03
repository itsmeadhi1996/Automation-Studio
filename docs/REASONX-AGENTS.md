# ReasonX agents

The agent catalog splits common QA tasks into six focused roles. `studio-agents.mjs` sends a role's profile, your task and an optional context file to your local ReasonX server, and returns a draft to review. Agents are advisory: they cannot call tools, change data, save cases, approve drafts or run tests.

The shipped profiles were written by hand from QA Studio's workflows. No model generated them, and they have not been tried against a live ReasonX server. A successful `check` or `run` on your machine is the evidence that they work there.

## Agents

The catalog is [.agents/agents.json](../.agents/agents.json). [.agents/README.md](../.agents/README.md) links each profile.

| Agent | Give it | You get |
| --- | --- | --- |
| `workspace-guide` | Goal, selected workspace, relevant status | Next action, navigation steps |
| `requirements-analyst` | Requirement, constraints, page metadata | Criteria, prerequisites, missing rules |
| `test-case-designer` | Criteria, setup, scope | Manual draft cases, assumptions |
| `automation-author` | QA instructions, observed controls | Proposed browser steps, locator gaps |
| `coverage-reviewer` | Criteria, existing case summaries | Coverage map, gaps, likely duplicates |
| `execution-analyst` | Run results, errors, evidence excerpts | Findings, possible causes, next check |

## Set up

Start your ReasonX server and its Ollama backend. Studio does not ship ReasonX. The default API base is `http://127.0.0.1:8080/v1`, and only local addresses are accepted. If authentication is on, set `REASONX_API_KEY`. Never put keys, passwords or exported secrets in a task or context file.

## Commands

Run these from the project folder:

```powershell
node studio-agents.mjs list
node studio-agents.mjs check
node studio-agents.mjs run requirements-analyst --task-file docs/examples/agents/requirement-task.txt --context-file docs/examples/agents/requirement-context.json --out .test-output/agents/requirement-analysis.json
node studio-agents.mjs generate workspace-guide --out-dir .test-output/agents/profile-drafts
node studio-agents.mjs generate all --out-dir .test-output/agents/profile-drafts
```

`npm run agents` is the same as `node studio-agents.mjs`, and `list` is the default command.

- **`list`** prints the catalog.
- **`check`** reports whether Studio and ReasonX are ready. It exits with 1 unless Studio is healthy and ReasonX is reachable, authorized and offering at least one model.
- **`run`** takes either `--task` or `--task-file`, not both. The system and user text together must fit in 5,500 characters; longer requests are refused and never silently cut. `--out` writes the result as JSON and fails if the file already exists.
- **`generate`** asks ReasonX for a proposed replacement profile, one role at a time, and writes one JSON file per role. The output folder must be outside `.agents`. Nothing is installed: review a proposal before you edit a profile by hand. A proposal needs all five headings and must fit in 2,000 characters, the limit for an installed profile.

The runner gives the model only the profile and the files you supply. It does not fetch project data or load Studio's encrypted credentials, so give it a short excerpt with the facts the task needs.

| Setting | Meaning |
| --- | --- |
| `REASONX_BASE_URL` or `--base-url` | Local ReasonX API base, ending in `/v1` |
| `REASONX_API_KEY` | Optional ReasonX key. It is removed from any error output and is never sent to Studio |
| `--model` | Overrides the catalog model for this command |
| `--mode` | Overrides the agent's mode: `auto`, `fast`, `standard`, `deep` or `expert` |
| `STUDIO_URL` | Studio address used by `check`, default `http://127.0.0.1:3300` |

The default model is `reasonx-v1`. Each request is text only and asks for at most 1,024 tokens. These commands do not change Studio's saved settings.

## Using the roles together

1. Use **Requirements analyst** on a short requirement. Settle the unknown behaviour before you draft cases.
2. Use **Test case designer** on a few criteria at a time, then **Coverage reviewer** to look for gaps. The CLI's output stays a document. To create real cases, use the Requirement screen, where drafts wait for review and approval assigns their test case numbers.
3. For manual testing, transfer approved cases to **Test plan** and record what you actually observe in a run.
4. For automation, open the case in **Automation Studio** and use **Automation author** with the controls you observed. Enter and check the real steps in the editor.
5. Give recorded results to **Execution analyst**, and keep its possible causes separate from the evidence.
6. **Workspace guide** can suggest the next action at any point.

These profiles are separate from Studio's built-in generation. The **Use ReasonX agents** method on the Requirement screen runs its own pipeline in `requirement-agent.mjs`. Automation drafts come from `reasonx.mjs`, through `/api/ai/draft` and the `studio_ai_draft_test` MCP tool, and are returned without being saved or run.

## When something fails

| What you see | What to do |
| --- | --- |
| `check` says ReasonX is unavailable | Start the service and confirm the API base |
| Authentication error | Set a valid `REASONX_API_KEY` |
| Unknown model | Choose a model that the server offers |
| ReasonX is busy | Let the active request finish, then try again |
| Oversized or incomplete output | Shorten the task and ask for fewer items |

A failed model request is not generated work.

## Checks

```powershell
$env:QA_TEST_PORTABLE_VAULT='1'
node --test --test-concurrency=1 test/studio-agents.test.mjs
```

These tests cover catalog loading, the shipped catalog, request limits, failures and draft-only behaviour. They use mocked ReasonX responses, so they do not show how good a live model's answers are.

See also the [user manual](USER-MANUAL.md) and the [API documentation](QA-API.md).
