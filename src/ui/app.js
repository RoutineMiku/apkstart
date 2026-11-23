'use strict';

const api = window.apkstart;
const $ = (id) => document.getElementById(id);

const state = {
  apps: [],
  settings: null,
  status: null,
  filter: '',
  installing: false,
  setupBusy: null,
  menuPkg: null,
};

const UI_TEXT = {
  '设置': 'Settings',
  '常用与安装': 'General & Installation',
  '显示与窗口': 'Display & Windows',
  '操作与输入': 'Controls & Input',
  '性能与资源': 'Performance & Resources',
  '网络与下载': 'Network & Downloads',
  '诊断与修复': 'Diagnostics & Repair',
  '集成与文件': 'Integration & Files',
  '更新与关于': 'Updates & About',
  '实验室': 'Laboratory',
  '搜索已安装应用': 'Search installed apps',
  '安装 APK': 'Install APK',
  '把 APK 拖进来就能装': 'Drop an APK here to install',
  '选择 APK 文件': 'Choose APK file',
  '设置项：横屏 / 内存 / 代理 / 快照…': 'Search settings: orientation / memory / proxy / snapshots…',
  '界面语言': 'Interface language',
  '界面语言已更改': 'Interface language changed',
  '界面已切换为简体中文。': 'The interface is now in Simplified Chinese.',
  '新': 'New',
  '简体中文': 'Simplified Chinese',
  '自动模式（默认，无需设置）': 'Automatic mode (default, no setup required)',
  '运行时与环境': 'Runtime & Environment',
  '应用窗口': 'Application window',
  '鼠标键位': 'Mouse controls',
  '性能与资源占用': 'Performance & Resource Usage',
  '下载与更新源': 'Download & Update Sources',
  '本机体检 · 自动配置': 'System Check · Auto Configuration',
  '驱动 · 兼容补丁': 'Drivers · Compatibility Patches',
  '自动检测 · 智能诊断': 'Automatic Checks · Smart Diagnostics',
  '安卓系统设置（不用进安卓桌面）': 'Android System Settings (no desktop needed)',
  '桌面与应用': 'Desktop & Applications',
  '文件互通': 'File Sharing',
  '系统集成': 'System Integration',
  '软件更新': 'Software Updates',
  '关于': 'About',
  '你好': 'Hello',
  '开始使用': 'Get Started',
  '打开设置': 'Open Settings',
  '下次启动不再自动弹出': 'Do not show automatically next time',
  '添加应用': 'Add application',
  '拖入 APK 即可安装': 'Drop an APK to install',
  '未连接运行时': 'Runtime not connected',
  '使用手册（含故障解决方案）': 'User guide and troubleshooting',
  '安装完成后会自动生成桌面图标，双击即以独立窗口运行，和普通 Windows 软件一样。': 'A desktop shortcut is created after installation. Double-click it to run the app in its own window, just like a Windows application.',
  '已注册 .apk 关联时，在资源管理器里双击 APK 也会直接装到 ApkStart。': 'When the .apk file association is enabled, double-click an APK in File Explorer to install it in ApkStart.',
  '正在检查运行时…': 'Checking runtime…',
  'ApkStart 已就绪': 'ApkStart is ready',
  '松手开始安装': 'Release to start installation',
  '支持单个或多个 .apk 文件': 'Supports one or more .apk files',
  '清除搜索': 'Clear search',
  '设置分类': 'Settings categories',
  '常用与安装': 'General & Installation',
  '运行状态': 'Runtime status',
  '正在检查…': 'Checking…',
  '一键完成': 'Set up automatically',
  '高级：连接已有运行时': 'Advanced: Connect an existing runtime',
  '全自动：无需选择镜像、无需启用加速、无需调内存': 'Fully automatic: no image selection, acceleration setup, or memory tuning required',
  '安装 Android 到虚拟磁盘': 'Install Android to a virtual disk',
  '稍后再说': 'Maybe later',
  '本机自适应参数': 'Automatic settings for this PC',
  '内存、核心数、渲染后端、端口、加速方式全部自动选择；启动失败会自动降级重试，不需要手动改。': 'Memory, CPU cores, renderer, ports, and acceleration are selected automatically. If startup fails, ApkStart retries with safer settings.',
  '磁盘总占用（运行时 + 安卓数据 + 缓存）': 'Total disk usage (runtime + Android data + cache)',
  '正在统计…': 'Calculating…',
  '清理可回收文件': 'Clean up reclaimable files',
  '清理旧版本残留': 'Remove leftovers from older versions',
  '修复网络': 'Repair network',
  '重置安卓数据': 'Reset Android data',
  '导出诊断报告': 'Export diagnostic report',
  '重建快捷方式': 'Rebuild shortcuts',
  '开机自动启动（默认开启）': 'Start with Windows (enabled by default)',
  '显示模式': 'Display mode',
  '自动全屏': 'Automatically use fullscreen',
  '屏幕方向': 'Screen orientation',
  '镜像自动旋转': 'Automatic rotation',
  '平板排版': 'Tablet layout',
  '当前面板方向': 'Current screen orientation',
  '窗口承载方式': 'Window mode',
  '竖屏画面大小': 'Portrait resolution',
  '小 · 720 × 1280': 'Small · 720 × 1280',
  '中 · 900 × 1600': 'Medium · 900 × 1600',
  '大 · 1080 × 1920': 'Large · 1080 × 1920',
  '超大 · 1440 × 2560': 'Extra large · 1440 × 2560',
  '鼠标键位': 'Mouse controls',
  '左键 · 确认 / 点击': 'Left button · Select / click',
  '右键 · 安卓返回': 'Right button · Android Back',
  '滚轮 · 滑动': 'Scroll wheel · Swipe',
  '平滑（推荐）· 合并多次滚动为一次流畅滑动': 'Smooth (recommended) · Combine scroll events into a fluid swipe',
  '原生 · 交给模拟器逐格处理': 'Native · Let the emulator handle each scroll step',
  '关闭 · 不拦截滚轮': 'Off · Do not intercept scrolling',
  '键盘映射（游戏手柄）': 'Keyboard mapping (game controls)',
  '启用键盘映射': 'Enable keyboard mapping',
  '性能与资源占用': 'Performance & Resource Usage',
  '资源策略': 'Resource profile',
  '省资源 · 2 核 / 让出前台 / 540p（老机器、挂机）': 'Save resources · 2 cores / lower priority / 540p (older PCs, background use)',
  '均衡 · 一半物理核 / 让出前台 / 720p（推荐）': 'Balanced · Half of physical cores / lower priority / 720p (recommended)',
  '流畅 · 不限核数 / 与前台同优先级（视频、游戏）': 'Smooth · No CPU limit / foreground priority (video, games)',
  '显卡偏好（独显 / 核显）': 'GPU preference (discrete / integrated)',
  '系统默认（推荐 · 让 Windows 决定）': 'System default (recommended · Let Windows decide)',
  '独显优先（游戏 / 视频更流畅，更耗电）': 'Prefer discrete GPU (smoother games and video, higher power use)',
  '核显优先（省电、发热低）': 'Prefer integrated GPU (lower power and heat)',
  '画质（安卓内部渲染分辨率）': 'Graphics quality (Android render resolution)',
  '自动（按加速状态）': 'Automatic (based on acceleration)',
  '流畅 · 540 × 960': 'Performance · 540 × 960',
  '均衡 · 720 × 1280': 'Balanced · 720 × 1280',
  '高清 · 1080 × 1920': 'High · 1080 × 1920',
  '安卓数据分区（应用与游戏装这里）': 'Android data partition (apps and games are stored here)',
  '立即扩容': 'Expand now',
  '系统语言': 'Android system language',
  '简体中文（推荐）': 'Simplified Chinese (recommended)',
  '繁體中文': 'Traditional Chinese',
  'English（镜像原生）': 'English (image default)',
  '日本語': 'Japanese',
  '中文输入法（推荐）': 'Chinese keyboard (recommended)',
  '高级参数（一般无需修改）': 'Advanced settings (usually no changes needed)',
  '运行时': 'Runtime',
  '运行时与环境': 'Runtime & Environment',
  'ApkStart 自带运行时（QEMU + Android 14，独立运行）': 'Built-in ApkStart runtime (QEMU + Android 14, runs independently)',
  'adb 路径': 'ADB path',
  '设备地址': 'Device address',
  '系统镜像（ISO）': 'System image (ISO)',
  '内存 (MB，0 = 自动)': 'Memory (MB, 0 = automatic)',
  'CPU 核心（0 = 自动）': 'CPU cores (0 = automatic)',
  '空闲回收（分钟，0 = 不回收）': 'Idle shutdown (minutes, 0 = never)',
  '兼容镜像': 'Compatibility image',
  '下载兼容镜像': 'Download compatibility image',
  '启动运行时': 'Start runtime',
  '停止内置虚拟机': 'Stop built-in virtual machine',
  '安卓系统设置（不用进安卓桌面）': 'Android system settings (without opening the Android desktop)',
  '刷新': 'Refresh',
  '一键流畅优化': 'Optimize performance',
  '飞行模式': 'Airplane mode',
  '系统动画': 'System animations',
  '媒体音量': 'Media volume',
  '字体大小': 'Font size',
  '显示大小': 'Display size',
  '安卓原生设置': 'Android settings',
  '显示设置': 'Display settings',
  '声音设置': 'Sound settings',
  '语言设置': 'Language settings',
  '应用管理': 'App management',
  '桌面与应用': 'Desktop & Applications',
  '安装后自动创建桌面快捷方式': 'Create a desktop shortcut after installation',
  '同时添加到开始菜单': 'Also add to the Start menu',
  '快捷方式目录': 'Shortcut folder',
  '文件互通': 'File sharing',
  '系统集成': 'System integration',
  '软件更新': 'Software updates',
  '关于': 'About',
  '开始体检': 'Run system check',
  '应用推荐配置': 'Apply recommended settings',
  '驱动 · 兼容补丁': 'Drivers · Compatibility patches',
  '正在读取驱动…': 'Loading drivers…',
  '导入驱动…': 'Import driver…',
  '打开驱动目录': 'Open driver folder',
  '导出本机模板': 'Export local template',
  '自动检测 · 智能诊断': 'Automatic checks · Smart diagnostics',
  '启用自动检测（默认开启）': 'Enable automatic checks (on by default)',
  '检测间隔': 'Check interval',
  '发现新问题时通知我': 'Notify me when new issues are found',
  '立即检测': 'Check now',
  '尚未检测': 'Not checked yet',
  '常用与安装': 'General & Installation',
  '更新与关于': 'Updates & About',
  '返回': 'Back',
  '正在运行': 'Running',
  '运行中': 'Running',
  '打开': 'Open',
  '切换到前台': 'Bring to front',
  '应用': 'Application',
  '暂无应用': 'No applications installed',
  '立即更新': 'Update now',
  '开始': 'Start',
  '取消': 'Cancel',
  '确定': 'OK',
  '关闭': 'Close',
  '完成': 'Done',
  '已就绪': 'Ready',
  '未下载': 'Not downloaded',
  '无': 'None',
  '自动': 'Automatic',
  '标准': 'Standard',
  '大': 'Large',
  '小': 'Small',
  '紧凑（省性能）': 'Compact (better performance)',
  '宽松': 'Spacious',
  '特大': 'Extra large',
  '每 1 分钟': 'Every minute',
  '每 5 分钟': 'Every 5 minutes',
  '每 10 分钟（推荐）': 'Every 10 minutes (recommended)',
  '每 30 分钟': 'Every 30 minutes',
  '每 1 小时': 'Every hour',
  '运行时未启动': 'Runtime is not running',
  '未下载': 'Not downloaded',
  '显示模式': 'Display mode',
  '竖屏窗口（可自由拉伸，记住每个应用的大小）': 'Portrait window (resizable; remembers each app’s size)',
  '全屏（铺满屏幕，保持手机比例两侧留黑）': 'Fullscreen (fills the screen while preserving the phone aspect ratio)',
  '关闭（按上面选的显示模式走）': 'Off (use the display mode selected above)',
  '打开 · 每次启动应用都自动全屏': 'On · Launch every app in fullscreen',
  '跟随应用（推荐 · 自动选横竖屏，画面铺满不留黑边）': 'Follow app (recommended · Automatically match orientation to fill the screen)',
  '强制竖屏（手机比例，适合刷短视频、看小说）': 'Force portrait (phone aspect ratio; ideal for short videos and reading)',
  '强制横屏（宽屏铺满，适合看剧、玩游戏）': 'Force landscape (wide-screen; ideal for videos and games)',
  '打开（默认）· 系统设置里显示自动旋转已开启': 'On (default) · Android reports auto-rotate as enabled',
  '关闭 · 回到旧的锁定行为': 'Off · Restore the previous locked behavior',
  '打开（推荐 · 逻辑密度 190dpi，sw606dp 走平板排版）': 'On (recommended · 190 dpi logical density enables tablet layouts)',
  '关闭（镜像默认密度，手机排版）': 'Off (use the image default density and phone layout)',
  '竖屏面板': 'Portrait display',
  '横屏面板': 'Landscape display',
  '原生窗口（默认·推荐）· 模拟器自己开窗口，帧率与缩放最稳': 'Native window (default, recommended) · The emulator opens its own window for smoother rendering and resizing',
  '嵌入模式 · 安卓画面嵌在 ApkStart 窗口里，标题栏带旋转按钮': 'Embedded mode · Android runs inside the ApkStart window with a rotate button in the title bar',
  '窗口模式下可拖动边框任意缩放；这里调的是 Android 内部渲染尺寸，越小越省性能。': 'In windowed mode, drag the borders to resize. This controls Android’s render resolution; lower values use fewer resources.',
  '资源策略': 'Resource profile',
  '自动模式（默认，无需设置）': 'Automatic mode (default, no setup required)',
  '界面语言': 'Interface language',
  '选择 ApkStart 界面语言。更改会立即生效；安卓系统语言请在性能设置中单独配置。': 'Choose the ApkStart interface language. Changes apply immediately. Configure Android’s system language separately in Performance settings.',
  '平板排版': 'Tablet layout',
  '更新与关于': 'Updates & About',
  '集成与文件': 'Integration & Files',
  '运行时状态': 'Runtime status',
  '运行时未部署 —— 打开设置 → 运行时，一键完成': 'Runtime not installed — open Settings → Runtime and select Set up automatically',
  '安卓虚拟机没有网络时（应用里联网页面一直黑屏/转圈），用这个把安卓数据重置掉来修网络。应用清单会保留，点开应用会自动重装': 'If Android has no network connection, reset its data to repair networking. Your app list is kept, and apps are reinstalled when opened.',
  '清空安卓 /data 用户数据 + 已装应用 + 快速启动快照，还原成刚装好系统的干净状态': 'Clear Android /data, installed apps, and quick-boot snapshots to restore a clean system.',
  '扫描并清掉旧版本留下的程序目录、失效的卸载项和更新临时文件': 'Find and remove old program folders, stale uninstall entries, and update temporary files.',
  '搜索设置项：横屏 / 内存 / 代理 / 快照…': 'Search settings: orientation / memory / proxy / snapshots…',
  '留空则自动在 PATH / Android SDK 中查找': 'Leave blank to search PATH and the Android SDK automatically',
  'Android-x86 / Bliss OS 的 ISO 或 IMG 路径，留空使用默认位置': 'Path to an Android-x86 / Bliss OS ISO or IMG; leave blank to use the default',
  '留空 = 桌面': 'Leave blank to use the Desktop',
  '选择 APK 文件': 'Choose APK file',
  '获取诊断报告': 'Get diagnostic report',
  '系统默认': 'System default',
  '离线': 'Offline',
  '未知': 'Unknown',
  '正在引导 Android…': 'Starting Android…',
  '运行时已就绪': 'Runtime ready',
  '需要部署': 'Setup required',
  '引导中': 'Starting',
  '自动配置': 'Automatic configuration',
  '缺少': 'Missing',
  '已就绪': 'Ready',
  '组件齐全': 'Components installed',
  '正在准备': 'Preparing',
  '请稍候': 'Please wait',
  '检测失败': 'Check failed',
  '没有发现影响使用的问题。': 'No issues affecting use were found.',
  '上次检测': 'Last checked',
  '一切正常': 'Everything is working',
  '项待处理': 'items need attention',
  '运行时已就绪 · Android': 'Runtime ready · Android',
  '硬件加速': 'Hardware acceleration',
  '软件模拟': 'Software rendering',
  '自动': 'Automatic',
  '有': 'Yes',
  '无': 'No',
  '全部': 'All',
  '启用': 'Enable',
  '关闭': 'Off',
  '打开': 'On',
  '已开启': 'Enabled',
  '已关闭': 'Disabled',
  '保存': 'Save',
  '重试': 'Retry',
  '正在保存…': 'Saving…',
  '已保存': 'Saved',
  '失败': 'Failed',
  '错误': 'Error',
  '警告': 'Warning',
  '提示': 'Notice',
  '教程': 'Guide',
  '处理': 'Fix',
  '详情': 'Details',
  '正在更新…': 'Updating…',
  '正在连接 GitHub…': 'Connecting to GitHub…',
  '检查中…': 'Checking…',
  '已是最新版本': 'You are up to date',
  '发现新版本': 'New version available',
  '检查失败': 'Check failed',
  '打开下载页': 'Open download page',
  '快捷方式已创建': 'Shortcut created',
  '正在安装': 'Installing',
  '安装失败': 'Installation failed',
  '启动失败': 'Startup failed',
  '已启动': 'Started',
  '运行时已就绪': 'Runtime is ready',
  '已取消': 'Canceled',
  '已完成': 'Completed',
  '未知错误': 'Unknown error',
  '暂无应用': 'No applications installed',
  '个应用': 'applications',
  '全屏（铺满屏幕，保持手机比例两侧留黑）': 'Fullscreen (fill the screen while keeping the phone aspect ratio, with black bars on the sides)',
  '窗口模式下可拖动边框任意缩放；这里调的是 Android 内部渲染尺寸，越小越省性能。': 'In window mode, drag the borders to resize. This controls Android’s render resolution; lower values use fewer resources.',
  '决定安卓虚拟机吃多少 CPU、画面多细腻。红果/抖音发卡就切「流畅」，只想挂着跑小应用就切「省资源」。改完下一次打开应用生效。': 'Controls Android CPU usage and image quality. Choose Smooth for video or games, or Save resources for lightweight apps running in the background. Changes take effect the next time you open an app.',
  '打开后，每次点开应用直接铺满屏幕，不用再按 F11。配合下面的「横屏」使用效果最好 —— 横屏面板的宽高比本来就贴合屏幕，全屏不会留黑边。': 'When enabled, apps open fullscreen without pressing F11. This works best with landscape orientation, which fills the screen without black bars.',
  '全屏只放大窗口，不改变画面比例，切换不重启应用。': 'Fullscreen enlarges the window without changing the aspect ratio or restarting the app.',
  '平滑模式把一小段时间内的滚动合并成一次滑动手势，避免逐格抽搐，也不会每格都拉起一个 adb 进程。': 'Smooth mode combines nearby scroll events into one swipe, avoiding choppy movement and repeated ADB processes.',
  '模拟器原生把左键当成手指点击，按住拖动就是滑动，无需额外设置。': 'The emulator maps the left mouse button to a finger tap; click and drag to swipe. No setup is needed.',
  '模拟器默认把右键也当成一次点击（容易误触）。开启后右键只执行返回，不再触发点击。': 'By default, the emulator treats right-click as a tap, which can cause accidental input. When enabled, right-click only performs Android Back.',
  '侧键映射需要全局鼠标钩子。钩子只在 ApkStart 应用窗口处于前台时安装，失焦或关闭立即卸载，不会拖慢桌面。': 'Side-button mapping uses a global mouse hook. It is active only while an ApkStart app window is focused and is removed immediately when focus is lost or the window closes.',
  '以上映射只在应用窗口前台生效；切回桌面或关闭窗口后，鼠标行为完全恢复 Windows 原生。': 'These mappings are active only while an app window is focused. Mouse behavior returns to normal when you switch to the desktop or close the window.',
  '把键盘按键映射成安卓触屏点击/滑动。适合用键盘玩手游（WASD 移动、J/K 技能等）。': 'Map keyboard keys to Android taps and swipes. Useful for playing mobile games with a keyboard (WASD movement, J/K skills, and more).',
  '每个应用可以单独配置，右键应用卡片 → 「按键映射」选择预设模板或自定义。': 'Configure each app separately. Right-click its card and choose Key mapping to select a preset or create your own.',
  '电脑同时有独显和核显时，Windows 有时会把模拟器分到核显，导致画面卡。这里可以明确指定用哪块显卡渲染；仅 Windows 10 1803+ 生效，改动在下次启动安卓时应用。': 'On PCs with both discrete and integrated GPUs, Windows may assign the emulator to the integrated GPU and cause slow rendering. Choose which GPU to use here. Requires Windows 10 version 1803 or later; changes take effect the next time Android starts.',
  '扩容是就地做的：已装应用与存档都保留，只是下次打开应用会多花十几秒。': 'Expansion is performed in place, preserving installed apps and saves. The next app launch may take a few extra seconds.',
  '关掉后界面切换明显更快，功能不受影响。': 'Disabling animations makes screen transitions noticeably faster without affecting functionality.',
  '系统镜像全机共享一份，应用数据用差分层保存；旧镜像、旧快照、日志和锁文件都可回收。日志超过上限会自动滚动，不会无限增长。': 'The system image is shared; app data is stored in a separate layer. Old images, snapshots, logs, and lock files can be reclaimed. Logs rotate automatically when they reach the size limit.',
  '开机自动启动（默认开启）': 'Start with Windows (enabled by default)',
  '随 Windows 登录常驻托盘，双击桌面图标秒开应用，无需手动启动。': 'Start in the system tray when you sign in to Windows. Double-click a desktop shortcut to launch an app without opening ApkStart first.',
  '安卓系统设置、权限弹窗、日期格式的语言。开机时注入到虚拟机，下次重启运行时生效。中文输入法不受此项影响，单独在下面开关。': 'Language used by Android settings, permission dialogs, and date formats. Applied to the virtual machine at startup; takes effect after restarting the runtime. The Chinese keyboard is controlled separately below.',
  '安卓虚拟机内部的无线网，关掉可省一点 CPU。': 'Wi-Fi inside the Android virtual machine. Turn it off to save some CPU resources.',
  '彻底断网（含移动数据），需要安静时打开。': 'Disconnect all network access, including mobile data.',
  '关闭系统动画、放开后台进程上限并把当前应用加入电池白名单，低配电脑体感最明显。': 'Disables system animations, raises the background process limit, and adds the current app to the battery allowlist. Most noticeable on lower-end PCs.',
  '快捷方式带真实应用图标，双击直接进应用': 'Shortcuts use the app’s icon and launch it directly',
  'Windows 搜索能搜到应用名，任务栏也按应用分组': 'Find apps by name in Windows Search; taskbar windows are grouped by app',
  '修改后旧目录里已有的文件会自动搬到新目录；正在运行的文件互通不受影响。': 'Existing files are moved to the new folder automatically. File sharing continues to work during the move.',
  '两侧目录会持续双向同步；在安卓应用里保存到该目录的文件，会出现在本机共享目录中。': 'Both folders stay in sync. Files saved here by Android apps also appear in the shared folder on this PC.',
  '双击 APK 直接安装到 ApkStart（仅写入当前用户，无需管理员）': 'Double-click an APK to install it in ApkStart (current user only; no administrator access required)',
  '设置修改后立即生效': 'Settings take effect immediately',
  '打开使用手册（含故障解决方案）': 'Open user guide and troubleshooting',
  '扫码关注公众号': 'Scan to follow our official account',
  '这里的功能还在实验阶段，行为可能随版本变化。遇到问题可在「诊断与修复 → 导出诊断报告」反馈。': 'These features are experimental and may change. If you encounter a problem, use Diagnostics & Repair → Export diagnostic report to send feedback.',
  '后台保留应用数': 'Number of apps to keep in the background',
  '多开模式下，超过这个数量的后台应用会被挂起（保留数据、秒切回），释放内存。': 'In multi-app mode, background apps beyond this limit are suspended to free memory while keeping their data for quick switching.',
  '1 · 平衡（推荐）': '1 · Balanced (recommended)',
  '2 · 多开更稳': '2 · More reliable multitasking',
  '3 · 最多并存': '3 · Keep the most apps open',
  '0 · 最省内存（只留当前应用）': '0 · Lowest memory use (keep only the current app)',
  '安装后自动创建桌面快捷方式': 'Create a desktop shortcut after installation',
  '同时添加到开始菜单': 'Also add to the Start menu',
  '本机共享目录': 'Shared folder on this PC',
  '安卓内对应目录': 'Matching folder on Android',
  '关联 .apk 文件': 'Associate .apk files',
  '运行时数据目录（系统镜像 · 已装应用 · 快照）': 'Runtime data folder (system image · installed apps · snapshots)',
  '安卓数据目录（应用、游戏与快速启动快照）': 'Android data folder (apps, games, and quick-boot snapshots)',
  '卸载 ApkStart': 'Uninstall ApkStart',
  '一键卸载': 'Uninstall',
  '检查更新': 'Check for updates',
  '当前版本': 'Current version',
  '尚未检查': 'Not checked yet',
  '语言设置': 'Language settings',
  '应用管理': 'App management',
  '常用与安装': 'General & Installation',
  '更新与关于': 'Updates & About',
  '本机自适应参数': 'Automatic settings for this PC',
  'Windows / PATH / Android SDK': 'Windows / PATH / Android SDK',
  '本机体检 · 自动配置': 'System check · Automatic configuration',
  '运行时与环境': 'Runtime & Environment',
  '自动模式（默认，无需设置）': 'Automatic mode (default, no setup required)',
  '系统镜像全机共享一份，应用数据用差分层保存；旧镜像、旧快照、日志和锁文件都可回收。': 'The system image is shared by all apps, while app data is stored separately. Old images, snapshots, logs, and lock files can be reclaimed.',
  '右键应用卡片可快速套用预设模板。': 'Right-click an app card to quickly apply a preset.',
  '自动选择较快的源（推荐）': 'Automatically choose the fastest source (recommended)',
  '只用 Gitee（国内通常最快）': 'Gitee only (usually fastest in China)',
  '只用 GitHub': 'GitHub only',
  '下载线程数（1–16，默认 8）': 'Download connections (1–16, default 8)',
  'Gitee 更新源（可选）': 'Gitee update source (optional)',
  'Gitee 只读 token（一般不用填）': 'Gitee read-only token (usually not required)',
  '开始体检': 'Run system check',
  '应用推荐配置': 'Apply recommended settings',
  '启用自动检测（默认开启）': 'Enable automatic checks (on by default)',
  '发现新问题时通知我': 'Notify me when new issues are found',
  '导出诊断报告': 'Export diagnostic report',
  '正在读取驱动…': 'Loading drivers…',
  '未下载': 'Not downloaded',
  '当前版本': 'Current version',
  '更新与下载源': 'Update and download source',
  '自动尝试公共加速镜像': 'Try public download mirrors automatically',
  '下载镜像前缀（可选，加速 GitHub）': 'Download mirror prefix (optional; speeds up GitHub downloads)',
  '检测间隔': 'Check interval',
  '文件互通': 'File sharing',
  '系统集成': 'System integration',
  '安卓系统设置（不用进安卓桌面）': 'Android system settings (no desktop needed)',
  '运行状态': 'Runtime status',
  '运行时已就绪 · 应用窗口会按屏幕自动适配': 'Runtime ready · App windows adapt to the screen automatically',
  '已就绪 · Android': 'Ready · Android',
  '组件齐全 · 待开机（打开应用时自动拉起）': 'All components installed · Starts automatically when you open an app',
  '组件齐全，双击任意 APK 或桌面图标即会自动开机': 'All components installed. Double-click an APK or desktop shortcut to start Android.',
  '还差': 'Still needed:',
  '；点下面「一键完成」，会在后台一次装好并自动开机': '; select Set up automatically below to install everything and start Android.',
  '已自动完成': 'Set up automatically',
  '一切就绪': 'All set',
  '安装程序运行中 —— 请在虚拟机窗口里完成安装': 'Installer is running — finish installation in the virtual machine window',
  '运行时待机（安装或打开应用时会自动拉起）': 'Runtime idle (starts automatically when you install or open an app)',
  '运行时尚未安装 Android 系统 —— 打开设置 → 运行时继续': 'Android is not installed — open Settings → Runtime to continue',
  '未启用硬件加速：已回退软件模拟（很慢）。点右下角「环境自检 → 修复」开启': 'Hardware acceleration is disabled; software rendering is being used (slow). Select System check → Fix at the bottom right to enable it.',
  '缺少 Android 14 通用系统镜像 —— 设置 → 运行时里下载（约 1.5GB，只下一次）': 'The Android 14 system image is missing — download it under Settings → Runtime (about 1.5 GB, one-time download).',
  '运行时引擎未安装 —— 打开设置 → 运行时一键完成': 'The runtime engine is not installed — open Settings → Runtime and select Set up automatically.',
  '运行时已就绪 —— 安装 APK 或双击桌面图标会自动开机': 'Runtime ready — install an APK or double-click a desktop shortcut to start Android.',
  '运行时已就绪 · Android': 'Runtime ready · Android',
  '网络正常': 'Network connected',
  '虚拟机未联网': 'Virtual machine is offline',
  '安装中': 'Installing',
  '待开机': 'Ready to start',
  '待安装': 'Not installed',
  '待下载镜像': 'Image download required',
  '正在检测…': 'Checking…',
  '尚未检测': 'Not checked yet',
  '上次检测': 'Last check',
  '上次启动失败：': 'Last startup failed: ',
  '上次启动自动诊断：': 'Automatic startup diagnosis: ',
  '运行时、adb 授权、磁盘、数据分区、快照与设置冲突都检查过了。': 'The runtime, ADB authorization, disk space, data partition, snapshots, and conflicting settings were checked.',
  '没有发现影响使用的问题。': 'No issues affecting use were found.',
  '上次检测': 'Last checked',
  '项待处理': 'items need attention',
  '一项待处理': '1 item needs attention',
  '没有发现': 'No issues found',
  '本机自适应参数': 'Automatic settings for this PC',
  '全自动：无需选择镜像、无需启用加速、无需调内存': 'Fully automatic: no image selection, acceleration setup, or memory tuning required',
  '首次使用：打开右上角设置 → 运行时 → 一键完成，再回来安装应用即可。': 'First time here? Open Settings → Runtime → Set up automatically, then return to install apps.',
  '提示：所有应用共享同一个 Android 运行时，所以第二个应用的启动几乎是瞬时的。': 'Tip: All apps share one Android runtime, so subsequent apps start almost instantly.',
  'Powered by RoutineMiku': 'Powered by RoutineMiku',
  '网络正常': 'Network OK',
  '应用已就绪': 'App is ready',
  '设置页': 'Settings',
  '开始使用': 'Get Started',
  '已安装应用': 'Installed apps',
  '安卓运行时': 'Android runtime',
  '就绪': 'Ready',
  '待命': 'Idle',
  '支持单个或多个 .apk 文件': 'Supports one or more .apk files',
  '选择设置项': 'Choose a setting',
  '运行时状态': 'Runtime status',
  '一键修复全部': 'Fix all automatically',
  '重新检查': 'Check again',
  '修复': 'Fix',
  '导出': 'Export',
  '正在检测…': 'Checking…',
  '一切正常': 'Everything is working',
  '没有发现影响使用的问题。': 'No issues affecting use were found.',
  '设置修改后立即生效': 'Changes take effect immediately',
  '完成': 'Done',
  '开始体检': 'Run system check',
  '运行时已就绪': 'Runtime ready',
  '运行时未连接': 'Runtime not connected',
  '独立窗口已启用': 'Standalone windows enabled',
  '下午好，欢迎回来': 'Good afternoon, welcome back',
  'ApkStart · 运行时会按需自动准备': 'ApkStart · The runtime is prepared on demand',
  '已装应用': 'Installed apps',
  '设备 / 端口': 'Device / port',
  '把 APK 拖进窗口就能安装，装完会自动生成桌面图标': 'Drop an APK into the window to install it. A desktop shortcut is created when installation finishes.',
  '关窗口只是退出那个应用，安卓环境会留着，下次点开更快': 'Closing a window only exits that app. Android stays running so the next app opens faster.',
  '已完成 · 点此复查': 'Completed · Click to check again',
  '环境自检通过，没有发现会影响运行的问题。': 'System check passed. No issues that affect operation were found.',
  '系统自检通过，没有发现会影响运行的问题。': 'System check passed. No issues that affect operation were found.',
  '共 8.2 GB · 已是精简状态': '8.2 GB total · Already optimized',
  '连当前 AVD 的快速启动快照也一起清（会先停运行时，能真正回收几 GB 快照）': 'Also remove quick-boot snapshots for the current AVD (the runtime will stop first; this can reclaim several GB)',
  '诊断报告用于排障；重建会补齐桌面 + 开始菜单入口': 'Diagnostic reports help with troubleshooting. Rebuild restores desktop and Start menu shortcuts.',
  '允许 USB 调试吗': 'Allow USB debugging?',
  '让 Windows 决定': 'Let Windows decide',
  '自动模式': 'Automatic mode',
  '运行时会按需自动准备': 'The runtime is prepared on demand',
  '设备 / 端口': 'Device / port',
  '已装应用': 'Installed apps',
  '把 APK 拖进窗口就能安装': 'Drop an APK into the window to install it',
  '关窗口只是退出那个应用': 'Closing a window only exits that app',
  '运行时、adb 授权、磁盘、数据分区、快照与设置冲突都检查过了。': 'The runtime, ADB authorization, disk space, data partition, snapshots, and conflicting settings were checked.',
  '均衡 · 4 核 / 4 GB / 720p': 'Balanced · 4 cores / 4 GB / 720p',
  '均衡 · 4 核 / 4 GB / 720p': 'Balanced · 4 cores / 4 GB / 720p',
  '自动：': 'Automatic: ',
  '把 APK 拖进窗口就能安装，装完会自动生成桌面图标': 'Drop an APK into the window to install it. A desktop shortcut is created when installation finishes.',
  'ApkStart 用': 'ApkStart uses ',
  '专用 adb 服务端口 ': 'dedicated ADB server port ',
  '（你系统里自己的 adb 是 ': '(your system ADB uses ',
  '），所以命令行里': '), so in the command line',
  ' 看不到这台安卓设备 —— 这是刻意的隔离。想连的话用': ' you will not see this Android device; this separation is intentional. To connect, use',
  ' 再执行 adb。': ' before running ADB.',
  '。注意：别对着 5555 端口手动 ': '. Do not manually run ',
  '，那会在正在运行的应用上弹出 「允许 USB 调试吗」的系统弹窗。': ', which would show an “Allow USB debugging?” dialog over the running app.',
  '应用、存档与快照会保留': 'Apps, saves, and snapshots are preserved',
  '桌面图标被误删或被安全软件拦掉时，点这里按当前设置全部补齐。': 'Use this to restore shortcuts if they were deleted or blocked by security software.',
  '系统镜像全机共享一份，应用数据用差分层保存；旧镜像、旧快照、日志和锁文件都可回收。日志超过上限会自动滚动，不会无限增长。「重置安卓数据」会真实删除数 GB 用户数据，仅保留系统本身。': 'The system image is shared by all apps; app data is stored separately. Old images, snapshots, logs, and lock files can be reclaimed. Logs rotate automatically at the size limit. Resetting Android data permanently deletes several GB of user data while keeping the system.',
  '专用 adb 服务端口 5044': 'dedicated ADB server port 5044',
  '（你系统里自己的 adb 是 5037），所以命令行里': '(your system ADB uses port 5037), so in the command line',
  '看不到这台安卓设备 —— 这是刻意的隔离。想连的话用': 'this Android device is intentionally isolated. To connect, use',
  '再执行 adb。 注意：别对着 5555 端口手动': 'before running ADB. Note: do not manually connect to port 5555',
  '内存、核心数、渲染后端、端口、加速方式全部自动选择；启动失败会自动降级重试，不需要手动改。': 'Memory, CPU cores, renderer, ports, and acceleration are selected automatically. If startup fails, ApkStart retries with safer settings.',
  '随时按': 'Press ',
  '或右键托盘切换；全屏只放大窗口，不改变画面比例，切换不重启应用。': 'or right-click the tray icon to switch. Fullscreen enlarges the window without changing the aspect ratio or restarting the app.',
  '虚拟手机面板的真实方向': 'the actual orientation of the virtual device display',
  '决定的。面板方向和应用自己声明的方向不一致时，': 'determines Android orientation. If it differs from the orientation requested by the app, ',
  '安卓只会给应用中间一条窄画面、两侧补黑 —— 换窗口大小、改分辨率都填不满。': 'Android displays a narrow image with black bars on the sides. Resizing the window or changing the resolution will not fill them.',
  '「跟随应用」会在安装 APK 时读出应用的方向，启动时自动把面板换成一致的那个，': 'Follow app reads the app orientation when the APK is installed and automatically matches the display when launching it, ',
  '所以红果、墨读这类应用会正立且铺满。方向不对时才重启一次运行时（约十几秒），': 'so apps display upright and fill the screen. The runtime restarts only when the orientation needs to change (about 10 seconds), ',
  '之后再打开同一方向的应用都是秒进。': 'and apps with the same orientation start quickly afterward.',
  '。注意这不影响画面方向：面板方向和屏幕方向仍由上面的': '. This does not control display orientation, which is still determined by the settings above',
  '策略 + 忽略应用方向请求决定，不会被传感器带歪。只有个别应用读取这个开关值时才会用到。': 'and is not affected by sensors. This setting is only relevant to apps that read the auto-rotate switch.',
  '720 宽按 190dpi 算等于 606dp，正好越过 Android 的 600dp 平板断点，': 'At 190 dpi, a 720-pixel width equals 606 dp, just above Android’s 600 dp tablet breakpoint. ',
  '红果短剧的双列剧集页、设置页的分栏都只在这个排版下出现。关掉会回到手机排版': 'Some apps show their tablet layout only at this size. Turn this off to return to the phone layout',
  '当前数据分区：尚未创建 · 所在磁盘剩余 未知。游戏提示「存储空间不足」就把这里调大后点「立即扩容」；能就地扩容时不丢已装应用。': 'Current data partition: not created · Free disk space: unknown. Increase the size here and select Expand now if a game reports insufficient storage. In-place expansion preserves installed apps.',
  '系统设置、权限弹窗、日期格式的语言。开机时注入到虚拟机，': 'Language used by Android settings, permission dialogs, and date formats. Applied to the virtual machine at startup; ',
  '。中文输入法不受此项影响，单独在下面开关。': '. The Chinese keyboard is controlled separately below.',
  '镜像只带英文键盘，勾上会静默安装并启用随包的谷歌拼音输入法， 这样在安卓应用里能直接打中文。关掉则保持系统原生输入法。': 'The image only includes an English keyboard. Enable this option to silently install and enable Google Pinyin so you can type Chinese in Android apps. Turn it off to use the system keyboard.',
  '当前数据分区：': 'Current data partition: ',
  '当前数据分区：尚未创建 · 所在磁盘剩余 未知。游戏提示「存储空间不足」就把这里调大后点「立即扩容」；能就地扩容时不丢已装应用。': 'Current data partition: not created · Free disk space: unknown. Increase the size here and select Expand now if a game reports insufficient storage. In-place expansion preserves installed apps.',
  '给安卓指定国内公共 DNS（阿里 / 腾讯）。安卓默认走主机的 DNS，主机挂着 VPN 或走公司网时解析会拖到几百毫秒，视频类应用首屏发慢。内网域名访问异常时可关掉。': 'Use public DNS servers in China (Alibaba / Tencent) for Android. The default host DNS can be slow when using a VPN or corporate network, delaying video apps. Turn this off if internal domains stop resolving.',
  '让应用提示音、视频声音正常播放。仅在你完全不需要声音、想再省一点 CPU 时关闭。': 'Enables app sounds and video audio. Turn this off only if you do not need sound and want to save a little CPU.',
  '让应用能用电脑的麦克风语音、通话、录音。关掉后应用里查不到录音设备。仅在你担心隐私、完全不需要录音时关闭。': 'Allows Android apps to use your PC microphone for voice input, calls, and recording. Turn this off if you do not need recording or have privacy concerns.',
  '保留快速启动快照（推荐）': 'Keep quick-boot snapshots (recommended)',
  '第二次打开应用只要几秒，代价是磁盘上多一份约 2–3 GB 的': 'Subsequent app launches take only a few seconds, at the cost of an extra 2–3 GB ',
  '。磁盘紧张可以关掉：只影响启动速度，不影响应用与存档。': '. Disable this if disk space is limited; only startup speed is affected, not apps or saves.',
  '容器细节（高级）': 'Container details (advanced)',
  '收敛 vCPU 配额并降低进程优先级，CPU 优先让给 Windows 桌面。上面的「资源策略」已经会自动设置这一项。': 'Limits vCPU allocation and lowers process priority so Windows gets CPU first. The Resource profile above already configures this automatically.',
  '虚拟机优先级': 'Virtual machine priority',
  '深度裁剪系统后台': 'Trim Android background services',
  '额外禁用 Play 商店、设置向导、打印服务等后台包，只留打开应用必需的环境。若遇到应用提示缺少 Google Play 服务，关掉此开关会自动恢复。': 'Disables background packages such as Play Store, setup wizard, and print services, keeping only what apps need. Turn this off to restore them if an app requires Google Play services.',
  '开机预热（推荐）': 'Warm up at startup (recommended)',
  '启动 ApkStart 后就在后台把安卓环境引导好（窗口全程隐藏，不会看到模拟器）。之后点任何应用只剩一次「打开」，实测从 20 多秒降到几乎不用等。代价是空闲时常驻约 1GB 内存，关掉后第一次打开应用需要冷启动。': 'ApkStart prepares Android in the background after startup (the emulator window stays hidden). Apps then open almost instantly instead of taking 20+ seconds. This uses about 1 GB of memory while idle; if disabled, the first app launch requires a cold boot.',
  '安卓环境只开机一次并常驻；之后打开应用不再重跑整个系统，只启动该应用并停掉其他应用进程。关掉最后一个窗口会清后台、停放容器，下次点开仍是秒进。': 'Android starts once and stays running. Opening an app starts only that app instead of rebooting the system. Closing the last window cleans up background processes and parks the container.',
  'ApkStart 只跑自己的运行时：adb / emulator / 系统镜像都由它自己下载和管理， 不探测、不接管、不依赖你电脑上装的任何模拟器（MuMu / 雷电 / 蓝叠 / WSA 都不会被使用）。 这样换机器、别人装没装模拟器、模拟器怎么升级，都不影响这里。': 'ApkStart uses its own runtime and manages its own ADB, emulator, and system image. It does not detect, control, or depend on other emulators installed on your PC (MuMu, LDPlayer, BlueStacks, or WSA).',
  '由 ApkStart 自己分配（emulator-5554，端口冲突时自动顺延），无需填写。': 'Assigned automatically by ApkStart (emulator-5554; advances if the port is in use). No input is needed.',
  '本机：/ · 未知 显卡 · 未知 · emulator 未知；驱动 0 个，本机已生效 0 个。': 'This PC: / · Unknown GPU · Unknown · emulator unknown; 0 drivers, 0 active on this PC.',
  '现在': 'now',
  '用的物理面板方向，由上面那条策略自动写入。 只有在「强制」模式下它才完全由你决定。': 'is the physical display orientation, set automatically by the policy above. You can choose it directly only in forced-orientation mode.',
  '原生窗口由模拟器直接渲染和排布，拖拽、缩放、旋转都跟手，不会出现黑边或点击错位， 代价是多一个任务栏图标（横屏用托盘菜单或 Ctrl+Alt+R）。嵌入模式会把模拟器窗口塞进我们的窗口， 观感更统一、自带旋转按钮，但在缩放/旋转/切换应用时容易掉帧并出现黑边。改动在下次打开应用时生效。': 'Native windows are rendered directly by the emulator for smooth resizing and rotation, without black bars or misaligned clicks. The tradeoff is an extra taskbar icon. Embedded mode looks more integrated and includes a rotate button, but may cause dropped frames or black bars. Changes take effect the next time you open an app.',
  '鼠标侧键 · 返回 / 前进（默认关闭）': 'Mouse side buttons · Back / Forward (off by default)',
  '把键盘按键映射成安卓触屏点击/滑动。适合用键盘玩手游（WASD 移动、J/K 技能等）。 每个应用可以单独配置，右键应用卡片 → 「按键映射」选择预设模板或自定义。': 'Map keyboard keys to Android taps and swipes. Useful for playing mobile games with a keyboard (WASD movement, J/K skills, and more). Configure each app separately by right-clicking its card and choosing Key mapping.',
  '当前应用未配置按键映射。右键应用卡片可快速套用预设模板。': 'No key mapping is configured for the current app. Right-click its card to quickly apply a preset.',
  '游戏提示「存储空间不足」就把这里调大后点「立即扩容」；能就地扩容时不丢已装应用。': 'If a game reports insufficient storage, increase the size here and select Expand now. In-place expansion preserves installed apps.',
  '网络加速（推荐）': 'Network acceleration (recommended)',
  '安卓声音': 'Android audio',
  '麦克风输入（推荐）': 'Microphone input (recommended)',
  '本机 未知 内存 / undefined 核；内存最多可分 未知，核心最多 1 个（各留 1/4 内存与 1 核给 Windows）。数据分区上限 0 GB。': 'This PC: unknown memory / undefined cores; up to unknown memory and 1 CPU core available (reserves 1/4 of memory and 1 core for Windows). Data partition limit: 0 GB.',
  '通用兼容镜像（自动管理）': 'Universal compatibility image (managed automatically)',
  '现在只有一个 Android 14 通用镜像，x86 与 ARM 应用都能跑，首次遇到 ARM 应用时会自动下载，不需要手动切换。此开关仅用于旧配置兼容。': 'A single Android 14 image supports both x86 and ARM apps. The first time an ARM app is installed, its support files are downloaded automatically. This setting is only for compatibility with older configurations.',
  '「自动」会同时问 GitHub 与 Gitee 的最新版本，把每个下载地址都真下 256KB 测一次速度，再从最快的那个地址下载；其中一个源不通不影响更新。': 'Automatic mode checks GitHub and Gitee for the latest version, tests each download URL with a 256 KB sample, then downloads from the fastest source. Updates still work if one source is unavailable.',
  'GitHub 直连太慢时，额外测速 ghfast.top / gh-proxy.com 这两个公开转发服务（只转发公开的发布文件，不涉及账号）。关掉后只用直连和你自己填的前缀。': 'If GitHub is slow, also test the public ghfast.top and gh-proxy.com proxies (they only relay public release files and do not access accounts). When disabled, only direct connections and your own prefix are used.',
  '填了就只用你填的前缀，不再尝试上面那两个公共镜像；留空则由「自动」逻辑决定。下载器会把它拼在真实地址前面。': 'When set, only this prefix is used instead of the public mirrors above. Leave blank to use automatic selection. The downloader prepends it to the original URL.',
  '大文件按块并行下载。默认 8 线程已经能跑满大多数家宽；网络稳定时可以试 16。': 'Large files are downloaded in parallel chunks. The default 8 connections are sufficient for most home broadband; try 16 on a stable connection.',
  '本项目仓库已公开，Gitee 的发行版列表匿名就能读，留空也能用 Gitee 源。 只有在「Gitee 被限流（返回 403/429）」或你想读私有分支时才需要填： gitee.com → 设置 → 私人令牌，只勾「projects」即可，它只用于读取发行版列表， 不会上传任何东西。': 'This repository is public, so Gitee release listings can be read anonymously. A token is only needed if Gitee rate-limits you (403/429) or you need private branches. Create a token under Gitee → Settings → Personal tokens and select only “projects”; it is used only to read release listings and never uploads anything.',
  '先查一遍这台机器：CPU 虚拟化有没有开、Windows 的虚拟机监控程序平台在不在、 显卡是什么、显存多大、内存和系统版本够不够。能自动改的（内存 / 核心 / 画质 / 渲染后端）直接写进设置， 并把结果固化成一份驱动；必须管理员权限的给按钮；只能在 BIOS 里改的会告诉你怎么改。': 'Checks CPU virtualization, the Windows Hypervisor Platform, GPU and video memory, available RAM, and Windows version. Automatically adjustable settings are applied and saved as a driver. Administrator-only changes get an action button; BIOS changes include instructions.',
  '有些机器要改启动参数才跑得起来（老显卡 GLES 版本低、没开硬件加速、某版驱动一开硬件渲染就崩）。 驱动就是一份 JSON：声明「匹配哪些机器」+「命中后改哪些启动参数」。你可以自己写、导入、分享。 驱动只改白名单里的启动项，': 'Some PCs need different startup parameters to run (older GPUs with low GLES versions, disabled hardware acceleration, or drivers that crash with hardware rendering). A driver is a JSON file that specifies which PCs it matches and which startup settings to apply. Drivers only modify allowlisted settings; ',
  '不执行任何代码': 'they do not execute any code',
  '；匹配不上就不生效。': '; they have no effect when the PC does not match.',
  '还没有任何驱动。可以点「导出本机模板」做一个，或导入别人做好的 JSON。': 'No drivers yet. Select Export local template to create one or import a JSON file.',
  '「导出本机模板」会把匹配条件按这台机器填好，改': 'Export local template fills in the match conditions for this PC. Edit ',
  '里的': ' in ',
  '就能用。字段说明见仓库里的': ' to use it. See ',
  '后台定时把这台机器查一遍：安卓运行时有没有起来、adb 授权是否正常、磁盘还剩多少、 数据分区是不是被差量盘挡住、快照有没有坏、设置之间有没有互相打架。 只在发现': 'Periodically checks whether Android is running, ADB is authorized, disk space is available, the data partition is accessible, snapshots are healthy, and settings are compatible. Notifications appear only for ',
  '新的': 'new ',
  '的严重问题时弹一次通知，其余都安静地列在下面。': 'serious issues; other results are listed here without notifications.',
  '关掉后不再定时扫描；随时可以点「立即检测」手动跑一次。': 'When disabled, scheduled scans stop. Select Check now to run one manually at any time.',
  '只对严重问题弹通知；已知的老问题不重复打扰。': 'Notifications are shown only for serious issues; known issues are not repeated.',
  '设备连接': 'Device connection',
  '安卓设备未授权调试': 'Android device has not authorized debugging',
  '重启运行时后会重新弹出确认框。': 'The confirmation prompt will appear again after restarting the runtime.',
  '存储': 'Storage',
  '运行时所在磁盘空间偏紧': 'Low disk space on the runtime drive',
  '剩余不足 8 GB。': 'Less than 8 GB remaining.',
  '屏幕方向策略与当前面板方向相反': 'Screen orientation policy conflicts with the current display orientation',
  '把面板方向改成与策略一致即可。': 'Set the display orientation to match the policy.',
  '未关联 · 点击开启': 'Not associated · Click to enable',
  '这里占用空间最大（数 GB）。改到非系统盘可大幅减轻 C 盘压力；修改后需重启软件，已存在的数据不会自动搬移（请手动复制后删除旧目录）。': 'This folder uses the most space (several GB). Move it off the system drive to reduce C: usage. Restart the app after changing it. Existing data is not moved automatically; copy it manually, then remove the old folder.',
  '真正吃盘的是这一块：数据分区（默认 6 GB，可在上面对大）+ 快速启动快照（约 2–3 GB）。 磁盘紧张时把它指到另一个盘（如 D:），重启软件后生效；旧目录里的': 'This folder uses the most disk space: the data partition (6 GB by default; increase it above) and quick-boot snapshots (about 2–3 GB). If space is low, move it to another drive (such as D:) and restart the app. The existing ',
  '可整体搬过去再删。': ' can be moved as a whole, then deleted from the old location.',
  '卸载会取消 .apk 关联并移除程序；便携版请按提示手动删除目录。': 'Uninstalling removes the .apk association and the app. For the portable edition, follow the prompts to delete its folder manually.',
  '已是最新版本（v0.6.0）': 'You are up to date (v0.6.0)',
  '从 GitHub（RoutineMiku/apkstart）获取最新版本；轻量版会下载便携包并自动替换程序文件， 运行时、已装应用与快照都不受影响。': 'Get the latest release from GitHub (RoutineMiku/apkstart). The lightweight edition downloads a portable package and replaces the app files; the runtime, installed apps, and snapshots are preserved.',
  '抖音 · 日常MIKU': 'TikTok · Daily MIKU',
  '双击即装的 Windows 安卓应用启动器：APK 安装、桌面快捷方式、独立窗口运行、文件双向互通。': 'A Windows Android app launcher: install APKs, create desktop shortcuts, run apps in separate windows, and share files both ways.',
  '抖音 · @日常MIKU（联系作者）': 'TikTok · @DailyMIKU (contact the author)',
  'Windows 原生多窗口 · 多开（实验性）': 'Native Windows multi-window · Run multiple apps (experimental)',
  '开启后打开新应用不再强制关闭上一个：多个应用可同时驻留、随时快速切回（保留登录态，不必重新加载），切回体验接近多窗口。 受限于安卓运行时只有一个模拟器窗口，同一时刻仍只有一个应用画面在前台显示，并非真正的同时并排多窗口。 会明显增加内存占用；关闭则回到「一次只显示一个应用」的稳定模式。': 'When enabled, opening a new app will not close the previous one. Apps stay resident and can be switched quickly without reloading or losing login state. The Android runtime has only one emulator window, so only one app is visible at a time; this is not true side-by-side multitasking. Memory use increases. Turn it off to return to the stable single-app mode.',

  '打开（推荐）· 每次启动应用都自动全屏': 'On (recommended) · Always launch apps fullscreen',
  '省资源 · 2 核 / 让出前台 / 540p（老机器、挂机）': 'Save resources · 2 cores / lower priority / 540p (older PCs, background use)',
  '均衡 · 一半物理核 / 让出前台 / 720p（推荐）': 'Balanced · Half of physical cores / lower priority / 720p (recommended)',
  '流畅 · 不限核数 / 与前台同优先级（视频、游戏）': 'Smooth · No CPU limit / foreground priority (video, games)',
  '设备地址': 'Device address',
  '本机共享目录': 'Shared folder on this PC',
  '安卓内对应目录': 'Matching folder on Android',
  '系统镜像（ISO）': 'System image (ISO)',
  '运行时数据目录（系统镜像 · 已装应用 · 快照）': 'Runtime data folder (system image · installed apps · snapshots)',
  '安卓数据目录（应用、游戏与快速启动快照）': 'Android data folder (apps, games, and quick-boot snapshots)',
  '卸载 ApkStart': 'Uninstall ApkStart',
  '关联 .apk 文件': 'Associate .apk files',
  '更新与下载源': 'Update and download sources',
  '运行时状态': 'Runtime status',
  '环境自检': 'System check',
  '导出诊断报告': 'Export diagnostic report',
  '启用自动检测（默认开启）': 'Enable automatic checks (on by default)',
  '发现新问题时通知我': 'Notify me when new issues are found',
  '自动尝试公共加速镜像': 'Try public download mirrors automatically',
  '本机体检 · 自动配置': 'System check · Automatic configuration',
  '一键完成': 'Set up automatically',
  '高级：连接已有运行时': 'Advanced: Connect an existing runtime',
  '同时添加到开始菜单': 'Also add to the Start menu',
  '安装后自动创建桌面快捷方式': 'Create a desktop shortcut after installation',
  '窗口模式下可拖动边框任意缩放；这里调的是 Android 内部渲染尺寸，越小越省性能。': 'In window mode, drag the borders to resize. This controls Android’s render resolution; lower values use fewer resources.',
  '安卓的横竖屏是': 'Android orientation is determined by the ',
  '面板和应用自己声明的方向不一致时，': 'When the display orientation does not match the orientation requested by an app, ',
  '安卓只会给应用中间一条窄画面、两侧补黑 —— 换窗口大小、改分辨率都填不满。': 'Android shows a narrow image with black bars on the sides. Resizing the window or changing the resolution cannot fill them.',
  '「跟随应用」会在安装 APK 时读出应用的方向，启动时自动把面板换成一致的那个，': 'Follow app reads the app orientation when the APK is installed and automatically matches the display when launching it, ',
  '所以红果、墨读这类应用会正立且铺满。方向不对时才重启一次运行时（约十几秒），': 'so apps display upright and fill the screen. The runtime restarts only when the orientation needs to change (about 10 seconds), ',
  '之后再打开同一方向的应用都是秒进。': 'and apps with the same orientation start quickly afterward.',
  '安卓里': 'In Android, ',
  '自动旋转开关默认打开': 'auto-rotate is enabled by default',
  '。注意这不影响画面方向：面板方向和屏幕方向仍由上面的': '. This does not control the display orientation, which is still determined by the settings above',
  '策略 + 忽略应用方向请求决定，不会被传感器带歪。只有个别应用读取这个开关值时才会用到。': 'and is not affected by sensors. This setting is only relevant to apps that read the auto-rotate switch.',
  '720 宽按 190dpi 算等于 606dp，正好越过 Android 的 600dp 平板断点，': 'At 190 dpi, a 720-pixel width equals 606 dp, just above Android’s 600 dp tablet breakpoint. ',
  '红果短剧的双列剧集页、设置页的分栏都只在这个排版下出现。关掉会回到手机排版': 'Some apps show their tablet layout only at this size. Turn this off to return to the phone layout',
  '（字更大、信息更少）。切换后下次打开应用生效。': '(larger text and less information). Changes take effect the next time you open an app.',
  '这是运行时': 'This is the runtime’s ',
  '用的物理面板方向，由上面那条策略自动写入。': 'physical display orientation, set automatically by the policy above.',
  '只有在「强制」模式下它才完全由你决定。': 'You can choose it directly only when using a forced orientation.',
  '原生窗口由模拟器直接渲染和排布，拖拽、缩放、旋转都跟手，不会出现黑边或点击错位，': 'Native windows are rendered directly by the emulator for smooth dragging, resizing, and rotation, without black bars or misaligned clicks. ',
  '代价是多一个任务栏图标（横屏用托盘菜单或 Ctrl+Alt+R）。嵌入模式会把模拟器窗口塞进我们的窗口，': 'The tradeoff is an extra taskbar icon (use the tray menu or Ctrl+Alt+R for landscape). Embedded mode places the emulator inside the ApkStart window, ',
  '观感更统一、自带旋转按钮，但在缩放/旋转/切换应用时容易掉帧并出现黑边。改动在下次打开应用时生效。': 'for a more integrated look and a rotate button, but may cause dropped frames or black bars when resizing, rotating, or switching apps. Changes take effect the next time you open an app.',
  '决定安卓虚拟机吃多少 CPU、画面多细腻。红果/抖音发卡就切「流畅」，只想挂着跑小应用就切「省资源」。改完下一次打开应用生效。': 'Controls Android CPU usage and image quality. Choose Smooth for video or games, or Save resources for lightweight apps running in the background. Changes take effect the next time you open an app.',
  '游戏模式会让安卓虚拟机保持较高 CPU 优先级并减少宿主侧轮询，输入与画面延迟最低；代价是整机其他程序会变慢。没有应用窗口时容器仍会自动降优先级停放。': 'Game mode gives the Android virtual machine higher CPU priority and reduces host polling for lower input and display latency. Other programs may run more slowly. When no app window is open, the container automatically lowers its priority.',
  '第二次打开应用只要几秒，代价是磁盘上多一份约 2–3 GB 的 ram.bin。磁盘紧张可以关掉：只影响启动速度，不影响应用与存档。': 'Subsequent launches take only a few seconds, at the cost of an extra 2–3 GB ram.bin file. Disable this if disk space is limited; only startup speed is affected, not apps or saves.',
  '从 GitHub（RoutineMiku/apkstart）获取最新版本；轻量版会下载便携包并自动替换程序文件，运行时、已装应用与快照都不受影响。': 'Check GitHub (RoutineMiku/apkstart) for the latest version. The lightweight edition downloads a portable package and replaces the app files; your runtime, apps, and snapshots are preserved.',
  '设置项：横屏 / 内存 / 代理 / 快照…': 'Search settings: orientation / memory / proxy / snapshots…',
  '搜索设置项：横屏 / 内存 / 代理 / 快照…': 'Search settings: orientation / memory / proxy / snapshots…',
  '留空 = 桌面': 'Leave blank to use the Desktop',
  '留空则自动在 PATH / Android SDK 中查找': 'Leave blank to search PATH and the Android SDK automatically',
  'Android-x86 / Bliss OS 的 ISO 或 IMG 路径，留空使用默认位置': 'Path to an Android-x86 / Bliss OS ISO or IMG; leave blank to use the default',
  '正在检查…': 'Checking…',
  '检查中…': 'Checking…',
  '立即检测': 'Check now',
  '尚未检查': 'Not checked yet',
  '检查更新': 'Check for updates',
  '一键卸载': 'Uninstall',
  '浏览': 'Browse',
  '立即同步': 'Sync now',
  '保存并迁移': 'Save and migrate',
  '打开': 'Open',
  '手动设置': 'Manual setup',
  '已是最新版本': 'You are up to date',
  '还没有应用': 'No apps yet',
  '首次使用：打开右上角设置 → 运行时 → 一键完成，再回来安装应用即可。': 'First time here? Open Settings → Runtime → Set up automatically, then return to install apps.',
  '本机不匹配': 'Does not match this PC',
  '命中：': 'Matched: ',
  '已生效': 'Active',
  '内置示例': 'Built-in example',
  'AMD 核显 · 改用 swangle 渲染（示例）': 'AMD integrated GPU · Use swangle rendering (example)',
  '部分 AMD 核显 + 老驱动下，-gpu host 能通过 emulator 自检，但 guest 起起来十几秒后进程直接崩溃（日志里只有 AEHD is operational）。把渲染后端固定成 swangle 可以绕过，代价是帧率略低。': 'With some AMD integrated GPUs and older drivers, -gpu host passes the emulator self-check, but the process crashes seconds after the guest starts (the log only shows “AEHD is operational”). Forcing the swangle renderer can avoid this, at the cost of a slightly lower frame rate.',
  'Intel 核显 · 软件渲染兜底（示例）': 'Intel integrated GPU · Software rendering fallback (example)',
  '老款 Intel 核显（HD / UHD 6xx 之前）在部分驱动版本上会出现 GLES 初始化失败或花屏。把渲染后端固定为 software，画面一定能出来。': 'Older Intel integrated GPUs (before HD/UHD 6xx) may fail GLES initialization or show visual artifacts with some driver versions. Forcing the software renderer should ensure the display works.',
  '没有硬件加速 · 直接走软件模拟（示例）': 'No hardware acceleration · Use software emulation (example)',
  '软件模拟比硬件加速慢 5~10 倍，能开虚拟化时建议还是去「Windows 功能」里勾上虚拟机平台': 'Software emulation is 5–10 times slower than hardware acceleration. If virtualization is available, enable the Virtual Machine Platform in Windows Features.',
  '如果画面正常但游戏很卡，可以在设置里把「画质」调成 540×960': 'If the display works but games are slow, lower Graphics quality to 540×960 in Settings.',
  '确认可用后，把 enabled 改成 true 或删掉这一行，就能自动生效': 'Once confirmed, set enabled to true or remove this line to apply the driver automatically.',
  '画面能出来但游戏会卡：这类机器更适合玩轻量应用': 'The display should work, but games may be slow. This hardware is better suited to lightweight apps.',
  '统计不可用': 'Usage statistics unavailable',
  '自动模式': 'Automatic mode',
  '（当前系统不支持此设置）': '(This setting is not supported on this system)',
  '（已生效：': '(Applied: ',
  '（已选 ': '(Selected ',
  '，下次启动安卓后生效）': '; takes effect the next time Android starts)',
  '机器没开「虚拟机监控程序平台」、也不允许装内核驱动时，emulator 走硬件加速会直接失败。这个补丁让 ApkStart 一开始就用软件模拟（-accel off），省掉两轮白等；同时把渲染后端换成 software，避免 GL 初始化失败。': 'If the Windows Hypervisor Platform is disabled and kernel drivers cannot be installed, emulator hardware acceleration fails immediately. This patch starts ApkStart with software emulation (-accel off) to avoid two wasted retries, and switches the renderer to software to prevent GL initialization failures.',
  '未启用硬件加速': 'Hardware acceleration is disabled',
  '当前没有硬件加速': 'Hardware acceleration is unavailable',
  '未安装 emulator点右侧「修复」会自动开启（需要管理员授权，可能要重启一次）；失败时会自动改装 AEHD 驱动。': 'The emulator is not installed. Select Fix on the right to enable hardware acceleration (administrator approval and possibly a restart are required); if that fails, the AEHD driver will be installed instead.',
  '未启用硬件加速：将回退软件模拟（能跑但很慢）。建议安装 AEHD 驱动或开启「虚拟机平台」点右侧「修复」会自动开启（需要管理员授权，可能要重启一次）；失败时会自动改装 AEHD 驱动。': 'Hardware acceleration is disabled, so software emulation will be used (it works but is slow). Install the AEHD driver or enable the Virtual Machine Platform. Select Fix on the right to enable it (administrator approval and possibly a restart are required); if that fails, the AEHD driver will be installed instead.',
  '只能跑纯软件模拟，开机慢到几分钟、画面也容易掉帧。开启「Windows 虚拟机监控程序平台」后重启即可。': 'Only software emulation is available, so startup may take several minutes and the display may stutter. Enable the Windows Hypervisor Platform and restart your PC.',
};

const UI_PHRASES = [
  ['ApkStart 用', 'ApkStart uses '],
  ['专用 adb 服务端口', 'dedicated ADB server port'],
  ['（你系统里自己的 adb 是 ', '(your system ADB uses port '],
  ['），所以命令行里', '), so in the command line'],
  ['看不到这台安卓设备 —— 这是刻意的隔离。想连的话用', 'you will not see this Android device; this isolation is intentional. To connect, use'],
  ['再执行 adb。', ' before running ADB.'],
  ['注意：别对着 5555 端口手动', 'Note: do not manually connect to port 5555'],
  ['，那会在正在运行的应用上弹出 「允许 USB 调试吗」的系统弹窗。', '; this opens an “Allow USB debugging?” dialog over the running app.'],
  ['内存、核心数、渲染后端、端口、加速方式全部自动选择；启动失败会自动降级重试，不需要手动改。', 'Memory, CPU cores, renderer, ports, and acceleration are selected automatically. If startup fails, ApkStart retries with safer settings.'],
  ['自动：', 'Automatic: '],
  ['GB 内存', ' GB memory'],
  ['核 · ', ' cores · '],
  [' 核', ' cores'],
  [' 渲染', ' rendering'],
  ['按需快照', 'on-demand snapshots'],
  ['冷启动', 'cold boot'],
  ['轻量容器', 'lightweight container'],
  ['端口 ', 'port '],
  ['无硬件加速，将回退软件模拟', 'No hardware acceleration; software rendering will be used'],
  ['本机不匹配', 'Does not match this PC'],
  ['命中：', 'Matched: '],
  ['独立窗口已启用', 'standalone windows enabled'],
  ['缺少 ', 'Missing '],
  ['还差 ', 'Still needed: '],
  ['adb 授权', 'ADB authorization'],
  ['剩余', 'remaining'],
  ['正在检测：', 'Checking: '],
  ['正在统计：', 'Calculating: '],
  ['缺少 ', 'Missing '],
  ['已就绪 · Android ', 'Ready · Android '],
  ['运行时已就绪 · Android ', 'Runtime ready · Android '],
  ['组件齐全 · 待开机', 'All components installed · Ready to start'],
  ['组件齐全，双击任意 APK 或桌面图标即会自动开机', 'All components installed. Double-click any APK or desktop shortcut to start Android.'],
  ['无硬件加速，将回退软件模拟', 'No hardware acceleration; software rendering will be used'],
  ['引擎', 'engine'],
  ['系统镜像', 'system image'],
  ['adb 工具链', 'ADB tools'],
  ['待开机', 'Ready to start'],
  ['已自动完成', 'Completed automatically'],
  ['运行时待机', 'Runtime idle'],
  ['待安装', 'Not installed'],
  ['待下载镜像', 'Image download required'],
  ['待机', 'Idle'],
  ['已安装', 'Installed'],
  ['未启用', 'Not enabled'],
  ['未联网', 'Offline'],
  ['状态', 'Status'],
  ['网络正常', 'Network connected'],
  ['一键流畅优化', 'Optimize performance'],
  ['检测间隔', 'Check interval'],
  [' 分钟', ' minutes'],
  [' 小时', ' hours'],
  ['项待处理', 'items need attention'],
  [' · 一切正常', ' · Everything is working'],
  ['正在检测…', 'Checking…'],
  ['尚未检测', 'Not checked yet'],
  ['上次检测', 'Last checked'],
  ['打开下载页', 'Open download page'],
  ['应用正在独立窗口中运行', 'The app is running in its own window'],
  ['正在检查运行时', 'Checking the runtime'],
  ['正在引导 Android', 'Starting Android'],
  ['选择 APK 文件', 'Choose APK file'],
  ['把 APK 拖进来就能装', 'Drop an APK here to install'],
  ['首次使用', 'First time here'],
  ['立即生效', 'takes effect immediately'],
  ['系统默认', 'System default'],
  ['镜像默认', 'image default'],
  ['应用会自动', 'Apps will automatically'],
  ['不会影响', 'does not affect'],
  ['仅用于', 'only used for'],
  ['仅在', 'only when'],
  ['功能不受影响', 'does not affect functionality'],
  ['无须', 'No need to'],
  ['无需', 'No need to'],
  ['是否正常', 'is working correctly'],
  ['下次打开应用生效', 'Takes effect the next time you open an app'],
  ['下次重启运行时生效', 'Takes effect after the next runtime restart'],
  ['下次启动安卓运行时后生效', 'Takes effect after the next Android runtime startup'],
  ['当前应用未配置按键映射', 'No key mapping is configured for the current app'],
  ['右键应用卡片', 'Right-click an app card'],
  ['正在检测运行时', 'Checking the runtime'],
  ['正在检查运行时', 'Checking the runtime'],
  ['正在读取', 'Loading'],
  ['正在统计', 'Calculating'],
  ['正在安装', 'Installing'],
  ['正在启动', 'Starting'],
  ['正在引导', 'Starting'],
  ['运行时已就绪', 'Runtime ready'],
  ['运行时未启动', 'Runtime is not running'],
  ['运行时未部署', 'Runtime is not installed'],
  ['一键完成', 'Set up automatically'],
  ['自动模式', 'Automatic mode'],
  ['默认开启', 'enabled by default'],
  ['默认关闭', 'disabled by default'],
  ['点击即可', 'Click to'],
  ['点下面', 'Click below'],
  ['打开设置', 'Open Settings'],
  ['设置 →', 'Settings →'],
  ['下一次打开应用', 'the next time you open an app'],
  ['下一次启动', 'the next startup'],
  ['下次启动', 'the next startup'],
  ['安卓运行时', 'Android runtime'],
  ['运行时', 'runtime'],
  ['系统镜像', 'system image'],
  ['兼容镜像', 'compatibility image'],
  ['已就绪', 'Ready'],
  ['未就绪', 'Not ready'],
  ['正在检测', 'Checking'],
  ['正在准备', 'Preparing'],
  ['正在下载', 'Downloading'],
  ['已安装', 'Installed'],
  ['未安装', 'Not installed'],
  ['无需设置', 'no setup required'],
  ['自动选择', 'selected automatically'],
  ['自动启动', 'Start automatically'],
  ['自动重试', 'retry automatically'],
  ['重启安卓', 'restart Android'],
  ['重启运行时', 'restart the runtime'],
  ['打开应用', 'open an app'],
  ['安装应用', 'install apps'],
  ['已安装应用', 'installed apps'],
  ['应用窗口', 'app window'],
  ['独立窗口', 'standalone window'],
  ['全屏', 'fullscreen'],
  ['竖屏', 'portrait'],
  ['横屏', 'landscape'],
  ['平板排版', 'tablet layout'],
  ['手机排版', 'phone layout'],
  ['硬件加速', 'hardware acceleration'],
  ['软件模拟', 'software rendering'],
  ['物理核', 'physical cores'],
  ['核心数', 'CPU cores'],
  ['内存', 'memory'],
  ['渲染分辨率', 'render resolution'],
  ['端口冲突', 'port conflict'],
  ['无需手动', 'no manual setup required'],
  ['请稍候', 'Please wait'],
  ['稍后再试', 'try again later'],
  ['请重试', 'Please try again'],
  ['检查失败', 'Check failed'],
  ['安装失败', 'Installation failed'],
  ['启动失败', 'Startup failed'],
  ['一切正常', 'Everything is working'],
  ['没有发现', 'No'],
  ['推荐', 'recommended'],
  ['已开启', 'enabled'],
  ['已关闭', 'disabled'],
];

const UI_TRANSLATION_PHRASES = [
  ...UI_PHRASES,
  ...Object.entries(UI_TEXT).filter(([source]) => source.length >= 8),
].sort((a, b) => b[0].length - a[0].length);

const BUILTIN_DRIVER_EN = {
  'example-amd-igpu-swangle': {
    name: 'AMD integrated GPU · Use swangle rendering (example)',
    description: 'With some AMD integrated GPUs and older drivers, -gpu host passes the emulator self-check, but the process crashes seconds after the guest starts (the log only shows “AEHD is operational”). Forcing the swangle renderer can avoid this, at the cost of a slightly lower frame rate.',
    notes: [
      'If the display works but games are slow, lower Graphics quality to 540×960 in Settings.',
      'Once confirmed, set enabled to true or remove this line to apply the driver automatically.',
    ],
  },
  'example-intel-igpu-software': {
    name: 'Intel integrated GPU · Software rendering fallback (example)',
    description: 'Older Intel integrated GPUs (before HD/UHD 6xx) may fail GLES initialization or show visual artifacts with some driver versions. Forcing the software renderer should ensure the display works.',
    notes: ['The display should work, but games may be slow. This hardware is better suited to lightweight apps.'],
  },
  'example-no-hypervisor-tcg': {
    name: 'No hardware acceleration · Use software emulation (example)',
    description: 'If the Virtual Machine Platform is disabled and kernel drivers cannot be installed, emulator hardware acceleration fails immediately. This patch starts ApkStart with software emulation (-accel off) to avoid two wasted retries, and switches the renderer to software to prevent GL initialization failures.',
    notes: ['Software emulation is 5–10 times slower than hardware acceleration. If virtualization is available, enable the Virtual Machine Platform in Windows Features.'],
  },
};

let uiLanguage = 'en';
const translatedText = new WeakMap();
let latestUsage = null;
let usageLoaded = false;

function localizedText(source) {
  const key = source.trim().replace(/\s+/g, ' ');
  if (uiLanguage !== 'en' || !key) return source;
  const translated = UI_TEXT[key];
  const leading = source.match(/^\s*/)[0];
  const trailing = source.match(/\s*$/)[0];
  if (translated) return `${leading}${translated}${trailing}`;
  const progressPatterns = [
    [/^下载运行时（约 (.+?)，只需一次，(\d+) 线程）…$/, (_m, size, threads) => `Downloading runtime (about ${size}, one-time download, ${threads} threads)…`],
    [/^下载运行时引擎（约 (.+?)，走 Google 官方源）…$/, (_m, size) => `Downloading runtime engine (about ${size}, from Google)…`],
    [/^下载 Android platform-tools（约 (.+?)）…$/, (_m, size) => `Downloading Android platform-tools (about ${size})…`],
    [/^正在从 (.+?) 下载运行时…$/, (_m, sourceName) => `Downloading runtime from ${sourceName}…`],
    [/^正在挑选最快的下载源（(.+?) · (.+?)）…$/, (_m, sourceName, tag) => `Selecting the fastest download source (${sourceName} · ${tag})…`],
    [/^下载 adb… (.+)$/, (_m, progress) => `Downloading ADB… ${progress}`],
    [/^下载运行时引擎 (.+)$/, (_m, progress) => `Downloading runtime engine ${progress}`],
    [/^下载兼容镜像 (.+)$/, (_m, progress) => `Downloading compatibility image ${progress}`],
    [/^解压运行时（约 (.+?)）…$/, (_m, duration) => `Extracting runtime (about ${duration})…`],
    [/^解压 (\d+)\/(\d+)$/, (_m, done, total) => `Extracting ${done}/${total}`],
    [/^正在准备 adb…$/, () => 'Preparing ADB…'],
    [/^正在准备 Android 运行时…$/, () => 'Preparing Android runtime…'],
    [/^正在准备 Android 系统镜像…$/, () => 'Preparing Android system image…'],
  ];
  for (const [pattern, render] of progressPatterns) {
    const match = key.match(pattern);
    if (match) return `${leading}${render(...match)}${trailing}`;
  }
  if (/^下载运行时 /.test(key)) {
    return `${leading}${key.replace(/^下载运行时 /, 'Downloading runtime ')
      .replace(' · 剩余约 ', ' · about ')
      .replace(/ 分钟/g, ' min')}${trailing}`;
  }
  const profile = key.match(/^自动：([\d.]+)GB 内存 · (\d+) 核 · (.+?) 渲染 · (硬件加速|软件模拟) · (按需快照|冷启动)( · 轻量容器)? · 端口 (\d+)$/);
  if (profile) {
    return `${leading}Automatic: ${profile[1]} GB memory · ${profile[2]} CPU cores · ${profile[3]} rendering · ${profile[4] === '硬件加速' ? 'hardware acceleration' : 'software emulation'} · ${profile[5] === '按需快照' ? 'on-demand snapshots' : 'cold boot'}${profile[6] ? ' · lightweight container' : ''} · port ${profile[7]}${trailing}`;
  }
  const phraseOutput = UI_TRANSLATION_PHRASES.reduce(
    (text, [from, to]) => text.replaceAll(from, to),
    key,
  );
  return `${leading}${/[\u3400-\u9fff]/.test(phraseOutput) ? key : phraseOutput}${trailing}`;
}

function formatUsageText(usage) {
  latestUsage = usage || null;
  usageLoaded = true;
  if (!usage) return uiLanguage === 'en' ? 'Usage statistics unavailable' : '统计不可用';
  if (uiLanguage === 'en') {
    return `Total ${usage.totalText}${usage.reclaimable
      ? ` · Reclaimable ${usage.reclaimableText} (${usage.count} ${usage.count === 1 ? 'item' : 'items'})`
      : ' · Already optimized'}`;
  }
  return `共 ${usage.totalText}${usage.reclaimable
    ? ` · 可回收 ${usage.reclaimableText}（${usage.count} 项）`
    : ' · 已是精简状态'}`;
}

function translateTextNode(node) {
  if (node.parentElement && node.parentElement.closest('[data-no-localize]')) return;
  const current = node.nodeValue;
  const previous = translatedText.get(node);
  const source = previous && current === previous.output ? previous.source : current;
  const output = localizedText(source);
  translatedText.set(node, { source, output });
  if (output !== current) node.nodeValue = output;
}

const TRANSLATABLE_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'value'];

function translateElement(el) {
  if (el.closest && el.closest('[data-no-localize]')) return;
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
  }
  if (el.nodeType === Node.ELEMENT_NODE) {
    for (const attr of TRANSLATABLE_ATTRIBUTES) {
      if (!el.hasAttribute(attr)) continue;
      const current = el.getAttribute(attr);
      const key = `attr:${attr}`;
      const previous = translatedText.get(el)?.[key];
      const source = previous && current === previous.output ? previous.source : current;
      const output = localizedText(source);
      const entry = translatedText.get(el) || {};
      entry[key] = { source, output };
      translatedText.set(el, entry);
      if (output !== current) el.setAttribute(attr, output);
    }
  }
}

let languageObserver = null;

function applyUiLanguage(language) {
  uiLanguage = language === 'zh-CN' ? 'zh-CN' : 'en';
  document.documentElement.lang = uiLanguage;
  if (usageLoaded && $('usageText')) $('usageText').textContent = formatUsageText(latestUsage);
  const scan = (root) => {
    if (root.nodeType === Node.TEXT_NODE) {
      translateTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root !== document.body) return;
    translateElement(root);
    root.querySelectorAll('*').forEach(translateElement);
  };
  scan(document.body);
  if (!languageObserver) {
    languageObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') translateTextNode(mutation.target);
        else if (mutation.type === 'attributes') translateElement(mutation.target);
        else mutation.addedNodes.forEach(scan);
      }
    });
    languageObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATABLE_ATTRIBUTES,
    });
  }
}

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initialOf(label) {
  const t = String(label || '?').trim();
  return (t[0] || '?').toUpperCase();
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (uiLanguage === 'en') {
    if (d < 60000) return 'Just now';
    if (d < 3600000) return `${Math.floor(d / 60000)} minutes ago`;
    if (d < 86400000) return `${Math.floor(d / 3600000)} hours ago`;
    if (d < 86400000 * 30) return `${Math.floor(d / 86400000)} days ago`;
    return new Date(ts).toLocaleDateString('en-US');
  }
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  if (d < 86400000 * 30) return `${Math.floor(d / 86400000)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/**
 * 迷你 toast
 *
 * 同一类消息做去重 + 数量上限：
 * 安装失败时里面有「运行时启动日志」在持续推送，以前每条都新建一个 toast，
 * 于是屏幕上会不停叠加同一条错误，看起来像「失败信息一直循环」。
 */
let _toastSeq = 0;
function toast({ title, body = '', type = 'info', progress = null, sticky = false, spinner = false }) {
  const wrap = $('toastWrap');
  // ① 去重：同样的标题 + 正文（4 秒内）只刷新那一条，不叠加
  const key = `${title}|${body}`;
  const dup = [...wrap.children].find((n) => n.dataset.key === key && Date.now() - Number(n.dataset.at || 0) < 4000);
  if (dup) {
    dup.dataset.at = String(Date.now());
    return {
      el: dup,
      dismiss: () => dup.remove(),
      update: ({ title: t2, body: b2 } = {}) => {
        if (t2 !== undefined) dup.querySelector('.t-title-text').textContent = t2;
        if (b2 !== undefined) dup.querySelector('.t-body').textContent = b2;
      },
    };
  }
  // ② 上限：同时最多 4 条，超出先挤掉最旧的
  while (wrap.children.length >= 4) wrap.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.dataset.key = key;
  el.dataset.at = String(Date.now());
  el.dataset.seq = String(++_toastSeq);
  el.innerHTML = `
    <div class="t-title">
      ${spinner ? '<span class="spinner"></span>' : ''}
      <span class="t-title-text">${esc(title)}</span>
    </div>
    <div class="t-body">${esc(body)}</div>
    ${progress === null ? '' : '<div class="bar"><i></i></div>'}
  `;
  $('toastWrap').appendChild(el);

  const dismiss = () => {
    el.style.transition = 'opacity .18s, transform .18s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 200);
  };

  const ctl = {
    el, dismiss,
    update({ title: t2, body: b2, progress: p2, type: ty } = {}) {
      if (t2 !== undefined) el.querySelector('.t-title-text').textContent = t2;
      if (b2 !== undefined) el.querySelector('.t-body').textContent = b2;
      if (p2 !== undefined && el.querySelector('.bar i')) {
        el.querySelector('.bar i').style.width = `${Math.max(2, Math.min(100, p2))}%`;
      }
      if (ty === 'error') el.classList.add('error');
      if (ty === 'ok') {
        el.querySelector('.spinner')?.remove();
        el.classList.remove('error');
      }
    },
  };

  if (!sticky) setTimeout(dismiss, type === 'error' ? 6000 : 3200);
  return ctl;
}

/* ---------------- 内置手册 ---------------- */

/** 打开内置手册；传故障信息时由主进程映射到对应章节 */
function openManual(payload) {
  if (!api || typeof api.openManual !== 'function') return Promise.resolve(null);
  return api.openManual(payload || { topic: 'overview' }).catch(() => null);
}

/** 自动检测问题 → 对应教程。reason 只影响主进程的去重策略。 */
function openManualForIssue(issue, reason = 'clicked') {
  if (!issue) return openManual({ topic: 'overview', reason });
  return openManual({
    issue: issue.code,
    title: issue.title,
    detail: issue.detail,
    reason,
  });
}

/** 安装/运行原始报错 → 对应教程 */
function openManualForError(message, reason = 'install-failed') {
  return openManual({ error: message, reason });
}

/* ---------------- 渲染 ---------------- */

function visibleApps() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.apps;
  return state.apps.filter((a) => (
    a.label.toLowerCase().includes(q)
    || a.package.toLowerCase().includes(q)
  ));
}

function renderGrid() {
  const apps = visibleApps();
  const grid = $('grid');
  const empty = $('empty');

  const hasAny = state.apps.length > 0;
  grid.classList.toggle('hidden', apps.length === 0);
  empty.classList.toggle('hidden', apps.length > 0);

  if (!hasAny) {
    const s = state.status;
    $('emptyHint').textContent = s && s.adbOk === false
      ? '首次使用：打开右上角设置 → 运行时 → 一键完成，再回来安装应用即可。'
      : '提示：所有应用共享同一个 Android 运行时，所以第二个应用的启动几乎是瞬时的。';
    grid.innerHTML = '';
    return;
  }

  // 末尾放一块「添加应用」虚线卡片。
  // 目的不只是好看：应用少的时候下面是一大片空白，用户不知道该干什么；
  // 这块卡片把「还能拖 APK 进来」这件事直接摆在眼前，也顺手填掉了空白。
  grid.innerHTML = apps.map((a) => `
    <div class="card" data-pkg="${esc(a.package)}" title="${esc(a.label)} · ${esc(a.package)}">
      ${a.pinned ? '<span class="pin">★</span>' : ''}
      ${a.running ? '<span class="badge-run" title="正在运行"></span>' : ''}
      <div class="icon">
        ${a.iconUrl
          ? `<img src="${esc(a.iconUrl)}" alt="" draggable="false" />`
          : `<div class="fallback" style="background:${esc(a.accent || '#9aa6b2')}">${esc(initialOf(a.label))}</div>`}
      </div>
      <div class="name" data-no-localize>${esc(a.label)}</div>
      <div class="meta">${a.running ? '运行中' : `v${esc(a.versionName)}${a.lastLaunchAt ? ' · ' + relTime(a.lastLaunchAt) : ''}`}</div>
      <div class="open-hint">${a.running ? '切换到前台' : '打开'}</div>
    </div>
  `).join('') + `
    <div class="card card-add" id="cardAdd" role="button" tabindex="0" title="拖入 APK 文件，或点击选择">
      <div class="add-plus" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round"><path d="M12 6v12"/><path d="M6 12h12"/></svg>
      </div>
      <div class="name">添加应用</div>
      <div class="meta">拖入 APK 即可安装</div>
    </div>
  `;
}

/* ---------------- 数据刷新 ---------------- */

async function refreshApps() {
  try {
    state.apps = await api.listApps();
    renderGrid();
    updateStats();
  } catch (e) {
    console.error(e);
  }
}

function updateStats() {
  const n = state.apps.length;
  $('statusStats').textContent = n ? `${n} 个应用` : '暂无应用';
}

async function refreshStatus() {
  try {
    state.status = await api.runtimeStatus();
    const s = state.status;
    const dot = $('statusDot');
    const text = $('statusText');
    const tag = $('engineTag');

    if (!s.adbOk) {
      dot.className = 'dot err';
      text.textContent = '运行时未部署 —— 打开设置 → 运行时，一键完成';
      tag.textContent = '需要部署';
      tag.className = 'brand-tag';
    } else if (s.deviceOnline) {
      dot.className = 'dot ok';
      text.textContent = `运行时已就绪 · Android ${s.android || '?'}${s.freeform ? ' · 独立窗口已启用' : ''}`;
      tag.textContent = `Android ${s.android || ''}`.trim();
      tag.className = 'brand-tag ok';
    } else if (s.phase === 'booting' || s.vmStarting) {
      dot.className = 'dot warn';
      text.textContent = '正在引导 Android…';
      tag.textContent = '引导中';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'accel') {
      dot.className = 'dot warn';
      // 说清「怎么修」而不是只说「没开」——这句是状态条上最容易被看到的位置
      text.textContent = '未启用硬件加速：已回退软件模拟（很慢）。点右下角「环境自检 → 修复」开启';
      tag.textContent = '软件模拟';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'sysimg') {
      dot.className = 'dot err';
      text.textContent = '缺少 Android 14 通用系统镜像 —— 设置 → 运行时里下载（约 1.5GB，只下一次）';
      tag.textContent = '待下载镜像';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'emulator') {
      dot.className = 'dot err';
      text.textContent = '运行时引擎未安装 —— 打开设置 → 运行时一键完成';
      tag.textContent = '需要部署';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'boot') {
      dot.className = 'dot warn';
      text.textContent = '运行时已就绪 —— 安装 APK 或双击桌面图标会自动开机';
      tag.textContent = '待开机';
      tag.className = 'brand-tag';
    } else if (s.installing) {
      dot.className = 'dot warn';
      text.textContent = '安装程序运行中 —— 请在虚拟机窗口里完成安装';
      tag.textContent = '安装中';
      tag.className = 'brand-tag';
    } else {
      dot.className = 'dot';
      text.textContent = s.installed
        ? '运行时待机（安装或打开应用时会自动拉起）'
        : '运行时尚未安装 Android 系统 —— 打开设置 → 运行时继续';
      tag.textContent = s.installed ? '待机' : '待安装';
      tag.className = 'brand-tag';
    }
    $('statusDevice').textContent = s.deviceOnline ? (s.serial || '') : '';
    // 网络状态：这是用户最容易踩的坑（应用里一直「网络错误」，但看不出是虚拟机没网）。
    // 直接摆在状态栏，出问题时一眼能看到，不用去翻日志。
    const netEl = $('statusNet');
    const netSep = $('statusNetSep');
    if (netEl) {
      const show = !!s.deviceOnline && !!s.network;
      netEl.hidden = !show;
      if (netSep) netSep.hidden = !show;
      if (show) {
        netEl.textContent = s.network.ok ? `网络正常 ${s.network.ip || ''}`.trim() : '虚拟机未联网';
        netEl.className = 'status-item status-net ' + (s.network.ok ? 'ok' : 'warn');
        netEl.title = s.network.ok
          ? '安卓虚拟机已联网，联网类应用可以正常加载'
          : '安卓虚拟机没有网络，联网页面会一直是空白/报错。可在「设置 → 修复网络」处理';
      }
    }

    renderSetup(s);
  } catch (e) {
    $('statusText').textContent = `状态检查失败：${e.message}`;
  }
}

/* ---------------- 运行时部署（固定在设置里） ---------------- */

/**
 * 运行时/部署/自检面板现在都收在「设置」里，主界面只留已安装应用。
 * 保留 showSetup 给托盘菜单与 ui:navigate 复用，语义改为「打开设置并定位到运行时」。
 */
function showSetup(on) {
  if (!on) { $('setupGuide').hidden = true; return; }
  openSettings().then(() => {
    focusGroup($('runtimeGroup'));
  }).catch(() => {});
}

function fmtGB(n) { return n ? `${(n / 1073741824).toFixed(2)} GB` : ''; }

function stepRow(opt) {
  const cls = ['step'];
  if (opt.done) cls.push('done');
  if (opt.busy) cls.push('busy');
  return `
    <div class="${cls.join(' ')}" data-step="${opt.key}">
      <div class="idx">${opt.done ? '✓' : opt.index}</div>
      <div class="body">
        <div class="t">${esc(opt.title)}${opt.tag ? `<span class="tag ${opt.req ? 'req' : ''}">${esc(opt.tag)}</span>` : ''}</div>
        <div class="d" data-desc>${esc(opt.desc)}</div>
        <div class="bar"><i data-bar></i></div>
      </div>
      <div class="act">${opt.actions || ''}</div>
    </div>`;
}

function renderSetup(s) {
  if (!s) return;
  const env = s.env || {};
  const hv = env.hypervisor || {};
  const accel = env.accel || s.accel || {};

  // 启动即见已安装应用：不再用部署向导整屏接管主界面，
  // 状态只在设置里的运行时面板 + 底部状态条上体现。
  const accelOk = accel.ok || hv.whpx;
  const adbDone = !!(env.adb && env.adb.ok);
  const emuDone0 = !!(env.emulator && env.emulator.ok);
  const imgDone0 = !!(env.sysimg && env.sysimg.ok);
  const allDone0 = adbDone && emuDone0 && imgDone0;
  const stateText = $('setupStateText');
  if (stateText) {
    const missing = [];
    if (!adbDone) missing.push('adb');
    if (!emuDone0) missing.push('引擎');
    if (!imgDone0) missing.push('系统镜像');
    stateText.textContent = s.deviceOnline
      ? `已就绪 · Android ${s.android || ''}`
      : s.phase === 'booting' || s.vmStarting
        ? '正在引导 Android…'
        : allDone0
          ? '组件齐全 · 待开机（打开应用时自动拉起）'
          : `缺少 ${missing.join('、')}${accelOk ? '' : '（无硬件加速，将回退软件模拟）'}`;
    stateText.title = s.autoProfile || accel.note || hv.note || '';
  }

  const emuDone = !!(env.emulator && env.emulator.ok);
  const imgDone = !!(env.sysimg && env.sysimg.ok);
  const busy = state.setupBusy;
  const booting = s.phase === 'booting';

  // 只保留一个步骤：下载、参数自适应、开机全部由「一键完成」串起来，
  // 且首次启动会在后台自动跑，用户不需要逐步点击。
  const allDone = !!(env.adb && env.adb.ok) && emuDone && imgDone;
  const left = [];
  if (!(env.adb && env.adb.ok)) left.push('adb 工具链');
  if (!emuDone) left.push('Android 运行时');
  if (!imgDone) left.push('系统镜像');
  const step = {
    key: 'all',
    index: 1,
    title: allDone ? '一切就绪' : '一键完成',
    tag: allDone ? '已自动完成' : '自动',
    done: allDone,
    busy: !!busy,
    desc: s.deviceOnline
      ? `Android ${s.android || ''} 已就绪 · 应用窗口会按屏幕自动适配`
      : booting
        ? '正在引导 Android…'
        : allDone
          ? '组件齐全，双击任意 APK 或桌面图标即会自动开机'
          : `还差 ${left.join('、')}；点下面「一键完成」，会在后台一次装好并自动开机`,
    actions: s.deviceOnline
      ? '<button class="btn ghost sm" data-act="vmStop">停止运行时</button>'
      : '',
  };

  $('setupSteps').innerHTML = stepRow(step);
  $('btnDeployAll').disabled = !!busy;
  $('btnDeployAll').textContent = busy ? '准备中…' : (allDone ? '已完成 · 点此复查' : '一键完成');
  // 「上次为什么没起来」优先显示落盘的失败记录：进程重启后内存里的 diagnosis 是空的，
  // 只显示 autoProfile 会让用户完全看不出原因（issue #20/#25 的报告就是这样）。
  const lf = s.lastFailure;
  const lastMsg = (lf && lf.diagnosis && lf.diagnosis.title)
    ? `上次启动失败：${lf.diagnosis.title}`
    : (s.diagnosis ? `上次启动自动诊断：${s.diagnosis.title}` : '');
  $('setupNote').textContent = lastMsg
    || s.autoProfile || '全自动：无需选择镜像、无需启用加速、无需调内存';
}

function store_getDiskSize() {
  return (state.settings && state.settings.runtime && state.settings.runtime.diskSizeGB) || 24;
}

function setStepBusy(key, on) {
  state.setupBusy = on ? key : null;
  // 五步已合并成一行，所有子步骤的进度都落在这唯一的进度条上
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (row) {
    row.classList.toggle('busy', !!on);
    if (on) {
      const bar = row.querySelector('[data-bar]');
      if (bar) bar.style.width = '3%';
    }
  }
}

function updateStepProgress(component, p) {
  if (!component) return;
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (!row) return;
  if (p.percent !== undefined) {
    const bar = row.querySelector('[data-bar]');
    if (bar) bar.style.width = `${Math.max(3, Math.min(100, p.percent))}%`;
  }
  if (p.message) {
    const d = row.querySelector('[data-desc]');
    if (d) d.textContent = localizedText(p.message);
  }
}

async function deployAll() {
  if (state.setupBusy) return;
  setStepBusy('all', true);
  try {
    // 一次调用把 adb / 引擎 / 系统镜像全装完，进度统一显示在唯一那一行
    // 用户点「一键部署」属于明确的手动重试，绕过失败冷却
    const r = await api.autoDeploy({ force: true });
    if (!r || !r.ok) {
      toast({ title: '准备失败', body: (r && r.error) || '请检查网络后重试', type: 'error', sticky: true });
      return;
    }
    await refreshStatus();
    toast({ title: '组件已就绪，正在自动开机…', body: '首次约 1-3 分钟，之后几秒即可。', type: 'info' });
    const started = await api.runtimeStart();
    await refreshStatus();
    toast(started && started.ok
      ? { title: '运行时已就绪', body: '现在把 APK 拖进窗口，或双击桌面图标即可。', type: 'ok' }
      : { title: '开机未完成', body: (started && started.error) || '请导出诊断报告查看原因', type: 'error', sticky: true });
  } catch (e) {
    toast({ title: '准备失败', body: e.message, type: 'error', sticky: true });
  } finally {
    setStepBusy('all', false);
    await refreshStatus();
    selfCheck();
  }
}

async function runStep(key) {
  if (state.setupBusy) return { ok: false, error: '已有部署任务进行中' };
  setStepBusy(key, true);
  let r;
  try {
    if (key === 'adb') r = await api.installAdb();
    else if (key === 'emulator') r = await api.installEmulator();
    else if (key === 'sysimg') r = await api.installSysimg();
    else if (key === 'accel') {
      const t = toast({
        title: '正在安装硬件加速驱动…',
        body: '请在弹出的是否允许窗口点「是」',
        sticky: true,
        spinner: true,
      });
      r = await api.enableAccel();
      if (r.ok) t.update({ title: '硬件加速已启用', type: 'ok' });
      else t.update({ title: '加速未启用', body: r.error, type: 'error', sticky: true });
    } else if (key === 'qemu') r = await api.installQemu();
    else if (key === 'iso') r = await api.downloadIso();
    else if (key === 'disk') r = await api.createDisk(store_getDiskSize());
    else r = { ok: false, error: '未知步骤' };
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  setStepBusy(key, false);
  await refreshStatus();
  return r;
}

async function startInstall() {
  const r = await api.startInstaller();
  if (!r.ok) {
    toast({ title: '无法启动安装环境', body: r.error, type: 'error', sticky: true });
    return;
  }
  $('setupGuide').hidden = false;
  $('setupGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast({ title: '虚拟机窗口已打开', body: '按下方 6 步完成安装；装好后点「我已安装完成」。', type: 'ok', sticky: true });
}

async function markInstalled() {
  await api.markInstalled();
  await api.runtimeStop();
  $('setupGuide').hidden = true;
  await refreshStatus();
  toast({ title: '安装完成，运行时已接管', body: '现在可以直接把 APK 拖进来安装了。', type: 'ok' });
}



/* ---------------- 安装 ---------------- */

/** 把安装失败翻译成「下一步该做什么」，只对最常见的几种做提示，其它原样显示 */
function friendlyInstallErrorText(msg) {
  const s = String(msg || '未知错误');
  if (/INSUFFICIENT_STORAGE|not enough space|空间不足|ENOSPC/i.test(s)) {
    return `${s}\n安卓数据分区不够用：设置 → 性能与资源占用 → 安卓数据分区调大后点「立即扩容」。`;
  }
  // 只有真正失败才走到这里：切换镜像是「进行中」的进度提示（install:progress），
  // 绝不能在红色失败横幅里再说「正在重试」——那会让用户以为还在处理，其实是真的失败了。
  if (/NO_MATCHING_ABIS/i.test(s)) {
    return /已切换到.*仍然安装失败|abiRetried/i.test(s)
      ? `${s}\nARM 兼容镜像已启用仍装不上，请到「设置 → 诊断与修复」导出诊断报告反馈。`
      : `${s}\n这个包只有 ARM 库。程序会自动切到兼容镜像重装一次，请留意后续提示。`;
  }
  if (/INSTALL_FAILED_ALREADY_EXISTS|signatures do not match/i.test(s)) {
    return `${s}\n同包名但签名不同（常见于从别的渠道装过）。在应用卡片右键「卸载」后再装。`;
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(s)) return `${s}\n已装版本更高，先在右键菜单里卸载再装。`;
  if (/ERR_FS_FILE_TOO_LARGE|greater than possible Buffer|Cannot allocate|ENOMEM|out of memory/i.test(s)) {
    return `${s}\n这个安装包过大或内存不足，解析被系统拒绝了。请确认磁盘与内存充足后重试；`
      + '仍失败请把安装包路径换成纯英文短路径（如 D:\\a.apk）。';
  }
  return s;
}

/* 当前那条「正在安装…」的 sticky 提示。install:error 事件要能把它收掉：
 * 主进程是先 send('install:error') 再让 invoke 失败的，两者都可能到得很晚，
 * 只靠 catch 收会出现「报错了右下角还在转圈」。 */
let installToast = null;

async function installFiles(paths) {
  if (!paths || !paths.length) return;
  if (state.installing) {
    toast({ title: '已有安装任务在进行', body: '请等当前应用装完再继续。' });
    return;
  }
  state.installing = true;
  let ok = 0;
  let failed = 0;

  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    const t = toast({ title: `正在安装 ${name}`, body: '解析 APK…', progress: 8, sticky: true, spinner: true });
    installToast = t;
    let off = () => {};
    try {
      off = api.on('install:progress', (pr) => {
        const base = { parse: 12, 'parse-done': 24, runtime: 38, install: 62, shortcut: 88, done: 100 }[pr.stage] || 50;
        const pct = pr.percent != null ? Math.min(60, Math.round((pr.percent / 100) * 60)) : base;
        t.update({ title: pr.meta ? `正在安装 ${pr.meta.label}` : `正在安装 ${name}`, body: pr.message, progress: pct });
      });
      const r = await api.installApk(p);
      t.update({ title: `${r.app.label} 已安装`, body: r.app.shortcutPath ? '桌面快捷方式已创建，双击即可直接打开。' : '可在应用卡片右键创建桌面快捷方式。', progress: 100, type: 'ok' });
      t.el.querySelector('.spinner')?.remove();
      setTimeout(t.dismiss, 3600);
      if (r.warnings && r.warnings.length) {
        toast({ title: `${r.app.label} 兼容性提示`, body: r.warnings.join(' '), type: 'error', sticky: false });
      }
      ok++;
    } catch (e) {
      failed++;
      // 先把那条「正在安装…」的 sticky 提示收掉，否则它会一直转圈、还继续被
      // 运行时日志刷新 —— 用户看到的就是「失败信息一直在循环」。
      // 错误提示统一由下面的 install:error 监听器负责（带文件名与中文原因），
      // 这里不再重复弹一条。
      try { off(); } catch (_) { /* ignore */ }
      t.dismiss();
      if (installToast === t) installToast = null;
    } finally {
      try { off(); } catch (_) { /* ignore */ }
    }
  }

  state.installing = false;
  await refreshApps();
  if (ok && !failed) $('search').value = '';
}

/* ---------------- 应用操作 ---------------- */

async function launchApp(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  state.launchPkg = pkg;
  const t = toast({
    title: `正在打开 ${app ? app.label : pkg}`,
    body: '首次启动需要预热运行时，请稍候…',
    sticky: true,
    spinner: true,
  });
  const r = await api.launch(pkg);
  if (r.ok) {
    // 应用有自己的窗口，主界面自动收起；这里只留一句提示，然后隐藏窗口
    t.update({ title: '已启动', body: '应用正在独立窗口中运行（顶部可旋转屏幕）。', type: 'ok' });
    setTimeout(t.dismiss, 1600);
    setTimeout(() => api.winHide(), 900);
    setTimeout(refreshApps, 1200);
  } else {
    t.update({ title: '启动失败', body: r.error, type: 'error' });
    setTimeout(t.dismiss, 6000);
  }
}

async function createShortcut(pkg) {
  try {
    const r = await api.createShortcut(pkg);
    toast({ title: '桌面快捷方式已创建', body: r.path, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: '创建快捷方式失败', body: e.message, type: 'error' });
  }
}

async function uninstall(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  if (!app) return;
  const ok = window.confirm(`确定卸载「${app.label}」？\n\n应用数据会一并被清除，桌面快捷方式也会被删除。`);
  if (!ok) return;
  try {
    await api.uninstall(pkg);
    toast({ title: '已卸载', body: app.label, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: '卸载失败', body: e.message, type: 'error' });
  }
}

/* ---------------- 右键菜单 ---------------- */

const MENU_ITEMS = [
  { key: 'open', label: '打开应用', kbd: 'Enter' },
  // 只在应用真的在运行时才出现（见 showMenu 里的过滤）。
  // 以前完全没有这一项，独立窗口模式下又没有可点的关闭按钮，
  // 应用一起来就关不掉，只能退到托盘退出整个 ApkStart。
  { key: 'stop', label: '关闭应用', onlyRunning: true },
  { key: 'shortcut', label: '创建桌面快捷方式' },
  { key: 'orientation', label: '横屏 / 竖屏' },
  { key: 'pin', label: '固定到顶部' },
  { key: 'keymap', label: '按键映射…' },
  { divider: true },
  { key: 'reveal', label: '打开 APK 所在位置' },
  { key: 'clear', label: '清除应用数据' },
  { divider: true },
  { key: 'uninstall', label: '卸载', danger: true },
];

function showMenu(x, y, pkg) {
  const menu = $('ctxmenu');
  state.menuPkg = pkg;
  const app = state.apps.find((a) => a.package === pkg);
  const items = MENU_ITEMS.filter((it) => !it.onlyRunning || (app && app.running));
  menu.innerHTML = items.map((it) => {
    if (it.divider) return '<div class="divider"></div>';
    const label = it.key === 'pin' ? (app && app.pinned ? '取消固定' : '固定到顶部')
      : (it.key === 'orientation'
        ? (app && app.orientationOverride === 'landscape' ? '竖屏启动（当前横屏）'
          : (app && app.orientationOverride === 'portrait' ? '横屏启动（当前竖屏）' : '设为横屏启动'))
        : it.label);
    return `<div class="item ${it.danger ? 'danger' : ''}" data-key="${it.key}" data-act="${it.key}">
      <span>${esc(label)}</span>${it.kbd ? `<span class="k">${it.kbd}</span>` : ''}
    </div>`;
  }).join('');
  menu.classList.add('on');

  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 10)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 10)}px`;
}

function hideMenu() {
  $('ctxmenu').classList.remove('on');
  state.menuPkg = null;
}

async function handleMenu(act) {
  const pkg = state.menuPkg;
  const app = state.apps.find((a) => a.package === pkg);
  hideMenu();
  if (!app) return;
  switch (act) {
    case 'open': return launchApp(pkg);
    case 'stop': {
      try {
        const r = await api.stop(pkg);
        if (r && r.ok) {
          toast({ title: '已关闭', body: app.label, type: 'ok' });
        } else {
          toast({ title: '关闭失败', body: (r && r.error) || '未知错误', type: 'error' });
        }
      } catch (e) {
        toast({ title: '关闭失败', body: e.message, type: 'error' });
      }
      return refreshApps();
    }
    case 'shortcut': return createShortcut(pkg);
    case 'orientation': {
      // 三态循环：跟随应用 → 横屏 → 竖屏 → 跟随应用
      // 这样红果这类被清单判成竖屏的应用，用户点一下就能强制横屏并记住。
      const cur = app.orientationOverride;
      const next = cur === 'landscape' ? 'portrait' : (cur === 'portrait' ? null : 'landscape');
      try {
        const r = await api.setAppOrientation(pkg, next);
        const txt = next === 'landscape' ? '横屏启动' : (next === 'portrait' ? '竖屏启动' : '跟随应用');
        toast({ title: `已设为${txt}`, body: '下次打开该应用时生效，无需重启整个环境。', type: 'ok' });
        if (r && typeof r.landscape === 'boolean' && state.apps) {
          const rec = state.apps.find((a) => a.package === pkg);
          if (rec) rec.orientationOverride = next;
        }
      } catch (e) {
        toast({ title: '设置方向失败', body: e.message, type: 'error' });
      }
      return refreshApps();
    }
    case 'pin': return api.pin(pkg, !app.pinned).then(refreshApps);
    case 'keymap': return showKeymapPicker(pkg, app.label);
    case 'reveal': return api.revealApk(pkg);
    case 'clear': {
      if (!window.confirm(`清除「${app.label}」的全部数据？此操作不可撤销。`)) return;
      try {
        await api.clearData(pkg);
        toast({ title: '数据已清除', body: app.label, type: 'ok' });
      } catch (e) {
        toast({ title: '清除失败', body: e.message, type: 'error' });
      }
      return;
    }
    case 'uninstall': return uninstall(pkg);
    default: return undefined;
  }
}

/**
 * 按键映射预设选择器。用 confirm + prompt 做最简交互（不引入新 UI 组件）。
 * 后续可以做成更精致的弹窗编辑器。
 */
async function showKeymapPicker(pkg, label) {
  try {
    const presets = await api.keymap.getPresets();
    const current = await api.keymap.getMap(pkg);
    const hasCurrent = current && current.length > 0;
    const lines = presets.map((p, i) => `${i + 1}. ${p.label} — ${p.desc}`);
    if (hasCurrent) lines.unshift('0. 清除当前映射');
    const msg = `为「${label}」选择按键映射预设：\n\n${lines.join('\n')}\n\n输入编号：`;
    const input = window.prompt(msg, hasCurrent ? '0' : '1');
    if (input === null) return; // 取消
    const idx = parseInt(input, 10);
    if (hasCurrent && idx === 0) {
      await api.keymap.setMap(pkg, []);
      toast({ title: '已清除按键映射', body: label, type: 'ok' });
      return;
    }
    const presetIdx = hasCurrent ? idx - 1 : idx;
    if (presetIdx < 1 || presetIdx > presets.length) {
      toast({ title: '无效编号', type: 'error' });
      return;
    }
    const chosen = presets[presetIdx - 1];
    await api.keymap.applyPreset(pkg, chosen.id);
    toast({ title: `已套用「${chosen.label}」`, body: `${label} · 打开应用后键盘即可操控`, type: 'ok' });
  } catch (e) {
    toast({ title: '按键映射设置失败', body: e.message, type: 'error' });
  }
}

/* ---------------- 设置 ---------------- */

// ---------------- 安卓系统设置 ----------------

let volumeTimer = null;

async function refreshAndroid() {
  const el = $('androidStatus');
  if (!el) return;
  el.textContent = '读取中…';
  const r = await api.android.status().catch(() => null);
  if (!r || !r.ok) {
    el.textContent = r && r.error ? `运行时未就绪（${String(r.error).slice(0, 36)}）` : '运行时未启动';
    return;
  }
  el.textContent = `Android ${r.sdk || '?'} · ${r.wifi ? 'Wi-Fi 已开' : 'Wi-Fi 已关'}` +
    `${r.airplane ? ' · 飞行模式' : ''} · 音量 ${r.volume}%`;
  $('setAndroidWifi').checked = !!r.wifi;
  $('setAndroidAirplane').checked = !!r.airplane;
  $('setAndroidAnim').checked = !r.animationsOff;
  $('setAndroidVolume').value = r.volume;
  $('androidVolumeText').textContent = `${r.volume}%`;
  if (r.fontScale) $('setAndroidFont').value = Number(r.fontScale).toFixed(2);
  if (r.density) {
    const opt = [...$('setAndroidDensity').options].find((o) => o.value === String(r.density));
    if (opt) $('setAndroidDensity').value = String(r.density);
  }
}

function bindAndroid() {
  const set = async (key, value, msg) => {
    const r = await api.android.set(key, value).catch(() => null);
    toast({
      type: r && r.ok ? 'ok' : 'error',
      title: r && r.ok ? (msg || '已生效') : `失败：${(r && r.error) || '运行时未就绪'}`,
    });
    if (r && r.ok) refreshAndroid();
  };
  $('setAndroidWifi').addEventListener('change', (e) => set('wifi', e.target.checked, e.target.checked ? 'Wi-Fi 已开启' : 'Wi-Fi 已关闭'));
  $('setAndroidAirplane').addEventListener('change', (e) => set('airplane', e.target.checked, e.target.checked ? '已进入飞行模式' : '已退出飞行模式'));
  $('setAndroidAnim').addEventListener('change', (e) => set('animations', e.target.checked, e.target.checked ? '系统动画已开启' : '系统动画已关闭，界面更快'));
  $('setAndroidFont').addEventListener('change', (e) => set('fontScale', Number(e.target.value), '字体大小已调整'));
  $('setAndroidDensity').addEventListener('change', (e) => set('density', Number(e.target.value), '显示大小已调整'));
  $('setAndroidVolume').addEventListener('input', (e) => {
    $('androidVolumeText').textContent = `${e.target.value}%`;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => set('volume', Number(e.target.value), '音量已调整'), 260);
  });
  $('btnAndroidRefresh').addEventListener('click', () => refreshAndroid());
  $('btnAndroidTune').addEventListener('click', async () => {
    const r = await api.android.tune(state.launchPkg || '').catch(() => null);
    toast({ type: r && r.ok ? 'ok' : 'error', title: r && r.ok ? '已优化：动画关闭、后台放宽、电池白名单' : '优化失败，运行时可能未启动' });
    if (r && r.ok) refreshAndroid();
  });
  const open = async (action) => {
    const r = await api.android.open(action).catch(() => null);
    if (!r || !r.ok) {
      toast({ type: 'error', title: '需要先打开一次应用，让运行时启动' });
    }
  };
  $('btnAndroidSettings').addEventListener('click', () => open('settings'));
  $('btnAndroidDisplay').addEventListener('click', () => open('display'));
  $('btnAndroidSound').addEventListener('click', () => open('sound'));
  $('btnAndroidLocale').addEventListener('click', () => open('locale'));
  $('btnAndroidApps').addEventListener('click', () => open('apps'));
}

/** 设置页字段同步：只剩自带运行时，所有资源项都露出来，不再按底座切换 */
function syncBackendFields() {
  const perf = $('perfGroup');
  if (perf) perf.hidden = false;
  refreshResources();
}

/** 本机资源上限 + 当前分配（设置页里那几行灰字） */
async function refreshResources() {
  const bNote = $('builtinResNote');
  if (!bNote) return;
  const gb = (mb) => (Number(mb) > 0 ? `${Math.round(Number(mb) / 1024)} GB` : '未知');
  const r = await api.resources().catch(() => null);
  if (!r || r.ok === false) {
    bNote.textContent = (r && (r.note || r.error)) || '暂时读不到资源分配信息';
    return;
  }
  const host = r.host || {};
  const lim = r.limits || {};
  const free = Number(r.freeMB) || Number((r.current && r.current.freeMB) || 0);
  bNote.textContent = `本机 ${gb(host.totalMB)} 内存 / ${host.cores} 核；`
    + `内存最多可分 ${gb(lim.maxMB)}，核心最多 ${Math.max(1, (host.cores || 1) - 1)} 个（各留 1/4 内存与 1 核给 Windows）。`
    + `数据分区上限 ${lim.maxGB || 0} GB${free ? `（所在磁盘剩余 ${(free / 1024).toFixed(1)} GB）` : ''}。`
    + (r.verdict && r.verdict.note ? ` ${r.verdict.note}` : '');
}

/** 本机体检：渲染报告（每条带等级点和可执行动作） */
function renderPreflight(res) {
  const list = $('preflightList');
  const sum = $('preflightSummary');
  const applyBtn = $('btnPreflightApply');
  if (!list) return;
  list.textContent = '';
  if (!res || !res.report) {
    if (sum) sum.textContent = (res && res.error) || '体检没有返回结果，请重试';
    return;
  }
  const { report, edition } = res;
  for (const it of report.items) {
    const item = document.createElement('div');
    item.className = 'pf-item';
    const head = document.createElement('div');
    head.className = 'pf-head';
    const dot = document.createElement('span');
    dot.className = `pf-dot ${it.level}`;
    const title = document.createElement('span');
    title.className = 'pf-title';
    title.textContent = it.title;
    head.append(dot, title);
    item.append(head);
    if (it.detail) {
      const d = document.createElement('div');
      d.className = 'pf-detail';
      d.textContent = it.detail;
      item.append(d);
    }
    if (it.action && it.action.kind === 'elevate') {
      const wrap = document.createElement('div');
      wrap.className = 'pf-action';
      const btn = document.createElement('button');
      btn.className = 'btn ghost sm';
      btn.textContent = it.action.label;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = '正在处理…';
        let r = null;
        if (it.action.id === 'accel') r = await api.enableAccel().catch(() => null);
        else r = await api.enableVirtualization().catch(() => null);
        btn.disabled = false;
        btn.textContent = old;
        if (!r) { toast({ type: 'error', title: '操作没有完成', body: '可以稍后重试，或手动按提示操作' }); return; }
        if (r.cancelled) toast({ type: 'warn', title: '已取消', body: '没有修改系统设置' });
        else if (r.ok || r.already) {
          const reboot = r.restartNeeded === true;
          toast({
            type: 'ok',
            title: r.already ? '硬件加速已经可用' : (reboot ? '已提交，需要重启' : '已生效'),
            body: r.already ? '' : (reboot ? '重启电脑后硬件加速才会生效，回来点「开始体检」确认' : '可以点「开始体检」确认结果'),
          });
          if (r.already || !reboot) setTimeout(() => runPreflight().catch(() => {}), 1200);
        } else {
          toast({ type: 'error', title: '没能自动完成', body: (r.error || r.note || '请按提示手动操作') });
        }
      });
      wrap.append(btn);
      item.append(wrap);
    } else if (it.action && it.action.kind === 'manual') {
      const wrap = document.createElement('div');
      wrap.className = 'pf-action pf-detail';
      wrap.textContent = `⚠ ${it.action.label}`;
      item.append(wrap);
    }
    list.append(item);
  }
  const rec = report.recommended || {};
  if (sum) {
    sum.textContent = `${report.summary}。推荐配置：${Math.round((rec.memoryMB || 0) / 1024)} GB 内存 / `
      + `${rec.cores || 2} 核 / ${rec.renderSize || 'auto'} · 渲染 ${rec.gpuMode || 'auto'}`
      + (edition === 'store' ? '（商店版：系统功能只能在「Windows 功能」里手动开）' : '');
  }
  if (applyBtn) applyBtn.hidden = false;
}

async function runPreflight() {
  const btn = $('btnPreflight');
  const sum = $('preflightSummary');
  if (!btn) return null;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '体检中…';
  if (sum) sum.textContent = '正在检查虚拟化、显卡、内存…（第一次约 2~3 秒）';
  let r = null;
  try {
    r = await api.preflightRun();
  } catch (e) {
    r = { error: e.message || '体检失败' };
  }
  btn.disabled = false;
  btn.textContent = old;
  renderPreflight(r);
  return r;
}

/** 驱动（兼容补丁）：渲染清单 + 命中状态 */
function renderDrivers(r) {
  const list = $('drvList');
  const sum = $('drvSummary');
  if (!list) return;
  const host = (r && r.host) || {};
  const drivers = (r && r.drivers) || [];
  const errors = (r && r.errors) || [];
  const onCount = drivers.filter((d) => d.enabled && d.matched).length;
  if (sum) {
    if (uiLanguage === 'en') {
      const accel = host.accel === 'none' ? 'No hardware acceleration' : (host.accel || 'Unknown');
      sum.textContent = `This PC: ${host.platform || 'Unknown'}/${host.arch || 'Unknown'} · ${host.gpuVendor || 'Unknown'} GPU · ${accel}`
        + ` · emulator ${host.emulatorVersion || 'unknown'}; ${drivers.length} drivers, ${onCount} active on this PC.`
        + (errors.length ? ` ${errors.length} files failed to load (see below).` : '');
    } else {
      const accel = host.accel === 'none' ? '无硬件加速' : (host.accel || '未知');
      sum.textContent = `本机：${host.platform || ''}/${host.arch || ''} · ${host.gpuVendor || '未知'} 显卡 · ${accel}`
        + ` · emulator ${host.emulatorVersion || '未知'}；驱动 ${drivers.length} 个，本机已生效 ${onCount} 个。`
        + (errors.length ? ` ${errors.length} 个文件加载失败（见下）。` : '');
    }
  }
  list.textContent = '';
  for (const d of drivers) {
    const builtinEnglish = d.builtin && BUILTIN_DRIVER_EN[d.id];
    const item = document.createElement('div');
    item.className = d.enabled ? 'drv-item on' : 'drv-item';

    const head = document.createElement('div');
    head.className = 'drv-head';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!d.enabled;
    cb.addEventListener('change', async () => {
      const res = await api.driversSetEnabled(d.id, cb.checked).catch(() => null);
      if (res && res.ok && res.overview) renderDrivers(res.overview);
      else { cb.checked = !cb.checked; toast({ type: 'error', title: '保存失败', body: (res && res.error) || '请稍后再试' }); }
    });
    const name = document.createElement('span');
    name.className = 'drv-name';
    name.textContent = uiLanguage === 'en' && builtinEnglish ? builtinEnglish.name : d.name;
    head.append(cb, name);

    if (d.matched && d.enabled) {
      const b = document.createElement('span');
      b.className = 'drv-badge hit';
      b.textContent = '已生效';
      head.append(b);
    }
    if (d.builtin) {
      const b = document.createElement('span');
      b.className = 'drv-badge';
      b.textContent = '内置示例';
      head.append(b);
    }
    item.append(head);

    const meta = document.createElement('div');
    meta.className = 'drv-meta';
    meta.textContent = `v${d.version || '?'}`
      + (d.author ? ` · ${d.author}` : '')
      + ` · priority ${d.priority}`
      + (d.hits && d.hits.length
        ? ` · ${uiLanguage === 'en' ? 'Matched: ' : '命中：'}${d.hits.join(' / ')}`
        : ` · ${uiLanguage === 'en' ? 'Does not match this PC' : '本机不匹配'}`);
    item.append(meta);

    if (d.description) {
      const desc = document.createElement('div');
      desc.className = 'drv-meta';
      desc.textContent = uiLanguage === 'en' && builtinEnglish
        ? builtinEnglish.description
        : d.description;
      item.append(desc);
    }
    list.append(item);
  }
  for (const e of errors) {
    const err = document.createElement('div');
    err.className = 'drv-err';
    err.textContent = `${String(e.file || '').split(/[\\/]/).pop()}：${(e.errors || []).join('；')}`;
    list.append(err);
  }
  if (!drivers.length && !errors.length) {
    const empty = document.createElement('div');
    empty.className = 'drv-meta';
    empty.textContent = '还没有任何驱动。可以点「导出本机模板」做一个，或导入别人做好的 JSON。';
    list.append(empty);
  }
}

async function refreshDrivers() {
  if (!$('drvList')) return;
  const r = await api.driversList().catch(() => null);
  if (!r) {
    if ($('drvSummary')) $('drvSummary').textContent = '读不到驱动列表（运行时可能还没部署）';
    return;
  }
  renderDrivers(r);
}

function fillSettings(s) {
  if ($('setLanguage')) $('setLanguage').value = s.language === 'zh-CN' ? 'zh-CN' : 'en';
  applyUiLanguage(s.language);
  syncBackendFields();
  refreshDrivers().catch(() => {});
  $('setAdbPath').value = s.adbPath || '';
  $('setSystemImage').value = s.runtime.isoPath || '';
  $('setMemory').value = s.engine.memoryMB;
  $('setCores').value = s.engine.cores;
  $('setIdle').value = s.engine.idleShutdownMinutes;
  if ($('setSourcePref')) $('setSourcePref').value = (s.runtime && s.runtime.sourcePreference) || 'auto';
  if ($('setAutoMirror')) $('setAutoMirror').checked = (s.runtime && s.runtime.autoMirror) !== false;
  if ($('setGiteeToken')) $('setGiteeToken').value = (s.runtime && s.runtime.giteeToken) || '';
  if ($('setMirrorPrefix')) $('setMirrorPrefix').value = (s.runtime && s.runtime.mirrorPrefix) || '';
  if ($('setConnections')) $('setConnections').value = Number((s.runtime && s.runtime.downloadConnections) || 8);
  $('setAudio').checked = s.engine.audio !== false;
  if ($('setMicrophone')) $('setMicrophone').checked = s.engine.microphone !== false;
  $('setLiteMode').checked = s.engine.liteMode !== false;
  $('setPrewarm').checked = s.engine.prewarm !== false;
  $('setPriorityMode').value = ['performance', 'game'].includes(s.engine.priorityMode)
    ? s.engine.priorityMode : 'balanced';
  $('setDeepTrim').checked = !!s.engine.deepTrim;
  $('setMouseRightBack').checked = s.engine.mouseRightBack !== false;
  $('setMouseWheelMode').value = ['smooth', 'native', 'off'].includes(s.engine.mouseWheelMode)
    ? s.engine.mouseWheelMode : 'smooth';
  $('setMouseSideButtons').checked = !!s.engine.mouseSideButtons;
  if ($('setKeymapEnabled')) $('setKeymapEnabled').checked = s.engine.keymapEnabled !== false;
  // 实验室：原生多窗口多开（实验性）
  if ($('setMultiWindow')) $('setMultiWindow').checked = !!s.engine.multiWindow;
  if ($('setKeepBackground')) $('setKeepBackground').value = String(
    Number(s.engine.keepBackground) >= 0 ? Number(s.engine.keepBackground) : 1,
  );
  $('setCompat').checked = !!(s.runtime && s.runtime.compatImage);
  $('setAutoShortcut').checked = !!s.createShortcutOnInstall;
  $('setStartMenuShortcut').checked = s.createStartMenuShortcut !== false;
  $('setShortcutDir').value = s.shortcutDir || '';
  $('setSharedDir').value = s.sharedDir || '';
  $('setDeviceSharedDir').value = s.deviceSharedDir || '';
  const d = s.display || {};
  $('setAutoStart').checked = s.autoStart !== false;
  const eng = s.engine || {};
  if ($('setResourceMode')) $('setResourceMode').value = eng.resourceMode || 'balanced';
  if ($('setGpuPreference')) $('setGpuPreference').value = eng.gpuPreference || 'auto';
  if ($('setRenderSize')) $('setRenderSize').value = eng.renderSize || 'auto';
  if ($('setDataGB')) $('setDataGB').value = String(Number(eng.dataPartitionGB || 0));
  if ($('setFastDns')) $('setFastDns').checked = eng.fastDns !== false;
  if ($('setLocale')) $('setLocale').value = eng.locale || 'zh-CN';
  if ($('setChineseIme')) $('setChineseIme').checked = eng.chineseIme !== false;
  if ($('setKeepSnapshot')) $('setKeepSnapshot').checked = eng.keepSnapshot !== false;
  $('setDisplayMode').value = d.mode === 'fullscreen' ? 'fullscreen' : 'window';
  if ($('setAutoFullscreen')) $('setAutoFullscreen').value = d.autoFullscreenOnLaunch === true ? 'on' : 'off';
  if ($('setLandscape')) $('setLandscape').value = d.landscape === true ? 'landscape' : 'portrait';
  if ($('setOrientationMode')) $('setOrientationMode').value = d.orientationMode || 'auto';
  if ($('setAutoRotate')) $('setAutoRotate').value = d.autoRotate === false ? 'off' : 'on';
  if ($('setTabletMode')) $('setTabletMode').value = d.tabletMode === false ? 'off' : 'on';
  $('setPortrait').value = d.portrait || '900x1600';
  // 0.6.0 起默认原生窗口：只有显式 true 才是嵌入模式（旧配置里 undefined 视为原生）
  if ($('setWindowEmbed')) $('setWindowEmbed').value = d.windowEmbed === true ? 'embed' : 'detached';
  $('portraitField').hidden = $('setDisplayMode').value === 'fullscreen';
}

/** 数据分区实际大小 + 磁盘余量，显示在设置页容量选择下方 */
async function refreshDataInfo() {
  const el = $('dataNote');
  if (!el) return;
  const info = await api.dataInfo().catch(() => null);
  if (!info) { el.textContent = '读取数据分区信息失败'; return; }
  const auto = Number(($('setDataGB') || {}).value || 0) === 0;
  // 有 quickboot 差量盘时底座镜像的大小不等于 guest 看到的容量（实测 8GB 镜像、guest 5.7GB），
  // 与其显示一个会误导人的数字，不如明确说「以运行时为准」。
  const img = info.overlay
    ? '快速启动差量盘（实际容量以运行时 /data 为准）'
    : (info.fsGB ? `实际文件系统 ${info.fsGB} GB` : (info.imageGB ? `${info.imageGB} GB` : '尚未创建'));
  const free = info.freeDiskMB ? `${(info.freeDiskMB / 1024).toFixed(1)} GB` : '未知';
  const pending = Number(info.pendingGB) > 0
    ? ` 目标 ${info.configuredGB} GB 还没生效：安卓正在用快速启动差量盘，需要「重置安卓数据」后按新容量重建（会清空已装应用）。`
    : '';
  el.textContent = `当前数据分区：${img}${auto ? '（自动）' : ''} · 所在磁盘剩余 ${free}。${pending}`
    + '游戏提示「存储空间不足」就把这里调大后点「立即扩容」；能就地扩容时不丢已装应用。';
}

/* ---------------- 设置页：分类导航 + 搜索 ---------------- */

/**
 * 设置项越来越多，一条长滚动找起来很费劲（用户 0.6.0 的原话：
 * 「设置内做好分类功能」）。这里把设置按用途分成 8 类，左侧一列导航。
 *
 * 分类表必须与 index.html 里每个分组的 data-cat 一致 ——
 * test/settings-categories-test.js 会校验这一致性。
 */
const SETTINGS_CATS = [
  { id: 'basic', name: '常用与安装' },
  { id: 'display', name: '显示与窗口' },
  { id: 'input', name: '操作与输入' },
  { id: 'perf', name: '性能与资源' },
  { id: 'net', name: '网络与下载' },
  { id: 'diag', name: '诊断与修复' },
  { id: 'files', name: '集成与文件' },
  { id: 'about', name: '更新与关于' },
  { id: 'lab', name: '实验室' },
];

const settingsCatState = { cat: 'basic', query: '' };

/** 设置里所有带分类标记的分组（.group 和 details.advanced-group 都算） */
function settingsGroups() {
  return Array.from(document.querySelectorAll('#settingsBody [data-cat]'));
}

/** 分组内是否命中搜索词：标题、字段名、说明文字都算 */
function groupMatches(group, q) {
  if (!q) return true;
  const sourceText = [];
  const walker = document.createTreeWalker(group, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const translation = translatedText.get(node);
    sourceText.push(translation ? translation.source : node.nodeValue);
  }
  const text = `${group.textContent || ''} ${sourceText.join(' ')}`.toLowerCase();
  if (text.includes(q)) return true;
  const title = group.querySelector('.group-title');
  return !!title && title.textContent.toLowerCase().includes(q);
}

/** 切到某个分类 */
function switchSettingsCat(cat, { keepQuery = false } = {}) {
  const target = SETTINGS_CATS.some((c) => c.id === cat) ? cat : 'basic';
  settingsCatState.cat = target;
  if (!keepQuery) settingsCatState.query = '';
  try { localStorage.setItem('apkstart.settings.cat', target); } catch (_) { /* ignore */ }
  const search = $('setSearch');
  if (search && !keepQuery) search.value = '';
  const clear = $('btnClearSearch');
  if (clear) clear.hidden = !settingsCatState.query;
  document.querySelectorAll('#setNav .set-nav-item').forEach((b) => {
    b.classList.toggle('on', b.dataset.cat === target);
  });
  applySettingsFilter();
}

/**
 * 应用可见性：搜索时跨分类展示命中的分组（否则搜到的东西藏在别的分类里，
 * 用户会以为「搜了没反应」）；没搜索时只显示当前分类。
 */
function applySettingsFilter() {
  const q = settingsCatState.query.trim().toLowerCase();
  const groups = settingsGroups();
  const hitPerCat = {};
  for (const g of groups) {
    const hit = groupMatches(g, q);
    const inCat = g.dataset.cat === settingsCatState.cat;
    g.hidden = q ? !hit : !inCat;
    if (hit) hitPerCat[g.dataset.cat] = (hitPerCat[g.dataset.cat] || 0) + 1;
  }
  // 分类按钮：搜索时标出哪些分类有命中项
  document.querySelectorAll('#setNav .set-nav-item').forEach((b) => {
    const n = hitPerCat[b.dataset.cat] || 0;
    b.classList.toggle('dim', !!q && n === 0);
    b.title = q ? `${n} 项命中` : '';
  });
  // 最后一个可见分组不画分隔线（分组被隐藏后 :last-child 会选错对象）
  const visible = groups.filter((g) => !g.hidden);
  visible.forEach((g) => g.classList.remove('last-visible'));
  if (visible.length) visible[visible.length - 1].classList.add('last-visible');
  updateCatBadges();
}

/** 定位到某个分组：先切到它所属的分类，再滚动过去 */
function focusGroup(el) {
  if (!el) return;
  const cat = el.dataset && el.dataset.cat;
  if (cat) switchSettingsCat(cat);
  const body = $('settingsBody');
  if (body) body.scrollTop = 0;
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function bindSettingsCategory() {
  const nav = $('setNav');
  if (nav) {
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.set-nav-item');
      if (!btn) return;
      switchSettingsCat(btn.dataset.cat);
      const body = $('settingsBody');
      if (body) body.scrollTop = 0;
    });
  }

  const search = $('setSearch');
  const clear = $('btnClearSearch');
  if (search) {
    search.addEventListener('input', () => {
      settingsCatState.query = search.value || '';
      if (clear) clear.hidden = !settingsCatState.query;
      applySettingsFilter();
    });
    // 回车：跳到第一个命中的分组
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const hit = settingsGroups().find((g) => !g.hidden);
      if (hit) focusGroup(hit);
    });
  }
  if (clear) {
    clear.addEventListener('click', () => {
      settingsCatState.query = '';
      if (search) search.value = '';
      clear.hidden = true;
      applySettingsFilter();
    });
  }

  // 记住上次停留的分类
  try {
    const last = localStorage.getItem('apkstart.settings.cat');
    if (last && SETTINGS_CATS.some((c) => c.id === last)) settingsCatState.cat = last;
  } catch (_) { /* ignore */ }
  switchSettingsCat(settingsCatState.cat);
}

/* ---------------- 自动检测（自动 debug）---------------- */

/** 自动检测的问题分类名（与 src/core/autodebug.js 的 CATEGORIES 对应） */
const DEBUG_CATS = [
  { id: 'runtime', name: '运行时' },
  { id: 'device', name: '设备连接' },
  { id: 'storage', name: '存储' },
  { id: 'settings', name: '设置' },
  { id: 'network', name: '网络' },
  { id: 'logs', name: '日志' },
];

let autodebugLast = null;

function renderAutodebug(res) {
  const list = $('autodebugList');
  const txt = $('autodebugStateText');
  if (!list) return;
  autodebugLast = res || null;
  const issues = (res && res.issues) || [];
  const at = res && res.at;

  if (txt) {
    if (res && res.running) txt.textContent = '正在检测…';
    else if (!at) txt.textContent = '尚未检测';
    else if (!issues.length) txt.textContent = `上次检测 ${relTime(at)} · 一切正常`;
    else txt.textContent = `上次检测 ${relTime(at)} · ${issues.length} 项待处理`;
  }

  if (!issues.length) {
    list.innerHTML = `<div class="dbg-ok">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
      <span>没有发现影响使用的问题。运行时、adb 授权、磁盘、数据分区、快照与设置冲突都检查过了。</span>
    </div>`;
    updateCatBadges();
    return;
  }

  const byCat = new Map();
  for (const it of issues) {
    const key = it.category || 'runtime';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(it);
  }
  const order = DEBUG_CATS.map((c) => c.id);
  const keys = Array.from(byCat.keys()).sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  list.innerHTML = keys.map((key) => {
    const name = (DEBUG_CATS.find((c) => c.id === key) || {}).name || key;
    const items = byCat.get(key);
    return `<div class="dbg-group">
      <div class="dbg-group-title">${esc(name)}<span class="dbg-count">${items.length}</span></div>
      ${items.map((it) => `
        <div class="dbg-item ${esc(it.severity || 'info')}">
          <span class="dbg-sev"></span>
          <div class="dbg-body">
            <div class="dbg-name">${esc(it.title || '')}</div>
            <div class="dbg-hint">${esc(it.hint || '')}</div>
            ${it.detail ? `<div class="dbg-detail">${esc(it.detail)}</div>` : ''}
          </div>
          ${it.fix ? `<button class="dbg-fix" data-code="${esc(it.code)}">处理</button>` : ''}
          <button class="dbg-help" data-code="${esc(it.code)}" title="打开内置教程">教程</button>
        </div>`).join('')}
    </div>`;
  }).join('');

  list.querySelectorAll('.dbg-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });
  list.querySelectorAll('.dbg-help').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) openManualForIssue(issue, 'clicked');
    });
  });

  updateCatBadges();
}

/** 分类按钮上的问题角标：只在有问题的分类上显示数字 */
function updateCatBadges() {
  const issues = (autodebugLast && autodebugLast.issues) || [];
  document.querySelectorAll('#setNav .set-nav-badge').forEach((el) => {
    const cat = el.dataset.badge;
    // 自动检测的问题不一定都归属某个设置分类，只有设置类问题才在「诊断与修复」上打标
    const n = cat === 'diag' ? issues.filter((i) => i.severity === 'error').length : 0;
    el.hidden = n === 0;
    el.textContent = n ? String(n) : '';
    el.classList.toggle('warn', false);
  });
}

function bindAutodebug() {
  const btn = $('btnAutodebugRun');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = '检测中…';
      try {
        const r = await api.autodebugRun().catch(() => null);
        if (r) renderAutodebug(r);
        else toast({ title: '检测失败', body: '采集状态时出错，稍后再试一次', type: 'error' });
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });
  }

  const report = $('btnAutodebugReport');
  if (report) {
    report.addEventListener('click', async () => {
      const r = await api.doctorReport().catch(() => null);
      if (r && r.ok !== false) toast({ title: '诊断报告已导出', body: '把报告发给作者可以最快定位问题', type: 'ok' });
      else toast({ title: '导出失败', body: (r && r.error) || '请重试', type: 'error' });
    });
  }

  const auto = $('setAutodebugAuto');
  if (auto) {
    auto.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ auto: auto.checked }).catch(() => null);
      if (r) fillAutodebugSettings(r);
      toast({
        title: auto.checked ? '已开启自动检测' : '已关闭自动检测',
        body: auto.checked ? '后台会定时检查，发现新问题才提醒' : '随时可以点「立即检测」手动跑一次',
        type: 'info',
      });
    });
  }

  const interval = $('setAutodebugInterval');
  if (interval) {
    interval.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ intervalMin: Number(interval.value) }).catch(() => null);
      if (r) fillAutodebugSettings(r);
      toast({ title: '检测间隔已更新', body: `每 ${r ? r.intervalMin : interval.value} 分钟检测一次`, type: 'ok' });
    });
  }

  const notify = $('setAutodebugNotify');
  if (notify) {
    notify.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ notify: notify.checked }).catch(() => null);
      if (r) fillAutodebugSettings(r);
    });
  }
}

function fillAutodebugSettings(cfg) {
  if (!cfg) return;
  const auto = $('setAutodebugAuto');
  if (auto) auto.checked = cfg.auto !== false;
  const interval = $('setAutodebugInterval');
  if (interval) interval.value = String(cfg.intervalMin || 10);
  const notify = $('setAutodebugNotify');
  if (notify) notify.checked = cfg.notify !== false;
}

async function openSettings() {
  state.settings = await api.getSettings();
  fillSettings(state.settings);
  fillAutodebugSettings((state.settings && state.settings.debug) || {});
  const info = await api.info();
  $('setRuntimeDir').value = info.runtimeDir || info.dataDir;
  if ($('setAvdDir')) {
    const di = await api.dataInfo().catch(() => null);
    $('setAvdDir').value = (di && di.avdDir) || '';
  }
  const verEl = document.getElementById('aboutVer');
  if (verEl && info.version) verEl.textContent = `v${info.version}`;
  const curVerEl = document.getElementById('updateCurrent');
  if (curVerEl && info.version) curVerEl.textContent = `v${info.version}`;
  const assoc = await api.assocStatus();
  const btn = $('btnAssoc');
  btn.textContent = assoc.registered ? '已关联 · 点击取消' : '未关联 · 点击开启';
  btn.dataset.on = assoc.registered ? '1' : '0';

  api.doctorProfile().then((r) => {
    if (r && r.text) $('autoProfileText').textContent = r.text;
  }).catch(() => { $('autoProfileText').textContent = '自动模式'; });
  // 显卡偏好：显示 Windows 是否真的应用了（支持但没生效时提示重启安卓）
  if ($('gpuPrefNote') && api.gpuStatus) {
    api.gpuStatus().then((g) => {
      if (!g || !g.supported) { $('gpuPrefNote').textContent = '（当前系统不支持此设置）'; return; }
      const applied = g.applied || 'auto';
      const want = g.mode || 'auto';
      const label = { auto: '系统默认', discrete: '独显', integrated: '核显' };
      $('gpuPrefNote').textContent = applied === want || want === 'auto'
        ? `（已生效：${label[applied] || applied}）`
        : `（已选 ${label[want] || want}，下次启动安卓后生效）`;
    }).catch(() => {});
  }
  api.runtimeUsage().then((u) => {
    $('usageText').textContent = formatUsageText(u);
  }).catch(() => { $('usageText').textContent = formatUsageText(null); });

  $('settingsMask').classList.add('on');
  refreshAndroid();
  refreshDataInfo();
  applySettingsFilter();
  // 先把上一次的检测结果铺上（别让面板空着等），再后台刷新一份
  api.autodebugState().then((r) => { if (r) renderAutodebug(r); }).catch(() => {});
}

function closeSettings() {
  $('settingsMask').classList.remove('on');
}

/* ---------------- 软件更新 ---------------- */

let lastUpdate = null;

/** 把一次检查结果画到设置面板（也用于启动时静默检查推送过来的状态） */
function renderUpdate(info) {
  lastUpdate = info || null;
  const cur = $('updateCurrent');
  const st = $('updateState');
  const btn = $('btnDoUpdate');
  const bar = $('updateBar');
  if (!cur || !st || !btn) return;
  if (!info) return;
  if (info.current) cur.textContent = `v${info.current}`;

  if (info.ok === false) {
    st.textContent = `检查失败：${info.error || '网络不可用'}`;
    // 检查失败也要给一条出路：直接把发布页打开，用户至少能手动下载。
    // 以前这里是「什么都不显示」，用户只会觉得「更新功能坏了」。
    showUpdateBtn(true);
    btn.textContent = '打开下载页';
    btn.dataset.mode = 'manual';
    lastUpdate = { htmlUrl: info.htmlUrl || '' };
    if (bar) bar.hidden = true;
    return;
  }
  if (info.hasUpdate) {
    // 如实说明这次是哪个源给出的版本、另一个源为什么没参与 ——
    // 用户排查「为什么检查更新很慢」时，这一行比任何日志都直接。
    const src = (info.sources || []).map((x) => `${x.name} ${x.tag || ''}`.trim()).join(' / ');
    const bad = (info.unreachable || []).map((x) => x.name).join('、');
    const stale = info.stale ? '（离线缓存，可能不是最新）' : '';
    st.textContent = `发现新版本 ${info.tag}${src ? `（${src}）` : ''}${bad ? `；${bad} 不可达` : ''}${stale}`;
    showUpdateBtn(true);
    btn.textContent = info.asset ? '立即更新' : '打开下载页';
    btn.dataset.mode = info.asset ? 'auto' : 'manual';
    const note = $('updateNote');
    if (note && info.notes) {
      const brief = String(info.notes).split('\n').slice(0, 8).join('\n').trim();
      if (brief) note.textContent = `更新内容：\n${brief}`;
    }
    if (bar) bar.hidden = true;
  } else {
    const src = (info.sources || []).map((x) => x.name).join(' / ');
    const stale = info.stale ? '（离线缓存）' : '';
    st.textContent = `已是最新版本（v${info.current}）${src ? ` · 经由 ${src}` : ''}${stale}`;
    showUpdateBtn(false);
    if (bar) bar.hidden = true;
  }
}

/** .btn 自带 display:inline-flex，会盖掉 hidden 属性，所以这里直接改 display */
function showUpdateBtn(on) {
  const btn = $('btnDoUpdate');
  if (!btn) return;
  btn.hidden = !on;
  btn.style.display = on ? '' : 'none';
}

function renderUpdateProgress(p) {
  if (!p) return;
  const st = $('updateState');
  const bar = $('updateBar');
  const fill = $('updateBarFill');
  if (p.stage === 'error') {
    if (st) st.textContent = `更新失败：${p.message || ''}`;
    if (bar) bar.hidden = true;
    toast({ title: '更新失败', body: p.message || '', type: 'error' });
    return;
  }
  if (st) st.textContent = p.message || '正在更新…';
  if (bar && fill) {
    bar.hidden = false;
    fill.style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
  }
}

function bindUpdate() {
  const check = $('btnCheckUpdate');
  const go = $('btnDoUpdate');
  if (!check || !go) return;

  const runCheck = async (silent) => {
    if (!silent) {
      check.disabled = true;
      const old = check.textContent;
      check.textContent = '检查中…';
      $('updateState').textContent = '正在连接 GitHub…';
      try {
        const info = await api.updateCheck();
        renderUpdate(info);
        if (info && info.hasUpdate) toast({ title: `发现新版本 ${info.tag}`, body: '点「立即更新」自动下载安装', type: 'info' });
        else if (info && info.ok !== false) toast({ title: '已是最新版本', body: `v${info.current}`, type: 'ok' });
      } catch (e) {
        $('updateState').textContent = `检查失败：${e.message}`;
      } finally {
        check.disabled = false;
        check.textContent = old;
      }
      return;
    }
    const info = await api.updateCheck().catch(() => null);
    if (info) renderUpdate(info);
  };

  check.addEventListener('click', () => runCheck(false));

  go.addEventListener('click', async () => {
    if (go.dataset.mode === 'manual') {
      api.updateOpenRelease(lastUpdate && lastUpdate.htmlUrl);
      return;
    }
    go.disabled = true;
    go.textContent = '更新中…';
    const r = await api.updateApply().catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) {
      go.disabled = false;
      go.textContent = '立即更新';
      if (r && r.error && !r.manual) {
        $('updateState').textContent = `更新失败：${r.error}`;
        toast({ title: '更新失败', body: r.error, type: 'error' });
      }
    } else {
      $('updateState').textContent = `已下载 v${r.version}，正在重启完成安装…`;
    }
  });

  // 打开设置时如果还没结果，就顺手查一次（放后台，不打扰）
  runCheck(true).catch(() => {});
}

function bindSettings() {
  const save = async (patch) => {
    state.settings = await api.setSettings(patch);
  };

  if ($('setLanguage')) {
    $('setLanguage').addEventListener('change', async (e) => {
      const language = e.target.value === 'zh-CN' ? 'zh-CN' : 'en';
      state.settings = await api.setSettings({ language });
      applyUiLanguage(language);
      toast({
        title: language === 'en' ? 'Language changed' : '界面语言已更改',
        body: language === 'en' ? 'The interface is now in English.' : '界面已切换为简体中文。',
        type: 'ok',
      });
    });
  }

  if ($('btnPreflight')) $('btnPreflight').addEventListener('click', () => runPreflight());
  if ($('btnPreflightApply')) {
    $('btnPreflightApply').addEventListener('click', async () => {
      const btn = $('btnPreflightApply');
      btn.disabled = true;
      const r = await api.preflightApply().catch(() => null);
      btn.disabled = false;
      if (!r || !r.ok) {
        toast({ type: 'error', title: '应用失败', body: (r && r.error) || '请稍后再试' });
        return;
      }
      state.settings = r.settings;
      toast({
        type: 'ok',
        title: '已按这台机器配置好',
        body: `内存 ${Math.round((r.recommended.memoryMB || 0) / 1024)} GB / ${r.recommended.cores} 核 / ${r.recommended.renderSize}`
          + (r.driverFile ? '；已生成驱动，下次开机会自动套用' : ''),
      });
      if (r.driverError) toast({ type: 'warn', title: '驱动没写成功', body: r.driverError });
      fillSettings(r.settings);
      refreshStatus();
    });
  }
  if ($('btnDrvReload')) $('btnDrvReload').addEventListener('click', () => refreshDrivers());
  if ($('btnDrvFolder')) {
    $('btnDrvFolder').addEventListener('click', async () => {
      const r = await api.driversOpenFolder().catch(() => null);
      if (!r || !r.ok) toast({ type: 'error', title: '打不开驱动目录' });
    });
  }
  if ($('btnDrvImport')) {
    $('btnDrvImport').addEventListener('click', async () => {
      const r = await api.driversImport().catch(() => null);
      if (!r || r.canceled) return;
      if (!r.ok) {
        toast({ type: 'error', title: '导入失败', body: (r.errors || []).slice(0, 3).join('；') });
        return;
      }
      toast({ type: 'ok', title: '驱动已导入并启用', body: `${r.driver.name} v${r.driver.version}` });
      if (r.overview) renderDrivers(r.overview);
    });
  }
  if ($('btnDrvExport')) {
    $('btnDrvExport').addEventListener('click', async () => {
      const r = await api.driversExportTemplate().catch(() => null);
      if (!r || r.canceled) return;
      if (!r.ok) { toast({ type: 'error', title: '导出失败' }); return; }
      toast({ type: 'ok', title: '模板已导出', body: '改完 effect 后放到驱动目录，点「刷新」即可生效' });
      refreshDrivers();
    });
  }

  $('setAdbPath').addEventListener('change', (e) => save({ adbPath: e.target.value.trim() }));
  $('setSystemImage').addEventListener('change', (e) => save({ runtime: { isoPath: e.target.value.trim() } }));
  // 内存 / 核心：填了具体值就关掉「自动」，填 0 又回到自动。
  // 旧代码只写 memoryMB，而 overridesFromSettings 只在 autoMemory=false 时才认它，
  // 于是「手动填了内存」一直被忽略 —— 这是设置页最容易被当成“没用”的一项。
  $('setMemory').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { memoryMB: v, autoMemory: false } } : { engine: { memoryMB: 0, autoMemory: true } });
  });
  $('setCores').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { cores: v, autoMemory: false } } : { engine: { cores: 0, autoMemory: true } });
  });
  if ($('setResourceMode')) {
    $('setResourceMode').addEventListener('change', async (e) => {
      // 资源策略会连带改 liteMode / priorityMode / renderSize（主进程里翻译）
      state.settings = await api.setSettings({ engine: { resourceMode: e.target.value } });
      fillSettings(state.settings);
      toast({ title: '资源策略已切换', body: '下一次打开应用生效', type: 'ok' });
    });
  }
  if ($('setGpuPreference')) {
    $('setGpuPreference').addEventListener('change', (e) => {
      save({ engine: { gpuPreference: e.target.value } });
      toast({ title: '显卡偏好已保存', body: '下一次启动安卓时生效', type: 'ok' });
    });
  }
  if ($('setRenderSize')) {
    $('setRenderSize').addEventListener('change', (e) => save({ engine: { renderSize: e.target.value } }));
  }
  if ($('setFastDns')) {
    $('setFastDns').addEventListener('change', (e) => save({ engine: { fastDns: e.target.checked } }));
  }
  if ($('setLocale')) {
    $('setLocale').addEventListener('change', async (e) => {
      state.settings = await api.setSettings({ engine: { locale: e.target.value } });
      toast({ title: '系统语言已更新', body: '下次重启安卓运行时后生效', type: 'ok' });
    });
  }
  if ($('setChineseIme')) {
    $('setChineseIme').addEventListener('change', async (e) => {
      state.settings = await api.setSettings({ engine: { chineseIme: e.target.checked } });
      toast({
        title: e.target.checked ? '已开启中文输入法' : '已关闭中文输入法',
        body: '下次重启安卓运行时后生效',
        type: 'ok',
      });
    });
  }
  if ($('setKeepSnapshot')) {
    $('setKeepSnapshot').addEventListener('change', (e) => save({ engine: { keepSnapshot: e.target.checked } }));
  }
  if ($('setDataGB')) {
    $('setDataGB').addEventListener('change', (e) => {
      save({ engine: { dataPartitionGB: Number(e.target.value) || 0 } });
      refreshDataInfo();
    });
  }
  if ($('btnGrowData')) {
    $('btnGrowData').addEventListener('click', async () => {
      const gb = Number($('setDataGB').value) || 0;
      if (!gb) { toast({ title: '先选一个容量', body: '「自动」表示由软件按磁盘余量决定，不需要扩容', type: 'info' }); return; }
      const { response } = await api.confirm({
        title: '立刻把安卓数据分区扩容？',
        message: `将把 /data 调整为 ${gb} GB（就地扩容，已装应用和存档都会保留）。`,
        detail: '扩容需要先关掉正在运行的安卓应用，完成后下次打开应用会重新引导，约多花十几秒。',
        okLabel: '开始扩容',
      });
      if (response !== 1) return;
      $('btnGrowData').disabled = true;
      const old = $('btnGrowData').textContent;
      $('btnGrowData').textContent = '扩容中…';
      const r = await api.setDataSize(gb).catch((e) => ({ ok: false, error: e.message }));
      $('btnGrowData').disabled = false;
      $('btnGrowData').textContent = old;
      if (r && !r.ok && r.needsReset) {
        // 快速启动的差量盘挡着：就地扩容做不到，只能按新容量重建 /data。
        // 这是明确的数据丢失操作，必须单独再确认一次。
        const again = await api.confirm({
          title: '需要重置安卓数据才能扩容',
          message: `安卓正在使用快速启动差量盘，就地扩容改不到它。要拿到 ${gb} GB 空间，必须按新容量重建 /data。`,
          detail: '重建会清空已安装的应用与存档（模拟器本身和镜像不受影响）。确定继续吗？',
          okLabel: '清空并重建',
        });
        if (again.response !== 1) { refreshDataInfo(); return; }
        $('btnGrowData').disabled = true;
        $('btnGrowData').textContent = '重建中…';
        const rr = await api.resetAndResize(gb).catch((e) => ({ ok: false, error: e.message }));
        $('btnGrowData').disabled = false;
        $('btnGrowData').textContent = old;
        toast({
          type: rr && rr.ok ? 'ok' : 'error',
          title: rr && rr.ok ? '已按新容量重建' : '重建失败',
          body: rr && rr.ok
            ? `下次打开应用会按 ${gb} GB 重建 /data（首次进入会多等几十秒）`
            : (rr && rr.error) || '未知错误',
        });
        refreshDataInfo();
        return;
      }
      toast({
        type: r && r.ok ? 'ok' : 'error',
        title: r && r.ok ? '数据分区已扩容' : '扩容失败',
        body: r && r.ok ? `现在约 ${r.fsGB || r.imageGB || gb} GB 可用` : (r && r.error) || '未知错误',
      });
      refreshDataInfo();
    });
  }
  $('setIdle').addEventListener('change', (e) => save({ engine: { idleShutdownMinutes: Number(e.target.value) || 0 } }));
  if ($('setSourcePref')) {
    $('setSourcePref').addEventListener('change', (e) => save({ runtime: { sourcePreference: e.target.value } }));
  }
  if ($('setAutoMirror')) {
    $('setAutoMirror').addEventListener('change', (e) => save({ runtime: { autoMirror: e.target.checked } }));
  }
  if ($('setGiteeToken')) {
    $('setGiteeToken').addEventListener('change', (e) => save({ runtime: { giteeToken: e.target.value.trim() } }));
  }
  if ($('setMirrorPrefix')) {
    $('setMirrorPrefix').addEventListener('change', (e) => save({ runtime: { mirrorPrefix: e.target.value.trim() } }));
  }
  if ($('setConnections')) {
    $('setConnections').addEventListener('change', (e) => {
      const n = Math.max(1, Math.min(16, Number(e.target.value) || 8));
      e.target.value = n;
      save({ runtime: { downloadConnections: n } });
    });
  }
  $('setAudio').addEventListener('change', (e) => save({ engine: { audio: e.target.checked } }));
  if ($('setMicrophone')) {
    $('setMicrophone').addEventListener('change', (e) => save({ engine: { microphone: e.target.checked } }));
  }
  $('setLiteMode').addEventListener('change', (e) => save({ engine: { liteMode: e.target.checked } }));
  $('setPrewarm').addEventListener('change', (e) => save({ engine: { prewarm: e.target.checked } }));
  $('setPriorityMode').addEventListener('change', (e) => save({ engine: { priorityMode: e.target.value } }));
  const savePointer = async (patch) => {
    await save({ engine: patch });
    // 立刻按当前窗口焦点重装/卸载钩子，不用等下次切窗口
    api.refreshPointerMapping().catch(() => {});
  };
  $('setMouseRightBack').addEventListener('change', (e) => savePointer({ mouseRightBack: e.target.checked }));
  $('setMouseWheelMode').addEventListener('change', (e) => savePointer({ mouseWheelMode: e.target.value }));
  $('setMouseSideButtons').addEventListener('change', (e) => savePointer({ mouseSideButtons: e.target.checked }));
  if ($('setKeymapEnabled')) {
    $('setKeymapEnabled').addEventListener('change', async (e) => {
      await api.keymap.setEnabled(e.target.checked);
      toast({ title: e.target.checked ? '键盘映射已开启' : '键盘映射已关闭', type: 'ok' });
    });
  }
  // 实验室：多开开关与后台保留数。改完提示下次打开应用生效（切换应用路径才读它）。
  if ($('setMultiWindow')) {
    $('setMultiWindow').addEventListener('change', (e) => {
      save({ engine: { multiWindow: e.target.checked } });
      toast({
        title: e.target.checked ? '多窗口多开已开启（实验性）' : '已回到单应用模式',
        body: e.target.checked ? '下次打开应用生效：多个应用可并存、各自独立原生窗口。' : '',
        type: 'ok',
      });
    });
  }
  if ($('setKeepBackground')) {
    $('setKeepBackground').addEventListener('change', (e) => {
      save({ engine: { keepBackground: Number(e.target.value) } });
    });
  }
  $('setDeepTrim').addEventListener('change', async (e) => {
    await save({ engine: { deepTrim: e.target.checked } });
    // 关掉深度裁剪必须把之前 pm disable-user 的包恢复回来，否则影响是持久的
    if (!e.target.checked) {
      api.restoreSystemApps().catch(() => {});
      toast({ title: '已恢复系统组件', body: '深度裁剪关闭，后台包正在恢复', type: 'info' });
    }
  });
  $('setCompat').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await save({ runtime: { compatImage: on } });
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (on && !ok) toast({ title: 'ARM 兼容模式已开启', body: '还需要下载 Google Play 兼容镜像（Android 14，约 1.5GB），点击下方按钮开始', type: 'info' });
    else if (on) toast({ title: 'ARM 兼容模式已开启', body: '重启运行时后生效', type: 'info' });
  });
  $('setAutoShortcut').addEventListener('change', (e) => save({ createShortcutOnInstall: e.target.checked }));
  $('setStartMenuShortcut').addEventListener('change', (e) => save({ createStartMenuShortcut: e.target.checked }));
  $('setShortcutDir').addEventListener('change', (e) => save({ shortcutDir: e.target.value.trim() }));
  $('setDeviceSharedDir').addEventListener('change', (e) => save({ deviceSharedDir: e.target.value.trim() }));
  $('setAutoStart').addEventListener('change', (e) => save({ autoStart: e.target.checked }));
  $('setDisplayMode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    $('portraitField').hidden = mode === 'fullscreen';
    state.settings = await api.setSettings({ display: { mode } });
    toast({ title: mode === 'fullscreen' ? '已切全屏' : '已切竖屏窗口', type: 'ok' });
  });
  if ($('setAutoFullscreen')) {
    $('setAutoFullscreen').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { autoFullscreenOnLaunch: on } });
      toast({ title: on ? '已开启自动全屏' : '已关闭自动全屏', body: '下次打开应用时生效', type: 'ok' });
    });
  }
  if ($('setOrientationMode')) {
    $('setOrientationMode').addEventListener('change', async (e) => {
      const mode = e.target.value;
      state.settings = await api.setSettings({ display: { orientationMode: mode } });
      toast({
        title: mode === 'auto' ? '已设为跟随应用' : (mode === 'landscape' ? '已强制横屏' : '已强制竖屏'),
        body: mode === 'auto'
          ? '下次打开应用时会按应用自己的方向选面板，方向不一致的话会重启一次运行时。'
          : '下次打开应用时会重启一次运行时把面板切到指定方向，之后不再重启。',
        type: 'ok',
      });
    });
  }
  if ($('setAutoRotate')) {
    $('setAutoRotate').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { autoRotate: on } });
      toast({
        title: on ? '已打开镜像自动旋转' : '已关闭镜像自动旋转',
        body: '下次打开应用时写进安卓镜像。画面方向仍由屏幕方向策略决定，不受此开关影响。',
        type: 'ok',
      });
    });
  }
  if ($('setTabletMode')) {
    $('setTabletMode').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { tabletMode: on } });
      toast({
        title: on ? '已打开平板排版' : '已关闭平板排版',
        body: '下次打开应用时生效（会重启一次运行时来改逻辑密度）。',
        type: 'ok',
      });
    });
  }
  if ($('setLandscape')) {
    $('setLandscape').addEventListener('change', async (e) => {
      const landscape = e.target.value === 'landscape';
      state.settings = await api.setSettings({ display: { landscape } });
      toast({
        title: landscape ? '面板已设为横屏' : '面板已设为竖屏',
        body: '下次打开应用时会重启一次运行时来切换物理面板方向（约十几秒），之后就不会再重启。',
        type: 'ok',
      });
    });
  }
  $('setPortrait').addEventListener('change', async (e) => {
    state.settings = await api.setSettings({ display: { portrait: e.target.value } });
    toast({ title: '画面大小已更新', body: '下次打开应用或切换应用时生效', type: 'ok' });
  });
  $('setWindowEmbed').addEventListener('change', async (e) => {
    const embed = e.target.value === 'embed';
    // windowEmbedChosen 标记「用户自己选过」：之后升级不会再被默认值迁移覆盖。
    state.settings = await api.setSettings({
      display: { windowEmbed: embed, windowEmbedChosen: true },
    });
    toast({
      title: embed ? '已切回嵌入模式' : '已切到原生窗口',
      body: embed
        ? '下次打开应用时生效。嵌入模式观感统一、标题栏带旋转按钮，但缩放/旋转时更容易掉帧或出现黑边。'
        : '下次打开应用时生效。原生窗口由模拟器自己渲染与排布，帧率和缩放更稳，横屏可用托盘菜单或 Ctrl+Alt+R。',
      type: 'ok',
    });
  });
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const r = await api.rebuildShortcuts();
    toast({
      title: r && r.fixed && r.fixed.length ? '已补齐快捷方式' : '快捷方式都还在',
      body: r && r.fixed && r.fixed.length ? r.fixed.join('、') : '桌面与开始菜单入口正常',
      type: 'ok',
    });
  });

  $('btnDiagnostics').addEventListener('click', async () => {
    try {
      const r = await api.doctorReport();
      toast({ title: '诊断报告已导出', body: `${r.diagnosis.title} · ${r.file}`, type: 'ok', sticky: true });
    } catch (e) {
      toast({ title: '导出失败', body: e.message, type: 'error' });
    }
  });

  $('btnCleanup').addEventListener('click', async () => {
    const btn = $('btnCleanup');
    const includeSnapshots = $('chkCleanSnapshots') && $('chkCleanSnapshots').checked;
    btn.disabled = true;
    try {
      const preview = await api.runtimeCleanup({ apply: false, includeSnapshots });
      if (!preview.candidates.length) {
        toast({ title: '已经是精简状态', body: '没有可回收的旧镜像或快照。', type: 'ok' });
        return;
      }
      const r = await api.runtimeCleanup({ apply: true, includeSnapshots });
      if (r.cancelled) return;
      toast({
        title: '清理完成',
        body: `释放约 ${(r.saved / 1048576).toFixed(0)} MB（${r.removed.length} 项），已安装应用保留。`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = formatUsageText(u);
    } catch (e) {
      toast({ title: '清理失败', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // 重置安卓数据：二级确认（先确认意图，再确认不可撤销），清完刷新占用统计
  $('btnResetData').addEventListener('click', async () => {
    const btn = $('btnResetData');
    btn.disabled = true;
    try {
      const first = await api.confirm({
        type: 'warning',
        title: '重置安卓数据？',
        message: '这会把安卓系统还原成「刚装好系统」的干净状态：',
        detail: '• 删除全部已安装的第三方 app（含红果、游戏等）及其数据、登录态\n'
          + '• 删除当前 AVD 的快速启动快照\n'
          + '• 系统镜像本身不受影响，重新打开应用会再次冷启动建数据\n\n'
          + '此操作不可撤销。是否继续？',
        buttons: ['取消', '继续'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!first || first.response !== 1) return;
      const second = await api.confirm({
        type: 'warning',
        title: '再确认一次',
        message: '已安装的 app 和它们的数据将被永久删除，确定要重置吗？',
        detail: '可放心的是：系统镜像、其它 AVD、本机的 APK 缓存和图标都不会动。',
        buttons: ['取消', '确定重置'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!second || second.response !== 1) return;
      const r = await api.runtimeResetData();
      if (!r || !r.ok) {
        toast({ title: '重置失败', body: (r && r.error) || '请重试', type: 'error' });
        return;
      }
      toast({
        title: '安卓数据已重置',
        body: `释放约 ${r.reclaimedMB} MB，已安装应用记录已清空。`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = formatUsageText(u);
    } catch (e) {
      toast({ title: '重置失败', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // 修复网络：安卓里联网页面一直黑屏（红果点「同意并继续」后整屏黑）时用。
  // 根因是虚拟机 /data 里的 Wi-Fi 配置坏了，wlan0 没起来、没有默认路由。
  // Play Store 镜像不允许 root，只能整体重置 /data；应用清单保留，点开时会自动重装。
  $('btnRepairNetwork').addEventListener('click', async () => {
    const btn = $('btnRepairNetwork');
    btn.disabled = true;
    try {
      const ok = await api.confirm({
        type: 'warning',
        title: '修复虚拟机网络？',
        message: '应用里需要联网的页面一直黑屏/转圈，通常是安卓虚拟机没有网络。',
        detail: '修复会按「代价从小到大」依次尝试：\n\n'
          + '1. 冷启动虚拟机（不加载快照）后等待联网 —— 不影响任何数据\n'
          + '2. 仍不行才重置安卓数据 —— 应用清单保留、点开会自动重装，\n'
          + '   但应用内的登录态、追剧记录等会丢失\n\n'
          + '只影响当前 AVD，系统镜像和本机 APK 缓存都不动。整个过程约 1–5 分钟。是否继续？',
        buttons: ['取消', '开始修复'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const r = await api.runtimeRepairNetwork();
      if (!r || !r.ok) {
        toast({
          title: '网络仍未恢复',
          body: (r && r.error) || '重置后虚拟机还是没网，请检查本机网络/防火墙是否拦住了模拟器。',
          type: 'error',
        });
        return;
      }
      toast({
        title: '网络已恢复',
        body: `${(r.network && r.network.ip) || '已联网'}${r.wiped ? '（为修复网络重置过安卓数据，点开应用会自动重装）' : '（未动你的数据）'}`,
        type: 'ok',
      });
    } catch (e) {
      toast({ title: '修复失败', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // 清理旧版本残留：扫描旧程序目录 / 失效卸载项 / 更新临时文件，确认后一次性清掉。
  $('btnLeftovers').addEventListener('click', async () => {
    const btn = $('btnLeftovers');
    btn.disabled = true;
    try {
      const r = await api.leftoversScan();
      if (!r || !r.ok) {
        toast({ title: '扫描失败', body: (r && r.error) || '请重试', type: 'error' });
        return;
      }
      const items = r.items || [];
      if (!items.length) {
        toast({ title: '很干净', body: '没有发现旧版本残留。', type: 'ok' });
        return;
      }
      const mb = Math.round((r.totalBytes || 0) / 1048576);
      const lines = items.slice(0, 8).map((x) => `• ${x.note}：${x.path}`);
      if (items.length > 8) lines.push(`…另有 ${items.length - 8} 项`);
      const ok = await api.confirm({
        type: 'warning',
        title: '清理旧版本残留？',
        message: `找到 ${items.length} 项残留，约 ${mb} MB：`,
        detail: `${lines.join('\n')}\n\n只删除「旧版本程序目录 / 已失效的卸载项 / 更新临时文件」，`
          + '当前正在运行的版本和你的应用数据都不会动。',
        buttons: ['取消', '开始清理'],
        defaultId: 1,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const c = await api.leftoversClean(items);
      if (!c || !c.ok) {
        toast({ title: '清理失败', body: (c && c.error) || '请重试', type: 'error' });
        return;
      }
      const failNote = (c.failed && c.failed.length) ? `，${c.failed.length} 项被占用未删` : '';
      toast({
        title: '已清理旧版本残留',
        body: `删除 ${c.removed.length} 项，释放 ${c.freedMB || 0} MB${failNote}。`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = formatUsageText(u);
    } catch (e) {
      toast({ title: '清理失败', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  $('btnOpenShared').addEventListener('click', () => api.openSharedDir());

  // 重建快捷方式：桌面图标被误删 / 被安全软件拦掉时的兜底入口
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const btn = $('btnRebuildShortcuts');
    btn.disabled = true;
    try {
      const r = await api.rebuildShortcuts().catch(() => ({ ok: false }));
      const fixed = (r && r.fixed) || [];
      toast(fixed.length
        ? { title: '快捷方式已重建', body: fixed.join('、'), type: 'ok' }
        : { title: '快捷方式都在', body: '没有需要重建的入口', type: 'info' });
    } finally {
      btn.disabled = false;
    }
  });

  // 共享目录：先浏览选目录，再「保存并迁移」把旧文件一次性搬到新目录
  $('btnBrowseShared').addEventListener('click', async () => {
    const picked = await api.openDir();
    if (!picked) return;
    $('setSharedDir').value = picked;
    toast({ title: '已选新目录', body: '点「保存并迁移」把旧文件搬过去', type: 'info' });
  });
  $('btnSaveShared').addEventListener('click', async () => {
    const dir = $('setSharedDir').value.trim();
    if (!dir) { toast({ title: '请先填写或浏览目录', type: 'error' }); return; }
    const btn = $('btnSaveShared');
    btn.disabled = true;
    const r = await api.setSharedDir(dir).catch(() => ({ ok: false }));
    btn.disabled = false;
    if (r.ok) {
      const moved = r.oldDir && r.oldDir !== r.newDir;
      toast({ title: '共享目录已更新', body: moved ? '旧目录里已有的文件已迁移到新目录' : '已保存', type: 'ok' });
    } else {
      toast({ title: '保存失败', body: r.error, type: 'error' });
    }
  });

  // 一键卸载 ApkStart 本体（取消 .apk 关联 + 启动卸载程序；便携版手动删除）
  $('btnUninstall').addEventListener('click', async () => {
    const ok = window.confirm('确定卸载 ApkStart？\n\n将取消 .apk 文件关联并移除程序。此操作不可撤销。');
    if (!ok) return;
    const btn = $('btnUninstall');
    btn.disabled = true;
    const r = await api.removeSelf().catch(() => ({ ok: false }));
    if (r.ok && r.portable) {
      btn.disabled = false;
      toast({
        title: '便携版无法自动卸载',
        body: `请手动删除程序目录（${r.exeDir}）与数据目录（${r.dataDir}）`,
        type: 'info', sticky: true,
      });
      return;
    }
    if (!r.ok) {
      btn.disabled = false;
      toast({ title: '卸载失败', body: r.error, type: 'error' });
      return;
    }
    toast({ title: '正在卸载…', body: '卸载程序已启动，ApkStart 即将退出', type: 'ok', sticky: true });
  });

  // ARM 兼容镜像下载（带进度 toast）
  $('btnInstallPlay').addEventListener('click', async () => {
    const btn = $('btnInstallPlay');
    btn.disabled = true;
    const t = toast({ title: '开始下载 ARM 兼容镜像', body: '准备中…', sticky: true, spinner: true, progress: 3 });
    const un = api.on('provision:progress', (p) => {
      if (p.component !== 'playimg') return;
      t.update({ title: '下载 ARM 兼容镜像', body: p.message || '', progress: p.percent });
    });
    try {
      const r = await api.installPlayImage();
      if (r && r.ok) {
        t.update({ title: 'ARM 兼容镜像就绪', body: '重启运行时后生效', progress: 100 });
        setTimeout(() => t.dismiss(), 3000);
        $('compatInstallField').hidden = true;
        refreshStatus();
      } else {
        t.update({ title: '兼容镜像下载失败', body: (r && r.error) || '未知错误', progress: null });
        t.dismiss();
        toast({ title: '兼容镜像下载失败', body: (r && r.error) || '未知错误', type: 'error' });
      }
    } catch (e) {
      t.dismiss();
      toast({ title: '兼容镜像下载失败', body: e.message, type: 'error' });
    } finally {
      un();
      btn.disabled = false;
    }
  });

  // 兼容镜像状态显示
  (async () => {
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const s = state.settings;
    const on = !!(s && s.runtime && s.runtime.compatImage);
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (env.playImage) {
      $('compatImgStatus').textContent = ok
        ? `已就绪（${(env.playImage.size / 1073741824).toFixed(2)} GB）` : '未下载';
    }
  })();
  $('btnOpenData').addEventListener('click', async () => {
    const info = await api.info();
    const dir = info.runtimeDir || info.dataDir;
    window.open(`file:///${dir.replace(/\\/g, '/')}`);
  });
  $('btnBrowseRuntimeDir').addEventListener('click', async () => {
    const info = await api.info();
    const picked = await api.openDir();
    if (!picked) return;
    await api.setSettings({ runtime: { dir: picked } });
    $('setRuntimeDir').value = picked;
    toast({ title: '数据目录已更新', body: '请重启 ApkStart 使其生效（旧数据不会自动搬移）', type: 'ok', sticky: true });
  });

  // 安卓数据目录（AVD + 快照）：真正吃盘的那块，单独指到别的盘
  if ($('btnBrowseAvdDir')) {
    $('btnBrowseAvdDir').addEventListener('click', async () => {
      const picked = await api.openDir();
      if (!picked) return;
      await api.setSettings({ runtime: { avdDir: picked } });
      $('setAvdDir').value = picked;
      toast({
        title: '安卓数据目录已更新',
        body: '请重启 ApkStart 使其生效。旧目录里的 apkstart.avd 可以整体搬到新目录，再删掉旧的。',
        type: 'ok',
        sticky: true,
      });
    });
  }
  if ($('btnOpenAvdDir')) {
    $('btnOpenAvdDir').addEventListener('click', async () => {
      const info = await api.dataInfo().catch(() => null);
      const dir = (info && info.avdDir) || (await api.info()).dataDir;
      window.open(`file:///${String(dir).replace(/\\/g, '/')}`);
    });
  }

  $('btnRuntimeStart').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = '正在启动…';
    const r = await api.runtimeStart();
    el.textContent = r.ok ? `已就绪：${r.engine}` : `启动失败：${r.error}`;
    refreshStatus();
  });

  $('btnRuntimeStop').addEventListener('click', async () => {
    await api.runtimeStop();
    $('probeResult').textContent = '已停止内置虚拟机';
    refreshStatus();
  });

  $('btnAssoc').addEventListener('click', async () => {
    const btn = $('btnAssoc');
    if (btn.dataset.on === '1') {
      await api.assocUnregister();
      btn.textContent = '未关联 · 点击开启';
      btn.dataset.on = '0';
      toast({ title: '.apk 关联已取消' });
    } else {
      const r = await api.assocRegister();
      btn.textContent = '已关联 · 点击取消';
      btn.dataset.on = '1';
      toast({ title: '.apk 关联已开启', body: r.ok ? '现在双击 APK 会直接安装到 ApkStart' : '', type: r.ok ? 'ok' : 'error' });
    }
  });
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  // 链接统一走系统浏览器
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.getAttribute('href'));
  });

  $('btnSettings').addEventListener('click', openSettings);
  // 0.6.2：内置手册从标题栏和「关于」页都能直接打开
  $('btnManual')?.addEventListener('click', () => openManual({ topic: 'overview', reason: 'toolbar' }));
  $('btnOpenManual')?.addEventListener('click', () => openManual({ topic: 'overview', reason: 'about' }));
  // 状态标签也当入口：点「需要部署 / 引导中 / Android 14」直接进设置的运行时面板
  $('engineTag').addEventListener('click', () => showSetup(true));
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnDoneSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', (e) => {
    if (e.target === $('settingsMask')) closeSettings();
  });

  // 运行时部署：入口已收进设置，这里只处理面板内的按钮
  $('btnDeployAll').addEventListener('click', deployAll);
  $('btnMarkInstalled').addEventListener('click', markInstalled);
  $('btnGuideClose').addEventListener('click', () => { $('setupGuide').hidden = true; });
  $('btnSetupAdvanced').addEventListener('click', () => {
    const adv = document.querySelector('.advanced-group');
    if (adv) {
      adv.open = true;
      adv.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });

  // 状态条上的自检计数：点开就是设置里的运行时面板
  $('envChip').addEventListener('click', () => {
    openSettings().then(() => {
      const box = $('envCheck');
      if (box && !box.hidden) focusGroup(box);
      else focusGroup($('runtimeGroup'));
    }).catch(() => {});
  });

  $('setupSteps').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'emulator' || act === 'sysimg' || act === 'accel'
      || act === 'adb' || act === 'qemu' || act === 'iso' || act === 'disk') {
      const r = await runStep(act);
      if (!r.ok) toast({ title: '操作失败', body: r.error, type: 'error', sticky: true });
      return;
    }
    if (act === 'isoImport') {
      const r = await api.importIso();
      if (r.ok) { toast({ title: '系统镜像已导入', body: r.path, type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: '导入失败', body: r.error, type: 'error' });
      return;
    }
    if (act === 'diskImport') {
      const r = await api.importDisk();
      if (r.ok) { toast({ title: '虚拟磁盘已导入', body: '可直接启动运行时', type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: '导入失败', body: r.error, type: 'error' });
      return;
    }
    if (act === 'install') { await startInstall(); return; }
    if (act === 'vmStart') {
      const t = toast({ title: '正在启动运行时…', body: '首次启动需要引导 Android 系统', sticky: true, spinner: true });
      const r = await api.runtimeStart();
      if (r.ok) { t.update({ title: '运行时已就绪', type: 'ok' }); setTimeout(t.dismiss, 2200); }
      else t.update({ title: '启动失败', body: r.error, type: 'error' });
      refreshStatus();
      return;
    }
    if (act === 'vmStop') {
      await api.runtimeStop();
      toast({ title: '运行时会话已结束' });
      refreshStatus();
    }
  });

  const pick = async () => {
    const files = await api.pickApk();
    if (files.length) installFiles(files);
  };
  $('btnInstall').addEventListener('click', pick);
  $('btnInstall2').addEventListener('click', pick);
  // 共享目录入口移到设置里：同步 + 打开都在「文件互通」组内
  const btnSync = $('btnSyncShared');
  if (btnSync) btnSync.addEventListener('click', async () => {
    btnSync.disabled = true;
    try {
      await api.syncShared();
      toast({ title: '已同步共享目录', type: 'ok' });
    } catch (_) {
      toast({ title: '同步失败', body: '运行时未就绪时会跳过同步', type: 'error' });
    } finally {
      btnSync.disabled = false;
    }
  });

  $('search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderGrid();
  });

  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    // 「添加应用」卡片没有 data-pkg，走安装流程而不是启动。
    // 直接转调工具栏那个「安装 APK」按钮，复用它的文件选择逻辑。
    if (card.classList.contains('card-add')) { $('btnInstall').click(); return; }
    if (card.dataset.pkg) launchApp(card.dataset.pkg);
  });

  $('grid').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, card.dataset.pkg);
  });

  $('grid').addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card) createShortcut(card.dataset.pkg);
  });

  $('ctxmenu').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (item) handleMenu(item.dataset.act);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxmenu')) hideMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
      closeSettings();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });

  // 拖放安装
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('dropzone').classList.add('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropzone').classList.remove('on');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files
      .map((f) => { try { return api.pathForFile(f); } catch (_) { return null; } })
      .filter((p) => p && /\.apk$/i.test(p));
    if (paths.length) installFiles(paths);
    else toast({ title: '只能拖入 .apk 文件', type: 'error' });
  });

  // 主进程事件
  api.on('install:error', (p) => {
    // 报错了就别再让「正在安装…」那条一直转圈（可能来自双击 APK 的另一条链路）
    if (installToast) { try { installToast.dismiss(); } catch (_) { /* ignore */ } installToast = null; }
    const name = p && p.file ? String(p.file).split(/[\\/]/).pop() : '';
    const raw = (p && p.message) || '未知错误';
    toast({
      title: name ? `安装失败：${name}` : '安装失败',
      body: friendlyInstallErrorText(raw),
      type: 'error',
    });
    // 0.6.2：安装失败自动把对应章节推到用户面前（ARM / 签名 / 空间…）
    openManualForError(raw, 'install-failed');
  });
  api.on('toast', (p) => toast({ title: p.message, type: p.type === 'error' ? 'error' : 'info' }));
  api.on('app:launched', () => setTimeout(refreshApps, 800));
  // 应用被关掉（托盘「关闭当前应用」、右键菜单、或窗口被关）后要刷新「运行中」标记
  api.on('apps:changed', () => setTimeout(refreshApps, 300));
  api.on('runtime:log', (m) => console.log('[runtime]', m));
  api.on('ui:navigate', (v) => {
    if (v === 'settings') openSettings();
    if (v === 'setup') { showSetup(true); refreshStatus(); }
  });
  api.on('provision:progress', (p) => updateStepProgress(p.component, p));
  api.on('update:state', (info) => {
    if (!info) return;
    renderUpdate(info);
    // 启动 8 秒后才拿到更新信息：欢迎卡若还开着，把「发现新版本」这条补进去
    const wm = $('welcomeMask');
    if (wm && !wm.hidden) renderWelcomeTips();
  });
  api.on('update:progress', (p) => renderUpdateProgress(p));
  // 自动检测：主进程定时跑完后把结果推过来，设置页开着就直接刷新面板
  api.on('autodebug:state', (r) => {
    if (r && r.running) {
      const txt = $('autodebugStateText');
      if (txt) txt.textContent = '正在检测…';
      return;
    }
    renderAutodebug(r);
  });
}

/* ---------------- 启动 ---------------- */

async function init() {
  bindEvents();
  bindSettings();
  bindSettingsCategory();
  bindAutodebug();
  bindUpdate();
  bindAndroid();
  bindWelcome();
  applyUiLanguage('en');
  state.settings = await api.getSettings();
  applyUiLanguage(state.settings && state.settings.language);
  await refreshStatus();
  await refreshApps();
  refreshAndroid();
  selfCheck();
  maybeShowWelcome();
  setInterval(refreshStatus, 6000);
  setInterval(refreshApps, 15000);
  setInterval(selfCheck, 60000);
}

/* ---------------- 启动欢迎卡 ---------------- */

let startupInfo = null;

function greetingOf(h) {
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function bindWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  const close = () => { mask.hidden = true; };
  const never = $('welcomeNever');
  $('welcomeOk').addEventListener('click', () => {
    if (never && never.checked) api.setSettings({ welcome: { disabled: true } }).catch(() => {});
    close();
  });
  $('welcomeSettings').addEventListener('click', () => { close(); openSettings(); });
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mask.hidden) close(); });
}

/** 决定要不要弹：开机自启必弹；手动打开则每天最多一次，且用户可永久关闭 */
async function maybeShowWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  // 冒烟截图时不要弹欢迎卡：否则每次自动截图都被它挡住主界面
  try { if ((await api.startupInfo()).smoke) return; } catch (_) { /* ignore */ }
  try { startupInfo = await api.startupInfo(); } catch (_) { startupInfo = null; }
  const cfg = (state.settings && state.settings.welcome) || {};
  if (cfg.disabled) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!(startupInfo && startupInfo.autostart) && cfg.lastDate === today) return;

  const h = new Date().getHours();
  $('welcomeHi').textContent = `${greetingOf(h)}，欢迎回来`;
  const ver = (startupInfo && startupInfo.version) || (state.status && state.status.version) || '';
  const ready = state.status && state.status.ready;
  $('welcomeSub').textContent = `ApkStart${ver ? ` v${ver}` : ''} · ${ready ? '运行时就绪，点开即用' : '运行时会按需自动准备'}`;

  const apps = (state.apps || []).length;
  const dev = $('statusDevice') ? $('statusDevice').textContent.trim() : '';
  const chips = [
    { k: String(apps), v: '已装应用' },
    { k: ready ? '就绪' : '待命', v: '安卓运行时' },
    { k: dev ? dev.replace(/^.*?(\d+)/, '$1') : '—', v: '设备 / 端口' },
  ];
  $('welcomeStats').innerHTML = chips
    .map((c) => `<div class="welcome-stat"><b>${esc(c.k)}</b><span>${esc(c.v)}</span></div>`)
    .join('');

  const tips = [];
  $('welcomeTips').innerHTML = '';
  mask.hidden = false;
  renderWelcomeTips();
  api.setSettings({ welcome: { lastDate: today } }).catch(() => {});
}

/** 提示区单独渲染：启动 8 秒后才拿到更新信息，那时卡片可能还开着，需要补一次 */
function renderWelcomeTips() {
  const box = $('welcomeTips');
  if (!box) return;
  const apps = (state.apps || []).length;
  const tips = [];
  if (lastUpdate && lastUpdate.hasUpdate) {
    tips.push(`发现新版本 <b>${esc(lastUpdate.tag || '')}</b>，可在「设置 → 软件更新」一键更新`);
  }
  if (!apps) {
    tips.push('把 APK 拖进窗口就能安装，装完会自动生成桌面图标');
  } else {
    tips.push('双击应用卡片即可在独立窗口中运行，右上角可旋转 / 缩放 / 关闭');
  }
  tips.push('关窗口只是退出那个应用，安卓环境会留着，下次点开更快');
  box.innerHTML = tips
    .map((t, i) => `<div class="welcome-tip"><i>${i + 1}</i><span>${t}</span></div>`)
    .join('');
}

/* ---------------- 环境自检 ---------------- */

let envBusy = false;

/** 拉取 doctor:selfCheck：把问题渲染到设置里的自检面板，并在状态条上留一个计数 */
async function selfCheck() {
  if (envBusy) return;
  envBusy = true;
  try {
    const r = await api.selfCheck().catch(() => null);
    if (r) renderEnvCheck(r);
  } catch (_) { /* 自检失败不阻断主流程 */ }
  finally { envBusy = false; }
}

function renderEnvCheck(r) {
  const box = $('envCheck');
  if (!box) return;
  // 「组件缺失」在同一个面板的一键完成里已经覆盖，不再重复列出
  const needDeploy = !!(state.status && state.status.needsSetup);
  const issues = (r.issues || []).filter((i) => !(needDeploy && i.fix === 'deploy'));

  // 主界面不再放横幅：只在底部状态条上留一个可点的计数，点开就是设置里的自检面板
  const chip = $('envChip');
  if (chip) {
    const errs = issues.filter((i) => i.severity === 'error').length;
    chip.hidden = issues.length === 0;
    chip.textContent = uiLanguage === 'en'
      ? (errs ? `${errs} ${errs === 1 ? 'issue' : 'issues'} to fix` : `${issues.length} ${issues.length === 1 ? 'notice' : 'notices'}`)
      : (errs ? `${errs} 项待修复` : `${issues.length} 项提示`);
    chip.className = `status-chip${errs ? ' err' : ''}`;
    chip.title = issues.map((i) => i.title).join('；');
  }

  if (!issues.length) {
    box.hidden = false;
    box.innerHTML = `
      <div class="env-check-ok">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
        <span>环境自检通过，没有发现会影响运行的问题。</span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" id="btnEnvRecheck">重新检查</button>
      </div>`;
    const re = $('btnEnvRecheck');
    if (re) re.addEventListener('click', selfCheck);
    return;
  }
  const errs = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errs;
  box.hidden = false;
  box.innerHTML = `
    <div class="env-check-head">
      <span class="ec-title">环境自检</span>
      ${errs ? `<span class="ec-count">${errs} 个严重</span>` : ''}
      ${warns ? `<span class="ec-count warn">${warns} 个提示</span>` : ''}
      <span class="ec-spacer"></span>
      <button class="btn ghost sm" id="btnEnvRecheck">重新检查</button>
      <button class="btn primary sm" id="btnEnvFixAll">一键修复全部</button>
    </div>
    <div class="env-check-list">
      ${issues.map((i) => `
        <div class="env-check-item ${i.severity}">
          <span class="ec-sev"></span>
          <div class="ec-body">
            <div class="ec-name">${esc(i.title)}</div>
            <div class="ec-hint">${esc(i.hint || '')}</div>
          </div>
          ${i.fix ? `<button class="ec-fix" data-code="${esc(i.code)}">修复</button>` : ''}
          <button class="ec-help" data-code="${esc(i.code)}" title="打开内置教程">教程</button>
        </div>`).join('')}
    </div>`;
  const re = $('btnEnvRecheck');
  if (re) re.addEventListener('click', selfCheck);
  const fixAll = $('btnEnvFixAll');
  if (fixAll) fixAll.addEventListener('click', () => fixAllIssues(issues));
  box.querySelectorAll('.ec-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });
  box.querySelectorAll('.ec-help').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) openManualForIssue(issue, 'clicked');
    });
  });
}

/** 修复没成功：如实报错，并把对应教程自动打开（同一章节主进程 60 秒内只弹一次） */
function failFix(issue, ctl, body) {
  const msg = body || '请按教程手动处理';
  if (ctl && typeof ctl.update === 'function') ctl.update({ body: msg, type: 'error', sticky: true });
  else toast({ title: '修复未完成', body: msg, type: 'error' });
  openManualForIssue(issue, 'fix-failed');
}

async function fixIssue(issue) {
  switch (issue.fix) {
    case 'vcRedist': {
      const r = await api.installVcRedist().catch(() => ({ ok: false }));
      if (!r.ok && r.reason === 'no-installer') {
        api.openExternal('https://learn.microsoft.com/zh-CN/cpp/windows/latest-supported-vc-redist?view=msvc-170#visual-studio-2015-2017-2019-and-2022');
        toast({ title: '未找到内置安装包', body: '已打开微软官方下载页，请下载 x64 版本', type: 'info' });
        break;
      }
      toast(r.ok
        ? { title: 'VC++ 运行库已安装', type: 'ok' }
        : { title: '安装未完成', body: r.error || '请重试', type: 'error' });
      break;
    }
    case 'virtualization': {
      const t = toast({ title: '正在开启硬件加速…', body: '请在弹出的窗口点「是」', sticky: true, spinner: true });
      const r = await api.enableVirtualization().catch(() => ({ ok: false }));
      if (r.ok) {
        t.update({ title: '硬件加速已启用', body: r.restartNeeded ? '请重启电脑以获得最佳性能' : (r.note || ''), type: 'ok' });
        setTimeout(t.dismiss, 3200);
      } else if (r.manual) {
        // 商店（MSIX）版：包固定 mediumIL，通常拿不到管理员授权。
        // 与其让用户点一个注定失败的按钮，不如直接把「启用或关闭 Windows 功能」
        // 对话框弹出来，并告诉他勾哪一项。
        t.dismiss();
        await api.openWindowsFeatures?.().catch(() => null);
        toast({
          title: '需要手动开启一次（仅此一次）',
          body: r.note || '在打开的窗口里勾选「Windows 虚拟机监控程序平台」，确定后重启电脑。',
          type: 'info',
          sticky: true,
        });
        // 自动提权走不通时，同步把图文教程打开，避免用户对着系统窗口不知道勾哪个
        openManualForIssue(issue, 'fix-failed');
      } else if (r.cancelled) {
        t.update({ title: '已取消', body: r.error || '没有拿到管理员授权，硬件加速没有改动。', type: 'info', spinner: false });
        setTimeout(t.dismiss, 4200);
      } else {
        failFix(issue, t, r.error || r.note || '未能开启硬件加速，已打开对应教程');
      }
      break;
    }
    case 'disk': {
      // 主进程会弹出原生确认框（含可释放空间预览），这里不再重复 confirm
      const r = await api.runtimeCleanup({ apply: true }).catch(() => null);
      if (!r) { toast({ title: '清理失败', body: '请重试', type: 'error' }); break; }
      if (r.cancelled) break;
      toast({ title: '清理完成', body: `释放约 ${((r.saved || 0) / 1048576).toFixed(0)} MB`, type: 'ok' });
      break;
    }
    case 'path': {
      toast({ title: '建议改到纯英文目录', body: '在 设置 → 系统集成 里修改「运行时数据目录」，再重启软件。', type: 'info', sticky: true });
      openSettings();
      break;
    }
    case 'deploy': {
      toast({ title: '正在补齐缺失的运行时组件…', type: 'info', sticky: true, spinner: true });
      await deployAll();
      break;
    }
    case 'lock': {
      const r = await api.clearLocks().catch(() => ({ ok: false }));
      toast(r.ok ? { title: '已清理残留锁文件', type: 'ok' } : { title: '清理失败', body: r.error, type: 'error' });
      break;
    }
    // ---- 自动检测（自动 debug）新增的修复动作 ----
    case 'restartRuntime': {
      // unauthorized / 引导卡死 / 孤儿锁的首选自愈动作：停一次再拉起来（走冷启动）
      const t = toast({ title: '正在重启安卓运行时…', body: '会重新引导一次，大约十几秒', type: 'info', sticky: true, spinner: true });
      const r = await api.restartRuntime().catch(() => ({ ok: false }));
      if (r && r.ok) {
        t.update({ title: '安卓运行时已重启', body: '授权弹窗请点「允许」', type: 'ok' });
        setTimeout(t.dismiss, 3000);
      } else {
        failFix(issue, t, (r && r.error) || '重启失败，已打开对应教程');
      }
      break;
    }
    case 'orphans': {
      const r = await api.clearOrphans().catch(() => ({ ok: false }));
      toast(r && r.ok
        ? { title: '已清理残留的模拟器进程', type: 'ok' }
        : { title: '清理失败', body: (r && r.error) || '请重试', type: 'error' });
      break;
    }
    case 'snapshots': {
      const r = await api.clearSnapshot().catch(() => ({ ok: false }));
      toast(r && r.ok
        ? { title: '已作废快速启动快照', body: '下次打开应用会走一次完整冷启动', type: 'ok' }
        : { title: '作废失败', body: (r && r.error) || '请重试', type: 'error' });
      break;
    }
    case 'dataReset': {
      // 扩容被差量盘挡住时必须重建：会清掉已装应用，所以只引导、不自动做。
      toast({
        title: '需要重建安卓数据分区',
        body: '到「设置 → 性能与资源」点「立即扩容」；提示需要重置时确认一次（会清空已装应用）。',
        type: 'info',
        sticky: true,
      });
      openSettings().then(() => focusGroup($('perfGroup'))).catch(() => {});
      break;
    }
    case 'orientation': {
      // 让物理面板方向跟上策略：策略要横屏就切横屏，要竖屏就切竖屏
      const s = (state.settings && state.settings.display) || {};
      const mode = s.orientationMode || 'auto';
      if (mode === 'auto') {
        toast({ title: '当前是「跟随应用」', body: '面板方向会按应用自动切换；若某个应用方向不对，可对它单独指定。', type: 'info' });
        break;
      }
      const wantLandscape = mode === 'landscape';
      state.settings = await api.setSettings({ display: { landscape: wantLandscape } });
      fillSettings(state.settings);
      toast({
        title: wantLandscape ? '面板已切成横屏' : '面板已切成竖屏',
        body: '下次打开应用生效',
        type: 'ok',
      });
      break;
    }
    case 'shared': {
      toast({ title: '请检查共享目录', body: '到「设置 → 集成与文件」确认本机共享目录存在且可写。', type: 'info', sticky: true });
      openSettings().then(() => focusGroup(document.querySelector('#settingsBody [data-cat="files"]'))).catch(() => {});
      break;
    }
    // ---- 0.6.2 声音检测对应的修复动作 ----
    case 'audio': {
      const t = toast({ title: '正在打开安卓应用声音…', body: '马上重启运行时让 -no-audio 失效', type: 'info', sticky: true, spinner: true });
      const s = await api.setSettings({ engine: { audio: true } }).catch(() => null);
      if (!s) { failFix(issue, t, '没能保存声音设置，已打开对应教程'); break; }
      state.settings = s;
      fillSettings(s);
      const r = await api.restartRuntime().catch(() => ({ ok: false }));
      if (r && r.ok !== false) {
        t.update({ title: '声音已打开', body: '运行时已重启，现在应该能听到应用声音了', type: 'ok' });
        setTimeout(t.dismiss, 3600);
      } else {
        failFix(issue, t, '声音开关已打开，但运行时重启失败，已打开对应教程');
      }
      break;
    }
    case 'audioService': {
      // MSIX / 普通权限都拿不到系统服务的提权操作，直接把教程送到用户面前
      toast({ title: '需要手动启动 Windows Audio', body: '已打开教程，照着做一次即可', type: 'info', sticky: true });
      openManualForIssue(issue, 'clicked');
      break;
    }
    case 'microphone': {
      const t = toast({ title: '正在打开麦克风输入…', body: '马上重启运行时让录音设备生效', type: 'info', sticky: true, spinner: true });
      const s = await api.setSettings({ engine: { microphone: true } }).catch(() => null);
      if (!s) { failFix(issue, t, '没能保存麦克风设置，已打开对应教程'); break; }
      state.settings = s;
      fillSettings(s);
      const r = await api.restartRuntime().catch(() => ({ ok: false }));
      if (r && r.ok !== false) {
        t.update({ title: '麦克风已打开', body: '运行时已重启，应用现在应该能录音了', type: 'ok' });
        setTimeout(t.dismiss, 3600);
      } else {
        failFix(issue, t, '麦克风开关已打开，但运行时重启失败，已打开对应教程');
      }
      break;
    }
    case 'repairNetwork': {
      const t = toast({ title: '正在重置安卓网络…', body: '应用清单会保留', type: 'info', sticky: true, spinner: true });
      const r = await api.runtimeRepairNetwork().catch(() => ({ ok: false }));
      if (r && r.ok !== false) {
        t.update({ title: '安卓网络已重置', body: '下次打开应用重新联网', type: 'ok' });
        setTimeout(t.dismiss, 3000);
      } else {
        t.update({ title: '重置失败', body: (r && r.error) || '请重试', type: 'error' });
      }
      break;
    }
    case 'report': {
      const r = await api.doctorReport().catch(() => null);
      toast(r && r.ok !== false
        ? { title: '诊断报告已导出', body: '把报告发给作者可以最快定位问题', type: 'ok' }
        : { title: '导出失败', body: (r && r.error) || '请重试', type: 'error' });
      break;
    }
    case 'settings': {
      openSettings();
      break;
    }
    default:
      toast({ title: '暂不支持自动修复', body: issue.hint || '', type: 'info' });
  }
  // 修复后重新自检，刷新横幅与状态
  setTimeout(selfCheck, 600);
  setTimeout(refreshStatus, 600);
}

async function fixAllIssues(issues) {
  const fixable = issues.filter((i) => i.fix);
  for (const i of fixable) {
    // eslint-disable-next-line no-await-in-loop
    await fixIssue(i);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 500));
  }
}

init().catch((e) => {
  console.error(e);
  toast({ title: '初始化失败', body: e.message, type: 'error', sticky: true });
});
