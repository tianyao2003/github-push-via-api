#!/usr/bin/env node
/**
 * push-via-api.mjs —— 用 GitHub Git Data API 推送本地 git 历史。
 *
 * 为什么需要它：本机网络出口只放行 api.github.com / codeload.github.com，
 * github.com:443 被代理拦截，`git push` 走不通。
 * Git Data API 全部挂在 api.github.com 上，可原样重建 blob/tree/commit。
 *
 * 用法：
 *   node push-via-api.mjs --dry-run
 *   node push-via-api.mjs
 *
 * 环境变量：
 *   REPO_DIR       本地仓库路径
 *   REPO_SLUG      owner/repo
 *   BRANCH         默认 main
 *   REWRITE_AUTHOR 形如 "Name <email>"，设了就把所有提交作者换成它
 *   GIT_EXE        git 绝对路径（Windows 上必需）
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`push-via-api — rebuild a git commit history on GitHub through the Git Data API

Usage:
  REPO_DIR=<local repo> REPO_SLUG=owner/repo node push-via-api.mjs [--dry-run]

Environment:
  REPO_DIR        local git repository (default: cwd)
  REPO_SLUG       owner/repo (required)
  BRANCH          branch to point at (default: main)
  REWRITE_AUTHOR  "Name <email>" — rewrite every commit author
  GIT_EXE         absolute path to git (auto-detected)
  GITHUB_TOKEN    token; falls back to \`gh auth token\`, then the gh hosts.yml

The token needs the \`repo\` scope, plus \`workflow\` if the history touches
.github/workflows/. Missing \`workflow\` surfaces as a bare 404 on the ref write.`)
  process.exit(0)
}

const REPO_DIR = process.env.REPO_DIR || process.cwd()
const SLUG = process.env.REPO_SLUG
if (!SLUG || !SLUG.includes('/')) {
  console.error('REPO_SLUG is required, e.g. REPO_SLUG=owner/repo')
  process.exit(1)
}
const BRANCH = process.env.BRANCH || 'main'
const REWRITE_AUTHOR = process.env.REWRITE_AUTHOR || ''
// Windows 上 spawnSync 直接调 "git" 会 EBUSY，所以先解析出一个绝对路径。
// 优先级：GIT_EXE 环境变量 -> where/command -v -> 裸 "git" 兜底。
function resolveGit() {
  if (process.env.GIT_EXE) return process.env.GIT_EXE
  const finder = process.platform === 'win32' ? 'where git' : 'command -v git'
  try {
    const out = execSync(finder, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (first) return first
  } catch { /* fall through */ }
  return 'git'
}
const GIT_EXE = resolveGit()

// ---------- token ----------
// Lookup order: GITHUB_TOKEN env -> `gh auth token` -> GitHub CLI hosts.yml.
// Nothing is written to disk; the token only lives in this process.
function loadToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  try {
    const t = execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (t) return t
  } catch { /* no gh CLI */ }
  const hosts = [
    join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'GitHub CLI', 'hosts.yml'),
    join(homedir(), '.config', 'gh', 'hosts.yml'),
  ].filter((f) => { try { return statSync(f).isFile() } catch { return false } })
  for (const f of hosts) {
    const m = readFileSync(f, 'utf8').match(/oauth_token:\s*(\S+)/)
    if (m) return m[1].replace(/["']/g, '')
  }
  throw new Error('No token. Set GITHUB_TOKEN, or run `gh auth login`.')
}
const TOKEN = loadToken()
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'push-via-api',
  'Content-Type': 'application/json',
}

// ---------- git 批量读取 ----------
// Windows 上 spawnSync 直接调 "git" 会 EBUSY；连续 spawn 也会 EBUSY。
// 对策：(a) 绝对路径 + shell；(b) 尽量减少 spawn 次数；(c) 失败重试。
const q = (s) => (/[\s"\\]/.test(s) ? '"' + String(s).replace(/"/g, '\\"') + '"' : String(s))

function runShell(cmd, opts = {}) {
  let lastErr
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return execSync(cmd, {
        cwd: REPO_DIR,
        maxBuffer: 1024 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts,
      })
    } catch (e) {
      // EBUSY / EAGAIN 是 Windows 上瞬时资源争用，重试即可
      if (e.code === 'EBUSY' || e.code === 'EAGAIN' || e.code === 'UNKNOWN') {
        lastErr = e
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * attempt)
        continue
      }
      throw e
    }
  }
  throw lastErr
}

function git(args) {
  return runShell([q(GIT_EXE), ...args.map(q)].join(' '), { encoding: 'utf8' })
}

/** 一次 git cat-file --batch 读多个对象，返回 Map<sha, {type, buf}> */
function batchRead(shas) {
  if (shas.length === 0) return new Map()
  const listFile = join(tmpdir(), `dsh-shas-${process.pid}-${shas.length}.txt`)
  writeFileSync(listFile, shas.join('\n') + '\n')
  const buf = runShell(`${q(GIT_EXE)} cat-file --batch < ${q(listFile)}`)
  const out = new Map()
  let p = 0
  while (p < buf.length) {
    const nl = buf.indexOf(0x0a, p)
    if (nl < 0) break
    const header = buf.subarray(p, nl).toString('utf8')
    p = nl + 1
    if (header.endsWith(' missing')) continue
    const [sha, type, sizeStr] = header.split(' ')
    const size = Number(sizeStr)
    const content = buf.subarray(p, p + size)
    p += size + 1 // 跳过后面的换行
    out.set(sha, { type, buf: Buffer.from(content) })
  }
  return out
}

function parseIdent(s) {
  const m = s.match(/^(.*?)\s*<([^>]*)>\s*(\d+)\s*([+-]\d{4})$/)
  if (!m) return { name: s.trim(), email: '', date: new Date().toISOString() }
  const [, name, email, ts, tz] = m
  const off = tz.slice(0, 3) + ':' + tz.slice(3)
  const pad = (n) => String(n).padStart(2, '0')
  const local = new Date(Number(ts) * 1000 + Number(tz.slice(0, 3)) * 3600000)
  const iso =
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${off}`
  return { name, email, date: iso }
}

/** 解析 commit 对象 */
function parseCommit(sha, buf) {
  const raw = buf.toString('utf8')
  const idx = raw.indexOf('\n\n')
  const header = raw.slice(0, idx)
  const message = raw.slice(idx + 2)
  const c = { sha, tree: null, parents: [], author: null, committer: null, message }
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) c.tree = line.slice(5).trim()
    else if (line.startsWith('parent ')) c.parents.push(line.slice(7).trim())
    else if (line.startsWith('author ')) c.author = parseIdent(line.slice(7))
    else if (line.startsWith('committer ')) c.committer = parseIdent(line.slice(10))
  }
  return c
}

/** 解析 tree 对象（二进制）: "<mode> <name>\0<20 bytes sha>" */
function parseTree(buf) {
  const entries = []
  let p = 0
  while (p < buf.length) {
    const sp = buf.indexOf(0x20, p)
    const mode = buf.subarray(p, sp).toString('utf8')
    const nul = buf.indexOf(0x00, sp)
    const name = buf.subarray(sp + 1, nul).toString('utf8')
    const sha = buf.subarray(nul + 1, nul + 21).toString('hex')
    p = nul + 21
    const type = mode === '40000' || mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob'
    entries.push({ mode: mode.padStart(6, '0'), name, sha, type })
  }
  return entries
}

function parseRewrite(spec) {
  const m = spec.match(/^(.*?)\s*<([^>]*)>$/)
  if (!m) throw new Error('REWRITE_AUTHOR must look like "Name <email>"')
  return { name: m[1], email: m[2] }
}

// ---------- GitHub API ----------
let apiCalls = 0
async function api(path, init = {}) {
  apiCalls++
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch('https://api.github.com' + path, { ...init, headers: H })
    const text = await res.text()
    if ((res.status === 403 || res.status === 429) && attempt < 4) {
      console.error(`  ! ${res.status} ${path} (attempt ${attempt}/4)`)
      await new Promise((r) => setTimeout(r, 4000 * attempt))
      continue
    }
    if (res.status >= 500 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * attempt))
      continue
    }
    let body
    try { body = JSON.parse(text) } catch { body = text }
    if (!res.ok) throw new Error(`API ${res.status} ${path}: ${JSON.stringify(body).slice(0, 500)}`)
    return body
  }
}

// ---------- 0. 仓库必须非空 ----------
// GitHub 对完全空的仓库拒绝 /git/blobs（409 "Git Repository is empty"）。
// 先用一个临时提交把仓库初始化出来，最后再把 ref 指到真正的历史，
// 这个临时提交会变成不可达对象（GitHub 侧自然回收）。
async function rawFetch(path, init = {}) {
  const res = await fetch('https://api.github.com' + path, { ...init, headers: { ...H, ...(init.headers || {}) } })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

const branchProbe = await rawFetch(`/repos/${SLUG}/git/ref/heads/${BRANCH}`)
let needInit = branchProbe.status !== 200

if (needInit) {
  if (DRY) {
    console.log(`branch ${BRANCH} not present -> DRY-RUN would initialise the repo first`)
  } else {
    console.log(`branch ${BRANCH} not present (${branchProbe.status}) -> initialising repo`)
    const init = await rawFetch(`/repos/${SLUG}/contents/.dsh-init`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'chore: initialise repository',
        content: Buffer.from('temporary file used to bootstrap the Git Data API\n').toString('base64'),
        branch: BRANCH,
      }),
    })
    if (init.status !== 201 && init.status !== 200) {
      console.error('init failed:', init.status, JSON.stringify(init.body).slice(0, 400))
      process.exit(1)
    }
    console.log(`  initialised, default branch now exists (commit ${init.body.commit.sha.slice(0, 8)})`)
  }
} else {
  console.log(`branch ${BRANCH} already exists -> no init needed`)
}
console.log()

// ---------- 采集 ----------
console.log(`repo dir  : ${REPO_DIR}`)
console.log(`target    : ${SLUG}  (branch ${BRANCH})`)
console.log(`mode      : ${DRY ? 'DRY-RUN (no writes)' : 'LIVE'}`)
if (REWRITE_AUTHOR) console.log(`author    : rewrite -> ${REWRITE_AUTHOR}`)
console.log()

const commitShas = git(['rev-list', '--reverse', BRANCH]).trim().split('\n')
console.log(`commits   : ${commitShas.length}`)

const commitObjs = batchRead(commitShas)
const commits = commitShas.map((s) => parseCommit(s, commitObjs.get(s).buf))

// 从根树 BFS 出所有子树与 blob（每次 batchRead 一层，spawn 次数极少）
const allTreeShas = new Set()
const allBlobShas = new Set()
const treeObjs = new Map()

let frontier = [...new Set(commits.map((c) => c.tree))]
while (frontier.length > 0) {
  const fresh = frontier.filter((s) => !treeObjs.has(s))
  if (fresh.length === 0) break
  const read = batchRead(fresh)
  const next = []
  for (const [sha, o] of read) {
    treeObjs.set(sha, o)
    allTreeShas.add(sha)
    for (const e of parseTree(o.buf)) {
      if (e.type === 'tree') next.push(e.sha)
      else if (e.type === 'blob') allBlobShas.add(e.sha)
    }
  }
  frontier = [...new Set(next)]
}

console.log(`trees     : ${allTreeShas.size}`)
console.log(`blobs     : ${allBlobShas.size}`)

const blobObjs = batchRead([...allBlobShas])

let totalBytes = 0
const blobB64 = new Map()
for (const [sha, o] of blobObjs) {
  totalBytes += o.buf.length
  blobB64.set(sha, o.buf.toString('base64'))
}
console.log(`blob data : ${(totalBytes / 1024).toFixed(1)} KiB`)

// 预检：GitHub blob API 单文件上限（base64 后约 100MB 限制，实际软上限 ~50MB）
let biggest = { sha: '', len: 0 }
for (const [sha, o] of blobObjs) if (o.buf.length > biggest.len) biggest = { sha, len: o.buf.length }
console.log(`largest   : ${(biggest.len / 1024).toFixed(1)} KiB (${biggest.sha.slice(0, 8)})`)
console.log()

if (DRY) {
  console.log('DRY-RUN 就绪，未发送任何写请求。将执行：')
  console.log(`  1. POST /repos/${SLUG}/git/blobs   x${blobB64.size}`)
  console.log(`  2. POST /repos/${SLUG}/git/trees   x${allTreeShas.size}`)
  console.log(`  3. POST /repos/${SLUG}/git/commits x${commits.length}`)
  console.log(`  4. POST /repos/${SLUG}/git/refs    refs/heads/${BRANCH}`)
  process.exit(0)
}

// ---------- 1. blobs ----------
const blobMap = new Map()
let n = 0
for (const [sha, b64] of blobB64) {
  n++
  const r = await api(`/repos/${SLUG}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: b64, encoding: 'base64' }),
  })
  blobMap.set(sha, r.sha)
  if (n % 25 === 0 || n === blobB64.size) process.stdout.write(`  blobs ${n}/${blobB64.size}\r`)
}
console.log(`  blobs   ${blobMap.size}/${blobMap.size}`)

// ---------- 2. trees（按深度自底向上） ----------
const treeMap = new Map()
const treeDepth = new Map()
function depthOf(treeSha) {
  if (treeDepth.has(treeSha)) return treeDepth.get(treeSha)
  const o = treeObjs.get(treeSha)
  if (!o) return 0
  let d = 0
  for (const e of parseTree(o.buf)) if (e.type === 'tree') d = Math.max(d, 1 + depthOf(e.sha))
  treeDepth.set(treeSha, d)
  return d
}
const orderedTrees = [...allTreeShas].sort((a, b) => depthOf(a) - depthOf(b))

for (const tsha of orderedTrees) {
  const entries = parseTree(treeObjs.get(tsha).buf).map((e) => ({
    path: e.name,
    mode: e.mode,
    type: e.type,
    sha:
      e.type === 'tree' ? treeMap.get(e.sha) || e.sha
      : e.type === 'blob' ? blobMap.get(e.sha) || e.sha
      : e.sha, // submodule
  }))
  const r = await api(`/repos/${SLUG}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree: entries }),
  })
  treeMap.set(tsha, r.sha)
  if (treeMap.size % 20 === 0 || treeMap.size === orderedTrees.size)
    process.stdout.write(`  trees   ${treeMap.size}/${orderedTrees.size}\r`)
}
console.log(`  trees   ${treeMap.size}/${orderedTrees.size}`)

// ---------- 3. commits ----------
const rewrite = REWRITE_AUTHOR ? parseRewrite(REWRITE_AUTHOR) : null
const commitMap = new Map()
for (const c of commits) {
  const payload = {
    message: c.message,
    tree: treeMap.get(c.tree) || c.tree,
    parents: c.parents.map((p) => commitMap.get(p) || p),
    author: rewrite
      ? { name: rewrite.name, email: rewrite.email, date: c.author.date }
      : c.author,
    committer: rewrite
      ? { name: rewrite.name, email: rewrite.email, date: c.committer.date }
      : c.committer,
  }
  const r = await api(`/repos/${SLUG}/git/commits`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  commitMap.set(c.sha, r.sha)
}
console.log(`  commits ${commitMap.size}/${commits.length}`)

// ---------- 4. ref ----------
const localHead = commits[commits.length - 1].sha
const remoteHead = commitMap.get(localHead)
console.log()
console.log('local  HEAD :', localHead)
console.log('remote HEAD :', remoteHead)
console.log('SHAs match  :', remoteHead === localHead, rewrite ? '(expected false: author rewritten)' : '')

// 分支可能已被初始化提交占用 -> POST 失败就 PATCH
// 注意：GitHub 对「已存在的 ref」返回的是 404，不是文档里写的 422。
let ref = await rawFetch(`/repos/${SLUG}/git/refs`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: remoteHead }),
})
if (ref.status !== 200 && ref.status !== 201) {
  console.log(`  ref POST -> ${ref.status}, falling back to PATCH`)
  ref = await rawFetch(`/repos/${SLUG}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: remoteHead, force: true }),
  })
}
if (ref.status !== 200 && ref.status !== 201) {
  console.error(`ref update failed ${ref.status}: ${JSON.stringify(ref.body).slice(0, 400)}`)
  process.exit(1)
}
console.log('ref         :', ref.body.ref, '->', ref.body.object.sha)
console.log(`\ndone. API calls: ${apiCalls}`)
