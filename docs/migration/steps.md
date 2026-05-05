# pi-stack 迁移步骤（submodule 工作流）

> 状态: 仅列步骤，**未到执行阶段**。Review 通过后再机械执行。
> 上下文: 参见 [docs/adr/0001](../adr/0001-pi-stack-as-author-distro.md)。
> 工作流模型: alfadb 是唯一作者+使用者，pi-stack 以 git submodule 形式挂在 `~/.pi/agent/skills/pi-stack/`。

---

## 当前状态

✅ 已完成：
- Step 0 — 仓骨架已建：`~/.pi/agent/skills/pi-stack/.git`，remote → `git@github.com:alfadb/pi-stack.git`
- Step 1 — 落盘文档（package.json、README、UPSTREAM.md、ADR、目录布局）已就位

⏳ 待执行：Step 2-12

---

## Step 2: GitHub 上创建 alfadb/pi-stack 空仓

**手工操作**：在 `https://github.com/new` 创建 `alfadb/pi-stack`，**不要**初始化 README/LICENSE/.gitignore（本地仓已经有了）。

可见性：公开（与 alfadb/pi-multi-agent / pi-sediment 一致；**Q1**: 公开前是否需要敏感扫描？见 open-questions.md）。

---

## Step 3: 落盘 LICENSE 与初始 commit

```bash
cd ~/.pi/agent/skills/pi-stack

# 复制 MIT LICENSE
cp ~/.pi/agent/skills/pi-multi-agent/LICENSE ./LICENSE

# .gitignore
cat > .gitignore <<'EOF'
node_modules/
.DS_Store
*.log
EOF

git add .
git commit -m "chore: initial scaffolding (package.json, README, ADR, UPSTREAM, docs)"
git push -u origin main
```

**回滚成本**: 0（删 GitHub 仓即可）

---

## Step 4: 加 vendor/gstack nested submodule

```bash
cd ~/.pi/agent/skills/pi-stack
mkdir -p vendor

git submodule add https://github.com/garrytan/gstack.git vendor/gstack
cd vendor/gstack && git checkout bf65487 && cd ../..

git add .gitmodules vendor/gstack
git commit -m "chore(vendor): pin gstack to bf65487 (v1.26.0.0)"
git push
```

**回滚成本**: 低（`git submodule deinit` + `git rm`）

---

## Step 5: 加 vendor/pensieve nested submodule

```bash
cd ~/.pi/agent/skills/pi-stack

git submodule add https://github.com/kingkongshot/Pensieve.git vendor/pensieve
cd vendor/pensieve && git checkout main
PENSIEVE_SHA=$(git rev-parse --short HEAD)
cd ../..

git add .gitmodules vendor/pensieve
git commit -m "chore(vendor): pin pensieve to ${PENSIEVE_SHA} (kingkongshot main)"

# 把 SHA 填入 UPSTREAM.md
$EDITOR UPSTREAM.md
git add UPSTREAM.md
git commit -m "docs(upstream): record pensieve baseline SHA"
git push
```

**回滚成本**: 低

---

## Step 6: 散文件 / in-tree 拷贝

```bash
cd ~/.pi/agent/skills/pi-stack
mkdir -p extensions skills prompts

# gbrain extension
cp -r ~/.pi/agent/extensions/gbrain ./extensions/gbrain

# retry-stream-eof（注意加注释 PR 链接 — Q3）
cp ~/.pi/agent/extensions/retry-stream-eof.ts ./extensions/retry-stream-eof.ts
# 在文件顶部加: // REMOVE WHEN https://github.com/mariozechner/pi-coding-agent/pull/<NNN> MERGED

# pi-model-curator (in-tree, 无 git 历史)
cp -r ~/.pi/agent/skills/pi-model-curator ./extensions/model-curator

git add extensions
git commit -m "feat(extensions): import gbrain, retry-stream-eof, model-curator"
git push
```

**回滚成本**: 0

---

## Step 7: subtree merge alfadb/pi-multi-agent

```bash
cd ~/.pi/agent/skills/pi-stack

git remote add pi-multi-agent git@github.com:alfadb/pi-multi-agent.git
git fetch pi-multi-agent

git subtree add --prefix=extensions/multi-agent pi-multi-agent main --squash

git remote remove pi-multi-agent
git push
```

**回滚成本**: 中（subtree commit 已经混入主历史，撤销需要 reset）

---

## Step 8: subtree merge alfadb/pi-sediment

```bash
cd ~/.pi/agent/skills/pi-stack

git remote add pi-sediment git@github.com:alfadb/pi-sediment.git
git fetch pi-sediment

git subtree add --prefix=extensions/sediment pi-sediment main --squash

git remote remove pi-sediment
git push
```

**回滚成本**: 中

---

## Step 9: 从 vendor/pensieve@pi 分支移植 A/B/C-i 内容

```bash
cd ~/.pi/agent/skills/pi-stack

# 从 pensieve 仓的 pi 分支 checkout 文件，但不带 git 历史
cd vendor/pensieve
git fetch origin pi:refs/remotes/origin/pi
mkdir -p /tmp/pensieve-pi-extract
git archive origin/pi pi/ .src/ | tar -x -C /tmp/pensieve-pi-extract/
cd ../..

# A 类: pi 适配层 → extensions/, skills/
mkdir -p extensions/pensieve-context skills/pensieve-wand
cp -r /tmp/pensieve-pi-extract/pi/extensions/pensieve-context/* extensions/pensieve-context/
cp -r /tmp/pensieve-pi-extract/pi/skills/pensieve-wand/* skills/pensieve-wand/

# A 类（runtime 入口）+ B 类（hook 脚本）+ C-i 类（模板/引用调整）
mkdir -p runtime/pensieve
cp /tmp/pensieve-pi-extract/pi/install.sh runtime/pensieve/install.sh

# .src/ 的全部内容（B + C-i + 上游主体）→ runtime/pensieve/
# 注意: 选项 4-i = 完整 own 一份；不区分 B vs C vs D，全部搬
cp -r /tmp/pensieve-pi-extract/.src/. runtime/pensieve/

# 清理
rm -rf /tmp/pensieve-pi-extract

git add extensions/pensieve-context skills/pensieve-wand runtime/pensieve
git commit -m "feat: port pensieve pi-branch content (A/B/C-i)"
git push
```

⚠️ **特别注意**: `.src/scripts/` 里的脚本路径引用可能假设了 pensieve repo 的目录结构。搬到 `runtime/pensieve/` 后要检查：
- 脚本里是否有 `../templates/` `../references/` 等相对路径 — 如果指向的目标也都搬过来了，应该 OK
- 脚本里是否有 `cd "$(dirname "$0")/.."` 之类的，要逐个验证
- `runtime/pensieve/install.sh` 的 settings.json 写入逻辑要适配 pi-stack 路径（详见 open-questions.md 的 Q4）

**回滚成本**: 0（纯文件拷贝）

---

## Step 10: 从 pi-gstack 移植 19 skill + browse + ship.md

```bash
cd ~/.pi/agent/skills/pi-stack

# pi-gstack 整个废弃，用 cp 而非 subtree（pi-gstack 不需要保历史）
PIGSTACK=~/.pi/agent/skills/pi-gstack

# Skills (19 个)
cp -r $PIGSTACK/skills/* skills/

# Browse extension
cp -r $PIGSTACK/extensions/browse extensions/browse

# Ship prompt
cp $PIGSTACK/prompts/ship.md prompts/ship.md

git add skills extensions prompts
git commit -m "feat: port 19 skills + browse + ship from pi-gstack"
git push
```

**回滚成本**: 0

---

## Step 11: 整理 multi-* prompts

参见 open-questions.md 的 **Q2**（决策：移到顶层 / 保留 in-extension / 子目录）。

假设选 (b) 保留在 `extensions/multi-agent/prompts/` 并多列一个 pi.prompts 路径：

```bash
cd ~/.pi/agent/skills/pi-stack
# 编辑 package.json:
#   "pi": { "prompts": ["./prompts", "./extensions/multi-agent/prompts"] }
$EDITOR package.json
git add package.json
git commit -m "feat: add multi-agent prompts to pi.prompts"
git push
```

**回滚成本**: 0

---

## Step 12: 切换 ~/.pi/agent/settings.json

```bash
cd ~/.pi
cp agent/settings.json agent/settings.json.bak

$EDITOR agent/settings.json
```

新 settings.json:
```json
{
  "lastChangelogVersion": "0.73.0",
  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-4-7",
  "defaultThinkingLevel": "xhigh",
  "packages": [
    "~/.pi/agent/skills/pi-stack"
  ],
  "prompts": [],
  "skills": [],
  "extensions": []
}
```

```bash
# 在 pi 内 /reload 验证 19 skill / 7 extension / N prompts 全部加载
# 也跑一次 /skill:autoplan, /skill:pensieve-wand, /skill:multi-debate 等
```

**回滚成本**: 0（恢复 settings.json.bak 即可）

---

## Step 13: 把 pi-stack 注册为 ~/.pi 的 submodule

到这一步，pi-stack 已经是独立的 git 仓 + 远程在 GitHub，但 ~/.pi 还没把它登记为 submodule。

```bash
cd ~/.pi
# 因为目录已经存在且有 .git，需要"反向" submodule add
# 法 a: 临时 mv 出去再 submodule add
mv agent/skills/pi-stack /tmp/pi-stack-tmp
git submodule add git@github.com:alfadb/pi-stack.git agent/skills/pi-stack
# 验证目录内容是否一致（如果 GitHub 已 push 过，submodule add 会拉到一致版本）
diff -r /tmp/pi-stack-tmp agent/skills/pi-stack || true
rm -rf /tmp/pi-stack-tmp

git add .gitmodules agent/skills/pi-stack
git commit -m "chore: add pi-stack as submodule, consolidating workflow tools"
git push
```

**回滚成本**: 中（涉及 ~/.pi 仓本身的提交，回滚要 reset/revert）

---

## Step 14: 清理 + archive 旧 repo

```bash
# 备份散文件后再删
mv ~/.pi/agent/extensions/gbrain ~/.pi/agent/extensions/gbrain.archived.$(date +%s)
mv ~/.pi/agent/extensions/retry-stream-eof.ts ~/.pi/agent/extensions/retry-stream-eof.ts.archived.$(date +%s)

# Submodule 先 deinit 再 rm
cd ~/.pi
git submodule deinit agent/skills/pi-multi-agent && git rm agent/skills/pi-multi-agent
git submodule deinit agent/skills/pi-sediment    && git rm agent/skills/pi-sediment
git submodule deinit agent/skills/pi-gstack      && git rm agent/skills/pi-gstack
git submodule deinit agent/skills/pensieve       && git rm agent/skills/pensieve
rm -rf agent/skills/pi-model-curator

git add -A
git commit -m "chore: migrate to alfadb/pi-stack monorepo, remove legacy submodules"
git push
```

GitHub 操作：
- alfadb/pi-multi-agent → archive，README 改为指向 pi-stack
- alfadb/pi-sediment → archive，README 改为指向 pi-stack
- alfadb/pi-gstack → archive，README 改为指向 pi-stack
- kingkongshot/Pensieve@feature/auto-sediment-hook → 删除
- kingkongshot/Pensieve@pi → 删除

**回滚成本**: 高（如果 Step 12 验证失败则不要执行 Step 13/14）

---

## 检查点

| 检查点 | 在哪步 | 检查内容 |
|---|---|---|
| ✅ Plan finalized | Step 1 后 | ADR + 目录布局 + UPSTREAM.md 已 review |
| ✅ Vendor pinned | Step 5 后 | `vendor/gstack` 与 `vendor/pensieve` 都 pin 到具体 SHA |
| ✅ Native ports work | Step 10 后 | `pi -e ./extensions/multi-agent/index.ts` 能启动 |
| ✅ Pensieve runtime works | Step 11 后 | `runtime/pensieve/install.sh` 能在测试项目里跑通 |
| ✅ Settings switch works | Step 12 后 | `pi /reload` 后 `/skill:autoplan` `/skill:pensieve-wand` 都能用 |
| ✅ Old repos can be archived | Step 14 之前 | 至少跑了一次完整工作流（multi-agent debate + sediment 触发 + pensieve-wand 查询）|

---

## 不可逆点

- **Step 13/14 是不可逆点**。Step 0–12 都可以保留旧 submodule / 散文件作为 fallback。
- 建议: Step 12 之后让新设置跑 1-3 天，确认日常工作流正常，再做 Step 13/14。

---

## 沉淀延续验证（执行 Step 12 后必跑）

```bash
# 在 pi-stack 内触发一次会沉淀的操作（比如完成一个小 task）
cd ~/.pi/agent/skills/pi-stack
# ... 做点啥 ...

# 验证 sediment 写到了 ~/.pi/.pensieve/，而不是 pi-stack/.pensieve/
ls ~/.pi/.pensieve/short-term/decisions/ | tail -3
ls ~/.pi/agent/skills/pi-stack/.pensieve/ 2>&1   # 应该是 "No such file or directory"
```

如果 sediment 创建了 `pi-stack/.pensieve/`，说明 superproject 探测失败，需要：
1. 检查 pensieve 版本是否包含 commit `7b81567`（superproject detection）
2. 检查 vendor/pensieve 是否 pin 到包含此 commit 的 SHA
3. 必要时把 runtime/pensieve/scripts/lib.sh 里的 `project_root()` 函数对照一下
