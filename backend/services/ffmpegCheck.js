/**
 * Detects whether FFmpeg is available at the configured path.
 * Result is cached after the first probe.
 */
const { spawnSync } = require('child_process');
const config = require('../config');

let cached = null;

function ffmpegAvailable() {
  if (cached !== null) return cached;
  try {
    const r = spawnSync(config.ffmpegPath, ['-version'], { stdio: 'ignore', timeout: 5000 });
    cached = r.status === 0;
  } catch {
    cached = false;
  }
  return cached;
}

function resetCache() { cached = null; }

module.exports = { ffmpegAvailable, resetCache };
