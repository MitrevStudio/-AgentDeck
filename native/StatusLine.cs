// The status line command of a Claude Code session started from AgentDeck, on Windows: what
// src/host/claude-context-collector.js does, as a small program of its own. AgentDeck compiles it into its data folder
// (src/host/claude-context.js), so a status update starts neither AgentDeck's executable nor anything else in the
// install folder - which an update must be free to move away while sessions keep working.
// Usage: StatusLine.exe <launch file> [bash|powershell <path of that shell>], Claude Code's status JSON on stdin.
//
// It saves the context figures of the session (<directory>/<session id>.json, the same file the collector writes),
// then runs the user's own status line command in the shell that started it, with the same input, and ends with its
// exit code. With no command of the user's it prints a default line; with the status line switched off, nothing.
// Whatever goes wrong while saving never keeps the user's line from showing.
//
// AgentDeck removes the programs of earlier versions that nothing has used for a month, going by the time on the file:
// a program that runs sets its own to now, once a day at most.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

static class StatusLine
{
    const int MOVEFILE_REPLACE_EXISTING = 1;
    const int ERROR_FILE_NOT_FOUND = 2, ERROR_PATH_NOT_FOUND = 3;
    const uint FILE_WRITE_ATTRIBUTES = 0x100, FILE_SHARE_ALL = 7, OPEN_EXISTING = 3;
    const long UNIX_EPOCH_TICKS = 621355968000000000;
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool MoveFileEx(string from, string to, int flags);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFile(string file, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileTime(SafeFileHandle file, IntPtr created, IntPtr accessed, ref long written);

    static int Main(string[] args)
    {
        try
        {
            return args.Length < 1 ? 1 : Run(args[0], args.Length > 1 ? args[1] : "", args.Length > 2 ? args[2] : "");
        }
        catch (Exception e)
        {
            Console.Error.Write(e.Message);
            return 1;
        }
    }

    static void MarkUsed()
    {
        try
        {
            string self = Assembly.GetExecutingAssembly().Location;
            if ((DateTime.UtcNow - File.GetLastWriteTimeUtc(self)).TotalDays <= 1)
            {
                return;
            }
            // Only the right to change the times is asked for: a running program's file is not opened for writing.
            using (SafeFileHandle file = CreateFile(self, FILE_WRITE_ATTRIBUTES, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero))
            {
                long now = DateTime.UtcNow.ToFileTimeUtc();
                if (!file.IsInvalid)
                {
                    SetFileTime(file, IntPtr.Zero, IntPtr.Zero, ref now);
                }
            }
        }
        catch
        {
            // Only its removal comes sooner; the session's command then turns to AgentDeck's executable.
        }
    }

    static int Run(string configFile, string runner, string runnerPath)
    {
        MarkUsed();
        byte[] input = ReadAll(Console.OpenStandardInput());
        JsonObject config = Json.Parse(File.ReadAllText(configFile, Utf8)) as JsonObject;
        if (config == null)
        {
            throw new FormatException("The launch file is not an object");
        }
        object data = null;
        Snapshot context = null;
        try
        {
            data = Json.Parse(Utf8.GetString(input));
            if (data == null)
            {
                throw new FormatException("No status came");
            }
            context = GetContext(data, Now());
            Collect(data, context, config.Get("directory") as string);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("AgentDeck context: " + e.Message);
        }
        string command = GetDisplay(config, configFile);
        if (command == null)
        {
            return 0;
        }
        if (command.Length > 0)
        {
            return RunDisplay(config, command, runner, runnerPath, input);
        }
        if (Json.IsTruthy(data))
        {
            WriteDefaultLine(data, context);
        }
        return 0;
    }

    static byte[] ReadAll(Stream stream)
    {
        MemoryStream all = new MemoryStream();
        byte[] buffer = new byte[16 * 1024];
        for (int read; (read = stream.Read(buffer, 0, buffer.Length)) > 0;)
        {
            all.Write(buffer, 0, read);
        }
        return all.ToArray();
    }

    static double Now()
    {
        return (DateTime.UtcNow.Ticks - UNIX_EPOCH_TICKS) / TimeSpan.TicksPerMillisecond;
    }

    // ---------- the figures (session-context.js: statusLine, snapshot) ----------
    sealed class Snapshot
    {
        public double? Tokens;
        public double At, ExpiresAt;
        public JsonNumber Window, Percent;
        public string Model, Status;
        public bool HasCache, Warm;
    }

    // A count or a size: a number that is not negative, or nothing.
    static JsonNumber GetCount(object value)
    {
        JsonNumber number = value as JsonNumber;
        return number != null && number.Value >= 0 && !double.IsInfinity(number.Value) ? number : null;
    }

    static double Sum(params object[] values)
    {
        double sum = 0;
        foreach (object value in values)
        {
            JsonNumber count = GetCount(value);
            sum += count == null ? 0 : count.Value;
        }
        return sum;
    }

    // Null for what is not a measurement of the session itself: no context window, or a subagent's or a task's.
    static Snapshot GetContext(object data, double at)
    {
        object window = Json.Get(data, "context_window");
        if (!Json.IsTruthy(window) || Json.IsTruthy(Json.Get(Json.Get(data, "agent"), "id")) || Json.IsTruthy(Json.Get(data, "task")))
        {
            return null;
        }
        object usage = Json.Get(window, "current_usage");
        object cache = Json.Get(data, "prompt_cache");
        bool reported = Json.IsTruthy(usage);
        Snapshot snapshot = new Snapshot();
        snapshot.Tokens = reported ? Sum(Json.Get(usage, "input_tokens"), Json.Get(usage, "cache_creation_input_tokens"), Json.Get(usage, "cache_read_input_tokens")) : (double?)null;
        snapshot.At = at;
        snapshot.Model = Json.ToText(Json.Get(Json.Get(data, "model"), "id"), "");
        snapshot.Window = GetCount(Json.Get(window, "context_window_size")) ?? new JsonNumber(0, "0");
        snapshot.Status = reported ? "reported" : "pending";
        snapshot.Percent = reported ? GetCount(Json.Get(window, "used_percentage")) : null;
        snapshot.HasCache = Json.IsTruthy(cache);
        snapshot.Warm = Equals(Json.Get(cache, "warm"), true);
        snapshot.ExpiresAt = Sum(Json.Get(cache, "expires_at")) * 1000;
        return snapshot;
    }

    static string Serialize(string sessionId, Snapshot c)
    {
        StringBuilder text = new StringBuilder();
        text.Append("{\"sessionId\":").Append(Json.Quote(sessionId)).Append(",\"context\":{");
        text.Append("\"tokens\":").Append(c.Tokens == null ? "null" : Json.Format(c.Tokens.Value));
        text.Append(",\"at\":").Append(Json.Format(c.At));
        text.Append(",\"model\":").Append(Json.Quote(c.Model));
        text.Append(",\"provider\":\"\"");
        text.Append(",\"window\":").Append(c.Window.Text);
        text.Append(",\"exact\":").Append(c.Window.Value > 0 ? "true" : "false");
        text.Append(",\"source\":\"claude-statusline\"");
        text.Append(",\"status\":").Append(Json.Quote(c.Status));
        text.Append(",\"percent\":").Append(c.Percent == null ? "null" : c.Percent.Text);
        text.Append(",\"cache\":");
        if (c.HasCache)
        {
            text.Append("{\"warm\":").Append(c.Warm ? "true" : "false").Append(",\"expiresAt\":").Append(Json.Format(c.ExpiresAt)).Append('}');
        }
        else
        {
            text.Append("null");
        }
        text.Append(",\"warmUntil\":").Append(Json.Format(c.HasCache && c.Warm ? c.ExpiresAt : 0));
        return text.Append("}}").ToString();
    }

    static bool IsSessionId(string id)
    {
        if (id == null || id.Length < 1 || id.Length > 200)
        {
            return false;
        }
        foreach (char c in id)
        {
            if (!(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-'))
            {
                return false;
            }
        }
        return true;
    }

    static bool IsSubagent(string transcript)
    {
        const string name = "subagents";
        for (int at = 1; transcript != null && (at = transcript.IndexOf(name, at, StringComparison.Ordinal)) > 0; at++)
        {
            int end = at + name.Length;
            if ((transcript[at - 1] == '\\' || transcript[at - 1] == '/') && end < transcript.Length && (transcript[end] == '\\' || transcript[end] == '/'))
            {
                return true;
            }
        }
        return false;
    }

    static void Collect(object data, Snapshot context, string directory)
    {
        string id = Json.Get(data, "session_id") as string;
        if (context == null || !IsSessionId(id) || IsSubagent(Json.Get(data, "transcript_path") as string))
        {
            return;
        }
        if (string.IsNullOrEmpty(directory))
        {
            throw new FormatException("The launch file names no folder");
        }
        WriteFile(directory, id + ".json", Serialize(id, context));
    }

    // Written under another name and renamed, so a reader never sees half a file. The other name is a short one: with
    // the longest session id the file's own path is longer than this runtime's file calls take, and only the rename,
    // which is Windows' own, is given it.
    static void WriteFile(string directory, string name, string contents)
    {
        Directory.CreateDirectory(directory);
        string temp = Path.Combine(directory, Guid.NewGuid().ToString() + ".tmp");
        string file = directory.TrimEnd('\\', '/') + "\\" + name;
        if (file.Length > 2 && file[1] == ':' && file.IndexOf('/') < 0)
        {
            file = "\\\\?\\" + file;
        }
        try
        {
            File.WriteAllText(temp, contents, Utf8);
            if (!MoveFileEx(temp, file, MOVEFILE_REPLACE_EXISTING))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            File.Delete(temp);
        }
    }

    // ---------- the user's own status line (claude-context.js: settingsFiles, settingsStamp, originalStatusLine) ----------
    static List<string> GetSettingsFiles(string cwd, string home)
    {
        string configDir = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR");
        if (string.IsNullOrEmpty(configDir))
        {
            configDir = Path.Combine(home, ".claude");
        }
        List<string> files = new List<string>();
        // The folder without a separator at its end, which a drive's own folder keeps.
        string folder = Path.GetFullPath(cwd).TrimEnd('\\', '/');
        for (string dir = folder.EndsWith(":") ? folder + "\\" : folder; dir != null; dir = Path.GetDirectoryName(dir))
        {
            files.Insert(0, Path.Combine(dir, ".claude", "settings.local.json"));
            files.Insert(0, Path.Combine(dir, ".claude", "settings.json"));
        }
        files.Insert(0, Path.Combine(configDir, "settings.json"));
        return files;
    }

    // Size and time of each of them, as the collector writes it: whole milliseconds, which both can tell.
    static string GetStamp(List<string> files)
    {
        StringBuilder stamp = new StringBuilder();
        for (int i = 0; i < files.Count; i++)
        {
            stamp.Append(i > 0 ? "|" : "");
            FileInfo info = new FileInfo(files[i]);
            if (info.Exists)
            {
                long ms = (info.LastWriteTimeUtc.Ticks - UNIX_EPOCH_TICKS) / TimeSpan.TicksPerMillisecond;
                stamp.Append(info.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(ms.ToString(CultureInfo.InvariantCulture));
            }
        }
        return stamp.ToString();
    }

    // The user's own status line command ("" when they have none), or null when they switched the status line off.
    // Their settings are read again only when one of the files changed since the launch or the last update; the launch
    // file then keeps what was found, for the updates after it.
    static string GetDisplay(JsonObject config, string configFile)
    {
        try
        {
            string home = config.Get("home") as string;
            List<string> files = GetSettingsFiles((string)config.Get("cwd"), home ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
            string seen = GetStamp(files);
            if (seen != config.Get("seen") as string)
            {
                bool found = false;
                object original = null;
                foreach (string file in files)
                {
                    string text;
                    try
                    {
                        text = File.ReadAllText(file, Utf8);
                    }
                    catch (FileNotFoundException)
                    {
                        continue;
                    }
                    catch (DirectoryNotFoundException)
                    {
                        continue;
                    }
                    object settings = Json.Parse(text);
                    if (settings == null)
                    {
                        throw new FormatException("Settings that are not an object");
                    }
                    JsonObject group = settings as JsonObject;
                    if (group != null && group.Has("statusLine"))
                    {
                        found = true;
                        original = group.Get("statusLine");
                    }
                }
                JsonObject next = config.Clone();
                next.Set("seen", seen);
                next.Set("off", found && original == null);
                next.Set("command", Json.Get(original, "command") as string ?? "");
                WriteFile(Path.GetDirectoryName(Path.GetFullPath(configFile)), Path.GetFileName(configFile), Json.Serialize(next));
                config = next;
            }
        }
        catch
        {
            // Keep the last readable display command.
        }
        return Json.IsTruthy(config.Get("off")) ? null : Json.ToText(config.Get("command"), "");
    }

    // The shells to try for the user's command. The half of the status line command that started this program names its
    // shell and where it is: the one Claude Code itself would run that command in. The shell found at the launch serves
    // when that one is not there.
    static List<string> GetShells(JsonObject config, string kind, string runnerPath)
    {
        List<string> programs = new List<string>();
        string found = config.Get("shellKind") as string == kind ? config.Get("shell") as string : null;
        foreach (string program in new string[] { runnerPath, found, kind == "powershell" ? "powershell.exe" : "bash" })
        {
            if (!string.IsNullOrEmpty(program) && !programs.Contains(program))
            {
                programs.Add(program);
            }
        }
        return programs;
    }

    static int RunDisplay(JsonObject config, string command, string runner, string runnerPath, byte[] input)
    {
        string kind = runner.Length > 0 ? runner : config.Get("shellKind") as string;
        string arguments = (kind == "powershell" ? "-NoProfile -NonInteractive -Command " : "-c ") + QuoteArgument(command);
        // The user's command must not take whatever it starts for AgentDeck's executable running as Node.
        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", null);
        foreach (string program in GetShells(config, kind, runner.Length > 0 ? runnerPath : ""))
        {
            ProcessStartInfo start = new ProcessStartInfo(program, arguments);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            Process shell;
            try
            {
                shell = Process.Start(start);
            }
            catch (Win32Exception e)
            {
                if (e.NativeErrorCode == ERROR_FILE_NOT_FOUND || e.NativeErrorCode == ERROR_PATH_NOT_FOUND)
                {
                    continue;
                }
                return 1;
            }
            // The bytes as they came, through the stream: the writer over it would put its own encoding's mark first.
            Stream stdin = shell.StandardInput.BaseStream;
            try
            {
                stdin.Write(input, 0, input.Length);
            }
            catch (IOException)
            {
                // A command that does not read its input.
            }
            try
            {
                stdin.Close();
            }
            catch (IOException)
            {
            }
            shell.WaitForExit();
            return shell.ExitCode;
        }
        return 1;
    }

    // One argument of a Windows command line, as the C runtime of the program started reads it back.
    static string QuoteArgument(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0)
        {
            return argument;
        }
        StringBuilder quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in argument)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            // Backslashes count as themselves except in front of a quote, where each needs another.
            quoted.Append('\\', c == '"' ? backslashes * 2 + 1 : backslashes).Append(c);
            backslashes = 0;
        }
        return quoted.Append('\\', backslashes * 2).Append('"').ToString();
    }

    static void WriteDefaultLine(object data, Snapshot context)
    {
        StringBuilder line = new StringBuilder(Json.ToText(Json.Get(Json.Get(data, "model"), "display_name"), "Claude"));
        if (context != null && context.Tokens != null)
        {
            line.Append(" · ").Append(context.Tokens.Value.ToString("N0", CultureInfo.CurrentCulture)).Append(" tokens");
            if (context.Percent != null)
            {
                line.Append(" · ").Append(Json.Format(Math.Floor(context.Percent.Value + 0.5))).Append('%');
            }
        }
        byte[] bytes = Utf8.GetBytes(line.Append('\n').ToString());
        using (Stream stdout = Console.OpenStandardOutput())
        {
            stdout.Write(bytes, 0, bytes.Length);
        }
    }
}

// A number and how it was written, so one that is only passed on stays the same number.
sealed class JsonNumber
{
    public readonly double Value;
    public readonly string Text;

    public JsonNumber(double value, string text)
    {
        Value = value;
        Text = text;
    }
}

// A JSON object with its keys in the order they came in.
sealed class JsonObject
{
    readonly List<string> keys = new List<string>();
    readonly Dictionary<string, object> values = new Dictionary<string, object>(StringComparer.Ordinal);

    public IEnumerable<string> Keys { get { return keys; } }

    public bool Has(string key)
    {
        return values.ContainsKey(key);
    }

    public object Get(string key)
    {
        object value;
        return values.TryGetValue(key, out value) ? value : null;
    }

    public void Set(string key, object value)
    {
        if (!values.ContainsKey(key))
        {
            keys.Add(key);
        }
        values[key] = value;
    }

    public JsonObject Clone()
    {
        JsonObject copy = new JsonObject();
        foreach (string key in keys)
        {
            copy.Set(key, values[key]);
        }
        return copy;
    }
}

// JSON values: null, bool, string, JsonNumber, List<object>, JsonObject.
static class Json
{
    const int MAX_DEPTH = 200;

    public static object Get(object value, string key)
    {
        JsonObject group = value as JsonObject;
        return group == null ? null : group.Get(key);
    }

    // What JavaScript takes for true: the collector decides with it, and this must decide the same.
    public static bool IsTruthy(object value)
    {
        if (value == null)
        {
            return false;
        }
        if (value is bool)
        {
            return (bool)value;
        }
        JsonNumber number = value as JsonNumber;
        if (number != null)
        {
            return number.Value != 0;
        }
        string text = value as string;
        return text == null || text.Length > 0;
    }

    public static string ToText(object value, string fallback)
    {
        if (!IsTruthy(value))
        {
            return fallback;
        }
        JsonNumber number = value as JsonNumber;
        return value as string ?? (number != null ? Format(number.Value) : value is bool ? "true" : "[object Object]");
    }

    public static string Format(double value)
    {
        if (Math.Floor(value) == value && Math.Abs(value) < 9e15)
        {
            return ((long)value).ToString(CultureInfo.InvariantCulture);
        }
        string text = value.ToString("R", CultureInfo.InvariantCulture);
        return double.Parse(text, CultureInfo.InvariantCulture) == value ? text : value.ToString("G17", CultureInfo.InvariantCulture);
    }

    public static string Quote(string text)
    {
        StringBuilder quoted = new StringBuilder("\"");
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            bool pair = char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]);
            if (c == '"' || c == '\\')
            {
                quoted.Append('\\').Append(c);
            }
            else if (c == '\n')
            {
                quoted.Append("\\n");
            }
            else if (c == '\r')
            {
                quoted.Append("\\r");
            }
            else if (c == '\t')
            {
                quoted.Append("\\t");
            }
            else if (c < ' ' || char.IsSurrogate(c) && !pair)
            {
                quoted.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            }
            else
            {
                quoted.Append(c);
                if (pair)
                {
                    quoted.Append(text[++i]);
                }
            }
        }
        return quoted.Append('"').ToString();
    }

    public static string Serialize(object value)
    {
        StringBuilder text = new StringBuilder();
        Write(text, value);
        return text.ToString();
    }

    static void Write(StringBuilder text, object value)
    {
        JsonObject group = value as JsonObject;
        List<object> list = value as List<object>;
        JsonNumber number = value as JsonNumber;
        if (group != null)
        {
            text.Append('{');
            foreach (string key in group.Keys)
            {
                text.Append(text[text.Length - 1] == '{' ? "" : ",").Append(Quote(key)).Append(':');
                Write(text, group.Get(key));
            }
            text.Append('}');
        }
        else if (list != null)
        {
            text.Append('[');
            for (int i = 0; i < list.Count; i++)
            {
                text.Append(i > 0 ? "," : "");
                Write(text, list[i]);
            }
            text.Append(']');
        }
        else if (number != null)
        {
            text.Append(number.Text);
        }
        else if (value is string)
        {
            text.Append(Quote((string)value));
        }
        else
        {
            text.Append(value == null ? "null" : (bool)value ? "true" : "false");
        }
    }

    public static object Parse(string text)
    {
        int at = 0;
        object value = ParseValue(text, ref at, 0);
        SkipSpace(text, ref at);
        if (at < text.Length)
        {
            throw new FormatException("Unexpected text after the JSON at " + at);
        }
        return value;
    }

    static void SkipSpace(string text, ref int at)
    {
        while (at < text.Length && (text[at] == ' ' || text[at] == '\t' || text[at] == '\n' || text[at] == '\r'))
        {
            at++;
        }
    }

    static FormatException Unexpected(string text, int at)
    {
        return new FormatException(at < text.Length ? "Unexpected '" + text[at] + "' in the JSON at " + at : "The JSON ends early");
    }

    static object ParseValue(string text, ref int at, int depth)
    {
        SkipSpace(text, ref at);
        if (at >= text.Length || depth > MAX_DEPTH)
        {
            throw Unexpected(text, at);
        }
        char c = text[at];
        if (c == '{')
        {
            JsonObject group = new JsonObject();
            at++;
            SkipSpace(text, ref at);
            while (at >= text.Length || text[at] != '}')
            {
                if (at >= text.Length || text[at] != '"')
                {
                    throw Unexpected(text, at);
                }
                string key = ParseString(text, ref at);
                SkipSpace(text, ref at);
                if (at >= text.Length || text[at++] != ':')
                {
                    throw Unexpected(text, at - 1);
                }
                group.Set(key, ParseValue(text, ref at, depth + 1));
                SkipSpace(text, ref at);
                if (at < text.Length && text[at] == ',')
                {
                    at++;
                    SkipSpace(text, ref at);
                    if (at < text.Length && text[at] == '}')
                    {
                        throw Unexpected(text, at);
                    }
                }
                else if (at >= text.Length || text[at] != '}')
                {
                    throw Unexpected(text, at);
                }
            }
            at++;
            return group;
        }
        if (c == '[')
        {
            List<object> list = new List<object>();
            at++;
            SkipSpace(text, ref at);
            while (at >= text.Length || text[at] != ']')
            {
                list.Add(ParseValue(text, ref at, depth + 1));
                SkipSpace(text, ref at);
                if (at < text.Length && text[at] == ',')
                {
                    at++;
                    SkipSpace(text, ref at);
                    if (at < text.Length && text[at] == ']')
                    {
                        throw Unexpected(text, at);
                    }
                }
                else if (at >= text.Length || text[at] != ']')
                {
                    throw Unexpected(text, at);
                }
            }
            at++;
            return list;
        }
        if (c == '"')
        {
            return ParseString(text, ref at);
        }
        foreach (string word in new string[] { "true", "false", "null" })
        {
            if (string.CompareOrdinal(text, at, word, 0, word.Length) == 0)
            {
                at += word.Length;
                return word == "null" ? null : (object)(word == "true");
            }
        }
        return ParseNumber(text, ref at);
    }

    static bool SkipDigits(string text, ref int at)
    {
        int start = at;
        while (at < text.Length && text[at] >= '0' && text[at] <= '9')
        {
            at++;
        }
        return at > start;
    }

    // Only what JSON calls a number, as its text is also written out again.
    static JsonNumber ParseNumber(string text, ref int at)
    {
        int start = at;
        at += at < text.Length && text[at] == '-' ? 1 : 0;
        int whole = at;
        bool valid = SkipDigits(text, ref at) && (at - whole == 1 || text[whole] != '0');
        if (valid && at < text.Length && text[at] == '.')
        {
            at++;
            valid = SkipDigits(text, ref at);
        }
        if (valid && at < text.Length && (text[at] == 'e' || text[at] == 'E'))
        {
            at++;
            at += at < text.Length && (text[at] == '+' || text[at] == '-') ? 1 : 0;
            valid = SkipDigits(text, ref at);
        }
        double number;
        string written = text.Substring(start, at - start);
        if (!valid || !double.TryParse(written, NumberStyles.Float, CultureInfo.InvariantCulture, out number))
        {
            throw Unexpected(text, start);
        }
        return new JsonNumber(number, number == 0 ? "0" : written);
    }

    static string ParseString(string text, ref int at)
    {
        StringBuilder value = new StringBuilder();
        for (at++; at < text.Length; at++)
        {
            char c = text[at];
            if (c == '"')
            {
                at++;
                return value.ToString();
            }
            if (c != '\\')
            {
                value.Append(c);
                continue;
            }
            if (++at >= text.Length)
            {
                break;
            }
            int escape = "\"\\/bfnrt".IndexOf(text[at]);
            ushort code;
            if (escape >= 0)
            {
                value.Append("\"\\/\b\f\n\r\t"[escape]);
            }
            else if (text[at] == 'u' && at + 4 < text.Length && ushort.TryParse(text.Substring(at + 1, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code))
            {
                value.Append((char)code);
                at += 4;
            }
            else
            {
                throw Unexpected(text, at);
            }
        }
        throw Unexpected(text, at);
    }
}
