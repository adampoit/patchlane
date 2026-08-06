import path from 'node:path';

export const repoRoot = path.resolve(import.meta.dirname, '..');
export const cliPath = path.join(repoRoot, 'dist', 'cli.js');
export const skillPaths = [
	path.join(repoRoot, 'skills', 'patchlane-fork-setup', 'SKILL.md'),
	path.join(repoRoot, 'skills', 'patchlane-health-check', 'SKILL.md'),
	path.join(repoRoot, 'skills', 'patchlane-migrate', 'SKILL.md'),
	path.join(repoRoot, 'skills', 'patchlane-sync-patches', 'SKILL.md'),
	path.join(repoRoot, 'skills', 'patchlane-workspace', 'SKILL.md'),
];
export const defaultModel = 'opencode-go/deepseek-v4-pro';
export const defaultUserModel = 'opencode-go/deepseek-v4-pro';
