# Claude Code Instructions

작업별 상세 절차·함정은 `.claude/skills/` 에 있다 (해당 작업 시 자동 로드):

| 스킬 | 내용 |
|---|---|
| deploy | 청소·이사 굽기와 EC2 배포 |
| server | SSM · nginx · 웹루트 |
| r2 | R2 자산 업로드, immutable 버전 규칙 |
| crawl | 수집요청, HaiIP · 세션 · dedup 함정 |
| index-check | 색인 배치, 페이스 · 차단 한계 |

서브에이전트: `deployer`(배포 전용) · `server-ops`(서버 전용) — 실행 범위를
명시해서 위임하고, 위임 전에 운영자 확인을 받는다.

배경 문서: `docs/` (MOVING-PROJECT-SPEC, GZIP-ASSET-DEPLOY, STATIC-RENDERER,
INDEX-CHECK-HANDOVER, LEAD-BEACON, HAIIP-VM-SCALEOUT-PROMPT 등).
**배관 신규 프로젝트는 docs/PIPING-PROJECT-HANDOVER.md 부터 읽을 것** —
인프라 전체 플로우·확정 요구사항·실행 단계·함정 총정리 (2026-08-24).
**apex(루트 도메인) 홈페이지는 docs/APEX-HANDOVER.md 부터 읽을 것** —
파일 지도·수정 위치·함정 10가지·미완료 목록 (2026-08-26).

## ⛔ 최우선 규칙 — 확인 먼저, 실행은 그 다음

**혼자 판단해서 다음 단계로 넘어가지 말 것.** 한 단계가 끝나면 결과를 보고하고
운영자 확인을 받은 뒤 진행한다.

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
- 이사 사이트 굽기: `node scripts/build-moving-site.mjs --site-index N --host <host> [--pages 3]`
- Run Naver crawl requests (Windows): `powershell -File scripts/run-crawl-range.ps1 -From 1 -To 20`
  (이사 `run-moving-crawl-range.ps1` / 배관 `run-piping-crawl-range.ps1 -Group …`.
  `run-windows-naver-crawl-resume.ps1` 은 본체라 직접 부르면 남의 기계 계정까지 돈다)
