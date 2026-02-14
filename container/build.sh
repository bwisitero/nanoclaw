#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Detect which container runtime is available
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "Using Docker..."
  docker build -t "${IMAGE_NAME}:${TAG}" .
  RUNTIME="docker"
elif command -v container >/dev/null 2>&1; then
  echo "Using Apple Container..."
  container build -t "${IMAGE_NAME}:${TAG}" .
  RUNTIME="container"
else
  echo "Error: No container runtime found. Please install Docker or Apple Container."
  exit 1
fi

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
