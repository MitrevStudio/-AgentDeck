# "Move here": stops a Claude Code process in another terminal and switches off the terminal modes it left on (or
# that tab prints escape codes). Run with -EncodedCommand, $ClaudePid, $ClaudeStart (its procStart from the live
# registry, '' when unknown) and $AgentDeckPid set in front.
# Exit: 0 stopped, 3 not Claude (the session's process is gone), 4 AgentDeck runs inside the session, 1 error

$ErrorActionPreference = 'Stop'
$resetModes = (@('?1000l', '?1002l', '?1003l', '?1006l', '?1015l', '?1004l', '?2004l', '<u', '<u', '<u', '>4m', '?1049l', '?25h', '0m') |
    ForEach-Object { [char]27 + '[' + $_ }) -join ''

function Import-Native
{
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class StopNative
{
    [DllImport("kernel32.dll")]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll")]
    public static extern bool AttachConsole(uint pid);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll")]
    public static extern bool GetConsoleMode(IntPtr handle, out uint mode);

    [DllImport("kernel32.dll")]
    public static extern bool SetConsoleMode(IntPtr handle, uint mode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern bool WriteConsole(IntPtr handle, string text, uint length, out uint written, IntPtr reserved);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
}
'@
}

# A child counts only when it started after its parent: Windows keeps a dead parent's id in ParentProcessId, so an
# unrelated older process can carry a recycled one.
function Get-ProcessTree($rootId)
{
    $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate
    $byId = @{}
    $all | ForEach-Object { $byId[[int]$_.ProcessId] = $_ }
    $ids = @($rootId)
    for ($i = 0; $i -lt $ids.Count; $i++)
    {
        $parent = $byId[[int]$ids[$i]]
        $ids += @($all | Where-Object { $_.ParentProcessId -eq $ids[$i] -and $parent -and $_.CreationDate -ge $parent.CreationDate } | ForEach-Object { [int]$_.ProcessId })
    }
    return $ids
}

function Stop-Tree($ids)
{
    [array]::Reverse($ids)
    $ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 40 -and (Get-Process -Id $ClaudePid -ErrorAction SilentlyContinue); $i++)
    {
        Start-Sleep -Milliseconds 200
    }
}

function Write-ConsoleText($text)
{
    # GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING
    $handle = [StopNative]::CreateFile('CONOUT$', [uint32]3221225472, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
    $mode = 0
    [void][StopNative]::GetConsoleMode($handle, [ref]$mode)
    [void][StopNative]::SetConsoleMode($handle, $mode -bor 0x4)
    $written = 0
    [void][StopNative]::WriteConsole($handle, $text, $text.Length, [ref]$written, [IntPtr]::Zero)
    [void][StopNative]::CloseHandle($handle)
}

try
{
    # A recycled pid: started at another time than the registry says, it is not the session's process any more.
    $process = Get-Process -Id $ClaudePid -ErrorAction SilentlyContinue
    if (-not $process -or $process.ProcessName -notmatch '^(claude|node|bun)$' -or
        ($ClaudeStart -and [string]$process.StartTime.ToFileTimeUtc() -ne $ClaudeStart))
    {
        exit 3
    }
    # AgentDeck started from inside the session (npm start in its shell) would go down with it.
    $ids = @(Get-ProcessTree $ClaudePid)
    if ($ids -contains $AgentDeckPid)
    {
        exit 4
    }
    Import-Native
    [void][StopNative]::FreeConsole()
    $attached = [StopNative]::AttachConsole($ClaudePid)
    Stop-Tree $ids
    if ($attached)
    {
        Write-ConsoleText "$resetModes`r`n[This session was moved to AgentDeck]`r`n"
        [void][StopNative]::FreeConsole()
    }
    exit 0
}
catch
{
    exit 1
}
