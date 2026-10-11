#!/usr/bin/env bash
# Verificacion manual contra una sesion real de OpenCode.
#
# El orden real de ejecucion de hooks no se puede comprobar de forma no interactiva:
# OpenCode ignora XDG_CONFIG_HOME y `opencode plugin list` da resultados inconsistentes.
# Ver docs/v2-compatibility.md. Este script existe para que el usuario lo ejecute dentro
# de su propia sesion, donde si se pueden ver los comandos registrados.
#
# Uso:  bash scripts/verify-opencode.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHIM_DIR="${HOME}/.config/opencode/plugins"
SHIM="${SHIM_DIR}/cache-guardian.ts"
DIST="${ROOT}/dist/index.js"

echo "== Cache Guardian: verificacion en host real =="

if ! command -v opencode >/dev/null 2>&1; then
  echo "ERROR: opencode no esta en el PATH."
  exit 1
fi

echo "opencode: $(opencode --version 2>&1 | head -1)"

if [ ! -f "$DIST" ]; then
  echo "ERROR: falta $DIST. Ejecuta primero: bun install && bun run build"
  exit 1
fi

if [ -e "$SHIM" ]; then
  echo "AVISO: ya existe $SHIM; se sobrescribira."
fi

mkdir -p "$SHIM_DIR"
printf "export { default } from "%s"
" "$DIST" > "$SHIM"
echo "Shim escrito en: $SHIM"

cat <<'STEPS'

-- Ahora, dentro de OpenCode (sesion interactiva):

  1. /cache_guardian_doctor
     -> debe listar los 4 hooks como 'ok' y confirmar el stream de eventos

  2. Haz 2-3 peticiones normales.

  3. /cache_guardian_report
     -> 'Requests observed' debe ser > 0
     -> 'Comparable pairs' > 0 solo tras la segunda peticion comparable
     -> las secciones de uso del proveedor deben mostrar cache read/write, no N/A

  4. /cache_guardian_reset --confirm
     -> debe confirmar el borrado

STEPS

read -r -p "Pulsa Enter para dejar el shim instalado, o Ctrl+C para limpiarlo: " _
rm -f "$SHIM"
echo "Shim eliminado: $SHIM"