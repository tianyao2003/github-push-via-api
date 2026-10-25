# github-push-via-api

**`git push` 走不通，仓库照样能上 GitHub —— 每个 commit、作者、日期、message 原样保留，SHA 完全一致。**

一个 agent skill + 一个单文件脚本。零依赖，Node ≥ 18。

## 问题

`git push` 用的是 git 自己的协议，连的是 `github.com:443`。在代理、防火墙或沙箱环境里，这个域名经常被封 —— 而 `api.github.com` 是通的。

## 思路

GitHub 的 REST API 可以直接创建 git 对象，它算 SHA-1 的方式和 git 完全一样。同样的字节，同样的 commit ID。

于是整段历史可以只走 `api.github.com` 重建出来：

```
POST /git/blobs  →  POST /git/trees  →  POST /git/commits  →  PATCH /git/refs
```

全程不碰 git 传输协议。而且因为 SHA 必须相同，你白得一个正确性校验：**不改作者的情况下，远端 head 的 SHA 必须等于本地。** 不相等就是有问题，别信那些 201。

## 快速开始

```bash
# 1. 先测哪个域名真的不通。这一步决定后面所有事。
#    8 行 fetch 探测，见 SKILL.md 的 "Step 0"

# 2. 空跑：只读本地仓库，不发出任何写请求
REPO_DIR=/path/to/repo REPO_SLUG=owner/repo node scripts/push-via-api.mjs --dry-run

# 3. 真推
REPO_DIR=/path/to/repo REPO_SLUG=owner/repo node scripts/push-via-api.mjs
```

环境变量：`REPO_DIR`、`REPO_SLUG`（必填），`BRANCH`（默认 `main`）、`REWRITE_AUTHOR`、`GIT_EXE`、`GITHUB_TOKEN`、`FORCE=1`。

token 读取顺序：`GITHUB_TOKEN` → `gh auth token` → GitHub CLI 的 `hosts.yml`。全程不落盘。需要 `repo` 权限；如果历史里动了 `.github/workflows/`，还需要 `workflow`。

`FORCE=1` 用于覆盖「远端有本地历史之外的提交」的分支。不加这个变量脚本会拒绝执行（exit 2）并打印两边的 head —— 那次强推会把这些提交删掉。

## 它不是「传文件」

它迁移的是**一个仓库**，不是往仓库里塞几个文件。那是另一个问题，而且 [azu/git-commit-push-via-github-api](https://github.com/azu/git-commit-push-via-github-api) 已经解决得不错了：

| | 本工具 | azu 那个库 |
| --- | --- | --- |
| 输入 | 一个已存在的本地 git 仓库 | 内存里的一组文件 |
| 输出 | 完整提交历史 | 在某个 ref 上叠一个新 commit |
| 需要装 git | 需要（要读本地对象） | 不需要 |
| 作者 / 日期 | 保留 | 不适用 |
| 校验方式 | 远端 head SHA 必须等于本地 | 无 |

服务器上不装 git、只想写个文件进仓库，用 azu 那个；手上是一个真仓库、但没有 push 通道，用这个。

## 五个坑

这几处是重新踩一遍很贵的，也是这个项目存在的理由。完整细节见 [`SKILL.md`](SKILL.md)。

1. **缺 `workflow` 权限时，报的是 `404` 不是 `403`。** 如果推送范围动了 `.github/workflows/`，ref 更新会被拒绝，返回一个光秃秃的 `404`。GraphQL 才说真实原因。修法：去 token 上勾 `workflow` —— 改权限不会改变 token 字符串。
2. **不要只看 ref 写入的状态码做分支。** token 正常时，ref 已存在返回文档里写的 `422`；缺 `workflow` 权限时，所有 ref 相关操作都返回 `404`，两个坑长得一模一样。任何非 2xx 都直接 fallback 到 `PATCH`。
3. **Windows 上 Node 不能按常规方式 spawn git。** `execFileSync('git')` 可能 `EBUSY`。走 shell 用 `git.exe` 绝对路径、尽量少 spawn（`git cat-file --batch`）、失败退避重试。
4. **shell heredoc 和 `node -e` 会吃掉反斜杠。** 写成 `.mjs` 文件再执行。
5. **删仓库需要 `delete_repo` 权限。** `repo` 不包含它，所以别随手创建清理不掉的临时诊断仓库。

## 推完要验证

别停在「API 返回 201」。把远端那条链走一遍，和本地对比：commit 数量、按顺序的 message、每个 commit 的作者、精确的文件集合（多出来的和缺的都要报）。然后**逐个扫描远端每个 blob**，找本机用户名、绝对路径、`ghp_*` / `github_pat_*` / `sk-*` / `AKIA*`、私钥头。

## 边界

- 重建的是 **commit 和 ref** —— 不含 submodule、LFS、tag、release 资产。
- 单文件 100 MB 上限，外加正常的 API 限流。脚本会打印调用次数。
- fine-grained token 不返回 `x-oauth-scopes` 头，判断能力要去调一个接口。

## 文件

| 路径 | 是什么 |
| --- | --- |
| [`SKILL.md`](SKILL.md) | agent skill：决策流程、token 能力探测、坑、验证。 |
| [`scripts/push-via-api.mjs`](scripts/push-via-api.mjs) | 实现。 |
| [`README.md`](README.md) | English version. |

## License

MIT
