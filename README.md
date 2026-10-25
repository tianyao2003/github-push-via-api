<div align="center">

# github-push-via-api

当 `git push` 无法连接 `github.com:443`，但 `api.github.com` 仍可访问时，通过 GitHub Git Data API 上传已有的本地 Git 提交历史。

这是受限网络环境下的备用方案；普通环境优先使用 `git push`。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](scripts/push-via-api.mjs)
[![CI](https://github.com/tianyao2003/github-push-via-api/actions/workflows/ci.yml/badge.svg)](https://github.com/tianyao2003/github-push-via-api/actions/workflows/ci.yml)

**中文** · [English](README_EN.md)

</div>

---

## 什么时候使用

适用于以下场景：

- `git push` 因代理、防火墙、沙箱或网络策略无法连接 `github.com:443`；
- `api.github.com` 可以访问；
- 本地已经有需要上传的 Git 提交历史；
- 需要尽量保留原有提交的父子关系、作者、时间和 message。

如果普通的 `git push` 可用，请继续使用它。这个工具不替代常规 Git 传输。

## 快速开始

脚本无第三方依赖，需要 Node.js 18+ 和 Git。远端仓库需要已经存在。

先空跑，确认本地范围、对象数量、Token 和远端分支：

```bash
REPO_DIR=/path/to/repo REPO_SLUG=owner/repo BRANCH=main node scripts/push-via-api.mjs --dry-run
```

确认空跑结果后再推送：

```bash
REPO_DIR=/path/to/repo REPO_SLUG=owner/repo BRANCH=main node scripts/push-via-api.mjs
```

推送结束后，脚本会打印本地和远端 HEAD，并比较两者的 SHA：

```text
local  HEAD : <sha>
remote HEAD : <sha>
SHAs match  : true
```

## Token 和配置

Token 只存在于进程内存中，不会写入磁盘。脚本按以下顺序读取 Token：

1. `GITHUB_TOKEN`
2. `gh auth token`
3. GitHub CLI 的 `hosts.yml`

经典 Token 通常需要 `repo` 权限；如果提交历史涉及 `.github/workflows/`，还需要 `workflow` 权限。细粒度 Token 需要目标仓库的 Contents 写权限。

| 环境变量 | 说明 |
| --- | --- |
| `REPO_DIR` | 本地仓库路径，默认为当前目录 |
| `REPO_SLUG` | GitHub 上的 `owner/repo`，必填 |
| `BRANCH` | 远端目标分支，默认 `main`；本地也必须能解析该 ref |
| `REWRITE_AUTHOR` | `"Name <email>"`；会同时改写每个 commit 的 author 和 committer |
| `GIT_EXE` | Git 自动探测失败时使用的绝对路径 |
| `GITHUB_TOKEN` | 显式提供的 GitHub Token |
| `FORCE` | 设为 `1` 才允许覆盖包含本地历史之外提交的远端分支 |

## 安全边界

脚本最后会强制更新远端分支。若远端分支包含本地历史之外的提交，脚本会打印两边的 HEAD，并以退出码 2 停止。

只有确认远端提交可以被替换时，才设置：

```bash
FORCE=1 REPO_DIR=/path/to/repo REPO_SLUG=owner/repo node scripts/push-via-api.mjs
```

上传过程中可能先创建 GitHub 对象，再在最后一步更新 ref。中途失败时可能留下未被分支引用的对象；重新执行前应先确认远端分支状态。

## SHA 保留范围

GitHub 使用与 Git 相同的对象哈希算法。对于当前脚本支持的普通、未签名 commit，在不设置 `REWRITE_AUTHOR` 且提交元数据可完整重建时，远端 HEAD 通常可以与本地保持相同 SHA。

以下情况当前版本不保证 SHA 一致：

- 使用非整点时区的提交；
- 带 `gpgsig`、`mergetag` 或其他额外 commit header 的提交；
- 需要改写 author 或 committer 的提交。

脚本会在结束时比较 HEAD SHA；如果不一致，应把结果视为需要进一步检查，而不是默认认为上传完全等价。

## 当前限制

- 只重建 commit、tree、blob 和 branch ref；
- submodule、Git LFS 对象、tag、release 资产不在范围内；
- 单个 blob 受 GitHub 100 MB 限制，另有常规 API 限流；
- `BRANCH` 需要能在本地仓库中解析；
- 远端仓库需要已经存在；创建仓库属于单独的准备步骤；
- `REWRITE_AUTHOR` 会改变 commit SHA，这是预期行为。

## 工作原理

1. 使用 `git rev-list` 读取提交顺序，用 `git cat-file --batch` 批量读取 tree 和 blob。
2. 通过 Git Data API 依次创建 blob、按层创建 tree、按提交顺序创建 commit。
3. 把目标分支指向新的 head。
4. 比较本地和远端 HEAD SHA。

详细的网络诊断、Token 权限判断、404/422、Windows `EBUSY` 和验证流程见 [SKILL.md](SKILL.md)。

## 安装

```bash
git clone https://github.com/tianyao2003/github-push-via-api
```

作为 Agent Skill 使用时，把 `SKILL.md` 放进所用 runtime 的 skills 目录，或让 Agent 直接读取本仓库。

## 仓库结构

```text
github-push-via-api/
├── SKILL.md                    # Agent Skill：判断流程、权限和故障排查
├── README.md                   # 中文说明
├── README_EN.md                # English documentation
└── scripts/
    └── push-via-api.mjs        # 零依赖 Node.js 实现
```

## License

MIT


