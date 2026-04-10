const { v4: uuidv4 } = require('uuid');
const { query, getOne, getMany } = require('../db');
const config = require('../config');
const slack = require('./slackService');

/**
 * Create an approval request.
 * Posts to Slack with interactive buttons, stores in DB.
 */
async function createApproval({
  agent,
  actionType,
  priority = 'normal',
  title,
  summary,
  fullContent = null,
  detailJson = {},
  callbackUrl = null,
}) {
  const expiresAt = new Date(Date.now() + config.approvalExpiryHours * 60 * 60 * 1000);

  const result = await query(
    `INSERT INTO approval_queue (agent, action_type, priority, title, summary, full_content, detail_json, expires_at, callback_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [agent, actionType, priority, title, summary, fullContent, JSON.stringify(detailJson), expiresAt, callbackUrl]
  );

  const approval = result.rows[0];

  // Post to Slack
  try {
    const slackResult = await slack.postApprovalRequest({
      approvalId: approval.id,
      agent,
      title,
      summary,
      fullContent,
      priority,
    });

    // Store Slack message TS for later updating
    await query(
      'UPDATE approval_queue SET slack_ts = $1, slack_channel = $2 WHERE id = $3',
      [slackResult.ts, slackResult.channel, approval.id]
    );

    approval.slack_ts = slackResult.ts;
  } catch (err) {
    console.error('Failed to post approval to Slack:', err.message);
  }

  return approval;
}

/**
 * Resolve an approval (approve/reject).
 * Updates Slack message, fires callback if approved.
 */
async function resolveApproval(approvalId, { status, resolvedBy = 'unknown', modifiedContent = null }) {
  const approval = await getOne('SELECT * FROM approval_queue WHERE id = $1', [approvalId]);
  if (!approval) {
    throw new Error(`Approval ${approvalId} not found`);
  }
  if (approval.status !== 'pending') {
    throw new Error(`Approval ${approvalId} already resolved (${approval.status})`);
  }

  await query(
    `UPDATE approval_queue SET status = $1, resolved_by = $2, resolved_at = NOW(), modified_content = $3 WHERE id = $4`,
    [status, resolvedBy, modifiedContent, approvalId]
  );

  // Update Slack message
  if (approval.slack_ts && approval.slack_channel) {
    const emoji = status === 'approved' ? '✅' : '❌';
    try {
      await slack.updateMessage({
        channel: approval.slack_channel,
        ts: approval.slack_ts,
        text: `${emoji} ${status.toUpperCase()} by ${resolvedBy}: ${approval.title}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${emoji} *${status.toUpperCase()}* by ${resolvedBy}\n*${approval.title}*\n${approval.summary}`
            }
          }
        ],
      });
    } catch (err) {
      console.error('Failed to update Slack message:', err.message);
    }
  }

  // Fire callback if approved and callback URL exists
  if (status === 'approved' && approval.callback_url) {
    try {
      await fetch(approval.callback_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approval_id: approvalId,
          status,
          detail_json: approval.detail_json,
          modified_content: modifiedContent,
        }),
      });
    } catch (err) {
      console.error(`Failed to fire callback for approval ${approvalId}:`, err.message);
    }
  }

  return { success: true, approvalId, status };
}

/**
 * Expire all stale approvals that have passed their deadline.
 */
async function expireStaleApprovals() {
  const stale = await getMany(
    `SELECT * FROM approval_queue WHERE status = 'pending' AND expires_at < NOW()`
  );

  for (const approval of stale) {
    await query(
      `UPDATE approval_queue SET status = 'expired', resolved_at = NOW() WHERE id = $1`,
      [approval.id]
    );

    // Update Slack message
    if (approval.slack_ts && approval.slack_channel) {
      try {
        await slack.updateMessage({
          channel: approval.slack_channel,
          ts: approval.slack_ts,
          text: `⏰ EXPIRED: ${approval.title}`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `⏰ *EXPIRED* — ${approval.title}\n${approval.summary}` }
            }
          ],
        });
      } catch (err) {
        console.error('Failed to update expired Slack message:', err.message);
      }
    }
  }

  return { expired: stale.length };
}

/**
 * List approvals with optional filters.
 */
async function listApprovals({ status = null, agent = null, limit = 50 } = {}) {
  let sql = 'SELECT * FROM approval_queue WHERE 1=1';
  const params = [];
  let idx = 1;

  if (status) {
    sql += ` AND status = $${idx++}`;
    params.push(status);
  }
  if (agent) {
    sql += ` AND agent = $${idx++}`;
    params.push(agent);
  }

  sql += ` ORDER BY requested_at DESC LIMIT $${idx}`;
  params.push(limit);

  return getMany(sql, params);
}

module.exports = { createApproval, resolveApproval, expireStaleApprovals, listApprovals };
