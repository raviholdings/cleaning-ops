import React, { useState } from 'react';
import { Globe, Search, MapPin, KeyRound, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';
import { OwnershipSummary } from '../types';
import { useDomainList } from '../useDomainList';
import Pager from './Pager';

interface DomainRegistryTabProps {
  summary?: OwnershipSummary | null;
  selectedGroupKey?: string;
}

export default function DomainRegistryTab({ summary, selectedGroupKey }: DomainRegistryTabProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const totalDomains = summary?.total ?? 0;
  const verifiedDomains = summary?.verified ?? 0;

  const {
    rows: filteredDomains, total: listTotal, page, setPage, totalPages, loading,
  } = useDomainList({ q: searchQuery, groupKey: selectedGroupKey });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      
      {/* Header & KPI */}
      <div className="glass-panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div>
            <h2 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Globe size={22} color="#06b6d4" /> 도메인 등록 현황 (Domain Registry)
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px' }}>
              업종/프로젝트별 도메인 등록 목록 및 네이버 계정 매핑 현황
            </p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>현재 등록된 총 도메인 수</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#06b6d4', marginTop: '4px' }}>
              {totalDomains.toLocaleString()} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>개</span>
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>소유 확인 완료 (Verified)</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#10b981', marginTop: '4px' }}>
              {verifiedDomains.toLocaleString()} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>개</span>
            </div>
          </div>
        </div>
      </div>

      {/* Filter & Search */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'flex-end' }}>
        <div style={{ position: 'relative', width: '320px' }}>
          <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="도메인 주소, 계정 ID 검색..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 14px 8px 36px',
              borderRadius: '8px',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid var(--border-color)',
              color: '#ffffff',
              fontSize: '0.85rem',
              outline: 'none'
            }}
          />
        </div>
      </div>

      {/* Domain Table */}
      <div className="glass-panel" style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                <th style={{ padding: '14px 16px' }}>도메인 URL</th>
                <th style={{ padding: '14px 16px' }}>담당 네이버 계정</th>
                <th style={{ padding: '14px 16px' }}>등록 상태</th>
                <th style={{ padding: '14px 16px' }}>배포 일시</th>
                <th style={{ padding: '14px 16px' }}>바로가기</th>
              </tr>
            </thead>
            <tbody>
              {filteredDomains.map(d => (
                <tr key={d.domain_name} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '14px 16px', fontWeight: 600, color: '#ffffff' }}>
                    {d.domain_name}
                  </td>
                  <td style={{ padding: '14px 16px', color: 'var(--text-muted)' }}>
                    {d.naver_account_id || '미지정'}
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <span style={{
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      background: d.naver_registration_status === 'verified' ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)',
                      color: d.naver_registration_status === 'verified' ? '#34d399' : '#fbbf24',
                    }}>
                      {d.naver_registration_status === 'verified' ? '소유확인 완료' : d.naver_registration_status === 'registered' ? '등록 대기' : '미등록'}
                    </span>
                  </td>
                  <td style={{ padding: '14px 16px', color: 'var(--text-muted)' }}>
                    {d.deployed_at ? new Date(d.deployed_at).toLocaleDateString() : '-'}
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <a
                      href={`https://${d.domain_name}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#818cf8', display: 'inline-flex', alignItems: 'center', gap: '4px', textDecoration: 'none' }}
                    >
                      방문 <ExternalLink size={13} />
                    </a>
                  </td>
                </tr>
              ))}
              {filteredDomains.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    {loading ? '불러오는 중…' : '등록된 도메인이 없거나 조건에 맞는 결과가 없습니다.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager page={page} totalPages={totalPages} total={listTotal} loading={loading} onChange={setPage} />
      </div>

    </div>
  );
}
