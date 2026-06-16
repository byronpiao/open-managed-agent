# Harness scripts

**入口**：`npm run harness -- run --infra <local|tcbr|scf> --engine <opencode|claude|all>`  

| 文档 | 内容 |
|------|------|
| [CONTRIBUTING.md](../../CONTRIBUTING.md) | 主验收编排 |
| [Harness一条龙.md](../../../Harness一条龙.md) | 按步骤 + 排障 |
| [scenarios/README.md](./scenarios/README.md) | 6 格矩阵 |

```bash
npm test
npm run test:merge
npm run dev:harness
npm run harness -- run --infra tcbr,scf --engine opencode
node scripts/harness/load-env.mjs --check --probe-matrix
```
