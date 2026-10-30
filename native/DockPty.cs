// Runs a command inside a Windows pseudo console (ConPTY), bridging it to stdin/stdout.
// Usage: DockPty.exe <cols> <rows> <cwd> <commandLine>
// stdin frames: [type:1][length:4 LE][payload]; type 0 = input bytes, type 1 = resize (cols:2 LE, rows:2 LE).
// stdout: raw terminal output. Exit code: the child's exit code.
using System;
using System.IO;
using System.Runtime.InteropServices;
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
    const int STARTF_USESTDHANDLES = 0x00000100;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const int JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
    const uint INFINITE = 0xFFFFFFFF;
    const byte FRAME_INPUT = 0;
    const byte FRAME_RESIZE = 1;
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

    [DllImport("kernel32.dll")]
    static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr process, out int exitCode);

    static IntPtr pseudoConsole;

    static int Main(string[] args)
    {
        Coord size = ToCoord(short.Parse(args[0]), short.Parse(args[1]));
        SafeFileHandle inputRead;
        SafeFileHandle inputWrite;
        SafeFileHandle outputRead;
        SafeFileHandle outputWrite;
        CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0);
        CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0);
        if (CreatePseudoConsole(size, inputRead, outputWrite, 0, out pseudoConsole) != 0)
        {
            return 90;
        }
        ProcessInformation process;
        if (!StartProcess(args[3], args[2], out process))
        {
            return 91;
        }
        inputRead.Dispose();
        outputWrite.Dispose();
        Thread output = StartThread(delegate { PumpOutput(outputRead); });
        StartThread(delegate { PumpInput(inputWrite); });
        WaitForSingleObject(process.hProcess, INFINITE);
        int exitCode;
        GetExitCodeProcess(process.hProcess, out exitCode);
        Thread.Sleep(150);
        ClosePseudoConsole(pseudoConsole);
        output.Join(2000);
        return exitCode;
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
        AssignProcessToJobObject(CreateKillOnCloseJob(), process.hProcess);
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
        JobExtendedLimitInformation info = new JobExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ref info, Marshal.SizeOf(typeof(JobExtendedLimitInformation)));
        return job;
    }

    static void PumpOutput(SafeFileHandle outputRead)
    {
        Stream stdout = Console.OpenStandardOutput();
        byte[] buffer = new byte[16384];
        using (FileStream source = new FileStream(outputRead, FileAccess.Read))
        {
            int read;
            while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
            {
                stdout.Write(buffer, 0, read);
                stdout.Flush();
            }
        }
    }

    static void PumpInput(SafeFileHandle inputWrite)
    {
        Stream stdin = Console.OpenStandardInput();
        using (FileStream target = new FileStream(inputWrite, FileAccess.Write))
        {
            byte[] header;
            while ((header = ReadExactly(stdin, 5)) != null)
            {
                byte[] payload = ReadExactly(stdin, BitConverter.ToInt32(header, 1));
                if (payload == null)
                {
                    break;
                }
                HandleFrame(header[0], payload, target);
            }
        }
        // stdin closed: the host is gone, and exiting closes the job, which ends the whole tree
        Environment.Exit(0);
    }

    static void HandleFrame(byte type, byte[] payload, FileStream target)
    {
        if (type == FRAME_INPUT)
        {
            target.Write(payload, 0, payload.Length);
            target.Flush();
        }
        else if (type == FRAME_RESIZE)
        {
            ResizePseudoConsole(pseudoConsole, ToCoord(BitConverter.ToInt16(payload, 0), BitConverter.ToInt16(payload, 2)));
        }
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
