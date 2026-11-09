import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'

/**
 * Host half of Plugin Hot Apply.
 *
 * It watches the packages installed in the current profile and, when their files
 * change on disk, asks the HMR service to reconcile the running Loader tree. The
 * reconcile evicts the changed modules and restarts the entries that own them, so
 * the newest code runs in the same process — no app restart, no lost session.
 *
 * `pluginManager` already reconciles after install/enable/disable. This plugin
 * covers the cases it does not: files edited or rebuilt in place, and version
 * swaps that are safer as remove → install → reconcile.
 */

export const name = 'hot-apply'
export const inject = ['webServer', 'hmr', 'pluginManager']

const VERSION = '0.3.0'
const APPLY_DEBOUNCE_MS = 1200
const SETTLE_MS = 250
const PACKAGE_CACHE_MS = 4000
const POLL_INTERVAL_MS = 3000
const MAX_POLL_DEPTH = 3
const RELAUNCH_DELAY_MS = 1200
const RELAUNCH_KILL_GRACE_MS = 1500
const RELAUNCH_WAIT_MS = 15000
const RELAUNCH_VERIFY_MS = 12000
const SOFT_TOUCH_LIMIT = 4000
const IGNORED_FILE = /(^|[\\/])(\.git|\.hg|\.svn|\.hot-apply|\.cache|\.turbo)([\\/]|$)|\.(log|tmp|swp|swx|map)$|~$/i

const state = {
  auto: true,
  lastApply: null,
  packages: [],
  packagesAt: 0,
  applying: null,
  queued: false,
  applyTimer: null,
  watchers: [],
  watchedReal: new Set(),
  rootWatcher: null,
  pollTimer: null,
  pollFingerprint: new Map(),
  restarting: null,
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function resolveProfileDir() {
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (fromEnv && fromEnv.length > 0) return fromEnv
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'profiles', process.env.DSH_PROFILE || 'desktop')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function readManifest(dir) {
  return readJson(path.join(dir, 'package.json'))
}

function isManagedPackage(dir, declared) {
  const manifest = readManifest(dir)
  if (manifest === undefined) return undefined
  if (declared.has(manifest.name)) return manifest
  if (manifest.dsh !== undefined) return manifest
  return undefined
}

function declaredNames(profileDir) {
  const names = new Set()
  const manifest = readJson(path.join(profileDir, 'package.json'))
  const dependencies = manifest?.dependencies ?? {}
  for (const key of Object.keys(dependencies)) names.add(key)
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  for (const entry of bundles) {
    if (typeof entry === 'string') names.add(entry)
    else if (entry && typeof entry.name === 'string') names.add(entry.name)
  }
  return names
}

function listPackageDirs(profileDir) {
  const modules = path.join(profileDir, 'node_modules')
  if (!fs.existsSync(modules)) return []
  const declared = declaredNames(profileDir)
  const found = []
  let entries = []
  try {
    entries = fs.readdirSync(modules)
  } catch {
    return []
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const full = path.join(modules, entry)
    const candidates = entry.startsWith('@')
      ? (() => {
          try {
            return fs.readdirSync(full).map(child => ({ name: `${entry}/${child}`, dir: path.join(full, child) }))
          } catch {
            return []
          }
        })()
      : [{ name: entry, dir: full }]
    for (const candidate of candidates) {
      const manifest = isManagedPackage(candidate.dir, declared)
      if (manifest === undefined) continue
      let real = candidate.dir
      try {
        real = fs.realpathSync(candidate.dir)
      } catch {
        continue
      }
      found.push({
        name: manifest.name ?? candidate.name,
        version: typeof manifest.version === 'string' ? manifest.version : '',
        dir: candidate.dir,
        real,
        bundle: manifest.dsh?.bundle !== undefined,
        client: manifest.dsh?.client !== undefined,
        watching: false,
      })
    }
  }
  found.sort((left, right) => left.name.localeCompare(right.name))
  return found
}

function refreshPackages(profileDir) {
  state.packages = listPackageDirs(profileDir)
  state.packagesAt = Date.now()
  return state.packages
}

function packagesNow(profileDir) {
  if (Date.now() - state.packagesAt > PACKAGE_CACHE_MS) refreshPackages(profileDir)
  return state.packages
}

function disposeWatchers() {
  for (const watcher of state.watchers) {
    try {
      watcher.close()
    } catch {
      // already closed
    }
  }
  state.watchers = []
  state.watchedReal = new Set()
  if (state.rootWatcher !== null) {
    try {
      state.rootWatcher.close()
    } catch {
      // already closed
    }
    state.rootWatcher = null
  }
  for (const entry of state.packages) entry.watching = false
}

function scheduleApply(ctx, cause) {
  if (!state.auto && cause !== 'manual') return
  if (state.applyTimer !== null) clearTimeout(state.applyTimer)
  state.applyTimer = setTimeout(() => {
    state.applyTimer = null
    void runApply(ctx, cause)
  }, APPLY_DEBOUNCE_MS)
  // A pending debounce must never keep the Host alive: the desktop updater only
  // waits 10 s for the Host to exit, and a live timer would hide that exit.
  state.applyTimer.unref?.()
}

function normalize(result, cause, startedAt) {
  const pending = (result.pending ?? []).map(entry => ({ url: entry.url, reason: entry.reason }))
  const restartReason = result.restartReason
  const status = restartReason !== undefined ? 'restart-required' : pending.length > 0 ? 'partial' : 'applied'
  return {
    at: Date.now(),
    cause,
    status,
    restartReason,
    pending,
    warnings: result.warnings ?? [],
    durationMs: Date.now() - startedAt,
  }
}

async function runApply(ctx, cause) {
  if (state.applying !== null) {
    state.queued = true
    return state.applying
  }
  const startedAt = Date.now()
  const promise = (async () => {
    try {
      // Give an editor or a build that is still writing time to settle.
      await sleep(SETTLE_MS)
      // Watchers are created during plugin activation, which runs inside an HMR
      // transaction. AsyncLocalStorage carries that transaction into every later
      // callback, and runExclusive refuses to nest. Leave the inherited context first.
      const hmr = ctx.hmr
      const reconcile = () => hmr.runExclusive(() => hmr.reconcileProfile([]))
      const result = await (hmr?.executing !== undefined && typeof hmr.executing.exit === 'function'
        ? hmr.executing.exit(reconcile)
        : reconcile())
      state.lastApply = normalize(result, cause, startedAt)
    } catch (error) {
      state.lastApply = {
        at: Date.now(),
        cause,
        status: 'error',
        error: String(error?.message ?? error),
        pending: [],
        warnings: [],
        durationMs: Date.now() - startedAt,
      }
    } finally {
      state.applying = null
      persistState()
      if (state.queued) {
        state.queued = false
        scheduleApply(ctx, 'queued')
      }
    }
    return state.lastApply
  })()
  state.applying = promise
  return promise
}

function stateFile(profileDir) {
  return path.join(profileDir, '.hot-apply', 'state.json')
}

function loadState(profileDir) {
  const saved = readJson(stateFile(profileDir))
  if (saved === undefined) return
  if (typeof saved.auto === 'boolean') state.auto = saved.auto
  if (saved.lastApply !== undefined && saved.lastApply !== null) state.lastApply = saved.lastApply
}

function persistState() {
  try {
    const dir = path.join(resolveProfileDir(), '.hot-apply')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ auto: state.auto, lastApply: state.lastApply }, null, 2))
  } catch {
    // Persisting the last result is best effort; a reload still works without it.
  }
}

function activeWork(ctx) {
  const counts = { turns: 0, jobs: 0, names: [] }
  try {
    const agents = ctx.get('agents')
    const list = agents?.list?.() ?? []
    for (const agent of list) {
      if (agent?.status !== 'running') continue
      counts.turns += 1
      const name = agent?.title ?? agent?.name ?? agent?.id
      if (name !== undefined && counts.names.length < 4) counts.names.push(String(name))
    }
  } catch {
    // The roster is informational only.
  }
  try {
    const jobs = ctx.get('jobs')
    const records = jobs?.list?.() ?? []
    for (const record of records) {
      const view = record?.job ?? record
      const status = view?.status ?? record?.status
      if (status === 'running' || status === 'stopping') counts.jobs += 1
    }
  } catch {
    // Same for background jobs.
  }
  return counts
}

function stopBackgroundJobs(ctx) {
  let stopped = 0
  try {
    const jobs = ctx.get('jobs')
    const records = jobs?.list?.() ?? []
    for (const record of records) {
      const view = record?.job ?? record
      const status = view?.status ?? record?.status
      if (status !== 'running' && status !== 'stopping') continue
      const id = view?.id ?? record?.id
      if (id === undefined) continue
      try {
        jobs.kill(id, undefined, 'hot-apply restart')
        stopped += 1
      } catch {
        // A job can finish between the listing and the kill.
      }
    }
  } catch {
    // Without the job service there is nothing to stop.
  }
  return stopped
}

/**
 * Where the desktop app runs from, or why it cannot be found.
 *
 * Only the desktop host can be relaunched: there the Host is the Electron binary in
 * Node mode, so `process.execPath` is the app itself and the parent process is the
 * Electron main process. A headless or CLI host is reported as unsupported instead of
 * guessing at a pid; the caller keeps the plugin's in-process reload in either case.
 */
function desktopTarget() {
  if (process.platform !== 'win32') return { error: 'platform-unsupported' }
  const exe = process.execPath
  if (typeof exe !== 'string' || exe.length === 0 || !/\.exe$/i.test(exe)) return { error: 'not-desktop-host' }
  if (!fs.existsSync(exe)) return { error: 'executable-missing' }
  // A packed Electron app keeps its archive next to the executable. Without it this
  // Host runs under a plain node.exe (the CLI), and there is no window to restart.
  if (!fs.existsSync(path.join(path.dirname(exe), 'resources', 'app.asar'))) return { error: 'not-desktop-host' }
  const pid = typeof process.ppid === 'number' && process.ppid > 0 ? process.ppid : undefined
  if (pid === undefined) return { error: 'parent-missing' }
  return { exe, pid }
}

function relaunchScript() {
  return [
    'param([int]$TargetPid,[string]$Exe,[string]$WorkDir,[string]$Log)',
    `function Write-Log([string]$text) { try { Add-Content -Path $Log -Value ((Get-Date -Format o) + " " + $text) -ErrorAction SilentlyContinue } catch {} }`,
    'Write-Log ("helper start target=" + $TargetPid + " exe=" + $Exe)',
    '$ErrorActionPreference = "SilentlyContinue"',
    `Start-Sleep -Milliseconds ${RELAUNCH_DELAY_MS}`,
    'try { (Get-Process -Id $TargetPid -ErrorAction Stop).CloseMainWindow() | Out-Null; Write-Log "close main window requested" } catch { Write-Log ("close main window failed: " + $_.Exception.Message) }',
    `Start-Sleep -Milliseconds ${RELAUNCH_KILL_GRACE_MS}`,
    'try { if (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) { Stop-Process -Id $TargetPid -Force -ErrorAction Stop; Write-Log "stop process requested" } } catch { Write-Log ("stop process failed: " + $_.Exception.Message) }',
    `$deadline = (Get-Date).AddMilliseconds(${RELAUNCH_WAIT_MS})`,
    'while ((Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 200 }',
    'if (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) { Write-Log ("aborted: pid " + $TargetPid + " still alive"); exit 1 }',
    'Write-Log "target exited"',
    'Start-Sleep -Milliseconds 900',
    '',
    '# Start the app through the shell, never through this console: a console-launched',
    '# app gets a visible console window and that window owns the app lifetime.',
    '$exeName = [System.IO.Path]::GetFileNameWithoutExtension($Exe)',
    '$quoted = [string][char]34 + $Exe + [string][char]34',
    '$launched = $false',
    'try {',
    '  Start-Process -FilePath (Join-Path $env:WINDIR "explorer.exe") -ArgumentList $quoted -ErrorAction Stop | Out-Null',
    '  Write-Log "explorer launch requested"',
    '} catch { Write-Log ("explorer launch failed: " + $_.Exception.Message) }',
    '$settle = (Get-Date).AddMilliseconds(9000)',
    'while ((Get-Date) -lt $settle) {',
    '  Start-Sleep -Milliseconds 300',
    '  $running = @(Get-Process -Name $exeName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)',
    '  if ($running.Count -gt 0) { $launched = $true; Write-Log ("app started pid=" + ($running -join ",")); break }',
    '}',
    'if (-not $launched) {',
    '  try { $started = Start-Process -FilePath $Exe -WorkingDirectory $WorkDir -PassThru -ErrorAction Stop; Write-Log ("direct launch pid=" + $started.Id) } catch { Write-Log ("direct launch failed: " + $_.Exception.Message) }',
    '}',
    '',
    '# Bring the window up: a hidden or minimized window looks like "nothing happened".',
    '$signature = @"',
    'using System;',
    'using System.Collections.Generic;',
    'using System.Runtime.InteropServices;',
    'public class DshWindow {',
    '  public delegate bool EnumProc(IntPtr handle, IntPtr param);',
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);',
    '  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr handle, out int pid);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);',
    '  public static List<IntPtr> ForPid(int pid) {',
    '    var found = new List<IntPtr>();',
    '    EnumWindows((handle, param) => { int owner; GetWindowThreadProcessId(handle, out owner); if (owner == pid) found.Add(handle); return true; }, IntPtr.Zero);',
    '    return found;',
    '  }',
    '}',
    '"@',
    'try { Add-Type -TypeDefinition $signature -ErrorAction Stop } catch { Write-Log ("show helper failed: " + $_.Exception.Message) }',
    '$shown = $false',
    '$windowDeadline = (Get-Date).AddMilliseconds(30000)',
    'while (-not $shown -and ((Get-Date) -lt $windowDeadline)) {',
    '  Start-Sleep -Milliseconds 500',
    '  $visible = Get-Process -Name $exeName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    '  if ($visible) {',
    '    [void][DshWindow]::ShowWindowAsync($visible.MainWindowHandle, 9)',
    '    [void][DshWindow]::ShowWindowAsync($visible.MainWindowHandle, 5)',
    '    [void][DshWindow]::SetForegroundWindow($visible.MainWindowHandle)',
    '    Write-Log ("window shown pid=" + $visible.Id + " handle=" + $visible.MainWindowHandle)',
    '    $shown = $true',
    '  }',
    '}',
    'if (-not $shown) {',
    '  $newest = Get-Process -Name $exeName -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1',
    '  if ($newest) {',
    '    $handles = [DshWindow]::ForPid($newest.Id)',
    '    foreach ($handle in $handles) { [void][DshWindow]::ShowWindowAsync($handle, 9); [void][DshWindow]::ShowWindowAsync($handle, 5); Write-Log ("forced window pid=" + $newest.Id + " handle=" + $handle) }',
    '    if ($handles.Count -gt 0) { [void][DshWindow]::SetForegroundWindow($handles[0]); $shown = $true }',
    '  }',
    '}',
    'Write-Log ("window ready=" + $shown)',
    '$launched = $true',
    'if ($launched) { exit 0 }',
    'exit 1',
    '',
  ].join('\r\n')
}

function relaunchCommand(profileDir, target, files) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return [
    `"${powershell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${files.script}" -TargetPid ${target.pid} -Exe "${target.exe}" -WorkDir "${path.dirname(target.exe)}" -Log "${files.log}"`,
  ].join('')
}

/**
 * The task scheduler can only show a console window when its action is a console
 * program, and a console-attached launch is what produced the stray cmd.exe window
 * that owned the app. `wscript //B` has no console at all, so the helper runs hidden
 * and everything it starts inherits no console.
 */
function relaunchLauncher(profileDir, target, files) {
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const inner = `"${powershell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${files.script}" -TargetPid ${target.pid} -Exe "${target.exe}" -WorkDir "${path.dirname(target.exe)}" -Log "${files.log}"`
  return [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${inner.replace(/"/g, '""')}", 0, False`,
    '',
  ].join('\r\n')
}

function writeRelaunchScript(profileDir, target) {
  const dir = path.join(profileDir, '.hot-apply')
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(dir, 'relaunch.ps1')
  const command = path.join(dir, 'relaunch.cmd')
  const launcher = path.join(dir, 'relaunch.vbs')
  const files = { script, command, launcher, log: path.join(dir, 'relaunch.log') }
  fs.writeFileSync(script, relaunchScript(), 'utf8')
  if (target !== undefined) {
    fs.writeFileSync(command, `@echo off\r\n${relaunchCommand(profileDir, target, files)}\r\n`, 'utf8')
    fs.writeFileSync(launcher, relaunchLauncher(profileDir, target, files), 'utf8')
  }
  return files
}

/**
 * Start the relaunch helper outside this process tree, on the user's desktop.
 *
 * Two constraints rule out a plain `spawn({detached:true})`:
 *   1. The desktop app kills its whole child tree when it quits, so a child helper
 *      dies between "close the window" and "start the app again" — which is why the
 *      first version could close DSH but never reopen it.
 *   2. A process created through Win32_Process.Create does survive that tree, but it
 *      has no interactive desktop: GUI applications started from it exit immediately.
 *
 * A shell hand-off covers both: `explorer.exe` is not part of the app's process tree and
 * runs in the logged-on user's session, so the helper it starts survives the quit and
 * opens the app on the real desktop. It also stays console-free, since the launcher is a
 * `.vbs` script run through `wscript`. Nothing is scheduled, registered or persisted.
 */
function spawnRelaunch(profileDir, target) {
  const files = writeRelaunchScript(profileDir, target)

  const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
  try {
    execFileSync(explorer, [files.launcher], { windowsHide: true, timeout: 15000, stdio: 'ignore' })
  } catch {
    // explorer.exe hands the file to the already running shell and reports a non-zero
    // exit code for a hand-off that worked, so its exit status says nothing. The log
    // the helper writes below is the only real evidence.
  }
  logApply(profileDir, `relaunch helper handed to explorer: ${files.launcher}`)

  // The helper writes its first log line within a second and closes the app within
  // three. If this process is still alive after the grace period, the hand-off
  // silently did nothing and the plain detached child is the last resort.
  const verify = setTimeout(() => {
    try {
      const log = fs.existsSync(files.log) ? fs.readFileSync(files.log, 'utf8') : ''
      if (log.includes('helper start')) return
      logApply(profileDir, 'relaunch helper did not start; trying a detached child')
      launchFallback(profileDir, target, files)
    } catch (error) {
      logApply(profileDir, `relaunch verification failed: ${error && error.message ? error.message : String(error)}`)
    }
  }, RELAUNCH_VERIFY_MS)
  verify.unref?.()

  return files
}

function launchFallback(profileDir, target, files) {
  const commandLine = `cmd.exe /c ""${files.command}""`
  try {
    const script = [
      `$ErrorActionPreference = 'Stop'`,
      `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}'; CurrentDirectory = '${path.dirname(target.exe).replace(/'/g, "''")}' }`,
      `if ($result.ReturnValue -ne 0) { Write-Output ('cim-failed ' + $result.ReturnValue) } else { Write-Output ('cim-ok ' + $result.ProcessId) }`,
    ].join('; ')
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    })
    logApply(profileDir, `relaunch detached: ${String(output).trim()}`)
    if (!/\bcim-ok\b/.test(String(output))) throw new Error(`wmi create failed: ${String(output).trim()}`)
    return files
  } catch (error) {
    logApply(profileDir, `wmi create failed, falling back to spawn: ${error && error.message ? error.message : String(error)}`)
    const env = { ...process.env }
    // The Host is an Electron binary running as Node. The relaunched app must be the real one.
    delete env.ELECTRON_RUN_AS_NODE
    delete env.DSH_DESKTOP_NODE_EXECUTABLE
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', files.script,
        '-TargetPid', String(target.pid), '-Exe', target.exe, '-WorkDir', path.dirname(target.exe), '-Log', files.log],
      { detached: true, stdio: 'ignore', windowsHide: true, env },
    )
    child.unref()
    return files
  }
}

function touchPackageFiles(packageDir, budget) {
  let touched = 0
  const stack = [{ dir: packageDir, depth: 0 }]
  while (stack.length > 0 && touched < budget) {
    const current = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (touched >= budget) break
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (current.depth < 6) stack.push({ dir: full, depth: current.depth + 1 })
        continue
      }
      if (!/\.(js|mjs|cjs)$/i.test(entry.name)) continue
      try {
        const now = new Date()
        fs.utimesSync(full, now, now)
        touched += 1
      } catch {
        // A file may vanish while a build is rewriting the package.
      }
    }
  }
  return touched
}

function touchAllPackages(profileDir, budget) {
  let touched = 0
  for (const entry of packagesNow(profileDir)) {
    if (entry.name === 'dsh-hot-apply') continue
    if (touched >= budget) break
    touched += touchPackageFiles(entry.real, budget - touched)
  }
  return touched
}

function describeHandles() {
  const lines = []
  try {
    const handles = process._getActiveHandles?.() ?? []
    for (const handle of handles) {
      const name = handle?.constructor?.name ?? typeof handle
      let referenced = true
      try {
        if (typeof handle?.hasRef === 'function') referenced = handle.hasRef()
      } catch {
        // A closing handle can refuse to answer.
      }
      if (!referenced) continue
      let extra = ''
      try {
        if (typeof handle?.fd === 'number') extra = ` fd=${handle.fd}`
        else if (typeof handle?.address === 'function') extra = ` address=${JSON.stringify(handle.address())}`
      } catch {
        // Diagnostics only.
      }
      lines.push(`${name}${extra}`)
    }
    const requests = process._getActiveRequests?.() ?? []
    for (const request of requests) lines.push(`request:${request?.constructor?.name ?? typeof request}`)
  } catch (error) {
    lines.push(`handle-dump-failed: ${String(error?.message ?? error)}`)
  }
  return lines
}

function writeShutdownDump(profileDir, reason) {
  try {
    const dir = path.join(profileDir, '.hot-apply')
    fs.mkdirSync(dir, { recursive: true })
    const lines = [`at=${new Date().toISOString()}`, `reason=${reason}`, ...describeHandles()]
    fs.writeFileSync(path.join(dir, 'shutdown-dump.log'), `${lines.join('\n')}\n`, 'utf8')
  } catch {
    // The dump is a diagnostic, never a requirement.
  }
}

let shutdownExitTimer = null
let shutdownExitDue = 0

function scheduleHostExit(profileDir, reason, delayMs) {
  const due = Date.now() + delayMs
  if (shutdownExitTimer !== null) {
    // A later safety deadline must never win over an earlier acknowledgement.
    if (due >= shutdownExitDue) return
    clearTimeout(shutdownExitTimer)
  }
  shutdownExitDue = due
  shutdownExitTimer = setTimeout(() => {
    writeShutdownDump(profileDir, reason)
    // The desktop updater only waits 10 s for the Host to exit and then SIGTERMs it.
    // Once the Host acknowledged the shutdown there is nothing left to finish except
    // whatever plugin handle is still ref'd, so exit deterministically before that
    // deadline instead of being killed.
    process.exit(0)
  }, delayMs)
  shutdownExitTimer.unref?.()
}

export function installShutdownExit(profileDir) {
  // A plugin reload re-evaluates this module but keeps the already installed IPC hooks.
  // Publish the current profile directory so the surviving hook writes its dump there.
  globalThis.__dshHotApplyProfileDir = profileDir
  if (globalThis.__dshHotApplyShutdownHook === true) return
  globalThis.__dshHotApplyShutdownHook = true
  const originalSend = typeof process.send === 'function' ? process.send : undefined
  if (originalSend !== undefined) {
    process.send = function (...args) {
      const result = originalSend.apply(this, args)
      try {
        const message = args[0]
        if (message !== null && typeof message === 'object' && message.type === 'shutdown-complete') {
          scheduleHostExit(globalThis.__dshHotApplyProfileDir ?? profileDir, 'shutdown-complete', 700)
        }
      } catch {
        // Never break the Host's own IPC.
      }
      return result
    }
  }
  process.on('message', message => {
    try {
      if (message !== null && typeof message === 'object' && message.type === 'shutdown') {
        // Safety net: if the acknowledgement never happens, leave well before SIGTERM.
        scheduleHostExit(globalThis.__dshHotApplyProfileDir ?? profileDir, 'shutdown-request', 7000)
      }
    } catch {
      // Same.
    }
  })
}

function restartSnapshot(ctx) {
  const target = desktopTarget()
  return {
    running: state.restarting !== null,
    mode: state.restarting,
    supported: target.error === undefined,
    reason: target.error,
    electronPid: target.pid,
    executable: target.exe,
    active: activeWork(ctx),
  }
}

function snapshot(ctx, profileDir) {
  const packages = packagesNow(profileDir).map(entry => ({
    name: entry.name,
    version: entry.version,
    watching: state.watchedReal.has(entry.real),
    bundle: entry.bundle,
    client: entry.client,
  }))
  return {
    version: VERSION,
    auto: state.auto,
    applying: state.applying !== null,
    lastApply: state.lastApply,
    packages,
    restart: restartSnapshot(ctx),
  }
}

function sendJson(response, statusCode, body) {
  const text = JSON.stringify(body)
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(text)
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

async function updateBundle(ctx, profileDir, name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, stage: 'lookup', error: 'invalid-name' }
  }
  if (name === 'dsh-hot-apply') {
    // Removing this bundle would unload the half that is running this request.
    return { ok: false, stage: 'lookup', error: 'self-update-unsupported' }
  }
  let bundles
  try {
    bundles = await ctx.pluginManager.listBundles()
  } catch (error) {
    return { ok: false, stage: 'lookup', error: String(error?.message ?? error) }
  }
  const bundle = bundles.find(entry => entry.name === name)
  if (bundle === undefined) return { ok: false, stage: 'lookup', error: 'unknown-plugin' }
  if (bundle.error !== undefined) {
    return { ok: false, stage: 'lookup', error: bundle.error.code, detail: bundle.error.diagnostic }
  }
  if (bundle.removable !== true) {
    return { ok: false, stage: 'lookup', error: bundle.readOnlyReason ?? 'not-removable' }
  }
  const spec = bundle.installTarget?.spec ?? name
  try {
    const removed = await ctx.pluginManager.removeBundle(name)
    if (removed.application === 'failed' || removed.application === 'cancelled') {
      return { ok: false, stage: 'remove', result: removed }
    }
    await sleep(600)
    const installed = await ctx.pluginManager.installBundle(spec, {})
    if (installed.application === 'failed' || installed.application === 'cancelled') {
      return { ok: false, stage: 'install', result: installed, spec }
    }
    const applied = await runApply(ctx, 'update')
    refreshPackages(profileDir)
    attachWatchers(ctx, profileDir)
    return { ok: applied.status === 'applied', stage: 'done', spec, applied, installed: { application: installed.application, version: installed.version } }
  } catch (error) {
    return { ok: false, stage: 'error', error: String(error?.message ?? error) }
  }
}

function registerRoutes(ctx, profileDir) {
  const register = (routePath, handler) => {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: routePath, handler }))
  }

  register('/hot-apply/restart', async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const body = await readBody(request)
    const mode = body?.mode === 'soft' ? 'soft' : 'hard'
    if (state.restarting !== null) {
      sendJson(response, 409, { ok: false, error: 'restart-in-flight', mode: state.restarting })
      return
    }
    const stopped = body?.stopTasks === false ? 0 : stopBackgroundJobs(ctx)
    if (mode === 'soft') {
      state.restarting = 'soft'
      try {
        const touched = touchAllPackages(profileDir, SOFT_TOUCH_LIMIT)
        const applied = await runApply(ctx, 'restart-soft')
        sendJson(response, applied?.status === 'error' ? 500 : 200, {
          ok: applied?.status !== 'error',
          mode,
          touched,
          applied,
          ...snapshot(ctx, profileDir),
        })
      } finally {
        state.restarting = null
      }
      return
    }
    const target = desktopTarget()
    if (target.error !== undefined) {
      sendJson(response, 409, { ok: false, error: target.error, stopped })
      return
    }
    state.restarting = 'hard'
    try {
      if (body?.dryRun === true) {
        // Lets the UI (and tests) inspect the helper without closing the app.
        const files = writeRelaunchScript(profileDir, target)
        state.restarting = null
        sendJson(response, 200, { ok: true, mode, dryRun: true, ...files, scriptBody: relaunchScript(), stopped })
        return
      }
      const files = spawnRelaunch(profileDir, target)
      // If the helper could not quit the app, allow a later attempt instead of locking the button.
      setTimeout(() => {
        if (state.restarting === 'hard') state.restarting = null
      }, 20000).unref?.()
      sendJson(response, 200, {
        ok: true,
        mode,
        stopped,
        electronPid: target.pid,
        executable: target.exe,
        script: files.script,
        log: files.log,
      })
    } catch (error) {
      state.restarting = null
      sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  register('/hot-apply/status', (request, response) => {
    sendJson(response, 200, snapshot(ctx, profileDir))
  })

  register('/hot-apply/apply', async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const result = await runApply(ctx, 'manual')
    sendJson(response, 200, { ok: result?.status !== 'error', lastApply: result, ...snapshot(ctx, profileDir) })
  })

  register('/hot-apply/config', async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const body = await readBody(request)
    if (body === undefined || typeof body?.auto !== 'boolean') {
      sendJson(response, 400, { ok: false, error: 'invalid-body' })
      return
    }
    state.auto = body.auto
    persistState()
    if (state.auto) scheduleApply(ctx, 'config')
    sendJson(response, 200, { ok: true, ...snapshot(ctx, profileDir) })
  })

  register('/hot-apply/bundles', async (request, response) => {
    try {
      const bundles = await ctx.pluginManager.listBundles()
      sendJson(response, 200, {
        ok: true,
        bundles: bundles.map(entry => ({
          name: entry.name,
          version: entry.version,
          availability: entry.availability,
          official: entry.official,
          installed: entry.installed,
          enabled: entry.enabled,
          removable: entry.removable,
          readOnlyReason: entry.readOnlyReason,
          installTarget: entry.installTarget,
          error: entry.error === undefined ? undefined : entry.error.code,
        })),
      })
    } catch (error) {
      sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  register('/hot-apply/update', async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const body = await readBody(request)
    if (body === undefined || typeof body?.name !== 'string') {
      sendJson(response, 400, { ok: false, error: 'invalid-body' })
      return
    }
    const result = await updateBundle(ctx, profileDir, body.name)
    sendJson(response, result.ok ? 200 : 409, { ...result, ...snapshot(ctx, profileDir) })
  })
}

function isRelevantChange(filename) {
  return !IGNORED_FILE.test(filename)
}

function attachWatchers(ctx, profileDir) {
  disposeWatchers()
  const packages = packagesNow(profileDir)
  for (const entry of packages) {
    try {
      const watcher = fs.watch(entry.real, { recursive: true }, (event, filename) => {
        if (filename !== null && !isRelevantChange(String(filename))) return
        scheduleApply(ctx, 'watch')
      })
      watcher.on('error', () => {})
      watcher.unref?.()
      state.watchers.push(watcher)
      state.watchedReal.add(entry.real)
      entry.watching = true
    } catch {
      entry.watching = false
    }
  }
  try {
    const modulesRoot = path.join(profileDir, 'node_modules')
    state.rootWatcher = fs.watch(modulesRoot, { recursive: false }, () => {
      refreshPackages(profileDir)
      attachWatchers(ctx, profileDir)
      scheduleApply(ctx, 'structure')
    })
    state.rootWatcher.on('error', () => {})
    state.rootWatcher.unref?.()
  } catch {
    state.rootWatcher = null
  }
  return state.watchers.length
}

function fingerprint(profileDir) {
  const stamps = []
  const walk = (dir, depth) => {
    if (depth > MAX_POLL_DEPTH) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (IGNORED_FILE.test(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        walk(full, depth + 1)
        continue
      }
      if (!/\.(js|mjs|cjs|json)$/i.test(entry.name)) continue
      try {
        const stat = fs.statSync(full)
        stamps.push(`${full}:${stat.mtimeMs}:${stat.size}`)
      } catch {
        // raced with a write; next round picks it up
      }
    }
  }
  for (const entry of packagesNow(profileDir)) walk(entry.real, 0)
  return stamps.join('|')
}

function startPolling(ctx, profileDir) {
  if (state.pollTimer !== null) return
  state.pollFingerprint = new Map([['all', fingerprint(profileDir)]])
  state.pollTimer = setInterval(() => {
    const next = fingerprint(profileDir)
    if (state.pollFingerprint.get('all') !== next) {
      state.pollFingerprint.set('all', next)
      scheduleApply(ctx, 'poll')
    }
  }, POLL_INTERVAL_MS)
  state.pollTimer.unref?.()
}

function logApply(profileDir, text) {
  try {
    const dir = path.join(profileDir, '.hot-apply')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'apply.log'), `${new Date().toISOString()} ${text}\n`)
  } catch {
    // Diagnostics only.
  }
}

export function apply(ctx) {
  const profileDir = resolveProfileDir()
  logApply(profileDir, `apply start ${VERSION} pid=${process.pid}`)
  try {
    loadState(profileDir)
    refreshPackages(profileDir)
    installShutdownExit(profileDir)

    registerRoutes(ctx, profileDir)
    logApply(profileDir, 'routes registered')

    ctx.effect(() => {
      const watched = attachWatchers(ctx, profileDir)
      if (watched === 0) startPolling(ctx, profileDir)
      logApply(profileDir, `watchers ${watched}`)
      return () => {
        if (state.applyTimer !== null) {
          clearTimeout(state.applyTimer)
          state.applyTimer = null
        }
        if (state.pollTimer !== null) {
          clearInterval(state.pollTimer)
          state.pollTimer = null
        }
        disposeWatchers()
      }
    })

    ctx.on('plugin-manager/changed', () => {
      const timer = setTimeout(() => {
        refreshPackages(profileDir)
        attachWatchers(ctx, profileDir)
      }, 600)
      timer.unref?.()
    })
    logApply(profileDir, 'apply done')
  } catch (error) {
    logApply(profileDir, `apply failed: ${error?.stack ?? String(error)}`)
    throw error
  }
}

