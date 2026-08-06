# Skill evals

These evals run a real pi worker agent against disposable local Git repositories. A separate pi user-driver agent supplies the next natural user message, asks for clarification, approves only authorized actions, and ends the conversation when it is complete, blocked, or unsafe. The driver has no repository or shell tools; deterministic Git, file, workflow, and command-outcome checks remain the source of truth for pass/fail.

They are intentionally opt-in because each run makes model requests. The draft-release workflow runs the full suite once as a fail-fast gate before creating a draft GitHub release; routine CI does not run live evals.

```bash
npm run evals -- --scenario setup
npm run evals -- --scenario feature-add
npm run evals -- --scenario feature-change
npm run evals -- --scenario sync-repair
npm run evals -- --scenario health-check
```

The worker and user-driver models are configured independently:

```bash
PATCHLANE_EVAL_API_KEY=... npm run evals -- \
  --model opencode-go/deepseek-v4-pro \
  --user-model opencode-go/deepseek-v4-pro
# or provide separate provider keys
npm run evals -- --model openai/gpt-5.6 --api-key-env OPENAI_API_KEY \
  --user-model anthropic/claude-sonnet-4-6 --user-api-key-env ANTHROPIC_API_KEY
```

Use `--fail-fast` to stop an all-scenario run after its first failure while preserving the suite's declared scenario order. Use `--auth-path` and `--user-auth-path` only when explicitly testing subscription-backed models. The harness never reads `~/.pi/agent/auth.json` implicitly, and it removes configured and ambient credential variables from the worker environment after initializing both model runtimes. Use `--keep` to retain successful fixtures for inspection; failed fixtures are retained automatically. Each run writes a versioned `user-driver-transcript.json` beside the worker event log.

A failed user-driver run can be replayed without another user-model request:

```bash
npm run evals -- --scenario sync-repair --replay /path/to/user-driver-transcript.json
```

The harness passes the three Patchlane skills explicitly to the worker and disables unrelated project context, extensions, and skill discovery so failures are attributable to the Patchlane instructions. The user driver receives only the protected policy and templates in `evals/user-driver/`, the validated contract in `evals/intents/`, and sanitized worker responses. Transcripts record hashes for both contract bundles.

Run `npm run evals:contracts` to verify the reviewed hash manifest. Contract changes require explicit review and a fresh baseline generated with `npm run evals:contracts:update`; the update command prints every added, changed, or removed contract.
