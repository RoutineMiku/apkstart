'use strict';
/**
 * 本机 ↔ 安卓 的共享目录双向同步
 *
 * 没有 root 的情况下无法真正「挂载」目录，所以采用增量同步：
 * 任何一侧新增/修改的文件都会在几秒内同步到另一侧，语义上等价于共享文件夹。
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');

const MAX_FILE = 512 * 1024 * 1024; // 单文件 512MB 上限

function walk(dir, base = dir, out = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    if (it.name.startsWith('.')) continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) walk(full, base, out);
    else if (it.isFile()) {
      try {
        const st = fs.statSync(full);
        if (st.size <= MAX_FILE) {
          out.push({ abs: full, rel: path.relative(base, full).split(path.sep).join('/'), mtime: st.mtimeMs, size: st.size });
        }
      } catch (_) { /* ignore */ }
    }
  }
  return out;
}

class Sharer {
  constructor(runtime) {
    this.runtime = runtime;
    this.stateFile = path.join(store.DATA_DIR, 'shared-state.json');
    this._busy = false;
    this._timer = null;
    this._lastError = '';
  }

  get localDir() { return store.getSettings().sharedDir; }
  get remoteDir() { return store.getSettings().deviceSharedDir; }

  loadState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (_) { return {}; }
  }

  saveState(s) {
    try { fs.writeFileSync(this.stateFile, JSON.stringify(s, null, 2)); } catch (_) { /* ignore */ }
  }

  async ensureDirs(onLog = () => {}) {
    if (!fs.existsSync(this.localDir)) fs.mkdirSync(this.localDir, { recursive: true });
    const client = this.runtime.client();
    if (!(await client.isOnline())) return false;
    await client.shellMkdir(this.remoteDir);
    return true;
  }

  async sync({ onLog = () => {} } = {}) {
    if (this._busy) return { skipped: true };
    this._busy = true;
    const result = { pushed: 0, pulled: 0, errors: [] };
    try {
      const client = this.runtime.client();
      if (!(await client.isOnline())) throw new Error('运行时未连接');
      await this.ensureDirs(onLog);
      const state = this.loadState();

      // --- 本机 → 设备 ---
      const localFiles = walk(this.localDir);
      for (const f of localFiles) {
        const prev = state[f.rel];
        const changed = !prev || Math.abs((prev.mtime || 0) - f.mtime) > 1500 || prev.size !== f.size;
        if (!changed) continue;
        const remote = `${this.remoteDir}/${f.rel}`;
        try {
          await client.shell(`mkdir -p "$(dirname '${remote}')"`);
          await client.push(f.abs, remote);
          state[f.rel] = { mtime: f.mtime, size: f.size, dir: 'up' };
          result.pushed++;
        } catch (e) {
          result.errors.push(`↑ ${f.rel}: ${e.message}`);
        }
      }

      // --- 设备 → 本机 ---
      let remoteList = [];
      try {
        remoteList = await this.listRemoteRecursive(client, this.remoteDir);
      } catch (_) { /* ignore */ }

      for (const r of remoteList) {
        const prev = state[r.rel];
        if (prev && Math.abs((prev.mtime || 0) - r.mtime) <= 1500 && prev.size === r.size) continue;
        const local = path.join(this.localDir, r.rel);
        try {
          fs.mkdirSync(path.dirname(local), { recursive: true });
          await client.pull(`${this.remoteDir}/${r.rel}`, local);
          const st = fs.statSync(local);
          state[r.rel] = { mtime: st.mtimeMs, size: st.size, dir: 'down' };
          result.pulled++;
        } catch (e) {
          result.errors.push(`↓ ${r.rel}: ${e.message}`);
        }
      }

      this.saveState(state);
      this._lastError = result.errors[0] || '';
      return result;
    } catch (e) {
      this._lastError = e.message;
      return { ...result, error: e.message };
    } finally {
      this._busy = false;
    }
  }

  async listRemoteRecursive(client, base, prefix = '', depth = 0, out = []) {
    if (depth > 6) return out;
    const items = await client.listRemote(prefix ? `${base}/${prefix}` : base);
    for (const it of items) {
      if (it.name === '.' || it.name === '..') continue;
      const rel = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.isDir) {
        await this.listRemoteRecursive(client, base, rel, depth + 1, out);
      } else {
        out.push({ rel, size: it.size, mtime: Date.now() });
      }
    }
    return out;
  }

  start(intervalMs = 8000) {
    if (this._timer) return;
    this._timer = setInterval(() => { this.sync().catch(() => {}); }, intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  get lastError() { return this._lastError; }
}

module.exports = { Sharer };
