---
name: github-push-via-api
description: Push a local git repository (full commit history, not just files) to GitHub using the REST Git Data API when `git push` cannot work — a blocking proxy, no SSH, no git-over-HTTPS egress, or a sandbox that only allows api.github.com. Also diagnoses the two failures that look like permission bugs but are not: GitHub returning 404 (not 403) when a token lacks the `workflow` scope and the pushed range adds a file under .github/workflows/, and the 404 returned for "ref already exists". Use when the user asks to publish/release a repo to GitHub, when `git push` fails with "CONNECT tunnel failed" / "Could not connect to server" / "Could not resolve host", when ref writes return 404 while ref reads return 200, or when the user must be told which token scopes to grant.
description_zh: "git push 不通时用 Git Data API 推送完整提交历史，并排查 workflow scope 导致的假 404"
description_en: "Push full git history to GitHub via the Git Data API when git push is blocked, and diagnose the workflow-scope 404"
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

Never assume. Test each host separately before designing around it:

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

**Does it carry the `workflow` scope?** See the trap below. This is the single
most expensive mistake in this workflow.

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

**GitHub computes SHA-1 the same way git does, so identical content yields
identical SHAs.** If `REWRITE_AUTHOR` is unset, the remote head SHA equals the
local one — a free, decisive correctness check. If it is set, SHAs differ by
design.

## The traps

### 1. `workflow` scope masquerades as a 404

If the pushed range adds or modifies anything under `.github/workflows/`, GitHub
refuses the ref update unless the token has the **`workflow`** scope. The error
is **`404 Not Found`** — not 403, and with no explanation:

```
POST /repos/{owner}/{repo}/git/refs -> 404
{"message":"Not Found","documentation_url":"https://docs.github.com/rest/git/refs#create-a-reference"}
```

GraphQL is more honest and gives you the real reason — use it to confirm:

```graphql
mutation { createRef(input:{repositoryId:"R_...", name:"refs/heads/x", oid:"<sha>"}) { ref { name } } }
# => "<your-login> does not have the correct permissions to execute `CreateRef`"
```

**Decisive test:** create a commit whose tree is the target tree with `.github`
removed, and try to reference it. 201 on the trimmed commit + 404 on the
original proves the workflow file is the cause.

`git push` reports this correctly as *"refusing to allow a Personal Access Token
to create or update workflow … without `workflow` scope"* — so if the user has a
working terminal, that message is a shortcut to the diagnosis. The Contents API
is blocked by the same rule, so there is no way around it.

**Fix:** have the user tick `workflow` on the existing token at
https://github.com/settings/tokens. Editing scopes keeps the token string
unchanged, so nothing has to be re-pasted. Alternatively drop the workflow file
— but then also drop any CI badge from the README, or it renders broken.

### 2. Never branch on the ref-write status code alone

Measured with a correctly-scoped token (re-run it yourself, the value is stable):

```
GET  /repos/o/r/git/ref/heads/main        -> 200
POST /repos/o/r/git/refs {ref, sha}       -> 422 {"message":"Reference already exists"}
PATCH /repos/o/r/git/refs/heads/main      -> 200
DELETE /repos/o/r/git/refs/heads/main     -> 422 {"message":"Cannot delete the default branch"}
```

So with a healthy token the existing-ref case is the documented `422`. **But while
the `workflow` scope is missing you get `404` for everything ref-related** —
including this one — which hides the real conflict and makes the two traps look
identical. Never branch on the status code alone; fall back to `PATCH` on any
non-2xx:

```js
let ref = await POST(`/git/refs`, {ref:'refs/heads/main', sha})
if (ref.status !== 200 && ref.status !== 201) {
  ref = await PATCH(`/git/refs/heads/main`, {sha, force:true})
}
```

Do not delete and recreate the default branch: `DELETE /git/refs/heads/main`
returns `422 "Cannot delete the default branch"`.

### 3. Windows + Node cannot spawn git the obvious way

- `execFileSync('git', args)` → `spawnSync git EBUSY`
- repeated `execSync` in a loop → `spawnSync C:\Windows\system32\cmd.exe EBUSY`

Three mitigations, all needed: use the **absolute path** to `git.exe` via a
shell; **minimise spawns** (`git cat-file --batch < shafile` reads many objects
in one call; walk trees breadth-first, one batch per depth); and **retry** on
`EBUSY`/`EAGAIN` with a short backoff.

### 4. Bash heredocs and `node -e` eat backslashes

Regexes containing `\s`, `\S`, or `\/` get mangled (`Bad substitution`,
`missing ) after argument list`). Write a `.mjs` file with a file-writing tool
and execute that instead.

### 5. Repo deletion needs its own scope

`repo` does **not** include deleting repositories — `DELETE /repos/{owner}/{repo}`
returns `403 "Must have admin rights to Repository."`. A classic token needs
`delete_repo`. Without it, the user must delete from the web UI. So avoid
creating throwaway diagnostic repos you cannot clean up.

## Verify after pushing

Do not stop at "the API said 201". Walk the remote chain and compare against
local, then scan every remote blob:

- commit count, and each commit message in order
- author on every commit
- file count and the exact file set (report extras *and* missing)
- **sensitive-string scan over every remote file**: local usernames, absolute
  paths, `ghp_*` / `github_pat_*` / `sk-*` / `AKIA*` / private-key headers

Rewriting history to remove a leaked string is possible (`git filter-branch
--tree-filter`, then delete `refs/original/...`, `git reflog expire --expire=now
--all`, `git gc --prune=now`) but verify at the **object level**, not just at
HEAD: `git cat-file --batch-all-objects --batch-check` must show zero matching
blobs, because reachable-commit greps miss dangling objects.
