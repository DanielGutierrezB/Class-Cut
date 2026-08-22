#!/bin/bash
#
# tools/bundle-ollama.sh — Mete Ollama y su modelo dentro de la app.
#
# La capa de criterio corre con un modelo local, y la promesa del instalador es
# que el editor no instale nada aparte. Acá se copia lo mínimo que hace falta
# para que eso funcione en una Mac recién sacada de la caja.
#
# Ollama.app pesa 581 MB, pero en Apple Silicon casi todo eso sobra: 367 MB son
# los backends de MLX (que solo usan los modelos en formato MLX, no los GGUF que
# usamos) y una docena de librerías son variantes de CPU de Intel. Las libs
# ggml/llama que trae son x86_64 puras —están ahí para las Macs Intel—; el
# `llama-server` de arm64 las lleva enlazadas adentro. Así que el mínimo real son
# dos binarios adelgazados a arm64:
#
#   ollama        32 MB   el servidor y la API
#   llama-server  13 MB   el que corre el modelo, con Metal adentro
#
# Comprobado corriendo una inferencia real desde una copia limpia: 44 MB y usa la
# GPU ("library=Metal ... Apple M3 Max"). Sin llama-server el servidor levanta
# igual pero se cae al primer pedido y reporta la GPU como `cpu`, que es la
# manera silenciosa de que todo vaya diez veces más lento.
#
# El modelo se copia del almacén de Ollama, que son blobs por hash más un
# manifiesto que los lista. Se copian solo los del modelo elegido.
#
#   bash tools/bundle-ollama.sh [modelo]      # por defecto qwen3:4b
#
set -euo pipefail

cd "$(dirname "$0")/.."

MODEL="${1:-qwen3:4b}"
SRC="/Applications/Ollama.app/Contents/Resources"
DEST="bin/mac/ollama"
MODELS="bin/mac/ollama-models"
STORE="${OLLAMA_MODELS:-$HOME/.ollama/models}"

if [ ! -d "$SRC" ]; then
    echo "No está Ollama.app en /Applications. Bajalo de https://ollama.com/download" >&2
    exit 1
fi

mkdir -p "$DEST"

# ─── Los binarios ────────────────────────────────────────────────────────
# `lipo -thin` invalida la firma, así que hay que volver a firmar cada uno o
# macOS los mata al arrancar sin decir por qué.
for tool in ollama llama-server; do
    if [ ! -f "$SRC/$tool" ]; then
        echo "Falta $tool en Ollama.app" >&2
        exit 1
    fi
    if lipo -archs "$SRC/$tool" | grep -q arm64; then
        lipo -thin arm64 "$SRC/$tool" -output "$DEST/$tool"
    else
        cp "$SRC/$tool" "$DEST/$tool"
    fi
    chmod +x "$DEST/$tool"
    codesign --force --sign - "$DEST/$tool" 2>/dev/null || true
    printf '  %-14s %s\n' "$tool" "$(du -h "$DEST/$tool" | cut -f1)"
done

# ─── El modelo ───────────────────────────────────────────────────────────
if [ ! -d "$STORE" ]; then
    echo "No hay almacén de modelos en $STORE" >&2
    exit 1
fi

NAME="${MODEL%%:*}"
TAG="${MODEL##*:}"
[ "$NAME" = "$TAG" ] && TAG="latest"
MANIFEST="$STORE/manifests/registry.ollama.ai/library/$NAME/$TAG"

if [ ! -f "$MANIFEST" ]; then
    echo "No está $MODEL descargado. Corré: ollama pull $MODEL" >&2
    exit 1
fi

echo "  modelo $MODEL"
mkdir -p "$MODELS/manifests/registry.ollama.ai/library/$NAME" "$MODELS/blobs"
cp "$MANIFEST" "$MODELS/manifests/registry.ollama.ai/library/$NAME/$TAG"

python3 - "$MANIFEST" "$STORE" "$MODELS" <<'PY'
import json, pathlib, shutil, sys

manifest, store, dest = (pathlib.Path(a) for a in sys.argv[1:4])
data = json.loads(manifest.read_text())
layers = list(data.get("layers", []))
if "config" in data:
    layers.append(data["config"])

total = 0
for layer in layers:
    blob = layer["digest"].replace(":", "-")
    src = store / "blobs" / blob
    if not src.exists():
        sys.exit(f"Falta el blob {blob}: el modelo está incompleto.")
    out = dest / "blobs" / blob
    if not out.exists() or out.stat().st_size != src.stat().st_size:
        shutil.copy2(src, out)
    total += src.stat().st_size
print(f"         {len(layers)} blobs · {total / 1e9:.2f} GB")
PY

# ─── La prueba ───────────────────────────────────────────────────────────
# Que los archivos estén no quiere decir que arranquen: lo único que cuenta es
# una inferencia real contra esta copia, en un puerto que no sea el de nadie.
PORT=11499
echo "  probando…"
OLLAMA_MODELS="$PWD/$MODELS" OLLAMA_HOST="127.0.0.1:$PORT" "./$DEST/ollama" serve > /tmp/classcut-ollama-test.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
    curl -sf -m 2 "http://127.0.0.1:$PORT/api/tags" > /dev/null 2>&1 && break
    sleep 1
done

# La prueba imita lo que la app le va a pedir de verdad —elegir una opción de una
# lista y contestarla en JSON—, porque un "decí hola" no distingue un modelo que
# funciona de uno que contesta cualquier cosa.
cat > /tmp/classcut-ollama-probe.json <<JSON
{
  "model": "$MODEL",
  "messages": [
    {"role": "system", "content": "Contestás únicamente con JSON."},
    {"role": "user", "content": "Opciones: 1) rojo, 2) verde, 3) azul. Elegí la opción 2 y contestá {\"elegido\": <número>}."}
  ],
  "stream": false, "format": "json", "think": false,
  "options": {"temperature": 0}
}
JSON

REPLY=$(curl -s -m 180 "http://127.0.0.1:$PORT/api/chat" \
    -H 'Content-Type: application/json' \
    --data-binary @/tmp/classcut-ollama-probe.json || true)

# El contenido viene escapado dentro del JSON de Ollama, así que hay que
# desanidarlo: buscar la cadena a ojo da un falso negativo con una respuesta
# perfectamente buena.
if printf '%s' "$REPLY" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if json.loads(d["message"]["content"]).get("elegido")==2 else 1)' 2>/dev/null; then
    if grep -q "library=Metal" /tmp/classcut-ollama-test.log; then
        echo "  ✓ contesta y usa Metal · $(du -sh "$DEST" "$MODELS" | awk '{s=s" "$1} END {print s}')"
    else
        echo "  ⚠ contesta pero SIN Metal: va a ir mucho más lento. Ver /tmp/classcut-ollama-test.log" >&2
    fi
else
    echo "  ✗ la prueba falló. Contestó:" >&2
    printf '    %s\n' "${REPLY:-(nada)}" >&2
    tail -5 /tmp/classcut-ollama-test.log >&2
    exit 1
fi
