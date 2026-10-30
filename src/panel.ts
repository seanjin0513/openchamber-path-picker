import { connectHost, HostRequestError } from '@openchamber/sdk';
import type { FileListEntry } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

const ROOT = '';
const LIST_LIMIT = 500;

type PathMode = 'relative' | 'absolute';
type Tone = 'success' | 'error';
type PanelError = {
  code: string;
  title: string;
  detail: string;
  canRetry: boolean;
};
type EmptyIcon = 'folder' | 'search' | 'alert' | 'lock';

const ICON = {
  chevron:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  file:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5h7l4 4v13h-11Z"/><path d="M13.5 3.5v4h4"/><path d="M9 12h6M9 15.5h6"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3.6a2 2 0 0 1 1.4.6l1.5 1.4H18A2.5 2.5 0 0 1 20.5 9v8A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17Z"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4.5 21 19H3Z"/><path d="M12 9.5v4M12 16.2v.3"/></svg>',
  lock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>',
};

const host = connectHost();

const els = {
  rootLabel: el<HTMLElement>('#root-label'),
  refresh: el<HTMLButtonElement>('#refresh'),
  collapse: el<HTMLButtonElement>('#collapse'),
  modeRelative: el<HTMLButtonElement>('#mode-relative'),
  modeAbsolute: el<HTMLButtonElement>('#mode-absolute'),
  hidden: el<HTMLButtonElement>('#hidden'),
  search: el<HTMLInputElement>('#search'),
  clear: el<HTMLButtonElement>('#clear'),
  list: el<HTMLElement>('#list'),
  count: el<HTMLElement>('#count'),
  status: el<HTMLElement>('#status'),
  menu: el<HTMLElement>('#menu'),
  menuName: el<HTMLElement>('#menu-name'),
  menuOpen: el<HTMLButtonElement>('#menu-open'),
};

const state = {
  ready: false,
  directory: null as string | null,
  generation: 0,
  children: new Map<string, FileListEntry[]>(),
  loading: new Set<string>(),
  errors: new Map<string, PanelError>(),
  expanded: new Set<string>(),
  query: '',
  mode: 'relative' as PathMode,
  showHidden: false,
};

let statusTimer = 0;
let visibleCount = 0;
let menuTarget: { path: string; row: HTMLButtonElement } | null = null;

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function el<T extends Element>(selector: string): T {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`Missing element: ${selector}`);
  return node as T;
}

function isDirectory(entry: FileListEntry): boolean {
  return entry.kind === 'directory';
}

function isHidden(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return '';
  return name.slice(index + 1).toUpperCase().slice(0, 5);
}

function absolutePath(relative: string): string {
  const root = state.directory ?? '';
  const separator = root.includes('\\') ? '\\' : '/';
  const trimmed = root.replace(/[\\/]+$/, '');
  return `${trimmed}${separator}${relative.split('/').join(separator)}`;
}

function compareEntries(a: FileListEntry, b: FileListEntry): number {
  const aDirectory = isDirectory(a);
  const bDirectory = isDirectory(b);
  if (aDirectory !== bDirectory) return aDirectory ? -1 : 1;
  return collator.compare(a.name, b.name);
}

function normalizedQuery(): string {
  return state.query.trim().toLocaleLowerCase();
}

function isVisible(entry: FileListEntry, path: string, query: string): boolean {
  if (!state.showHidden && isHidden(entry.name)) return false;
  if (!query) return true;
  if (entry.name.toLocaleLowerCase().includes(query)) return true;
  if (!isDirectory(entry)) return false;

  const children = state.children.get(path);
  if (!children) return false;
  return children.some((child) => isVisible(child, joinPath(path, child.name), query));
}

function hasVisibleChild(path: string, query: string): boolean {
  const children = state.children.get(path);
  if (!children) return false;
  return children.some((child) => isVisible(child, joinPath(path, child.name), query));
}

function renderChrome(): void {
  const hasProject = Boolean(state.directory);
  const enabled = state.ready && hasProject;

  els.rootLabel.textContent = !state.ready
    ? '正在连接…'
    : hasProject
      ? baseName(state.directory as string)
      : '未打开项目';
  els.rootLabel.title = hasProject ? (state.directory as string) : '';

  els.modeRelative.setAttribute('aria-pressed', String(state.mode === 'relative'));
  els.modeAbsolute.setAttribute('aria-pressed', String(state.mode === 'absolute'));
  els.modeRelative.disabled = !enabled;
  els.modeAbsolute.disabled = !enabled;

  els.hidden.setAttribute('aria-pressed', String(state.showHidden));
  els.hidden.title = state.showHidden ? '隐藏点文件和 node_modules' : '显示点文件和 node_modules';
  els.hidden.setAttribute('aria-label', els.hidden.title);
  els.hidden.disabled = !enabled;

  els.collapse.disabled = !enabled || state.expanded.size === 0 || Boolean(state.query.trim());
  els.refresh.disabled = !enabled || state.loading.has(ROOT);
  els.search.disabled = !enabled;
}

function renderList(): void {
  closeMenu();
  if (!state.ready) {
    showSkeleton();
    els.count.textContent = '正在连接…';
    return;
  }

  if (!state.directory) {
    showEmpty('folder', '还没有打开项目', '在左侧选择一个项目，再打开路径面板。');
    els.count.textContent = '';
    return;
  }

  const rootError = state.errors.get(ROOT);
  if (rootError && !state.children.has(ROOT)) {
    showError(rootError);
    els.count.textContent = '';
    return;
  }

  if (!state.children.has(ROOT)) {
    showSkeleton();
    els.count.textContent = '读取中…';
    return;
  }

  const activePath = activeTreePath();
  const query = normalizedQuery();
  visibleCount = 0;

  const fragment = document.createDocumentFragment();
  appendEntries(fragment, state.children.get(ROOT) ?? [], ROOT, 0, query);

  if (visibleCount === 0) {
    if (query) {
      showEmpty('search', '没有匹配项', `“${state.query.trim()}”不在已加载的文件里。`, '清除筛选', () => clearQuery());
      els.count.textContent = '0 个匹配';
    } else if (!state.showHidden && (state.children.get(ROOT) ?? []).some((entry) => isHidden(entry.name))) {
      showEmpty('folder', '这里只有隐藏项', '点眼睛按钮显示点文件和 node_modules。', '显示隐藏项', () => setShowHidden(true));
      els.count.textContent = '0 项';
    } else {
      showEmpty('folder', '这个文件夹是空的', '把文件放进项目后，点刷新。');
      els.count.textContent = '0 项';
    }
    return;
  }

  els.list.replaceChildren(fragment);
  els.list.setAttribute('aria-busy', 'false');
  updateCount(query);
  if (activePath) focusRowByPath(activePath);
}

function appendEntries(
  parent: HTMLElement | DocumentFragment,
  entries: FileListEntry[],
  parentPathValue: string,
  depth: number,
  query: string,
): void {
  const matching = [...entries]
    .sort(compareEntries)
    .filter((entry) => isVisible(entry, joinPath(parentPathValue, entry.name), query));
  const shown = matching.slice(0, LIST_LIMIT);

  for (const entry of shown) {
    const path = joinPath(parentPathValue, entry.name);

    const node = document.createElement('div');
    node.className = 'tree-node';
    node.setAttribute('role', 'none');

    const row = renderRow(entry, path, depth);
    node.append(row);

    if (isDirectory(entry)) {
      const expanded = query ? state.expanded.has(path) || hasVisibleChild(path, query) : state.expanded.has(path);
      row.setAttribute('aria-expanded', String(expanded));
      row.classList.toggle('expanded', expanded);
      if (state.loading.has(path)) row.classList.add('is-loading');

      if (expanded) {
        const group = document.createElement('div');
        group.className = 'tree-group';
        group.setAttribute('role', 'group');
        appendChildren(group, path, depth + 1, query);
        node.append(group);
      }
    }

    parent.append(node);
    visibleCount += 1;
  }

  if (matching.length > shown.length) {
    parent.append(note(`还有 ${matching.length - shown.length} 项未显示`));
  }
}

function appendChildren(group: HTMLElement, path: string, depth: number, query: string): void {
  const error = state.errors.get(path);
  if (error) {
    group.append(errorNote(error, path));
    return;
  }

  const children = state.children.get(path);
  if (children) {
    const before = visibleCount;
    appendEntries(group, children, path, depth, query);
    if (state.loading.has(path)) {
      group.prepend(loadingNote());
    } else if (visibleCount === before) {
      group.append(note(query ? '没有匹配项' : '空文件夹'));
    }
    return;
  }

  if (state.loading.has(path)) {
    group.append(loadingNote());
    return;
  }

  group.append(loadingNote());
  void loadDir(path);
}

function renderRow(entry: FileListEntry, path: string, depth: number): HTMLButtonElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'row tree-row';
  row.dataset.path = path;
  row.dataset.kind = entry.kind;
  row.title = path;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(depth + 1));

  const lead = document.createElement('span');
  lead.className = 'row-lead';

  if (isDirectory(entry)) {
    lead.classList.add('chevron');
    lead.innerHTML = ICON.chevron;
  } else {
    lead.classList.add('file-mark');
    lead.innerHTML = ICON.file;
  }

  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = entry.name;

  const meta = document.createElement('span');
  meta.className = 'row-meta';
  if (!isDirectory(entry)) {
    meta.textContent = extensionOf(entry.name) || '文件';
  } else {
    meta.hidden = true;
  }

  row.append(lead, name, meta);
  row.addEventListener('click', () => {
    if (isDirectory(entry)) {
      toggleDir(path);
      return;
    }
    void insertEntry(path, row);
  });

  if (!isDirectory(entry)) {
    row.setAttribute('aria-haspopup', 'menu');
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      row.focus({ preventScroll: true });
      openMenu(path, row, event.clientX, event.clientY);
    });
  }

  return row;
}

function note(text: string): HTMLElement {
  const node = document.createElement('div');
  node.className = 'tree-note';
  node.textContent = text;
  return node;
}

function loadingNote(): HTMLElement {
  const node = document.createElement('div');
  node.className = 'tree-note';
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  node.append(spinner, document.createTextNode('读取中…'));
  return node;
}

function errorNote(error: PanelError, path: string): HTMLElement {
  const node = document.createElement('div');
  node.className = 'tree-note error';

  const text = document.createElement('span');
  text.textContent = error.title;
  text.title = error.detail;

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'mini-action';
  retry.textContent = '重试';
  retry.addEventListener('click', (event) => {
    event.stopPropagation();
    void loadDir(path);
  });

  node.append(text, retry);
  return node;
}

async function insertEntry(path: string, row: HTMLElement): Promise<void> {
  if (!state.directory) return;
  const text = state.mode === 'relative' ? path : absolutePath(path);

  try {
    await host.compose({ text, mode: 'append' });
    showStatus(`已插入 ${text}`, 'success');
    flashRow(row);
  } catch (error) {
    const message =
      error instanceof HostRequestError && error.code === 'NO_SESSION'
        ? '还没有打开对话，先在右侧开始一个会话。'
        : error instanceof Error
          ? error.message
          : '插入路径失败。';
    showStatus(message, 'error');
    void host.toast({ kind: 'error', message }).catch(() => undefined);
  }
}

function openMenu(path: string, row: HTMLButtonElement, x: number, y: number): void {
  menuTarget = { path, row };
  els.menuName.textContent = baseName(path);
  els.menuName.title = absolutePath(path);
  els.menu.hidden = false;

  // Measure at the origin before clamping so the menu never opens off-screen.
  els.menu.style.left = '0px';
  els.menu.style.top = '0px';
  const rect = els.menu.getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
  const top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin));
  els.menu.style.left = `${left}px`;
  els.menu.style.top = `${top}px`;

  els.menuOpen.focus({ preventScroll: true });
}

function closeMenu(restoreFocus = false): void {
  if (els.menu.hidden) return;
  const target = menuTarget;
  menuTarget = null;
  els.menu.hidden = true;
  if (restoreFocus) target?.row.focus({ preventScroll: true });
}

function serviceErrorText(body: string): string | null {
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === 'object' && 'error' in value) {
      const error = (value as { error?: unknown }).error;
      if (typeof error === 'string' && error.trim()) return error;
    }
  } catch {
    // The service can also answer with a non-JSON body; the status code is enough.
  }
  return null;
}

function describeOpenError(error: unknown): string {
  if (error instanceof HostRequestError) {
    switch (error.code) {
      case 'NO_SERVICE':
        return '本地打开服务未就绪。请确认已在 设置 → 扩展 → 路径面板 允许“本地服务”，然后重试。';
      case 'DISABLED':
        return '扩展已被停用，请在 设置 → 扩展 中重新启用路径面板。';
      case 'SERVICE_FAILED':
        return '本地打开服务启动失败，请重试；若反复失败，重新加载界面。';
      case 'REQUEST_FAILED':
        return '本地打开服务没有响应，请重试。';
      case 'NOT_GRANTED':
        return '需要本地服务权限。请到 设置 → 扩展 → 路径面板 允许“本地服务”。';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : '无法用默认应用打开。';
}

async function openPathWithDefaultApp(path: string): Promise<void> {
  if (!state.directory) return;

  try {
    const result = await host.serviceRequest({
      method: 'POST',
      path: '/open',
      body: JSON.stringify({ path: absolutePath(path) }),
    });

    if (result.status < 200 || result.status >= 300) {
      throw new Error(serviceErrorText(result.body) ?? `本地服务返回 ${result.status}。`);
    }

    showStatus(`已用默认应用打开 ${baseName(path)}`, 'success');
  } catch (error) {
    const message = describeOpenError(error);
    showStatus(message, 'error');
    void host.toast({ kind: 'error', message }).catch(() => undefined);
  }
}

function flashRow(row: HTMLElement): void {
  row.classList.remove('inserted');
  void row.offsetWidth;
  row.classList.add('inserted');
  window.setTimeout(() => row.classList.remove('inserted'), 1300);
}

function clearStatus(): void {
  window.clearTimeout(statusTimer);
  els.status.textContent = '';
  els.status.title = '';
  delete els.status.dataset.tone;
}

function showStatus(text: string, tone: Tone): void {
  clearStatus();
  els.status.textContent = text;
  els.status.title = text;
  els.status.dataset.tone = tone;
  statusTimer = window.setTimeout(clearStatus, tone === 'error' ? 6500 : 4000);
}

function updateCount(query: string): void {
  const suffix = state.loading.has(ROOT) ? ' · 读取中…' : '';
  els.count.textContent = query ? `${visibleCount} 个匹配${suffix}` : `${visibleCount} 项${suffix}`;
}

function showSkeleton(): void {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 7; index += 1) {
    const line = document.createElement('div');
    line.className = `skeleton w${(index % 5) + 1}`;
    fragment.append(line);
  }
  els.list.replaceChildren(fragment);
  els.list.setAttribute('aria-busy', 'true');
}

function showError(error: PanelError): void {
  const icon: EmptyIcon = error.code === 'NOT_GRANTED' ? 'lock' : 'alert';
  showEmpty(icon, error.title, error.detail, error.canRetry ? '重试' : undefined, error.canRetry ? () => void loadDir(ROOT) : undefined, error.code);
}

function showEmpty(
  icon: EmptyIcon,
  title: string,
  detail: string,
  actionLabel?: string,
  action?: () => void,
  code?: string,
): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'empty';

  const iconBox = document.createElement('div');
  iconBox.className = 'empty-icon';
  iconBox.innerHTML = ICON[icon];

  const titleNode = document.createElement('p');
  titleNode.className = 'empty-title';
  titleNode.textContent = title;

  const detailNode = document.createElement('p');
  detailNode.className = 'empty-detail';
  detailNode.textContent = detail;

  wrapper.append(iconBox, titleNode, detailNode);

  if (actionLabel && action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'empty-action';
    button.textContent = actionLabel;
    button.addEventListener('click', action);
    wrapper.append(button);
  }

  if (code) {
    const codeNode = document.createElement('p');
    codeNode.className = 'empty-code';
    codeNode.textContent = code;
    wrapper.append(codeNode);
  }

  els.list.replaceChildren(wrapper);
  els.list.setAttribute('aria-busy', 'false');
}

function describeError(error: unknown): PanelError {
  const code = error instanceof HostRequestError ? error.code : 'UNKNOWN';
  switch (code) {
    case 'NOT_GRANTED':
      return {
        code,
        title: '需要文件权限',
        detail: '请到 设置 → 扩展 → 路径面板 允许“读写项目文件”，然后重试。',
        canRetry: true,
      };
    case 'NO_DIRECTORY':
      return {
        code,
        title: '还没有打开项目',
        detail: '在左侧选择一个项目后再打开路径面板。',
        canRetry: false,
      };
    case 'DISABLED':
      return {
        code,
        title: '扩展已被停用',
        detail: '请在 设置 → 扩展 中启用路径面板。',
        canRetry: false,
      };
    case 'BAD_PATH':
      return {
        code,
        title: '这个文件夹不可用',
        detail: '它可能已被移动或删除。刷新后再试。',
        canRetry: true,
      };
    case 'DISCONNECTED':
    case 'HOST_UNAVAILABLE':
    case 'HOST_TIMEOUT':
      return {
        code,
        title: '与 OpenChamber 的连接中断',
        detail: '稍等片刻后重试。',
        canRetry: true,
      };
    default:
      return {
        code,
        title: '读取文件夹失败',
        detail: error instanceof Error ? error.message : String(error),
        canRetry: true,
      };
  }
}

function toggleDir(path: string): void {
  if (state.expanded.has(path)) {
    state.expanded.delete(path);
    renderChrome();
    renderList();
    return;
  }

  state.expanded.add(path);
  renderChrome();

  if (!state.children.has(path) && !state.loading.has(path) && !state.errors.has(path)) {
    void loadDir(path);
    return;
  }

  renderList();
}

function collapseAll(): void {
  if (state.expanded.size === 0) return;
  state.expanded.clear();
  renderChrome();
  renderList();
}

async function loadDir(path: string, options: { keepStale?: boolean } = {}): Promise<boolean> {
  if (!state.directory || state.loading.has(path)) return false;

  const generation = state.generation;
  state.loading.add(path);
  state.errors.delete(path);
  renderChrome();
  renderList();

  try {
    const result = await host.listDir(path || '.');
    if (generation !== state.generation) return false;
    state.children.set(path, result.entries);
    return true;
  } catch (error) {
    if (generation !== state.generation) return false;

    const panelError = describeError(error);
    if (options.keepStale && state.children.has(path)) {
      showStatus(`刷新失败：${panelError.title}`, 'error');
    } else {
      state.children.delete(path);
      state.errors.set(path, panelError);
    }
    return false;
  } finally {
    if (generation === state.generation) {
      state.loading.delete(path);
      renderChrome();
      renderList();
    }
  }
}

async function refreshAll(): Promise<void> {
  if (!state.directory) return;

  const paths = [ROOT, ...state.expanded];
  const results = await Promise.all(paths.map((path) => loadDir(path, { keepStale: true })));
  if (results.every(Boolean)) showStatus('已刷新', 'success');
}

function setDirectory(directory: string | null): void {
  if (directory === state.directory) {
    if (directory && !state.children.has(ROOT) && !state.loading.has(ROOT)) {
      void loadDir(ROOT);
    } else if (state.ready) {
      renderList();
    }
    return;
  }

  state.directory = directory;
  state.generation += 1;
  state.children.clear();
  state.loading.clear();
  state.errors.clear();
  state.expanded.clear();
  state.query = '';
  visibleCount = 0;

  els.search.value = '';
  els.clear.hidden = true;
  clearStatus();

  renderChrome();
  renderList();

  if (directory) {
    void loadDir(ROOT);
  } else {
    els.search.blur();
  }
}

function clearQuery(focus = true): void {
  state.query = '';
  els.search.value = '';
  els.clear.hidden = true;
  renderChrome();
  renderList();
  if (focus) els.search.focus();
}

function setMode(mode: PathMode): void {
  if (state.mode === mode) return;
  state.mode = mode;
  renderChrome();
  void host.storage.set('path-mode', mode).catch(() => undefined);
}

function setShowHidden(value: boolean): void {
  state.showHidden = value;
  renderChrome();
  renderList();
  void host.storage.set('show-hidden', value).catch(() => undefined);
}

function treeRows(): HTMLButtonElement[] {
  return Array.from(els.list.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'));
}

function activeTreePath(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !els.list.contains(active)) return null;
  return active.dataset.path ?? null;
}

function focusRowByPath(path: string): void {
  const row = treeRows().find((candidate) => candidate.dataset.path === path);
  row?.focus({ preventScroll: true });
}

function focusRow(index: number): void {
  const rows = treeRows();
  if (rows.length === 0) return;
  const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
  row?.focus();
  row?.scrollIntoView({ block: 'nearest' });
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

async function restorePreferences(): Promise<void> {
  const [mode, hidden] = await Promise.all([
    host.storage.get('path-mode').catch(() => undefined),
    host.storage.get('show-hidden').catch(() => undefined),
  ]);
  if (mode === 'relative' || mode === 'absolute') state.mode = mode;
  if (typeof hidden === 'boolean') state.showHidden = hidden;
  renderChrome();
  renderList();
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  state.ready = true;

  const directory = context.directory ?? null;
  if (directory !== state.directory) {
    setDirectory(directory);
    return;
  }

  renderChrome();
  if (directory && !state.children.has(ROOT) && !state.loading.has(ROOT)) {
    void loadDir(ROOT);
  } else {
    renderList();
  }
});

host.onDirectory((directory) => {
  setDirectory(directory ?? null);
});

els.refresh.addEventListener('click', () => void refreshAll());
els.collapse.addEventListener('click', collapseAll);
els.modeRelative.addEventListener('click', () => setMode('relative'));
els.modeAbsolute.addEventListener('click', () => setMode('absolute'));
els.hidden.addEventListener('click', () => setShowHidden(!state.showHidden));

els.search.addEventListener('input', () => {
  state.query = els.search.value;
  els.clear.hidden = !state.query;
  renderChrome();
  renderList();
});

els.search.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.query) {
    event.preventDefault();
    clearQuery();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    focusRow(0);
  }
});

els.clear.addEventListener('click', () => clearQuery());

els.menuOpen.addEventListener('click', () => {
  const target = menuTarget;
  closeMenu();
  if (target) void openPathWithDefaultApp(target.path);
});

els.menu.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu(true);
    return;
  }
  if (event.key === 'Tab') closeMenu();
});

document.addEventListener(
  'pointerdown',
  (event) => {
    if (els.menu.hidden) return;
    if (event.target instanceof Node && els.menu.contains(event.target)) return;
    closeMenu();
  },
  true,
);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.menu.hidden) {
    event.preventDefault();
    closeMenu(true);
  }
});

window.addEventListener('blur', () => closeMenu());
window.addEventListener('resize', () => closeMenu());
document.addEventListener('scroll', () => closeMenu(), true);

els.list.addEventListener('keydown', (event) => {
  const rows = treeRows();
  if (rows.length === 0) return;

  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  const row = index >= 0 ? rows[index] : undefined;

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      focusRow(index + 1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      if (index <= 0) els.search.focus();
      else focusRow(index - 1);
      break;
    case 'Home':
      event.preventDefault();
      focusRow(0);
      break;
    case 'End':
      event.preventDefault();
      focusRow(rows.length - 1);
      break;
    case 'ArrowRight':
      if (!row || row.dataset.kind !== 'directory') return;
      event.preventDefault();
      if (row.getAttribute('aria-expanded') === 'true') focusRow(index + 1);
      else toggleDir(row.dataset.path ?? '');
      break;
    case 'ArrowLeft': {
      if (!row) return;
      event.preventDefault();
      const path = row.dataset.path ?? '';
      if (row.dataset.kind === 'directory' && row.getAttribute('aria-expanded') === 'true') {
        toggleDir(path);
        return;
      }
      const parent = parentPath(path);
      if (parent) focusRowByPath(parent);
      else els.search.focus();
      break;
    }
  }
});

document.addEventListener('keydown', (event) => {
  if (
    event.key === '/' &&
    !event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    state.ready &&
    state.directory &&
    !isTypingTarget(event.target)
  ) {
    event.preventDefault();
    els.search.focus();
    els.search.select();
  }
});

renderChrome();
renderList();
void restorePreferences();
