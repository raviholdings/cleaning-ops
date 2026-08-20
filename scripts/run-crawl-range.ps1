#Requires -Version 5.1
<#
.SYNOPSIS
  계정 순번 범위만 골라 수집요청을 돌린다. PC·VM 어디서든 같은 명령을 쓴다.

.DESCRIPTION
  기계마다 담당 계정이 다르다. 세션과 배정 IP 가 그 기계에 묶여 있어서,
  남의 계정을 돌리면 HaiIP 가 그 IP 를 못 잡고 계정마다 실패한다.

  이 스크립트가 두 가지를 채운다.

  1. 러너 이름
     run-windows-naver-crawl-resume.ps1 은 .env 를 읽지 않는다.
     환경변수가 없으면 $env:COMPUTERNAME 을 쓰는데, 매핑에 없는 이름이면
     "no runnable accounts for runnerPc=..." 로 죽는다.
     DB 의 crawl_runner_pc 값이 siwol-win 하나뿐이므로 그것으로 고정한다.

  2. 담당 계정만 선별
     순번 범위를 계정 ID 목록으로 바꿔 NAVER_CRAWL_INCLUDE_ACCOUNTS 에 넣는다.
     기계별로 다른 범위를 주면 서로 안 겹치므로 동시에 돌려도 된다.

.EXAMPLE
  powershell -NoProfile -ep Bypass -File scripts/run-crawl-range.ps1 -From 1  -To 20   # 본 PC
  powershell -NoProfile -ep Bypass -File scripts/run-crawl-range.ps1 -From 21 -To 50   # VM1
  powershell -NoProfile -ep Bypass -File scripts/run-crawl-range.ps1 -From 51 -To 80   # VM2
  powershell -NoProfile -ep Bypass -File scripts/run-crawl-range.ps1 -From 81 -To 100  # VM3
  powershell -NoProfile -ep Bypass -File scripts/run-crawl-range.ps1 -From 1 -To 20 -DryRun
#>
param(
	[Parameter(Mandatory = $true)][int]$From,
	[Parameter(Mandatory = $true)][int]$To,
	[switch]$DryRun,
	[switch]$NoHaiIp
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 값이 이상하면 여기서 멈춘다. "-To -50" 처럼 음수로 오타를 내면 범위가 비고,
# 그러면 "대상 계정이 없습니다" 로 조용히 끝나 정상인 줄 알게 된다.
if ($From -lt 1 -or $To -lt 1) {
	throw "순번은 1 이상이어야 합니다. 입력값: -From $From -To $To  (예: -From 21 -To 50)"
}
if ($From -gt $To) {
	throw "-From 이 -To 보다 큽니다. 입력값: -From $From -To $To  (예: -From 21 -To 50)"
}

Write-Host "계정 순번 $From ~ $To 의 계정 ID 를 조회합니다..."
$ids = (& node (Join-Path $PSScriptRoot 'get-account-ids-by-order.mjs') --from $From --to $To) | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) { throw "계정 조회 실패 (exit $LASTEXITCODE)" }

$ids = ($ids | Out-String).Trim()
if (-not $ids) {
	Write-Host "순번 $From~$To 에 수집요청 대상 계정이 없습니다. (소유확인된 도메인이 있어야 잡힙니다)" -ForegroundColor Yellow
	exit 0
}

$count = ($ids -split ',').Count
Write-Host "대상 계정 $count 개: $ids"

$env:NAVER_WINDOWS_CRAWL_RUNNER_PC = 'siwol-win'
$env:NAVER_CRAWL_RUNNER_PC = 'siwol-win'
$env:NAVER_CRAWL_INCLUDE_ACCOUNTS = $ids
# 청소 전용 러너다. 이사(moving-ravi)는 run-moving-crawl-range.ps1 이 따로 맡는다.
$env:NAVER_CRAWL_INCLUDE_GROUPS = 'cleaning-ravi'
$env:NAVER_CRAWL_EXCLUDE_GROUPS = ''
# 범위로 고르므로 제외 목록은 비운다. 이전 실행에서 남아 있으면 엉뚱하게 걸러진다.
$env:NAVER_CRAWL_EXCLUDE_ACCOUNTS = ''

$forwarded = @()
if ($DryRun) { $forwarded += '-DryRun' }
if ($NoHaiIp) { $forwarded += '-NoHaiIp' }

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run-windows-naver-crawl-resume.ps1') @forwarded
exit $LASTEXITCODE
