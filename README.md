<div align="center">

# github-push-via-api

用 GitHub REST API 重建本地 git 提交历史 —— 同样的 commit、作者与 SHA。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](scripts/push-via-api.mjs)
[![CI](https://github.com/tianyao2003/github-push-via-api/actions/workflows/ci.yml/badge.svg)](https://github.com/tianyao2003/github-push-via-api/actions/workflows/ci.yml)

**中文** · [English](README_EN.md)

</div>

---

`git push` 需要 `github.com:443` 走 git 的 smart-HTTP 协议。在代理、防火墙或沙箱环境里，这个域名经常不通，而 `api.github.com` 通常可以访问。

这个仓库提供一个 agent skill 和一个零依赖的 Node 脚本，用 Git Data API 完成同样的事：

```
POST /git/blobs  →  POST /git/trees  →  POST /git/commits  →  PATCH /git/refs
```

GitHub 计算对象 SHA-1 的方式与 git 一致，所以同样的内容会得到同样的 commit ID。不修改作者的情况下，远端 head 的 SHA 与本地相同。

## 示例

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

实际推送结束后会打印两边的 head：

```
local  HEAD : 8f2c1d4e9a7b3f05c6d18e2a4b70935f1c8d6e2a
remote HEAD : 8f2c1d4e9a7b3f05c6d18e2a4b70935f1c8d6e2a
SHAs match  : true
```

两行 SHA 相同，说明历史是逐字节重建的。

## 安装

脚本零依赖，Node 18 及以上即可运行：

```bash
git clone https://github.com/tianyao2003/github-push-via-api
```

作为 agent skill 使用时，把 `SKILL.md` 放进所用 runtime 的 skills 目录，或让 agent 直接读取本仓库完成安装。

## 使用

```bash
# 空跑：读取本地仓库，不发出写请求
REPO_DIR=/path/to/repo REPO_SLUG=owner/repo node scripts/push-via-api.mjs --dry-run

# 推送
REPO_DIR=/path/to/repo REPO_SLUG=owner/repo node scripts/push-via-api.mjs
```

| 环境变量 | 说明 |
| --- | --- |
| `REPO_DIR` | 本地仓库路径，默认为当前目录 |
| `REPO_SLUG` | GitHub 上的 `owner/repo`，必填 |
| `BRANCH` | 要指向的分支，默认 `main` |
| `REWRITE_AUTHOR` | `"Name <email>"`，用于改写全部提交的作者 |
| `GIT_EXE` | git 的绝对路径，自动探测失败时使用 |
| `GITHUB_TOKEN` | token；缺省时依次读取 `gh auth token` 和 GitHub CLI 的 `hosts.yml` |
| `FORCE` | 设为 `1` 时允许覆盖远端存在本地历史之外提交的分支 |

token 只存在于进程内存中，不写入磁盘。需要 `repo` 权限；如果历史里包含 `.github/workflows/`，还需要 `workflow` 权限。

最后一步会强制更新分支。如果远端分支上有本地历史之外的提交，脚本会打印两边的 head 并以退出码 2 结束；设置 `FORCE=1` 才会继续。

## 工作原理

1. 读取本地仓库：用 `git rev-list` 取提交列表，再按层遍历每个 tree 和 blob，通过 `git cat-file --batch` 批量读取。
2. 在 GitHub 上重建对象：先 blobs，再按深度自底向上建 trees，最后按顺序建 commits，保留原有的父提交、作者、提交者、时间与 message。
3. 把分支指向新的 head。
4. 比对远端与本地 head 的 SHA。

## 失败模式

以下是实际遇到并记录在 [`SKILL.md`](SKILL.md) 中的情况，包含实测状态码与完整的判断流程。

- **缺少 `workflow` 权限时，ref 更新返回 `404` 而不是 `403`。** 当推送范围涉及 `.github/workflows/` 时会出现。GraphQL 会返回具体原因。在已有 token 上补勾权限不会改变 token 字符串。
- **ref 写入的状态码存在歧义。** ref 已存在时返回 `422`；token 缺少 `workflow` 时，所有 ref 相关操作都返回 `404`。脚本在任何非 2xx 时回退到 `PATCH`。
- **在 Windows 上通过 Node 调用 git 可能返回 `EBUSY`。** 在受限沙箱下观测到。脚本通过 shell 调用绝对路径的 `git.exe`，批量读取对象，并带退避重试。
- **shell heredoc 和 `node -e` 会处理掉反斜杠。** 含 `\s`、`\S`、`\/` 的正则会被破坏，写成 `.mjs` 文件执行即可。
- **删除仓库需要 `delete_repo` 权限。** `repo` 权限不包含删除仓库。

## 边界

- 重建的是 commit 和 ref。submodule、LFS、tag 与 release 资产不在范围内。
- 单文件上限 100 MB，另有常规 API 限流。脚本会打印 API 调用次数。
- fine-grained token 不返回 `x-oauth-scopes` 头，因此通过调用接口来判断权限，而不是读响应头。

## 仓库结构

```
github-push-via-api/
├── SKILL.md                    # agent skill：判断流程、token 权限探测、失败模式
├── README.md                   # 中文
├── README_EN.md                # English
└── scripts/
    └── push-via-api.mjs        # 实现
```

## License

MIT
