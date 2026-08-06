import React, { useState } from 'react';
import { 
  Plus, 
  CheckCircle2, 
  Clock, 
  AlertCircle, 
  PauseCircle, 
  Edit3, 
  Trash2, 
  Search, 
  Filter, 
  TrendingUp, 
  Calendar, 
  User, 
  CheckSquare,
  Sparkles,
  ChevronRight
} from 'lucide-react';
import { DevTask, TaskStatus, TaskPriority } from '../types';

interface DevRoadmapTabProps {
  tasks: DevTask[];
  onAddTask: (task: Omit<DevTask, 'id'>) => Promise<void>;
  onUpdateTask: (task: DevTask) => Promise<void>;
  onDeleteTask: (taskId: string) => Promise<void>;
}

export default function DevRoadmapTab({
  tasks,
  onAddTask,
  onUpdateTask,
  onDeleteTask
}: DevRoadmapTabProps) {
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  
  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<DevTask | null>(null);

  // Form State
  const [formData, setFormData] = useState({
    title: '',
    category: 'Frontend / Build',
    assignee: '개발팀',
    priority: 'high' as TaskPriority,
    status: 'in_progress' as TaskStatus,
    startDate: new Date().toISOString().slice(0, 10),
    targetDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    completedDate: '',
    progress: 50,
    description: '',
    notes: ''
  });

  // Calculate Metrics for Executive Report
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.status === 'completed');
  const inProgressTasks = tasks.filter(t => t.status === 'in_progress');
  const pendingTasks = tasks.filter(t => t.status === 'pending');
  const onHoldTasks = tasks.filter(t => t.status === 'on_hold');

  const avgProgress = totalTasks > 0 
    ? Math.round(tasks.reduce((sum, t) => sum + (t.status === 'completed' ? 100 : t.progress), 0) / totalTasks)
    : 0;

  const categories = Array.from(new Set(tasks.map(t => t.category)));

  // Filter Tasks
  const filteredTasks = tasks.filter(task => {
    const matchesStatus = filterStatus === 'all' || task.status === filterStatus;
    const matchesCategory = filterCategory === 'all' || task.category === filterCategory;
    const matchesSearch = searchQuery === '' || 
      task.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      task.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      task.assignee.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesStatus && matchesCategory && matchesSearch;
  });

  const openCreateModal = () => {
    setEditingTask(null);
    setFormData({
      title: '',
      category: 'Frontend / Build',
      assignee: '개발팀',
      priority: 'high',
      status: 'in_progress',
      startDate: new Date().toISOString().slice(0, 10),
      targetDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      completedDate: '',
      progress: 50,
      description: '',
      notes: ''
    });
    setIsModalOpen(true);
  };

  const openEditModal = (task: DevTask) => {
    setEditingTask(task);
    setFormData({
      title: task.title,
      category: task.category,
      assignee: task.assignee,
      priority: task.priority,
      status: task.status,
      startDate: task.startDate,
      targetDate: task.targetDate,
      completedDate: task.completedDate || '',
      progress: task.progress,
      description: task.description,
      notes: task.notes || ''
    });
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title.trim()) return;

    if (editingTask) {
      await onUpdateTask({
        ...editingTask,
        ...formData,
        completedDate: formData.status === 'completed' ? (formData.completedDate || new Date().toISOString().slice(0, 10)) : undefined
      });
    } else {
      await onAddTask({
        ...formData,
        completedDate: formData.status === 'completed' ? new Date().toISOString().slice(0, 10) : undefined
      });
    }
    setIsModalOpen(false);
  };

  const handleQuickStatusChange = async (task: DevTask, newStatus: TaskStatus) => {
    const isCompleted = newStatus === 'completed';
    await onUpdateTask({
      ...task,
      status: newStatus,
      progress: isCompleted ? 100 : (newStatus === 'pending' ? 0 : task.progress),
      completedDate: isCompleted ? new Date().toISOString().slice(0, 10) : undefined
    });
  };

  const getStatusBadge = (status: TaskStatus) => {
    switch (status) {
      case 'completed':
        return <span className="badge badge-success"><CheckCircle2 size={13} /> 완료</span>;
      case 'in_progress':
        return <span className="badge badge-info"><Clock size={13} /> 진행 중</span>;
      case 'pending':
        return <span className="badge badge-warning"><AlertCircle size={13} /> 대기 중</span>;
      case 'on_hold':
        return <span className="badge badge-danger"><PauseCircle size={13} /> 보류</span>;
    }
  };

  const getPriorityBadge = (priority: TaskPriority) => {
    switch (priority) {
      case 'urgent': return <span style={{ color: '#ef4444', fontWeight: 600, fontSize: '0.75rem' }}>🔥 긴급</span>;
      case 'high': return <span style={{ color: '#f59e0b', fontWeight: 600, fontSize: '0.75rem' }}>⚡ 높음</span>;
      case 'medium': return <span style={{ color: '#38bdf8', fontWeight: 500, fontSize: '0.75rem' }}>🔵 보통</span>;
      case 'low': return <span style={{ color: '#9ca3af', fontWeight: 400, fontSize: '0.75rem' }}>⚪ 낮음</span>;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      
      {/* Executive Overview Header */}
      <div className="glass-panel" style={{ padding: '24px', background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(6, 182, 212, 0.1) 100%)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <Sparkles size={20} color="#818cf8" />
              <h2 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#ffffff' }}>
                개발팀 개발 현황 & 전체 진행 과정 <span style={{ fontSize: '0.9rem', color: '#818cf8' }}>(대표님 공유용)</span>
              </h2>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              전체 시스템 구축 및 세부 마일스톤별 진행 상황 실시간 종합 브리핑
            </p>
          </div>

          <button
            onClick={openCreateModal}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 20px',
              borderRadius: '10px',
              background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
              color: '#ffffff',
              border: 'none',
              fontWeight: 600,
              fontSize: '0.9rem',
              cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(99, 102, 241, 0.4)'
            }}
          >
            <Plus size={18} /> 신규 과제 등록
          </button>
        </div>

        {/* Executive Summary Stats Bar */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
          
          <div style={{ background: 'rgba(0,0,0,0.25)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>전체 달성률</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#60a5fa', display: 'flex', alignItems: 'baseline', gap: '4px' }}>
              {avgProgress}%
              <TrendingUp size={16} color="#60a5fa" />
            </div>
            <div style={{ height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', marginTop: '8px', overflow: 'hidden' }}>
              <div style={{ width: `${avgProgress}%`, height: '100%', background: 'linear-gradient(90deg, #3b82f6, #06b6d4)', borderRadius: '3px' }} />
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.25)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>총 등록 과제</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#ffffff' }}>
              {totalTasks} <span style={{ fontSize: '0.9rem', fontWeight: 400, color: 'var(--text-muted)' }}>건</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: '4px' }}>마일스톤 전체 목록</div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.25)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>개발 완료</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#34d399' }}>
              {completedTasks.length} <span style={{ fontSize: '0.9rem', fontWeight: 400, color: 'var(--text-muted)' }}>건</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: '#34d399', marginTop: '4px' }}>검증 및 배포 완료됨</div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.25)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>현재 진행 중</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#38bdf8' }}>
              {inProgressTasks.length} <span style={{ fontSize: '0.9rem', fontWeight: 400, color: 'var(--text-muted)' }}>건</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: '#38bdf8', marginTop: '4px' }}>적극 추진 집중 작업</div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.25)', padding: '16px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>대기/보류</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 800, color: '#fbbf24' }}>
              {pendingTasks.length + onHoldTasks.length} <span style={{ fontSize: '0.9rem', fontWeight: 400, color: 'var(--text-muted)' }}>건</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: '#fbbf24', marginTop: '4px' }}>다음 순서 예정 항목</div>
          </div>

        </div>
      </div>

      {/* Filter & Search Bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', justifyContent: 'space-between' }}>
        
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Status Filter Buttons */}
          <div style={{ display: 'flex', background: 'rgba(255,255,255,0.05)', padding: '4px', borderRadius: '10px', border: '1px solid var(--border-color)' }}>
            {[
              { key: 'all', label: '전체' },
              { key: 'in_progress', label: '진행 중' },
              { key: 'completed', label: '완료' },
              { key: 'pending', label: '대기 중' },
              { key: 'on_hold', label: '보류' }
            ].map(item => (
              <button
                key={item.key}
                onClick={() => setFilterStatus(item.key)}
                style={{
                  padding: '6px 14px',
                  borderRadius: '8px',
                  border: 'none',
                  background: filterStatus === item.key ? 'var(--primary)' : 'transparent',
                  color: filterStatus === item.key ? '#ffffff' : 'var(--text-muted)',
                  fontSize: '0.85rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Category Filter */}
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
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
            <option value="all" style={{ background: '#121826' }}>전체 카테고리</option>
            {categories.map(cat => (
              <option key={cat} value={cat} style={{ background: '#121826' }}>{cat}</option>
            ))}
          </select>
        </div>

        {/* Search Input */}
        <div style={{ position: 'relative', minWidth: '240px' }}>
          <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder="과제명, 담당자, 설명 검색..."
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

      {/* Task List Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '16px' }}>
        {filteredTasks.map(task => (
          <div
            key={task.id}
            className="glass-panel animate-fade-in"
            style={{
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: '16px',
              borderLeft: `4px solid ${
                task.status === 'completed' ? '#10b981' :
                task.status === 'in_progress' ? '#38bdf8' :
                task.status === 'pending' ? '#f59e0b' : '#ef4444'
              }`
            }}
          >
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', marginBottom: '8px' }}>
                <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px', background: 'rgba(255,255,255,0.08)', color: 'var(--text-muted)' }}>
                  {task.category}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {getPriorityBadge(task.priority)}
                  {getStatusBadge(task.status)}
                </div>
              </div>

              <h3 style={{ fontSize: '1.05rem', fontWeight: 600, color: '#ffffff', marginBottom: '8px', lineHeight: 1.4 }}>
                {task.title}
              </h3>

              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '14px' }}>
                {task.description}
              </p>

              {task.notes && (
                <div style={{ fontSize: '0.8rem', padding: '8px 12px', borderRadius: '6px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', color: '#818cf8', marginBottom: '12px' }}>
                  💡 <strong>비고:</strong> {task.notes}
                </div>
              )}
            </div>

            {/* Progress Bar & Meta Info */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '12px' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  <span>진행률</span>
                  <span style={{ fontWeight: 600, color: task.status === 'completed' ? '#34d399' : '#38bdf8' }}>
                    {task.status === 'completed' ? 100 : task.progress}%
                  </span>
                </div>
                <div style={{ height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
                  <div style={{
                    width: `${task.status === 'completed' ? 100 : task.progress}%`,
                    height: '100%',
                    background: task.status === 'completed' ? '#10b981' : 'linear-gradient(90deg, #6366f1, #06b6d4)',
                    transition: 'width 0.3s ease'
                  }} />
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <User size={13} /> {task.assignee}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Calendar size={13} /> {task.startDate} ~ {task.targetDate}
                </div>
              </div>

              {/* Status Action Buttons & Edit/Delete */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '4px' }}>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {(['pending', 'in_progress', 'completed'] as TaskStatus[]).map(st => (
                    <button
                      key={st}
                      onClick={() => handleQuickStatusChange(task, st)}
                      title={`${st} 상태로 변경`}
                      style={{
                        padding: '4px 8px',
                        fontSize: '0.7rem',
                        borderRadius: '4px',
                        border: '1px solid var(--border-color)',
                        background: task.status === st ? 'rgba(99, 102, 241, 0.3)' : 'rgba(255,255,255,0.04)',
                        color: task.status === st ? '#ffffff' : 'var(--text-muted)',
                        cursor: 'pointer'
                      }}
                    >
                      {st === 'pending' ? '대기' : st === 'in_progress' ? '진행중' : '완료'}
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => openEditModal(task)}
                    style={{ background: 'none', border: 'none', color: '#818cf8', cursor: 'pointer', padding: '4px' }}
                    title="수정"
                  >
                    <Edit3 size={15} />
                  </button>
                  <button
                    onClick={() => onDeleteTask(task.id)}
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '4px' }}
                    title="삭제"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

            </div>
          </div>
        ))}
      </div>

      {filteredTasks.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          조건에 부합하는 개발 과제가 없습니다.
        </div>
      )}

      {/* CRUD Modal Dialog */}
      {isModalOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '20px'
        }}>
          <div className="glass-panel" style={{ width: '100%', maxWidth: '600px', padding: '28px', background: '#121826' }}>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '20px', color: '#ffffff' }}>
              {editingTask ? '개발 과제 수정' : '신규 개발 과제 등록'}
            </h3>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                  과제명 (제목) *
                </label>
                <input
                  type="text"
                  required
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid var(--border-color)',
                    color: '#ffffff',
                    fontSize: '0.9rem',
                    outline: 'none'
                  }}
                  placeholder="예: 1,000개 서브도메인 SEO 자동 빌드 파이프라인"
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                    카테고리
                  </label>
                  <input
                    type="text"
                    value={formData.category}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: '8px',
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid var(--border-color)',
                      color: '#ffffff',
                      fontSize: '0.9rem',
                      outline: 'none'
                    }}
                    placeholder="Frontend / Backend / Database / Automation 등"
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                    담당자
                  </label>
                  <input
                    type="text"
                    value={formData.assignee}
                    onChange={(e) => setFormData({ ...formData, assignee: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: '8px',
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid var(--border-color)',
                      color: '#ffffff',
                      fontSize: '0.9rem',
                      outline: 'none'
                    }}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                    우선순위
                  </label>
                  <select
                    value={formData.priority}
                    onChange={(e) => setFormData({ ...formData, priority: e.target.value as TaskPriority })}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid var(--border-color)',
                      color: '#ffffff',
                      fontSize: '0.85rem',
                      outline: 'none'
                    }}
                  >
                    <option value="urgent" style={{ background: '#121826' }}>🔥 긴급 (Urgent)</option>
                    <option value="high" style={{ background: '#121826' }}>⚡ 높음 (High)</option>
                    <option value="medium" style={{ background: '#121826' }}>🔵 보통 (Medium)</option>
                    <option value="low" style={{ background: '#121826' }}>⚪ 낮음 (Low)</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                    진행 상태
                  </label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value as TaskStatus })}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid var(--border-color)',
                      color: '#ffffff',
                      fontSize: '0.85rem',
                      outline: 'none'
                    }}
                  >
                    <option value="pending" style={{ background: '#121826' }}>대기 중</option>
                    <option value="in_progress" style={{ background: '#121826' }}>진행 중</option>
                    <option value="completed" style={{ background: '#121826' }}>완료</option>
                    <option value="on_hold" style={{ background: '#121826' }}>보류</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                    진행률 ({formData.progress}%)
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={formData.progress}
                    onChange={(e) => setFormData({ ...formData, progress: parseInt(e.target.value) })}
                    style={{ width: '100%', marginTop: '12px' }}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                    시작일
                  </label>
                  <input
                    type="date"
                    value={formData.startDate}
                    onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: '8px',
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid var(--border-color)',
                      color: '#ffffff',
                      fontSize: '0.85rem'
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                    목표 완료일
                  </label>
                  <input
                    type="date"
                    value={formData.targetDate}
                    onChange={(e) => setFormData({ ...formData, targetDate: e.target.value })}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: '8px',
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid var(--border-color)',
                      color: '#ffffff',
                      fontSize: '0.85rem'
                    }}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                  상세 설명 및 목표
                </label>
                <textarea
                  rows={3}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid var(--border-color)',
                    color: '#ffffff',
                    fontSize: '0.85rem',
                    outline: 'none',
                    resize: 'vertical'
                  }}
                  placeholder="과제에 대한 핵심 목표 및 추진 내용을 입력하세요."
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                  특이사항 및 비고
                </label>
                <input
                  type="text"
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid var(--border-color)',
                    color: '#ffffff',
                    fontSize: '0.85rem',
                    outline: 'none'
                  }}
                  placeholder="대표님 참고사항 / 이슈 사항 등"
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '12px' }}>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  style={{
                    padding: '10px 18px',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  취소
                </button>
                <button
                  type="submit"
                  style={{
                    padding: '10px 24px',
                    borderRadius: '8px',
                    border: 'none',
                    background: 'linear-gradient(135deg, #6366f1 0%, #06b6d4 100%)',
                    color: '#ffffff',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  {editingTask ? '수정 저장' : '과제 등록 완료'}
                </button>
              </div>

            </form>
          </div>
        </div>
      )}

    </div>
  );
}
