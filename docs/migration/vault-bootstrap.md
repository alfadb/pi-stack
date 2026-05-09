# Migration — Vault Bootstrap（age 加密 + OS keychain 集成）

> **状态**：待实施
> **依赖**：[ADR 0014](../adr/0014-abrain-as-personal-brain.md) §D4 / [brain-redesign-spec.md](../brain-redesign-spec.md) §6
> **关联**：本文件解决 Round 3 复核 P0-B2（OS keychain 跨平台承诺不成立）

## 1. 平台支持矩阵

ADR 0014 §D4 把 "OS keychain 自动解锁" 写为硬事实。**实际上跨平台支持参差**——本文件给出 fail-closed 的统一矩阵：每个平台都能跑，能力差异透明化。

| 平台 | Master key 后端 | Auto-unlock 能力 | 取不到 master key 时行为 |
|---|---|---|---|
| **macOS** | Keychain Services（`security` CLI） | ✅ 登录 session 内自动可用 | fail-closed |
| **Linux desktop**（GNOME / KDE） | Secret Service via `libsecret` (`secret-tool`) | ✅ 桌面 session 内自动可用 | fail-closed，提示 unlock |
| **Linux headless / server** | `pass`（gpg-encrypted file at `~/.password-store/abrain/master`），或 fallback `~/.abrain/.vault-master.age`（用户 GPG identity 加密） | ⚠️ 需用户主动 `pass git pull` 或 GPG agent 解锁 | fail-closed，CLI 提示运行 `pi vault unlock` |
| **WSL** | 桥接 Windows Credential Manager（`wsl-credential-helper`），或退回 Linux headless 路径 | ⚠️ 视用户配置而定 | fail-closed |
| **CI / 容器** | 不支持 vault | ❌ 永不解锁 | bash 注入拒绝；`vault_release` 工具不可用 |

**平台检测**：pi 启动时按以下顺序探测，第一个成功的为该 host 的 backend：
1. `$SECRETS_BACKEND` env override（用户强制）
2. macOS：`uname -s` = Darwin → Keychain
3. Linux + `$DISPLAY` 或 `$WAYLAND_DISPLAY` → Secret Service
4. Linux + `pass` 命令存在 + `~/.password-store/abrain/` 存在 → pass
5. Linux + `~/.abrain/.vault-master.age` 存在 → GPG-file fallback
6. 都没有 → 写 `~/.abrain/.state/vault-disabled` flag，vault 子系统全部 disable

## 2. Fail-closed 原则

**永不**降级到不安全模式（如 master key 写入 plaintext env 变量）。取不到 master key 时：

| 子系统 | 行为 |
|---|---|
| `~/.abrain/vault/_meta.md` | 仍可读（未加密的元数据） |
| `~/.abrain/projects/<id>/vault/_meta.md` | 仍可读 |
| 加密文件 `*.md.age` | **不解密**（保持密文） |
| bash 注入 `$VAULT_<key>` | **拒绝执行**，返回错误："vault locked, run `pi vault unlock` first" |
| `vault_release` 工具调用 | **拒绝**，返回错误 |
| `/secret <key>` 写入 | **拒绝**（因为加密需要 master key） |
| memory_search 命中 vault `_meta.md` | 正常返回元数据，但 LLM 看到的内容会标记 `🔒 vault locked` |

启动时 vault disabled 状态在 TUI footer 持续可见（"vault: locked"），用户能立刻看到。

## 3. Master key 生成 + 注册流程

首次安装 abrain 后跑 `pi vault init`：

```bash
# 0. 创建 install 临时目录（v1.2 修正，Round 4 Opus P1 3-5）——
#    不能用 /tmp：tmpfs 上 shred 是 no-op；NFS-mounted /tmp 同样无意义。
#    用 ~/.abrain/.state/install/ 保证与 abrain 同文件系统，shred 有效。
mkdir -p ~/.abrain/.state/install
chmod 700 ~/.abrain/.state/install
INSTALL_TMP=$(mktemp -d -p ~/.abrain/.state/install)

# 1. 生成 age master key
age-keygen -o $INSTALL_TMP/master.age 2>&1
#   输出：Public key: age1xxx...

# 2. 把 secret key 注册到 OS keychain
case "$BACKEND" in
  macos)
    security add-generic-password -s "alfadb-abrain-master" \
      -a "$USER" -w "$(cat $INSTALL_TMP/master.age)" -U
    ;;
  secret-service)
    secret-tool store --label="alfadb abrain master" \
      service abrain key master <<< "$(cat $INSTALL_TMP/master.age)"
    ;;
  pass)
    pass insert -m abrain/master <<< "$(cat $INSTALL_TMP/master.age)"
    ;;
  gpg-file)
    age -e -r "$(gpg --list-keys --with-colons | awk -F: '/^pub/{print $5; exit}')" \
      -o ~/.abrain/.vault-master.age $INSTALL_TMP/master.age
    ;;
esac

# 3. 把 public key 写入 ~/.abrain/.vault-pubkey（明文，用于加密时引用）
grep "Public key:" $INSTALL_TMP/master.age | awk '{print $3}' > ~/.abrain/.vault-pubkey

# 4. 销毁临时文件 + 整个 install 目录
shred -u $INSTALL_TMP/master.age 2>/dev/null
rm -rf $INSTALL_TMP
```

**安全声明**：
- master key 在生成与注册期间临时落 `~/.abrain/.state/install/`（与 abrain 同文件系统，shred 有效）。不使用 `/tmp`（可能是 tmpfs / NFS，shred 不生效）
- 备份责任在用户：建议 `pi vault export-master --to <usb-key>` 加密备份到外部介质（命令尚未实施，列入 backlog）
- master key rotation：当前 spec 不支持。若 rotation 必要：人工 unlock 全部 vault 文件 → 用新 key 重新加密 → 注册新 key 到 keychain。复杂度高，列入 backlog

## 4. 首次启动 onboarding flow

pi 启动时首次未检测到任何 master key 后端可用：

```
┌─ Vault setup ──────────────────────────────────────┐
│                                                    │
│  abrain vault 尚未初始化。选择：                   │
│                                                    │
│  [1] 现在初始化（生成 master key）                 │
│  [2] 跳过（vault 子系统将 disabled，可稍后初始化）│
│  [3] 我已经在另一台机器初始化 → 帮我导入           │
│                                                    │
└────────────────────────────────────────────────────┘
```

选 [1] → 跑 §3 流程，结束后 `pi vault status` 应显示 `unlocked`。
选 [2] → 写 `~/.abrain/.state/vault-disabled` flag，pi 继续运行（其他功能不受影响）。
选 [3] → 进入跨设备导入流程（详见 §6）。

## 5. 每个 pi 进程启动时的 unlock check

```typescript
// pseudo-code in extensions/abrain/vault.ts
async function loadMasterKey(): Promise<MasterKey | null> {
  // (a) extension activate 头部的 enforceable guard——v1.2 补，Round 4 GPT P0-N2
  if (process.env.PI_ABRAIN_DISABLED === "1") {
    log.info("abrain disabled by env (typical: sub-pi via dispatch_agents)");
    return null;  // fail-closed、不跳 keychain backend
  }
  if (existsSync("~/.abrain/.state/vault-disabled")) return null;

  const backend = detectBackend();
  try {
    const secret = await backend.fetchSecret("alfadb-abrain-master");
    return parseMasterKey(secret);
  } catch (err) {
    log.warn(`vault locked: ${err.message}`);
    return null;  // fail-closed
  }
}
```

### Sub-pi enforce——三层机制性（v1.2 补，Round 4 GPT P0-N2）

ADR 0014 §关键不变量 #6 要求 "sub-pi 默认看不到任何 vault" 是**机制性的**不只是 documentation。下面三点同时生效：

#### (a) `dispatch_agents` spawn 强制 env override（不允许上层覆盖）

```typescript
// extensions/dispatch/index.ts
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,                       // 先继承父环境
  PI_ABRAIN_DISABLED: "1",              // 后强制覆盖——不允许上层 export PI_ABRAIN_DISABLED=0
};
spawn("pi", args, { env: childEnv });
```

这里顺序重要：`...process.env` 在前、`PI_ABRAIN_DISABLED: "1"` 在后。如果用户 `export PI_ABRAIN_DISABLED=0` 也会被后的覆写掩盖。

#### (b) extension activate 顶层位置的 hard guard（不仅 loadMasterKey 处，上面的伪代码可见）

```typescript
// extensions/abrain/index.ts
export function activate(api: PiExtensionAPI) {
  if (process.env.PI_ABRAIN_DISABLED === "1") {
    api.log.info("abrain extension disabled (sub-pi mode)");
    return;  // 无 tool 注册、无事件订阅、无 vault metadata 加载
  }
  // 正常启动路径
  api.registerTool("vault_release", ···);
  api.subscribe("agent_end", ···);
}
```

#### (c) Smoke 验证 enforcement——不是靠 documentation、是靠测试

`scripts/smoke-vault-subpi-isolation.mjs`（待写）验证：
1. 父 pi 启动后 `pi vault status` = unlocked
2. dispatch_agents 子 pi 进程调用 `pi vault status`返回 locked/disabled
3. dispatch_agents 子 pi 中调用 `pi vault list` 拒绝（不返回任何 metadata）
4. 即使用户设 `PI_ABRAIN_DISABLED=0` env，dispatch_agents 子 pi 仍然 disabled（验证 spawn override 顺序正确）

## 6. 跨设备导入（手动）

ADR 0014 §D-E 选择的方案：vault 跨设备靠用户手动同步（rsync / syncthing / iCloud Drive）。具体步骤：

```bash
# 设备 A（已初始化）：
# 1. rsync 整个 ~/.abrain（含 vault/）到设备 B（vault 内容已加密，传输不需 trust 通道）
rsync -av --delete ~/.abrain/ user@deviceB:.abrain/

# 2. 把 master key 安全传到设备 B
#    选项 a: 物理 USB key（推荐）
#    选项 b: 临时打开 ssh + scp 加密文件 + 立刻删除
#    选项 c: pass git remote（如果两台设备共用 pass repo）

# 设备 B：
# 1. 把 master key 注册到本设备 keychain（按 §3 流程）
# 2. 验证：pi vault status → unlocked
# 3. 验证：pi vault list → 看到 A 上写过的所有 keys
```

**已知 trade-off**：
- 设备 A 写新 secret 后，设备 B 不会自动看到——必须人工再跑一次 rsync
- vault 文件较少时这是合理代价；若 vault 写入频繁可考虑 syncthing 自动同步

## 7. 与 Lane V 同步语义的衔接

详见 [brain-redesign-spec.md §6.4.0](../brain-redesign-spec.md#640-vault-写入的执行者与同步语义)。简言之（v1.2 修正，Round 4 N1）：

- `/secret` 命令由 **main pi 进程内同步调用 vaultWriter library** 处理（不走 sediment IPC / 不走 agent_end 异步）。vaultWriter 是 `extensions/abrain/vault-writer.ts`，复用 sediment 的 validation/audit substrate 但代码共享不是进程共享。避免 daemon / socket / peer credential 三层新工程面
- 落盘步骤：flock(vault 目录) → age encrypt(plaintext, `~/.abrain/.vault-pubkey`) → 先 append `vault-events.jsonl` + fsync → atomic rename 到 `vault/<key>.md.age` → append `_meta/<key>.md` → unflock
- 同步等待用户 TUI 输入完毕后立即返回——`$VAULT_<key>` 在下一条 bash 命令里立即可用
- 写入失败（keychain unlock 失败 / vault-events append 失败 / 加密失败）TUI 立刻报错，不进入 partial state

## 8. 验收 checklist

vault-bootstrap 完成后必须验证：

- [ ] `pi vault status` 在每个支持平台返回 `unlocked`
- [ ] `pi vault status` 在 fail-closed 场景（keychain locked / disabled）返回 `locked` 而非 crash
- [ ] `/secret test-key test-value` 落盘成功 + 立刻 `bash -c 'echo $VAULT_test_key'` 解密注入正确
- [ ] `vault forget test-key` rm 加密文件 + 后续 `$VAULT_test_key` 报 not-found
- [ ] sub-pi 启动时 `PI_ABRAIN_DISABLED=1` 生效，sub-pi 内 `vault list` 拒绝
- [ ] vault 文件全部 .gitignored（`git status` 干净）
