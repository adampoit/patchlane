import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const WORKFLOW_DIRECTORY = '.github/workflows';
const LOCAL_WORKFLOW_PREFIX = `./${WORKFLOW_DIRECTORY}/`;

export type WorkflowFile = {
	file: string;
	content: string;
};

export type WorkflowPolicyViolation = {
	message: string;
};

function localWorkflowReferences(contents: string) {
	let workflow: unknown;
	try {
		workflow = parse(contents) as unknown;
	} catch {
		return [];
	}

	const references = new Set<string>();
	const visited = new WeakSet<object>();

	function visit(value: unknown) {
		if (typeof value !== 'object' || value === null || visited.has(value)) return;
		visited.add(value);

		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}

		for (const [key, child] of Object.entries(value)) {
			if (key === 'uses' && typeof child === 'string' && child.startsWith(LOCAL_WORKFLOW_PREFIX)) {
				const target = child.slice(LOCAL_WORKFLOW_PREFIX.length);
				if (/\.ya?ml$/.test(target)) references.add(target);
			}
			visit(child);
		}
	}

	visit(workflow);
	return [...references].sort();
}

export function validateWorkflowPolicy(
	allowedWorkflows: string[] | undefined,
	workflowFiles: WorkflowFile[],
): WorkflowPolicyViolation[] {
	if (allowedWorkflows === undefined) return [];

	const allowed = new Set(allowedWorkflows);
	const actual = new Set(workflowFiles.map(({ file }) => file));
	const violations: WorkflowPolicyViolation[] = [];

	for (const file of [...actual].sort()) {
		if (!allowed.has(file)) {
			violations.push({
				message: `Unexpected workflow '${WORKFLOW_DIRECTORY}/${file}' is not in allowedWorkflows.`,
			});
		}
	}

	for (const file of [...allowed].sort()) {
		if (!actual.has(file)) {
			violations.push({
				message: `Allowed workflow '${WORKFLOW_DIRECTORY}/${file}' is missing from the composed tree.`,
			});
		}
	}

	for (const { file, content } of [...workflowFiles].sort((left, right) => left.file.localeCompare(right.file))) {
		for (const target of localWorkflowReferences(content)) {
			if (!actual.has(target)) {
				violations.push({
					message: `Workflow '${WORKFLOW_DIRECTORY}/${file}' references missing local reusable workflow '${WORKFLOW_DIRECTORY}/${target}'.`,
				});
			} else if (!allowed.has(target)) {
				violations.push({
					message: `Workflow '${WORKFLOW_DIRECTORY}/${file}' references disallowed local reusable workflow '${WORKFLOW_DIRECTORY}/${target}'.`,
				});
			}
		}
	}

	return violations;
}

export function workflowFilesAtRef(cwd: string, ref: string): WorkflowFile[] {
	const listed = spawnSync('git', ['ls-tree', '-r', '--name-only', ref, '--', WORKFLOW_DIRECTORY], {
		cwd,
		encoding: 'utf8',
	});
	if (listed.error || listed.status !== 0) {
		throw new Error(
			`Could not inspect workflows at ${ref}: ${(listed.error?.message ?? listed.stderr.trim()) || 'git ls-tree failed'}`,
		);
	}

	return listed.stdout
		.split(/\r?\n/)
		.filter((file) => file.startsWith(`${WORKFLOW_DIRECTORY}/`) && /\.ya?ml$/.test(file))
		.map((file) => {
			const shown = spawnSync('git', ['show', `${ref}:${file}`], { cwd, encoding: 'utf8' });
			if (shown.error || shown.status !== 0) {
				throw new Error(
					`Could not read workflow '${file}' at ${ref}: ${(shown.error?.message ?? shown.stderr.trim()) || 'git show failed'}`,
				);
			}
			return { file: file.slice(WORKFLOW_DIRECTORY.length + 1), content: shown.stdout };
		});
}
