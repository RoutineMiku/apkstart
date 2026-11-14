# ApkStart window agent (ASCII only).
# A single long-lived helper that owns every Win32 trick we need:
#   * re-parents the Android emulator Qt window into an ApkStart BrowserWindow (one clean window,
#     no emulator sidebar, no emulator title bar);
#   * hides the floating emulator toolbar window that shows the volume/camera/back rail;
#   * rotates the device with Ctrl+Left / Ctrl+Right and reports the new window size;
#   * runs an opt-in WH_MOUSE_LL hook so right click becomes Android BACK, wheel
#     becomes a coalesced swipe, and (optionally) side buttons become BACK / FORWARD.
#     Left click is deliberately left alone: Qt already maps it to a finger tap.
# Everything is P/Invoke from the .NET Framework that ships with Windows 10/11,
# so there is no native binary to compile, sign or ship.
# Protocol: TCP on 127.0.0.1, one JSON object per line. First stdout line is "PORT=<n>".
param([int]$Port = 0)

$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class ApkAgent
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT Pt; public int MouseData; public int Flags; public int Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr Hwnd; public uint Message; public IntPtr WParam; public IntPtr LParam; public uint Time; public int X; public int Y; }
    // Minimal PROCESS_BASIC_INFORMATION: enough to read InheritedFromUniqueProcessId.
    [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr ParentPid; }

    public delegate bool EnumProc(IntPtr h, IntPtr p);
    public delegate IntPtr HookProc(int code, IntPtr wp, IntPtr lp);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr c, IntPtr p);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr c);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    // 裁剪嵌入窗口的可见区域：把压到标题栏上的那条外框去掉
    [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);

    const int GWL_STYLE = -16;
    const int GWL_EXSTYLE = -20;
    const uint WS_CHILD = 0x40000000;
    const uint WS_POPUP = 0x80000000;
    const int WS_CAPTION = 0x00C00000;
    const int WS_THICKFRAME = 0x00040000;
    const int WS_MINIMIZEBOX = 0x00020000;
    const int WS_MAXIMIZEBOX = 0x00010000;
    const int WS_SYSMENU = 0x00080000;
    const int WS_BORDER = 0x00800000;
    const int WS_CLIPCHILDREN = 0x02000000;
    const int WS_CLIPSIBLINGS = 0x04000000;
    const int WS_EX_APPWINDOW = 0x00040000;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int WS_EX_CLIENTEDGE = 0x00000200;
    const int WS_EX_WINDOWEDGE = 0x00000100;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_SHOWWINDOW = 0x0040;
    const uint SWP_FRAMECHANGED = 0x0020;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOSIZE = 0x0001;

    static IntPtr _host = IntPtr.Zero;
    static IntPtr _emu = IntPtr.Zero;
    static IntPtr _hook = IntPtr.Zero;
    static HookProc _hookProc = null;
    static Thread _hookThread = null;
    static volatile bool _hookRun = false;
    static uint _hookTid = 0;
    static readonly ManualResetEvent _hookReady = new ManualResetEvent(false);
    static readonly ConcurrentQueue<string> _events = new ConcurrentQueue<string>();
    static long _lastToolSweep = 0;
    static long _embedAt = 0;
    // 常驻压制：默认一开机就开，把模拟器主窗 + 工具栏 + 控制台黑窗压住。
    // 与「embed 完成就关掉」的旧逻辑不同，它是**常驻**的 —— sweep 会跳过已经嵌进
    // 我们窗口的那一个窗口，其余一律藏起来（含 ApkStart 退出后回到桌面的那个黑窗）。
    static volatile bool _quiet = true;
    static long _bootHideSweep = 0;
    // 兜底超时：万一 embed 没来（用户只是打开了 ApkStart 没点应用），
    // 不能让 120ms 一轮的扫描永远跑下去白烧 CPU。每次真藏到窗口就续期。
    static long _bootHideUntil = 0;
    static long _bootHideStart = Environment.TickCount;
    // 断线后的「守卫」截止时间（TickCount）。见 Serve() 里 sock == null 的分支。
    static long _lingerUntil = 0;

    // Which windows count as "ours": only those created by a process whose exe lives
    // inside one of these directories (the runtime root / bundled engine dir).
    // This is the whole fix for "ApkStart conflicts with WeChat": WeChat 4.x is Qt 6
    // too (its windows are QWindowIcon / QWindowToolSaveBits), so any matching that
    // relied on window class names alone could hide or even re-parent WeChat's own
    // windows. Class names are never unique; the owning process's path is.
    static readonly System.Collections.Generic.List<string> _scopeDirs = new System.Collections.Generic.List<string>();
    static readonly System.Collections.Generic.Dictionary<uint, bool> _oursCache = new System.Collections.Generic.Dictionary<uint, bool>();
    // PID of the ApkStart main process. The only window we are ever allowed to embed
    // into / swallow clicks for. Guard against a recycled HWND: if _host later belongs
    // to somebody else, the mouse hook must pass events through instead of eating them.
    static uint _appPid = 0;
    static uint _hostPid = 0;

    // Hook options. All three default to OFF: an "hook on" without options must
    // never swallow anybody's clicks. JS sends the real config on every enable.
    static volatile int _optRight = 0;
    static volatile int _optWheel = 0;
    static volatile int _optSide = 0;

    // Wheel coalescing: Qt would turn every single notch into a separate touch
    // gesture (visible stutter). We accumulate deltas for a short window and
    // hand one normalized position to the JS side, which injects a single swipe.
    static readonly object _wheelLock = new object();
    static int _wheelDx = 0, _wheelDy = 0;
    static double _wheelNx = 0.5, _wheelNy = 0.5;
    static long _wheelFirst = 0, _wheelLast = 0;

    // ------------------------------------------------------------------ ownership
    // Scope is set by the JS side before anything is hidden ("scope" command).
    // With no scope the agent refuses to touch any window: leaving one black console
    // around is a cosmetic bug, hiding a user's WeChat window is not.
    static void SetScope(string raw)
    {
        _scopeDirs.Clear();
        string[] pieces = (raw == null ? "" : raw).Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string piece in pieces)
        {
            string d = piece.Trim();
            if (d.Length == 0) continue;
            try { d = System.IO.Path.GetFullPath(d); } catch { }
            if (!d.EndsWith("\\")) d += "\\";
            _scopeDirs.Add(d.ToLowerInvariant());
        }
        lock (_oursCache) { _oursCache.Clear(); }
    }

    static bool IsOurs(uint pid)
    {
        if (pid == 0 || _scopeDirs.Count == 0) return false;
        lock (_oursCache)
        {
            bool hit;
            if (_oursCache.TryGetValue(pid, out hit)) return hit;
        }
        bool ours = false;
        try
        {
            using (Process p = Process.GetProcessById((int)pid))
            {
                string file = null;
                try { file = p.MainModule.FileName; } catch { file = null; }
                if (!string.IsNullOrEmpty(file))
                {
                    string low = file.ToLowerInvariant();
                    for (int i = 0; i < _scopeDirs.Count; i++)
                        if (low.StartsWith(_scopeDirs[i], StringComparison.Ordinal)) { ours = true; break; }
                }
            }
        }
        catch { ours = false; }
        lock (_oursCache)
        {
            // PIDs get recycled; a bounded cache is enough (one entry per live process).
            if (_oursCache.Count > 400) _oursCache.Clear();
            _oursCache[pid] = ours;
        }
        return ours;
    }

    static uint ParentOf(uint pid)
    {
        IntPtr h = IntPtr.Zero;
        try
        {
            h = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
            if (h == IntPtr.Zero) return 0;
            PBI pbi = new PBI();
            int len;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PBI)), out len) != 0) return 0;
            return (uint)pbi.ParentPid.ToInt64();
        }
        catch { return 0; }
        finally { if (h != IntPtr.Zero) CloseHandle(h); }
    }

    // Console windows belong to conhost.exe, not to the program that owns the console,
    // so the window pid is never the emulator's. Walk conhost's parents instead.
    static bool ConsoleOwnedByUs(uint pid)
    {
        uint p = ParentOf(pid);
        for (int i = 0; i < 3 && p != 0; i++)
        {
            if (IsOurs(p)) return true;
            p = ParentOf(p);
        }
        return false;
    }

    static bool IsOurConsole(IntPtr h)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (IsOurs(pid) || ConsoleOwnedByUs(pid)) return true;
        if (_scopeDirs.Count == 0) return false;
        // Windows titles a console with the image path it launched, so the runtime
        // directory shows up verbatim. Precise enough to never match a stray terminal.
        string title = TitleOf(h).ToLowerInvariant();
        for (int i = 0; i < _scopeDirs.Count; i++)
            if (title.IndexOf(_scopeDirs[i], StringComparison.Ordinal) >= 0) return true;
        return false;
    }

    // ------------------------------------------------------------------ window discovery
    static string ClassOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(h, sb, 256);
        return sb.ToString();
    }
    static string TitleOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        return sb.ToString();
    }

    // The emulator draws its framebuffer in a "QWindowIcon" top level window titled
    // "Android Emulator - <avd>:<port>"; the volume/rotate rail lives in a separate
    // small "QWindowTool*" window we hide.
    //
    // 注意：模拟器开机阶段（以及被常驻压制藏起来之后）这个窗口是**不可见**的，
    // 所以这里不能再按 IsWindowVisible 过滤 —— 否则永远找不到可嵌入的窗口，
    // 用户看到的是一个全黑的应用窗口。改为「标题是 Android Emulator 就认，
    // 可见的大窗口优先」。工具栏 / 提示窗（QWindowTool）尺寸太小，被面积阈值挡掉。
    static IntPtr FindEmulator()
    {
        IntPtr best = IntPtr.Zero;
        long bestScore = long.MinValue;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            // Ownership comes first. "QWindowIcon" is the class of EVERY Qt top level
            // window, and WeChat 4.x / MuMu / music players are Qt too -- matching on
            // the class alone is how the wrong window ended up hidden or re-parented.
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (!IsOurs(owner)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("QWindowIcon", StringComparison.Ordinal) < 0) return true;
            string title = TitleOf(h);
            bool named = title.IndexOf("Android Emulator", StringComparison.OrdinalIgnoreCase) >= 0;
            if (!named && !IsWindowVisible(h)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            long area = (long)(r.R - r.L) * (r.B - r.T);
            if (area < 200 * 200) return true;   // 工具栏 / 提示窗不是画面窗口
            // 可见的大窗口优先，其次才是隐藏的
            long score = area + (IsWindowVisible(h) ? 1000000000L : 0);
            if (score > bestScore) { bestScore = score; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    // 诊断用：列出顶层窗口（类别 / 标题 / pid / 尺寸 / 是否可见）。
    // 用于验证「打开软件只看到软件界面」——模拟器主窗、netsim 控制台都必须不在其中。
    static string ListWindows(bool includeHidden)
    {
        var sb = new StringBuilder();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            bool vis = IsWindowVisible(h);
            if (!vis && !includeHidden) return true;
            string cls = ClassOf(h);
            string title = TitleOf(h);
            // 隐藏窗口太多（系统里有成百上千个），只看跟模拟器/Qt 有关的
            if (!vis && cls.IndexOf("QWindow", StringComparison.Ordinal) < 0
                && title.IndexOf("Android Emulator", StringComparison.OrdinalIgnoreCase) < 0) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            int w = r.R - r.L, hh = r.B - r.T;
            if (vis && (w < 40 || hh < 40)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (sb.Length > 0) sb.Append(",");
            sb.Append("{\"cls\":").Append(JsonStr(cls))
              .Append(",\"title\":").Append(JsonStr(title))
              .Append(",\"pid\":").Append(pid)
              .Append(",\"w\":").Append(w)
              .Append(",\"h\":").Append(hh)
              .Append(",\"vis\":").Append(vis ? "true" : "false")
              .Append("}");
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    static void HideToolWindows()
    {
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("QWindowTool", StringComparison.Ordinal) < 0) return true;
            // QWindowToolSaveBits is what Qt uses for menus, tooltips and popup panels --
            // WeChat's emoji panel / right-click menu included. Only hide our own.
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (!IsOurs(owner)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if ((r.R - r.L) > 200) return true;   // the framebuffer window also uses this class
            ShowWindow(h, 0);
            return true;
        }, IntPtr.Zero);
    }

    // 开机阶段：把 qemu / emulator 的黑色控制台窗口藏起来，避免「命令窗口」闪现。
    // 它们是 console 子系统进程，Node 的 windowsHide 覆盖不到子进程，只能靠 Win32 周期压住。
    //
    // 关键坑：Windows 10 以后控制台窗口真正属于 conhost.exe，GetWindowThreadProcessId
    // 拿到的是 conhost 的 pid，不是 emulator 的 pid —— 老实现按 pid 白名单匹配，
    // 于是这些黑窗一个都藏不住（"点了没反应，先弹个 cmd 黑框"就是这么来的）。
    // 现在改成「pid 命中 或 窗口标题命中（标题就是被启动的 exe 路径）」，两条路任一生效即隐藏。
    static void HideConsoleWindows()
    {
        if (_scopeDirs.Count == 0) return;   // no scope: never touch anybody's terminal

        // 先扫一遍有哪些控制台窗口；一个都没有就别去枚举进程（GetProcessesByName 不便宜）
        var consoles = new System.Collections.Generic.List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0)
                consoles.Add(h);
            return true;
        }, IntPtr.Zero);
        if (consoles.Count == 0) return;

        // 老实现还有一条「标题里含 emulator / qemu / netsim 就算我们的」，
        // 那会把用户自己开的终端（标题是某个路径，比如 D://Android//emulator）也一起藏掉。
        // 现在只认两种证据：conhost 的父进程链能走到我们运行时目录里，
        // 或者标题里出现我们运行时目录的绝对路径（Windows 会把镜像路径当控制台标题）。
        foreach (IntPtr h in consoles)
        {
            if (IsOurConsole(h)) ShowWindow(h, 0);
        }
    }

    // 诊断用：列出当前「可见」的控制台窗口（黑窗）及其归属，供 tools 里的验证脚本使用。
    // ours=true 表示这就是 emulator/qemu 的控制台窗口。
    static string ListConsoles()
    {
        var sb = new StringBuilder();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            bool isConsole = cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0;
            if (!isConsole) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string title = TitleOf(h);
            bool ours = IsOurConsole(h);
            if (sb.Length > 0) sb.Append(",");
            sb.Append("{\"ours\":").Append(ours ? "true" : "false")
              .Append(",\"pid\":").Append(pid)
              .Append(",\"cls\":").Append(JsonStr(cls))
              .Append(",\"title\":").Append(JsonStr(title))
              .Append("}");
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    static string JsonStr(string s)
    {
        var b = new StringBuilder("\"");
        foreach (char c in s == null ? "" : s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c >= ' ') b.Append(c);
        }
        b.Append("\"");
        return b.ToString();
    }

    // 兜底：把「我们的运行时进程」创建的任何**多余的顶层可见窗口**都藏起来。
    // 除了模拟器主窗口（要嵌进宿主）之外，emulator / qemu / netsimd / adb 都可能
    // 弹出一些一闪而过的东西（Qt 提示框、崩溃对话框、音量条、日志窗…）。
    // 以前只按类名逐个点名，漏一个就闪一次；这里改成按「进程属于我们的运行时目录」
    // 判断，覆盖面更全。宿主窗口和模拟器窗口本身不在这个范围，绝不会误伤。
    static void HideStrayWindows()
    {
        if (_scopeDirs.Count == 0) return;
        IntPtr embeddedRoot = _emu;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            if (h == embeddedRoot) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (!IsOurs(pid)) return true;
            string cls = ClassOf(h);
            // 控制台/工具栏已有专门处理，这里只管剩下的杂窗
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if ((r.R - r.L) < 8 && (r.B - r.T) < 8) return true;   // 8x8 以下当隐形
            ShowWindow(h, 0);
            return true;
        }, IntPtr.Zero);
    }

    // 常驻压制扫描：只要模拟器窗口还不是「我们某个窗口的子窗口」，就把它藏起来。
    // 这样无论模拟器是在开机、预热，还是 ApkStart 已经退出（窗口被系统重新挂到桌面，
    // 恢复成顶层窗口），用户都不会看到那个叫 "Android Emulator - apkstart5554" 的黑窗。
    // 同时把工具栏（QWindowTool）与所有控制台窗口（qemu / netsimd / emulator）压住。
    static void QuietSweep()
    {
        bool embedded = _emu != IntPtr.Zero && _host != IntPtr.Zero && GetParent(_emu) == _host;
        IntPtr e = embedded ? _emu : FindEmulator();
        if (!embedded && e != IntPtr.Zero && IsWindowVisible(e)) ShowWindow(e, 0);
        HideToolWindows();
        HideConsoleWindows();
        HideStrayWindows();
        if (!embedded && e != IntPtr.Zero) _bootHideUntil = Environment.TickCount + 5000;
    }

    // Only our own runtime counts. The old version returned true for ANY process named
    // "emulator" -- other emulators (MuMu / LDPlayer ship their own) kept the guard alive.
    static bool AnyEmulatorProcess()
    {
        if (_scopeDirs.Count == 0) return false;
        try
        {
            string[] names = { "qemu-system-x86_64", "qemu-system-x86_64-headless", "emulator", "emulator-headless", "netsimd" };
            for (int i = 0; i < names.Length; i++)
            {
                Process[] all = Process.GetProcessesByName(names[i]);
                for (int j = 0; j < all.Length; j++)
                    if (IsOurs((uint)all[j].Id)) return true;
            }
        }
        catch { }
        return false;
    }

    // ------------------------------------------------------------------ embed / detach
    static bool Embed(IntPtr host, IntPtr emu)
    {
        if (host == IntPtr.Zero || emu == IntPtr.Zero) return false;
        HideToolWindows();
        SetParent(emu, host);
        uint style = (uint)GetWindowLong(emu, GWL_STYLE);
        style &= ~WS_POPUP;
        style &= ~(uint)(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_BORDER);
        style |= WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
        SetWindowLong(emu, GWL_STYLE, (int)style);
        int ex = GetWindowLong(emu, GWL_EXSTYLE);
        ex &= ~(WS_EX_APPWINDOW | WS_EX_TOOLWINDOW | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE);
        SetWindowLong(emu, GWL_EXSTYLE, ex);
        return true;
    }

    // HWND_TOP: Chromium 的渲染子窗口和模拟器是同级的子窗口，
    // 不主动抬到最前就会被 Chromium 那块黑底盖住（用户看到的就是黑屏）。
    static readonly IntPtr HWND_TOP = new IntPtr(1);
    static void Fit(int x, int y, int w, int h, bool frame, int clipTop)
    {
        if (_emu == IntPtr.Zero) return;
        if (w < 16) w = 16;
        if (h < 16) h = 16;
        // 只有「确实已经嵌进我们窗口」的才允许显示。
        // 万一 embed 失败（模拟器窗口还没建好 / 句柄换了），Fit 绝不能把它当独立窗口
        // 顶到桌面上 —— 那正是用户看到的那个 "Android Emulator - apkstart5554" 黑窗。
        bool embedded = _host != IntPtr.Zero && GetParent(_emu) == _host;
        if (!embedded)
        {
            ShowWindow(_emu, 0);
            return;
        }
        // SWP_FRAMECHANGED forces Windows to recompute the whole non-client area and
        // repaint it. It is needed exactly once (right after SetParent); repeating it
        // on every periodic sweep caused visible stutter and wasted GPU/CPU.
        uint flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | (frame ? SWP_FRAMECHANGED : 0u);
        SetWindowPos(_emu, HWND_TOP, x, y, w, h, flags);
        // 模拟器 Qt 窗口的外框比 LCD 大一圈，我们让它向上溢出、把外框挤出客户区；
        // 溢到标题栏上的那一条必须裁掉 —— 否则它被抬到最前时会在标题栏下方画出一条
        // 黑边（用户反馈「点四个按钮时冒出黑色区域侵入界面」就是这个）。
        if (clipTop > 0)
        {
            IntPtr rgn = CreateRectRgn(0, clipTop, w, h);
            // SetWindowRgn 成功后区域归系统所有，不能再删
            if (SetWindowRgn(_emu, rgn, true) == 0) DeleteObject(rgn);
        }
        else
        {
            SetWindowRgn(_emu, IntPtr.Zero, true);
        }
    }

    static void Raise()
    {
        if (_emu == IntPtr.Zero) return;
        SetWindowPos(_emu, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    static void Detach()
    {
        if (_emu == IntPtr.Zero) return;
        SetParent(_emu, IntPtr.Zero);
        uint style = (uint)GetWindowLong(_emu, GWL_STYLE);
        style &= ~WS_CHILD;
        style |= (uint)(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
        SetWindowLong(_emu, GWL_STYLE, (int)style);
        int ex = GetWindowLong(_emu, GWL_EXSTYLE);
        ex |= WS_EX_APPWINDOW;
        SetWindowLong(_emu, GWL_EXSTYLE, ex);
        SetWindowPos(_emu, IntPtr.Zero, 60, 40, 480, 853, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        _emu = IntPtr.Zero;
    }

    // 与 Detach 相同，但**不显示**窗口：宿主窗口即将销毁时调用。
    // 不先摘下来，Windows 会在宿主销毁时把子窗口重新挂到桌面并设成可见，
    // 于是就凭空多出一个 "Android Emulator - apkstart5554" 的黑窗。
    static void ParkEmulator()
    {
        if (_emu == IntPtr.Zero) _emu = FindEmulator();
        IntPtr e = _emu;
        if (e == IntPtr.Zero) { _host = IntPtr.Zero; return; }
        ShowWindow(e, 0);
        SetParent(e, IntPtr.Zero);
        uint style = (uint)GetWindowLong(e, GWL_STYLE);
        style &= ~WS_CHILD;
        style |= (uint)(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
        SetWindowLong(e, GWL_STYLE, (int)style);
        int ex = GetWindowLong(e, GWL_EXSTYLE);
        ex |= WS_EX_APPWINDOW;
        SetWindowLong(e, GWL_EXSTYLE, ex);
        SetWindowPos(e, IntPtr.Zero, 40, 40, 480, 853, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE);
        _emu = IntPtr.Zero;
        _host = IntPtr.Zero;
    }

    // ------------------------------------------------------------------ rotation
    // 模拟器的转屏是「改面板方向」，只有它自己的 Qt 快捷键 Ctrl+←/→ 会触发；
    // 控制台命令 adb emu rotate 只是把画面转 90°，系统里仍然是竖屏（画面横躺）。
    // 难点是快捷键必须由模拟器窗口收到键盘消息，而它已经是我们窗口的子窗口、
    // 焦点在网页层。所以先把两个线程的输入队列接起来，把焦点临时给模拟器，
    // 按完键再还回去。
    static void Rotate(string dir)
    {
        if (_emu == IntPtr.Zero) _emu = FindEmulator();
        if (_emu == IntPtr.Zero) return;
        // keybd_event feeds the SYSTEM input queue, so if we are not the foreground
        // window the Ctrl+Left lands in whatever the user is typing in (WeChat's input
        // box, a browser, ...). Rotate is a user action in our own window; if we are
        // not foreground, do nothing instead of typing into someone else's app.
        IntPtr fg = GetForegroundWindow();
        if (_host == IntPtr.Zero || (fg != IntPtr.Zero && GetAncestor(fg, 2) != _host)) return;
        IntPtr host = _host != IntPtr.Zero ? _host : GetParent(_emu);

        uint emuTid, hostTid, dummy;
        emuTid = GetWindowThreadProcessId(_emu, out dummy);
        hostTid = host != IntPtr.Zero ? GetWindowThreadProcessId(host, out dummy) : 0;
        uint myTid = GetCurrentThreadId();

        bool a1 = AttachThreadInput(myTid, emuTid, true);
        bool a2 = hostTid != 0 && AttachThreadInput(myTid, hostTid, true);
        try
        {
            if (host != IntPtr.Zero) SetForegroundWindow(host);
            IntPtr prev = SetFocus(_emu);
            Thread.Sleep(150);
            byte vk = dir == "right" ? (byte)0x27 : (byte)0x25;
            keybd_event(0x11, 0, 0, IntPtr.Zero);
            Thread.Sleep(50);
            keybd_event(vk, 0, 0, IntPtr.Zero);
            Thread.Sleep(80);
            keybd_event(vk, 0, 2, IntPtr.Zero);
            keybd_event(0x11, 0, 2, IntPtr.Zero);
            Thread.Sleep(120);
            SetFocus(prev);
        }
        finally
        {
            if (a2) AttachThreadInput(myTid, hostTid, false);
            if (a1) AttachThreadInput(myTid, emuTid, false);
        }
    }

    // ------------------------------------------------------------------ mouse mapping
    const int WM_RBUTTONDOWN = 0x0204;
    const int WM_RBUTTONUP = 0x0205;
    const int WM_RBUTTONDBLCLK = 0x0206;
    const int WM_MOUSEWHEEL = 0x020A;
    const int WM_XBUTTONDOWN = 0x020B;
    const int WM_XBUTTONUP = 0x020C;
    const int WM_MOUSEHWHEEL = 0x020E;

    static readonly Stopwatch _clock = Stopwatch.StartNew();
    static long NowMs() { return _clock.ElapsedMilliseconds; }

    // Only react inside the embedded LCD while OUR window is the foreground root.
    // GetAncestor(GA_ROOT) covers Chromium child windows and the Qt framebuffer.
    static bool InOurLcd(POINT pt, out RECT r)
    {
        r = new RECT();
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero || _host == IntPtr.Zero) return false;
        // HWNDs get recycled. If "our" host is gone (or now belongs to another process)
        // the hook must not swallow anything -- otherwise right click / wheel silently
        // stop working in whichever app inherited the handle.
        if (!IsWindow(_host)) return false;
        if (_appPid != 0 && _hostPid != 0 && _hostPid != _appPid) return false;
        if (GetAncestor(fg, 2) != _host) return false;   // 2 = GA_ROOT
        IntPtr e = _emu;
        if (e != IntPtr.Zero && GetWindowRect(e, out r))
        {
            // Qt keeps an 8px grey pad around the real LCD; embed() pushes it out.
            return pt.X >= r.L + 8 && pt.X <= r.R - 8 && pt.Y >= r.T + 8 && pt.Y <= r.B - 8;
        }
        // Before embed (or if FindEmulator failed) fall back to the host window
        // minus its 38px title bar. Approximate on HiDPI, but only a fallback.
        if (!GetWindowRect(_host, out r)) return false;
        return pt.X >= r.L + 4 && pt.X <= r.R - 4 && pt.Y >= r.T + 40 && pt.Y <= r.B - 4;
    }

    static string Num(double v) { return v.ToString("0.####", CultureInfo.InvariantCulture); }

    static void PushWheel(int dx, int dy, POINT pt, RECT r)
    {
        int w = r.R - r.L - 16, h = r.B - r.T - 16;
        double nx = w > 0 ? (pt.X - r.L - 8.0) / w : 0.5;
        double ny = h > 0 ? (pt.Y - r.T - 8.0) / h : 0.5;
        if (nx < 0) nx = 0; if (nx > 1) nx = 1;
        if (ny < 0) ny = 0; if (ny > 1) ny = 1;
        long now = NowMs();
        lock (_wheelLock)
        {
            if (_wheelDx == 0 && _wheelDy == 0) _wheelFirst = now;
            _wheelDx += dx;
            _wheelDy += dy;
            _wheelNx = nx;
            _wheelNy = ny;
            _wheelLast = now;
        }
    }

    // Drained from the socket loop. Emit after 60ms of quiet, but never let a
    // continuous spin starve the queue (hard cap 90ms from the first notch).
    static void FlushWheel(bool force)
    {
        int dx = 0, dy = 0;
        double nx = 0.5, ny = 0.5;
        long now = NowMs();
        lock (_wheelLock)
        {
            if (_wheelDx == 0 && _wheelDy == 0) return;
            if (!force && now - _wheelLast < 60 && now - _wheelFirst < 90) return;
            dx = _wheelDx; dy = _wheelDy; nx = _wheelNx; ny = _wheelNy;
            _wheelDx = 0; _wheelDy = 0;
        }
        _events.Enqueue("{\"ev\":\"wheel\",\"dx\":" + dx + ",\"dy\":" + dy
            + ",\"nx\":" + Num(nx) + ",\"ny\":" + Num(ny) + "}");
    }

    static void ResetWheel()
    {
        lock (_wheelLock) { _wheelDx = 0; _wheelDy = 0; }
    }

    // The callback must stay microscopic: Windows synchronously waits for it on
    // EVERY mouse event of EVERY process. Anything not one of our 7 messages
    // (including all left-button events) is a single CallNextHookEx.
    static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int msg = (int)wParam;
            bool right = msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP || msg == WM_RBUTTONDBLCLK;
            bool wheel = msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL;
            bool xbut = msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP;
            if (!right && !wheel && !xbut) return CallNextHookEx(_hook, nCode, wParam, lParam);
            if ((right && _optRight == 0) || (wheel && _optWheel == 0) || (xbut && _optSide == 0))
                return CallNextHookEx(_hook, nCode, wParam, lParam);

            MSLLHOOKSTRUCT d = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            RECT r;
            if (!InOurLcd(d.Pt, out r)) return CallNextHookEx(_hook, nCode, wParam, lParam);

            if (right)
            {
                // Qt maps a right click to a plain finger tap: swallow it, emit BACK.
                if (msg == WM_RBUTTONDOWN) _events.Enqueue("{\"ev\":\"back\"}");
                return (IntPtr)1;
            }
            if (wheel)
            {
                int delta = (short)((d.MouseData >> 16) & 0xFFFF);
                if (msg == WM_MOUSEWHEEL) PushWheel(0, delta, d.Pt, r);
                else PushWheel(delta, 0, d.Pt, r);
                return (IntPtr)1;
            }
            if (msg == WM_XBUTTONDOWN)
            {
                int button = (d.MouseData >> 16) & 0xFFFF;
                _events.Enqueue(button == 1 ? "{\"ev\":\"back\"}" : "{\"ev\":\"forward\"}");
            }
            return (IntPtr)1;
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    // A WH_MOUSE_LL hook is global: Windows synchronously waits for this callback on
    // EVERY mouse event of EVERY application. It must therefore live on a thread whose
    // only job is pumping messages. Installing it on the socket-serving thread (which
    // used to block up to 4s in Poll) made the whole desktop pointer lag and drift.
    // It is scoped now: JS installs it only while an app window is foreground, and
    // the callback ignores events outside the embedded LCD.
    static void HookThreadProc()
    {
        _hookTid = GetCurrentThreadId();
        _hookProc = HookCallback;
        _hook = SetWindowsHookEx(14, _hookProc, IntPtr.Zero, 0);
        _hookReady.Set();
        MSG m;
        while (_hookRun && GetMessage(out m, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
        if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        _hookTid = 0;
    }

    static void HookOn()
    {
        if (_hookThread != null && _hookThread.IsAlive) return;
        _hookRun = true;
        _hookReady.Reset();
        _hookThread = new Thread(HookThreadProc);
        _hookThread.IsBackground = true;
        _hookThread.Start();
        // Reply must reflect the real hook state; otherwise the JS side sees
        // hooked:false and thinks enabling failed.
        _hookReady.WaitOne(1000);
    }
    static void HookOff()
    {
        _hookRun = false;
        _optRight = 0; _optWheel = 0; _optSide = 0;
        ResetWheel();
        if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        if (_hookTid != 0) PostThreadMessage(_hookTid, 0x0012, IntPtr.Zero, IntPtr.Zero); // WM_QUIT
        _hookThread = null;
        // _hookProc 故意保留引用：钩子线程可能正在执行回调，提前置 null
        // 会让委托被 GC 回收。线程退出时会自然释放。
    }

    // ------------------------------------------------------------------ plumbing
    static void Pump()
    {
        MSG m;
        while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1))
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
    }

    static long L(string line, string key)
    {
        string pat = "\"" + key + "\"";
        int i = line.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return 0;
        i = line.IndexOf(':', i + pat.Length);
        if (i < 0) return 0;
        i++;
        while (i < line.Length && (line[i] == ' ' || line[i] == '\"')) i++;
        int j = i;
        while (j < line.Length && (char.IsDigit(line[j]) || line[j] == '-')) j++;
        long v;
        return long.TryParse(line.Substring(i, j - i), out v) ? v : 0;
    }

    static string S(string line, string key)
    {
        string pat = "\"" + key + "\":\"";
        int i = line.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return "";
        i += pat.Length;
        int j = line.IndexOf('"', i);
        return j < 0 ? "" : line.Substring(i, j - i);
    }

    static void Reply(Socket s, string json)
    {
        try
        {
            byte[] b = Encoding.UTF8.GetBytes(json + "\n");
            s.Send(b);
        }
        catch { }
    }

    public static void Serve(int port)
    {
        TcpListener l = new TcpListener(IPAddress.Loopback, port);
        l.Start();
        int actual = ((IPEndPoint)l.LocalEndpoint).Port;
        Console.WriteLine("PORT=" + actual);
        Console.Out.Flush();
        Socket sock;
        try { sock = l.AcceptSocket(); }
        catch { return; }
        l.Stop();

        StringBuilder rx = new StringBuilder();
        byte[] buf = new byte[8192];
        bool run = true;
        while (run)
        {
            Pump();
            FlushWheel(false);

            string ev;
            while (_events.TryDequeue(out ev))
                Reply(sock, "{\"ev\":\"" + ev + "\"}");

            // The Qt tool rail can re-appear right after embedding. Sweep only for the
            // first few seconds after an embed, then stop: a permanent 2s EnumWindows +
            // SetWindowPos loop is pure overhead and competes with the foreground app.
            long now = Environment.TickCount;
            if (_embedAt != 0 && now - _embedAt < 8000 && now - _lastToolSweep > 1500)
            {
                _lastToolSweep = now;
                HideToolWindows();
                Raise();
            }
            if (_embedAt != 0 && now - _embedAt >= 8000) _embedAt = 0;

            // 常驻压制：模拟器主窗 / 工具栏 / qemu·netsimd 控制台黑窗，一律不允许露面。
            // 前 90 秒 120ms 一轮（开机阶段窗口是「刚创建就可见」，慢了就会闪一下），
            // 之后放慢到 400ms —— 仍然能兜住「ApkStart 退出后窗口被重挂到桌面」这类情况。
            long sweepGap = (now - _bootHideStart < 90000) ? 120 : 400;
            if (_quiet && now - _bootHideSweep > sweepGap)
            {
                _bootHideSweep = now;
                QuietSweep();
            }

            try
            {
                // 连接已经断了（ApkStart 退出 / 异常崩溃）：不立刻收工。
                // 模拟器可能还在开机，几十秒后 Qt 才把窗口显示出来 —— 那时如果
                // 已经没有代理在盯着，桌面上就会留一个 Android Emulator 黑窗。
                // 所以断线后继续「守」一会儿，直到最后一段时间没有模拟器进程。
                if (sock == null)
                {
                    if (Environment.TickCount > _lingerUntil) break;
                    // 模拟器都退干净了就不用再守
                    if (!AnyEmulatorProcess() && FindEmulator() == IntPtr.Zero) break;
                    Thread.Sleep(120);
                    continue;
                }
                // Short poll: keep the message pump responsive even when no command
                // arrives. Never block for seconds while owning window hooks.
                if (!sock.Poll(50, SelectMode.SelectRead)) continue;
                int n = sock.Receive(buf);
                if (n <= 0)
                {
                    try { sock.Close(); } catch { }
                    sock = null;
                    if (_quiet) { _lingerUntil = Environment.TickCount + 180000; continue; }
                    break;
                }
                rx.Append(Encoding.UTF8.GetString(buf, 0, n));
                while (true)
                {
                    string all = rx.ToString();
                    int nl = all.IndexOf('\n');
                    if (nl < 0) break;
                    string line = all.Substring(0, nl).Trim();
                    rx.Remove(0, nl + 1);
                    if (line.Length == 0) continue;

                    string cmd = S(line, "cmd");
                    if (cmd == "scope")
                    {
                        // Whitelist of "our" directories. Must arrive before boothide /
                        // embed; the sweeps refuse to touch anything outside it.
                        SetScope(S(line, "dirs"));
                        long appPid = L(line, "pid");
                        _appPid = appPid > 0 ? (uint)appPid : 0;
                        _hostPid = 0;
                        Reply(sock, "{\"ok\":true,\"n\":" + _scopeDirs.Count + "}");
                    }
                    else if (cmd == "embed")
                    {
                        // 嵌入即代表「用户要看画面了」。压制不关（它只藏非嵌入窗口
                        // 与控制台黑窗），但要先把窗口从隐藏状态正确地交给 SetParent，
                        // 再由 Fit 的 SWP_SHOWWINDOW 显示出来。
                        IntPtr want = new IntPtr(L(line, "host"));
                        uint wantPid = 0;
                        if (want != IntPtr.Zero) GetWindowThreadProcessId(want, out wantPid);
                        // Never re-parent into a foreign window: a stale handle could
                        // point at another app (the exact way "ApkStart ate WeChat's
                        // window" can happen).
                        if (want == IntPtr.Zero || (_appPid != 0 && wantPid != _appPid))
                        {
                            Reply(sock, "{\"ok\":false,\"error\":\"host-not-ours\"}");
                            Thread.Sleep(1);
                        }
                        else
                        {
                            _host = want;
                            _hostPid = wantPid;
                            _emu = FindEmulator();
                            bool ok = Embed(_host, _emu);
                            _embedAt = Environment.TickCount;
                            _lastToolSweep = 0;
                            Fit((int)L(line, "x"), (int)L(line, "y"), (int)L(line, "w"), (int)L(line, "h"), true, (int)L(line, "clipTop"));
                            Reply(sock, "{\"ok\":" + (ok ? "true" : "false") + ",\"emu\":" + _emu.ToInt64() + "}");
                        }
                    }
                    else if (cmd == "fit")
                    {
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        Fit((int)L(line, "x"), (int)L(line, "y"), (int)L(line, "w"), (int)L(line, "h"), false, (int)L(line, "clipTop"));
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "rotate")
                    {
                        Rotate(S(line, "dir"));
                        Thread.Sleep(350);
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "hide")
                    {
                        if (_emu != IntPtr.Zero) ShowWindow(_emu, 0);
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "show")
                    {
                        if (_emu != IntPtr.Zero) ShowWindow(_emu, 5);
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "detach")
                    {
                        Detach();
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "hook")
                    {
                        // Options are re-sent on every enable, so changing settings
                        // while the hook is live needs no reinstall / no thread churn.
                        _optRight = L(line, "right") == 1 ? 1 : 0;
                        _optWheel = L(line, "wheel") == 1 ? 1 : 0;
                        _optSide = L(line, "side") == 1 ? 1 : 0;
                        if (L(line, "on") == 1) HookOn(); else HookOff();
                        Reply(sock, "{\"ok\":true,\"hooked\":" + (_hook != IntPtr.Zero ? "true" : "false") + "}");
                    }
                    else if (cmd == "probe")
                    {
                        IntPtr e = FindEmulator();
                        RECT r = new RECT();
                        if (e != IntPtr.Zero) GetWindowRect(e, out r);
                        Reply(sock, "{\"ok\":true,\"emu\":" + e.ToInt64() + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + "}");
                    }
                    else if (cmd == "consoles")
                    {
                        Reply(sock, "{\"ok\":true,\"list\":[" + ListConsoles() + "]}");
                    }
                    else if (cmd == "windows")
                    {
                        Reply(sock, "{\"ok\":true,\"list\":[" + ListWindows(L(line, "all") == 1) + "]}");
                    }
                    else if (cmd == "boothide")
                    {
                        if (L(line, "on") == 1)
                        {
                            _quiet = true;
                            _bootHideSweep = 0;
                            _bootHideStart = Environment.TickCount;
                            QuietSweep();
                        }
                        else
                        {
                            // 保留窗口不动，只把控制台黑窗再压一遍（关掉 quiet 一般是因为
                            // 用户想自己看一眼模拟器窗口，见设置 startVisible）。
                            _quiet = false;
                            HideConsoleWindows();
                        }
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "park")
                    {
                        // 应用窗口要关了：先把模拟器窗口从宿主上摘下来并藏好，
                        // 避免宿主销毁时 Windows 把它重新挂到桌面、恢复成顶层可见窗口
                        // （用户看到的「凭空冒出一个 Android Emulator 黑窗」就是这么来的）。
                        _quiet = true;
                        _bootHideStart = Environment.TickCount;
                        _bootHideSweep = 0;
                        ParkEmulator();
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "quit")
                    {
                        Reply(sock, "{\"ok\":true}");
                        run = false;
                        break;
                    }
                    else
                    {
                        Reply(sock, "{\"ok\":false,\"error\":\"unknown\"}");
                    }
                }
            }
            catch (SocketException)
            {
                try { sock.Close(); } catch { }
                sock = null;
                if (_quiet) { _lingerUntil = Environment.TickCount + 180000; continue; }
                break;
            }
            catch (Exception) { }
        }
        HookOff();
        try { sock.Close(); } catch { }
    }
}
'@

Add-Type -TypeDefinition $src
[ApkAgent]::Serve($Port)
