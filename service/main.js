'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN || '';
const IDLE_MS = Number(process.env.OPENCHAMBER_SERVICE_IDLE_MS) || 60_000;
const MAX_BODY = 64 * 1024;

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error('path-picker service: OPENCHAMBER_SERVICE_PORT is missing or invalid');
  process.exit(1);
}

if (!TOKEN) {
  console.error('path-picker service: OPENCHAMBER_SERVICE_TOKEN is missing');
  process.exit(1);
}

class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ServiceError(413, '请求内容过大。'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function openerFor(target) {
  if (process.platform === 'darwin') {
    return { command: 'open', args: [target] };
  }
  if (process.platform === 'win32') {
    return { command: 'explorer.exe', args: [target] };
  }
  return { command: 'xdg-open', args: [target] };
}

function launch(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    const cleanup = () => {
      child.removeListener('error', onError);
      child.removeListener('spawn', onSpawn);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onSpawn = () => {
      cleanup();
      child.unref();
      resolve();
    };

    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

async function openFile(target) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new ServiceError(400, '缺少文件路径。');
  }
  if (target.includes('\0')) {
    throw new ServiceError(400, '文件路径无效。');
  }
  if (!path.isAbsolute(target)) {
    throw new ServiceError(400, '需要绝对路径。');
  }

  let stat;
  try {
    stat = await fs.stat(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new ServiceError(404, '文件不存在或已被移动。');
    }
    throw new ServiceError(500, '无法读取这个文件。');
  }

  if (!stat.isFile()) {
    throw new ServiceError(400, '只能打开文件。');
  }

  const { command, args } = openerFor(target);
  try {
    await launch(command, args);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new ServiceError(500, `找不到系统命令：${command}`);
    }
    throw new ServiceError(500, '系统无法打开这个文件。');
  }
}

const server = http.createServer(async (request, response) => {
  beginRequest();

  try {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      send(response, 401, { error: '未授权的请求。' });
      return;
    }

    const url = new URL(request.url || '/', 'http://127.0.0.1');

    if (request.method === 'GET' && url.pathname === '/health') {
      send(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/open') {
      let payload;
      try {
        payload = JSON.parse(await readBody(request));
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError(400, '请求内容不是有效的 JSON。');
      }

      await openFile(payload && payload.path);
      send(response, 200, { ok: true });
      return;
    }

    send(response, 404, { error: '没有这个接口。' });
  } catch (error) {
    const status = error instanceof ServiceError ? error.status : 500;
    const message = error instanceof ServiceError ? error.message : '本地服务处理失败。';
    if (status >= 500 && !(error instanceof ServiceError)) {
      console.error('path-picker service:', error);
    }
    if (!response.headersSent) send(response, status, { error: message });
    else response.end();
  } finally {
    endRequest();
  }
});

let idleTimer = null;
let activeRequests = 0;

function beginRequest() {
  activeRequests += 1;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function endRequest() {
  activeRequests = Math.max(0, activeRequests - 1);
  scheduleIdleStop();
}

function scheduleIdleStop() {
  if (activeRequests > 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, IDLE_MS);
  idleTimer.unref?.();
}

let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 1500).unref();
}

server.on('error', (error) => {
  console.error('path-picker service:', error);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  scheduleIdleStop();
});

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
