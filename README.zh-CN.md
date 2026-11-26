<div align="center">

# PanelKit (agy-mcp-kit)

**面向 Antigravity 插件套件的标准 Rust MCP 运行时原语、SEP-1865 暖色编辑风面板套件与零漂移同步工具。**

[主页](https://eatingdream.dev) · [English](README.md) | 简体中文 · [AI 指南](docs/ai-guide.md) · [`llms.txt`](llms.txt)

[![CI](https://github.com/eatingDream-antigravity-plugins/agy-mcp-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/eatingDream-antigravity-plugins/agy-mcp-kit/actions/workflows/ci.yml)
![Built with Rust](https://img.shields.io/badge/built%20with-Rust-1A1916?logo=rust&logoColor=white)
![SEP-1865](https://img.shields.io/badge/MCP%20Apps-SEP--1865-D97757)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

## 它是什么

**PanelKit**（`agy-mcp-kit`）是 [eatingDream Antigravity 插件套件](https://eatingdream.dev) —— [ContextRadar](https://github.com/eatingDream-antigravity-plugins/context-radar-mcp)（`context-radar-mcp`）、[ClamGuard](https://github.com/eatingDream-antigravity-plugins/mac-clamshell-mcp)（`mac-clamshell-mcp`）、[RemoteCast](https://github.com/eatingDream-antigravity-plugins/chrome-stream-mcp)（`chrome-stream-mcp`）、[ColabDeck](https://github.com/eatingDream-antigravity-plugins/colab-mcp)（`colab-mcp`）共享的单一事实来源（A+B 混合架构）：

- **B — 单一事实源与完整测试**：维护零冗余的 Rust 核心模块（仅依赖 `serde`/`serde_json`）与 Editorial-Warm 面板基础件，由 `cargo test --locked` 和 `node --test` 独立守护。
- **A — 零外部依赖独立同步**：通过 `scripts/sync-kit.sh` 与 SHA256 `kit-manifest.json`，将精简核心文件直接同步进各插件仓库并用 `--check` 校验零漂移，确保每个插件的离线 `cargo build --release --locked` 保持极速独立构建。

它**不是**重型异步框架，也不会强迫下游插件引入私有 Git 依赖。

## 核心模块

| 层级 | 文件 | 职责 |
| :--- | :--- | :--- |
| **MCP 协议** | [`src/mcp_protocol.rs`](src/mcp_protocol.rs) | 协议版本协商（`2025-11-25`..`2024-11-05`）、严格 SEP-1865 `mimeTypes` 数组校验、`tools/list` 与 `tools/call` 共用可见性门禁、JSON-RPC 2.0 单条与批处理分发 |
| **SWR 缓存** | [`src/swr_cache.rs`](src/swr_cache.rs) | 线程安全 `SwrCache<T>`：`<1 ms` 非阻塞热读取、单飞后台刷新合并、有界冷启动等待、单调版本号 `rev` 与 `is_unchanged(since_rev)` 零字节轮询 |
| **HTML 注入** | [`src/html_boot.rs`](src/html_boot.rs) | 切分点 `HtmlLoader`：基于 `(mtime, len)` 缓存模板、预定位启动脚本注入点、安全转义 `</script>` 与 `<!--` |
| **测试护栏** | [`src/test_guard.rs`](src/test_guard.rs) | 编译期 `#[cfg(test)]` 拒绝器（`ensure_not_in_test` 与 `guard_host_effect!`），确保测试绝不触发真实系统/硬件副作用 |
| **面板令牌** | [`panel/tokens.css`](panel/tokens.css) | 16 个规范双字母颜色令牌（深色 `#141311`、浅色 `#FAF8F4` 且 `--ok: #2F7D53`），支持减弱动态效果，禁用 `prefers-color-scheme` |
| **面板桥接** | [`panel/bridge.js`](panel/bridge.js) | 严格校验 `ev.source === parent` 的 SEP-1865 通信客户端，支持合并/重试 `ui/initialize`（`2026-01-26`）、`serverTools` 检测、实时主题同步与净 RTT 测量 |
| **面板门禁** | [`panel/guard.mjs`](panel/guard.mjs) | 可执行面板 QA 门禁（`assertPanelInvariants`），校验 UTF-8 字节预算、单 `<script>`、`default-src 'none'`、零 `innerHTML`/`opacity:0`/`--buncss-*` 与全部 16 个令牌 |

## 快速开始

在本地运行全部校验：

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
node --test panel/test/kit.test.mjs
./scripts/sync-kit.sh --check-manifest
./scripts/check_sanitized.sh
```

同步套件文件到目标插件仓库并校验零漂移：

```sh
./scripts/sync-kit.sh ../mac-clamshell-mcp
./scripts/sync-kit.sh --check ../mac-clamshell-mcp
```

直接校验任意编译产物 `panel.html`：

```sh
node panel/guard.mjs ../mac-clamshell-mcp/panel/dist/panel.html --max-bytes 43500
```

## 同步工作流（A+B 混合架构）

下游插件既可全量同步，也可按需同步指定模块（`--files` / `--map`）：

```sh
./scripts/sync-kit.sh \
  --files src/mcp_protocol.rs,src/swr_cache.rs,panel/bridge.js,panel/guard.mjs \
  ../colab-mcp
```

每次同步都会生成 `.agy-kit-sync.json` 记录源路径、提交哈希与 SHA256 摘要，CI 只需运行 `./scripts/sync-kit.sh --check <repo>` 即可第一时间捕获漂移，同时保持各插件 `Cargo.lock` 完全独立。

## 给 AI Agent 使用

完整的 Rust API 签名、JS 桥接选项、面板门禁参数以及按需 `--files` / `--map` 同步说明均汇总在 Agent 参考文档中：

> 可直接告诉你的 Agent：*「请先阅读 [`llms.txt`](llms.txt) 和 [`docs/ai-guide.md`](docs/ai-guide.md)，再将 `agy-mcp-kit` 模块与面板校验同步接入目标插件。」*

## 安全与隐私边界

- **运行时零主动联网**：Rust 模块与 JS 面板套件均不发起任何出站网络请求。
- **严格 PostMessage 来源校验**：`panel/bridge.js` 会丢弃所有 `ev.source !== window.parent` 的跨窗口消息。
- **失败即阻断的脱敏门禁**：`scripts/check_sanitized.sh` 仅输出 `file:line`（绝不回显敏感行内容），且绝不掩盖 `git grep` 异常退出码。
- **零副作用测试护栏**：`test_guard.rs` 在 `cargo test` 编译期直接拒绝真实桌面、显示、浏览器或计费云调用。

## 文档索引

- [AI Agent 指南与 API 参考（`docs/ai-guide.md`）](docs/ai-guide.md)
- [LLM 索引（`llms.txt`）](llms.txt) · [套件清单（`kit-manifest.json`）](kit-manifest.json)
- [参与贡献](CONTRIBUTING.md) · [安全说明](SECURITY.md)

## 许可证

[MIT](LICENSE)
