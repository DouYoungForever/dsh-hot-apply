- [x] I added **one file** at `data/plugins/DouYoungForever__dsh-hot-apply.yml` — that single file is the whole submission.
- [x] My repo's `package.json` declares **`dsh.bundle`** (`dsh.bundle.patch: ./cordis.patch.yml`, plus `dsh.client` for the browser half).
- [x] My repo is at least **1 day old** — created 2026-11-09T06:40:41Z, this PR was opened after it passed that mark.
- [x] `category: dev` — it is a developer tool: it applies plugin changes to the running composition and restarts the desktop app when a restart is really needed.
- [x] Description states what the plugin does, no superlatives.
- [x] My repo has the `dsh-plugin` topic.

The plugin has two halves. The host half watches the profile's plugin directories, runs the HMR reconcile pass and serves a local HTTP API (`/hot-apply/status`, `/hot-apply/restart`, `/hot-apply/apply`, `/hot-apply/config`). The web half registers a restart pill in `shell.overlay`, a settings page under `settings.plugins.tab` and a button in `plugins.detail.actions`.

A restart hands a generated helper script to `explorer.exe`. The helper is therefore not a child of the app's job object and survives the app exiting: it closes the main window, waits for the old process to go away, starts the new one and brings its window to the front. Capability detection returns a reason (`platform-unsupported`, `not-desktop-host`, `executable-missing`, `parent-missing`) instead of failing silently, and the web half shows that reason in place of the button.

The package is pure JavaScript with no runtime dependencies beyond `react`, which the host already provides. It does not patch `app.asar`, does not create scheduled tasks, and an `unpatch-shell` bin ships only to clean up the old 0.2.x tray patch if someone had it installed.
