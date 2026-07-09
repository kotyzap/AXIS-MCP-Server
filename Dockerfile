# Standalone ACAP build for AXIS OS 11/12 (Native SDK), bundling a Node.js app.
# Target: ARTPEC-8 (aarch64) — Axis Q1656. One architecture per build via --build-arg ARCH.
#   docker build --build-arg ARCH=aarch64 --build-arg VERSION=12.6.0 -t axis_mcp:arm64 .
#   docker cp $(docker create axis_mcp:arm64):/opt/app/. ./build-arm64   # .eap lands here

ARG ARCH=aarch64
ARG VERSION=12.6.0
ARG OS_VERSION=ubuntu24.04
FROM --platform=linux/amd64 axisecp/acap-native-sdk:${VERSION}-${ARCH}-${OS_VERSION} AS builder

ARG ARCH
WORKDIR /opt/app

# Host Node (to run tsc) + fetch the ARM Node runtimes bundled into the .eap.
# Node 18/20 are fine on AXIS OS 11/12 (glibc >= 2.28).
ARG NODE_VERSION=20.11.0
RUN apt-get update && apt-get install -y curl wget xz-utils jq && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    mkdir -p bin && \
    wget -q https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz && \
    tar -xf node-v${NODE_VERSION}-linux-arm64.tar.xz && \
    cp node-v${NODE_VERSION}-linux-arm64/bin/node bin/node-arm64 && \
    wget -q https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-armv7l.tar.xz && \
    tar -xf node-v${NODE_VERSION}-linux-armv7l.tar.xz && \
    cp node-v${NODE_VERSION}-linux-armv7l/bin/node bin/node-armhf && \
    rm -rf node-v${NODE_VERSION}-linux-*

COPY app/ /opt/app/

# Production deps + compile TypeScript -> dist/
RUN npm install && npm run build && npm prune --omit=dev

# GOTCHA #1: sourcing environment-setup* exports its own ARCH (e.g. "arm64"),
# clobbering the build arg. Capture TARGET_ARCH BEFORE sourcing and key off it.
RUN TARGET_ARCH="$ARCH" && \
    . /opt/axis/acapsdk/environment-setup* && \
    echo "Build TARGET_ARCH=[$TARGET_ARCH]" && \
    case "$TARGET_ARCH" in \
      aarch64) rm -f bin/node-armhf; ${STRIP} bin/node-arm64 2>/dev/null || true ;; \
      armv7hf) rm -f bin/node-arm64; ${STRIP} bin/node-armhf 2>/dev/null || true ;; \
      *) echo "Unknown TARGET_ARCH=[$TARGET_ARCH]" >&2; exit 1 ;; \
    esac && \
    sed -i "s/\"architecture\": \"[^\"]*\"/\"architecture\": \"$TARGET_ARCH\"/" manifest.json && \
    chmod +x axis_mcp 2>/dev/null; \
    echo "=== active manifest.json ===" && cat manifest.json

# Build the .eap. GOTCHA #5: html/ is auto-included — do NOT pass it via -a.
# Add only the dirs acap-build won't include on its own.
RUN . /opt/axis/acapsdk/environment-setup* && \
    grep architecture manifest.json && \
    acap-build . -a dist -a bin -a node_modules && \
    echo "=== built .eap ===" && ls -la *.eap && \
    tar tzf *.eap 2>/dev/null | sed -n '1,40p'
