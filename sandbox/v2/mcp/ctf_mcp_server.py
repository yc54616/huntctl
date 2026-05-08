#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import shlex
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

from mcp.server.fastmcp import FastMCP


PROFILE = (sys.argv[1] if len(sys.argv) > 1 else "all").strip().lower()
WORKSPACE = Path(os.environ.get("CTF_MCP_WORKSPACE", "/challenge/workspace"))
DISTFILES = Path(os.environ.get("CTF_MCP_DISTFILES", "/challenge/distfiles"))
SHARED = Path(os.environ.get("CTF_MCP_SHARED", "/challenge/shared"))
CACHE = Path(os.environ.get("CTF_MCP_CACHE", "/challenge/cache"))
GHIDRA_SCRIPT = Path(os.environ.get("CTF_MCP_GHIDRA_SCRIPT", "/opt/ctf-mcp/CtfMcpGhidra.java"))

try:
    SHARED.mkdir(parents=True, exist_ok=True)
except PermissionError:
    SHARED = Path("/tmp/ctf-mcp-shared")
    SHARED.mkdir(parents=True, exist_ok=True)
try:
    CACHE.mkdir(parents=True, exist_ok=True)
except PermissionError:
    CACHE = Path("/tmp/ctf-mcp-cache")
    CACHE.mkdir(parents=True, exist_ok=True)

mcp = FastMCP(f"ctf-{PROFILE}")


def _enabled(*profiles: str) -> bool:
    return PROFILE == "all" or PROFILE in profiles


def _which(name: str) -> str | None:
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        path = Path(directory) / name
        if path.exists() and os.access(path, os.X_OK):
            return str(path)
    return None


def _safe_name(prefix: str, suffix: str = ".txt") -> Path:
    stamp = int(time.time() * 1000)
    return SHARED / f"{prefix}-{stamp}{suffix}"


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_text_preview(path: Path, max_bytes: int = 4096) -> str:
    try:
        data = path.read_bytes()[:max_bytes]
    except Exception as exc:
        return f"[read error] {exc}"
    return data.decode("utf-8", errors="replace")


def _json_dump(data: object) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)


def _spill(label: str, output: str, limit: int = 24000) -> str:
    if len(output.encode("utf-8", errors="replace")) <= limit:
        return output
    path = _safe_name(label)
    path.write_text(output, encoding="utf-8", errors="replace")
    preview = output[:4000]
    return f"{preview}\n\n...[truncated, full output saved to {path}]"


def _run(
    command: str | list[str],
    *,
    timeout: int = 120,
    cwd: Path | str = WORKSPACE,
    label: str = "mcp-output",
    shell: bool | None = None,
) -> str:
    if shell is None:
        shell = isinstance(command, str)
    run_cwd = Path(cwd)
    if not run_cwd.exists():
        run_cwd = Path.cwd()
    try:
        proc = subprocess.run(
            command,
            cwd=str(run_cwd),
            shell=shell,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=max(1, int(timeout)),
            env=os.environ.copy(),
        )
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout if isinstance(exc.stdout, str) else (exc.stdout or b"").decode(errors="replace")
        stderr = exc.stderr if isinstance(exc.stderr, str) else (exc.stderr or b"").decode(errors="replace")
        return _spill(label, f"{stdout}\n{stderr}\n[timeout after {timeout}s]")
    except Exception as exc:
        return f"[mcp error] {type(exc).__name__}: {exc}"

    output = proc.stdout
    if proc.stderr:
        output += ("\n" if output else "") + proc.stderr
    if not output:
        output = f"[exit {proc.returncode}]"
    elif proc.returncode != 0:
        output += f"\n[exit {proc.returncode}]"
    return _spill(label, output)


def _quote_path(path: str) -> str:
    return shlex.quote(path)


def _file_type(path: Path) -> str:
    if not path.exists():
        return "[missing]"
    return _run(["file", "-b", str(path)], timeout=20, label="file", shell=False).strip()


def _routing_for(path: Path, file_type: str) -> list[str]:
    lower_name = path.name.lower()
    lower_type = file_type.lower()
    routes: list[str] = []
    if any(x in lower_type for x in ("elf", "pe32", "mach-o", "wasm")) or path.suffix.lower() in {".so", ".elf", ".exe", ".dll", ".wasm"}:
        routes += ["ctf_rev.binary_overview", "ctf_ghidra.ghidra_summary", "ctf_pwn.gdb_checksec"]
    if any(x in lower_type for x in ("zip archive", "tar archive", "gzip", "bzip2", "xz compressed", "7-zip")) or path.suffix.lower() in {".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar"}:
        routes += ["ctf_forensics.forensics_overview", "ctf_triage.triage_path extracted directory"]
    if "android package" in lower_type or lower_name.endswith((".apk", ".dex", ".jar")):
        routes += ["ctf_mobile.apk_overview", "ctf_mobile.jadx_decompile"]
    if any(x in lower_type for x in ("pcap", "capture file")) or lower_name.endswith((".pcap", ".pcapng")):
        routes += ["tshark via ctf_system.run_limited", "ctf_forensics.forensics_overview"]
    if any(x in lower_type for x in ("image", "png", "jpeg", "gif", "webp")):
        routes += ["ctf_forensics.forensics_overview", "zsteg/steghide via ctf_system.run_limited"]
    if "text" in lower_type or path.suffix.lower() in {".txt", ".py", ".js", ".c", ".cpp", ".go", ".rs", ".java", ".md", ".json", ".yml", ".yaml"}:
        routes += ["ctf_triage.triage_path", "rg/search via ctf_system.run_limited"]
    if not routes:
        routes += ["ctf_forensics.forensics_overview", "ctf_system.run_limited"]
    return list(dict.fromkeys(routes))


def _artifact_record(path: Path, root: Path) -> dict:
    stat = path.stat()
    record = {
        "path": str(path),
        "relative_path": str(path.relative_to(root)) if path.is_relative_to(root) else path.name,
        "size": stat.st_size,
        "mtime": int(stat.st_mtime),
        "mime_guess": mimetypes.guess_type(path.name)[0],
    }
    if stat.st_size <= 100 * 1024 * 1024:
        try:
            record["sha256"] = _sha256_file(path)
        except Exception as exc:
            record["sha256_error"] = str(exc)
    if stat.st_size <= 64 * 1024:
        record["preview"] = _read_text_preview(path, 2048)
    return record


def _index_artifacts(root: Path, limit: int = 500) -> dict:
    root = root.resolve()
    records: list[dict] = []
    if not root.exists():
        return {"root": str(root), "count": 0, "artifacts": []}
    for path in sorted(root.rglob("*")):
        if len(records) >= limit:
            break
        if path.is_file():
            try:
                records.append(_artifact_record(path, root))
            except Exception as exc:
                records.append({"path": str(path), "error": str(exc)})
    return {"root": str(root), "count": len(records), "artifacts": records}


def _artifact_db() -> sqlite3.Connection:
    db_path = CACHE / "artifact-index.sqlite3"
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS artifacts (
            path TEXT PRIMARY KEY,
            sha256 TEXT,
            size INTEGER,
            mtime INTEGER,
            kind TEXT,
            source_tool TEXT,
            command TEXT,
            preview TEXT,
            updated_at INTEGER
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_artifacts_sha256 ON artifacts(sha256)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind)")
    return conn


def _command_cache_db() -> sqlite3.Connection:
    db_path = CACHE / "command-cache.sqlite3"
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS command_cache (
            cache_key TEXT PRIMARY KEY,
            command TEXT,
            cwd TEXT,
            timeout INTEGER,
            output_path TEXT,
            returncode INTEGER,
            duration REAL,
            output_bytes INTEGER,
            created_at INTEGER,
            last_hit_at INTEGER,
            hit_count INTEGER DEFAULT 0
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_command_cache_command ON command_cache(command)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_command_cache_last_hit ON command_cache(last_hit_at)")
    return conn


def _command_cache_key(command: str, cwd: Path, timeout: int, fingerprint: str = "") -> str:
    payload = "\0".join([command, str(cwd.resolve() if cwd.exists() else cwd), str(int(timeout)), fingerprint])
    return hashlib.sha256(payload.encode("utf-8", errors="replace")).hexdigest()


def _run_command_cached(command: str, *, timeout: int = 120, cwd: Path | str = WORKSPACE, refresh: bool = False, max_preview: int = 8000) -> str:
    run_cwd = Path(cwd)
    if not run_cwd.exists():
        run_cwd = Path.cwd()
    key = _command_cache_key(command, run_cwd, timeout)
    cache_dir = CACHE / "command-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    with _command_cache_db() as conn:
        row = conn.execute(
            "SELECT output_path, returncode, duration, output_bytes, created_at, hit_count FROM command_cache WHERE cache_key = ?",
            (key,),
        ).fetchone()
        if row and not refresh:
            output_path, returncode, duration, output_bytes, created_at, hit_count = row
            conn.execute(
                "UPDATE command_cache SET last_hit_at = ?, hit_count = hit_count + 1 WHERE cache_key = ?",
                (int(time.time()), key),
            )
            preview = _read_text_preview(Path(output_path), max_bytes=max(512, int(max_preview)))
            return _json_dump({
                "cache": "hit",
                "cache_key": key,
                "returncode": returncode,
                "duration_seconds": duration,
                "output_bytes": output_bytes,
                "created_at": created_at,
                "hit_count_before": hit_count,
                "output_path": output_path,
                "preview": preview,
            })

    started = time.time()
    try:
        proc = subprocess.run(
            command,
            cwd=str(run_cwd),
            shell=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=max(1, int(timeout)),
            env=os.environ.copy(),
        )
        output = proc.stdout
        if proc.stderr:
            output += ("\n" if output else "") + proc.stderr
        if not output:
            output = f"[exit {proc.returncode}]"
        elif proc.returncode != 0:
            output += f"\n[exit {proc.returncode}]"
        returncode = proc.returncode
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout if isinstance(exc.stdout, str) else (exc.stdout or b"").decode(errors="replace")
        stderr = exc.stderr if isinstance(exc.stderr, str) else (exc.stderr or b"").decode(errors="replace")
        output = f"{stdout}\n{stderr}\n[timeout after {timeout}s]"
        returncode = 124
    except Exception as exc:
        output = f"[mcp error] {type(exc).__name__}: {exc}"
        returncode = 1
    duration = round(time.time() - started, 3)
    output_path = cache_dir / f"{key}.txt"
    output_path.write_text(output, encoding="utf-8", errors="replace")
    _record_artifact(output_path, kind="command-cache-output", source_tool="run_cached", command=command, preview=output[:3000])
    output_bytes = len(output.encode("utf-8", errors="replace"))
    with _command_cache_db() as conn:
        conn.execute(
            """
            INSERT INTO command_cache(cache_key, command, cwd, timeout, output_path, returncode, duration, output_bytes, created_at, last_hit_at, hit_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(cache_key) DO UPDATE SET
                command=excluded.command,
                cwd=excluded.cwd,
                timeout=excluded.timeout,
                output_path=excluded.output_path,
                returncode=excluded.returncode,
                duration=excluded.duration,
                output_bytes=excluded.output_bytes,
                created_at=excluded.created_at,
                last_hit_at=excluded.last_hit_at,
                hit_count=0
            """,
            (
                key,
                command,
                str(run_cwd),
                int(timeout),
                str(output_path),
                int(returncode),
                float(duration),
                int(output_bytes),
                int(time.time()),
                int(time.time()),
            ),
        )
    return _json_dump({
        "cache": "miss",
        "cache_key": key,
        "returncode": returncode,
        "duration_seconds": duration,
        "output_bytes": output_bytes,
        "output_path": str(output_path),
        "preview": output[: max(512, int(max_preview))],
    })


def _record_artifact(path: Path, *, kind: str = "", source_tool: str = "", command: str = "", preview: str = "") -> None:
    if not path.exists() or not path.is_file():
        return
    try:
        stat = path.stat()
        sha = _sha256_file(path) if stat.st_size <= 100 * 1024 * 1024 else ""
        if not preview:
            preview = _read_text_preview(path, 3000)
        with _artifact_db() as conn:
            conn.execute(
                """
                INSERT INTO artifacts(path, sha256, size, mtime, kind, source_tool, command, preview, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    sha256=excluded.sha256,
                    size=excluded.size,
                    mtime=excluded.mtime,
                    kind=excluded.kind,
                    source_tool=excluded.source_tool,
                    command=excluded.command,
                    preview=excluded.preview,
                    updated_at=excluded.updated_at
                """,
                (
                    str(path),
                    sha,
                    stat.st_size,
                    int(stat.st_mtime),
                    kind,
                    source_tool,
                    command,
                    preview[:8000],
                    int(time.time()),
                ),
            )
    except Exception:
        return


def _write_report(prefix: str, text: str, *, kind: str, source_tool: str, command: str = "") -> Path:
    path = _safe_name(prefix, ".md")
    path.write_text(text, encoding="utf-8", errors="replace")
    _record_artifact(path, kind=kind, source_tool=source_tool, command=command, preview=text[:3000])
    return path


def _collect_files(root: Path, limit: int = 80) -> list[Path]:
    if not root.exists():
        return []
    if root.is_file():
        return [root]
    files = [p for p in sorted(root.rglob("*")) if p.is_file()]
    return files[: max(1, int(limit))]


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _chrome_bin() -> str | None:
    candidates = [
        os.environ.get("CHROME_BIN", ""),
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        if "/" in candidate and Path(candidate).exists():
            return candidate
        found = _which(candidate)
        if found:
            return found
    return None


async def _chrome_eval_cdp(url: str, expression: str, wait_ms: int, timeout: int, *, resources: bool = False) -> str:
    import asyncio
    import websockets

    chrome = _chrome_bin()
    if not chrome:
        return "[missing] chromium/google-chrome not found"
    port = _free_port()
    user_data = tempfile.TemporaryDirectory(prefix="ctf-chrome-")
    proc = subprocess.Popen(
        [
            chrome,
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            f"--remote-debugging-port={port}",
            f"--user-data-dir={user_data.name}",
            "about:blank",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + max(5, timeout)
        page_ws = ""
        while time.monotonic() < deadline:
            try:
                new_url = f"http://127.0.0.1:{port}/json/new?{urllib.parse.quote(url, safe=':/?&=%#,+')}"
                req = urllib.request.Request(new_url, method="PUT")
                with urllib.request.urlopen(req, timeout=2) as r:
                    page_info = json.loads(r.read().decode())
                page_ws = page_info.get("webSocketDebuggerUrl", "")
                if page_ws:
                    break
            except Exception:
                await asyncio.sleep(0.2)
        if not page_ws:
            return "[chrome error] remote debugging page was not created"

        next_id = 0
        network_events: list[dict] = []

        async with websockets.connect(page_ws, max_size=16 * 1024 * 1024) as ws:
            async def call(method: str, params: dict | None = None) -> dict:
                nonlocal next_id
                next_id += 1
                msg_id = next_id
                await ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
                while True:
                    raw = await asyncio.wait_for(ws.recv(), timeout=max(1, timeout))
                    event = json.loads(raw)
                    if event.get("id") == msg_id:
                        return event
                    if resources and str(event.get("method", "")).startswith("Network."):
                        network_events.append(event)

            await call("Page.enable")
            await call("Runtime.enable")
            if resources:
                await call("Network.enable")
            await call("Page.navigate", {"url": url})
            await asyncio.sleep(max(0, wait_ms) / 1000)
            result = await call(
                "Runtime.evaluate",
                {"expression": expression, "returnByValue": True, "awaitPromise": True},
            )
            value = (result.get("result") or {}).get("result", {})
            out = {
                "value": value.get("value", value.get("description")),
                "type": value.get("type"),
                "subtype": value.get("subtype"),
            }
            if resources:
                perf = await call(
                    "Runtime.evaluate",
                    {
                        "expression": "JSON.stringify(performance.getEntriesByType('resource').map(r => ({name:r.name, initiatorType:r.initiatorType, duration:r.duration, transferSize:r.transferSize})))",
                        "returnByValue": True,
                    },
                )
                perf_value = (((perf.get("result") or {}).get("result") or {}).get("value")) or "[]"
                try:
                    out["performance_resources"] = json.loads(perf_value)
                except Exception:
                    out["performance_resources_raw"] = perf_value
                out["network_event_count"] = len(network_events)
            return _json_dump(out)
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            proc.kill()
        user_data.cleanup()


if _enabled("system"):

    @mcp.tool()
    def ctf_tool_audit() -> str:
        """Return the CTF sandbox tool audit."""
        return _run("ctf-tool-audit", timeout=60, label="tool-audit")

    @mcp.tool()
    def run_limited(command: str, timeout: int = 120) -> str:
        """Run a shell command inside the CTF sandbox with output truncation."""
        return _run(command, timeout=timeout, label="run-limited")

    @mcp.tool()
    def run_cached(command: str, timeout: int = 120, refresh: bool = False, max_preview: int = 8000) -> str:
        """Run a shell command and persist/reuse exact-command output in /challenge/cache."""
        return _run_command_cached(command, timeout=timeout, refresh=refresh, max_preview=max_preview)

    @mcp.tool()
    def command_cache_stats(limit: int = 30) -> str:
        """Return command result cache hit/miss statistics."""
        with _command_cache_db() as conn:
            total = conn.execute(
                "SELECT COUNT(*), COALESCE(SUM(hit_count), 0), COALESCE(SUM(output_bytes), 0) FROM command_cache"
            ).fetchone()
            rows = conn.execute(
                """
                SELECT command, cwd, output_path, returncode, duration, output_bytes, hit_count, created_at, last_hit_at
                FROM command_cache
                ORDER BY hit_count DESC, last_hit_at DESC
                LIMIT ?
                """,
                (max(1, int(limit)),),
            ).fetchall()
        return _json_dump({
            "cached_command_count": int(total[0] or 0),
            "cache_hit_count": int(total[1] or 0),
            "cached_output_bytes": int(total[2] or 0),
            "top": [
                {
                    "command": command[:300],
                    "cwd": cwd,
                    "output_path": output_path,
                    "returncode": returncode,
                    "duration_seconds": duration,
                    "output_bytes": output_bytes,
                    "hit_count": hit_count,
                    "created_at": created_at,
                    "last_hit_at": last_hit_at,
                }
                for command, cwd, output_path, returncode, duration, output_bytes, hit_count, created_at, last_hit_at in rows
            ],
        })


if _enabled("triage"):

    @mcp.tool()
    def triage_path(path: str = "/challenge/distfiles", deep: bool = False, limit: int = 80) -> str:
        """Classify files and recommend the next MCP/tool route."""
        root = Path(path)
        if not root.exists():
            return f"[missing] {path}"
        candidates = [root] if root.is_file() else [p for p in sorted(root.rglob("*")) if p.is_file()]
        rows: list[dict] = []
        for item in candidates[: max(1, int(limit))]:
            try:
                stat = item.stat()
                ftype = _file_type(item)
                rec = {
                    "path": str(item),
                    "size": stat.st_size,
                    "sha256": _sha256_file(item) if stat.st_size <= 100 * 1024 * 1024 else "skipped-large-file",
                    "file": ftype,
                    "recommended_routes": _routing_for(item, ftype),
                }
                if deep:
                    q = _quote_path(str(item))
                    rec["quick_probe"] = _run(
                        f"file {q}; strings -a {q} | head -40; binwalk {q} 2>/dev/null | head -40",
                        timeout=120,
                        label="triage-probe",
                    )
                rows.append(rec)
            except Exception as exc:
                rows.append({"path": str(item), "error": str(exc)})
        out = {"root": str(root), "count": len(rows), "truncated": len(candidates) > len(rows), "items": rows}
        path_out = SHARED / "triage-index.json"
        path_out.write_text(_json_dump(out), encoding="utf-8")
        _record_artifact(path_out, kind="triage-index", source_tool="triage_path")
        return _json_dump(out) + f"\n\nsaved={path_out}"

    @mcp.tool()
    def auto_triage(path: str = "/challenge/distfiles", deep: bool = False, limit: int = 40, timeout: int = 900) -> str:
        """Run a broad first-pass CTF triage and save a compact Markdown report."""
        root = Path(path)
        if not root.exists():
            return f"[missing] {path}"
        files = _collect_files(root, limit=limit)
        started = time.time()
        sections: list[str] = [
            "# Auto Triage Report",
            "",
            f"- root: `{root}`",
            f"- files_considered: {len(files)}",
            f"- deep: {bool(deep)}",
            "",
        ]
        json_items: list[dict] = []
        per_file_timeout = max(20, min(180, int(timeout) // max(1, len(files))))
        for idx, item in enumerate(files, 1):
            try:
                stat = item.stat()
                ftype = _file_type(item)
                routes = _routing_for(item, ftype)
                sha = _sha256_file(item) if stat.st_size <= 100 * 1024 * 1024 else "skipped-large-file"
                q = _quote_path(str(item))
                quick_parts = [
                    f"file {q}",
                    f"strings -a {q} | head -80",
                    f"binwalk {q} 2>/dev/null | head -80",
                    f"7z l {q} 2>/dev/null | head -80",
                    f"exiftool {q} 2>/dev/null | head -80",
                ]
                lower = ftype.lower()
                if "elf" in lower or "pe32" in lower or item.suffix.lower() in {".elf", ".so", ".exe", ".dll"}:
                    quick_parts += [
                        f"checksec --file={q} 2>/dev/null || true",
                        f"rz-bin -I {q} 2>/dev/null | head -80",
                        f"rz-bin -s {q} 2>/dev/null | head -120",
                    ]
                if deep:
                    quick_parts += [
                        f"rg -a -n -i 'flag|key|pass|secret|token|admin|system|exec|open|read|write|verify|check|encrypt|decrypt' {q} 2>/dev/null | head -120",
                    ]
                probe = _run(" ; ".join(quick_parts), timeout=per_file_timeout, label="auto-triage-probe")
                item_rec = {
                    "path": str(item),
                    "size": stat.st_size,
                    "sha256": sha,
                    "file": ftype,
                    "recommended_routes": routes,
                }
                json_items.append(item_rec)
                _record_artifact(item, kind=ftype[:120], source_tool="auto_triage", preview=probe[:3000])
                sections += [
                    f"## {idx}. `{item}`",
                    "",
                    f"- size: {stat.st_size}",
                    f"- sha256: `{sha}`",
                    f"- file: `{ftype}`",
                    f"- recommended: {', '.join(routes)}",
                    "",
                    "```text",
                    probe[:6000],
                    "```",
                    "",
                ]
            except Exception as exc:
                sections += [f"## {idx}. `{item}`", "", f"[error] {type(exc).__name__}: {exc}", ""]
                json_items.append({"path": str(item), "error": repr(exc)})
        payload = {
            "root": str(root),
            "duration_seconds": round(time.time() - started, 3),
            "count": len(json_items),
            "items": json_items,
        }
        json_path = SHARED / "auto-triage.json"
        json_path.write_text(_json_dump(payload), encoding="utf-8")
        _record_artifact(json_path, kind="triage-json", source_tool="auto_triage")
        report = "\n".join(sections)
        report_path = _write_report("auto-triage", report, kind="triage-report", source_tool="auto_triage", command=f"auto_triage({path})")
        return report[:10000] + f"\n\nsaved_report={report_path}\nsaved_json={json_path}"


if _enabled("artifacts", "system"):

    @mcp.tool()
    def artifact_index(root: str = "/challenge/shared", include_cache: bool = False, limit: int = 500) -> str:
        """Index shared/cache artifacts with size, hashes, and small previews."""
        roots = [Path(root)]
        if include_cache:
            roots.append(CACHE)
        data = {"generated_at": int(time.time()), "roots": [_index_artifacts(r, limit=limit) for r in roots]}
        out_path = SHARED / "artifacts-index.json"
        out_path.write_text(_json_dump(data), encoding="utf-8")
        for group in data["roots"]:
            for artifact in group.get("artifacts", []):
                path = Path(str(artifact.get("path", "")))
                _record_artifact(
                    path,
                    kind=str(artifact.get("mime_guess") or ""),
                    source_tool="artifact_index",
                    preview=str(artifact.get("preview") or ""),
                )
        _record_artifact(out_path, kind="artifact-index", source_tool="artifact_index")
        return _json_dump(data) + f"\n\nsaved={out_path}"

    @mcp.tool()
    def artifact_read(path: str, max_bytes: int = 12000) -> str:
        """Read a bounded preview of an artifact file."""
        p = Path(path)
        if not p.exists() or not p.is_file():
            return f"[missing] {path}"
        return _read_text_preview(p, max_bytes=max(256, int(max_bytes)))

    @mcp.tool()
    def artifact_search(query: str = "", kind: str = "", limit: int = 50) -> str:
        """Search the persistent artifact SQLite index."""
        sql = "SELECT path, sha256, size, kind, source_tool, updated_at, preview FROM artifacts"
        clauses: list[str] = []
        params: list[object] = []
        if query:
            clauses.append("(path LIKE ? OR preview LIKE ? OR command LIKE ? OR sha256 LIKE ?)")
            like = f"%{query}%"
            params.extend([like, like, like, like])
        if kind:
            clauses.append("kind LIKE ?")
            params.append(f"%{kind}%")
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY updated_at DESC LIMIT ?"
        params.append(max(1, int(limit)))
        with _artifact_db() as conn:
            rows = [
                {
                    "path": path,
                    "sha256": sha256,
                    "size": size,
                    "kind": row_kind,
                    "source_tool": source_tool,
                    "updated_at": updated_at,
                    "preview": (preview or "")[:500],
                }
                for path, sha256, size, row_kind, source_tool, updated_at, preview in conn.execute(sql, params)
            ]
        return _json_dump({"count": len(rows), "items": rows})

    @mcp.tool()
    def artifact_stats() -> str:
        """Return persistent artifact cache statistics."""
        with _artifact_db() as conn:
            total = conn.execute("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM artifacts").fetchone()
            by_kind = conn.execute(
                "SELECT COALESCE(kind, ''), COUNT(*), COALESCE(SUM(size), 0) FROM artifacts GROUP BY kind ORDER BY COUNT(*) DESC LIMIT 30"
            ).fetchall()
            by_tool = conn.execute(
                "SELECT COALESCE(source_tool, ''), COUNT(*) FROM artifacts GROUP BY source_tool ORDER BY COUNT(*) DESC LIMIT 30"
            ).fetchall()
        return _json_dump({
            "artifact_count": int(total[0] or 0),
            "total_bytes": int(total[1] or 0),
            "by_kind": [{"kind": k, "count": c, "bytes": b} for k, c, b in by_kind],
            "by_tool": [{"source_tool": t, "count": c} for t, c in by_tool],
        })


if _enabled("browser", "chrome", "web"):

    @mcp.tool()
    def chrome_dom(url: str, wait_ms: int = 1000, timeout: int = 45) -> str:
        """Render a URL with headless Chrome and return the final DOM."""
        chrome = _chrome_bin()
        if not chrome:
            return "[missing] chromium-browser/chromium/google-chrome not found"
        cmd = (
            f"{_quote_path(chrome)} --headless=new --no-sandbox --disable-gpu "
            f"--disable-dev-shm-usage --virtual-time-budget={int(wait_ms)} "
            f"--dump-dom {_quote_path(url)}"
        )
        return _run(cmd, timeout=timeout, label="chrome-dom")

    @mcp.tool()
    def chrome_screenshot(url: str, width: int = 1365, height: int = 900, wait_ms: int = 1000, timeout: int = 60) -> str:
        """Render a URL with headless Chrome and save a screenshot under /challenge/shared."""
        chrome = _chrome_bin()
        if not chrome:
            return "[missing] chromium-browser/chromium/google-chrome not found"
        path = _safe_name("chrome-screenshot", ".png")
        cmd = (
            f"{_quote_path(chrome)} --headless=new --no-sandbox --disable-gpu "
            f"--disable-dev-shm-usage --virtual-time-budget={int(wait_ms)} "
            f"--window-size={int(width)},{int(height)} --screenshot={_quote_path(str(path))} "
            f"{_quote_path(url)}"
        )
        output = _run(cmd, timeout=timeout, label="chrome-screenshot")
        return f"screenshot={path}\n{output}"

    @mcp.tool()
    def chrome_pdf(url: str, wait_ms: int = 1000, timeout: int = 60) -> str:
        """Render a URL with headless Chrome and save a PDF under /challenge/shared."""
        chrome = _chrome_bin()
        if not chrome:
            return "[missing] chromium-browser/chromium/google-chrome not found"
        path = _safe_name("chrome-page", ".pdf")
        cmd = (
            f"{_quote_path(chrome)} --headless=new --no-sandbox --disable-gpu "
            f"--disable-dev-shm-usage --virtual-time-budget={int(wait_ms)} "
            f"--print-to-pdf={_quote_path(str(path))} {_quote_path(url)}"
        )
        output = _run(cmd, timeout=timeout, label="chrome-pdf")
        return f"pdf={path}\n{output}"

    @mcp.tool()
    async def chrome_eval_js(url: str, javascript: str, wait_ms: int = 1000, timeout: int = 45) -> str:
        """Render a URL with Chrome DevTools Protocol and evaluate JavaScript."""
        return await _chrome_eval_cdp(url, javascript, wait_ms, timeout)

    @mcp.tool()
    async def chrome_extract_links(url: str, wait_ms: int = 1000, timeout: int = 45) -> str:
        """Render a URL and extract links, forms, scripts, and visible title text."""
        js = r"""
JSON.stringify({
  title: document.title,
  location: location.href,
  links: Array.from(document.querySelectorAll('a[href]')).slice(0, 500).map(a => ({text: a.innerText.trim().slice(0,120), href: a.href})),
  forms: Array.from(document.forms).slice(0, 100).map(f => ({action: f.action, method: f.method, inputs: Array.from(f.elements).map(e => ({name: e.name, type: e.type, value: e.value ? '<set>' : ''}))})),
  scripts: Array.from(document.scripts).slice(0, 200).map(s => s.src || '<inline>'),
  textPreview: document.body ? document.body.innerText.slice(0, 2000) : ''
})
"""
        raw = await _chrome_eval_cdp(url, js, wait_ms, timeout)
        try:
            data = json.loads(raw)
            value = data.get("value")
            if isinstance(value, str):
                return json.dumps(json.loads(value), ensure_ascii=False, indent=2)
        except Exception:
            pass
        return raw

    @mcp.tool()
    async def chrome_resource_log(url: str, wait_ms: int = 2000, timeout: int = 60) -> str:
        """Render a URL and return a lightweight resource/performance log."""
        raw = await _chrome_eval_cdp(url, "document.readyState", wait_ms, timeout, resources=True)
        out_path = _safe_name("chrome-resource-log", ".json")
        out_path.write_text(raw, encoding="utf-8")
        return raw + f"\n\nsaved={out_path}"


if _enabled("ghidra"):

    def _ghidra(path: str, mode: str, query: str = "", timeout: int = 900) -> str:
        binary = Path(path)
        if not binary.exists():
            return f"[missing] {path}"
        if not _which("ghidra-headless"):
            return "[missing] ghidra-headless not found"
        project_dir = CACHE / "ghidra-projects"
        project_dir.mkdir(parents=True, exist_ok=True)
        try:
            digest = _sha256_file(binary)[:16]
        except Exception:
            digest = hashlib.sha1(str(binary.resolve()).encode()).hexdigest()[:16]
        project = f"mcp-{binary.name[:32].replace('/', '_')}-{digest}"
        marker = project_dir / f"{project}.imported"
        was_cached = marker.exists()
        if was_cached:
            cmd = [
                "ghidra-headless",
                str(project_dir),
                project,
                "-process",
                binary.name,
                "-noanalysis",
                "-scriptPath",
                str(GHIDRA_SCRIPT.parent),
                "-postScript",
                GHIDRA_SCRIPT.name,
                mode,
            ]
        else:
            cmd = [
            "ghidra-headless",
            str(project_dir),
            project,
            "-import",
            str(binary),
            "-overwrite",
            "-analysisTimeoutPerFile",
            str(max(30, min(timeout, 600))),
            "-scriptPath",
            str(GHIDRA_SCRIPT.parent),
            "-postScript",
            GHIDRA_SCRIPT.name,
            mode,
            ]
        if query:
            cmd.append(query)
        output = _run(cmd, timeout=timeout, label=f"ghidra-{mode}", shell=False)
        script_lines: list[str] = []
        for line in output.splitlines():
            if "CtfMcpGhidra.java>" not in line:
                continue
            text = line.split("CtfMcpGhidra.java>", 1)[1]
            text = text.split(" (GhidraScript)", 1)[0].strip()
            if text:
                script_lines.append(text)
        if script_lines:
            if not marker.exists() and "[exit " not in output:
                marker.write_text(f"{binary}\n{time.time()}\n", encoding="utf-8")
            tail = "\n".join(output.splitlines()[-20:])
            cache_state = "hit" if was_cached else "miss"
            return "\n".join(script_lines) + f"\n\ncache={cache_state} project={project_dir / project}\n--- ghidra log tail ---\n" + tail
        return output

    @mcp.tool()
    def ghidra_summary(path: str, timeout: int = 600) -> str:
        """Import a binary into Ghidra headless and return program summary."""
        return _ghidra(path, "summary", timeout=timeout)

    @mcp.tool()
    def ghidra_functions(path: str, limit: int = 200, timeout: int = 900) -> str:
        """Import a binary into Ghidra and list discovered functions."""
        return _ghidra(path, "functions", str(limit), timeout=timeout)

    @mcp.tool()
    def ghidra_decompile(path: str, function_or_address: str, timeout: int = 900) -> str:
        """Import a binary into Ghidra and decompile a function by name or address."""
        return _ghidra(path, "decompile", function_or_address, timeout=timeout)


if _enabled("rev"):

    @mcp.tool()
    def binary_overview(path: str) -> str:
        """Run file, checksec, ldd, and quick symbol/string probes for a binary."""
        q = _quote_path(path)
        cmd = f"file {q}; checksec --file={q} || true; ldd {q} 2>/dev/null || true; strings -a {q} | head -200"
        return _run(cmd, timeout=120, label="binary-overview")

    @mcp.tool()
    def strings_grep(path: str, pattern: str = "", limit: int = 200) -> str:
        """Search printable strings from a file, optionally filtering by regex."""
        q = _quote_path(path)
        if pattern:
            cmd = f"strings -a {q} | rg -n -i -- {shlex.quote(pattern)} | head -{int(limit)}"
        else:
            cmd = f"strings -a {q} | head -{int(limit)}"
        return _run(cmd, timeout=120, label="strings")

    @mcp.tool()
    def rizin_info(path: str) -> str:
        """Run rizin/rz-bin static metadata commands for a binary."""
        q = _quote_path(path)
        cmd = f"(rz-bin -I {q}; rz-bin -S {q}; rz-bin -s {q} | head -200) 2>&1"
        return _run(cmd, timeout=180, label="rizin-info")

    @mcp.tool()
    def rev_triage(path: str, include_ghidra: bool = False, timeout: int = 900) -> str:
        """Run a reverse-engineering one-shot triage and save a report."""
        p = Path(path)
        if not p.exists():
            return f"[missing] {path}"
        q = _quote_path(str(p))
        commands = [
            f"file {q}",
            f"sha256sum {q}",
            f"rz-bin -I {q} 2>/dev/null || true",
            f"rz-bin -S {q} 2>/dev/null | head -160 || true",
            f"rz-bin -i {q} 2>/dev/null | head -220 || true",
            f"rz-bin -s {q} 2>/dev/null | head -220 || true",
            f"strings -a {q} | rg -n -i 'flag|key|pass|secret|token|admin|debug|verify|check|encrypt|decrypt|system|exec|shell|/bin/sh|http|socket' | head -220 || true",
            f"strings -a {q} | head -220",
        ]
        output = _run(" ; ".join(commands), timeout=timeout, label="rev-triage")
        if include_ghidra:
            output += "\n\n[hint] Run ctf_ghidra.ghidra_summary on this path for cached Ghidra analysis."
        report = f"# Reverse Triage\n\n- path: `{p}`\n\n```text\n{output}\n```\n"
        report_path = _write_report("rev-triage", report, kind="rev-report", source_tool="rev_triage", command=f"rev_triage({path})")
        return report[:12000] + f"\n\nsaved_report={report_path}"


if _enabled("pwn"):

    @mcp.tool()
    def gdb_checksec(path: str) -> str:
        """Run pwn-oriented binary metadata: file, checksec, RELRO/NX/PIE, and dynamic libs."""
        q = _quote_path(path)
        cmd = f"file {q}; checksec --file={q} || true; ldd {q} 2>/dev/null || true; readelf -h {q} 2>/dev/null | sed -n '1,80p'"
        return _run(cmd, timeout=120, label="gdb-checksec")

    @mcp.tool()
    def gdb_backtrace(path: str, args: str = "", stdin: str = "", timeout: int = 120) -> str:
        """Run a binary under gdb batch mode and return crash/backtrace context."""
        input_file = ""
        run_redirect = ""
        if stdin:
            p = _safe_name("gdb-stdin", ".txt")
            p.write_text(stdin, encoding="utf-8", errors="replace")
            input_file = str(p)
            run_redirect = f" < {input_file}"
        cmd = (
            "gdb -q -batch "
            "-ex 'set pagination off' "
            f"-ex 'run{run_redirect}' "
            "-ex 'bt' -ex 'info registers' -ex 'x/16gx $rsp' "
            f"--args {_quote_path(path)} {args}"
        )
        output = _run(cmd, timeout=timeout, label="gdb-backtrace")
        if input_file:
            output += f"\nstdin_file={input_file}"
        return output

    @mcp.tool()
    def gdb_disassemble(path: str, symbol: str = "main", timeout: int = 120) -> str:
        """Disassemble a symbol/function in gdb batch mode."""
        cmd = f"gdb -q -batch -ex 'set pagination off' -ex 'file {_quote_path(path)}' -ex 'disassemble {symbol}'"
        return _run(cmd, timeout=timeout, label="gdb-disassemble")

    @mcp.tool()
    def cyclic_pattern(length: int = 512) -> str:
        """Generate a pwntools cyclic pattern."""
        code = f"from pwn import *; print(cyclic({int(length)}).decode('latin-1'))"
        return _run(["python3", "-c", code], timeout=30, label="cyclic", shell=False)

    @mcp.tool()
    def pwn_triage(path: str, timeout: int = 600) -> str:
        """Run a pwn one-shot triage and save a compact report."""
        p = Path(path)
        if not p.exists():
            return f"[missing] {path}"
        q = _quote_path(str(p))
        commands = [
            f"file {q}",
            f"sha256sum {q}",
            f"checksec --file={q} || true",
            f"readelf -h {q} 2>/dev/null | sed -n '1,90p' || true",
            f"readelf -l {q} 2>/dev/null | rg -n 'GNU_STACK|GNU_RELRO|INTERP|LOAD' || true",
            f"ldd {q} 2>/dev/null || true",
            f"seccomp-tools dump {q} 2>/dev/null | head -180 || true",
            f"ROPgadget --binary {q} --only 'pop|ret|syscall|int' 2>/dev/null | head -180 || true",
            f"strings -a {q} | rg -n -i '/bin/sh|system|execve|flag|open|read|write|puts|printf|scanf|gets|strcpy|malloc|free' | head -220 || true",
        ]
        output = _run(" ; ".join(commands), timeout=timeout, label="pwn-triage")
        report = f"# Pwn Triage\n\n- path: `{p}`\n\n```text\n{output}\n```\n"
        report_path = _write_report("pwn-triage", report, kind="pwn-report", source_tool="pwn_triage", command=f"pwn_triage({path})")
        return report[:12000] + f"\n\nsaved_report={report_path}"


if _enabled("crypto"):

    @mcp.tool()
    def hash_identify(value: str) -> str:
        """Identify common hash/token formats by length and character set."""
        v = value.strip()
        patterns = [
            ("md5", r"[a-fA-F0-9]{32}"),
            ("sha1", r"[a-fA-F0-9]{40}"),
            ("sha256", r"[a-fA-F0-9]{64}"),
            ("sha512", r"[a-fA-F0-9]{128}"),
            ("bcrypt", r"\$2[aby]\$.{56}"),
            ("jwt", r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"),
            ("base64-ish", r"[A-Za-z0-9+/=_-]{16,}"),
        ]
        checks = [name for name, pat in patterns if re.fullmatch(pat, v)]
        return _json_dump({"value_length": len(v), "candidates": checks or ["unknown"]})

    @mcp.tool()
    def z3_solve_python(script: str, timeout: int = 120) -> str:
        """Run a bounded Python/Z3 solving script."""
        path = _safe_name("z3-solve", ".py")
        path.write_text(script, encoding="utf-8")
        return _run(["python3", str(path)], timeout=timeout, label="z3-solve", shell=False) + f"\nscript={path}"

    @mcp.tool()
    def number_theory_eval(expression: str, timeout: int = 60) -> str:
        """Evaluate a Python number-theory expression with math, Crypto.Util.number, and sympy if present."""
        code = (
            "import math\n"
            "try:\n from Crypto.Util.number import *\nexcept Exception: pass\n"
            "try:\n import sympy as sp\nexcept Exception: sp=None\n"
            f"print({expression})\n"
        )
        path = _safe_name("number-theory", ".py")
        path.write_text(code, encoding="utf-8")
        return _run(["python3", str(path)], timeout=timeout, label="number-theory", shell=False) + f"\nscript={path}"

    @mcp.tool()
    def sage_eval(expression: str, timeout: int = 120) -> str:
        """Evaluate a SageMath expression for crypto/number theory work."""
        if not _which("sage"):
            return "[missing] sage not found"
        path = _safe_name("sage-eval", ".sage")
        path.write_text(f"print({expression})\n", encoding="utf-8")
        _record_artifact(path, kind="sage-script", source_tool="sage_eval", command=expression)
        return _run(["sage", str(path)], timeout=timeout, label="sage-eval", shell=False) + f"\nscript={path}"

    @mcp.tool()
    def sage_script(script: str, timeout: int = 300) -> str:
        """Run a bounded SageMath script saved under /challenge/shared."""
        if not _which("sage"):
            return "[missing] sage not found"
        path = _safe_name("sage-script", ".sage")
        path.write_text(script, encoding="utf-8")
        _record_artifact(path, kind="sage-script", source_tool="sage_script", preview=script[:3000])
        return _run(["sage", str(path)], timeout=timeout, label="sage-script", shell=False) + f"\nscript={path}"


if _enabled("web"):

    @mcp.tool()
    def http_probe(url: str, timeout: int = 30) -> str:
        """Fetch HTTP headers and a short body preview."""
        cmd = f"curl -k -i -L --max-time {int(timeout)} {_quote_path(url)} | head -220"
        return _run(cmd, timeout=timeout + 5, label="http-probe")

    @mcp.tool()
    def nmap_scan(target: str, ports: str = "1-1000", extra_args: str = "-sV --version-light", timeout: int = 300) -> str:
        """Run a bounded nmap scan."""
        cmd = f"nmap {extra_args} -p {shlex.quote(ports)} {shlex.quote(target)}"
        return _run(cmd, timeout=timeout, label="nmap")

    @mcp.tool()
    def ffuf_dir(url: str, wordlist: str = "/opt/SecLists/Discovery/Web-Content/common.txt", timeout: int = 300) -> str:
        """Run a small ffuf directory brute force."""
        cmd = f"ffuf -u {_quote_path(url.rstrip('/') + '/FUZZ')} -w {_quote_path(wordlist)} -of json -t 40"
        return _run(cmd, timeout=timeout, label="ffuf")

    @mcp.tool()
    def web_recon(target: str, ports: str = "80,443,8080,8000,5000,3000", wordlist: str = "/opt/SecLists/Discovery/Web-Content/common.txt", run_nuclei: bool = False, timeout: int = 900) -> str:
        """Run a bounded web recon pipeline and save a report."""
        t = target.strip()
        if not t:
            return "[missing] target"
        is_url = t.startswith(("http://", "https://"))
        host = urllib.parse.urlparse(t).hostname if is_url else t.split("/")[0]
        if not host:
            return "[missing] host"
        commands = [
            f"printf '%s\\n' {shlex.quote(host)} | /root/go/bin/httpx -silent -status-code -title -tech-detect -follow-redirects -ports {shlex.quote(ports)} 2>/dev/null | tee /challenge/shared/web-httpx.txt || true",
            f"nmap -sV --version-light -p {shlex.quote(ports)} {shlex.quote(host)} 2>/dev/null | tee /challenge/shared/web-nmap.txt || true",
        ]
        if is_url:
            commands += [
                f"curl -k -i -L --max-time 20 {shlex.quote(t)} | head -220 | tee /challenge/shared/web-curl.txt || true",
                f"/root/go/bin/katana -u {shlex.quote(t)} -silent -depth 2 -jc -kf all -timeout 20 2>/dev/null | head -500 | tee /challenge/shared/web-katana.txt || true",
            ]
            if Path(wordlist).exists():
                commands.append(
                    f"/root/go/bin/ffuf -u {shlex.quote(t.rstrip('/') + '/FUZZ')} -w {shlex.quote(wordlist)} -t 40 -ac -of json -o /challenge/shared/web-ffuf.json 2>/dev/null || true"
                )
            if run_nuclei:
                commands.append(
                    f"/root/go/bin/nuclei -u {shlex.quote(t)} -silent -rl 10 -timeout 5 -o /challenge/shared/web-nuclei.txt 2>/dev/null || true"
                )
        output = _run(" ; ".join(commands), timeout=timeout, label="web-recon")
        for artifact in Path("/challenge/shared").glob("web-*"):
            if artifact.is_file():
                _record_artifact(artifact, kind="web-recon-artifact", source_tool="web_recon")
        report = f"# Web Recon\n\n- target: `{t}`\n- host: `{host}`\n\n```text\n{output}\n```\n"
        report_path = _write_report("web-recon", report, kind="web-report", source_tool="web_recon", command=f"web_recon({target})")
        return report[:12000] + f"\n\nsaved_report={report_path}"


if _enabled("mobile"):

    @mcp.tool()
    def apk_overview(path: str) -> str:
        """Return quick APK metadata and archive listing."""
        q = _quote_path(path)
        cmd = f"file {q}; unzip -l {q} | head -220; apktool d -f -o /tmp/mcp-apktool-preview {q} >/tmp/mcp-apktool.log 2>&1 || true; sed -n '1,120p' /tmp/mcp-apktool.log"
        return _run(cmd, timeout=180, label="apk-overview")

    @mcp.tool()
    def jadx_decompile(path: str, output_dir: str = "") -> str:
        """Decompile an APK/JAR/DEX with jadx into /challenge/shared unless output_dir is provided."""
        out = Path(output_dir) if output_dir else _safe_name("jadx", "")
        out.mkdir(parents=True, exist_ok=True)
        cmd = f"jadx -d {_quote_path(str(out))} {_quote_path(path)}"
        output = _run(cmd, timeout=900, label="jadx")
        return f"output_dir={out}\n{output}"

    @mcp.tool()
    def apk_triage(path: str, decompile: bool = False, timeout: int = 600) -> str:
        """Run APK/JAR/DEX triage and optionally decompile with jadx."""
        p = Path(path)
        if not p.exists():
            return f"[missing] {path}"
        q = _quote_path(str(p))
        commands = [
            f"file {q}",
            f"sha256sum {q}",
            f"unzip -l {q} 2>/dev/null | head -260 || true",
            f"apktool d -f -o /challenge/shared/apktool-preview {q} >/challenge/shared/apktool.log 2>&1 || true; sed -n '1,160p' /challenge/shared/apktool.log 2>/dev/null || true",
            f"find /challenge/shared/apktool-preview -maxdepth 4 -type f 2>/dev/null | head -220 || true",
            f"rg -n -i 'flag|ctf|secret|token|key|password|admin|debug|http|api|native|System.loadLibrary' /challenge/shared/apktool-preview 2>/dev/null | head -260 || true",
        ]
        if decompile:
            commands.append(f"jadx -d /challenge/shared/jadx-out {q} >/challenge/shared/jadx.log 2>&1 || true; sed -n '1,120p' /challenge/shared/jadx.log 2>/dev/null || true")
        output = _run(" ; ".join(commands), timeout=timeout, label="apk-triage")
        for artifact in [Path("/challenge/shared/apktool.log"), Path("/challenge/shared/jadx.log")]:
            if artifact.exists():
                _record_artifact(artifact, kind="mobile-artifact", source_tool="apk_triage")
        report = f"# APK Triage\n\n- path: `{p}`\n- decompile: {bool(decompile)}\n\n```text\n{output}\n```\n"
        report_path = _write_report("apk-triage", report, kind="mobile-report", source_tool="apk_triage", command=f"apk_triage({path})")
        return report[:12000] + f"\n\nsaved_report={report_path}"


if _enabled("forensics"):

    @mcp.tool()
    def forensics_overview(path: str) -> str:
        """Run common file, exif, binwalk, and archive probes."""
        q = _quote_path(path)
        cmd = f"file {q}; exiftool {q} 2>/dev/null | head -120; binwalk {q} 2>/dev/null | head -120; 7z l {q} 2>/dev/null | head -120"
        return _run(cmd, timeout=180, label="forensics")

    @mcp.tool()
    def pcap_overview(path: str, timeout: int = 300) -> str:
        """Run a packet-capture first pass and save a compact report."""
        p = Path(path)
        if not p.exists():
            return f"[missing] {path}"
        q = _quote_path(str(p))
        commands = [
            f"file {q}",
            f"capinfos {q} 2>/dev/null || true",
            f"tshark -r {q} -q -z io,phs 2>/dev/null | head -220 || true",
            f"tshark -r {q} -q -z conv,tcp 2>/dev/null | head -160 || true",
            f"tshark -r {q} -q -z conv,udp 2>/dev/null | head -160 || true",
            f"tshark -r {q} -Y 'dns.qry.name' -T fields -e frame.number -e ip.src -e dns.qry.name 2>/dev/null | head -220 || true",
            f"tshark -r {q} -Y 'http.request' -T fields -e frame.number -e ip.src -e http.host -e http.request.method -e http.request.uri 2>/dev/null | head -220 || true",
            f"strings -a {q} | rg -n -i 'flag|ctf|key|pass|secret|token|http|host|user|login|admin' | head -220 || true",
        ]
        output = _run(" ; ".join(commands), timeout=timeout, label="pcap-overview")
        report = f"# PCAP Overview\n\n- path: `{p}`\n\n```text\n{output}\n```\n"
        report_path = _write_report("pcap-overview", report, kind="pcap-report", source_tool="pcap_overview", command=f"pcap_overview({path})")
        return report[:12000] + f"\n\nsaved_report={report_path}"

    @mcp.tool()
    def stego_overview(path: str, timeout: int = 300) -> str:
        """Run image/media stego probes and save a compact report."""
        p = Path(path)
        if not p.exists():
            return f"[missing] {path}"
        q = _quote_path(str(p))
        commands = [
            f"file {q}",
            f"exiftool {q} 2>/dev/null | head -180 || true",
            f"pngcheck -vt {q} 2>/dev/null | head -160 || true",
            f"zbarimg -q {q} 2>/dev/null | head -80 || true",
            f"binwalk {q} 2>/dev/null | head -160 || true",
            f"7z l {q} 2>/dev/null | head -120 || true",
            f"strings -a {q} | rg -n -i 'flag|ctf|key|pass|secret|token|BEGIN|PK\\x03\\x04|JFIF|PNG|IDAT|IEND' | head -220 || true",
        ]
        output = _run(" ; ".join(commands), timeout=timeout, label="stego-overview")
        report = f"# Stego Overview\n\n- path: `{p}`\n\n```text\n{output}\n```\n"
        report_path = _write_report("stego-overview", report, kind="stego-report", source_tool="stego_overview", command=f"stego_overview({path})")
        return report[:12000] + f"\n\nsaved_report={report_path}"

    @mcp.tool()
    def forensics_triage(path: str, timeout: int = 600) -> str:
        """Run a broad forensics one-shot triage and save a report."""
        p = Path(path)
        if not p.exists():
            return f"[missing] {path}"
        q = _quote_path(str(p))
        commands = [
            f"file {q}",
            f"sha256sum {q}",
            f"exiftool {q} 2>/dev/null | head -180 || true",
            f"binwalk {q} 2>/dev/null | head -180 || true",
            f"7z l {q} 2>/dev/null | head -180 || true",
            f"foremost -T -i {q} -o /challenge/shared/foremost-out >/challenge/shared/foremost.log 2>&1 || true; sed -n '1,120p' /challenge/shared/foremost.log 2>/dev/null || true",
            f"tshark -r {q} -q -z io,phs 2>/dev/null | head -180 || true",
            f"strings -a {q} | rg -n -i 'flag|ctf|key|pass|secret|token|admin|login|http|host|BEGIN|PK\\x03\\x04' | head -240 || true",
        ]
        output = _run(" ; ".join(commands), timeout=timeout, label="forensics-triage")
        for artifact in Path("/challenge/shared").glob("foremost*"):
            if artifact.is_file():
                _record_artifact(artifact, kind="forensics-artifact", source_tool="forensics_triage")
        report = f"# Forensics Triage\n\n- path: `{p}`\n\n```text\n{output}\n```\n"
        report_path = _write_report("forensics-triage", report, kind="forensics-report", source_tool="forensics_triage", command=f"forensics_triage({path})")
        return report[:12000] + f"\n\nsaved_report={report_path}"

    @mcp.tool()
    def binwalk_extract(path: str) -> str:
        """Extract firmware/archive content with binwalk into /challenge/shared."""
        out = _safe_name("binwalk", "")
        out.mkdir(parents=True, exist_ok=True)
        cmd = f"cd {_quote_path(str(out))} && binwalk -eM --run-as=root {_quote_path(path)}"
        output = _run(cmd, timeout=900, label="binwalk-extract")
        return f"output_dir={out}\n{output}"


if _enabled("frida"):

    @mcp.tool()
    def frida_processes(target: str = "-U") -> str:
        """List Frida-visible processes. Default target is USB device."""
        return _run(f"frida-ps {target}", timeout=30, label="frida-ps")


if __name__ == "__main__":
    mcp.run()
