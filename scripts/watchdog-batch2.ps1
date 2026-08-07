param(
	[int]$CheckIntervalSeconds = 300,   # 5분마다 점검
	[int]$StallMinutes = 45,            # 이 시간 동안 진척이 없으면 멈춘 것으로 본다
	[int]$MaxRestarts = 12,
	[int]$FromOrder = 11,
	[int]$ToOrder = 20
)

# 2차 배치 마무리 러너가 죽거나 멈추면 알아서 다시 띄운다.
#
# 2026-08-05~06 이틀 동안 배포 실패·세션 만료·스크립트 손상으로 밤 작업이 세 번
# 통째로 날아갔다. 사람이 지켜보지 않아도 되게 감시자를 따로 둔다.
#
# 재시작이 안전한 이유:
#   - 토큰 회수는 이미 받은 건 건너뛴다
#   - 소유확인은 verified 인 도메인을 다시 하지 않는다
#   - 수집요청은 제출 이력을 보고 이어서 넣는다
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/watchdog-batch2.ps1

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

$Node = $env:NODE_EXE
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $Node)) { $Node = 'node' }

$LogDir = Join-Path $RootDir 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
$WatchLog = Join-Path $LogDir ("watchdog-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Write-WatchLog {
	param([string]$Message)
	$line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
	try { Add-Content -Path $WatchLog -Value $line -Encoding utf8 } catch {}
	Write-Host $line
}

# 남은 일감(소유확인 안 된 도메인 수)을 센다. 0 이면 다 끝난 것.
$RemainingJs = @'
const {readFileSync}=require('fs');
for(const l of readFileSync('.env','utf8').split(/\r?\n/)){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim();}
const pg=require('pg');
(async()=>{
  const c=new pg.Client({connectionString:process.env.DATABASE_URL||process.env.DIRECT_URL,ssl:{rejectUnauthorized:false}});
  await c.connect();
  const r=await c.query(`select
      count(*) filter (where d.naver_registration_status <> 'verified')::int remaining,
      count(*) filter (where d.naver_registration_status = 'verified')::int verified
    from public.naver_project_domains d
    join public.naver_searchadvisor_accounts a on a.account_id = d.naver_account_id
    where a.account_order between $1 and $2`, [Number(process.argv[1]), Number(process.argv[2])]);
  await c.end();
  console.log(`${r.rows[0].remaining} ${r.rows[0].verified}`);
})().catch(()=>{console.log('-1 -1');process.exit(0)})
'@

function Get-Progress {
	$out = (& $Node -e $RemainingJs "$FromOrder" "$ToOrder" 2>$null | Select-Object -Last 1)
	$parts = ([string]$out).Trim() -split '\s+'
	if ($parts.Count -lt 2) { return $null }
	return @{ Remaining = [int]$parts[0]; Verified = [int]$parts[1] }
}

function Test-RunnerAlive {
	$p = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
		Where-Object { $_.CommandLine -match 'run-batch2-finish\.ps1' }
	return [bool]$p
}

function Start-Runner {
	# 죽은 프로세스가 남긴 잠금 파일 때문에 새 러너가 바로 종료되는 걸 막는다.
	$lock = Join-Path $RootDir 'tmp\verify-crawl-chain.lock'
	if (Test-Path $lock) {
		try {
			$fs = [System.IO.File]::Open($lock, 'Open', 'ReadWrite', 'None')
			$fs.Close()
			Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
		} catch {
			Write-WatchLog '  잠금이 아직 살아 있습니다. 러너가 도는 중으로 보고 건너뜁니다.'
			return $false
		}
	}
	# 멈춘 하위 프로세스가 남아 있으면 IP 를 물고 있어 새 러너가 엉킨다.
	Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
		Where-Object { $_.CommandLine -match 'verify-naver|capture-naver|register-naver|submit-naver|build-and-deploy' } |
		ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
	Start-Sleep -Seconds 3

	Start-Process powershell.exe -ArgumentList @(
		'-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts\run-batch2-finish.ps1'
	) -WindowStyle Hidden | Out-Null
	return $true
}

# ---------------------------------------------------------------------------

Write-WatchLog "감시 시작. 대상 계정 $FromOrder~$ToOrder / 점검 ${CheckIntervalSeconds}초 / 정체판정 ${StallMinutes}분"

$restarts = 0
$lastVerified = -1
$lastProgressAt = Get-Date

while ($true) {
	Start-Sleep -Seconds $CheckIntervalSeconds

	$prog = Get-Progress
	if ($null -eq $prog -or $prog.Remaining -lt 0) {
		Write-WatchLog 'DB 조회 실패. 다음 점검에 다시 봅니다.'
		continue
	}

	if ($prog.Verified -ne $lastVerified) {
		Write-WatchLog ("진척 있음: 소유확인 {0} / 남은 {1}" -f $prog.Verified, $prog.Remaining)
		$lastVerified = $prog.Verified
		$lastProgressAt = Get-Date
	}

	if ($prog.Remaining -eq 0) {
		Write-WatchLog "✅ 계정 $FromOrder~$ToOrder 소유확인 전량 완료. 감시를 종료합니다."
		break
	}

	$alive = Test-RunnerAlive
	$stalledMin = [int]((Get-Date) - $lastProgressAt).TotalMinutes

	if (-not $alive) {
		if ($restarts -ge $MaxRestarts) {
			Write-WatchLog "러너가 죽었지만 재시작 상한(${MaxRestarts}회)에 도달했습니다. 사람 확인이 필요합니다."
			break
		}
		$restarts++
		Write-WatchLog "러너가 없습니다. 재시작합니다 ($restarts/$MaxRestarts). 남은 $($prog.Remaining)건"
		if (Start-Runner) { $lastProgressAt = Get-Date }
		continue
	}

	if ($stalledMin -ge $StallMinutes) {
		if ($restarts -ge $MaxRestarts) {
			Write-WatchLog "정체 상태지만 재시작 상한에 도달했습니다. 사람 확인이 필요합니다."
			break
		}
		$restarts++
		Write-WatchLog "${stalledMin}분째 진척이 없습니다. 강제 재시작합니다 ($restarts/$MaxRestarts)."
		Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
			Where-Object { $_.CommandLine -match 'run-batch2-finish\.ps1' } |
			ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
		Start-Sleep -Seconds 5
		if (Start-Runner) { $lastProgressAt = Get-Date }
	}
}

Write-WatchLog '감시 종료.'
