import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Zap, 
  RefreshCw, 
  Kanban, 
  KeyRound, 
  Globe, 
  Rocket, 
  ShieldCheck, 
  Send,
  TrendingUp 
} from 'lucide-react';
import { DevTask, AccountInfo, CrawlTodayStat, CandidateProjectStat, LeadSubmission, AccountSummary, OwnershipSummary, DeploymentSummary, RootDomainStat, AccountDomainCount } from './types';
import DevRoadmapTab from './components/DevRoadmapTab';
import AccountStatsTab from './components/AccountStatsTab';
import DomainRegistryTab from './components/DomainRegistryTab';
import DeploymentStatusTab from './components/DeploymentStatusTab';
import OwnershipVerifyTab from './components/OwnershipVerifyTab';
import CrawlRequestTab from './components/CrawlRequestTab';
import IndexStatusTab from './components/IndexStatusTab';

import type { SessionUser } from './components/AuthGate';

const GROUPS = [
  { id: 'all', label: '전체 업종' },
  { id: 'cleaning-ravi', label: '청소' },
  { id: 'moving-ravi', label: '이사' },
  { id: 'demolition-ravi', label: '철거' },
];

export default function App({ user }: { user: SessionUser }) {
  const [activeTab, setActiveTab] = useState<
    'dev_roadmap' | 'account' | 'domain' | 'deployment' | 'ownership' | 'crawl' | 'index'
  >('dev_roadmap');

  const [selectedGroupKey, setSelectedGroupKey] = useState<string>('all');
  const [loading, setLoading] = useState(false);

  // Stats Cache for instantaneous 0ms switching
  const statsCacheRef = useRef<Record<string, any>>({});

  // Dev Tasks State (CRUD)
  const [devTasks, setDevTasks] = useState<DevTask[]>([]);

  // Monitoring Stats State (R)
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [domainCounts, setDomainCounts] = useState<AccountDomainCount[]>([]);
  const [crawlTodayByProject, setCrawlTodayByProject] = useState<CrawlTodayStat[]>([]);
  const [candidateStats, setCandidateStats] = useState<CandidateProjectStat[]>([]);
  const [leadSubmissions, setLeadSubmissions] = useState<LeadSubmission[]>([]);

  // DB 에서 집계해 내려주는 요약
  const [accountSummary, setAccountSummary] = useState<AccountSummary | null>(null);
  const [ownershipSummary, setOwnershipSummary] = useState<OwnershipSummary | null>(null);
  const [deploymentSummary, setDeploymentSummary] = useState<DeploymentSummary | null>(null);
  const [rootDomains, setRootDomains] = useState<RootDomainStat[]>([]);

  // Fetch Dev Tasks from Backend CRUD API
  const fetchDevTasks = async () => {
    try {
      const res = await fetch('/api/dev-tasks');
      if (res.ok) {
        const tasks = await res.json();
        setDevTasks(tasks);
      }
    } catch (e) {
      console.error('Error fetching dev tasks:', e);
    }
  };

  const applyData = useCallback((data: any) => {
    if (!data) return;
    if (data.accounts) setAccounts(data.accounts);
    if (data.accountDomainCounts) setDomainCounts(data.accountDomainCounts);

    if (data.accountSummary) setAccountSummary(data.accountSummary);
    if (data.ownershipSummary) setOwnershipSummary(data.ownershipSummary);
    if (data.deploymentSummary) setDeploymentSummary(data.deploymentSummary);
    if (data.rootDomains) setRootDomains(data.rootDomains);
    if (data.candidateStats) setCandidateStats(data.candidateStats);
    if (data.crawlTodayByProject) setCrawlTodayByProject(data.crawlTodayByProject);

    if (data.leads) setLeadSubmissions(data.leads as LeadSubmission[]);
  }, []);

  // Pre-fetch all industry groups concurrently
  const fetchAllGroupsData = useCallback(async () => {
    setLoading(true);
    try {
      await fetchDevTasks();

      const fetchPromises = GROUPS.map(async (g) => {
        const queryUrl = g.id !== 'all' ? `/api/stats?groupKey=${encodeURIComponent(g.id)}` : '/api/stats';
        try {
          const res = await fetch(queryUrl);
          if (res.ok) {
            const data = await res.json();
            statsCacheRef.current[g.id] = data;
            return { id: g.id, data };
          }
        } catch (e) {
          console.error(`Failed to fetch stats for ${g.id}:`, e);
        }
        return null;
      });

      await Promise.all(fetchPromises);

      // Apply selected group immediately
      const current = statsCacheRef.current[selectedGroupKey];
      if (current) {
        applyData(current);
      }
    } catch (err) {
      console.error('Error prefetching DB stats:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedGroupKey, applyData]);

  // 첫 로드만 한다. 자동 폴링(20초)은 뺐다 — 통계 쿼리가 130만 행 풀스캔이라
  // 20초보다 오래 걸리고, 그러면 쿼리가 계속 쌓여 DB 전체(수집요청 러너 포함)가
  // 타임아웃 났다 (2026-08-20 실측: 활성 쿼리 10개+ 적체). 새로고침은 브라우저로.
  useEffect(() => {
    fetchAllGroupsData();
  }, []);

  // Instant switch handler
  const handleSelectGroup = (groupId: string) => {
    setSelectedGroupKey(groupId);
    // If cached in memory, switch instantly in 0ms!
    if (statsCacheRef.current[groupId]) {
      applyData(statsCacheRef.current[groupId]);
    }
    // Background re-fetch for this group
    const queryUrl = groupId !== 'all' ? `/api/stats?groupKey=${encodeURIComponent(groupId)}` : '/api/stats';
    fetch(queryUrl).then(res => res.json()).then(data => {
      statsCacheRef.current[groupId] = data;
      applyData(data);
    }).catch(console.error);
  };

  // CRUD Handlers for Dev Tasks
  const handleAddTask = async (newTaskData: Omit<DevTask, 'id'>) => {
    try {
      const res = await fetch('/api/dev-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTaskData)
      });
      if (res.ok) {
        await fetchDevTasks();
      }
    } catch (e) {
      console.error('Failed to add dev task:', e);
    }
  };

  const handleUpdateTask = async (updatedTask: DevTask) => {
    try {
      const res = await fetch('/api/dev-tasks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedTask)
      });
      if (res.ok) {
        await fetchDevTasks();
      }
    } catch (e) {
      console.error('Failed to update dev task:', e);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!window.confirm('정말로 이 개발 과제를 삭제하시겠습니까?')) return;
    try {
      const res = await fetch(`/api/dev-tasks?id=${taskId}`, { method: 'DELETE' });
      if (res.ok) {
        await fetchDevTasks();
      }
    } catch (e) {
      console.error('Failed to delete dev task:', e);
    }
  };

  const navItems = [
    { key: 'dev_roadmap', label: '개발팀 전체 진행과정', badge: `${devTasks.length}건`, icon: Kanban, isCrucial: true },
    { key: 'account', label: '1. 계정 확인', badge: `${accountSummary?.total ?? accounts.length}개`, icon: KeyRound },
    { key: 'domain', label: '2. 도메인 등록', badge: `${(ownershipSummary?.total ?? 0).toLocaleString()}개`, icon: Globe },
    { key: 'deployment', label: '3. 배포 현황', badge: `${(deploymentSummary?.deployed_domains ?? ownershipSummary?.deployed ?? 0).toLocaleString()}개`, icon: Rocket },
    { key: 'ownership', label: '4. 소유 확인', badge: `${(ownershipSummary?.verified ?? 0).toLocaleString()}개`, icon: ShieldCheck },
    { key: 'crawl', label: '5. 수집 요청 현황', badge: `오늘 ${crawlTodayByProject.reduce((a, r) => a + (r.submitted || 0), 0).toLocaleString()}건`, icon: Send },
    { key: 'index', label: '6. 색인 현황', badge: '검색 노출', icon: TrendingUp }
  ];

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-dark)' }}>
      
      {/* Left Sidebar Navigation */}
      <aside style={{
        width: '280px',
        minWidth: '280px',
        background: 'rgba(18, 24, 38, 0.9)',
        backdropFilter: 'blur(16px)',
        borderRight: '1px solid var(--border-color)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '24px 16px',
        position: 'sticky',
        top: 0,
        height: '100vh',
        boxSizing: 'border-box'
      }}>
        <div>
          {/* Logo & Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px', paddingLeft: '8px' }}>
            <div style={{ 
              width: '42px', 
              height: '42px', 
              borderRadius: '12px', 
              background: 'linear-gradient(135deg, #6366f1 0%, #06b6d4 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 8px 16px -4px rgba(99, 102, 241, 0.4)'
            }}>
              <Zap color="#ffffff" size={24} />
            </div>
            <div>
              <h1 style={{ fontSize: '1.35rem', fontWeight: 800, color: '#ffffff', letterSpacing: '-0.02em', lineHeight: 1.2 }}>
                Cleaning Ops
              </h1>
              <span style={{ fontSize: '0.75rem', color: 'var(--primary-light)', fontWeight: 600 }}>
                통합 관리자 대시보드
              </span>
            </div>
          </div>

          {/* 로그인 정보 */}
          <div style={{
            marginBottom: '18px', padding: '10px 12px', borderRadius: '10px',
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)',
          }}>
            <div style={{ fontSize: '0.78rem', color: '#e2e8f0', fontWeight: 600, wordBreak: 'break-all' }}>
              {user.name || user.username}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
              {user.role === 'owner' ? '소유자' : '멤버'}
            </div>
            <button
              onClick={async () => {
                await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
                window.location.reload();
              }}
              style={{
                marginTop: '8px', width: '100%', padding: '6px', borderRadius: '7px',
                border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.05)',
                color: '#cbd5e1', fontSize: '0.75rem', cursor: 'pointer',
              }}
            >
              로그아웃
            </button>
          </div>

          {/* Left Vertical Menu */}
          <nav style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {navItems.map(item => {
              const IconComponent = item.icon;
              const isActive = activeTab === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => setActiveTab(item.key as any)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 14px',
                    borderRadius: '10px',
                    border: isActive ? '1px solid var(--border-highlight)' : '1px solid transparent',
                    background: isActive 
                      ? (item.isCrucial ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.25) 0%, rgba(6, 182, 212, 0.15) 100%)' : 'rgba(255, 255, 255, 0.08)') 
                      : 'transparent',
                    color: isActive ? '#ffffff' : 'var(--text-muted)',
                    fontWeight: isActive ? 700 : 500,
                    fontSize: '0.88rem',
                    cursor: 'pointer',
                    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                    textAlign: 'left'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <IconComponent size={18} color={isActive ? '#818cf8' : 'var(--text-muted)'} />
                    <span>{item.label}</span>
                  </div>
                  {item.badge && (
                    <span style={{ 
                      fontSize: '0.7rem', 
                      padding: '2px 8px', 
                      borderRadius: '10px', 
                      background: isActive ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.06)',
                      color: isActive ? '#ffffff' : 'var(--text-muted)',
                      fontWeight: 600
                    }}>
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Sidebar Footer Refresh Controls */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '16px' }}>
          <button
            onClick={() => fetchAllGroupsData()}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              padding: '10px 14px',
              borderRadius: '10px',
              border: '1px solid var(--border-color)',
              background: 'rgba(255,255,255,0.05)',
              color: '#ffffff',
              cursor: 'pointer',
              fontSize: '0.85rem',
              fontWeight: 500
            }}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
            {loading ? '동기화 중...' : '실시간 DB 새로고침'}
          </button>
        </div>

      </aside>

      {/* Main Content Area */}
      <main style={{ flex: 1, padding: '32px 40px', overflowY: 'auto' }}>
        
        {/* 업종(프로젝트) 선택 바: 동일 서브도메인을 공유하므로 소유확인/도메인/배포 탭에는 노출하지 않고 수집요청 및 색인현황 탭에만 표시 */}
        {(activeTab === 'crawl' || activeTab === 'index') && (
          <div className="glass-panel" style={{ padding: '14px 20px', marginBottom: '24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#e2e8f0' }}>업종(프로젝트) 선택:</span>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {GROUPS.map(p => (
                  <button
                    key={p.id}
                    onClick={() => handleSelectGroup(p.id)}
                    style={{
                      padding: '6px 14px',
                      borderRadius: '8px',
                      border: selectedGroupKey === p.id ? '1px solid #818cf8' : '1px solid var(--border-color)',
                      background: selectedGroupKey === p.id ? 'rgba(99, 102, 241, 0.25)' : 'rgba(255, 255, 255, 0.04)',
                      color: selectedGroupKey === p.id ? '#ffffff' : 'var(--text-muted)',
                      fontSize: '0.85rem',
                      fontWeight: selectedGroupKey === p.id ? 700 : 500,
                      cursor: 'pointer',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              선택된 업종: <code style={{ color: '#818cf8', background: 'rgba(0,0,0,0.3)', padding: '2px 6px', borderRadius: '4px' }}>{selectedGroupKey === 'all' ? '전체 업종' : selectedGroupKey === 'cleaning-ravi' ? '청소 (cleaning-ravi)' : selectedGroupKey === 'moving-ravi' ? '이사 (moving-ravi)' : '철거 (demolition-ravi)'}</code>
            </div>
          </div>
        )}

        {activeTab === 'dev_roadmap' && (
          <DevRoadmapTab
            tasks={devTasks}
            onAddTask={handleAddTask}
            onUpdateTask={handleUpdateTask}
            onDeleteTask={handleDeleteTask}
          />
        )}

        {activeTab === 'account' && (
          <AccountStatsTab accounts={accounts} domainCounts={domainCounts} summary={accountSummary} />
        )}

        {activeTab === 'domain' && (
          <DomainRegistryTab summary={ownershipSummary} />
        )}

        {activeTab === 'deployment' && (
          <DeploymentStatusTab summary={deploymentSummary} rootDomains={rootDomains} />
        )}

        {activeTab === 'ownership' && (
          <OwnershipVerifyTab summary={ownershipSummary} />
        )}

        {activeTab === 'crawl' && (
          <CrawlRequestTab
            crawlTodayByProject={crawlTodayByProject}
            candidateStats={candidateStats}
          />
        )}

        {activeTab === 'index' && <IndexStatusTab selectedGroupKey={selectedGroupKey} />}
      </main>

    </div>
  );
}
