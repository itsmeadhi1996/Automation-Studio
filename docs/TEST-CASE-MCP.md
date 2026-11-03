# Local test case generation and MCP

QA Studio's Local rules method and the `generate_test_cases` MCP tool call the same pure service, `test-case-generator.mjs`. It needs no AI model, API key, application server, browser or network connection. It produces editable manual scenarios. It never runs security scans, load tests or the cases it generates.

## Start the server

You need Node.js 22 or newer and this project's dependencies. From the project folder:

```powershell
npm run mcp:test-cases
```

This is the same as `node test-case-mcp.mjs`. It is a stdio server: it waits silently for JSON-RPC on stdin and reserves stdout for protocol messages. An MCP client normally starts it for you. QA Studio does not need to be running, and no credentials are needed.

`npm run mcp` starts the Studio bridge, which offers this tool alongside the eight `studio_*` tools. Those eight need a running Studio and its sign-in. This tool does not.

## Client configuration

For clients that accept `mcpServers` configuration, use the following. Change the path to match your install, and use a full path to Node if `node` is not on the client's PATH.

```json
{
  "mcpServers": {
    "qa-test-cases": {
      "command": "node",
      "args": ["D:/Adhish/Project/automation 4.0/test-case-mcp.mjs"]
    }
  }
}
```

No environment variables or tokens are needed. In Studio's custom MCP connection screen, choose stdio with the same command and argument.

## Sample call

Send this as the `params` of a `tools/call` request:

```json
{
  "name": "generate_test_cases",
  "arguments": {
    "requirement": "Email is required. Password must have 8 to 64 characters. Registration responds within 2 seconds.",
    "moduleName": "Registration",
    "pageMetadata": {
      "fields": [
        { "name": "Email", "type": "email", "constraints": { "required": true } },
        { "name": "Password", "type": "password", "constraints": { "minLength": 8, "maxLength": 64 } }
      ],
      "controls": [{ "name": "Register", "type": "submit" }],
      "constraints": []
    },
    "categories": ["Positive", "Negative", "Functional", "Validation", "Boundary", "Security", "Performance"]
  }
}
```

## Input

| Field | Accepted value |
| --- | --- |
| `requirement` | Required text that is not blank, up to 10,000 characters |
| `moduleName` | Optional text that is not blank, up to 120 characters. Defaults to `General` |
| `categories` | Optional non-empty list of the seven names in the sample. Leaving it out means all that apply |
| `pageMetadata.fields` | Up to 100 `{name, type?, constraints?}` entries |
| Field `type` | `text`, `email`, `password`, `number`, `integer`, `url`, `date`, `select`, `checkbox`, `textarea`, `tel`, `file` |
| Field `constraints` | `required` boolean; whole `minLength` and `maxLength` from 0 to 1,000,000; `min` and `max` up to 1e12 in absolute value; positive `step` up to 1e12; `options`, 1 to 100 strings of up to 500 characters; `pattern` text of up to 500 characters |
| `pageMetadata.controls` | Up to 100 `{name, type?, disabled?}` entries. Type is `button`, `submit`, `link`, `checkbox`, `tab` or `select` |
| `pageMetadata.constraints` | Up to 100 plain-language rules of up to 1,000 characters each |

Field and control names cannot be blank and are limited to 160 characters.

Invalid types, unknown properties in a field, control or constraint definition, and a reversed range within one field are rejected. The error gives the path and the reason, and does not repeat what you submitted.

Do not put real credentials in requirements or metadata. The requirement text comes back as the case's requirement reference, and the app saves and exports it. The tool itself logs nothing.

### Metadata that gets normalized

Missing, null, blank or empty metadata generates from the requirement alone. Also accepted are JSON text containing an object, and a nested `pageMetadata` wrapper. Null `fields`, `controls` and `constraints` count as absent. Other page details, such as a title or URL, are ignored with a note. Invalid JSON and wrong types still return a clear error. For example, text in `fields` reports `pageMetadata.fields must be an array`.

### When sources disagree

Generation settles each field property separately. The requirement text wins, then plain-language page constraints, then structured or inspected metadata. So a required flag or limit in the requirement overrides an out-of-date page attribute. Bounds of equal priority combine into their overlap when there is one.

If equally authoritative sources cannot agree, such as ranges that do not overlap or different patterns, that property is left out of concrete assertions. A Validation review scenario is generated instead when that category is selected. Everything else still generates normally.

The summary says when this happens, warnings describe the decisions, and affected cases carry assumptions. Your saved requirement and metadata are not changed. Generation cannot decide which business rule is correct.

## Output

The result is in `structuredContent`, with the same JSON in its text content: `{testCases, summary, warnings, coverage: {complete: false, limitReached}}`. Failures return `isError: true` with a message.

Each case contains:

- `id`: a `TCG-` identifier that stays the same for unchanged inputs and rules, even when categories are filtered
- `title`, `module`, `category` and `priority` (`critical`, `high`, `medium` or `low`)
- `preconditions`: a list of strings
- `steps`: a list of `{instruction, expectedResult}`
- `testData`: a list of `{field, value}`, using dummy values or instructions for building the data
- `expectedResult` and `requirementReference`: text
- `assumptions`: a list of inferred choices and items to review

The MCP tool returns drafts and saves nothing.

## Use it in QA Studio

1. Open **Requirement** and add a requirement with its title, URL and description. You can also add a module, categories and page metadata.
2. Set the generation method to **Local rules — no AI key required** and generate. The app calls the same service directly, with no MCP step and no AI key.
3. Review the drafts on the Requirement page. They stay separate from Test cases until you approve them. Approval adds a case to Test cases and gives it a permanent test case number.
4. Regenerating keeps your renamed or edited cases, because each case's identifier is kept in `qa.generationId`.

## Rules and limits

| Category | What it generates from |
| --- | --- |
| Functional | Requirement clauses, and supplied control actions and disabled states |
| Positive | A valid-data scenario using supplied fields and a submit control, if there is one |
| Negative | Invalid email, URL, number and integer formats |
| Validation | Required fields, supplied options and supplied patterns. Patterns are never executed by the generator |
| Boundary | At and just outside supplied length and numeric limits. A default step of 1 is marked as an assumption |
| Security | A password display template with a marked policy assumption, and an unauthenticated access scenario when authentication is explicitly required |
| Performance | Timing scenarios only when a response-time limit is supplied |

Text extraction recognizes a limited set of English forms, such as `Email is required`, `Password must have 8 to 64 characters`, `Name must have at most 50 characters`, `Age must be between 18 and 65`, `within 2 seconds` and `under 500 ms`. Anything else becomes a general scenario that refers to the clause, so use structured metadata for precise rules.

Output is capped at 200 cases, with a warning when the cap applies. At most 100 fields receive scenarios, and general Functional scenarios cover the first 100 clauses.

The generator does not infer unstated business behaviour, guarantee complete coverage, prove that the app works or produce executable browser steps. A tester needs to review ambiguous requirements, generated data, expected outcomes and assumptions. Changing the requirement text can produce new identifiers and more drafts, so review earlier drafts when a requirement changes.

## Checks

```powershell
$env:QA_TEST_PORTABLE_VAULT='1'
node --test --test-concurrency=1 test/test-case-generator.test.mjs test/test-case-conflicts.test.mjs test/test-case-metadata.test.mjs test/test-case-mcp.test.mjs
```

The portable vault setting applies only to disposable test workspaces under `.test-output`.
