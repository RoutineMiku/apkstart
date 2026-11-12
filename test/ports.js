'use strict';
// 在 Electron 主进程里跑一遍端口发现逻辑，确认 tasklist/netstat 解析是否可用
const { app } = require('electron');
const { execFile } = require('child_process');

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    resolve(err ? `ERR ${err.message}` : String(out || ''));
  });
});

app.whenReady().then(async () => {
  const tl = await run('tasklist', ['/FO', 'CSV', '/NH']);
  console.log('TASKLIST_LEN', tl.length, JSON.stringify(tl.slice(0, 80)));
  const pids = new Set();
  for (const line of tl.split('\n')) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m && /qemu|emulator/i.test(m[1])) pids.add(m[2]);
  }
  console.log('PIDS', [...pids].join(','));
  const ns = await run('netstat', ['-ano', '-p', 'TCP']);
  console.log('NETSTAT_LEN', ns.length);
  const ports = new Set();
  for (const line of ns.split('\n')) {
    const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (m && pids.has(m[2])) ports.add(Number(m[1]));
  }
  console.log('PORTS', [...ports].join(','));
  app.quit();
});
