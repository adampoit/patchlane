import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPackageVersion } from './package-version.js';

const DEFAULT_INSTALL_DIR = '.agents/skills';
const INSTALL_STATE_FILE = '.patchlane-install.json';
const BUNDLED_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

type SkillManifest = {
	version: 1;
	skills: SkillDefinition[];
};

type SkillDefinition = {
	name: string;
	files: string[];
};

type InstallState = {
	managedSkills: string[];
	sourceBaseUrl: string;
};

type InstallPatchlaneAgentsOptions = {
	installDir?: string;
	ref?: string;
};

type SkillFile = {
	relativePath: string;
	contents: string;
};

type FetchedSkill = {
	name: string;
	files: SkillFile[];
};

function log(message: string) {
	process.stdout.write(`${message}\n`);
}

function fail(message: string): never {
	throw new Error(message);
}

function env(name: string, fallback?: string) {
	return process.env[name] || fallback;
}

function normalizeBaseUrl(value: string) {
	return value.replace(/\/+$/, '');
}

function resolveSourceBaseUrl(ref: string) {
	const overridden = env('PATCHLANE_SKILLS_BASE_URL');
	if (overridden) return normalizeBaseUrl(overridden);
	return normalizeBaseUrl(`https://raw.githubusercontent.com/adampoit/patchlane/${ref}/skills`);
}

function buildUrl(baseUrl: string, relativePath: string) {
	return new URL(relativePath, `${baseUrl}/`).toString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSkillName(name: string) {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
		fail(`Invalid skill name '${name}' in manifest.`);
	}
}

function validateRelativePath(relativePath: string) {
	if (!relativePath) fail('Manifest contained an empty file path.');
	if (path.isAbsolute(relativePath)) {
		fail(`Manifest path '${relativePath}' must be relative.`);
	}

	const segments = relativePath.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		fail(`Manifest path '${relativePath}' is not safe to write.`);
	}
}

function parseManifest(value: unknown): SkillManifest {
	if (!isPlainObject(value)) fail('Skills manifest must be an object.');
	if (value.version !== 1) fail('Unsupported skills manifest version.');
	if (!Array.isArray(value.skills) || value.skills.length === 0) {
		fail('Skills manifest did not contain any skills.');
	}

	const skills = value.skills.map((entry) => {
		if (!isPlainObject(entry)) fail('Each skills manifest entry must be an object.');
		const name = entry.name;
		const files = entry.files;

		if (typeof name !== 'string') fail('Skill manifest entry is missing a string name.');
		validateSkillName(name);

		if (!Array.isArray(files) || files.length === 0) {
			fail(`Skill '${name}' must declare at least one file.`);
		}

		const normalizedFiles = files.map((file) => {
			if (typeof file !== 'string') {
				fail(`Skill '${name}' contained a non-string file path.`);
			}
			validateRelativePath(file);
			return file;
		});

		return { name, files: normalizedFiles } satisfies SkillDefinition;
	});

	return {
		version: 1,
		skills,
	};
}

async function fetchText(url: string) {
	const response = await fetch(url);
	if (!response.ok) {
		fail(`Failed to download '${url}': ${response.status} ${response.statusText}`.trim());
	}
	return response.text();
}

function parseManifestText(raw: string) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		fail('Failed to parse the Patchlane skills manifest as JSON.');
	}
	return parseManifest(parsed);
}

async function fetchManifest(sourceBaseUrl: string) {
	return parseManifestText(await fetchText(buildUrl(sourceBaseUrl, 'manifest.json')));
}

function readBundledManifest() {
	let raw: string;
	try {
		raw = readFileSync(path.join(BUNDLED_SKILLS_DIR, 'manifest.json'), 'utf8');
	} catch (error) {
		fail(`Failed to read bundled Patchlane skills: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseManifestText(raw);
}

function readBundledSkills(manifest: SkillManifest): FetchedSkill[] {
	return manifest.skills.map((skill) => ({
		name: skill.name,
		files: skill.files.map((relativePath) => {
			const filePath = path.join(BUNDLED_SKILLS_DIR, skill.name, relativePath);
			try {
				return { relativePath, contents: readFileSync(filePath, 'utf8') };
			} catch (error) {
				fail(
					`Failed to read bundled skill file '${filePath}': ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}),
	}));
}

async function fetchSkill(sourceBaseUrl: string, skill: SkillDefinition): Promise<FetchedSkill> {
	const files = await Promise.all(
		skill.files.map(async (relativePath) => ({
			relativePath,
			contents: await fetchText(buildUrl(sourceBaseUrl, `${skill.name}/${relativePath}`)),
		})),
	);

	return {
		name: skill.name,
		files,
	};
}

function readInstallState(filePath: string): InstallState {
	if (!existsSync(filePath)) {
		return {
			managedSkills: [],
			sourceBaseUrl: '',
		};
	}

	try {
		const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
		if (!isPlainObject(parsed)) throw new Error();
		const managedSkills = Array.isArray(parsed.managedSkills)
			? parsed.managedSkills.filter((value): value is string => typeof value === 'string')
			: [];
		const sourceBaseUrl = typeof parsed.sourceBaseUrl === 'string' ? parsed.sourceBaseUrl : '';
		managedSkills.forEach(validateSkillName);
		return { managedSkills, sourceBaseUrl };
	} catch {
		return {
			managedSkills: [],
			sourceBaseUrl: '',
		};
	}
}

function writeSkillFiles(installDir: string, skill: FetchedSkill) {
	const skillDir = path.join(installDir, skill.name);
	rmSync(skillDir, { force: true, recursive: true });
	mkdirSync(skillDir, { recursive: true });

	for (const file of skill.files) {
		const destination = path.join(skillDir, file.relativePath);
		mkdirSync(path.dirname(destination), { recursive: true });
		writeFileSync(destination, file.contents);
	}
}

export async function installPatchlaneAgents(options: InstallPatchlaneAgentsOptions = {}) {
	const installDir = path.resolve(process.cwd(), options.installDir ?? DEFAULT_INSTALL_DIR);
	const configuredRef = options.ref ?? env('PATCHLANE_SKILLS_REF');
	const hasExplicitRemoteSource = configuredRef !== undefined || Boolean(env('PATCHLANE_SKILLS_BASE_URL'));
	const useBundledSkills = !hasExplicitRemoteSource && existsSync(path.join(BUNDLED_SKILLS_DIR, 'manifest.json'));
	let sourceBaseUrl: string;
	let fetchedSkills: FetchedSkill[];

	if (useBundledSkills) {
		sourceBaseUrl = pathToFileURL(BUNDLED_SKILLS_DIR).toString();
		log(`Using bundled Patchlane agent skills from ${BUNDLED_SKILLS_DIR}`);
		const manifest = readBundledManifest();
		fetchedSkills = readBundledSkills(manifest);
	} else {
		const ref = configuredRef ?? `v${getPackageVersion()}`;
		sourceBaseUrl = resolveSourceBaseUrl(ref);
		log(`Fetching Patchlane agent skills from ${sourceBaseUrl}`);
		const manifest = await fetchManifest(sourceBaseUrl);
		fetchedSkills = await Promise.all(manifest.skills.map((skill) => fetchSkill(sourceBaseUrl, skill)));
	}

	mkdirSync(installDir, { recursive: true });
	const installStatePath = path.join(installDir, INSTALL_STATE_FILE);
	const priorState = readInstallState(installStatePath);
	const nextSkillNames = new Set(fetchedSkills.map((skill) => skill.name));

	for (const staleSkill of priorState.managedSkills) {
		if (!nextSkillNames.has(staleSkill)) {
			rmSync(path.join(installDir, staleSkill), {
				force: true,
				recursive: true,
			});
		}
	}

	for (const skill of fetchedSkills) {
		writeSkillFiles(installDir, skill);
		log(`Installed ${skill.name}`);
	}

	writeFileSync(
		installStatePath,
		`${JSON.stringify(
			{
				managedSkills: fetchedSkills.map((skill) => skill.name),
				sourceBaseUrl,
			} satisfies InstallState,
			null,
			2,
		)}\n`,
	);

	log(
		`Synced ${fetchedSkills.length} Patchlane agent ${fetchedSkills.length === 1 ? 'skill' : 'skills'} into ${path.relative(process.cwd(), installDir) || '.'}`,
	);
}
