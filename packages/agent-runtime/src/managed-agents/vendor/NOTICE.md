# CMA vendor notice

Protocol-layer code vendored from [mosoo-agent-driver](https://github.com/langgenius/mosoo-agent-driver) (Apache-2.0).

| File | Upstream path |
|------|----------------|
| `projections-cma.ts` | `src/projections/cma/index.ts` |
| `cma-store-types.ts` | `src/stores/cma-store.ts` |
| `cma-http.ts` | `src/surfaces/cma-http/index.ts` |
| `cma-memory-store.ts` | `src/stores/memory/cma-memory-store.ts` |
| `runtime-command-types.ts` | subset of `src/runtime-command/index.ts` |
| `driver-event-types.ts` | subset of `src/protocol/events` + `runtime-events` |

Local changes:

- Imports rewritten to `./vendor/*` (no Bun, no DriverProcess).
- `driver-event-types` / `runtime-command-types` are minimal subsets for OMA Host layer only.

Golden fixtures: `tests/fixtures/cma/*`.
