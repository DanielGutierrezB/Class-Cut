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
   exportar; el **guion final**, que es la clase cortada leída de corrido con lo
   que no cierra marcado en su bloque; y **ver la clase**, que la reproduce
   montada (ver **El reproductor**).
5. **Exportar XML** — una sola carpeta `The Cutter/` en la raíz agregada, con el
   XML final de cada clase y un `Backup/` con lo que se usó para generarlo.

Y cada clase se queda con una copia de su propio trabajo, dentro de su carpeta
(ver **El trabajo viaja con la clase**), para que volver a entrar por otro lado
no cueste otra hora de Whisper.

## Cortes con criterio

Cortar donde el director de contenido puso la marca no alcanza: sus marcas están
cerca, pero el bloque termina diciendo "Pausa" o se corta a mitad de frase.
Medido sobre las 174 tomas del curso antes de arreglarlo: **66 terminaban con una
orden al editor** y **103 quedaban colgando** a mitad de idea.

El corte se decide en cuatro capas, de la más barata a la más cara:

0. **Órdenes** ([engine/orden-del-cd.js](engine/orden-del-cd.js)) — a veces el CD
   ya escribió dónde va el corte y no hay nada que deducir. Ver más abajo.
1. **Reglas** ([engine/speech-edges.js](engine/speech-edges.js)) — los límites de
   palabra impiden que el colchón de aire se lleve la palabra vecina, se saca lo
   que el profesor le dice al editor ("pausa", "corte", el conteo) y el borde se
   lleva a donde una frase abre o cierra. Esto solo arregla el 93%.
2. **Criterio** ([engine/cut-refine.js](engine/cut-refine.js)) — cuando quedan
   dos cortes defendibles, decide el modelo local. No se le pide un tiempo: se le
   dan los cortes posibles **numerados** dentro de la transcripción y contesta un
   número, así no puede inventar un timecode ni cortar a mitad de palabra. Si
   contesta cualquier otra cosa, manda la regla. Cuánto contexto ve y a qué
   bloques se les gasta una consulta está medido más abajo.
3. **Repeticiones** ([engine/repeticiones.js](engine/repeticiones.js)) — lo que se
   dice dos veces se quita una, sin preguntar. Ver más abajo.
4. **Sentido** ([engine/coherence.js](engine/coherence.js)) — con la clase ya
   cortada se arma el guion final —solo lo que sobrevive, en orden— y se lee
   buscando lo que ninguna regla ve: una idea que quedó colgando, un bloque que
   abre con un "Y entonces" cuyo antecedente se eliminó. Los hallazgos apuntan a
   **números de bloque** y se validan contra los que existen.
5. **Repaso** ([engine/repasar.js](engine/repasar.js)) — lo que la lectura
   encontró, arreglado; y la clase leída otra vez para ver qué quedó. Ver más
   abajo.

Todo es local (Ollama). Si no está corriendo, la app corta igual con las reglas y
lo dice en **Diagnóstico**; la casilla "Afinar con IA local" lo apaga a mano y el
selector de al lado fuerza un modelo en vez de dejar que elija el mejor que haya.

El modelo va con **semilla fija**. La misma clase tiene que dar el mismo corte, y
sin semilla no lo daba: dos corridas seguidas sobre los mismos archivos leían la
clase 13 y una encontraba seis cosas y la otra nueve. Para quien edita, eso hace
que reprocesar deje de ser repetir y pase a ser tirar otra vez el dado; y para
quien desarrolla, hace imposible saber si un cambio mejoró algo o le tocó una
corrida con suerte.

Que esto funcione no se mira a ojo, se cuenta. [tools/medir-cortes.js](tools/medir-cortes.js)
vuelve a medir los mismos defectos sobre el curso ya procesado:

```bash
node tools/medir-cortes.js "/ruta/al/curso" --detalle
```

Un aviso sobre la vara, porque cuesta un rato entenderlo: **no se mide contra los
tiempos de palabra de Whisper**. Whisper entrega las palabras pegadas —el 99%
empieza exactamente donde termina la anterior, y una sola "palabra" puede cubrir
ocho segundos de silencio—, así que preguntarle si un corte cae dentro de una
palabra da que sí siempre. Si el corte se metió en el sonido lo sabe la medición
de onda ([engine/vendor/audio-onset.js](engine/vendor/audio-onset.js)), que es la
que mira el audio de verdad.

Las reglas que definen "corte malo" viven en un solo archivo
([tools/defectos.js](tools/defectos.js)) y las comparten el medidor y el banco.
Con una copia en cada uno, un banco podía declarar una mejora que la medición
oficial no veía, y los dos tenían razón.

### Cuando el CD ya dijo dónde cortar

De los 174 bloques del curso, 69 traen una nota escrita para el editor. La mayoría
son de post ("POST: highlight en el archivo tasks.md"), pero 24 son órdenes de
corte con nombre y apellido:

```
OUT ANTES DE: "En Spec-Driven Development, la"
IN DESPUÉS DE: "3, 2, 1. Vamos a ver qué hallazgos generó"
```

Eso no es una pista, es la persona que armó la clase diciendo dónde va el corte.
Se estaban cumpliendo **1 de 24**, con bordes pasados de largo por 13, 19 y hasta
23 segundos. La nota llegaba al prompt como texto suelto y el modelo no podía
hacer nada con ella: la ventana que ve son unas 60 palabras alrededor del corte y
la frase que la nota pide casi siempre cae fuera. Ahora se ubica la frase en el
transcript y el borde se lleva ahí sin consultar a nadie: **21 de 24**, con tres
bloques colgando menos y sin costo (213s contra 231s, que es ruido).

Tres cosas que no son obvias y que costaron la mitad del trabajo:

- **La orden viaja en el marcador que no le corresponde.** El CD escribe sobre el
  IN, pero casi siempre habla del OUT. Además de llevarla al borde del que habla,
  hay que dejar de mostrársela al otro: "OUT ANTES DE …" mientras se afina la
  entrada es ruido puro.
- **La frase aparece varias veces, porque hay retomas.** El profesor arranca, se
  traba y repite: en la clase 1 la misma frase aparece cuatro veces dentro de un
  bloque, con puntaje perfecto las cuatro. Quedarse con la primera lleva el corte
  a la toma equivocada. Lo que desempata es el marcador en vivo: aunque esté
  corrido veinte segundos, dice cuál de las tomas tenía delante el CD. Si dos
  tomas quedan casi equidistantes es una moneda al aire, y ahí la frase se ofrece
  como candidata en vez de imponerse.
- **"Antes" y "después" no cortan en el mismo punto de la frase.** En los dos
  casos la frase queda afuera, así que "OUT antes de X" corta donde X empieza y
  "IN después de X" donde X termina. Tratarlos igual dejaba la clase 11 abriendo
  con el "3, 2, 1" del conteo, o sea justo lo que la nota pedía sacar.

Ubicar la frase es difuso a propósito: el CD la escribe de memoria y Whisper la
transcribe a su manera —"Spec-Driven Development" contra "Spectriven
Development"—, así que compararlas letra a letra no encuentra nada. Por debajo de
0.8 de coincidencia no se toca el borde: un 0.75 enganchó "y nos entregó el
cambio en la aplicación" cuando la nota pedía "¡Ya nos entregó la aplicación", y
llevar el corte ahí lo dejaba partiendo una oración por la mitad.

De las 3 que quedan sin cumplir, 2 piden frases que no están en el audio (la nota
dice "Esto puede" y eso no se dice en ese tramo) y 1 son dos tomas equidistantes
que se dejan a criterio del resto. Se mide con:

```bash
node tools/ordenes-cumplidas.js "/ruta/al/curso" --detalle
```

### El conteo de la toma

Cada toma arranca con "3, 2, 1", y eso no es la clase: es la claqueta hablada. La
limpieza de bordes la sacaba yendo palabra por palabra desde el arranque y
parando en la primera que no fuera del director — y ahí está el fallo, porque el
"Ok." que el director suele decir justo antes del conteo solo cuenta como suyo
si trae un silencio propio delante. Cuando venía pegado, el bucle paraba en él y
**no llegaba nunca al conteo que tenía detrás**. Tres bloques del curso abrían
así: `Ok. 3, 2, 1. En este curso…`, `Lista. Bueno. Tres, dos, uno. Para…` y, el
peor, `Claqueta 6, clase 6. 3, 2, 1. Ya…`.

Ahora el conteo se busca primero, en las ocho primeras palabras, y el bloque abre
**detrás de la última**: lo que viene después del conteo es la toma, por
definición, y lo que viene antes no lo es nunca.

Con quitarlo del recorte no alcanzaba, y eso fue lo que costó ver. En la clase 6
el borde no lo decidía la regla sino el modelo (`in.decidedBy=ia`), eligiendo
entre los cortes que se le ofrecen — y el filtro que descarta los que dejan
charla dentro **mira solo la palabra que sigue al corte**, que ahí era
"Claqueta". No está en ninguna lista, así que el candidato pasaba y el modelo lo
elegía. El filtro ahora mira el arranque entero, con la misma función que usan el
recorte y la medición: si un corte deja la claqueta hablada dentro, no llega a
ser una opción.

Sobre el curso, los bloques que abrían con el conteo pasan de **3 a 0**, y de
paso la charla del director suelta baja de 8 a 2: el "Ok." y el "Lista. Bueno."
que tapaban el conteo se iban con él.

Un detalle de implementación que se lleva palabras por delante si se hace mal: el
borde va a donde **arranca** la palabra siguiente al conteo, no a donde termina
el conteo. Whisper entrega palabras que se pisan, y el "uno." acababa después de
que empezara la frase; llevar el borde a ese final se comía «Para ver» en la
clase 9 y «En» en la 13. La cola del conteo que pueda quedar dentro la resuelve
el afinado con la onda, porque entre la cuenta y la toma siempre hay silencio.

Con una condición que costó una prueba en rojo: tienen que ser **dos seguidas**.
"Uno de los problemas más comunes" y "Tres cosas antes de empezar" abren clases de
verdad, y la regla vieja se llevaba ese "Uno" y ese "Tres" por delante — la frase
que presenta el bloque, justo. En cifra (`3, 2, 1`) sí vale una sola: Whisper
escribe en cifra el conteo y en letra el número hablado.

### Lo que se dice dos veces

El profesor arranca una idea, no le sale, y la vuelve a decir. El CD marca los dos
intentos porque marca en vivo y no va a frenar la grabación para editar, así que
al final de la clase el alumno escucha la misma frase dos veces seguidas. En el
curso pasa **15 veces**, unos tres minutos de material duplicado.

Esto ya se detectaba: la capa de sentido lo reportaba como "Se dice dos veces" y
sugería "eliminar el bloque 14". Pero reportarlo es dejarle la tarea al editor, y
es justo una tarea que la máquina hace mejor, porque la respuesta está en los
tiempos de palabra y no en el criterio. Ahora se arregla sola y el guion cuenta
**lo que se hizo** en vez de lo que falta hacer.

El arreglo casi nunca es tirar un bloque. Lo normal es que al bloque de antes le
sobre la **cola** —siguió de largo hasta donde el profesor se trabó— y que el de
después ya diga eso mismo mejor: recortar esa cola conserva todo y arregla el
empalme. Solo cuando el bloque entero es la toma mala (corto, calcado y con la
buena justo detrás) se apaga, y apagarlo es reversible desde la revisión, donde
aparece como "fuera" con el motivo.

Cuatro cosas que costaron el trabajo:

- **Buscarlo tiene que ser difuso.** Dos tomas de una frase no comparten las
  palabras: "y es justamente ese el problema por el que ByCoin no escala" contra
  "y justo ese es el problema por el que el Bitcoin no escala". La comparación
  literal que había en el medidor daba **cero** sobre las trece clases mientras el
  anclaje difuso encontraba quince.
- **Pero alinear bien no alcanza.** "El cuarto componente es el de estructura y
  estilo de código" y "el quinto componente es el de manejo de errores y
  validaciones" alinean a 0.71, el mismo puntaje que una retoma de verdad, porque
  comparten todo el andamiaje del idioma. Con ese solo criterio la herramienta
  borraba 60 segundos únicos de la clase 4. Se compara además por las palabras que
  **dicen** algo, sin el relleno: ahí esa pareja comparte 1 de 5 y una retoma
  comparte casi todas.
- **El sitio donde arranca la repetición no es donde queda bien cortar.** Justo
  antes suele estar la parte en la que el profesor se trababa, así que el borde
  pasa por las mismas limpiezas que cualquier otro —quitar las órdenes al editor,
  cerrar la frase—, y en vueltas, porque se destapan entre sí: sacar el conteo deja
  el corte detrás de un "Pausa. Listo.", que también cierra frase.
- **Se comprueba después de aplicar, dos veces.** Si al recortar la repetición
  sigue ahí, el recorte se deshace: mover el corte y encima dejar el defecto es
  peor que no haber tocado nada. Y si el recorte deja el bloque terminando a
  mitad de idea, también: el punto donde arranca la retoma no siempre tiene una
  frase cerrada cerca, y cambiar una repetición por un final colgando no es
  arreglar, es mover el defecto de sitio.

Sobre el curso, los defectos bajan de **68 a 53**: se van las 15 repeticiones y no
aparece ni un final colgando nuevo. Eso último costó ampliar el margen para
retraer al cerrar la frase (ocho palabras en vez de cuatro): acá lo que queda entre
la última frase cerrada y el punto de recorte ya se sabe que sobra, así que
retraer es gratis. Con el margen de siempre, la clase 10 terminaba un bloque en
"y aquí ya nos abre nuestro".

Cuando el modelo señala una repetición que las reglas no vieron, se intenta
ubicarla con el listón más bajo —hay dos señales independientes apuntando al mismo
sitio— pero con la misma comprobación al final. Lo que se mira antes de tocar
nada:

```bash
node tools/medir-repeticiones.js "/ruta/al/curso"
```

Imprime, para cada una, con qué se queda el bloque y qué se va. Un recorte mal
puesto se lee enseguida; a ojo, no.

### El repaso final

Leer la clase cortada y decir qué no cierra estaba resuelto. Lo que hacía con
eso, no: escribía una lista. Y una lista es trabajo que no se hizo — "el bloque 7
arranca con un 'Entonces' apoyado en algo que se eliminó" no es un hallazgo, es
una tarea de veinte segundos que la máquina hace mejor, porque la respuesta está
en los tiempos de palabra.

Así que antes de reportar, se intenta ([engine/repasar.js](engine/repasar.js)).
Cuatro arreglos, todos mecánicos:

- **el conector huérfano** — el bloque abre con "Y", "Entonces", "Pero"
  apoyándose en algo que quedó fuera. Se corre el IN detrás del conector.
- **el arranque a mitad de frase** — el bloque empieza en "promesa de valor de
  este curso…" porque el corte se comió el "La". Se retrae hasta donde la frase
  empezaba.
- **la frase abierta** — el bloque termina a mitad de idea. Se estira hasta que
  cierre, sin llegar nunca al bloque siguiente.
- **el fragmento suelto** — un bloque de un segundo que dice "contaminar y
  perder contexto" y que el siguiente dice entero. Se apaga.

Lo que **no** se arregla es el orden: mover un bloque de sitio cambia la clase y
eso lo decide quien edita. Se reporta y ya.

Dos reglas que no se negocian, y las dos costaron encontrarlas:

- **Todo arreglo se comprueba.** Se aplica, se vuelve a medir el defecto y si
  sigue ahí se deshace. Mover un corte y encima dejar el problema es peor que no
  haber tocado nada: el editor ya no va a mirar ese bloque, porque figura como
  arreglado.
- **Después de arreglar se vuelve a leer.** La clase que se leyó ya no existe, y
  un arreglo puede dejar un empalme donde no lo había. Sin esa segunda lectura,
  lo que se entrega es el informe de una clase que no es la suya. Cuesta una
  llamada más —el guion entero entra en una— contra las decenas que se gastan
  afinando bordes.

#### Qué da, medido

Sobre las trece clases del curso, el repaso arregla solo **6 de los 36** hallazgos
de la lectura, y hay que decir por qué ese número no baja más: **el modelo
encuentra una cantidad parecida de cosas cada vez que lee**, arregladas o no. Con
la semilla fija se ve claro — las clases 2, 3, 5, 6, 8, 10, 11 dan exactamente los
mismos hallazgos leyendo dos veces la misma clase—, y en las que sí se arregló
algo, la relectura vuelve con otros tantos. Buena parte de lo que reporta no es un
defecto sino una opinión ("el salto se nota", "falta contexto"), y eso no se
arregla moviendo un corte: se arregla decidiendo, que es del editor.

Lo que sí se mide sin modelo de por medio son los defectos de borde, y ahí ninguno
empeora:

| | antes del repaso | después |
|---|---|---|
| abre con el conteo de la toma | 3 | **0** |
| termina con habla del director | 8 | **2** |
| frase colgando al final | 27 | 27 |
| conector huérfano | 14 | **13** |
| cortado a mitad de palabra | 5 | **4** |
| repite el bloque anterior | 2 | **1** |

Que `colgando` no suba es el dato que más costó: arreglar el arranque de un bloque
y romperle el final a otro habría sido un empate disfrazado de mejora.

El diagnóstico de por qué un arreglo no se aplicó se mira con:

```bash
node tools/ver-hallazgos.js "/ruta/al/curso" --clases 13
node tools/medir-repaso.js "/ruta/al/curso"
```

El primero imprime cada hallazgo con el texto de su bloque y si se supo arreglar;
el segundo cuenta, sobre el curso entero, cuántas cosas encontró la lectura y
cuántas le quedan al editor.

#### Por qué la guarda del conector no podía ser la nota del CD

El primer intento no quitaba ningún conector, y el motivo enseña algo del
formato: se estaba respetando la nota del CD —"si él escribió el bloque
empezando por 'Y', lo puso a propósito"—. Pero el `cueIn` no es lo que el CD
quiso, es **la transcripción de cómo abre el bloque**. Si el bloque abre con "Y",
el cue empieza con "Y" siempre, y la guarda se disparaba en todos los casos.

Lo que de verdad deja huérfano a un conector es que se haya tirado material justo
antes: "Y en cuarto lugar, tenemos…" abre perfecto cuando el bloque de antes
viene pegado, porque el "en tercero" está ahí y se lee de corrido. Esa es la
guarda — la misma que ya usaba [tools/defectos.js](tools/defectos.js) para
contarlos.

### El criterio se elige en Ajustes

El criterio —quién decide los cortes dudosos y lee el guion— es una preferencia
de la máquina, no de la clase. En **Ajustes** (arriba a la derecha) hay tres:

- **Modelo local.** El que viene con la app. Sin internet, sin cuentas, y con la
  semilla fija reprocesar da el corte idéntico. Es el default de fábrica.
- **Cursor CLI.** La cuenta de Cursor del editor, con el modelo que tenga
  contratado (Sonnet, GPT, el que sea). El CLI corre en modo impresión y de
  solo lectura, en un directorio vacío propio: contesta números, no ve archivos.
- **API de Claude.** Directo a Anthropic con la clave del editor. La clave se
  guarda en esta Mac y solo viaja a `api.anthropic.com`.

**Probar** funciona antes de Guardar: se pega la clave o se elige el modelo, se
ve que contesta y cuánto tarda, y recién ahí uno se lo queda. Los proveedores
remotos declaran ventana grande (`contextoGrande`), y con eso el motor les da
la clase ENTERA de fondo al decidir cada corte y les pasa el guion completo en
una sola lectura — con el local eso se midió y no conviene (abajo); con una
ventana de un millón de tokens, ver que lo que se está por descartar se rehace
tres minutos después es exactamente lo que el modelo chico no podía.

Lo que se pierde con un proveedor remoto es el determinismo bit a bit: no hay
semilla que fijar por el CLI, así que reprocesar da un corte equivalente pero
no idéntico (por la API se pide `temperature: 0`, que es lo más cerca). Las
herramientas de medición usan la MISMA puerta que la app (`engine/ia.js`), con
`--ia` y `--modelo` para los A/B.

Medido sobre las trece clases del curso, mismo código, qwen3.8:27b local contra
Sonnet 5 por el CLI (ventana de 1M, clase entera de fondo):

|                                  | qwen local | Sonnet 5 |
| -------------------------------- | ---------: | -------: |
| cosas que la lectura encontró    |         24 |       63 |
| defectos de borde (colgando)     |         27 |       25 |
| defectos de borde (conector)     |         14 |       12 |
| tiempo total                     |     52 min |   45 min |

La diferencia grande no está en los bordes —eso lo deciden mayormente las
reglas y la lista de candidatos— sino en la LECTURA: Sonnet encuentra el triple
y lo describe como un editor ("la frase se corta antes de decir cuál es la
respuesta, probablemente 'no'"; "'puede ser efímero' no concuerda en género con
'la deuda'"). Más hallazgos no es un corte peor: es un lector más exigente
diciendo qué le falta al primer corte, que es exactamente lo que el visor le
muestra al editor.

### Cuánto tiene que ver el modelo

Al afinar un borde, el modelo LOCAL ve unas 60 palabras alrededor del corte. La
clase entera también le entraría —unos 3700 tokens, contra los ~20k que aguanta
el default de Ollama, medido con [tools/medir-contexto.js](tools/medir-contexto.js)—
así que valía preguntarse si dársela mejora los cortes: podría ver que lo que
está por dejar afuera se rehace tres minutos después, algo que ninguna ventana
alcanza.

Se probó, con la clase entera marcada bloque por bloque, y **no conviene**.
Sobre los 174 bloques del curso:

| | defectos | consultas | tiempo |
|---|---|---|---|
| ventana de 60 palabras | 52 | 67 | 38 s |
| clase entera de fondo | 50 | 67 | 108 s |

Dos defectos de diferencia sobre 174 está dentro del ruido, y cuesta **2.8× el
tiempo**. Lo que más dice: de 33 consultas, en 30 contesta exactamente lo mismo
con una ventana que con la clase entera. El cuello no es cuánto ve el modelo,
es **qué opciones tiene para elegir** — medido con
[tools/mirar-colgados.js](tools/mirar-colgados.js), de los bloques que terminan a
mitad de frase, en la mitad el corte bueno **nunca estuvo en la lista de
candidatos**, y ahí no hay contexto ni modelo que ayude.

También se probó abrir el afinado a todos los bloques, no solo a los dudosos: la
confianza mide si la nota del CD enganchó con el transcript, no si el corte quedó
bueno, así que un bloque puede estar clavado donde decía la nota y cortar a mitad
de frase igual. Medido: los mismos 52 defectos moviendo 126 bordes en vez de 98, y
si además se le deja preguntar al modelo, 114 consultas para terminar con uno más.

Con la medición cerrada, las variantes perdedoras **se borraron** en vez de
quedar como palancas: el banco que las comparaba y las opciones `contexto`,
`mirar`, `preguntar` y `ordenes` de `cut-refine`. Una rama que producción no
ejecuta nunca es código que igual hay que leer, probar y no romper; los números
quedan acá y en el historial, que es donde se consultan.

La historia siguió: `clase-entera.js` VOLVIÓ del historial cuando aparecieron
los proveedores de ventana grande — exactamente el "si algún día se re-mide con
otro modelo, la rama se saca de git" que decía este párrafo. Pero volvió como
capacidad, no como opción: se enciende sola cuando el cliente declara
`contextoGrande`, y con el modelo local sigue apagada, que es lo que la
medición dijo.

### Cuánta ventana se le pide a Ollama

`num_ctx` se calcula del largo del prompt en vez de ir fijo
([engine/ai-local.js](engine/ai-local.js)). Importa porque Ollama, cuando el
prompt no le entra, **no falla**: descarta el principio y contesta igual, y un
prompt que se cayó a la mitad se ve idéntico a uno que entró entero. Fijar un
número tampoco servía: medido, el default de Ollama aguanta ~20k tokens, así que
pedir 16384 le **bajaba** el techo en vez de subírselo.

### Por qué la transcripción va sin VAD

Whisper puede correr con un detector de voz delante, que le recorta el audio a
los pedazos donde hay habla. Suena a mejora y estuvo puesto un tiempo, pero
después remapea los tiempos al reloj original y ese remapeo los arruina. Sobre
una clase entera, medido:

|                                        | con VAD | sin VAD |
| -------------------------------------- | ------: | ------: |
| palabras                               |   3 693 |   5 119 |
| duración de exactamente 0,10 s         |     788 |     147 |
| empiezan antes de que termine la previa |     540 |       0 |

Las que empiezan antes de que termine la anterior son imposibles —nadie dice tres
palabras en 40 ms— y en el panel se ven como un puñado que pasa de golpe y otra
que se queda clavada, que es justo lo que hay que poder leer para validar un
corte.

Peor: se comía habla. Perdía la charla del director, que es la que el recorte de
muletillas necesita oír, y **desubicaba el contenido**. En la clase 1 daba "En
Spec-Driven Development" arrancando en 249,3; contra la onda del audio se dice en
262,9. Lo que pasa en 249 es el director diciendo "pausa, quiero repetir esa por
favor", diez segundos de silencio y recién ahí la cuenta. Con ese transcript, el
bloque arrancaba sobre la charla del director sin que se notara. Tampoco era más
rápido.

Lo único que el VAD sí evitaba es que Whisper alucine sobre los silencios —el
caso del curso es un "sí," repetido doce veces, cada uno de exactamente 0,94 s,
sobre diecisiete segundos en los que nadie habla—. De eso se ocupa
`collapseLoops`, que colapsa la repetición y ya estaba.

Y el bucle también viene **en frases**, que es lo que no estaba. Whisper rellena
los silencios largos con créditos de subtítulos aprendidos de su entrenamiento: en
la clase 4 escribió *"Andrea Oroz Sincronización"* cuarenta y cinco veces
seguidas, y en la clase 2 *"No hay una entera de chat."* ciento nueve. Ninguna
regla de palabra suelta lo ve —"Andrea" nunca va seguida de "Andrea"— así que
llegaban enteras al guion final, donde el modelo las señalaba, con razón, como
bloques que no dicen nada. Cinco de los treinta y siete hallazgos del curso eran
eso.

Ahora se busca la frase que da vueltas (de dos a seis palabras, tres vueltas
mínimo) y sobrevive **una** sola, no tres como en la palabra suelta: nadie repite
tres palabras idénticas cuatro veces seguidas, y cuando pasa es relleno. Sobre el
curso quita 2.571 palabras, y la comprobación de que no se lleva nada bueno por
delante es que **ningún bloque que se conserva pierde contenido**: los seis que
cambian eran basura al cien por cien —el bloque 5 de la clase 2 pasa de 132
palabras a 1, y las 132 eran la misma frase—. El tiempo del bucle no desaparece,
se lo queda la última palabra que sobrevive, así que la línea de tiempo no se
mueve.

Los transcripts guardados no se rehacen solos: esto entra al **reprocesar**.

El audio se convierte a 16 kHz mono antes de pasárselo. Whisper acepta el
Live-Mix tal cual viene del Rodecaster —48 kHz, estéreo, 24 bits— y lo convierte
por dentro, pero tarda cuatro veces más: en una clase de 42 minutos, 334 s contra
68 s, y la conversión cuesta 12. El texto es el mismo: recortando cuarenta
segundos de las dos fuentes, las palabras salen con menos de 20 ms de diferencia.
De paso, entra igual lo que traiga cualquier otra grabadora.

Se probó borrar directamente las palabras que caen dentro de un silencio medido.
No sirve, y conviene dejarlo escrito para que nadie lo reintente: como la voz
lejana mide igual que el silencio, ese filtro borraba 833 palabras de una clase,
entre ellas la claqueta, que es de donde cuelga todo el alineado.

## El reproductor

La pestaña **Ver la clase** reproduce el corte montado: los bloques uno detrás
del otro, saltándose lo que queda afuera y cambiando de cámara donde el plan lo
pide. Es la forma de juzgar un corte de verdad —en la lista un borde es un
número, y escuchando segundo y medio no se sabe si la clase se entiende de punta
a punta— sin exportar ni abrir Premiere.

Se arma con los bloques que están en pantalla, no con los del disco: mover un
borde o sacar un bloque se ve en el reproductor antes de guardar, que es cuando
sirve. La tira de abajo es la clase montada, con cada bloque en su lugar; hacer
clic en uno lo pone también en la pestaña de cortes, para arreglar ahí lo que se
vio raro acá.

### Cómo se lee la tira

El **fondo** dice con qué se ve el bloque, y son los mismos colores que se
escriben como etiqueta de clip en el XML: la cámara 1 en celeste, la 2 en rosa,
y así hasta ocho ([`CLIP_LABELS`](engine/fcp-xml.js)). O sea que la tira se lee
igual que la secuencia una vez importada, y no hay que traducir nada.

Lo demás va como **líneas dentro del cuadro**, porque son cosas distintas del
"con qué" y antes competían todas por el mismo color de fondo:

- **abajo**, una línea naranja (o roja) en los bloques que conviene revisar,
- **arriba**, una línea clara en los que tienen un comentario.

Debajo de la tira queda una leyenda armada con lo que esa clase usa de verdad:
una clase grabada con una sola cámara no muestra colores que no va a ver nunca.
El comentario también se avisa en la lista de cortes, con un `✎` y cuántos hay.

Con el teclado: **espacio** reproduce y pausa, **←** y **→** van cinco segundos
(con shift, uno), **↑** y **↓** saltan de bloque y **inicio** vuelve al principio.
Van en el documento y no en el reproductor: si dependieran del foco habría que
hacer clic en el video antes de cada atajo. Escribiendo una nota o un comentario
no se disparan, que ahí el espacio es un espacio.

En los bloques que van con el screen recorder, el profesor va en un recuadro
cuadrado con esquinas redondeadas abajo a la derecha, recortado desde el centro
de su cámara. Sale de la vista `PV` del plan, no de un número de cámara fijo, y
no aparece cuando el bloque ya está mostrando esa misma cámara ni cuando la clase
se grabó con una sola. Las dos cámaras traen el mismo mix, así que suena solo la
principal; la del recuadro va muda y se reacomoda si se corre más de un cuarto de
segundo. Medido en una clase: 16 ms de desfase y cero cuadros caídos con las dos
decodificando a la vez.

Esto es del reproductor y **no viaja al XML**: el crop, la escala y la posición se
podrían escribir, pero las esquinas redondeadas no tienen representación en FCP7,
así que el armado del PiP queda para el NLE.

## Leer la clase mientras suena

Al lado del video va el transcript del corte, bloque por bloque, y se alumbra la
palabra que se está diciendo. Leer va mucho más rápido que escuchar: validar un
corte pasa a ser mirar dónde abre y dónde cierra cada bloque, en vez de esperar
a que la clase entera pase en tiempo real. Un clic en cualquier palabra lleva el
video hasta ahí.

El texto es el del corte que está en pantalla, con los bordes que el editor haya
movido, así que lo que se lee es lo que va a salir. Whisper devuelve palabras que
se pisan entre sí, así que "cuál suena ahora" se resuelve como la última que ya
arrancó: buscar la que contiene el segundo prende dos a la vez.

Cada bloque lleva el color de su cámara en el borde izquierdo y en un fondo muy
bajo: los mismos de la tira y de las etiquetas de clip del XML, así que leyendo
se reconoce de qué toma es cada tramo sin bajar la vista a la línea de tiempo.
Va bajo, no lleno, porque encima hay que poder leer.

El divisor entre el video y el texto se arrastra, y cuánto se le da a cada uno
depende de qué se esté haciendo: mirando cortes sobra el panel, revisando la
letra sobra el video. Doble clic vuelve al reparto de fábrica y, con el foco
puesto, las flechas lo mueven de a poco —pero la barra espaciadora sigue
reproduciendo, porque un atajo que depende de dónde se hizo el último clic no es
un atajo. El ancho se recuerda entre sesiones, y
ninguno de los dos puede quedar en nada: al achicar la ventana el texto cede
primero, pero sin pisar lo elegido, así que al agrandarla se recupera.

### Dónde no se dice nada

Leído corrido, un silencio no se ve. El texto dice "En Spec-Driven Development
hay un cambio de paradigma" y el video tarda diez segundos de más en llegar a
"hay", porque en el medio nadie habla. La primera impresión es que el panel va
adelantado del video, cuando los dos están en su lugar y lo que sobra es el aire.

Por eso las pausas se dibujan **dentro del texto**, en el renglón, donde el video
se queda quieto, y la lista de bloques marca cuántos segundos de aire trae cada
uno. Un clic en el aviso lleva el video un segundo antes, que es donde se oye si
la pausa sobra o está haciendo algo.

No se sacan del transcript sino del audio (`engine/silencios.js`). Whisper le
cuelga el silencio al **final** de la última palabra dicha: en una clase,
"Development" figura durando de 250,49 a 261,92 y de esos once segundos se habla
medio. Mirando solo los tiempos de las palabras el hueco no existe, porque no hay
separación entre una y la siguiente.

Se mide sobre el pico del audio contra el percentil 90 de la clase entera —no
contra el máximo, que lo levanta cualquier golpe en la mesa, ni contra el propio
bloque, que si estuviera callado de punta a punta se compararía consigo mismo—.
Un ruidito aislado no parte una pausa en dos.

El pico solo no alcanza, igual. El director habla desde lejos del micrófono y en
el Live-Mix eso mide **exactamente igual que el silencio**: máximo de 0,0040 en
los dos, mientras el profesor llega a 0,10. Con el audio solo, "cuando estés
listo, dame el claqueta 1, clase 1" son quince segundos de nada. Whisper sí lo
oye, así que cada pausa se recorta hasta donde el transcript dice que alguien
vuelve a hablar. Recortar y no descartar: la pausa del bloque 3 termina cuando
arranca la cuenta de "tres, dos, uno", y siguen siendo diez segundos de nada.
Sin ese recorte eran 150 pausas y 17,8 minutos; con él, 70 y 6,1.

Se calculan al transcribir y quedan en `silencios.json`. Mover un borde no lo
invalida, porque las pausas están ancladas al material y no al corte.

### Lo que el editor escribe

Dos cosas, y las dos terminan en el XML como marcador, que es lo que va a leer
quien monte la clase:

- **La nota del marcador** que vino del Rodecaster se puede corregir donde se lee.
  Para cuando alguien revisa, los cortes ya están validados, así que cambiar ese
  texto no mueve ningún borde. Vaciarla vuelve a la original en vez de dejarla en
  blanco.
- **Un comentario** sobre un pedazo del transcript: se selecciona y se comenta.
  Sale como marcador amarillo llamado `Nota`, para distinguirlo de los que puso
  el director de contenido, que conservan su color.

Se guardan solas, sin esperar a "Guardar y regenerar", y mientras se escribe y no
solo al salir del campo: son lo único de una revisión que no se puede volver a
calcular. Viven en `Backup/<clase>_notas.json`, que el pipeline no toca, así que
reprocesar la clase no se las lleva.

Van ancladas al **tiempo de la grabación**, nunca a la posición en el corte: la
grabación no cambia nunca y el corte sí, cada vez que se mueve un borde. Un
comentario sobre material que después quedó afuera no se pierde, pero tampoco
viaja al XML final —un marcador suelto ahí confunde más de lo que ayuda—; vuelve
a aparecer si el bloque se recupera.

Detalles que valen la pena:

- **No se transcodifica nada.** Los archivos del Rodecaster son H.264 en MP4, que
  Chromium reproduce nativo. Abrir uno de 15 GB toma ~110 ms y buscar una
  posición entre 11 y 40 ms, así que los saltos de bloque se sienten sin costura.
- **Un `<video>` por cámara.** Cambiar el `src` obligaría a reabrir un archivo de
  15 GB en pleno corte; con un elemento por cámara el cambio de plano es esconder
  uno y mostrar el otro, y el que sigue se deja ya posicionado mientras el actual
  todavía suena.
- **El audio sale de la cámara.** El Rodecaster graba el mismo mix en el archivo
  de video y en `Live-Mix.wav` (46:53.23 contra 46:53.27), así que usar el
  embebido evita sincronizar dos elementos sin perder nada.
- **El cuadro es un 16:9 propio**, no el contenedor: el recuadro del profesor se
  ancla a la imagen, y anclado afuera quedaría flotando sobre la banda negra
  cuando la ventana es más ancha que el video.
- **El borde del bloque se vigila por cuadro**, no con `timeupdate`: ese avisa
  unas cuatro veces por segundo, y llegar tarde 200 ms cuela en cada corte un
  pedazo de lo que se decidió sacar.

El video llega a la ventana por un protocolo propio, `clase://`, que solo sirve
rutas de una lista blanca y responde por rangos
([engine/media-server.js](engine/media-server.js)). No se usa `file://` porque
habría que apagar `webSecurity`, y no se usa `net.fetch` sobre `file://` porque
ignora el `Range` y devuelve el archivo entero: el video se queda negro esperando
bytes que nunca llegan en el orden que pidió.

> **Cuidado al escribir la interfaz.** La política de seguridad de la ventana es
> `style-src 'self'`, sin `'unsafe-inline'`: un atributo `style="…"` escrito
> dentro de una plantilla de HTML **queda en el DOM y no se aplica nunca**, sin
> ningún error. Los estilos calculados se ponen tocando `.style` desde el código
> (así se pintan la tira de bloques y las barras de progreso).

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

## El trabajo viaja con la clase

Todo lo que produce el pipeline vive en `The Cutter/Backup/`, y ese `The Cutter`
cuelga de la carpeta que se arrastró a la app. Ahí estaba el problema: **la misma
clase, arrastrada de otra manera, era una clase nueva**. Se procesa el día 1
soltando `Day_1/`; al día siguiente se graba el día 2 y se suelta el curso entero
para tenerlos juntos; y las trece clases del día 1 aparecen sin procesar, porque
su `The Cutter` quedó dentro de `Day_1/`, que ahora es una subcarpeta. Una hora
de Whisper por delante para volver a obtener exactamente lo mismo.

Así que al terminar, cada clase guarda su trabajo **dentro de su propia carpeta**,
al lado del XML del Rodecaster, en `class-cut.json`
([engine/estado-clase.js](engine/estado-clase.js)). Ahí no depende de por dónde se
entre: la carpeta se puede mover, renombrar el día o meter en otro curso, y lo
hecho va con ella.

Y va el trabajo entero —transcript, alineado, plan de cortes, coherencia,
silencios y notas—, no un recibo que diga "ya se procesó". Un recibo con la fecha
evita repetir el trabajo solo mientras el original siga a mano; en cuanto la
carpeta se mueve, apunta a un sitio que ya no existe y el trabajo se perdió
igual. Guardarlo completo cuesta ~0,5 MB contra los gigas de video que tiene al
lado, y a cambio la regla es simple: **mover la carpeta no pierde nada**.

Al procesar, lo guardado vuelve al `Backup` de la raíz nueva antes de empezar. No
se le enseñó a cada etapa a buscar en dos sitios: se deja el `Backup` como si la
clase ya se hubiera procesado ahí y el resto del pipeline sigue igual. Lo que ya
esté en esa raíz no se pisa —es de una corrida más reciente—. El visor hace lo
mismo al abrir, así que se puede revisar una clase procesada desde otra carpeta
sin volver a procesarla.

Lo que no se da por bueno es un trabajo hecho sobre otro material. Se guarda la
huella (tamaño y fecha) del XML y del `Live-Mix`: si el CD movió un marcador y
volvió a exportar, o si se regrabó el audio, la clase pasa a **"hay que
rehacerla"** y lo guardado no se usa. Reusar un transcript de otro audio no
falla, que sería lo cómodo: miente.

En la tabla se ve antes de apretar nada —cuáles están hechas y de cuándo, y el
pie dice cuántas van a tardar segundos y cuántas van desde cero—. **Reprocesar**
tira lo guardado y lo hace todo de nuevo; como eso son horas, pregunta primero.

Las notas y los bordes movidos a mano no esperan a la próxima corrida: se meten
en el archivo apenas se guardan. Son lo único de todo esto que no se puede
recalcular.

## Estado

Funciona de punta a punta contra el curso real (3 días, 13 clases): se agrega la
carpeta, se procesan las clases y salen los XML cortados, revisables antes de
exportar. Las herramientas y el modelo ya viajan dentro de la app; lo que queda
es empaquetar el `.pkg` (ver **Distribución**).

Medido sobre ese curso: 8h18m de material crudo → 1h28m de tomas buenas en 174
bloques, en 19 minutos de proceso, con el 95% de los marcadores anclados al
audio.

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

# Un atajo hay que probarlo con un clic y una tecla de verdad:
npx electron . --folder=… --js="…" --click=756,234 --key=Space --js-despues="…"
```

`--click` y `--key` mandan eventos reales, y esa es toda la gracia: `elemento.click()`
no mueve el foco como lo mueve el mouse y un `new KeyboardEvent` no arrastra la
acción del navegador, así que el scroll de la barra espaciadora —justo lo que se
quiere ver— no aparece nunca. Con eventos fabricados, un atajo roto se ve sano.

Y para mirar una pantalla que solo existe después de procesar un curso —horas—
hay fixtures que la pintan con datos puestos a mano, sin tocar las carpetas de
nadie:

```bash
npx electron . --shot=/tmp/guion.png --js="$(node tools/ver-guion.js)"
```

### Estructura

```
main.js · preload.js     Electron (el motor corre en el proceso principal)
src/js/                  ventana: un módulo por paso, sin frameworks
  app.js                 solo el cableado: qué botón llama a qué
  vista-carpeta · vista-clases · vista-corrida    pasos 1 a 3
  visor/                 paso 4: onda, bordes, guion y reproductor
    pista.js             la clase cortada como una sola línea de tiempo
    reproductor.js       reproducirla saltando bloques y cambiando de cámara
    letra.js             el transcript repartido en bloques, palabra por palabra
    panel-letra.js       el panel que se alumbra y donde se comenta
    division.js          el reparto de espacio entre el video y el texto
engine/
  course-scan.js         descubre clases por firma de estructura
  rodecaster-xml.js      parser de marcadores (pares IN/OUT, claqueta, cues)
  media-probe.js         duración y frame rate reales con ffprobe
  transcribe.js          Whisper local, palabra por palabra
  decidir.js             de las palabras a los bloques decididos
  align.js               claqueta, anclaje de cada marcador e invariantes
  speech-edges.js        habla del director, límites de palabra, cierre de frase
  cut-refine.js          candidatos de corte y elección (regla o IA)
  orden-del-cd.js        las órdenes de corte escritas en la nota
  repeticiones.js        lo que se dice dos veces, quitado una
  coherence.js           guion final y revisión de sentido
  repasar.js             arregla lo que la lectura encontró y vuelve a leer
  borde.js               mover un corte y dejarlo medido contra la onda
  ai-local.js            cliente de Ollama, con todo lo que dice validado
  ollama-server.js       levanta el modelo propio y elige cuál usar
  ollama-store.js        dónde están Ollama y sus modelos en esta máquina
  notas.js               lo que escribe el editor, anclado a la grabación
  estado-clase.js        el trabajo hecho, guardado dentro de la carpeta de la clase
  silencios.js           dónde no se dice nada, medido sobre el audio
  cutplan.js · export.js · fcp-xml.js    plan de cortes y XML de salida
  media-server.js        sirve el video a la ventana, por rangos y con lista blanca
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

La IA es opcional y también local. Para desarrollo, cualquier Ollama con un
modelo de la lista de `ollama-server.js` sirve; la app lo detecta solo:

```bash
brew install ollama && ollama pull qwen3:4b
```

Los modelos: `ggml-large-v3-turbo.bin` (1,5 GB) y `ggml-silero-v5.1.2.bin`
(885 KB), de los repos `ggerganov/whisper.cpp` y `ggml-org/whisper-vad` en
Hugging Face. Se pueden apuntar con `CLASSCUT_WHISPER_MODEL` y `CLASSCUT_VAD_MODEL`.

## Distribución

La app no le pide nada al editor: trae ffmpeg, ffprobe, whisper-cli, los modelos
de Whisper y VAD, y su propio Ollama con un modelo. Dos scripts la arman:

```bash
brew install cmake              # solo para compilar whisper.cpp
bash tools/bundle-binaries.sh   # ffmpeg, ffprobe y whisper-cli
bash tools/bundle-ollama.sh     # Ollama + qwen3:4b
```

**whisper-cli se compila, no se copia.** El paquete de Homebrew trae la carpeta
de sus backends (Metal, BLAS, CPU) compilada adentro del binario, así que
reubicado seguía cargando los de `/opt/homebrew` junto con la librería del
bundle; con dos copias de ggml en el mismo proceso los dispositivos se registran
en una y se buscan en la otra, y aborta con `GGML_ASSERT(device) failed`. No hay
variable de entorno que apague esa ruta. Compilado con los backends enlazados
adentro y el shader de Metal embebido, el problema no existe: no hay ninguna
carpeta que encontrar. Quedan 3 MB que solo dependen de frameworks del sistema.

Se apunta a la línea base de Apple Silicon (`armv8.2-a+dotprod+fp16`) y no a la
máquina que empaqueta: un binario hecho en un M3 usa instrucciones (`i8mm`) que
en un M1 son ilegales, y eso no se descubre hasta que le revienta al editor.

**Ollama entra en 44 MB** adelgazando `ollama` y `llama-server` a arm64; el resto
de Ollama.app son backends de MLX y variantes de CPU de Intel que acá no se usan.
Van los dos binarios porque el servidor busca a `llama-server` como hermano suyo:
separarlos lo deja corriendo en CPU sin avisar. Corre en un puerto propio, nunca
el 11434, para no pelearle nada a la instalación que el editor ya tenga —y si esa
instalación tiene un modelo más grande, se usa ése.

### Los modelos viven fuera de la app

Los modelos son 3.8 de los 3.9 GB y son idénticos en todas las versiones; el
código que de verdad cambia son unos pocos megas. Si viajaran dentro del `.app`,
cada actualización sería bajar cuatro gigas para cambiar unos kilobytes, y peor:
reemplazar el `.app` los borraría y habría que reinstalarlos igual.

Así que el instalador los deja una sola vez en `/Library/Application Support/Class Cut`
y ahí se quedan. `paths.dataDirs()` los busca primero ahí y solo después adentro
del bundle, para no romper las instalaciones viejas.

`npm run build` arma dos instaladores:

| | qué lleva | cuándo |
|---|---|---|
| `ClassCut-<v>-arm64.pkg` | app + modelos · 3.8 GB | máquina nueva |
| `ClassCut-<v>-arm64-update.pkg` | solo la app · 146 MB | lo que baja el botón |

El completo se pasa a mano —disco, Drive—: GitHub no acepta archivos de más de
2 GiB en un release. El de actualización sí entra, y es el único que la app
necesita bajar sola.

El de actualización se instala **encima** de lo que ya está: reemplaza el `.app`
y no toca nada más, así que los modelos, los binarios y las carpetas de trabajo
quedan intactos. Si alguna versión futura necesitara un modelo o un binario que
antes no existía, ese PKG no lo trae; el chequeo de arranque lo detecta y lo
dice en **Diagnóstico**, y esa versión hay que instalarla con el completo.

## Actualizaciones

```bash
npm run build      # los dos PKG en dist/
npm run publish    # sube el de actualización como release del repo
```

**El número de versión es el botón.** Está siempre, al lado del nombre, y siempre
se puede tocar: apagado dice en qué versión estás; cuando hay una nueva se
enciende en verde con un punto y la ventana cuenta cuál es, qué trae y cuánto
pesa.

Antes eran dos cosas —un número apagado en la esquina y un botón verde que
aparecía solo cuando había novedades— y esconder el botón tenía un problema:
cuando no está, no hay dónde preguntar. Si la consulta del arranque falló porque
esa mañana no había internet, no quedaba forma de reintentar, ni de saber en qué
versión estabas sin abrir Diagnóstico.

La consulta se hace sola al arrancar y cada seis horas, siempre en silencio: si
no hay nada, o no hay internet, no pasa nada y la app sigue cortando clases. A
mano se pide desde el mismo botón —o desde **Diagnóstico**, que es donde se mira
cuando algo no anda—, y ahí sí contesta siempre, aunque la respuesta sea que no
hay nada.

**No usa `electron-updater` a propósito.** Ese instala solo, pero en macOS valida
que la firma del build nuevo case con la de la app corriendo, y sin un Developer
ID de Apple la firma es ad-hoc: su identificador cambia en cada compilación y la
validación falla. Antes que un botón que a veces no hace nada, esto baja el PKG a
Descargas, cierra la app y abre el instalador. El día que haya certificado, el
camino de un clic se puede volver a mirar.

Al instalar, la app se cierra sola: el instalador reemplaza ese mismo `.app` y lo
que quedara corriendo sería una app cuyos archivos en disco ya no son los suyos.
Nunca se cierra a mitad de un curso; ahí avisa y espera.

Para probar el flujo sin publicar nada, `CLASSCUT_UPDATE_BASE` apunta la consulta
a un servidor local.

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
