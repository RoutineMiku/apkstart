'use strict';
/**
 * ApkStart i18n Internationalization Engine
 * Supports: English ('en') and Simplified Chinese ('zh-CN').
 * Works in both Node.js (main process) and Browser (renderer UI).
 */

const DICT = {
  'en': {
    // Brand & Titlebar
    'brand.name': 'ApkStart',
    'brand.tagline': 'Android App Runner for Windows',
    'brand.not_connected': 'Runtime Not Connected',
    'brand.connected': 'Runtime Ready',
    'titlebar.manual': 'User Manual & Troubleshooting',
    'titlebar.settings': 'Settings',

    // Toolbar & Search
    'toolbar.search_placeholder': 'Search installed apps...',
    'toolbar.install_apk': 'Install APK',

    // Empty State
    'empty.title': 'Drop APK here to install',
    'empty.desc': 'Desktop shortcut will be created upon installation. Double-click to launch in a standalone window, just like native Windows software.<br/>When .apk association is registered, double-clicking any APK in File Explorer installs it directly.',
    'empty.select_file': 'Select APK File',

    // Dropzone
    'dropzone.title': 'Release to Install',
    'dropzone.sub': 'Supports single or multiple .apk files',

    // Statusbar
    'status.checking': 'Checking runtime...',
    'status.ready': 'Ready',
    'status.not_running': 'Not running',
    'status.running': 'Running',
    'status.online': 'Online',
    'status.offline': 'Offline',
    'status.port': 'Port',
    'status.idle': 'Idle',

    // App Context Menu
    'ctx.launch': 'Launch App',
    'ctx.open_in_explorer': 'Show in Explorer',
    'ctx.recreate_shortcut': 'Recreate Desktop Shortcut',
    'ctx.pin': 'Pin to Top',
    'ctx.unpin': 'Unpin from Top',
    'ctx.orientation': 'Screen Orientation',
    'ctx.orient_auto': 'Auto (Follow Manifest)',
    'ctx.orient_portrait': 'Force Portrait',
    'ctx.orient_landscape': 'Force Landscape',
    'ctx.clear_data': 'Clear App Data',
    'ctx.uninstall': 'Uninstall',
    'ctx.details': 'App Details',
    'ctx.uninstall_confirm': 'Are you sure you want to uninstall {name}? App data will be deleted.',

    // Welcome Dialog
    'welcome.hi': 'Hello',
    'welcome.sub': 'ApkStart is ready to use',
    'welcome.never': "Don't show automatically on next startup",
    'welcome.settings': 'Open Settings',
    'welcome.ok': 'Get Started',

    // Settings Navigation
    'nav.basic': 'General & Setup',
    'nav.display': 'Display & Window',
    'nav.input': 'Controls & Input',
    'nav.perf': 'Performance & Resources',
    'nav.net': 'Network & Downloads',
    'nav.diag': 'Diagnostics & Repair',
    'nav.files': 'Integration & Files',
    'nav.about': 'About & Updates',
    'nav.lab': 'Laboratory',

    // Settings Header & Footer
    'settings.title': 'Settings',
    'settings.search_placeholder': 'Search settings: orientation / memory / proxy / snapshot...',
    'settings.clear_search': 'Clear search',
    'settings.save_note': 'Changes take effect immediately',
    'settings.done': 'Done',

    // Settings - Language
    'settings.lang_group': 'Interface Language',
    'settings.lang_label': 'Display Language',
    'settings.lang_sub': 'Choose the display language for ApkStart. Takes effect immediately.',
    'settings.lang_auto': 'Follow System (Auto)',
    'settings.lang_en': 'English',
    'settings.lang_zh': '简体中文 (Simplified Chinese)',

    // Settings - Basic
    'settings.runtime_env': 'Runtime & Environment',
    'settings.run_status': 'Status',
    'settings.one_click_deploy': 'One-Click Setup',
    'settings.advanced_connect': 'Advanced: Connect Existing',
    'settings.auto_mode_title': 'Automatic Configuration (Default)',
    'settings.auto_mode_sub': 'Adaptive Host Settings',
    'settings.auto_mode_desc': 'Memory, CPU cores, graphics backend, port, and virtualization acceleration are configured automatically with self-healing fallback.',

    // Settings - Display
    'settings.window_group': 'Application Window',
    'settings.display_mode': 'Display Mode',
    'settings.mode_window': 'Windowed (Resizable, remembers window bounds per app)',
    'settings.mode_fullscreen': 'Full Screen (Padded & centered)',
    'settings.orientation': 'Screen Orientation',
    'settings.window_size': 'Window Size (Portrait)',
    'settings.tablet_layout': 'Tablet Layout (sw606dp)',
    'settings.tablet_sub': 'Simulates tablet width for dual-column and responsive layouts in supported apps.',

    // Settings - Input
    'settings.mouse_group': 'Mouse Controls',
    'settings.mouse_left': 'Left Click · Tap / Confirm',
    'settings.mouse_left_sub': 'Native tap and drag gesture emulation.',
    'settings.mouse_right_back': 'Right Click · Back Button',
    'settings.mouse_right_sub': 'Maps right click to Android system Back button.',
    'settings.mouse_wheel_smooth': 'Smooth Mouse Wheel',
    'settings.mouse_wheel_sub': 'Converts scroll wheel ticks into smooth Android touch fling gestures.',
    'settings.keymap_group': 'Keymapping (Game Controls)',
    'settings.keymap_enable': 'Enable Keyboard Mapping',
    'settings.keymap_sub': 'Map keyboard keys to touchscreen locations (WASD movement, skill hotkeys).',

    // Settings - Performance
    'settings.perf_group': 'Performance & Resource Allocation',
    'settings.resource_mode': 'Resource Mode',
    'settings.res_save': 'Power Saver · 2 cores / Low priority / 540p',
    'settings.res_balanced': 'Balanced · Auto cores & RAM / 720p (Recommended)',
    'settings.res_performance': 'High Performance · Max cores & RAM / Native resolution',
    'settings.hardware_accel': 'Hardware Acceleration (WHPX / AEHD)',
    'settings.quickboot': 'Quickboot Snapshot (Fast boot in ~3s)',

    // Settings - Network
    'settings.net_group': 'Download & Update Sources',
    'settings.net_source': 'Source Preference',
    'settings.net_auto': 'Auto (Speed test and pick fastest)',
    'settings.fast_dns': 'Fast DNS Resolution',

    // Settings - Audio
    'settings.audio_group': 'Sound & Microphone',
    'settings.audio_enable': 'Enable Audio Output',
    'settings.mic_enable': 'Enable Microphone Input',

    // Settings - Diagnostics
    'settings.diag_group': 'Diagnostics & Repair',
    'settings.preflight_title': 'System Preflight & Auto-Config',
    'settings.autodebug_title': 'Smart Diagnostic Health Check',
    'settings.export_report': 'Export Diagnostic Report',
    'settings.repair_network': 'Repair Android Network',
    'settings.clear_snapshot': 'Reset Snapshot Cache',

    // Settings - Files & Desktop
    'settings.desktop_group': 'Desktop & System Integration',
    'settings.create_desktop_shortcut': 'Create Desktop Shortcut on Install',
    'settings.create_start_shortcut': 'Create Start Menu Shortcut on Install',
    'settings.shared_dir': 'PC Shared Folder (%USERPROFILE%\\ApkStartShared)',
    'settings.assoc_apk': 'Register .apk File Association',
    'settings.autostart': 'Launch on Windows Startup',

    // Settings - About & Updates
    'settings.about_title': 'About ApkStart',
    'settings.version': 'Version',
    'settings.check_updates': 'Check for Updates',
    'settings.checking_update': 'Checking for updates...',
    'settings.up_to_date': 'You are using the latest version.',
    'settings.update_available': 'New version available: {ver}',
    'settings.open_data_dir': 'Open Data Directory',
    'settings.open_manual': 'Open User Manual',

    // Settings - Lab
    'settings.lab_title': 'Laboratory',
    'settings.multi_window': 'Multi-Window Mode (Experimental)',
    'settings.multi_window_sub': 'Allow multiple Android apps to run simultaneously in separate windows.',

    // Tray Menu
    'tray.open': 'Open ApkStart',
    'tray.check_update': 'Check for Updates',
    'tray.data_dir': 'Open Data Directory',
    'tray.shared_dir': 'Open Shared Folder',
    'tray.manual': 'User Manual',
    'tray.settings': 'Settings',
    'tray.quit': 'Exit',

    // Shell Window Controls
    'shell.rotate': 'Rotate Screen (Ctrl+R)',
    'shell.min': 'Minimize',
    'shell.max': 'Maximize',
    'shell.close': 'Close',
    'shell.booting': 'Starting Android runtime...',

    // Splash Window
    'splash.preparing': 'Preparing runtime...',
    'splash.first_run_title': 'First Run · Auto-Configuring',
    'splash.step1': 'Download Android runtime engine (~200MB, one-time)',
    'splash.step2': 'Download system image (~1.5GB, one-time)',
    'splash.step3': 'Configure hardware acceleration & networking',
    'splash.step4': 'Ready to double-click APKs or desktop shortcuts',

    // Notifications & Toasts
    'toast.installed': 'Installed successfully: {name}',
    'toast.install_failed': 'Installation failed: {error}',
    'toast.installing': 'Installing {name}...',
    'toast.data_cleared': 'Data cleared for {name}',
    'toast.uninstalled': 'Uninstalled {name}',
    'toast.shortcut_created': 'Shortcut created on desktop',
    'toast.saved': 'Settings saved'
  },

  'zh-CN': {
    // 品牌与标题栏
    'brand.name': 'ApkStart',
    'brand.tagline': 'Windows 上的安卓应用运行器',
    'brand.not_connected': '未连接运行时',
    'brand.connected': '运行时就绪',
    'titlebar.manual': '使用手册（含故障解决方案）',
    'titlebar.settings': '设置',

    // 工具栏与搜索
    'toolbar.search_placeholder': '搜索已安装应用',
    'toolbar.install_apk': '安装 APK',

    // 空状态
    'empty.title': '把 APK 拖进来就能装',
    'empty.desc': '安装完成后会自动生成桌面图标，双击即以独立窗口运行，和普通 Windows 软件一样。<br/>已注册 .apk 关联时，在资源管理器里双击 APK 也会直接装到 ApkStart。',
    'empty.select_file': '选择 APK 文件',

    // 拖放区域
    'dropzone.title': '松手开始安装',
    'dropzone.sub': '支持单个或多个 .apk 文件',

    // 状态栏
    'status.checking': '正在检查运行时…',
    'status.ready': '已就绪',
    'status.not_running': '未运行',
    'status.running': '运行中',
    'status.online': '在线',
    'status.offline': '未联网',
    'status.port': '端口',
    'status.idle': '空闲',

    // 右键菜单
    'ctx.launch': '启动应用',
    'ctx.open_in_explorer': '在资源管理器中显示',
    'ctx.recreate_shortcut': '重新创建桌面快捷方式',
    'ctx.pin': '置顶应用',
    'ctx.unpin': '取消置顶',
    'ctx.orientation': '屏幕方向',
    'ctx.orient_auto': '自动（跟随 APK 清单）',
    'ctx.orient_portrait': '强制竖屏',
    'ctx.orient_landscape': '强制横屏',
    'ctx.clear_data': '清除应用数据',
    'ctx.uninstall': '卸载',
    'ctx.details': '应用详情',
    'ctx.uninstall_confirm': '确定要卸载 {name} 吗？应用数据将被清空。',

    // 启动欢迎
    'welcome.hi': '你好',
    'welcome.sub': 'ApkStart 已就绪',
    'welcome.never': '下次启动不再自动弹出',
    'welcome.settings': '打开设置',
    'welcome.ok': '开始使用',

    // 设置分类导航
    'nav.basic': '常用与安装',
    'nav.display': '显示与窗口',
    'nav.input': '操作与输入',
    'nav.perf': '性能与资源',
    'nav.net': '网络与下载',
    'nav.diag': '诊断与修复',
    'nav.files': '集成与文件',
    'nav.about': '更新与关于',
    'nav.lab': '实验室',

    // 设置头部与底部
    'settings.title': '设置',
    'settings.search_placeholder': '搜索设置项：横屏 / 内存 / 代理 / 快照…',
    'settings.clear_search': '清除搜索',
    'settings.save_note': '设置修改后立即生效',
    'settings.done': '完成',

    // 语言设置
    'settings.lang_group': '界面语言 / Language',
    'settings.lang_label': '显示语言',
    'settings.lang_sub': '选择 ApkStart 的界面显示语言，修改后立即生效。',
    'settings.lang_auto': '跟随系统 / Follow System (Auto)',
    'settings.lang_en': 'English',
    'settings.lang_zh': '简体中文 (Simplified Chinese)',

    // 常规
    'settings.runtime_env': '运行时与环境',
    'settings.run_status': '运行状态',
    'settings.one_click_deploy': '一键完成',
    'settings.advanced_connect': '高级：连接已有运行时',
    'settings.auto_mode_title': '自动模式（默认，无需设置）',
    'settings.auto_mode_sub': '本机自适应参数',
    'settings.auto_mode_desc': '内存、核心数、渲染后端、端口、加速方式全部自动选择；启动失败会自动降级重试，不需要手动改。',

    // 显示
    'settings.window_group': '应用窗口',
    'settings.display_mode': '显示模式',
    'settings.mode_window': '竖屏窗口（可自由拉伸，记住每个应用的大小）',
    'settings.mode_fullscreen': '全屏模式（铺满屏幕高度并居中）',
    'settings.orientation': '屏幕方向',
    'settings.window_size': '窗口大小（竖屏）',
    'settings.tablet_layout': '平板排版（sw606dp）',
    'settings.tablet_sub': '模拟平板宽度以激活支持应用的双列与平板排版。',

    // 输入
    'settings.mouse_group': '鼠标键位',
    'settings.mouse_left': '左键 · 确认 / 点击',
    'settings.mouse_left_sub': '模拟器原生把左键当成手指点击，按住拖动就是滑动，无需额外设置。',
    'settings.mouse_right_back': '右键 · 返回上一页',
    'settings.mouse_right_sub': '映射鼠标右键为安卓系统返回键。',
    'settings.mouse_wheel_smooth': '平滑滚轮',
    'settings.mouse_wheel_sub': '合并滚轮刻度为单次顺滑触摸滑动。',
    'settings.keymap_group': '键盘映射（游戏手柄）',
    'settings.keymap_enable': '启用键盘映射',
    'settings.keymap_sub': '把键盘按键映射成安卓触屏点击/滑动。适合用键盘玩手游（WASD 移动、J/K 技能等）。',

    // 性能
    'settings.perf_group': '性能与资源占用',
    'settings.resource_mode': '资源策略',
    'settings.res_save': '省资源 · 2 核 / 让出前台 / 540p（老机器、挂机）',
    'settings.res_balanced': '均衡 · 自动核心与内存 / 720p（推荐）',
    'settings.res_performance': '流畅 · 最大核心与内存 / 原生画质',
    'settings.hardware_accel': '硬件加速（WHPX / AEHD）',
    'settings.quickboot': 'Quickboot 快速启动快照（约 3 秒秒开）',

    // 网络
    'settings.net_group': '下载与更新源',
    'settings.net_source': '更新与下载源',
    'settings.net_auto': '自动选择较快的源（推荐）',
    'settings.fast_dns': '公共加速 DNS',

    // 声音
    'settings.audio_group': '声音与麦克风',
    'settings.audio_enable': '启用声音输出',
    'settings.mic_enable': '启用麦克风输入',

    // 诊断
    'settings.diag_group': '诊断与修复',
    'settings.preflight_title': '本机体检 · 自动配置',
    'settings.autodebug_title': '自动检测 · 智能诊断',
    'settings.export_report': '导出诊断报告',
    'settings.repair_network': '一键修复安卓网络',
    'settings.clear_snapshot': '清空快照缓存',

    // 文件与桌面
    'settings.desktop_group': '桌面与系统集成',
    'settings.create_desktop_shortcut': '安装后自动创建桌面快捷方式',
    'settings.create_start_shortcut': '安装后自动创建开始菜单快捷方式',
    'settings.shared_dir': '本机共享目录（%USERPROFILE%\\ApkStartShared）',
    'settings.assoc_apk': '关联 .apk 文件',
    'settings.autostart': '开机自动启动',

    // 关于与更新
    'settings.about_title': '关于 ApkStart',
    'settings.version': '当前版本',
    'settings.check_updates': '检查更新',
    'settings.checking_update': '正在检查更新…',
    'settings.up_to_date': '当前已是最新版本',
    'settings.update_available': '发现新版本：{ver}',
    'settings.open_data_dir': '打开数据目录',
    'settings.open_manual': '打开使用手册',

    // 实验室
    'settings.lab_title': '实验室',
    'settings.multi_window': '多窗口模式（实验性）',
    'settings.multi_window_sub': '允许同时打开多个应用、各自独立窗口。',

    // 托盘菜单
    'tray.open': '打开主界面',
    'tray.check_update': '检查更新',
    'tray.data_dir': '打开数据目录',
    'tray.shared_dir': '打开共享文件夹',
    'tray.manual': '使用手册',
    'tray.settings': '设置',
    'tray.quit': '退出',

    // 壳窗口
    'shell.rotate': '横屏 / 竖屏（Ctrl+R）',
    'shell.min': '最小化',
    'shell.max': '最大化',
    'shell.close': '关闭',
    'shell.booting': '正在启动安卓运行时…',

    // Splash 窗口
    'splash.preparing': '正在准备…',
    'splash.first_run_title': '首次使用 · 自动配置中',
    'splash.step1': '下载 Android 运行时引擎（约 200MB，只需一次）',
    'splash.step2': '下载系统镜像（约 1.5GB，只需一次）',
    'splash.step3': '配置硬件加速与网络',
    'splash.step4': '完成后即可双击 APK 或桌面图标秒开应用',

    // 通知与气泡
    'toast.installed': '安装成功：{name}',
    'toast.install_failed': '安装失败：{error}',
    'toast.installing': '正在安装 {name}…',
    'toast.data_cleared': '已清除应用数据：{name}',
    'toast.uninstalled': '已卸载 {name}',
    'toast.shortcut_created': '已在桌面生成快捷方式',
    'toast.saved': '设置已保存'
  }
};

let currentLocale = 'en';

function detectSystemLocale() {
  try {
    if (typeof navigator !== 'undefined' && navigator.language) {
      return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
    }
  } catch (_) {}
  try {
    const env = process.env.LANG || process.env.LANGUAGE || process.env.LC_ALL || '';
    if (env.toLowerCase().includes('zh')) return 'zh-CN';
  } catch (_) {}
  return 'en';
}

function setLocale(lang) {
  if (lang === 'auto' || !lang) {
    currentLocale = detectSystemLocale();
  } else if (DICT[lang]) {
    currentLocale = lang;
  }
  return currentLocale;
}

function getLocale() {
  return currentLocale;
}

function t(key, params = {}) {
  const table = DICT[currentLocale] || DICT['en'];
  let text = table[key] !== undefined ? table[key] : (DICT['en'][key] || key);
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
  }
  return text;
}

/**
 * Apply translations to DOM elements with data-i18n attributes.
 */
function applyToDOM(root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;

  // text content
  const elements = doc.querySelectorAll('[data-i18n]');
  for (const el of elements) {
    const key = el.getAttribute('data-i18n');
    if (key) el.innerHTML = t(key);
  }

  // placeholder
  const placeholders = doc.querySelectorAll('[data-i18n-placeholder]');
  for (const el of placeholders) {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.placeholder = t(key);
  }

  // title
  const titles = doc.querySelectorAll('[data-i18n-title]');
  for (const el of titles) {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.title = t(key);
  }

  // html lang attribute
  if (doc.documentElement) {
    doc.documentElement.lang = currentLocale;
  }
}

const i18n = {
  DICT,
  setLocale,
  getLocale,
  detectSystemLocale,
  t,
  applyToDOM
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = i18n;
}
if (typeof window !== 'undefined') {
  window.i18n = i18n;
}
