'use strict';
/**
 * grabacion.js — La sesión de toma de notas, de principio a fin.
 *
 * Junta las tres piezas: `captura` escribe el audio que manda la ventana, `oir`
 * lo transcribe por pedazos, y `notas-vivo` decide qué es una toma y cómo se
 * escribe. Acá está lo que ninguna de las tres puede tener: el estado de la
 * sesión y los relojes que la mueven.
 *
 * **Vive en el proceso principal y no en la ventana**, aunque la ventana sea la
 * que dibuja. El motivo es que hay una sola verdad: si el estado viviera allá,
 * las señales las decidiría un archivo y el XML lo escribiría otro, y en cuanto
 * discreparan la clase quedaría con marcadores que no son los que se vieron.
 * La ventana pide y dibuja; acá se decide.
 *
 * **Dos ciclos, y la separación es lo que protege el transcript.** El de señales
 * corre acá, seguido y con un modelo liviano, y su texto es descartable: solo
 * sirve para saber si alguien dijo "3, 2, 1" o "Pausa", y de eso solo se le cree
 * la hora. El de toma corre en `relecturas.js`, una vez por toma y con el modelo
 * grande, y ESE texto es el que queda. Así el transcript nunca se arma pegando
 * pedazos, que es de donde salen las palabras cortadas y los tiempos que no
 * cierran.
 *
 * **Qué quedó acá y qué se fue.** Este archivo tiene la sesión: arrancarla, el
 * PCM que llega, el ciclo de señales, la claqueta y el cierre. Lo demás salió a
 * módulos con nombre propio, y todos reciben la sesión en vez de buscarla:
 *
 *   `espejo.js`          lo que se ve de la sesión: el disco y la pantalla
 *   `relecturas.js`      la cola que le rehace el texto a cada toma cerrada
 *   `temario-sesion.js`  cuándo y contra qué se mide la lista del CD
 *   `cambios-toma.js`    lo que el editor cambia a mano, y deshacer
 *   `clases-grabadas.js` las clases que ya están en el disco
 *   `oir-toma.js`        volver a oír un tramo, con o sin sesión
 *
 * Lo de abajo del todo es la fachada: la ventana y las pruebas siguen entrando
 * por `grabacion`, que es lo único que sabe si hay una sesión y cuál es.
 */

const captura = require('./captura');
const golpe = require('./golpe');
const vivo = require('./notas-vivo');
const historial = require('./deshacer');
const nombreDeClase = require('./nombre-de-clase');
const workspace = require('./workspace');
const lengua = require('./lengua');
const empalme = require('./empalme');
const medirToma = require('./medir-toma');
const gpu = require('./gpu');

const espejo = require('./espejo');
const oirToma = require('./oir-toma');
const relecturas = require('./relecturas');
const temarioSesion = require('./temario-sesion');
const cambiosToma = require('./cambios-toma');
const clasesGrabadas = require('./clases-grabadas');

// Los medidores de toma, dados de alta al cargar el módulo: son código y no
// datos de una grabación, así que ninguna sesión puede arrancar con la mitad
// enganchada (ver `engine/medir-toma.js`).
medirToma.registrar(lengua.medidor);
medirToma.registrar(empalme.medidor);

/**
 * Cada cuánto se escucha buscando señales, y cuánto se escucha.
 *
 * La ventana se solapa con la anterior a propósito: una señal que caiga justo en
 * el borde entre dos pedazos aparece partida en los dos y en ninguno completa. Un
 * segundo alcanza para "3, 2, 1", que es la señal más larga.
 */
const CICLO_MS = 3000;
const SOLAPE_MS = 1200;

/** Cuánto se le da a Whisper alrededor de un golpe para leer la frase. */
const MARGEN_CLAQUETA_MS = 4000;

/**
 * Lo que se busca alrededor del aplauso para creerle.
 *
 * El director de contenido dice "Claqueta 7, clase 7" y aplaude, pero Whisper no
 * conoce la palabra: en las trece clases del curso la escribió "Claqueta",
 * "Claquetados", "Cacleta", "Klaqueta" y hasta "clasedos" (pegando "clase dos").
 * De ahí que se busque el pedazo del medio y no la palabra entera.
 *
 * "Clase" a secas NO alcanza y por eso lleva un número detrás: es la palabra más
 * dicha de una clase —"en esta clase vas a entender…"— y con ella cualquier
 * portazo cerca de alguien hablando quedaba confirmado. Con las dos reglas juntas
 * se confirman las trece.
 */
const DICE_CLAQUETA = /claque|cacle|klaque/i;
const DICE_CLASE_N = /\bclase\s*(\d{1,3})\b/i;

let sesion = null;
/** La promesa de `terminar`, mientras dura. */
let cierre = null;

function activa() {
    return Boolean(sesion);
}

/** La secuencia que se está grabando, para que el disco la deje fuera de la lista. */
function enCurso() {
    return sesion ? sesion.estado.secuencia : null;
}

/**
 * Suelta la sesión, y le avisa.
 *
 * Los dos son necesarios y por eso van juntos. Bajar `viva` es lo que hace que
 * las pasadas que quedaron en el aire —una relectura, una consulta de temario—
 * se den cuenta al volver de su `await` de que la sesión que tienen en la mano
 * ya no es la de nadie. Antes eso se miraba preguntando si la variable de este
 * archivo seguía en pie, y esa pregunta dejó de servir en cuanto la sesión pasó
 * a viajar como argumento.
 */
function soltar() {
    if (sesion) sesion.viva = false;
    sesion = null;
}

/**
 * Arranca una sesión.
 *
 * `ceroMs` se fija acá y no cuando llega el primer audio: es el momento de
 * "Iniciar grabación", el mismo botón con el que se pone a grabar el Rodecaster,
 * y de él cuelgan todos los cuadros del XML. También es la hora que va en el
 * nombre del archivo, que es por donde post encuentra a qué carpeta pertenece
 * (ver `nombre-de-clase.js`).
 *
 * @param {object} params { dir, clase, curso, dispositivo, sampleRate, canales,
 *   avisar, sinReloj }
 */
function iniciar(params) {
    const p = params || {};
    if (!p.dir) throw new Error('Falta la carpeta donde guardar las notas.');
    if (sesion) throw new Error('Ya hay una grabación en curso.');

    const ceroMs = Date.now();
    const clase = Number(p.clase) || 1;
    const parte = clasesGrabadas.parteQueSigue(p.dir, clase, null);
    sesion = {
        // Mientras esté en pie. Lo mira todo lo que vuelve de un `await`, que es
        // la única forma de saber que la sesión se cerró mientras se esperaba.
        viva: true,
        estado: vivo.estadoNuevo({
            secuencia: nombreDeClase.armar({ clase, parte, curso: p.curso, cuandoMs: ceroMs }),
            clase,
            parte,
            curso: p.curso,
            ceroMs,
            dispositivo: p.dispositivo,
            temario: temarioSesion.heredar(p.dir)
        }),
        dir: p.dir,
        captura: null,
        // El fondo de esta sala y cuándo fue el último golpe (`golpe.js`).
        golpes: golpe.nuevo(),
        // Los golpes que todavía no se leyeron, en orden: la hora de cada uno. Se
        // leen cuando el audio de alrededor ya está en el disco (`leerCandidatas`).
        candidatas: [],
        // Las tomas que esperan que se les rehaga el texto, de a una; y la
        // promesa de la pasada que las está atendiendo, si hay una
        // (`engine/relecturas.js`).
        cola: [],
        rehaciendo: null,
        // Lo que el editor le hizo a las tomas a mano, para poder volver
        // (`engine/deshacer.js`). Nace con la sesión y muere con ella: las fotos
        // son de las tomas de ESTA clase, y deshacer con el historial de la
        // anterior metería una toma de otra grabación adentro de esta.
        historia: historial.nueva(),
        // La promesa de la medición de cobertura en curso, si hay una: es lo que
        // impide dos consultas encimadas (`engine/temario-sesion.js`).
        midiendoTemario: null,
        // "Terminar" ya apretado: el audio se cerró y se releen las últimas tomas.
        terminando: false,
        // Hasta dónde ya se escuchó buscando señales.
        escuchadoHastaMs: ceroMs,
        buscando: false,
        timer: null,
        avisar: typeof p.avisar === 'function' ? p.avisar : () => {}
    };

    abrirEscucha({ sampleRate: p.sampleRate, canales: p.canales });
    // `sinReloj` es para la simulación, que empuja el ciclo a mano después de
    // cada pedazo: con el reloj andando las dos pasadas se pisarían y la que
    // llegara segunda no vería nada.
    if (!p.sinReloj) sesion.timer = setInterval(() => { buscarSenales(); }, CICLO_MS);
    // Entre dos clases el editor puede haber cambiado de proveedor en Ajustes, y
    // los medidores de toma se lo guardan por sesión para no preguntarlo veinte
    // veces (`cliente` en `medir-toma.js`).
    medirToma.olvidar();
    // Y de acá en más el Whisper de las señales tiene la GPU, así que el modelo
    // local no se consulta hasta que la suelte (`engine/gpu.js`).
    gpu.tomar();
    espejo.escribir(sesion);
    return espejo.resumen(sesion);
}

function abrirEscucha(params) {
    const p = params || {};
    const info = captura.abrir({
        dir: workspace.notasAudioDir(sesion.dir),
        nombre: sesion.estado.secuencia,
        sampleRate: p.sampleRate,
        canales: p.canales,
        desdeMs: Date.now()
    });
    sesion.captura = { ...info, segundos: 0 };
    sesion.escuchadoHastaMs = info.desdeMs;
    return info;
}

/**
 * El PCM que manda la ventana: se escribe y se mira si trajo un golpe.
 *
 * La hora que se le da al buscador de golpes sale de la POSICIÓN EN EL AUDIO y
 * no de `Date.now()`, y eso importa por dos motivos. Uno: el pedazo que llega
 * ahora se grabó hace un instante, y el aplauso tiene que quedar donde suena.
 * El otro es que así el mismo código sirve para pasarle un Live-Mix de una clase
 * vieja a toda velocidad y comprobar que encuentra su claqueta
 * (`tools/simular-grabacion.js`), que es la única forma de probar esto sin
 * ponerse a aplaudir delante del micrófono.
 *
 * Un golpe no es todavía la claqueta: queda como candidata y se lee después,
 * cuando haya audio de los dos lados. Con la claqueta ya confirmada no se
 * anota ninguno más: en una clase se aplaude una vez.
 */
function pcm(buffer) {
    if (!sesion || !sesion.captura) return null;

    // Antes de escribir: `segundos` es cuánto había, o sea dónde arranca esto.
    const desdeMs = sesion.captura.desdeMs + sesion.captura.segundos * 1000;
    const r = captura.escribir(sesion.captura.id, buffer);
    sesion.captura.segundos = r.segundos;

    const visto = golpe.mirar(sesion.golpes, buffer, Math.round(desdeMs));
    if (visto.golpe && !claquetaLista()) {
        sesion.candidatas.push(visto.ms);
        sesion.avisar({ tipo: 'golpe', ms: visto.ms });
    }
    return r;
}

function claquetaLista() {
    return Boolean(sesion.estado.claqueta && sesion.estado.claqueta.confirmada);
}

/** Un tramo de esta sesión, transcripto (`oir-toma.js` no sabe de sesiones). */
function oirTramo(desdeMs, hastaMs, liviano) {
    return oirToma.tramo(espejo.archivosDeLaSesion(sesion), desdeMs, hastaMs, liviano);
}

/**
 * El ciclo de señales: escucha lo último y abre o cierra tomas.
 *
 * Nunca corre dos veces a la vez. Whisper tarda algo más de un segundo y el ciclo
 * dispara cada tres, pero si el disco o el modelo se demoran, encadenar dos
 * lecturas del mismo audio duplicaría las palabras y con ellas las señales.
 */
async function buscarSenales() {
    if (!sesion || sesion.buscando || !sesion.captura) return;
    const hasta = espejo.grabadoHastaMs(sesion);
    const desde = Math.max(sesion.captura.desdeMs, sesion.escuchadoHastaMs - SOLAPE_MS);
    if (hasta - desde < 1500) return;

    sesion.buscando = true;
    try {
        // Primero los golpes que quedaron por leer: la claqueta es lo que ancla la
        // clase entera en post y una toma puede esperar tres segundos más.
        await leerCandidatas();
        if (!sesion) return;

        const oido = await oirTramo(desde, hasta, true);
        if (!sesion) return;

        let eventos = [];
        if (oido && oido.palabras.length) {
            // La ventana entera, incluido el solape: quitar acá lo ya oído deshacía
            // el solape justo cuando servía (ver `aplicarSenales`).
            eventos = vivo.aplicarSenales(sesion.estado, oido.palabras);
            for (const ev of eventos) {
                if (ev.tipo === 'cerrada' || ev.tipo === 'cerrada-sola') relecturas.encolar(sesion, ev.toma);
            }
            if (eventos.length) espejo.escribir(sesion);
        }
        relecturas.releerOrillas(sesion);
        // El estado va en cada pasada y no solo cuando hay una señal: así las
        // palabras de la toma abierta van apareciendo en pantalla, que es lo que
        // dice "esto está oyendo bien" sin tener que esperar a que la toma cierre.
        //
        // `oyendo` es lo que se acaba de oír, tal cual, incluida la charla que no
        // es de ninguna toma. Es el único sitio donde eso se ve, y es lo que
        // permite darse cuenta de que el micrófono está agarrando la sala en vez
        // del Rodecaster antes de haber grabado media clase.
        sesion.avisar({
            tipo: 'estado',
            estado: espejo.resumen(sesion),
            eventos,
            oyendo: (oido ? oido.palabras : []).map(w => w.texto).join(' ')
        });
        sesion.escuchadoHastaMs = hasta;
    } catch (err) {
        if (sesion) sesion.avisar({ tipo: 'error', mensaje: err.message });
    } finally {
        if (sesion) sesion.buscando = false;
    }
}

/* ─── La claqueta ─────────────────────────────────────────────────────────
 *
 * El aplauso es lo que ancla la clase entera en post: con él, `align.js` mide el
 * desfase entre el XML de notas y el Live-Mix del Rodecaster. Encontrarlo tiene
 * dos mitades: el pico lo oye `golpe.js` en el PCM, y creerle o no es lo de acá.
 */

/**
 * Lee qué se dijo alrededor de cada golpe pendiente y decide si es la claqueta.
 *
 * El pico solo no alcanza —una puerta o un golpe en la mesa miden igual— así que
 * se transcribe alrededor y se busca "claqueta" o "clase N". Cuál queda lo dice
 * `vivo.elegirClaqueta`, que es la regla entera en cinco líneas y con prueba.
 *
 * **Se lee después, no cuando el golpe suena.** En ese momento el audio que viene
 * DETRÁS todavía no existe —se está grabando— y ahí está la mitad de la frase:
 * pedir un tramo que no está escrito devuelve nada. La simulación lo mostraba
 * como una claqueta en el sitio correcto y con la frase vacía, o sea sin
 * confirmar y con el editor teniendo que mirarla igual. Lo llama el ciclo de
 * señales, que corre cada tres segundos: para cuando le toca, el margen ya está
 * en el disco.
 *
 * Las candidatas son una cola y no un solo lugar porque dos golpes pueden venir
 * más cerca de lo que tarda en leerse el primero: con un solo lugar, el segundo
 * pisaba la lectura pendiente del primero, y si alrededor del primero se había
 * dicho "clase 7", nadie lo oía nunca.
 */
async function leerCandidatas() {
    while (sesion && sesion.candidatas.length) {
        const ms = sesion.candidatas[0];
        // Todavía no hay audio detrás de este golpe; los que siguen son
        // posteriores, así que tampoco.
        if (espejo.grabadoHastaMs(sesion) < ms + MARGEN_CLAQUETA_MS) return;
        sesion.candidatas.shift();
        if (claquetaLista()) continue;

        const leida = await leerClaqueta(ms);
        if (!sesion) return;
        const elegida = vivo.elegirClaqueta(sesion.estado.claqueta, leida);
        if (elegida === sesion.estado.claqueta) continue;

        sesion.estado.claqueta = elegida;
        espejo.fijar(sesion);
    }
}

async function leerClaqueta(ms) {
    let frase = '';
    try {
        const oido = await oirTramo(ms - MARGEN_CLAQUETA_MS, ms + MARGEN_CLAQUETA_MS, false);
        frase = (oido ? oido.palabras : []).map(w => w.texto).join(' ').trim();
    } catch (err) {
        // El golpe se oyó igual: queda como candidata sin frase, y se avisa.
        if (sesion) sesion.avisar({ tipo: 'error', mensaje: err.message });
    }
    return {
        ms,
        frase,
        confirmada: DICE_CLAQUETA.test(frase) || DICE_CLASE_N.test(frase),
        origen: 'golpe'
    };
}

/**
 * La claqueta puesta a mano: el aplauso no se oyó, o se oyó un portazo.
 *
 * Confirmada por construcción. La afirmó una persona que estaba mirando, y
 * pedirle a Whisper que lo confirme sería desconfiar del editor para creerle a un
 * modelo: antes pasaba por la misma lectura que un golpe, y podía terminar en
 * pantalla como "sin confirmar" después de que alguien la había afirmado. Los
 * golpes que quedaban por leer ya no importan.
 */
function claqueta(paredMs) {
    if (!sesion) return null;
    sesion.estado.claqueta = {
        ms: Number(paredMs) || Date.now(),
        frase: '',
        confirmada: true,
        origen: 'editor'
    };
    sesion.candidatas = [];
    espejo.escribir(sesion);
    return espejo.resumen(sesion);
}

/* ─── El cierre ───────────────────────────────────────────────────────────*/

/**
 * Termina la sesión: cierra el audio, relee lo que quedó pendiente, escribe por
 * última vez y suelta todo.
 *
 * Es asíncrona por la relectura. La toma que estaba abierta se cierra acá y
 * nadie la había releído con el modelo grande —y las que se cerraron en los
 * últimos segundos pueden estar todavía en la cola—. Sin esperar, la última toma
 * de cada clase quedaba con el texto del ciclo de señales, que es el
 * descartable. El audio ya está cerrado para entonces, así que se lee del WAV
 * terminado. Son uno o dos segundos por toma pendiente, y la ventana lo dice.
 *
 * Apretar "Terminar" dos veces es una vez: la segunda recibe la misma promesa.
 */
function terminar() {
    if (!sesion) return cierre || Promise.resolve(null);
    if (!cierre) {
        sesion.terminando = true;
        // La promesa vive fuera de `sesion`: si no hay nada que releer, cerrar es
        // sincrónico y `sesion` ya es null cuando la promesa vuelve.
        cierre = cerrarSesion().finally(() => { cierre = null; });
    }
    return cierre;
}

async function cerrarSesion() {
    const pendiente = cerrarLoAbierto();
    if (pendiente != null) relecturas.encolar(sesion, pendiente);
    if (sesion.rehaciendo) await sesion.rehaciendo;
    if (!sesion) return null; // `apagar` se adelantó

    // **Acá, y en ningún otro renglón, es donde el Whisper suelta la GPU.** El
    // reloj de las señales ya está parado, el audio cerrado y la cola de
    // relecturas drenada: no queda un solo Whisper andando. Un paso antes todavía
    // se estaba transcribiendo; un paso después la sesión ya no existe y no
    // habría dónde escribir lo que se mida.
    //
    // No queda libre: la agarra la medición que se venía absteniendo, que ahora
    // sí puede preguntar. Lo que no se puede es levantar OTRO Whisper encima
    // —`regenerar` sigue rebotando hasta el último renglón— (`engine/gpu.js`).
    gpu.tomar('cierre');
    try {
        await temarioSesion.alCerrar(sesion);
        if (!sesion) return null;

        // Y lo mismo con lo de cada toma: se mide lo que se había abstenido, se le
        // da un rato a lo que esté en el aire, y la medida que no llegue queda
        // dicha en vez de quedar en "midiendo" para siempre (`medirToma.cerrar`).
        await medirToma.cerrar(sesion.estado.tomas, { avisar: relecturas.avisador(sesion) });
    } finally {
        gpu.soltar();
    }
    if (!sesion) return null;

    const final = espejo.escribir(sesion);
    const salida = { ...espejo.resumen(sesion), archivos: final };
    soltar();
    return salida;
}

/**
 * Cierra la toma abierta y el audio, sin releer nada. Devuelve el id de la toma
 * que quedó por releer, si hubo una.
 *
 * La toma se cierra en su última palabra, o donde llegó el audio si no dijo
 * ninguna. No en `Date.now()`: la hora de ahora puede ser posterior a lo que se
 * grabó, y un OUT más allá del audio deja un bloque que en post no existe.
 */
function cerrarLoAbierto() {
    if (sesion.timer) clearInterval(sesion.timer);
    sesion.timer = null;

    const abierta = vivo.tomaAbierta(sesion.estado);
    if (abierta) {
        abierta.outMs = vivo.finDeToma(abierta, espejo.grabadoHastaMs(sesion));
        abierta.cerradaSola = true;
    }
    if (sesion.captura) {
        const cerrada = captura.cerrar(sesion.captura.id, Date.now());
        if (cerrada) sesion.estado.sesiones.push(cerrada);
        sesion.captura = null;
    }
    return abierta ? abierta.id : null;
}

/**
 * Al cerrar la app: lo mínimo y sincrónico. Se cierra lo abierto, se escribe y
 * se cierra cualquier WAV que quede. Sin releer nada, porque la app se está
 * yendo: para eso está "Regenerar" en la lista de clases.
 *
 * Así la cabecera del WAV queda con el tamaño real y el XML con lo último que
 * pasó. Cerrar la app en medio de un rodaje no puede costar la clase.
 */
function apagar() {
    if (sesion) {
        cerrarLoAbierto();
        espejo.escribir(sesion);
        soltar();
    }
    // El reloj de las señales quedó parado en `cerrarLoAbierto`, así que no hay
    // ningún Whisper con el que pelearse. Sin esto, una app que se cierra en
    // medio de un rodaje dejaría el veto puesto para el resto del proceso.
    gpu.soltar();
    captura.cerrarTodo();
}

/* ─── La fachada ──────────────────────────────────────────────────────────
 *
 * La ventana, el puente y las pruebas entran por acá y no por los módulos de
 * adentro, y el motivo es uno solo: este archivo es el único que sabe si hay una
 * sesión y cuál es. Todo lo de abajo es la misma línea repetida —agarrar la
 * sesión de arriba y pasársela a quien sepa hacer el trabajo—, que es
 * exactamente lo que antes estaba desparramado en mil cuatrocientas líneas.
 */

function ponerTemario(texto) {
    return temarioSesion.poner(sesion, texto);
}

function editar(cambio) {
    return cambiosToma.editar(sesion, cambio);
}

function cerrarToma() {
    return cambiosToma.cerrarToma(sesion);
}

function deshacer() {
    return cambiosToma.volver(sesion, 'atras');
}

function rehacer() {
    return cambiosToma.volver(sesion, 'adelante');
}

function resumen() {
    return espejo.resumen(sesion);
}

function listar(dirs) {
    return clasesGrabadas.listar(dirs, enCurso());
}

function parteQueSigue(dir, clase) {
    return clasesGrabadas.parteQueSigue(dir, clase, enCurso());
}

/**
 * Renombrar y borrar pasan por la fachada y no se exportan directo como
 * `editarGrabada`, y es por lo único que este archivo existe: son las dos que
 * tienen que saber cuál es la clase que se está grabando en este instante, para
 * negarse a tocarle los archivos por debajo.
 */
function renombrarGrabada(json, cambio) {
    return clasesGrabadas.renombrar(json, cambio, enCurso());
}

function borrarGrabada(json) {
    return clasesGrabadas.borrar(json, enCurso());
}

module.exports = {
    CICLO_MS,
    activa,
    iniciar,
    pcm,
    claqueta,
    ponerTemario,
    editar,
    editarGrabada: clasesGrabadas.editarGrabada,
    deshacer,
    rehacer,
    cerrarToma,
    terminar,
    apagar,
    resumen,
    listar,
    parteQueSigue,
    regenerar: clasesGrabadas.regenerar,
    renombrarGrabada,
    borrarGrabada,
    // Para poder empujar el ciclo desde una prueba o desde el arnés, sin esperar
    // los tres segundos del reloj.
    buscarSenales
};
