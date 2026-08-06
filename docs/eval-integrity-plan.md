# Plan: Protect Eval Intent and Keep Process in Skills

## Goal

Prevent an agent from making live evals easier by changing scenario intent, while keeping the user-driver prompt natural and moving workflow requirements into the Patchlane skills.

## Design principles

- `evals/intents/*.json` is the authoritative scenario contract; scenario code must not duplicate it.
- `skills/*/SKILL.md` describes worker behavior and safety boundaries.
- The user-driver prompt describes a normal user pursuing the contract; it must not prescribe shell commands or evaluator steps.
- Assertions verify repository state, approvals, and outcomes rather than requiring a particular conversation script.
- The local extension is a guardrail for Pi sessions, not the only enforcement mechanism; CI and tests must detect intent drift too.

## Proposed layout

```text
AGENTS.md
.pi/
  extensions/
    eval-intent-guard.ts
evals/
  intents/
    setup.json
    feature-add.json
    feature-change.json
    sync-repair.json
    health-check.json
  user-driver/
    system.md
    initial.md
    follow-up.md
  intent.ts
  scenarios/*.ts   # setup, assertions, and fixture wiring only
```

## Phase 1: Establish the immutable intent boundary

1. Add a root `AGENTS.md` with minimal, high-value guidance:
    - Never edit `evals/intents/*.json` to make an eval pass.
    - Put worker behavior changes in the relevant `skills/*/SKILL.md`.
    - Put evaluation logic changes in assertions or runner code, with a reason.
    - Treat intent changes as contract changes requiring explicit review and a fresh baseline.
    - Run the eval type-check, unit tests, formatting, artifact check, and relevant live evals before publication.
2. Move each current `Scenario.intent` object verbatim into its corresponding JSON file.
3. Add a strict loader/validator in `evals/intent.ts` for the existing fields:
   `name`, `goal`, `preferences`, `authorization`, `prohibitions`, and `maxTurns`.
4. Refactor scenario factories to load the JSON intent instead of defining process instructions inline.
5. Add a test that every registered scenario has exactly one intent file and that the loaded JSON matches the expected schema.

## Phase 2: Isolate the user-driver policy and templates

The generated user turns cannot be frozen—the driver model must still respond to worker output—but the instructions that shape those turns can and should be immutable.

1. Move the user-driver system policy out of `evals/runner.ts` into `evals/user-driver/system.md`.
2. Move the initial and follow-up prompt templates into `evals/user-driver/initial.md` and `evals/user-driver/follow-up.md`.
3. Keep interpolation in one small loader: templates may receive only the validated scenario JSON and sanitized worker response.
4. Remove prompt prose from the runner; it should load the protected files and assemble messages without changing their policy.
5. Record a policy/template bundle hash in each transcript, while retaining compatibility parsing for older transcript versions.

## Phase 3: Add the repo-local Pi guard

Create `.pi/extensions/eval-intent-guard.ts` using Pi's `tool_call` event. Resolve paths relative to the repository root and protect both `evals/intents/**` and `evals/user-driver/**`, so normal source, assertion, and skill work remains possible.

The extension should:

- Block built-in `write` and `edit` calls targeting `evals/intents/**` or `evals/user-driver/**`, including normalized absolute paths and traversal attempts.
- Block shell commands that would mutate a protected intent or driver-policy file, including redirection, `tee`, `sed -i`, copy/move/remove, and common Git restore/reset/checkout operations involving the protected directories.
- Allow read-only inspection such as `read`, `git diff`, `git show`, and `grep`.
- Block commits or staged Git operations that include an intent file, even when the command itself does not name the path.
- Fail closed for ambiguous shell mutations rather than prompting the model to override the guard.
- Return a clear block reason naming the protected policy, without exposing hidden evaluator details.
- Remain safe in non-interactive modes: never assume a UI confirmation is available.

Add focused extension helpers for path normalization, read-only command classification, and staged-file detection so the policy is testable without starting a full interactive session.

## Phase 4: Make skills carry the workflow

Update the skills, not the driver prompt, with the requirements currently being forced through user messages:

- `patchlane-fork-setup`: inspect first, map existing fork changes, preserve the base ref by default, obtain mapping and plan approval before mutations, and publish only explicitly authorized patch refs.
- `patchlane-workspace`: require workspace creation only after approval, inspect JSON status immediately, work only in the composed workspace, and run status plus dry-run landing validation.
- `patchlane-sync-patches`: keep diagnosis, disposable candidate creation, local projection, and publication as separate boundaries; use only a disposable local origin for candidate validation.

Keep scenario intents focused on user outcomes and safety preferences. Do not add exact command names, evaluator check names, or turn-by-turn instructions to make a model pass.

## Phase 5: Enforce contract integrity outside Pi

1. Add a deterministic contract-integrity check used by tests and the publication workflow.
2. Store a reviewed hash manifest for `evals/intents/*.json` and `evals/user-driver/*`, or require an explicit update command that regenerates it and prints the changed contracts.
3. Fail the check when an intent, policy, or template changes without the corresponding approved baseline update.
4. Keep the Pi extension as the interactive protection and the hash check as the CI/repository protection; neither should depend on model compliance.
5. Ensure failed eval artifacts include the intent and driver-bundle hashes so a run can be reproduced without silently accepting a changed contract.

## Phase 6: Test and rollout

- Unit-test JSON validation and scenario/intent registration.
- Unit-test the extension against direct writes, path traversal, shell mutations, read-only commands, and commits containing protected files.
- Run an integration test with a disposable Pi session that confirms a blocked tool call leaves the intent file unchanged.
- Verify ordinary edits to skills, assertions, and source files remain allowed.
- Revert procedural coaching added to the user-driver prompt and scenario goals/preferences; retain only generic message-format validation if it is still needed.
- Run `npm run evals:check`, `npm test`, `npm run artifacts:check`, `npm run format:check`, and the authenticated full eval suite.
- Review the final diff to confirm intent files changed only through the explicit contract-update path.

## Completion criteria

- A Pi agent cannot edit or commit `evals/intents/*.json` or `evals/user-driver/*` through normal file or shell tools.
- CI rejects unreviewed intent, policy, or template changes.
- Scenario TypeScript contains no duplicated intent contract or inline driver policy.
- Worker skills, rather than the synthetic user prompt, explain all required workflow steps.
- The natural authenticated eval suite passes without prompt text that names evaluator-specific commands or process choreography.
