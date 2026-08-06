#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	contractManifestChanges,
	contractManifestPath,
	createContractManifest,
	readContractManifest,
	type ContractManifest,
} from '../evals/contract-integrity.ts';

const root = process.cwd();
const update = process.argv.slice(2).includes('--update');
const manifestFile = path.join(root, contractManifestPath);
const actual = createContractManifest(root);
let expected: ContractManifest = { version: 1, files: {} };
if (existsSync(manifestFile)) expected = readContractManifest(root);
const changes = contractManifestChanges(expected, actual);

if (update) {
	if (!changes.length) {
		console.log('Eval contracts are unchanged.');
		process.exit(0);
	}
	for (const change of changes) console.log(`${change.kind}: ${change.file}`);
	writeFileSync(manifestFile, `${JSON.stringify(actual, null, 2)}\n`);
	console.log(`Updated ${contractManifestPath}; review every contract change and establish a fresh baseline.`);
	process.exit(0);
}

if (changes.length) {
	for (const change of changes) console.error(`${change.kind}: ${change.file}`);
	console.error(
		'Eval contracts differ from the reviewed baseline; use npm run evals:contracts:update after approval.',
	);
	process.exit(1);
}
console.log('Eval contract integrity check passed.');
