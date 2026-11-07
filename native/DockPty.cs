// Runs a command inside a Windows pseudo console (ConPTY) and serves it on a named pipe, so the terminal outlives the
// app that shows it: AgentDeck starts this detached, attaches over the pipe, and can let go of it and attach again
// later (after a restart or an update) while the program keeps running.
// Usage: DockPty.exe --pipe <id> <cols> <rows> <cwd> <commandLine> starts the host (the same arguments with --serve)
// as a process of its own and prints its process id. The environment variable AGENTDECK_PIPE_TOKEN holds a secret the
// hello repeats, so AgentDeck knows the pipe is the host's and not one made under the same name.
//
// Pipe \\.\pipe\agentdeck-term-<id>: the current user only, one client at a time. Frames both ways:
// [type:1][length:4 LE][payload].
//   client -> host: 0 input bytes, 1 resize (cols:2 LE, rows:2 LE), 2 kill (ends the program tree).
//   host -> client: 0 output bytes, 1 exited (code:4 LE), 2 hello (JSON: v, id, pid, token, cols, rows). A client gets
//   the hello, then the last RING_SIZE bytes of output (behind the terminal modes switched before them), then the live
//   output.
// The program runs in a kill-on-close job only this process holds, so it ends with this process. This process ends
// when the program does, or on a kill frame - never because a client went away.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class DockPty
{
    [StructLayout(LayoutKind.Sequential)]
    struct Coord
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JobBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JobExtendedLimitInformation
    {
        public JobBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint DETACHED_PROCESS = 0x00000008;
    const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    const int STARTF_USESTDHANDLES = 0x00000100;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const int JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
    const uint INFINITE = 0xFFFFFFFF;
    const int PROTOCOL = 1;
    const int RING_SIZE = 512 * 1024;
    const int MAX_FRAME = 16 * 1024 * 1024;
    const string TOKEN_VARIABLE = "AGENTDECK_PIPE_TOKEN";
    const byte FRAME_INPUT = 0, FRAME_RESIZE = 1, FRAME_KILL = 2;
    const byte FRAME_OUTPUT = 0, FRAME_EXITED = 1, FRAME_HELLO = 2;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = (IntPtr)0x00020016;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out SafeFileHandle readPipe, out SafeFileHandle writePipe, IntPtr attributes, int size);

    [DllImport("kernel32.dll")]
    static extern int CreatePseudoConsole(Coord size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr console);

    [DllImport("kernel32.dll")]
    static extern int ResizePseudoConsole(IntPtr console, Coord size);

    [DllImport("kernel32.dll")]
    static extern void ClosePseudoConsole(IntPtr console);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JobExtendedLimitInformation info, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr process, out int exitCode);

    static IntPtr pseudoConsole;
    static string id, token;
    static short cols, rows;
    // Guarded by `gate`: output is kept and sent to the client in one step, so a client attaching gets each byte exactly
    // once (in the replay or live).
    static readonly object gate = new object();
    static readonly byte[] ring = new byte[RING_SIZE];
    static int ringStart, ringCount;
    static bool ringWrapped;
    // The terminal modes as the output that left the ring left them.
    static readonly ModeScanner evictedModes = new ModeScanner();
    static NamedPipeServerStream client;

    static int Main(string[] args)
    {
        if (args.Length == 6 && args[0] == "--pipe")
        {
            return Relaunch();
        }
        if (args.Length != 6 || args[0] != "--serve")
        {
            return 92;
        }
        id = args[1];
        cols = short.Parse(args[2]);
        rows = short.Parse(args[3]);
        // Read and dropped before the program starts: it inherits this environment.
        token = Environment.GetEnvironmentVariable(TOKEN_VARIABLE) ?? "";
        Environment.SetEnvironmentVariable(TOKEN_VARIABLE, null);
        NamedPipeServerStream server = CreateServer("agentdeck-term-" + id);
        SafeFileHandle inputRead;
        SafeFileHandle inputWrite;
        SafeFileHandle outputRead;
        SafeFileHandle outputWrite;
        CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0);
        CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0);
        if (CreatePseudoConsole(ToCoord(cols, rows), inputRead, outputWrite, 0, out pseudoConsole) != 0)
        {
            return 90;
        }
        ProcessInformation process;
        if (!StartProcess(args[5], args[4], out process))
        {
            return 91;
        }
        inputRead.Dispose();
        outputWrite.Dispose();
        FileStream input = new FileStream(inputWrite, FileAccess.Write);
        Thread output = StartThread(delegate { PumpOutput(outputRead); });
        StartThread(delegate { Serve(server, input); });
        WaitForSingleObject(process.hProcess, INFINITE);
        int exitCode;
        GetExitCodeProcess(process.hProcess, out exitCode);
        Thread.Sleep(150);
        ClosePseudoConsole(pseudoConsole);
        output.Join(2000);
        SendExit(exitCode);
        return exitCode;
    }

    // The process AgentDeck starts inherits every inheritable handle AgentDeck has (Node starts children that way):
    // its sockets, pipes and files would stay open for as long as the terminal runs, long after AgentDeck is gone. So
    // it only starts the real host - the same exe with --serve, inheriting nothing, outside AgentDeck's job where
    // Windows allows - prints that process's id and ends. The environment (with the token) is passed on as it is.
    static int Relaunch()
    {
        string commandLine = Environment.CommandLine;
        int at = commandLine.IndexOf(" --pipe ", StringComparison.Ordinal);
        if (at < 0)
        {
            return 93;
        }
        StringBuilder serve = new StringBuilder(commandLine.Substring(0, at) + " --serve " + commandLine.Substring(at + 8));
        StartupInfoEx startupInfo = new StartupInfoEx();
        startupInfo.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfo));
        ProcessInformation process;
        uint flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
        if (!CreateProcessW(null, serve, IntPtr.Zero, IntPtr.Zero, false, flags | CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, null, ref startupInfo, out process)
            && !CreateProcessW(null, serve, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, null, ref startupInfo, out process))
        {
            return 94;
        }
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        Console.Out.Write(process.dwProcessId);
        Console.Out.Flush();
        return 0;
    }

    static Coord ToCoord(short cols, short rows)
    {
        Coord coord = new Coord();
        coord.X = cols;
        coord.Y = rows;
        return coord;
    }

    static Thread StartThread(ThreadStart work)
    {
        Thread thread = new Thread(work);
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    // Only the current user may open it (the default lets everyone read it, and with it the terminal's output), and a
    // single instance means a second client is turned away while one is attached.
    static NamedPipeServerStream CreateServer(string name)
    {
        SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
        PipeSecurity security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(user);
        security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.FullControl, AccessControlType.Allow));
        // Asynchronous (overlapped): one thread reads the pipe while another writes it, which a synchronous handle
        // would serialize.
        return new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, security);
    }

    static bool StartProcess(string commandLine, string cwd, out ProcessInformation process)
    {
        StartupInfoEx startupInfo = new StartupInfoEx();
        startupInfo.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
        // without this the child would inherit the bridge's redirected stdio instead of the pseudo console
        startupInfo.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startupInfo.lpAttributeList = CreateAttributeList();
        uint flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED;
        if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, cwd, ref startupInfo, out process))
        {
            return false;
        }
        // Outside its kill-on-close job the child could outlive this process (and a stopped terminal), so it never runs
        // without one.
        IntPtr job = CreateKillOnCloseJob();
        if (job == IntPtr.Zero || !AssignProcessToJobObject(job, process.hProcess))
        {
            TerminateProcess(process.hProcess, 1);
            return false;
        }
        ResumeThread(process.hThread);
        return true;
    }

    static IntPtr CreateAttributeList()
    {
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr list = Marshal.AllocHGlobal(size);
        InitializeProcThreadAttributeList(list, 1, 0, ref size);
        UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pseudoConsole, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero);
        return list;
    }

    static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            return IntPtr.Zero;
        }
        JobExtendedLimitInformation info = new JobExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ref info, Marshal.SizeOf(typeof(JobExtendedLimitInformation))))
        {
            CloseHandle(job);
            return IntPtr.Zero;
        }
        return job;
    }

    static void PumpOutput(SafeFileHandle outputRead)
    {
        byte[] buffer = new byte[16384];
        using (FileStream source = new FileStream(outputRead, FileAccess.Read))
        {
            int read;
            while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
            {
                byte[] chunk = new byte[read];
                Buffer.BlockCopy(buffer, 0, chunk, 0, read);
                lock (gate)
                {
                    Remember(chunk);
                    SendToClient(FRAME_OUTPUT, chunk);
                }
            }
        }
    }

    // One client after another, for as long as the program runs.
    static void Serve(NamedPipeServerStream server, FileStream input)
    {
        while (true)
        {
            try
            {
                server.WaitForConnection();
                lock (gate)
                {
                    WriteFrame(server, FRAME_HELLO, GetHello());
                    WriteFrame(server, FRAME_OUTPUT, GetReplay());
                    client = server;
                }
                ReadFrames(server, input);
            }
            catch (IOException)
            {
                // the client went away midway
            }
            lock (gate)
            {
                client = null;
                try
                {
                    server.Disconnect();
                }
                catch (InvalidOperationException)
                {
                }
                catch (IOException)
                {
                }
            }
        }
    }

    static void ReadFrames(Stream pipe, FileStream input)
    {
        byte[] header;
        while ((header = ReadExactly(pipe, 5)) != null)
        {
            int length = BitConverter.ToInt32(header, 1);
            byte[] payload = length >= 0 && length <= MAX_FRAME ? ReadExactly(pipe, length) : null;
            if (payload == null)
            {
                return;
            }
            HandleFrame(header[0], payload, input);
        }
    }

    static void HandleFrame(byte type, byte[] payload, FileStream input)
    {
        if (type == FRAME_INPUT)
        {
            input.Write(payload, 0, payload.Length);
            input.Flush();
        }
        else if (type == FRAME_RESIZE && payload.Length >= 4)
        {
            short c = BitConverter.ToInt16(payload, 0), r = BitConverter.ToInt16(payload, 2);
            if (c > 0 && r > 0)
            {
                lock (gate)
                {
                    cols = c;
                    rows = r;
                }
                ResizePseudoConsole(pseudoConsole, ToCoord(c, r));
            }
        }
        else if (type == FRAME_KILL)
        {
            // Exiting closes the job, which ends the whole program tree.
            Environment.Exit(0);
        }
    }

    // id is a GUID and token hex (AgentDeck makes both), so neither needs escaping.
    static byte[] GetHello()
    {
        string json = "{\"v\":" + PROTOCOL + ",\"id\":\"" + id + "\",\"pid\":" + Process.GetCurrentProcess().Id + ",\"token\":\"" + token
            + "\",\"cols\":" + cols + ",\"rows\":" + rows + "}";
        return Encoding.UTF8.GetBytes(json);
    }

    // The ring in order. Once output was dropped from it, it starts at its first escape sequence (so never inside one,
    // nor inside a character), behind the modes switched before that point: alternate screen, bracketed paste, mouse...
    static byte[] GetReplay()
    {
        byte[] kept = new byte[ringCount];
        int first = Math.Min(ringCount, RING_SIZE - ringStart);
        Buffer.BlockCopy(ring, ringStart, kept, 0, first);
        Buffer.BlockCopy(ring, 0, kept, first, ringCount - first);
        if (!ringWrapped)
        {
            return kept;
        }
        int from = Math.Max(0, Array.IndexOf(kept, (byte)0x1B));
        ModeScanner modes = evictedModes.Clone();
        for (int i = 0; i < from; i++)
        {
            modes.Feed(kept[i]);
        }
        byte[] prefix = modes.GetPrefix();
        byte[] replay = new byte[prefix.Length + kept.Length - from];
        Buffer.BlockCopy(prefix, 0, replay, 0, prefix.Length);
        Buffer.BlockCopy(kept, from, replay, prefix.Length, kept.Length - from);
        return replay;
    }

    static void Remember(byte[] data)
    {
        foreach (byte b in data)
        {
            if (ringCount < RING_SIZE)
            {
                ring[(ringStart + ringCount) % RING_SIZE] = b;
                ringCount++;
                continue;
            }
            evictedModes.Feed(ring[ringStart]);
            ring[ringStart] = b;
            ringStart = (ringStart + 1) % RING_SIZE;
            ringWrapped = true;
        }
    }

    // Callers hold `gate`. A client that went away is dropped here; Serve() notices too and waits for the next one.
    static void SendToClient(byte type, byte[] payload)
    {
        if (client == null)
        {
            return;
        }
        try
        {
            WriteFrame(client, type, payload);
        }
        catch (Exception e)
        {
            if (!(e is IOException || e is ObjectDisposedException || e is InvalidOperationException))
            {
                throw;
            }
            client = null;
        }
    }

    static void WriteFrame(Stream pipe, byte type, byte[] payload)
    {
        byte[] frame = new byte[5 + payload.Length];
        frame[0] = type;
        BitConverter.GetBytes(payload.Length).CopyTo(frame, 1);
        Buffer.BlockCopy(payload, 0, frame, 5, payload.Length);
        pipe.Write(frame, 0, frame.Length);
        pipe.Flush();
    }

    // The exit code reaches an attached client before this process (and with it the pipe) ends; waited for briefly, so
    // a client that stopped reading cannot keep it alive.
    static void SendExit(int exitCode)
    {
        NamedPipeServerStream attached;
        lock (gate)
        {
            SendToClient(FRAME_EXITED, BitConverter.GetBytes(exitCode));
            attached = client;
        }
        if (attached == null)
        {
            return;
        }
        Thread drain = StartThread(delegate
        {
            try
            {
                attached.WaitForPipeDrain();
            }
            catch (Exception)
            {
                // gone already
            }
        });
        drain.Join(2000);
    }

    static byte[] ReadExactly(Stream stream, int length)
    {
        byte[] buffer = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            int read = stream.Read(buffer, offset, length - offset);
            if (read <= 0)
            {
                return null;
            }
            offset += read;
        }
        return buffer;
    }
}

// Follows the DEC private modes (ESC [ ? n ; m h|l) through a byte stream, so output that is dropped can be stood in for
// by the modes it left switched.
sealed class ModeScanner
{
    const int MAX_MODES = 64;
    int state; // 0 text, 1 after ESC, 2 after ESC [, 3 in ESC [ ? ...
    readonly StringBuilder digits = new StringBuilder();
    readonly List<string> order = new List<string>();
    readonly Dictionary<string, char> modes = new Dictionary<string, char>();

    public void Feed(byte b)
    {
        if (state == 3 && ((b >= (byte)'0' && b <= (byte)'9') || b == (byte)';'))
        {
            if (digits.Length < 64)
            {
                digits.Append((char)b);
            }
            return;
        }
        if (state == 3 && (b == (byte)'h' || b == (byte)'l'))
        {
            Apply((char)b);
        }
        if (state == 1 && b == (byte)'[')
        {
            state = 2;
        }
        else if (state == 2 && b == (byte)'?')
        {
            state = 3;
            digits.Length = 0;
        }
        else
        {
            state = b == 0x1B ? 1 : 0;
        }
    }

    void Apply(char set)
    {
        foreach (string mode in digits.ToString().Split(';'))
        {
            if (mode.Length == 0 || mode.Length > 5)
            {
                continue;
            }
            if (!modes.ContainsKey(mode))
            {
                if (order.Count >= MAX_MODES)
                {
                    continue;
                }
                order.Add(mode);
            }
            modes[mode] = set;
        }
    }

    public ModeScanner Clone()
    {
        ModeScanner copy = new ModeScanner();
        copy.state = state;
        copy.digits.Append(digits.ToString());
        copy.order.AddRange(order);
        foreach (KeyValuePair<string, char> pair in modes)
        {
            copy.modes[pair.Key] = pair.Value;
        }
        return copy;
    }

    public byte[] GetPrefix()
    {
        StringBuilder prefix = new StringBuilder();
        foreach (string mode in order)
        {
            prefix.Append("\x1b[?").Append(mode).Append(modes[mode]);
        }
        return Encoding.ASCII.GetBytes(prefix.ToString());
    }
}
