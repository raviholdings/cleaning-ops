import React, { useState } from 'react';
import { Rocket, CheckCircle2, Clock, AlertTriangle, Search, Server, ExternalLink } from 'lucide-react';
import { DeploymentSummary, RootDomainStat } from '../types';
import { useDomainList } from '../useDomainList';
import Pager from './Pager';

interface DeploymentStatusTabProps {
  summary: DeploymentSummary | null;
  rootDomains: RootDomainStat[];
}

const n = (value: number) => value.toLocaleString();

export default function DeploymentStatusTab({ summary, rootDomains }: DeploymentStatusTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const totalDomains = summary?.total_domains ?? 0;
  const deployedCount = summary?.deployed_domains ?? 0;
  const activeCount = summary?.active_domains ?? 0;
  const reserveCount = summary?.reserve_domains ?? 0;

  const deploymentRate = totalDomains > 0
    ? Math.round((deployedCount / totalDomains) * 100)
    : 0;
  const activeRate = totalDomains > 0 ? Math.round((activeCount / totalDomains) * 100) : 0;

  const pagePerSite = totalDomains > 0 && summary
    ? Math.round(summary.total_pages / totalDomains)
    : 100;

  const { rows: filteredDomains, total, page, setPage, totalPages, loading } = useDomainList({
    q: searchQuery,
    deployed: statusFilter === 'deployed' ? 'yes' : statusFilter === 'pending' ? 'no' : '',
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
              메인도메인 {summary?.root_domains ?? '-'}개 · 서브도메인 {n(totalDomains)}개 · 서브도메인당 {pagePerSite}장
              {summary?.last_deployed_at && ` · 최종 배포 ${new Date(summary.last_deployed_at).toLocaleString()}`}
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
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px' }}>
              {n(deployedCount)} / {n(totalDomains)} 서브도메인
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>활성 도메인</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#34d399', marginTop: '4px' }}>
              {n(activeCount)} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>개</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px' }}>
              소유확인 완료 · 전체의 {activeRate}%
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>예비 도메인</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#fbbf24', marginTop: '4px' }}>
              {n(reserveCount)} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>개</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px' }}>
              배포는 됐으나 소유확인 전
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>활성 페이지</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#818cf8', marginTop: '4px' }}>
              {n(summary?.active_pages ?? activeCount * pagePerSite)} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>장</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px' }}>
              배포 {n(summary?.deployed_pages ?? deployedCount * pagePerSite)}장 / 전체 {n(summary?.total_pages ?? totalDomains * pagePerSite)}장
            </div>
          </div>
        </div>
      </div>

      {/* 메인도메인별 내역 */}
      {rootDomains.length > 0 && (
        <div className="glass-panel" style={{ padding: '20px 24px 8px' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <Server size={17} color="#818cf8" /> 메인도메인별 내역
          </h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', marginTop: '12px' }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ padding: '10px 12px', textAlign: 'left' }}>메인도메인</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }}>서브도메인</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }}>배포</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }}>활성</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }}>예비</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }}>전체 페이지</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right' }}>활성 페이지</th>
                </tr>
              </thead>
              <tbody>
                {rootDomains.map(row => (
                  <tr key={row.root} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={{ padding: '10px 12px', fontWeight: 600, color: '#ffffff' }}>{row.root}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>{n(row.subdomains)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: '#10b981' }}>{n(row.deployed)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: '#34d399' }}>{n(row.active)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: '#fbbf24' }}>{n(row.subdomains - row.active)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>{n(row.pages)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', color: '#818cf8' }}>{n(row.active_pages)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
                    {loading ? '불러오는 중…' : '도메인이 없거나 검색 조건과 매칭되지 않습니다.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager page={page} totalPages={totalPages} total={total} loading={loading} onChange={setPage} />
      </div>

    </div>
  );
}
