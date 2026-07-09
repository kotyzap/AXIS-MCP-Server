#!/bin/sh
# Build the .eap locally with Docker. Usage: ./build.sh [arm64|armhf|both]
# Q1656 is ARTPEC-8 -> use arm64. (On macOS external/exFAT volumes the exec bit
# may not stick — run `sh build.sh`.)
set -e
cd "$(dirname "$0")"

IMAGE=axis_mcp
VERSION=12.6.0
OS_VERSION=ubuntu24.04
TARGET="${1:-arm64}"

build_one() {
  ARCH="$1"; TAG="$2"
  echo "=== Building $ARCH ($TAG) ==="
  docker build --build-arg ARCH="$ARCH" --build-arg VERSION="$VERSION" \
    --build-arg OS_VERSION="$OS_VERSION" -t "$IMAGE:$TAG" .
  rm -rf "build-$TAG"
  docker cp "$(docker create $IMAGE:$TAG)":/opt/app/. "build-$TAG"
  find "build-$TAG" -maxdepth 1 -name '*.eap' -exec cp {} . \; -print
}

case "$TARGET" in
  arm64)  build_one aarch64 arm64 ;;
  armhf)  build_one armv7hf armhf ;;
  both)   build_one aarch64 arm64; build_one armv7hf armhf ;;
  *) echo "Usage: $0 [arm64|armhf|both]"; exit 1 ;;
esac
echo "Done. .eap files are in $(pwd)"
