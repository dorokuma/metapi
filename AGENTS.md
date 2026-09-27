# Metapi Engineering Rules

These rules apply to the whole repository unless a deeper `AGENTS.md` overrides
them. They are intentionally opinionated and mechanical so humans and agents can
make small, consistent changes without re-learning the codebase each time.

## Core Rules / 核心铁律

- **构建与测试**：全量构建执行 `npm run build`（包含 Web/Server/Desktop 构建）；测试执行 `npm test`（Vitest 单元与集成测试）。
- **静态与契约检查**：类型检查执行 `npm run typecheck`；架构与仓库漂移检查执行 `npm run repo:drift-check`；数据库契约与兼容性检查执行 `npm run test:schema:unit` / `npm run test:schema:parity` / `npm run test:schema:upgrade`。
- **提交规范**：提交规范——commit message 须过全局 commit-msg hook：Conventional Commits 类型白名单、≤72 字、冒号后一空格、禁噪声词与密钥。
- **决策与踩坑记录**：决策/踩坑须记 .agents/notes/（满足触发规则任一条即写，参考模板并按规范归档）。

## 运行实例与数据 / Runtime Instance And Data

- **生产实例**：本机 Docker 容器 `metapi`（host 网络，`127.0.0.1:4000`，重启策略 `unless-stopped`）。**镜像 tag 规则：发版镜像 = `metapi:<版本号>`**（如 `metapi:1.4.2`）；历史镜像本地保留（`metapi:local-*`、`-bak-*`、旧版本号 tag），都是回滚位。
- **生产的唯一真相是 compose 文件**：`/var/lib/metapi/docker-compose.yml`（compose project `metapi`、service/container `metapi`、`network_mode: host`、卷 `/var/lib/metapi/data:/app/data`、`env_file: /var/lib/metapi/.env`）。**现役镜像由该文件的 `image:` 行决定**；用 compose 命令前先 `cd /var/lib/metapi`。核对实际在跑的 tag 用 `docker inspect metapi --format '{{.Config.Image}}'`——两者不一致说明容器被人绕过 compose 动过，属异常；恢复方式是让 compose 重新接管（见「发版与无痛上线」）。
- **真实数据位置**：宿主 `/var/lib/metapi/data`（容器内挂载为 `/app/data`）；核心库 `/var/lib/metapi/data/hub.db`（SQLite）。站点/账号/路由/设置（`sites`/`accounts`/`token_routes`/`settings`）、代理日志 `proxy_logs`、调试抓取 `proxy_debug_*` 等运行期数据都在此库；运行日志在 `docker logs metapi`。同目录 `data.bak-*-pre-*.db` 是历史切换快照（回滚用），`deploy-logs/` 是既往切换日志。
- **仓库内的 `docker/docker-compose.yml`、`docker/docker-compose.override.yml`、`update-and-restart.sh`、`data/` 都是本地开发件，不是生产**：它们的数据卷指向仓库目录、override 会用本地代码构建、端口写成映射式 `127.0.0.1:4000:4000`。**禁止用它们操作生产**，排查线上问题也不要读这里的 `data/`。
- **排查原则**：先读运行实例的事实（hub.db 只读打开，如 `sqlite3 "file:/var/lib/metapi/data/hub.db?mode=ro"`；必要时 `docker logs` / `docker inspect`），弄清「发生了什么」；需要解释机制、定位实现时再读源码（它回答「为什么」）。只读源码往往查不到运行期问题，两者结合使用；对生产数据/配置/容器的任何写操作须先经用户批准。

## 发版与无痛上线 / Release And Painless Deploy

用户说「发版」即按本节执行（上线 → 验收 → 发布收尾）。前置：改动在分支上经双审（reviewer + oracle）通过后方可提交；commit message 须过 commit-msg hook；对生产的写操作须先经用户批准。

**唯一路径**：`scripts/deploy-painless.sh --version <版本号> --yes`（`--yes` 只是非交互确认）。脚本按固定顺序执行，无跳过开关，任一步失败自动回滚（恢复 compose 备份 + `docker compose up -d`）：

1. 旁路构建 `metapi:<版本号>`（旧容器继续服务）
2. `hub.db` 只读一致快照 + `PRAGMA quick_check`（不过即终止）
3. canary：快照副本 + `PORT=4100` 起一次性容器验证 migrate 与接口（不过即终止，生产未动）
4. 切换：改 `/var/lib/metapi/docker-compose.yml` 的 `image:` 行（附 switch 注释）→ `docker compose config -q` → `docker compose up -d`
5. 验收：容器 running、`127.0.0.1:4000` 监听、日志含 `Migration complete.`、`/api/stats/dashboard` 与 `/v1/models` 均 200
6. 收尾：打印快照路径、镜像级/数据级回滚命令

- **脚本跑完还要做的**：① 按本次改动做真实流量验证（复现触发 / 查调试库与日志核对）；② 发布收尾：**显式** `git push origin <branch>` → `git merge --ff-only` 进 main → `git push origin main`；③ 分支清理（仅限本次 ff-only 合入的那一个分支）：
  - 只删本次这一支：清理对象严格限定为本次发版合入的那一个分支，禁止按 `git branch --merged` 等谓词扫除；永久保护 ref 永不删：`main`、`origin/main`、`upstream/*` 全不删。
  - 先推后删：删 `origin` 远程分支的前提 = `git push origin main` 已成功且该分支 tip 已是 `origin/main` 的祖先；祖先校验参照写死为 fetch 后的 `origin/main`（先 `git fetch origin`，再用 `git merge-base --is-ancestor <分支tip> origin/main` 验证）；远端删除带期望 SHA 校验（在 `git merge --ff-only` 之前用 `git rev-parse <branch>` 冻结期望 SHA，删除时只拿这个冻结值去对 `git ls-remote`，对不上就放弃并报告）。
  - 在用判据写死：分支满足任一即视为在用、不删——被任何 worktree 检出（`git worktree list`）、关联工作区有未提交/未跟踪改动、有未合并进 main 的 commit。
  - 禁止强制：删除只用 `git branch -d` 与 `git worktree remove`；git 拒绝时停下报告，严禁 `-D`、严禁 `worktree remove --force`、严禁对 worktree 目录 `rm -rf`（避免主仓库 worktree 元数据变脏）。
  - 顺序：先回收 worktree → 再删本地分支 → 最后删远程分支。
- **红线**：
  - **生产容器只由 compose 管**：不 `docker stop/rm metapi`、不手搓 `docker run` 替换它、不把切换拆成「先删后建」两步——任何时刻都不得让生产容器处于「已删除且无替代」状态。
  - **切换中途被打断时，第一优先级是「容器在不在」**（`docker ps -a --filter name=metapi`）：不在就立刻 `cd /var/lib/metapi && docker compose up -d` 恢复，之后才排查原因。
  - **单一操作者**：切换窗口内只允许一个 agent/会话操作生产容器，不并发派发会动容器的 worker。
  - **不手工重建 Env**：环境变量唯一真相是 `/var/lib/metapi/docker-compose.yml` + `/var/lib/metapi/.env`；不要从 `docker inspect` 抄 Env 拼 `docker run`。
  - **日志里的密钥不外传**：启动横幅会把 `AUTH_TOKEN`/`PROXY_TOKEN` 明文写进 `docker logs`，日志内容不得落盘、回传或粘贴到别处。
  - **不擅自改运行时事实**：数据路径 `/var/lib/metapi/data`、host 网络、端口 `4000`、`container_name: metapi`。
  - main 的 tracking 指向 upstream——裸 `git push` 会指向 upstream，一律显式写 `origin`；不推 upstream、不 force、不打 tag；分支清理只按发布收尾第③条执行，此外不删分支。

## Index & Documentation / 索引与现状文档

- 项目文档：[docs/](docs/)（VitePress 文档目录）及 [CONTRIBUTING.md](CONTRIBUTING.md)（贡献与本地开发指南）
- 架构与规则文档：[AGENTS.md](AGENTS.md)
- 决策与踩坑笔记：[.agents/notes/](.agents/notes/)（说明详见 [.agents/notes/README.md](.agents/notes/README.md)）
- 写完笔记刷新索引：scripts/notes-index.sh（本地生成 INDEX.md，不入 git）

## Related Repositories / 关联仓库

- **prism**：同属 LLM 网关方向，独立演进。

## Golden Principles

- Prefer one source of truth. If a helper, contract, or workflow already owns
  an invariant, extend it instead of creating a parallel implementation.
- Fix the family, not just the symptom. When a bug comes from a repeated
  pattern, sweep adjacent paths in the same subsystem before calling the work
  done.
- Keep changes narrow and reviewable. Land one coherent slice at a time and
  avoid bundling unrelated cleanup into the same patch.

## Server Layers

- `src/server/routes/**` are adapters, not owners. Route files may register
  Fastify endpoints, parse request context, and delegate. They must not own
  protocol conversion, retry policy, stream lifecycle, billing, or
  persistence.
- If a helper is imported by anything outside one route file, it does not
  belong under `src/server/routes/proxy/`.
- `src/server/proxy-core/**` owns proxy orchestration. Endpoint fallback should
  flow through `executeEndpointFlow()`. Channel/session bookkeeping should flow
  through `sharedSurface.ts`.
- `src/server/transformers/**` are protocol-pure. Do not import from
  `src/server/routes/**`, Fastify, OAuth services, token router, or runtime
  dispatch modules. If a transformer needs a shared contract, move it to a
  neutral module first.
- Whole-body upstream reads in proxy orchestration should use
  `readRuntimeResponseText()` instead of direct `.text()` reads.

## Platform And Routing Rules

- Platform behavior must be explicit. Detection, endpoint preference, discovery
  transport, and management capability should come from one declared capability
  story, not scattered `if platform === ...` branches.
- Thin adapters must stay honest. Do not let a platform look feature-complete
  through inherited defaults if the underlying upstream does not support the
  feature.
- Retry classification and routing health classification should share the same
  failure vocabulary whenever possible.

## Database Rules

- One schema change requires three synchronized outputs: update the Drizzle
  schema, update SQLite migration history, and regenerate checked-in schema
  artifacts together.
- Cross-dialect bootstrap and upgrade SQL must be generated from the schema
  contract. Do not hand-write new MySQL/Postgres schema patches in feature
  code.
- Legacy schema compatibility is temporary and spec-owned. Additive startup
  shims should stay narrow and trace back to a feature compatibility spec.

## Web Rules

- Pages are orchestration surfaces, not shared utility libraries. Do not import
  one top-level page from another top-level page.
- Mobile behavior should reuse existing shared primitives first:
  `ResponsiveFilterPanel`, `ResponsiveBatchActionBar`, `MobileCard`,
  `useIsMobile`, and `mobileLayout.ts`.
- When a page grows a second complex modal, drawer, or panel family, extract it
  into a domain subfolder before adding more inline state and rendering logic.

## Guardrails

- Run `npm run repo:drift-check` before finishing changes that touch shared
  architecture boundaries.
- If you add a new boundary-heavy module, add or extend an architecture test in
  the same area so the rule becomes executable.
- Keep local planning files under `docs/plans/`. They are intentionally ignored
  by git and should not be treated as published documentation.
