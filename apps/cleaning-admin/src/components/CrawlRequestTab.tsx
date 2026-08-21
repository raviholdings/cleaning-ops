import React from 'react';
import { Send, CheckCircle2, AlertTriangle, Clock, Layers, Zap } from 'lucide-react';
import { CrawlTodayStat, CandidateProjectStat } from '../types';

/*
 * 수집요청 현황 — 업종별 카드 하나씩, 숫자만.
 *
 * 이전 판은 일자별 그래프(recharts)와 최근 7일 로그 목록을 그렸는데, 그 뒤의
 * 쿼리(URL LIKE 풀스캔 + 일자별 집계)가 호출당 23~43초로 DB 를 포화시켜
 * 수집요청 러너·색인 루프까지 타임아웃으로 죽였다 (2026-08-21 실측).
 * 지금은 오늘(KST) 집계 카운트만 프로젝트별로 받아 숫자로 보여준다.
 */

interface CrawlRequestTabProps {
  crawlTodayByProject: CrawlTodayStat[];
  candidateStats: CandidateProjectStat[];
}

const PROJECTS = [
  { key: 'cleaning-ravi', label: '청소', accent: '#818cf8', bg: 'rgba(99, 102, 241, 0.12)' },
  { key: 'moving-ravi', label: '이사', accent: '#67e8f9', bg: 'rgba(6, 182, 212, 0.12)' },
];

function Metric({ label, value, color, icon }: { label: string; value: number; color: string; icon: React.ReactNode }) {
  return (
    <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: '1.8rem', fontWeight: 800, color, marginTop: '4px' }}>
        {value.toLocaleString()} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>건</span>
      </div>
    </div>
  );
}

export default function CrawlRequestTab({ crawlTodayByProject, candidateStats }: CrawlRequestTabProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div className="glass-panel" style={{ padding: '24px' }}>
        <h2 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Zap size={22} color="#6366f1" /> 수집요청 현황 (오늘 · KST)
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px' }}>
          업종별 오늘 실행·제출·실패 건수. 자정(KST)에 일일 한도가 리셋됩니다. 갱신은 브라우저 새로고침.
        </p>
      </div>

      {PROJECTS.map((project) => {
        const today = crawlTodayByProject.find((r) => r.target_project === project.key);
        const candidates = candidateStats.find((r) => r.target_project === project.key);
        return (
          <div key={project.key} className="glass-panel" style={{ padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ padding: '4px 12px', borderRadius: '8px', background: project.bg, color: project.accent }}>
                  {project.label}
                </span>
              </h3>
              {candidates && (
                <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Layers size={14} /> 수집 대상 풀 {candidates.total.toLocaleString()}장
                </div>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
              <Metric label="오늘 실행" value={today?.processed || 0} color={project.accent} icon={<Send size={14} />} />
              <Metric label="오늘 제출 성공" value={today?.submitted || 0} color="#34d399" icon={<CheckCircle2 size={14} />} />
              <Metric label="오늘 실패" value={today?.failed || 0} color="#f87171" icon={<AlertTriangle size={14} />} />
              <Metric label="한도 중지 (내일 이월)" value={today?.quota_stop || 0} color="#fbbf24" icon={<Clock size={14} />} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
