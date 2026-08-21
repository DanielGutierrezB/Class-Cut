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
3. **Procesar** — transcribe `Live-Mix.wav` con Whisper local, ubica la claqueta
   y alinea cada marcador con el audio.
4. **Revisar cortes** — waveform, bloques y transcript para ajustar antes de
   exportar.
5. **Exportar XML** — una sola carpeta `The Cutter/` en la raíz agregada, con el
   XML final de cada clase y un `Backup/` con lo que se usó para generarlo.

## Estado

En desarrollo. Fase 1 lista: escáner, parser de marcadores, medición del material
y la tabla de clases (verificado contra un curso real de 3 días y 13 clases).

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
  paths.js               dónde están ffmpeg/ffprobe/whisper en esta máquina
tests/                   corredor propio: node tests/run.js
```

### Herramientas externas

En desarrollo se usan las del sistema (`/opt/homebrew/bin`). La app distribuida
las trae adentro: el instalador `.pkg` incluye ffmpeg, ffprobe, whisper-cli y su
modelo, así que no hay nada que instalar aparte. **Diagnóstico** (arriba a la
derecha) dice qué encontró y dónde.

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
