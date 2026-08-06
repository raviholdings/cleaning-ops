import React, { useState } from 'react';
import { Globe, Search, MapPin, KeyRound, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';
import { DomainInfo } from '../types';

interface DomainRegistryTabProps {
  domains: DomainInfo[];
}

export default function DomainRegistryTab({ domains }: DomainRegistryTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [areaFilter, setAreaFilter] = useState('all');

  const totalDomains = domains.length;
  const targetTotal = 1000;
  const registrationProgress = Math.round((totalDomains / targetTotal) * 100);

  const uniqueAreas = Array.from(new Set(domains.map(d => d.area_name).filter(Boolean))) as string[];

  const filteredDomains = domains.filter(d => {
    const matchesArea = areaFilter === 'all' || d.area_name === areaFilter;
    const matchesSearch = searchQuery === '' ||
      d.domain_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (d.area_name && d.area_name.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (d.naver_account_id && d.naver_account_id.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesArea && matchesSearch;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      
      {/* Header & KPI */}
      <div className="glass-panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div>
            <h2 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Globe size={22} color="#06b6d4" /> 1,000개 도메인 등록 현황 (Domain Registry)
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px' }}>
              지역별 서브도메인 카탈로그 등록 및 프로젝트 매핑 현황
            </p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>현재 등록된 도메인 수</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#06b6d4', marginTop: '4px' }}>
              {totalDomains} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>/ 1,000 개</span>
            </div>
            <div style={{ height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', marginTop: '8px', overflow: 'hidden' }}>
              <div style={{ width: `${registrationProgress}%`, height: '100%', background: '#06b6d4' }} />
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>타겟 행정 구역/지역 수</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#38bdf8', marginTop: '4px' }}>
              {uniqueAreas.length} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>개 지역</span>
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>프로젝트 그룹 키</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#818cf8', marginTop: '6px' }}>
              {domains[0]?.project_key || 'cleaning-ravi'}
            </div>
          </div>
        </div>
      </div>

      {/* Filter & Search */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <select
            value={areaFilter}
            onChange={(e) => setAreaFilter(e.target.value)}
            style={{
              padding: '8px 14px',
              borderRadius: '8px',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid var(--border-color)',
              color: '#ffffff',
              fontSize: '0.85rem',
              outline: 'none'
            }}
          >
            <option value="all" style={{ background: '#121826' }}>전체 지역 보기</option>
            {uniqueAreas.map(area => (
              <option key={area} value={area} style={{ background: '#121826' }}>{area}</option>
            ))}
          </select>
        </div>

        <div style={{ position: 'relative', width: '280px' }}>
          <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="도메인 주소, 지역, 계정 검색..."
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
                <th style={{ padding: '14px 16px' }}>대표 행정 지역</th>
                <th style={{ padding: '14px 16px' }}>담당 네이버 계정</th>
                <th style={{ padding: '14px 16px' }}>등록 일시</th>
                <th style={{ padding: '14px 16px' }}>바로가기</th>
              </tr>
            </thead>
            <tbody>
              {filteredDomains.map(d => (
                <tr key={d.domain_name} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '14px 16px', fontWeight: 600, color: '#ffffff' }}>
                    {d.domain_name}
                  </td>
                  <td style={{ padding: '14px 16px', color: '#38bdf8' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      <MapPin size={13} /> {d.area_name || '-'}
                    </span>
                  </td>
                  <td style={{ padding: '14px 16px', color: 'var(--text-muted)' }}>
                    {d.naver_account_id || '미지정'}
                  </td>
                  <td style={{ padding: '14px 16px', color: 'var(--text-muted)' }}>
                    {d.created_at ? new Date(d.created_at).toLocaleDateString() : '-'}
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
                    등록된 도메인이 없거나 조건에 맞는 결과가 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
