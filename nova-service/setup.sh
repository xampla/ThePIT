#!/usr/bin/env sh
# One-time setup: fetch the community rule set and install the sidecar with uv.
set -e
cd "$(dirname "$0")"
if [ ! -d rules ]; then
  git clone --depth 1 https://github.com/Nova-Hunting/nova-rules rules
else
  git -C rules pull --ff-only
fi
uv sync
echo "run with: npm run nova   (or: cd nova-service && uv run pit-nova)"
