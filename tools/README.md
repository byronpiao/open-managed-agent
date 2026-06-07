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

Reads from `.env` / `.env.harness` via `scripts/load-env.mjs`:

- `CLOUDBASE_ENV_ID`
- `ANTHROPIC_AUTH_TOKEN` or `LLM_API_KEY`
- `ANTHROPIC_BASE_URL`
- `LLM_MODEL` (optional)
