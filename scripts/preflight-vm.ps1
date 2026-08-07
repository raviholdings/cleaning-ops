#Requires -Version 5.1
<#
.SYNOPSIS
  새 VM 이 세션 저장 / 소유확인을 돌릴 준비가 됐는지 한 번에 점검한다.

.DESCRIPTION
  VM 을 늘릴 때마다 같은 곳에서 막혔다. 그래서 실제로 막혔던 항목만 모아
  순서대로 확인한다. 아무것도 바꾸지 않고 읽기만 한다.

    powershell -ExecutionPolicy Bypass -File scripts/preflight-vm.ps1
    powershell -ExecutionPolicy Bypass -File scripts/preflight-vm.ps1 -TestIpChange

  -TestIpChange 를 주면 HaiIP 로 실제 IP 를 한 번 바꿔본다. 이건 외부 상태를
  건드리므로 기본값은 꺼져 있다.

.NOTES
  종료코드 0 = 전부 통과, 1 = 하나라도 실패.
#>
param(
	[switch]$TestIpChange,
	[string]$HaiIpExePath = 'C:\Program Files (x86)\Haionnet\HaiipClientMulti\HaiipClientMulti.exe'
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$results = New-Object System.Collections.ArrayList

function Add-Result {
	param([string]$Name, [bool]$Ok, [string]$Detail, [string]$Fix = '')
	[void]$results.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail; Fix = $Fix })
	$mark = if ($Ok) { '  OK  ' } else { ' FAIL ' }
	Write-Host ("[{0}] {1}" -f $mark, $Name) -ForegroundColor $(if ($Ok) { 'Green' } else { 'Red' })
	if ($Detail) { Write-Host ("         {0}" -f $Detail) -ForegroundColor DarkGray }
	if (-not $Ok -and $Fix) { Write-Host ("         → {0}" -f $Fix) -ForegroundColor Yellow }
}

Write-Host ''
Write-Host '=== VM 준비 상태 점검 ===' -ForegroundColor Cyan
Write-Host ("컴퓨터: {0}   사용자: {1}" -f $env:COMPUTERNAME, $env:USERNAME)
Write-Host ''

# ── 1. 관리자 권한 ────────────────────────────────────────────────
# HaiIP 가 관리자로 떠 있으면, 관리자가 아닌 프로세스는 그 창에 클릭을 못 보낸다.
# Windows 의 UIPI 규칙이라 우회할 방법이 없다.
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Add-Result -Name '관리자 권한으로 실행 중' -Ok $isAdmin `
	-Detail $(if ($isAdmin) { '높은 권한' } else { '일반 권한' }) `
	-Fix 'PowerShell 을 "관리자 권한으로 실행" 으로 다시 열 것. HaiIP 창에 클릭을 못 보낸다.'

# ── 2. curl ──────────────────────────────────────────────────────
# Invoke-WebRequest 가 아니라 curl.exe 를 쓴다. IE 엔진 초기화 문제와
# 프록시 설정을 타지 않아서 공인 IP 조회가 안정적이다.
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
Add-Result -Name 'curl.exe 존재' -Ok ([bool]$curl) `
	-Detail $(if ($curl) { $curl.Source } else { '없음' }) `
	-Fix 'Windows 10 1803 이상이면 기본 포함이다. 없으면 설치할 것.'

# ── 3. 공인 IP 조회 ───────────────────────────────────────────────
$publicIp = ''
if ($curl) {
	try { $publicIp = (& curl.exe -s --max-time 15 'https://api.ipify.org').Trim() } catch { $publicIp = '' }
}
$ipOk = $publicIp -match '^\d{1,3}(\.\d{1,3}){3}$'
Add-Result -Name '공인 IP 조회' -Ok $ipOk `
	-Detail $(if ($ipOk) { $publicIp } else { "응답: '$publicIp'" }) `
	-Fix '방화벽이나 프록시가 api.ipify.org 를 막고 있는지 확인할 것.'

# ── 4. Node / Chrome ─────────────────────────────────────────────
$node = Get-Command node -ErrorAction SilentlyContinue
$nodeVer = if ($node) { (& node -v) } else { '' }
$nodeOk = $nodeVer -match '^v(2[2-9]|[3-9]\d)\.'
Add-Result -Name 'Node 22 이상' -Ok $nodeOk -Detail $nodeVer `
	-Fix 'pageCatalog.ts 같은 .ts 를 직접 import 하므로 22 이상이 필요하다.'

# Playwright 는 번들 크로미움이 아니라 시스템 Chrome 을 쓴다 (channel: chrome).
$chromePaths = @(
	"$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
	"${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
	"$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
Add-Result -Name 'Chrome 설치됨' -Ok ([bool]$chrome) -Detail $chrome `
	-Fix "세션 캡처가 channel:'chrome' 으로 시스템 Chrome 을 띄운다. 번들 크로미움으로는 안 된다."

# ── 5. .env ──────────────────────────────────────────────────────
$envPath = Join-Path $repoRoot '.env'
$envOk = Test-Path $envPath
$envKeys = @()
if ($envOk) {
	$envKeys = (Get-Content $envPath | ForEach-Object {
		if ($_ -match '^([A-Z0-9_]+)=(.+)$') { $Matches[1] }
	})
}
Add-Result -Name '.env 존재' -Ok $envOk -Detail $envPath -Fix 'VM1 에서 필요한 줄만 복사해 올 것.'

foreach ($key in @('DATABASE_URL', 'DIRECT_URL')) {
	Add-Result -Name ".env 에 $key" -Ok ($envKeys -contains $key) `
		-Detail '세션 저장·소유확인 둘 다 필요' -Fix "VM1 의 .env 에서 $key 줄을 복사할 것."
}
Add-Result -Name '.env 에 ANTI_CAPTCHA_API_KEY' -Ok ($envKeys -contains 'ANTI_CAPTCHA_API_KEY') `
	-Detail '소유확인의 보안문자 자동 해독에 필요 (세션 저장만 할 거면 없어도 됨)' `
	-Fix 'VM1 의 .env 에서 ANTI_CAPTCHA_API_KEY 줄을 복사할 것.'

# ── 6. DB 연결 ───────────────────────────────────────────────────
if ($envOk -and ($envKeys -contains 'DATABASE_URL' -or $envKeys -contains 'DIRECT_URL') -and $nodeOk) {
	# node -e 로 넘기면 PowerShell 이 인용부호를 먹어서 스크립트가 깨진다.
	# 임시 파일로 떨어뜨려 실행하고 지운다.
	# 반드시 저장소 안에 둔다. %TEMP% 에 두면 node 가 위로 올라가며 node_modules 를
	# 찾다가 'pg' 를 못 만나 MODULE_NOT_FOUND 로 죽는다.
	$probeDir = Join-Path $repoRoot 'tmp'
	if (-not (Test-Path $probeDir)) { New-Item -ItemType Directory -Path $probeDir -Force | Out-Null }
	$probe = Join-Path $probeDir ('preflight-db-' + [guid]::NewGuid().ToString('N') + '.cjs')
	$probeCode = @(
		"const fs = require('fs');",
		"for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {",
		"  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());",
		"  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();",
		"}",
		"const pg = require('pg');",
		"const url = process.env.DATABASE_URL || process.env.DIRECT_URL;",
		"const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });",
		"c.connect()",
		"  .then(() => c.query('select count(*)::int as n from public.naver_searchadvisor_accounts'))",
		"  .then((r) => { console.log('accounts=' + r.rows[0].n); return c.end(); })",
		"  .catch((e) => { console.log('ERR ' + e.message); process.exit(1); });"
	) -join "`r`n"
	Set-Content -Path $probe -Value $probeCode -Encoding utf8

	Push-Location $repoRoot
	$dbOut = & node $probe 2>&1
	Pop-Location
	Remove-Item $probe -ErrorAction SilentlyContinue
	$dbOk = ($LASTEXITCODE -eq 0) -and ($dbOut -match 'accounts=')
	Add-Result -Name 'DB 연결' -Ok $dbOk -Detail ($dbOut -join ' ') `
		-Fix 'DATABASE_URL 이 맞는지, VM 아이피가 Supabase 에서 막혀 있지 않은지 확인할 것.'
} else {
	Add-Result -Name 'DB 연결' -Ok $false -Detail '앞 단계가 안 돼서 건너뜀' -Fix '위 항목부터 해결할 것.'
}

# ── 7. HaiIP ─────────────────────────────────────────────────────
$haiIpInstalled = Test-Path $HaiIpExePath
Add-Result -Name 'HaiIP 설치됨' -Ok $haiIpInstalled -Detail $HaiIpExePath `
	-Fix 'HaiIP 가 없으면 계정마다 IP 를 바꿀 수 없다. 이 VM 의 IP 하나로 여러 계정을 쓰게 되니 운영자와 상의할 것.'

if ($haiIpInstalled) {
	$proc = Get-Process -Name 'HaiipClientMulti' -ErrorAction SilentlyContinue
	Add-Result -Name 'HaiIP 실행 중' -Ok ([bool]$proc) `
		-Detail $(if ($proc) { "PID $($proc.Id)  창제목: $($proc.MainWindowTitle)" } else { '실행 안 됨' }) `
		-Fix 'HaiIP 를 실행하고 로그인해 둘 것.'

	if ($proc) {
		$hasWindow = $proc.MainWindowHandle -ne 0
		Add-Result -Name 'HaiIP 창 핸들 확보' -Ok $hasWindow `
			-Detail $(if ($hasWindow) { "handle $($proc.MainWindowHandle)" } else { '창이 트레이로 숨어 있음' }) `
			-Fix '트레이 아이콘을 눌러 창을 띄워 둘 것. 최소화는 괜찮지만 완전히 숨으면 클릭을 못 보낸다.'

		# 상태 조회를 실제로 돌려본다. 관리자 권한 불일치는 여기서 드러난다.
		$statusRaw = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
			-File (Join-Path $repoRoot 'scripts/haiip-windows-ui-control.ps1') -Command status 2>&1
		$statusOk = $LASTEXITCODE -eq 0
		$detail = if ($statusOk) {
			try {
				$s = ($statusRaw -join "`n") | ConvertFrom-Json
				"현재 IP $($s.publicIp) / 스크립트 권한상승 $($s.currentProcessElevated)"
			} catch { '상태 조회 성공' }
		} else { ($statusRaw | Select-Object -Last 3) -join ' ' }
		Add-Result -Name 'HaiIP 상태 조회' -Ok $statusOk -Detail $detail `
			-Fix 'HaiIP 가 관리자로 떠 있는데 이 창은 아니면 클릭이 막힌다. 둘의 권한을 맞출 것.'

		if ($TestIpChange -and $statusOk) {
			Write-Host ''
			Write-Host '  IP 전환을 실제로 시도합니다 (최대 2분)...' -ForegroundColor Cyan
			$before = $publicIp
			$changeRaw = & powershell.exe -NoProfile -ExecutionPolicy Bypass `
				-File (Join-Path $repoRoot 'scripts/haiip-windows-ui-control.ps1') `
				-Command change -RequireChanged -WaitSeconds 60 2>&1
			$changeOk = $LASTEXITCODE -eq 0
			$after = ''
			try { $after = (& curl.exe -s --max-time 15 'https://api.ipify.org').Trim() } catch {}
			Add-Result -Name 'HaiIP IP 전환' -Ok ($changeOk -and $after -and $after -ne $before) `
				-Detail "$before -> $after" `
				-Fix (($changeRaw | Select-Object -Last 3) -join ' ')
		}
	}
} else {
	Write-Host '         (HaiIP 가 없으므로 이후 HaiIP 항목은 건너뜁니다)' -ForegroundColor DarkGray
}

# ── 정리 ─────────────────────────────────────────────────────────
$failed = @($results | Where-Object { -not $_.Ok })
Write-Host ''
Write-Host ('통과 {0} / 전체 {1}' -f ($results.Count - $failed.Count), $results.Count) -ForegroundColor Cyan

if ($failed.Count -eq 0) {
	Write-Host '전부 통과. 세션 저장을 시작해도 됩니다:' -ForegroundColor Green
	Write-Host '  node scripts/capture-naver-session.mjs --accounts <시작>-<끝> --no-auto-click' -ForegroundColor Green
	exit 0
}

Write-Host ''
Write-Host '해결해야 할 항목:' -ForegroundColor Yellow
foreach ($f in $failed) { Write-Host ("  - {0}: {1}" -f $f.Name, $f.Fix) -ForegroundColor Yellow }
exit 1
