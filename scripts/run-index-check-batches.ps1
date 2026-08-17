#Requires -Version 5.1
<#
.SYNOPSIS
  색인 조사를 작게 끊어 돌리고, 회차 사이에 쉰다.

.DESCRIPTION
  한 번에 1만 개를 밀어넣으면 네이버가 막는다. 실측:

    2026-08-14  프록시  30개 · 요청 1,386건  → 403, 9,497개 실패
    2026-08-17  프록시 100개 · 요청 1,892건  → 403, 828개 실패

  프록시를 100개로 늘려 IP 당 부하를 3분의 1로 줄였는데도 비슷한 총량에서
  똑같이 막혔다. IP 별 한도가 아니라 짧은 시간에 몰린 전체 요청량을 보는
  것이다. 그래서 프록시를 더 사도 해결되지 않고, 회차를 작게 끊고 사이에
  쉬는 수밖에 없다.

  한 회차 200개면 요청이 약 900건이다. 막히기 시작한 1,400건의 3분의 2다.

  같은 -RunId 로 반복하면 스크립트가 알아서 이어간다.
    NAVER_INDEX_CHECK_RESUME  성공한 도메인은 건너뛴다 (기본 켜짐)
    NAVER_INDEX_RETRY_ERRORS  실패한 것만 다시 시도한다

.PARAMETER BatchSize
  한 회차에 볼 도메인 수. 기본 200.

.PARAMETER RestMinutes
  회차 사이 휴식(분). 기본 20.

.PARAMETER Rounds
  돌릴 회차 수. 기본 12 (하루 2,400개꼴).

.EXAMPLE
  powershell -NoProfile -ep Bypass -File scripts/run-index-check-batches.ps1
  powershell -NoProfile -ep Bypass -File scripts/run-index-check-batches.ps1 -BatchSize 150 -RestMinutes 30
#>
param(
	[int]$BatchSize = 200,
	[int]$RestMinutes = 20,
	[int]$Rounds = 12,
	[string]$RunId = 'cleaning-ravi-index-rolling',
	[int]$Concurrency = 20,
	# 이 run-id 로 이미 끝낸 도메인 수. 이어서 돌릴 때 목표치를 여기서부터 키운다.
	[int]$ResumeFrom = 0
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$node = $env:NODE_EXE
if (-not $node -or -not (Test-Path $node)) { $node = 'node' }

$env:NAVER_INDEX_GROUP_KEY = 'cleaning-ravi'
$env:NAVER_INDEX_CHECK_CONCURRENCY = "$Concurrency"
$env:NAVER_INDEX_CHECK_RESUME = '1'
$env:NAVER_INDEX_RETRY_ERRORS = '1'

<#
 NAVER_INDEX_CHECK_LIMIT 은 회차당 증가분이 아니라 누적 목표치다.

 loadTargets 가 목표치만큼 도메인을 먼저 자르고, 거기서 이미 끝난 것을 뺀다.
 그래서 매 회차에 같은 값을 주면 두 번째 회차부터는 뺄 것이 없어 아무 일도
 안 하고 끝난다. 실제로 그렇게 걸었다가 1회차가 36초 만에 끝나고 그 뒤로
 제자리를 돌았다.

 회차마다 BatchSize 씩 목표를 키워야 200개씩 새로 본다.

 이미 다른 run-id 로 조사한 도메인과는 겹칠 수 있다. 완료 판정이 run-id
 단위라서다. 처음 몇 회차가 그만큼 빨리 끝나는 것으로 드러난다.
#>
$startFrom = 0
if ($ResumeFrom -gt 0) { $startFrom = $ResumeFrom }

Write-Host "색인 조사 (회차당 $BatchSize개 · 휴식 ${RestMinutes}분 · $Rounds회)"
Write-Host "run-id: $RunId"
Write-Host ''

$blocked = 0
for ($i = 1; $i -le $Rounds; $i += 1) {
	$goal = $startFrom + ($i * $BatchSize)
	$env:NAVER_INDEX_CHECK_LIMIT = "$goal"

	$stamp = (Get-Date).ToString('HH:mm:ss')
	Write-Host "[$stamp] $i/$Rounds 회차 시작 (누적 목표 $goal 개)"

	$out = & $node 'scripts/check-naver-indexed-posts.mjs' `
		'--group' 'cleaning-ravi' '--run-id' $RunId '--trigger' 'manual' 2>&1
	$text = ($out | Out-String)

	# 차단이 나오면 이번 회차는 이미 손해다. 더 세게 쉬어서 회복을 기다린다.
	$hits = ([regex]::Matches($text, 'naver blocked')).Count
	$line = ($text -split "`n" | Where-Object { $_ -match '"(checked|indexed)_domain_count"' }) -join ' '

	if ($hits -gt 0) {
		$blocked += 1
		Write-Host "  차단 $hits 건 — 이번 회차 손실. 휴식을 2배로 늘린다." -ForegroundColor Yellow
	} else {
		Write-Host "  차단 없음. $line" -ForegroundColor Green
	}

	if ($i -lt $Rounds) {
		$rest = if ($hits -gt 0) { $RestMinutes * 2 } else { $RestMinutes }
		Write-Host "  ${rest}분 휴식"
		Start-Sleep -Seconds ($rest * 60)
	}
}

Write-Host ''
Write-Host "끝. 차단이 난 회차 $blocked / $Rounds"
Write-Host '남은 도메인은 같은 명령을 다시 돌리면 이어서 간다.'
