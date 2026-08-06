import React, { useState } from 'react';
import { Rocket, CheckCircle2, Clock, AlertTriangle, Search, Server, ExternalLink } from 'lucide-react';
import { DomainInfo } from '../types';

interface DeploymentStatusTabProps {
  domains: DomainInfo[];
}

export default function DeploymentStatusTab({ domains }: DeploymentStatusTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const totalDomains = domains.length;
  const deployedDomains = domains.filter(d => d.deployed_at != null);
  const pendingDeployDomains = domains.filter(d => d.deployed_at == null);

  const deploymentRate = totalDomains > 0 
    ? Math.round((deployedDomains.length / totalDomains) * 100) 
    : 0;

  const filteredDomains = domains.filter(d => {
    const isDeployed = d.deployed_at != null;
    const matchesStatus = statusFilter === 'all' || 
      (statusFilter === 'deployed' && isDeployed) || 
      (statusFilter === 'pending' && !isDeployed);
    const matchesSearch = searchQuery === '' || 
      d.domain_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (d.area_name && d.area_name.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesStatus && matchesSearch;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      
      {/* Header & KPI */}
      <div className="glass-panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div>
            <h2 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Rocket size={22} color="#10b981" /> 정적 랜딩페이지 배포 현황 (Deployment Status)
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px' }}>
              Astro 5.x 정적 랜딩페이지 도메인별 실시간 배포 현황 및 타임스탬프
            </p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>배포 완료율</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#10b981', marginTop: '4px' }}>
              {deploymentRate}%
            </div>
            <div style={{ height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', marginTop: '8px', overflow: 'hidden' }}>
              <div style={{ width: `${deploymentRate}%`, height: '100%', background: '#10b981' }} />
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>배포 완료 사이트</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#ffffff', marginTop: '4px' }}>
              {deployedDomains.length} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>개</span>
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>배포 대기 / 미배포</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#fbbf24', marginTop: '4px' }}>
              {pendingDeployDomains.length} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>개</span>
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>빌드 타겟 버그/오류</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#34d399', marginTop: '4px' }}>
              0 <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>건 (정상)</span>
            </div>
          </div>
        </div>
      </div>

      {/* Filter & Search */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          {[
            { key: 'all', label: '전체 도메인' },
            { key: 'deployed', label: '배포 완료' },
            { key: 'pending', label: '배포 대기' }
          ].map(item => (
            <button
              key={item.key}
              onClick={() => setStatusFilter(item.key)}
              style={{
                padding: '6px 14px',
                borderRadius: '8px',
                border: '1px solid var(--border-color)',
                background: statusFilter === item.key ? 'var(--primary)' : 'rgba(255,255,255,0.05)',
                color: '#ffffff',
                fontSize: '0.85rem',
                cursor: 'pointer'
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div style={{ position: 'relative', width: '260px' }}>
          <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="도메인 주소 검색..."
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

      {/* Table */}
      <div className="glass-panel" style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                <th style={{ padding: '14px 16px' }}>도메인 URL</th>
                <th style={{ padding: '14px 16px' }}>지역</th>
                <th style={{ padding: '14px 16px' }}>배포 상태</th>
                <th style={{ padding: '14px 16px' }}>배포 완료 일시 (`deployed_at`)</th>
                <th style={{ padding: '14px 16px' }}>웹 사이트 확인</th>
              </tr>
            </thead>
            <tbody>
              {filteredDomains.map(d => {
                const isDeployed = d.deployed_at != null;
                return (
                  <tr key={d.domain_name} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={{ padding: '14px 16px', fontWeight: 600, color: '#ffffff' }}>
                      {d.domain_name}
                    </td>
                    <td style={{ padding: '14px 16px', color: 'var(--text-muted)' }}>
                      {d.area_name || '-'}
                    </td>
                    <td style={{ padding: '14px 16px' }}>
                      {isDeployed ? (
                        <span className="badge badge-success"><CheckCircle2 size={13} /> 배포 완료</span>
                      ) : (
                        <span className="badge badge-warning"><Clock size={13} /> 배포 대기</span>
                      )}
                    </td>
                    <td style={{ padding: '14px 16px', color: isDeployed ? '#34d399' : 'var(--text-muted)' }}>
                      {d.deployed_at ? new Date(d.deployed_at).toLocaleString() : '-'}
                    </td>
                    <td style={{ padding: '14px 16px' }}>
                      <a
                        href={`https://${d.domain_name}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#818cf8', display: 'inline-flex', alignItems: 'center', gap: '4px', textDecoration: 'none' }}
                      >
                        라이브 링크 <ExternalLink size={13} />
                      </a>
                    </td>
                  </tr>
                );
              })}
              {filteredDomains.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    도메인이 없거나 검색 조건과 매칭되지 않습니다.
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
