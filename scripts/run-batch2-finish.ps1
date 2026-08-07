param(
	[int]$VerifyReadyFrom = 11,   # 토큰·배포가 끝나 바로 소유확인 가능한 범위
	[int]$VerifyReadyTo = 14,
	[int]$NeedTokenFrom = 15,     # 토큰이 없어 회수부터 해야 하는 범위
	[int]$NeedTokenTo = 20,
	[int]$SessionRetries = 6,
	[int]$RegisterTimeoutMinutes = 60,
	[int]$VerifyTimeoutMinutes = 150,
	[int]$CrawlTimeoutMinutes = 90,
	[int]$DeployTimeoutMinutes = 90
)

# 2차 배치 마무리. 아래 순서로 끝까지 간다.
#
#   1) 계정 11~14  소유확인 -> 수집요청      (토큰·배포 이미 끝남)
#   2) 계정 15~20  토큰 회수                  (사이트는 네이버에 등록돼 있음)
#   3) 계정 15~20  빌드·배포                  (메타태그를 실제로 올린다)
#   4) 계정 15~20  소유확인 -> 수집요청
#
# HaiIP 는 회선 하나로 IP 를 한 번에 하나만 잡으므로 전부 순차다.
# 세션은 하루도 못 가므로 단계 진입 직전마다 --force 로 새로 잡는다.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-batch2-finish.ps1

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

$Node = $env:NODE_EXE
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $Node)) { $Node = 'node' }

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogDir = Join-Path $RootDir 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
$MainLog = Join-Path $LogDir "finish-$Stamp.log"

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Write-FinishLog {
	param([string]$Message)
	$line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
	try { Add-Content -Path $MainLog -Value $line -Encoding utf8 } catch {}
	# Write-Output 을 쓰면 호출한 함수의 반환값에 로그가 섞인다. 반드시 Write-Host.
	Write-Host $line
}

function Invoke-Step {
	param([string]$FilePath, [string[]]$Arguments, [string]$OutLog, [int]$TimeoutMinutes, [string]$Label)
	$startedAt = Get-Date
	Write-FinishLog "START  $Label"
	try {
		$proc = Start-Process -FilePath $FilePath -ArgumentList $Arguments -NoNewWindow -PassThru `
			-RedirectStandardOutput $OutLog -RedirectStandardError "$OutLog.err"
		$proc.EnableRaisingEvents = $true   # 이걸 켜야 ExitCode 가 채워진다
	} catch {
		Write-FinishLog "ERROR  $Label - 시작 실패: $($_.Exception.Message)"
		return 'start-failed'
	}
	$exited = $proc.WaitForExit($TimeoutMinutes * 60 * 1000)
	if (-not $exited) {
		Write-FinishLog "TIMEOUT $Label - ${TimeoutMinutes}분 초과, 강제 종료"
		try { $proc.Kill() } catch {}
		try { $proc.WaitForExit(30000) | Out-Null } catch {}
		return 'timeout'
	}
	try { $proc.WaitForExit() } catch {}
	$code = $proc.ExitCode
	$min = [int]((Get-Date) - $startedAt).TotalMinutes
	Write-FinishLog "END    $Label exit=$code elapsed=${min}min"
	if ($code -eq 0) { return 'ok' }
	return "exit-$code"
}

# PowerShell "..." 안에서는 $1 이 변수로 치환돼 JS 가 깨진다. 단일 인용 here-string 필수.
$SessionCheckJs = @'
const {readFileSync}=require('fs');
for(const l of readFileSync('.env','utf8').split(/\r?\n/)){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim();}
const pg=require('pg');
(async()=>{
  const c=new pg.Client({connectionString:process.env.DATABASE_URL||process.env.DIRECT_URL,ssl:{rejectUnauthorized:false}});
  await c.connect();
  const r=await c.query('select searchadvisor_session_secret_id s from public.naver_searchadvisor_accounts where account_id=$1',[process.argv[1]]);
  await c.end();
  console.log(r.rows[0] && r.rows[0].s ? 'YES' : 'NO');
})().catch(()=>{console.log('NO');process.exit(0)})
'@

function Test-SessionSaved {
	param([string]$AccountId)
	return ((& $Node -e $SessionCheckJs $AccountId 2>$null) -match 'YES')
}

# 세션을 다시 잡지 않는다. 이유:
#
# 네이버가 반복 로그인을 감지하면 "영수증 총액 계산" 같은 추가 인증을 띄운다.
# 이건 사람이 풀어야 해서 무인 실행으로는 통과할 수 없다. 그런데 2026-08-06 밤에
# 단계마다 --force 로 재로그인을 시켰더니, 아무도 인증을 못 풀어 로그인이 실패했고
# 그 실패한 세션이 멀쩡하던 세션을 덮어써 소유확인 1,000건이 통째로 날아갔다.
#
# 그래서 여기서는 저장된 세션을 "쓰기만" 한다. 죽어 있으면 그 계정을 건너뛰고
# 사람이 scripts/capture-naver-session.mjs 로 다시 잡아주면 된다.
function Test-SessionUsable {
	param([string]$AccountId, [int]$AccountOrder, [string]$Phase)
	if (-not (Test-SessionSaved -AccountId $AccountId)) { return 'none' }
	$log = Join-Path $LogDir "finish-$Stamp-sessioncheck-$Phase-$AccountOrder-$AccountId.log"
	$r = Invoke-Step -FilePath $Node -Arguments @('scripts/check-naver-session-alive.mjs', '--account', $AccountId) `
		-OutLog $log -TimeoutMinutes 5 -Label "session[$Phase] 확인 #$AccountOrder $AccountId"
	if ($r -eq 'ok') { return 'ok' }
	return 'dead'
}

function Get-Accounts {
	param([int]$From, [int]$To)
	$raw = & $Node 'scripts/list-naver-accounts-by-order.mjs' '--from' $From '--to' $To
	if ($LASTEXITCODE -ne 0 -or -not $raw) { throw "계정 목록 조회 실패 ($From~$To)" }
	# PS 5.1 의 ConvertFrom-Json 은 배열을 한 덩어리로 흘린다. foreach 로 풀어야 한다.
	$parsed = $raw | ConvertFrom-Json
	$list = @()
	foreach ($row in $parsed) { $list += , $row }
	return $list
}

function Invoke-VerifyAndCrawl {
	param($Accounts, [string]$Phase)
	$out = @()
	foreach ($acc in $Accounts) {
		$id = $acc.accountId; $ord = $acc.accountOrder

		$sess = Test-SessionUsable -AccountId $id -AccountOrder $ord -Phase $Phase
		Write-FinishLog "  세션 #$ord $id -> $sess"
		if ($sess -ne 'ok') {
			# 세션이 죽었으면 사람이 capture-naver-session.mjs 로 다시 잡아야 한다.
			# 여기서 재로그인을 시도하면 추가 인증에 걸려 멀쩡한 세션까지 망가진다.
			$out += "#${ord} ${id}: session=$sess (사람이 재캡처 필요)"
			continue
		}

		$vLog = Join-Path $LogDir "finish-$Stamp-verify-$ord-$id.log"
		$v = Invoke-Step -FilePath $Node -Arguments @('scripts/verify-naver-searchadvisor-sites.mjs', '--account', $id) `
			-OutLog $vLog -TimeoutMinutes $VerifyTimeoutMinutes -Label "verify #$ord $id"

		$env:NAVER_CRAWL_RUNNER_PC = 'siwol-win'
		$env:NAVER_CRAWL_INCLUDE_ACCOUNTS = $id
		$cLog = Join-Path $LogDir "finish-$Stamp-crawl-$ord-$id.log"
		$c = Invoke-Step -FilePath 'powershell.exe' `
			-Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts\run-windows-naver-crawl-resume.ps1') `
			-OutLog $cLog -TimeoutMinutes $CrawlTimeoutMinutes -Label "crawl  #$ord $id"
		Remove-Item Env:\NAVER_CRAWL_INCLUDE_ACCOUNTS -ErrorAction SilentlyContinue

		$out += "#${ord} ${id}: verify=$v crawl=$c"
	}
	return $out
}

# ---------------------------------------------------------------------------

$LockPath = Join-Path $RootDir 'tmp\verify-crawl-chain.lock'
if (-not (Test-Path (Split-Path -Parent $LockPath))) {
	New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LockPath) | Out-Null
}
$lockStream = $null
try {
	$lockStream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch [System.IO.IOException] {
	Write-FinishLog '다른 러너가 이미 돌고 있습니다. 종료합니다.'
	exit 2
}

$summary = @()
try {
	Write-FinishLog "2차 배치 마무리 시작. 준비완료 $VerifyReadyFrom~$VerifyReadyTo / 토큰필요 $NeedTokenFrom~$NeedTokenTo"

	# ---- 1) 준비된 계정 소유확인 + 수집요청 --------------------------------
	Write-FinishLog "===== 1) 계정 $VerifyReadyFrom~$VerifyReadyTo 소유확인 + 수집요청 ====="
	$ready = Get-Accounts -From $VerifyReadyFrom -To $VerifyReadyTo
	$summary += (Invoke-VerifyAndCrawl -Accounts $ready -Phase 'a')

	# ---- 2) 토큰 회수 -------------------------------------------------------
	Write-FinishLog "===== 2) 계정 $NeedTokenFrom~$NeedTokenTo 토큰 회수 ====="
	$need = Get-Accounts -From $NeedTokenFrom -To $NeedTokenTo
	foreach ($acc in $need) {
		$id = $acc.accountId; $ord = $acc.accountOrder
		$sess = Test-SessionUsable -AccountId $id -AccountOrder $ord -Phase 'reg'
		Write-FinishLog "  세션 #$ord $id -> $sess"
		if ($sess -ne 'ok') { $summary += "#${ord} ${id}: session=$sess (사람이 재캡처 필요)"; continue }

		# 사이트는 이미 네이버에 등록돼 있고 DB 의 토큰만 없는 상태다.
		# 소유확인 화면에서 인증키를 다시 읽는 복구 모드로 돈다.
		$env:NAVER_REGISTER_TOKEN_RECOVERY = '1'
		$rLog = Join-Path $LogDir "finish-$Stamp-register-$ord-$id.log"
		$r = Invoke-Step -FilePath $Node -Arguments @('scripts/register-naver-searchadvisor-sites.mjs', '--account', $id) `
			-OutLog $rLog -TimeoutMinutes $RegisterTimeoutMinutes -Label "register #$ord $id"
		Remove-Item Env:\NAVER_REGISTER_TOKEN_RECOVERY -ErrorAction SilentlyContinue
		$summary += "#${ord} ${id}: register=$r"
	}

	# ---- 3) 해당 범위만 재배포 ---------------------------------------------
	# 토큰이 채워졌으니 메타태그를 실제 HTML 에 올린다. 이걸 빼먹으면 4) 가 전부 실패한다.
	Write-FinishLog "===== 3) 계정 $NeedTokenFrom~$NeedTokenTo 빌드·배포 ====="
	$dLog = Join-Path $LogDir "finish-$Stamp-deploy.log"
	$d = Invoke-Step -FilePath $Node `
		-Arguments @('scripts/build-and-deploy-sites.mjs', '--from-order', "$NeedTokenFrom", '--to-order', "$NeedTokenTo") `
		-OutLog $dLog -TimeoutMinutes $DeployTimeoutMinutes -Label "deploy #$NeedTokenFrom~$NeedTokenTo"
	Write-FinishLog "  배포 -> $d"
	$summary += "deploy($NeedTokenFrom~$NeedTokenTo)=$d"

	if ($d -ne 'ok') {
		Write-FinishLog '배포 실패. 메타태그가 없으면 소유확인이 전부 실패하므로 4) 를 건너뜁니다.'
	} else {
		# ---- 4) 나머지 소유확인 + 수집요청 ---------------------------------
		Write-FinishLog "===== 4) 계정 $NeedTokenFrom~$NeedTokenTo 소유확인 + 수집요청 ====="
		$summary += (Invoke-VerifyAndCrawl -Accounts $need -Phase 'b')
	}

	Write-FinishLog '===== 전체 완료 ====='
	foreach ($line in $summary) { Write-FinishLog "  $line" }
} catch {
	Write-FinishLog "중단: $($_.Exception.Message)"
	exit 1
} finally {
	if ($lockStream) { $lockStream.Close() }
	Remove-Item Env:\NAVER_CRAWL_INCLUDE_ACCOUNTS -ErrorAction SilentlyContinue
	Remove-Item Env:\NAVER_REGISTER_TOKEN_RECOVERY -ErrorAction SilentlyContinue
}
