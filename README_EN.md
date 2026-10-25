<div align="center">

# github-push-via-api

Rebuild a local git history on GitHub through the REST Git Data API — same commits, same authors, same SHAs.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](scripts/push-via-api.mjs)
[![CI](https://github.com/tianyao2003/github-push-via-api/actions/workflows/ci.yml/badge.svg)](https://github.com/tianyao2003/github-push-via-api/actions/workflows/ci.yml)

[中文](README.md) · **English**

</div>

---

`git push` needs `github.com:443` speaking git's smart-HTTP protocol. In proxied, firewalled or sandboxed environments that host is often unreachable, while `api.github.com` usually is.

This repository contains an agent skill and a zero-dependency Node script that do the same job over the Git Data API:

```
POST /git/blobs  →  POST /git/trees  →  POST /git/commits  →  PATCH /git/refs
```

GitHub computes object SHA-1 exactly the way git does, so identical content yields identical commit IDs. With the author untouched, the remote head SHA matches the local one.

## Example

```console
$ REPO_DIR=~/src/my-project REPO_SLUG=me/my-project node scripts/push-via-api.mjs --dry-run
branch main not present -> DRY-RUN would initialise the repo first

repo dir  : /home/me/src/my-project
target    : me/my-project  (branch main)
mode      : DRY-RUN (no writes)

commits   : 42
trees     : 118
blobs     : 396
blob data : 2.1 MiB
largest   : 184.2 KiB (7f3a91c2)

DRY-RUN ready - no writes sent. Would perform:
  1. POST /repos/me/my-project/git/blobs   x396
  2. POST /repos/me/my-project/git/trees   x118
  3. POST /repos/me/my-project/git/commits x42
  4. POST /repos/me/my-project/git/refs    refs/heads/main
```

A live push ends by printing both heads:

```
local  HEAD : 8f2c1d4e9a7b3f05c6d18e2a4b70935f1c8d6e2a
remote HEAD : 8f2c1d4e9a7b3f05c6d18e2a4b70935f1c8d6e2a
SHAs match  : true
```

Matching SHAs mean the history was rebuilt byte for byte.

## Install

The script has no dependencies and runs on Node 18 or newer:

```bash
git clone https://github.com/tianyao2003/github-push-via-api
```

To use it as an agent skill, copy `SKILL.md` into your runtime's skills directory, or point your agent at this repository.

## Usage

```bash
# Dry run: reads the local repository, sends no writes
REPO_DIR=/path/to/repo REPO_SLUG=owner/repo node scripts/push-via-api.mjs --dry-run

# Push
REPO_DIR=/path/to/repo REPO_SLUG=owner/repo node scripts/push-via-api.mjs
```

| Variable | Meaning |
| --- | --- |
| `REPO_DIR` | Local repository (default: current directory) |
| `REPO_SLUG` | `owner/repo` on GitHub (required) |
| `BRANCH` | Branch to point at (default `main`) |
| `REWRITE_AUTHOR` | `"Name <email>"` to rewrite every commit author |
| `GIT_EXE` | Absolute path to git, if auto-detection fails |
| `GITHUB_TOKEN` | Token; falls back to `gh auth token`, then the GitHub CLI `hosts.yml` |
| `FORCE` | Set to `1` to overwrite a remote branch that has commits outside local history |

The token stays in process memory and is never written to disk. It needs the `repo` scope, plus `workflow` if the history touches `.github/workflows/`.

The final step force-updates the branch. If the remote branch holds a commit outside the local history, the script prints both heads and exits with code 2. `FORCE=1` continues.

## How it works

1. Read the local repository: `git rev-list` for commits, then a breadth-first walk of every tree and blob, batched through `git cat-file --batch`.
2. Recreate objects on GitHub: blobs first, then trees bottom-up by depth, then commits in order with their original parents, author, committer, dates and messages.
3. Point the branch at the new head.
4. Compare the remote head SHA against the local one.

## Failure modes

Recorded in [`SKILL.md`](SKILL.md) with the measured status codes and the full decision procedure.

- **A missing `workflow` scope returns `404` rather than `403`.** It appears when the pushed range touches `.github/workflows/`. GraphQL reports the specific reason. Adding the scope to an existing token does not change the token string.
- **Ref-write status codes are ambiguous.** An existing ref returns `422`; a token missing `workflow` returns `404` for every ref operation. The script falls back to `PATCH` on any non-2xx.
- **Spawning git from Node on Windows can return `EBUSY`.** Observed under a restricted sandbox. The script calls an absolute `git.exe` through a shell, batches object reads, and retries with backoff.
- **Shell heredocs and `node -e` consume backslashes.** Regexes containing `\s`, `\S` or `\/` break; write a `.mjs` file and run it.
- **Deleting a repository needs `delete_repo`.** The `repo` scope does not include it.

## Limits

- Rebuilds commits and refs. Submodules, LFS, tags and release assets are out of scope.
- Per-blob limit is 100 MB, plus the normal API rate limits. The script prints its API call count.
- Fine-grained tokens send no `x-oauth-scopes` header, so capability is probed by calling an endpoint rather than reading headers.

## Repository structure

```
github-push-via-api/
├── SKILL.md                    # The agent skill: decision procedure, token probing, failure modes
├── README.md                   # 中文
├── README_EN.md                # English
└── scripts/
    └── push-via-api.mjs        # The implementation
```

## License

MIT
