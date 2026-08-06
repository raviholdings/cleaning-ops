param(
	[ValidateSet('status', 'change')]
	[string]$Command = 'status',
	[int]$WaitSeconds = 60,
	[int]$Retries = 3,
	[switch]$RequireChanged,
	[switch]$NoAllCheck,
	[int]$AllCheckOffsetX = 6,
	[int]$AllCheckOffsetY = 6,
	[int]$ChangeIpOffsetX = -1,
	[int]$ChangeIpOffsetY = -1,
	[ValidateSet('Input', 'WMCommand', 'BMClick')]
	[string]$ChangeClickMethod = 'BMClick',
	[int]$WindowWaitSeconds = 90,
	[switch]$NoAutoStart,
	[string]$PreferredIp = '',
	[int]$PreferredWaitSeconds = 25,
	[int]$PreferredActivationRetries = 2,
	[switch]$CheckPreferredResult,
	[string]$HaiIpExePath = 'C:\Program Files (x86)\Haionnet\HaiipClientMulti\HaiipClientMulti.exe',
	[string]$PublicIpUrl = 'https://api.ipify.org?format=json',
	[string]$LogPath = 'reports/haiip-windows-ip-changes.jsonl'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class HaiIpWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public int type;
    public MOUSEINPUT mi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct TOKEN_ELEVATION {
    public int TokenIsElevated;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct LVITEM32 {
    public UInt32 mask;
    public Int32 iItem;
    public Int32 iSubItem;
    public UInt32 state;
    public UInt32 stateMask;
    public UInt32 pszText;
    public Int32 cchTextMax;
    public Int32 iImage;
    public UInt32 lParam;
    public Int32 iIndent;
    public Int32 iGroupId;
    public UInt32 cColumns;
    public UInt32 puColumns;
    public UInt32 piColFmt;
    public Int32 iGroup;
  }

  public enum TOKEN_INFORMATION_CLASS {
    TokenUser = 1,
    TokenGroups,
    TokenPrivileges,
    TokenOwner,
    TokenPrimaryGroup,
    TokenDefaultDacl,
    TokenSource,
    TokenType,
    TokenImpersonationLevel,
    TokenStatistics,
    TokenRestrictedSids,
    TokenSessionId,
    TokenGroupsAndPrivileges,
    TokenSessionReference,
    TokenSandBoxInert,
    TokenAuditPolicy,
    TokenOrigin,
    TokenElevationType,
    TokenLinkedToken,
    TokenElevation
  }

  public const UInt32 PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  public const UInt32 TOKEN_QUERY = 0x0008;

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hDlg, int nIDDlgItem);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT Point);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr hWnd, UInt32 Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr hWnd, UInt32 Msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, UInt32 Msg, IntPtr wParam, IntPtr lParam, UInt32 fuFlags, UInt32 uTimeout, out IntPtr lpdwResult);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeout", CharSet=CharSet.Auto, SetLastError=true)] public static extern IntPtr SendMessageTimeoutString(IntPtr hWnd, UInt32 Msg, IntPtr wParam, string lParam, UInt32 fuFlags, UInt32 uTimeout, out IntPtr lpdwResult);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hWnd, UInt32 Msg, IntPtr wParam, IntPtr lParam);

  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(UInt32 dwDesiredAccess, bool bInheritHandle, UInt32 dwProcessId);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr VirtualAllocEx(IntPtr hProcess, IntPtr lpAddress, UIntPtr dwSize, UInt32 flAllocationType, UInt32 flProtect);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool VirtualFreeEx(IntPtr hProcess, IntPtr lpAddress, UIntPtr dwSize, UInt32 dwFreeType);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool WriteProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, ref RECT lpBuffer, UIntPtr nSize, out UIntPtr lpNumberOfBytesWritten);
  [DllImport("kernel32.dll", EntryPoint="WriteProcessMemory", SetLastError=true)] public static extern bool WriteProcessMemoryLvItem32(IntPtr hProcess, IntPtr lpBaseAddress, ref LVITEM32 lpBuffer, UIntPtr nSize, out UIntPtr lpNumberOfBytesWritten);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, out RECT lpBuffer, UIntPtr nSize, out UIntPtr lpNumberOfBytesRead);
  [DllImport("kernel32.dll", EntryPoint="ReadProcessMemory", SetLastError=true)] public static extern bool ReadProcessMemoryBytes(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, UIntPtr nSize, out UIntPtr lpNumberOfBytesRead);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr ProcessHandle, UInt32 DesiredAccess, out IntPtr TokenHandle);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr TokenHandle, TOKEN_INFORMATION_CLASS TokenInformationClass, IntPtr TokenInformation, UInt32 TokenInformationLength, out UInt32 ReturnLength);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr hObject);
}
'@
try { Add-Type -AssemblyName System.Windows.Forms } catch {}

$ControlIds = @{
	ChangeIp = 1098
	CurrentIp = 1092
	ConnectTime = 1093
	StatusText = 1096
	AllCheck = 1099
	AutoChange = 1075
	ListView = 1074
	SearchText = 1188
	SearchButton = 1187
	ResetSearch = 1101
}

$DefaultMessageTimeoutMs = 2500

function Invoke-HaiIpSendMessage {
	param(
		[IntPtr]$Hwnd,
		[uint32]$Message,
		[IntPtr]$WParam = [IntPtr]::Zero,
		[IntPtr]$LParam = [IntPtr]::Zero,
		[string]$Label = 'SendMessage',
		[int]$TimeoutMs = $DefaultMessageTimeoutMs
	)

	$result = [IntPtr]::Zero
	$flags = [uint32](0x0001 -bor 0x0002)
	$ok = [HaiIpWin32]::SendMessageTimeout($Hwnd, $Message, $WParam, $LParam, $flags, [uint32]$TimeoutMs, [ref]$result)
	if ($ok -eq [IntPtr]::Zero) {
		$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
		throw "$Label timed out or failed after ${TimeoutMs}ms (message=$Message, hwnd=$($Hwnd.ToInt64()), win32=$errorCode)."
	}
	return $result
}

function Invoke-HaiIpSendMessageString {
	param(
		[IntPtr]$Hwnd,
		[uint32]$Message,
		[IntPtr]$WParam = [IntPtr]::Zero,
		[string]$LParam = '',
		[string]$Label = 'SendMessageString',
		[int]$TimeoutMs = $DefaultMessageTimeoutMs
	)

	$result = [IntPtr]::Zero
	$flags = [uint32](0x0001 -bor 0x0002)
	$ok = [HaiIpWin32]::SendMessageTimeoutString($Hwnd, $Message, $WParam, $LParam, $flags, [uint32]$TimeoutMs, [ref]$result)
	if ($ok -eq [IntPtr]::Zero) {
		$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
		throw "$Label timed out or failed after ${TimeoutMs}ms (message=$Message, hwnd=$($Hwnd.ToInt64()), win32=$errorCode)."
	}
	return $result
}

function Invoke-HaiIpPostMessage {
	param(
		[IntPtr]$Hwnd,
		[uint32]$Message,
		[IntPtr]$WParam = [IntPtr]::Zero,
		[IntPtr]$LParam = [IntPtr]::Zero,
		[string]$Label = 'PostMessage'
	)

	if (-not [HaiIpWin32]::PostMessage($Hwnd, $Message, $WParam, $LParam)) {
		$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
		throw "$Label failed (message=$Message, hwnd=$($Hwnd.ToInt64()), win32=$errorCode)."
	}
}

function Convert-HaiIpMessageResultToInt32 {
	param([IntPtr]$Value)

	$number = $Value.ToInt64()
	if ($number -gt [int]::MaxValue) {
		$number -= 4294967296
	}
	return [int]$number
}

function Get-WindowTextValue {
	param([IntPtr]$Hwnd)
	if ($Hwnd -eq [IntPtr]::Zero) { return '' }
	$buffer = [Text.StringBuilder]::new(1024)
	[void][HaiIpWin32]::GetWindowText($Hwnd, $buffer, $buffer.Capacity)
	return $buffer.ToString()
}

function Get-ClassNameValue {
	param([IntPtr]$Hwnd)
	if ($Hwnd -eq [IntPtr]::Zero) { return '' }
	$buffer = [Text.StringBuilder]::new(512)
	[void][HaiIpWin32]::GetClassName($Hwnd, $buffer, $buffer.Capacity)
	return $buffer.ToString()
}

function Get-RectObject {
	param([IntPtr]$Hwnd)
	$rect = [HaiIpWin32+RECT]::new()
	if (-not [HaiIpWin32]::GetWindowRect($Hwnd, [ref]$rect)) {
		return $null
	}
	return [pscustomobject]@{
		left = $rect.Left
		top = $rect.Top
		right = $rect.Right
		bottom = $rect.Bottom
		width = $rect.Right - $rect.Left
		height = $rect.Bottom - $rect.Top
	}
}

function Get-ProcessIsElevated {
	param([int]$ProcessId)
	$processHandle = [HaiIpWin32]::OpenProcess([HaiIpWin32]::PROCESS_QUERY_LIMITED_INFORMATION, $false, [uint32]$ProcessId)
	if ($processHandle -eq [IntPtr]::Zero) { return $null }

	$tokenHandle = [IntPtr]::Zero
	try {
		if (-not [HaiIpWin32]::OpenProcessToken($processHandle, [HaiIpWin32]::TOKEN_QUERY, [ref]$tokenHandle)) {
			return $null
		}

		$size = [Runtime.InteropServices.Marshal]::SizeOf([type][HaiIpWin32+TOKEN_ELEVATION])
		$buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
		try {
			$returnLength = [uint32]0
			$ok = [HaiIpWin32]::GetTokenInformation(
				$tokenHandle,
				[HaiIpWin32+TOKEN_INFORMATION_CLASS]::TokenElevation,
				$buffer,
				[uint32]$size,
				[ref]$returnLength
			)
			if (-not $ok) { return $null }
			$elevation = [Runtime.InteropServices.Marshal]::PtrToStructure($buffer, [type][HaiIpWin32+TOKEN_ELEVATION])
			return [bool]$elevation.TokenIsElevated
		} finally {
			[Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
		}
	} finally {
		if ($tokenHandle -ne [IntPtr]::Zero) { [void][HaiIpWin32]::CloseHandle($tokenHandle) }
		if ($processHandle -ne [IntPtr]::Zero) { [void][HaiIpWin32]::CloseHandle($processHandle) }
	}
}

function Test-CurrentProcessElevated {
	$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
	$principal = [Security.Principal.WindowsPrincipal]::new($identity)
	return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-HaiIpWindow {
	$matches = New-Object System.Collections.Generic.List[object]
	[HaiIpWin32]::EnumWindows({
		param($hwnd, $lparam)

		if (-not [HaiIpWin32]::IsWindowVisible($hwnd)) { return $true }

		[uint32]$windowProcessId = 0
		[void][HaiIpWin32]::GetWindowThreadProcessId($hwnd, [ref]$windowProcessId)
		$title = Get-WindowTextValue $hwnd
		$className = Get-ClassNameValue $hwnd
		$processName = ''
		try { $processName = (Get-Process -Id ([int]$windowProcessId) -ErrorAction Stop).ProcessName } catch {}

		if ($processName -eq 'HaiipClientMulti' -and $title -eq 'Hai-IP') {
			$rect = Get-RectObject $hwnd
			$matches.Add([pscustomobject]@{
				hwnd = $hwnd
				processId = [int]$windowProcessId
				processName = $processName
				title = $title
				className = $className
				rect = $rect
			})
		}

		return $true
	}, [IntPtr]::Zero) | Out-Null

	$window = $matches |
		Where-Object { $_.rect -and $_.rect.width -gt 0 -and $_.rect.height -gt 0 } |
		Sort-Object @{ Expression = { $_.rect.width * $_.rect.height }; Descending = $true } |
		Select-Object -First 1

	if (-not $window) {
		throw 'Hai-IP window was not found. Start Hai-IP and keep the main window visible.'
	}

	return $window
}

function Get-WindowChildSnapshots {
	param([IntPtr]$Hwnd)

	$children = New-Object System.Collections.Generic.List[object]
	[HaiIpWin32]::EnumChildWindows($Hwnd, {
		param($childHwnd, $lparam)

		$children.Add([pscustomobject]@{
			hwnd = $childHwnd
			text = Get-WindowTextValue $childHwnd
			className = Get-ClassNameValue $childHwnd
			rect = Get-RectObject $childHwnd
		})
		return $true
	}, [IntPtr]::Zero) | Out-Null
	return @($children)
}

function Get-HaiIpDialogKind {
	param([string]$Text)

	if ($Text -match '\uCCB4\uD06C\uB41C\s*IP|\uCCB4\uD06C.*\uC5C6|\uB300\uAE30\uC778\s*IP|\uB300\uAE30\s*IP.*\uC5C6') {
		return 'no-checked-or-waiting-ip'
	}
	if ($Text -match '\uC774\uBBF8\s*\uC0AC\uC6A9|\uC0AC\uC6A9\s*\uC911|\uC0AC\uC6A9\uC911') {
		return 'ip-already-in-use'
	}
	return ''
}

function Get-HaiIpBlockingDialogs {
	$dialogs = New-Object System.Collections.Generic.List[object]
	[HaiIpWin32]::EnumWindows({
		param($hwnd, $lparam)

		try {
			if (-not [HaiIpWin32]::IsWindowVisible($hwnd)) { return $true }

			[uint32]$windowProcessId = 0
			[void][HaiIpWin32]::GetWindowThreadProcessId($hwnd, [ref]$windowProcessId)
			$processName = ''
			try { $processName = (Get-Process -Id ([int]$windowProcessId) -ErrorAction Stop).ProcessName } catch {}
			if ($processName -ne 'HaiipClientMulti') { return $true }

			$title = Get-WindowTextValue $hwnd
			$className = Get-ClassNameValue $hwnd
			if ($title -eq 'Hai-IP') { return $true }
			if ($className -ne '#32770') { return $true }

			$children = @()
			$childError = ''
			try {
				$children = @(Get-WindowChildSnapshots -Hwnd ([IntPtr]$hwnd))
			} catch {
				$childError = $_.Exception.Message
			}

			$text = (@($title) + @($children | ForEach-Object { $_.text }) | Where-Object { $_ }) -join ' '
			$kind = Get-HaiIpDialogKind -Text $text
			if (-not $kind) {
				$kind = 'haiip-dialog'
			}

			$dialogs.Add([pscustomobject]@{
				hwnd = $hwnd
				processId = [int]$windowProcessId
				processName = $processName
				title = $title
				className = $className
				rect = Get-RectObject $hwnd
				text = $text
				kind = $kind
				children = $children
				childError = if ($childError) { $childError } else { $null }
			})
		} catch {
			return $true
		}
		return $true
	}, [IntPtr]::Zero) | Out-Null
	return @($dialogs)
}

function Invoke-HaiIpDialogDismiss {
	param([object]$Dialog)

	$hwnd = [IntPtr]$Dialog.hwnd
	$attempts = @()
	$okHwnd = [HaiIpWin32]::GetDlgItem($hwnd, 1)
	if ($okHwnd -ne [IntPtr]::Zero) {
		try {
			[void](Invoke-HaiIpSendMessage -Hwnd $okHwnd -Message 0x00F5 -Label "dialog-ok-$($Dialog.kind) BM_CLICK" -TimeoutMs 1200)
			$attempts += [pscustomobject]@{ method = 'BM_CLICK'; sent = 1 }
			return $attempts
		} catch {
			$attempts += [pscustomobject]@{ method = 'BM_CLICK'; error = $_.Exception.Message }
		}
	}

	try {
		[void](Invoke-HaiIpSendMessage -Hwnd $hwnd -Message 0x0111 -WParam ([IntPtr]1) -Label "dialog-ok-$($Dialog.kind) WM_COMMAND" -TimeoutMs 1200)
		$attempts += [pscustomobject]@{ method = 'WM_COMMAND_IDOK'; sent = 1 }
		return $attempts
	} catch {
		$attempts += [pscustomobject]@{ method = 'WM_COMMAND_IDOK'; error = $_.Exception.Message }
	}

	try {
		Invoke-HaiIpPostMessage -Hwnd $hwnd -Message 0x0010 -Label "dialog-ok-$($Dialog.kind) WM_CLOSE"
		$attempts += [pscustomobject]@{ method = 'WM_CLOSE'; sent = 1 }
		return $attempts
	} catch {
		$attempts += [pscustomobject]@{ method = 'WM_CLOSE'; error = $_.Exception.Message }
	}

	return $attempts
}

function Dismiss-HaiIpBlockingDialogs {
	$events = @()
	$dialogs = @(Get-HaiIpBlockingDialogs)
	foreach ($dialog in $dialogs) {
		$dismissAttempts = @(Invoke-HaiIpDialogDismiss -Dialog $dialog)
		$events += [pscustomobject]@{
			label = 'dismiss-haiip-dialog'
			kind = $dialog.kind
			text = $dialog.text
			childError = $dialog.childError
			dismissAttempts = $dismissAttempts
		}
		Start-Sleep -Milliseconds 400
	}
	return $events
}

function Ensure-HaiIpAllCheck {
	param(
		[object]$Window,
		[switch]$ForceClickIfUnknown
	)

	$clicks = @()
	$allCheck = Get-ControlSnapshot -Window $Window -Id $ControlIds.AllCheck
	if ($allCheck.checkState -eq 0) {
		$clicks += Invoke-ControlClick -Window $Window -ControlId $ControlIds.AllCheck -Label 'all-check-on' -OffsetX $AllCheckOffsetX -OffsetY $AllCheckOffsetY
		Start-Sleep -Milliseconds 700
	} elseif ($null -eq $allCheck.checkState) {
		if ($ForceClickIfUnknown) {
			$clicks += Invoke-ControlClick -Window $Window -ControlId $ControlIds.AllCheck -Label 'all-check-on-unknown-state' -OffsetX $AllCheckOffsetX -OffsetY $AllCheckOffsetY
			Start-Sleep -Milliseconds 700
		} else {
			$clicks += [pscustomobject]@{
				label = 'all-check-state-unknown-skip'
				controlId = $ControlIds.AllCheck
				checkState = $allCheck.checkState
			}
		}
	} else {
		$clicks += [pscustomobject]@{
			label = 'all-check-already-on'
			controlId = $ControlIds.AllCheck
			checkState = $allCheck.checkState
		}
	}
	return $clicks
}

function Resolve-HaiIpExePath {
	$candidates = @(
		$HaiIpExePath,
		'C:\Program Files (x86)\Haionnet\HaiipClientMulti\HaiipClientMulti.exe',
		'C:\Program Files\Haionnet\HaiipClientMulti\HaiipClientMulti.exe'
	) | Where-Object { $_ } | Select-Object -Unique

	foreach ($candidate in $candidates) {
		if (Test-Path -LiteralPath $candidate) {
			return (Resolve-Path -LiteralPath $candidate).Path
		}
	}

	$command = Get-Command 'HaiipClientMulti.exe' -ErrorAction SilentlyContinue
	if ($command) { return $command.Source }
	return $null
}

function Start-HaiIpClient {
	$exePath = Resolve-HaiIpExePath
	if (-not $exePath) {
		throw 'Hai-IP executable was not found. Pass -HaiIpExePath or install Hai-IP in the default location.'
	}

	$workingDirectory = Split-Path -Parent $exePath
	Start-Process -FilePath $exePath -WorkingDirectory $workingDirectory | Out-Null
}

function Wait-HaiIpWindow {
	param([int]$TimeoutSeconds)

	$deadline = (Get-Date).AddSeconds([Math]::Max(1, $TimeoutSeconds))
	do {
		try {
			return Find-HaiIpWindow
		} catch {
			Start-Sleep -Milliseconds 750
		}
	} while ((Get-Date) -lt $deadline)

	return Find-HaiIpWindow
}

function Get-HaiIpWindowForChange {
	try {
		return Find-HaiIpWindow
	} catch {
		if ($NoAutoStart) { throw }
		Start-HaiIpClient
		return Wait-HaiIpWindow -TimeoutSeconds $WindowWaitSeconds
	}
}

function Get-ControlSnapshot {
	param(
		[object]$Window,
		[int]$Id
	)

	$hwnd = [HaiIpWin32]::GetDlgItem($Window.hwnd, $Id)
	if ($hwnd -eq [IntPtr]::Zero) {
		return [pscustomobject]@{ id = $Id; found = $false }
	}

	$bmGetCheck = 0x00F0
	$checkState = $null
	try {
		$checkState = Convert-HaiIpMessageResultToInt32 (Invoke-HaiIpSendMessage -Hwnd $hwnd -Message $bmGetCheck -Label "BM_GETCHECK control $Id")
	} catch {}

	return [pscustomobject]@{
		id = $Id
		found = $true
		hwnd = $hwnd.ToInt64()
		text = Get-WindowTextValue $hwnd
		className = Get-ClassNameValue $hwnd
		rect = Get-RectObject $hwnd
		checkState = $checkState
	}
}

function Get-HaiIpIniState {
	$paths = @(
		'C:\Program Files (x86)\Haionnet\HaiipClientMulti\Hai-ipClientSetup.ini',
		'C:\Program Files\Haionnet\HaiipClientMulti\Hai-ipClientSetup.ini'
	)

	$path = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
	if (-not $path) { return $null }

	$text = Get-Content -Raw -Path $path
	$getValue = {
		param([string]$Name)
		$match = [regex]::Match($text, "(?m)^$([regex]::Escape($Name))=(.*)$")
		if ($match.Success) { return $match.Groups[1].Value.Trim() }
		return ''
	}

	return [pscustomobject]@{
		path = $path
		serviceType = & $getValue 'ServiceType'
		dynamicProduct = & $getValue 'DynamicProduct'
		server = & $getValue 'SERVER'
		lastUsedIp = & $getValue 'LastUsedIP'
		isAutoChange = & $getValue 'IsAutoChange'
		autoChangeSec = & $getValue 'AutoChangeSec'
	}
}

function Get-PublicIp {
	try {
		$separator = if ($PublicIpUrl.Contains('?')) { '&' } else { '?' }
		$url = "$PublicIpUrl$separator`_ts=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
		$output = & curl.exe -4 -sS --max-time 10 --no-keepalive `
			-H 'Cache-Control: no-cache' `
			-H 'Pragma: no-cache' `
			-H 'Connection: close' `
			$url
		if ($LASTEXITCODE -ne 0) { return '' }

		$text = ($output -join "`n").Trim()
		if (-not $text) { return '' }

		try {
			$json = $text | ConvertFrom-Json -ErrorAction Stop
			if ($json.ip) { return [string]$json.ip }
			if ($json.query) { return [string]$json.query }
		} catch {}

		$match = [regex]::Match($text, '\b\d{1,3}(?:\.\d{1,3}){3}\b')
		if ($match.Success) { return $match.Value }
		return $text
	} catch {
		return ''
	}
}

function Get-HaiIpStatus {
	$processes = Get-Process -Name 'HaiipClientMulti', 'haiip_openvpn' -ErrorAction SilentlyContinue |
		Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle
	$window = $null
	try { $window = Find-HaiIpWindow } catch {}

	$controls = @{}
	if ($window) {
		foreach ($key in $ControlIds.Keys) {
			$controls[$key] = Get-ControlSnapshot -Window $window -Id $ControlIds[$key]
		}
	}

	return [pscustomobject]@{
		checkedAt = (Get-Date).ToString('o')
		currentProcessElevated = Test-CurrentProcessElevated
		publicIp = Get-PublicIp
		processes = $processes
		window = $window
		ini = Get-HaiIpIniState
		controls = $controls
	}
}

function Get-HaiIpStatusPublicIpValue {
	param([object]$Status)

	$ip = [string]$Status.publicIp
	if (-not $ip -and $Status.controls -and $Status.controls.CurrentIp) {
		$ip = [string]$Status.controls.CurrentIp.text
	}
	if (-not $ip -and $Status.ini) {
		$ip = [string]$Status.ini.lastUsedIp
	}
	if ($ip -match '^\d{1,3}(?:\.\d{1,3}){3}$') { return $ip }
	return ''
}

function Get-ObservedPublicIp {
	$ip = Get-PublicIp
	if ($ip) { return $ip }

	try {
		return Get-HaiIpStatusPublicIpValue -Status (Get-HaiIpStatus)
	} catch {
		return ''
	}
}

function Assert-CanDriveHaiIp {
	param([object]$Window)
	$currentElevated = Test-CurrentProcessElevated
	$targetElevated = Get-ProcessIsElevated -ProcessId $Window.processId
	if ($targetElevated -and -not $currentElevated) {
		throw "Hai-IP is running elevated, but this script is not. Run PowerShell/Scheduled Task with highest privileges before using change."
	}
}

function Set-HaiIpWindowForeground {
	param([IntPtr]$Hwnd)

	# SetForegroundWindow 는 다른 프로세스가 최상위일 때 Windows 가 조용히 무시한다.
	# 그러면 SendInput 클릭이 비활성 창으로 들어가 앱이 받아주지 않는다.
	# 현재 최상위 창의 입력 스레드에 우리 스레드를 붙이면 이 제한이 풀린다.
	$foreground = [HaiIpWin32]::GetForegroundWindow()
	if ($foreground -eq $Hwnd) { return $true }

	$targetThread = 0
	if ($foreground -ne [IntPtr]::Zero) {
		$targetThread = [HaiIpWin32]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)
	}
	$currentThread = [HaiIpWin32]::GetCurrentThreadId()
	$attached = $false

	try {
		if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
			$attached = [HaiIpWin32]::AttachThreadInput($currentThread, $targetThread, $true)
		}
		[void][HaiIpWin32]::ShowWindow($Hwnd, 9)
		[void][HaiIpWin32]::BringWindowToTop($Hwnd)
		[void][HaiIpWin32]::SetForegroundWindow($Hwnd)
	} finally {
		if ($attached) { [void][HaiIpWin32]::AttachThreadInput($currentThread, $targetThread, $false) }
	}

	Start-Sleep -Milliseconds 400
	return ([HaiIpWin32]::GetForegroundWindow() -eq $Hwnd)
}

function Invoke-ControlClick {
	param(
		[object]$Window,
		[int]$ControlId,
		[string]$Label,
		[int]$OffsetX = -1,
		[int]$OffsetY = -1,
		[ValidateSet('Input', 'WMCommand', 'BMClick')]
		[string]$Method = 'Input'
	)

	$control = Get-ControlSnapshot -Window $Window -Id $ControlId
	if (-not $control.found -or -not $control.rect) {
		throw "Hai-IP control was not found: $Label ($ControlId)"
	}

	if ($Method -eq 'WMCommand') {
		$wmCommand = 0x0111
		$bnClicked = 0
		$wParam = [IntPtr](($bnClicked -shl 16) -bor $ControlId)
		[void](Invoke-HaiIpSendMessage -Hwnd $Window.hwnd -Message $wmCommand -WParam $wParam -LParam ([IntPtr]$control.hwnd) -Label "$Label WM_COMMAND")
		return [pscustomobject]@{
			label = $Label
			controlId = $ControlId
			method = $Method
			offsetX = $null
			offsetY = $null
			x = $null
			y = $null
			sent = 1
		}
	}

	if ($Method -eq 'BMClick') {
		$bmClick = 0x00F5
		[void](Invoke-HaiIpSendMessage -Hwnd ([IntPtr]$control.hwnd) -Message $bmClick -Label "$Label BM_CLICK")
		return [pscustomobject]@{
			label = $Label
			controlId = $ControlId
			method = $Method
			offsetX = $null
			offsetY = $null
			x = $null
			y = $null
			sent = 1
		}
	}

	$desktopAccess = 0x0001 -bor 0x0080 -bor 0x0100 -bor 0x0040 -bor 0x0008
	$desktop = [HaiIpWin32]::OpenInputDesktop(0, $false, [uint32]$desktopAccess)

	try {
		[void](Set-HaiIpWindowForeground -Hwnd ([IntPtr]$Window.hwnd))
		Start-Sleep -Milliseconds 300

		if ($OffsetX -ge 0 -and $OffsetY -ge 0) {
			$x = [int]($control.rect.left + $OffsetX)
			$y = [int]($control.rect.top + $OffsetY)
		} else {
			$x = [int]($control.rect.left + [Math]::Max(1, [Math]::Floor($control.rect.width / 2)))
			$y = [int]($control.rect.top + [Math]::Max(1, [Math]::Floor($control.rect.height / 2)))
		}

		if (-not [HaiIpWin32]::SetCursorPos($x, $y)) {
			throw "SetCursorPos failed for $Label at $x,$y"
		}

		Start-Sleep -Milliseconds 150

		$inputs = New-Object 'HaiIpWin32+INPUT[]' 2
		$inputs[0].type = 0
		$inputs[0].mi.dwFlags = 0x0002
		$inputs[1].type = 0
		$inputs[1].mi.dwFlags = 0x0004
		$sent = [HaiIpWin32]::SendInput(2, $inputs, [Runtime.InteropServices.Marshal]::SizeOf([type][HaiIpWin32+INPUT]))
		if ($sent -ne 2) {
			throw "SendInput sent $sent/2 events for $Label"
		}

		Start-Sleep -Milliseconds 500
		return [pscustomobject]@{
			label = $Label
			controlId = $ControlId
			method = $Method
			offsetX = if ($OffsetX -ge 0) { $OffsetX } else { $null }
			offsetY = if ($OffsetY -ge 0) { $OffsetY } else { $null }
			x = $x
			y = $y
			sent = $sent
		}
	} finally {
		if ($desktop -ne [IntPtr]::Zero) { [void][HaiIpWin32]::CloseDesktop($desktop) }
	}
}

function Invoke-ScreenDoubleClick {
	param(
		[object]$Window,
		[string]$Label,
		[int]$X,
		[int]$Y
	)

	$desktopAccess = 0x0001 -bor 0x0080 -bor 0x0100 -bor 0x0040 -bor 0x0008
	$desktop = [HaiIpWin32]::OpenInputDesktop(0, $false, [uint32]$desktopAccess)

	try {
		[void](Set-HaiIpWindowForeground -Hwnd ([IntPtr]$Window.hwnd))
		Start-Sleep -Milliseconds 300

		if (-not [HaiIpWin32]::SetCursorPos($X, $Y)) {
			throw "SetCursorPos failed for $Label at $X,$Y"
		}

		Start-Sleep -Milliseconds 120

		$inputs = New-Object 'HaiIpWin32+INPUT[]' 2
		$inputs[0].type = 0
		$inputs[0].mi.dwFlags = 0x0002
		$inputs[1].type = 0
		$inputs[1].mi.dwFlags = 0x0004
		$firstSent = [HaiIpWin32]::SendInput(2, $inputs, [Runtime.InteropServices.Marshal]::SizeOf([type][HaiIpWin32+INPUT]))
		Start-Sleep -Milliseconds 120
		$secondSent = [HaiIpWin32]::SendInput(2, $inputs, [Runtime.InteropServices.Marshal]::SizeOf([type][HaiIpWin32+INPUT]))
		$sent = $firstSent + $secondSent
		if ($sent -ne 4) {
			throw "SendInput sent $sent/4 events for $Label"
		}

		Start-Sleep -Milliseconds 700
		return [pscustomobject]@{
			label = $Label
			method = 'InputDoubleClick'
			x = $X
			y = $Y
			sent = $sent
		}
	} finally {
		if ($desktop -ne [IntPtr]::Zero) { [void][HaiIpWin32]::CloseDesktop($desktop) }
	}
}

function Set-ControlText {
	param(
		[object]$Window,
		[int]$ControlId,
		[string]$Text
	)

	$control = Get-ControlSnapshot -Window $Window -Id $ControlId
	if (-not $control.found) {
		throw "Hai-IP control was not found for text input: $ControlId"
	}

	$wmSetText = 0x000C
	[void](Invoke-HaiIpSendMessageString -Hwnd ([IntPtr]$control.hwnd) -Message $wmSetText -LParam $Text -Label "WM_SETTEXT control $ControlId")
	return [pscustomobject]@{
		label = 'set-text'
		controlId = $ControlId
		text = $Text
		sent = 1
	}
}

function Set-ControlTextByInput {
	param(
		[object]$Window,
		[int]$ControlId,
		[string]$Text
	)

	if (-not ('System.Windows.Forms.SendKeys' -as [type])) {
		throw 'System.Windows.Forms.SendKeys is not available for keyboard text input.'
	}

	$focusClick = Invoke-ControlClick -Window $Window -ControlId $ControlId -Label 'focus-text-input' -Method 'Input'
	Start-Sleep -Milliseconds 150
	[System.Windows.Forms.SendKeys]::SendWait('^a')
	Start-Sleep -Milliseconds 80
	if ($Text) {
		[System.Windows.Forms.SendKeys]::SendWait($Text)
	} else {
		[System.Windows.Forms.SendKeys]::SendWait('{BACKSPACE}')
	}
	Start-Sleep -Milliseconds 250

	return [pscustomobject]@{
		label = 'type-text'
		controlId = $ControlId
		text = $Text
		method = 'Input'
		focusClick = $focusClick
		sent = 1
	}
}

function Get-ListViewItemCount {
	param([object]$Window)

	$control = Get-ControlSnapshot -Window $Window -Id $ControlIds.ListView
	if (-not $control.found) { return 0 }

	$lvmGetItemCount = 0x1004
	return Convert-HaiIpMessageResultToInt32 (Invoke-HaiIpSendMessage -Hwnd ([IntPtr]$control.hwnd) -Message $lvmGetItemCount -Label 'LVM_GETITEMCOUNT')
}

function Get-ListViewSelectedIndex {
	param([object]$Window)

	$control = Get-ControlSnapshot -Window $Window -Id $ControlIds.ListView
	if (-not $control.found) { return -1 }

	$lvmGetNextItem = 0x100C
	$lvniSelected = 0x0002
	$lvniFocused = 0x0001
	$selected = Convert-HaiIpMessageResultToInt32 (Invoke-HaiIpSendMessage -Hwnd ([IntPtr]$control.hwnd) -Message $lvmGetNextItem -WParam ([IntPtr](-1)) -LParam ([IntPtr]$lvniSelected) -Label 'LVM_GETNEXTITEM selected')
	if ($selected -lt 0) {
		$selected = Convert-HaiIpMessageResultToInt32 (Invoke-HaiIpSendMessage -Hwnd ([IntPtr]$control.hwnd) -Message $lvmGetNextItem -WParam ([IntPtr](-1)) -LParam ([IntPtr]$lvniFocused) -Label 'LVM_GETNEXTITEM focused')
	}
	return $selected
}

function Get-ListViewItemRect {
	param(
		[object]$Window,
		[int]$Index
	)

	$control = Get-ControlSnapshot -Window $Window -Id $ControlIds.ListView
	if (-not $control.found) {
		throw 'Hai-IP list view was not found.'
	}
	if ($Index -lt 0) {
		throw "Invalid Hai-IP list view index: $Index"
	}

	$lvmEnsureVisible = 0x1013
	$lvmGetItemRect = 0x100E
	[void](Invoke-HaiIpSendMessage -Hwnd ([IntPtr]$control.hwnd) -Message $lvmEnsureVisible -WParam ([IntPtr]$Index) -Label "LVM_ENSUREVISIBLE index $Index")
	Start-Sleep -Milliseconds 150

	$processAccess = 0x0008 -bor 0x0010 -bor 0x0020 -bor 0x0400
	$processHandle = [HaiIpWin32]::OpenProcess([uint32]$processAccess, $false, [uint32]$Window.processId)
	if ($processHandle -eq [IntPtr]::Zero) {
		$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
		throw "OpenProcess failed for Hai-IP list view item rect: $errorCode"
	}

	$remoteRect = [IntPtr]::Zero
	try {
		$rectSize = [UIntPtr]::new([uint64]16)
		$remoteRect = [HaiIpWin32]::VirtualAllocEx($processHandle, [IntPtr]::Zero, $rectSize, [uint32](0x1000 -bor 0x2000), [uint32]0x04)
		if ($remoteRect -eq [IntPtr]::Zero) {
			$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
			throw "VirtualAllocEx failed for Hai-IP list view item rect: $errorCode"
		}

		$rectIn = [HaiIpWin32+RECT]::new()
		$rectIn.Left = 0
		$written = [UIntPtr]::Zero
		if (-not [HaiIpWin32]::WriteProcessMemory($processHandle, $remoteRect, [ref]$rectIn, $rectSize, [ref]$written)) {
			$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
			throw "WriteProcessMemory failed for Hai-IP list view item rect: $errorCode"
		}

		$ok = Convert-HaiIpMessageResultToInt32 (Invoke-HaiIpSendMessage -Hwnd ([IntPtr]$control.hwnd) -Message $lvmGetItemRect -WParam ([IntPtr]$Index) -LParam $remoteRect -Label "LVM_GETITEMRECT index $Index")
		if ($ok -eq 0) {
			throw "LVM_GETITEMRECT failed for Hai-IP list view index $Index"
		}

		$rectOut = [HaiIpWin32+RECT]::new()
		$read = [UIntPtr]::Zero
		if (-not [HaiIpWin32]::ReadProcessMemory($processHandle, $remoteRect, [ref]$rectOut, $rectSize, [ref]$read)) {
			$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
			throw "ReadProcessMemory failed for Hai-IP list view item rect: $errorCode"
		}

		return [pscustomobject]@{
			left = $rectOut.Left
			top = $rectOut.Top
			right = $rectOut.Right
			bottom = $rectOut.Bottom
			width = $rectOut.Right - $rectOut.Left
			height = $rectOut.Bottom - $rectOut.Top
		}
	} finally {
		if ($remoteRect -ne [IntPtr]::Zero) {
			[void][HaiIpWin32]::VirtualFreeEx($processHandle, $remoteRect, [UIntPtr]::Zero, [uint32]0x8000)
		}
		if ($processHandle -ne [IntPtr]::Zero) {
			[void][HaiIpWin32]::CloseHandle($processHandle)
		}
	}
}

function Invoke-SelectedListViewItemDoubleClick {
	param(
		[object]$Window,
		[ValidateSet('WMDoubleClick', 'WMDoubleClickTimeout', 'InputDoubleClick')]
		[string]$Method = 'WMDoubleClick'
	)

	$control = Get-ControlSnapshot -Window $Window -Id $ControlIds.ListView
	if (-not $control.found -or -not $control.rect) {
		throw 'Hai-IP list view was not found for selected row double click.'
	}

	$selectedIndex = Get-ListViewSelectedIndex -Window $Window
	if ($selectedIndex -lt 0) {
		throw 'Hai-IP list view has no selected IP row after search.'
	}

	$itemRect = Get-ListViewItemRect -Window $Window -Index $selectedIndex
	if ($itemRect.height -le 0 -or $itemRect.width -le 0) {
		throw "Hai-IP selected row rect is invalid for index $selectedIndex."
	}

	$xOffset = if ($itemRect.width -gt 96) { 80 } else { [Math]::Max(8, [Math]::Floor($itemRect.width / 2)) }
	$clientX = [int]($itemRect.left + $xOffset)
	$clientY = [int]($itemRect.top + [Math]::Max(1, [Math]::Floor($itemRect.height / 2)))
	$x = [int]($control.rect.left + $clientX)
	$y = [int]($control.rect.top + $clientY)
	$sent = 0
	if ($Method -eq 'InputDoubleClick') {
		$inputClick = Invoke-ScreenDoubleClick -Window $Window -Label 'double-click-selected-ip-row' -X $x -Y $y
		$sent = $inputClick.sent
	} else {
		$lParam = [IntPtr](((($clientY -band 0xffff) -shl 16) -bor ($clientX -band 0xffff)))
		$wmMouseMove = 0x0200
		$wmLButtonDown = 0x0201
		$wmLButtonUp = 0x0202
		$wmLButtonDblClk = 0x0203
		$mkLButton = [IntPtr]1
		if ($Method -eq 'WMDoubleClickTimeout') {
			[void](Invoke-HaiIpSendMessage -Hwnd ([IntPtr]$control.hwnd) -Message $wmMouseMove -LParam $lParam -Label 'WM_MOUSEMOVE selected row')
			[void](Invoke-HaiIpSendMessage -Hwnd ([IntPtr]$control.hwnd) -Message $wmLButtonDown -WParam $mkLButton -LParam $lParam -Label 'WM_LBUTTONDOWN selected row')
			[void](Invoke-HaiIpSendMessage -Hwnd ([IntPtr]$control.hwnd) -Message $wmLButtonUp -LParam $lParam -Label 'WM_LBUTTONUP selected row')
			Start-Sleep -Milliseconds 120
			[void](Invoke-HaiIpSendMessage -Hwnd ([IntPtr]$control.hwnd) -Message $wmLButtonDblClk -WParam $mkLButton -LParam $lParam -Label 'WM_LBUTTONDBLCLK selected row')
			[void](Invoke-HaiIpSendMessage -Hwnd ([IntPtr]$control.hwnd) -Message $wmLButtonUp -LParam $lParam -Label 'WM_LBUTTONUP selected row after double click')
		} else {
			Invoke-HaiIpPostMessage -Hwnd ([IntPtr]$control.hwnd) -Message $wmMouseMove -LParam $lParam -Label 'WM_MOUSEMOVE selected row'
			Invoke-HaiIpPostMessage -Hwnd ([IntPtr]$control.hwnd) -Message $wmLButtonDown -WParam $mkLButton -LParam $lParam -Label 'WM_LBUTTONDOWN selected row'
			Invoke-HaiIpPostMessage -Hwnd ([IntPtr]$control.hwnd) -Message $wmLButtonUp -LParam $lParam -Label 'WM_LBUTTONUP selected row'
			Start-Sleep -Milliseconds 120
			Invoke-HaiIpPostMessage -Hwnd ([IntPtr]$control.hwnd) -Message $wmLButtonDblClk -WParam $mkLButton -LParam $lParam -Label 'WM_LBUTTONDBLCLK selected row'
			Invoke-HaiIpPostMessage -Hwnd ([IntPtr]$control.hwnd) -Message $wmLButtonUp -LParam $lParam -Label 'WM_LBUTTONUP selected row after double click'
		}
		Start-Sleep -Milliseconds 700
		$sent = 5
	}

	return [pscustomobject]@{
		label = 'double-click-selected-ip-row'
		controlId = $ControlIds.ListView
		selectedIndex = $selectedIndex
		itemRect = $itemRect
		clientX = $clientX
		clientY = $clientY
		x = $x
		y = $y
		method = $Method
		sent = $sent
	}
}

function Test-ListViewItemChecked {
	param(
		[object]$Window,
		[int]$Index = 0
	)

	$control = Get-ControlSnapshot -Window $Window -Id $ControlIds.ListView
	if (-not $control.found) { return $false }

	$lvmGetItemState = 0x102C
	$lvisStateImageMask = 0xF000
	$state = Convert-HaiIpMessageResultToInt32 (Invoke-HaiIpSendMessage -Hwnd ([IntPtr]$control.hwnd) -Message $lvmGetItemState -WParam ([IntPtr]$Index) -LParam ([IntPtr]$lvisStateImageMask) -Label "LVM_GETITEMSTATE index $Index")
	return ((($state -band $lvisStateImageMask) -shr 12) -eq 2)
}

function Get-ListViewItemText {
	param(
		[object]$Window,
		[int]$Index,
		[int]$SubItem = 0,
		[switch]$Ansi
	)

	$control = Get-ControlSnapshot -Window $Window -Id $ControlIds.ListView
	if (-not $control.found) {
		throw 'Hai-IP list view was not found for item text.'
	}
	if ($Index -lt 0) {
		throw "Invalid Hai-IP list view index for item text: $Index"
	}

	$processAccess = 0x0008 -bor 0x0010 -bor 0x0020 -bor 0x0400
	$processHandle = [HaiIpWin32]::OpenProcess([uint32]$processAccess, $false, [uint32]$Window.processId)
	if ($processHandle -eq [IntPtr]::Zero) {
		$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
		throw "OpenProcess failed for Hai-IP list view item text: $errorCode"
	}

	$remoteItem = [IntPtr]::Zero
	$remoteText = [IntPtr]::Zero
	try {
		$charCount = 256
		$bytesPerChar = if ($Ansi) { 1 } else { 2 }
		$textByteCount = $charCount * $bytesPerChar
		$itemByteCount = [Runtime.InteropServices.Marshal]::SizeOf([type][HaiIpWin32+LVITEM32])
		$remoteText = [HaiIpWin32]::VirtualAllocEx($processHandle, [IntPtr]::Zero, [UIntPtr]::new([uint64]$textByteCount), [uint32](0x1000 -bor 0x2000), [uint32]0x04)
		if ($remoteText -eq [IntPtr]::Zero) {
			$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
			throw "VirtualAllocEx failed for Hai-IP list view item text buffer: $errorCode"
		}
		$remoteItem = [HaiIpWin32]::VirtualAllocEx($processHandle, [IntPtr]::Zero, [UIntPtr]::new([uint64]$itemByteCount), [uint32](0x1000 -bor 0x2000), [uint32]0x04)
		if ($remoteItem -eq [IntPtr]::Zero) {
			$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
			throw "VirtualAllocEx failed for Hai-IP list view item text struct: $errorCode"
		}

		$item = [HaiIpWin32+LVITEM32]::new()
		$item.mask = 0x0001
		$item.iItem = $Index
		$item.iSubItem = $SubItem
		$item.pszText = [uint32]($remoteText.ToInt64() -band 0xffffffff)
		$item.cchTextMax = $charCount

		$written = [UIntPtr]::Zero
		if (-not [HaiIpWin32]::WriteProcessMemoryLvItem32($processHandle, $remoteItem, [ref]$item, [UIntPtr]::new([uint64]$itemByteCount), [ref]$written)) {
			$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
			throw "WriteProcessMemory failed for Hai-IP list view item text: $errorCode"
		}

		$lvmGetItemText = if ($Ansi) { 0x102D } else { 0x1073 }
		[void](Invoke-HaiIpSendMessage -Hwnd ([IntPtr]$control.hwnd) -Message $lvmGetItemText -WParam ([IntPtr]$Index) -LParam $remoteItem -Label "LVM_GETITEMTEXT index $Index subitem $SubItem")

		$buffer = New-Object byte[] $textByteCount
		$read = [UIntPtr]::Zero
		if (-not [HaiIpWin32]::ReadProcessMemoryBytes($processHandle, $remoteText, $buffer, [UIntPtr]::new([uint64]$textByteCount), [ref]$read)) {
			$errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
			throw "ReadProcessMemory failed for Hai-IP list view item text: $errorCode"
		}

		if ($Ansi) {
			return ([Text.Encoding]::Default.GetString($buffer)).TrimEnd([char]0)
		}
		return ([Text.Encoding]::Unicode.GetString($buffer)).TrimEnd([char]0)
	} finally {
		if ($remoteText -ne [IntPtr]::Zero) {
			[void][HaiIpWin32]::VirtualFreeEx($processHandle, $remoteText, [UIntPtr]::Zero, [uint32]0x8000)
		}
		if ($remoteItem -ne [IntPtr]::Zero) {
			[void][HaiIpWin32]::VirtualFreeEx($processHandle, $remoteItem, [UIntPtr]::Zero, [uint32]0x8000)
		}
		if ($processHandle -ne [IntPtr]::Zero) {
			[void][HaiIpWin32]::CloseHandle($processHandle)
		}
	}
}

function Get-ListViewItemTexts {
	param(
		[object]$Window,
		[int]$Index,
		[int]$MaxSubItems = 6
	)

	$texts = @()
	for ($subItem = 0; $subItem -lt $MaxSubItems; $subItem += 1) {
		$text = ''
		try {
			$text = Get-ListViewItemText -Window $Window -Index $Index -SubItem $subItem
			if (-not $text) {
				$text = Get-ListViewItemText -Window $Window -Index $Index -SubItem $subItem -Ansi
			}
		} catch {
			$texts += [pscustomobject]@{
				subItem = $subItem
				text = ''
				error = $_.Exception.Message
			}
			continue
		}
		$texts += [pscustomobject]@{
			subItem = $subItem
			text = $text
		}
	}
	return $texts
}

function Test-ListViewItemTextsContainIp {
	param(
		[object[]]$Texts,
		[string]$Ip
	)

	foreach ($entry in @($Texts)) {
		$text = [string]$entry.text
		if ($text -and $text.Contains($Ip)) {
			return $true
		}
	}
	return $false
}

function Reset-HaiIpSearch {
	param([object]$Window)

	$clicks = @()
	$clicks += Set-ControlText -Window $Window -ControlId $ControlIds.SearchText -Text ''
	$clicks += Invoke-ControlClick -Window $Window -ControlId $ControlIds.SearchButton -Label 'clear-search' -Method 'BMClick'
	Start-Sleep -Milliseconds 600
	return $clicks
}

function Invoke-ChangeIpButtonOnce {
	param(
		[object]$Window,
		[string]$BeforeIp
	)

	$clicks = @()
	$result = $null
	$lastError = ''
	$methods = @($ChangeClickMethod)
	foreach ($fallbackMethod in @('Input', 'WMCommand', 'BMClick')) {
		if ($methods -notcontains $fallbackMethod) { $methods += $fallbackMethod }
	}

	foreach ($method in $methods) {
		try {
			$clicks += Invoke-ControlClick -Window $Window -ControlId $ControlIds.ChangeIp -Label "change-ip-$method" -OffsetX $ChangeIpOffsetX -OffsetY $ChangeIpOffsetY -Method $method
			$result = Wait-PublicIpChange -Before $BeforeIp -TimeoutSeconds $WaitSeconds
			if (-not $RequireChanged -or $result.changed) { break }
			if ($result.retryableDialog) {
				$clicks += $result.dialogEvents
				$clicks += [pscustomobject]@{
					label = 'change-ip-retryable-dialog'
					method = $method
					dialogKind = $result.dialogKind
					dialogText = $result.dialogText
				}
				try { $clicks += Reset-HaiIpSearch -Window $Window } catch {}
				if ($result.dialogKind -in @('no-checked-or-waiting-ip', 'ip-already-in-use', 'haiip-dialog', 'haiip-dialog-detect-error')) {
					try { $clicks += Ensure-HaiIpAllCheck -Window $Window -ForceClickIfUnknown } catch {
						$clicks += [pscustomobject]@{
							label = 'all-check-retry-error'
							error = $_.Exception.Message
						}
					}
				}
				continue
			}
			$clicks += [pscustomobject]@{
				label = 'change-ip-no-change'
				method = $method
				beforePublicIp = $BeforeIp
				afterPublicIp = $result.publicIp
				timedOut = $result.timedOut
			}
		} catch {
			$lastError = $_.Exception.Message
			$clicks += [pscustomobject]@{
				label = 'change-ip-click-error'
				method = $method
				error = $lastError
			}
		}
		if ($result -and (-not $RequireChanged -or $result.changed)) { break }
	}

	if (-not $result) {
		$result = [pscustomobject]@{
			publicIp = Get-ObservedPublicIp
			changed = $false
			timedOut = $true
			error = $lastError
		}
	}

	return [pscustomobject]@{
		changed = (-not $RequireChanged) -or [bool]$result.changed
		result = $result
		clicks = $clicks
		method = $ChangeClickMethod
		methodsTried = $methods
		lastError = $lastError
	}
}

function Select-PreferredIpInList {
	param(
		[object]$Window,
		[string]$Ip
	)

	$clicks = @()
	$beforeSearchItemCount = Get-ListViewItemCount -Window $Window
	$beforeSelectedIndex = Get-ListViewSelectedIndex -Window $Window
	$clicks += Set-ControlText -Window $Window -ControlId $ControlIds.SearchText -Text $Ip
	$clicks += Invoke-ControlClick -Window $Window -ControlId $ControlIds.SearchButton -Label 'search-preferred-ip' -Method 'BMClick'
	Start-Sleep -Milliseconds 800

	$itemCount = Get-ListViewItemCount -Window $Window
	$selectedIndex = Get-ListViewSelectedIndex -Window $Window
	$selectedItemTexts = @()
	$textMatched = $false
	if ($selectedIndex -lt 0) {
		$clicks += Set-ControlTextByInput -Window $Window -ControlId $ControlIds.SearchText -Text $Ip
		$clicks += Invoke-ControlClick -Window $Window -ControlId $ControlIds.SearchButton -Label 'search-preferred-ip-input-retry' -Method 'Input'
		Start-Sleep -Milliseconds 1000
		$itemCount = Get-ListViewItemCount -Window $Window
		$selectedIndex = Get-ListViewSelectedIndex -Window $Window
	}

	if ($itemCount -ge 1 -and $selectedIndex -ge 0) {
		$selectedItemTexts = @(Get-ListViewItemTexts -Window $Window -Index $selectedIndex)
		$textMatched = Test-ListViewItemTextsContainIp -Texts $selectedItemTexts -Ip $Ip
	}

	if ($itemCount -lt 1 -or $selectedIndex -lt 0 -or -not $textMatched) {
		$clicks += Reset-HaiIpSearch -Window $Window
		return [pscustomobject]@{
			found = $false
			itemCount = $itemCount
			searchApplied = $true
			checked = $false
			selectedIndex = $selectedIndex
			selectedIndexBefore = $beforeSelectedIndex
			selectedItemTexts = $selectedItemTexts
			textMatched = $textMatched
			clicks = $clicks
		}
	}

	$checked = $true
	if ($CheckPreferredResult) {
		$checked = Test-ListViewItemChecked -Window $Window -Index $selectedIndex
	}
	if ($CheckPreferredResult -and -not $checked) {
		$itemRect = Get-ListViewItemRect -Window $Window -Index $selectedIndex
		$clicks += Invoke-ControlClick -Window $Window -ControlId $ControlIds.ListView -Label 'check-preferred-ip-selected-result' -OffsetX 10 -OffsetY ([int]($itemRect.top + [Math]::Max(1, [Math]::Floor($itemRect.height / 2)))) -Method 'Input'
		Start-Sleep -Milliseconds 400
		$checked = Test-ListViewItemChecked -Window $Window -Index $selectedIndex
	}

	return [pscustomobject]@{
		found = $true
		itemCount = $itemCount
		searchApplied = $true
		checked = $checked
		selectedIndex = $selectedIndex
		selectedIndexBefore = $beforeSelectedIndex
		selectedItemRect = (Get-ListViewItemRect -Window $Window -Index $selectedIndex)
		selectedItemTexts = $selectedItemTexts
		textMatched = $textMatched
		checkAttempted = [bool]$CheckPreferredResult
		clicks = $clicks
	}
}

function Wait-PublicIpTarget {
	param(
		[string]$Target,
		[int]$TimeoutSeconds
	)

	$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
	$last = ''
	do {
		Start-Sleep -Seconds 2
		$last = Get-ObservedPublicIp
		if ($last -and $Target -and $last -eq $Target) {
			return [pscustomobject]@{
				publicIp = $last
				targetReached = $true
				changed = $true
				timedOut = $false
			}
		}
		$dialogEvents = @()
		try {
			$dialogEvents = @(Dismiss-HaiIpBlockingDialogs)
		} catch {
			$dialogEvents = @([pscustomobject]@{
				label = 'dismiss-haiip-dialog-error'
				kind = 'haiip-dialog-detect-error'
				text = $_.Exception.Message
				error = $_.Exception.Message
			})
		}
		if ($dialogEvents.Count -gt 0) {
			return [pscustomobject]@{
				publicIp = Get-ObservedPublicIp
				targetReached = $false
				changed = $false
				timedOut = $false
				retryableDialog = $true
				dialogKind = $dialogEvents[-1].kind
				dialogText = $dialogEvents[-1].text
				dialogEvents = $dialogEvents
			}
		}
	} while ((Get-Date) -lt $deadline)

	return [pscustomobject]@{
		publicIp = $last
		targetReached = $false
		changed = $false
		timedOut = $true
	}
}

function Wait-PublicIpChange {
	param(
		[string]$Before,
		[int]$TimeoutSeconds
	)

	$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
	$last = $Before
	do {
		Start-Sleep -Seconds 2
		$last = Get-ObservedPublicIp
		if ($last -and $Before -and $last -ne $Before) {
			return [pscustomobject]@{
				publicIp = $last
				changed = $true
				timedOut = $false
			}
		}
		$dialogEvents = @()
		try {
			$dialogEvents = @(Dismiss-HaiIpBlockingDialogs)
		} catch {
			$dialogEvents = @([pscustomobject]@{
				label = 'dismiss-haiip-dialog-error'
				kind = 'haiip-dialog-detect-error'
				text = $_.Exception.Message
				error = $_.Exception.Message
			})
		}
		if ($dialogEvents.Count -gt 0) {
			return [pscustomobject]@{
				publicIp = Get-ObservedPublicIp
				changed = $false
				timedOut = $false
				retryableDialog = $true
				dialogKind = $dialogEvents[-1].kind
				dialogText = $dialogEvents[-1].text
				dialogEvents = $dialogEvents
			}
		}
	} while ((Get-Date) -lt $deadline)

	return [pscustomobject]@{
		publicIp = $last
		changed = $false
		timedOut = $true
	}
}

function Append-ChangeLog {
	param([object]$Event)
	$resolved = if ([IO.Path]::IsPathRooted($LogPath)) { $LogPath } else { Join-Path (Get-Location) $LogPath }
	$dir = Split-Path -Parent $resolved
	if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
	($Event | ConvertTo-Json -Depth 8 -Compress) | Add-Content -Path $resolved
}

function Invoke-HaiIpChange {
	$window = Get-HaiIpWindowForChange
	Assert-CanDriveHaiIp -Window $window

	$beforeStatus = Get-HaiIpStatus
	$beforeIp = Get-HaiIpStatusPublicIpValue -Status $beforeStatus
	$clicks = @()
	$preferredIpValue = $PreferredIp.Trim()
	$preferredSelection = $null
	$preferredAttempted = [bool]$preferredIpValue
	$preferredUsed = $false
	$allowRandomFallback = $true
	$preferredFocusedResultSeen = $false
	$preferredDialogAllowsRandomFallback = $false
	$fallbackReason = ''

	if (-not $NoAllCheck) {
		$clicks += Ensure-HaiIpAllCheck -Window $window
	}

	$attempts = [Math]::Max(1, $Retries)
	$result = $null

	if ($preferredIpValue) {
		if ($beforeIp -eq $preferredIpValue) {
			$preferredUsed = $true
			$result = [pscustomobject]@{
				publicIp = $beforeIp
				targetReached = $true
				changed = $false
				timedOut = $false
				alreadyCurrent = $true
			}
		} else {
			try {
				$activationMethods = @('WMDoubleClick', 'WMDoubleClickTimeout', 'InputDoubleClick')
				$preferredActivationAttempts = [Math]::Max(1, $PreferredActivationRetries)
				for ($activationAttempt = 1; $activationAttempt -le $preferredActivationAttempts -and -not $preferredUsed; $activationAttempt += 1) {
					if ($activationAttempt -gt 1) {
						try { $clicks += Reset-HaiIpSearch -Window $window } catch {
							$clicks += [pscustomobject]@{
								label = 'reset-search-before-preferred-retry-error'
								attempt = $activationAttempt
								error = $_.Exception.Message
							}
						}
					}

					$preferredSelection = Select-PreferredIpInList -Window $window -Ip $preferredIpValue
					$clicks += $preferredSelection.clicks
					if (-not $preferredSelection.found) {
						$fallbackReason = "Preferred IP was not found in Hai-IP list: $preferredIpValue"
						continue
					}
					$preferredFocusedResultSeen = $true
					if (-not $preferredSelection.checked) {
						$preferredDialogAllowsRandomFallback = $true
						$fallbackReason = "Preferred IP search result was found but could not be checked: $preferredIpValue"
						continue
					}

					foreach ($activationMethod in $activationMethods) {
						try {
							$clicks += Invoke-SelectedListViewItemDoubleClick -Window $window -Method $activationMethod
							$result = Wait-PublicIpTarget -Target $preferredIpValue -TimeoutSeconds $PreferredWaitSeconds
							if ($result.targetReached) {
								$preferredUsed = $true
								break
							}
							if ($result.retryableDialog) {
								$clicks += $result.dialogEvents
								$preferredDialogAllowsRandomFallback = $true
								$fallbackReason = "Preferred IP activation blocked by Hai-IP dialog ($($result.dialogKind)): $($result.dialogText)"
								break
							}
							$fallbackReason = "Preferred IP row double-click via $activationMethod did not reach target: $preferredIpValue"
						} catch {
							$clicks += [pscustomobject]@{
								label = 'double-click-selected-ip-row-error'
								method = $activationMethod
								attempt = $activationAttempt
								error = $_.Exception.Message
							}
							$fallbackReason = "Preferred IP row double-click via $activationMethod failed: $($_.Exception.Message)"
						}
					}
					if ($preferredDialogAllowsRandomFallback) { break }
				}

				if (-not $preferredUsed -and $preferredSelection -and $preferredSelection.found -and -not $preferredDialogAllowsRandomFallback) {
					$allowRandomFallback = $false
					if (-not $fallbackReason) {
						$fallbackReason = "Preferred IP row was double-clicked but was not reached: $preferredIpValue"
					}
				}
				if (-not $preferredUsed -and $preferredFocusedResultSeen -and -not $preferredDialogAllowsRandomFallback) {
					$allowRandomFallback = $false
					if (-not $fallbackReason) {
						$fallbackReason = "Preferred IP focused row was seen, but double-click retries did not reach target: $preferredIpValue"
					}
				}
			} catch {
				if ($preferredSelection -and $preferredSelection.found) {
					$allowRandomFallback = $false
				}
				if ($preferredFocusedResultSeen) {
					$allowRandomFallback = $false
				}
				$fallbackReason = "Preferred IP selection failed: $($_.Exception.Message)"
			}
		}
	}

	if (-not $preferredUsed -and $allowRandomFallback) {
		if ($preferredIpValue) {
			try { $clicks += Reset-HaiIpSearch -Window $window } catch {}
		}
		try { $clicks += Ensure-HaiIpAllCheck -Window $window -ForceClickIfUnknown } catch {
			$clicks += [pscustomobject]@{
				label = 'all-check-before-random-fallback-error'
				error = $_.Exception.Message
			}
		}

		for ($attempt = 1; $attempt -le $attempts; $attempt += 1) {
			$randomBeforeIp = Get-ObservedPublicIp
			$buttonAttempt = Invoke-ChangeIpButtonOnce -Window $window -BeforeIp $randomBeforeIp
			$clicks += $buttonAttempt.clicks
			$result = $buttonAttempt.result
			if (-not $RequireChanged -or $result.changed) { break }
		}
	}

	$afterStatus = Get-HaiIpStatus
	$afterIp = Get-HaiIpStatusPublicIpValue -Status $afterStatus
	$targetReached = [bool]($preferredIpValue -and $afterIp -eq $preferredIpValue)
	$finalChanged = [bool]($beforeIp -and $afterIp -and $beforeIp -ne $afterIp)
	$ok = if ($preferredUsed -and $preferredIpValue) {
		$targetReached
	} else {
		(-not $RequireChanged) -or $finalChanged -or [bool]($result -and $result.changed)
	}
	$event = [pscustomobject]@{
		type = 'haiip-windows-ui-change'
		at = (Get-Date).ToString('o')
		ok = $ok
		requireChanged = [bool]$RequireChanged
		preferredIp = if ($preferredIpValue) { $preferredIpValue } else { $null }
		preferredAttempted = $preferredAttempted
		preferredUsed = $preferredUsed
		preferredTargetReached = $targetReached
		randomFallbackAllowed = $allowRandomFallback
		preferredDialogAllowsRandomFallback = $preferredDialogAllowsRandomFallback
		preferredFocusedResultSeen = $preferredFocusedResultSeen
		preferredSelection = $preferredSelection
		fallbackReason = if ($fallbackReason) { $fallbackReason } else { $null }
		beforePublicIp = $beforeIp
		afterPublicIp = $afterIp
		changed = $finalChanged
		waitResult = $result
		clicks = $clicks
		beforeWindowIp = $beforeStatus.controls.CurrentIp.text
		afterWindowIp = $afterStatus.controls.CurrentIp.text
		statusText = $afterStatus.controls.StatusText.text
		attempts = $attempts
	}
	Append-ChangeLog -Event $event

	if (-not $event.ok) {
		$event | ConvertTo-Json -Depth 8
		if ($preferredIpValue -and -not $preferredUsed -and $allowRandomFallback) {
			$reason = if ($fallbackReason) { " $fallbackReason" } else { '' }
			throw "Hai-IP random fallback after preferred IP failure did not change public IP.$reason"
		}
		if ($preferredIpValue) {
			throw "Hai-IP click completed, but preferred public IP was not reached: $preferredIpValue."
		}
		throw "Hai-IP click completed, but public IP did not change from $beforeIp."
	}

	return $event
}

if ($Command -eq 'status') {
	Get-HaiIpStatus | ConvertTo-Json -Depth 8
} elseif ($Command -eq 'change') {
	Invoke-HaiIpChange | ConvertTo-Json -Depth 8
}
