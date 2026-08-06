param(
	[int]$FromOrder = 11,
	[int]$ToOrder = 20,
	[int]$CrawlBackfillFrom = 1,
	[int]$CrawlBackfillTo = 10,
	[int]$SessionRetries = 6,
	[int]$RegisterTimeoutMinutes = 60,
	[int]$VerifyTimeoutMinutes = 150,
	[int]$CrawlTimeoutMinutes = 90,
	[int]$DeployTimeoutMinutes = 60,
	[switch]$SkipDeploy,
	# 단계를 골라 돌리기 위한 스위치. HTML 수정을 다른 쪽에서 하는 동안
	# 빌드와 무관한 3단계만 먼저 돌리는 식으로 나눠 쓴다.
	[switch]$OnlyBackfill,     # 3단계(기존 계정 잔여 수집요청)만
	[switch]$SkipRegister,     # 1단계 건너뛰기 (토큰 회수가 이미 끝난 경우)
	[switch]$SkipBackfill      # 3단계 건너뛰기
)

if ($OnlyBackfill) {
	$SkipRegister = $true
	$SkipDeploy = $true
	$SkipVerifyStage = $true
}

# 2차 배치(계정 11~20) 전체 파이프라인을 무인으로 끝까지 돌린다.
#
#   1단계  계정별: 세션 캡처 -> 서치어드바이저 사이트 등록(토큰 발급)
#   2단계  전체 빌드·배포 (메타태그 반영)
#   3단계  기존 계정(1~10) 잔여 수집요청 (오늘 할당량을 버리지 않으려 먼저 한다)
#   4단계  계정별: 소유확인 -> 수집요청
#
# HaiIP 는 회선 하나로 공인 IP 를 한 번에 하나만 잡으므로 전부 순차 실행이다.
# 1단계에서 세션 캡처와 사이트 등록을 붙여둔 이유도 같은 IP 를 두 번 잡지 않기 위해서다.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-batch2-full-pipeline.ps1

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
$MainLog = Join-Path $LogDir "batch2-$Stamp.log"

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Write-ChainLog {
	param([string]$Message)
	$line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
	try { Add-Content -Path $MainLog -Value $line -Encoding utf8 } catch {}
	# Write-Output 을 쓰면 호출한 함수의 반환값에 로그가 섞인다.
	Write-Host $line
}

function Invoke-Step {
	param(
		[string]$FilePath,
		[string[]]$Arguments,
		[string]$OutLog,
		[int]$TimeoutMinutes,
		[string]$Label
	)

	$startedAt = Get-Date
	Write-ChainLog "START  $Label"
	try {
		$proc = Start-Process -FilePath $FilePath -ArgumentList $Arguments -NoNewWindow -PassThru `
			-RedirectStandardOutput $OutLog -RedirectStandardError "$OutLog.err"
		# 이걸 켜야 Start-Process -PassThru 객체의 ExitCode 가 채워진다.
		$proc.EnableRaisingEvents = $true
	} catch {
		Write-ChainLog "ERROR  $Label - 프로세스 시작 실패: $($_.Exception.Message)"
		return 'start-failed'
	}

	$exited = $proc.WaitForExit($TimeoutMinutes * 60 * 1000)
	if (-not $exited) {
		Write-ChainLog "TIMEOUT $Label - ${TimeoutMinutes}분 초과로 강제 종료"
		try { $proc.Kill() } catch {}
		try { $proc.WaitForExit(30000) | Out-Null } catch {}
		return 'timeout'
	}
	try { $proc.WaitForExit() } catch {}
	$code = $proc.ExitCode
	$elapsed = [int]((Get-Date) - $startedAt).TotalMinutes
	Write-ChainLog "END    $Label exit=$code elapsed=${elapsed}min"
	if ($code -eq 0) { return 'ok' }
	return "exit-$code"
}

# PowerShell 의 "..." 안에서는 $1 같은 게 변수로 치환돼 JS 가 깨진다.
# 반드시 단일 인용 here-string(@'...'@) 을 쓰고, 계정 ID 는 argv 로 넘긴다.
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
	$out = & $Node -e $SessionCheckJs $AccountId 2>$null
	return ($out -match 'YES')
}

# 네이버 세션은 하루도 못 간다. 2026-08-05 18:41 에 잡은 세션이 이튿날 09:40 에는
# 죽어 있었고, 로그인 화면이 떠서 등록·소유확인이 전부 타임아웃으로 실패했다.
# 그래서 단계에 들어가기 직전마다 --force 로 새로 잡는다.
# HaiIP 가 다른 계정이 쓰는 IP 를 물어오면 스크립트가 스스로 멈추므로 몇 번 재시도한다.
function Get-FreshSession {
	param([string]$AccountId, [int]$AccountOrder, [string]$Phase)
	for ($try = 1; $try -le $SessionRetries; $try++) {
		$log = Join-Path $LogDir "batch2-$Stamp-session-$Phase-$AccountOrder-$AccountId-try$try.log"
		Invoke-Step -FilePath $Node -Arguments @('scripts/capture-naver-session.mjs', '--account', $AccountId, '--force') `
			-OutLog $log -TimeoutMinutes 12 -Label "session[$Phase] #$AccountOrder $AccountId (시도 $try/$SessionRetries)" | Out-Null
		if (Test-SessionSaved -AccountId $AccountId) { return "ok(try$try)" }
		Start-Sleep -Seconds 5
	}
	return 'failed'
}

# 오늘(KST) 해당 계정 범위가 이미 제출한 수집요청 건수. 4단계 대기 여부 판단용.
$QuotaUsedJs = @'
const {readFileSync}=require('fs');
for(const l of readFileSync('.env','utf8').split(/\r?\n/)){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim();}
const pg=require('pg');
(async()=>{
  const c=new pg.Client({connectionString:process.env.DATABASE_URL||process.env.DIRECT_URL,ssl:{rejectUnauthorized:false}});
  await c.connect();
  const r=await c.query(`select count(*)::int n
      from public.naver_searchadvisor_crawl_request_results r
      join public.naver_searchadvisor_accounts a on a.account_id = r.account
     where r.status = 'submitted'
       and (r.requested_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date
       and a.account_order between $1 and $2`, [Number(process.argv[1]), Number(process.argv[2])]);
  await c.end();
  console.log(r.rows[0].n);
})().catch(()=>{console.log('0');process.exit(0)})
'@

# ---------------------------------------------------------------------------

$LockPath = Join-Path $RootDir 'tmp\verify-crawl-chain.lock'
if (-not (Test-Path (Split-Path -Parent $LockPath))) {
	New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LockPath) | Out-Null
}
$lockStream = $null
try {
	$lockStream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch [System.IO.IOException] {
	Write-ChainLog '다른 러너가 이미 돌고 있습니다. 종료합니다.'
	exit 2
}

try {
	Write-ChainLog "2차 배치 파이프라인 시작. 신규 계정 $FromOrder~$ToOrder / 잔여 수집요청 $CrawlBackfillFrom~$CrawlBackfillTo"

	$accountsRaw = & $Node 'scripts/list-naver-accounts-by-order.mjs' '--from' $FromOrder '--to' $ToOrder
	if ($LASTEXITCODE -ne 0 -or -not $accountsRaw) { throw "계정 목록 조회 실패 (exit=$LASTEXITCODE)" }
	# PS 5.1 의 ConvertFrom-Json 은 배열을 한 덩어리로 흘린다. foreach 로 풀어야 한다.
	$parsed = $accountsRaw | ConvertFrom-Json
	$accounts = @()
	foreach ($row in $parsed) { $accounts += , $row }
	Write-ChainLog "신규 대상 계정 $($accounts.Count)개"

	$summary = @()

	# ---- 1단계: 세션 캡처 + 사이트 등록 ------------------------------------
	if ($SkipRegister) { Write-ChainLog '===== 1단계 건너뜀 (-SkipRegister) =====' }
	foreach ($acc in ($(if ($SkipRegister) { @() } else { Write-ChainLog '===== 1단계: 세션 캡처 + 사이트 등록 ====='; $accounts }))) {
		$id = $acc.accountId
		$ord = $acc.accountOrder

		$sessionResult = Get-FreshSession -AccountId $id -AccountOrder $ord -Phase 'reg'
		Write-ChainLog "  세션 #$ord $id -> $sessionResult"
		if ($sessionResult -eq 'failed') {
			$summary += "#${ord} ${id}: session=failed (이후 단계 건너뜀)"
			continue
		}

		# 사이트는 이미 네이버에 등록돼 있고 DB 의 토큰만 잃어버린 상태라서,
		# 소유확인 화면에서 인증키를 다시 읽어오는 복구 모드로 돈다.
		# 신규 사이트를 등록할 때는 이 변수를 켜면 안 된다(등록 없이 토큰만 생긴다).
		$env:NAVER_REGISTER_TOKEN_RECOVERY = '1'
		$regLog = Join-Path $LogDir "batch2-$Stamp-register-$ord-$id.log"
		$regResult = Invoke-Step -FilePath $Node -Arguments @('scripts/register-naver-searchadvisor-sites.mjs', '--account', $id) `
			-OutLog $regLog -TimeoutMinutes $RegisterTimeoutMinutes -Label "register #$ord $id"
		Remove-Item Env:\NAVER_REGISTER_TOKEN_RECOVERY -ErrorAction SilentlyContinue
		$summary += "#${ord} ${id}: session=$sessionResult register=$regResult"
	}

	# ---- 2단계: 빌드 + 배포 -------------------------------------------------
	if (-not $SkipDeploy) {
		Write-ChainLog '===== 2단계: 빌드 + 배포 (메타태그 반영) ====='
		$deployLog = Join-Path $LogDir "batch2-$Stamp-deploy.log"
		$deployResult = Invoke-Step -FilePath $Node -Arguments @('scripts/build-and-deploy-sites.mjs') `
			-OutLog $deployLog -TimeoutMinutes $DeployTimeoutMinutes -Label 'deploy (전체)'
		Write-ChainLog "  배포 -> $deployResult"
		if ($deployResult -ne 'ok') {
			# 메타태그가 안 올라갔으면 소유확인은 전부 실패한다. 여기서 멈추는 게 낫다.
			Write-ChainLog '배포가 실패해 소유확인을 건너뜁니다. 잔여 수집요청은 그대로 진행합니다.'
			$summary += "deploy=$deployResult (소유확인 생략)"
			$skipVerify = $true
		}
	} else {
		Write-ChainLog '===== 2단계: 배포 건너뜀 (-SkipDeploy) ====='
	}

	# ---- 3단계: 기존 계정 잔여 수집요청 ------------------------------------
	if ($SkipBackfill) { Write-ChainLog '===== 3단계 건너뜀 (-SkipBackfill) =====' } else {
	# 소유확인(약 13시간)보다 먼저 돌린다. 할당량은 자정(KST)에 초기화되고
	# 안 쓴 몫은 이월되지 않으므로, 소유확인을 먼저 하면 오늘 몫을 통째로 버리게 된다.
	# (2026-08-05 밤: 할당량이 바닥난 20:53 에 도착해 43,511건 중 5천 건만 들어갔다.)
	# 이미 오늘 몫을 다 쓴 상태라면 넣을 자리가 없으니 그때만 자정을 기다린다.
	$usedToday = [int](& $Node -e $QuotaUsedJs "$CrawlBackfillFrom" "$CrawlBackfillTo" 2>$null)
	$quota = ($CrawlBackfillTo - $CrawlBackfillFrom + 1) * 100 * 50
	Write-ChainLog "기존 계정 오늘 소진량: $usedToday / $quota"
	if ($usedToday -ge ($quota * 0.8)) {
		$midnight = (Get-Date).Date.AddDays(1).AddMinutes(2)
		$waitMin = [int]($midnight - (Get-Date)).TotalMinutes
		Write-ChainLog "할당량이 거의 찼습니다. 초기화(자정)까지 ${waitMin}분 대기합니다."
		while ((Get-Date) -lt $midnight) { Start-Sleep -Seconds 60 }
		Write-ChainLog '자정 지남. 잔여 수집요청을 시작합니다.'
	}

	Write-ChainLog "===== 3단계: 기존 계정 $CrawlBackfillFrom~$CrawlBackfillTo 잔여 수집요청 ====="
	$oldRaw = & $Node 'scripts/list-naver-accounts-by-order.mjs' '--from' $CrawlBackfillFrom '--to' $CrawlBackfillTo
	if ($LASTEXITCODE -eq 0 -and $oldRaw) {
		$oldParsed = $oldRaw | ConvertFrom-Json
		$oldAccounts = @()
		foreach ($row in $oldParsed) { $oldAccounts += , $row }
		foreach ($acc in $oldAccounts) {
			$id = $acc.accountId
			$ord = $acc.accountOrder
			$env:NAVER_CRAWL_RUNNER_PC = 'siwol-win'
			$env:NAVER_CRAWL_INCLUDE_ACCOUNTS = $id
			$crawlLog = Join-Path $LogDir "batch2-$Stamp-backfill-$ord-$id.log"
			$r = Invoke-Step -FilePath 'powershell.exe' `
				-Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts\run-windows-naver-crawl-resume.ps1') `
				-OutLog $crawlLog -TimeoutMinutes $CrawlTimeoutMinutes -Label "backfill crawl #$ord $id"
			Remove-Item Env:\NAVER_CRAWL_INCLUDE_ACCOUNTS -ErrorAction SilentlyContinue
			$summary += "backfill #${ord} ${id}: crawl=$r"
		}
	} else {
		Write-ChainLog '기존 계정 목록 조회 실패 - 잔여 수집요청을 건너뜁니다.'
	}
	}

	# ---- 4단계: 소유확인 + 수집요청 (신규 계정) ----------------------------
	if (-not $skipVerify -and -not $SkipVerifyStage) {
		Write-ChainLog '===== 4단계: 소유확인 + 수집요청 (신규 계정) ====='
		foreach ($acc in $accounts) {
			$id = $acc.accountId
			$ord = $acc.accountOrder

			# 1단계에서 잡은 세션은 여기 올 때쯤이면 이미 죽어 있다. 다시 잡고 들어간다.
			$sess = Get-FreshSession -AccountId $id -AccountOrder $ord -Phase 'vfy'
			Write-ChainLog "  세션[verify] #$ord $id -> $sess"
			if ($sess -eq 'failed') {
				$summary += "#${ord} ${id}: verify=session-failed"
				continue
			}

			$verifyLog = Join-Path $LogDir "batch2-$Stamp-verify-$ord-$id.log"
			$verifyResult = Invoke-Step -FilePath $Node -Arguments @('scripts/verify-naver-searchadvisor-sites.mjs', '--account', $id) `
				-OutLog $verifyLog -TimeoutMinutes $VerifyTimeoutMinutes -Label "verify #$ord $id"

			$env:NAVER_CRAWL_RUNNER_PC = 'siwol-win'
			$env:NAVER_CRAWL_INCLUDE_ACCOUNTS = $id
			$crawlLog = Join-Path $LogDir "batch2-$Stamp-crawl-$ord-$id.log"
			$crawlResult = Invoke-Step -FilePath 'powershell.exe' `
				-Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts\run-windows-naver-crawl-resume.ps1') `
				-OutLog $crawlLog -TimeoutMinutes $CrawlTimeoutMinutes -Label "crawl  #$ord $id"
			Remove-Item Env:\NAVER_CRAWL_INCLUDE_ACCOUNTS -ErrorAction SilentlyContinue

			$summary += "#${ord} ${id}: verify=$verifyResult crawl=$crawlResult"
		}
	}

	Write-ChainLog '===== 전체 완료 ====='
	foreach ($line in $summary) { Write-ChainLog "  $line" }
} catch {
	Write-ChainLog "중단: $($_.Exception.Message)"
	exit 1
} finally {
	if ($lockStream) { $lockStream.Close() }
	Remove-Item Env:\NAVER_CRAWL_INCLUDE_ACCOUNTS -ErrorAction SilentlyContinue
}
