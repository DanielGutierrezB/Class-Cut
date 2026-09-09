'use strict';
/**
 * maqueta/cc.js — El puente de Electron, de mentira, para mirar el diseño.
 *
 * Lo carga `tools/maqueta.js` antes que `app.js`. Pone un `window.cc` con las
 * mismas funciones que expone `preload.js`, contestando de memoria: la interfaz
 * corre entera en un navegador común, sin Electron, sin Node y sin material.
 *
 * Cuatro reglas al escribir esto:
 *
 *   1. **La forma es la de verdad.** Cada objeto de acá tiene los campos que el
 *      motor devuelve, con sus unidades —segundos en la revisión, milisegundos
 *      de reloj en la grabación—. Un campo inventado se ve bien acá y explota
 *      en la app, que es peor que no tener maqueta.
 *
 *   2. **Lo que allá se niega, acá se niega.** Con el mismo motivo y con las
 *      mismas palabras, porque el texto del error es pantalla. Una maqueta que
 *      dice que sí a todo deja aprobar gestos que la app rechaza, y el estado de
 *      error —que es la mitad del diseño de un formulario— no se dibuja nunca.
 *
 *   3. **Lo que allá tarda, acá tarda.** Hay renglones que existen SOLO mientras
 *      algo está en vuelo —"Terminando…", "midiendo", la cobertura sin medir— y
 *      contestando al instante no aparecen. Los tiempos van comprimidos y está
 *      dicho dónde (ver "Lo que tarda", más abajo).
 *
 *   4. **Los casos se eligen, no se repiten.** Cuatro clases iguales no dicen
 *      nada del diseño. Hay una procesada y al día, una que hay que rehacer, una
 *      sin procesar, una que no se puede procesar, una carpeta con avisos y otra
 *      con una clase repetida. En la revisión hay bloques de confianza baja,
 *      hallazgos ya corregidos y comentarios encima del transcript, porque son
 *      los estados que en el uso normal aparecen de a poco y nunca juntos.
 *
 * No es un simulador: nadie corta nada, nada se guarda en disco. Guardar
 * contesta que sí y devuelve lo que la pantalla necesita para seguir dibujando.
 *
 * Y lo que la maqueta NO imita, a propósito, para no tener que averiguarlo dos
 * veces: no abre ni cierra tomas sola —el reparto se elige, y uno que cambia
 * debajo de la mano no se puede juzgar—, no oye el micrófono ni dibuja la onda
 * con lo que entra, y no reparte el trabajo entre procesos. Nada de eso cambia
 * lo que la pantalla puede ver.
 */

(function () {

// El reparto de bloques sale de `maqueta/plan.js`, que es el mismo del que sale
// el audio: si cada uno tuviera el suyo, se oiría silencio donde la onda dibuja
// sonido y no se podría juzgar nada que dependa de la sincronía.
const plan = window.maquetaPlan;

const MEDIA = { camara1: '/media/camara-1.mp4', camara2: '/media/camara-2.mp4', liveMix: '/media/live-mix.wav' };
const DURACION_SEC = plan.DURACION_SEC;
const CURSO = '/Cursos/2609_curso-de-prueba';
const TALLER = '/Cursos/2610_taller-corto';

/**
 * Una carpeta reciente que vive en un disco que no está enchufado.
 *
 * Está a propósito y con una ruta larga: es el caso que no aparece nunca cuando
 * uno mira el diseño con material propio —el disco está enchufado, siempre— y es
 * justo el que hay que poder mirar. De paso muestra la ruta plegada haciendo su
 * trabajo, que con `/Cursos/xxx` no se ve.
 */
const AFUERA = '/Volumes/Rushes 2026/Clientes/Fundación Norte/Cursos/2508_taller-de-guion';

/**
 * Los ajustes de la maqueta, que se acuerdan de lo que se les guardó.
 *
 * Acá `ajustesLeer` armaba un literal nuevo en cada llamada y `ajustesGuardar`
 * pegaba el cambio sobre una copia que se tiraba en la misma línea. El gesto que
 * lo mostraba era «Quitar de la lista»: guarda la lista sin esa carpeta y
 * enseguida relee (`cargar()` en `grabar/grabadas.js`), y la relectura devolvía
 * el literal entero, con la carpeta de vuelta antes de que la pantalla llegara a
 * pintarse sin ella. La app de verdad escribe el JSON en disco, así que ahí la
 * carpeta se iba y se quedaba ida; en la maqueta el botón parecía no andar.
 *
 * Ojo con lo que esto significa: un mock que contesta siempre lo mismo no es un
 * mock más simple, es uno que no puede reproducir ningún gesto que guarde.
 */
let ajustes = {
    version: 1,
    notasDir: CURSO,
    notasDirs: [CURSO, TALLER],
    carpetasRecientes: [CURSO, AFUERA, TALLER],
    ia: {
        proveedor: 'cursor',
        local: { modelo: null },
        cursor: { modelo: 'claude-sonnet-5-thinking-high' },
        anthropic: { modelo: 'claude-sonnet-4-5' }
    },
    secretos: { anthropic: false }
};

// Las vistas de verdad, servidas por `tools/maqueta.js` desde
// `engine/notas-vivo.js`. Acá había una copia y se quedó vieja: la maqueta
// seguía ofreciendo `SL` y `SR` cuando la app ya ofrecía `S`, así que el diseño
// se miraba con un selector que no existía.
const VISTAS = window.maquetaVistas.VISTAS;
const COLOR = Object.fromEntries(VISTAS.map(v => [v.nombre, v.colorDeMarcador]));

// Cómo se reparte la carpeta de notas, también servida desde el motor
// (`workspace.js`). Acá estaba escrita plana —el XML y el sidecar sueltos en la
// raíz— de cuando la carpeta no tenía forma, así que la maqueta enseñaba dónde
// caían las cosas hace dos versiones.
const NOTAS = window.maquetaNotas;

/**
 * Los números con los que el motor se mueve, servidos desde el motor
 * (ver `numerosDelMotor` en `tools/maqueta.js`): cada cuánto empuja el estado y
 * los mínimos del empalme. Por lo mismo que las bandas de lengua: escritos a
 * mano acá, la maqueta se movía a un ritmo y ofrecía ajustes que la app no.
 */
const MOTOR = window.maquetaMotor;

/** El XML y el sidecar de una clase de notas, donde la app los va a poner. */
function archivosDeNotas(carpeta, nombre) {
    return {
        xml: `${carpeta}/${NOTAS.xml}/${nombre}.xml`,
        json: `${carpeta}/${NOTAS.datos}/${nombre}${NOTAS.sufijo}`
    };
}

const espera = ms => new Promise(r => setTimeout(r, ms));

/* ─── Lo que tarda ───────────────────────────────────────────────────────
 *
 * El motor no contesta al instante y la maqueta tampoco puede, porque hay
 * estados de la pantalla que existen SOLO mientras algo tarda: "Terminando…",
 * "Leyendo la toma 4 con el modelo…", el temario midiéndose. Contestando ya, esos
 * tres renglones no aparecen nunca y no se pueden aprobar.
 *
 * **Los dos números están comprimidos y es la única mentira a propósito de este
 * archivo.** Allá una consulta al modelo tarda del orden de dos minutos
 * (`LIMITE_MS` en `engine/lengua.js` y en `engine/empalme.js`, medido, no
 * estimado) y el cierre de la sesión, lo que tarde releer las tomas pendientes.
 * Una maqueta que hiciera esperar dos minutos para ver un renglón no se usaría, y
 * no hacerlos esperar nada es lo que había. Lo que importa de estos números es el
 * ORDEN —que se vea el estado de espera y que se lo pueda mirar quieto— y no su
 * valor, así que se comprimen y queda dicho acá.
 */
const DEMORA_DEL_MODELO_MS = 8000;
const DEMORA_DE_CIERRE_MS = 2500;
/** Lo que tarda releer una toma con el modelo grande, por toma. */
const DEMORA_DE_RELECTURA_MS = 700;

/* ─── El transcript ──────────────────────────────────────────────────────
 *
 * Frases de verdad y no "lorem ipsum": el panel del guion, el karaoke y la caja
 * de comentarios se juzgan por cómo cae el texto, y un texto falso cae distinto
 * —no tiene comas, ni palabras largas, ni frases que se pasan de renglón—.
 */

// A qué ritmo se llenan las tomas de la maqueta, en palabras por minuto de toma.
// Es el del curso de verdad medido con `tools/medir-lengua.js`, y tiene que
// seguir siendo el mismo que usa `lenguaDe` más abajo: son los dos números que
// el panel muestra uno al lado del otro.
const RITMO_DE_HABLA = 160;

const GUION = [
    'Bueno, arrancamos. Hoy vamos a ver cómo se arma un flujo de trabajo con el editor y qué cosas conviene automatizar desde el principio.',
    'Lo primero que quiero mostrarles es la diferencia entre pedirle algo puntual y darle contexto de todo el proyecto. Son dos formas de trabajar completamente distintas.',
    'Fíjense acá en la pantalla. Cuando abro el panel de la derecha, lo que estoy haciendo es darle acceso a los archivos que están abiertos en este momento.',
    'Esto que ven es lo que llamamos spec driven development, y es probablemente el cambio más grande en la forma de escribir código de los últimos años.',
    'Ahora, ojo con esto, porque acá hay una trampa. Si ustedes le dan demasiado contexto, el modelo se pierde y empieza a tocar cosas que nadie le pidió.',
    'Entonces la regla es: contexto suficiente, no contexto máximo. Y suficiente quiere decir los archivos que de verdad importan para lo que estás pidiendo.',
    'Vamos a hacer un ejercicio. Quiero que abran su editor y creen un archivo de reglas, así, en la carpeta raíz del proyecto.',
    'Adentro de ese archivo van a escribir tres cosas: qué hace el proyecto, cómo se corren las pruebas, y qué convenciones de nombres usan.',
    'Alguien me preguntaba en el chat si esto reemplaza la documentación. La respuesta corta es que no, pero la respuesta larga es más interesante.',
    'La documentación la lee una persona una vez cada seis meses. Esto lo lee la máquina en cada pedido que le hacés, así que se mantiene solo porque duele cuando está mal.',
    'Miren lo que pasa cuando lo corro sin las reglas puestas. Me inventa un nombre de función que no sigue ninguna convención de las que usamos acá.',
    'Y ahora con las reglas. Misma pregunta, mismo archivo, y el nombre que sale ya es el que hubiéramos escrito nosotros. Esa es toda la diferencia.',
    'Les dejo un momento para que lo prueben y después seguimos con la parte de pruebas automáticas, que es donde esto se pone realmente interesante.',
    'Retomamos. Lo que quedaba pendiente era ver cómo se le pide que escriba las pruebas antes que el código, y no al revés como estamos acostumbrados.'
];

/**
 * Palabras con su tiempo, en segundos de la grabación.
 *
 * Se reparten a ritmo de habla —unas dos palabras y media por segundo— con una
 * pausa extra en cada punto. Eso importa para el diseño: el karaoke se ve mal
 * justamente en las pausas, y con palabras equiespaciadas ese caso no aparece.
 */
function palabrasDe(bloques) {
    const words = [];
    const segments = [];
    let frase = 0;

    for (const b of bloques) {
        let t = b.sourceStartSec + 0.6;
        while (t < b.sourceEndSec - 1) {
            const texto = GUION[frase % GUION.length];
            frase++;
            const desde = t;
            const partes = texto.split(' ');
            for (const p of partes) {
                if (t >= b.sourceEndSec - 0.4) break;
                // Las palabras largas duran más, y después de un punto hay aire.
                const dura = 0.20 + p.length * 0.028;
                words.push({ start: Number(t.toFixed(2)), end: Number((t + dura).toFixed(2)), text: p });
                t += dura + (/[.,;:]$/.test(p) ? 0.26 : 0.06);
            }
            segments.push({ start: Number(desde.toFixed(2)), end: Number(t.toFixed(2)), text: texto });
            t += 0.5;
        }
    }
    return { words, segments };
}

/* ─── La clase que se revisa ─────────────────────────────────────────────── */

// El color es lo único que el plan no trae: es cosa de las vistas, no del corte.
const SEGMENTOS = plan.segmentos().map(s => ({ ...s, color: COLOR[s.view] }));
const REMOVIDOS = plan.removidos(SEGMENTOS);
const TEXTO = palabrasDe(SEGMENTOS);
const VIEW_MAP = plan.VIEW_MAP;

const picos = (desdeSec, hastaSec, cuantos) => plan.picos(SEGMENTOS, desdeSec, hastaSec, cuantos);

function claseEnRevision(id, clase) {
    return {
        ok: true,
        sequenceName: `0${clase}_curso-de-prueba_2026-09-0${clase}_13-0${clase}-00`,
        classNumber: clase,
        durationSec: DURACION_SEC,
        fps: 30,
        liveMixPath: `${id}/Audio/Live-Mix.wav`,
        liveMixUrl: MEDIA.liveMix,
        cameras: [
            { index: 0, name: '1_CAMERA 1.mp4', url: MEDIA.camara1 },
            { index: 1, name: '2_CAMERA 2.mp4', url: MEDIA.camara2 }
        ],
        cutplan: {
            version: 1,
            createdAt: '2026-09-08T13:40:00.000Z',
            fps: 30,
            durationSec: DURACION_SEC,
            viewMap: VIEW_MAP,
            cameras: [
                { index: 0, name: '1_CAMERA 1.mp4', path: `${id}/Video/1_CAMERA 1.mp4`, used: true },
                { index: 1, name: '2_CAMERA 2.mp4', path: `${id}/Video/2_CAMERA 2.mp4`, used: true }
            ],
            audios: [
                { index: 0, name: 'Live-Mix.wav', path: `${id}/Audio/Live-Mix.wav`, isLiveMix: true, enabled: true },
                { index: 1, name: '1_COMBO-1.wav', path: `${id}/Audio/1_COMBO-1.wav`, isLiveMix: false, enabled: false }
            ],
            segments: SEGMENTOS.map(s => ({ ...s })),
            removed: REMOVIDOS,
            totals: {
                segments: SEGMENTOS.length,
                kept: SEGMENTOS.filter(s => s.keep).length,
                keepSec: SEGMENTOS.filter(s => s.keep).reduce((a, s) => a + s.durationSec, 0),
                removeSec: REMOVIDOS.reduce((a, t) => a + t.durationSec, 0),
                needsReview: SEGMENTOS.filter(s => s.confidence === 'baja').length
            },
            warnings: [{ code: 'bloque_corto', message: 'El bloque 8 dura menos de un minuto.' }]
        },
        offset: { appliedSec: 8.0, applied: true, source: 'claqueta', confianza: 'alta' },
        refine: null,
        repeticiones: {
            // La forma es la de `engine/repeticiones.js`: `texto` es lo que se
            // quitó y `recorteSec` cuánto duraba, y el guion los muestra los dos.
            hallazgos: [
                {
                    bloque: 3, contra: 4, accion: 'recortar', aplicado: true,
                    timeSec: SEGMENTOS[3].sourceEndSec - 9, recorteSec: 9.0, quedaSec: 39.0,
                    score: 0.91, parecido: 0.88, aplicadoSec: SEGMENTOS[3].sourceEndSec - 9,
                    texto: 'Y ahora con las reglas. Misma pregunta, mismo archivo, y el nombre que sale ya es el que hubiéramos escrito nosotros.'
                },
                {
                    bloque: 5, contra: 6, accion: 'recortar', aplicado: false,
                    timeSec: SEGMENTOS[5].sourceEndSec - 6, recorteSec: 6.0, quedaSec: 46.0,
                    score: 0.62, parecido: 0.58,
                    texto: 'Entonces la regla es: contexto suficiente, no contexto máximo.'
                }
            ],
            stats: { mirados: 8, recortadas: 1, descartadas: 0, deshechas: 0, segundos: 9 }
        },
        retomas: null,
        repaso: null,
        edges: SEGMENTOS.map((s, i) => ({
            index: i,
            in: {
                decidedBy: s.cueIn ? 'conteo' : 'nota',
                reason: s.cueIn ? `Después de "${s.cueIn}"` : 'En el marcador de la nota',
                snap: null, chatterRemoved: null, refine: null, score: null
            },
            out: {
                decidedBy: s.cueOut ? 'pausa' : 'regla',
                reason: s.cueOut ? 'En "Pausa"' : 'Al empezar el bloque siguiente',
                snap: null, chatterRemoved: null, refine: null, score: null
            }
        })),
        coherence: {
            blocks: SEGMENTOS.map((s, i) => ({
                n: i + 1, index: i, view: s.view, note: s.note,
                startSec: s.sourceStartSec, endSec: s.sourceEndSec, durationSec: s.durationSec,
                text: TEXTO.segments.filter(g => g.start >= s.sourceStartSec && g.start < s.sourceEndSec).map(g => g.text).join(' ')
            })),
            // `tipo` sale de la lista de `guion.js`, `fuente` es 'ia' o 'regla', y
            // `corregido` NO es un booleano: es el texto de qué se arregló, que
            // es lo que se muestra en la tarjeta verde.
            findings: [
                {
                    bloque: 2, tipo: 'repetido', gravedad: 'media', fuente: 'regla',
                    detalle: 'La nota pide cortar antes de "spec driven development" y la salida queda después.',
                    corregido: 'Se movió la salida del bloque 2 nueve segundos antes, hasta donde arranca la frase.'
                },
                {
                    bloque: 4, tipo: 'idea_colgando', gravedad: 'alta', fuente: 'ia',
                    detalle: 'El bloque termina a mitad de la explicación del archivo de reglas: la idea queda abierta y el bloque siguiente arranca en otra cosa.',
                    sugerencia: 'Mover la salida hasta después de "qué convenciones de nombres usan".'
                },
                {
                    bloque: 6, tipo: 'conector', gravedad: 'baja', fuente: 'ia',
                    detalle: 'Empieza con "Entonces la regla es" pero lo que explicaba esa regla quedó fuera del corte.'
                },
                {
                    bloque: 8, tipo: 'empalme', gravedad: 'media', fuente: 'ia',
                    detalle: 'La clase cierra anunciando la parte de pruebas, que no llega a grabarse.'
                }
            ],
            wordCount: TEXTO.words.length,
            stats: { bloques: 8, hallazgos: 3 }
        },
        segments: TEXTO.segments,
        words: TEXTO.words,
        reloj: { como: 'dtw', movidas: 412, medianaMs: 84 },
        notas: {
            version: 1,
            sequenceName: `0${clase}_curso-de-prueba`,
            bloques: { 3: { note: 'Revisado a mano: el arranque quedó bien.' } },
            comentarios: [
                {
                    id: 'c-maqueta-1',
                    sourceStartSec: SEGMENTOS[1].sourceStartSec + 12,
                    sourceEndSec: SEGMENTOS[1].sourceStartSec + 16,
                    texto: 'spec driven development',
                    comentario: 'Poner un rótulo acá con el término escrito.',
                    createdAt: '2026-09-08T14:00:00.000Z',
                    updatedAt: '2026-09-08T14:00:00.000Z'
                },
                {
                    id: 'c-maqueta-2',
                    sourceStartSec: SEGMENTOS[4].sourceStartSec + 20,
                    sourceEndSec: SEGMENTOS[4].sourceStartSec + 24,
                    texto: 'contexto suficiente, no contexto máximo',
                    comentario: 'Esta frase va como título de la clase.',
                    createdAt: '2026-09-08T14:02:00.000Z',
                    updatedAt: '2026-09-08T14:02:00.000Z'
                }
            ]
        },
        silencios: {
            nivel: 0.02,
            minimoSec: 2.5,
            tramos: REMOVIDOS.filter(t => t.durationSec >= 2.5).map(t => ({
                desdeSec: t.startSec, hastaSec: t.endSec, duracionSec: t.durationSec
            }))
        },
        waveform: { peaks: picos(0, DURACION_SEC, 1200), durationSec: DURACION_SEC, fromSec: 0, toSec: DURACION_SEC }
    };
}

/* ─── Las carpetas y sus clases ──────────────────────────────────────────── */

function clase(spec) {
    const folder = `${spec.root}/${spec.dayName ? spec.dayName + '/' : ''}${spec.folderName}`;
    return {
        id: folder,
        folder,
        folderName: spec.folderName,
        dayName: spec.dayName || null,
        parent: spec.dayName ? `${spec.root}/${spec.dayName}` : spec.root,
        root: spec.root,
        xmlPath: `${folder}/${spec.sequenceName}.xml`,
        xmlName: `${spec.sequenceName}.xml`,
        xmlAmbiguous: false,
        xmlOptions: null,
        xmlDeNotas: Boolean(spec.deNotasEnVivo),
        videos: [
            { name: '1_CAMERA 1.mp4', path: `${folder}/Video/1_CAMERA 1.mp4` },
            { name: '2_CAMERA 2.mp4', path: `${folder}/Video/2_CAMERA 2.mp4` }
        ],
        audios: spec.sinLiveMix
            ? [{ name: '1_COMBO-1.wav', path: `${folder}/Audio/1_COMBO-1.wav`, isLiveMix: false }]
            : [
                { name: 'Live-Mix.wav', path: `${folder}/Audio/Live-Mix.wav`, isLiveMix: true },
                { name: '1_COMBO-1.wav', path: `${folder}/Audio/1_COMBO-1.wav`, isLiveMix: false }
            ],
        liveMixPath: spec.sinLiveMix ? null : `${folder}/Audio/Live-Mix.wav`,
        timestamp: { key: spec.sortKey, date: '2026-09-08', time: '13-00-00', ms: Date.parse('2026-09-08T13:00:00Z') },
        sortKey: spec.sortKey,
        mtime: 0,
        classNumber: spec.classNumber,
        parte: 1,
        sequenceName: spec.sequenceName,
        timebase: 30,
        mediaTimebase: 29.97,
        deNotasEnVivo: Boolean(spec.deNotasEnVivo),
        markerCount: spec.blockCount * 2,
        blockCount: spec.blockCount,
        views: spec.views,
        blocks: [],
        lastBlockEndSec: DURACION_SEC - 40,
        nominalDurationSec: DURACION_SEC,
        hasClap: !spec.sinClaqueta,
        clapSec: spec.sinClaqueta ? null : 8,
        durationSec: spec.durationSec,
        fps: 30,
        problems: spec.problems || [],
        warnings: spec.warnings || [],
        processable: !(spec.problems || []).length,
        selected: !(spec.problems || []).length,
        duplicate: Boolean(spec.duplicate),
        alreadyProcessed: Boolean(spec.trabajoGuardado),
        processedAt: spec.trabajoGuardado ? spec.trabajoGuardado.procesadaEn : null,
        trabajoGuardado: spec.trabajoGuardado || null
    };
}

const alDia = {
    procesadaEn: '2026-09-08T13:40:00.000Z', sirve: true, porque: '',
    modelo: 'claude-sonnet-5-thinking-high', duracionFinalSec: 459, msProceso: 214000,
    tokens: { informa: true, total: 48200, consultas: 3 }
};
const hayQueRehacerla = {
    procesadaEn: '2026-09-05T10:12:00.000Z', sirve: false,
    porque: 'Cambiaron las notas después de exportar el XML.',
    modelo: 'ggml-large-v3-turbo.bin', duracionFinalSec: 512, msProceso: 402000,
    tokens: { informa: false, total: 0, consultas: 0 }
};

const CARPETAS = [
    {
        ok: true, root: CURSO, rootName: '2609_curso-de-prueba',
        outputDir: `${CURSO}/The Cutter`, writable: true,
        kind: 'course', dayCount: 2, dayNames: ['Day_1', 'Day_2'],
        warnings: [],
        classes: [
            clase({ root: CURSO, dayName: 'Day_1', folderName: 'Clase 01 - Default_2026-09-08_1_13-01-47', sequenceName: '01_curso-de-prueba', classNumber: 1, blockCount: 8, views: { PV: 4, R: 3, X2: 1 }, durationSec: 600, sortKey: '20260908-130147-001', trabajoGuardado: alDia }),
            clase({ root: CURSO, dayName: 'Day_1', folderName: 'Clase 02 - Default_2026-09-08_2_14-05-12', sequenceName: '02_curso-de-prueba', classNumber: 2, blockCount: 6, views: { PV: 3, R: 3 }, durationSec: 742, sortKey: '20260908-140512-002', trabajoGuardado: hayQueRehacerla, deNotasEnVivo: true }),
            clase({ root: CURSO, dayName: 'Day_2', folderName: 'Clase 03 - Default_2026-09-09_1_09-30-00', sequenceName: '03_curso-de-prueba', classNumber: 3, blockCount: 9, views: { PV: 5, R: 2, S: 2 }, durationSec: 1204, sortKey: '20260909-093000-003', warnings: [{ code: 'sin_claqueta', message: 'No encontré la claqueta: el ajuste va por la primera palabra.' }], sinClaqueta: true }),
            clase({ root: CURSO, dayName: 'Day_2', folderName: 'Clase 04 - Default_2026-09-09_2_11-15-40', sequenceName: '04_curso-de-prueba', classNumber: 4, blockCount: 0, views: {}, durationSec: 0, sortKey: '20260909-111540-004', sinLiveMix: true, problems: [{ code: 'sin_live_mix', message: 'No hay Live-Mix.wav: sin él no se puede transcribir.' }] })
        ]
    },
    {
        ok: true, root: TALLER, rootName: '2610_taller-corto',
        outputDir: `${TALLER}/The Cutter`, writable: true,
        kind: 'day', dayCount: 1, dayNames: [],
        warnings: [{ code: 'carpeta_suelta', message: 'Esta carpeta es un día, no un curso: las clases van sin agrupar.' }],
        classes: [
            clase({ root: TALLER, folderName: 'Clase 01 - Default_2026-09-10_1_10-00-00', sequenceName: '01_taller-corto', classNumber: 1, blockCount: 5, views: { PV: 3, R: 2 }, durationSec: 488, sortKey: '20260910-100000-001' }),
            clase({ root: TALLER, folderName: 'Clase 01 - Default_2026-09-10_2_10-45-00', sequenceName: '01_taller-corto_p2', classNumber: 1, blockCount: 4, views: { PV: 4 }, durationSec: 322, sortKey: '20260910-104500-002', duplicate: true })
        ]
    }
];

for (const carpeta of CARPETAS) {
    carpeta.classCount = carpeta.classes.length;
    carpeta.processableCount = carpeta.classes.filter(c => c.processable).length;
    carpeta.totalDurationSec = carpeta.classes.reduce((a, c) => a + (c.durationSec || 0), 0);
    carpeta.accion = 'agregar';
    carpeta.reemplaza = [];
}

const PROCESABLES = CARPETAS.flatMap(c => c.classes).filter(c => c.processable);

/* ─── La toma de notas en vivo ───────────────────────────────────────────── */

const CERO = Date.parse('2026-09-08T13:00:00');

const palabra = (ms, texto) => ({ t: ms, texto });

/**
 * Una toma que empieza a `desdeSec` de que arrancó su clase.
 *
 * El cero va como parámetro y no fijo porque cada clase grabada tiene el suyo, y
 * con un cero compartido salían tomas de las once de la mañana dentro de una
 * clase que había empezado a las diez: la tarjeta decía que había durado tres
 * horas. Los tiempos de una toma son horas del día, no del reloj de la app.
 */
/**
 * La calidad del lenguaje de una toma (`engine/lengua.js`).
 *
 * **Los números no se cuentan sobre las palabras de la maqueta, se declaran
 * acá.** Son los del curso de verdad: 168 palabras por minuto de habla, una
 * muletilla cada tanto y un 5% de aire. Lo que sí importa es que las tomas se
 * llenen al mismo ritmo (`RITMO_DE_HABLA`, arriba), porque el bloque "La sesión"
 * sí cuenta sobre las palabras y los dos ritmos se muestran uno al lado del otro:
 * si se separan, la pantalla parece rota por culpa de la maqueta.
 *
 * Adentro, la forma es la de verdad: `det` es lo determinista y `ia` es lo que
 * contestó el modelo, con su estado propio. Es lo que deja mirar el bloque con
 * la mitad de arriba puesta y la de abajo caída, que es como se va a ver el día
 * que no haya proveedor.
 */
function lenguaDe(duraSec, opciones) {
    const o = opciones || {};
    const aire = o.aire == null ? Math.round(duraSec * 0.05) : o.aire;
    const habla = Math.max(1, duraSec - aire);
    const palabras = o.palabras == null ? Math.round(habla * 2.8) : o.palabras;
    const muletillas = o.muletillas == null ? 1 : o.muletillas;
    return {
        det: {
            version: 1,
            palabras,
            duracionSec: duraSec,
            hablandoSec: habla,
            aireSec: aire,
            muletillas,
            cuales: o.cuales || ['o sea'],
            ppm: Math.round(palabras / (habla / 60)),
            muletillasPorMin: Math.round((muletillas / (habla / 60)) * 10) / 10,
            airePct: Math.round((aire / duraSec) * 1000) / 10
        },
        ia: o.ia === undefined
            ? { estado: 'listo', porque: '', modelo: 'claude-sonnet-5-thinking-high', hallazgos: [] }
            : o.ia
    };
}

/**
 * Lo que se dice en una toma de `duraSec`, encadenando renglones del guion.
 *
 * Uno solo no alcanza: son unas 25 palabras, y estirarlas sobre un minuto daba
 * 26 palabras por minuto. El bloque "La sesión" cuenta el ritmo sobre estas
 * palabras y el de lenguaje trae el suyo escrito a mano, así que los dos
 * mostraban "Palabras por minuto" con números que no se parecían —y lo primero
 * que uno piensa mirando la pantalla es que la app está mal, no la maqueta.
 * Encadenando hasta llenar la toma a ritmo de habla, los dos dicen lo mismo.
 */
function loQueSeDice(desdeRenglon, duraSec) {
    const cuantas = Math.max(1, Math.round((RITMO_DE_HABLA * duraSec) / 60));
    const dichas = [];
    for (let n = 0; dichas.length < cuantas; n++) {
        dichas.push(...GUION[(desdeRenglon + n) % GUION.length].split(' '));
    }
    return dichas;
}

function tomaDe(i, desdeSec, duraSec, extra, ceroMs) {
    const cero = ceroMs == null ? CERO : ceroMs;
    const inMs = cero + desdeSec * 1000;
    const outMs = cero + (desdeSec + duraSec) * 1000;
    const dichas = loQueSeDice(i, duraSec);
    const paso = (duraSec * 1000) / (dichas.length + 1);
    return Object.assign({
        id: i + 1,
        vista: ['PV', 'R', 'S', 'PV'][i % 4],
        comentario: '',
        descartada: false,
        cerradaSola: false,
        pausaAdentro: null,
        repiteA: null,
        cuenta: '3, 2, 1.',
        inMs,
        outMs,
        antes: [palabra(inMs - 2400, 'tres,'), palabra(inMs - 1600, 'dos,'), palabra(inMs - 800, 'uno.')],
        palabras: dichas.map((p, n) => palabra(Math.round(inMs + paso * (n + 1)), p)),
        despues: [palabra(outMs + 500, 'Pausa.'), palabra(outMs + 1400, 'Cortá')],
        lengua: lenguaDe(duraSec),
        comentarios: []
    }, extra || {});
}

/**
 * Las bandas con las que un número entra en zona o no, servidas desde
 * `engine/lengua.js` (ver `tools/maqueta.js`).
 *
 * Acá estaban copiadas a mano, con el argumento de que un navegador pelado no
 * puede importar el motor. Podía: el servidor de la maqueta es Node y le pasa lo
 * que haga falta, que es como llegan las vistas. Copiadas, la maqueta podía
 * mostrar en zona un número que en la app estaba fuera, y una maqueta que miente
 * no sirve para aprobar nada.
 */
const BANDAS_DE_LENGUA = window.maquetaLengua.BANDAS;

function zonaDeLengua(clave, valor) {
    const banda = BANDAS_DE_LENGUA[clave];
    if (!banda || valor == null) return null;
    if (banda.desde != null && valor < banda.desde) return 'ojo';
    return valor > banda.hasta ? 'ojo' : 'bien';
}

/**
 * El agregado de la clase, sumando solo las tomas que quedan.
 *
 * Es la misma cuenta que hace `lengua.agregado` del otro lado, y se hace acá
 * porque el motor devuelve el agregado ya calculado: si la maqueta lo escribiera
 * a mano, descartar una toma no movería el número y justo eso es lo que hay que
 * poder mirar.
 */
function agregadoDeLengua(tomas) {
    const medidas = tomas.filter(t => !t.descartada && t.lengua && t.lengua.det);
    const suma = medidas.reduce((a, t) => ({
        palabras: a.palabras + t.lengua.det.palabras,
        hablandoSec: a.hablandoSec + t.lengua.det.hablandoSec,
        aireSec: a.aireSec + t.lengua.det.aireSec,
        duracionSec: a.duracionSec + t.lengua.det.duracionSec,
        muletillas: a.muletillas + t.lengua.det.muletillas
    }), { palabras: 0, hablandoSec: 0, aireSec: 0, duracionSec: 0, muletillas: 0 });

    const minutos = suma.hablandoSec / 60;
    const ppm = minutos > 0 ? Math.round(suma.palabras / minutos) : null;
    const mule = minutos > 0 ? Math.round((suma.muletillas / minutos) * 10) / 10 : null;
    const aire = suma.duracionSec > 0
        ? Math.round((suma.aireSec / suma.duracionSec) * 1000) / 10
        : null;
    // La última de la que el modelo ya habló, igual que el motor: la que todavía
    // se está midiendo no puede encabezar el panel, porque siempre hay una.
    const contestadas = medidas.filter(t =>
        t.lengua.ia && ['listo', 'falla', 'sin-modelo', 'abstenido'].includes(t.lengua.ia.estado));
    const ultima = contestadas[contestadas.length - 1] || null;
    const enCamino = medidas.find(t => t.lengua.ia && t.lengua.ia.estado === 'midiendo');

    const cuenta = new Map();
    for (const t of medidas) {
        for (const cual of t.lengua.det.cuales) cuenta.set(cual, (cuenta.get(cual) || 0) + 1);
    }

    return {
        version: 1,
        tomas: medidas.length,
        sinMedir: tomas.filter(t => !t.descartada && t.outMs != null && !(t.lengua && t.lengua.det)).length,
        abierta: tomas.some(t => t.outMs == null),
        palabras: suma.palabras,
        hablandoSec: suma.hablandoSec,
        aireSec: suma.aireSec,
        ppm,
        muletillasPorMin: mule,
        airePct: aire,
        muletillas: suma.muletillas,
        masDichas: [...cuenta.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
            .map(([cual, veces]) => ({ cual, veces })),
        ultima: ultima ? { toma: ultima.id, ...ultima.lengua } : null,
        midiendo: enCamino ? enCamino.id : null,
        zonas: {
            ppm: zonaDeLengua('ppm', ppm),
            muletillasPorMin: zonaDeLengua('muletillasPorMin', mule),
            airePct: zonaDeLengua('airePct', aire)
        },
        bandas: BANDAS_DE_LENGUA
    };
}

/**
 * Un comentario sobre las palabras que caen en una ventana de la toma.
 *
 * La cita se saca de las palabras que el rango abarca y no se escribe a mano: lo
 * que se subraya arriba sale del rango, así que si el texto fuera inventado la
 * maqueta mostraría una cita señalando otra frase. Justo lo que se está mirando
 * cuando se revisa cómo se ven los comentarios.
 *
 * @param {number} desdeSec segundos desde que empieza la toma, no desde la clase
 */
function comentarSobre(toma, desdeSec, hastaSec, comentario) {
    const dentro = toma.palabras.filter(w =>
        w.t >= toma.inMs + desdeSec * 1000 && w.t <= toma.inMs + hastaSec * 1000);
    if (!dentro.length) return toma;
    toma.comentarios = (toma.comentarios || []).concat([{
        desdeMs: dentro[0].t,
        hastaMs: dentro[dentro.length - 1].t,
        texto: dentro.map(w => w.texto).join(' '),
        comentario
    }]);
    return toma;
}

/* ─── El empalme con la toma anterior ────────────────────────────────────────
 *
 * Lo que sirve `engine/empalme.js` cuando una toma cierra: el profesor volvió a
 * decir al retomar lo que ya había dicho, y hay un ajuste de un clic para
 * sacarlo. La pantalla tiene que dibujar el tramo subrayado como aviso y los dos
 * botones, «Ajustar corte» y «Descartar ajuste».
 *
 * **La forma es la del motor y los tiempos son de verdad.** El tramo va en horas
 * de palabra —así lo ubica el resto de la pantalla, igual que los comentarios y
 * los marcadores— y sale de las palabras que la toma dice acá, no escrito a mano:
 * un subrayado que señala otra frase es justo el error que hay que poder ver.
 *
 * Lo que la maqueta no puede tener es que las dos tomas se repitan de verdad: el
 * guion de arriba es genérico y las tomas se llenan encadenando renglones. O sea
 * que el «porque» está escrito y el tramo es real. Alcanza para dibujar, que es
 * para lo que está esto.
 *
 * Y se rehace al servir, como allá (`paraLaPantalla` se recalcula en cada
 * lectura): si el corte que la sugerencia señala ya no está en la toma anterior
 * —porque se aceptó el ajuste, o porque alguien arrastró el borde— la sugerencia
 * desaparece sola. Eso es lo que hay que poder mirar después de apretar el botón.
 *
 * **Lo guardado y lo que se dibuja son dos cosas, como allá.** En la toma queda
 * lo que se pagó y lo que se apuntó —`empalme.det` de `medir` y `empalme.ia` de
 * la consulta, que es como `medir-toma.js` reparte cada medida— y la vista se
 * arma al servir, en el resumen. Acá estaba al revés: la vista se escribía ENCIMA
 * del campo `empalme` de la toma en cada lectura, así que el descarte no tenía
 * dónde vivir y terminó en un campo suelto con otro nombre. Dos mentiras de una:
 * la forma no era la de allá, y lo que la maqueta guardaba en otro sitio no
 * entraba en la foto del historial igual que allá.
 */

/** Un tramo para subrayar, en horas de palabra: la forma de `empalme.tramo`. */
function tramoDe(id, palabras) {
    if (!palabras || !palabras.length) return null;
    return {
        toma: id,
        desdeMs: palabras[0].t,
        hastaMs: palabras[palabras.length - 1].t,
        texto: palabras.map(w => w.texto).join(' ')
    };
}

/**
 * Dónde abre la última frase que se puede recortar de una toma.
 *
 * Se busca un arranque de frase y no una palabra cualquiera porque es lo que hace
 * el motor: cortar a mitad de frase dejaría la toma anterior colgando, y ahí la
 * sugerencia no sale. Con los mismos dos mínimos, para que el ajuste que la
 * maqueta ofrece sea uno de los que la app ofrecería.
 */
function abreLaUltimaFrase(toma) {
    const dichas = toma.palabras || [];
    for (let i = dichas.length - 1; i > 0; i--) {
        if (!/[.!?…]$/.test(dichas[i - 1].texto)) continue;
        if (toma.outMs - dichas[i].t < MOTOR.empalme.MINIMO_RECORTE_MS) continue;
        if (dichas[i].t - toma.inMs < MOTOR.empalme.MINIMO_QUEDA_MS) break;
        return dichas[i];
    }
    return null;
}

/**
 * Con qué toma va a quedar pegada esta en el XML (`empalme.anterior`).
 *
 * No es "la de antes en la lista": es la de antes que va a QUEDAR. Una descartada
 * no llega al XML, así que la que pega es la anterior a esa. Acá la sugerencia se
 * colgaba de un par escrito a mano, así que descartar la toma del medio no movía
 * nada — y en la app la pregunta pasa a ser otra y la respuesta guardada deja de
 * valer, que es justo lo que hay que poder mirar.
 */
function anteriorDeEmpalme(tomas, toma) {
    if (!toma || toma.descartada) return null;
    const donde = tomas.findIndex(t => t.id === toma.id);
    if (donde < 1) return null;

    for (let i = donde - 1; i >= 0; i--) {
        const previa = tomas[i];
        if (previa.descartada) continue;
        if (previa.inMs == null || previa.outMs == null) continue;
        if ((previa.palabras || []).length < MOTOR.empalme.MINIMO_PALABRAS) continue;
        return previa;
    }
    return null;
}

/**
 * La sugerencia, armada contra las palabras de AHORA y con la aduana puesta.
 *
 * Es `armarSugerencia` de allá: lo guardado es un corte, y antes de mostrarlo hay
 * que volver a preguntar si ese corte se puede hacer. La palabra tiene que seguir
 * en la toma anterior y los dos mínimos tienen que seguir dándose; si no, no hay
 * botón. Sin esta aduana la maqueta ofrecía un ajuste que la app no ofrece.
 *
 * @param {object} pagado lo que contestó el modelo y quedó guardado en la toma
 *   (`empalme.ia.hallazgos`): contra quién, desde qué palabra y por qué.
 */
function armarSugerenciaDeEmpalme(previa, actual, pagado) {
    const dichas = previa.palabras || [];
    const corte = dichas.find(w => w.t === pagado.paredMs);
    // La palabra del corte ya no está en la toma: el borde se movió, o se aceptó
    // el ajuste, y lo que decía la sugerencia dejó de ser cierto.
    if (!corte) return null;
    if (previa.outMs - corte.t < MOTOR.empalme.MINIMO_RECORTE_MS) return null;
    if (corte.t - previa.inMs < MOTOR.empalme.MINIMO_QUEDA_MS) return null;

    const repetido = dichas.filter(w => w.t >= corte.t);
    return {
        origen: pagado.origen,
        porque: pagado.porque,
        enLaAnterior: tramoDe(previa.id, repetido),
        enEsta: tramoDe(actual.id, (actual.palabras || []).slice(0, MOTOR.empalme.CABEZA_PALABRAS)),
        ajuste: {
            tipo: 'borde',
            toma: previa.id,
            borde: 'out',
            paredMs: corte.t,
            quitaSec: Math.round((previa.outMs - corte.t) / 100) / 10,
            palabras: repetido.length
        },
        descartar: { tipo: 'descartar-ajuste', toma: actual.id, contra: previa.id }
    };
}

/**
 * El empalme de una toma tal como se dibuja (`empalme.paraLaPantalla`).
 *
 * Se rehace en cada lectura y no se guarda, que es lo que hace que una sugerencia
 * no pueda quedar hablando de algo que ya no existe.
 */
function empalmeParaLaPantalla(toma, tomas) {
    if (!toma || toma.outMs == null || toma.descartada) return null;
    const previa = anteriorDeEmpalme(tomas, toma);
    if (!previa) return null;

    const guardado = toma.empalme || {};
    const ia = guardado.ia || null;
    const vista = {
        contra: previa.id,
        parecido: guardado.det ? guardado.det.parecido : 0,
        // 'sin-medir' cuando nadie miró todavía; los demás son los del mecanismo
        // ('midiendo', 'listo', 'falla', 'sin-modelo', 'abstenido') y 'descartado'.
        estado: ia ? ia.estado : 'sin-medir',
        porque: ia ? ia.porque : '',
        sugerencia: null
    };

    if (guardado.descartado && guardado.descartado.contra === previa.id) {
        vista.estado = 'descartado';
        vista.porque = 'Descartaste el ajuste de este empalme.';
        return vista;
    }

    const pagado = ((ia && ia.hallazgos) || []).find(h => h && h.contra === previa.id);
    if (pagado) vista.sugerencia = armarSugerenciaDeEmpalme(previa, toma, pagado);
    return vista;
}

// Cuánto lleva grabando la sesión, y en qué segundo abre la toma que sigue en
// curso. Van juntos acá arriba porque el cero en vivo se calcula restando el
// primero a la hora de ahora: si se separan, los relojes y las palabras de la
// toma abierta cuentan contra momentos distintos.
const CORRIDOS = 420;
const ABRE_LA_ULTIMA = 250;

/**
 * La sesión que se está grabando, o null si no hay ninguna.
 *
 * **Null es una respuesta y no un caso raro**, y por eso esto no arma nada solo:
 * del otro lado hay sesión desde "Iniciar grabación" hasta "Terminar" y en
 * ningún otro momento (`sesion` en `engine/grabacion.js`), así que todo lo del
 * puente tiene que saber contestar sin ella. Acá la sesión se armaba a la primera
 * pregunta y no se soltaba nunca, o sea que la maqueta no podía enseñar la
 * pantalla sin nada en curso ni lo que pasa después de terminar.
 *
 * Se arma UNA vez y queda guardada (`enMemoria.sesion`). Antes se rearmaba en
 * cada llamada, y eso hacía que la maqueta mintiera en lo peor: descartar una
 * toma, comentar o mover un borde se dibujaba un instante y desaparecía en el
 * repintado siguiente, porque el estado que contestaba el puente era otra vez el
 * de fábrica. Del lado de la app el motor guarda la sesión, así que acá también.
 */
function sesionEnVivo() {
    return enMemoria.sesion;
}

/**
 * Pone a grabar una sesión, con la clase a medio grabar o con nada.
 *
 * Vacía es como arranca una de verdad (`vivo.estadoNuevo`: `tomas: []`), y es la
 * única forma de mirar quieto el estado vacío de la lista —"Todavía no hay tomas.
 * La primera se abre cuando el profesor cuenta 3, 2, 1"—, que era una pantalla
 * que la maqueta escondía: apretar "Iniciar grabación" contestaba con una clase
 * que ya tenía cuatro tomas grabadas.
 *
 * Con el reparto puesto es lo que abre `?grabando`, y es lo que hay que mirar
 * para juzgar el diseño: una clase en curso con sus casos elegidos.
 */
function ponerAGrabar(cero, conReparto) {
    enMemoria.sesion = armarSesion(cero, conReparto);
    empezarAEmpujar();
    return enMemoria.sesion;
}

/** Suelta la sesión, como `soltar()` allá: de acá en más no hay ninguna. */
function soltarLaSesion() {
    enMemoria.sesion = null;
    // La lista de la SESIÓN se va con ella; la de la carpeta se queda, que es lo
    // que hace que la clase siguiente del mismo curso la encuentre puesta.
    enMemoria.temario = null;
    enMemoria.carpeta = null;
    enMemoria.midiendoTemario = false;
    enMemoria.historia = { atras: [], adelante: [] };
    pararElEmpujon();
}

const ultimo = pila => (pila.length ? pila[pila.length - 1].que : '');

/* ─── Lo que la pantalla recibe ──────────────────────────────────────────
 *
 * `espejo.resumen` de este lado: la sesión mirada desde afuera. La sesión guarda
 * lo que pasó y esto arma lo que se dibuja, y los dos son distintos a propósito
 * —lo que se calcula se calcula en cada lectura (`repiteA`, la lengua agregada,
 * el empalme de la pantalla) para que no pueda quedar viejo—.
 *
 * Que fuera lo mismo era una mentira de forma: el puente devolvía la sesión con
 * campos que el motor no manda y con el empalme de la vista escrito encima del
 * que la toma guarda, así que la pantalla se probaba contra un estado que en la
 * app no existe.
 */

function resumenEnVivo() {
    const s = sesionEnVivo();
    if (!s) return null;
    const abierta = s.tomas.find(t => t.outMs == null);
    return {
        secuencia: s.secuencia,
        clase: s.clase,
        parte: s.parte,
        curso: s.curso,
        ceroMs: s.ceroMs,
        claqueta: s.claqueta,
        vistas: VISTAS,
        dir: s.dir,
        // Dónde van a caer los dos archivos. El motor lo manda con cada resumen y
        // es de donde el cartel de arriba saca la ruta que muestra.
        archivos: s.archivos,
        // Sigue diciendo que sí mientras la sesión exista, incluso cerrando: allá
        // es una constante del resumen y quien decide que se terminó es que no
        // haya sesión, no este campo.
        grabando: true,
        // El temario del CD con su última cobertura, y si hay una medición en
        // vuelo: el panel lo dice mientras tarda.
        temario: enMemoria.temario,
        midiendoTemario: Boolean(enMemoria.midiendoTemario),
        // Cómo viene hablando, agregado sobre las tomas que quedan. Va calculado
        // y no escrito a mano porque del otro lado también lo calcula el motor.
        lengua: agregadoDeLengua(s.tomas),
        terminando: Boolean(s.terminando),
        segundos: s.segundos,
        abierta: abierta ? abierta.id : null,
        historia: {
            atras: enMemoria.historia.atras.length,
            adelante: enMemoria.historia.adelante.length,
            queAtras: ultimo(enMemoria.historia.atras),
            queAdelante: ultimo(enMemoria.historia.adelante)
        },
        tomas: s.tomas.map(t => tomaParaLaPantalla(t, s.tomas))
    };
}

/**
 * Una toma como la manda el motor: sus campos y ninguno más.
 *
 * La lista es la de `espejo.resumen` y está escrita entera a propósito. Antes
 * salía la toma tal como la maqueta la guarda, así que la pantalla veía campos
 * que la app no manda —y podía llegar a dibujar con uno de ellos sin que nada
 * fallara hasta estar en Electron.
 */
function tomaParaLaPantalla(toma, tomas) {
    return {
        id: toma.id,
        vista: toma.vista,
        comentario: toma.comentario || '',
        descartada: Boolean(toma.descartada),
        cerradaSola: Boolean(toma.cerradaSola),
        pausaAdentro: toma.pausaAdentro || null,
        repiteA: toma.repiteA || null,
        cuenta: toma.cuenta || '',
        inMs: toma.inMs,
        outMs: toma.outMs,
        palabras: toma.palabras,
        lengua: toma.lengua || null,
        // Qué le pasó a la relectura, cuando le pasó algo (`engine/insistir.js`).
        // Va acá por lo que dice el comentario de arriba, leído al revés: la lista
        // escrita a mano evita que la pantalla dibuje con un campo que la app no
        // manda, y por eso mismo un campo que la app SÍ manda y que acá falte es
        // un estado que la maqueta no puede mostrar — o sea el único sitio donde
        // se puede mirar el diseño de ese aviso sin grabar una clase entera.
        relectura: toma.relectura || null,
        // Rehecho en cada lectura, como allá: la sugerencia habla de una palabra
        // concreta de la toma anterior, y esa palabra se mueve.
        empalme: empalmeParaLaPantalla(toma, tomas),
        antes: toma.antes || [],
        despues: toma.despues || [],
        comentarios: toma.comentarios
    };
}

function armarSesion(cero, conReparto) {
    const tomas = conReparto ? elReparto(cero) : [];
    if (tomas.length) empalmePagado(tomas);

    return {
        secuencia: '05_curso-de-prueba_2026-09-08_15-20-00',
        clase: 5, parte: 1, curso: '2609_curso-de-prueba',
        ceroMs: cero,
        // La forma entera de `leerClaqueta`: la frase que se oyó alrededor del
        // golpe y de dónde salió. Sin `origen` y sin `frase` el cartel de arriba
        // no podía decir ni qué se oyó ni que la puso una persona, o sea que la
        // mitad de sus estados no se veía.
        claqueta: { ms: cero + 6000, frase: 'Claqueta 5, clase 5.', confirmada: true, origen: 'golpe' },
        dir: CURSO,
        archivos: archivosDeNotas(CURSO, '05_curso-de-prueba_2026-09-08_15-20-00'),
        // Cuánto audio hay escrito. Allá es `captura.segundos` y crece con el PCM
        // que manda la ventana; acá lo mueve el reloj en cada empujón.
        segundos: conReparto ? CORRIDOS : 0,
        terminando: false,
        // El reloj de la sesión: hasta dónde se oyó y por qué renglón del guion va
        // el profesor (ver `seguirHablando`).
        relojMs: Date.now(),
        oidoHastaMs: cero + (conReparto ? CORRIDOS : 0),
        renglon: conReparto ? 4 : 0,
        porDecir: [],
        tomas
    };
}

/**
 * El reparto de la clase en curso: los casos elegidos que hay para mirar.
 *
 * Va aparte de `armarSesion` porque una sesión de verdad arranca sin nada y esto
 * es el atajo para no tener que grabar cuatro tomas antes de poder opinar.
 */
function elReparto(cero) {
    return [
        // Dos comentarios en la misma toma, y no uno: con uno solo el
        // subrayado se explica solo, y lo que hay que poder mirar es cómo se
        // distingue cuál es cuál cuando hay varios.
        comentarSobre(
            comentarSobre(tomaDe(0, 20, 55, null, cero), 6, 13, 'Acá va muy rápido, avisarle'),
            28, 34, 'Sacar un clip corto de esta parte'),
        // La toma que se va de zona, y hace falta que haya una: con todo en
        // verde no se puede aprobar el color del aviso, que es la mitad de que
        // esto sirva. Cuatro muletillas en un minuto y dos hallazgos del modelo,
        // citando lo que la toma dice de verdad —una cita que señala otra frase
        // es exactamente el error que hay que poder ver acá.
        tomaDe(1, 95, 68, {
            comentario: 'Repite el arranque, quedarse con esta',
            lengua: lenguaDe(68, {
                aire: 8,
                muletillas: 4,
                cuales: ['o sea', 'o sea', 'eh', 'este'],
                ia: {
                    estado: 'listo',
                    porque: '',
                    modelo: 'claude-sonnet-5-thinking-high',
                    hallazgos: [
                        {
                            tipo: 'sin_cerrar',
                            que: 'Son dos formas de trabajar completamente distintas.',
                            detalle: 'Anuncia dos formas de trabajar y la toma cierra sin haber explicado la segunda.'
                        },
                        {
                            tipo: 'jerga',
                            que: 'darle contexto de todo el proyecto',
                            detalle: 'Usa «contexto» como término técnico sin decir qué incluye.'
                        }
                    ]
                }
            })
        }, cero),
        // Descartada y con los peores números de la clase a propósito: si el
        // agregado la contara, el ritmo y las muletillas de arriba se irían al
        // demonio, así que su exclusión se ve sin tener que buscarla.
        tomaDe(2, 190, 40, {
            descartada: true,
            repiteA: 2,
            lengua: lenguaDe(40, { aire: 14, muletillas: 9, cuales: ['o sea', 'digamos', 'eh'] })
        }, cero),
        // La última abierta: es la que dibuja "Cerrar acá" y la toma en curso.
        // Sin medición, que es lo que le pasa de verdad: su texto es el del
        // ciclo liviano y se descarta cuando cierre. Dura lo que va del reloj y
        // no un número fijo: mientras está abierta el profesor sigue hablando, y
        // con un largo escrito a mano sus palabras se acababan mientras "La
        // sesión" le seguía sumando segundos, o sea un ritmo cayéndose sola.
        tomaDe(3, ABRE_LA_ULTIMA, CORRIDOS - ABRE_LA_ULTIMA, { outMs: null, lengua: null }, cero)
    ];
}

/**
 * El empalme de la 2 con la 1: lo que el modelo contestó cuando la 2 cerró.
 *
 * **Va colgando de la toma y en los dos campos que allá usa cada medida**: `det`
 * es lo que se apuntó gratis y `ia` lo que contestó el proveedor, que es como
 * `medir-toma.js` reparte todo lo que se mide de una toma. Se guarda el corte y
 * el porqué y no la sugerencia, porque la sugerencia se rehace al servir contra
 * las palabras de ese momento. La 2 ya venía con la nota "Repite el arranque",
 * así que es la que corresponde.
 */
function empalmePagado(tomas) {
    const corte = abreLaUltimaFrase(tomas[0]);
    if (!corte) return;
    tomas[1].empalme = {
        det: { version: 1, contra: tomas[0].id, parecido: 0.62, porRegla: null },
        ia: {
            estado: 'listo',
            porque: '',
            modelo: 'claude-sonnet-5-thinking-high',
            hallazgos: [{
                contra: tomas[0].id,
                origen: 'modelo',
                paredMs: corte.t,
                porque: 'Las dos tomas explican que hay que darle contexto de todo el proyecto y no un pedido puntual.',
                cita: (tomas[0].palabras || []).filter(w => w.t >= corte.t).map(w => w.texto).join(' ')
            }]
        }
    };
}

/* ─── Cambiar la clase en curso, y volver atrás ──────────────────────────
 *
 * Lo mismo que `editarEnMemoria` hace con una clase ya grabada, pero sobre la
 * sesión viva: los cambios se aplican de verdad y se pueden deshacer, porque si
 * no la mitad de lo que hay para mirar en esta pantalla no se puede mirar. Es
 * una copia de la forma del motor (`editar`, `eliminar` y `engine/deshacer.js`)
 * y no de sus reglas: acá alcanza con que el estado cambie donde la app lo
 * cambia, y quién puede hacer qué lo decide allá.
 */

function tomaEnVivo(id) {
    const sesion = sesionEnVivo();
    return (sesion && sesion.tomas.find(t => t.id === id)) || null;
}

const fotoDeToma = t => (t ? JSON.parse(JSON.stringify(t)) : null);

/**
 * Si dos fotos dicen lo mismo, o sea si el cambio cambió algo
 * (`historial.mismaFoto`).
 *
 * Allá se comparan campo por campo porque las fotos comparten los objetos de
 * adentro y no se pueden serializar por cualquier cosa que tengan; acá las fotos
 * ya son un clon de JSON, así que la comparación honesta es la de sus textos.
 * Contesta lo mismo, que es lo único que la maqueta necesita copiar.
 */
const mismaFoto = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Lo que contesta el puente es una COPIA, como del otro lado.
 *
 * El `contextBridge` de Electron manda todo por un canal, así que lo que llega a
 * la ventana es una foto del estado en el momento de contestar y no el objeto
 * que el motor sigue tocando. Acá se devolvía el objeto vivo, y eso escondía una
 * familia entera de defectos: cualquier respuesta atrasada traía igual los
 * cambios de después —eran el mismo objeto—, así que dos gestos rápidos que en
 * la app pueden dejar la pantalla un momento sin el segundo cambio, en la
 * maqueta no fallaban nunca. Una maqueta que no puede mostrar el bug no sirve
 * para probar el arreglo.
 */
const porElPuente = x => (x == null ? x : JSON.parse(JSON.stringify(x)));

/**
 * Un cambio a mano sobre la clase en curso (`cambiosToma.editar`).
 *
 * **Lo que allá no se hace, acá tampoco**, y eso es la mitad del valor de esto:
 * un gesto que la maqueta acepta y la app rechaza deja probar una pantalla que no
 * existe. Los tres que se plantan —el borde que no se movió, reabrir la que no es
 * la última, eliminar una que no está descartada— tienen su porqué al lado.
 *
 * @throws si el tipo de cambio no existe, como `vivo.aplicar`: el canal de allá
 *   no lo atrapa, así que la ventana recibe una promesa rota y no un estado.
 */
function manoEnVivo(cambio) {
    const c = cambio || {};
    const sesion = sesionEnVivo();
    if (!sesion) return null;
    const toma = tomaEnVivo(c.toma);
    if (!toma) return resumenEnVivo();

    const antes = fotoDeToma(toma);

    if (c.tipo === 'vista') toma.vista = c.vista;
    else if (c.tipo === 'nota') toma.comentario = String(c.texto || '');
    else if (c.tipo === 'descartar') {
        toma.descartada = Boolean(c.descartada);
        // Lo que la toma decía deja de contar para la clase, así que un objetivo
        // que estaba cubierto por ella deja de estarlo: allá se vuelve a medir la
        // cobertura en el mismo gesto (`temarioSesion.pedir` en `editar`).
        pedirLaCobertura();
    } else if (c.tipo === 'comentar') {
        toma.comentarios = (toma.comentarios || []).concat([{
            desdeMs: Number(c.desdeMs), hastaMs: Number(c.hastaMs),
            texto: String(c.texto || ''), comentario: String(c.comentario || '')
        }]);
    } else if (c.tipo === 'borrar-comentario') {
        toma.comentarios = (toma.comentarios || []).filter((_x, i) => i !== c.indice);
    } else if (c.tipo === 'descartar-ajuste') {
        // Contra quién se descartó, y no un simple sí: si la toma pasa a empalmar
        // con otra, la pregunta es otra y esta marca no tiene que valer.
        //
        // Y en `empalme.descartado` de la toma, que es donde lo escribe
        // `empalme.descartar`: lo que cuelga de la toma entra en la foto de
        // `fotoDeToma`, así que descartar se deshace con Cmd-Z como todo lo demás.
        //
        // Descartar dos veces el mismo empalme no es un cambio, y allá tampoco lo
        // es: sin esta línea la marca se reescribía con la hora de ahora, que
        // alcanza para que el historial anote un paso que al deshacerse no se ve.
        const marca = (toma.empalme || {}).descartado;
        if (!marca || marca.contra !== Number(c.contra)) {
            toma.empalme = {
                ...(toma.empalme || {}),
                descartado: { contra: Number(c.contra), ms: Date.now() }
            };
        }
    } else if (c.tipo === 'borde') {
        // Un borde que cae donde ya estaba no se mueve, y uno que cruza al otro
        // tampoco: los dos gestos llegan de un arrastre que volvió a su sitio o
        // que se pasó de largo. Del historial se ocupa `anotarEnMemoria`, que ve
        // que la toma quedó igual.
        const estaba = c.borde === 'in' ? toma.inMs : toma.outMs;
        if (c.paredMs != null && Number(c.paredMs) !== estaba) {
            moverElBorde(toma, c.borde, Number(c.paredMs));
        }
    } else if (c.tipo === 'reabrir') {
        reabrirEnMemoria(sesion, toma);
    } else if (c.tipo === 'eliminar') {
        // Sin descartarla antes no se elimina: el botón solo existe en una
        // descartada, así que esto es la red de abajo y se planta en silencio.
        if (toma.descartada) sesion.tomas.splice(sesion.tomas.indexOf(toma), 1);
    } else {
        throw new Error(`Cambio sin definir: ${c.tipo}`);
    }

    // La foto de después es null cuando la toma ya no está en la sesión, y eso se
    // mira en la LISTA y no en el tipo del cambio, igual que allá: un `eliminar`
    // que se plantó deja la toma donde estaba, así que su foto es la de antes y
    // `anotarEnMemoria` no anota nada.
    anotarEnMemoria({
        que: comoSeLlamaEnMemoria(c),
        id: toma.id,
        antes,
        despues: sesion.tomas.includes(toma) ? fotoDeToma(toma) : null
    });
    return resumenEnVivo();
}

/**
 * El borde movido, con las dos reglas de `vivo.moverBorde`: un IN no pasa el OUT
 * y un OUT no pasa el IN. Acá se movía sin preguntar, así que la maqueta dejaba
 * dar vuelta una toma.
 *
 * @returns {boolean} si se movió
 */
function moverElBorde(toma, cual, paredMs) {
    if (cual === 'in' && toma.outMs != null && paredMs >= toma.outMs) return false;
    if (cual === 'out' && toma.inMs != null && paredMs <= toma.inMs) return false;
    repartirEnMemoria(toma, cual, paredMs);
    return true;
}

/**
 * Reabrir: solo la última, y solo si no hay otra abierta (`cambiosToma.reabrir`).
 *
 * Dos tomas abiertas a la vez rompen todo lo demás —el ciclo de señales le mete
 * las palabras a "la abierta" y no hay tal cosa—, así que allá el gesto se planta.
 * Acá reabría cualquiera: la maqueta podía dejar la pantalla con dos tomas en
 * curso, que es un estado que la app no puede tener.
 */
function reabrirEnMemoria(sesion, toma) {
    const tomas = sesion.tomas;
    if (tomas.some(t => t.outMs == null) || toma !== tomas[tomas.length - 1]) return;
    toma.outMs = null;
    toma.cerradaSola = false;
    toma.despues = [];
}

function comoSeLlamaEnMemoria(c) {
    const cual = `la toma ${c.toma}`;
    if (c.tipo === 'vista') return `poner ${cual} en ${c.vista}`;
    if (c.tipo === 'nota') return `la nota de ${cual}`;
    if (c.tipo === 'descartar') return `${c.descartada ? 'descartar' : 'recuperar'} ${cual}`;
    if (c.tipo === 'comentar') return `comentar «${String(c.texto || '').slice(0, 30)}»`;
    if (c.tipo === 'borrar-comentario') return `quitar un comentario de ${cual}`;
    if (c.tipo === 'descartar-ajuste') return `descartar el ajuste de corte de ${cual}`;
    if (c.tipo === 'borde') return `mover el ${c.borde === 'in' ? 'IN' : 'OUT'} de ${cual}`;
    if (c.tipo === 'reabrir') return `reabrir ${cual}`;
    if (c.tipo === 'eliminar') return `eliminar ${cual}`;
    if (c.tipo === 'cerrar') return `cerrar ${cual}`;
    // Los dos que no son de ninguna toma, así que no la nombran.
    if (c.tipo === 'claqueta') return 'poner la claqueta';
    if (c.tipo === 'temario') return `${String(c.texto || '').trim() ? 'pegar' : 'sacar'} el temario`;
    return `el cambio en ${cual}`;
}

/**
 * Anota un paso, si es que hizo algo (`anotar` en `engine/deshacer.js`).
 *
 * El portero está acá y no en cada gesto por lo mismo que allá: así no hay forma
 * de que uno nuevo se olvide de preguntar. Un paso que al deshacerse no se ve
 * hace apretar de nuevo pensando que el botón no funciona, y encima se come el
 * Cmd-Z que iba para el cambio de verdad.
 */
function anotarEnMemoria(paso) {
    if (mismaFoto(paso.antes, paso.despues)) return;
    enMemoria.historia.atras.push(paso);
    enMemoria.historia.adelante.length = 0;
}

/* ─── Los dos pasos que no son de ninguna toma ───────────────────────────
 *
 * La claqueta puesta a mano y el temario pegado también se deshacen allá, y van
 * en la MISMA pila que los cambios de toma para que el orden de deshacer sea el
 * orden de los gestos (ver `engine/deshacer.js`).
 *
 * La única diferencia de forma con el motor es dónde vive cada campo: allá los
 * dos cuelgan de `sesion.estado` y acá la claqueta está en la sesión y el
 * temario en `enMemoria`. El paso guarda el NOMBRE del campo, igual que allá, y
 * el ida y vuelta a dónde está guardado se resuelve en estas dos funciones.
 */

function campoDeLaSesion(campo) {
    const sesion = sesionEnVivo();
    if (campo === 'claqueta') return sesion ? sesion.claqueta : null;
    return enMemoria.temario;
}

function ponerCampoDeLaSesion(campo, valor) {
    const copia = valor ? JSON.parse(JSON.stringify(valor)) : null;
    if (campo === 'claqueta') {
        const sesion = sesionEnVivo();
        if (sesion) sesion.claqueta = copia;
        return;
    }
    enMemoria.temario = copia;
}

/** La foto de un campo de la sesión (`historial.fotoDeCampo`). */
const fotoDeCampo = v => (v ? JSON.parse(JSON.stringify(v)) : null);

function anotarDeLaSesionEnMemoria(campo, antes, cambio) {
    anotarEnMemoria({
        que: comoSeLlamaEnMemoria(cambio),
        campo,
        antes,
        despues: fotoDeCampo(campoDeLaSesion(campo))
    });
}

function volverEnMemoria(hacia) {
    const sesion = sesionEnVivo();
    if (!sesion) return { ok: false, estado: null };
    const desde = hacia === 'adelante' ? enMemoria.historia.adelante : enMemoria.historia.atras;
    const a = hacia === 'adelante' ? enMemoria.historia.atras : enMemoria.historia.adelante;
    const paso = desde[desde.length - 1];
    if (!paso) return { ok: false, estado: resumenEnVivo() };

    const foto = hacia === 'adelante' ? paso.despues : paso.antes;
    const tomas = sesion.tomas;
    // La única cosa que no se puede deshacer, y es de las tomas: un paso de la
    // sesión no repone ninguna, así que la pregunta no le corresponde. Hecha
    // igual lo plantaría, porque un paso sin `id` hace que cualquier toma
    // abierta cuente como "la otra" (ver `volver` en `engine/cambios-toma.js`).
    if (!paso.campo && foto && foto.outMs == null &&
        tomas.some(t => t.id !== paso.id && t.outMs == null)) {
        return {
            ok: false,
            error: `No puedo ${hacia === 'adelante' ? 'rehacer' : 'deshacer'} «${paso.que}»: ` +
                'mientras tanto se abrió otra toma, y dos tomas abiertas a la vez rompen ' +
                'el ciclo de señales. Cerrá la de ahora y volvé a intentar.',
            estado: resumenEnVivo()
        };
    }

    desde.pop();
    a.push(paso);
    if (paso.campo) {
        ponerCampoDeLaSesion(paso.campo, foto);
        // Un temario repuesto vuelve con la cobertura que se le había medido
        // CONTRA esa lista, así que no se vuelve a medir. Allá lo decide la
        // huella (`hayQueMedir`); pedirlo igual dejaría el panel diciendo
        // "midiendo" donde la app muestra el resultado en el acto.
        if (!enMemoria.temario || !enMemoria.temario.cobertura) pedirLaCobertura();
        return { ok: true, que: paso.que, estado: resumenEnVivo() };
    }
    const donde = tomas.findIndex(t => t.id === paso.id);
    if (!foto) {
        if (donde >= 0) tomas.splice(donde, 1);
    } else if (donde >= 0) {
        for (const clave of Object.keys(tomas[donde])) delete tomas[donde][clave];
        Object.assign(tomas[donde], foto);
    } else {
        const detras = tomas.findIndex(t => t.id > paso.id);
        tomas.splice(detras === -1 ? tomas.length : detras, 0, foto);
    }
    // Deshacer un descarte también mueve la cobertura, como allá.
    pedirLaCobertura();
    return { ok: true, que: paso.que, estado: resumenEnVivo() };
}

function grabadas() {
    const hecha = (clase, hora, hacerTomas, comoSeLlama, dir) => {
        const donde = dir || CURSO;
        const curso = donde.split('/').pop();
        const nombre = comoSeLlama || `0${clase}_${curso.replace(/^\d+_/, '')}_2026-09-08_${hora}`;
        const ceroMs = Date.parse(`2026-09-08T${hora.replace(/-/g, ':')}`);
        const tomas = hacerTomas(ceroMs);
        return {
            secuencia: nombre,
            clase, parte: 1, curso,
            ceroMs,
            claqueta: { ms: ceroMs + 6000, confirmada: true },
            vistas: VISTAS,
            // La clase ya grabada también trae su agregado: lo que se midió en
            // vivo quedó en el sidecar, así que se puede volver a mirar después.
            lengua: agregadoDeLengua(tomas),
            tomas,
            carpeta: donde,
            // El WAV que dejó la grabación. Sin esto el cartel de borrar decía
            // "ningún audio" en todas, o sea que tapaba justo lo que el cartel
            // existe para nombrar: los cientos de megas que no van a la papelera.
            sesiones: [{ archivo: `${donde}/${nombre}.wav` }],
            archivos: archivosDeNotas(donde, nombre)
        };
    };
    return [
        muestrarioDeVistas(hecha),
        hecha(3, '12-10-00', cero => [
            tomaDe(0, 15, 50, null, cero),
            comentarSobre(tomaDe(1, 80, 62, null, cero), 20, 27, 'Sacar un clip corto de acá'),
            tomaDe(2, 160, 45, { descartada: true }, cero)
        ]),
        hecha(2, '10-30-00', cero => [tomaDe(3, 12, 70, null, cero), tomaDe(0, 95, 55, null, cero)]),
        // Una clase en la OTRA carpeta. La maqueta decía tener dos carpetas y una
        // estaba siempre vacía, así que el agrupado nunca mostraba dos grupos con
        // clases y «Por fecha» nunca mezclaba cursos — que es justo donde se ve
        // si quitar una carpeta se lleva sus clases o si quedan colgadas.
        hecha(1, '09-30-00', cero => [
            tomaDe(0, 20, 60, null, cero),
            tomaDe(2, 110, 40, null, cero)
        ], null, TALLER)
    ];
}

/**
 * La sesión que se acaba de terminar, ya como una clase de la lista.
 *
 * Es el sidecar que escribe `terminar()`: lo mismo que se estaba grabando, sin la
 * sesión. Hace falta porque si no la clase recién terminada se evaporaba —la
 * maqueta volvía a la pantalla de reposo y la lista de grabadas seguía teniendo
 * las tres de siempre—, y lo primero que hace cualquiera después de terminar es
 * buscarla ahí.
 */
function comoQuedaGrabada(sesion) {
    const tomas = porElPuente(sesion.tomas);
    return {
        secuencia: sesion.secuencia,
        clase: sesion.clase, parte: sesion.parte, curso: sesion.curso,
        ceroMs: sesion.ceroMs,
        claqueta: sesion.claqueta,
        vistas: VISTAS,
        lengua: agregadoDeLengua(tomas),
        tomas,
        carpeta: sesion.dir,
        archivos: sesion.archivos
    };
}

/**
 * La paleta entera, una toma por vista y en el orden en que se ofrecen.
 *
 * No pretende ser una clase: es para poder aprobar los colores de un vistazo sin
 * tener que fabricar a mano una toma de cada tipo, que es lo que había que hacer
 * antes y por eso nunca se miraban las cinco juntas. Se arma desde `VISTAS`, así
 * que si aparece una vista nueva aparece sola acá; y va primera en la lista para
 * no tener que buscarla.
 *
 * La primera lleva un comentario subrayado y una nota escrita, porque el color de
 * la tarjeta hay que juzgarlo con texto encima y no vacío.
 */
function muestrarioDeVistas(hecha) {
    return hecha(9, '09-00-00', cero => VISTAS.map((v, n) => {
        const toma = tomaDe(n, 15 + n * 70, 55, {
            vista: v.nombre,
            comentario: `${v.nombre} · ${v.titulo}`
        }, cero);
        return n === 0
            ? comentarSobre(toma, 8, 15, 'Con texto encima, que es como hay que juzgar el color')
            : toma;
    }), 'MUESTRARIO_de_colores_una-toma-por-vista');
}

/* ─── Guardar sin guardar ────────────────────────────────────────────────── */

const enMemoria = {
    notas: {}, planes: {}, temario: null,
    // La lista del CD de cada carpeta, que es donde vive antes de que haya
    // ninguna clase. Allá es un archivo adentro de la carpeta de notas y acá un
    // objeto: la carpeta es el curso, y el CD entrega una lista por curso
    // (`engine/temario-sesion.js`).
    temarioPorCarpeta: {},
    // En qué carpeta está grabando la sesión, para saber a cuál escribirle la
    // lista que se pega con la clase ya empezada.
    carpeta: null,
    // Si hay una medición de cobertura en vuelo, como `sesion.midiendoTemario`.
    midiendoTemario: false,
    // La sesión que se está grabando, para que lo que se le hace quede hecho, y
    // lo que se le hizo, para poder volver (ver `sesionEnVivo`).
    sesion: null,
    historia: { atras: [], adelante: [] }
};

/**
 * El temario recién pegado, sin medir (`temarioSesion.poner`).
 *
 * Del lado de la app esto lo parte `engine/temario.js`; acá hace falta un parseo
 * mínimo para que la lista pegada se vea partida.
 *
 * **Sale sin cobertura y eso es el arreglo.** La medición la hace un modelo y
 * tarda, así que allá el estado vuelve con `cobertura: null` y
 * `midiendoTemario: true`, y el resultado llega después por un aviso. Acá la
 * lista volvía ya medida en el mismo suspiro, o sea que el renglón que el panel
 * muestra mientras se mide —el único que explica por qué la lista está unos
 * segundos sin resultado— no existía en la maqueta y no se podía aprobar.
 */
/**
 * La lista guardada para una carpeta, sin cobertura y sin clase.
 *
 * `origen: 'guardado'` es lo que hace que la sesión que la herede diga en el
 * desplegable que no la pegó nadie ahí: puede ser la de la clase de ayer.
 */
function temarioGuardado(texto) {
    const puesto = temarioPegado(texto);
    return puesto.objetivos.length ? { ...puesto, origen: 'guardado' } : null;
}

/** En qué carpeta graba la sesión, que es a la que le queda la lista pegada. */
function carpetaEnVivo() {
    return enMemoria.carpeta;
}

function temarioPegado(texto) {
    const objetivos = String(texto || '')
        .split(/\r?\n/)
        .map(r => r.replace(/^\s*(?:[-–—*•·]+\s*|\d{1,2}\s*[.)\-–]\s+)/, '').trim())
        // El renglón que anuncia la lista ("Objetivos de la clase:") no es un
        // tema, igual que en `engine/temario.js`: sin esta línea la maqueta lo
        // mostraba como un objetivo cubierto, o sea enseñando un comportamiento
        // que la app no tiene.
        .filter(r => r && !/^[^.!?]{0,60}:$/.test(r))
        .map((tema, i) => ({ n: i + 1, texto: tema }));
    if (!objetivos.length) return null;

    return {
        texto: String(texto || ''),
        objetivos,
        origen: 'pegado',
        cobertura: null,
        fallo: null,
        abstenido: null
    };
}

/**
 * La cobertura de mentira, para poder mirar los dos estados a la vez.
 *
 * **Deja un objetivo cubierto y otro sin cubrir a propósito**: con todos
 * cubiertos o todos faltando, la mitad del diseño del bloque no aparece nunca.
 *
 * `como: 'ia'` es lo que dibuja la medición normal; poniéndolo en `'palabras'`
 * se ve el cartel de "es una aproximación", y con `fallo` el de "no se pudo
 * medir". Los tres estados se miran cambiando esta función.
 */
function coberturaDe(objetivos) {
    // Las tomas cerradas de la sesión: es de donde tiene que salir el número que
    // se muestra al lado de un objetivo cubierto, porque es el que se puede ir a
    // mirar. Inventarlo dejaría el panel señalando tomas que no están, que es
    // justo lo que pasaba con una sesión recién arrancada: la lista se puede
    // pegar antes de "Iniciar", y ahí no hay ninguna toma todavía.
    const cerradas = tomasCerradas();
    const medidos = objetivos.map((o, i) => ({
        ...o,
        cubierto: i % 3 !== 1,
        toma: i % 3 !== 1 ? cerradas[i % cerradas.length] : null,
        porque: i % 3 !== 1
            ? 'Lo explicó con el panel de contexto abierto.'
            : 'Todavía no lo nombró: lo anunció para más adelante.'
    }));
    const cubiertos = medidos.filter(o => o.cubierto).length;

    return {
        como: 'ia',
        medidoEn: new Date().toISOString(),
        modelo: 'claude-sonnet-5-thinking-high',
        huella: `maqueta-${objetivos.length}`,
        cubiertos,
        faltan: medidos.length - cubiertos,
        objetivos: medidos
    };
}

/** Las tomas que cuentan para la cobertura: las que quedan y ya cerraron. */
function tomasCerradas() {
    const s = sesionEnVivo();
    return ((s && s.tomas) || [])
        .filter(t => !t.descartada && t.outMs != null)
        .map(t => t.id);
}

/**
 * Larga la medición de la cobertura, y una sola a la vez (`temarioSesion.pedir`).
 *
 * Lo que llega después llega por el mismo camino que allá: `espejo.fijar`, o sea
 * un aviso con el estado entero. Sin pantalla que lo pida y sin que nadie toque
 * nada, que es lo que no se podía verificar hasta que la maqueta empujó.
 *
 * Sin ninguna toma cerrada no se mide y no es un caso raro: es como arranca toda
 * clase, y allá `hayQueMedir` contesta lo mismo —no hay texto contra el que
 * comparar—. El panel lo dice con su propio renglón, que sin esto no aparecía.
 */
function pedirLaCobertura() {
    if (enMemoria.midiendoTemario || !enMemoria.temario || !tomasCerradas().length) return;
    enMemoria.midiendoTemario = true;
    setTimeout(() => {
        enMemoria.midiendoTemario = false;
        if (!enMemoria.temario || !sesionEnVivo()) return;
        enMemoria.temario = {
            ...enMemoria.temario,
            cobertura: coberturaDe(enMemoria.temario.objetivos),
            fallo: null
        };
        empujar();
    }, DEMORA_DEL_MODELO_MS);
}

/**
 * Lo que el motor le hace a una toma que acaba de quedar cerrada.
 *
 * Son las dos fases de `medir-toma.js`, y la separación es lo que hay que poder
 * mirar: `medir` es sincrónico y no falla —el panel tiene número apenas la toma
 * cierra— y la consulta al modelo tarda y llega después, así que entre las dos
 * hay un rato en que el bloque dice "midiendo". Ese rato no existía acá: una toma
 * cerrada a mano se quedaba sin medida para siempre, y `midiendo` —que es un
 * estado que la pantalla dibuja distinto en dos bloques— no se veía nunca.
 */
function medirLaTomaCerrada(toma) {
    const sesion = sesionEnVivo();
    if (!sesion) return;
    const midiendo = () => ({ estado: 'midiendo', porque: '', hallazgos: [] });

    toma.lengua = lenguaDe(Math.max(1, Math.round((toma.outMs - toma.inMs) / 1000)),
        { ia: midiendo() });
    const previa = anteriorDeEmpalme(sesion.tomas, toma);
    if (previa) {
        toma.empalme = {
            det: { version: 1, contra: previa.id, parecido: 0.31, porRegla: null },
            ia: midiendo()
        };
    }
    // Y el texto bueno pide medir el temario otra vez: hay material nuevo, que es
    // el latido de allá (`temarioSesion.pedir` en `relecturas.rehacer`).
    pedirLaCobertura();

    setTimeout(() => {
        // La sesión puede haberse cerrado, y la toma puede haberse eliminado o
        // deshecho mientras el modelo pensaba: allá el aviso se cae solo cuando
        // ya no hay dónde escribir.
        const ahora = sesionEnVivo();
        if (!ahora || !ahora.tomas.includes(toma)) return;
        toma.lengua = lenguaDe(Math.max(1, Math.round((toma.outMs - toma.inMs) / 1000)));
        // Sin hallazgo: la maqueta no puede tener dos tomas que se repitan de
        // verdad —el guion es genérico— y decir que sí sería subrayar un tramo
        // que no repite nada. Lo que se mira acá es el camino, no el hallazgo.
        if (toma.empalme) toma.empalme.ia = { estado: 'listo', porque: '', hallazgos: [] };
        empujar();
    }, DEMORA_DEL_MODELO_MS);
}

/**
 * Las clases ya grabadas, una sola vez y no una por pregunta.
 *
 * `grabadas()` las arma de cero cada vez que se la llama, y con eso la maqueta
 * mentía sobre algo que la app de verdad sí hace: cambiarle la vista a una toma
 * de una clase terminada. El motor la escribe en el disco (`editarGrabada` en
 * `engine/grabacion.js`) y la vuelve a leer, así que el cambio queda; acá la
 * lista se rehacía igual a la de antes y el botón parecía roto.
 *
 * Una maqueta que no guarda no sirve para mirar: lo que se está probando es
 * justamente qué pasa DESPUÉS de tocar algo.
 */
let yaGrabadas = null;
const listaGrabadas = () => (yaGrabadas || (yaGrabadas = grabadas()));

/**
 * La plantilla de Premiere que se eligió en esta pestaña, o `null`.
 *
 * Arranca sin elegir a propósito: así es una máquina recién instalada, y ese es
 * justamente el camino que hay que poder mirar —que el botón la pida la primera
 * vez—. Vive acá y no en `ajustes` porque acá no hay Premiere que la escriba, y
 * dejarla en los ajustes fingiría que quedó guardada en un disco.
 */
let plantillaElegida = null;

/**
 * Las tres listas juntas, el borde corrido, y a repartir de nuevo: es lo que hace
 * `moverBordeGuardado` allá, en cuatro líneas.
 *
 * Lo usan las dos: la clase en curso y una ya grabada. Es lo mismo que del otro
 * lado, donde el reparto vive en un solo sitio por el mismo motivo.
 */
function repartirEnMemoria(toma, borde, paredMs) {
    const guardadas = (toma.antes || []).concat(toma.palabras || [], toma.despues || []);
    if (borde === 'in') toma.inMs = paredMs;
    else toma.outMs = paredMs;
    toma.antes = guardadas.filter(w => w.t < toma.inMs);
    toma.palabras = guardadas.filter(w => w.t >= toma.inMs && (toma.outMs == null || w.t < toma.outMs));
    toma.despues = toma.outMs == null ? [] : guardadas.filter(w => w.t >= toma.outMs);
}

/**
 * Un cambio sobre una clase ya grabada (`clasesGrabadas.editarGrabada`).
 *
 * **Los que entran son los de `vivo.aplicar` y ni uno más ni uno menos**: los que
 * se resuelven con lo que ya está escrito. `descartar-ajuste` entra —el descarte
 * es una marca en la toma y no pide audio— y acá quedaba afuera, así que el botón
 * "Descartar ajuste" de una clase terminada parecía roto en la maqueta y anda en
 * la app. `reabrir` queda afuera y con su motivo, y lo que no existe es un error
 * de programa.
 *
 * Y el borde tiene el límite de allá: fuera del texto guardado no se mueve. Acá
 * se movía siempre, o sea que la maqueta dejaba arrastrar el OUT de una clase
 * terminada más allá de lo que se leyó del audio, que es el gesto que en la app
 * contesta "usá Regenerar".
 *
 * @throws como allá; el puente lo atrapa y lo devuelve como `{ok:false, error}`.
 */
function editarEnMemoria(json, cambio) {
    const c = cambio || {};
    const clase = listaGrabadas().find(x => x.archivos.json === json);
    if (!clase) throw new Error('No encuentro esa clase.');
    const toma = clase.tomas.find(x => x.id === c.toma);
    if (!toma) throw new Error(`Esa clase no tiene la toma ${c.toma}.`);

    if (c.tipo === 'vista') toma.vista = c.vista;
    else if (c.tipo === 'nota') toma.comentario = String(c.texto || '');
    else if (c.tipo === 'descartar') toma.descartada = Boolean(c.descartada);
    else if (c.tipo === 'comentar') {
        toma.comentarios = (toma.comentarios || []).concat([{
            desdeMs: Number(c.desdeMs), hastaMs: Number(c.hastaMs),
            texto: String(c.texto || ''), comentario: String(c.comentario || '')
        }]);
    } else if (c.tipo === 'borrar-comentario') {
        toma.comentarios = (toma.comentarios || []).filter((_x, i) => i !== c.indice);
    } else if (c.tipo === 'descartar-ajuste') {
        toma.empalme = {
            ...(toma.empalme || {}),
            descartado: { contra: Number(c.contra), ms: Date.now() }
        };
    } else if (c.tipo === 'borde') {
        bordeDeLoGuardado(toma, c.borde, Number(c.paredMs));
    } else if (c.tipo === 'reabrir') {
        throw new Error('Reabrir es de la clase que se está grabando. Con la ' +
            'clase cerrada, una toma sin OUT no llega al XML: para que termine ' +
            'más adelante, arrastrá la línea roja.');
    } else {
        throw new Error(`Cambio sin definir: ${c.tipo}`);
    }
    return { archivos: clase.archivos };
}

/**
 * El nombre de una clase, como lo arma `engine/nombre-de-clase.js`.
 *
 * Copiado y no importado porque acá no hay `require`: la maqueta corre en la
 * ventana. Lo que importa que sea igual es la forma, porque la lista vuelve a
 * leer la parte de ahí — si esto escribiera `_p1_`, la maqueta mostraría una
 * parte 1 que la app no muestra.
 */
function nombreArmado({ clase, parte, curso, cuandoMs }) {
    const d = new Date(cuandoMs);
    const dos = n => String(n).padStart(2, '0');
    const fecha = `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
    const hora = `${dos(d.getHours())}-${dos(d.getMinutes())}-${dos(d.getSeconds())}`;
    return `${dos(clase)}_${Number(parte) > 1 ? `p${parte}_` : ''}${curso}_${fecha}_${hora}`;
}

/**
 * Renombrar una clase de la lista (`clasesGrabadas.renombrar`).
 *
 * **Las tres negativas del motor están acá, y son la mitad de lo que hay que
 * poder mirar.** Un stub que siempre contesta `{ok:true}` deja sin dibujar
 * justamente lo que se pidió que se explicara: por qué algo no se puede. Así que
 * se niega por lo mismo que allá —la clase que se está grabando, el curso vacío,
 * el nombre repetido— y con el mismo texto, que es el que la pantalla muestra tal
 * cual.
 *
 * Y la hora NO se toca, que es la regla entera: sale del `ceroMs` que la clase ya
 * tenía y el nombre nuevo la vuelve a escribir igual.
 */
function renombrarEnMemoria(json, cambio) {
    const c = cambio || {};
    const clase = listaGrabadas().find(x => x.archivos.json === json);
    if (!clase) throw new Error('No encuentro esa clase.');

    const sesion = sesionEnVivo();
    if (sesion && sesion.secuencia === clase.secuencia) {
        throw new Error('Esa clase se está grabando ahora. Terminá la grabación para renombrarla.');
    }
    if (c.curso != null && !String(c.curso).trim()) {
        throw new Error('El nombre del curso no puede quedar vacío.');
    }
    // Sin hora recuperable el motor se planta, y la maqueta tiene que poder
    // mostrarlo: una clase con `ceroMs` en null es la clase vieja de antes de que
    // el sidecar la guardara (ver `horaDeCaptura` en `clases-grabadas.js`).
    if (!clase.ceroMs) {
        throw new Error('Esta clase no dice a qué hora se grabó, y sin esa hora el ' +
            'nombre nuevo no podría emparejarse con la carpeta del Rodecaster.');
    }

    const numero = Number(c.clase != null ? c.clase : clase.clase);
    const curso = c.curso != null ? String(c.curso) : clase.curso;
    // Reusar un número la convierte en la parte siguiente, y quedarse en el propio
    // le deja la parte que tenía: es lo que la pantalla prometió mientras se
    // escribía (`parteQueQueda` en `src/js/grabar/gestionar.js`).
    const parte = numero === Number(clase.clase)
        ? (Number(clase.parte) || 1)
        : listaGrabadas().filter(x => x !== clase && Number(x.clase) === numero).length + 1;

    const nombre = nombreArmado({ clase: numero, parte, curso, cuandoMs: clase.ceroMs });
    if (nombre === clase.secuencia) {
        return { secuencia: nombre, archivos: clase.archivos, movida: false, audios: 0 };
    }
    if (listaGrabadas().some(x => x !== clase && x.secuencia === nombre)) {
        throw new Error(`Ya hay una clase llamada «${nombre}» en esa carpeta.`);
    }

    clase.secuencia = nombre;
    clase.clase = numero;
    clase.parte = parte;
    clase.curso = curso;
    clase.archivos = archivosDeNotas(clase.carpeta, nombre);
    return {
        secuencia: nombre,
        archivos: clase.archivos,
        movida: true,
        audios: (clase.sesiones || []).length
    };
}

/**
 * Borrar una clase de la lista (`clasesGrabadas.borrar`).
 *
 * Se va de la lista y no vuelve, que es lo que hay que poder mirar: el cartel
 * pregunta por archivos que no van a la papelera, y una maqueta donde la clase
 * reaparece al repintar no probaría que el gesto llega hasta el final. `yaGrabadas`
 * la guarda entre preguntas justamente para eso (ver `listaGrabadas`).
 */
function borrarEnMemoria(json) {
    const clase = listaGrabadas().find(x => x.archivos.json === json);
    if (!clase) throw new Error('No encuentro esa clase.');

    const sesion = sesionEnVivo();
    if (sesion && sesion.secuencia === clase.secuencia) {
        throw new Error('Esa clase se está grabando ahora. Terminá la grabación para borrarla.');
    }

    yaGrabadas = listaGrabadas().filter(x => x !== clase);
    // Lo que se fue de verdad, archivo por archivo, como contesta `borrar` en
    // `engine/clases-grabadas.js`. Devolvía en cambio un `borrados: 2 + audios`
    // que nadie leía, y sin `xml` ni `sidecar` el aviso de después se quedaba en
    // «Borrada: 1 audio»: el cartel prometía tres archivos y el acuse nombraba
    // uno, que es la mitad del gesto sin confirmar.
    return {
        secuencia: clase.secuencia,
        xml: true,
        sidecar: true,
        audios: new Set((clase.sesiones || []).map(s => s.archivo)).size
    };
}

/**
 * El borde de una clase terminada: dentro del texto que quedó guardado y nada
 * más (`moverBordeGuardado`).
 *
 * Con la clase cerrada no hay ciclo que relea nada, así que el único texto que
 * respalda el borde es el que está en el sidecar —la toma y sus dos orillas—. Más
 * allá, el transcript seguiría diciendo lo de antes mientras el marcador dice
 * otra cosa, y ese cue es lo que reancla el bloque en post.
 */
function bordeDeLoGuardado(toma, borde, paredMs) {
    const guardadas = (toma.antes || []).concat(toma.palabras || [], toma.despues || []);
    const ultima = guardadas[guardadas.length - 1];
    if (!guardadas.length || !Number.isFinite(paredMs) ||
        paredMs < guardadas[0].t || paredMs > ultima.t) {
        throw new Error('Ese borde cae fuera del texto que quedó guardado. ' +
            'Corrilo hasta donde llega el gris y usá "Regenerar": relee la toma ' +
            'del audio y deja otros segundos de contexto para seguir.');
    }
    // Un borde que cruza al otro no explota: no se mueve y la línea vuelve a su
    // sitio sola al repintar, igual que en la clase en curso.
    moverElBorde(toma, borde, paredMs);
}

/* ─── El puente ──────────────────────────────────────────────────────────── */

const oyentes = {};
const avisar = (canal, payload) => { if (oyentes[canal]) oyentes[canal](payload); };

/* ─── El empujón del estado ──────────────────────────────────────────────
 *
 * **El motor manda el estado entero cada tres segundos, haya novedades o no.** Es
 * la pasada del ciclo de señales (`buscarSenales` en `engine/grabacion.js`): se
 * oye lo último, se abren o cierran tomas, y al final va el estado con lo que se
 * acaba de oír al lado. Además lo manda `espejo.fijar` en cada cosa que cambia
 * lejos de un gesto: una medida que llegó, la cobertura del temario, un borde
 * releído.
 *
 * La maqueta no mandaba NADA, y eso escondía la mitad de esta pantalla: todo lo
 * que la interfaz hace entre dos repintados espontáneos —que es donde vivió la
 * familia entera de bugs de esta tanda: el foco, la tarjeta ocupada, el
 * comentario abierto al margen— solo se podía verificar con un sustituto, un
 * repintado disparado a mano desde otro gesto. Y un sustituto no prueba lo mismo:
 * un gesto trae un clic, y el empujón llega sin que nadie toque nada.
 *
 * Va por el mismo canal (`grabar-aviso`), con la misma forma
 * (`{tipo:'estado', estado, eventos, oyendo}`) y a la misma cadencia, que llega
 * servida desde el motor y no copiada acá (`MOTOR.CICLO_MS`).
 */

let elEmpujon = null;

function empezarAEmpujar() {
    if (elEmpujon) return;
    elEmpujon = setInterval(unaPasada, MOTOR.CICLO_MS);
}

function pararElEmpujon() {
    clearInterval(elEmpujon);
    elEmpujon = null;
}

/** Una pasada del ciclo de señales: se oye lo último y va el estado. */
function unaPasada() {
    const sesion = sesionEnVivo();
    if (!sesion) return pararElEmpujon();
    empujar(seguirHablando(sesion));
}

/**
 * El estado a la ventana.
 *
 * **`oyendo` va SOLO en el aviso del ciclo y no en los de `espejo.fijar`**, y la
 * diferencia se ve en la pantalla: la línea "Oyendo:" se apaga cuando el campo
 * llega vacío y se queda como está cuando no llega, así que mandarlo en todos los
 * avisos la borraría cada vez que se mide una toma.
 *
 * @param {{eventos:Array, oyendo:string}} [oido] lo que trajo la pasada, si esto
 *   viene del ciclo
 */
function empujar(oido) {
    const estado = resumenEnVivo();
    if (!estado) return;
    const aviso = { tipo: 'estado', estado: porElPuente(estado) };
    if (oido) Object.assign(aviso, oido);
    avisar('grabar-aviso', aviso);
}

/**
 * Lo que se dijo desde la pasada anterior: el audio crece y la toma abierta se
 * llena.
 *
 * Es lo que hace `aplicarSenales` con las palabras del ciclo liviano, y hace falta
 * por lo que dice el motor de su propio empujón: "así las palabras de la toma
 * abierta van apareciendo en pantalla, que es lo que dice «esto está oyendo bien»
 * sin tener que esperar a que la toma cierre". Con una toma abierta congelada, el
 * empujón de la maqueta sería un repintado que dibuja siempre lo mismo, y una
 * pantalla que no se mueve no prueba que se pueda leer mientras se mueve.
 *
 * El reloj es el de la sesión y no `Date.now()`: la clase de la maqueta puede
 * tener su cero fijo —eso es lo que hace repetibles las capturas— y las palabras
 * tienen que seguir donde las dejó, no nueve horas más adelante.
 *
 * Lo que NO hace la maqueta es abrir y cerrar tomas sola. Está dicho en el
 * encabezado del archivo: el reparto se elige, y un reparto que cambia debajo de
 * la mano no se puede juzgar ni verificar. Cerrar una toma se prueba con el botón.
 */
function seguirHablando(sesion) {
    const paso = Date.now() - sesion.relojMs;
    sesion.relojMs += paso;
    // Cuánto audio hay escrito, que allá lo mueve el PCM que manda la ventana.
    sesion.segundos += Math.round(paso / 1000);

    const desde = sesion.oidoHastaMs;
    sesion.oidoHastaMs += paso;
    const dichas = loQueSeDiceEntre(sesion, desde, sesion.oidoHastaMs);

    // A la toma abierta y a ninguna otra. Entre dos tomas lo que se dice no es de
    // nadie y aun así se oye: es lo único que avisa de que el micrófono está
    // agarrando la sala en vez del Rodecaster antes de media clase.
    const abierta = sesion.tomas.find(t => t.outMs == null);
    if (abierta) abierta.palabras.push(...dichas);
    return { eventos: [], oyendo: dichas.map(w => w.texto).join(' ') };
}

/** Las palabras que se dicen entre dos momentos, al ritmo del curso. */
function loQueSeDiceEntre(sesion, desdeMs, hastaMs) {
    const cuantas = Math.round((RITMO_DE_HABLA * (hastaMs - desdeMs)) / 60000);
    if (cuantas < 1) return [];
    const paso = (hastaMs - desdeMs) / (cuantas + 1);
    const dichas = [];
    for (let n = 0; n < cuantas; n++) {
        if (!sesion.porDecir.length) {
            sesion.porDecir = GUION[sesion.renglon++ % GUION.length].split(' ');
        }
        dichas.push(palabra(Math.round(desdeMs + paso * (n + 1)), sesion.porDecir.shift()));
    }
    return dichas;
}

window.cc = {
    appInfo: async () => ({ version: '0.9.0-maqueta', arch: 'arm64', electron: '33.2.0', platform: 'darwin' }),

    doctor: async () => ({
        arch: 'arm64', appleSilicon: true, ok: true,
        tools: [
            { key: 'ffprobe', required: true, found: true, path: '/Apps/Class Cut.app/…/ffprobe', name: null, source: 'incluido en la app', searched: [], nota: null },
            { key: 'ffmpeg', required: true, found: true, path: '/Apps/Class Cut.app/…/ffmpeg', name: null, source: 'incluido en la app', searched: [], nota: null },
            { key: 'whisper-cli', required: true, found: true, path: '/Apps/Class Cut.app/…/whisper-cli', name: null, source: 'incluido en la app', searched: [], nota: null },
            { key: 'modelo de Whisper', required: true, found: true, path: '/Library/…/ggml-large-v3-turbo.bin', name: 'ggml-large-v3-turbo.bin', source: 'Application Support', searched: [], nota: null },
            { key: 'modelo liviano (notas en vivo)', required: false, found: false, path: null, name: null, source: null, searched: ['/Library/…/ggml-base.bin'], nota: 'Sin él, la toma de notas en vivo escucha las señales pero no escribe el transcript.' }
        ],
        ai: { estado: 'listo', model: 'claude-sonnet-5-thinking-high', source: 'Cursor CLI', reason: 'Cursor CLI conectado.', proveedor: 'cursor' }
    }),

    modelos: async () => ([
        { model: 'qwen3:4b', own: true },
        { model: 'qwen3:14b', own: false },
        { model: 'llama3.1:8b', own: false }
    ]),
    modelo: async preferido => ({
        estado: 'listo',
        model: preferido || 'claude-sonnet-5-thinking-high',
        source: 'Cursor CLI',
        reason: 'Cursor CLI conectado.',
        proveedor: 'cursor'
    }),

    ajustesLeer: async () => structuredClone(ajustes),
    /**
     * Un PARCHE sobre lo que había, como `ajustes-guardar` del otro lado
     * (`main.js`, que hace `guardar({...leer(), ...parche})`): cada pantalla
     * manda solo lo suyo.
     *
     * Y con el único invariante que el motor impone al sanear: la carpeta en uso
     * siempre está en la lista y va primera (`sanear` en `engine/ajustes.js`).
     * Es lo que hace que quitar una carpeta no pueda dejar afuera la activa —por
     * eso su cabecera dice «en uso» en vez de ofrecer el botón.
     */
    ajustesGuardar: async datos => {
        ajustes = { ...ajustes, ...structuredClone(datos || {}) };
        const otras = (ajustes.notasDirs || []).filter(d => d && d !== ajustes.notasDir);
        ajustes.notasDirs = (ajustes.notasDir ? [ajustes.notasDir] : []).concat([...new Set(otras)]);
        // Y el otro invariante del saneado: sin repetidas y hasta el tope
        // (`RECIENTES` en `engine/ajustes.js`). Un mock que no recorta deja pasar
        // en la maqueta una lista que en la app no puede existir.
        ajustes.carpetasRecientes = [...new Set(ajustes.carpetasRecientes || [])].slice(0, 6);
        return { ok: true, ajustes: structuredClone(ajustes) };
    },
    iaProbar: async () => { await espera(700); return { ok: true, mensaje: 'Contestó en 0,8 s.' }; },
    // `{ ok, modelos }` y no una lista suelta: la pantalla de ajustes distingue
    // "el CLI no contestó" de "contestó y no tiene modelos".
    cursorModelos: async () => ({
        ok: true,
        modelos: ['claude-sonnet-5-thinking-high', 'claude-opus-5-thinking-high', 'composer-2.5-fast']
    }),
    claudeLoginEmpezar: async () => ({ ok: true, url: 'https://claude.ai/oauth/…' }),
    claudeLoginCodigo: async () => ({ ok: true }),
    claudeSalir: async () => ({ ok: true }),

    updateCheck: async () => {
        await espera(900);
        return { hay: true, version: '1.0.0', notas: '- El reproductor arranca en el bloque que estabas mirando\n- Se puede comentar una clase ya generada\n- Arreglado el karaoke en las pausas largas', url: 'https://…/Class-Cut-1.0.0.pkg', nombre: 'Class-Cut-1.0.0.pkg', 'tamañoBytes': 268435456 };
    },
    updateDownload: async () => {
        for (let p = 0; p <= 100; p += 4) {
            await espera(90);
            avisar('update-progress', { percent: p, bajado: Math.round(268435456 * p / 100), total: 268435456 });
        }
        avisar('update-ready', { path: '/tmp/Class-Cut-1.0.0.pkg' });
        return { ok: true, path: '/tmp/Class-Cut-1.0.0.pkg' };
    },
    updateCancel: async () => ({ ok: true }),
    updateInstall: async () => ({ ok: true, cerrando: false }),

    pickFolder: async () => CURSO,
    confirmar: async payload => window.confirm(`${payload.titulo}\n\n${payload.mensaje || ''}`),
    preguntar: async payload => {
        const lista = (payload.opciones || []).map((o, i) => `${i}: ${o}`).join('\n');
        const r = window.prompt(`${payload.titulo}\n\n${payload.mensaje || ''}\n\n${lista}\n\n(vacío = cancelar)`, '0');
        return r === null || r === '' ? -1 : Number(r);
    },

    scan: async folder => {
        await espera(400);
        const hallada = CARPETAS.find(c => c.root === folder) || CARPETAS[0];
        // Como `main.js`, que recuerda la raíz recién después de que el escaneo
        // salió bien. Sin esto la maqueta ofrecía una lista de recientes que
        // nunca crecía, o sea la mitad del gesto.
        const otras = (ajustes.carpetasRecientes || []).filter(d => d !== hallada.root);
        ajustes.carpetasRecientes = [hallada.root, ...otras].slice(0, 6);
        return hallada;
    },
    carpetasRecientes: async () => structuredClone(ajustes.carpetasRecientes || []),
    /**
     * Qué carpetas están en el disco. En la maqueta no hay disco: está la de
     * afuera, que nunca está, y todas las demás, que siempre están.
     *
     * Y contesta tarde a propósito. La pantalla pinta la lista antes de saberlo
     * (`cargarRecientes` en `src/js/vista-carpeta.js`), y con una respuesta
     * instantánea los dos tiempos se ven como uno: el medio segundo es lo que
     * hace visible que la lista NO espera al disco para aparecer.
     */
    carpetasEnDisco: async rutas => {
        await espera(500);
        return Object.fromEntries((rutas || []).map(r => [r, r !== AFUERA]));
    },
    quitarCarpeta: async () => ({ ok: true }),

    process: async payload => {
        const ids = payload.ids || [];
        avisar('process-class', { phase: 'modelo', modelo: { reason: 'Cursor CLI conectado.', model: 'claude-sonnet-5-thinking-high' } });
        const etapas = ['leer', 'transcribir', 'alinear', 'decidir', 'exportar'];
        const results = [];

        for (let i = 0; i < ids.length; i++) {
            avisar('process-class', { phase: 'empieza', id: ids[i], index: i, total: ids.length, result: null });
            for (const etapa of etapas) {
                for (let p = 0; p <= 100; p += 20) {
                    await espera(etapa === 'transcribir' ? 130 : 60);
                    avisar('process-stage', { stage: etapa, id: ids[i], index: i, total: ids.length, percent: p, msClase: 8000, msEtapa: 1600, hechas: [] });
                }
            }
            const result = {
                id: ids[i], ok: true, sequenceName: `0${i + 1}_curso-de-prueba`,
                msProceso: 214000,
                etapas: etapas.map(e => ({ etapa: e, ms: 40000 })),
                tokens: { informa: true, total: 48200, entrada: 39000, salida: 9200, consultas: 3 },
                materialSec: 600, transcribio: true,
                offset: { appliedSec: 8, source: 'claqueta' },
                stats: { confidence: { alta: 5, media: 2, baja: 1 } },
                totals: { segments: 8, kept: 7, keepSec: 459, needsReview: 1 },
                exported: { sequenceName: `0${i + 1}_curso-de-prueba`, finalXml: `${CURSO}/The Cutter/0${i + 1}_final.xml` },
                warnings: [], cancelled: false
            };
            results.push(result);
            avisar('process-class', { phase: 'termina', id: ids[i], index: i, total: ids.length, result });
        }
        return { ok: true, cancelled: false, salidas: [{ root: CURSO, dir: `${CURSO}/The Cutter`, nombre: '2609_curso-de-prueba' }], carpetas: CARPETAS, results };
    },
    cancelProcess: async () => ({ ok: true }),

    loadReview: async payload => {
        await espera(350);
        const clase = PROCESABLES.find(c => c.id === payload.id);
        return claseEnRevision(payload.id, clase ? clase.classNumber : 1);
    },
    saveReview: async payload => {
        await espera(500);
        enMemoria.planes[payload.id] = payload.segments;
        const kept = (payload.segments || []).filter(s => s.keep);
        return {
            ok: true,
            cutplan: Object.assign(claseEnRevision(payload.id, 1).cutplan, { segments: payload.segments }),
            exported: {
                sequenceName: '01_curso-de-prueba',
                finalXml: `${CURSO}/The Cutter/01_final.xml`,
                populatedXml: `${CURSO}/The Cutter/01_poblada.xml`,
                alignedXml: `${CURSO}/The Cutter/01_alineada.xml`,
                keepSec: kept.reduce((a, s) => a + (s.durationSec || 0), 0),
                segments: kept.length
            },
            tambien: [{ classNumber: 3, porque: 'notas_nuevas' }],
            fallas: []
        };
    },
    pendientes: async () => ({
        carpeta: { root: CURSO, nombre: '2609_curso-de-prueba' },
        otras: [{ id: PROCESABLES[1].id, classNumber: 2, sequenceName: '02_curso-de-prueba', porque: 'notas_nuevas', motivo: 'Tiene comentarios que todavía no están en el XML' }],
        afuera: [{ id: PROCESABLES[2].id, classNumber: 1, sequenceName: '01_taller-corto', porque: 'sin_exportar', motivo: 'Nunca se exportó' }]
    }),
    saveNotas: async payload => {
        enMemoria.notas[payload.id] = { bloques: payload.bloques, comentarios: payload.comentarios };
        return { ok: true, notas: { version: 1, sequenceName: '01_curso-de-prueba', bloques: payload.bloques, comentarios: payload.comentarios, updatedAt: new Date().toISOString() } };
    },
    waveformWindow: async payload => {
        const fromSec = payload.fromSec || 0;
        const toSec = payload.toSec || DURACION_SEC;
        return { peaks: picos(fromSec, toSec, payload.buckets || 900), durationSec: DURACION_SEC, fromSec, toSec };
    },

    /**
     * "Iniciar grabación": una sesión NUEVA, o sea vacía.
     *
     * Como allá: sin carpeta no arranca, con una sesión en curso no arranca, y la
     * que arranca no tiene ninguna toma —las abre el profesor contando—. Acá
     * contestaba siempre que sí y con la clase de la maqueta ya medio grabada, así
     * que ni el error ni el estado vacío de la lista se podían mirar.
     */
    grabarIniciar: async payload => {
        const p = payload || {};
        if (!p.dir) return { ok: false, error: 'Falta la carpeta donde guardar las notas.' };
        if (sesionEnVivo()) return { ok: false, error: 'Ya hay una grabación en curso.' };
        ponerAGrabar(Date.now(), false);
        enMemoria.carpeta = p.dir;
        // La sesión nace con la lista que la carpeta ya tenía, como allá
        // (`temarioSesion.heredar`): sin esto, apretar "Iniciar" perdería de vista
        // la lista que se acababa de pegar y la maqueta enseñaría eso.
        enMemoria.temario = enMemoria.temarioPorCarpeta[p.dir] || null;
        pedirLaCobertura();
        return { ok: true, estado: porElPuente(resumenEnVivo()) };
    },
    grabarPcm: () => {},
    // El estado pelado, como el canal de verdad: la pantalla se lo guarda tal
    // cual (`vista.estado = await …`), así que envuelto en `{ok, estado}` dejaba
    // la vista con un objeto que no era un estado y la pantalla se vaciaba.
    //
    // Y la claqueta queda EN LA HORA QUE LLEGA y con `origen: 'editor'`, que es lo
    // que hace que el cartel diga "puesta a mano": acá se ignoraba el argumento y
    // se contestaba la claqueta de fábrica, o sea que apretar el botón no movía
    // nada y el estado que el botón existe para producir no se veía nunca.
    // Y deja su paso en el historial, como allá: no es de ninguna toma, pero
    // reescribe el archivo igual, así que se deshace con Cmd-Z como todo lo demás
    // (`claqueta` en `engine/grabacion.js`).
    grabarClaqueta: async paredMs => {
        const sesion = sesionEnVivo();
        if (!sesion) return null;
        const antes = fotoDeCampo(sesion.claqueta);
        sesion.claqueta = {
            ms: Number(paredMs) || Date.now(),
            frase: '',
            confirmada: true,
            origen: 'editor'
        };
        anotarDeLaSesionEnMemoria('claqueta', antes, { tipo: 'claqueta' });
        return porElPuente(resumenEnVivo());
    },
    /**
     * La lista pegada, sin medir todavía.
     *
     * Vuelve en el acto y con `midiendoTemario` puesto, como allá: la medición
     * sale detrás y llega por un aviso (ver `pedirLaCobertura`).
     *
     * Pegar la MISMA lista otra vez se planta antes de tocar nada, como allá: sin
     * eso el gesto tira la cobertura ya medida para volver a medir lo mismo, y
     * deja un paso en el historial que al deshacerse no se ve.
     *
     * **Sin sesión también se pega, y es el camino normal**: la lista del CD llega
     * antes de grabar y el panel la ofrece desde que se entra a la toma de notas.
     * Allá queda en un archivo de la carpeta y acá en memoria, indexada por
     * carpeta, que es lo mismo salvo por lo único que la maqueta no puede mostrar
     * —que sobreviva a cerrar la app—. Vuelve con la forma mínima, la lista y nada
     * más, porque no hay sesión de la que hacer un resumen.
     */
    grabarTemario: async (texto, dir) => {
        if (!sesionEnVivo()) {
            const puesta = temarioGuardado(texto);
            enMemoria.temarioPorCarpeta[dir] = puesta;
            // Y vuelve como 'pegado' aunque quede guardada como 'guardado', igual
            // que allá (`ponerEnElCurso`): el rótulo del panel avisa que una lista
            // apareció sola, y la que se acaba de pegar la pegó quien mira.
            return porElPuente({ temario: puesta && { ...puesta, origen: 'pegado' } });
        }
        const antes = fotoDeCampo(enMemoria.temario);
        const nuevo = temarioPegado(texto);
        if (antes && nuevo && antes.texto === nuevo.texto) return porElPuente(resumenEnVivo());

        enMemoria.temario = nuevo;
        // Lo pegado con la clase empezada también queda para la carpeta: la lista
        // es del curso y no de esta clase (ver `poner` en `temario-sesion.js`).
        enMemoria.temarioPorCarpeta[carpetaEnVivo()] = temarioGuardado(texto);
        anotarDeLaSesionEnMemoria('temario', antes, { tipo: 'temario', texto });
        pedirLaCobertura();
        return porElPuente(resumenEnVivo());
    },
    /** La lista guardada para una carpeta, con la de la sesión ganando si hay una. */
    grabarTemarioCarpeta: async dir => porElPuente(
        sesionEnVivo() ? enMemoria.temario : (enMemoria.temarioPorCarpeta[dir] || null)
    ),
    // Sin demora, y es a propósito: allá esto es memoria y dos escrituras en
    // disco, o sea que vuelve en el mismo suspiro. Y esa velocidad es lo que hace
    // dura la prueba — la respuesta cae en un microtask, o sea ENTRE el mousedown
    // y el mouseup del clic que la pidió, que es exactamente la ventana donde el
    // repintado se comía el clic siguiente. Demorarla acá ablandaría el arnés.
    grabarEditar: async cambio => porElPuente(manoEnVivo(cambio)),
    // Envuelto acá y no adentro, como en `ipc/grabar.js`: el motor tira con el
    // motivo y el puente lo convierte en `{ok:false, error}`, que es lo que la
    // pantalla muestra tal cual.
    grabarEditarGrabada: async (json, cambio) => {
        await espera(120);
        try {
            return { ok: true, ...editarEnMemoria(json, cambio) };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },
    // Los dos de gestionar la lista, envueltos igual que el de arriba y que
    // `ipc/grabar.js`: el motor tira con el motivo y el puente lo convierte en
    // `{ok:false, error}`, que es lo que el formulario muestra tal cual. La demora
    // es la de tres archivos moviéndose, no la de un campo del sidecar.
    grabarRenombrar: async (json, cambio) => {
        await espera(180);
        try {
            return { ok: true, ...renombrarEnMemoria(json, cambio) };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },
    grabarBorrar: async json => {
        await espera(180);
        try {
            return { ok: true, ...borrarEnMemoria(json) };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },
    grabarCerrarToma: async () => {
        const sesion = sesionEnVivo();
        if (!sesion) return null;
        const abierta = sesion.tomas.find(t => t.outMs == null);
        if (!abierta) return porElPuente(resumenEnVivo());
        const antes = fotoDeToma(abierta);
        // En su última palabra, como `finDeToma` del otro lado.
        const ultima = (abierta.palabras || [])[(abierta.palabras || []).length - 1];
        abierta.outMs = ultima ? ultima.t + 400 : abierta.inMs + 1000;
        abierta.despues = [];
        anotarEnMemoria({
            que: comoSeLlamaEnMemoria({ tipo: 'cerrar', toma: abierta.id }),
            id: abierta.id, antes, despues: fotoDeToma(abierta)
        });
        // El estado vuelve YA y la medida llega después, que es el orden de allá:
        // cerrar una toma la encola para releerla y medirla, y eso tarda.
        medirLaTomaCerrada(abierta);
        return porElPuente(resumenEnVivo());
    },
    grabarDeshacer: async () => porElPuente(volverEnMemoria('atras')),
    grabarRehacer: async () => porElPuente(volverEnMemoria('adelante')),
    // Null mientras no haya nada grabando, que es como abre la app; con
    // `?grabando` la sesión ya está puesta y la pantalla la encuentra sola por el
    // mismo camino que del otro lado.
    grabarEstado: async () => porElPuente(resumenEnVivo()),
    grabarVistas: async () => porElPuente(VISTAS),
    // Copiadas, y sin la que se está grabando. Acá salía la lista VIVA: la ventana
    // se quedaba con el mismo objeto que la maqueta sigue tocando, así que un
    // cambio posterior aparecía solo en pantalla sin que nadie repintara nada —la
    // misma mentira que tenía `grabarEditar` antes de `porElPuente`.
    /**
     * Las clases de LAS CARPETAS QUE SE PIDEN, como `clasesGrabadas.listar(dirs)`:
     * el motor abre esas carpetas y no sabe de ninguna otra.
     *
     * Acá el argumento se ignoraba y volvía todo lo que hubiera en memoria, así
     * que una carpeta quitada dejaba sus clases sueltas en la lista: escondidas
     * en el modo por carpeta —no hay cabecera de la que colgarlas— y a la vista
     * en «Por fecha», que es donde se nota que la carpeta se fue a medias.
     */
    grabarListar: async dirs => {
        const donde = new Set(dirs || []);
        const sesion = sesionEnVivo();
        return porElPuente(listaGrabadas()
            .filter(c => donde.has(c.carpeta))
            .filter(c => !sesion || c.secuencia !== sesion.secuencia));
    },
    /**
     * Releer una clase terminada con el modelo grande.
     *
     * Con una grabación en curso NO se puede: el Whisper de las señales tiene la
     * GPU (`gpu.ocupada` en `clasesGrabadas.regenerar`), y eso es lo primero que
     * contesta. Acá contestaba `{ok:true}` pelado y en el acto, así que la maqueta
     * dejaba regenerar mientras grababa —que la app prohíbe— y la tarjeta no podía
     * mostrar su cuenta de tomas releídas, que llega por aviso.
     */
    grabarRegenerar: async json => {
        if (sesionEnVivo()) {
            return { ok: false, error: 'Terminá la grabación en curso antes de regenerar una clase.' };
        }
        const clase = listaGrabadas().find(c => c.archivos.json === json);
        if (!clase) return { ok: false, error: 'No encuentro esa clase.' };
        const tomas = clase.tomas.filter(t => t.inMs != null && t.outMs != null);
        for (let i = 0; i < tomas.length; i++) {
            await espera(DEMORA_DE_RELECTURA_MS);
            avisar('grabar-aviso', { tipo: 'regenerando', json, hechas: i + 1, total: tomas.length });
        }
        return { ok: true, tomas: tomas.length, sinAudio: 0, archivos: clase.archivos };
    },
    /**
     * "Terminar": se cierra lo abierto, se relee lo pendiente y se suelta todo.
     *
     * Tarda, y eso es lo que pone el botón en "Terminando…" — el estado se empuja
     * antes de la espera para que la pantalla lo diga mientras pasa.
     *
     * Lo que devuelve es el resumen con `archivos`, o sea que sigue diciendo
     * `grabando: true`: allá es una constante del resumen y quien decide que se
     * terminó es que después no haya sesión. Y no hay: la sesión se suelta, la
     * clase pasa a la lista de las grabadas y `grabarEstado` contesta null.
     */
    grabarTerminar: async () => {
        const sesion = sesionEnVivo();
        if (!sesion) return null;
        sesion.terminando = true;
        empujar();

        // El reloj de las señales para acá, en el primer renglón del cierre y no
        // al final (`cerrarLoAbierto`): de acá en más nadie oye nada, así que la
        // toma abierta cierra en su última palabra y no en la hora de ahora.
        pararElEmpujon();
        const abierta = sesion.tomas.find(t => t.outMs == null);
        if (abierta) {
            const ultima = (abierta.palabras || [])[(abierta.palabras || []).length - 1];
            abierta.outMs = ultima ? ultima.t + 400 : abierta.inMs + 1000;
            abierta.cerradaSola = true;
            abierta.despues = [];
        }
        await espera(DEMORA_DE_CIERRE_MS);

        const salida = { ...resumenEnVivo(), archivos: sesion.archivos };
        listaGrabadas().unshift(comoQuedaGrabada(sesion));
        soltarLaSesion();
        return porElPuente(salida);
    },
    onGrabarAviso: cb => { oyentes['grabar-aviso'] = cb; },

    /**
     * El proyecto de Premiere de un curso entero.
     *
     * La plantilla arranca SIN elegir, que es como está una máquina recién
     * instalada y es el camino que hay que poder mirar: el botón tiene que pedirla
     * la primera vez. `plantillaElegida` la recuerda dentro de la vida de la
     * pestaña —no en los ajustes— porque acá no hay Premiere que la escriba, y
     * fingir que quedó guardada en disco sería una de las mentiras que esta
     * maqueta viene evitando.
     */
    // En la app de verdad la plantilla se busca sola entre los proyectos del
    // editor y casi nunca se pregunta. La maqueta hace lo mismo: contesta que la
    // encontró, con `hallada` para que se vea el aviso de cuál salió elegida.
    prprojPlantilla: async () => (plantillaElegida
        ? { ok: true, ruta: plantillaElegida }
        : { ok: true, ruta: `${CURSO}/Curso viejo.prproj`, hallada: true }),
    prprojElegirPlantilla: async () => {
        plantillaElegida = `${CURSO}/Plantilla de mentira.prproj`;
        return { ok: true, ruta: plantillaElegida };
    },
    /**
     * Avisa clase por clase, como el motor de verdad, en vez de contestar de una.
     * El botón muestra una cuenta que sube y el cabezal se repinta debajo mientras
     * tanto: si acá contestara al toque, ese camino no se podría mirar nunca.
     */
    prprojGenerar: async carpeta => {
        const suyas = listaGrabadas().filter(c => c.carpeta === carpeta && c.archivos);
        if (!suyas.length) return { ok: false, error: 'No hay ninguna clase con XML en esta carpeta.' };
        for (let i = 0; i < suyas.length; i++) {
            await espera(DEMORA_DE_RELECTURA_MS);
            avisar('prproj-aviso', {
                carpeta, hecho: i + 1, total: suyas.length,
                que: `Clase ${suyas[i].clase}`
            });
        }
        // Con avisos y con cuenta, que es como vuelve del motor de verdad: sin
        // ellos la maqueta mostraría un «Detalle» vacío y no se vería el caso
        // que motivó separarlos, que es el de un aviso real enterrado entre la
        // narración de trece clases.
        const nombre = carpeta.split('/').filter(Boolean).pop();
        const conRecuadro = suyas.filter(c => (c.vistas || []).length > 1);
        return {
            ok: true,
            ruta: `${carpeta}/Proyecto/${nombre}.prproj`,
            clases: suyas.length,
            avisos: conRecuadro.length
                ? [`${conRecuadro.length * 4} corte(s) de ${conRecuadro.length} clase(s) traían el`
                    + ' recuadro puesto en el XML: entran en su lugar y con su duración, pero'
                    + ' sin el encuadre.']
                : [],
            cuenta: [
                `Salió de ${suyas.length} clase(s) procesada(s) en «The Cutter»:`
                    + ' trae el material, los cortes y los marcadores.',
                `${suyas.length} secuencia(s), ${suyas.length * 162} corte(s),`
                    + ` ${suyas.length * 5} marcador(es) y ${suyas.length * 12} archivo(s) de material.`
            ]
        };
    },
    onPrprojAviso: cb => { oyentes['prproj-aviso'] = cb; },

    reveal: async t => { window.alert(`Mostraría en el Finder:\n${t}`); return { ok: true }; },
    openPath: async t => { window.alert(`Abriría:\n${t}`); return { ok: true }; },

    anotar: async () => ({ ok: true }),
    // La forma es la que devuelve `registro.escribir`: el botón muestra
    // `lineas`, y con `path` en vez de `archivo` decía "undefined líneas".
    registroDescargar: async () => ({
        ok: true,
        archivo: '/Users/vos/Downloads/class-cut-log-20260909-163000.md',
        lineas: 1847
    }),
    pathForFile: file => `${CURSO}/${file && file.name ? file.name : 'arrastrada'}`,

    onScanFound: cb => { oyentes['scan-found'] = cb; },
    onScanProgress: cb => { oyentes['scan-progress'] = cb; },
    onProcessStage: cb => { oyentes['process-stage'] = cb; },
    onProcessClass: cb => { oyentes['process-class'] = cb; },
    onUpdateProgress: cb => { oyentes['update-progress'] = cb; },
    onUpdateReady: cb => { oyentes['update-ready'] = cb; }
};

/**
 * La puerta para probar a mano lo que la maqueta no puede mostrar sola.
 *
 * Hay estados que existen solo mientras algo pasa —la pantalla grabando— y que
 * abriendo la app nunca se ven quietos. El camino corto es abrir
 * `localhost:4321/?grabando`; desde la consola del navegador:
 *
 *   maqueta.grabando()     pinta la sesión en curso donde esté
 *   maqueta.empujar()      un empujón del estado a mano, sin esperar el ciclo
 *   maqueta.cargar()       vuelve a meter las dos carpetas
 */
window.maqueta = {
    sesionEnVivo,
    resumenEnVivo,
    // Para tocar la sesión desde la consola y ver el resultado sin esperar los
    // tres segundos del ciclo:
    //
    //   maqueta.sesionEnVivo().tomas[1].descartada = true;
    //   maqueta.empujar();
    //
    // El agregado de lenguaje ya no hay que rehacerlo a mano: `resumenEnVivo` lo
    // calcula en cada lectura, igual que el motor.
    empujar: () => empujar(),
    grabando: () => window.dev.grabarEstado(resumenEnVivo()),
    agregadoDeLengua,
    cargar: cargarCarpetas,
    datos: { CARPETAS, VISTAS, revision: id => claseEnRevision(id || PROCESABLES[0].id, 1) }
};

/**
 * Las dos carpetas entran solas al abrir.
 *
 * Podría dejarse la pantalla vacía y que quien mira apriete "Elegir carpeta…",
 * pero entonces lo primero que se ve de la app es su estado vacío, y el estado
 * vacío es la única pantalla que ya se puede mirar sin maqueta. Lo que cuesta
 * ver —la tabla con clases de verdad, agrupadas por carpeta, unas procesadas y
 * otras no— es lo que conviene tener delante al abrir.
 */
async function cargarCarpetas() {
    for (const carpeta of CARPETAS) await window.dev.addFolder(carpeta.root);
}

const abreGrabando = () => new URLSearchParams(location.search).has('grabando');

/**
 * `?grabando` abre la maqueta con una clase a medio grabar.
 *
 * Es el estado que no se puede ver quieto abriendo la app: hay que apretar
 * "Iniciar grabación" y esperar a que pasen cosas. Deja además el temario del CD
 * ya pegado y medido, porque el bloque de cobertura vacío solo muestra su estado
 * pendiente y lo que hay para mirar es la lista con unos temas dichos y otros no.
 * Para verlo vacío, se borra la lista desde el mismo desplegable.
 */
function arrancarGrabando() {
    // Colgado de la hora de ahora y no de la fecha fija: los relojes del bloque
    // "La sesión" cuentan contra el cero, así que con la fija dirían que se lleva
    // grabando desde septiembre.
    ponerAGrabar(Date.now() - CORRIDOS * 1000, true);
    // En qué carpeta graba, que es a la que le va a quedar la lista si alguien
    // pega otra desde el desplegable.
    enMemoria.carpeta = CURSO;
    // Ya medido, y por eso puesto a mano en vez de pedido: una clase a medio
    // grabar ya tuvo tiempo de que le contestaran, y lo que hay para mirar es la
    // lista con unos temas dichos y otros no. El camino lento —pegar y esperar—
    // se ejercita pegando una lista nueva desde el mismo desplegable.
    const temario = temarioPegado([
        'Objetivos de la clase:',
        '- Mostrar la diferencia entre pedir algo puntual y dar contexto del proyecto',
        '- Explicar qué es spec driven development y por qué cambia la forma de escribir código',
        '- Armar una especificación corta en vivo, de punta a punta',
        '- Enseñar a revisar lo que el modelo devuelve antes de aceptarlo',
        '- Dejar el proyecto corriendo con la primera especificación aplicada'
    ].join('\n'));
    enMemoria.temario = { ...temario, cobertura: coberturaDe(temario.objetivos) };
    window.dev.abrirGrabar();
}

// `dev` lo publica `app.js`, que corre después de este archivo.
window.addEventListener('DOMContentLoaded', () => setTimeout(async () => {
    await cargarCarpetas();
    if (abreGrabando()) arrancarGrabando();
}, 60));

})();
