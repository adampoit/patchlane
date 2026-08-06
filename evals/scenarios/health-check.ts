import {
	assistantText,
	bashCommands,
	check,
	commandCheck,
	forbiddenCheck,
	preApprovalMutationCheck,
} from '../assertions.ts';
import { createFixture, git, optionalRef, targetTip } from '../fixtures.ts';
import { loadScenarioIntent } from '../intent.ts';
import type { Scenario } from '../types.ts';

export function healthCheckScenario(): Scenario {
	const intent = loadScenarioIntent('health-check');
	return {
		name: intent.name,
		description: 'Check Patchlane configuration and sync health without changing repository state.',
		intent,
		setup: createFixture,
		assert: (context, run) => {
			const commands = bashCommands(run);
			const text = assistantText(run.events);
			return [
				preApprovalMutationCheck(run, undefined, 'kept the repository unchanged during the read-only check'),
				commandCheck(commands, /(?:npx\s+)?patchlane(?:@[^\s]+)?\s+doctor\b/, 'ran Patchlane doctor'),
				commandCheck(commands, /patchlane(?:@[^\s]+)?\s+sync[\s\S]*--dry-run/, 'validated sync with a dry run'),
				forbiddenCheck(
					commands,
					/(?:workspace\s+(?:create|land|remove)|\bgit\b[^;&|\n]*\b(?:commit|push)\b|--push\b|--force\b)/,
					'did not modify workspaces, refs, or remotes',
				),
				check(/doctor|healthy|valid|warning|error|sync/.test(text), 'reported the health result'),
				check(
					targetTip(context.forkBare, context.root, context.targetLane) === context.targetLaneBefore &&
						optionalRef(context.forkWork, `refs/heads/${context.targetLane}`) ===
							context.targetLaneLocalBefore,
					'left configured lane refs unchanged',
				),
				check(
					optionalRef(context.forkWork, 'refs/heads/patch/sync') === context.sourceLaneBefore &&
						git(['status', '--porcelain'], context.forkWork).trim() === '',
					'left the original worktree clean',
				),
			];
		},
	};
}
