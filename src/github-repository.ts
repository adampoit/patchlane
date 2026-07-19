import { run } from './subprocess.js';

type ForkRepositoryOptions = {
	cwd: string;
	repository?: string;
	originRemoteName?: string;
};

function repositoryName(value: string | undefined) {
	const normalized = value?.trim().replace(/\.git$/, '');
	return normalized && /^[^\s/]+\/[^\s/]+$/.test(normalized) ? normalized : undefined;
}

export function githubRepositoryFromRemote(remoteUrl: string | undefined) {
	const normalized = remoteUrl?.trim();
	if (!normalized) return undefined;

	try {
		const url = new URL(normalized);
		if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) return undefined;
		return repositoryName(url.pathname.replace(/^\//, ''));
	} catch {
		const scpMatch = normalized.match(/^(?:[^@\s]+@)?github\.com:([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
		return scpMatch ? `${scpMatch[1]}/${scpMatch[2]}` : undefined;
	}
}

export function resolveForkRepository(options: ForkRepositoryOptions) {
	if (options.repository !== undefined) {
		const explicit = repositoryName(options.repository);
		if (!explicit) throw new Error(`Invalid GitHub repository '${options.repository}'; expected owner/repo.`);
		return explicit;
	}

	const originRemoteName = options.originRemoteName ?? 'origin';
	const remote = run('git', ['remote', 'get-url', '--push', originRemoteName], options.cwd);
	if (remote.status === 0) {
		const repository = githubRepositoryFromRemote(remote.stdout);
		if (repository) return repository;
	}

	const environmentRepository = repositoryName(process.env.GITHUB_REPOSITORY);
	if (environmentRepository) return environmentRepository;

	throw new Error(
		`Could not determine the fork GitHub repository from the '${originRemoteName}' push target. ` +
			`Configure that remote to point at GitHub or pass --repository=owner/repo.`,
	);
}
