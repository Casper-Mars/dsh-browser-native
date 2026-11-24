#!/usr/bin/env bash
#
# dsh 版本兼容性校验：把本包按发布形态打包，装进一个全新的 dsh 环境，
# 依次验证「安装准入 → patch 组合 → 运行时装配」三层。
#
#   pnpm compat                # 校验 npm 上的 latest（默认）
#   pnpm compat 0.2.2-rc.5     # 校验指定版本
#   bash scripts/dsh-compat.sh latest 0.2.2-rc.5
#
# 与 CI 同一条路径（.github/workflows/dsh-compat.yml），本地能过即 CI 能过。
#
# 三层判据：
#   1. 安装准入：dsh 用包自带的 engines.dsh / peerDependencies 判定兼容性，
#      不满足会直接拒绝安装并打印 requirements；
#   2. patch 组合：`dsh --profile <p> --dump-config` 能把 dsh-browser-native
#      组进配置树（schema 变更会在这里炸）；
#   3. 运行时装配：冷启动 profile，断言 8 个 browser tool 真的注册成功。
#
# 退出码：全部目标通过为 0，任一目标失败为 1，用法错误为 2。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="compat"
FAILED=0
RESULTS=()

log() { printf '\n\033[1m[dsh-compat] %s\033[0m\n' "$*"; }
ok() { printf '\033[32m[dsh-compat] PASS %s\033[0m\n' "$*"; }
err() { printf '\033[31m[dsh-compat] FAIL %s\033[0m\n' "$*" >&2; }

if [ "$#" -eq 0 ]; then
  set -- latest
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "需要 node 与 npm 在 PATH 中" >&2
  exit 2
fi

# 发布内容依赖 dist/：缺了就现编译，避免用旧产物做兼容结论。
if [ ! -f "$ROOT/dist/index.js" ]; then
  log "未发现 dist/，先执行 pnpm build"
  (cd "$ROOT" && pnpm build) || { err "pnpm build 失败"; exit 1; }
fi

TARBALL="$(cd "$ROOT" && npm pack --silent --pack-destination "${TMPDIR:-/tmp}" | tail -1)"
if [ -z "$TARBALL" ] || [ ! -f "${TMPDIR:-/tmp}/$TARBALL" ]; then
  err "npm pack 未产出 tarball"
  exit 1
fi
TARBALL="${TMPDIR:-/tmp}/$TARBALL"
log "打包完成：$TARBALL"

check_one() {
  local target="$1"
  local work
  work="$(mktemp -d "${TMPDIR:-/tmp}/dsh-compat-XXXXXX")"

  log "=== 目标 dsh：$target ==="

  (
    set -e
    cd "$work"
    printf '{"name":"dsh-compat-sandbox","private":true}\n' > package.json

    npm install --no-audit --no-fund --silent "@deepseek-ai/dsh@$target" >/dev/null
    local dsh="$work/node_modules/.bin/dsh"
    [ -x "$dsh" ] || { err "@deepseek-ai/dsh@$target 未提供 dsh 可执行文件"; exit 1; }

    local resolved
    resolved="$("$dsh" --version)"
    echo "[dsh-compat] 解析到的实际版本：$resolved"

    export DSH_HOME="$work/home"
    mkdir -p "$DSH_HOME"

    # 1) 安装准入 + 2) 组合：install 失败会打印 dsh 的兼容性判定细节
    if ! "$dsh" plugin --profile "$PROFILE" add "$TARBALL" > "$work/install.log" 2>&1; then
      err "安装被拒绝（dsh $resolved）"
      sed 's/^/    /' "$work/install.log" >&2
      exit 1
    fi
    echo "[dsh-compat] PASS 插件安装准入（manifest 兼容）"

    if ! "$dsh" --profile "$PROFILE" --dump-config > "$work/dump.yml" 2> "$work/dump.err"; then
      err "profile 组合失败（dsh $resolved）"
      sed 's/^/    /' "$work/dump.err" >&2
      exit 1
    fi

    local missing=0
    for needle in "id: dsh-browser-native" "name: dsh-browser-native"; do
      if ! grep -qF "$needle" "$work/dump.yml"; then
        err "组合结果缺少「$needle」"
        missing=1
      fi
    done
    [ "$missing" -eq 0 ] || exit 1
    echo "[dsh-compat] PASS patch 组合（dsh-browser-native）"

    # 3) 运行时：探针必须从 dsh 安装目录运行，裸导入 @deepseek-ai/dsh 才能解析
    cp "$ROOT/scripts/compat-probe.mjs" "$work/probe.mjs"
    if ! PROBE_PROFILE="$PROFILE" PROBE_TIMEOUT_MS=90000 node "$work/probe.mjs" 2>&1 | sed 's/^/    /' | tee "$work/probe.log"; then
      err "运行时探针失败（dsh $resolved）"
      exit 1
    fi
    if ! grep -q "运行时探针全部通过" "$work/probe.log"; then
      err "运行时探针未通过（dsh $resolved）"
      exit 1
    fi
    echo "[dsh-compat] PASS 运行时装配（8 个 browser tool）"
  )

  local status=$?
  rm -rf "$work"
  if [ "$status" -eq 0 ]; then
    ok "dsh $target 兼容"
    RESULTS+=("PASS  $target")
  else
    err "dsh $target 不兼容"
    RESULTS+=("FAIL  $target")
    FAILED=1
  fi
}

for target in "$@"; do
  check_one "$target"
done

printf '\n[dsh-compat] 汇总：\n'
printf '  %s\n' "${RESULTS[@]}"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
printf '\n\033[32m[dsh-compat] 全部目标兼容\033[0m\n'
