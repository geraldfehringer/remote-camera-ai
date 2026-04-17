#!/usr/bin/env node
// PreToolUse hook: reject Edit/Write/NotebookEdit whose new content contains
// real-looking API keys or credentials. Wired via .claude/settings.json.
//
// Reads the Claude Code hook payload from stdin (JSON). Exits 0 to allow,
// non-zero with a human-readable message on stderr to block.

const fs = require('node:fs')
const path = require('node:path')

function readStdin() {
  try { return fs.readFileSync(0, 'utf8') } catch { return '' }
}

const raw = readStdin()
let payload
try { payload = JSON.parse(raw) } catch { process.exit(0) }

const tool = payload.tool_name ?? ''
if (!['Edit', 'Write', 'NotebookEdit'].includes(tool)) process.exit(0)

const input = payload.tool_input ?? {}
const filePath = input.file_path ?? input.notebook_path ?? ''

// Pull any string field that may carry to-be-written content.
const candidates = [
  input.new_string,
  input.content,
  input.new_source,
  input.new_string && input.old_string ? input.new_string : undefined,
  ...(Array.isArray(input.edits) ? input.edits.map((e) => e?.new_string) : []),
].filter((v) => typeof v === 'string')

const content = candidates.join('\n')
if (!content) process.exit(0)

const PATTERNS = [
  { name: 'OpenAI project key',       re: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { name: 'Anthropic API key',        re: /sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API key (AQ.Ab)',   re: /AQ\.Ab[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API key (AIza)',    re: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: 'Together API key',         re: /tgp_v1_[A-Za-z0-9_-]{20,}/ },
  { name: 'AWS access key id',        re: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token',             re: /gh[psur]_[A-Za-z0-9]{30,}/ },
  { name: 'Slack token',              re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Private key header',       re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/ },
]

const hits = PATTERNS.filter((p) => p.re.test(content))
if (hits.length === 0) process.exit(0)

const rel = filePath ? path.relative(process.cwd(), filePath) || filePath : '(unknown file)'
process.stderr.write(
  '\n[secret-scan] refusing to write ' + rel + '\n' +
  '  Detected secret-like values:\n    - ' + hits.map((h) => h.name).join('\n    - ') + '\n' +
  '  If this is a placeholder, use <REPLACE-WITH-...> form.\n' +
  '  To adjust detection, edit scripts/secret-scan.cjs.\n\n'
)
process.exit(1)
