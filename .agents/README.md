# QA Studio agents

This folder holds the catalog that `npm run agents` reads. Agents are advisory: they return drafts, cannot call tools and cannot change data.

| Agent | Profile | Purpose |
| --- | --- | --- |
| `workspace-guide` | [profiles/workspace-guide.md](profiles/workspace-guide.md) | Suggests the next action and where to go in QA Studio or Automation Studio. |
| `requirements-analyst` | [profiles/requirements-analyst.md](profiles/requirements-analyst.md) | Turns a requirement into testable criteria and names what is missing. |
| `test-case-designer` | [profiles/test-case-designer.md](profiles/test-case-designer.md) | Drafts manual test cases from criteria for human review. |
| `automation-author` | [profiles/automation-author.md](profiles/automation-author.md) | Proposes browser steps from QA instructions and observed controls. |
| `coverage-reviewer` | [profiles/coverage-reviewer.md](profiles/coverage-reviewer.md) | Maps existing cases to criteria and finds gaps and duplicates. |
| `execution-analyst` | [profiles/execution-analyst.md](profiles/execution-analyst.md) | Reads run results and evidence and suggests the next check. |

`agents.json` lists the agents, their default ReasonX mode and their inputs and outputs. Each profile must stay between 1 and 2,000 characters, inside this folder, and use the headings `# Mission`, `# Inputs`, `# Workflow`, `# Output` and `# Limits`.

`node studio-agents.mjs generate` writes proposed replacement profiles outside this folder. It never installs them. Review a proposal before you edit a profile here.

See [docs/REASONX-AGENTS.md](../docs/REASONX-AGENTS.md) for setup and commands.
