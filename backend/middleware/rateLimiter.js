const rateLimit = require('express-rate-limit');

function createRateLimiter(windowMs, max, message) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message || 'Too many requests, please try again later.' },
    skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1',
  });
}

module.exports = { createRateLimiter };
