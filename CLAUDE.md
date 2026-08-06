# Claude Code Instructions

Please refer to [AGENTS.md](file:///C:/Users/LD/Desktop/ravi/cleaning-ops/AGENTS.md) for full architecture, environment variables, script mappings, and task roadmap.

## ⛔ 최우선 규칙 — 확인 먼저, 실행은 그 다음

**혼자 판단해서 다음 단계로 넘어가지 말 것.** 한 단계가 끝나면 결과를 보고하고
운영자 확인을 받은 뒤 진행한다. 자세한 내용은 AGENTS.md "6. Critical Operational
Rules → 0. ASK BEFORE ACTING" 참고.

멈추고 물어봐야 하는 경우:
- 운영자가 준 스크립트·데이터가 실제 스키마와 **안 맞을 때** → 임의로 고치지 말고 보고
- DB 쓰기(insert/update/delete/DDL) — 적용 전 무엇이 몇 건인지 먼저 보고
- 외부 작업 — 네이버 로그인, 수집요청 제출, 배포, DNS 변경
- 파일 삭제·덮어쓰기·대량 리팩터링
- 지시서에 없는 값을 스스로 정해야 할 때 (그룹 키, 계정 배정, 명명 규칙 등)

읽기 전용 조사(파일 읽기, 검색, `--dry-run`, `select`)와 방금 지시받은 바로 그
작업은 물어보지 않아도 된다.

**임의로 정한 값이 있으면 반드시 목록으로 보고할 것.**

## Quick Commands
- Root dependencies: `npm install`
- Apply DB migrations: `npm run db:migrate` (dry run: `npm run db:migrate:dry`)
- Register domains/accounts: `npm run domains:register`
- App dev server: `cd apps/cleaning-ravi && npm run dev`
- App build: `cd apps/cleaning-ravi && npm run build`
- Run Naver crawl requests (Windows): `powershell -File ./scripts/run-windows-naver-crawl-resume.ps1`
