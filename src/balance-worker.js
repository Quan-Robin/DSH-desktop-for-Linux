'use strict';
// Worker for parsing dsh session files (zstd decompress + line scan).
// CPU-heavy work runs off the main process so the UI never blocks on the
// first (uncached) balance scan. The parser itself lives in usage-parse.js
// (shared with balance.js's inline fallback).
const { parentPort } = require('node:worker_threads');
const { parseUsageFile } = require('./usage-parse');

parentPort.on('message', (files) => {
  const results = files.map((file) => ({ file, data: parseUsageFile(file) }));
  parentPort.postMessage(results);
});
