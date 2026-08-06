{
  "name": "cleaning-ops",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "db:migrate": "node scripts/apply-migrations.mjs",
    "db:migrate:dry": "node scripts/apply-migrations.mjs --dry-run",
    "domains:register": "node scripts/register-naver-project-domains.mjs",
    "crawl:resume": "powershell -File ./scripts/run-windows-naver-crawl-resume.ps1",
    "index:check": "bash ./scripts/run-naver-index-checks.sh",
    "admin:dev": "npm --prefix apps/cleaning-admin run dev",
    "admin:build": "npm --prefix apps/cleaning-admin run build"
  },
  "dependencies": {
    "pg": "^8.11.3",
    "playwright": "^1.40.0"
  }
}
