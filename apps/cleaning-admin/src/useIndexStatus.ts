import { useCallback, useEffect, useRef, useState } from 'react';
import { IndexBucket, IndexRoot, IndexRow, IndexSummary } from './types';

export type IndexFilter = 'indexed' | 'not_indexed' | 'all';

/**
 * 색인 현황을 서버에서 쪽 단위로 가져온다.
 *
 * useDomainList 와 같은 모양이다. 다른 점은 요약·구간표·루트별 집계가 목록과
 * 같은 응답에 실려 온다는 것뿐이다. 세 가지를 따로 부르면 왕복이 세 번이 되고,
 * 어차피 서버에서 같은 CTE 를 공유하므로 한 번에 받는 편이 싸다.
 */
export function useIndexStatus(filter: IndexFilter, q: string, groupKey = '', pageSize = 50) {
  const [summary, setSummary] = useState<IndexSummary | null>(null);
  const [buckets, setBuckets] = useState<IndexBucket[]>([]);
  const [roots, setRoots] = useState<IndexRoot[]>([]);
  const [rows, setRows] = useState<IndexRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const requestId = useRef(0);

  useEffect(() => { setPage(1); }, [filter, q, groupKey]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page), pageSize: String(pageSize), filter,
      });
      if (q) params.set('q', q);
      if (groupKey && groupKey !== 'all') params.set('groupKey', groupKey);
      const res = await fetch(`/api/index-status?${params.toString()}`, { signal });
      if (!res.ok) throw new Error(`색인 현황을 불러오지 못했습니다 (HTTP ${res.status})`);
      const data = await res.json();
      if (id !== requestId.current) return;
      setSummary(data.summary || null);
      setBuckets(data.buckets || []);
      setRoots(data.roots || []);
      setRows(data.rows || []);
      setTotal(Number(data.total) || 0);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      if (id === requestId.current) setError(String(err?.message || err));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [page, pageSize, filter, q, groupKey]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => { void load(controller.signal); }, q ? 300 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [load, q]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return { summary, buckets, roots, rows, total, page, setPage, totalPages, loading, error };
}
