# 路径面板

OpenChamber 扩展：以树形浏览当前工作区的文件，点一下就把路径插入输入框。适合在对话里引用表格、脚本、日志等工作区文件。

## 功能

- 项目文件树，文件夹就地展开，不用逐层点进去
- 文件夹可展开/收起，工具栏可一键全部收起
- 目录优先、按名称自然排序
- 筛选文件树（已加载的文件夹），`/` 聚焦筛选框，`Esc` 清空
- 点击文件插入路径，多次插入自动以换行分隔
- 右键文件可用系统默认应用打开
- 右键文件或文件夹可在系统文件管理器中显示（访达 / 资源管理器）
- 右键文件夹可把该文件夹的路径插入输入框
- 右键文件或文件夹可删除，删除项用红色标注，需要再点一次「确认删除？」
- `相对路径` / `绝对路径` 一键切换，偏好会记住
- 默认隐藏点文件和 `node_modules`，可用眼睛按钮显示
- 读取失败、未授权、未打开项目时有明确提示和重试入口

## 使用

1. 在 OpenChamber 左侧打开一个项目。
2. 从右侧面板栏打开「路径面板」。
3. 点文件夹前的箭头展开，点文件即可把路径插入当前对话输入框。
4. 右键文件夹，选择「插入路径」，不需要先点进这个文件夹就能插到它的路径。
5. 右键文件，选择「用默认应用打开」，用系统关联的应用打开它。
6. 右键文件或文件夹，选择「在文件管理器中显示」，会在访达（macOS）或资源管理器（Windows）里定位到它；Linux 上打开所在目录。
7. 右键任意文件或文件夹，选择「删除」（红色），再点一次「确认删除？」才真正删除。macOS 上会移到废纸篓，Windows 上移到回收站（网络盘等回收站不可用的情况直接删除），其他系统直接删除，且只能删项目目录内的内容。

相对路径以当前项目根目录为基准，例如 `data/2026-10.xlsx`；绝对路径是项目目录加相对路径，在 macOS 上形如 `/Users/me/project/data/2026-10.xlsx`，在 Windows 上是本机分隔符的写法，例如 `D:\code\project\data\2026-10.xlsx`。面板不会自动加 `@`，插入的是纯文本路径。

键盘：`↑`/`↓` 在文件树中移动，`→` 展开文件夹，`←` 收起文件夹或回到上一级，`Enter` 展开或插入，`/` 聚焦筛选框，`Esc` 清空筛选。

## 安装

在 OpenChamber 的 `设置 → 扩展` 里选择「从文件夹安装」，指向本项目目录（即包含 `package.json`、`panel/` 和 `service/` 的目录）。

也可以在 `~/.config/openchamber/extensions.json` 的 `paths` 数组中加入该路径，然后重启 OpenChamber。

首次打开面板需要在扩展设置里批准 `files`（读写项目文件）权限。右键「用默认应用打开」还需要批准 `service`（本地服务）权限；服务进程只监听本机回环地址，用一次性令牌校验请求。

更新到带本地服务的版本后，如果扩展卡片显示「需要批准」，在 `设置 → 扩展 → 路径面板` 里重新「允许并启用」即可。

## 开发

```bash
npm install
npm run build      # esbuild -> panel/main.js
npm run typecheck  # tsc --noEmit
```

`node_modules` 里的 esbuild 二进制是分平台的（macOS arm64、Windows x64 各不相同）。在两个系统之间同步项目目录时不要同步 `node_modules`，到另一个系统后先删掉它再 `npm install`，否则 `npm run build` 会报找不到 esbuild 的可执行文件。

结构：

```
src/panel.ts       面板逻辑（TypeScript）
panel/index.html   面板页面
panel/style.css    面板样式（使用宿主主题变量）
panel/main.js      构建产物，需提交/保留
service/main.js    本地服务：默认应用打开、在文件管理器中显示、删除文件/文件夹
build.mjs          esbuild 打包脚本
icon.svg           面板图标
```

面板运行在 sandbox iframe 中，只能加载包内资源，脚本必须打包成 IIFE；`panel/main.js` 缺失时扩展安装检查会失败。

## 权限

- `files`：用于 `host.listDir` 读取项目目录。面板只调用目录列表接口，不会改写文件。
- `service` + `exec`：右键打开文件、在文件管理器中显示或删除时，宿主启动 `service/main.js`。打开文件调用系统 `open`（macOS）、`explorer.exe`（Windows）或 `xdg-open`（Linux）；显示用 `open -R`、`explorer.exe /select,`，Linux 上打开所在目录；删除在 macOS 上移入 `~/.Trash`，在 Windows 上通过一个隐藏的 PowerShell 进程调用 `SHFileOperation`（`FOF_ALLOWUNDO`）移入回收站，回收站不可用时（网络盘、只读文件）退回 `fs.rm` 直接删除，其他系统直接删除。Windows 上还有两点特殊处理：路径先换成反斜杠的本机写法，`/select,` 与路径分成两个参数（否则资源管理器会打开错误的位置）；资源管理器改由 PowerShell 的 `Start-Process -WindowStyle Normal` 启动，因为宿主是隐藏启动服务的，直接 spawn 会让新窗口继承隐藏状态——表现为「提示成功但看不到窗口」，启动后再把该窗口切到前台，实在抢不到前台时闪一下任务栏。服务只监听 `127.0.0.1`，每个请求都校验宿主注入的 Bearer 令牌；删除只接受存在、绝对且位于项目目录内的路径（项目根目录本身不允许删除）；空闲 60 秒后自行退出，下次右键再启动。

没有声明 `prompt`，插入路径走 `host.compose`，不需要发送消息的权限。
