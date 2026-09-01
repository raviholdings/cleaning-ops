import React, { useState, useEffect } from 'react';
import {
  Send, CheckCircle2, AlertTriangle, Clock, Layers, Zap, Globe, ChevronDown,
} from 'lucide-react';
import { CrawlTodayStat, CandidateProjectStat } from '../types';

/*
 * 수집요청 현황.
 *
 * 위쪽은 브랜드 사이트 다섯을 도메인별로 본다. 한도가 사이트당 하루 50건이라
 * 업종 합계로 묶으면 어느 곳이 천장에 부딪혔는지 안 보인다 — 지금 중점으로
 * 보는 것이 이쪽이라 맨 위에 둔다 (운영자 지시 2026-09-01).
 *
 * 아래쪽 기존 업종(청소·이사·배관)은 접어 두고 고를 때만 편다. 늘 펼쳐 두면
 * 안 보는 카드 넷이 브랜드를 아래로 밀어낸다.
 *
 * 그래프는 두지 않는다. 이전 판의 일자별 집계 쿼리가 호출당 23~43초로 DB 를
 * 포화시켜 수집요청 러너와 색인 루프까지 타임아웃으로 죽였다 (2026-08-21).
 */

interface CrawlRequestTabProps {
  crawlTodayByProject: CrawlTodayStat[];
  candidateStats: CandidateProjectStat[];
}

/** 도메인 -> 브랜드. DB 에는 브랜드 이름이 없어 여기서 붙인다. */
const BRANDS: Record<string, { label: string; accent: string; bg: string }> = {
  'dreamcome.kr': { label: '드림컴뚜러', accent: '#fbbf24', bg: 'rgba(245, 158, 11, 0.12)' },
  'thunderdrain.kr': { label: '썬더배관', accent: '#a78bfa', bg: 'rgba(139, 92, 246, 0.12)' },
  'beaverpipe.kr': { label: '비버배관', accent: '#34d399', bg: 'rgba(16, 185, 129, 0.12)' },
  'ssac3.kr': { label: '싹쓰리배관', accent: '#f87171', bg: 'rgba(239, 68, 68, 0.12)' },
  'dosadosa.kr': { label: '하수구도사', accent: '#22d3ee', bg: 'rgba(6, 182, 212, 0.12)' },
};

const OTHER_PROJECTS = [
  { key: 'cleaning-ravi', label: '청소', accent: '#818cf8', bg: 'rgba(99, 102, 241, 0.12)' },
  { key: 'moving-ravi', label: '이사', accent: '#67e8f9', bg: 'rgba(6, 182, 212, 0.12)' },
  { key: 'piping-ravi', label: '배관', accent: '#fbbf24', bg: 'rgba(245, 158, 11, 0.12)' },
  { key: 'piping-ravi-shared', label: '배관(공유)', accent: '#fb923c', bg: 'rgba(249, 115, 22, 0.12)' },
];

interface BrandRow {
  host: string;
  page_count: number;
  naver_account_id: string | null;
  account_order: number | null;
  processed: number;
  submitted: number;
  quota_stop: number;
  failed: number;
  done: number;
  last_at: string | null;
  fail_status: string | null;
  fail_code: string | null;
  fail_reason: string | null;
  failed_at: string | null;
}

/*
 * 네이버가 주는 코드와 러너가 남긴 말은 사람이 읽을 것이 못 된다.
 * 무엇을 해야 하는지까지 적어 준다 — 숫자만 보고 원인을 DB 에서 뒤진 적이 있다.
 */
function explainFail(row: BrandRow): { text: string; how: string; tone: string } | null {
  const raw = row.fail_reason || row.fail_code || '';
  if (!raw) return null;
  if (/login is required|session|NID_/i.test(raw)) {
    return {
      tone: '#f87171',
      text: '세션이 죽었습니다 (네이버 로그인 필요)',
      how: `node scripts/capture-naver-session.mjs --account ${row.naver_account_id ?? ''}`,
    };
  }
  if (/FAIL_MAX_DOCUMENT_COUNT|quota/i.test(raw)) {
    return {
      tone: '#fbbf24',
      text: `오늘 한도(${DAILY_LIMIT}건)를 다 썼습니다. 자정(KST)에 풀립니다`,
      how: '다음 실행에서 이어서 나갑니다 — 따로 할 일 없습니다',
    };
  }
  if (/blocked|정지/i.test(raw)) {
    return { tone: '#f87171', text: '계정이 정지된 것으로 보입니다', how: '다른 계정으로 이관이 필요합니다' };
  }
  return { tone: '#f87171', text: raw.slice(0, 120), how: '' };
}

function Metric({ label, value, color, icon, suffix = '건' }: {
  label: string; value: number; color: string; icon: React.ReactNode; suffix?: string;
}) {
  return (
    <div style={{ background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: '1.8rem', fontWeight: 800, color, marginTop: '4px' }}>
        {value.toLocaleString()} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>{suffix}</span>
      </div>
    </div>
  );
}

const DAILY_LIMIT = 50;

function BrandCard({ row }: { row: BrandRow }) {
  const brand = BRANDS[row.host] || { label: row.host, accent: '#94a3b8', bg: 'rgba(148,163,184,0.12)' };
  const left = Math.max(0, DAILY_LIMIT - row.submitted);
  const pct = row.page_count > 0 ? Math.min(100, Math.round((row.done / row.page_count) * 1000) / 10) : 0;
  /* 남은 장수 ÷ 하루 50건. 오늘 다 썼으면 내일부터라 올림한다. */
  const daysLeft = row.page_count > row.done
    ? Math.ceil((row.page_count - row.done) / DAILY_LIMIT) : 0;
  const fail = explainFail(row);

  return (
    <div className="glass-panel" style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ padding: '4px 12px', borderRadius: '8px', background: brand.bg, color: brand.accent, fontWeight: 700 }}>
            {brand.label}
          </span>
          <code style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{row.host}</code>
          {row.account_order !== null && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              계정 {row.account_order} · {row.naver_account_id}
            </span>
          )}
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          {row.last_at ? `마지막 제출 ${new Date(row.last_at).toLocaleString('ko-KR')}` : '아직 제출 없음'}
        </div>
      </div>

      {/* 진도 막대 — 전체 중 얼마나 냈나 */}
      <div style={{ marginBottom: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '6px' }}>
          <span style={{ color: 'var(--text-muted)' }}>
            누적 {row.done.toLocaleString()} / {row.page_count.toLocaleString()}장
          </span>
          <span style={{ color: brand.accent, fontWeight: 700 }}>
            {pct}%{daysLeft > 0 ? ` · 남은 기간 약 ${daysLeft}일` : ' · 완료'}
          </span>
        </div>
        <div style={{ height: '8px', borderRadius: '999px', background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: brand.accent, transition: 'width .3s' }} />
        </div>
      </div>

      {fail && (
        <div style={{
          background: 'rgba(0,0,0,0.25)', border: `1px solid ${fail.tone}33`,
          borderLeft: `3px solid ${fail.tone}`, borderRadius: '10px',
          padding: '12px 14px', marginBottom: '14px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: fail.tone, fontSize: '0.85rem', fontWeight: 700 }}>
            <AlertTriangle size={14} /> {fail.text}
          </div>
          {fail.how && (
            <code style={{ display: 'block', marginTop: '6px', fontSize: '0.78rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
              {fail.how}
            </code>
          )}
          {row.failed_at && (
            <div style={{ marginTop: '4px', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
              마지막 {new Date(row.failed_at).toLocaleString('ko-KR')}
              {row.fail_code ? ` · ${row.fail_code}` : ''}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
        <Metric label="오늘 제출" value={row.submitted} color="#34d399" icon={<CheckCircle2 size={14} />} />
        <Metric label={`오늘 남은 한도 (${DAILY_LIMIT})`} value={left} color={left === 0 ? '#fbbf24' : brand.accent} icon={<Clock size={14} />} />
        <Metric label="오늘 실패" value={row.failed} color="#f87171" icon={<AlertTriangle size={14} />} />
        <Metric label="한도 중지" value={row.quota_stop} color="#fbbf24" icon={<Clock size={14} />} />
      </div>
    </div>
  );
}

export default function CrawlRequestTab({ crawlTodayByProject, candidateStats }: CrawlRequestTabProps) {
  const [brands, setBrands] = useState<BrandRow[]>([]);
  const [openOther, setOpenOther] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/crawl-brand')
      .then((r) => r.json())
      .then((d) => { if (alive && d?.rows) setBrands(d.rows); })
      .catch(console.error);
    return () => { alive = false; };
  }, []);

  const todayTotal = brands.reduce((n, b) => n + b.submitted, 0);
  const doneTotal = brands.reduce((n, b) => n + b.done, 0);
  const pageTotal = brands.reduce((n, b) => n + b.page_count, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="glass-panel" style={{ padding: '24px' }}>
        <h2 style={{ fontSize: '1.3rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Zap size={22} color="#6366f1" /> 수집요청 현황 (오늘 · KST)
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px' }}>
          한도는 <b style={{ color: '#e2e8f0' }}>사이트당 하루 {DAILY_LIMIT}건</b>이고 자정(KST)에 리셋됩니다.
          계정을 늘려도 늘지 않습니다 — 한도가 계정이 아니라 도메인에 붙기 때문입니다. 갱신은 브라우저 새로고침.
        </p>
      </div>

      {/* ── 브랜드 다섯 (중점) ── */}
      <div className="glass-panel" style={{ padding: '20px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Globe size={18} color="#f472b6" /> 브랜드 사이트 {brands.length}곳
          </h3>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            오늘 제출 <b style={{ color: '#34d399' }}>{todayTotal.toLocaleString()}</b>
            {' / '}{(brands.length * DAILY_LIMIT).toLocaleString()}건
            <span style={{ margin: '0 8px', opacity: 0.4 }}>·</span>
            누적 <b style={{ color: '#e2e8f0' }}>{doneTotal.toLocaleString()}</b>
            {' / '}{pageTotal.toLocaleString()}장
          </div>
        </div>
      </div>

      {brands.length === 0 && (
        <div className="glass-panel" style={{ padding: '24px', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          브랜드 도메인이 없거나 아직 불러오는 중입니다.
        </div>
      )}
      {brands.map((row) => <BrandCard key={row.host} row={row} />)}

      {/* ── 기존 업종 — 고를 때만 편다 ── */}
      <div className="glass-panel" style={{ padding: '20px 24px' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <Layers size={16} color="#94a3b8" /> 다른 업종
        </h3>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {OTHER_PROJECTS.map((p) => {
            const on = openOther === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setOpenOther(on ? null : p.key)}
                style={{
                  padding: '8px 16px',
                  borderRadius: '10px',
                  cursor: 'pointer',
                  fontSize: '0.88rem',
                  fontWeight: 600,
                  border: on ? `1px solid ${p.accent}` : '1px solid var(--border-color)',
                  background: on ? p.bg : 'rgba(255,255,255,0.04)',
                  color: on ? p.accent : 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                {p.label}
                <ChevronDown size={14} style={{ transform: on ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
              </button>
            );
          })}
        </div>
      </div>

      {openOther && (() => {
        const p = OTHER_PROJECTS.find((x) => x.key === openOther)!;
        const today = crawlTodayByProject.find((r) => r.target_project === p.key);
        const candidates = candidateStats.find((r) => r.target_project === p.key);
        return (
          <div className="glass-panel" style={{ padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#ffffff' }}>
                <span style={{ padding: '4px 12px', borderRadius: '8px', background: p.bg, color: p.accent }}>{p.label}</span>
              </h3>
              {candidates && (
                <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Layers size={14} /> 수집 대상 풀 {candidates.total.toLocaleString()}장
                </div>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
              <Metric label="오늘 실행" value={today?.processed || 0} color={p.accent} icon={<Send size={14} />} />
              <Metric label="오늘 제출 성공" value={today?.submitted || 0} color="#34d399" icon={<CheckCircle2 size={14} />} />
              <Metric label="오늘 실패" value={today?.failed || 0} color="#f87171" icon={<AlertTriangle size={14} />} />
              <Metric label="한도 중지 (내일 이월)" value={today?.quota_stop || 0} color="#fbbf24" icon={<Clock size={14} />} />
            </div>
          </div>
        );
      })()}
    </div>
  );
}
