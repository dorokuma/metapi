# Agent 决策与踩坑笔记

本目录用于记录开发与协作过程中的技术决策、架构权衡、踩坑记录及临时变通方案。

## 触发规则

满足以下**任一**条件即须在 `.agents/notes/` 记录笔记：

1. **契约变更**：SQLite schema、索引格式、配置格式、对外 API 契约的调整或新增。
2. **跨界变更**：涉及跨两个以上模块（如 server、web、desktop、db）或跨仓库的交互与改动。
3. **方案否决**：否决了看似更优、更主流或更直觉的技术方案。
4. **临时降级**：包含临时降级、workaround 或特定环境特判逻辑。
5. **上游分歧**：与 upstream 保持的故意分歧或定制差异。
6. **性能考量**：关键性能参数、阈值或特殊优化取值的依据。

## 豁免清单

以下情况免写笔记（但**触发优先于豁免**：单文件内出现的 workaround 仍必须记录）：

- 常规版本 bump
- 纯文案调整与 typo 修复
- 行为不变的单文件 bug 修复
- 小版本依赖升级（无 breaking changes / 无 workaround）
- 纯补测试用例

## 记录规范

- **文件命名**：`YYYYMMDD-slug.md`（例如 `20260917-sqlite-schema-sync.md`）
- **模板参考**：统一参考模板 [_template.md](_template.md)
- **历史记录**：旧笔记被新方案取代时，只在 frontmatter 添加 `superseded` / `superseded_by` 链接，禁止直接改写或删除旧笔记内容
- **索引刷新**：编写或更新笔记后，运行 `scripts/notes-index.sh` 刷新索引（生成本地 `INDEX.md`，不入 git）
