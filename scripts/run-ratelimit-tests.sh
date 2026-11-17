#!/usr/bin/env bash
# 限速调节域测试入口：打包 TS 测试 → 在隔离目录运行 → 清理
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$ROOT/.tmp-ratelimit-test"
mkdir -p "$TMP/build"

node "$ROOT/scripts/build-ratelimit-tests.mjs"
node "$TMP/build/engine.test.js"
node "$TMP/build/service.test.js"
node "$TMP/build/smoke.test.js"

rm -rf "$TMP"
echo "全部测试通过，临时产物已清理"
