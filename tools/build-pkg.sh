#!/bin/bash
#
# tools/build-pkg.sh — Arma los dos instaladores de una versión.
#
# Son dos porque los modelos pesan 3.8 GB de los 3.9 y son los mismos en todas
# las versiones. Si viajaran dentro del `.app`, actualizar la app sería volver a
# bajar cuatro gigas para cambiar unos kilobytes de código; peor todavía,
# reemplazar el `.app` los borraría y habría que reinstalarlos igual.
#
#   ClassCut-<v>-arm64.pkg          completo   ~4 GB   primera instalación
#   ClassCut-<v>-arm64-update.pkg   solo app   ~120 MB  lo que descarga el botón
#
# El completo son dos componentes: la app a /Applications y los modelos a
# /Library/Application Support/Class Cut, que es donde `engine/paths.js` los
# busca. El de actualización lleva solo el primero, así que se instala sobre lo
# que ya está y deja los modelos en su lugar, intactos.
#
#   bash tools/build-pkg.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
IDENT=$(node -p "require('./package.json').build.appId")
APP_NAME="Class Cut"
DATA_DIR="/Library/Application Support/${APP_NAME}"
OUT="dist"
STAGE="$OUT/pkg-stage"

echo "Class Cut ${VERSION}"

# La app reporta la de `version.json` y el instalador se llama con la de
# `package.json`. Si no son la misma, la app se compara contra los releases con
# un número que no es el suyo: o no ve una actualización que existe, o se ofrece
# a sí misma para siempre.
REPORTADA=$(node -p "require('./version.json').version")
if [ "$REPORTADA" != "$VERSION" ]; then
    echo "version.json dice ${REPORTADA} y package.json ${VERSION}. Igualalos antes de compilar."
    exit 1
fi

for tool in pkgbuild productbuild; do
    command -v "$tool" >/dev/null || { echo "Falta $tool (viene con las Command Line Tools)."; exit 1; }
done

# ── 1. La app ────────────────────────────────────────────────────────
# `--dir` deja el .app sin empaquetar: el empaquetado lo hacemos acá abajo,
# porque el target `pkg` de electron-builder solo sabe armar un componente y
# necesitamos dos.
echo "→ compilando la app"
npx electron-builder --mac --dir

APP="$OUT/mac-arm64/${APP_NAME}.app"
[ -d "$APP" ] || { echo "No quedó el .app en $APP"; exit 1; }

# Sin certificado de Apple la firma es ad-hoc. Alcanza para que macOS la deje
# correr después del primer "Abrir igual", y es lo que hay hasta que exista un
# Developer ID.
echo "→ firmando ad-hoc"
codesign --force --deep --sign - "$APP" 2>/dev/null || true

# ── 2. Los modelos ───────────────────────────────────────────────────
MODELS="bin/mac/models"
OLLAMA_MODELS="bin/mac/ollama-models"
[ -d "$MODELS" ] || { echo "Faltan los modelos de Whisper: corré tools/bundle-binaries.sh"; exit 1; }
[ -d "$OLLAMA_MODELS" ] || { echo "Falta el modelo de Ollama: corré tools/bundle-ollama.sh"; exit 1; }

rm -rf "$STAGE"
mkdir -p "$STAGE/payload"
echo "→ juntando los modelos ($(du -shc "$MODELS" "$OLLAMA_MODELS" | tail -1 | cut -f1))"
# `ditto` y no `cp`: sin `--norsrc` cada archivo viaja con un `._` al lado, que
# son 16 archivos de basura dentro de un instalador de 3.8 GB.
ditto --norsrc --noextattr --noacl "$MODELS" "$STAGE/payload/models"
ditto --norsrc --noextattr --noacl "$OLLAMA_MODELS" "$STAGE/payload/ollama-models"

# ── 3. Los componentes ───────────────────────────────────────────────
echo "→ armando los componentes"
pkgbuild --quiet \
    --component "$APP" \
    --install-location "/Applications" \
    --identifier "${IDENT}" \
    --version "$VERSION" \
    "$STAGE/app.pkg"

pkgbuild --quiet \
    --root "$STAGE/payload" \
    --install-location "$DATA_DIR" \
    --identifier "${IDENT}.models" \
    --version "$VERSION" \
    "$STAGE/models.pkg"

# ── 4. Los instaladores ──────────────────────────────────────────────
distribution() {
    local title="$1"; shift
    {
        echo '<?xml version="1.0" encoding="utf-8"?>'
        echo '<installer-gui-script minSpecVersion="2">'
        echo "  <title>${title}</title>"
        echo '  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>'
        echo '  <volume-check><allowed-os-versions><os-version min="11.0"/></allowed-os-versions></volume-check>'
        echo '  <choices-outline>'
        for pkg in "$@"; do echo "    <line choice=\"${pkg}\"/>"; done
        echo '  </choices-outline>'
        for pkg in "$@"; do
            echo "  <choice id=\"${pkg}\" visible=\"false\"><pkg-ref id=\"${pkg}\"/></choice>"
            echo "  <pkg-ref id=\"${pkg}\">${pkg}.pkg</pkg-ref>"
        done
        echo '</installer-gui-script>'
    }
}

echo "→ instalador completo"
distribution "${APP_NAME} ${VERSION}" app models > "$STAGE/full.dist"
productbuild --distribution "$STAGE/full.dist" --package-path "$STAGE" \
    "$OUT/ClassCut-${VERSION}-arm64.pkg"

echo "→ instalador de actualización"
distribution "${APP_NAME} ${VERSION}" app > "$STAGE/update.dist"
productbuild --distribution "$STAGE/update.dist" --package-path "$STAGE" \
    "$OUT/ClassCut-${VERSION}-arm64-update.pkg"

rm -rf "$STAGE"

echo ""
echo "Listo:"
for f in "$OUT/ClassCut-${VERSION}-arm64.pkg" "$OUT/ClassCut-${VERSION}-arm64-update.pkg"; do
    echo "  $(du -h "$f" | cut -f1)  $f"
done
echo ""
echo "Para publicarlo: bash tools/publish-release.sh"
