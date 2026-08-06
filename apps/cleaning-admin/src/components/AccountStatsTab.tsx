import React, { useState } from 'react';
import { KeyRound, ShieldCheck, AlertTriangle, Search, CheckCircle2, UserCheck, Calendar, Globe, Cpu } from 'lucide-react';
import { AccountInfo, DomainInfo } from '../types';

interface AccountStatsTabProps {
  accounts: AccountInfo[];
  domains: DomainInfo[];
}

export default function AccountStatsTab({ accounts, domains }: AccountStatsTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const accountDomainMap: Record<string, number> = {};
  domains.forEach(d => {
    const accId = d.naver_account_id || 'unassigned';
    accountDomainMap[accId] = (accountDomainMap[accId] || 0) + 1;
  });

  const totalAccounts = accounts.length;
  const activeAccounts = accounts.filter(a => a.status === 'active');
  const blockedAccounts = accounts.filter(a => a.status === 'blocked');

  const filteredAccounts = accounts.filter(acc => {
    const matchesStatus = statusFilter === 'all' || acc.status === statusFilter;
    const matchesSearch = searchQuery === '' || 
      acc.account_id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (acc.organization_name && acc.organization_name.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesStatus && matchesSearch;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      
      {/* Header & KPI */}
      <div className="glass-panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div>
            <h2 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <KeyRound size={22} color="#818cf8" /> 계정 확인 & 세션 관리 (Account Monitoring)
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px' }}>
              네이버 서치어드바이저 1,000개 도메인 바인딩 계정 세션 및 할당 현황
            </p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>총 관리 계정 수</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#ffffff', marginTop: '4px' }}>
              {totalAccounts} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>개</span>
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>정상 활성 계정 (Active)</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#34d399', marginTop: '4px' }}>
              {activeAccounts.length} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>개</span>
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>차단/정지 계정 (Blocked)</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#f87171', marginTop: '4px' }}>
              {blockedAccounts.length} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>개</span>
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>평균 계정당 등록 사이트</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#38bdf8', marginTop: '4px' }}>
              {totalAccounts > 0 ? (domains.length / totalAccounts).toFixed(1) : 0} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>개</span>
            </div>
          </div>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          {['all', 'active', 'blocked'].map(st => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              style={{
                padding: '6px 14px',
                borderRadius: '8px',
                border: '1px solid var(--border-color)',
                background: statusFilter === st ? 'var(--primary)' : 'rgba(255,255,255,0.05)',
                color: '#ffffff',
                fontSize: '0.85rem',
                cursor: 'pointer'
              }}
            >
              {st === 'all' ? '전체 계정' : st === 'active' ? '정상 활성' : '차단/제한'}
            </button>
          ))}
        </div>

        <div style={{ position: 'relative', width: '260px' }}>
          <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="계정 ID, 소속 검색..."
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

      {/* Account Table */}
      <div className="glass-panel" style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                <th style={{ padding: '14px 16px' }}>계정 순서</th>
                <th style={{ padding: '14px 16px' }}>네이버 계정 ID</th>
                <th style={{ padding: '14px 16px' }}>소속 / 계정구분</th>
                <th style={{ padding: '14px 16px' }}>할당 도메인 수 / 한도</th>
                <th style={{ padding: '14px 16px' }}>계정 상태</th>
                <th style={{ padding: '14px 16px' }}>최근 세션 검증 시각</th>
                <th style={{ padding: '14px 16px' }}>접속 IP</th>
              </tr>
            </thead>
            <tbody>
              {filteredAccounts.map(acc => {
                const domainCount = accountDomainMap[acc.account_id] || 0;
                return (
                  <tr key={acc.account_id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', transition: 'background 0.2s' }}>
                    <td style={{ padding: '14px 16px', color: 'var(--text-muted)', fontWeight: 600 }}>
                      #{acc.account_order}
                    </td>
                    <td style={{ padding: '14px 16px', fontWeight: 600, color: '#ffffff' }}>
                      {acc.account_id}
                    </td>
                    <td style={{ padding: '14px 16px', color: 'var(--text-muted)' }}>
                      {acc.organization_name} ({acc.account_identity_type})
                    </td>
                    <td style={{ padding: '14px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontWeight: 700, color: domainCount > 0 ? '#38bdf8' : 'var(--text-muted)' }}>
                          {domainCount} 개
                        </span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          / {acc.planned_domain_limit || 100}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: '14px 16px' }}>
                      {acc.status === 'active' ? (
                        <span className="badge badge-success"><CheckCircle2 size={13} /> 정상</span>
                      ) : (
                        <span className="badge badge-danger"><AlertTriangle size={13} /> 제한됨</span>
                      )}
                    </td>
                    <td style={{ padding: '14px 16px', color: 'var(--text-muted)' }}>
                      {acc.searchadvisor_session_validated_at 
                        ? new Date(acc.searchadvisor_session_validated_at).toLocaleString() 
                        : '-'}
                    </td>
                    <td style={{ padding: '14px 16px', color: '#818cf8', fontFamily: 'monospace' }}>
                      {acc.searchadvisor_session_saved_public_ip || '-'}
                    </td>
                  </tr>
                );
              })}
              {filteredAccounts.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    등록된 계정이 없거나 검색 결과가 없습니다.
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
