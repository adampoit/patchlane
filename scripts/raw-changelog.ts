#!/usr/bin/env node --experimental-strip-types

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

type Commit = {
	hash: string;
	subject: string;
	files: string[];
};

function git(args: string[]) {
	return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function ref(input: string) {
	if (input === 'HEAD') return input;
	if (input.startsWith('v')) return input;
	if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(input)) return `v${input}`;
	return input;
}

function latestTag() {
	try {
		return git(['describe', '--tags', '--abbrev=0']);
	} catch {
		return '';
	}
}

function commitType(subject: string) {
	if (/^(fix|bugfix)\b|fix/i.test(subject)) return 'Bugfixes';
	if (/^(feat|feature)\b/i.test(subject)) return 'Features';
	return 'Improvements';
}

function isInternal(subject: string) {
	return (
		/^(chore|ci|docs|test|tests|style|format|release)(\(.+\))?:/i.test(subject) ||
		/^Bump version to /i.test(subject) ||
		/^Bump .+ from .+ to .+\s*\(#\d+\)$/i.test(subject) ||
		/^Apply adampoit\/conventions\//i.test(subject)
	);
}

function commits(from: string, to: string) {
	const range = from ? `${ref(from)}..${ref(to)}` : ref(to);
	const hashes = git(['log', '--format=%H', range]).split('\n').filter(Boolean);

	return hashes
		.map((hash): Commit => {
			const subject = git(['show', '-s', '--format=%s', hash]);
			const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', hash]).split('\n').filter(Boolean);
			return { hash: hash.slice(0, 7), subject, files };
		})
		.filter((commit) => !isInternal(commit.subject));
}

function format(from: string, to: string, list: Commit[]) {
	const groups = new Map<string, Commit[]>([
		['Features', []],
		['Improvements', []],
		['Bugfixes', []],
	]);

	for (const commit of list) {
		groups.get(commitType(commit.subject))!.push(commit);
	}

	const lines = [`Last release: ${from || 'none'}`, `Target ref: ${ref(to)}`, ''];
	if (list.length === 0) {
		lines.push('No notable changes.');
		return lines.join('\n');
	}

	for (const [title, entries] of groups) {
		if (entries.length === 0) continue;
		lines.push(`## ${title}`);
		for (const entry of entries) {
			lines.push(`- \`${entry.hash}\` ${entry.subject}`);
			if (entry.files.length > 0) lines.push(`  Files: ${entry.files.join(', ')}`);
		}
		lines.push('');
	}

	if (lines.at(-1) === '') lines.pop();
	return lines.join('\n');
}

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		from: { type: 'string', short: 'f' },
		to: { type: 'string', short: 't', default: 'HEAD' },
		help: { type: 'boolean', short: 'h', default: false },
	},
});

if (values.help) {
	console.log(`
Usage: node --experimental-strip-types scripts/raw-changelog.ts [options]

Options:
  -f, --from <ref>   Starting ref (default: latest tag, if any)
  -t, --to <ref>     Ending ref (default: HEAD)
  -h, --help         Show this help message
`);
	process.exit(0);
}

const from = values.from ?? latestTag();
const to = values.to ?? 'HEAD';
console.log(format(from, to, commits(from, to)));
