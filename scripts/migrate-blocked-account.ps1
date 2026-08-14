#Requires -Version 5.1
<#
.SYNOPSIS
  정지된 계정의 도메인을 새 계정으로 옮기고, 쓸 수 있는 상태까지 한 번에 되돌린다.

.DESCRIPTION
  계정이 정지되면 거기 물린 서브도메인 100개가 통째로 멈춘다. 서브도메인과
  페이지는 멀쩡하니 다른 계정으로 옮겨 다시 쓴다. 그런데 옮기는 것만으로는
  안 되고 네 단계를 더 거쳐야 한다. 그걸 손으로 하면 중간에 빠뜨리기 쉬워
  하나로 묶었다.

    1. 이관        도메인 소유 계정을 바꾸고 옛 계정을 blocked 로
    2. 사이트등록   새 계정으로 서치어드바이저에 등록하고 토큰을 받는다
    3. 재배포      받은 토큰을 페이지 메타태그로 내보낸다
    4. 소유확인     네이버가 그 메타태그를 확인한다
    5. 수집요청     비로소 색인 요청을 넣을 수 있다

  2번을 건너뛰면 4번이 전부 실패한다. 서치어드바이저에서 사이트는 "등록한
  계정의 것"이라, DB 의 소유자만 바꾸고 옛 토큰을 그대로 두면 새 계정 세션으로
  소유확인할 때 남의 사이트가 되기 때문이다.

  3번도 건너뛰면 안 된다. 토큰은 페이지에 실려 나가야 네이버가 읽는다.

.PARAMETER From
  정지된 계정 ID.

.PARAMETER To
  받을 계정 ID. 도메인이 하나도 없어야 한다(네이버 계정당 사이트 100개 상한).
  세션이 미리 캡처돼 있어야 한다 — capture-naver-session.mjs 는 실제 로그인이라
  사람이 붙어야 해서 이 스크립트에 넣지 않았다.

.PARAMETER Order
  받을 계정의 순번. 재배포 구간을 정하는 데 쓴다.

.EXAMPLE
  # 무엇이 바뀌는지만 보기
  powershell -NoProfile -ep Bypass -File scripts/migrate-blocked-account.ps1 `
    -From nm4ohsf9dj77 -To puxl74870 -Order 102 -DryRun

  # 실제 실행
  powershell -NoProfile -ep Bypass -File scripts/migrate-blocked-account.ps1 `
    -From nm4ohsf9dj77 -To puxl74870 -Order 102

  # 수집요청까지 이어서
  powershell -NoProfile -ep Bypass -File scripts/migrate-blocked-account.ps1 `
    -From nm4ohsf9dj77 -To puxl74870 -Order 102 -WithCrawl
#>
param(
	[Parameter(Mandatory = $true)][string]$From,
	[Parameter(Mandatory = $true)][string]$To,
	[Parameter(Mandatory = $true)][int]$Order,
	[switch]$DryRun,
	[switch]$WithCrawl,
	[switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$node = $env:NODE_EXE
if (-not $node -or -not (Test-Path $node)) { $node = 'node' }

function Step {
	param([string]$Title)
	Write-Host ''
	Write-Host ('=' * 60)
	Write-Host ("  $Title")
	Write-Host ('=' * 60)
}

function Fail {
	param([string]$Message)
	Write-Host ''
	Write-Host "중단: $Message" -ForegroundColor Red
	Write-Host '앞 단계까지는 반영됐다. 원인을 고치고 같은 명령을 다시 실행하면 이어서 간다.'
	exit 1
}

if ($From -eq $To) { Fail "-From 과 -To 가 같다: $From" }
if ($Order -lt 1) { Fail "-Order 는 1 이상이어야 한다: $Order" }

Write-Host "정지 계정 이관: $From  ->  $To (#$Order)"
if ($DryRun) { Write-Host '  [dry-run] 1단계만 미리보기로 돌고 끝난다.' -ForegroundColor Yellow }

# ---------------------------------------------------------------- 1. 이관
Step '1/5  도메인 이관 + 옛 계정 정지'
$reassign = @('scripts/reassign-account-domains.mjs', '--from', $From, '--to', $To)
if ($DryRun) { $reassign += '--dry-run' } else { $reassign += '--block-source' }
& $node @reassign
if ($LASTEXITCODE -ne 0) { Fail "이관 실패 (exit $LASTEXITCODE)" }
if ($DryRun) {
	Write-Host ''
	Write-Host 'dry-run 이므로 여기서 멈춘다. 결과가 맞으면 -DryRun 을 빼고 다시 실행할 것.'
	exit 0
}

# ---------------------------------------------------------------- 2. 사이트등록
# 새 계정으로 등록해야 토큰이 그 계정 것이 된다. 옛 토큰은 이관 때 비워졌다.
Step '2/5  서치어드바이저 사이트등록 (토큰 발급)'
& $node 'scripts/register-naver-searchadvisor-sites.mjs' '--account' $To
if ($LASTEXITCODE -ne 0) { Fail "사이트등록 실패 (exit $LASTEXITCODE)" }

# ---------------------------------------------------------------- 3. 재배포
# 토큰은 페이지의 <meta name="naver-site-verification"> 로 나가야 읽힌다.
Step '3/5  재배포 (토큰을 메타태그로 내보내기)'
if ($SkipDeploy) {
	Write-Host '  -SkipDeploy 라 건너뛴다. 소유확인이 전부 실패하면 이 단계를 안 한 탓이다.' -ForegroundColor Yellow
} else {
	& $node 'scripts/build-and-deploy-sites.mjs' `
		'--renderer' 'static' '--templates' 'templates-merged' '--extend' 'merged' `
		'--gzip' '--no-feeds' '--chunk-sites' '250' '--chunk-retries' '3' `
		'--from-order' "$Order" '--to-order' "$Order"
	if ($LASTEXITCODE -ne 0) { Fail "재배포 실패 (exit $LASTEXITCODE)" }
}

# ---------------------------------------------------------------- 4. 소유확인
Step '4/5  소유확인'
& $node 'scripts/verify-naver-searchadvisor-sites.mjs' '--account' $To
if ($LASTEXITCODE -ne 0) { Fail "소유확인 실패 (exit $LASTEXITCODE)" }

# ---------------------------------------------------------------- 5. 수집요청
Step '5/5  수집요청'
if ($WithCrawl) {
	& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run-crawl-range.ps1') `
		-From $Order -To $Order
	if ($LASTEXITCODE -ne 0) { Fail "수집요청 실패 (exit $LASTEXITCODE)" }
} else {
	Write-Host '  -WithCrawl 을 안 줘서 건너뛴다. 따로 돌리려면:'
	Write-Host "    powershell -NoProfile -ep Bypass -File scripts/run-crawl-range.ps1 -From $Order -To $Order"
}

Write-Host ''
Write-Host ('=' * 60)
Write-Host "  완료: $From -> $To (#$Order)"
Write-Host ('=' * 60)
Write-Host '확인:'
Write-Host "  node scripts/verify-naver-searchadvisor-sites.mjs --account $To --limit 1   # 남은 건수 확인"
