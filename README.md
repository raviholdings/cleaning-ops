# Cleaning Ops - 독립 네이버 수집/색인 및 입주청소 정적 사이트

본 프로젝트는 독립 서버 및 데이터베이스(Supabase/PostgreSQL) 기반의 입주청소 정적 사이트 배포, 네이버 Search Advisor 수집요청 자동화, 노출 색인 체크를 담당하는 전용 레포지토리입니다.

## 📂 프로젝트 구조

```text
cleaning-ops/
├── apps/
│   └── cleaning-ravi/             # Astro 입주청소 랜딩페이지 정적 앱
├── config/                         # Google Service Account JSON 등 설정 파일
├── scripts/                        # 네이버 수집요청, 색인 체크, IP 제어 핵심 스크립트 (21개)
│   └── lib/                        # 의존 라이브러리 스크립트
├── supabase/
│   └── migrations/                 # 독립 DB 마이그레이션 Clean DDL 스크립트 위치
├── logs/                           # 런너 실행 로그
├── reports/                        # 색인/수집 리포트 데이터
├── .env                            # 환경변수 설정 파일
└── package.json                    # 루트 런너 의존성 (pg, playwright)
```

## 🚀 빠른 시작

1. **환경변수 설정**
   `.env.example`을 참고하여 `.env` 파일의 DB 및 API 키를 설정합니다.

2. **의존성 설치**
   ```bash
   # 루트 런너 패키지 설치
   npm install

   # cleaning-ravi 앱 패키지 설치
   cd apps/cleaning-ravi
   npm install
   ```

3. **입주청소 랜딩페이지 실행**
   ```bash
   cd apps/cleaning-ravi
   npm run dev
   ```

4. **네이버 크롤링/수집요청 실행 (Windows)**
   ```powershell
   powershell -File ./scripts/run-windows-naver-crawl-resume.ps1
   ```
