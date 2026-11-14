'use strict';
// 临时验证：窗口代理脚本能编译、能连上、boothide 能下发
const { WinAgent } = require('../src/core/agent');

(async () => {
  const a = new WinAgent();
  try {
    await a.ensure();
    console.log('agent ready, port=', a.port);
    const r1 = await a.bootHide();
    console.log('bootHide ->', JSON.stringify(r1));
    await new Promise((r) => setTimeout(r, 500));
    const r2 = await a.bootShow();
    console.log('bootShow ->', JSON.stringify(r2));
    const p = await a.probe();
    console.log('probe ->', JSON.stringify(p));
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    a.dispose();
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  }
})();
