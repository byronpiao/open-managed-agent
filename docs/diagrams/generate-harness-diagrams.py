#!/usr/bin/env python3
"""Generate harness documentation SVG diagrams (no HTML)."""

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


def runtime_stack() -> None:
    """Dark architecture — harness runtime request path (harness-architecture / tutorial)."""
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 520" width="1000" height="520">',
        '  <defs>',
        '    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" stroke-width="0.5"/></pattern>',
        '    <marker id="ah" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#64748b"/></marker>',
        '    <marker id="ag" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#34d399"/></marker>',
        '  </defs>',
        '  <rect width="1000" height="520" fill="#020617"/><rect width="1000" height="520" fill="url(#grid)"/>',
        '  <text x="500" y="34" fill="#f8fafc" font-family="JetBrains Mono, monospace" font-size="17" font-weight="700" text-anchor="middle">Harness Runtime Stack</text>',
        '  <text x="500" y="54" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="middle">runtime=harness · thinking loop inside AGS sandbox</text>',
        '  <path d="M 130 200 L 230 200" stroke="#64748b" stroke-width="1.5" fill="none" marker-end="url(#ah)"/>',
        '  <path d="M 390 200 L 490 200" stroke="#64748b" stroke-width="1.5" fill="none" marker-end="url(#ah)"/>',
        '  <path d="M 650 200 L 750 200" stroke="#34d399" stroke-width="1.5" fill="none" marker-end="url(#ag)"/>',
        '  <rect x="40" y="170" width="180" height="60" rx="6" fill="#0f172a"/><rect x="40" y="170" width="180" height="60" rx="6" fill="rgba(8,51,68,0.4)" stroke="#22d3ee" stroke-width="1.5"/>',
        '  <text x="130" y="195" fill="#fff" font-family="JetBrains Mono, monospace" font-size="11" font-weight="600" text-anchor="middle">Client</text>',
        '  <text x="130" y="212" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">magent / SDK / ACP</text>',
        '  <rect x="230" y="130" width="360" height="140" rx="12" fill="none" stroke="#fbbf24" stroke-width="1.5" stroke-dasharray="8,4"/>',
        '  <text x="242" y="148" fill="#fbbf24" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600">OMA Runtime (SCF / tcbr)</text>',
        '  <rect x="250" y="162" width="150" height="48" rx="6" fill="#0f172a"/><rect x="250" y="162" width="150" height="48" rx="6" fill="rgba(6,78,59,0.4)" stroke="#34d399" stroke-width="1.5"/>',
        '  <text x="325" y="183" fill="#fff" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600" text-anchor="middle">/v1 Managed Agents</text>',
        '  <text x="325" y="198" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="8" text-anchor="middle">optional MA HTTP</text>',
        '  <rect x="420" y="162" width="150" height="48" rx="6" fill="#0f172a"/><rect x="420" y="162" width="150" height="48" rx="6" fill="rgba(6,78,59,0.4)" stroke="#34d399" stroke-width="1.5"/>',
        '  <text x="495" y="183" fill="#fff" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600" text-anchor="middle">acp-endpoint</text>',
        '  <text x="495" y="198" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="8" text-anchor="middle">orchestrator · sync</text>',
        '  <rect x="490" y="130" width="250" height="200" rx="12" fill="none" stroke="#34d399" stroke-width="1.5" stroke-dasharray="8,4"/>',
        '  <text x="502" y="148" fill="#34d399" font-family="JetBrains Mono, monospace" font-size="10" font-weight="600">AGS Sandbox (magent image)</text>',
        '  <rect x="510" y="170" width="210" height="44" rx="6" fill="#0f172a"/><rect x="510" y="170" width="210" height="44" rx="6" fill="rgba(6,78,59,0.4)" stroke="#34d399" stroke-width="1.5"/>',
        '  <text x="615" y="197" fill="#fff" font-family="JetBrains Mono, monospace" font-size="11" font-weight="600" text-anchor="middle">OpenCode ACP</text>',
        '  <rect x="510" y="224" width="210" height="44" rx="6" fill="#0f172a"/><rect x="510" y="224" width="210" height="44" rx="6" fill="rgba(6,78,59,0.4)" stroke="#34d399" stroke-width="1.5"/>',
        '  <text x="615" y="251" fill="#fff" font-family="JetBrains Mono, monospace" font-size="11" font-weight="600" text-anchor="middle">Claude ACP Harness</text>',
        '  <rect x="750" y="170" width="210" height="98" rx="6" fill="#0f172a"/><rect x="750" y="170" width="210" height="98" rx="6" fill="rgba(120,53,15,0.3)" stroke="#fbbf24" stroke-width="1.5"/>',
        '  <text x="855" y="200" fill="#fff" font-family="JetBrains Mono, monospace" font-size="11" font-weight="600" text-anchor="middle">CloudBase</text>',
        '  <text x="855" y="218" fill="#fde68a" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">AI LLM gateway</text>',
        '  <text x="855" y="234" fill="#fde68a" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">FlexDB harness_*</text>',
        '  <text x="855" y="250" fill="#fde68a" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">optional COS mount</text>',
        '  <path d="M 615 268 L 615 310 L 855 310" stroke="#fbbf24" stroke-width="1.5" fill="none" stroke-dasharray="4,2" marker-end="url(#ah)"/>',
        '  <text x="735" y="302" fill="#fbbf24" font-family="JetBrains Mono, monospace" font-size="8">LLM / persist</text>',
        '  <rect x="40" y="360" width="920" height="130" rx="8" fill="#0f172a" stroke="#334155" stroke-width="1"/>',
        '  <text x="60" y="388" fill="#f8fafc" font-family="JetBrains Mono, monospace" font-size="12" font-weight="600">resolveRuntime(config)</text>',
        '  <text x="60" y="412" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10">index.ts → runtime=harness → managed-agents-endpoint + harness/acp-endpoint</text>',
        '  <text x="60" y="432" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10">runtime=managed → OAK handler only (no sandbox — different product path)</text>',
        '  <text x="60" y="460" fill="#64748b" font-family="JetBrains Mono, monospace" font-size="9">agent.yaml: runtime + engine(opencode|claude|codebuddy) switches behavior</text>',
        '</svg>',
    ]
    write("harness-runtime-stack.svg", lines)


def two_stories() -> None:
    """Flat icon — Story A ACP vs Story B MA HTTP."""
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 480" width="960" height="480">',
        '  <defs><marker id="ab" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#2563eb"/></marker></defs>',
        '  <rect width="960" height="480" fill="#ffffff"/>',
        '  <text x="480" y="36" fill="#111827" font-size="18" font-weight="600" text-anchor="middle">Two Client Stories on One Harness Deploy</text>',
        '  <rect x="380" y="70" width="200" height="48" rx="8" fill="#fef3c7" stroke="#fcd34d" stroke-width="1.5"/>',
        '  <text x="480" y="100" fill="#111827" font-size="13" font-weight="600" text-anchor="middle">CloudBase Agent</text>',
        '  <text x="480" y="108" fill="#6b7280" font-size="10" text-anchor="middle">runtime: harness</text>',
        '  <path d="M 380 118 L 240 118 L 240 150" fill="none" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>',
        '  <path d="M 580 118 L 720 118 L 720 150" fill="none" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>',
        '  <rect x="80" y="150" width="320" height="120" rx="10" fill="#eff6ff" stroke="#93c5fd" stroke-width="1.5"/>',
        '  <text x="240" y="180" fill="#1d4ed8" font-size="14" font-weight="600" text-anchor="middle">Story A · Harness runtime</text>',
        '  <text x="240" y="202" fill="#374151" font-size="12" text-anchor="middle">magent run · JSON-RPC ACP</text>',
        '  <text x="240" y="222" fill="#6b7280" font-size="11" text-anchor="middle">POST .../acp</text>',
        '  <text x="240" y="248" fill="#6b7280" font-size="10" text-anchor="middle">session/new · session/prompt</text>',
        '  <rect x="560" y="150" width="320" height="120" rx="10" fill="#f0fdf4" stroke="#86efac" stroke-width="1.5"/>',
        '  <text x="720" y="180" fill="#15803d" font-size="14" font-weight="600" text-anchor="middle">Story B · MA HTTP</text>',
        '  <text x="720" y="202" fill="#374151" font-size="12" text-anchor="middle">SDK / REST + SSE</text>',
        '  <text x="720" y="222" fill="#6b7280" font-size="11" text-anchor="middle">/v1/agents · sessions · events</text>',
        '  <text x="720" y="248" fill="#6b7280" font-size="10" text-anchor="middle">user.message · tool_confirmation</text>',
        '  <path d="M 240 270 L 240 310 L 480 310 L 480 340" fill="none" stroke="#2563eb" stroke-width="2" marker-end="url(#ab)"/>',
        '  <path d="M 720 270 L 720 310 L 480 310" fill="none" stroke="#2563eb" stroke-width="2"/>',
        '  <rect x="330" y="340" width="300" height="72" rx="10" fill="#fff7ed" stroke="#fdba74" stroke-width="1.5"/>',
        '  <text x="480" y="370" fill="#111827" font-size="14" font-weight="600" text-anchor="middle">AGS Remote Sandbox</text>',
        '  <text x="480" y="392" fill="#6b7280" font-size="11" text-anchor="middle">OpenCode / Claude Code engine</text>',
        '  <text x="480" y="456" fill="#6b7280" font-size="11" text-anchor="middle">Same deploy — do not mix session ID semantics across protocols</text>',
        '</svg>',
    ]
    write("harness-two-stories.svg", lines)


def quickstart_flow() -> None:
    """Flat icon — tutorial quickstart steps."""
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 200" width="960" height="200">',
        '  <defs><marker id="ab" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#2563eb"/></marker></defs>',
        '  <rect width="960" height="200" fill="#ffffff"/>',
        '  <text x="480" y="28" fill="#111827" font-size="16" font-weight="600" text-anchor="middle">Quickstart: first sandbox conversation</text>',
        '  <rect x="24" y="60" width="130" height="52" rx="8" fill="#eff6ff" stroke="#bfdbfe" stroke-width="1.5"/>',
        '  <text x="89" y="84" fill="#111827" font-size="11" font-weight="600" text-anchor="middle">1. magent login</text>',
        '  <text x="89" y="100" fill="#6b7280" font-size="9" text-anchor="middle">tcb env use</text>',
        '  <line x1="154" y1="86" x2="174" y2="86" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>',
        '  <rect x="174" y="60" width="130" height="52" rx="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>',
        '  <text x="239" y="84" fill="#111827" font-size="11" font-weight="600" text-anchor="middle">2. agent.yaml</text>',
        '  <text x="239" y="100" fill="#6b7280" font-size="9" text-anchor="middle">runtime+harness</text>',
        '  <line x1="304" y1="86" x2="324" y2="86" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>',
        '  <rect x="324" y="60" width="150" height="52" rx="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>',
        '  <text x="399" y="84" fill="#111827" font-size="11" font-weight="600" text-anchor="middle">3. agent:create</text>',
        '  <text x="399" y="100" fill="#6b7280" font-size="9" text-anchor="middle">deploy runtime</text>',
        '  <line x1="474" y1="86" x2="494" y2="86" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>',
        '  <rect x="494" y="60" width="130" height="52" rx="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>',
        '  <text x="559" y="84" fill="#111827" font-size="11" font-weight="600" text-anchor="middle">4. magent run</text>',
        '  <text x="559" y="100" fill="#6b7280" font-size="9" text-anchor="middle">warm sandbox</text>',
        '  <line x1="624" y1="86" x2="644" y2="86" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>',
        '  <rect x="644" y="60" width="140" height="52" rx="8" fill="#f0fdf4" stroke="#86efac" stroke-width="1.5"/>',
        '  <text x="714" y="84" fill="#111827" font-size="11" font-weight="600" text-anchor="middle">5. AGS engine</text>',
        '  <text x="714" y="100" fill="#6b7280" font-size="9" text-anchor="middle">opencode / claude</text>',
        '  <line x1="784" y1="86" x2="804" y2="86" stroke="#16a34a" stroke-width="1.5" marker-end="url(#ab)"/>',
        '  <rect x="804" y="60" width="132" height="52" rx="8" fill="#faf5ff" stroke="#d8b4fe" stroke-width="1.5"/>',
        '  <text x="870" y="84" fill="#111827" font-size="11" font-weight="600" text-anchor="middle">CloudBase AI</text>',
        '  <text x="870" y="100" fill="#6b7280" font-size="9" text-anchor="middle">hy3</text>',
        '  <text x="480" y="155" fill="#6b7280" font-size="11" text-anchor="middle">No third-party LLM key required for default path · first run may take 1–3 min</text>',
        '  <text x="480" y="178" fill="#9ca3af" font-size="10" text-anchor="middle">CI / hand-fill CAM: harness-env Advanced settings</text>',
        '</svg>',
    ]
    write("harness-quickstart-flow.svg", lines)


def env_layers() -> None:
    """Flat icon — .env.harness → OMA → TRW injection."""
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 420" width="960" height="420">',
        '  <defs><marker id="ab" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#2563eb"/></marker></defs>',
        '  <rect width="960" height="420" fill="#ffffff"/>',
        '  <text x="480" y="32" fill="#111827" font-size="17" font-weight="600" text-anchor="middle">Harness Environment Layers</text>',
        '  <text x="480" y="54" fill="#6b7280" font-size="12" text-anchor="middle">Harness reads .env.harness only — not .env</text>',
        '  <rect x="80" y="80" width="800" height="72" rx="10" fill="#eff6ff" stroke="#93c5fd" stroke-width="1.5"/>',
        '  <text x="480" y="108" fill="#1d4ed8" font-size="13" font-weight="600" text-anchor="middle">Host · .env.harness + scenarios/.env.*</text>',
        '  <text x="480" y="130" fill="#6b7280" font-size="11" text-anchor="middle">CLOUDBASE_ENV_ID · HARNESS_TOOL_* · HARNESS_COS_* · LLM_* (BYOK scenarios)</text>',
        '  <line x1="480" y1="152" x2="480" y2="178" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>',
        '  <text x="496" y="168" fill="#2563eb" font-size="10">deploy / load-env</text>',
        '  <rect x="80" y="178" width="800" height="72" rx="10" fill="#f0fdf4" stroke="#86efac" stroke-width="1.5"/>',
        '  <text x="480" y="206" fill="#15803d" font-size="13" font-weight="600" text-anchor="middle">OMA Runtime process</text>',
        '  <text x="480" y="228" fill="#6b7280" font-size="11" text-anchor="middle">AGENT_CONFIG · TCB_SECRET_* or TENCENTCLOUD_* (tcbr vs SCF) · PORT</text>',
        '  <line x1="480" y1="250" x2="480" y2="276" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>',
        '  <text x="496" y="266" fill="#2563eb" font-size="10">sandbox start inject</text>',
        '  <rect x="80" y="276" width="800" height="72" rx="10" fill="#fff7ed" stroke="#fdba74" stroke-width="1.5"/>',
        '  <text x="480" y="304" fill="#c2410c" font-size="13" font-weight="600" text-anchor="middle">TRW sandbox (magent image)</text>',
        '  <text x="480" y="326" fill="#6b7280" font-size="11" text-anchor="middle">OPENCODE_CONFIG_CONTENT · HARNESS_* · TENCENTCLOUD_* for in-box FlexDB</text>',
        '  <rect x="80" y="368" width="380" height="36" rx="6" fill="#f9fafb" stroke="#e5e7eb"/>',
        '  <text x="270" y="390" fill="#374151" font-size="11" text-anchor="middle">.env.harness ≠ .env (managed agent / SDK)</text>',
        '  <rect x="500" y="368" width="380" height="36" rx="6" fill="#f9fafb" stroke="#e5e7eb"/>',
        '  <text x="690" y="390" fill="#374151" font-size="11" text-anchor="middle">scenarios strip COS / BYOK per matrix</text>',
        '</svg>',
    ]
    write("harness-env-layers.svg", lines)


def cos_persistence() -> None:
    """Flat icon — conversation replay vs COS workspace."""
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 360" width="960" height="360">',
        '  <defs><marker id="ab" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#2563eb"/></marker></defs>',
        '  <rect width="960" height="360" fill="#ffffff"/>',
        '  <text x="480" y="32" fill="#111827" font-size="17" font-weight="600" text-anchor="middle">Conversation vs Workspace Persistence</text>',
        '  <rect x="40" y="60" width="420" height="250" rx="10" fill="#f9fafb" stroke="#d1d5db" stroke-width="1.5"/>',
        '  <text x="250" y="90" fill="#111827" font-size="14" font-weight="600" text-anchor="middle">Default (no COS)</text>',
        '  <rect x="70" y="110" width="360" height="44" rx="8" fill="#faf5ff" stroke="#d8b4fe"/>',
        '  <text x="250" y="137" fill="#111827" font-size="12" text-anchor="middle">Multi-turn chat → harness_sessions + sync/events</text>',
        '  <rect x="70" y="170" width="360" height="44" rx="8" fill="#fef2f2" stroke="#fecaca"/>',
        '  <text x="250" y="197" fill="#991b1b" font-size="12" text-anchor="middle">Sandbox files lost on TTL / re-acquire</text>',
        '  <text x="250" y="240" fill="#6b7280" font-size="11" text-anchor="middle">test:merge · no HARNESS_COS_* required</text>',
        '  <rect x="500" y="60" width="420" height="250" rx="10" fill="#f0fdf4" stroke="#86efac" stroke-width="1.5"/>',
        '  <text x="710" y="90" fill="#111827" font-size="14" font-weight="600" text-anchor="middle">HARNESS_COS_ENABLED=1</text>',
        '  <rect x="530" y="110" width="360" height="44" rx="8" fill="#faf5ff" stroke="#d8b4fe"/>',
        '  <text x="710" y="137" fill="#111827" font-size="12" text-anchor="middle">Chat replay unchanged (FlexDB)</text>',
        '  <rect x="530" y="170" width="360" height="44" rx="8" fill="#ecfdf5" stroke="#6ee7b7"/>',
        '  <text x="710" y="197" fill="#047857" font-size="12" text-anchor="middle">COS mount + workspace/snapshot on delete</text>',
        '  <text x="710" y="240" fill="#6b7280" font-size="11" text-anchor="middle">harness -- local cos-e2e gate</text>',
        '  <text x="480" y="340" fill="#6b7280" font-size="11" text-anchor="middle">Cloud harness steps auto-strip COS segment</text>',
        '</svg>',
    ]
    write("harness-cos-persistence.svg", lines)


def credentials_flow() -> None:
    """Claude official style — CAM auth path."""
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 400" width="960" height="400">',
        '  <defs><marker id="ac" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><polygon points="0 0, 8 4, 0 8" fill="#5a5a5a"/></marker></defs>',
        '  <rect width="960" height="400" fill="#f8f6f3"/>',
        '  <text x="480" y="38" fill="#1a1a1a" font-size="19" font-weight="700" text-anchor="middle">Credentials: no console API Key required</text>',
        '  <rect x="60" y="70" width="140" height="64" rx="12" fill="#a8c5e6" stroke="#4a4a4a" stroke-width="2.5"/>',
        '  <text x="130" y="100" fill="#1a1a1a" font-size="14" font-weight="600" text-anchor="middle">Developer</text>',
        '  <text x="130" y="118" fill="#6a6a6a" font-size="11" text-anchor="middle">magent login</text>',
        '  <line x1="200" y1="102" x2="250" y2="102" stroke="#5a5a5a" stroke-width="2" marker-end="url(#ac)"/>',
        '  <rect x="250" y="70" width="160" height="64" rx="12" fill="#f4e4c1" stroke="#4a4a4a" stroke-width="2.5"/>',
        '  <text x="330" y="98" fill="#1a1a1a" font-size="13" font-weight="600" text-anchor="middle">CAM temp keys</text>',
        '  <text x="330" y="118" fill="#6a6a6a" font-size="11" text-anchor="middle">replaces TCB_SECRET_*</text>',
        '  <line x1="410" y1="102" x2="460" y2="102" stroke="#5a5a5a" stroke-width="2" marker-end="url(#ac)"/>',
        '  <rect x="460" y="70" width="180" height="64" rx="12" fill="#9dd4c7" stroke="#4a4a4a" stroke-width="2.5"/>',
        '  <text x="550" y="98" fill="#1a1a1a" font-size="13" font-weight="600" text-anchor="middle">OMA Runtime</text>',
        '  <text x="550" y="118" fill="#6a6a6a" font-size="11" text-anchor="middle">gateway JWT exchange</text>',
        '  <line x1="640" y1="102" x2="690" y2="102" stroke="#5a5a5a" stroke-width="2" marker-end="url(#ac)"/>',
        '  <rect x="690" y="70" width="210" height="64" rx="12" fill="#e8e6e3" stroke="#4a4a4a" stroke-width="2.5"/>',
        '  <text x="795" y="98" fill="#1a1a1a" font-size="13" font-weight="600" text-anchor="middle">CloudBase services</text>',
        '  <text x="795" y="118" fill="#6a6a6a" font-size="11" text-anchor="middle">AI · FlexDB · AGS control</text>',
        '  <rect x="60" y="170" width="840" height="90" rx="12" fill="#ffffff" stroke="#4a4a4a" stroke-width="1.5" stroke-dasharray="8,4"/>',
        '  <text x="480" y="200" fill="#1a1a1a" font-size="14" font-weight="600" text-anchor="middle">Sandbox instance (sit_*)</text>',
        '  <text x="480" y="222" fill="#6a6a6a" font-size="12" text-anchor="middle">Session token injected at start — do not copy into .env</text>',
        '  <text x="480" y="244" fill="#6a6a6a" font-size="11" text-anchor="middle">HARNESS_TOOL_ROLE_ARN only when auto-creating first AGS tool</text>',
        '  <rect x="60" y="290" width="400" height="72" rx="12" fill="#a8c5e6" stroke="#4a4a4a" stroke-width="2"/>',
        '  <text x="260" y="320" fill="#1a1a1a" font-size="13" font-weight="600" text-anchor="middle">Optional LLM_* (BYOK)</text>',
        '  <text x="260" y="342" fill="#6a6a6a" font-size="11" text-anchor="middle">Third-party key — mutually exclusive with default AI</text>',
        '  <rect x="500" y="290" width="400" height="72" rx="12" fill="#e8e6e3" stroke="#4a4a4a" stroke-width="2"/>',
        '  <text x="700" y="320" fill="#1a1a1a" font-size="13" font-weight="600" text-anchor="middle">Optional HARNESS_COS_*</text>',
        '  <text x="700" y="342" fill="#6a6a6a" font-size="11" text-anchor="middle">Workspace mount — not required for chat</text>',
        '</svg>',
    ]
    write("harness-credentials-flow.svg", lines)


def opencode_models() -> None:
    """Flat icon — OpenCode model routing."""
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 320" width="960" height="320">',
        '  <defs><marker id="ab" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#2563eb"/></marker></defs>',
        '  <rect width="960" height="320" fill="#ffffff"/>',
        '  <text x="480" y="32" fill="#111827" font-size="17" font-weight="600" text-anchor="middle">OpenCode Model Routing (priority)</text>',
        '  <rect x="60" y="70" width="250" height="200" rx="10" fill="#eff6ff" stroke="#93c5fd" stroke-width="2"/>',
        '  <text x="185" y="100" fill="#1d4ed8" font-size="13" font-weight="600" text-anchor="middle">1 · Default</text>',
        '  <text x="185" y="130" fill="#111827" font-size="12" text-anchor="middle">omit model or hy3</text>',
        '  <text x="185" y="155" fill="#6b7280" font-size="11" text-anchor="middle">CLOUDBASE_APIKEY + CAM</text>',
        '  <text x="185" y="178" fill="#6b7280" font-size="11" text-anchor="middle">CloudBase AI gateway</text>',
        '  <text x="185" y="210" fill="#16a34a" font-size="11" font-weight="600" text-anchor="middle">Recommended start</text>',
        '  <rect x="355" y="70" width="250" height="200" rx="10" fill="#f0fdf4" stroke="#86efac" stroke-width="2"/>',
        '  <text x="480" y="100" fill="#15803d" font-size="13" font-weight="600" text-anchor="middle">2 · zen (opencode only)</text>',
        '  <text x="480" y="130" fill="#111827" font-size="12" text-anchor="middle">model: zen in yaml</text>',
        '  <text x="480" y="155" fill="#6b7280" font-size="11" text-anchor="middle">Built into sandbox image</text>',
        '  <text x="480" y="178" fill="#6b7280" font-size="11" text-anchor="middle">No CloudBase AI quota</text>',
        '  <text x="480" y="210" fill="#6b7280" font-size="11" text-anchor="middle">cloud-tcbr harness scenario</text>',
        '  <rect x="650" y="70" width="250" height="200" rx="10" fill="#fff7ed" stroke="#fdba74" stroke-width="2"/>',
        '  <text x="775" y="100" fill="#c2410c" font-size="13" font-weight="600" text-anchor="middle">3 · Custom BYOK</text>',
        '  <text x="775" y="130" fill="#111827" font-size="12" text-anchor="middle">LLM_* + OPENAI_BASE_URL</text>',
        '  <text x="775" y="155" fill="#6b7280" font-size="11" text-anchor="middle">or ModelSpec in yaml</text>',
        '  <text x="775" y="178" fill="#6b7280" font-size="11" text-anchor="middle">OpenAI-compatible vendor</text>',
        '  <text x="775" y="210" fill="#dc2626" font-size="11" text-anchor="middle">Mutually exclusive w/ default AI</text>',
        '  <text x="480" y="300" fill="#6b7280" font-size="11" text-anchor="middle">Set before agent:create · update env or redeploy to rotate keys</text>',
        '</svg>',
    ]
    write("harness-opencode-models.svg", lines)


def claude_models() -> None:
    """Claude official — Claude model routing."""
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 280" width="960" height="280">',
        '  <defs><marker id="ac" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><polygon points="0 0, 8 4, 0 8" fill="#5a5a5a"/></marker></defs>',
        '  <rect width="960" height="280" fill="#f8f6f3"/>',
        '  <text x="480" y="36" fill="#1a1a1a" font-size="19" font-weight="700" text-anchor="middle">Claude Code Model Routing</text>',
        '  <text x="480" y="58" fill="#6a6a6a" font-size="13" text-anchor="middle">No zen built-in — use CloudBase AI or BYOK</text>',
        '  <rect x="80" y="90" width="360" height="150" rx="12" fill="#a8c5e6" stroke="#4a4a4a" stroke-width="2.5"/>',
        '  <text x="260" y="125" fill="#1a1a1a" font-size="15" font-weight="600" text-anchor="middle">Default · CloudBase AI</text>',
        '  <text x="260" y="150" fill="#6a6a6a" font-size="12" text-anchor="middle">hy3 via Anthropic-compatible gateway</text>',
        '  <text x="260" y="175" fill="#6a6a6a" font-size="11" text-anchor="middle">magent login — no Anthropic.com key</text>',
        '  <text x="260" y="210" fill="#1a1a1a" font-size="12" font-weight="600" text-anchor="middle">Recommended start</text>',
        '  <rect x="520" y="90" width="360" height="150" rx="12" fill="#f4e4c1" stroke="#4a4a4a" stroke-width="2.5"/>',
        '  <text x="700" y="125" fill="#1a1a1a" font-size="15" font-weight="600" text-anchor="middle">Custom BYOK</text>',
        '  <text x="700" y="150" fill="#6a6a6a" font-size="12" text-anchor="middle">LLM_* + ANTHROPIC_BASE_URL</text>',
        '  <text x="700" y="175" fill="#6a6a6a" font-size="11" text-anchor="middle">Third-party Anthropic-compatible endpoint</text>',
        '  <text x="700" y="210" fill="#6a6a6a" font-size="11" text-anchor="middle">Do not set LLM_* if using default AI</text>',
        '</svg>',
    ]
    write("harness-claude-models.svg", lines)


def test_scenarios() -> None:
    """Dark — harness acceptance scenarios."""
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 400" width="1000" height="400">',
        '  <defs>',
        '    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" stroke-width="0.5"/></pattern>',
        '  </defs>',
        '  <rect width="1000" height="400" fill="#020617"/><rect width="1000" height="400" fill="url(#grid)"/>',
        '  <text x="500" y="34" fill="#f8fafc" font-family="JetBrains Mono, monospace" font-size="16" font-weight="700" text-anchor="middle">Harness Acceptance Scenarios</text>',
        '  <rect x="40" y="70" width="280" height="140" rx="8" fill="#0f172a" stroke="#22d3ee" stroke-width="1.5"/>',
        '  <text x="180" y="100" fill="#22d3ee" font-family="JetBrains Mono, monospace" font-size="12" font-weight="600" text-anchor="middle">local / test:merge</text>',
        '  <text x="180" y="125" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="middle">Host process + real AGS</text>',
        '  <text x="180" y="145" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="middle">CloudBase AI default LLM</text>',
        '  <text x="180" y="165" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="middle">COS optional (⑥ segment)</text>',
        '  <text x="180" y="190" fill="#64748b" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">npm run test:merge</text>',
        '  <rect x="360" y="70" width="280" height="140" rx="8" fill="#0f172a" stroke="#34d399" stroke-width="1.5"/>',
        '  <text x="500" y="100" fill="#34d399" font-family="JetBrains Mono, monospace" font-size="12" font-weight="600" text-anchor="middle">cloud-tcbr-opencode</text>',
        '  <text x="500" y="125" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="middle">tcbr container deploy</text>',
        '  <text x="500" y="145" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="middle">opencode zen (strip BYOK)</text>',
        '  <text x="500" y="165" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="middle">COS stripped</text>',
        '  <text x="500" y="190" fill="#64748b" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">harness -- cloud-tcbr-opencode</text>',
        '  <rect x="680" y="70" width="280" height="140" rx="8" fill="#0f172a" stroke="#fbbf24" stroke-width="1.5"/>',
        '  <text x="820" y="100" fill="#fbbf24" font-family="JetBrains Mono, monospace" font-size="12" font-weight="600" text-anchor="middle">cloud-scf-opencode</text>',
        '  <text x="820" y="125" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="middle">SCF function deploy</text>',
        '  <text x="820" y="145" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="middle">custom LLM (③ scenario)</text>',
        '  <text x="820" y="165" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10" text-anchor="middle">TENCENTCLOUD_* role inject</text>',
        '  <text x="820" y="190" fill="#64748b" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="middle">harness -- cloud-scf-opencode</text>',
        '  <rect x="40" y="240" width="920" height="120" rx="8" fill="#0f172a" stroke="#334155"/>',
        '  <text x="60" y="270" fill="#f8fafc" font-family="JetBrains Mono, monospace" font-size="11" font-weight="600">Also</text>',
        '  <text x="60" y="292" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10">db-pressure — FlexDB row/bytes probe (opencode | claude | all)</text>',
        '  <text x="60" y="312" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10">local-claude / cloud-*-claude — scenarios/.env.local-claude BYOK</text>',
        '  <text x="60" y="332" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="10">ma-protocol — separate MA HTTP smoke (Story B)</text>',
        '  <text x="60" y="352" fill="#64748b" font-family="JetBrains Mono, monospace" font-size="9">One .env.harness cannot run all scenarios — see scenarios/README.md</text>',
        '</svg>',
    ]
    write("harness-test-scenarios.svg", lines)


def main() -> None:
    arch_diagram()
    opencode_flow()
    claude_flow()
    db_pressure_compare()
    runtime_stack()
    two_stories()
    quickstart_flow()
    env_layers()
    cos_persistence()
    credentials_flow()
    opencode_models()
    claude_models()
    test_scenarios()
    import xml.etree.ElementTree as ET

    for path in sorted(OUT.glob("harness-*.svg")):
        ET.parse(path)
        print(f"valid xml: {path.name}")


if __name__ == "__main__":
    main()
