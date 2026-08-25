import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import AuthGate from './components/AuthGate.tsx';
import LeadDashboard from './components/LeadDashboard.tsx';
import './index.css';

// 로그인하지 않으면 App 자체를 렌더하지 않는다. App 이 마운트되자마자
// /api/stats 를 부르는데, 어차피 서버가 401 을 주지만 화면을 아예 안 그리는
// 편이 낫다.
// lead-dashboard.<루트> 로 들어오면 배관 접수 화면만 띄운다. 같은 서버·같은
// 인증을 쓰고 화면만 가른다 (admin.<루트> 는 종전 관리자 그대로).
const isLeadHost = window.location.hostname.startsWith('lead-dashboard');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>{(user) => (isLeadHost ? <LeadDashboard user={user} /> : <App user={user} />)}</AuthGate>
  </React.StrictMode>,
);
