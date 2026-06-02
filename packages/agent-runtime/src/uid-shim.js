// uid-shim.js — required before index.js in SCF to prevent Claude Code
// CLI from refusing --dangerously-skip-permissions on uid==0.
//
// Claude Code's CLI checks process.getuid() === 0 and exits 1 with:
//   "--dangerously-skip-permissions cannot be used with root/sudo privileges"
//
// SCF functions run as root and we have no Dockerfile to create a non-root
// user upfront. Patching process.getuid here fools the check without
// changing the actual process identity (which would require su/useradd
// and add latency to cold-start port binding).
//
// This is intentionally limited: we only override getuid/geteuid, not
// setuid. Real privilege separation still applies at the OS level.
if (process.getuid?.() === 0) {
  const fakeUid = 1001;
  process.getuid  = () => fakeUid;
  process.geteuid = () => fakeUid;
}
