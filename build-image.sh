#!/usr/bin/env bash
# Build this mediator's Docker image from the local checkout into the local
# Docker image cache. No registry involved. Runs the test suite first and
# aborts (no build) if it fails.
set -euo pipefail

cd "$(dirname "$0")"

IMAGE_TAG="${1:-openhim-advapacs-mediator:local}"

echo "==> Running tests..."
npm test

echo "==> Building $IMAGE_TAG from $(pwd)..."
docker build -t "$IMAGE_TAG" .

echo "==> Done."
docker images "${IMAGE_TAG%%:*}"
