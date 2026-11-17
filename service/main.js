'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
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

// Windows shell commands only understand backslash paths, so every target is
// resolved first; path.resolve also turns the forward-slash paths the host
// reports into native separators.
function resolveTarget(target, missingMessage, invalidMessage) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new ServiceError(400, missingMessage);
  }
  if (target.includes('\0')) {
    throw new ServiceError(400, invalidMessage);
  }
  if (!path.isAbsolute(target)) {
    throw new ServiceError(400, '需要绝对路径。');
  }
  return path.resolve(target);
}

function openerFor(target) {
  if (process.platform === 'darwin') {
    return { command: 'open', args: [target] };
  }
  if (process.platform === 'win32') {
    // explorer hands its own start-up show state to the program it opens, and
    // that program's window would be hidden too.
    return { command: 'explorer.exe', args: [target], hideWindow: false };
  }
  return { command: 'xdg-open', args: [target] };
}

// `hideWindow` keeps a console helper from flashing a window. On Windows it is
// passed to the child as SW_HIDE, and whether the child shows a window at all
// comes from it: explorer.exe hands that state on to the window it opens, so an
// Explorer window started that way is created hidden and the user sees nothing.
// Desktop helpers therefore launch with hideWindow off; only console programs
// such as PowerShell use it.
function launch(command, args, hideWindow = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: hideWindow,
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

// Windows keeps no Node API for the Recycle Bin, so a hidden PowerShell process
// calls SHFileOperation. FOF_ALLOWUNDO is the Recycle Bin; FOF_SILENT,
// FOF_NOCONFIRMATION and FOF_NOERRORUI keep it from showing anything. The C#
// source stays on one line and the whole script travels in -EncodedCommand, so
// no quoting survives a trip through a shell.
const RECYCLE_ASSEMBLY =
  'using System; using System.Runtime.InteropServices; public static class OcRecycle { ' +
  '[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct Op { public IntPtr hwnd; public uint wFunc; ' +
  '[MarshalAs(UnmanagedType.LPWStr)] public string pFrom; [MarshalAs(UnmanagedType.LPWStr)] public string pTo; ' +
  'public ushort fFlags; [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted; public IntPtr hNameMappings; ' +
  '[MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle; } ' +
  '[DllImport("shell32.dll", CharSet=CharSet.Unicode)] private static extern int SHFileOperation(ref Op lpFileOp); ' +
  'public static int Delete(string path) { Op op = new Op(); op.wFunc = 3; op.pFrom = path + (char)0 + (char)0; ' +
  'op.fFlags = 0x0454; return SHFileOperation(ref op); } }';
const RECYCLE_TIMEOUT_MS = 15_000;

function recycleScript(target) {
  const literal = `'${target.replace(/'/g, "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -TypeDefinition '${RECYCLE_ASSEMBLY}'`,
    `$code = [OcRecycle]::Delete(${literal})`,
    'exit $code',
  ].join('\n');
}

/** Runs Windows PowerShell hidden and resolves with its exit code. */
function runPowerShell(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: 'ignore', windowsHide: true },
    );

    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('PowerShell 没有响应。'));
    }, timeoutMs);
    timer.unref?.();

    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(code);
    };

    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(null, code ?? 1));
  });
}

/** Windows: move the entry into the Recycle Bin; false when it refused. */
async function recycleEntry(target) {
  try {
    const code = await runPowerShell(recycleScript(target), RECYCLE_TIMEOUT_MS);
    if (code !== 0) return false;
  } catch {
    return false;
  }

  // A cancelled or partly failed operation still exits with 0, so the entry's
  // absence is what proves it moved.
  try {
    await fs.lstat(target);
    return false;
  } catch {
    return true;
  }
}

async function deleteEntry(target, root) {
  const resolvedTarget = resolveTarget(target, '缺少路径。', '路径无效。');

  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new ServiceError(400, '缺少项目目录。');
  }

  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ServiceError(400, '只能删除项目目录内的文件。');
  }

  let stat;
  try {
    stat = await fs.lstat(resolvedTarget);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new ServiceError(404, '文件不存在或已被移动。');
    }
    throw new ServiceError(500, '无法读取这个文件。');
  }

  // macOS and Windows send it to the Trash / Recycle Bin; everywhere else, and
  // when the Recycle Bin refuses (a network share, a read-only file), it is
  // removed outright like Explorer does.
  if (process.platform === 'darwin') {
    await moveToTrash(resolvedTarget);
    return true;
  }

  if (process.platform === 'win32' && (await recycleEntry(resolvedTarget))) {
    return true;
  }

  try {
    await fs.rm(resolvedTarget, { recursive: stat.isDirectory(), force: false });
  } catch (error) {
    throw new ServiceError(500, '删除失败，文件可能正在被使用。');
  }
  return false;
}

async function moveToTrash(target) {
  const name = path.basename(target);
  if (!name || name === path.sep) throw new ServiceError(400, '只能删除项目目录内的文件。');

  const trash = path.join(os.homedir(), '.Trash');
  let destination = '';
  for (let index = 0; index < 100; index += 1) {
    const candidate = path.join(trash, index === 0 ? name : `${name} ${index + 1}`);
    try {
      await fs.lstat(candidate);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        destination = candidate;
        break;
      }
      throw new ServiceError(500, '无法访问废纸篓。');
    }
  }
  if (!destination) throw new ServiceError(409, '废纸篓里同名项目太多，请手动删除。');

  try {
    await fs.rename(target, destination);
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      throw new ServiceError(409, '项目和废纸篓不在同一磁盘，请手动删除。');
    }
    if (error && error.code === 'ENOENT') {
      throw new ServiceError(404, '文件不存在或已被移动。');
    }
    throw new ServiceError(500, '无法移入废纸篓。');
  }
}

function revealerFor(target) {
  if (process.platform === 'darwin') {
    return { command: 'open', args: ['-R', target] };
  }
  // xdg-open has no "select this entry" mode: show the containing folder instead.
  return { command: 'xdg-open', args: [path.dirname(target)] };
}

// Explorer selects the entry, but its window can come up hidden or stay behind
// the app. Two Windows rules cause that: the host starts this service hidden,
// and a window created by a hidden process inherits that show state; and only
// the process that last received input may raise another app's window. One
// helper handles both — Start-Process gives Explorer an explicit normal window
// state, and a bare Alt press lets this process bring the window forward.
const WINDOW_ASSEMBLY =
  'using System; using System.Runtime.InteropServices; public static class OcWindow { ' +
  '[StructLayout(LayoutKind.Sequential)] private struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; ' +
  'public uint dwFlags; public uint uCount; public uint dwTimeout; } ' +
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); ' +
  '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); ' +
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); ' +
  '[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h); ' +
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); ' +
  '[DllImport("user32.dll")] private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra); ' +
  '[DllImport("user32.dll")] private static extern bool FlashWindowEx(ref FLASHWINFO info); ' +
  'public static bool Raise(IntPtr h) { ' +
  'if (IsIconic(h)) ShowWindow(h, 9); ' +
  // A bare Alt press counts as input from this process, which is what Windows
  // wants before it lets a background process move the foreground.
  'keybd_event(18, 0, 0, UIntPtr.Zero); keybd_event(18, 0, 2, UIntPtr.Zero); ' +
  'BringWindowToTop(h); SetForegroundWindow(h); ' +
  // Windows can still refuse while another app holds the foreground; then at
  // least blink its taskbar button so the window is noticed.
  'if (GetForegroundWindow() == h) return true; ' +
  'FLASHWINFO info = new FLASHWINFO(); info.cbSize = (uint)Marshal.SizeOf(info); info.hwnd = h; ' +
  'info.dwFlags = 3; info.uCount = 3; FlashWindowEx(ref info); return false; } }';
const REVEAL_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 15_000;
const REVEAL_NO_WINDOW = 3;

const psLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** PowerShell lines that put the folder window's handle in $handle, or exit 3. */
function windowLookup(folder) {
  return [
    `$folder = ${psLiteral(folder)}`,
    '$shell = New-Object -ComObject Shell.Application',
    '$handle = [IntPtr]::Zero',
    'for ($try = 0; $try -lt 30; $try += 1) {',
    '  foreach ($window in @($shell.Windows())) {',
    '    try { if ($window.Document.Folder.Self.Path -eq $folder) { $handle = [IntPtr]$window.HWND; break } } catch { }',
    '  }',
    '  if ($handle -ne [IntPtr]::Zero) { break }',
    '  Start-Sleep -Milliseconds 150',
    '}',
    'if ($handle -eq [IntPtr]::Zero) { exit 3 }',
  ];
}

function revealScript(target) {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `Add-Type -TypeDefinition '${WINDOW_ASSEMBLY}'`,
    // `/select,` and the path stay separate arguments so only the path is
    // quoted; one joined argument makes Explorer open its working directory
    // instead whenever the path contains a space.
    `Start-Process -FilePath 'explorer.exe' -ArgumentList @('/select,', ${psLiteral(`"${target}"`)}) -WindowStyle Normal`,
    ...windowLookup(path.dirname(target)),
    '[void][OcWindow]::Raise($handle)',
    'exit 0',
  ].join('\n');
}

function raiseScript(folder) {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `Add-Type -TypeDefinition '${WINDOW_ASSEMBLY}'`,
    ...windowLookup(folder),
    '[void][OcWindow]::Raise($handle)',
    'exit 0',
  ].join('\n');
}

/**
 * Windows: starts a desktop program with an explicit normal window state, so a
 * program the hidden service starts still shows its window. Resolves false when
 * PowerShell is unavailable, and the caller falls back to a direct spawn.
 */
async function startVisible(file, args) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `Start-Process -FilePath ${psLiteral(file)} -ArgumentList @(${args.map(psLiteral).join(', ')}) -WindowStyle Normal`,
  ].join('\n');

  try {
    return (await runPowerShell(script, START_TIMEOUT_MS)) === 0;
  } catch {
    return false;
  }
}

/** Windows: select the entry in Explorer, then make sure its window is in front. */
async function revealOnWindows(target) {
  const folder = path.dirname(target);
  const code = await runPowerShell(revealScript(target), REVEAL_TIMEOUT_MS).catch(() => -1);

  if (code === -1) {
    // No PowerShell: a direct start is all that is left.
    try {
      await launch('explorer.exe', ['/select,', target], false);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new ServiceError(500, '找不到系统命令：explorer.exe');
      }
      throw new ServiceError(500, '系统无法打开文件管理器。');
    }
    return;
  }

  if (code !== REVEAL_NO_WINDOW) return;

  // Explorer showed no window for that folder, so opening it is the only way to
  // leave the user something to look at.
  if (!(await startVisible('explorer.exe', [`"${folder}"`]))) {
    await launch('explorer.exe', [folder], false).catch(() => undefined);
    return;
  }
  await runPowerShell(raiseScript(folder), REVEAL_TIMEOUT_MS).catch(() => undefined);
}

async function revealEntry(target) {
  const resolved = resolveTarget(target, '缺少路径。', '路径无效。');

  try {
    await fs.stat(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new ServiceError(404, '文件不存在或已被移动。');
    }
    throw new ServiceError(500, '无法读取这个文件。');
  }

  if (process.platform === 'win32') {
    await revealOnWindows(resolved);
    return;
  }

  const { command, args } = revealerFor(resolved);
  try {
    await launch(command, args);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new ServiceError(500, `找不到系统命令：${command}`);
    }
    throw new ServiceError(500, '系统无法打开文件管理器。');
  }
}

async function openFile(target) {
  const resolved = resolveTarget(target, '缺少文件路径。', '文件路径无效。');

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new ServiceError(404, '文件不存在或已被移动。');
    }
    throw new ServiceError(500, '无法读取这个文件。');
  }

  if (!stat.isFile()) {
    throw new ServiceError(400, '只能打开文件。');
  }

  if (process.platform === 'win32' && (await startVisible('explorer.exe', [`"${resolved}"`]))) {
    return;
  }

  const { command, args, hideWindow } = openerFor(resolved);
  try {
    await launch(command, args, hideWindow);
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

    if (request.method === 'POST' && url.pathname === '/reveal') {
      let payload;
      try {
        payload = JSON.parse(await readBody(request));
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError(400, '请求内容不是有效的 JSON。');
      }

      await revealEntry(payload && payload.path);
      send(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/delete') {
      let payload;
      try {
        payload = JSON.parse(await readBody(request));
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError(400, '请求内容不是有效的 JSON。');
      }

      const trashed = await deleteEntry(payload && payload.path, payload && payload.root);
      send(response, 200, { ok: true, trashed });
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
