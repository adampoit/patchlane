import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const contractManifestPath = 'evals/contract-hashes.json';
const CONTRACT_DIRECTORIES = ['evals/intents', 'evals/user-driver'] as const;

export type ContractManifest = {
	version: 1;
	files: Record<string, string>;
};

function contractFilesIn(root: string, relativeDirectory: string): string[] {
	const directory = path.join(root, relativeDirectory);
	return readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) => {
			const relativePath = path.posix.join(relativeDirectory, entry.name);
			return entry.isDirectory() ? contractFilesIn(root, relativePath) : entry.isFile() ? [relativePath] : [];
		})
		.sort();
}

export function createContractManifest(root: string): ContractManifest {
	const files = CONTRACT_DIRECTORIES.flatMap((directory) => contractFilesIn(root, directory)).sort();
	return {
		version: 1,
		files: Object.fromEntries(
			files.map((file) => [
				file,
				createHash('sha256')
					.update(readFileSync(path.join(root, file)))
					.digest('hex'),
			]),
		),
	};
}

export function readContractManifest(root: string): ContractManifest {
	const value = JSON.parse(readFileSync(path.join(root, contractManifestPath), 'utf8')) as unknown;
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid contract manifest');
	const candidate = value as { version?: unknown; files?: unknown };
	if (candidate.version !== 1 || !candidate.files || typeof candidate.files !== 'object') {
		throw new Error('invalid contract manifest');
	}
	for (const [file, hash] of Object.entries(candidate.files)) {
		if (!CONTRACT_DIRECTORIES.some((directory) => file.startsWith(`${directory}/`))) {
			throw new Error(`contract manifest contains an invalid path: ${file}`);
		}
		if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
			throw new Error(`contract manifest contains an invalid hash for: ${file}`);
		}
	}
	return candidate as ContractManifest;
}

export function contractManifestChanges(expected: ContractManifest, actual: ContractManifest) {
	const files = new Set([...Object.keys(expected.files), ...Object.keys(actual.files)]);
	return [...files]
		.sort()
		.filter((file) => expected.files[file] !== actual.files[file])
		.map((file) => ({
			file,
			kind:
				expected.files[file] === undefined ? 'added' : actual.files[file] === undefined ? 'removed' : 'changed',
		}));
}
