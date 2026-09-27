---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: "scripts, desktop" # server, web, desktop, db, proxy-core, transformers, routes, services, docs, scripts
---

# 依赖弃用告警：8 个包被上游 pin 死，桌面工具链拆分延后

## 一句话结论

冷安装余下的 `npm warn deprecated` 共 9 行 / 8 个包（`glob@7.2.3` 因两条路径出现两次），全部被上游精确依赖，**无法用 overrides 就地消除**；唯一的结构解法是把 Electron 桌面打包工具链拆出根 `package.json`，本轮决定延后——先保证「测试 / 打包 / 文档 job 与出货运行时同为 Node 22.15」，弃用告警按已知状态接受。

## 背景

- 治理目标：装依赖不再刷弃用告警。本轮已消掉 `prebuild-install@7.1.3`（随 `better-sqlite3` 13 移除）与 `glob@10.5.0`。
- 余下清单（冷缓存 `npm ci` 实测，9 行）：`glob@7.2.3`(×2)、`inflight@1.0.6`、`rimraf@2.6.3`、`@esbuild-kit/core-utils@3.3.2`、`@esbuild-kit/esm-loader@2.6.5`、`text-encoding@0.6.4`、`lodash.isequal@4.5.0`、`boolean@3.2.0`。`temp@0.9.4` 虽老但**未**被弃用，故不计入。
- 父级链（`npm ls --all` + registry `deprecated` 字段逐包核对）：

| 弃用包 | 父级链（自下而上） | 归属 |
| --- | --- | --- |
| `glob@7.2.3`、`inflight@1.0.6` | `@electron/asar@3.4.1` ← `app-builder-lib@26.15.3` ← `electron-builder@26.15.3` | 桌面打包 devDep |
| `rimraf@2.6.3` | `temp@0.9.4` ← `electron-winstaller@5.4.0` ← `electron-builder-squirrel-windows@26.15.3` ← `app-builder-lib` | 桌面打包 devDep |
| `boolean@3.2.0` | `global-agent@3.0.0` ← `@electron/get@3.1.0` ← `app-builder-lib` | 桌面打包 devDep |
| `lodash.isequal@4.5.0` | `electron-updater` | 桌面运行时依赖 |
| `@esbuild-kit/core-utils`、`@esbuild-kit/esm-loader` | `@esbuild-kit/esm-loader` ← `drizzle-kit@0.31.x`（含最新 0.31.11） | 迁移工具 devDep |
| `text-encoding@0.6.4` | `shapefile@0.6.6` ← `geobuf@4.0.0` ← `@visactor/vdataset@1.0.24` ← `@visactor/vchart` ← `@visactor/react-vchart` | **生产依赖** |

链上各包均已是最新版：`temp` 0.9.4、`boolean` 3.2.0、`lodash.isequal` 4.5.0、`shapefile` 0.6.6、`geobuf` 4.0.0、`@visactor/vdataset` 1.0.24、`@electron/asar` 4.3.1（而 26.x 工具链 pin 的是 3.4.1）。

## 决策

- 本轮不改弃用链、不为告警发版：`better-sqlite3` 13、`electron-builder` 26.15、`engines.node >=22.15.0` 保持不变。
- **Node 版本统一为 22.15**：`ci.yml`、`release.yml`、`docs-pages.yml`、`harness-drift-report.yml` 全为 `22.15`。依据：出货镜像 = `docker/Dockerfile` 的 `node:22-bookworm-slim`；`semver.satisfies("22.15.0", engines.node)` 对已装 345 个包 **0 不满足**；此前 release / docs / harness 跑 25，会放过「25 能过、22 挂」的问题。
- 弃用告警按已知状态接受。复评触发条件：① `drizzle-kit` 1.0 正式版（改用 jiti，`@esbuild-kit` 消失）；② `electron-builder` 27 正式版（`@electron/asar` 4 ESM 化、glob 13）；③ 决定给桌面端独立发布链（届时做 workspace 拆分）。

## 被放弃的方案（必填）

1. **overrides 就地顶版**：`@electron/asar@3.x` 使用 glob 7 的 callback API，glob 8+ 已移除 callback → 顶版会直接破坏桌面打包；`temp` / `boolean` / `lodash.isequal` 均已是最后一版（`boolean` 作者明确 `Package no longer supported`），`lodash.isequal` 无 scoped 等价物可替。
2. **升级到 `electron-builder@27.0.0-alpha.9`**：其依赖的 `@electron/asar@4.x` 为 ESM-only（`type: module`），而 `app-builder-lib` / `electron-winstaller` 是 CJS → 无法安装；且为 alpha，不上生产链路。
3. **桌面工具链 workspace 拆分（最接近可行）**：可移出 6/8 个弃用包，但需改 macOS 专属 `release.yml`（本机无法完整验证）、处理 `electron-updater` 拆出后的打包期解析、同步 `electron-builder.yml` 路径与 `dist:desktop*` 脚本；收益仅为消除告警 → 风险/收益不划算，延后。
4. **消除 `text-encoding`**：链条上各包全在最新版，除非替换 `@visactor` 图表栈对 `shapefile`/`geobuf` 的用法（属业务改动），不做。

## 来源

- 冷安装实测：隔离目录 `npm ci`；改造前后 Docker 冷构建日志各一份（`prebuild-install`、`glob@10.5.0` 已在改造后消失）。
- 父级链：`npm ls --all glob rimraf inflight temp @esbuild-kit/core-utils boolean`；弃用核对：`npm view <pkg>@<ver> deprecated`。
- Node 证据：`docker/Dockerfile:3,21` 均为 `node:22-bookworm-slim`；`package.json` `engines.node >=22.15.0`；本地全量测试（Node 22.23.1）499/500 文件、3215/3223 用例通过；`npm run repo:drift-check --report-only` violations 0。
