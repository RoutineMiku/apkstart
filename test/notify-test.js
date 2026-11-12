'use strict';
// 用真实的 dumpsys 输出验证通知解析
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { parseRecords } = require('../src/core/notify');

app.whenReady().then(() => {
  const dump = fs.readFileSync(path.join(__dirname, 'notif.txt'), 'utf8');
  const list = parseRecords(dump);
  console.log('COUNT', list.length);
  for (const n of list) console.log(JSON.stringify(n).slice(0, 220));
  app.quit();
});
