# Smoke Tests Reference

`package.json#scripts` 是 smoke test live truth。本文只是便于阅读的镜像；修改脚本时请同步本文。

## Current scripts（2026-05-15）

| npm script | File | Coverage |
|---|---|---|
| `smoke:memory` | `scripts/smoke-memory-sediment.mjs` | memory facade + sediment integration regressions, including credential typed-redaction boundary (pre-LLM, audit, writer, `memory_search` query) |
| `smoke:dispatch` | `scripts/smoke-dispatch-input-compat.mjs` | dispatch input compatibility |
| `smoke:fallback-timing` | `scripts/smoke-model-fallback-mutation-timing.mjs` | model-fallback mutation timing |
| `smoke:vision` | `scripts/smoke-vision.mjs` | vision tool registration/schema/basic path |
| `smoke:imagine` | `scripts/smoke-imagine.mjs` | imagine tool registration/schema/output path |
| `smoke:paths` | `scripts/smoke-pi-astack-paths.mjs` | runtime path helpers |
| `smoke:vault-subpi-isolation` | `scripts/smoke-vault-subpi-isolation.mjs` | sub-pi `PI_ABRAIN_DISABLED` isolation |
| `smoke:abrain` | `scripts/smoke-abrain-backend-detect.mjs` | vault backend detection |
| `smoke:abrain-bootstrap` | `scripts/smoke-abrain-bootstrap.mjs` | vault bootstrap |
| `smoke:abrain-vault-writer` | `scripts/smoke-abrain-vault-writer.mjs` | vault write/encrypt path |
| `smoke:abrain-vault-reader` | `scripts/smoke-abrain-vault-reader.mjs` | vault read/release path |
| `smoke:abrain-vault-bash` | `scripts/smoke-abrain-vault-bash.mjs` | bash injection/output handling |
| `smoke:abrain-active-project` | `scripts/smoke-abrain-active-project.mjs` | strict active project binding |
| `smoke:abrain-secret-scope` | `scripts/smoke-abrain-secret-scope.mjs` | project/global secret scope behavior |
| `smoke:abrain-i18n` | `scripts/smoke-abrain-i18n.mjs` | abrain i18n strings |

## Recommended subsets

```bash
npm run smoke:memory
npm run smoke:dispatch
npm run smoke:abrain-active-project
npm run smoke:abrain-vault-reader
npm run smoke:abrain-vault-bash
npm run smoke:vision
npm run smoke:imagine
```

For doc-only changes, run at least `npm run smoke:paths` if paths/runtime references were touched. For memory/sediment/vault changes, run the relevant subset above plus any command-specific smoke. For sanitizer or sediment secret-boundary changes, run `npm run smoke:memory` because it covers typed placeholders, prompt redaction, audit raw_text/error redaction, trigger phrase sanitization, and `memory_search` query redaction.

## Historical note

Older audit docs listed “15 smoke” but mixed npm aliases with file names and omitted `vision`/`imagine`. Treat audit lists as snapshots, not live reference.
