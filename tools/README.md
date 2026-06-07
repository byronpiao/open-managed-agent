# Tools — internal debug helpers

These small scripts use the same `tcb login` credentials magent uses and
call CloudBase OpenAPIs directly.

They are operator tools, not user-facing commands. Keep them runnable from
the repo root with plain `node tools/<name>.mjs`.

## cloudrun-logs.mjs

Inspect the deploy record + process log for a TCBR (cloudrun) service.

    node tools/cloudrun-logs.mjs <serviceName>

Useful when a `magent cloudrun:create` ends in `deploy_failed` and you need
to see the build/probe trace.

## cloudrun-set-env.mjs

Push a new EnvParam map to a TCBR service via `SubmitServerConfigChangeDiff`,
which atomically rolls out a new deploy version reusing the same image.

    node tools/cloudrun-set-env.mjs <serviceName>

Reads from `.env` + `.env.harness` via `scripts/load-env.mjs`:

| 变量 | 文件 | 说明 |
|------|------|------|
| `CLOUDBASE_ENV_ID` | `.env` | 必填 |
| `LLM_API_KEY` | `.env.harness` | 优先；与 `ANTHROPIC_BASE_URL` 成对 |
| `ANTHROPIC_BASE_URL` | `.env.harness` | 必填（无 harness 时可放 `.env`） |
| `ANTHROPIC_AUTH_TOKEN` | `.env` | 仅当未设 `LLM_API_KEY` 时回退 |
| `LLM_MODEL` | `.env.harness` | 可选，默认 `mimo-v2.5-pro` |
