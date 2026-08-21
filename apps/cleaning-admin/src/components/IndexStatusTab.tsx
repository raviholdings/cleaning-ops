import React, { useState } from 'react';
import { Search, TrendingUp, AlertTriangle } from 'lucide-react';
import Pager from './Pager';
import { IndexFilter, useIndexStatus } from '../useIndexStatus';

/**
 * 색인 현황.
 *
 * 여기 숫자는 전부 "도메인별 최신 정상 조사"를 기준으로 한다. 프록시가
 * 막혀 실패한 행은 서버에서 걸러낸다. 그걸 안 거르면 조사에 실패한 것과
 * 색인이 안 된 것이 구분되지 않아 색인률이 실제보다 훨씬 낮게 보인다.
 *
 * 그래서 "조사 완료 / 전체"를 맨 앞에 둔다. 색인률만 크게 띄우면 아직
 * 조사도 안 한 도메인이 몇 개인지 안 보인다.
 */
interface IndexStatusTabProps {
  selectedGroupKey?: string;
}

export default function IndexStatusTab({ selectedGroupKey = '' }: IndexStatusTabProps) {
  const [filter, setFilter] = useState<IndexFilter>('indexed');
  const [q, setQ] = useState('');
  const { summary, buckets, roots, rows, total, page, setPage, totalPages, loading, error } =
    useIndexStatus(filter, q, selectedGroupKey);

  const totalDomains = summary?.total_domains ?? 0;
  const checked = summary?.checked ?? 0;
  const indexed = summary?.indexed ?? 0;
  const posts = summary?.indexed_posts ?? 0;

  const indexRate = checked > 0 ? ((indexed / checked) * 100).toFixed(1) : '0';
  const checkRate = totalDomains > 0 ? ((checked / totalDomains) * 100).toFixed(1) : '0';

  const cards = [
    { label: '조사 완료', value: checked, unit: '개', color: '#ffffff', hint: `전체 ${totalDomains.toLocaleString()}개 중 ${checkRate}%` },
    { label: '색인된 도메인', value: indexed, unit: '개', color: '#34d399', hint: `조사분의 ${indexRate}%` },
    { label: '색인된 페이지', value: posts, unit: '장', color: '#818cf8', hint: '네이버 검색 노출 기준' },
    { label: '미색인', value: Math.max(0, checked - indexed), unit: '개', color: '#fbbf24', hint: '조사했으나 안 잡힌 것' },
  ];

  const filters: { key: IndexFilter; label: string }[] = [
    { key: 'indexed', label: '색인됨' },
    { key: 'not_indexed', label: '미색인' },
    { key: 'all', label: '전체' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div className="glass-panel" style={{ padding: '24px' }}>
        <h2 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <TrendingUp size={22} color="#34d399" /> 색인 현황
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px', marginBottom: '20px' }}>
          네이버에서 <code style={{ color: '#a5b4fc' }}>site:도메인</code> 으로 검색해 실제 노출되는 URL 을 센 결과
          {summary?.last_checked && ` · 마지막 조사 ${new Date(summary.last_checked).toLocaleString('ko-KR')}`}
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          {cards.map((c) => (
            <div key={c.label} style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{c.label}</div>
              <div style={{ fontSize: '1.8rem', fontWeight: 800, color: c.color, marginTop: '4px' }}>
                {c.value.toLocaleString()} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>{c.unit}</span>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>{c.hint}</div>
            </div>
          ))}
        </div>

        {checked < totalDomains && (
          <div style={{
            marginTop: '16px', padding: '12px 14px', borderRadius: '10px',
            background: 'rgba(251, 191, 36, 0.08)', border: '1px solid rgba(251, 191, 36, 0.25)',
            display: 'flex', gap: '8px', alignItems: 'flex-start',
          }}>
            <AlertTriangle size={16} color="#fbbf24" style={{ flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '0.82rem', color: '#fde68a' }}>
              아직 {(totalDomains - checked).toLocaleString()}개가 미조사입니다. 네이버가 짧은 시간에 몰린 요청을
              막기 때문에 한 번에 다 돌리지 못하고 나눠서 조사합니다. 위 색인률은 조사된 {checked.toLocaleString()}개 기준입니다.
            </div>
          </div>
        )}
      </div>

      {/* 수집요청을 얼마나 넣었느냐에 따라 색인률이 갈리는지 — 이 표가 이 화면의 핵심이다. */}
      <div className="glass-panel" style={{ padding: '24px' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#ffffff', marginBottom: '4px' }}>
          수집요청 대비 색인률
        </h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '16px' }}>
          수집요청을 많이 넣은 도메인일수록 색인이 잘 되는지 확인한다
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>수집요청</th>
              <th style={{ padding: '8px 10px' }}>도메인</th>
              <th style={{ padding: '8px 10px' }}>색인됨</th>
              <th style={{ padding: '8px 10px' }}>색인률</th>
              <th style={{ padding: '8px 10px' }}>평균 색인 장수</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => {
              const rate = b.domains > 0 ? (100 * b.indexed) / b.domains : 0;
              return (
                <tr key={b.bucket} style={{ borderTop: '1px solid rgba(255,255,255,0.06)', color: '#e2e8f0', textAlign: 'right' }}>
                  <td style={{ textAlign: 'left', padding: '10px' }}>{b.bucket}</td>
                  <td style={{ padding: '10px' }}>{b.domains.toLocaleString()}</td>
                  <td style={{ padding: '10px' }}>{b.indexed.toLocaleString()}</td>
                  <td style={{ padding: '10px', fontWeight: 700, color: rate >= 80 ? '#34d399' : rate >= 50 ? '#fbbf24' : '#f87171' }}>
                    {rate.toFixed(1)}%
                  </td>
                  <td style={{ padding: '10px' }}>{(b.avg_posts ?? 0).toFixed(1)}</td>
                </tr>
              );
            })}
            {!buckets.length && (
              <tr><td colSpan={5} style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>조사 결과가 없습니다</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {roots.length > 0 && (
        <div className="glass-panel" style={{ padding: '24px' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#ffffff', marginBottom: '16px' }}>루트 도메인별</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
            {roots.map((r) => {
              const rate = r.checked > 0 ? (100 * r.indexed) / r.checked : 0;
              return (
                <div key={r.root} style={{ background: 'rgba(0,0,0,0.2)', padding: '12px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ fontSize: '0.82rem', color: '#e2e8f0', fontWeight: 600 }}>{r.root}</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 700, color: rate >= 80 ? '#34d399' : '#fbbf24', marginTop: '4px' }}>
                    {rate.toFixed(0)}% <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 400 }}>
                      ({r.indexed}/{r.checked})
                    </span>
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{r.posts.toLocaleString()}장 색인</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="glass-panel" style={{ padding: '0', overflow: 'hidden' }}>
        <div style={{ padding: '20px 24px', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '6px' }}>
            {filters.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                style={{
                  padding: '6px 14px', borderRadius: '8px', fontSize: '0.82rem', cursor: 'pointer',
                  border: filter === f.key ? '1px solid var(--border-highlight)' : '1px solid var(--border-color)',
                  background: filter === f.key ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.05)',
                  color: '#ffffff',
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
            <Search size={15} color="var(--text-muted)" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="도메인 검색"
              style={{
                width: '100%', padding: '8px 10px 8px 32px', borderRadius: '8px',
                border: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.25)',
                color: '#ffffff', fontSize: '0.85rem',
              }}
            />
          </div>
        </div>

        {error && (
          <div style={{ padding: '16px 24px', color: '#f87171', fontSize: '0.85rem' }}>{error}</div>
        )}

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', background: 'rgba(0,0,0,0.2)' }}>
                <th style={{ textAlign: 'left', padding: '10px 24px' }}>도메인</th>
                <th style={{ textAlign: 'left', padding: '10px' }}>계정</th>
                <th style={{ textAlign: 'right', padding: '10px' }}>색인 장수</th>
                <th style={{ textAlign: 'center', padding: '10px' }}>색인</th>
                <th style={{ textAlign: 'left', padding: '10px 24px' }}>조사 시각</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.domain} style={{ borderTop: '1px solid rgba(255,255,255,0.06)', color: '#e2e8f0' }}>
                  <td style={{ padding: '10px 24px' }}>
                    <a
                      href={`https://search.naver.com/search.naver?where=web&query=${encodeURIComponent(`site:${r.domain}`)}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: '#a5b4fc', textDecoration: 'none' }}
                    >
                      {r.domain}
                    </a>
                  </td>
                  <td style={{ padding: '10px', color: 'var(--text-muted)' }}>
                    {r.account_order ? `#${r.account_order}` : (r.naver_account_id || '-')}
                  </td>
                  <td style={{ padding: '10px', textAlign: 'right', fontWeight: 700 }}>
                    {(r.indexed_post_count ?? 0).toLocaleString()}
                  </td>
                  <td style={{ padding: '10px', textAlign: 'center' }}>
                    <span style={{
                      padding: '2px 10px', borderRadius: '999px', fontSize: '0.75rem',
                      background: r.indexed ? 'rgba(52,211,153,0.15)' : 'rgba(148,163,184,0.15)',
                      color: r.indexed ? '#34d399' : '#94a3b8',
                    }}>
                      {r.indexed ? '색인됨' : '미색인'}
                    </span>
                  </td>
                  <td style={{ padding: '10px 24px', color: 'var(--text-muted)' }}>
                    {r.checked_at ? new Date(r.checked_at).toLocaleString('ko-KR') : '-'}
                  </td>
                </tr>
              ))}
              {!rows.length && !loading && (
                <tr><td colSpan={5} style={{ padding: '28px', textAlign: 'center', color: 'var(--text-muted)' }}>해당하는 도메인이 없습니다</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <Pager page={page} totalPages={totalPages} total={total} loading={loading} onChange={setPage} />
      </div>
    </div>
  );
}
