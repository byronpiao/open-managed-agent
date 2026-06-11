#!/usr/bin/env python3
"""Generate harness session-storage SVG diagrams (no HTML)."""

from pathlib import Path

OUT = Path(__file__).parent


def write(name: str, lines: list[str]) -> None:
    path = OUT / name
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {path}")


def arch_diagram() -> None:
    """Dark-themed system architecture (architecture-diagram palette, SVG only)."""
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 720" width="1000" height="720">',
        '  <defs>',
        '    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">',
        '      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" stroke-width="0.5"/>',
        '    </pattern>',
        '    <marker id="ah" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">',
        '      <polygon points="0 0, 10 3.5, 0 7" fill="#64748b"/>',
        '    </marker>',
        '    <marker id="ah-green" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">',
        '      <polygon points="0 0, 10 3.5, 0 7" fill="#34d399"/>',
        '    </marker>',
        '    <marker id="ah-violet" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">',
        '      <polygon points="0 0, 10 3.5, 0 7" fill="#a78bfa"/>',
        '    </marker>',
        '  </defs>',
        '  <rect width="1000" height="720" fill="#020617"/>',
        '  <rect width="1000" height="720" fill="url(#grid)"/>',
        '  <text x="500" y="36" fill="#f8fafc" font-family="JetBrains Mono, monospace" font-size="18" font-weight="700" text-anchor="middle">Harness Session External Storage</text>',
        '  <text x="500" y="58" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="11" text-anchor="middle">OpenCode + Claude Code · FlexDB SoR outside AGS sandbox</text>',
        # arrows (behind boxes)
        '  <path d="M 120 130 L 120 95 L 230 95" fill="none" stroke="#64748b" stroke-width="1.5" marker-end="url(#ah)"/>',
        '  <path d="M 310 130 L 310 200" fill="none" stroke="#64748b" stroke-width="1.5" marker-end="url(#ah)"/>',
        '  <path d="M 430 240 L 520 240" fill="none" stroke="#34d399" stroke-width="1.5" marker-end="url(#ah-green)"/>',
        '  <path d="M 430 310 L 520 310" fill="none" stroke="#34d399" stroke-width="1.5" marker-end="url(#ah-green)"/>',
        '  <path d="M 700 240 L 780 240 L 780 420 L 700 420" fill="none" stroke="#a78bfa" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#ah-violet)"/>',
        '  <path d="M 700 310 L 780 310 L 780 480 L 700 480" fill="none" stroke="#a78bfa" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#ah-violet)"/>',
        '  <path d="M 430 200 L 700 200 L 700 130" fill="none" stroke="#a78bfa" stroke-width="1.5" marker-end="url(#ah-violet)"/>',
        '  <path d="M 700 130 L 700 95 L 230 95" fill="none" stroke="#a78bfa" stroke-width="1.5" stroke-dasharray="4,2" marker-end="url(#ah-violet)"/>',
        '  <text x="560" y="188" fill="#a78bfa" font-family="JetBrains Mono, monospace" font-size="9">export / append</text>',
        '  <text x="820" y="350" fill="#a78bfa" font-family="JetBrains Mono, monospace" font-size="9">hydrate / load</text>',
        # client
        '  <rect x="40" y="130" width="160" height="60" rx="6" fill="#0f172a"/>',
        '  <rect x="40" y="130" width="160" height="60" rx="6" fill="rgba(8,51,68,0.4)" stroke="#22d3ee" stroke-width="1.5"/>',
        '  <text x="120" y="155" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="11" font-weight="600" text-anchor="middle">Client</text>',
        '  <text x="120" y="172" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">prompt / session API</text>',
        # OMA region
        '  <rect x="200" y="78" width="280" height="200" rx="12" fill="none" stroke="#fbbf24" stroke-width="1.5" stroke-dasharray="8,4"/>',
        '  <text x="212" y="96" fill="#fbbf24" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600">OMA Runtime (CAM writes index)</text>',
        '  <rect x="220" y="110" width="110" height="52" rx="6" fill="#0f172a"/>',
        '  <rect x="220" y="110" width="110" height="52" rx="6" fill="rgba(6,78,59,0.4)" stroke="#34d399" stroke-width="1.5"/>',
        '  <text x="275" y="133" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600" text-anchor="middle">acp-endpoint</text>',
        '  <text x="275" y="148" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="8" text-anchor="middle">SSE + session</text>',
        '  <rect x="350" y="110" width="110" height="52" rx="6" fill="#0f172a"/>',
        '  <rect x="350" y="110" width="110" height="52" rx="6" fill="rgba(6,78,59,0.4)" stroke="#34d399" stroke-width="1.5"/>',
        '  <text x="405" y="133" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600" text-anchor="middle">sandbox-prewarm</text>',
        '  <text x="405" y="148" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="8" text-anchor="middle">bind / re-acquire</text>',
        '  <rect x="220" y="178" width="240" height="44" rx="6" fill="#0f172a"/>',
        '  <rect x="220" y="178" width="240" height="44" rx="6" fill="rgba(76,29,149,0.35)" stroke="#a78bfa" stroke-width="1.5"/>',
        '  <text x="340" y="198" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600" text-anchor="middle">harness_sessions</text>',
        '  <text x="340" y="212" fill="#c4b5fd" font-family="JetBrains Mono, monospace" font-size="8" text-anchor="middle">metadata only · OMA upsert</text>',
        # AGS sandbox region
        '  <rect x="510" y="78" width="250" height="420" rx="12" fill="none" stroke="#34d399" stroke-width="1.5" stroke-dasharray="8,4"/>',
        '  <text x="522" y="96" fill="#34d399" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600">AGS Sandbox (ephemeral disk)</text>',
        '  <rect x="530" y="210" width="210" height="70" rx="6" fill="#0f172a"/>',
        '  <rect x="530" y="210" width="210" height="70" rx="6" fill="rgba(6,78,59,0.4)" stroke="#34d399" stroke-width="1.5"/>',
        '  <text x="635" y="235" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="11" font-weight="600" text-anchor="middle">OpenCode</text>',
        '  <text x="635" y="252" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">opencode serve · SQLite temp</text>',
        '  <text x="635" y="266" fill="#6ee7b7" font-family="JetBrains Mono, monospace" font-size="8" text-anchor="middle">OMA pulls /sync at prompt end</text>',
        '  <rect x="530" y="280" width="210" height="70" rx="6" fill="#0f172a"/>',
        '  <rect x="530" y="280" width="210" height="70" rx="6" fill="rgba(6,78,59,0.4)" stroke="#34d399" stroke-width="1.5"/>',
        '  <text x="635" y="305" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="11" font-weight="600" text-anchor="middle">Claude ACP Harness</text>',
        '  <text x="635" y="322" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">claude-agent-sdk SessionStore</text>',
        '  <text x="635" y="336" fill="#6ee7b7" font-family="JetBrains Mono, monospace" font-size="8" text-anchor="middle">append during turn (in-box creds)</text>',
        # FlexDB region
        '  <rect x="780" y="78" width="200" height="420" rx="12" fill="none" stroke="#a78bfa" stroke-width="1.5" stroke-dasharray="8,4"/>',
        '  <text x="792" y="96" fill="#a78bfa" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600">CloudBase FlexDB</text>',
        '  <rect x="800" y="120" width="160" height="48" rx="6" fill="#0f172a"/>',
        '  <rect x="800" y="120" width="160" height="48" rx="6" fill="rgba(76,29,149,0.4)" stroke="#a78bfa" stroke-width="1.5"/>',
        '  <text x="880" y="142" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600" text-anchor="middle">harness_sessions</text>',
        '  <text x="880" y="156" fill="#c4b5fd" font-family="JetBrains Mono, monospace" font-size="8" text-anchor="middle">shared index</text>',
        '  <rect x="800" y="190" width="160" height="56" rx="6" fill="#0f172a"/>',
        '  <rect x="800" y="190" width="160" height="56" rx="6" fill="rgba(76,29,149,0.4)" stroke="#a78bfa" stroke-width="1.5"/>',
        '  <text x="880" y="212" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600" text-anchor="middle">harness_sync_events</text>',
        '  <text x="880" y="228" fill="#c4b5fd" font-family="JetBrains Mono, monospace" font-size="8" text-anchor="middle">OpenCode · OMA export</text>',
        '  <rect x="800" y="270" width="160" height="72" rx="6" fill="#0f172a"/>',
        '  <rect x="800" y="270" width="160" height="72" rx="6" fill="rgba(76,29,149,0.4)" stroke="#a78bfa" stroke-width="1.5"/>',
        '  <text x="880" y="292" fill="#ffffff" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600" text-anchor="middle">harness_claude_*</text>',
        '  <text x="880" y="308" fill="#c4b5fd" font-family="JetBrains Mono, monospace" font-size="8" text-anchor="middle">entries / messages</text>',
        '  <text x="880" y="322" fill="#c4b5fd" font-family="JetBrains Mono, monospace" font-size="8" text-anchor="middle">summaries · in-sandbox write</text>',
        # legend
        '  <rect x="40" y="540" width="920" height="150" rx="8" fill="#0f172a" stroke="#334155" stroke-width="1"/>',
        '  <text x="60" y="568" fill="#f8fafc" font-family="JetBrains Mono, monospace" font-size="12" font-weight="600">Legend</text>',
        '  <rect x="60" y="582" width="14" height="14" rx="3" fill="rgba(8,51,68,0.4)" stroke="#22d3ee" stroke-width="1"/>',
        '  <text x="82" y="594" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10">Frontend / Client</text>',
        '  <rect x="220" y="582" width="14" height="14" rx="3" fill="rgba(6,78,59,0.4)" stroke="#34d399" stroke-width="1"/>',
        '  <text x="242" y="594" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10">Runtime / Sandbox</text>',
        '  <rect x="400" y="582" width="14" height="14" rx="3" fill="rgba(76,29,149,0.4)" stroke="#a78bfa" stroke-width="1"/>',
        '  <text x="422" y="594" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10">Database (FlexDB)</text>',
        '  <line x1="60" y1="620" x2="100" y2="620" stroke="#a78bfa" stroke-width="1.5" marker-end="url(#ah-violet)"/>',
        '  <text x="110" y="624" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10">Persist / restore transcript</text>',
        '  <line x1="60" y1="648" x2="100" y2="648" stroke="#64748b" stroke-width="1.5" marker-end="url(#ah)"/>',
        '  <text x="110" y="652" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10">ACP / control plane</text>',
        '  <text x="500" y="624" fill="#64748b" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">Layer A: managed_agents_session_events (SSE replay) — parallel, not shown</text>',
        '  <text x="500" y="648" fill="#64748b" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">Layer B: harness_* collections — engine SoR for re-acquire</text>',
        '</svg>',
    ]
    write("harness-session-storage-architecture.svg", lines)


def opencode_flow() -> None:
    """Flat icon style — OpenCode export-at-prompt-end data flow."""
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" width="960" height="540">',
        '  <defs>',
        '    <marker id="ab" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#2563eb"/></marker>',
        '    <marker id="ag" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#16a34a"/></marker>',
        '    <marker id="ap" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#9333ea"/></marker>',
        '  </defs>',
        '  <rect width="960" height="540" fill="#ffffff"/>',
        '  <text x="480" y="40" fill="#111827" font-family="Helvetica Neue, Arial, PingFang SC, Microsoft YaHei, sans-serif" font-size="18" font-weight="600" text-anchor="middle">OpenCode Write Path (per-round export)</text>',
        '  <text x="480" y="64" fill="#6b7280" font-size="13" text-anchor="middle">FlexDB writes happen after each prompt ends — not during streaming</text>',
        # row 1: happy path
        '  <rect x="40" y="100" width="120" height="56" rx="8" fill="#eff6ff" stroke="#bfdbfe" stroke-width="1.5"/>',
        '  <text x="100" y="125" fill="#111827" font-size="13" font-weight="600" text-anchor="middle">Client</text>',
        '  <text x="100" y="142" fill="#6b7280" font-size="11" text-anchor="middle">prompt</text>',
        '  <path d="M 160 128 L 200 128" fill="none" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>',
        '  <rect x="200" y="100" width="140" height="56" rx="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>',
        '  <text x="270" y="125" fill="#111827" font-size="13" font-weight="600" text-anchor="middle">OMA acp-endpoint</text>',
        '  <text x="270" y="142" fill="#6b7280" font-size="11" text-anchor="middle">SSE stream</text>',
        '  <path d="M 340 128 L 380 128" fill="none" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>',
        '  <rect x="380" y="88" width="160" height="76" rx="8" fill="#f0fdf4" stroke="#86efac" stroke-width="1.5"/>',
        '  <text x="460" y="115" fill="#111827" font-size="13" font-weight="600" text-anchor="middle">AGS · OpenCode</text>',
        '  <text x="460" y="132" fill="#6b7280" font-size="11" text-anchor="middle">SQLite in sandbox</text>',
        '  <text x="460" y="148" fill="#6b7280" font-size="10" text-anchor="middle">events accumulate</text>',
        '  <path d="M 540 128 L 580 128" fill="none" stroke="#9333ea" stroke-width="1.5" stroke-dasharray="4,2" marker-end="url(#ap)"/>',
        '  <text x="560" y="118" fill="#9333ea" font-size="10" text-anchor="middle">SSE</text>',
        '  <rect x="580" y="100" width="140" height="56" rx="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>',
        '  <text x="650" y="125" fill="#111827" font-size="13" font-weight="600" text-anchor="middle">Client receives</text>',
        '  <text x="650" y="142" fill="#6b7280" font-size="11" text-anchor="middle">tokens / tools</text>',
        # export step
        '  <path d="M 270 156 L 270 210 L 760 210 L 760 168" fill="none" stroke="#16a34a" stroke-width="2" marker-end="url(#ag)"/>',
        '  <rect x="300" y="192" width="200" height="36" rx="6" fill="#ffffff" stroke="#ffffff"/>',
        '  <text x="400" y="214" fill="#16a34a" font-size="12" font-weight="600" text-anchor="middle">prompt_end → persistOpencodeSyncForSession</text>',
        '  <rect x="680" y="112" width="240" height="56" rx="8" fill="#faf5ff" stroke="#d8b4fe" stroke-width="1.5"/>',
        '  <text x="800" y="135" fill="#111827" font-size="13" font-weight="600" text-anchor="middle">FlexDB</text>',
        '  <text x="800" y="152" fill="#6b7280" font-size="11" text-anchor="middle">harness_sync_events (+sessions)</text>',
        '  <text x="460" y="200" fill="#6b7280" font-size="10" text-anchor="middle">GET /sync/history (cursor=maxSeq) → idempotent doc.set</text>',
        # re-acquire
        '  <rect x="40" y="280" width="880" height="200" rx="10" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1" stroke-dasharray="6,4"/>',
        '  <text x="60" y="306" fill="#111827" font-size="14" font-weight="600">Re-acquire (new sandbox)</text>',
        '  <rect x="60" y="330" width="150" height="56" rx="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>',
        '  <text x="135" y="355" fill="#111827" font-size="12" font-weight="600" text-anchor="middle">sandbox-prewarm</text>',
        '  <text x="135" y="372" fill="#6b7280" font-size="10" text-anchor="middle">bind new instance</text>',
        '  <path d="M 210 358 L 250 358" fill="none" stroke="#16a34a" stroke-width="1.5" marker-end="url(#ag)"/>',
        '  <text x="230" y="348" fill="#16a34a" font-size="9">read</text>',
        '  <rect x="250" y="330" width="200" height="56" rx="8" fill="#faf5ff" stroke="#d8b4fe" stroke-width="1.5"/>',
        '  <text x="350" y="355" fill="#111827" font-size="12" font-weight="600" text-anchor="middle">FlexDB listEvents</text>',
        '  <text x="350" y="372" fill="#6b7280" font-size="10" text-anchor="middle">paginate 100/page · full session</text>',
        '  <path d="M 450 358 L 490 358" fill="none" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>',
        '  <text x="470" y="348" fill="#2563eb" font-size="9">replay</text>',
        '  <rect x="490" y="330" width="180" height="56" rx="8" fill="#f0fdf4" stroke="#86efac" stroke-width="1.5"/>',
        '  <text x="580" y="355" fill="#111827" font-size="12" font-weight="600" text-anchor="middle">POST /sync/replay</text>',
        '  <text x="580" y="372" fill="#6b7280" font-size="10" text-anchor="middle">into fresh OpenCode</text>',
        # risk callout
        '  <rect x="60" y="410" width="840" height="52" rx="8" fill="#fef2f2" stroke="#fecaca" stroke-width="1.5"/>',
        '  <text x="480" y="432" fill="#991b1b" font-size="12" font-weight="600" text-anchor="middle">Risk: crash mid-prompt → events after last export may be lost (§3.1)</text>',
        '  <text x="480" y="450" fill="#b91c1c" font-size="11" text-anchor="middle">Mitigations: idle_pause export · session_delete export · export retry + syncExportFailedAt</text>',
        # legend
        '  <line x1="60" y1="510" x2="100" y2="510" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/><text x="108" y="514" fill="#6b7280" font-size="11">Request / replay</text>',
        '  <line x1="240" y1="510" x2="280" y2="510" stroke="#16a34a" stroke-width="1.5" marker-end="url(#ag)"/><text x="288" y="514" fill="#6b7280" font-size="11">FlexDB persist / read</text>',
        '  <line x1="460" y1="510" x2="500" y2="510" stroke="#9333ea" stroke-width="1.5" stroke-dasharray="4,2" marker-end="url(#ap)"/><text x="508" y="514" fill="#6b7280" font-size="11">Streaming (no DB)</text>',
        '</svg>',
    ]
    write("harness-opencode-export-flow.svg", lines)


def claude_flow() -> None:
    """Claude official style — in-sandbox append during turn."""
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 560" width="960" height="560">',
        '  <defs>',
        '    <marker id="ac" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><polygon points="0 0, 8 4, 0 8" fill="#5a5a5a"/></marker>',
        '  </defs>',
        '  <rect width="960" height="560" fill="#f8f6f3"/>',
        '  <text x="480" y="42" fill="#1a1a1a" font-family="-apple-system, BlinkMacSystemFont, PingFang SC, Microsoft YaHei, sans-serif" font-size="20" font-weight="700" text-anchor="middle">Claude Code Write Path (turn-time append)</text>',
        '  <text x="480" y="68" fill="#6a6a6a" font-size="14" text-anchor="middle">SessionStore writes from inside the sandbox — OMA does not export transcript</text>',
        # main flow
        '  <rect x="48" y="110" width="130" height="64" rx="12" fill="#a8c5e6" stroke="#4a4a4a" stroke-width="2.5"/>',
        '  <text x="113" y="140" fill="#1a1a1a" font-size="15" font-weight="600" text-anchor="middle">Client</text>',
        '  <text x="113" y="158" fill="#6a6a6a" font-size="12" text-anchor="middle">prompt</text>',
        '  <line x1="178" y1="142" x2="218" y2="142" stroke="#5a5a5a" stroke-width="2" marker-end="url(#ac)"/>',
        '  <rect x="218" y="110" width="150" height="64" rx="12" fill="#f4e4c1" stroke="#4a4a4a" stroke-width="2.5"/>',
        '  <text x="293" y="138" fill="#1a1a1a" font-size="14" font-weight="600" text-anchor="middle">OMA acp-endpoint</text>',
        '  <text x="293" y="156" fill="#6a6a6a" font-size="11" text-anchor="middle">routes to harness</text>',
        '  <line x1="368" y1="142" x2="408" y2="142" stroke="#5a5a5a" stroke-width="2" marker-end="url(#ac)"/>',
        '  <rect x="408" y="96" width="200" height="92" rx="12" fill="#9dd4c7" stroke="#4a4a4a" stroke-width="2.5"/>',
        '  <text x="508" y="126" fill="#1a1a1a" font-size="15" font-weight="600" text-anchor="middle">claude-acp-harness</text>',
        '  <text x="508" y="146" fill="#6a6a6a" font-size="12" text-anchor="middle">claude-agent-sdk turn loop</text>',
        '  <text x="508" y="164" fill="#6a6a6a" font-size="11" text-anchor="middle">TENCENTCLOUD_* in sandbox</text>',
        # append loop
        '  <rect x="648" y="96" width="200" height="92" rx="12" fill="#9dd4c7" stroke="#4a4a4a" stroke-width="2.5"/>',
        '  <text x="748" y="126" fill="#1a1a1a" font-size="15" font-weight="600" text-anchor="middle">SessionStore</text>',
        '  <text x="748" y="146" fill="#6a6a6a" font-size="12" text-anchor="middle">append() per step</text>',
        '  <text x="748" y="164" fill="#6a6a6a" font-size="11" text-anchor="middle">uuid idempotent</text>',
        '  <line x1="608" y1="142" x2="648" y2="142" stroke="#5a5a5a" stroke-width="2" marker-end="url(#ac)"/>',
        '  <line x1="748" y1="188" x2="748" y2="228" stroke="#5a5a5a" stroke-width="2" stroke-dasharray="5,3" marker-end="url(#ac)"/>',
        '  <text x="762" y="212" fill="#5a5a5a" font-size="12">write</text>',
        '  <rect x="648" y="228" width="200" height="72" rx="12" fill="#e8e6e3" stroke="#4a4a4a" stroke-width="2.5"/>',
        '  <text x="748" y="256" fill="#1a1a1a" font-size="14" font-weight="600" text-anchor="middle">FlexDB</text>',
        '  <text x="748" y="276" fill="#6a6a6a" font-size="11" text-anchor="middle">harness_claude_session_entries</text>',
        '  <text x="748" y="290" fill="#6a6a6a" font-size="10" text-anchor="middle">+ messages / summaries</text>',
        # during turn note
        '  <path d="M 508 188 L 508 248 L 200 248 L 200 174" fill="none" stroke="#5a5a5a" stroke-width="1.5" stroke-dasharray="3,2"/>',
        '  <text x="354" y="240" fill="#5a5a5a" font-size="12" text-anchor="middle">SSE to client continues while append runs</text>',
        # re-acquire block
        '  <rect x="48" y="330" width="864" height="180" rx="12" fill="#ffffff" stroke="#4a4a4a" stroke-width="1.5" stroke-dasharray="8,4"/>',
        '  <text x="68" y="358" fill="#1a1a1a" font-size="16" font-weight="700">Re-acquire</text>',
        '  <rect x="68" y="378" width="160" height="64" rx="12" fill="#f4e4c1" stroke="#4a4a4a" stroke-width="2"/>',
        '  <text x="148" y="408" fill="#1a1a1a" font-size="13" font-weight="600" text-anchor="middle">claude-session-warm</text>',
        '  <text x="148" y="426" fill="#6a6a6a" font-size="11" text-anchor="middle">session/load</text>',
        '  <line x1="228" y1="410" x2="278" y2="410" stroke="#5a5a5a" stroke-width="2" marker-end="url(#ac)"/>',
        '  <rect x="278" y="378" width="200" height="64" rx="12" fill="#e8e6e3" stroke="#4a4a4a" stroke-width="2"/>',
        '  <text x="378" y="408" fill="#1a1a1a" font-size="13" font-weight="600" text-anchor="middle">FlexDB paginated load</text>',
        '  <text x="378" y="426" fill="#6a6a6a" font-size="11" text-anchor="middle">100 entries / page</text>',
        '  <line x1="478" y1="410" x2="528" y2="410" stroke="#5a5a5a" stroke-width="2" marker-end="url(#ac)"/>',
        '  <rect x="528" y="378" width="200" height="64" rx="12" fill="#9dd4c7" stroke="#4a4a4a" stroke-width="2"/>',
        '  <text x="628" y="408" fill="#1a1a1a" font-size="13" font-weight="600" text-anchor="middle">SDK restores context</text>',
        '  <text x="628" y="426" fill="#6a6a6a" font-size="11" text-anchor="middle">replay: false</text>',
        '  <rect x="68" y="458" width="824" height="40" rx="10" fill="#f0fdf4" stroke="#9dd4c7" stroke-width="1.5"/>',
        '  <text x="480" y="483" fill="#1a1a1a" font-size="12" font-weight="600" text-anchor="middle">Already-appended entries survive sandbox crash better than OpenCode mid-prompt gap</text>',
        # legend
        '  <line x1="48" y1="530" x2="88" y2="530" stroke="#5a5a5a" stroke-width="2" marker-end="url(#ac)"/><text x="96" y="534" fill="#6a6a6a" font-size="12">Control / data</text>',
        '  <line x1="220" y1="530" x2="260" y2="530" stroke="#5a5a5a" stroke-width="2" stroke-dasharray="5,3" marker-end="url(#ac)"/><text x="268" y="534" fill="#6a6a6a" font-size="12">FlexDB write (during turn)</text>',
        '</svg>',
    ]
    write("harness-claude-session-flow.svg", lines)


def db_pressure_compare() -> None:
    """Flat icon — what db-pressure measures for each engine."""
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 400" width="960" height="400">',
        '  <defs><marker id="ab" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#2563eb"/></marker></defs>',
        '  <rect width="960" height="400" fill="#ffffff"/>',
        '  <text x="480" y="36" fill="#111827" font-size="17" font-weight="600" text-anchor="middle">db-pressure: what gets counted (short prompt baseline)</text>',
        '  <rect x="40" y="70" width="420" height="280" rx="10" fill="#f9fafb" stroke="#d1d5db" stroke-width="1.5"/>',
        '  <text x="250" y="100" fill="#111827" font-size="15" font-weight="600" text-anchor="middle">OpenCode</text>',
        '  <rect x="70" y="120" width="360" height="44" rx="8" fill="#eff6ff" stroke="#bfdbfe" stroke-width="1.5"/>',
        '  <text x="250" y="147" fill="#111827" font-size="13" text-anchor="middle">harness_sync_events · ~7 rows/round · ~3.6 KB JSON</text>',
        '  <text x="250" y="175" fill="#6b7280" font-size="11" text-anchor="middle">Measured after OMA export (listEvents byte size)</text>',
        '  <text x="250" y="210" fill="#6b7280" font-size="11" text-anchor="middle">+ harness_sessions metadata (not in row count)</text>',
        '  <text x="250" y="250" fill="#16a34a" font-size="12" font-weight="600" text-anchor="middle">Wall ~90s/round (LLM + sandbox)</text>',
        '  <rect x="500" y="70" width="420" height="280" rx="10" fill="#f9fafb" stroke="#d1d5db" stroke-width="1.5"/>',
        '  <text x="710" y="100" fill="#111827" font-size="15" font-weight="600" text-anchor="middle">Claude Code</text>',
        '  <rect x="530" y="120" width="360" height="44" rx="8" fill="#faf5ff" stroke="#d8b4fe" stroke-width="1.5"/>',
        '  <text x="710" y="147" fill="#111827" font-size="13" text-anchor="middle">harness_claude_session_entries · ~6 rows/round</text>',
        '  <text x="710" y="175" fill="#6b7280" font-size="11" text-anchor="middle">bytes~ = rows × 512B estimate (not real JSON)</text>',
        '  <text x="710" y="210" fill="#6b7280" font-size="11" text-anchor="middle">messages/summaries not counted</text>',
        '  <text x="710" y="250" fill="#16a34a" font-size="12" font-weight="600" text-anchor="middle">Wall ~3 min/round (model/route)</text>',
        '  <text x="480" y="375" fill="#6b7280" font-size="12" text-anchor="middle">npm run harness -- db-pressure --engines all</text>',
        '</svg>',
    ]
    write("harness-db-pressure-compare.svg", lines)


def main() -> None:
    arch_diagram()
    opencode_flow()
    claude_flow()
    db_pressure_compare()
    for name in [
        "harness-session-storage-architecture.svg",
        "harness-opencode-export-flow.svg",
        "harness-claude-session-flow.svg",
        "harness-db-pressure-compare.svg",
    ]:
        import xml.etree.ElementTree as ET

        ET.parse(OUT / name)
        print(f"valid xml: {name}")


if __name__ == "__main__":
    main()
