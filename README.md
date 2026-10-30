# 路径面板

OpenChamber 扩展：以树形浏览当前工作区的文件，点一下就把路径插入输入框。适合在对话里引用表格、脚本、日志等工作区文件。

## 功能

- 项目文件树，文件夹就地展开，不用逐层点进去
- 文件夹可展开/收起，工具栏可一键全部收起
- 目录优先、按名称自然排序
- 筛选文件树（已加载的文件夹），`/` 聚焦筛选框，`Esc` 清空
- 点击文件插入路径，多次插入自动以换行分隔
- 右键文件可用系统默认应用打开
- `相对路径` / `绝对路径` 一键切换，偏好会记住
- 默认隐藏点文件和 `node_modules`，可用眼睛按钮显示
- 读取失败、未授权、未打开项目时有明确提示和重试入口

## 使用

1. 在 OpenChamber 左侧打开一个项目。
2. 从右侧面板栏打开「路径面板」。
3. 点文件夹前的箭头展开，点文件即可把路径插入当前对话输入框。
4. 右键文件，选择「用默认应用打开」，用系统关联的应用打开它。

相对路径以当前项目根目录为基准，例如 `data/2026-10.xlsx`；绝对路径是项目目录加相对路径，例如 `/Users/me/project/data/2026-10.xlsx`。面板不会自动加 `@`，插入的是纯文本路径。

键盘：`↑`/`↓` 在文件树中移动，`→` 展开文件夹，`←` 收起文件夹或回到上一级，`Enter` 展开或插入，`/` 聚焦筛选框，`Esc` 清空筛选。

## 安装

在 OpenChamber 的 `设置 → 扩展` 里选择「从文件夹安装」，指向本目录：

```
/Users/sean/Projects/openchamber-path-picker
```

也可以在 `~/.config/openchamber/extensions.json` 的 `paths` 数组中加入该路径，然后重启 OpenChamber。

首次打开面板需要在扩展设置里批准 `files`（读写项目文件）权限。右键「用默认应用打开」还需要批准 `service`（本地服务）权限；服务进程只监听本机回环地址，用一次性令牌校验请求。

更新到带本地服务的版本后，如果扩展卡片显示「需要批准」，在 `设置 → 扩展 → 路径面板` 里重新「允许并启用」即可。

## 开发

```bash
npm install
npm run build      # esbuild -> panel/main.js
npm run typecheck  # tsc --noEmit
```

结构：

```
src/panel.ts       面板逻辑（TypeScript）
panel/index.html   面板页面
panel/style.css    面板样式（使用宿主主题变量）
panel/main.js      构建产物，需提交/保留
service/main.js    本地服务：用系统默认应用打开文件
build.mjs          esbuild 打包脚本
icon.svg           面板图标
```

面板运行在 sandbox iframe 中，只能加载包内资源，脚本必须打包成 IIFE；`panel/main.js` 缺失时扩展安装检查会失败。

## 权限

- `files`：用于 `host.listDir` 读取项目目录。面板只调用目录列表接口，不会改写文件。
- `service` + `exec`：右键打开文件时，宿主启动 `service/main.js`，由它调用系统 `open`（macOS）、`explorer.exe`（Windows）或 `xdg-open`（Linux）。服务只监听 `127.0.0.1`，每个请求都校验宿主注入的 Bearer 令牌，只接受存在且绝对路径的文件；空闲 60 秒后自行退出，下次右键再启动。

没有声明 `prompt`，插入路径走 `host.compose`，不需要发送消息的权限。
