---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: "scripts" # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# 生产切换收敛为 compose 唯一路径（手工 docker run 方案作废）

## 一句话结论

`metapi` 生产容器由 compose 管理（`/var/lib/metapi/docker-compose.yml`），切换只能「改 `image:` 行 + `docker compose up -d`」；按旧文档「停并删旧容器 → 以同配置 `docker run`」执行，会在 rm 与新容器创建之间留下无容器窗口，2026-09-27 因此停机 17 分钟。

## 背景

- 2026-09-27 19:56 派发的 1.4.2 发版 worker 按当时 AGENTS.md「发版与无痛上线」第 4 步执行：`docker build -t metapi:1.4.2`（19:58:43 完成）→ `docker inspect metapi` 抄 Env → **19:59:15 执行 `docker stop metapi && docker rm metapi`**；此后该 worker 无任何后续动作（会话卡死），新容器从未创建。
- 影响：19:59:25 起 `127.0.0.1:4000` 无监听、`docker ps -a` 无 `metapi` 容器；20:16:47 用 compose 恢复，空窗约 17 分钟。`hub.db` 数据完好（`integrity_check` ok）。
- 物证：dockerd journal（19:59:15 停 → 19:59:25 force kill → 之后无 create 事件）；`/root/deploy-prep/container-config.md` 自身记录了 `com.docker.compose.config_files = /var/lib/metapi/docker-compose.yml`；`/root/deploy-prep/deploy-painless.sh`（草案，整条设计即为 docker run 复刻现役容器）。
- 旧文档两处缺陷：① 未写明「生产由 compose 文件管理」，反把 `docker inspect` 的 Env 当作重建依据；② 把切换设计为「先删后建」的两段式手工操作，任一步中断即无替代品。

## 决策

- AGENTS.md「发版与无痛上线」重写为 compose 唯一路径，并新增红线：
  - 切换 = 改 `/var/lib/metapi/docker-compose.yml` 的 `image:` 行（附 switch 注释）→ `docker compose config -q` → `docker compose up -d`（compose 自行 stop→remove→create）。
  - 切换前置条件：`hub.db` 只读快照（`.backup` + `PRAGMA quick_check` 必须 ok）落到 `/var/lib/metapi/`。
  - 中断时第一优先级是「`metapi` 容器在不在」：不在就立刻用旧 tag `docker compose up -d` 恢复，禁止先排查后恢复。
  - 禁止手工 `docker stop/rm` 生产容器、禁止手搓 `docker run` 替换它、禁止执行 `deploy-prep` 草案脚本、切换窗口内单一操作者。
  - 可选旁路验证：新 tag + `data-canary` 数据副本 + `PORT=4100` 起一次性容器，验证通过后再切。
- 「运行实例与数据」节补充：生产唯一真相 = compose 文件；仓库内 `docker/docker-compose.yml`、`docker/docker-compose.override.yml`、`update-and-restart.sh`、`data/` 属本地开发件，禁止用于生产。
- 附带发现（本次未修）：容器启动横幅会把 `AUTH_TOKEN` / `PROXY_TOKEN` 明文写进 `docker logs`（json-file 保留 20m×5），建议后续改为掩码输出。

## 被放弃的方案（必填）

- **手工 `docker run` 复刻现役配置**（旧文档第 4 步 + `deploy-painless.sh` 的设计）：Env 需从 `docker inspect` 手工抄取，密钥外泄面变大，且容器会脱离 compose 归属（后续 `docker compose` 命令看不到它）；本次事故里那条 sed 复刻命令本身也拼错了引号。
- **「先删后建」两段式切换**：host 网络下同名同端口容器无法并存，于是用「先删」换秒级切换——代价是任何中断都直接变成停机，收益远小于风险。
- **`docker compose down` + `up -d --build`**（`update-and-restart.sh` 的思路）：会重建网络与容器，且依赖仓库内 dev compose/数据卷，不适用于本机生产 compose。

## 来源

- 时间线：`journalctl -u docker --since "19:55"`（19:59:15 stop / 19:59:25 force kill / 之后无 create）
- 执行者会话：`/tmp/herdr-role-sessions/default/role-worker-bf782167/2026-09-27T11-56-21-191Z_01a0e2b9-2b46-71cf-97c1-8b200e39cdbb.jsonl`
- 生产 compose：`/var/lib/metapi/docker-compose.yml`（`.bak-*` 与文件内 switch 注释块即切换/回滚记录）
- 恢复操作：`cd /var/lib/metapi && docker compose up -d`（image 切至 `metapi:1.4.2`）；数据快照 `/var/lib/metapi/data.bak-20260927-201626-pre-142/`
