# dsh-hot-apply

让插件更新在**当前进程内**生效，而不是弹出「请重启 DSH 使更改生效」；真需要重启时，一键把自己重新拉起来。

## 为什么需要它

DSH 自带的 HMR（`hmr` 服务）已经能在安装 / 启用 / 停用后重组 Loader 树，但有两件事不在它的默认覆盖里：

1. **已装插件的文件在磁盘上变了**（本地联调包、重新构建的 `client.js`、`pnpm` 就地覆盖）。
   `hmr` 的默认 `ignored` 含 `**/node_modules`，所以它不会主动去监听这些文件；只有被显式调用 `reconcileProfile()` 时才会比对。
2. **版本切换**：`pluginManager` 的「更新」是 `removeBundle` + `installBundle`，官方页面在 `restartReason` 非空时提示重启；而市场安装需要绕开「删除后再装」的两个独立事务。

## 它做了什么

- **监听**：对 profile 下每个已装包的真实目录（含符号链接目标）建立 `fs.watch(..., { recursive: true })`，另监听 `node_modules` 根目录，识别结构变化（新增 / 移除包）。监听失败时退化为 3 秒一次的指纹轮询。
- **应用**：文件变化去抖 1.2 秒后调用
  ```js
  hmr.runExclusive(() => hmr.reconcileProfile([]))
  ```
  `reconcileProfile` 会比对已加载模块与磁盘文件、驱逐变化模块、停掉拥有它们的 Loader entry，再按当前文件重新导入 —— 宿主半区就此更换代码，进程与会话都不中断。
- **脱离事务上下文**：`fs.watch` 回调是在插件激活（一个 HMR 事务）里创建的，`AsyncLocalStorage` 会把那个事务带进回调，导致 `runExclusive` 报 `HMR transactions cannot be nested`。所以真正调用前会先 `hmr.executing.exit(fn)` 退出继承来的事务上下文。
- **免重启更新**：详情页按钮走 `removeBundle` → `installBundle` → `reconcileProfile`。新版本落在一个新的真实目录，装载与旧目录无关，因此不会触发 `package-moved`。
- **结果上报**：`applied` / `partial` / `restart-required` / `error`，并把 `pending` 模块与 `restartReason` 翻译成人话（例如「插件包解析到了新目录」「涉及 DSH 自身已加载的模块」）。

## 一键重启

`POST /hot-apply/restart {"mode":"hard"}`。宿主半区把当前 Electron 主进程 PID 与可执行文件路径（`process.execPath`）交给一个**脱离应用进程树、也不登记任何持久化项**的助手：

1. 用 `explorer.exe "relaunch.vbs"` 交接：资源管理器创建的子进程不在 DSH 的 job object 里，因此主进程被杀掉后它仍然活着；`.vbs` 由 `wscript` 运行，全程无控制台窗口。
2. 助手（`relaunch.ps1`，`-WindowStyle Hidden`）等 1.2 秒 → `CloseMainWindow()` → 1.5 秒后仍在就 `Stop-Process -Force` → 等进程真正退出（最多 15 秒）。
3. 用 `explorer.exe "<DeepSeek Harness.exe>"` 启动应用——等同双击，由资源管理器创建、不带控制台，因此关掉任何终端都不会连带关掉 DSH；9 秒内没检测到进程则 `Start-Process` 兜底。
4. 用 user32 `EnumWindows` + `ShowWindowAsync(SW_RESTORE, SW_SHOW)` + `SetForegroundWindow` 把主窗口显示并置前（最多等 30 秒），避免出现「只剩托盘图标、要点右键打开」的情况。
5. 不建计划任务、不注册开机项、不写应用安装目录；助手文件只落在 `<profile>/.hot-apply/`（`relaunch.ps1` / `relaunch.cmd` / `relaunch.vbs` / `relaunch.log`），可随时删除，下次点击会重新生成。

若 `explorer` 交接 12 秒内没有产出 `helper start` 日志，插件会退回到两条更粗糙的路径（WMI `Win32_Process.Create` → 分离的 PowerShell 子进程），并把每一次尝试写进 `<profile>/.hot-apply/apply.log`。

其他开关：

- **只重新加载插件模块**：`{"mode":"soft"}`。给所有已装插件的 `.js/.mjs/.cjs` 打上新的 mtime，再走一次 `reconcileProfile()`；不关窗口、不重启进程，但 DSH 自身模块的改动仍需重启。
- **重启前先收尾**：`stopTasks: true` 会杀掉所有 `running/stopping` 的后台 job，并在界面上提示当前有几个任务在跑。
- **自检**：`{"mode":"hard","dryRun":true}` 只写出 `relaunch.ps1` / `relaunch.cmd` / `relaunch.vbs` 并回显内容，不真的重启。

## 支持范围

重启是桌面应用专属能力：宿主要能拿到一个有窗口的 Electron 可执行文件。不满足时接口返回 `409` 和 `error` 代码，界面显示对应说明，插件其余功能（监听 / 免重启应用）照常工作：

| `error` | 含义 |
| --- | --- |
| `platform-unsupported` | 不是 Windows |
| `not-desktop-host` | 宿主不在桌面应用里（例如 `dsh` CLI，或可执行文件旁没有 `resources/app.asar`） |
| `executable-missing` | `process.execPath` 不可用 |
| `parent-missing` | 拿不到父进程 PID |

## 界面

- **右下角悬浮按钮「重启 DSH」**：`shell.overlay` 里的常驻胶囊按钮，任何页面都点得到，一键重启。
- **设置 → 插件 → 一键重启**：重启按钮、只重新加载插件模块的按钮、当前版本、最近一次结果、不支持时的原因。
- **插件详情页头部**：「重启 DSH」按钮。
- 客户端半区不再依赖 locale 字典与异步状态渲染，按钮在首帧就存在。

## HTTP 接口（同源）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/hot-apply/status` | 版本、开关、最近一次结果、包与监听状态、重启能力 |
| POST | `/hot-apply/apply` | 立即比对并应用 |
| POST | `/hot-apply/config` | `{ auto: boolean }` |
| POST | `/hot-apply/update` | `{ name: string }`，先卸载再安装再应用 |
| POST | `/hot-apply/restart` | `{ mode: "hard" \| "soft", stopTasks?: boolean, dryRun?: boolean }` |
| GET | `/hot-apply/bundles` | `pluginManager.listBundles()` 的精简视图 |

状态持久化在 `<profile>/.hot-apply/state.json`（开关与最近一次结果，插件自身重载后仍然可读）。

## 安装

```bash
dsh plugin install dsh-hot-apply
```

或在 profile 的 `package.json` 里加依赖后重启一次。桌面应用里也可以直接把本地目录 link 进 `node_modules` 做联调。

## 从 0.2.x 升级

0.2.6 及更早的版本会把「重启 DSH」写进桌面应用的托盘菜单——那需要原地改写 `resources/app.asar` 内的 `lib/main.js`，本次起已彻底移除。跑过旧版本的机器上，托盘里那一项会一直留着，直到把被改写的入口还原：

```bash
# 装在 profile 里（路径按自己的 DSH_HOME 调整）
node "C:\Users\<you>\.dsh\profiles\desktop\node_modules\dsh-hot-apply\scripts\unpatch-shell.mjs"

# 或者从源码目录、手动指定安装位置
node scripts/unpatch-shell.mjs --install "D:\deepseek_harness"
```

不带参数时会自动探测 `%LOCALAPPDATA%\Programs\DeepSeek Harness`、`%ProgramFiles%\DeepSeek Harness` 等常见位置。

脚本会定位 `app.asar` 的 `lib/main.js`，删掉带 `hot-apply:restart-item` 标记的那一段，把字节长度补回原值，并把还原前的入口备份到 `<profile>/.hot-apply/main-entry-backup.js`。**重启 DSH 之后**托盘项才会消失。没跑过 0.2.x 的机器不需要执行。

## 边界

- 若更改触及 DSH 自身已加载的模块（`host-module`），或插件不由插件列表管理（`unmanaged-plugin`），HMR 会把它列为 `pending`，本插件如实显示「需要重启」，不会假装成功。
- 本插件不能更新自己：卸载会先摘掉正在执行该请求的宿主半区。
- 极少数环境（企业策略禁用脚本宿主、`wscript` 被拦截）下助手起不来，插件会退到分离子进程；仍失败时应用只是没关掉，不会丢数据。

## 许可

MIT
