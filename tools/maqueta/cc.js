'use strict';
/**
 * maqueta/cc.js — El puente de Electron, de mentira, para mirar el diseño.
 *
 * Lo carga `tools/maqueta.js` antes que `app.js`. Pone un `window.cc` con las
 * mismas funciones que expone `preload.js`, contestando de memoria: la interfaz
 * corre entera en un navegador común, sin Electron, sin Node y sin material.
 *
 * Dos reglas al escribir esto:
 *
 *   1. **La forma es la de verdad.** Cada objeto de acá tiene los campos que el
 *      motor devuelve, con sus unidades —segundos en la revisión, milisegundos
 *      de reloj en la grabación—. Un campo inventado se ve bien acá y explota
 *      en la app, que es peor que no tener maqueta.
 *
 *   2. **Los casos se eligen, no se repiten.** Cuatro clases iguales no dicen
 *      nada del diseño. Hay una procesada y al día, una que hay que rehacer, una
 *      sin procesar, una que no se puede procesar, una carpeta con avisos y otra
 *      con una clase repetida. En la revisión hay bloques de confianza baja,
 *      hallazgos ya corregidos y comentarios encima del transcript, porque son
 *      los estados que en el uso normal aparecen de a poco y nunca juntos.
 *
 * No es un simulador: nadie corta nada, nada se guarda en disco. Guardar
 * contesta que sí y devuelve lo que la pantalla necesita para seguir dibujando.
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

/** El XML y el sidecar de una clase de notas, donde la app los va a poner. */
function archivosDeNotas(carpeta, nombre) {
    return {
        xml: `${carpeta}/${NOTAS.xml}/${nombre}.xml`,
        json: `${carpeta}/${NOTAS.datos}/${nombre}${NOTAS.sufijo}`
    };
}

const espera = ms => new Promise(r => setTimeout(r, ms));

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

// El cero de la sesión que se muestra grabando. Los relojes del bloque "La
// sesión" cuentan contra este número, así que con la fecha fija de arriba dirían
// que se lleva grabando desde septiembre. Abriendo la maqueta con `?grabando` se
// cuelga de la hora de ahora y los relojes corren de verdad; sin eso se queda con
// la fija, que es lo que hace repetibles las capturas.
let ceroDeLaSesion = CERO;
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
 */

const EMPALME_MINIMO_RECORTE_MS = 1500;
const EMPALME_MINIMO_QUEDA_MS = 3000;

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
        if (toma.outMs - dichas[i].t < EMPALME_MINIMO_RECORTE_MS) continue;
        if (dichas[i].t - toma.inMs < EMPALME_MINIMO_QUEDA_MS) break;
        return dichas[i];
    }
    return null;
}

/**
 * El empalme de `actual` con `previa`, tal como lo sirve el motor.
 *
 * @param {object} pagado lo que contestó el modelo y quedó guardado en la toma:
 *   contra quién y desde qué palabra. Es lo único que allá se guarda, porque es
 *   lo único que se pagó.
 */
function empalmeDe(previa, actual, pagado) {
    if (!previa || !actual || !pagado) return null;
    if (actual.outMs == null || actual.descartada || previa.descartada) return null;

    const vista = {
        contra: previa.id,
        parecido: pagado.parecido,
        estado: 'listo',
        porque: '',
        sugerencia: null
    };

    if (actual.empalmeDescartado === previa.id) {
        vista.estado = 'descartado';
        vista.porque = 'Descartaste el ajuste de este empalme.';
        return vista;
    }

    const dichas = previa.palabras || [];
    const corte = dichas.find(w => w.t === pagado.paredMs);
    // La palabra del corte ya no está en la toma: el borde se movió y lo que
    // decía la sugerencia dejó de ser cierto.
    if (!corte) return vista;

    const repetido = dichas.filter(w => w.t >= corte.t);
    vista.sugerencia = {
        origen: 'modelo',
        porque: pagado.porque,
        enLaAnterior: tramoDe(previa.id, repetido),
        enEsta: tramoDe(actual.id, (actual.palabras || []).slice(0, repetido.length)),
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
    return vista;
}

/** El empalme de todas las tomas de la sesión, rehecho contra el estado de ahora. */
function empalmesEnVivo(tomas) {
    for (const toma of tomas) toma.empalme = null;
    const pagado = enMemoria.empalmePagado;
    if (!pagado) return;
    const actual = tomas.find(t => t.id === pagado.toma);
    const previa = tomas.find(t => t.id === pagado.contra);
    if (actual) actual.empalme = empalmeDe(previa, actual, pagado);
}

// Cuánto lleva grabando la sesión, y en qué segundo abre la toma que sigue en
// curso. Van juntos acá arriba porque el cero en vivo se calcula restando el
// primero a la hora de ahora: si se separan, los relojes y las palabras de la
// toma abierta cuentan contra momentos distintos.
const CORRIDOS = 420;
const ABRE_LA_ULTIMA = 250;

/**
 * La sesión grabando. Sin argumento cuelga de `ceroDeLaSesion`, que es lo que
 * decide si los relojes de arriba están quietos o corriendo.
 *
 * Se arma UNA vez por cero y queda guardada (`enMemoria.sesion`). Antes se
 * rearmaba en cada llamada, y eso hacía que la maqueta mintiera en lo peor:
 * descartar una toma, comentar o mover un borde se dibujaba un instante y
 * desaparecía en el repintado siguiente, porque el estado que contestaba el
 * puente era otra vez el de fábrica. Del lado de la app el motor guarda la
 * sesión, así que acá también.
 */
function sesionEnVivo(ceroMs) {
    if (ceroMs != null) return armarSesion(ceroMs);
    if (!enMemoria.sesion || enMemoria.sesion.ceroMs !== ceroDeLaSesion) {
        enMemoria.sesion = armarSesion(ceroDeLaSesion);
    }
    // El temario se pega aparte y la lengua depende de qué tomas quedan, así que
    // los dos se rehacen al servir: es lo que hace el motor en cada `resumen`.
    enMemoria.sesion.temario = enMemoria.temario;
    enMemoria.sesion.lengua = agregadoDeLengua(enMemoria.sesion.tomas);
    empalmesEnVivo(enMemoria.sesion.tomas);
    const abierta = enMemoria.sesion.tomas.find(t => t.outMs == null);
    enMemoria.sesion.abierta = abierta ? abierta.id : null;
    enMemoria.sesion.historia = {
        atras: enMemoria.historia.atras.length,
        adelante: enMemoria.historia.adelante.length,
        queAtras: ultimo(enMemoria.historia.atras),
        queAdelante: ultimo(enMemoria.historia.adelante)
    };
    return enMemoria.sesion;
}

const ultimo = pila => (pila.length ? pila[pila.length - 1].que : '');

function armarSesion(cero) {
    const tomas = [
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

    // El empalme de la 2 con la 1, que es lo que el modelo contestó cuando la 2
    // cerró. Se guarda acá y no en la toma porque es lo único que allá queda
    // guardado —lo que se pagó—: la sugerencia se rehace al servir contra las
    // palabras de ese momento. La 2 ya venía con la nota "Repite el arranque",
    // así que es la que corresponde.
    const corte = abreLaUltimaFrase(tomas[0]);
    enMemoria.empalmePagado = corte ? {
        toma: tomas[1].id,
        contra: tomas[0].id,
        parecido: 0.62,
        paredMs: corte.t,
        porque: 'Las dos tomas explican que hay que darle contexto de todo el proyecto y no un pedido puntual.'
    } : null;

    return {
        secuencia: '05_curso-de-prueba_2026-09-08_15-20-00',
        clase: 5, parte: 1, curso: '2609_curso-de-prueba',
        ceroMs: cero,
        claqueta: { ms: cero + 6000, confirmada: true },
        vistas: VISTAS,
        dir: CURSO,
        // Dónde van a caer los dos archivos. El motor lo manda con cada resumen y
        // es de donde el cartel de arriba saca la ruta que muestra.
        archivos: archivosDeNotas(CURSO, '05_curso-de-prueba_2026-09-08_15-20-00'),
        grabando: true,
        terminando: false,
        segundos: CORRIDOS,
        abierta: 4,
        // El temario del CD arranca vacío, que es como arranca una clase: el
        // bloque de cobertura se mira primero en su estado pendiente, y pegar la
        // lista (`grabarTemario`) es lo que lo llena.
        temario: enMemoria.temario,
        midiendoTemario: false,
        // Cómo viene hablando, agregado sobre las tomas que quedan. Va calculado
        // y no escrito a mano porque del otro lado también lo calcula el motor.
        lengua: agregadoDeLengua(tomas),
        historia: { atras: 0, adelante: 0, queAtras: '', queAdelante: '' },
        tomas
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
    return sesionEnVivo().tomas.find(t => t.id === id) || null;
}

const fotoDeToma = t => (t ? JSON.parse(JSON.stringify(t)) : null);

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

function manoEnVivo(cambio) {
    const c = cambio || {};
    const sesion = sesionEnVivo();
    const toma = tomaEnVivo(c.toma);
    if (!toma) return sesion;

    const antes = fotoDeToma(toma);
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
        // Contra quién se descartó, y no un simple sí: si la toma pasa a empalmar
        // con otra, la pregunta es otra y esta marca no tiene que valer.
        //
        // Y en la TOMA, no en un campo suelto de `enMemoria`, porque es donde lo
        // guarda el motor (`empalme.descartar`, que escribe `empalme.descartado`).
        // Lo que cuelga de la toma entra en la foto de `fotoDeToma`, así que
        // descartar se deshace con Cmd-Z como todo lo demás; en un campo aparte
        // la maqueta mentía justo en eso.
        toma.empalmeDescartado = Number(c.contra);
    } else if (c.tipo === 'borde') {
        repartirEnMemoria(toma, c.borde, Number(c.paredMs));
    } else if (c.tipo === 'reabrir') {
        toma.outMs = null;
        toma.despues = [];
    } else if (c.tipo === 'eliminar') {
        if (!toma.descartada) return sesion;
        sesion.tomas.splice(sesion.tomas.indexOf(toma), 1);
    }

    anotarEnMemoria({
        que: comoSeLlamaEnMemoria(c),
        id: toma.id,
        antes,
        despues: c.tipo === 'eliminar' ? null : fotoDeToma(toma)
    });
    return sesionEnVivo();
}

function comoSeLlamaEnMemoria(c) {
    const cual = `la toma ${c.toma}`;
    if (c.tipo === 'vista') return `poner ${cual} en ${c.vista}`;
    if (c.tipo === 'nota') return `la nota de ${cual}`;
    if (c.tipo === 'descartar') return `${c.descartada ? 'descartar' : 'recuperar'} ${cual}`;
    if (c.tipo === 'comentar') return `comentar «${String(c.texto || '').slice(0, 30)}»`;
    if (c.tipo === 'borrar-comentario') return `quitar un comentario de ${cual}`;
    if (c.tipo === 'descartar-ajuste') return `descartar el ajuste de ${cual}`;
    if (c.tipo === 'borde') return `mover el ${c.borde === 'in' ? 'IN' : 'OUT'} de ${cual}`;
    if (c.tipo === 'eliminar') return `eliminar ${cual}`;
    if (c.tipo === 'cerrar') return `cerrar ${cual}`;
    return `el cambio en ${cual}`;
}

function anotarEnMemoria(paso) {
    enMemoria.historia.atras.push(paso);
    enMemoria.historia.adelante.length = 0;
}

function volverEnMemoria(hacia) {
    const desde = hacia === 'adelante' ? enMemoria.historia.adelante : enMemoria.historia.atras;
    const a = hacia === 'adelante' ? enMemoria.historia.atras : enMemoria.historia.adelante;
    const paso = desde[desde.length - 1];
    if (!paso) return { ok: false, estado: sesionEnVivo() };

    const foto = hacia === 'adelante' ? paso.despues : paso.antes;
    const tomas = sesionEnVivo().tomas;
    if (foto && foto.outMs == null && tomas.some(t => t.id !== paso.id && t.outMs == null)) {
        return {
            ok: false,
            error: `No puedo ${hacia === 'adelante' ? 'rehacer' : 'deshacer'} «${paso.que}»: ` +
                'mientras tanto se abrió otra toma, y dos tomas abiertas a la vez rompen ' +
                'el ciclo de señales. Cerrá la de ahora y volvé a intentar.',
            estado: sesionEnVivo()
        };
    }

    desde.pop();
    a.push(paso);
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
    return { ok: true, que: paso.que, estado: sesionEnVivo() };
}

function grabadas() {
    const hecha = (clase, hora, hacerTomas, comoSeLlama) => {
        const nombre = comoSeLlama || `0${clase}_curso-de-prueba_2026-09-08_${hora}`;
        const ceroMs = Date.parse(`2026-09-08T${hora.replace(/-/g, ':')}`);
        const tomas = hacerTomas(ceroMs);
        return {
            secuencia: nombre,
            clase, parte: 1, curso: '2609_curso-de-prueba',
            ceroMs,
            claqueta: { ms: ceroMs + 6000, confirmada: true },
            vistas: VISTAS,
            // La clase ya grabada también trae su agregado: lo que se midió en
            // vivo quedó en el sidecar, así que se puede volver a mirar después.
            lengua: agregadoDeLengua(tomas),
            tomas,
            carpeta: CURSO,
            archivos: archivosDeNotas(CURSO, nombre)
        };
    };
    return [
        muestrarioDeVistas(hecha),
        hecha(3, '12-10-00', cero => [
            tomaDe(0, 15, 50, null, cero),
            comentarSobre(tomaDe(1, 80, 62, null, cero), 20, 27, 'Sacar un clip corto de acá'),
            tomaDe(2, 160, 45, { descartada: true }, cero)
        ]),
        hecha(2, '10-30-00', cero => [tomaDe(3, 12, 70, null, cero), tomaDe(0, 95, 55, null, cero)])
    ];
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
    // La sesión que se está grabando, para que lo que se le hace quede hecho, y
    // lo que se le hizo, para poder volver (ver `sesionEnVivo`).
    sesion: null,
    historia: { atras: [], adelante: [] }
};

/**
 * El temario pegado y su cobertura, de mentira.
 *
 * Del lado de la app esto lo parte `engine/temario.js` y lo mide un modelo; acá
 * hace falta un parseo mínimo para que la lista pegada se vea partida, y una
 * cobertura inventada para poder mirar los dos estados a la vez. **Deja un
 * objetivo cubierto y otro sin cubrir a propósito**: con todos cubiertos o todos
 * faltando, la mitad del diseño del bloque no aparece nunca.
 *
 * `como: 'ia'` es lo que dibuja la medición normal; poniéndolo en `'palabras'`
 * se ve el cartel de "es una aproximación", y con `fallo` el de "no se pudo
 * medir". Los tres estados se miran cambiando esta función.
 */
function temarioDe(texto) {
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

    // Las tomas cerradas de la sesión: es de donde tiene que salir el número que
    // se muestra al lado de un objetivo cubierto, porque es el que se puede ir a
    // mirar. Inventarlo dejaría el panel señalando tomas que no están.
    const cerradas = [1, 2];
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
        texto: String(texto || ''),
        objetivos,
        origen: 'pegado',
        fallo: null,
        cobertura: {
            como: 'ia',
            medidoEn: new Date().toISOString(),
            modelo: 'claude-sonnet-5-thinking-high',
            huella: `maqueta-${objetivos.length}`,
            cubiertos,
            faltan: medidos.length - cubiertos,
            objetivos: medidos
        }
    };
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
 * El mismo cambio que `vivo.aplicar` del lado del motor, y solo los mismos: los
 * que se resuelven con lo que ya está escrito. Mover un borde entra —las orillas
 * de la toma están acá, así que es repartir de nuevo lo mismo— y reabrir sobre
 * una clase cerrada tiene que fallar acá también, porque en la app falla.
 */
/**
 * Las tres listas juntas, el borde corrido, y a repartir de nuevo: es lo que hace
 * `moverBordeGuardado` allá, en cuatro líneas y sin sus reglas. Acá alcanza con
 * que la maqueta muestre el texto repartido; lo que decide qué borde es legal se
 * prueba con el motor de verdad.
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

function editarEnMemoria(json, cambio) {
    const c = cambio || {};
    const clase = listaGrabadas().find(x => x.archivos.json === json);
    if (!clase) return { ok: false, error: 'No encuentro esa clase.' };
    const toma = clase.tomas.find(x => x.id === c.toma);
    if (!toma) return { ok: false, error: `Esa clase no tiene la toma ${c.toma}.` };

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
    } else if (c.tipo === 'borde') {
        repartirEnMemoria(toma, c.borde, Number(c.paredMs));
    } else {
        return {
            ok: false,
            error: `Sobre una clase ya grabada no se puede "${c.tipo}": ` +
                'con la clase cerrada eso pide volver a oír el audio, y eso es "Regenerar".'
        };
    }
    return { ok: true, archivos: clase.archivos };
}

/* ─── El puente ──────────────────────────────────────────────────────────── */

const oyentes = {};
const avisar = (canal, payload) => { if (oyentes[canal]) oyentes[canal](payload); };

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

    ajustesLeer: async () => ({
        version: 1,
        notasDir: CURSO,
        notasDirs: [CURSO, TALLER],
        ia: {
            proveedor: 'cursor',
            local: { modelo: null },
            cursor: { modelo: 'claude-sonnet-5-thinking-high' },
            anthropic: { modelo: 'claude-sonnet-4-5' }
        },
        secretos: { anthropic: false }
    }),
    ajustesGuardar: async datos => ({ ok: true, ajustes: Object.assign(await window.cc.ajustesLeer(), datos) }),
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
        return CARPETAS.find(c => c.root === folder) || CARPETAS[0];
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

    grabarIniciar: async () => ({ ok: true, estado: porElPuente(sesionEnVivo()) }),
    grabarPcm: () => {},
    // El estado pelado, como el canal de verdad: la pantalla se lo guarda tal
    // cual (`vista.estado = await …`), así que envuelto en `{ok, estado}` dejaba
    // la vista con un objeto que no era un estado y la pantalla se vaciaba.
    grabarClaqueta: async () => porElPuente(sesionEnVivo()),
    // Tarda: en la app el motor guarda la lista y le pregunta al modelo, y lo que
    // hay que poder mirar es que el panel no se rompa mientras eso pasa.
    grabarTemario: async texto => {
        enMemoria.temario = temarioDe(texto);
        await espera(400);
        return porElPuente(sesionEnVivo());
    },
    grabarEditar: async cambio => porElPuente(manoEnVivo(cambio)),
    grabarEditarGrabada: async (json, cambio) => { await espera(120); return editarEnMemoria(json, cambio); },
    grabarCerrarToma: async () => {
        const abierta = sesionEnVivo().tomas.find(t => t.outMs == null);
        if (!abierta) return porElPuente(sesionEnVivo());
        const antes = fotoDeToma(abierta);
        // En su última palabra, como `finDeToma` del otro lado.
        const ultima = (abierta.palabras || [])[(abierta.palabras || []).length - 1];
        abierta.outMs = ultima ? ultima.t + 400 : abierta.inMs + 1000;
        abierta.despues = [];
        anotarEnMemoria({
            que: comoSeLlamaEnMemoria({ tipo: 'cerrar', toma: abierta.id }),
            id: abierta.id, antes, despues: fotoDeToma(abierta)
        });
        return porElPuente(sesionEnVivo());
    },
    grabarDeshacer: async () => porElPuente(volverEnMemoria('atras')),
    grabarRehacer: async () => porElPuente(volverEnMemoria('adelante')),
    // Sin `?grabando` contesta null, que es como abre la app: sin nada en curso.
    // Con `?grabando` contesta la sesión, así la pantalla la encuentra sola por
    // el mismo camino que del otro lado y no hay que empujarle un estado a mano.
    grabarEstado: async () => (abreGrabando() ? porElPuente(sesionEnVivo()) : null),
    grabarVistas: async () => VISTAS,
    grabarListar: async () => listaGrabadas(),
    grabarRegenerar: async () => ({ ok: true }),
    grabarTerminar: async () => porElPuente(Object.assign(sesionEnVivo(), {
        grabando: false,
        archivos: archivosDeNotas(CURSO, sesionEnVivo().secuencia)
    })),
    onGrabarAviso: cb => { oyentes['grabar-aviso'] = cb; },

    reveal: async t => { window.alert(`Mostraría en el Finder:\n${t}`); return { ok: true }; },
    openPath: async t => { window.alert(`Abriría:\n${t}`); return { ok: true }; },

    anotar: async () => ({ ok: true }),
    registroDescargar: async () => ({ ok: true, path: '/tmp/class-cut-registro.json' }),
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
 *   maqueta.grabando()     la pantalla de grabar, con una sesión en curso
 *   maqueta.cargar()       vuelve a meter las dos carpetas
 */
window.maqueta = {
    sesionEnVivo,
    grabando: () => window.dev.grabarEstado(sesionEnVivo()),
    // Para poder descartar una toma y ver que las tasas se mueven, que es lo que
    // hay que poder mirar del bloque de lenguaje: el motor rehace el agregado en
    // cada aviso, así que la maqueta necesita poder rehacerlo igual.
    //
    //   const s = maqueta.sesionEnVivo();
    //   s.tomas[1].descartada = true;
    //   s.lengua = maqueta.agregadoDeLengua(s.tomas);
    //   dev.grabarEstado(s);
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
    ceroDeLaSesion = Date.now() - CORRIDOS * 1000;
    enMemoria.temario = temarioDe([
        'Objetivos de la clase:',
        '- Mostrar la diferencia entre pedir algo puntual y dar contexto del proyecto',
        '- Explicar qué es spec driven development y por qué cambia la forma de escribir código',
        '- Armar una especificación corta en vivo, de punta a punta',
        '- Enseñar a revisar lo que el modelo devuelve antes de aceptarlo',
        '- Dejar el proyecto corriendo con la primera especificación aplicada'
    ].join('\n'));
    window.dev.abrirGrabar();
}

// `dev` lo publica `app.js`, que corre después de este archivo.
window.addEventListener('DOMContentLoaded', () => setTimeout(async () => {
    await cargarCarpetas();
    if (abreGrabando()) arrancarGrabando();
}, 60));

})();
