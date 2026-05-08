#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import json
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


PROFILES = [
    "system",
    "triage",
    "artifacts",
    "browser",
    "ghidra",
    "rev",
    "pwn",
    "crypto",
    "web",
    "mobile",
    "forensics",
    "frida",
]


async def list_tools(profile: str) -> list[str]:
    params = StdioServerParameters(command="ctf-mcp-server", args=[profile])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            return [tool.name for tool in tools.tools]


async def call_tool(profile: str, tool: str, args: dict) -> str:
    params = StdioServerParameters(command="ctf-mcp-server", args=[profile])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(tool, args)
            return "\n".join(getattr(item, "text", str(item)) for item in result.content)


async def main() -> int:
    report: dict[str, object] = {"profiles": {}, "calls": {}}
    failed = False
    for profile in PROFILES:
        try:
            tools = await asyncio.wait_for(list_tools(profile), timeout=20)
            report["profiles"][profile] = {"ok": True, "tools": tools}
        except Exception as exc:
            failed = True
            report["profiles"][profile] = {"ok": False, "error": repr(exc)}

    smoke_calls = [
        ("browser", "chrome_dom", {"url": "data:text/html,<h1>mcp-ok</h1>", "timeout": 30}, "mcp-ok"),
        ("browser", "chrome_eval_js", {"url": "data:text/html,<script>window.x=21*2</script>", "javascript": "window.x", "timeout": 30}, "\"value\": 42"),
        ("ghidra", "ghidra_summary", {"path": "/bin/true", "timeout": 240}, "function_count="),
        ("system", "run_cached", {"command": "printf mcp-cache-ok", "timeout": 30}, "\"cache\": \"miss\""),
        ("system", "run_cached", {"command": "printf mcp-cache-ok", "timeout": 30}, "\"cache\": \"hit\""),
        ("system", "command_cache_stats", {}, "cache_hit_count"),
        ("triage", "triage_path", {"path": "/bin/true", "limit": 1}, "recommended_routes"),
        ("triage", "auto_triage", {"path": "/bin/true", "limit": 1, "timeout": 120}, "saved_report="),
        ("pwn", "pwn_triage", {"path": "/bin/true", "timeout": 120}, "saved_report="),
        ("crypto", "sage_eval", {"expression": "2^16 + 1", "timeout": 120}, "65537"),
        ("forensics", "forensics_triage", {"path": "/bin/true", "timeout": 120}, "saved_report="),
        ("artifacts", "artifact_stats", {}, "artifact_count"),
    ]
    for profile, tool, args, marker in smoke_calls:
        key = f"{profile}.{tool}"
        try:
            text = await asyncio.wait_for(call_tool(profile, tool, args), timeout=max(30, int(args.get("timeout", 60)) + 30))
            ok = marker in text and "[exit " not in text
            failed = failed or not ok
            report["calls"][key] = {"ok": ok, "marker": marker, "preview": text[:1000]}
        except Exception as exc:
            failed = True
            report["calls"][key] = {"ok": False, "error": repr(exc)}

    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
