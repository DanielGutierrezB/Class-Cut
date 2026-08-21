#!/bin/bash
#
# tools/bundle-binaries.sh — Mete ffmpeg, ffprobe y whisper-cli dentro de la app.
#
# La promesa del instalador es que no haya que instalar nada más, y estos
# binarios vienen de Homebrew enlazados contra librerías que viven en
# /opt/homebrew: en una Mac sin Homebrew no arrancan. Acá se copian ellos y todas
# sus dependencias a bin/mac/, se les reescribe de dónde cargan cada librería y
# se vuelven a firmar (tocar un binario invalida su firma y macOS lo mata).
#
# Dos cosas que costaron un rato entender:
#
# 1. Homebrew enlaza por `@rpath/libfoo.dylib`, no por ruta absoluta. Saltarse
#    esas referencias —parecen "ya relativas, ya están bien"— deja fuera del
#    bundle justo las librerías propias del programa: whisper-cli se quedaba sin
#    libwhisper y ffprobe cargaba una mezcla de librerías del bundle y del
#    sistema, con el síntoma desconcertante de un símbolo de ObjC "que existe
#    pero no donde se esperaba". Hay que resolver el @rpath contra los LC_RPATH
#    del binario ORIGINAL, que es donde esas rutas todavía significan algo.
# 2. Se reescribe a @executable_path/lib y @loader_path, no a @rpath: esas dos no
#    buscan en varios sitios, dicen exactamente dónde está el archivo.
#
# ESTADO: ffmpeg y ffprobe quedan autocontenidos y arrancan sin Homebrew en el
# PATH (comprobado abajo). whisper-cli TODAVÍA NO: el paquete de Homebrew trae la
# carpeta de sus backends (Metal, BLAS, CPU) compilada adentro
# —/opt/homebrew/Cellar/ggml/*/libexec—, así que reubicado sigue cargando los de
# ahí junto con la librería del bundle. Con dos copias de ggml-base en el mismo
# proceso, los dispositivos quedan registrados en una y buscados en la otra, y
# aborta con `GGML_ASSERT(device) failed`. No hay variable de entorno que apague
# esa ruta: GGML_BACKEND_PATH apunta a UN archivo, no reemplaza el directorio.
#
# La salida es compilar whisper.cpp acá con los backends enlazados adentro
# (`cmake -DGGML_BACKEND_DL=OFF`) en vez de copiar el de Homebrew. Mientras
# tanto la app usa el whisper-cli del sistema, que es lo que ya hace en
# desarrollo.
#
#   bash tools/bundle-binaries.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."
DEST="bin/mac"
LIBDIR="$DEST/lib"
mkdir -p "$LIBDIR"

log() { printf '  %s\n' "$*"; }

is_system_lib() {
    case "$1" in
        /usr/lib/*|/System/*) return 0 ;;
        *) return 1 ;;
    esac
}

resign() {
    codesign --force --sign - --timestamp=none "$1" 2>/dev/null || true
}

rpaths_of() {
    otool -l "$1" 2>/dev/null | awk '/LC_RPATH/{f=1;next} f&&/path /{print $2;f=0}'
}

# Una dependencia tal como la declara el binario → la ruta real en el disco.
resolve_dep() {
    local dep="$1" origin="$2"
    local dir; dir=$(dirname "$origin")

    case "$dep" in
        @rpath/*)
            local base="${dep#@rpath/}"
            local candidate
            for rp in $(rpaths_of "$origin") /opt/homebrew/lib "$dir"; do
                candidate="${rp//@loader_path/$dir}"
                candidate="${candidate//@executable_path/$dir}"
                if [ -f "$candidate/$base" ]; then echo "$candidate/$base"; return 0; fi
            done
            return 1 ;;
        @loader_path/*) echo "$dir/${dep#@loader_path/}" ;;
        @executable_path/*) echo "$dir/${dep#@executable_path/}" ;;
        *) echo "$dep" ;;
    esac
}

# @param 1 archivo ya copiado al bundle   2 ruta original (para resolver @rpath)
# @param 3 prefijo con el que se reescribe (@executable_path/lib/ o @loader_path/)
fix_deps() {
    local file="$1" origin="$2" prefix="$3"

    while read -r dep; do
        [ -z "$dep" ] && continue
        is_system_lib "$dep" && continue

        local real base
        if ! real=$(resolve_dep "$dep" "$origin"); then
            log "no pude resolver $dep (de $(basename "$origin"))"
            continue
        fi
        is_system_lib "$real" && continue
        base=$(basename "$real")

        if [ ! -f "$LIBDIR/$base" ]; then
            if [ ! -f "$real" ]; then
                log "falta $real"
                continue
            fi
            cp "$real" "$LIBDIR/$base"
            chmod u+w "$LIBDIR/$base"
            install_name_tool -id "@loader_path/$base" "$LIBDIR/$base" 2>/dev/null || true
            add_bundle_rpath "$LIBDIR/$base" "@loader_path"
            fix_deps "$LIBDIR/$base" "$real" "@loader_path/"
            resign "$LIBDIR/$base"
        fi

        # Las que ya vienen por @rpath se dejan como están: la ruta nueva es más
        # larga que la vieja y `install_name_tool -change` no siempre tiene lugar
        # para escribirla (falla en silencio y el binario queda apuntando a
        # Homebrew). Para esas alcanza con agregarle al binario un rpath que mire
        # dentro del bundle, cosa que hace `add_bundle_rpath` más abajo.
        case "$dep" in
            @rpath/*) continue ;;
        esac
        install_name_tool -change "$dep" "${prefix}${base}" "$file" 2>/dev/null ||
            log "no pude reescribir $dep en $(basename "$file")"
    done < <(otool -L "$file" | tail -n +2 | awk '{print $1}')
}

# El rpath del bundle va PRIMERO: en una Mac con Homebrew, el del binario
# original todavía resuelve, y queremos que gane el nuestro.
add_bundle_rpath() {
    install_name_tool -add_rpath "$2" "$1" 2>/dev/null || true
}

bundle_tool() {
    local name="$1" src
    src=$(command -v "$name" || true)
    if [ -z "$src" ]; then
        echo "✗ no encuentro $name en el PATH" >&2
        return 1
    fi
    src=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$src")

    log "$name ← $src"
    cp "$src" "$DEST/$name"
    chmod u+w "$DEST/$name"
    add_bundle_rpath "$DEST/$name" "@executable_path/lib"
    fix_deps "$DEST/$name" "$src" "@executable_path/lib/"
    resign "$DEST/$name"
}

echo "Empaquetando binarios en $DEST"
bundle_tool ffmpeg
bundle_tool ffprobe
bundle_tool whisper-cli

GGML_LIBEXEC=$(ls -d /opt/homebrew/Cellar/ggml/*/libexec 2>/dev/null | tail -1 || true)
if [ -n "$GGML_LIBEXEC" ]; then
    log "backends de ggml ← $GGML_LIBEXEC"
    for backend in "$GGML_LIBEXEC"/*.so "$GGML_LIBEXEC"/*.dylib; do
        [ -e "$backend" ] || continue
        base=$(basename "$backend")
        cp "$backend" "$LIBDIR/$base"
        chmod u+w "$LIBDIR/$base"
        install_name_tool -id "@loader_path/$base" "$LIBDIR/$base" 2>/dev/null || true
        fix_deps "$LIBDIR/$base" "$backend" "@loader_path/"
        resign "$LIBDIR/$base"
    done
    for extra in "$GGML_LIBEXEC"/*.metal "$GGML_LIBEXEC"/*.metallib; do
        [ -e "$extra" ] && cp "$extra" "$LIBDIR/" || true
    done
    # Los backends van SOLO en lib/, junto a la librería de ggml que los usa.
    # Copiarlos también al lado del ejecutable parecía más seguro y es peor: se
    # registran dos veces y whisper aborta con GGML_ASSERT(device) failed.
else
    log "no encontré los backends de ggml: whisper va a andar solo por CPU"
fi

echo
echo "Listo:"
du -sh "$DEST" | sed 's/^/  /'
echo
echo "Comprobación (sin Homebrew en el PATH):"
env PATH=/usr/bin:/bin "$DEST/ffprobe" -version 2>&1 | head -1 | sed 's/^/  /'
env PATH=/usr/bin:/bin GGML_BACKEND_PATH="$PWD/$LIBDIR" "$DEST/whisper-cli" --help 2>&1 |
    grep -E "^usage|load_backend" | head -4 | sed 's/^/  /'
