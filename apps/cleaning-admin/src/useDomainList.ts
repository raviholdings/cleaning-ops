import { useCallback, useEffect, useRef, useState } from 'react';
import { DomainInfo } from './types';

export interface DomainQuery {
  q?: string;
  status?: string;
  account?: string;
  deployed?: 'yes' | 'no' | '';
  groupKey?: string;
  pageSize?: number;
}

export function useDomainList(query: DomainQuery) {
  const { q = '', status = '', account = '', deployed = '', groupKey = '', pageSize = 50 } = query;

  const [rows, setRows] = useState<DomainInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestId = useRef(0);

  useEffect(() => { setPage(1); }, [q, status, account, deployed, groupKey, pageSize]);

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
      if (groupKey && groupKey !== 'all') params.set('groupKey', groupKey);

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
  }, [page, pageSize, q, status, account, deployed, groupKey]);

  useEffect(() => {
    const controller = new AbortController();
    const delay = q ? 300 : 0;
    const timer = setTimeout(() => { void load(controller.signal); }, delay);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [load, q]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return { rows, total, page, setPage, totalPages, loading, error, reload: () => load() };
}
