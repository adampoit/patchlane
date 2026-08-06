# AGENTS.md

## Eval contract boundaries

- Never edit `evals/intents/*.json` or `evals/user-driver/*` to make an eval pass.
- Put worker workflow and safety changes in the relevant `skills/*/SKILL.md`.
- Change eval assertions or runner logic only for a documented evaluation reason.
- Treat intent, user-driver policy, and template changes as contract changes requiring explicit review and a fresh baseline via `npm run evals:contracts:update`.
