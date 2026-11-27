# Contributing

Contributions to [PanelKit (agy-mcp-kit)](https://github.com/eatingDream-antigravity-plugins/PanelKit) are welcome.

## Workflow

- Use short-lived branches from `main` (`feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`, `ci/`) and submit Pull Requests with [Conventional Commits](https://www.conventionalcommits.org/) titles.
- Configure a GitHub noreply commit email (`<id>+<login>@users.noreply.github.com`); never commit secrets, tokens, private keys, personal hostnames/paths, or real credentials.
- Whenever any canonical kit file changes, refresh `kit-manifest.json` with `./scripts/sync-kit.sh --update-manifest`.
- Contributions are licensed under the [MIT License](LICENSE).

## Local checks before pushing

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
node --test panel/test/kit.test.mjs
bash scripts/sync-kit.sh --check-manifest
bash scripts/check_sanitized.sh
```
