#!/usr/bin/env node
/**
 * Undo the tray-menu patch that dsh-hot-apply <= 0.2.x wrote into `app.asar`.
 *
 * v0.2.x inserted a "restart DSH" entry into the desktop shell's tray menu by
 * rewriting `lib/main.js` in place (same byte length, so no other archive entry
 * moved). v0.3.0 dropped that feature, because the plugin market forbids touching
 * the application bundle. An installation that ran v0.2.x still carries the patched
 * `main.js`; this script removes the entry again and pads the file back to its
 * original length, so the archive layout stays intact.
 *
 * The running app keeps the old menu in memory until it is restarted.
 *
 * Usage:
 *   node scripts/unpatch-shell.mjs                       # auto-detect the install
 *   node scripts/unpatch-shell.mjs --install "D:\deepseek_harness"
 *   node scripts/unpatch-shell.mjs --asar "D:\deepseek_harness\resources\app.asar"
 *   node scripts/unpatch-shell.mjs --dry-run             # only write a preview copy
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MARKER = '// hot-apply:restart-item'
const ANCHOR = 'label: messages.quitApplication'
const SEPARATOR = '{ type: "separator" },'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i]
    if (name === '--install' || name === '--asar') {
      args[name.slice(2)] = argv[i + 1]
      i += 1
    }
  }
  return args
}

function candidates(args) {
  if (args.asar !== undefined) return [path.resolve(args.asar)]
  if (args.install !== undefined) return [path.join(path.resolve(args.install), 'resources', 'app.asar')]
  const home = process.env.LOCALAPPDATA
  const programFiles = process.env.ProgramFiles
  return [
    home && path.join(home, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    programFiles && path.join(programFiles, 'DeepSeek Harness', 'resources', 'app.asar'),
    'D:\\deepseek_harness\\resources\\app.asar',
  ].filter(value => typeof value === 'string' && value.length > 0)
}

function locate(asar) {
  const fd = fs.openSync(asar, 'r+')
  try {
    const prefix = Buffer.alloc(16)
    fs.readSync(fd, prefix, 0, 16, 0)
    const headerSize = prefix.readUInt32LE(4)
    const head = Buffer.alloc(headerSize)
    fs.readSync(fd, head, 0, headerSize, 8)
    const text = head.toString('utf8')
    const header = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    let node = header
    for (const part of ['lib', 'main.js']) {
      if (node?.files?.[part] === undefined) throw new Error(`"${part}" not found in ${asar}`)
      node = node.files[part]
    }
    return { fd, size: Number(node.size), dataAt: 8 + headerSize + Number(node.offset) }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

/** Remove the inserted menu entry; returns the reverted source and the dropped line count. */
function unpatched(source) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(eol)
  const marker = lines.findIndex(line => line.includes(MARKER))
  if (marker < 0) return undefined
  const label = lines.findIndex((line, index) => index > marker && line.includes(ANCHOR))
  if (label < 0) throw new Error('found the marker but not the quit entry below it')
  if (lines[label - 1].trim() !== '{') throw new Error('unexpected layout above the quit entry')
  let end = label - 2
  while (end > marker && lines[end].trim() !== '},') end -= 1
  if (lines[end].trim() !== '},') throw new Error('unexpected layout below the inserted entry')
  return { source: lines.slice(0, marker).concat(lines.slice(end + 1)).join(eol), removed: end - marker + 1 }
}

/** Keep a copy of the entry before touching the archive, so a bad write can be undone. */
function backup(dir, buffer, size) {
  const file = path.join(dir, 'main-entry-backup.js')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, buffer.subarray(0, size))
  return file
}

function restoreHint(file) {
  return `backup: ${file} (copy it back over the lib/main.js entry with the same technique)`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const asar = candidates(args).find(value => fs.existsSync(value))
  if (asar === undefined) {
    console.error('app.asar not found; pass --install <dir> or --asar <file>')
    process.exitCode = 1
    return
  }
  const { fd, size, dataAt } = locate(asar)
  try {
    const buffer = Buffer.alloc(size)
    fs.readSync(fd, buffer, 0, size, dataAt)
    const original = buffer.toString('utf8')
    // A shifted read would still find the marker and then rewrite the wrong bytes,
    // so make sure the entry really starts where the header says it does.
    if (!/^(import |"use strict"|#!|\/\/)/.test(original)) {
      throw new Error(`unexpected entry start ${JSON.stringify(original.slice(0, 40))}; refusing to write`)
    }
    if (!original.includes(MARKER)) {
      console.log(`${asar}: clean, nothing to undo`)
      return
    }
    const result = unpatched(original)
    let next = result.source
    const length = Buffer.byteLength(next, 'utf8')
    if (length > size) throw new Error(`unpatched file is ${length - size} bytes larger than the original`)
    const pad = size - length
    if (pad > 0 && pad < 3) throw new Error(`cannot pad ${pad} bytes safely`)
    if (pad >= 3) next += `${'\n//'}${'x'.repeat(pad - 3)}`
    const out = Buffer.from(next, 'utf8')
    if (out.length !== size) throw new Error(`length mismatch: ${out.length} != ${size}`)

    if (process.argv.includes('--dry-run')) {
      const preview = path.join(os.tmpdir(), 'hot-apply-main-preview.mjs')
      fs.writeFileSync(preview, Buffer.from(result.source, 'utf8'))
      console.log(`dry run: ${result.removed} lines would be removed, ${size} bytes kept`)
      console.log(`preview: ${preview}`)
      return
    }

    const dir = path.join(process.env.DSH_PROFILE_DIR || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop'), '.hot-apply')
    const file = backup(dir, buffer, size)
    fs.writeSync(fd, out, 0, size, dataAt)

    const verify = Buffer.alloc(size)
    fs.readSync(fd, verify, 0, size, dataAt)
    if (verify.toString('utf8').includes(MARKER)) throw new Error(`write did not take effect; ${restoreHint(file)}`)
    console.log(`${asar}: removed ${result.removed} lines, ${size} bytes kept`)
    console.log(restoreHint(file))
    console.log('restart DSH to drop the tray entry')
  } finally {
    fs.closeSync(fd)
  }
}

main()
