'use strict';
/**
 * 端到端引导测速：直接驱动 Runtime，输出每个阶段耗时。
 * 用法：node tools/e2e-boot.js <appRoot> [--stop|--keep]
 *   appRoot = 安装目录里的 resources/app（能找到 runtime/ 的那个）
 */
const path = require('path');
const { Runtime } = require('../src/core/engine');

const APP_ROOT = process.argv[2] || process.cwd();
const mode = process.argv.includes('--stop') ? 'stop' : 'keep';

(async () => {
  const t0 = Date.now();
  const rt = new Runtime(APP_ROOT);
  const mark = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

  mark('prewarm begin');
  const r = await rt.prewarm({ onLog: (m) => mark(m) });
  mark(`prewarm result ok=${r && r.ok} bootMs=${r && r.bootMs} err=${(r && r.error) || ''}`);

  if (r && r.ok) {
    const c = rt.client();
    const out = await c.shell('getprop sys.boot_completed; pm path android', { timeout: 15000 }).catch((e) => `ERR ${e.message}`);
    mark(`after-ready probe: ${String(out).replace(/\n/g, ' | ')}`);
  }

  if (mode === 'stop') {
    mark('stop begin (save snapshot)');
    await rt.stop().catch((e) => mark(`stop err ${e.message}`));
    mark('stop done');
    const emu = rt.emulator;
    mark(`hasSnapshot=${emu.hasSnapshot()}`);
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
