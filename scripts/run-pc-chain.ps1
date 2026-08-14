#Requires -Version 5.1
<#
.SYNOPSIS
  이 PC 가 자리 비운 동안 혼자 돌게 하는 체인.

.DESCRIPTION
  배포 -> 소유확인(1~20) -> 수집요청(1~20) 을 순서대로 돌린다.

  한 기기에서 이 셋을 동시에 돌리면 안 된다. 셋 다 HaiIP 창을 조작해서
  IP 가 엉킨다. 그래서 순차로 묶었다.

  소유확인을 사이에 넣은 이유:
    #15·#16 은 08-07 배포가 실제로 안 올라가서 메타태그가 없었다. 이번
    재배포로 태그가 생기므로 바로 소유확인이 가능해진다. 그리고 수집요청은
    소유확인된 도메인만 대상으로 삼기 때문에, 먼저 확인해두면 그 200건이
    같은 밤에 수집요청까지 나간다.

  단계가 실패해도 다음으로 넘어간다. 배포만은 실패하면 멈춘다. 태그가 없는
  상태로 소유확인을 돌려봐야 전부 건너뛰기 때문이다.

    powershell -NoProfile -ep Bypass -File scripts/run-pc-chain.ps1
    powershell -NoProfile -ep Bypass -File scripts/run-pc-chain.ps1 -SkipDeploy
#>
param(
	[switch]$SkipDeploy,
	[switch]$SkipVerify,
	[switch]$SkipCrawl,
	[string]$Templates = 'templates-merged'
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir "pc-chain-$stamp.log"

function Write-Chain {
	param([string]$Message)
	$line = "[{0}] {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message
	# Write-Output 을 쓰면 이 함수의 반환값에 섞여 호출부를 오염시킨다.
	# 예전에 그것 때문에 HaiIP 검색창에 로그 문장이 입력된 적이 있다.
	Write-Host $line
	Add-Content -Path $log -Value $line -Encoding utf8
}

function Invoke-Step {
	param([string]$Label, [string]$File, [string[]]$Arguments)

	Write-Chain "START  $Label"
	$stepLog = Join-Path $logDir "pc-chain-$stamp-$($Label -replace '[^a-zA-Z0-9]', '-').log"
	$started = Get-Date

	& $File @Arguments *>&1 | ForEach-Object {
		$text = [string]$_
		Add-Content -Path $stepLog -Value $text -Encoding utf8
		if ($text -match '"phase"|진행|완료|✗|❌|오류|error|Error') { Write-Host "    $text" }
	}
	$code = $LASTEXITCODE
	$mins = [int]((Get-Date) - $started).TotalMinutes
	Write-Chain "END    $Label  exit=$code  ${mins}분  log=$stepLog"
	return $code
}

Write-Chain "===== PC 체인 시작 (templates=$Templates) ====="

# ---- 1) 배포 ----------------------------------------------------------
if (-not $SkipDeploy) {
	$code = Invoke-Step -Label 'deploy' -File 'node' -Arguments @(
		'scripts/build-and-deploy-sites.mjs',
		'--renderer', 'static',
		'--templates', $Templates,
		'--extend', 'merged'
	)
	if ($code -ne 0) {
		Write-Chain '배포 실패. 메타태그가 없으면 소유확인이 전부 건너뛰므로 여기서 멈춥니다.'
		exit 1
	}
} else {
	Write-Chain 'SKIP   deploy'
}

# ---- 2) 소유확인 1~20 -------------------------------------------------
if (-not $SkipVerify) {
	Invoke-Step -Label 'verify-1-20' -File 'node' -Arguments @(
		'scripts/verify-naver-searchadvisor-sites.mjs', '--accounts', '1-20'
	) | Out-Null
} else {
	Write-Chain 'SKIP   verify'
}

# ---- 3) 수집요청 1~20 -------------------------------------------------
if (-not $SkipCrawl) {
	Invoke-Step -Label 'crawl-1-20' -File 'powershell' -Arguments @(
		'-NoProfile', '-ExecutionPolicy', 'Bypass',
		'-File', (Join-Path $PSScriptRoot 'run-crawl-range.ps1'),
		'-From', '1', '-To', '20'
	) | Out-Null
} else {
	Write-Chain 'SKIP   crawl'
}

Write-Chain '===== PC 체인 완료 ====='
Write-Chain "전체 로그: $log"
