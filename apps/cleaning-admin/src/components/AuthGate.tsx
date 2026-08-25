import React, { useEffect, useState } from 'react';
import { LogIn, UserPlus, ShieldCheck, Clock, AlertTriangle } from 'lucide-react';

export interface SessionUser {
  id: number;
  username: string;
  name: string | null;
  status: 'pending' | 'approved' | 'blocked';
  role: 'owner' | 'staff' | 'member';
}

interface Props {
  children: (user: SessionUser) => React.ReactNode;
}

/**
 * 로그인하지 않으면 아무것도 안 보여준다.
 *
 * 어드민에는 네이버 계정 ID, 도메인 1만 개, 계정별 배정 IP 가 그대로 있다.
 * 주소를 아는 사람이면 누구나 보는 상태로 두면 안 된다.
 *
 * 가입은 열려 있지만 승인 전에는 데이터를 못 본다. 첫 가입자만 자동으로
 * 승인되고, 그 사람이 나머지를 승인한다.
 */
export default function AuthGate({ children }: Props) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => setUser(d.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'signup' ? { username, password, name } : { username, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || '처리에 실패했습니다.'); return; }

      if (mode === 'signup') {
        setNotice(data.message || '가입이 접수됐습니다.');
        setMode('login');
        setPassword('');
      } else {
        setUser(data.user);
      }
    } catch {
      setError('서버에 연결하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  };

  if (checking) {
    return (
      <div style={wrap}>
        <div style={{ color: '#94a3b8', fontSize: '0.9rem' }}>확인 중...</div>
      </div>
    );
  }

  // 로그인은 했지만 아직 승인 전
  if (user && user.status !== 'approved') {
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            {user.status === 'pending'
              ? <Clock size={22} color="#fbbf24" />
              : <AlertTriangle size={22} color="#f87171" />}
            <h1 style={title}>
              {user.status === 'pending' ? '승인 대기 중' : '차단된 계정'}
            </h1>
          </div>
          <p style={desc}>
            {user.status === 'pending'
              ? '가입은 완료됐습니다. 관리자가 승인하면 바로 이용할 수 있습니다.'
              : '이 계정은 차단되어 있습니다. 관리자에게 문의하세요.'}
          </p>
          <div style={{ ...desc, marginTop: 6 }}>{user.username}</div>
          <button style={{ ...button, marginTop: 18, background: 'rgba(255,255,255,0.08)' }} onClick={logout}>
            로그아웃
          </button>
        </div>
      </div>
    );
  }

  if (user) return <>{children(user)}</>;

  return (
    <div style={wrap}>
      <form style={card} onSubmit={submit}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <ShieldCheck size={22} color="#818cf8" />
          <h1 style={title}>클리닝 운영 대시보드</h1>
        </div>
        <p style={desc}>{mode === 'login' ? '로그인이 필요합니다.' : '가입 후 관리자 승인을 받아야 이용할 수 있습니다.'}</p>

        {notice && <div style={{ ...banner, background: 'rgba(52,211,153,0.12)', color: '#6ee7b7' }}>{notice}</div>}
        {error && <div style={{ ...banner, background: 'rgba(248,113,113,0.12)', color: '#fca5a5' }}>{error}</div>}

        {mode === 'signup' && (
          <input style={input} placeholder="이름 (선택)" value={name} onChange={(e) => setName(e.target.value)} />
        )}
        <input
          style={input} type="text" placeholder="아이디 (영문 소문자·숫자·_-)" required
          autoComplete="username" pattern="[a-z0-9_-]{3,30}"
          value={username} onChange={(e) => setUsername(e.target.value)}
        />
        <input
          style={input} type="password" placeholder="비밀번호 (8자 이상)" required minLength={8}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          value={password} onChange={(e) => setPassword(e.target.value)}
        />

        <button style={button} type="submit" disabled={busy}>
          {mode === 'login' ? <LogIn size={16} /> : <UserPlus size={16} />}
          {busy ? '처리 중...' : mode === 'login' ? '로그인' : '가입 신청'}
        </button>

        <button
          type="button"
          style={{ ...linkButton }}
          onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setNotice(''); }}
        >
          {mode === 'login' ? '계정이 없으신가요? 가입하기' : '이미 계정이 있으신가요? 로그인'}
        </button>
      </form>
    </div>
  );
}

const wrap: React.CSSProperties = {
  minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: '#0b1020', padding: 20,
};
const card: React.CSSProperties = {
  width: '100%', maxWidth: 380, background: '#151b2b', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 16, padding: 28, display: 'flex', flexDirection: 'column', gap: 10,
};
const title: React.CSSProperties = { fontSize: '1.1rem', fontWeight: 700, color: '#fff', margin: 0 };
const desc: React.CSSProperties = { color: '#94a3b8', fontSize: '0.85rem', margin: 0 };
const banner: React.CSSProperties = { padding: '10px 12px', borderRadius: 8, fontSize: '0.84rem', lineHeight: 1.5 };
const input: React.CSSProperties = {
  padding: '11px 13px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)', color: '#fff', fontSize: '0.9rem', outline: 'none',
};
const button: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
  padding: '11px 13px', borderRadius: 9, border: 'none', background: '#4f46e5',
  color: '#fff', fontSize: '0.92rem', fontWeight: 700, cursor: 'pointer', marginTop: 4,
};
const linkButton: React.CSSProperties = {
  background: 'none', border: 'none', color: '#818cf8', fontSize: '0.82rem',
  cursor: 'pointer', marginTop: 2,
};
