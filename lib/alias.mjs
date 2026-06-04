// ── Alias generation ──────────────────────────────────────────────────────────
// tcb requires alias to be ASCII; convert Unicode/CJK names to a stable slug.

export function toAlias(name) {
  const ascii = name
    .toLowerCase()
    .replace(/[一-鿿㐀-䶿]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const hasCJK = /[一-鿿㐀-䶿]/.test(name);
  let hash = 5381;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash) ^ name.charCodeAt(i);
  const suffix = (hash >>> 0).toString(36).slice(0, 6);

  const base = ascii || "agent";
  return hasCJK ? `${base ? base + "-" : ""}${suffix}` : base;
}
