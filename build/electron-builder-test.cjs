'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Lightweight test installer: reuse the runtime already in the user's data directory.
// A new installation downloads the runtime on demand, as the portable build does.
const config = yaml.load(fs.readFileSync(path.join(__dirname, '../electron-builder.yml'), 'utf8'));
module.exports = {
  ...config,
  directories: { ...config.directories, output: 'dist/i18n-test' },
  extraMetadata: { version: `${require('../package.json').version}-i18n.1` },
  extraResources: [],
  publish: null,
};
