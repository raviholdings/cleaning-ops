#Requires -Version 5.1
<#
.SYNOPSIS
  어드민 대시보드를 빌드본으로 띄운다. 작업 스케줄러가 부팅 때 이걸 부른다.

.DESCRIPTION
  Cloudflare 터널(admin.uloung.com)이 localhost:3000 을 바라본다.
  터널은 윈도우 서비스라 알아서 뜨지만, 이 서버가 없으면 502 가 난다.

  개발 서버(npm run dev)가 아니라 빌드본(npm run preview)을 띄운다.
  개발 서버는 모듈을 하나씩 그때그때 변환해 내려주므로 요청이 100개가 넘고,
  터널을 왕복하면 한 장 여는 데 몇 초씩 걸린다. 빌드본은 파일 3개면 된다.

  dist 가 없으면 먼저 빌드한다. 코드를 고쳤을 때는 -Rebuild 로 강제한다.

    powershell -NoProfile -ep Bypass -File scripts/run-admin-server.ps1
    powershell -NoProfile -ep Bypass -File scripts/run-admin-server.ps1 -Rebuild
#>
param([switch]$Rebuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $root 'apps\cleaning-admin'
Set-Location $appDir

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'admin-server.log'

function Write-AdminLog {
	param([string]$Message)
	$line = "[{0}] {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message
	Write-Host $line
	Add-Content -Path $log -Value $line -Encoding utf8
}

Write-AdminLog '어드민 서버 시작 준비'

# 이미 3000 을 쓰고 있으면 그 프로세스를 접는다. 두 개가 뜨면 하나는
# 3001 로 밀려서 터널이 못 찾는다.
$busy = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $busy) {
	Write-AdminLog "3000 포트를 쓰던 프로세스 종료: PID $($conn.OwningProcess)"
	Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
}
if ($busy) { Start-Sleep -Seconds 3 }

if ($Rebuild -or -not (Test-Path (Join-Path $appDir 'dist\index.html'))) {
	Write-AdminLog '빌드 시작'
	& npm run build 2>&1 | ForEach-Object { Add-Content -Path $log -Value ([string]$_) -Encoding utf8 }
	if ($LASTEXITCODE -ne 0) { Write-AdminLog "빌드 실패 exit=$LASTEXITCODE"; exit 1 }
	Write-AdminLog '빌드 완료'
}

Write-AdminLog 'preview 서버 실행 (localhost:3000)'
& npm run preview 2>&1 | ForEach-Object { Add-Content -Path $log -Value ([string]$_) -Encoding utf8 }
