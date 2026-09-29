#!/usr/bin/env bash
# metapi 无痛上线：compose-only 唯一生产切换路径，失败自动回滚。
# 依据 AGENTS.md「发版与无痛上线」——切换只做一件事：改
# /var/lib/metapi/docker-compose.yml 的 image: 行 + docker compose up -d；
# 本脚本从不 docker stop/rm metapi，也从不动 /var/lib/metapi 以外的生产事实。
set -euo pipefail

usage() {
  cat <<'EOF'
用法：scripts/deploy-painless.sh --version <版本号> [--yes]

  --version <v>  目标版本，镜像 tag = metapi:<v>（必填）
  --yes          非交互确认（TTY 下不加会先问一次）

固定流程（无跳过开关）：
  1 旁路构建 metapi:<v>，旧容器继续服务
  2 hub.db 只读一致快照 + PRAGMA quick_check（不过就终止）
  3 canary：快照副本 + PORT=4100 起一次性容器验证 migrate 与接口，不过则终止（生产未动）
  4 切换：改 compose 的 image: 行 → docker compose config -q → docker compose up -d
  5 验收：容器 running、127.0.0.1:4000 监听、日志含 Migration complete. 与
    Server listening、/api/stats/dashboard 与 /v1/models 均 200
  6 任一步失败自动回滚：恢复 compose 备份 → docker compose up -d（不打印任何密钥）
EOF
}

die()  { printf '\033[31m[deploy][error]\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[deploy][warn]\033[0m %s\n' "$*" >&2; }

VERSION=""
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --yes)     ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)         usage >&2; die "未知参数：$1" ;;
  esac
done
[ -n "$VERSION" ] || { usage >&2; die "--version 必填"; }
case "$VERSION" in
  *[!0-9A-Za-z._-]*) die "--version 只能含字母数字与 ._- （如 1.4.3）" ;;
esac

# ── 生产事实（唯一真相；勿在别处复制） ───────────────────────────────────────
COMPOSE_DIR="/var/lib/metapi"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.yml"
ENV_FILE="$COMPOSE_DIR/.env"
DB_FILE="$COMPOSE_DIR/data/hub.db"
CONTAINER="metapi"
PROD_PORT=4000
CANARY="metapi-canary"
CANARY_PORT=4100
CANARY_DIR="$COMPOSE_DIR/data-canary"
LOCK_FILE="$COMPOSE_DIR/.deploy.lock"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

IMAGE="metapi:$VERSION"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$COMPOSE_DIR/deploy-logs/deploy-$STAMP-$VERSION.log"
SNAPSHOT="$COMPOSE_DIR/data.bak-$STAMP-pre-$VERSION.db"
COMPOSE_BAK="$COMPOSE_FILE.pre-$STAMP-$VERSION"
SWITCHED=0
DONE=0

compose() { ( cd "$COMPOSE_DIR" && docker compose "$@" ); }
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }
http_code() { curl -s -o /dev/null -m 5 -w '%{http_code}' -H "Authorization: Bearer $1" "http://127.0.0.1:$2$3" 2>/dev/null || echo 000; }
wait_http_200() { local waited=0; while [ "$waited" -lt "$4" ]; do [ "$(http_code "$1" "$2" "$3")" = 200 ] && return 0; sleep 2; waited=$((waited+2)); done; return 1; }

cleanup_canary() { docker rm -f "$CANARY" >/dev/null 2>&1 || true; }

rollback() {
  warn "切换失败 → 自动回滚"
  cp -f "$COMPOSE_BAK" "$COMPOSE_FILE"
  info "已恢复切换前 compose：$COMPOSE_BAK"
  compose up -d || die "回滚重建失败，人工介入：cd $COMPOSE_DIR && docker compose up -d"
  info "回滚完成，现役镜像：$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"
}

on_exit() {
  local code=$?
  [ "$DONE" -eq 1 ] && return 0
  cleanup_canary
  if [ "$SWITCHED" -eq 1 ]; then rollback; fi
  exit "$code"
}
trap on_exit EXIT

# ── 0 前置校验 ───────────────────────────────────────────────────────────────
[ -f "$COMPOSE_FILE" ] || die "缺少生产 compose：$COMPOSE_FILE"
[ -f "$ENV_FILE" ]     || die "缺少环境文件：$ENV_FILE"
[ -f "$DB_FILE" ]      || die "缺少生产数据库：$DB_FILE"
command -v docker >/dev/null  || die "缺少 docker"
command -v sqlite3 >/dev/null || die "缺少 sqlite3"
compose config -q || die "compose 配置校验失败（缺 env 或语法错误）"

mkdir -p "$COMPOSE_DIR/deploy-logs"
exec > >(tee -a "$LOG_FILE") 2>&1
info "目标 $IMAGE；日志 $LOG_FILE"

exec 9>"$LOCK_FILE"
flock -n 9 || die "已有 deploy 在运行（$LOCK_FILE）：同一时间只允许一个操作者"

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  info "现役容器 $CONTAINER：$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')（running=$(docker inspect "$CONTAINER" --format '{{.State.Running}}')）"
else
  warn "容器 $CONTAINER 当前不存在，本次 up -d 同时充当即刻恢复动作"
fi

# ── 1 旁路构建（旧容器继续服务） ─────────────────────────────────────────────
info "[1/6] 构建 $IMAGE"
docker build -t "$IMAGE" -f "$REPO_DIR/docker/Dockerfile" "$REPO_DIR"
docker image inspect "$IMAGE" --format '       built {{.Id}} {{.Created}}'

# ── 2 hub.db 快照（切换前置条件） ────────────────────────────────────────────
info "[2/6] hub.db 只读快照"
[ -e "$SNAPSHOT" ] && die "快照已存在：$SNAPSHOT"
sqlite3 "file:$DB_FILE?mode=ro" ".backup '$SNAPSHOT'"
check="$(sqlite3 "$SNAPSHOT" 'PRAGMA quick_check;')"
[ "$check" = ok ] || die "快照 quick_check=$check，终止发版"
info "       $SNAPSHOT（$(du -h "$SNAPSHOT" | cut -f1)）"

# ── 3 canary：副本 + 4100，不碰生产容器 ──────────────────────────────────────
info "[3/6] canary 验证 @ 127.0.0.1:$CANARY_PORT"
rm -rf "$CANARY_DIR"; mkdir -p "$CANARY_DIR"
cp -f "$SNAPSHOT" "$CANARY_DIR/hub.db"
docker run -d --name "$CANARY" --network host --env-file "$ENV_FILE" \
  -e HOST=127.0.0.1 -e PORT="$CANARY_PORT" -e DATA_DIR=/app/data \
  -e CHECKIN_CRON='0 0 31 2 *' -e BALANCE_REFRESH_CRON='0 0 31 2 *' \
  -v "$CANARY_DIR:/app/data" "$IMAGE" >/dev/null
if ! wait_http_200 "$(env_value AUTH_TOKEN)" "$CANARY_PORT" /api/stats/dashboard 90; then
  warn "canary 未就绪，最后 30 行日志："
  docker logs --tail 30 "$CANARY" 2>&1 | sed 's/^/  /' || true
  die "canary 失败：生产未做任何改动"
fi
docker logs "$CANARY" 2>&1 | grep -q 'Migration complete.' && info "       migrate + 接口 200 通过"
cleanup_canary

# ── 4 切换：改 compose image: 行 + up -d ─────────────────────────────────────
if [ "$ASSUME_YES" -eq 0 ]; then
  [ -t 0 ] || die "非交互环境请加 --yes"
  printf '确认把生产切到 %s ？[y/N] ' "$IMAGE"
  read -r answer
  case "$answer" in y|Y) ;; *) die "已取消，生产未改动" ;; esac
fi

info "[4/6] 切换 compose image: → $IMAGE"
cp -f "$COMPOSE_FILE" "$COMPOSE_BAK"
PREV_IMAGE="$(sed -n 's/^ *image: *//p' "$COMPOSE_FILE" | head -1)"
python3 - "$COMPOSE_FILE" "$IMAGE" "$PREV_IMAGE" "$COMPOSE_BAK" "$(date +%F)" <<'PY'
import sys
path, image, prev, bak, day = sys.argv[1:6]
note = ("    # %s switched to %s; prev %s\n"
        "    # rollback: 恢复 %s 或把 image 改回 %s 后 docker compose up -d\n") % (day, image, prev, bak, prev)
out, done = [], False
for line in open(path, encoding="utf-8"):
    if not done and line.strip().startswith("image:"):
        out += [note, "    image: %s\n" % image]
        done = True
    else:
        out.append(line)
if not done:
    sys.exit("compose 里找不到 image: 行")
open(path, "w", encoding="utf-8").write("".join(out))
PY
compose config -q || die "改后 compose 校验失败"
info "       $(compose config --images | tr '\n' ' ')"
SWITCHED=1
compose up -d

# ── 5 验收 ───────────────────────────────────────────────────────────────────
info "[5/6] 验收（最多等 180s 就绪）"
waited=0
until docker logs "$CONTAINER" 2>&1 | grep -q "Server listening at http://127.0.0.1:$PROD_PORT"; do
  if [ "$waited" -ge 180 ]; then
    docker logs --tail 30 "$CONTAINER" 2>&1 | sed "s/^/  /"
    die "180s 内未就绪"
  fi
  sleep 2; waited=$((waited+2))
done
[ "$(docker inspect "$CONTAINER" --format '{{.State.Running}}')" = true ] || die "容器未 running"
[ "$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')" = "$IMAGE" ] || die "容器镜像与目标不符"
ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PROD_PORT" || die "127.0.0.1:$PROD_PORT 未监听"
docker logs "$CONTAINER" 2>&1 | grep -q 'Migration complete.' || die "日志缺少 Migration complete."
dash="$(http_code "$(env_value AUTH_TOKEN)" "$PROD_PORT" /api/stats/dashboard)"
models="$(http_code "$(env_value PROXY_TOKEN)" "$PROD_PORT" /v1/models)"
info "       /api/stats/dashboard=$dash  /v1/models=$models"
[ "$dash" = 200 ] || die "管理接口异常（$dash）"
[ "$models" = 200 ] || die "代理接口异常（$models）"
compose ps
SWITCHED=0
DONE=1

# ── 6 收尾 ───────────────────────────────────────────────────────────────────
info "[6/6] 上线完成：$IMAGE"
cat <<EOF

还需人工/agent 完成：
  1 真实流量验证（复现触发 / 查调试库与日志核对）
  2 数据级回滚（仅当新版本迁移污染数据）：compose stop → 用 $SNAPSHOT 覆盖 $DB_FILE
    （同时删除 hub.db-wal / hub.db-shm）→ compose up -d
  3 发布收尾：显式 git push origin <branch> → merge --ff-only 进 main → git push origin main
  4 分支清理：按 AGENTS.md「发版与无痛上线」节「脚本跑完还要做的」第③条执行：只删本次 ff-only 合入的一支（其余 ref 不删）、顺序 worktree→本地→远程、只用 git branch -d / git worktree remove、禁 -D / --force / rm -rf
  5 存量裁剪（每次发版必做，判据写死）：DB 快照 /var/lib/metapi/data.bak-*.db 按 mtime 倒序只留最新 7 个（本次发版新增必留），其余逐个 rm -f -- <文件> 删除，禁止对 /var/lib/metapi/data 做目录级删除；镜像只保留当前发版版本，删掉更旧的 metapi:<版本号> 与陈旧 tag，删前先核无人使用（docker ps -a --filter ancestor=<镜像> 为空），需要旧版作即时回滚位时先向用户确认后从对应提交重建；清理前先看发版窗口（deploy-logs/ 有进行中 deploy 或 .deploy.lock 被持有时让位），data-canary/ 暂存区不当作残留清理
镜像级回滚：cp -f $COMPOSE_BAK $COMPOSE_FILE && cd $COMPOSE_DIR && docker compose up -d
EOF
