<div align="center">

# github-push-via-api

When `git push` cannot reach `github.com:443` but `api.github.com` is reachable, upload existing local Git history through the GitHub Git Data API.

This is a fallback for restricted networks. Use regular `git push` when it works.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](scripts/push-via-api.mjs)
[![CI](https://github.com/tianyao2003/github-push-via-api/actions/workflows/ci.yml/badge.svg)](https://github.com/tianyao2003/github-push-via-api/actions/workflows/ci.yml)

[中文](README.md) · **English**

</div>

---

## When to use it

This tool is for cases where:

- `git push` cannot reach `github.com:443` because of a proxy, firewall, sandbox, or network policy;
- `api.github.com` is reachable;
- the local repository already contains the Git history to upload;
- you want to preserve the original parent relationships, authors, dates, and messages as far as the current implementation allows.

If regular `git push` works, use it. This tool is a fallback for Git transport restrictions.

## Quick start

The script has no third-party dependencies. It requires Node.js 18+ and Git. The destination repository must already exist.

Run a dry run first to inspect the local range, object counts, token, and target branch:

```bash
REPO_DIR=/path/to/repo REPO_SLUG=owner/repo BRANCH=main node scripts/push-via-api.mjs --dry-run
```

After reviewing the dry run, push the history:

```bash
REPO_DIR=/path/to/repo REPO_SLUG=owner/repo BRANCH=main node scripts/push-via-api.mjs
```

At the end, the script prints both heads and compares their SHAs:

```text
local  HEAD : <sha>
remote HEAD : <sha>
SHAs match  : true
```

## Token and configuration

The token stays in process memory and is never written to disk. The script looks for it in this order:

1. `GITHUB_TOKEN`
2. `gh auth token`
3. the GitHub CLI `hosts.yml`

A classic token usually needs the `repo` scope. If the history touches `.github/workflows/`, it also needs the `workflow` scope. A fine-grained token needs Contents write access to the destination repository.

| Variable | Meaning |
| --- | --- |
| `REPO_DIR` | Local repository; defaults to the current directory |
| `REPO_SLUG` | GitHub `owner/repo`; required |
| `BRANCH` | Remote target branch; defaults to `main`. The same ref must resolve locally |
| `REWRITE_AUTHOR` | `"Name <email>"`; rewrites both author and committer on every commit |
| `GIT_EXE` | Absolute Git path used when auto-detection fails |
| `GITHUB_TOKEN` | Explicit GitHub token |
| `FORCE` | Set to `1` to overwrite a remote branch containing commits outside local history |

## Safety boundary

The final step force-updates the remote branch. If that branch contains a commit outside the local history, the script prints both heads and exits with code 2.

Only set this variable after confirming that replacing the remote history is safe:

```bash
FORCE=1 REPO_DIR=/path/to/repo REPO_SLUG=owner/repo node scripts/push-via-api.mjs
```

The script may create GitHub objects before the final ref update. If a run fails midway, orphaned objects may remain; inspect the remote branch before retrying.

## SHA preservation

GitHub uses the same object hashing algorithm as Git. For ordinary unsigned commits supported by the current script, with `REWRITE_AUTHOR` unset and all commit metadata reconstructible, the remote HEAD can usually retain the local SHA.

The current version does not guarantee identical SHAs for:

- commits using non-whole-hour time zones;
- commits with `gpgsig`, `mergetag`, or other extra commit headers;
- commits whose author or committer is rewritten.

The script compares the local and remote HEAD at the end. If they differ, treat the result as needing further inspection rather than assuming the histories are fully equivalent.

## Current limits

- Rebuilds commits, trees, blobs, and branch refs only;
- submodules, Git LFS objects, tags, and release assets are out of scope;
- each blob is subject to GitHub's 100 MB limit and normal API rate limits;
- `BRANCH` must resolve in the local repository;
- the destination repository must already exist; repository creation is a separate preparation step;
- `REWRITE_AUTHOR` changes commit SHAs by design.

## How it works

1. Read commit order with `git rev-list` and batch-read trees and blobs with `git cat-file --batch`.
2. Create blobs, trees by depth, and commits in order through the Git Data API.
3. Point the target branch at the new head.
4. Compare the local and remote HEAD SHAs.

For network diagnosis, token capability checks, 404/422 behavior, Windows `EBUSY`, and the full verification procedure, see [SKILL.md](SKILL.md).

## Install

```bash
git clone https://github.com/tianyao2003/github-push-via-api
```

To use it as an agent skill, copy `SKILL.md` into your runtime's skills directory, or point your agent at this repository.

## Repository structure

```text
github-push-via-api/
├── SKILL.md                    # Agent skill: decisions, permissions, and troubleshooting
├── README.md                   # Chinese documentation
├── README_EN.md                # English documentation
└── scripts/
    └── push-via-api.mjs        # Zero-dependency Node.js implementation
```

## License

MIT


