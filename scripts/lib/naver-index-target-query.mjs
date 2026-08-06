export const NAVER_INDEX_REGISTRY_TARGETS_SQL = `
	with target_rows as (
		select distinct on (target.host)
			target.id as domain_id,
			target.host as domain,
			target.site_url,
			target.naver_account_id,
			target.naver_account_id as city_slug,
			coalesce(target.region_label, target.area_name, target.display_name) as region_label,
			coalesce(nullif(target.page_count, 0), $3)::integer as page_count,
			target.sitemap_url_count,
			target.deployed_at,
			null::timestamptz as updated_at
		from public.naver_index_check_target_domains target
		where target.group_key = $1
			and target.target_project = $2
			and (coalesce(array_length($4::text[], 1), 0) = 0 or target.naver_account_id = any($4::text[]))
			and (
				$5::text = ''
				or lower(target.host) = $5::text
				or lower(target.host) like concat('%.', $5::text)
			)
			and (
				$6::text = 'all'
				or ($6::text = 'netlify' and lower(target.host) like '%.netlify.app')
				or ($6::text = 'non-netlify' and lower(target.host) not like '%.netlify.app')
			)
		order by target.host, target.deployed_at desc nulls last
	),
	crawl as (
		select
			state_crawl.domain_id,
			state_crawl.crawl_submitted_or_present,
			state_crawl.crawl_processed_count,
			state_crawl.crawl_last_requested_at
		from (
			select
				target.domain_id,
				count(*) filter (
					where state.last_status in ('submitted', 'already-present')
				)::integer as crawl_submitted_or_present,
				count(*)::integer as crawl_processed_count,
				max(state.last_attempt_at) as crawl_last_requested_at
			from target_rows target
			join public.naver_project_page_crawl_state state
				on state.domain_id = target.domain_id
			group by target.domain_id
		) state_crawl

		union all

		select
			latest.domain_id,
			count(*) filter (
				where latest.status in ('submitted', 'already-present')
			)::integer as crawl_submitted_or_present,
			count(*)::integer as crawl_processed_count,
			max(latest.requested_at) as crawl_last_requested_at
		from (
			select distinct on (target.domain_id, result.url)
				target.domain_id,
				result.url,
				result.status,
				result.requested_at,
				result.id
			from target_rows target
			join public.naver_searchadvisor_crawl_request_results result
				on result.host = target.domain
			join public.naver_searchadvisor_crawl_request_runs run
				on run.run_id = result.run_id
			where run.target_project = $2
				and not exists (
					select 1
					from public.naver_project_page_crawl_state state
					where state.domain_id = target.domain_id
				)
			order by target.domain_id, result.url, result.requested_at desc, result.id desc
		) latest
		group by latest.domain_id
	)
	select
		target.domain,
		target.site_url,
		target.naver_account_id,
		target.city_slug,
		target.region_label,
		target.page_count,
		target.sitemap_url_count,
		target.deployed_at,
		target.updated_at,
		coalesce(crawl.crawl_submitted_or_present, 0)::integer as crawl_submitted_or_present,
		coalesce(crawl.crawl_processed_count, 0)::integer as crawl_processed_count,
		crawl.crawl_last_requested_at
	from target_rows target
	left join crawl
		on crawl.domain_id = target.domain_id
	order by target.domain
`;

export async function loadNaverIndexRegistryTargets(client, {
	domainGroupKey,
	targetProject,
	targetPageCount,
	deploymentAccountIds = [],
	targetHostSuffix = '',
	targetDomainKind = 'all',
	explicitHosts = new Set(),
	targetLimit = 0
}) {
	const { rows } = await client.query(
		NAVER_INDEX_REGISTRY_TARGETS_SQL,
		[
			domainGroupKey,
			targetProject,
			targetPageCount,
			deploymentAccountIds,
			targetHostSuffix,
			targetDomainKind
		]
	);
	let targets = rows;
	if (explicitHosts.size > 0) {
		targets = targets.filter((row) => explicitHosts.has(String(row.domain || '').toLowerCase()));
	}
	if (targetLimit > 0) targets = targets.slice(0, targetLimit);
	return targets;
}
