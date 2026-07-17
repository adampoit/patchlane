import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function getPackageVersion() {
	const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
	const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
	if (typeof packageJson.version !== 'string' || !packageJson.version) {
		throw new Error('Patchlane package version is missing.');
	}
	return packageJson.version;
}
