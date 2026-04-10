const config = require('../config');

/**
 * Post a message to a Slack channel.
 * In stub mode, logs to console.
 */
async function postMessage({ channel, text, blocks = null }) {
  if (config.stubMode || !config.slackBotToken) {
    console.log(`[STUB SLACK] Channel: ${channel}\n  Text: ${text}\n`);
    return { ok: true, ts: `stub-${Date.now()}`, channel };
  }

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.slackBotToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel,
      text,
      blocks: blocks || undefined,
    }),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }
  return { ok: true, ts: data.ts, channel: data.channel };
}

/**
 * Update an existing Slack message (e.g., to mark approval resolved).
 */
async function updateMessage({ channel, ts, text, blocks = null }) {
  if (config.stubMode || !config.slackBotToken) {
    console.log(`[STUB SLACK UPDATE] Channel: ${channel} TS: ${ts}\n  Text: ${text}\n`);
    return { ok: true };
  }

  const response = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.slackBotToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel,
      ts,
      text,
      blocks: blocks || undefined,
    }),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack update error: ${data.error}`);
  }
  return { ok: true };
}

/**
 * Post an approval request to Slack with interactive buttons.
 */
async function postApprovalRequest({ approvalId, agent, title, summary, fullContent, priority = 'normal' }) {
  const priorityEmoji = priority === 'urgent' ? '🚨' : priority === 'high' ? '⚠️' : '📋';
  const channel = config.slackApprovalChannel;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${priorityEmoji} Approval Required — ${title}` }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Agent:*\n${agent}` },
        { type: 'mrkdwn', text: `*Priority:*\n${priority.toUpperCase()}` },
      ]
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Summary:*\n${summary}` }
    },
  ];

  if (fullContent) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Full Content:*\n\`\`\`${fullContent.substring(0, 2500)}\`\`\`` }
    });
  }

  blocks.push(
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve' },
          style: 'primary',
          action_id: 'approval_approve',
          value: String(approvalId),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject' },
          style: 'danger',
          action_id: 'approval_reject',
          value: String(approvalId),
        },
      ]
    }
  );

  return postMessage({ channel, text: `Approval: ${title}`, blocks });
}

/**
 * Post a daily briefing or ops message to the ops channel.
 */
async function postOpsBriefing(text, blocks = null) {
  const channel = config.slackOpsChannel || config.slackApprovalChannel;
  return postMessage({ channel, text, blocks });
}

module.exports = { postMessage, updateMessage, postApprovalRequest, postOpsBriefing };
