#!/usr/bin/env node
// PostToolUse hook: after an Edit/Write on a .ts/.tsx file, run a scoped
// tsc --noEmit against the nearest tsconfig.json. Non-blocking — errors are
// printed so the user sees them but don't fail the tool call.

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function readStdin() {
  try { return fs.readFileSync(0, 'utf8') } catch { return '' }
}

const raw = readStdin()
let payload
try { payload = JSON.parse(raw) } catch { process.exit(0) }

const tool = payload.tool_name ?? ''
if (!['Edit', 'Write'].includes(tool)) process.exit(0)

const filePath = payload.tool_input?.file_path ?? ''
if (!/\.(ts|tsx)$/.test(filePath)) process.exit(0)
if (/node_modules|\/dist\//.test(filePath)) process.exit(0)

function findTsconfig(startFile) {
  let dir = path.dirname(path.resolve(startFile))
  const root = path.parse(dir).root
  while (dir !== root) {
    const candidate = path.join(dir, 'tsconfig.json')
    if (fs.existsSync(candidate)) return candidate
    dir = path.dirname(dir)
  }
  return null
}

const tsconfig = findTsconfig(filePath)
if (!tsconfig) process.exit(0)

const pkgDir = path.dirname(tsconfig)
const result = spawnSync('npx', ['--no-install', 'tsc', '-p', tsconfig, '--noEmit'], {
  cwd: pkgDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 60_000,
  encoding: 'utf8',
})

if (result.status !== 0) {
  const out = (result.stdout ?? '') + (result.stderr ?? '')
  process.stderr.write(
    '[scoped-typecheck] ' + path.relative(process.cwd(), tsconfig) + ' reported errors:\n' +
    out.split('\n').slice(0, 40).join('\n') + '\n'
  )
}
process.exit(0)
