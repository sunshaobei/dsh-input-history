# dsh-input-history

输入框 **↑/↓ 输入历史** 独立插件，DeepSeek Harness (DSH) Web。

从 dsh-file-mention 拆分而来：**每次发送（回车或点发送按钮，任意会话/工作区）都同步落库**到一份**全局 localStorage 历史环**，↑/↓ 按键时**同步读取**，召回即时且完整——不做任何异步历史 RPC、没有失效刷新，彻底消除「历史不全/时有时无」的问题。

| 能力 | 说明 |
| --- | --- |
| **发送落库** | 输入框每次发送都**同步**记录：回车（捕获阶段 keydown，含 IME/trigger 菜单/锁定态守卫）与点发送按钮（点击后校验草稿被清空，即平台 commitSend 已执行）两条路径全覆盖 |
| **全局共享** | 历史环**不绑定会话/工作区**，任意会话、任意工作区共用一份；合并时折叠旧版 `<file>` 块回 `@路径`、跳过空白、连续重复只留一条 |
| **↑/↓ 导航** | 空输入框按 ↑ 召回上一条已发送 prompt；↑/↓ 在历史间移动；↓ 越过最新条恢复原始草稿；手动编辑自动退出浏览态；trigger 菜单打开时按键让位给菜单 |
| **持久化** | localStorage 键 `dsh-input-history:input-history`（JSON 数组，旧→新），默认上限 **100 条**（超限淘汰最旧）；历史在**每次按键时同步读取** |
| **预热迁移** | 升级后首次进入会话时，会把当前会话的过往 prompt（`user/message` 纯文本事件）**一次性合并**进历史环，并把旧 dsh-file-mention 键（`dsh-file-mention:input-history` / `dsh-file-mention:history-limit`）**迁移**到本插件命名空间（尽力而为，失败则从空环开始累积） |

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-input-history
```

`dsh.bundle.patch` 声明会让 CLI 自动把本包追加进 profile 的 bundles（宿主半随之挂载，宿主半本身是空实现——所有逻辑都在客户端）。然后**重启 DSH 桌面应用**并刷新页面。零运行时依赖，无 peer / 构建要求。

卸载：`dsh plugin --profile web remove dsh-input-history`。

开发迭代：改完代码运行 `scripts/deploy.sh`（同步 lib 到 profile 安装目录）后重启。

## 配置

历史环上限默认 100 条；可在浏览器 console 里覆盖（下次发送生效，删除该键恢复默认）：

```js
localStorage.setItem("dsh-input-history:history-limit", "200")
```

## 架构

```
┌ composer (ui-conversation, 不改) ─────────────────────────────┐
│ Enter keydown（捕获）→ 守卫（IME/菜单/锁定/忙碌）            │
│   → recordSent(草稿)：折叠 <file> 块 → 去重 → 截断 → 落库   │
│ 发送按钮 click（捕获）→ 快照草稿 → 校验草稿被清空（已发送）  │
│   → recordSent(快照)                                         │
│ ↑/↓ keydown（捕获）→ loadHistory() 同步读全局环              │
│   → historyNav 纯函数 → conversation.input.for(scope).setDraft│
│ 启动 warm → 一次性合并当前会话历史 prompt + 迁移旧键         │
└──────────────────────────────────────────────────────────────┘
```

- 客户端 bundle 以 `window.__ModuleLoader__.load` 约定注册，**不 require 任何模块**（纯逻辑，无 React），规避 externals 漂移，无需打包器。
- 键盘仲裁、IME 守卫、菜单渲染全部由 DSH 内建管线承担；本插件只在捕获阶段补记录与历史导航。
- 与 dsh-file-mention 解耦：两者可独立安装/卸载/升级；历史数据通过旧键迁移平滑交接。

## 已知限制

- 只记录**输入框实际发送的文本**；纯图片等无文本发送不产生条目；发送失败的尝试按「输入过即记录」的容忍策略保留
- keydown/点击命中依赖 DOM 结构约定（`data-composer-card`），DSH 前端大版本变更时需适配
- 预热迁移依赖 `sessions.history` RPC（尽力而为，失败则从空环开始累积，不影响发送落库与 ↑/↓ 导航）

## 测试

```sh
node --test test/client.test.js
```

10 个用例：块折叠、历史状态机、历史环落库（折叠/去重/截断/上限覆盖/损坏容错/无 storage 降级）、旧键迁移、prompt 提取、插件形状。
