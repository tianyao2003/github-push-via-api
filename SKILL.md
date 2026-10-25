---
name: github-push-via-api
description: Push a local git repository, including its full commit history, to GitHub through the REST Git Data API when `git push` cannot reach github.com — a blocking proxy, no SSH, no git-over-HTTPS egress, or a sandbox that only allows api.github.com. Covers the status codes that are easy to misread: a ref write returning 404 when the token lacks the `workflow` scope and the pushed range touches .github/workflows/, and 422 for a ref that already exists. Use when the user asks to publish or release a repo to GitHub, when `git push` fails with "CONNECT tunnel failed" / "Could not connect to server" / "Could not resolve host", when ref writes return 404 while ref reads return 200, or when the user needs to know which token scopes to grant.
description_zh: "git push 不通时用 Git Data API 推送完整提交历史，以及 ref 写入返回 404 / 422 时的排查路径"
description_en: "Push full git history to GitHub via the Git Data API when git push is blocked, and read the ref-write status codes correctly"
license: MIT
---

# Push git history to GitHub when `git push` is impossible

`git push` needs `github.com:443` over the git smart-HTTP protocol. In locked-down
or proxied environments that host is often blocked while `api.github.com` is
allowed. The Git Data API (`/git/blobs`, `/git/trees`, `/git/commits`,
`/git/refs`) lives entirely on `api.github.com`, so it can rebuild an exact
commit history — messages, authorship, dates, and **identical SHAs** — with no
git transport at all.

Bundled script: `scripts/push-via-api.mjs` (run `--dry-run` first).

## Step 0 — establish what is actually blocked

Test each host separately before designing around it:

```js
for (const [name, url] of [
  ['api.github.com',    'https://api.github.com/rate_limit'],
  ['github.com (git)',  'https://github.com/OWNER/REPO.git/info/refs?service=git-upload-pack'],
  ['codeload',          'https://codeload.github.com/OWNER/REPO/tar.gz/refs/heads/main'],
]) {
  try { console.log(name, (await fetch(url)).status) }
  catch (e) { console.log(name, 'ERR', e.message) }
}
```

If `github.com` fails while `api.github.com` returns 200, the Git Data API is the
way. Also check for proxy env (`HTTP_PROXY`/`HTTPS_PROXY`) — unsetting them may
make things worse, not better: a direct connection is often blocked when the
proxy is the only egress.

## Step 1 — check token capability before doing any work

Two independent things must hold, and they are checked differently.

**Can it create the repo / reach private repos?**
```js
GET /user/repos?per_page=1&visibility=private   // 0 results => token covers public repos only
```
A classic PAT needs the `repo` scope. A fine-grained PAT needs *Repository
access = All repositories* **plus** `Administration: read and write` to create a
repo, and `Contents: read and write` to push. `GET /user` returns the granted
scopes in the `x-oauth-scopes` response header **for classic tokens only** —
fine-grained tokens send no scope header, so probe capability instead.

**Does it carry the `workflow` scope?** See trap 1 below. This is the most
frequent cause of a confusing failure in this workflow.

## Step 2 — create the repo with `auto_init: true`

```js
POST /user/repos { name, private: true, auto_init: true }
```

`auto_init: true` makes GitHub create a real initial commit. Do **not** use
`auto_init: false`: an "empty repository" is a distinct internal state, and it
gives misleading errors later. (It is not the cause of the workflow-scope 404 —
that was a red herring — but it removes a variable and makes the first commit
reachable.)

If you must use an empty repo, bootstrap it first with
`PUT /repos/{owner}/{repo}/contents/{path}`; `/git/blobs` refuses an empty repo
with `409 Git Repository is empty`.

## Step 3 — push

```
REPO_DIR=<local repo>  REPO_SLUG=owner/repo  node scripts/push-via-api.mjs --dry-run
REPO_DIR=<local repo>  REPO_SLUG=owner/repo  REWRITE_AUTHOR='Name <email>' node scripts/push-via-api.mjs
```

The script reads local objects, POSTs blobs → trees (bottom-up) → commits (in
order, preserving parents), then points the branch at the new head.

The last step force-overwrites the branch. If the remote branch already holds a
commit that is not in your local history, that update would delete remote work,
so the script exits with code 2 and prints both heads. `FORCE=1` is the explicit
opt-in; before setting it, work out whose commit that is.

**GitHub computes SHA-1 the same way git does, so identical content yields
identical SHAs.** If `REWRITE_AUTHOR` is unset, the remote head SHA equals the
local one — a free correctness check. If it is set, SHAs differ by design.

## Status codes and pitfalls

### 1. A missing `workflow` scope returns 404

If the pushed range adds or modifies anything under `.github/workflows/`, GitHub
rejects the ref update unless the token has the **`workflow`** scope. The error
is **`404 Not Found`** — not 403, and with no explanation:

```
POST /repos/{owner}/{repo}/git/refs -> 404
{"message":"Not Found","documentation_url":"https://docs.github.com/rest/git/refs#create-a-reference"}
```

GraphQL returns the real reason — use it to confirm:

```graphql
mutation { createRef(input:{repositoryId:"R_...", name:"refs/heads/x", oid:"<sha>"}) { ref { name } } }
# => "<your-login> does not have the correct permissions to execute `CreateRef`"
```

**Confirming test:** create a commit whose tree is the target tree with
`.github` removed, and try to reference it. 201 on the trimmed commit plus 404 on
the original confirms the workflow file is the cause.

`git push` reports this correctly as *"refusing to allow a Personal Access Token
to create or update workflow … without `workflow` scope"* — so if the user has a
working terminal, that message shortens the diagnosis. The Contents API is
blocked by the same rule, so there is no way around it.

**Fix:** have the user tick `workflow` on the existing token at
https://github.com/settings/tokens. Editing scopes keeps the token string
unchanged, so nothing has to be re-pasted. Alternatively drop the workflow file
— and then also drop any CI badge from the README, or it renders broken.

### 2. Ref-write status codes need a fallback, not a branch

Measured with a correctly-scoped token (the values are stable; re-run to confirm):

```
GET  /repos/o/r/git/ref/heads/main        -> 200
POST /repos/o/r/git/refs {ref, sha}       -> 422 {"message":"Reference already exists"}
PATCH /repos/o/r/git/refs/heads/main      -> 200
DELETE /repos/o/r/git/refs/heads/main     -> 422 {"message":"Cannot delete the default branch"}
```

With a healthy token the existing-ref case is the documented `422`. While the
`workflow` scope is missing, however, every ref operation returns `404` —
including this one — which hides the real conflict and makes the two cases look
identical. So branch on the operation, not the code: fall back to `PATCH` on any
non-2xx.

```js
let ref = await POST(`/git/refs`, {ref:'refs/heads/main', sha})
if (ref.status !== 200 && ref.status !== 201) {
  ref = await PATCH(`/git/refs/heads/main`, {sha, force:true})
}
```

Deleting and recreating the default branch does not work either:
`DELETE /git/refs/heads/main` returns `422 "Cannot delete the default branch"`.

### 3. Windows + Node: git spawning can fail with `EBUSY`

Observed under a restricted sandbox:

- `execFileSync('git', args)` → `spawnSync git EBUSY`
- repeated `execSync` in a loop → `spawnSync C:\Windows\system32\cmd.exe EBUSY`

This is **not universal** — the same code spawned git 30/30 times without error
on an ordinary Windows session, so treat it as an environment-dependent failure
rather than a rule. Building for it costs little, because the failure gives no
hint about which of the three causes it is:

- use the **absolute path** to `git.exe` via a shell
- **minimise spawns** (`git cat-file --batch < shafile` reads many objects in one
  call; walk trees breadth-first, one batch per depth)
- **retry** on `EBUSY`/`EAGAIN` with a short backoff

If you hit `EBUSY` and cannot explain it, check whether a sandbox is confining the
process before redesigning the code — that was the cause in the case recorded here.

### 4. Bash heredocs and `node -e` eat backslashes

Regexes containing `\s`, `\S`, or `\/` get mangled (`Bad substitution`,
`missing ) after argument list`). Write a `.mjs` file with a file-writing tool
and execute that instead.

### 5. Repo deletion needs its own scope

`repo` does **not** include deleting repositories — `DELETE /repos/{owner}/{repo}`
returns `403 "Must have admin rights to Repository."`. A classic token needs
`delete_repo`; without it, deletion happens in the web UI. This is worth knowing
before creating throwaway diagnostic repos that cannot be cleaned up.

## Verify after pushing

"The API said 201" is not a verification. Walk the remote chain and compare
against local, then scan every remote blob:

- commit count, and each commit message in order
- author on every commit
- file count and the exact file set (report extras *and* missing)
- **sensitive-string scan over every remote file**: local usernames, absolute
  paths, `ghp_*` / `github_pat_*` / `sk-*` / `AKIA*` / private-key headers

Rewriting history to remove a leaked string is possible (`git filter-branch
--tree-filter`, then delete `refs/original/...`, `git reflog expire --expire=now
--all`, `git gc --prune=now`), but verify at the **object level**, not only at
HEAD: `git cat-file --batch-all-objects --batch-check` must show zero matching
blobs, because reachable-commit greps miss dangling objects.
