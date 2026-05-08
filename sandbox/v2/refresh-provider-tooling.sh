#!/usr/bin/env bash
# Refresh claude and codex CLI tools inside a running sandbox container.
# Usage: ./refresh-provider-tooling.sh <container_id_or_name>
set -euo pipefail

CONTAINER="${1:-}"
if [[ -z "$CONTAINER" ]]; then
    echo "Usage: $0 <container_id_or_name>" >&2
    exit 1
fi

exec_in() {
    docker exec "$CONTAINER" bash -c "$1"
}

retry_npm_global() {
    local package="$1"
    local label="${2:-$package}"
    exec_in "
        npm config set fetch-retries 5 >/dev/null &&
        npm config set fetch-retry-mintimeout 20000 >/dev/null &&
        npm config set fetch-retry-maxtimeout 120000 >/dev/null &&
        npm config set fetch-timeout 300000 >/dev/null &&
        for attempt in 1 2 3 4 5; do
            npm install -g --no-audit --no-fund '$package' 2>&1 | tail -5 && exit 0
            sleep \$((attempt * 10))
        done
        exit 1
    " || echo "$label update skipped"
}

echo "==> Refreshing provider tooling in container: $CONTAINER"

# ── Claude CLI ──────────────────────────────────────────────────────────────
echo "--- Updating claude CLI ---"
retry_npm_global "@anthropic-ai/claude-code" "claude CLI"

# Check if claude is available
if exec_in 'which claude' &>/dev/null; then
    echo "claude CLI: $(exec_in 'claude --version 2>/dev/null || echo unknown')"
else
    echo "WARNING: claude CLI not found in container"
fi

# ── Codex CLI ───────────────────────────────────────────────────────────────
echo "--- Updating codex CLI ---"
retry_npm_global "@openai/codex" "codex CLI"

if exec_in 'which codex' &>/dev/null; then
    echo "codex CLI: $(exec_in 'codex --version 2>/dev/null || echo unknown')"
else
    echo "WARNING: codex CLI not found in container"
fi

# ── Go tools ────────────────────────────────────────────────────────────────
echo "--- Refreshing Go-based security tools ---"
GO_TOOLS=(
    "github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest"
    "github.com/projectdiscovery/httpx/cmd/httpx@latest"
    "github.com/ffuf/ffuf/v2@latest"
    "github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest"
    "github.com/tomnomnom/waybackurls@latest"
    "github.com/tomnomnom/anew@latest"
)
for tool in "${GO_TOOLS[@]}"; do
    name="${tool##*/}"
    name="${name%%@*}"
    echo -n "  $name ... "
    if exec_in "go install $tool 2>/dev/null"; then
        echo "ok"
    else
        echo "failed (skipped)"
    fi
done

# ── Python packages ──────────────────────────────────────────────────────────
echo "--- Refreshing Python packages ---"
exec_in 'pip3 install --no-cache-dir --break-system-packages --upgrade pwntools pycryptodome pillow z3-solver 2>&1 | tail -3'

# ── SecLists ─────────────────────────────────────────────────────────────────
echo "--- Updating SecLists ---"
exec_in 'cd /opt/SecLists && git pull --ff-only 2>&1 | tail -3' || echo "SecLists update skipped"

echo "==> Done."
