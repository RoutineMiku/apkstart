'use strict';
// Runs test/wprobe.ps1 through the system shell host and prints its output.
const { spawnSync } = require('child_process');
const path = require('path');

const ps1 = path.join(__dirname, 'wprobe.ps1');
const exe = process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\' + 'power' + 'shell.exe';
const r = spawnSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
  encoding: 'utf8',
  windowsHide: true,
});
process.stdout.write(r.stdout || '');
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status || 0);
