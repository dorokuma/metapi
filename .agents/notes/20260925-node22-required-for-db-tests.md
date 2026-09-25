---
status: active # active | superseded
superseded_by: ""
supersedes: ""
模块: db
---

# 环境注意：DB 测试/门禁必须用 Node 22（默认 mise Node 26.7.0 会 ERR_DLOPEN_FAILED）

## 一句话结论

本机登录/交互 shell 的默认 `node` 是 mise 管理的 Node 26.7.0（NODE_MODULE_VERSION 147），
而当前 `node_modules` 里 better-sqlite3 12.10.0 的 native binding 是 Node 22 预编译
（NODE_MODULE_VERSION 127）；Node 26 下只要真正打开数据库（`new Database()`）就抛
`ERR_DLOPEN_FAILED`（"compiled against a different Node.js version … 127 … requires 147"）。
凡是会实际加载 better-sqlite3 的测试与门禁（全量 `npm test`、`test:schema:*`、真库集成测试等）
必须显式用 Node 22：`PATH=/root/.nvm/versions/node/v22.23.1/bin:$PATH …` 执行；否则失败发生在
测试执行中途、`afterAll` 清理不执行，还会在 `tmp/` 残留测试目录。**遇到这类报错先核对
`node -v`，不要把环境问题误判为代码回归。**

## 背景

- `~/.config/mise/config.toml` 配置 `[tools] node = "26.7.0"`，登录 shell 里 mise 的 shim 排在
  PATH 最前：`bash -lc 'which -a node'` 首项为
  `/root/.local/share/mise/installs/node/26.7.0/bin/node`（`v26.7.0`，
  `process.versions.modules === 147`）；`/root/.nvm/versions/node/v22.23.1/bin/node`（ABI 127）
  退居其次。
- better-sqlite3 的 binding 是**懒加载**：`require('better-sqlite3')` 本身不报错，
  `new Database(...)` 才触发加载。所以 Node 版本不符时报错点可能出现在测试执行中途，
  而不是进程启动时，更容易被当成业务代码失败来排查。
- 实测报错原文（Node 26.7.0 打开 `:memory:` 库）：

  ```
  Error: The module '…/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
  was compiled against a different Node.js version using
  NODE_MODULE_VERSION 127. This version of Node.js requires
  NODE_MODULE_VERSION 147. Please try re-compiling or re-installing …
  ```

- 仓库 `.nvmrc`（25.0.0）/ `package.json engines`（`>=25.0.0`）是声明面，**不能据此认为
  Node 25/26 下可直接跑 DB 测试**；决定因素是当前 `node_modules` 里 binding 的实际编译版本
  （127 = Node 22）。本机安装态即 Node 22 预编译，因此 DB 相关命令都按 Node 22 执行。
- 残留 `tmp/` 机制：失败发生在测试中途时，测试在 `DATA_DIR`（`tmp/…`）下已创建的目录
  等不到 `afterAll` 清理；该目录被 gitignore，不影响提交，但会作为"脏现场"干扰下次排查。
- 受控执行环境（如 agent 的固定 PATH 命令通道）里 `node` 可能恰好已是 22，
  不能以"那里能跑"推断登录 shell 也能跑；以命令实际解析到的 node 版本为准。

## 决策

1. DB 相关命令统一显式前置 Node 22，例如：

   ```bash
   PATH=/root/.nvm/versions/node/v22.23.1/bin:$PATH npm test
   PATH=/root/.nvm/versions/node/v22.23.1/bin:$PATH npm run test:schema:unit
   ```

2. 测试/门禁失败时先确认 `node -v` 与 `process.versions.modules`；若出现
   `ERR_DLOPEN_FAILED` / NODE_MODULE_VERSION 不符，一律按环境问题处理：换 Node 22 重跑，
   而不是改代码或怀疑测试逻辑。
3. 失败运行残留的 `tmp/` 目录属预期现象，排查/重跑前可清理；不要把它当代码产物处理
   （`tmp/*` 已被 gitignore，不会入库）。

## 被放弃的方案（必填）

- **在 Node 26 下 `npm rebuild better-sqlite3` / 重装依赖**：会改写 `node_modules` 里
  binding 的 ABI（变成 147），让 Node 22 侧反而失效；且 Node 26 过新，prebuild 未必可得、
  退回编译工具链，影响面远大于"换 node 执行"。不取。
- **改 `.nvmrc` / `engines` 来表达本机约定**：声明文件拦不住 mise 在登录 shell 里对 PATH 的
  覆盖（mise shim 优先级最高），对实际入口无约束力，且改动仓库声明面超出环境留痕范围。
  不取，仅记录本约定。
- **把 DB 门禁改成内存库/跳过**：掩盖真实迁移与方言投影问题，属降低覆盖换省事。不取。

## 来源

- 本机实测（2026-09-25）：`bash -lc 'which -a node'`、`node -p "process.versions.modules"`、
  Node 26.7.0 下 `new Database(':memory:')` 的完整报错文本；better-sqlite3 12.10.0、
  binding 位于 `node_modules/better-sqlite3/build/Release/better_sqlite3.node`。
- 「Cline 上游探测」各阶段门禁实践：DB 相关测试/门禁统一在 Node 22 下执行并通过。
