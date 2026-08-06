import React, { useState } from 'react';
import { Send, CheckCircle2, AlertTriangle, Clock, BarChart3, Search, RefreshCw, Zap } from 'lucide-react';
import { 
  ResponsiveContainer, 
  XAxis, 
  YAxis, 
  Tooltip, 
  CartesianGrid,
  BarChart,
  Bar,
  Legend
} from 'recharts';
import { CrawlDailyStat, CrawlLog } from '../types';

interface CrawlRequestTabProps {
  crawlDailyStats: CrawlDailyStat[];
  todayCrawl: CrawlDailyStat | null;
  crawlDailyQuota: number;
  totalCrawlResultCount: number;
  recentLogs: CrawlLog[];
}

export default function CrawlRequestTab({
  crawlDailyStats,
  todayCrawl,
  crawlDailyQuota,
  totalCrawlResultCount,
  recentLogs
}: CrawlRequestTabProps) {
  const [logSearchQuery, setLogSearchQuery] = useState('');

  const todaySubmitted = todayCrawl?.submitted || 0;
  const todayTotal = todayCrawl?.total || 0;
  const quotaProgress = Math.min(100, Math.round((todayTotal / crawlDailyQuota) * 100));

  const filteredLogs = recentLogs.filter(log => 
    logSearchQuery === '' ||
    log.domain_name.toLowerCase().includes(logSearchQuery.toLowerCase()) ||
    (log.path && log.path.toLowerCase().includes(logSearchQuery.toLowerCase())) ||
    (log.status && log.status.toLowerCase().includes(logSearchQuery.toLowerCase()))
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      
      {/* Header & KPI */}
      <div className="glass-panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div>
            <h2 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Send size={22} color="#6366f1" /> 네이버 수집 요청 현황 (SearchAdvisor Crawl Operations)
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px' }}>
              Windows Runner & HaiIP IP 로테이션 수집요청 실시간 일별 집계 및 로그
            </p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          
          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>오늘 수집요청 처리량</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#818cf8', marginTop: '4px' }}>
              {todayTotal.toLocaleString()} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>/ 50,000 건</span>
            </div>
            <div style={{ height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', marginTop: '8px', overflow: 'hidden' }}>
              <div style={{ width: `${quotaProgress}%`, height: '100%', background: 'linear-gradient(90deg, #6366f1, #06b6d4)' }} />
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>오늘 성공 제출 (Submitted)</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#34d399', marginTop: '4px' }}>
              {todaySubmitted.toLocaleString()} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>건</span>
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>누적 전체 수집요청 수</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#ffffff', marginTop: '4px' }}>
              {totalCrawlResultCount.toLocaleString()} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>건</span>
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>러너 상태 (siwol-win)</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#34d399', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Zap size={18} /> 정상 가동 중
            </div>
          </div>

        </div>
      </div>

      {/* Daily Recharts Bar Visualization */}
      <div className="glass-panel" style={{ padding: '24px' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#ffffff', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <BarChart3 size={18} color="#818cf8" /> 일별 수집요청 제출 추이 (Daily Crawl Volume)
        </h3>

        {crawlDailyStats.length > 0 ? (
          <div style={{ width: '100%', height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={crawlDailyStats} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="date" stroke="var(--text-muted)" fontSize={12} />
                <YAxis stroke="var(--text-muted)" fontSize={12} />
                <Tooltip 
                  contentStyle={{ background: '#121826', border: '1px solid var(--border-color)', borderRadius: '8px', color: '#ffffff' }} 
                />
                <Legend wrapperStyle={{ paddingTop: '10px' }} />
                <Bar dataKey="submitted" name="제출 성공" fill="#10b981" radius={[4, 4, 0, 0]} stackId="a" />
                <Bar dataKey="quotaStop" name="할당량 정지" fill="#f59e0b" radius={[4, 4, 0, 0]} stackId="a" />
                <Bar dataKey="failed" name="실패" fill="#ef4444" radius={[4, 4, 0, 0]} stackId="a" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
            일별 집계된 수집 요청 통계가 없습니다.
          </div>
        )}
      </div>

      {/* Recent Crawl Logs Table */}
      <div className="glass-panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#ffffff' }}>
            최근 수집요청 실행 이력 로그 (Recent Execution Logs)
          </h3>

          <div style={{ position: 'relative', width: '260px' }}>
            <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="도메인, 경로 검색..."
              value={logSearchQuery}
              onChange={(e) => setLogSearchQuery(e.target.value)}
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

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                <th style={{ padding: '12px 14px' }}>요청 일시</th>
                <th style={{ padding: '12px 14px' }}>대상 도메인</th>
                <th style={{ padding: '12px 14px' }}>요청 경로 (Path)</th>
                <th style={{ padding: '12px 14px' }}>상태 (Status)</th>
                <th style={{ padding: '12px 14px' }}>응답 메시지</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map(log => (
                <tr key={log.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '12px 14px', color: 'var(--text-muted)' }}>
                    {log.requested_at ? new Date(log.requested_at).toLocaleString() : '-'}
                  </td>
                  <td style={{ padding: '12px 14px', fontWeight: 600, color: '#ffffff' }}>
                    {log.domain_name}
                  </td>
                  <td style={{ padding: '12px 14px', fontFamily: 'monospace', color: '#38bdf8' }}>
                    {log.path || '/'}
                  </td>
                  <td style={{ padding: '12px 14px' }}>
                    {log.status === 'submitted' ? (
                      <span className="badge badge-success">제출성공</span>
                    ) : log.status === 'quota-stop' ? (
                      <span className="badge badge-warning">한도정지</span>
                    ) : (
                      <span className="badge badge-danger">{log.status}</span>
                    )}
                  </td>
                  <td style={{ padding: '12px 14px', color: 'var(--text-muted)' }}>
                    {log.response_message || 'OK'}
                  </td>
                </tr>
              ))}
              {filteredLogs.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    최근 수집요청 로그가 없습니다.
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
