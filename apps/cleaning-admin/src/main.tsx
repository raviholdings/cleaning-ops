import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import AuthGate from './components/AuthGate.tsx';
import './index.css';

// 로그인하지 않으면 App 자체를 렌더하지 않는다. App 이 마운트되자마자
// /api/stats 를 부르는데, 어차피 서버가 401 을 주지만 화면을 아예 안 그리는
// 편이 낫다.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>{(user) => <App user={user} />}</AuthGate>
  </React.StrictMode>,
);
