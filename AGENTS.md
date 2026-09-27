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

- **生产实例**：本机 Docker 容器 `metapi`（host 网络，`127.0.0.1:4000`，重启策略 `unless-stopped`）。**镜像 tag 规则：发版镜像 = `metapi:<版本号>`**（如 `metapi:1.4.1`）；现役 tag 以 `docker inspect metapi --format '{{.Config.Image}}'` 实际为准，勿写死；历史镜像本地保留（如 `metapi:local-*`、`-bak-*`），可作回滚位。
- **真实数据位置**：宿主 `/var/lib/metapi/data`（容器内挂载为 `/app/data`）；核心库 `/var/lib/metapi/data/hub.db`（SQLite）。站点/账号/路由/设置（`sites`/`accounts`/`token_routes`/`settings`）、代理日志 `proxy_logs`、调试抓取 `proxy_debug_*` 等运行期数据都在此库；运行日志在 `docker logs metapi`。
- **仓库内的 `data/` 是开发副本，不是生产数据**——排查线上问题勿用它。
- **排查原则**：先读运行实例的事实（hub.db 只读打开，如 `sqlite3 "file:/var/lib/metapi/data/hub.db?mode=ro"`；必要时 `docker logs` / `docker inspect`），弄清「发生了什么」；需要解释机制、定位实现时再读源码（它回答「为什么」）。只读源码往往查不到运行期问题，两者结合使用；对生产数据/配置/容器的任何写操作须先经用户批准。

## 发版与无痛上线 / Release And Painless Deploy

用户说「发版」即按本节执行（上线 → 验收 → 发布收尾）。前置：改动在分支上经双审（reviewer + oracle）通过后方可提交；commit message 须过 commit-msg hook。

- **无痛上线（旧容器运行到切换前一刻）**：
  1. **定版本**：先 bump `package.json` 版本号并提交（连同 CHANGELOG、`.agents/notes/`）——版本号按语义化递增（或按用户指定），镜像 tag 与版本对齐。
  2. **旁路构建**：`docker build -t metapi:<版本号> -f docker/Dockerfile .`（如 `metapi:1.4.1`；旧容器照跑）。
  3. **回流位**：记录新旧 IMAGE ID；旧版本镜像保留为回滚位（回滚 = 用上一版本 tag）；切换前对 hub.db 做只读一致性快照（`.backup`）到 `/root/deploy-prep/`。
  4. **切换**：先 `docker inspect metapi` 核对现配置（网络/卷/Cmd/Entrypoint/Env，Env 现读现用不落盘）→ 停并删旧容器 → 以同配置 `docker run metapi:<版本号>`（host 网络同端口不能并存，切换为秒级）。
  5. **健康检查 + 验收**：容器 running、端口/HTTP 探测、`docker logs` 无致命错；不过 → 用上一版本 tag 原地回滚。然后按本次改动做真实流量验证（复现触发 / 查调试库与日志核对）。
- **发布收尾**：**显式** `git push origin <branch>` → `git merge --ff-only` 进 main → `git push origin main`。
- **红线**：main 的 tracking 指向 upstream——裸 `git push` 会指向 upstream，一律显式写 `origin`；不推 upstream、不 force、不打 tag、不删分支（除用户明说）。

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
