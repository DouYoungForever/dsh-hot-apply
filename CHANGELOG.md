# Changelog

## 0.3.0

市场版本：不再触碰桌面应用本体，也不再登记任何持久化项。

- 移除托盘菜单补丁。0.2.x 会原地改写 `resources/app.asar` 里的 `lib/main.js`，把「重启 DSH」插进托盘菜单——这会改动安装目录、没有卸载路径、应用升级后失效，且在 `Program Files` 下没有写权限。该功能整体删除，插件不再读写 `app.asar`。
- 移除计划任务。0.2.x 通过 `schtasks.exe /create` + `wscript //B` 拉起重启助手，会在系统里留下一次性任务。现在改用 `explorer.exe "relaunch.vbs"` 交接：资源管理器创建的子进程不在应用的 job object 里，主进程退出后仍存活，且不带控制台。
- 助手的健壮性：交接后 12 秒内没有 `helper start` 日志，就退回 WMI `Win32_Process.Create`，再退回分离的 PowerShell 子进程；每次尝试都写进 `<profile>/.hot-apply/apply.log`。
- 重启能力自检：`GET /hot-apply/status` 的 `restart.supported` 与 `restart.reason` 给出明确原因，`POST /hot-apply/restart` 在不可用时返回 `409`；界面据此显示「为什么不能重启」，而不是按钮永远可点。
- 修正客户端读取能力位时用了 `status.supported`（永远为真）的问题。
- 新增 `scripts/unpatch-shell.mjs`：把 0.2.x 写进 `app.asar` 的托盘项还原，并备份原入口。
- manifest 补齐发布所需字段：`license`、`keywords`、`engines`、`files`、`icon`、`dsh.manifestVersion`、`dsh.client.external`、`dsh.compatibility.dshReleases`、`peerDependencies`。

## 0.2.6

- 托盘菜单加入「重启 DSH」（已移除，见 0.3.0）。
- 修复若干本地化字符串里的乱码。

## 0.2.4

- 新增一键重启：`POST /hot-apply/restart`。
- 新增 `stopTasks`，重启前收掉后台 job。

## 0.2.2

- 界面改为常驻悬浮胶囊 + 设置页 + 插件详情页按钮。
- 客户端半区去掉 locale 字典与异步状态渲染。

## 0.2.1

- 免重启更新：`removeBundle` → `installBundle` → `reconcileProfile`。

## 0.2.0

- 所有 watcher 与定时器 `unref()`，不再阻止宿主在 10 秒内优雅退出。

## 0.1.0

- 首个版本：监听 profile 内插件文件，变更后 `reconcileProfile()`。
