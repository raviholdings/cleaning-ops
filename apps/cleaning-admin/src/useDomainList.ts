import { useCallback, useEffect, useRef, useState } from 'react';
import { DomainInfo } from './types';

export interface DomainQuery {
  q?: string;
  status?: string;
  account?: string;
  deployed?: 'yes' | 'no' | '';
  pageSize?: number;
}

/**
 * 도메인 목록을 서버에서 페이지 단위로 가져온다.
 *
 * 예전에는 /api/stats 가 10,000행을 통째로 내려주고 각 탭이 브라우저에서
 * 걸러 썼다. 1.9MB 를 매번 받느라 화면 여는 데 2초가 그것으로 갔고,
 * 도메인이 늘어나면 그대로 비례해 느려지는 구조였다.
 *
 * 검색어는 타이핑할 때마다 요청하지 않도록 300ms 늦춘다.
 */
export function useDomainList(query: DomainQuery) {
  const { q = '', status = '', account = '', deployed = '', pageSize = 50 } = query;

  const [rows, setRows] = useState<DomainInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 응답이 순서를 바꿔 도착하면 옛 결과가 새 결과를 덮어쓴다. 마지막 요청만 반영한다.
  const requestId = useRef(0);

  // 조건이 바뀌면 1페이지로 돌아간다. 3페이지를 보다가 검색하면
  // 결과가 한 페이지뿐인데 3페이지를 달라고 해서 빈 화면이 된다.
  useEffect(() => { setPage(1); }, [q, status, account, deployed, pageSize]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (q) params.set('q', q);
      if (status) params.set('status', status);
      if (account) params.set('account', account);
      if (deployed) params.set('deployed', deployed);

      const res = await fetch(`/api/domains?${params.toString()}`, { signal });
      if (!res.ok) throw new Error(`목록을 불러오지 못했습니다 (HTTP ${res.status})`);
      const data = await res.json();
      if (id !== requestId.current) return;
      setRows(data.rows || []);
      setTotal(Number(data.total) || 0);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      if (id === requestId.current) setError(String(err?.message || err));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [page, pageSize, q, status, account, deployed]);

  useEffect(() => {
    const controller = new AbortController();
    const delay = q ? 300 : 0;
    const timer = setTimeout(() => { void load(controller.signal); }, delay);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [load, q]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return { rows, total, page, setPage, totalPages, loading, error, reload: () => load() };
}
