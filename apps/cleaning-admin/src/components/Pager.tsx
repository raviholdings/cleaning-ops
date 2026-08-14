import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PagerProps {
  page: number;
  totalPages: number;
  total: number;
  loading?: boolean;
  onChange: (page: number) => void;
}

const button: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: '8px',
  border: '1px solid var(--border-color)',
  background: 'rgba(255,255,255,0.05)',
  color: '#ffffff',
  fontSize: '0.85rem',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
};

export default function Pager({ page, totalPages, total, loading, onChange }: PagerProps) {
  const disabledStyle = (disabled: boolean): React.CSSProperties =>
    disabled ? { ...button, opacity: 0.35, cursor: 'not-allowed' } : button;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '12px', padding: '12px 16px', flexWrap: 'wrap',
    }}>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
        총 {total.toLocaleString()}개 · {page} / {totalPages} 쪽
        {loading && <span style={{ marginLeft: '8px', color: '#818cf8' }}>불러오는 중…</span>}
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          type="button"
          style={disabledStyle(page <= 1)}
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft size={15} /> 이전
        </button>
        <button
          type="button"
          style={disabledStyle(page >= totalPages)}
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          다음 <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}
