const rateLimit = require('express-rate-limit');

// extraSkip: fungsi opsional (req)=>bool untuk melewati limiter pada path
// tertentu (mis. endpoint streaming berfrekuensi tinggi yang punya limiter
// longgar sendiri).
function createRateLimiter(windowMs, max, message, extraSkip) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message || 'Too many requests, please try again later.' },
    skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1' || (extraSkip ? !!extraSkip(req) : false),
  });
}

module.exports = { createRateLimiter };
