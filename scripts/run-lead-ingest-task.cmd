@echo off
rem 매일 lead 비콘 로그를 DB 로 옮긴다 (Windows 작업 스케줄러 ravi-lead-ingest 가 부른다).
rem 회전 로그까지 ssh 로 통째로 읽고, dedup 이라 며칠 밀려도 다음 실행이 따라잡는다.
rem HaiIP 로 인터넷이 끊긴 시각이면 그 날은 실패 — rotate 10 이라 열흘 안에만 돌면 유실 없음.
cd /d C:\Users\LD\Desktop\ravi\cleaning-ops
node scripts\ingest-lead-beacon.mjs --ssh >> logs\lead-ingest-task.log 2>&1
