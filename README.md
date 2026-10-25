# github-push-via-api

**`git push` doesn't work here. This still gets your repository onto GitHub —
every commit, author, date and message, with the same SHAs.**

An agent skill plus a single-file script. No dependencies, Node ≥ 18.

## The problem

`git push` speaks git's own protocol to `github.com:443`. Behind a proxy, a
firewall or a sandbox, that host is frequently blocked — while `api.github.com`
is allowed.

## The idea

GitHub's REST API can create git objects directly. It computes SHA-1 exactly the
way git does, so **the same bytes produce the same commit IDs**.

That means a full history can be rebuilt over `api.github.com` alone:

```
POST /git/blobs  →  POST /git/trees  →  POST /git/commits  →  PATCH /git/refs
```

No git transport involved. And since the SHAs must match, you get a free
correctness check: **with the author untouched, the remote head SHA has to equal
the local one.** If it doesn't, something is wrong — don't trust the 201s.

## Quick start

```bash
# 1. Which host is actually blocked? (this decides the whole approach)
#    ~8-line fetch probe, in SKILL.md under "Step 0"

# 2. Dry run — reads the local repo, sends no writes
REPO_DIR=/path/to/repo REPO_SLUG=owner/repo node scripts/push-via-api.mjs --dry-run

# 3. Do it
REPO_DIR=/path/to/repo REPO_SLUG=owner/repo node scripts/push-via-api.mjs
```

Environment: `REPO_DIR`, `REPO_SLUG` (required), `BRANCH` (default `main`),
`REWRITE_AUTHOR`, `GIT_EXE`, `GITHUB_TOKEN`, `FORCE=1`.

The token is read from `GITHUB_TOKEN`, then `gh auth token`, then the GitHub CLI
`hosts.yml`. It is never written to disk.

The token needs `repo`, plus `workflow` if the history touches
`.github/workflows/`. `FORCE=1` is required to overwrite a remote branch that has
commits outside your local history — without it the script refuses, because that
force update would delete them.

## What it is not

This is **not** "upload some files to a repo". It migrates a repository.

| | this tool | [azu/git-commit-push-via-github-api](https://github.com/azu/git-commit-push-via-github-api) |
| --- | --- | --- |
| Input | an existing local git repo | a list of files in memory |
| Output | the whole commit history | one new commit on top of a ref |
| Needs git installed | yes (reads local objects) | no |
| Authors / dates | preserved | not applicable |
| Verification | remote head SHA must equal local | none |

They solve different problems. Use azu's library when a server needs to write a
file to GitHub without git. Use this when you have a real repository and no way
to push it.

## Verify after pushing

Don't stop at "the API said 201". Walk the remote chain and compare against
local: commit count, messages in order, author on every commit, exact file set
(report extras *and* missing). Then scan **every remote blob** for local
usernames, absolute paths, `ghp_*` / `github_pat_*` / `sk-*` / `AKIA*` and
private-key headers.

## The traps

These are the parts that are expensive to rediscover.

**1. A missing `workflow` scope reports itself as `404`, not `403`.** If the pushed
range touches `.github/workflows/`, GitHub refuses the ref update and answers
`404 Not Found` with no explanation. GraphQL names the real reason. Fix: tick
`workflow` on the token — editing scopes does not change the token string, so
nothing has to be re-pasted.

**2. Never branch on ref-write status codes.** With a healthy token an existing
ref returns the documented `422`; while `workflow` is missing you get `404` for
everything ref-related, so the two traps look identical. Fall back to `PATCH` on
any non-2xx.

**3. Windows + Node cannot spawn git the obvious way.** `execFileSync('git')` can
fail with `EBUSY`. Mitigations: absolute `git.exe` path via a shell, far fewer
spawns (`git cat-file --batch` reads many objects per call), retry with backoff.

**4. Shell heredocs and `node -e` eat backslashes.** Regexes with `\s`, `\S`, `\/`
get mangled. Write a `.mjs` file and run that.

**5. Deleting a repo needs its own scope.** `repo` does not include it;
`DELETE /repos/{owner}/{repo}` returns `403`. A classic token needs `delete_repo`.
So don't create throwaway diagnostic repos you can't clean up.

Full detail, including the measured status codes and the decision procedure, is in
[`SKILL.md`](SKILL.md).

## Honest limits

- Rebuilds **commits and refs** — not submodules, LFS, tags or release assets.
- Per-blob 100 MB cap, plus normal API rate limits. The script prints its call
  count so you can see where you are.
- Fine-grained tokens send no `x-oauth-scopes` header, so probe capability by
  calling an endpoint instead of reading headers.

## Contents

| Path | What it is |
| --- | --- |
| [`SKILL.md`](SKILL.md) | The agent skill: decision procedure, token probing, traps, verification. |
| [`scripts/push-via-api.mjs`](scripts/push-via-api.mjs) | The implementation. |
| [`README.zh.md`](README.zh.md) | 中文版。 |

## License

MIT
