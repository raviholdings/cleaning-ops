import React, { useState, useEffect } from 'react';
import { 
  Zap, 
  RefreshCw, 
  Kanban, 
  KeyRound, 
  Globe, 
  Rocket, 
  ShieldCheck, 
  Send,
  ChevronRight
} from 'lucide-react';
import { DevTask, AccountInfo, CrawlDailyStat, CrawlLog, LeadSubmission, AccountSummary, OwnershipSummary, DeploymentSummary, RootDomainStat, AccountDomainCount } from './types';
import DevRoadmapTab from './components/DevRoadmapTab';
import AccountStatsTab from './components/AccountStatsTab';
import DomainRegistryTab from './components/DomainRegistryTab';
import DeploymentStatusTab from './components/DeploymentStatusTab';
import OwnershipVerifyTab from './components/OwnershipVerifyTab';
import CrawlRequestTab from './components/CrawlRequestTab';

import type { SessionUser } from './components/AuthGate';

export default function App({ user }: { user: SessionUser }) {
  const [activeTab, setActiveTab] = useState<
    'dev_roadmap' | 'account' | 'domain' | 'deployment' | 'ownership' | 'crawl'
  >('dev_roadmap');

  const [loading, setLoading] = useState(true);

  // Dev Tasks State (CRUD)
  const [devTasks, setDevTasks] = useState<DevTask[]>([]);

  // Monitoring Stats State (R)
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [domainCounts, setDomainCounts] = useState<AccountDomainCount[]>([]);
  const [crawlDailyStats, setCrawlDailyStats] = useState<CrawlDailyStat[]>([]);
  const [recentCrawlLogs, setRecentCrawlLogs] = useState<CrawlLog[]>([]);
  const [todayCrawl, setTodayCrawl] = useState<CrawlDailyStat | null>(null);
  const [crawlDailyQuota, setCrawlDailyQuota] = useState(50000);
  const [totalCrawlResultCount, setTotalCrawlResultCount] = useState(0);
  const [leadSubmissions, setLeadSubmissions] = useState<LeadSubmission[]>([]);

  // DB 에서 집계해 내려주는 요약. 3,000행을 프론트에서 세면 느리고 값이 어긋난다.
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

  // Fetch Monitoring Data from Backend API
  const fetchRealDbData = async () => {
    setLoading(true);
    try {
      await fetchDevTasks();

      const res = await fetch('/api/stats');
      if (res.ok) {
        const data = await res.json();

        if (data.accounts) setAccounts(data.accounts);
        if (data.accountDomainCounts) setDomainCounts(data.accountDomainCounts);

        // DB 가 세어준 집계를 쓴다. 프론트에서 만 행을 다시 세면 느리고,
        // 목록이 잘려 내려오면 숫자가 실제와 어긋난다.
        if (data.accountSummary) setAccountSummary(data.accountSummary);
        if (data.ownershipSummary) setOwnershipSummary(data.ownershipSummary);
        if (data.deploymentSummary) setDeploymentSummary(data.deploymentSummary);
        if (data.rootDomains) setRootDomains(data.rootDomains);

        if (data.crawlDaily) {
          const byDate = new Map<string, CrawlDailyStat>();
          let sumCount = 0;
          data.crawlDaily.forEach((item: any) => {
            const date = String(item.date);
            const count = Number(item.count || 0);
            sumCount += count;
            if (!byDate.has(date)) {
              byDate.set(date, { date, submitted: 0, quotaStop: 0, failed: 0, total: 0 });
            }
            const row = byDate.get(date)!;
            row.total += count;
            if (item.status === 'submitted') row.submitted += count;
            else if (item.status === 'quota-stop') row.quotaStop += count;
            else if (item.status === 'failed') row.failed += count;
          });

          const chartList = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
          setTotalCrawlResultCount(sumCount);
          setCrawlDailyStats(chartList);
          setCrawlDailyQuota(Number(data.crawlDailyQuota) || 50000);
          // DB 가 KST 기준으로 직접 세어준 값을 우선한다. 차트에서 찾아 쓰면
        // 시간대 경계에서 어긋난다.
        if (data.crawlToday) {
          setTodayCrawl({
            date: data.todayKst,
            submitted: data.crawlToday.submitted || 0,
            quotaStop: data.crawlToday.quota_stop || 0,
            failed: data.crawlToday.failed || 0,
            total: (data.crawlToday.submitted || 0) + (data.crawlToday.quota_stop || 0) + (data.crawlToday.failed || 0),
          });
        } else {
          setTodayCrawl(chartList.find((r) => r.date === data.todayKst) || null);
        }
        }

        if (data.recentCrawlLogs) setRecentCrawlLogs(data.recentCrawlLogs);
        if (data.leads) setLeadSubmissions(data.leads as LeadSubmission[]);
      } else {
        console.error('API /api/stats failed:', res.statusText);
      }

    } catch (err) {
      console.error('Error querying DB/API:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRealDbData();
  }, []);

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
    { key: 'dev_roadmap', label: '🚀 개발팀 전체 진행과정', badge: `${devTasks.length}건`, icon: Kanban, isCrucial: true },
    { key: 'account', label: '🔑 1. 계정 확인', badge: `${accountSummary?.total ?? accounts.length}개`, icon: KeyRound },
    { key: 'domain', label: '🌐 2. 도메인 등록', badge: `${(ownershipSummary?.total ?? 0).toLocaleString()}개`, icon: Globe },
    { key: 'deployment', label: '🚀 3. 배포 현황', badge: `${(deploymentSummary?.deployed_domains ?? ownershipSummary?.deployed ?? 0).toLocaleString()}개`, icon: Rocket },
    { key: 'ownership', label: '🛡️ 4. 소유 확인', badge: `${(ownershipSummary?.verified ?? 0).toLocaleString()}개`, icon: ShieldCheck },
    // 수집요청 뱃지는 '오늘 제출'이다. 누적을 보여주면 일일 한도와 비교가 안 된다.
    { key: 'crawl', label: '📨 5. 수집 요청 현황', badge: `오늘 ${(todayCrawl?.submitted || 0).toLocaleString()}건`, icon: Send }
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
        boxSizing: 'border-row' as any
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
            onClick={fetchRealDbData}
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
            crawlDailyStats={crawlDailyStats}
            todayCrawl={todayCrawl}
            crawlDailyQuota={crawlDailyQuota}
            totalCrawlResultCount={totalCrawlResultCount}
            recentLogs={recentCrawlLogs}
          />
        )}
      </main>

    </div>
  );
}
