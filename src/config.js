require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://elite:password@localhost:5432/elite_trucking',
  apiKey: process.env.API_KEY || 'dev-key',

  // Claude
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',

  // Twilio
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || '',

  // SendGrid
  sendgridApiKey: process.env.SENDGRID_API_KEY || '',
  sendgridFromEmail: process.env.SENDGRID_FROM_EMAIL || 'ops@elitetrucking.com',
  sendgridFromName: process.env.SENDGRID_FROM_NAME || 'Elite Trucking',

  // Slack
  slackBotToken: process.env.SLACK_BOT_TOKEN || '',
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET || '',
  slackApprovalChannel: process.env.SLACK_APPROVAL_CHANNEL || '',
  slackOpsChannel: process.env.SLACK_OPS_CHANNEL || '',

  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramGroupId: process.env.TELEGRAM_GROUP_ID || '',

  // n8n
  n8nBaseUrl: process.env.N8N_BASE_URL || 'http://localhost:5678',

  // Settings
  approvalExpiryHours: parseInt(process.env.APPROVAL_EXPIRY_HOURS || '4', 10),
  stubMode: process.env.STUB_MODE === 'true',
};

module.exports = config;
