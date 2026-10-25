# github-push-via-api

An agent skill + a single-file script for the case where **`git push` cannot
work**, but you still need the real history on GitHub — every commit, author,
date, and message, with **identical SHAs**.

`git push` needs `github.com:443` speaking git's smart-HTTP protocol. In locked-down
or proxied environments that host is frequently blocked while `api.github.com` is
allowed. The Git Data API lives entirely on `api.github.com`:

```
/git/blobs  →  /git/trees  →  /git/commits  →  /git/refs
```

so a full commit history can be rebuilt with no git transport at all. GitHub
computes object SHA-1 exactly the way git does, so identical content yields
identical SHAs — which gives you a free, decisive correctness check: with the
author left untouched, the remote head SHA must equal the local one.

## Contents

| Path | What it is |
| --- | --- |
| [`SKILL.md`](SKILL.md) | The agent skill: decision procedure, token-capability probing, the traps, and post-push verification. |
| [`scripts/push-via-api.mjs`](scripts/push-via-api.mjs) | The implementation. Zero dependencies, Node ≥ 18. |

## Usage

```bash
REPO_DIR=/path/to/local/repo REPO_SLUG=owner/repo node scripts/push-via-api.mjs --dry-run
REPO_DIR=/path/to/local/repo REPO_SLUG=owner/repo node scripts/push-via-api.mjs
```

Environment: `REPO_DIR`, `REPO_SLUG` (required), `BRANCH` (default `main`),
`REWRITE_AUTHOR='Name <email>'`, `GIT_EXE`, `GITHUB_TOKEN`.

Token lookup order: `GITHUB_TOKEN` → `gh auth token` → the GitHub CLI `hosts.yml`.
Nothing is persisted; the token lives only in the process.

## Step 0 is a measurement, not an assumption

Before designing around a blocked host, test each host separately:

```js
for (const [name, url] of [
  ['api.github.com',   'https://api.github.com/rate_limit'],
  ['github.com (git)', 'https://github.com/OWNER/REPO.git/info/refs?service=git-upload-pack'],
  ['codeload',         'https://codeload.github.com/OWNER/REPO/tar.gz/refs/heads/main'],
]) {
  try { console.log(name, (await fetch(url)).status) }
  catch (e) { console.log(name, 'ERR', e.message) }
}
```

A machine can have `api.github.com` at 200 and `github.com` unreachable at the
same time; it can also have the opposite. The answer decides the whole approach,
and it changes over minutes.

## The traps (this is the part that is hard to rediscover)

### 1. A missing `workflow` scope reports itself as `404`, not `403`

If the pushed range adds or modifies anything under `.github/workflows/`, GitHub
refuses the ref update unless the token carries the **`workflow`** scope — and the
API answers `404 Not Found`, with no explanation. GraphQL is more honest and
names the real reason (`does not have the correct permissions to execute
CreateRef`).

The fix is to tick `workflow` on the existing token: editing scopes does not
change the token string, so nothing has to be re-pasted. There is no way around
the rule — the Contents API is blocked by it too.

### 2. Do not branch on ref-write status codes

Measured against a correctly-scoped token:

```
GET  /repos/o/r/git/ref/heads/main        -> 200
POST /repos/o/r/git/refs {ref, sha}       -> 422 {"message":"Reference already exists"}
PATCH /repos/o/r/git/refs/heads/main      -> 200
DELETE /repos/o/r/git/refs/heads/main     -> 422 {"message":"Cannot delete the default branch"}
```

With a healthy token the existing-ref case is the documented `422`. **While the
`workflow` scope is missing you get `404` for everything ref-related**, including
this one — which makes the two traps look identical. So: fall back to `PATCH` on
any non-2xx, and never create a throwaway branch you cannot delete.

### 3. Windows + Node cannot spawn git the obvious way

`execFileSync('git', ...)` → `spawnSync git EBUSY`; a loop of `execSync` calls →
`spawnSync cmd.exe EBUSY`. Three mitigations, all needed: an absolute `git.exe`
path via a shell, far fewer spawns (`git cat-file --batch` reads many objects in
one call), and retry with backoff.

### 4. Shell heredocs and `node -e` eat backslashes

Regexes containing `\s`, `\S`, `\/` get mangled into `Bad substitution` /
`missing ) after argument list`. Write a `.mjs` file and run that.

### 5. Deleting a repo needs its own scope

`repo` does not include deletion: `DELETE /repos/{owner}/{repo}` returns
`403 "Must have admin rights to Repository."`. A classic token needs
`delete_repo`. Avoid creating throwaway diagnostic repos you cannot clean up.

## Verify after pushing

Do not stop at "the API said 201". Walk the remote chain and compare it against
local — commit count, message order, author, exact file set (report extras *and*
missing) — then scan **every remote blob** for local usernames, absolute paths,
`ghp_*` / `github_pat_*` / `sk-*` / `AKIA*` and private-key headers.

If something leaked, rewriting history is possible but must be verified at the
object level: `git cat-file --batch-all-objects --batch-check` has to show zero
matching blobs, because greps over reachable commits miss dangling objects.

## Honest limits

- It rebuilds **commits and refs**, not submodules, LFS, tags, or release assets.
- Large repositories hit the per-blob 100 MB limit and rate limits; the script
  prints API call counts so you can see where you are.
- Anonymous or fine-grained tokens do not send `x-oauth-scopes`, so probe
  capability by calling an endpoint instead of reading headers.

## License

MIT
