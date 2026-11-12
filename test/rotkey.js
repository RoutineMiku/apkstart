'use strict';
// node test/rotkey.js left|right
const { spawnSync } = require('child_process');
const path = require('path');
const exe = process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\' + 'power' + 'shell.exe';
const key = process.argv[2] || 'left';
const r = spawnSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'rotkey.ps1'), '-Key', key], { encoding: 'utf8', windowsHide: true });
process.stdout.write(r.stdout || '');
if (r.stderr) process.stderr.write(r.stderr);
