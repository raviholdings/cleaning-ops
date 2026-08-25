import React, { useCallback, useEffect, useState } from 'react';
import { Phone, RefreshCw, Search, Check } from 'lucide-react';
import Pager from './Pager.tsx';

/*
 * 배관 접수 화면 (lead-dashboard.uloung.com).
 * 접수된 건을 보고 고객에게 전화하는 용도라, 전화번호는 tel: 링크로 바로 걸 수
 * 있게 두고 "전화함" 표시와 메모를 남긴다.
 */

interface Lead {
  id: string;
  created_at: string;
  area_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  request_notes: string | null;
  host: string | null;
  site_url: string | null;
  handled_at: string | null;
  handled_by: string | null;
  memo: string | null;
}

interface LeadDashboardProps {
  user: { name: string | null; username: string; role: 'owner' | 'staff' | 'member' };
}

const PAGE_SIZE = 50;

const cell: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border-color)',
  fontSize: '0.85rem',
  verticalAlign: 'top',
};

const chip = (active: boolean): React.CSSProperties => ({
  padding: '6px 14px',
  borderRadius: '999px',
  border: '1px solid var(--border-color)',
  background: active ? 'rgba(96,165,250,0.25)' : 'rgba(255,255,255,0.05)',
  color: '#ffffff',
  fontSize: '0.85rem',
  cursor: 'pointer',
});

function fmt(ts: string) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function LeadDashboard({ user }: LeadDashboardProps) {
  const allowed = user.role === 'owner' || user.role === 'staff';
  const [rows, setRows] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [unhandled, setUnhandled] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<'unhandled' | 'all' | 'handled'>('unhandled');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    // 권한이 없으면 요청 자체를 보내지 않는다. 서버도 403 으로 막지만(requireRole),
    // 화면에서 헛되이 부르지 않게 한다.
    if (!allowed) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), status });
      if (search) params.set('q', search);
      const res = await fetch(`/api/leads?${params}`);
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
      // 라우트가 없으면 Vite 가 index.html 을 200 으로 돌려준다. 그대로 파싱하면
      // "Unexpected token '<'" 이 떠서 원인을 알 수 없다 — 먼저 걸러낸다.
      if (!res.headers.get('content-type')?.includes('application/json')) {
        throw new Error('API(/api/leads)가 응답하지 않습니다. 관리자 서버를 재시작해야 합니다 '
          + '(scripts/run-admin-server.ps1 -Rebuild).');
      }
      const data = await res.json();
      setRows(data.rows || []);
      setTotal(data.total || 0);
      setUnhandled(data.unhandled || 0);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [page, status, search]);

  useEffect(() => { load(); }, [load]);

  if (!allowed) {
    return (
      <div style={{ padding: '64px 24px', textAlign: 'center', color: '#9ca3af' }}>
        <h1 style={{ fontSize: '1.2rem', color: '#fff', marginBottom: '10px' }}>접근 권한이 없습니다</h1>
        <p style={{ fontSize: '0.9rem', margin: 0 }}>
          배관 접수 화면은 고객 개인정보를 다루므로 <strong style={{ color: '#d1d5db' }}>소유자·스태프</strong>만
          볼 수 있습니다. 권한이 필요하면 소유자에게 요청하세요.
        </p>
        <p style={{ fontSize: '0.8rem', marginTop: '14px' }}>
          로그인 계정: {user.name || user.username} (멤버)
        </p>
      </div>
    );
  }

  async function patch(id: string, body: Record<string, unknown>) {
    const res = await fetch('/api/leads', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...body }),
    });
    if (!res.ok) { setError('저장에 실패했습니다.'); return; }
    const saved = await res.json();
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...saved } : r)));
    if ('handled' in body) setUnhandled((n) => (body.handled ? Math.max(0, n - 1) : n + 1));
  }

  return (
    <div style={{ padding: '24px', maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '18px' }}>
        <h1 style={{ fontSize: '1.4rem', margin: 0 }}>배관 접수</h1>
        <span style={{ color: '#9ca3af', fontSize: '0.9rem' }}>
          미처리 <strong style={{ color: '#f87171' }}>{unhandled}</strong> · 전체 {total}
        </span>
        <button onClick={load} disabled={loading} style={chip(false)}>
          <RefreshCw size={14} style={{ verticalAlign: '-2px' }} /> 새로고침
        </button>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
        {(['unhandled', 'all', 'handled'] as const).map((s) => (
          <button key={s} onClick={() => { setStatus(s); setPage(1); }} style={chip(status === s)}>
            {s === 'unhandled' ? '미처리' : s === 'all' ? '전체' : '처리됨'}
          </button>
        ))}
        <form
          onSubmit={(e) => { e.preventDefault(); setSearch(q); setPage(1); }}
          style={{ display: 'flex', gap: '6px', marginLeft: 'auto' }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="이름 · 전화 · 지역 · 내용"
            style={{
              padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--border-color)',
              background: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: '0.85rem', minWidth: '220px',
            }}
          />
          <button type="submit" style={chip(false)}><Search size={14} /></button>
        </form>
      </div>

      {error && (
        <div style={{
          padding: '10px 14px', marginBottom: '12px', borderRadius: '8px',
          background: 'rgba(248,113,113,0.15)', color: '#fca5a5', fontSize: '0.85rem',
        }}>
          {error}
        </div>
      )}

      <div style={{ overflowX: 'auto', border: '1px solid var(--border-color)', borderRadius: '12px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '900px' }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
              {['접수', '지역', '이름', '전화', '문의내용', '메모', '처리'].map((h) => (
                <th key={h} style={{ ...cell, textAlign: 'left', fontWeight: 600, color: '#d1d5db' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ opacity: r.handled_at ? 0.55 : 1 }}>
                <td style={{ ...cell, whiteSpace: 'nowrap' }}>{fmt(r.created_at)}</td>
                <td style={cell}>{r.area_name || '-'}</td>
                <td style={cell}>{r.customer_name || '-'}</td>
                <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                  {r.customer_phone ? (
                    <a
                      href={`tel:${r.customer_phone.replace(/[^0-9+]/g, '')}`}
                      style={{ color: '#60a5fa', textDecoration: 'none', fontWeight: 600 }}
                    >
                      <Phone size={13} style={{ verticalAlign: '-2px' }} /> {r.customer_phone}
                    </a>
                  ) : '-'}
                </td>
                <td style={{ ...cell, maxWidth: '320px', whiteSpace: 'pre-wrap' }}>{r.request_notes || '-'}</td>
                <td style={cell}>
                  <input
                    defaultValue={r.memo || ''}
                    placeholder="메모"
                    onBlur={(e) => { if (e.target.value !== (r.memo || '')) patch(r.id, { memo: e.target.value }); }}
                    style={{
                      width: '160px', padding: '4px 8px', borderRadius: '6px',
                      border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)',
                      color: '#fff', fontSize: '0.8rem',
                    }}
                  />
                </td>
                <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                  <button onClick={() => patch(r.id, { handled: !r.handled_at })} style={chip(!!r.handled_at)}>
                    {r.handled_at ? <><Check size={13} /> {r.handled_by || '처리됨'}</> : '전화함'}
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr>
                <td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#9ca3af', padding: '32px' }}>
                  접수된 건이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: '14px' }}>
        <Pager
          page={page}
          totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
          total={total}
          loading={loading}
          onChange={setPage}
        />
      </div>
    </div>
  );
}
