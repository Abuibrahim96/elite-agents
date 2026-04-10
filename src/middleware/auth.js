const config = require('../config');

function apiKeyAuth(req, res, next) {
  // Skip auth for webhook endpoints that have their own verification
  if (req.path.startsWith('/api/webhooks/twilio') || req.path.startsWith('/api/webhooks/slack')) {
    return next();
  }

  const key = req.headers['x-api-key'];
  if (!key || key !== config.apiKey) {
    return res.status(401).json({ error: 'Unauthorized — invalid or missing API key' });
  }
  next();
}

module.exports = apiKeyAuth;
