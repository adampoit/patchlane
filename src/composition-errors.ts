export type CompositionErrorCode =
	'missing_lane' | 'invalid_lane' | 'invalid_lane_base' | 'conflict' | 'workflow_policy';

export class CompositionError extends Error {
	readonly name = 'CompositionError';

	constructor(
		readonly code: CompositionErrorCode,
		message: string,
		readonly details: Record<string, unknown> = {},
	) {
		super(message);
	}
}

export function isCompositionError(error: unknown): error is CompositionError {
	return error instanceof CompositionError;
}
