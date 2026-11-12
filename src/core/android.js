'use strict';
/**
 * 安卓系统设置：不需要进安卓桌面，也不用装第三方工具，
 * 直接通过 adb 把常用的系统开关做成 ApkStart 设置页里的按钮。
 * 所有命令都是官方 shell 接口，不依赖 root。
 */
const ACTIONS = {
  settings: 'android.settings.SETTINGS',
  wifi: 'android.settings.WIFI_SETTINGS',
  display: 'android.settings.DISPLAY_SETTINGS',
  sound: 'android.settings.SOUND_SETTINGS',
  locale: 'android.settings.LOCALE_SETTINGS',
  date: 'android.settings.DATE_SETTINGS',
  apps: 'android.settings.APPLICATION_SETTINGS',
  storage: 'android.settings.INTERNAL_STORAGE_SETTINGS',
  battery: 'android.settings.BATTERY_SAVER_SETTINGS',
  cast: 'android.settings.CAST_SETTINGS',
  dev: 'android.settings.APPLICATION_DEVELOPMENT_SETTINGS',
};

class AndroidSettings {
  constructor(runtime) { this.runtime = runtime; }

  async client() {
    const rt = await this.runtime.ensure();
    if (!rt.ok) throw new Error(rt.error || '运行时未就绪');
    return rt.client;
  }

  async _sh(commands) {
    const c = await this.client();
    const script = commands.map((x) => `${x}; `).join('');
    return c.shell(script, { timeout: 20000 });
  }

  /** 读一批当前状态，供设置页显示 */
  async status() {
    const out = await this._sh([
      'echo "wifi=$(settings get global wifi_on)"',
      'echo "air=$(settings get global airplane_mode_on)"',
      'echo "font=$(settings get system font_scale)"',
      'echo "density=$(wm density | tail -n1 | tr -dc \'0-9\')"',
      'echo "animw=$(settings get global window_animation_scale)"',
      'echo "sdk=$(getprop ro.build.version.sdk)"',
      'echo "vol=$(dumpsys audio | grep -m1 -A3 STREAM_MUSIC | grep -o \'streamVolume:[0-9]*\' | head -1 | cut -d: -f2)"',
    ]);
    const get = (k) => {
      const m = new RegExp(`${k}=([^\\r\\n]*)`).exec(String(out));
      return m ? m[1].trim() : '';
    };
    const anim = get('animw');
    return {
      wifi: get('wifi') === '1',
      airplane: get('air') === '1',
      fontScale: Number(get('font')) || 1,
      density: Number(get('density')) || 0,
      volume: Number(get('vol')) || 0,
      animationsOff: anim === '0.0' || anim === '0',
      sdk: Number(get('sdk')) || 0,
    };
  }

  async setWifi(on) {
    await this._sh([`svc wifi ${on ? 'enable' : 'disable'}`]);
    return { ok: true };
  }

  async setAirplane(on) {
    const v = on ? 1 : 0;
    await this._sh([
      `settings put global airplane_mode_on ${v}`,
      `am broadcast -a android.intent.action.AIRPLANE_MODE --ez state ${on ? 'true' : 'false'}`,
      `svc wifi ${on ? 'disable' : 'enable'}`,
      `svc data ${on ? 'disable' : 'enable'}`,
    ]);
    return { ok: true };
  }

  async setVolume(percent) {
    const v = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    await this._sh([`media volume --stream 3 --set ${v}`]);
    return { ok: true, volume: v };
  }

  /** 关闭系统动画 = 明显的「变快」体感，且几乎不损失功能 */
  async setAnimations(on) {
    const v = on ? '1' : '0';
    await this._sh([
      `settings put global window_animation_scale ${v}`,
      `settings put global transition_animation_scale ${v}`,
      `settings put global animator_duration_scale ${v}`,
    ]);
    return { ok: true, animationsOff: !on };
  }

  async setFontScale(scale) {
    const v = Math.max(0.85, Math.min(1.3, Number(scale) || 1)).toFixed(2);
    await this._sh([`settings put system font_scale ${v}`]);
    return { ok: true, fontScale: Number(v) };
  }

  /** 显示大小：改 dpi，越大内容越大（相当于系统「显示大小」档位） */
  async setDensity(dpi) {
    const v = Math.max(120, Math.min(640, Math.round(Number(dpi) || 0)));
    if (!v) return { ok: false };
    await this._sh([`wm density ${v}`]);
    return { ok: true, density: v };
  }

  /** 一键整理：关动画 + 关遥测类服务 + 电池白名单，让应用更跟手 */
  async tune({ pkg } = {}) {
    const cmds = [
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put global activity_manager_constants max_cached_processes=32',
    ];
    if (pkg) cmds.push(`dumpsys deviceidle whitelist +${pkg}`);
    await this._sh(cmds);
    return { ok: true };
  }

  async open(action) {
    const a = ACTIONS[action] || ACTIONS.settings;
    const c = await this.client();
    await c.shell(`am start -a ${a}`, { timeout: 15000 });
    return { ok: true };
  }

  /** 应用运行时权限一览 + 授权 */
  async permissions(pkg) {
    const c = await this.client();
    const dump = await c.shell(`dumpsys package ${pkg}`, { timeout: 20000 });
    const lines = String(dump).split(/\r?\n/);
    let inRuntime = false;
    const rows = [];
    for (const line of lines) {
      if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
      if (!inRuntime) continue;
      if (/^\s{0,6}\S/.test(line)) break;
      const m = /^\s+([A-Za-z0-9_.]+):\s*granted=(\w+)/.exec(line);
      if (m) rows.push({ name: m[1], granted: m[2] === 'true' });
    }
    return rows;
  }

  async grantAll(pkg) {
    const c = await this.client();
    const rows = await this.permissions(pkg);
    const denied = rows.filter((r) => !r.granted).map((r) => r.name);
    for (const p of denied) {
      // eslint-disable-next-line no-await-in-loop
      await c.shell(`pm grant ${pkg} ${p}`, { timeout: 8000 }).catch(() => {});
    }
    return { ok: true, granted: denied.length };
  }
}

module.exports = { AndroidSettings, ACTIONS };
