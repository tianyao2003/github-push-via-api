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

以下是本仓库对自己的空跑输出：

```console
$ REPO_DIR=. REPO_SLUG=me/my-project node scripts/push-via-api.mjs --dry-run
branch main already exists -> no init needed

repo dir  : /home/me/src/my-project
target    : me/my-project  (branch main)
mode      : DRY-RUN (no writes)

commits   : 8
trees     : 13
blobs     : 20
blob data : 130.7 KiB
largest   : 17.1 KiB (f181dc13)

DRY-RUN ready - no writes sent. Would perform:
  1. POST /repos/me/my-project/git/blobs   x20
  2. POST /repos/me/my-project/git/trees   x13
  3. POST /repos/me/my-project/git/commits x8
  4. POST /repos/me/my-project/git/refs    refs/heads/main
```

实际推送结束后会打印两边的 head：

```
local  HEAD : 8f2c1d4e9a7b3f05c6d18e2a4b70935f1c8d6e2a
remote HEAD : 8f2c1d4e9a7b3f05c6d18e2a4b70935f1c8d6e2a
SHAs match  : true
```

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

## 已知问题

实测状态码和完整判断流程见 [`SKILL.md`](SKILL.md)。

| 现象 | 原因 |
| --- | --- |
| ref 写入返回 `404` | token 缺 `workflow` 权限，且推送范围涉及 `.github/workflows/`。GraphQL 会返回真实原因。 |
| ref 写入返回 `422` | ref 已存在。脚本对任何非 2xx 都回退到 `PATCH`。 |
| `spawnSync git EBUSY` | Windows 受限沙箱下观测到。脚本用绝对路径 `git.exe`、批量读对象并退避重试。 |
| 正则里的 `\s` 被吃掉 | shell heredoc 与 `node -e` 会处理反斜杠，写成 `.mjs` 文件执行。 |
| 删除仓库返回 `403` | `repo` 权限不含删除仓库，需要 `delete_repo`。 |

## 边界

- 重建的是 commit 和 ref；submodule、LFS、tag 与 release 资产不在范围内。
- 单文件上限 100 MB，另有常规 API 限流。脚本会打印 API 调用次数。
- fine-grained token 不返回 `x-oauth-scopes` 头，权限通过调用接口判断。

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
