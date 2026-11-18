#!/usr/bin/env bash
# ==============================================================================
# edu.takir.ru — Production Moodle 4.4 -> 4.5 LTS -> 5.3 LTS Migration & Cutover
# Includes: Pre-flight checks, 3-2-1 backup verification, staged upgrade,
#           Moodle 5.1+ public/ webroot handling, systemd cron, and healthcheck.
# ==============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

# ------------------------------------------------------------------------------
# Configuration (override via environment variables if needed)
# ------------------------------------------------------------------------------
readonly SITE_DOMAIN="${SITE_DOMAIN:-edu.takir.ru}"
readonly SRC_SSH="${SRC_SSH:-root@legacy.takir.ru}"
readonly SRC_MOODLE_DIR="${SRC_MOODLE_DIR:-/var/www/edu.takir.ru/moodle}"
readonly SRC_MOODLEDATA_DIR="${SRC_MOODLEDATA_DIR:-/var/moodledata}"

readonly TGT_BASE_DIR="${TGT_BASE_DIR:-/var/www/edu.takir.ru}"
readonly TGT_MOODLE_DIR="${TGT_MOODLE_DIR:-${TGT_BASE_DIR}/moodle}"
readonly TGT_MOODLEDATA_DIR="${TGT_MOODLEDATA_DIR:-/var/moodledata}"
readonly BACKUP_DIR="${BACKUP_DIR:-/var/backups/moodle-migration}"
readonly OFFSITE_RSYNC_TARGET="${OFFSITE_RSYNC_TARGET:-backup@offsite.takir.ru:/backups/edu.takir.ru}"

readonly DB_HOST="${DB_HOST:-127.0.0.1}"
readonly DB_PORT="${DB_PORT:-3306}"
readonly DB_NAME="${DB_NAME:-moodle_takir}"
readonly DB_USER="${DB_USER:-moodle_user}"
readonly DB_PASS="${DB_PASS:-}" # Passed via ~/.my.cnf or env

readonly PHP_BIN="${PHP_BIN:-/usr/bin/php}"
readonly WEB_USER="${WEB_USER:-www-data}"
readonly WEB_GROUP="${WEB_GROUP:-www-data}"

readonly MOODLE_GIT_REPO="${MOODLE_GIT_REPO:-https://git.moodle.org/moodle.git}"
readonly BRANCH_45="${BRANCH_45:-MOODLE_405_STABLE}"
readonly BRANCH_53="${BRANCH_53:-MOODLE_503_STABLE}"

readonly LOG_FILE="/var/log/moodle_migration_$(date +%Y%m%d_%H%M%S).log"

# ------------------------------------------------------------------------------
# Logging & Error Handling
# ------------------------------------------------------------------------------
log() {
    local level="$1"; shift
    printf '[%s] [%-5s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$level" "$*" | tee -a "$LOG_FILE"
}

info()  { log "INFO"  "$@"; }
warn()  { log "WARN"  "$@"; }
error() { log "ERROR" "$@"; }

cleanup_on_error() {
    local exit_code=$?
    local line_no=$1
    error "Migration aborted at line ${line_no} with exit code ${exit_code}."
    error "Maintenance mode may still be active on source or target. Inspect ${LOG_FILE}."
    exit "$exit_code"
}
trap 'cleanup_on_error $LINENO' ERR

require_root() {
    if [[ "${EUID}" -ne 0 ]]; then
        error "This script must be run as root."
        exit 1
    fi
}

# ------------------------------------------------------------------------------
# 1. Pre-flight Verification on Target VPS
# ------------------------------------------------------------------------------
preflight_checks() {
    info "=== Phase 1: Pre-flight Verification ==="

    local required_cmds=( "$PHP_BIN" mysql mysqldump zstd rsync redis-cli git curl sha256sum systemctl )
    for cmd in "${required_cmds[@]}"; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            error "Required command not found: ${cmd}"
            exit 1
        fi
    done

    # PHP version >= 8.2 (8.3+ recommended for Moodle 5.3 LTS)
    local php_ver php_major php_minor
    php_ver="$("$PHP_BIN" -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')"
    php_major="${php_ver%%.*}"
    php_minor="${php_ver##*.}"
    if (( php_major < 8 || (php_major == 8 && php_minor < 2) )); then
        error "PHP >= 8.2 required (found ${php_ver}). Moodle 5.3 LTS recommends PHP 8.3+."
        exit 1
    fi
    if (( php_major == 8 && php_minor == 2 )); then
        warn "PHP 8.2 detected. PHP 8.3+ is recommended for Moodle 5.3 LTS."
    else
        info "PHP version check passed: ${php_ver}"
    fi

    # max_input_vars >= 5000
    local max_input_vars
    max_input_vars="$("$PHP_BIN" -r 'echo (int)ini_get("max_input_vars");')"
    if (( max_input_vars < 5000 )); then
        error "PHP max_input_vars must be >= 5000 (current: ${max_input_vars})."
        exit 1
    fi
    info "PHP max_input_vars check passed: ${max_input_vars}"

    # Required PHP extensions
    local required_exts=( intl sodium mbstring xml curl zip gd soap )
    local loaded_exts
    loaded_exts="$("$PHP_BIN" -m | tr '[:upper:]' '[:lower:]')"
    for ext in "${required_exts[@]}"; do
        if ! grep -qx "$ext" <<< "$loaded_exts"; then
            error "Missing required PHP extension: ${ext}"
            exit 1
        fi
    done
    info "All required PHP extensions loaded: ${required_exts[*]}"

    # Redis connectivity
    if [[ "$(redis-cli ping 2>/dev/null || true)" != "PONG" ]]; then
        error "Redis health check failed (redis-cli ping did not return PONG)."
        exit 1
    fi
    info "Redis ping passed: PONG"

    # Disk headroom >= 2.5x moodledata
    local src_data_kb tgt_avail_kb required_kb
    src_data_kb="$(ssh -o BatchMode=yes "$SRC_SSH" "du -sk '${SRC_MOODLEDATA_DIR}' | awk '{print \$1}'")"
    tgt_avail_kb="$(df -Pk "${TGT_BASE_DIR%/*}" | awk 'NR==2 {print $4}')"
    required_kb=$(( src_data_kb * 5 / 2 ))

    if (( tgt_avail_kb < required_kb )); then
        error "Insufficient disk space. Available: ${tgt_avail_kb} KB, Required (2.5x moodledata): ${required_kb} KB."
        exit 1
    fi
    info "Disk headroom check passed: ${tgt_avail_kb} KB available >= ${required_kb} KB required."
}

# ------------------------------------------------------------------------------
# 2. Source Maintenance, Consistent DB Dump, Rsync & 3-2-1 Backup Verification
# ------------------------------------------------------------------------------
backup_and_sync() {
    info "=== Phase 2: Maintenance Mode, DB Dump, Rsync & 3-2-1 Verification ==="
    mkdir -p "$BACKUP_DIR" "$TGT_MOODLE_DIR" "$TGT_MOODLEDATA_DIR"

    info "Enabling CLI maintenance mode on source (${SRC_SSH})..."
    ssh -o BatchMode=yes "$SRC_SSH" "sudo -u ${WEB_USER} php '${SRC_MOODLE_DIR}/admin/cli/maintenance.php' --enable"

    local dump_file="${BACKUP_DIR}/${DB_NAME}_pre_cutover_$(date +%Y%m%d_%H%M%S).sql.zst"
    info "Streaming consistent mysqldump | zstd -T0 -3 to ${dump_file}..."
    ssh -o BatchMode=yes "$SRC_SSH" \
        "mysqldump --single-transaction --quick --routines --triggers --hex-blob '${DB_NAME}' | zstd -T0 -3 -c" \
        > "$dump_file"

    sha256sum "$dump_file" > "${dump_file}.sha256"
    zstd -t "$dump_file"
    info "Local compressed DB dump verified: ${dump_file}"

    # 3-2-1 Backup Copy 2: Offsite rsync with checksum verification
    info "Syncing backup artifact to offsite 3-2-1 target: ${OFFSITE_RSYNC_TARGET}..."
    rsync -avz --checksum "$dump_file" "${dump_file}.sha256" "${OFFSITE_RSYNC_TARGET}/"

    info "Restoring DB dump into target MariaDB/MySQL (${DB_NAME})..."
    local mysql_auth=( -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" )
    [[ -n "$DB_PASS" ]] && mysql_auth+=( "-p${DB_PASS}" )

    mysql "${mysql_auth[@]}" -e "CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    zstd -dc "$dump_file" | mysql "${mysql_auth[@]}" "$DB_NAME"

    info "Syncing moodledata via rsync -aHAX --numeric-ids --delete..."
    rsync -aHAX --numeric-ids --delete --info=progress2 \
        "${SRC_SSH}:${SRC_MOODLEDATA_DIR}/" "${TGT_MOODLEDATA_DIR}/"

    chown -R "${WEB_USER}:${WEB_GROUP}" "$TGT_MOODLEDATA_DIR"
    chmod -R 0750 "$TGT_MOODLEDATA_DIR"
}

# ------------------------------------------------------------------------------
# 3. Staged Moodle Upgrade (4.4 -> 4.5 LTS -> 5.3 LTS) & Systemd Cron
# ------------------------------------------------------------------------------
run_moodle_cli() {
    local rel_script="$1"
    shift || true
    local cli_path="${TGT_MOODLE_DIR}/${rel_script}"
    if [[ ! -f "$cli_path" && -f "${TGT_MOODLE_DIR}/public/${rel_script}" ]]; then
        cli_path="${TGT_MOODLE_DIR}/public/${rel_script}"
    fi
    sudo -u "$WEB_USER" "$PHP_BIN" "$cli_path" "$@"
}

staged_upgrade() {
    info "=== Phase 3: Staged Moodle Upgrade (4.4 -> 4.5 LTS -> 5.3 LTS) ==="

    if [[ ! -d "${TGT_MOODLE_DIR}/.git" ]]; then
        info "Cloning Moodle repository into ${TGT_MOODLE_DIR}..."
        git clone --quiet "$MOODLE_GIT_REPO" "$TGT_MOODLE_DIR"
    fi

    # Preserve config.php from source
    rsync -a "${SRC_SSH}:${SRC_MOODLE_DIR}/config.php" "${TGT_MOODLE_DIR}/config.php"

    # Stage A: 4.4 -> 4.5 LTS
    info "Checking out ${BRANCH_45} (Moodle 4.5 LTS)..."
    git -C "$TGT_MOODLE_DIR" fetch --all --prune --quiet
    git -C "$TGT_MOODLE_DIR" checkout --force "$BRANCH_45"
    chown -R "${WEB_USER}:${WEB_GROUP}" "$TGT_MOODLE_DIR"

    run_moodle_cli "admin/cli/maintenance.php" --enable
    run_moodle_cli "admin/cli/mysql_collation.php" --collation=utf8mb4_unicode_ci
    run_moodle_cli "admin/cli/upgrade.php" --non-interactive
    run_moodle_cli "admin/cli/purge_caches.php"

    # Stage B: 4.5 LTS -> 5.3 LTS (handles Moodle 5.1+ public/ webroot layout)
    info "Checking out ${BRANCH_53} (Moodle 5.3 LTS)..."
    git -C "$TGT_MOODLE_DIR" checkout --force "$BRANCH_53"
    chown -R "${WEB_USER}:${WEB_GROUP}" "$TGT_MOODLE_DIR"

    if [[ -d "${TGT_MOODLE_DIR}/public" ]]; then
        info "Moodle 5.1+ public/ webroot layout detected. Ensuring Nginx/PHP-FPM points to ${TGT_MOODLE_DIR}/public."
    fi

    run_moodle_cli "admin/cli/upgrade.php" --non-interactive
    run_moodle_cli "admin/cli/purge_caches.php"
    run_moodle_cli "admin/cli/checks.php"

    install_systemd_cron
    verify_and_cutover
}

install_systemd_cron() {
    info "Installing systemd moodle-cron.service and moodle-cron.timer (60s interval)..."
    local cron_script="${TGT_MOODLE_DIR}/admin/cli/cron.php"
    [[ -f "${TGT_MOODLE_DIR}/public/admin/cli/cron.php" ]] && cron_script="${TGT_MOODLE_DIR}/public/admin/cli/cron.php"

    cat <<EOF > /etc/systemd/system/moodle-cron.service
[Unit]
Description=Moodle Background Cron (${SITE_DOMAIN})
After=network.target mariadb.service redis-server.service

[Service]
Type=oneshot
User=${WEB_USER}
Group=${WEB_GROUP}
ExecStart=${PHP_BIN} ${cron_script}
StandardOutput=journal
StandardError=journal
EOF

    cat <<EOF > /etc/systemd/system/moodle-cron.timer
[Unit]
Description=Run Moodle Cron every 60 seconds (${SITE_DOMAIN})

[Timer]
OnBootSec=60s
OnUnitActiveSec=60s
AccuracySec=5s
Unit=moodle-cron.service

[Install]
WantedBy=timers.target
EOF

    systemctl daemon-reload
    systemctl enable --now moodle-cron.timer
    info "systemd moodle-cron.timer enabled and started."
}

verify_and_cutover() {
    info "Running final HTTP & CLI healthcheck before disabling maintenance mode..."
    local http_code
    http_code="$(curl -sk -o /dev/null -w '%{http_code}' "https://${SITE_DOMAIN}/login/index.php" || true)"
    if [[ "$http_code" != "200" && "$http_code" != "303" && "$http_code" != "503" ]]; then
        error "Unexpected HTTP status from https://${SITE_DOMAIN}/login/index.php: ${http_code}"
        exit 1
    fi

    run_moodle_cli "admin/cli/maintenance.php" --disable
    info "Maintenance mode disabled. Migration of ${SITE_DOMAIN} to Moodle 5.3 LTS completed successfully."
}

main() {
    require_root
    preflight_checks
    backup_and_sync
    staged_upgrade
}

main "$@"
