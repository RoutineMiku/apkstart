'use strict';
// Wrapper: node test/uiact.js click 800 40
const { spawnSync } = require('child_process');
const path = require('path');

const exe = process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\' + 'power' + 'shell.exe';
const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'uiact.ps1')];
const [act, x, y] = process.argv.slice(2);
args.push('-Act', act || 'click', '-X', String(x || 0), '-Y', String(y || 0));
const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
process.stdout.write(r.stdout || '');
if (r.stderr) process.stderr.write(r.stderr);
