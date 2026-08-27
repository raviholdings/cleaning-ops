@echo off
rem 루트 도메인 10개의 네이버 색인 상태를 찍는다 (작업 스케줄러 ravi-root-index-monitor).
rem 밤(22:00~09:00) 15분 · 낮(09:00~22:00) 30분 — 트리거 2개로 나눠 걸려 있다.
rem 밤을 조인 이유: 색인이 4시간짜리로 붙었다 떨어졌다 하고
rem (2026-08-25 naoheg 16:42 20건 -> 21:06 0건), 아침에 밤사이 기록을 보기 때문이다.
rem 회차당 11쿼리(루트 10 + 대조군 1) · 하루 770쿼리 = 차단 한계(1,400~1,900/일)의 41~55%.
rem 색인 조사 배치와 IP 예산을 공유한다 — 그걸 같이 돌릴 거면 밤도 30분으로 되돌릴 것.
rem HaiIP 로 인터넷이 끊긴 시각이면 그 회차만 실패 — 다음 회차가 이어 찍는다.
cd /d C:\Users\LD\Desktop\ravi\cleaning-ops
node scripts\check-naver-root-index-daily.mjs >> logs\root-index-monitor.log 2>&1
