#Requires -Version 5.1
<#
.SYNOPSIS
  배관 수집요청을 계정 순번 범위로 돌린다.

.DESCRIPTION
  이사 run-moving-crawl-range.ps1 과 같은 골격이다. 배관만의 차이는 두 가지.

  1. 그룹이 둘이다. 도메인 출처가 달라서 하나로 못 묶는다.
       piping-ravi         신규 서브도메인 10,000 (계정 201~300, 자기 도메인)
       piping-ravi-shared  기존 청소 서브도메인 10,000 (계정 1~105, 도메인 차용)
     -Group 으로 고른다. 계정 범위와 안 맞으면 대상이 0건이 되므로 미리 막는다.

  2. URL 은 각 사이트의 /배관/sitemap.xml 에서 읽는다 (사이트맵 모드).
     배포 산출물과 100% 같은 주소가 들어가 인코딩 불일치로 할당량을 이중
     소모할 일이 없다. 경로는 인코딩 형태(%EB%B0%B0%EA%B4%80 = "배관")로 넘긴다 —
     PS 5.1 콘솔 인코딩에서 한글 env 가 깨지는 사고를 피한다.

  ⚠ 그룹의 crawl_request_enabled 가 true 여야 대상이 잡힌다. 배관 두 그룹은
    false 로 만들어 뒀다 (배포·소유확인 전에 새어 나가지 않게). 켜는 것은 별도 작업.

  ⚠ 기존 1만(piping-ravi-shared)은 청소·이사와 하루 50건/사이트 한도를 나눠 쓴다.
    청소 재수집이 도는 중에 같이 돌리면 서로 갉아먹는다.

.EXAMPLE
  powershell -NoProfile -ep Bypass -File scripts/run-piping-crawl-range.ps1 -Group piping-ravi -From 201 -To 230
  powershell -NoProfile -ep Bypass -File scripts/run-piping-crawl-range.ps1 -Group piping-ravi-shared -From 1 -To 20
  powershell -NoProfile -ep Bypass -File scripts/run-piping-crawl-range.ps1 -Group piping-ravi -From 201 -To 201 -DryRun
#>
param(
	[Parameter(Mandatory = $true)][ValidateSet('piping-ravi', 'piping-ravi-shared')][string]$Group,
	[Parameter(Mandatory = $true)][int]$From,
	[Parameter(Mandatory = $true)][int]$To,
	[switch]$DryRun,
	[switch]$NoHaiIp,
	# 재수집 기준선 — 청소·이사와 동일. 예: -DoneSince 2026-08-25T00:00:00+09:00
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

# 그룹과 계정 범위가 어긋나면 조용히 0건이 된다. 원인을 찾느라 시간을 버리지 않게 막는다.
# 신규 배관 계정은 201~300 이지만, 정지된 계정의 도메인은 100번대 여유 순번으로
# 이관된다(예: 204 정지 -> 106). 그 계정도 배관 도메인을 갖고 있으므로 범위에
# 넣어야 한다. 101~200 중 배관 도메인이 없는 계정은 그룹 필터에서 0건이 되어 무해하다.
if ($Group -eq 'piping-ravi' -and ($From -lt 101 -or $To -gt 300)) {
	throw "piping-ravi(신규 서브도메인)는 계정 201~300(정지 이관분은 101~200) 입니다. 입력값: -From $From -To $To"
}
if ($Group -eq 'piping-ravi-shared' -and $To -gt 105) {
	throw "piping-ravi-shared(기존 서브도메인)는 계정 1~105 입니다. 입력값: -From $From -To $To"
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
Write-Host "대상 계정 $count 개 (배관 · $Group): $ids"

$env:NAVER_WINDOWS_CRAWL_RUNNER_PC = 'siwol-win'
$env:NAVER_CRAWL_RUNNER_PC = 'siwol-win'
$env:NAVER_CRAWL_INCLUDE_ACCOUNTS = $ids
$env:NAVER_CRAWL_EXCLUDE_ACCOUNTS = ''
# 구글시트 갱신 끔 — 시트가 실제로 만들어진 적이 없는데 계정마다 무거운 DB 조회만
# 돌리고 타임아웃으로 죽었다 (2026-08-21). 현황은 관리자 페이지가 담당한다.
$env:NAVER_WINDOWS_CRAWL_UPDATE_SHEETS = '0'

# 배관 전용 — 그룹 고정 + 사이트맵 모드 + 배관 사이트맵 경로
$env:NAVER_CRAWL_INCLUDE_GROUPS = $Group
$env:NAVER_CRAWL_EXCLUDE_GROUPS = ''
$env:NAVER_CRAWL_SITEMAP_ONLY_PROJECTS = $Group
# 2026-08-27: URL 을 숫자로 바꾸면서 /배관/ -> /piping/ 이 되었다.
# 옛 경로(%EB%B0%B0%EA%B4%80)로 두면 사이트맵을 못 찾아 조용히 0건이 된다.
$env:NAVER_CRAWL_SITEMAP_PATH = '/piping/sitemap.xml'

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
