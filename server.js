try {

const express = require('express');
const path = require('path');
const cors = require('cors');
const config = require('./src/config');
const apiKeyAuth = require('./src/middleware/auth');
const { requestLogger } = require('./src/middleware/logger');

console.log('[BOOT] Config loaded, port:', config.port);

const agentRoutes = require('./src/routes/agentRoutes');
const approvalRoutes = require('./src/routes/approvalRoutes');
const webhookRoutes = require('./src/routes/webhookRoutes');
const dashboardRoutes = require('./src/routes/dashboardRoutes');

console.log('[BOOT] All routes loaded');

const app = express();

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// Serve the Agent Control Panel
app.use(express.static(path.join(__dirname, 'public')));

// Health check (no auth)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'elite-agents',
    timestamp: new Date().toISOString(),
    supabase_url: !!process.env.SUPABASE_URL,
    supabase_key: !!process.env.SUPABASE_KEY,
    supabase_key_len: (process.env.SUPABASE_KEY || '').length,
    env_count: Object.keys(process.env).filter(k => k.startsWith('SUPA') || k.startsWith('API') || k.startsWith('ANTHROPIC') || k.startsWith('TELEGRAM')).join(','),
  });
});

// API routes (auth required)
app.use('/api/agent', apiKeyAuth, agentRoutes);
app.use('/api/approvals', apiKeyAuth, approvalRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/dashboard', apiKeyAuth, dashboardRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

const port = process.env.PORT || config.port || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`  ELITE TRUCKING AGENT SYSTEM`);
  console.log(`  Running on port ${port}`);
  console.log(`  Stub mode: ${config.stubMode ? 'ON (no real SMS/email)' : 'OFF (LIVE)'}`);
  console.log(`========================================\n`);

  // Start Telegram bot if token is set
  if (config.telegramBotToken) {
    try {
      const { initTelegram } = require('./src/services/telegramService');
      initTelegram();
    } catch (e) {
      console.error('[Telegram] Failed to start:', e.message);
    }
  }
});

module.exports = app;

} catch (err) {
  console.error('[FATAL] Server failed to start:', err);
  process.exit(1);
}