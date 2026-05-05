# 落盘后浮出的问题

落盘期间识别出的待澄清问题，按优先级排序。

---

## ✅ 已拍板（落盘 v2 时确认）

- **沉淀容器**: ~/.pi/.pensieve/（不在 pi-stack 内）。pensieve 通过 superproject 探测找到 ~/.pi。详见 ADR 第 8 条硬纪律。
- **GitHub 仓**: `git@github.com:alfadb/pi-stack.git`，公开
- **方案落盘位置**: pi-stack 仓内（方案即代码）。当前你正在读的这个文件就是产物之一。
- **物理位置**: `~/.pi/agent/skills/pi-stack/`，作为 ~/.pi 的 git submodule
- **加载方式**: settings.json `packages: ["~/.pi/agent/skills/pi-stack"]`（local path）
- **vendor 选 4-i**: `runtime/pensieve/` 完整 own 一份，不走 patches queue

---

## P0 — 落盘后必须立即澄清才能 finalize 方案的

### Q1. 公开仓敏感扫描

ADR 已选公开仓。但发现以下需要确认：

- `extensions/sediment/` 里是否有 prompt 包含个人记忆/项目敏感信息？
- `runtime/pensieve/templates/maxims/` 里的 4 个 maxim 是 alfadb 个人风格还是从其他项目搬来？版权问题？
- `runtime/pensieve/templates/knowledge/taste-review/content.md` 是否包含个人偏好的隐私内容？

**需要决策**: 公开 push 之前要不要做一次 `gitleaks` + 人工 sweep？  
**推荐**: 是。Step 9-11 完成后、Step 12 push 之前加一步"敏感扫描"。

```bash
# 建议加在 Step 11.5
gitleaks detect --source ~/.pi/agent/skills/pi-stack --no-git
# 人工 sweep:
grep -ri "TODO.*personal\|私人\|alfadb.*password\|secret" ~/.pi/agent/skills/pi-stack
```

---

### Q2. multi-agent 的 prompts 路径

迁移步骤 Step 11 提了一种处理：保留在 `extensions/multi-agent/prompts/`，让 `pi.prompts` 多列一个路径。Alternatives：

- **(a)** 移到顶层 `prompts/multi-*.md`（顶层平铺所有 prompt）
- **(b)** 留在 `extensions/multi-agent/prompts/`，`pi.prompts: ["./prompts", "./extensions/multi-agent/prompts"]`（**当前方案**）
- **(c)** 移到 `prompts/multi-agent/multi-*.md`（按功能分子目录）

**(b) 的好处**: 保持 multi-agent 的封装性（subtree 升级时不打乱）。  
**(a) 的好处**: 顶层 prompts/ 一眼能看全。  
**(c) 的好处**: 未来 prompts 多了好分类。

**推荐**: (b)。理由是 subtree merge 进来的资源最好保持原结构，便于未来反向 cherry-pick。如果 prompts/ 只有几个 multi-* 和 ship.md，平铺也 OK。

---

### Q3. retry-stream-eof.ts 的上游 PR

Step 6 引用了"上游 PR 链接"。当前 ~/.pi/agent/extensions/retry-stream-eof.ts 头部是什么状态？

**需要决策**:
- (a) PR 已提，链接已知 → Step 6 直接填进文件头注释
- (b) PR 还没提 → 要不要在迁移前先提？
- (c) PR 不打算提 → 改文件头注释为"alfadb 永久 hack"，归类为长期端口层资源

---

## P1 — 影响实施细节但不阻塞 finalize

### Q4. `runtime/pensieve/install.sh` 的路径假设

pensieve `pi/install.sh` 是从 `~/.pi/agent/skills/pensieve/` 这个安装位置工作的。搬到 `runtime/pensieve/install.sh` 之后：
- 它假设 `.src/` 在哪里？需要改成 `./` 还是保持 `../`？
- 它的 settings.json 写入逻辑是否需要改成"pi-stack 安装位置"？

**这个问题在 Step 9 执行时会浮出，但建议先看一眼 install.sh**。

```bash
# 提前看
cat ~/.pi/agent/skills/pensieve/pi/install.sh | head -50
```

### Q5. 是否需要单元/集成测试

ADR 没提测试。但：
- pi-multi-agent 当前有没有自己的测试？
- pi-sediment 有没有？
- runtime/pensieve/scripts/ 里的 shell 脚本有 lint / shellcheck 吗？

**推荐**: 至少加一个 `npm run check`（typecheck + 基本 lint），CI 不强制但本地能跑。

### Q6. UPSTREAM.md 的端口映射怎么自动化

UPSTREAM.md 端口映射是**最容易腐化**的文档（每次端口都要手工加行）。

**推荐**: 写个 `scripts/check-upstream-coverage.sh`，对比：
- vendor/gstack 里所有 SKILL.md → skills/ 里是否都有同名目录
- vendor/pensieve 里 .src/templates/maxims/*.md → runtime/pensieve/templates/maxims/ 里是否都有

如果 mismatch 就报错。这个工具不进 ADR，作为后续 nice-to-have。

---

## P2 — 远期问题

### Q7. 与 brain maxim 的偏离会不会回头修

ADR 0001 标记了一个有意识的偏离：选 4-i（完整 own）而不是 4-ii（patches queue）。这个偏离的代价是：

- runtime/pensieve/scripts/run-hook.sh（C-i 类）每次 vendor pensieve 升级时，需要手工 diff 上游 .src/scripts/run-hook.sh 来决定哪些值得移植
- 如果某天发现这种"手工 diff" 太累，可能想转向 patches queue
- 但那时 runtime/pensieve/ 里的修改已经累积了一段时间，转 patches 是一次大手术

**推荐**: ADR 0001 已经写了"如果未来发现 runtime/pensieve 升级痛苦超过预期，可以转向 patches queue"。这条作为预警条款保留即可，不需要现在解决。

---

## 推荐处理顺序

1. **现在拍板**: Q1 (敏感扫描)、Q2 (prompts 路径)、Q3 (retry PR 链接) — 这三个影响 Step 6/11 的执行
2. **Step 9 时处理**: Q4 (install.sh 路径)
3. **方案 v2 时处理**: Q5 (测试)、Q6 (自动化校验) — 不阻塞落地
4. **永久 watch**: Q7 (maxim 偏离)
