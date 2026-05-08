#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
from pathlib import Path


WORKSPACE = os.environ.get("WORKSPACE") or os.environ.get("CTF_MCP_WORKSPACE") or "/challenge/workspace"
DISTFILES = os.environ.get("DISTFILES") or os.environ.get("CTF_MCP_DISTFILES") or "/challenge/distfiles"
SHARED = os.environ.get("SHARED") or os.environ.get("CTF_MCP_SHARED") or "/challenge/shared"
HOME = Path(os.environ.get("HOME", "/challenge/provider-home/home"))
CODEX_HOME = Path(os.environ.get("CODEX_HOME", str(HOME / ".codex")))
CLAUDE_HOME = Path(os.environ.get("CLAUDE_HOME", str(HOME / ".claude")))

BASE_ENV = {
    "CTF_MCP_WORKSPACE": WORKSPACE,
    "CTF_MCP_DISTFILES": DISTFILES,
    "CTF_MCP_SHARED": SHARED,
    "CTF_MCP_CACHE": os.environ.get("CACHE") or os.environ.get("CTF_MCP_CACHE") or "/challenge/cache",
    "CTF_MCP_GHIDRA_SCRIPT": "/opt/ctf-mcp/CtfMcpGhidra.java",
    "CHROME_BIN": "/usr/bin/google-chrome-stable",
}

SERVERS = {
    "ctf_system": ["system"],
    "ctf_triage": ["triage"],
    "ctf_artifacts": ["artifacts"],
    "ctf_browser": ["browser"],
    "ctf_ghidra": ["ghidra"],
    "ctf_rev": ["rev"],
    "ctf_pwn": ["pwn"],
    "ctf_crypto": ["crypto"],
    "ctf_web": ["web"],
    "ctf_mobile": ["mobile"],
    "ctf_forensics": ["forensics"],
    "ctf_frida": ["frida"],
}


def _toml_str(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _toml_array(values: list[str]) -> str:
    return "[" + ", ".join(_toml_str(v) for v in values) + "]"


def _toml_inline_env(env: dict[str, str]) -> str:
    items = ", ".join(f"{key} = {_toml_str(value)}" for key, value in sorted(env.items()))
    return "{ " + items + " }"


def _strip_codex_ctf_blocks(text: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    skipping = False
    header_re = re.compile(r"^\s*\[mcp_servers\.(ctf_[A-Za-z0-9_]+)\]\s*$")
    any_header_re = re.compile(r"^\s*\[.*\]\s*$")
    for line in lines:
        if header_re.match(line):
            skipping = True
            continue
        if skipping and any_header_re.match(line):
            skipping = False
        if not skipping:
            out.append(line)
    return "\n".join(out).rstrip()


def configure_codex() -> Path:
    CODEX_HOME.mkdir(parents=True, exist_ok=True)
    config = CODEX_HOME / "config.toml"
    text = config.read_text(encoding="utf-8", errors="replace") if config.exists() else ""
    text = _strip_codex_ctf_blocks(text)
    blocks: list[str] = []
    for name, args in SERVERS.items():
        blocks.append(
            "\n".join(
                [
                    f"[mcp_servers.{name}]",
                    'command = "ctf-mcp-server"',
                    f"args = {_toml_array(args)}",
                    f"env = {_toml_inline_env(BASE_ENV)}",
                ]
            )
        )
    rendered = (text + "\n\n" if text else "") + "\n\n".join(blocks) + "\n"
    config.write_text(rendered, encoding="utf-8")
    return config


def _server_json(args: list[str]) -> dict:
    return {
        "type": "stdio",
        "command": "ctf-mcp-server",
        "args": args,
        "env": BASE_ENV,
    }


def configure_claude() -> tuple[Path, Path]:
    Path(WORKSPACE).mkdir(parents=True, exist_ok=True)
    CLAUDE_HOME.mkdir(parents=True, exist_ok=True)
    project_config = Path(WORKSPACE) / ".mcp.json"
    home_config = CLAUDE_HOME / "ctf-mcp.json"
    data: dict = {}
    if project_config.exists():
        try:
            data = json.loads(project_config.read_text(encoding="utf-8"))
        except Exception:
            backup = project_config.with_suffix(".json.bak")
            backup.write_text(project_config.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
            data = {}
    servers = data.setdefault("mcpServers", {})
    for name, args in SERVERS.items():
        servers[name] = _server_json(args)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    project_config.write_text(text, encoding="utf-8")
    home_config.write_text(text, encoding="utf-8")
    return project_config, home_config


def main() -> int:
    codex = configure_codex()
    claude_project, claude_home = configure_claude()
    print(f"codex_mcp={codex}")
    print(f"claude_mcp_project={claude_project}")
    print(f"claude_mcp_home={claude_home}")
    print("servers=" + ",".join(SERVERS))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
