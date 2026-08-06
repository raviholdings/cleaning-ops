const VALID_EXPOSURE_STATUSES = new Set(['unexposed', 'unknown', 'exposed']);
const ALL_STATUS_TOKENS = new Set(['', '*', 'all', 'none', 'off', '0']);

export function parseCrawlExposureStatuses(value) {
	const raw = String(value ?? '').trim().toLowerCase();
	if (ALL_STATUS_TOKENS.has(raw)) return [];

	const statuses = [...new Set(raw
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean))];
	const invalid = statuses.filter((status) => !VALID_EXPOSURE_STATUSES.has(status));
	if (invalid.length > 0) {
		throw new Error(`Invalid crawl exposure status: ${invalid.join(', ')}`);
	}
	return statuses;
}

export function resolveCrawlExposureStatuses({
	project,
	configuredStatuses,
	unexposedOnlyProjects = '',
} = {}) {
	if (configuredStatuses !== undefined) {
		return parseCrawlExposureStatuses(configuredStatuses);
	}

	return projectListIncludes(unexposedOnlyProjects, project) ? ['unexposed'] : [];
}

export function parseCrawlExposurePriorityOverride(value) {
	if (value === undefined || value === null || String(value).trim() === '') return null;

	const normalized = String(value).trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	throw new Error(`Invalid crawl exposure priority override: ${value}`);
}

export function resolveCrawlExposurePriority({
	databaseEnabled = false,
	configuredEnabled,
	exposureStatuses = [],
} = {}) {
	if (exposureStatuses.length > 0) {
		return { enabled: true, source: 'strict-exposure-statuses' };
	}

	const override = parseCrawlExposurePriorityOverride(configuredEnabled);
	if (override !== null) {
		return { enabled: override, source: 'environment-override' };
	}

	return { enabled: databaseEnabled === true, source: 'database' };
}

function projectListIncludes(value, project) {
	const normalizedProject = String(project || '').trim().toLowerCase();
	return String(value || '')
		.split(',')
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean)
		.includes(normalizedProject);
}
