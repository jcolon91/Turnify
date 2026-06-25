#!/usr/bin/env bash
# ============================================================================
#  Bukéame — RESPALDO automático de la base de datos (P0).
#  Corre por cron (recomendado: como el usuario postgres, peer auth sin clave).
#  Hace pg_dump comprimido, rota a 7 días y (opcional) lo copia FUERA del VPS.
#
#  Instalar (como root):
#    chmod +x /var/www/bukeame/scripts/backup-db.sh
#    mkdir -p /var/backups/bukeame && chown postgres:postgres /var/backups/bukeame
#    crontab -u postgres -e
#      # respaldo diario 3:15 a.m.
#      15 3 * * * /var/www/bukeame/scripts/backup-db.sh >> /var/backups/bukeame/backup.log 2>&1
# ============================================================================
set -euo pipefail

DB="${BUKEAME_DB:-bukeame}"
DEST="${BUKEAME_BACKUP_DIR:-/var/backups/bukeame}"
KEEP_DAYS="${BUKEAME_KEEP_DAYS:-7}"
STAMP="$(date +%F_%H%M)"
FILE="$DEST/bukeame_${STAMP}.sql.gz"

mkdir -p "$DEST"

# Dump comprimido. Se escribe a .tmp y se renombra: el .gz final solo aparece
# cuando el dump terminó completo (nunca un backup a medias).
pg_dump "$DB" | gzip -9 > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
echo "$(date '+%F %T') backup OK -> $FILE ($(du -h "$FILE" | cut -f1))"

# Rotación: borra dumps más viejos que KEEP_DAYS días.
find "$DEST" -name 'bukeame_*.sql.gz' -mtime +"$KEEP_DAYS" -delete

# ── OPCIONAL pero MUY recomendado: copia FUERA del VPS ──────────────────────
# Un atacante que controla el VPS también borra los backups locales. Copia el
# dump a otro lugar. Descomenta y configura UNO de estos:
#   scp "$FILE" usuario@otro-host:/ruta/backups/
#   rclone copy "$FILE" remoto:bukeame-backups/    # rclone con S3 / Backblaze B2 / Drive
# ============================================================================
