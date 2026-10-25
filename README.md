# github-push-via-api

**`git push` doesn't work here. This still gets your repo onto GitHub — every
commit, author, date and message, with the same SHAs.**

An agent skill plus a single-file script. Zero dependencies, Node ≥ 18.

## The problem

`git push` speaks git's own protocol to `github.com:443`. Behind a proxy, a
firewall or a sandbox that host is often blocked — while `api.github.com` is
allowed.

## The idea

GitHub's REST API can create git objects directly, and it computes SHA-1 exactly
the way git does. Same bytes, same commit IDs.

So a whole history can be rebuilt over `api.github.com` alone:

```
POST /git/blobs  →  POST /git/trees  →  POST /git/commits  →  PATCH /git/refs
```

No git transport involved. And because the SHAs must match, you get a free
correctness check: **with the author untouched, the remote head SHA has to equal
the local one.** If it doesn't, something is wrong — don't trust the 201s.

## Quick start

```bash
# 1. Which host is actually blocked? This decides the whole approach.
#    ~8-line fetch probe, see "Step 0" in SKILL.md

# 2. Dry run: reads the local repo, sends no writes
REPO_DIR=/path/to/repo REPO_SLUG=owner/repo node scripts/push-via-api.mjs --dry-run

# 3. Do it
REPO_DIR=/path/to/repo REPO_SLUG=owner/repo node scripts/push-via-api.mjs
```

Environment: `REPO_DIR`, `REPO_SLUG` (required), `BRANCH` (default `main`),
`REWRITE_AUTHOR`, `GIT_EXE`, `GITHUB_TOKEN`, `FORCE=1`.

The token is read from `GITHUB_TOKEN`, then `gh auth token`, then the GitHub CLI
`hosts.yml`. It is never written to disk. It needs `repo`, plus `workflow` if the
history touches `.github/workflows/`.

`FORCE=1` is required to overwrite a remote branch holding commits that are not in
your local history. Without it the script refuses (exit 2) and prints both heads:
that force update would delete them.

## Not a file uploader

This migrates a repository; it doesn't push a few files. That's a different
problem, and [azu/git-commit-push-via-github-api](https://github.com/azu/git-commit-push-via-github-api)
already solves it well:

| | this tool | azu's library |
| --- | --- | --- |
| Input | an existing local git repo | a list of files in memory |
| Output | the whole commit history | one new commit on top of a ref |
| Needs git installed | yes (reads local objects) | no |
| Authors / dates | preserved | not applicable |
| Verification | remote head SHA must equal local | none |

Use azu's when a server needs to write a file to GitHub without git. Use this
when you have a real repository and no way to push it.

## The traps

The expensive part, and the reason this exists. Full detail in [`SKILL.md`](SKILL.md).

1. **A missing `workflow` scope reports itself as `404`, not `403`.** If the pushed
   range touches `.github/workflows/`, the ref update is refused with a bare
   `404`. GraphQL names the real reason. Fix by ticking `workflow` on the token —
   editing scopes doesn't change the token string.
2. **Never branch on ref-write status codes.** Healthy token: existing ref returns
   the documented `422`. Missing `workflow`: everything ref-related returns `404`,
   so the two traps look identical. Fall back to `PATCH` on any non-2xx.
3. **Windows + Node: git spawning can fail with `EBUSY`.** Seen under a
   sandbox, not on every Windows session — but build for it: absolute `git.exe`
   via a shell, fewer spawns (`git cat-file --batch`), retry with backoff.
4. **Shell heredocs and `node -e` eat backslashes.** Write a `.mjs` file instead.
5. **Deleting a repo needs `delete_repo`.** `repo` doesn't include it, so don't
   create throwaway diagnostic repos you can't clean up.

## Verify after pushing

Don't stop at "the API said 201". Walk the remote chain and compare with local:
commit count, messages in order, author on every commit, exact file set (report
extras *and* missing). Then scan **every remote blob** for local usernames,
absolute paths, `ghp_*` / `github_pat_*` / `sk-*` / `AKIA*` and private-key
headers.

## Limits

- Rebuilds **commits and refs** — not submodules, LFS, tags or release assets.
- Per-blob 100 MB cap, plus normal API rate limits. The script prints its call
  count.
- Fine-grained tokens send no `x-oauth-scopes` header, so probe capability by
  calling an endpoint.

## Files

| Path | What it is |
| --- | --- |
| [`SKILL.md`](SKILL.md) | The agent skill: decision procedure, token probing, traps, verification. |
| [`scripts/push-via-api.mjs`](scripts/push-via-api.mjs) | The implementation. |
| [`README.zh.md`](README.zh.md) | 中文版。 |

## License

MIT
