#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-huntctl-worker:full-next}"
DOCKERFILE="${DOCKERFILE:-sandbox/Dockerfile.sandbox}"
CONTEXT="${CONTEXT:-.}"

echo "==> Building ${IMAGE} from ${DOCKERFILE}"
DOCKER_BUILDKIT=1 docker build \
  --progress=plain \
  -f "${DOCKERFILE}" \
  -t "${IMAGE}" \
  "${CONTEXT}"

echo "==> Tool audit"
docker run --rm "${IMAGE}" bash -lc 'ctf-tool-audit | tee /tmp/ctf-tool-audit.txt'
echo "==> MCP doctor"
docker run --rm "${IMAGE}" bash -lc 'ctf-mcp-configure >/tmp/ctf-mcp-configure.log && ctf-mcp-doctor'
