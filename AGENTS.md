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

用户说「发版」即按本节执行（上线 → 验收 → 发布收尾）。前置：改动在分支上经双审（reviewer + oracle）通过后方可提交；commit message 须过 commit-msg hook。

**事实基线**：生产容器由 compose 管理（`/var/lib/metapi/docker-compose.yml`，project `metapi`），**切换动作只有一种：改该文件的 `image:` 行 + `docker compose up -d`**。手工 `docker stop/rm` 生产容器再手搓 `docker run` 重建是禁止动作（2026-09-27 曾因此停机 17 分钟，见 `.agents/notes/`）。

- **无痛上线（旧容器运行到切换前一刻）**：
  1. **定版本**：先 bump `package.json` 版本号并提交（连同 CHANGELOG、`.agents/notes/`）——版本号按语义化递增（或按用户指定），镜像 tag 与版本对齐（`metapi:<版本号>`）。
  2. **旁路构建**：`docker build -t metapi:<版本号> -f docker/Dockerfile .`（旧容器照跑），记下新旧 IMAGE ID（`docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}'`）。构建必须在切换**之前完整结束**，不得把构建与切换混在一个未完成的动作里。
  3. **数据快照（切换前置条件，不做不得切换）**：
     ```
     sqlite3 "file:/var/lib/metapi/data/hub.db?mode=ro" ".backup '/var/lib/metapi/data.bak-<ts>-pre-<slug>.db'"
     sqlite3 /var/lib/metapi/data.bak-<ts>-pre-<slug>.db 'PRAGMA quick_check;'   # 必须 ok
     ```
     快照与现役数据同目录（与既往 `data.bak-*` 惯例一致），回滚时可直接覆盖回去。
  4. **切换（单条命令窗口）**：
     - 编辑 `/var/lib/metapi/docker-compose.yml`：**只改 `image:` 行**，并按文件现有格式在该行上方补一行 switch 注释（`# <日期> switched to ...; prev ...; rollback: ...`）。
     - `cd /var/lib/metapi && docker compose config -q`（语法与变量校验，缺 env 会在此报错）→ `docker compose config --images`（确认只认到新 tag）。
     - `docker compose up -d`（compose 自行 stop → remove → create，秒级完成）。
     - 禁止在 compose 之外动生产容器：不 `docker stop/rm metapi`、不手搓 `docker run` 替换它、不把 rm 与 run 拆成两步手工操作。
  5. **健康检查 + 验收**（全通过才算上线成功）：`docker compose ps` 为 `running`；`ss -ltn | grep 127.0.0.1:4000`；`docker logs --tail 50 metapi` 必须出现 `Migration complete.` 与 `Server listening at http://127.0.0.1:4000`；HTTP 探测 `/api/stats/dashboard`（带 `AUTH_TOKEN`）与 `/v1/models`（带 `PROXY_TOKEN`）均 200；再按本次改动做真实流量验证（复现触发 / 查调试库与日志核对）。
  6. **失败回滚（同样只有一条命令路径）**：容器没起来或验收不过 → 把 `image:` 改回注释里的 `prev` tag → `docker compose up -d`。若新版本已跑过 schema 迁移且数据被污染 → 停容器后用第 3 步快照覆盖 `/var/lib/metapi/data/hub.db`，再回滚 image 并 `up -d`。
- **可选：切换前旁路验证新镜像**（涉及数据迁移的改动强烈建议）：用**新 tag + 数据副本 + 另一个端口**起一次性容器，验证 migrate 与接口后再执行第 4 步：
  ```
  mkdir -p /var/lib/metapi/data-canary && cp /var/lib/metapi/data/hub.db /var/lib/metapi/data-canary/hub.db
  docker run --rm --name metapi-canary --network host --env-file /var/lib/metapi/.env \
    -e HOST=127.0.0.1 -e PORT=4100 -e DATA_DIR=/app/data \
    -e CHECKIN_CRON='0 0 31 2 *' -e BALANCE_REFRESH_CRON='0 0 31 2 *' \
    -v /var/lib/metapi/data-canary:/app/data metapi:<版本号>
  ```
  （`-e` 覆盖 `--env-file`；cron 改成永不触发，避免副本上跑定时任务。）验证完 `docker rm -f metapi-canary`，副本目录可留作对比，不进生产。
- **发布收尾**：**显式** `git push origin <branch>` → `git merge --ff-only` 进 main → `git push origin main`。
- **红线**：
  - main 的 tracking 指向 upstream——裸 `git push` 会指向 upstream，一律显式写 `origin`；不推 upstream、不 force、不打 tag、不删分支（除用户明说）。
  - **任何时刻都不得让生产容器处于「已删除且无替代」状态**：切换是可回退的单步动作，不是「先删再建」的流程。
  - **切换中途被打断时，第一优先级是「`metapi` 容器在不在」**（`docker ps -a --filter name=metapi`）：不在就立刻用旧 tag `docker compose up -d` 恢复服务，之后再排查原因；禁止先排查、后恢复。
  - **禁止执行 `/root/deploy-prep/deploy-painless.sh` 一类"草案脚本"**：它按手工 `docker run` 设计，与 compose 事实冲突；未获用户明确批准，不得运行任何 `deploy-prep` 脚本。
  - **单一操作者**：同一时间只允许一个 agent/会话操作生产容器；切换窗口内不并发派发其他会动容器的 worker，切换动作要一次做完。
  - **Env 不手工重建**：环境变量唯一真相是 `/var/lib/metapi/docker-compose.yml` + `/var/lib/metapi/.env`；不要从 `docker inspect` 抄 Env 拼 `docker run`。启动横幅会把 `AUTH_TOKEN`/`PROXY_TOKEN` 明文写进 `docker logs`，日志内容不得落盘、回传或粘贴到别处。
  - 不擅自改动 `/var/lib/metapi/docker-compose.yml` 之外的运行时事实：数据路径 `/var/lib/metapi/data`、host 网络、端口 `4000`、`container_name: metapi`。

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
