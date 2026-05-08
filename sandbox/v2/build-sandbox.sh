#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-ctf-sandbox}"
DOCKERFILE="${DOCKERFILE:-sandbox/Dockerfile.sandbox}"
CONTEXT="${CONTEXT:-.}"

echo "==> Building ${IMAGE} from ${DOCKERFILE}"
DOCKER_BUILDKIT=1 docker build \
  --progress=plain \
  -f "${DOCKERFILE}" \
  -t "${IMAGE}" \
  "${CONTEXT}"

echo "==> Tool audit"
docker run --rm --privileged "${IMAGE}" bash -lc 'id && ctf-tool-audit | tee /tmp/ctf-tool-audit.txt'
