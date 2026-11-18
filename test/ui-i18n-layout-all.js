'use strict';
/**
 * Runs test/ui-i18n-layout.js under Electron at 100%, 150% and 200% display scaling
 * (the scale factor is a process-wide switch, so each one needs its own Electron process).
 * Run: npm run test:ui-i18n
 */
const { spawnSync } = require('child_process');
const path = require('path');

const electron = require('electron'); // path to the Electron binary when required from Node
const script = path.join(__dirname, 'ui-i18n-layout.js');
let failed = 0;
for (const dpr of (process.env.UI_DPRS || '1,1.5,2').split(',')) {
  console.log(`\n[ui-i18n] display scale ${dpr}x`);
  const r = spawnSync(electron, [script], { stdio: 'inherit', env: { ...process.env, UI_DPR: dpr } });
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
