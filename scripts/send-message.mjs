#!/usr/bin/env node
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  compileMessage,
  normalizeDeliveryMessageRequest,
  renderMessageFeishuCard,
  renderMessageMarkdown,
  renderMessagePlainText,
  resolvePreferredLocale,
} from '../notification-utils.js';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const FEISHU_CARD_SENDER = path.join(SCRIPT_DIR, 'send-feishu-card.mjs');
const LOG_PATH = path.join(SCRIPT_DIR, '..', 'error.log');

const CHANNEL_CAPABILITIES = Object.freeze({
  feishu: { rich: true, text_mode: 'plain' },
  telegram: { rich: false, text_mode: 'markdown' },
});

function logScriptError(context, error) {
  const parts = [
    `[${new Date().toISOString()}] [${context}]`,
    error instanceof Error ? error.stack || error.message : String(error),
  ];
  if (error && typeof error === 'object') {
    if (typeof error.stdout === 'string' && error.stdout.trim()) {
      parts.push(`stdout: ${error.stdout.trim()}`);
    }
    if (typeof error.stderr === 'string' && error.stderr.trim()) {
      parts.push(`stderr: ${error.stderr.trim()}`);
    }
  }
  try {
    fs.appendFileSync(LOG_PATH, `${parts.join('\n')}\n`, 'utf8');
  } catch {}
}

function parseArgs(argv) {
  let payloadJson = '';
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg !== '--payload') continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('--payload requires a JSON value');
    }
    payloadJson = value;
    index += 1;
  }
  if (!payloadJson) {
    throw new Error('Missing --payload');
  }
  const payload = JSON.parse(payloadJson);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be a JSON object');
  }
  return payload;
}

function normalizeTarget(payload) {
  const channel = typeof payload.channel === 'string' && payload.channel.trim()
    ? payload.channel.trim().toLowerCase()
    : '';
  const targetType = typeof payload?.target?.type === 'string' && payload.target.type.trim()
    ? payload.target.type.trim()
    : '';
  const targetId = typeof payload?.target?.id === 'string' && payload.target.id.trim()
    ? payload.target.id.trim()
    : '';
  const targetLocale = typeof payload?.target?.locale === 'string' && payload.target.locale.trim()
    ? payload.target.locale.trim()
    : '';
  if (!channel) throw new Error('channel is required');
  if (!targetType) throw new Error('target.type is required');
  if (!targetId) throw new Error('target.id is required');
  return { channel, targetType, targetId, targetLocale };
}

function resolveCompiledMessage(payload) {
  const { targetLocale } = normalizeTarget(payload);
  const preferredLocale = resolvePreferredLocale(
    payload.locale,
    targetLocale,
    payload.user_locale,
    payload.language,
  );
  const request = normalizeDeliveryMessageRequest(payload, { preferredLocale });
  return {
    request,
    compiled: compileMessage(request, { preferredLocale }),
  };
}

function resolveText(compiled, channel) {
  const capability = CHANNEL_CAPABILITIES[channel] || { rich: false, text_mode: 'markdown' };
  return capability.text_mode === 'plain'
    ? renderMessagePlainText(compiled)
    : renderMessageMarkdown(compiled);
}

function sendFeishuCard(payload, compiled) {
  const { targetId, targetType } = normalizeTarget(payload);
  if (targetType !== 'chat_id' && targetType !== 'open_id') {
    throw new Error('Feishu target.type must be "chat_id" or "open_id"');
  }
  const targetFlag = targetType === 'open_id' ? '--open-id' : '--chat-id';
  execFileSync(
    process.execPath,
    [FEISHU_CARD_SENDER, '--json', JSON.stringify(renderMessageFeishuCard(compiled)), targetFlag, targetId],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15000,
    },
  );
}

function sendViaOpenClawMessage(payload, compiled) {
  const { channel, targetId, targetType } = normalizeTarget(payload);
  const text = resolveText(compiled, channel);
  if (!text) {
    throw new Error('No text content available for delivery');
  }
  const target = channel === 'feishu'
    ? targetType === 'chat_id'
      ? `group:${targetId}`
      : targetType === 'open_id'
        ? `user:${targetId}`
        : targetId
    : targetId;
  execFileSync(
    'openclaw',
    ['message', 'send', '--channel', channel, '--target', target, '--message', text],
    {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30000,
    },
  );
}

async function main() {
  const payload = parseArgs(process.argv.slice(2));
  const { channel } = normalizeTarget(payload);
  const { request, compiled } = resolveCompiledMessage(payload);
  const deliveryPolicy = request.delivery_policy || { prefer_rich: true, allow_fallback: true };
  const capability = CHANNEL_CAPABILITIES[channel] || { rich: false, text_mode: 'markdown' };

  if (channel === 'feishu' && capability.rich && deliveryPolicy.prefer_rich) {
    try {
      sendFeishuCard(payload, compiled);
      return;
    } catch (error) {
      logScriptError('scripts/send-message/feishu-rich', error);
      if (!deliveryPolicy.allow_fallback) {
        throw error;
      }
    }
  }

  sendViaOpenClawMessage(payload, compiled);
}

main().catch((error) => {
  logScriptError('scripts/send-message', error);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

