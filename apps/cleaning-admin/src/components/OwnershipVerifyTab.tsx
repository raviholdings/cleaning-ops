import React, { useState } from 'react';
import { ShieldCheck, Search, Clock, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { OwnershipSummary } from '../types';
import { useDomainList } from '../useDomainList';
import Pager from './Pager';

interface OwnershipVerifyTabProps {
  summary?: OwnershipSummary | null;
}

/**
 * 소유확인 현황.
 *
 * 상태 세 가지가 서로 다른 단계를 뜻한다. 뭉뚱그리면 어디가 막혔는지 안 보인다.
 *   pending    = 네이버 등록 전. 서치어드바이저 인증키를 아직 못 받았다
 *   registered = 인증키는 받았고 소유확인만 남았다
 *   verified   = 소유확인 완료
 */
export default function OwnershipVerifyTab({ summary }: OwnershipVerifyTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'verified' | 'registered' | 'pending'>('all');

  // 요약은 DB 집계를 쓴다. 목록은 /api/domains 가 쪽 단위로 준다.
  const total = summary?.total ?? 0;
  const verified = summary?.verified ?? 0;
  const waiting = summary?.waiting ?? 0;
  const notRegistered = summary?.not_registered ?? 0;
  const pct = total > 0 ? ((verified / total) * 100).toFixed(1) : '0';

  const {
    rows: filtered, total: listTotal, page, setPage, totalPages, loading,
  } = useDomainList({
    q: searchQuery,
    status: statusFilter === 'all' ? '' : statusFilter,
  });

  const cards = [
    { label: '전체 도메인', value: total, color: '#ffffff', hint: '등록 대상 전체' },
    { label: '네이버 등록 전', value: notRegistered, color: '#94a3b8', hint: '인증키 미발급' },
    { label: '소유확인 완료', value: verified, color: '#34d399', hint: `${pct}%` },
    { label: '소유확인 대기', value: waiting, color: '#fbbf24', hint: '인증키 발급됨' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div className="glass-panel" style={{ padding: '24px' }}>
        <h2 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <ShieldCheck size={22} color="#34d399" /> 소유확인 현황
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px', marginBottom: '20px' }}>
          네이버 서치어드바이저 사이트 소유권 인증 진행 상태
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          {cards.map((c) => (
            <div key={c.label} style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{c.label}</div>
              <div style={{ fontSize: '1.8rem', fontWeight: 800, color: c.color, marginTop: '4px' }}>
                {c.value.toLocaleString()} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>개</span>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>{c.hint}</div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: '18px' }}>
          <div style={{ display: 'flex', height: '10px', borderRadius: '5px', overflow: 'hidden', background: 'rgba(255,255,255,0.08)' }}>
            <div style={{ width: `${(verified / Math.max(total, 1)) * 100}%`, background: '#34d399' }} title={`완료 ${verified}`} />
            <div style={{ width: `${(waiting / Math.max(total, 1)) * 100}%`, background: '#fbbf24' }} title={`대기 ${waiting}`} />
            <div style={{ width: `${(notRegistered / Math.max(total, 1)) * 100}%`, background: '#475569' }} title={`등록 전 ${notRegistered}`} />
          </div>
          <div style={{ display: 'flex', gap: '16px', marginTop: '8px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            <span><span style={{ color: '#34d399' }}>■</span> 완료 {verified.toLocaleString()}</span>
            <span><span style={{ color: '#fbbf24' }}>■</span> 대기 {waiting.toLocaleString()}</span>
            <span><span style={{ color: '#475569' }}>■</span> 등록 전 {notRegistered.toLocaleString()}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          {([
            ['all', '전체'],
            ['verified', '소유확인 완료'],
            ['registered', '소유확인 대기'],
            ['pending', '네이버 등록 전'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setStatusFilter(key)}
              style={{
                padding: '6px 14px', borderRadius: '8px', border: '1px solid var(--border-color)',
                background: statusFilter === key ? 'var(--primary)' : 'rgba(255,255,255,0.05)',
                color: '#ffffff', fontSize: '0.85rem', cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ position: 'relative', width: '260px' }}>
          <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="도메인, 계정 검색..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%', padding: '8px 14px 8px 36px', borderRadius: '8px',
              background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-color)',
              color: '#ffffff', fontSize: '0.85rem', outline: 'none',
            }}
          />
        </div>
      </div>

      <div className="glass-panel" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', fontSize: '0.8rem', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>
          조건에 맞는 {listTotal.toLocaleString()}건 중 {filtered.length.toLocaleString()}건 표시
        </div>
        <div style={{ overflowX: 'auto', maxHeight: '520px', overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
            <thead style={{ position: 'sticky', top: 0 }}>
              <tr style={{ background: '#151b2b', borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                <th style={{ padding: '12px 16px' }}>도메인</th>
                <th style={{ padding: '12px 16px' }}>계정</th>
                <th style={{ padding: '12px 16px' }}>상태</th>
                <th style={{ padding: '12px 16px' }}>배포</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((d) => {
                const st = d.naver_registration_status;
                const badge = st === 'verified'
                  ? { text: '소유확인 완료', color: '#34d399', Icon: CheckCircle2 }
                  : st === 'registered'
                    ? { text: '소유확인 대기', color: '#fbbf24', Icon: Clock }
                    : { text: '네이버 등록 전', color: '#94a3b8', Icon: AlertTriangle };
                return (
                  <tr key={d.domain_name} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={{ padding: '10px 16px', color: '#e2e8f0' }}>{d.domain_name}</td>
                    <td style={{ padding: '10px 16px', color: 'var(--text-muted)' }}>{d.naver_account_id || '-'}</td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: badge.color }}>
                        <badge.Icon size={14} /> {badge.text}
                      </span>
                    </td>
                    <td style={{ padding: '10px 16px', color: 'var(--text-muted)' }}>
                      {d.deployed_at ? new Date(d.deployed_at).toLocaleDateString('ko-KR') : '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pager page={page} totalPages={totalPages} total={listTotal} loading={loading} onChange={setPage} />
      </div>
    </div>
  );
}
