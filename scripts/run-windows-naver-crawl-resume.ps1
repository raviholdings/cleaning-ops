param(
	[switch]$DryRun,
	[switch]$NoHaiIp
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RootDir

$Node = $env:NODE_EXE
if (-not $Node) {
	$Node = 'C:\Program Files\nodejs\node.exe'
}
if (-not (Test-Path $Node)) {
	$Node = 'node'
}

$RunStartedAtDate = Get-Date
$RunStartedAt = $RunStartedAtDate.ToString('yyyyMMdd-HHmmss')
$LogDir = Join-Path $RootDir 'logs'
$ReportDir = Join-Path $RootDir 'reports\naver-site-search'
$RuntimeDir = Join-Path $RootDir 'tmp\naver-crawl-runtime'
$RunScratchDir = Join-Path $RuntimeDir $RunStartedAt
$LockPath = Join-Path $RootDir '.windows-naver-crawl.lock'
$MainLog = Join-Path $LogDir 'windows-naver-crawl-requests.log'
$CommandLogLock = [object]::new()
$LocalLogEnabled = ($env:NAVER_WINDOWS_CRAWL_LOCAL_LOG -ne '0' -and $env:NAVER_CRAWL_LOCAL_LOG -ne '0')
$LocalReportEnabled = ($env:NAVER_CRAWL_LOCAL_REPORT -eq '1')
$InitialCrawlDbUrlSource = $env:NAVER_CRAWL_DB_URL_SOURCE
$InitialWindowsCrawlDbUrlSource = $env:NAVER_WINDOWS_CRAWL_DB_URL_SOURCE
$InitialCrawlExposureStatuses = [Environment]::GetEnvironmentVariable('NAVER_CRAWL_EXPOSURE_STATUSES', 'Process')
$InitialCrawlExposurePriorityEnabled = [Environment]::GetEnvironmentVariable('NAVER_CRAWL_EXPOSURE_PRIORITY_ENABLED', 'Process')
$CrawlUnexposedOnlyProjects = if ($env:NAVER_WINDOWS_CRAWL_UNEXPOSED_ONLY_PROJECTS) {
	$env:NAVER_WINDOWS_CRAWL_UNEXPOSED_ONLY_PROJECTS
} elseif ($env:NAVER_CRAWL_UNEXPOSED_ONLY_PROJECTS) {
	$env:NAVER_CRAWL_UNEXPOSED_ONLY_PROJECTS
} else {
	''
}

$setupDirs = @($RuntimeDir, $RunScratchDir)
if ($LocalLogEnabled) { $setupDirs += $LogDir }
if ($LocalReportEnabled) { $setupDirs += $ReportDir }
New-Item -ItemType Directory -Force -Path $setupDirs | Out-Null

$MaxAccountsPerHaiIpPublicIp = 1
if ($env:HAIIP_MAX_ACCOUNTS_PER_PUBLIC_IP) {
	$MaxAccountsPerHaiIpPublicIp = [Math]::Max(1, [int]$env:HAIIP_MAX_ACCOUNTS_PER_PUBLIC_IP)
}
$script:LastHaiIpMaxAttempts = 0
$script:LastHaiIpLastPublicIp = ''
$script:LastHaiIpLastRejectReason = ''
$script:WindowsCrawlTimeoutWarningSent = $false

$WindowsCrawlExecutionLimitMinutes = 24 * 60
if ($env:NAVER_WINDOWS_CRAWL_EXECUTION_LIMIT_MINUTES) {
	$WindowsCrawlExecutionLimitMinutes = [Math]::Max(0, [int]$env:NAVER_WINDOWS_CRAWL_EXECUTION_LIMIT_MINUTES)
} elseif ($env:NAVER_WINDOWS_CRAWL_EXECUTION_LIMIT_HOURS) {
	$WindowsCrawlExecutionLimitMinutes = [Math]::Max(0, [int]$env:NAVER_WINDOWS_CRAWL_EXECUTION_LIMIT_HOURS) * 60
}
$WindowsCrawlTimeoutWarningLeadMinutes = 60
if ($env:NAVER_WINDOWS_CRAWL_TIMEOUT_WARNING_LEAD_MINUTES) {
	$WindowsCrawlTimeoutWarningLeadMinutes = [Math]::Max(0, [int]$env:NAVER_WINDOWS_CRAWL_TIMEOUT_WARNING_LEAD_MINUTES)
}

function Normalize-RunnerPc {
	param([string]$Value)
	if (-not $Value) { return '' }
	return $Value.Trim().ToLowerInvariant()
}

function Resolve-RunnerPc {
	param([string]$Value)
	$normalized = Normalize-RunnerPc $Value
	switch ($normalized) {
		'desktop-j6uplii' { return 'siwol-win' }
		'desktop-7005n8d' { return 'siwol-win2' }
		'siwol-win' { return 'siwol-win' }
		'siwol-win2' { return 'siwol-win2' }
		default { return $normalized }
	}
}

function Split-EnvList {
	param([string]$Value)
	if (-not $Value) { return @() }
	return @($Value -split ',' | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
}

function Set-CrawlExposureScope {
	param([string]$Project)
	Restore-EnvValue -Name 'NAVER_CRAWL_EXPOSURE_PRIORITY_ENABLED' -Value $InitialCrawlExposurePriorityEnabled

	if ($null -ne $InitialCrawlExposureStatuses) {
		$env:NAVER_CRAWL_EXPOSURE_STATUSES = $InitialCrawlExposureStatuses
	} else {
		$unexposedOnlyProjects = @(Split-EnvList $CrawlUnexposedOnlyProjects)
		$normalizedProject = Normalize-RunnerPc $Project
		if ($unexposedOnlyProjects -contains $normalizedProject) {
			$env:NAVER_CRAWL_EXPOSURE_STATUSES = 'unexposed'
		} else {
			Remove-Item -Path 'Env:NAVER_CRAWL_EXPOSURE_STATUSES' -ErrorAction SilentlyContinue
		}
	}
}

function Get-CrawlDbUrlSource {
	param([string]$Project)

	$defaultCatalogProjects = 'bbungbbung-piping,gosim,recovery-law'
	$catalogProjectConfig = if ($env:NAVER_WINDOWS_CRAWL_CATALOG_PROJECTS) {
		$env:NAVER_WINDOWS_CRAWL_CATALOG_PROJECTS
	} elseif ($env:NAVER_CRAWL_CATALOG_PROJECTS) {
		$env:NAVER_CRAWL_CATALOG_PROJECTS
	} else {
		$defaultCatalogProjects
	}
	$catalogProjects = @(Split-EnvList $catalogProjectConfig)
	$normalizedProject = Normalize-RunnerPc $Project
	if ($catalogProjects -contains $normalizedProject) {
		return 'catalog'
	}

	$defaultSitemapProjects = ''
	$sitemapProjectConfig = if ($env:NAVER_WINDOWS_CRAWL_SITEMAP_PROJECTS) {
		$env:NAVER_WINDOWS_CRAWL_SITEMAP_PROJECTS
	} elseif ($env:NAVER_CRAWL_SITEMAP_ONLY_PROJECTS) {
		$env:NAVER_CRAWL_SITEMAP_ONLY_PROJECTS
	} else {
		$defaultSitemapProjects
	}
	$sitemapProjects = @(Split-EnvList $sitemapProjectConfig)
	if ($sitemapProjects -contains $normalizedProject) {
		return 'sitemap'
	}
	if ($InitialWindowsCrawlDbUrlSource) { return $InitialWindowsCrawlDbUrlSource }
	if ($InitialCrawlDbUrlSource) { return $InitialCrawlDbUrlSource }
	return 'auto'
}

$runnerPcValue = $env:NAVER_WINDOWS_CRAWL_RUNNER_PC
if (-not $runnerPcValue) { $runnerPcValue = $env:NAVER_CRAWL_RUNNER_PC }
if (-not $runnerPcValue) { $runnerPcValue = $env:COMPUTERNAME }
$RunnerPc = Resolve-RunnerPc $runnerPcValue
if (-not $RunnerPc) {
	throw 'Could not determine this Windows crawl runner PC. Set NAVER_WINDOWS_CRAWL_RUNNER_PC to siwol-win or siwol-win2.'
}
$env:NAVER_CRAWL_RUNNER_PC = $RunnerPc

function Write-Log {
	param([string]$Message)
	$line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
	if ($LocalLogEnabled) {
		try {
			Add-Content -Path $MainLog -Value $line
		} catch {
			# Logging must not abort the crawl runner.
		}
	}
	# Write-Output 을 쓰면 이 함수를 부른 함수의 "반환값"에 로그가 섞여 들어간다.
	# 실제로 Get-NaverAccountPreferredIp 가 실패 로그를 그대로 반환해버려,
	# 그 오류 메시지 전문이 -PreferredIp 로 넘어가 HaiIP 검색창에 입력됐다.
	# (2026-08-06) 반드시 Write-Host 로 내보낸다.
	Write-Host $line
}

$script:WindowsCrawlPauseWindows = ''
if ($RunnerPc -eq 'siwol-win2') {
	if ($env:NAVER_WINDOWS_CRAWL_PAUSE_WINDOWS) {
		$script:WindowsCrawlPauseWindows = $env:NAVER_WINDOWS_CRAWL_PAUSE_WINDOWS
	} elseif ($env:NAVER_CRAWL_PAUSE_WINDOWS) {
		$script:WindowsCrawlPauseWindows = $env:NAVER_CRAWL_PAUSE_WINDOWS
	} else {
		$script:WindowsCrawlPauseWindows = '09:40-19:05'
	}

	# The Windows runner waits before HaiIP work, so the child process must not pause mid-account.
	$env:NAVER_CRAWL_PAUSE_WINDOWS = '0'
	Write-Log "Configured siwol-win2 account-boundary pause windows: NAVER_WINDOWS_CRAWL_PAUSE_WINDOWS=$($script:WindowsCrawlPauseWindows)."
}

function Get-ActiveWindowsCrawlPauseWindow {
	param([datetime]$Now = (Get-Date))

	$raw = [string]$script:WindowsCrawlPauseWindows
	$normalized = $raw.Trim().ToLowerInvariant()
	if (-not $normalized -or @('0', 'false', 'off', 'none') -contains $normalized) {
		return $null
	}

	$minuteOfDay = $Now.Hour * 60 + $Now.Minute
	foreach ($item in @($raw -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
		$match = [regex]::Match($item, '^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$')
		if (-not $match.Success) {
			throw "Invalid NAVER_WINDOWS_CRAWL_PAUSE_WINDOWS item: $item"
		}

		$startHour = [int]$match.Groups[1].Value
		$startMinutePart = [int]$match.Groups[2].Value
		$endHour = [int]$match.Groups[3].Value
		$endMinutePart = [int]$match.Groups[4].Value
		if ($startHour -gt 23 -or $endHour -gt 23 -or $startMinutePart -gt 59 -or $endMinutePart -gt 59) {
			throw "Invalid NAVER_WINDOWS_CRAWL_PAUSE_WINDOWS time: $item"
		}

		$startMinute = $startHour * 60 + $startMinutePart
		$endMinute = $endHour * 60 + $endMinutePart
		if ($startMinute -eq $endMinute) {
			throw "Invalid zero-length NAVER_WINDOWS_CRAWL_PAUSE_WINDOWS item: $item"
		}

		$active = $false
		$endAt = $null
		if ($startMinute -lt $endMinute) {
			$active = $minuteOfDay -ge $startMinute -and $minuteOfDay -lt $endMinute
			if ($active) { $endAt = $Now.Date.AddMinutes($endMinute) }
		} elseif ($minuteOfDay -ge $startMinute) {
			$active = $true
			$endAt = $Now.Date.AddDays(1).AddMinutes($endMinute)
		} elseif ($minuteOfDay -lt $endMinute) {
			$active = $true
			$endAt = $Now.Date.AddMinutes($endMinute)
		}

		if ($active) {
			return [pscustomobject]@{
				Label = ('{0:D2}:{1:D2}-{2:D2}:{3:D2}' -f $startHour, $startMinutePart, $endHour, $endMinutePart)
				EndAt = $endAt
			}
		}
	}

	return $null
}

function Wait-WindowsCrawlAccountBoundaryPause {
	param(
		[string]$NextAccount,
		[string]$NextProject
	)

	if ($RunnerPc -ne 'siwol-win2' -or $DryRun) { return }

	while ($true) {
		$activeWindow = Get-ActiveWindowsCrawlPauseWindow
		if (-not $activeWindow) { return }

		Write-Log "Pausing before HaiIP change for $NextAccount/$NextProject. window=$($activeWindow.Label) resumeAt=$($activeWindow.EndAt.ToString('yyyy-MM-dd HH:mm:ss'))."
		while ((Get-Date) -lt $activeWindow.EndAt) {
			$remainingSeconds = [Math]::Max(1, [int][Math]::Ceiling(($activeWindow.EndAt - (Get-Date)).TotalSeconds))
			Start-Sleep -Seconds ([Math]::Min(60, $remainingSeconds))
		}
		Write-Log "Account-boundary pause ended for $NextAccount/$NextProject; HaiIP verification will run next."
	}
}

function Remove-PathQuiet {
	param([string]$Path)
	if ($Path -and (Test-Path $Path)) {
		Remove-Item -Recurse -Force $Path -ErrorAction SilentlyContinue
	}
}

function Write-CommandLogLine {
	param(
		[string]$Line,
		[string]$AccountLog
	)

	if (-not $Line) { return }
	Write-Output $Line
	if (-not $LocalLogEnabled) { return }

	[Threading.Monitor]::Enter($CommandLogLock)
	try {
		try {
			if ($AccountLog) {
				Add-Content -Path $AccountLog -Value $Line
			}
			Add-Content -Path $MainLog -Value $Line
		} catch {
			# Logging must not abort the crawl runner.
		}
	} finally {
		[Threading.Monitor]::Exit($CommandLogLock)
	}
}

function Clear-PersistentLocalSessionState {
	$profilePattern = Join-Path $RootDir '.naver-searchadvisor-profile-*'
	Get-ChildItem -Path $profilePattern -Directory -ErrorAction SilentlyContinue |
		Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

	$legacySessionDir = Join-Path $RootDir 'tmp\naver-login'
	if (Test-Path $legacySessionDir) {
		Get-ChildItem -Path $legacySessionDir -File -Filter '*.storage.json' -ErrorAction SilentlyContinue |
			Where-Object {
				$_.BaseName -like 'ju1wig-*' -or
				$_.BaseName -like 'smpzk80761-*' -or
				$_.BaseName -like 'wlsaud8943-*' -or
				$_.BaseName -like 'world90713-*'
			} |
			Remove-Item -Force -ErrorAction SilentlyContinue
	}
}

function Test-NaverStorageStateHasLoginCookies {
	param([string]$Path)

	if (-not (Test-Path $Path)) { return $false }

	try {
		$state = Get-Content -Path $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
		$cookieNames = @($state.cookies | ForEach-Object { [string]$_.name })
		return ($cookieNames -contains 'NID_AUT') -and ($cookieNames -contains 'NID_SES')
	} catch {
		Write-Log "Could not inspect Search Advisor storage state ${Path}: $($_.Exception.Message)"
		return $false
	}
}

function ConvertTo-ProcessArguments {
	param([string[]]$Arguments)

	return (($Arguments | ForEach-Object {
		$value = [string]$_
		if ($value -notmatch '[\s"]') {
			$value
		} else {
			'"' + ($value -replace '"', '\"') + '"'
		}
	}) -join ' ')
}

function ConvertTo-PowerShellSingleQuotedString {
	param([string]$Value)
	return "'" + ($Value -replace "'", "''") + "'"
}

function Invoke-CapturedCommand {
	param(
		[string]$FilePath,
		[string[]]$Arguments
	)

	$psi = [System.Diagnostics.ProcessStartInfo]::new()
	$psi.FileName = $FilePath
	$psi.Arguments = ConvertTo-ProcessArguments -Arguments $Arguments
	$psi.WorkingDirectory = $RootDir
	$psi.UseShellExecute = $false
	$psi.RedirectStandardOutput = $true
	$psi.RedirectStandardError = $true
	$process = [System.Diagnostics.Process]::Start($psi)
	$stdout = $process.StandardOutput.ReadToEnd()
	$stderr = $process.StandardError.ReadToEnd()
	$process.WaitForExit()

	return [pscustomobject]@{
		exitCode = $process.ExitCode
		stdout = $stdout
		stderr = $stderr
	}
}

function Get-NaverAccountPreferredIp {
	param([string]$Account)

	$script = Join-Path $RootDir 'scripts\get-naver-searchadvisor-account-session-ip.mjs'
	if (-not (Test-Path $script)) { return '' }

	$result = Invoke-CapturedCommand -FilePath $Node -Arguments @(
		$script,
		'--account',
		$Account
	)
	if ($result.exitCode -ne 0) {
		Write-Log ("Preferred IP lookup failed for {0}: {1}" -f $Account, $result.stderr.Trim())
		return ''
	}

	try {
		$json = $result.stdout | ConvertFrom-Json -ErrorAction Stop
		$ip = [string]$json.preferredPublicIp
		if ($ip -match '^\d{1,3}(?:\.\d{1,3}){3}$') { return $ip }
	} catch {
		Write-Log ("Preferred IP lookup returned invalid JSON for {0}: {1}" -f $Account, $_.Exception.Message)
	}
	return ''
}

# 위 함수가 어떤 이유로든 IP 가 아닌 걸 돌려주면 그대로 HaiIP 검색창에 타이핑된다.
# 실제로 오류 메시지 전문이 입력된 적이 있어, 넘기기 직전에 한 번 더 거른다.
function Get-SafePreferredIp {
	param([string]$Account)
	$value = (Get-NaverAccountPreferredIp -Account $Account | Select-Object -Last 1)
	$value = ([string]$value).Trim()
	if ($value -match '^\d{1,3}(?:\.\d{1,3}){3}$') { return $value }
	if ($value) { Write-Log ("Preferred IP 값이 IP 형식이 아니라 무시합니다: {0}" -f $value.Substring(0, [Math]::Min(80, $value.Length))) }
	return ''
}

function Get-NaverSessionIpConflictAccounts {
	param(
		[string]$PublicIp,
		[string]$Account
	)

	if (-not $PublicIp -or $PublicIp -notmatch '^\d{1,3}(?:\.\d{1,3}){3}$') { return @() }

	$script = Join-Path $RootDir 'scripts\get-naver-searchadvisor-account-session-ip.mjs'
	if (-not (Test-Path $script)) {
		throw "Naver session IP lookup script was not found: $script"
	}

	$result = Invoke-CapturedCommand -FilePath $Node -Arguments @(
		$script,
		'--ip',
		$PublicIp,
		'--exclude-account',
		$Account
	)
	if ($result.exitCode -ne 0) {
		throw ("Session IP conflict lookup failed for {0}: {1}" -f $PublicIp, $result.stderr.Trim())
	}

	try {
		$json = $result.stdout | ConvertFrom-Json -ErrorAction Stop
		if (-not $json.accounts) { return @() }
		return @($json.accounts | ForEach-Object { [string]$_.accountId } | Where-Object { $_ })
	} catch {
		throw ("Session IP conflict lookup returned invalid JSON for {0}: {1}" -f $PublicIp, $_.Exception.Message)
	}
}

function Format-AccountList {
	param([string[]]$Accounts)
	return (($Accounts | Where-Object { $_ } | Select-Object -Unique) -join ', ')
}

function Write-HaiIpCommandResult {
	param(
		[pscustomobject]$Result,
		[string]$AccountLog
	)

	if ($Result.stdout) {
		$Result.stdout -split "`r?`n" |
			Where-Object { $_ } |
			ForEach-Object { Write-CommandLogLine -Line "[haiip] $_" -AccountLog $AccountLog }
	}
	if ($Result.stderr) {
		$Result.stderr -split "`r?`n" |
			Where-Object { $_ } |
			ForEach-Object { Write-CommandLogLine -Line "[haiip:stderr] $_" -AccountLog $AccountLog }
	}
}

function Get-HaiIpPublicIpRejectionReason {
	param(
		[string]$PublicIp,
		[string]$Account
	)

	if (-not $PublicIp -or $PublicIp -notmatch '^\d{1,3}(?:\.\d{1,3}){3}$') {
		return 'public IP is empty or invalid'
	}

	$dbConflictAccounts = @(Get-NaverSessionIpConflictAccounts -PublicIp $PublicIp -Account $Account)
	if ($dbConflictAccounts.Count -ge $MaxAccountsPerHaiIpPublicIp) {
		return "public IP is already registered to $($dbConflictAccounts.Count) other account session(s): $(Format-AccountList $dbConflictAccounts)"
	}

	return ''
}

function Invoke-LoggedCommand {
	param(
		[string]$FilePath,
		[string[]]$Arguments,
		[string]$AccountLog,
		[string]$StdoutPrefix = '',
		[string]$StderrPrefix = '[stderr] ',
		[int]$MaxStdoutLines = -1
	)

	$commandId = [Guid]::NewGuid().ToString('N')
	$stdoutPath = Join-Path $RunScratchDir "command-$commandId.stdout.log"
	$stderrPath = Join-Path $RunScratchDir "command-$commandId.stderr.log"
	$argumentList = ConvertTo-ProcessArguments -Arguments $Arguments

	$process = Start-Process `
		-FilePath $FilePath `
		-ArgumentList $argumentList `
		-WorkingDirectory $RootDir `
		-NoNewWindow `
		-Wait `
		-PassThru `
		-RedirectStandardOutput $stdoutPath `
		-RedirectStandardError $stderrPath

	if ((Test-Path $stdoutPath) -and $MaxStdoutLines -ne 0) {
		$stdoutContentArgs = @{
			Path = $stdoutPath
			ErrorAction = 'SilentlyContinue'
		}
		if ($MaxStdoutLines -gt 0) {
			$stdoutContentArgs.TotalCount = $MaxStdoutLines
		}
		Get-Content @stdoutContentArgs |
			Where-Object { $_ } |
			ForEach-Object { Write-CommandLogLine -Line "$StdoutPrefix$_" -AccountLog $AccountLog }
		if ($MaxStdoutLines -gt 0) {
			Write-CommandLogLine -Line "[stdout] output logging capped at $MaxStdoutLines line(s) for $FilePath" -AccountLog $AccountLog
		}
	}
	if (Test-Path $stderrPath) {
		Get-Content -Path $stderrPath -ErrorAction SilentlyContinue |
			Where-Object { $_ } |
			ForEach-Object { Write-CommandLogLine -Line "$StderrPrefix$_" -AccountLog $AccountLog }
	}

	Remove-PathQuiet $stdoutPath
	Remove-PathQuiet $stderrPath

	if ($process.ExitCode -ne 0) {
		throw "Command failed with exit code $($process.ExitCode): $FilePath $($Arguments -join ' ')"
	}
}

function ConvertFrom-UnicodeEscape {
	param([string]$Value)
	return [regex]::Unescape($Value)
}

function Send-WindowsCrawlRunnerAlert {
	param(
		[string]$Account,
		[string]$Project,
		[string]$Stage,
		[string]$ErrorMessage,
		[string]$AccountLog,
		[string]$ReportPath,
		[int]$Attempts = 0,
		[string]$LastPublicIp = '',
		[string]$LastRejectReason = '',
		[int]$RunIndex = 0,
		[int]$TotalRuns = 0,
		[int]$RemainingRuns = 0
	)

	if ($DryRun -or $env:NAVER_CRAWL_ALERT_ENABLED -eq '0') { return }

	$alertScript = Join-Path $RootDir 'scripts\naver-searchadvisor-crawl-alert.mjs'
	if (-not (Test-Path $alertScript)) {
		Write-Log "Skipping crawl runner alert because alert script was not found: $alertScript"
		return
	}

	$attemptText = if ($Attempts -gt 0) { "$Attempts$(ConvertFrom-UnicodeEscape '\uD68C')" } else { '-' }
	$orderText = if ($RunIndex -gt 0 -and $TotalRuns -gt 0) { "$RunIndex / $TotalRuns" } else { '-' }
	$remainingText = if ($RemainingRuns -ge 0) { "$RemainingRuns$(ConvertFrom-UnicodeEscape '\uAC1C')" } else { '-' }
	$stageText = switch ($Stage) {
		'haiip-change' { ConvertFrom-UnicodeEscape 'IP \uBCC0\uACBD' }
		'session-export' { ConvertFrom-UnicodeEscape '\uC138\uC158 \uB0B4\uBCF4\uB0B4\uAE30' }
		'crawl-submit' { ConvertFrom-UnicodeEscape '\uC218\uC9D1\uC694\uCCAD \uC81C\uCD9C' }
		'session-upsert' { ConvertFrom-UnicodeEscape '\uC138\uC158 \uC800\uC7A5' }
		default { $Stage }
	}
	$message = "{0} {1} {2} {3} {4} {5}" -f @(
		$RunnerPc,
		(ConvertFrom-UnicodeEscape '\uB124\uC774\uBC84 \uC218\uC9D1\uC694\uCCAD \uC791\uC5C5\uC5D0\uC11C'),
		$orderText,
		(ConvertFrom-UnicodeEscape '\uACC4\uC815\uC758 IP \uBCC0\uACBD\uC774 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. \uB0A8\uC740 \uACC4\uC815\uC740'),
		$remainingText,
		(ConvertFrom-UnicodeEscape '\uC785\uB2C8\uB2E4.')
	)
	$infoList = @(
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uD504\uB85C\uC81D\uD2B8'); value = $Project },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uC2E4\uD589\uC11C\uBC84'); value = $RunnerPc },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uC791\uC5C5\uC21C\uC11C'); value = $orderText },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uB0A8\uC740\uACC4\uC815'); value = $remainingText },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uC2E4\uD328\uACC4\uC815'); value = $Account },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uB2E8\uACC4'); value = $stageText },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape 'IP\uC7AC\uC2DC\uB3C4'); value = $attemptText },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uB9C8\uC9C0\uB9C9IP'); value = $(if ($LastPublicIp) { $LastPublicIp } else { '-' }) },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uC2E4\uD328\uC0AC\uC720'); value = $(if ($LastRejectReason) { $LastRejectReason } else { $ErrorMessage }) },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uC2E4\uD589ID'); value = $env:NAVER_CRAWL_RUN_ID },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uC2DC\uC791\uC2DC\uAC01'); value = $RunStartedAt },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uB85C\uADF8'); value = $(if ($AccountLog) { $AccountLog } else { 'local logging disabled' }) }
	)
	$infoJson = ConvertTo-Json -InputObject @($infoList) -Compress -Depth 4

	$result = Invoke-CapturedCommand -FilePath $Node -Arguments @(
		'scripts/naver-searchadvisor-crawl-alert.mjs',
		'--operational',
		'--title', (ConvertFrom-UnicodeEscape '\uB124\uC774\uBC84 \uC218\uC9D1\uC694\uCCAD \uC791\uC5C5 \uC2E4\uD328'),
		'--message', $message,
		'--info-json', $infoJson
	)

	if ($result.stdout) {
		$result.stdout -split "`r?`n" |
			Where-Object { $_ } |
			ForEach-Object { Write-CommandLogLine -Line "[crawl-alert] $_" -AccountLog $AccountLog }
	}
	if ($result.stderr) {
		$result.stderr -split "`r?`n" |
			Where-Object { $_ } |
			ForEach-Object { Write-CommandLogLine -Line "[crawl-alert:stderr] $_" -AccountLog $AccountLog }
	}
	if ($result.exitCode -ne 0) {
		Write-Log "Crawl runner alert command failed for $Account/$Project with exit code $($result.exitCode)."
	}
}

function Send-WindowsCrawlTimeoutWarningIfNeeded {
	param(
		[int]$RunIndex,
		[int]$TotalRuns,
		[string]$CurrentAccount,
		[string]$CurrentProject,
		[string]$CurrentGroupKey
	)

	if ($script:WindowsCrawlTimeoutWarningSent) { return }
	if ($DryRun -or $env:NAVER_CRAWL_ALERT_ENABLED -eq '0') { return }
	if ($WindowsCrawlExecutionLimitMinutes -le 0 -or $WindowsCrawlTimeoutWarningLeadMinutes -le 0) { return }

	$elapsedMinutes = [int][Math]::Floor(((Get-Date) - $RunStartedAtDate).TotalMinutes)
	$warningAtMinutes = [Math]::Max(0, $WindowsCrawlExecutionLimitMinutes - $WindowsCrawlTimeoutWarningLeadMinutes)
	if ($elapsedMinutes -lt $warningAtMinutes) { return }

	$script:WindowsCrawlTimeoutWarningSent = $true
	$remainingLimitMinutes = [Math]::Max(0, $WindowsCrawlExecutionLimitMinutes - $elapsedMinutes)
	$remainingRuns = [Math]::Max(0, $TotalRuns - $RunIndex + 1)
	$orderText = if ($RunIndex -gt 0 -and $TotalRuns -gt 0) { "$RunIndex / $TotalRuns" } else { '-' }
	$message = "{0} {1} {2} {3} {4}{5} {6}" -f @(
		$RunnerPc,
		(ConvertFrom-UnicodeEscape '\uB124\uC774\uBC84 \uC218\uC9D1\uC694\uCCAD \uC2E4\uD589\uC774'),
		$elapsedMinutes,
		(ConvertFrom-UnicodeEscape '\uBD84\uC9F8 \uC9C4\uD589 \uC911\uC785\uB2C8\uB2E4. Windows \uC2A4\uCF00\uC904\uB7EC \uC2E4\uD589 \uC81C\uD55C\uAE4C\uC9C0 \uC57D'),
		$remainingLimitMinutes,
		(ConvertFrom-UnicodeEscape '\uBD84'),
		(ConvertFrom-UnicodeEscape '\uB0A8\uC558\uC2B5\uB2C8\uB2E4.')
	)
	$infoList = @(
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uC2E4\uD589\uC11C\uBC84'); value = $RunnerPc },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uC791\uC5C5\uC21C\uC11C'); value = $orderText },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uB0A8\uC740\uACC4\uC815'); value = "$remainingRuns$(ConvertFrom-UnicodeEscape '\uAC1C')" },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uD604\uC7AC\uACC4\uC815'); value = $CurrentAccount },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uD504\uB85C\uC81D\uD2B8'); value = $CurrentProject },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uADF8\uB8F9'); value = $(if ($CurrentGroupKey) { $CurrentGroupKey } else { '-' }) },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uC2DC\uC791\uC2DC\uAC01'); value = $RunStartedAt },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uACBD\uACFC\uBD84'); value = "$elapsedMinutes" },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uC2E4\uD589\uC81C\uD55C\uBD84'); value = "$WindowsCrawlExecutionLimitMinutes" },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uB0A8\uC740\uBD84'); value = "$remainingLimitMinutes" },
		[ordered]@{ label = (ConvertFrom-UnicodeEscape '\uB85C\uADF8'); value = $(if ($LocalLogEnabled) { $MainLog } else { 'local logging disabled' }) }
	)
	$infoJson = ConvertTo-Json -InputObject @($infoList) -Compress -Depth 4

	try {
		$result = Invoke-CapturedCommand -FilePath $Node -Arguments @(
			'scripts/naver-searchadvisor-crawl-alert.mjs',
			'--operational',
			'--title', (ConvertFrom-UnicodeEscape '\uB124\uC774\uBC84 \uC218\uC9D1\uC694\uCCAD \uC2E4\uD589\uC2DC\uAC04 \uACBD\uACE0'),
			'--message', $message,
			'--info-json', $infoJson
		)
		if ($result.stdout) {
			$result.stdout -split "`r?`n" |
				Where-Object { $_ } |
				ForEach-Object { Write-CommandLogLine -Line "[crawl-alert] $_" -AccountLog '' }
		}
		if ($result.stderr) {
			$result.stderr -split "`r?`n" |
				Where-Object { $_ } |
				ForEach-Object { Write-CommandLogLine -Line "[crawl-alert:stderr] $_" -AccountLog '' }
		}
		if ($result.exitCode -ne 0) {
			Write-Log "Crawl timeout warning alert command failed with exit code $($result.exitCode)."
		}
	} catch {
		Write-Log "Crawl timeout warning alert failed: $($_.Exception.Message)"
	}
}

function Get-PublicIp {
	try {
		$url = 'https://api.ipify.org?format=json&_ts=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
		$output = & curl.exe -4 -sS --max-time 10 --no-keepalive `
			-H 'Cache-Control: no-cache' `
			-H 'Pragma: no-cache' `
			-H 'Connection: close' `
			$url
		if ($LASTEXITCODE -ne 0) { return '' }
		$text = ($output -join "`n").Trim()
		if (-not $text) { return '' }
		try {
			$response = $text | ConvertFrom-Json -ErrorAction Stop
			if ($response.ip) { return [string]$response.ip }
		} catch {}
		$match = [regex]::Match($text, '\b\d{1,3}(?:\.\d{1,3}){3}\b')
		if ($match.Success) { return $match.Value }
		return ''
	} catch {
		return ''
	}
}

function Invoke-HaiIpChange {
	param(
		[string]$Account,
		[string]$Project,
		[string]$AccountLog
	)

	# 프록시 모드에서는 계정별 IP 를 프록시가 결정하므로 로컬 IP 를 돌릴 이유가 없다.
	# 이 경우에만 HaiIP 를 건너뛴다. 그 외에는 여전히 필수다.
	$proxyEnabled = $env:NAVER_PROXY_ENABLED -in @('1','true','yes','on') `
		-or $env:BRIGHT_DATA_PROXY_ENABLED -in @('1','true','yes','on')
	if ($proxyEnabled) {
		Write-Log "[proxy] Proxy mode is enabled; skipping HaiIP change for $Account/$Project."
		return [pscustomobject]@{ ok = $true; skipped = $true; reason = 'proxy-mode' }
	}

	if ($NoHaiIp) {
		throw 'HaiIP change is mandatory for this runner; -NoHaiIp is no longer allowed.'
	}

	$customChangeCommand = [bool]$env:HAIIP_CHANGE_COMMAND
	$changeCommand = $env:HAIIP_CHANGE_COMMAND
	$changeArguments = $null
	$preferredChangeArguments = $null
	if (-not $changeCommand) {
		$haiIpScript = Join-Path $RootDir 'scripts\haiip-windows-ui-control.ps1'
		$changeArguments = @(
			$haiIpScript,
			'change',
			'-RequireChanged',
			'-NoAllCheck',
			'-WaitSeconds', '60',
			'-Retries', '2',
			'-ChangeClickMethod', 'BMClick'
		)
	}

	$preferredIp = Get-SafePreferredIp -Account $Account
	if ($preferredIp) {
		$preferredConflictAccounts = @(Get-NaverSessionIpConflictAccounts -PublicIp $preferredIp -Account $Account)
		if ($preferredConflictAccounts.Count -ge $MaxAccountsPerHaiIpPublicIp) {
			Write-Log "Preferred IP $preferredIp for $Account is already registered to $($preferredConflictAccounts.Count) other account session(s): $(Format-AccountList $preferredConflictAccounts); using fallback change."
			$preferredIp = ''
		} elseif ($preferredConflictAccounts.Count -gt 0) {
			Write-Log "Preferred IP $preferredIp for $Account is shared with $(Format-AccountList $preferredConflictAccounts); allowing because HAIIP_MAX_ACCOUNTS_PER_PUBLIC_IP=$MaxAccountsPerHaiIpPublicIp."
		} elseif ($customChangeCommand) {
			Write-Log "Preferred IP $preferredIp for $Account is available, but HAIIP_CHANGE_COMMAND is custom; preferred routing is skipped."
			$preferredIp = ''
		} else {
			Write-Log ("Preferred IP for {0}: {1}" -f $Account, $preferredIp)
			$preferredChangeArguments = $changeArguments + @('-PreferredIp', $preferredIp, '-PreferredWaitSeconds', '25', '-PreferredActivationRetries', '3')
		}
	}
	if (-not $preferredIp) {
		Write-Log "No reusable preferred IP for $Account; using random HaiIP change with DB duplicate check."
	}

	$maxIpAttempts = 10
	if ($env:HAIIP_SESSION_IP_ATTEMPTS) {
		$maxIpAttempts = [Math]::Max(1, [int]$env:HAIIP_SESSION_IP_ATTEMPTS)
	}
	$script:LastHaiIpMaxAttempts = $maxIpAttempts
	$script:LastHaiIpLastPublicIp = ''
	$script:LastHaiIpLastRejectReason = ''

	for ($attempt = 1; $attempt -le $maxIpAttempts; $attempt += 1) {
		Write-Log "Running HaiIP change command before $Account/$Project. attempt=$attempt/$maxIpAttempts"
		$beforeIp = Get-PublicIp
		if (-not $beforeIp) {
			if ($attempt -lt $maxIpAttempts) {
				Write-Log "Public IP before change could not be verified; retrying HaiIP change."
				continue
			}
			throw "Public IP before HaiIP change could not be verified."
		}
		Write-Log "Public IP before change: $beforeIp"

		if ($preferredIp -and $beforeIp -eq $preferredIp) {
			Write-Log ("Public IP is already on preferred IP for {0}: {1}; skipping HaiIP click." -f $Account, $beforeIp)
			return
		}

		$attemptUsesPreferred = [bool]($preferredIp -and $preferredChangeArguments)
		$attemptChangeArguments = $(if ($attemptUsesPreferred) { $preferredChangeArguments } else { $changeArguments })
		$haiIpPowerShellArgs = @(
			'-NoProfile',
			'-ExecutionPolicy',
			'Bypass'
		)
		if ($customChangeCommand) {
			$haiIpPowerShellArgs += @('-Command', $changeCommand)
		} else {
			$haiIpPowerShellArgs += @('-File') + $attemptChangeArguments
		}

		$haiIpResult = Invoke-CapturedCommand -FilePath 'powershell.exe' -Arguments $haiIpPowerShellArgs
		Write-HaiIpCommandResult -Result $haiIpResult -AccountLog $AccountLog
		if ($haiIpResult.exitCode -ne 0 -and $attemptUsesPreferred) {
			Start-Sleep -Seconds 3
			$afterPreferredIp = Get-PublicIp
			if ($afterPreferredIp -and $afterPreferredIp -ne $beforeIp) {
				$preferredFallbackRejectReason = Get-HaiIpPublicIpRejectionReason -PublicIp $afterPreferredIp -Account $Account
				if (-not $preferredFallbackRejectReason) {
					Write-Log "Preferred IP $preferredIp for $Account was not reached, but HaiIP changed to usable fallback IP $afterPreferredIp."
					return
				}
				Write-Log ("Preferred IP {0} for {1} changed to unusable fallback IP {2}: {3}" -f $preferredIp, $Account, $afterPreferredIp, $preferredFallbackRejectReason)
			}
			Write-Log "Preferred IP $preferredIp for $Account was not reached; falling back to random HaiIP change."
			$preferredIp = ''
			$haiIpPowerShellArgs = @(
				'-NoProfile',
				'-ExecutionPolicy',
				'Bypass'
			)
			$haiIpPowerShellArgs += @('-File') + $changeArguments
			$haiIpResult = Invoke-CapturedCommand -FilePath 'powershell.exe' -Arguments $haiIpPowerShellArgs
			Write-HaiIpCommandResult -Result $haiIpResult -AccountLog $AccountLog
		}
		if ($haiIpResult.exitCode -ne 0) {
			$script:LastHaiIpLastRejectReason = "HaiIP change command failed with exit code $($haiIpResult.exitCode)"
			if ($attempt -lt $maxIpAttempts) {
				Write-Log "$($script:LastHaiIpLastRejectReason); retrying HaiIP change."
				continue
			}
			throw "HaiIP change command failed with exit code $($haiIpResult.exitCode)."
		}

		Start-Sleep -Seconds 5
		$afterIp = Get-PublicIp
		$script:LastHaiIpLastPublicIp = $afterIp
		if (-not $afterIp) {
			if ($attempt -lt $maxIpAttempts) {
				Write-Log "Public IP after change could not be verified; retrying HaiIP change."
				continue
			}
			$script:LastHaiIpLastRejectReason = 'public IP after HaiIP change could not be verified'
			throw "Public IP after HaiIP change could not be verified."
		}

		Write-Log "Public IP after change: $afterIp"
		if ($afterIp -eq $beforeIp) {
			if ($preferredIp -and $afterIp -eq $preferredIp) {
				Write-Log ("Public IP is already on preferred IP for {0}: {1}" -f $Account, $afterIp)
				return
			}
			if ($attempt -lt $maxIpAttempts) {
				Write-Log "Public IP did not change from $beforeIp; retrying HaiIP change."
				continue
			}
			$script:LastHaiIpLastRejectReason = "public IP did not change from $beforeIp"
			throw "HaiIP change command completed, but public IP did not change from $beforeIp."
		}

		$rejectReason = Get-HaiIpPublicIpRejectionReason -PublicIp $afterIp -Account $Account
		$script:LastHaiIpLastRejectReason = $rejectReason
		if ($rejectReason) {
			if ($attempt -lt $maxIpAttempts) {
				Write-Log ("Public IP {0} is not usable for {1}: {2}; retrying HaiIP change." -f $afterIp, $Account, $rejectReason)
				continue
			}
			throw "HaiIP changed to an unusable public IP for ${Account}: $afterIp ($rejectReason)"
		}

		return
	}
}

function Get-DbCrawlRuns {
	$script = Join-Path $RootDir 'scripts\list-naver-crawl-runs.mjs'
	if (-not (Test-Path $script)) {
		throw "DB crawl run list script was not found: $script"
	}

	try {
		$result = Invoke-CapturedCommand -FilePath $Node -Arguments @($script)
		if ($result.exitCode -ne 0) {
			throw ("DB crawl run lookup failed: {0}" -f $result.stderr.Trim())
		}
		$parsed = $result.stdout | ConvertFrom-Json -ErrorAction Stop
		$runs = @()
		foreach ($row in @($parsed)) {
			$account = [string]$row.Account
			$project = [string]$row.Project
			if (-not $account -or -not $project) { continue }
			$runs += @{
				Account = $account
				Project = $project
				GroupKey = [string]$row.GroupKey
				RunnerPc = [string]$row.RunnerPc
				DomainCount = [int]$row.DomainCount
				PageCount = [int]$row.PageCount
			}
		}
		return $runs
	} catch {
		throw "DB crawl run lookup returned invalid data: $($_.Exception.Message)"
	}
}

function Restore-EnvValue {
	param(
		[string]$Name,
		[AllowNull()][string]$Value
	)

	if ($null -eq $Value) {
		Remove-Item -Path "Env:$Name" -ErrorAction SilentlyContinue
		return
	}
	Set-Item -Path "Env:$Name" -Value $Value
}

function Invoke-CrawlStaleRunRepair {
	param(
		[string]$Account,
		[string]$Project,
		[string]$AccountLog
	)

	if ($env:NAVER_WINDOWS_CRAWL_REPAIR_STALE_RUNS -eq '0') {
		return
	}

	$script = Join-Path $RootDir 'scripts\repair-naver-crawl-stale-runs.mjs'
	if (-not (Test-Path $script)) {
		Write-Log "Skipping stale crawl run repair because script was not found: $script"
		return
	}

	$olderThanMinutes = if ($env:NAVER_WINDOWS_CRAWL_STALE_RUN_MINUTES) {
		[Math]::Max(1, [int]$env:NAVER_WINDOWS_CRAWL_STALE_RUN_MINUTES)
	} elseif ($env:NAVER_CRAWL_STALE_RUN_MINUTES) {
		[Math]::Max(1, [int]$env:NAVER_CRAWL_STALE_RUN_MINUTES)
	} else {
		15
	}

	try {
		$result = Invoke-CapturedCommand -FilePath $Node -Arguments @(
			$script,
			'--account', $Account,
			'--project', $Project,
			'--older-than-minutes', "$olderThanMinutes"
		)
		if ($result.stdout) {
			$result.stdout -split "`r?`n" |
				Where-Object { $_ } |
				ForEach-Object { Write-CommandLogLine -Line "[stale-repair] $_" -AccountLog $AccountLog }
		}
		if ($result.stderr) {
			$result.stderr -split "`r?`n" |
				Where-Object { $_ } |
				ForEach-Object { Write-CommandLogLine -Line "[stale-repair:stderr] $_" -AccountLog $AccountLog }
		}
		if ($result.exitCode -ne 0) {
			Write-Log "Stale crawl run repair failed for $Account/$Project with exit code $($result.exitCode); continuing normal run."
		}
	} catch {
		Write-Log "Stale crawl run repair failed for ${Account}/${Project}: $($_.Exception.Message); continuing normal run."
	}
}

function Test-CrawlFastSkip {
	param(
		[string]$Account,
		[string]$Project
	)

	if ($env:NAVER_WINDOWS_CRAWL_FAST_SKIP -eq '0') {
		return [pscustomobject]@{ Skip = $false; Message = 'fast skip disabled' }
	}

	try {
		$previousNodeOptions = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process')
		$env:NODE_OPTIONS = [string]::Join(' ', @(($previousNodeOptions, '--no-warnings') | Where-Object { $_ }))
		try {
			$output = & $Node 'scripts/check-naver-crawl-pending-fast.mjs' '--account' $Account '--project' $Project 2>$null
		} finally {
			Restore-EnvValue -Name 'NODE_OPTIONS' -Value $previousNodeOptions
		}
		if ($LASTEXITCODE -ne 0 -or -not $output) {
			return [pscustomobject]@{ Skip = $false; Message = "Fast skip check did not return a usable result for $Account/$Project; continuing normal run." }
		}

		$jsonLine = @($output | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1)
		if (-not $jsonLine) {
			return [pscustomobject]@{ Skip = $false; Message = "Fast skip check returned no JSON for $Account/$Project; continuing normal run." }
		}

		$result = $jsonLine | ConvertFrom-Json
		if ($result.skip -eq $true) {
			return [pscustomobject]@{
				Skip = $true
				Message = "Skipping $Account/$Project before HaiIP change because DB shows no pending crawl targets. latestRun=$($result.latestRunId) next=$($result.latestNextIndex)/$($result.latestTotalTasks) domains=$($result.domainCount)"
			}
		}

		return [pscustomobject]@{ Skip = $false; Message = '' }
	} catch {
		return [pscustomobject]@{ Skip = $false; Message = "Fast skip check failed for ${Account}/${Project}: $($_.Exception.Message); continuing normal run." }
	}
}

$lockStream = $null
try {
	$lockStream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch [System.IO.IOException] {
	Write-Log 'Another Windows Naver crawl runner is already active; exiting.'
	exit 2
}

try {
	Write-Log "Windows Naver crawl runner started. dryRun=$DryRun runnerPc=$RunnerPc root=$RootDir scratch=$RunScratchDir"
	$dbRuns = @(Get-DbCrawlRuns)
	if ($dbRuns.Count -le 0) {
		throw "DB crawl run lookup returned no runnable accounts for runnerPc=$RunnerPc."
	}
	$Runs = $dbRuns
	Write-Log "Loaded Windows crawl runs from DB: count=$($Runs.Count) runnerPc=$RunnerPc."
	Clear-PersistentLocalSessionState

	$totalRuns = $Runs.Count
	$runIndex = 0
	foreach ($run in $Runs) {
		$runIndex += 1
		$remainingRuns = [Math]::Max(0, $totalRuns - $runIndex)
		$account = $run.Account
		$project = $run.Project
		$groupKey = if ($run.GroupKey) { $run.GroupKey } else { $project }
		$safeProject = $project -replace '[^A-Za-z0-9_.-]', '-'
		$slug = "$account-$safeProject"
		$runId = "windows-$slug-$RunStartedAt"
		$accountLog = if ($LocalLogEnabled) { Join-Path $LogDir "windows-naver-crawl-$slug.log" } else { '' }
		$storageState = Join-Path $RunScratchDir "$slug.storage.json"
		$profileDir = Join-Path $RunScratchDir "profile-$slug"
		$reportPath = Join-Path $ReportDir "$runId-report.json"
		$stage = 'not-started'

		$env:NAVER_CRAWL_ACCOUNT_ID = $account
		$env:NAVER_CRAWL_TARGET_PROJECT = $project
		$env:NAVER_CRAWL_QUEUE_SOURCE = 'db'
		$env:NAVER_CRAWL_DB_URL_SOURCE = Get-CrawlDbUrlSource -Project $project
		Set-CrawlExposureScope -Project $project
		$env:NAVER_CRAWL_REPORT = $reportPath
		$env:NAVER_CRAWL_LOCAL_REPORT = $(if ($LocalReportEnabled) { '1' } else { '0' })
		$env:NAVER_CRAWL_TRIGGER = 'windows-scheduled-task'
		$env:NAVER_CRAWL_RUN_ID = $runId

		Send-WindowsCrawlTimeoutWarningIfNeeded `
			-RunIndex $runIndex `
			-TotalRuns $totalRuns `
			-CurrentAccount $account `
			-CurrentProject $project `
			-CurrentGroupKey $groupKey

		$exposureScope = if ($env:NAVER_CRAWL_EXPOSURE_STATUSES) { $env:NAVER_CRAWL_EXPOSURE_STATUSES } else { 'all' }
		$exposurePriorityPolicy = if ($exposureScope -ne 'all') {
			'strict-exposure-statuses'
		} elseif ($null -ne $InitialCrawlExposurePriorityEnabled) {
			"environment-override:$InitialCrawlExposurePriorityEnabled"
		} else {
			'database'
		}
		Write-Log "Starting $account/$project. runId=$runId dbUrlSource=$($env:NAVER_CRAWL_DB_URL_SOURCE) exposurePriorityPolicy=$exposurePriorityPolicy exposureScope=$exposureScope."
		try {
			if (-not $DryRun) {
				Invoke-CrawlStaleRunRepair -Account $account -Project $project -AccountLog $accountLog
				$fastSkip = Test-CrawlFastSkip -Account $account -Project $project
				if ($fastSkip.Message) {
					Write-Log $fastSkip.Message
				}
				if ($fastSkip.Skip -eq $true) {
					continue
				}
			}

			Wait-WindowsCrawlAccountBoundaryPause -NextAccount $account -NextProject $project

			$stage = 'haiip-change'
			Invoke-HaiIpChange -Account $account -Project $project -AccountLog $accountLog
			Write-Log "HaiIP change verified for $account/$project."

			$stage = 'session-export'
			Write-Log "Exporting stored Search Advisor session for $account/$project to $storageState."
			Invoke-LoggedCommand -FilePath $Node -Arguments @(
				'scripts/export-naver-searchadvisor-session.mjs',
				'--account', $account,
				'--output', $storageState
			) -AccountLog $accountLog
			Write-Log "Exported stored Search Advisor session for $account/$project."

			$env:NAVER_CRAWL_USER_DATA_DIR = $profileDir
			$env:NAVER_CRAWL_STORAGE_STATE = $storageState
			$env:NAVER_CRAWL_HEADLESS = '1'
			$env:NAVER_CRAWL_WAIT_FOR_LOGIN = '0'
			$env:NAVER_CRAWL_AUTO_LOGIN = '0'
			$env:NAVER_CRAWL_BROWSER_CHANNEL = 'chrome'
			$env:NAVER_CRAWL_CONCURRENCY = $(if ($env:NAVER_WINDOWS_CRAWL_CONCURRENCY) { $env:NAVER_WINDOWS_CRAWL_CONCURRENCY } else { '14' })
			$env:NAVER_CRAWL_MAX_CONCURRENCY = $(if ($env:NAVER_WINDOWS_CRAWL_MAX_CONCURRENCY) { $env:NAVER_WINDOWS_CRAWL_MAX_CONCURRENCY } else { '14' })
			$env:NAVER_CRAWL_DB_QUEUE_ORDER = $(if ($env:NAVER_WINDOWS_CRAWL_DB_QUEUE_ORDER) { $env:NAVER_WINDOWS_CRAWL_DB_QUEUE_ORDER } else { 'round-robin' })
			$env:NAVER_CRAWL_FORCE_SEQUENTIAL = '0'
			$env:NAVER_CRAWL_REQUIRE_IP_ROTATION = '1'
			$env:NAVER_CRAWL_LOOP = $(if ($env:NAVER_WINDOWS_CRAWL_LOOP) { $env:NAVER_WINDOWS_CRAWL_LOOP } else { '1' })
			$env:NAVER_CRAWL_RECORD_DB = $(if ($DryRun) { '0' } else { '1' })
			$env:NAVER_CRAWL_BATCH_SIZE = $(if ($env:NAVER_WINDOWS_CRAWL_BATCH_SIZE) { $env:NAVER_WINDOWS_CRAWL_BATCH_SIZE } else { '0' })
			$env:NAVER_CRAWL_NAV_DELAY_MS = $(if ($env:NAVER_WINDOWS_CRAWL_NAV_DELAY_MS) { $env:NAVER_WINDOWS_CRAWL_NAV_DELAY_MS } else { '1000' })
			$env:NAVER_CRAWL_BATCH_DELAY_MS = $(if ($env:NAVER_WINDOWS_CRAWL_BATCH_DELAY_MS) { $env:NAVER_WINDOWS_CRAWL_BATCH_DELAY_MS } else { '30000' })

			if (-not $DryRun -and (Test-Path $reportPath)) {
				Write-Log "Removing local crawl report before $account/$project; DB completed URLs are the resume source."
				Remove-Item -Force $reportPath -ErrorAction SilentlyContinue
				Remove-Item -Force "${reportPath}.tmp" -ErrorAction SilentlyContinue
			}

			$crawlArgs = @('scripts/submit-naver-searchadvisor-crawl-requests.mjs')
			if ($DryRun) {
				$crawlArgs += '--dry-run'
			}
			$reportLabel = if ($LocalReportEnabled) { $reportPath } else { 'db-only' }
			Write-Log "Starting Naver crawl request submit for $account/$project; report=$reportLabel."
			$stage = 'crawl-submit'
			$crawlStdoutLines = 300
			if ($env:NAVER_WINDOWS_CRAWL_STDOUT_LOG_LINES) {
				$crawlStdoutLines = [int]$env:NAVER_WINDOWS_CRAWL_STDOUT_LOG_LINES
			}
			Invoke-LoggedCommand -FilePath $Node -Arguments $crawlArgs -AccountLog $accountLog -MaxStdoutLines $crawlStdoutLines
			Write-Log "Completed Naver crawl request submit for $account/$project."

			if (-not $DryRun -and (Test-Path $storageState) -and (Test-NaverStorageStateHasLoginCookies -Path $storageState)) {
				$stage = 'session-upsert'
				$currentIp = Get-PublicIp
				$upsertArgs = @(
					'scripts/upsert-naver-searchadvisor-session.mjs',
					'--account', $account,
					'--storage-state', $storageState,
					'--status', 'valid',
					'--note', "windows crawl refresh $RunStartedAt"
				)
				if ($currentIp) {
					$upsertArgs += @('--validated-ip', $currentIp)
				}
				Write-Log "Updating stored Search Advisor session for $account/$project with validated IP $currentIp."
				Invoke-LoggedCommand -FilePath $Node -Arguments $upsertArgs -AccountLog $accountLog
				Write-Log "Updated stored Search Advisor session for $account/$project."
			} elseif (-not $DryRun -and (Test-Path $storageState)) {
				Write-Log "Skipping Search Advisor session update for $account/$project because storage state is missing NID_AUT/NID_SES login cookies."
			}

			Write-Log "Finished $account/$project."
		} catch {
			$errorMessage = $_.Exception.Message
			Write-Log "Failed ${account}/${project}: $errorMessage"
			if ($stage -eq 'haiip-change') {
				Send-WindowsCrawlRunnerAlert `
					-Account $account `
					-Project $project `
					-Stage $stage `
					-ErrorMessage $errorMessage `
					-AccountLog $accountLog `
					-ReportPath $reportPath `
					-Attempts $script:LastHaiIpMaxAttempts `
					-LastPublicIp $script:LastHaiIpLastPublicIp `
					-LastRejectReason $script:LastHaiIpLastRejectReason `
					-RunIndex $runIndex `
					-TotalRuns $totalRuns `
					-RemainingRuns $remainingRuns
			}
		} finally {
			Remove-PathQuiet $profileDir
			Remove-PathQuiet $storageState
		}

	}

	Remove-PathQuiet $RunScratchDir

	# 응답 원문 로그를 R2 로 올린다 (지난 날짜 분만. 실패해도 수집요청과 무관 —
	# 스크립트가 항상 exit 0 이고 경고는 stdout 으로만 낸다).
	try {
		$rawLogOutput = & node (Join-Path $PSScriptRoot 'upload-crawl-raw-logs.mjs')
		foreach ($rawLogLine in @($rawLogOutput)) {
			if ($rawLogLine) { Write-Log "raw-log: $rawLogLine" }
		}
	} catch {
		Write-Log "raw-log upload skipped: $($_.Exception.Message)"
	}

	Write-Log 'Windows Naver crawl runner finished.'
} catch {
	Write-Log "Windows Naver crawl runner failed: $($_.Exception.GetType().FullName): $($_.Exception.Message)"
	exit 1
} finally {
	Remove-PathQuiet $RunScratchDir
	if ($lockStream) {
		$lockStream.Dispose()
	}
}
