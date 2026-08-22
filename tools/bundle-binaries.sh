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
# whisper-cli no se copia: se compila. El paquete de Homebrew trae la carpeta de
# sus backends (Metal, BLAS, CPU) compilada adentro del binario
# —/opt/homebrew/Cellar/ggml/*/libexec—, así que reubicado seguía cargando los de
# ahí JUNTO con la librería del bundle. Con dos copias de ggml-base en el mismo
# proceso, los dispositivos quedan registrados en una y buscados en la otra, y
# aborta con `GGML_ASSERT(device) failed`. No hay variable de entorno que apague
# esa ruta: GGML_BACKEND_PATH apunta a UN archivo, no reemplaza el directorio.
#
# Compilado desde fuente con los backends enlazados adentro y el shader de Metal
# embebido en el ejecutable, el problema desaparece de raíz: no hay ninguna
# carpeta que encontrar. El binario queda en 3 MB y no depende de nada fuera de
# los frameworks del sistema.
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

# Se apunta a la línea base de Apple Silicon y no a ESTA máquina: `GGML_NATIVE`
# compila para el procesador que tenga el que empaqueta, y un binario hecho en un
# M3 usa instrucciones (i8mm) que en un M1 son ilegales. El editor no se entera
# de eso hasta que la app le revienta al transcribir.
WHISPER_ARCH="armv8.2-a+dotprod+fp16"
WHISPER_SRC="${WHISPER_SRC:-$PWD/build/whisper.cpp}"

build_whisper() {
    if ! command -v cmake > /dev/null; then
        echo "✗ falta cmake para compilar whisper.cpp. Instalalo con: brew install cmake" >&2
        return 1
    fi
    if [ ! -d "$WHISPER_SRC/.git" ]; then
        log "whisper.cpp ← github"
        mkdir -p "$(dirname "$WHISPER_SRC")"
        git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER_SRC" 2>&1 |
            sed 's/^/    /'
    fi

    log "compilando whisper-cli para $WHISPER_ARCH"
    cmake -S "$WHISPER_SRC" -B "$WHISPER_SRC/build" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DGGML_BACKEND_DL=OFF \
        -DGGML_METAL=ON \
        -DGGML_METAL_EMBED_LIBRARY=ON \
        -DGGML_NATIVE=OFF \
        -DGGML_CPU_ARM_ARCH="$WHISPER_ARCH" \
        -DWHISPER_BUILD_TESTS=OFF \
        -DWHISPER_BUILD_SERVER=OFF \
        > /dev/null || { echo "✗ falló el cmake de whisper.cpp" >&2; return 1; }

    cmake --build "$WHISPER_SRC/build" --config Release -j "$(sysctl -n hw.ncpu)" \
        > /dev/null || { echo "✗ falló la compilación de whisper.cpp" >&2; return 1; }

    cp "$WHISPER_SRC/build/bin/whisper-cli" "$DEST/whisper-cli"
    resign "$DEST/whisper-cli"
}

echo "Empaquetando binarios en $DEST"
bundle_tool ffmpeg
bundle_tool ffprobe
build_whisper

echo
echo "Listo:"
du -sh "$DEST" | sed 's/^/  /'
echo
# La única comprobación que vale es sin Homebrew a la vista: con él en el PATH un
# binario mal enlazado funciona igual y el problema aparece en la máquina del
# editor, que es donde no se puede arreglar.
echo "Comprobación (sin Homebrew en el PATH):"
env -i PATH=/usr/bin:/bin "$DEST/ffprobe" -version 2>&1 | head -1 | sed 's/^/  /'
env -i PATH=/usr/bin:/bin "$DEST/ffmpeg" -version 2>&1 | head -1 | sed 's/^/  /'

if otool -L "$DEST/whisper-cli" | tail -n +2 | grep -qv -e '/usr/lib/' -e '/System/'; then
    echo "  ✗ whisper-cli depende de algo que no es del sistema:" >&2
    otool -L "$DEST/whisper-cli" | tail -n +2 | grep -v -e '/usr/lib/' -e '/System/' >&2
    exit 1
fi
echo "  whisper-cli: solo frameworks del sistema · $(du -h "$DEST/whisper-cli" | cut -f1)"
