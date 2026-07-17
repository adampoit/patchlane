export type UpstreamSource =
	{ kind: 'release'; selector: string; value: string } | { kind: 'branch'; ref: string; value: string };

export function parseUpstreamSource(value: string): UpstreamSource {
	const separator = value.indexOf(':');
	if (separator < 1) {
		throw new Error(
			`Invalid upstream source '${value}'. Use 'release:latest', 'release:prerelease', 'release:<regex>', or 'branch:<ref>'.`,
		);
	}

	const kind = value.slice(0, separator);
	const target = value.slice(separator + 1).trim();
	if (!target) {
		throw new Error(`Invalid upstream source '${value}'; the source target cannot be empty.`);
	}

	if (kind === 'release') {
		return { kind, selector: target, value: `release:${target}` };
	}
	if (kind === 'branch') {
		return { kind, ref: target, value: `branch:${target}` };
	}

	throw new Error(
		`Invalid upstream source kind '${kind}'. Use 'release:latest', 'release:prerelease', 'release:<regex>', or 'branch:<ref>'.`,
	);
}

export function resolveUpstreamSource(
	source: string | undefined,
	upstreamRef: string,
	releaseSelector: string,
): UpstreamSource {
	if (source) return parseUpstreamSource(source);
	if (releaseSelector) return parseUpstreamSource(`release:${releaseSelector}`);
	return parseUpstreamSource(`branch:${upstreamRef}`);
}
