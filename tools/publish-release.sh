#!/bin/bash
#
# tools/publish-release.sh — Publica una versión para que el botón la encuentre.
#
# Sube el PKG de actualización como release del propio repo, que es lo que la app
# consulta (ver `engine/updates.js`).
#
# El instalador completo NO se sube. GitHub no acepta archivos de más de 2 GiB
# en un release y ese pesa 3.8 GB por los modelos. Tampoco hace falta: se usa una
# sola vez, cuando se instala la app en una máquina nueva, y para eso se pasa a
# mano (disco, Drive, lo que sea). El de actualización, que es el que la app baja
# sola, entra de sobra con sus 146 MB.
#
#   bash tools/publish-release.sh
#   bash tools/publish-release.sh notas/0.3.0.md
#
# Las notas salen de un archivo si se le pasa uno, y si no del texto de acá
# abajo. El archivo es el caso normal de una versión con algo que contar: el
# botón de actualizar muestra estas notas tal cual, así que son lo único que el
# editor lee antes de decidir si instala, y un párrafo escrito para él no cabe
# en un heredoc de un script. El texto de abajo queda para las versiones que no
# cambian nada que se pueda contar.
#
set -euo pipefail

cd "$(dirname "$0")/.."

NOTAS_ARCHIVO="${1:-}"
if [ -n "$NOTAS_ARCHIVO" ] && [ ! -f "$NOTAS_ARCHIVO" ]; then
    echo "No existe el archivo de notas: $NOTAS_ARCHIVO"
    exit 1
fi

VERSION=$(node -p "require('./package.json').version")
OWNER=$(node -p "require('./engine/updates').DEFAULTS.owner")
REPO=$(node -p "require('./engine/updates').DEFAULTS.repo")

UPDATE_PKG="dist/ClassCut-${VERSION}-arm64-update.pkg"
FULL_PKG="dist/ClassCut-${VERSION}-arm64.pkg"

command -v gh >/dev/null || { echo "Falta gh (brew install gh)."; exit 1; }

[ -f "$UPDATE_PKG" ] || { echo "No está $UPDATE_PKG. Corré primero: npm run build"; exit 1; }

# Publicar una versión que la app ya tiene, o menor, deja el botón ofreciendo
# algo que no existe.
if gh release view "v${VERSION}" --repo "${OWNER}/${REPO}" >/dev/null 2>&1; then
    echo "La v${VERSION} ya está publicada. Subí la versión en package.json y version.json."
    exit 1
fi

gh repo view "${OWNER}/${REPO}" >/dev/null 2>&1 || {
    echo "No se ve ${OWNER}/${REPO}. Revisá 'gh auth status'."; exit 1;
}

echo "→ publicando v${VERSION}"
if [ -n "$NOTAS_ARCHIVO" ]; then
    echo "   notas: $NOTAS_ARCHIVO"
    gh release create "v${VERSION}" "$UPDATE_PKG" \
        --repo "${OWNER}/${REPO}" \
        --title "Class Cut ${VERSION}" \
        --notes-file "$NOTAS_ARCHIVO"
else
    gh release create "v${VERSION}" "$UPDATE_PKG" \
        --repo "${OWNER}/${REPO}" \
        --title "Class Cut ${VERSION}" \
        --notes "$(cat <<'NOTAS'
Actualización de la app. Los modelos no se vuelven a descargar: siguen
instalados en /Library/Application Support/Class Cut.

Desde la app: el número de versión, arriba a la izquierda, o Diagnóstico →
Buscar actualización.
NOTAS
)"
fi

echo ""
echo "Publicado. La app lo va a ver en la próxima consulta."
if [ -f "$FULL_PKG" ]; then
    echo ""
    echo "Para instalar en una máquina nueva, pasá a mano:"
    echo "  $(du -h "$FULL_PKG" | cut -f1)  $FULL_PKG"
fi
