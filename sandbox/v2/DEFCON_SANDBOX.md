# DEF CON Sandbox Strategy

This project should treat the sandbox as a competition workstation, not as a
minimal runtime container.

## What Docker Can And Cannot Do

- Linux tools and Linux binaries: run natively in the container.
- Other CPU architectures: run through `qemu-user-static` or full `qemu-system-*`.
- Windows userland binaries: run best-effort through Wine, or through a separate
  Windows VM if GUI/kernel behavior matters.
- macOS/iOS binaries: static analysis only inside Docker with Ghidra/LIEF/LLVM.
  Running macOS is not a Docker problem and should be handled outside this agent.
- Android: APK/static analysis and ADB tooling are in the sandbox; emulators are
  better handled by a host/VM service exposed to the sandbox.

The practical goal is not "every OS inside one Docker container." The goal is:

- one fast privileged Linux toolbox for normal CTF work;
- QEMU for Linux kernels, initramfs, firmware, and foreign CPU architectures;
- Wine/MinGW for Windows userland triage and exploit prototyping;
- host or VM bridges for Windows kernel, macOS, iOS, and Android emulator work;
- a visible audit command so missing tools are caught before a live round.

## Image Layers

Current `Dockerfile.sandbox` is a large all-in-one image with:

- pwn/rev: `gdb`, `gdb-multiarch`, `pwndbg`, `gef`, `checksec`, `patchelf`,
  `ROPgadget`, `ropper`, `one_gadget`, `seccomp-tools`, `angr`, `unicorn`,
  `capstone`, `keystone`, `lief`, `zig`, `rizin`, `ghidra-headless`.
- multi-arch: `qemu-user-static`, `qemu-system-*`, i386 multilib, MinGW, and
  best-effort Linux cross GCC packages. Some Linux cross GCC packages conflict
  with `gcc-multilib` on Ubuntu, so this all-in-one image preserves i386 pwn
  support and skips conflicting cross compilers instead of removing core tools.
- web: `nmap`, `masscan`, `ffuf`, `gobuster`, `nuclei`, `katana`, `httpx`,
  `sqlmap`, `SecLists`, browser tooling.
- forensics: `binwalk`, `sleuthkit`, `testdisk`, `exiftool`, `pngcheck`,
  `zbar-tools`, `yara`, `volatility3`.
- mobile: `apktool`, `jadx`, `dex2jar`, `adb`, `fastboot` where packages are
  available.
- Windows: `wine`, `wine64`, MinGW cross compilers, `osslsigncode` where
  package constraints allow them.

Optional apt installs use `--no-remove` so adding a best-effort tool cannot
silently remove core pwn packages.

Run `ctf-tool-audit` inside a sandbox to see what actually installed.

## MCP Layer

The sandbox also ships a local CTF MCP layer:

- `ctf_browser`: headless Chrome DOM, screenshot, PDF, JS evaluation, link/form
  extraction, and resource logs.
- `ctf_triage`: file classification plus `auto_triage` first-pass reports with
  recommended next MCP/tool routes.
- `ctf_artifacts`: `/challenge/shared` and `/challenge/cache` artifact indexing.
  Artifact metadata is also persisted to SQLite for search/stats.
- `ctf_ghidra`: Ghidra headless summary, function listing, and decompile helpers
  with cached projects under `/challenge/cache/ghidra-projects`.
- `ctf_rev`: binary overview, strings search, rizin metadata, and `rev_triage`.
- `ctf_pwn`: GDB/checksec/backtrace/disassembly, cyclic patterns, and
  `pwn_triage`.
- `ctf_crypto`: hash identification, Python/Z3, direct SageMath expression/script
  helpers, and number-theory helpers.
- `ctf_web`: curl, nmap, ffuf, and `web_recon` wrappers.
- `ctf_mobile`: APK overview, `apk_triage`, and jadx decompile wrappers.
- `ctf_forensics`: file/exif/binwalk/archive probes, `pcap_overview`,
  `stego_overview`, `forensics_triage`, and binwalk extraction.
- `ctf_frida`: Frida process listing.
- `ctf_system`: sandbox audit, bounded command execution, and exact-command
  output caching with hit statistics.

`ctf-mcp-configure` writes Codex MCP config to `$CODEX_HOME/config.toml` and
Claude MCP config to `/challenge/workspace/.mcp.json` at sandbox startup:

- Codex: appends `[mcp_servers.ctf_*]` entries to `$CODEX_HOME/config.toml`.
- Claude: writes `/challenge/workspace/.mcp.json` and a copy under
  `$CLAUDE_HOME`.

Heavy tools are lazy: Chrome, Ghidra, GDB, Sage, and scanners start only when
their MCP tools are called. Run `ctf-mcp-doctor` inside the sandbox to
smoke-test the MCP layer.

## Token And Cache Policy

The agent is tuned for provider prompt caching and lower context churn:

- `/challenge/cache` is bind-mounted to each target's `.cache`, so Ghidra
  projects, MCP artifact indexes, and session summaries survive sandbox restarts.
- Before the solver starts, the backend runs a deterministic preflight scan and
  writes `/challenge/cache/initial-triage.md` plus `/challenge/cache/facts.md`.
  The scan safely extracts common archives into `/challenge/cache/extracted`,
  follows nested archives within bounded file/byte/depth limits, and emits
  balanced route signals for pwn/rev, kernel/firmware, source/web, crypto,
  forensics/stego, mobile, blockchain, secrets/OSINT, and misc. These files are
  reused in later prompts so the model does not rediscover basic file facts.
- Artifact metadata is stored in `/challenge/cache/artifact-index.sqlite3`; use
  `ctf_artifacts.artifact_search` and `ctf_artifacts.artifact_stats` before
  rerunning expensive analysis.
- Exact command output can be cached in `/challenge/cache/command-cache.sqlite3`
  via `ctf_system.run_cached`; inspect hit counts with
  `ctf_system.command_cache_stats`.
- Static solver instructions stay at the beginning of prompts, while operator
  guidance and recent output stay at the end. This preserves provider prefix
  cache hits.
- Follow-up prompts include only a bounded tail of the previous solver output.
  Large logs should live in `/challenge/shared` and be referenced by path.
- Codex follow-up turns use `codex exec resume --last` when possible and set a
  model auto-compaction token limit to avoid context runaway.
- Trace logging deduplicates repeated stream/usage events before advisor calls,
  reducing advisor prompt size and UI noise.

Relevant `.env` knobs:

```bash
SOLVER_FOLLOWUP_OUTPUT_CHARS=2500
SOLVER_CACHE_CONTEXT_CHARS=3500
SOLVER_CODEX_RESUME=true
SOLVER_CODEX_AUTO_COMPACT_TOKENS=140000
PREFLIGHT_EXTRACT_ENABLED=true
PREFLIGHT_EXTRACT_MAX_DEPTH=2
PREFLIGHT_EXTRACT_MAX_ARCHIVES=40
```

## Build

```bash
./sandbox/build-sandbox.sh ctf-sandbox
```

The build intentionally keeps some tools best-effort. Missing optional packages
should not prevent the core sandbox from building.

## Runtime Permissions

For CTF kernel/pwn work, `.env` should use:

```bash
SANDBOX_USER=root
SANDBOX_PRIVILEGED=true
SANDBOX_NETWORK_MODE=bridge
```

Existing containers keep their old Docker config. Restart the target to get a
new privileged root sandbox.

## Next Architecture Step

The all-in-one image is convenient but slow to build and heavy to pull. The
next serious upgrade is sandbox profiles:

- `ctf-sandbox:base`
- `ctf-sandbox:pwn`
- `ctf-sandbox:rev`
- `ctf-sandbox:web`
- `ctf-sandbox:mobile`
- `ctf-sandbox:forensics`

Then target metadata can choose an image profile per challenge. That gives
faster startup and fewer tool conflicts while keeping the all-in-one image as
the fallback.

## External OS Bridges

For DEF CON-level coverage, add bridge endpoints rather than trying to nest
everything inside Docker:

- `windows-vm`: WinDbg, x64dbg, Visual Studio Build Tools, Windows kernel tests.
- `android-vm`: emulator, Frida server, objection, rooted images.
- `macos-host`: Mach-O execution, codesign, LLDB, iOS static tooling.
- `firmware-lab`: QEMU system images, OpenWrt, router firmware, UART/JTAG notes.

The agent can access those via SSH, HTTP RPC, or mounted shared directories.
Keep Docker as the default workstation and escalate to a bridge only when the
artifact actually needs that OS runtime.
