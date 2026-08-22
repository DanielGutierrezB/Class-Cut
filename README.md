# Class Cut

App local de macOS (Apple Silicon) que procesa las grabaciones del **Rodecaster
Video** y devuelve las clases **ya precortadas** en XML, listo para importar en
**Premiere Pro** o **DaVinci Resolve**.

Todo pasa fuera del editor: se agrega la carpeta del curso, la app transcribe el
Live-Mix, alinea los marcadores del director de contenido con lo que realmente se
dijo, calcula los cortes y escribe el XML. Nada del material original se toca.

## Cómo funciona

1. **Agregar carpeta** — el curso completo, un día o una sola clase; la app
   reconoce las clases por su estructura (un XML del Rodecaster con `Audio/` y
   `Video/` al lado), no por el nombre de la carpeta.
2. **Clases** — tabla con lo que encontró: número de clase (sale del nombre de
   secuencia del XML), duración real medida con ffprobe, bloques del CD y avisos.
3. **Procesar** — transcribe `Live-Mix.wav` con Whisper local, ubica la claqueta,
   alinea cada marcador con el audio y decide dónde el corte tiene sentido (ver
   **Cortes con criterio**).
4. **Revisar cortes** — waveform, bloques y transcript para ajustar antes de
   exportar, y el **guion final**: la clase cortada leída de corrido, con lo que
   no cierra marcado en su bloque.
5. **Exportar XML** — una sola carpeta `The Cutter/` en la raíz agregada, con el
   XML final de cada clase y un `Backup/` con lo que se usó para generarlo.

## Cortes con criterio

Cortar donde el director de contenido puso la marca no alcanza: sus marcas están
cerca, pero el bloque termina diciendo "Pausa" o se corta a mitad de frase.
Medido sobre las 174 tomas del curso antes de arreglarlo: **66 terminaban con una
orden al editor** y **103 quedaban colgando** a mitad de idea.

El corte se decide en tres capas, de la más barata a la más cara:

1. **Reglas** ([engine/speech-edges.js](engine/speech-edges.js)) — los límites de
   palabra impiden que el colchón de aire se lleve la palabra vecina, se saca lo
   que el profesor le dice al editor ("pausa", "corte", el conteo) y el borde se
   lleva a donde una frase abre o cierra. Esto solo arregla el 93%.
2. **Criterio** ([engine/cut-refine.js](engine/cut-refine.js)) — cuando quedan
   dos cortes defendibles, decide el modelo local. No se le pide un tiempo: se le
   dan los cortes posibles **numerados** dentro de la transcripción y contesta un
   número, así no puede inventar un timecode ni cortar a mitad de palabra. Si
   contesta cualquier otra cosa, manda la regla.
3. **Sentido** ([engine/coherence.js](engine/coherence.js)) — con la clase ya
   cortada se arma el guion final —solo lo que sobrevive, en orden— y se lee
   buscando lo que ninguna regla ve: una idea que quedó colgando, algo dicho dos
   veces porque sobrevivieron dos tomas, un bloque que abre con un "Y entonces"
   cuyo antecedente se eliminó. Los hallazgos apuntan a **números de bloque** y se
   validan contra los que existen.

Todo es local (Ollama). Si no está corriendo, la app corta igual con las reglas y
lo dice en **Diagnóstico**; la casilla "Afinar con IA local" lo apaga a mano.

## Colores

Los **marcadores** salen con el color que les puso el director de contenido, sin
excepción. Para que Premiere los devuelva idénticos hay que escribirle su entero
nativo (`pproColor`, el mismo que trae el XML del Rodecaster): si solo se le dan
componentes RGB, los ajusta al color más parecido de su paleta y el marcador
cambia de color solo. El XML lleva las dos formas —el entero para Premiere, el
RGB para Resolve y el resto—, así que ninguno de los dos tiene que adivinar.

Los **clips** se colorean por fuente y siempre igual entre clases: la cámara en
Cerulean, el screen recorder en Rose, y de ahí en adelante una etiqueta distinta
por fuente ([engine/fcp-xml.js](engine/fcp-xml.js), `CLIP_LABELS`). El audio
queda con su color por defecto. Esto Premiere lo lee del XML; Resolve no importa
colores de clip desde FCP7, así que para eso va aparte
[resolve/colorear-clips.py](resolve/colorear-clips.py), que se corre dentro de
Resolve una vez importado.

## Estado

Funciona de punta a punta contra el curso real (3 días, 13 clases): se agrega la
carpeta, se procesan las clases y salen los XML cortados, revisables antes de
exportar. Lo que falta es el instalador (ver **Distribución**).

Medido sobre ese curso: 8h18m de material crudo → 1h37m de tomas buenas en 174
bloques, con el 95% de los marcadores anclados al audio.

## Desarrollo

```bash
npm install
npm start              # abre la app
npm test               # motor puro: sin red, sin Premiere, sin Whisper
```

Iterar la interfaz sin abrirla a mano:

```bash
npx electron . --folder=/ruta/al/curso --shot=/tmp/cc.png
npx electron . --folder=/ruta/al/curso --js="openDrawer('04_…')" --shot=/tmp/cc.png
```

### Estructura

```
main.js · preload.js     Electron (el motor corre en el proceso principal)
src/                     ventana: HTML/CSS/JS sin frameworks
engine/
  course-scan.js         descubre clases por firma de estructura
  rodecaster-xml.js      parser de marcadores (pares IN/OUT, claqueta, cues)
  media-probe.js         duración y frame rate reales con ffprobe
  transcribe.js          Whisper local con VAD
  align.js               claqueta, anclaje de cada marcador e invariantes
  speech-edges.js        habla del director, límites de palabra, cierre de frase
  cut-refine.js          candidatos de corte y elección (regla o IA)
  coherence.js           guion final y revisión de sentido
  ai-local.js            cliente de Ollama, con todo lo que dice validado
  cutplan.js · export.js · fcp-xml.js    plan de cortes y XML de salida
  paths.js               dónde están ffmpeg/ffprobe/whisper en esta máquina
resolve/                 script de color de clips para DaVinci (ver su README)
tests/                   corredor propio: node tests/run.js
```

### Herramientas externas

La app busca ffmpeg, ffprobe, whisper-cli y los modelos primero dentro de sí
misma (`bin/mac/`) y después en el sistema. **Diagnóstico** (arriba a la derecha)
dice qué encontró y dónde.

Para desarrollo alcanza con Homebrew:

```bash
brew install ffmpeg whisper-cpp
mkdir -p bin/mac/models   # y dejar ahí ggml-large-v3-turbo.bin y el modelo de VAD
```

La IA es opcional y también local:

```bash
brew install ollama && ollama serve
ollama pull qwen3.8:27b     # o el que prefieras: se configura en ai-local.js
```

Los modelos: `ggml-large-v3-turbo.bin` (1,5 GB) y `ggml-silero-v5.1.2.bin`
(885 KB), de los repos `ggerganov/whisper.cpp` y `ggml-org/whisper-vad` en
Hugging Face. Se pueden apuntar con `CLASSCUT_WHISPER_MODEL` y `CLASSCUT_VAD_MODEL`.

## Distribución

Pendiente. `tools/bundle-binaries.sh` ya deja ffmpeg y ffprobe autocontenidos
—copia sus librerías, reescribe de dónde las cargan y los vuelve a firmar—, y se
comprobó que arrancan sin Homebrew en el PATH.

Falta whisper-cli, y por un motivo concreto: el paquete de Homebrew trae la
carpeta de sus backends (Metal, BLAS, CPU) compilada adentro, así que aunque se
copie sigue cargando los de `/opt/homebrew`. Con dos copias de ggml en el mismo
proceso, los dispositivos se registran en una y se buscan en la otra, y aborta.
La salida es compilar whisper.cpp acá con los backends enlazados adentro
(`cmake -DGGML_BACKEND_DL=OFF`) en vez de copiar el de Homebrew.

Hasta entonces el `.pkg` no puede prometer "cero instalación", que es justamente
lo que tiene que prometer.

## Lo que se aprendió del material real

- La `<duration>` del XML es siempre 2 h exactas: es un valor fijo del Rodecaster.
  Las clases duran entre 17 minutos y 1:06 h, así que las duraciones se miden del
  material.
- El material es **30 fps exactos**, aunque el XML declare 29.97 en el formato.
- El par IN/OUT se decide por la **duración del marcador**, no por el texto: hay
  notas del CD que empiezan con `OUT ANTES DE:` y son un IN.
- El `out` del marcador IN son 10 s de adorno; el bloque termina en el marcador
  OUT, que a veces cae antes.
- El número de clase vive en el nombre de secuencia del XML: la carpeta
  "FIRS CLASS" es internamente la clase 13.
- El colchón de aire necesita saber dónde está la palabra vecina. Sin ese límite
  se comía lo que venía después: 66 de 174 tomas terminaban con el "Pausa" que el
  profesor le dice al editor, y en el corte se oía "Pau—".
- Los cortes posibles no pueden salir solo de las pausas del audio: en un tramo
  hablado de corrido no hay ninguna, y el cierre bueno —el punto final de la
  frase— se queda fuera de la lista. Hay que ofrecerlo aparte.
