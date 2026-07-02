import assert from "node:assert/strict";
import {
  formatSyncTimestamp,
  resolveSyncImageTag,
  resolveCnbImageTag,
} from "../lib/sync-image-tags.mjs";

const when = new Date("2026-06-16T14:30:00");
const ts = formatSyncTimestamp(when);
assert.equal(ts, "260616-1430");

assert.equal(resolveSyncImageTag("sandbox", ts), "magent-260616-1430");
assert.equal(resolveSyncImageTag("tcbr", ts), "260616-1430");
assert.equal(resolveSyncImageTag("scf", ts), "260616-1430-scf");

assert.equal(
  resolveCnbImageTag({ imageTag: "magent-260616-1430", serviceName: "tcb-sandbox", now: when }),
  "magent-260616-1430",
);
assert.equal(
  resolveCnbImageTag({ serviceName: "tcb-sandbox", now: when }),
  "magent-260616-1430",
);
assert.equal(
  resolveCnbImageTag({ serviceName: "open-managed-agent", baselineImage: "ghcr.io/x/open-managed-agent:latest", now: when }),
  "260616-1430",
);
assert.equal(
  resolveCnbImageTag({ serviceName: "open-managed-agent", baselineImage: "ghcr.io/x/open-managed-agent-scf:latest", now: when }),
  "260616-1430-scf",
);

console.log("sync-image-tags: ok");
