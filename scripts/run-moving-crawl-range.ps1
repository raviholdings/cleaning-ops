#Requires -Version 5.1
<#
.SYNOPSIS
  이사(moving-ravi) 수집요청을 계정 순번 범위로 돌린다.

.DESCRIPTION
  청소의 run-crawl-range.ps1 과 같은 골격이지만 세 가지가 다르다.

  1. 그룹을 moving-ravi 로 고정한다. 청소 큐는 건드리지 않는다.
  2. URL 은 각 사이트의 /이사/sitemap.xml 에서 읽는다 (사이트맵 모드).
     배포 산출물과 100% 같은 주소가 들어가므로 인코딩 불일치로 할당량을
     이중 소모할 일이 없다. 사이트맵의 <loc> 은 퍼센트 인코딩 형태다.
  3. 사이트맵 경로는 인코딩 형태(%EC%9D%B4%EC%82%AC = "이사")로 넘긴다.
     PS 5.1 콘솔 인코딩에 한글 env 가 깨지는 사고를 피한다.

  DB 에 moving-ravi 그룹 행이 등록되어 있어야 대상이 잡힌다.

.EXAMPLE
  powershell -NoProfile -ep Bypass -File scripts/run-moving-crawl-range.ps1 -From 1  -To 20   # 본 PC
  powershell -NoProfile -ep Bypass -File scripts/run-moving-crawl-range.ps1 -From 21 -To 50   # VM1
  powershell -NoProfile -ep Bypass -File scripts/run-moving-crawl-range.ps1 -From 1 -To 20 -DryRun
#>
param(
	[Parameter(Mandatory = $true)][int]$From,
	[Parameter(Mandatory = $true)][int]$To,
	[switch]$DryRun,
	[switch]$NoHaiIp,
	# 재수집 기준선 — 청소 run-crawl-range.ps1 과 동일. 예: -DoneSince 2026-08-23T00:00:00+09:00
	[string]$DoneSince = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($From -lt 1 -or $To -lt 1) {
	throw "순번은 1 이상이어야 합니다. 입력값: -From $From -To $To  (예: -From 21 -To 50)"
}
if ($From -gt $To) {
	throw "-From 이 -To 보다 큽니다. 입력값: -From $From -To $To"
}

Write-Host "계정 순번 $From ~ $To 의 계정 ID 를 조회합니다..."
$ids = (& node (Join-Path $PSScriptRoot 'get-account-ids-by-order.mjs') --from $From --to $To) | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) { throw "계정 조회 실패 (exit $LASTEXITCODE)" }

$ids = ($ids | Out-String).Trim()
if (-not $ids) {
	Write-Host "순번 $From~$To 에 수집요청 대상 계정이 없습니다." -ForegroundColor Yellow
	exit 0
}

$count = ($ids -split ',').Count
Write-Host "대상 계정 $count 개 (이사 · moving-ravi): $ids"

$env:NAVER_WINDOWS_CRAWL_RUNNER_PC = 'siwol-win'
$env:NAVER_CRAWL_RUNNER_PC = 'siwol-win'
$env:NAVER_CRAWL_INCLUDE_ACCOUNTS = $ids
$env:NAVER_CRAWL_EXCLUDE_ACCOUNTS = ''
# 구글시트 갱신 끔 — 시트가 실제로 만들어진 적이 없는데 계정마다 무거운 DB 조회만
# 돌리고 타임아웃으로 죽었다 (2026-08-21). 현황은 관리자 페이지가 담당한다.
$env:NAVER_WINDOWS_CRAWL_UPDATE_SHEETS = '0'

# 이사 전용 — 그룹 고정 + 사이트맵 모드 + 이사 사이트맵 경로
$env:NAVER_CRAWL_INCLUDE_GROUPS = 'moving-ravi'
$env:NAVER_CRAWL_EXCLUDE_GROUPS = ''
$env:NAVER_CRAWL_SITEMAP_ONLY_PROJECTS = 'moving-ravi'
$env:NAVER_CRAWL_SITEMAP_PATH = '/%EC%9D%B4%EC%82%AC/sitemap.xml'

if ($DoneSince) {
	$cleanDoneSince = $DoneSince.Trim().TrimEnd('\', '"', "'")
	$env:NAVER_CRAWL_DONE_SINCE = $cleanDoneSince
	Write-Host "재수집 기준선: $cleanDoneSince 이전 제출은 없던 것으로 칩니다." -ForegroundColor Yellow
} else {
	$env:NAVER_CRAWL_DONE_SINCE = ''
}

$forwarded = @()
if ($DryRun) { $forwarded += '-DryRun' }
if ($NoHaiIp) { $forwarded += '-NoHaiIp' }

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run-windows-naver-crawl-resume.ps1') @forwarded
exit $LASTEXITCODE
