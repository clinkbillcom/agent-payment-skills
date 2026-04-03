import { spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..');
const CACHE_PATH = path.join(SKILL_DIR, 'clink.config.json');
const LOG_PATH = path.join(SKILL_DIR, 'error.log');

function parseArgs(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for --${key}`);
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

function normalizeCache(cache) {
  const normalized = cache && typeof cache === 'object' ? cache : {};
  if (!Array.isArray(normalized.paymentMethods)) normalized.paymentMethods = [];
  if (normalized.defaultPaymentMethodId === undefined) normalized.defaultPaymentMethodId = null;
  if (!normalized.orderCardStates || typeof normalized.orderCardStates !== 'object') {
    normalized.orderCardStates = {};
  }
  if (
    normalized.pendingMerchantConfirmation &&
    typeof normalized.pendingMerchantConfirmation === 'object' &&
    !Array.isArray(normalized.pendingMerchantConfirmation)
  ) {
    const pending = normalized.pendingMerchantConfirmation;
    if (
      pending.notifyDestination &&
      typeof pending.notifyDestination === 'object' &&
      !Array.isArray(pending.notifyDestination) &&
      typeof pending.notifyDestination.channel === 'string' &&
      pending.notifyDestination.channel.trim() &&
      pending.notifyDestination.target &&
      typeof pending.notifyDestination.target === 'object' &&
      !Array.isArray(pending.notifyDestination.target) &&
      typeof pending.notifyDestination.target.id === 'string' &&
      pending.notifyDestination.target.id.trim() &&
      typeof pending.notifyDestination.target.type === 'string' &&
      pending.notifyDestination.target.type.trim()
    ) {
      pending.notifyDestination = {
        channel: pending.notifyDestination.channel.trim().toLowerCase(),
        target: {
          type: pending.notifyDestination.target.type.trim(),
          id: pending.notifyDestination.target.id.trim(),
        },
      };
    } else {
      pending.notifyDestination = null;
    }
  }
  return normalized;
}

async function readCache() {
  try {
    const content = await fsp.readFile(CACHE_PATH, 'utf8');
    return normalizeCache(JSON.parse(content));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return normalizeCache({});
    }
    throw error;
  }
}

async function writeCache(cache) {
  await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fsp.writeFile(CACHE_PATH, JSON.stringify(normalizeCache(cache), null, 2), 'utf8');
}

function normalizeOrderStatus(status) {
  if (status === undefined || status === null || status === '') return null;
  return String(status).trim();
}

function getOrderCardStateKeys(orderId, status, sessionId) {
  const keys = [];
  const normalizedStatus = normalizeOrderStatus(status);
  if (typeof orderId === 'string' && orderId.trim() && normalizedStatus) {
    keys.push(`order_status:${orderId.trim()}:${normalizedStatus}`);
  }
  if (typeof orderId === 'string' && orderId.trim()) keys.push(`order:${orderId.trim()}`);
  if (typeof sessionId === 'string' && sessionId.trim()) keys.push(`session:${sessionId.trim()}`);
  return keys;
}

function getOrderCardState(cache, orderId, status, sessionId) {
  const normalizedCache = normalizeCache(cache);
  for (const key of getOrderCardStateKeys(orderId, status, sessionId)) {
    if (normalizedCache.orderCardStates[key]) {
      return normalizedCache.orderCardStates[key];
    }
  }
  return null;
}

async function updateOrderCardState(orderId, status, sessionId, patch) {
  if (!Object.keys(patch || {}).length) return null;
  const cache = normalizeCache(await readCache());
  const existing = getOrderCardState(cache, orderId, status, sessionId) || {};
  const nextState = {
    ...existing,
    ...patch,
    orderId: typeof orderId === 'string' && orderId.trim() ? orderId.trim() : existing.orderId || null,
    status: normalizeOrderStatus(status) || existing.status || null,
    sessionId: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : existing.sessionId || null,
    updatedAt: new Date().toISOString(),
  };

  for (const key of getOrderCardStateKeys(nextState.orderId, nextState.status, nextState.sessionId)) {
    cache.orderCardStates[key] = nextState;
  }

  await writeCache(cache);
  return nextState;
}

async function clearPendingMerchantConfirmation(server, tool, pendingSessionId) {
  const cache = normalizeCache(await readCache());
  const pending = cache.pendingMerchantConfirmation;
  if (!pending) return;
  const sessionMatches = (pending.sessionId || null) === (pendingSessionId || null);
  if (pending.server === server && pending.tool === tool && sessionMatches) {
    delete cache.pendingMerchantConfirmation;
    await writeCache(cache);
  }
}

async function appendLog(message) {
  try {
    await fsp.mkdir(path.dirname(LOG_PATH), { recursive: true });
    await fsp.appendFile(LOG_PATH, `${message}\n`, 'utf8');
  } catch {}
}

async function run() {
  const args = parseArgs(process.argv);
  const configPath = args['config-path'];
  const server = args.server;
  const tool = args.tool;
  const argsJson = args['args-json'];
  const orderId = args['order-id'] || null;
  const sessionId = args['session-id'] || null;
  const triggerSource = args['trigger-source'] || 'async_runner';
  const pendingSessionId = args['pending-session-id'] || null;

  if (!configPath || !server || !tool || !argsJson || !orderId) {
    throw new Error('config-path, server, tool, args-json, and order-id are required');
  }

  const launchLogPrefix = `[${new Date().toISOString()}] [merchant_confirmation]`;
  await appendLog(`${launchLogPrefix} start server=${server} tool=${tool} order=${orderId} session=${sessionId || 'N/A'}`);

  const logFd = fs.openSync(LOG_PATH, 'a');
  let closeResult = null;
  try {
    closeResult = await new Promise((resolve, reject) => {
      const child = spawn('npx', ['mcporter', '--config', configPath, 'call', server, tool, '--args', argsJson], {
        stdio: ['ignore', logFd, logFd],
      });
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    try {
      fs.closeSync(logFd);
    } catch {}
  }

  await appendLog(`${launchLogPrefix} exit_code=${closeResult.code === null ? 'null' : closeResult.code} signal=${closeResult.signal || 'none'}`);

  if (closeResult.code !== 0) {
    await updateOrderCardState(orderId, 1, sessionId, {
      merchantConfirmationDispatched: false,
      merchantConfirmationDispatchFailedAt: new Date().toISOString(),
      merchantConfirmationDispatchFailedSource: triggerSource,
      merchantConfirmationDispatchExitCode: closeResult.code === null ? null : String(closeResult.code),
      merchantConfirmationDispatchSignal: closeResult.signal || null,
    });
    process.exit(closeResult.code || 1);
  }

  await updateOrderCardState(orderId, 1, sessionId, {
    merchantConfirmationDispatched: false,
    merchantConfirmationTriggered: true,
    merchantConfirmationTriggeredAt: new Date().toISOString(),
    merchantConfirmationTriggerSource: triggerSource,
  });
  await clearPendingMerchantConfirmation(server, tool, pendingSessionId);
  await appendLog(`${launchLogPrefix} state_updated order=${orderId} session=${sessionId || 'N/A'}`);
}

run().catch(async (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  try {
    const args = parseArgs(process.argv);
    const orderId = args['order-id'] || null;
    const sessionId = args['session-id'] || null;
    const triggerSource = args['trigger-source'] || 'async_runner';
    if (orderId) {
      await updateOrderCardState(orderId, 1, sessionId, {
        merchantConfirmationDispatched: false,
        merchantConfirmationDispatchFailedAt: new Date().toISOString(),
        merchantConfirmationDispatchFailedSource: triggerSource,
        merchantConfirmationDispatchError: message,
      });
    }
  } catch {}
  await appendLog(`[${new Date().toISOString()}] [merchant_confirmation.runner] ${message}`);
  process.exit(1);
});
