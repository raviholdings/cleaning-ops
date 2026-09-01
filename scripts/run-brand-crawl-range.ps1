#Requires -Version 5.1
<#
.SYNOPSIS
  브랜드 사이트(다섯 개) 수집요청을 계정 순번 범위로 돌린다.

.DESCRIPTION
  배관 run-piping-crawl-range.ps1 과 같은 골격이다. 다른 점은 셋.

  1. 그룹이 brand-ravi 하나뿐이고 계정은 501~505 다. 한 계정이 도메인 하나씩 든다.

       501 dreamcome.kr    502 thunderdrain.kr   503 beaverpipe.kr
       504 ssac3.kr        505 dosadosa.kr

  2. URL 은 각 사이트의 /sitemap_index.xml 에서 읽는다 (사이트맵 모드).
     이건 Yoast 꼴 **색인**이라 <loc> 이 페이지가 아니라 자식 사이트맵이다.
     제출 본체가 색인을 한 단계 따라 내려가도록 고쳐 뒀다 (2026-09-01).
     그 수정 없이 돌리면 .xml 주소 열 개를 수집요청으로 올린다.

  3. 배관과 달리 생성 폴백이 없다. 주소가 한글이거나(싹쓰리) 3단계(도사)라
     번호로 만들 수가 없다. 사이트맵을 못 읽으면 그 계정은 그냥 0건이다.

  ⚠ 도메인 다섯이라 하루 천장이 250건(사이트당 50건)이다. 전체를 한 바퀴 도는 데
    싹쓰리 67일 · 도사 73일이 걸린다. 이건 러너로 못 줄인다 — 한도가 계정이 아니라
    사이트에 붙기 때문이다. 대량 색인은 IndexNow 쪽이 답이다.

  ⚠ 그룹의 crawl_request_enabled 가 true 여야 대상이 잡힌다.

.EXAMPLE
  powershell -NoProfile -ep Bypass -File scripts/run-brand-crawl-range.ps1 -From 501 -To 505 -DryRun
  powershell -NoProfile -ep Bypass -File scripts/run-brand-crawl-range.ps1 -From 501 -To 505
#>
param(
	[Parameter(Mandatory = $true)][int]$From,
	[Parameter(Mandatory = $true)][int]$To,
	[switch]$DryRun,
	[switch]$NoHaiIp,
	# 재수집 기준선 — 청소·이사·배관과 동일. 예: -DoneSince 2026-09-01T00:00:00+09:00
	[string]$DoneSince = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($From -lt 1 -or $To -lt 1) {
	throw "순번은 1 이상이어야 합니다. 입력값: -From $From -To $To"
}
if ($From -gt $To) {
	throw "-From 이 -To 보다 큽니다. 입력값: -From $From -To $To"
}
# 범위를 벗어나면 조용히 0건이 된다. 원인을 찾느라 시간을 버리지 않게 막는다.
if ($From -lt 501 -or $To -gt 505) {
	throw "브랜드(brand-ravi)는 계정 501~505 입니다. 입력값: -From $From -To $To"
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
Write-Host "대상 계정 $count 개 (브랜드 · brand-ravi): $ids"

$env:NAVER_WINDOWS_CRAWL_RUNNER_PC = 'siwol-win'
$env:NAVER_CRAWL_RUNNER_PC = 'siwol-win'
$env:NAVER_CRAWL_INCLUDE_ACCOUNTS = $ids
$env:NAVER_CRAWL_EXCLUDE_ACCOUNTS = ''
# 구글시트 갱신 끔 — 시트가 실제로 만들어진 적이 없다. 현황은 관리자 페이지가 담당한다.
$env:NAVER_WINDOWS_CRAWL_UPDATE_SHEETS = '0'

# 브랜드 전용 — 그룹 고정 + 사이트맵 모드
$env:NAVER_CRAWL_INCLUDE_GROUPS = 'brand-ravi'
$env:NAVER_CRAWL_EXCLUDE_GROUPS = ''
$env:NAVER_CRAWL_SITEMAP_ONLY_PROJECTS = 'brand-ravi'
$env:NAVER_CRAWL_SITEMAP_PATH = '/sitemap_index.xml'
# 생성 폴백 없음. 배관처럼 번호로 주소를 만들 수 없는 구조다.
$env:NAVER_CRAWL_PIPING_PAGE_COUNT = ''

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
