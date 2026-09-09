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
 * corre seguido con un modelo liviano y su texto es descartable: solo sirve para
 * saber si alguien dijo "3, 2, 1" o "Pausa", y de eso solo se le cree la hora. El
 * de toma corre una vez, al cerrar, con el modelo grande, y ESE texto es el que
 * queda. Así el transcript nunca se arma pegando pedazos, que es de donde salen
 * las palabras cortadas y los tiempos que no cierran.
 */

const fs = require('fs');
const path = require('path');

const captura = require('./captura');
const golpe = require('./golpe');
const oir = require('./oir');
const vivo = require('./notas-vivo');
const historial = require('./deshacer');
const notasXml = require('./notas-xml');
const nombreDeClase = require('./nombre-de-clase');
const workspace = require('./workspace');
const temario = require('./temario');
const lengua = require('./lengua');
const empalme = require('./empalme');
const medirToma = require('./medir-toma');
const gpu = require('./gpu');
const ia = require('./ia');

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
 * Cuánto se guarda de lo que se dijo justo antes y justo después de una toma.
 *
 * Es lo que deja mover un borde MIRANDO. Con el texto recortado exactamente en el
 * IN y en el OUT, correr un borde es adivinar: no se ve la frase que quedó
 * afuera, que es justo la que dice si el corte está bien puesto. Doce segundos
 * son unas treinta palabras a la velocidad del curso —más de lo que un borde se
 * corre nunca, porque el error típico es de una frase— y para Whisper siguen
 * siendo el mismo recorte corto (`oir.js`: el largo casi no cambia lo que tarda).
 */
const ORILLA_MS = 12000;

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

/**
 * Cómo termina el archivo con la hora del día. Vive en `workspace.js` junto con
 * el resto de la forma de la carpeta de notas: acá se usa para reconocer una
 * clase en el disco, y allá para saber en qué piso dejarla.
 */
const { SUFIJO_SIDECAR } = workspace;

let sesion = null;
/** La promesa de `terminar`, mientras dura. */
let cierre = null;

function activa() {
    return Boolean(sesion);
}

/**
 * Qué parte de esa clase es la que va a arrancar ahora.
 *
 * Una clase se puede grabar en dos tandas —se para a mitad y se retoma un rato
 * después—, y cada tanda es su propia grabación: su audio, su XML y su carpeta
 * del Rodecaster. La primera vez que se usa un número es la parte 1; volver a
 * usarlo abre la 2, la 3, y así.
 *
 * **Se cuenta contra el disco y no contra lo que la pantalla tenga en la mano.**
 * La pantalla lo adivina para poder mostrarlo mientras se escribe, pero su lista
 * puede estar vieja —se grabó desde otra ventana, alguien copió un XML— y dos
 * grabaciones con el mismo nombre se pisarían el archivo.
 */
function parteQueSigue(dir, clase) {
    return listar([dir]).filter(c => c.clase === clase).length + 1;
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
    const parte = parteQueSigue(p.dir, clase);
    sesion = {
        estado: vivo.estadoNuevo({
            secuencia: nombreDeClase.armar({ clase, parte, curso: p.curso, cuandoMs: ceroMs }),
            clase,
            parte,
            curso: p.curso,
            ceroMs,
            dispositivo: p.dispositivo,
            temario: heredarTemario(p.dir)
        }),
        dir: p.dir,
        captura: null,
        // El fondo de esta sala y cuándo fue el último golpe (`golpe.js`).
        golpes: golpe.nuevo(),
        // Los golpes que todavía no se leyeron, en orden: la hora de cada uno. Se
        // leen cuando el audio de alrededor ya está en el disco (`leerCandidatas`).
        candidatas: [],
        // Las tomas que esperan que se les rehaga el texto, de a una; y la
        // promesa de la pasada que las está atendiendo, si hay una.
        cola: [],
        rehaciendo: null,
        // Lo que el editor le hizo a las tomas a mano, para poder volver
        // (`engine/deshacer.js`). Nace con la sesión y muere con ella: las fotos
        // son de las tomas de ESTA clase, y deshacer con el historial de la
        // anterior metería una toma de otra grabación adentro de esta.
        historia: historial.nueva(),
        // La promesa de la medición de cobertura en curso, si hay una: es lo que
        // impide dos consultas encimadas (`atenderTemario`).
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
    escribir();
    return resumen();
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

/**
 * Hasta dónde llega el audio escrito, en hora del día.
 *
 * No se puede pedir hasta "ahora": el audio de ahora todavía no está en el
 * archivo. Se pide hasta donde el archivo llega, que es lo que `captura` sabe.
 */
function grabadoHastaMs() {
    if (!sesion || !sesion.captura) return 0;
    return sesion.captura.desdeMs + sesion.captura.segundos * 1000;
}

/**
 * Un tramo del reloj de pared, transcripto.
 *
 * Se busca en qué archivo está: el que se está escribiendo o alguno ya cerrado
 * (`estado.sesiones`). Lo segundo es lo que permite releer la última toma de una
 * clase después de cerrar el audio, en `terminar`.
 */
function oirTramo(desdeMs, hastaMs, liviano) {
    const donde = captura.laQueContiene(archivosDeLaSesion(), desdeMs);
    if (!donde) return Promise.resolve(null);
    return oir.escuchar({ sesion: donde, desdeMs, hastaMs, liviano });
}

/** Los WAV de esta sesión: el que se está escribiendo y los que ya se cerraron. */
function archivosDeLaSesion() {
    return (sesion.captura ? [sesion.captura] : []).concat(sesion.estado.sesiones);
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
    const hasta = grabadoHastaMs();
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
                if (ev.tipo === 'cerrada' || ev.tipo === 'cerrada-sola') encolarToma(ev.toma);
            }
            if (eventos.length) escribir();
        }
        releerOrillas();
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
            estado: resumen(),
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

/**
 * Rehace el texto de una toma cerrada, con el modelo grande y de una sola pasada.
 *
 * Es lo que hace que el transcript sea bueno: una toma entera tiene frases
 * completas, así que Whisper puntúa bien, y al no pegar pedazos no hay palabras
 * cortadas ni tiempos que se pisen. El texto del ciclo de señales se descarta
 * entero — de él solo se usó la hora de las señales.
 *
 * Y se vuelve a buscar señales adentro: si el ciclo liviano no oyó una "Pausa",
 * acá aparece, y la toma se puede partir. Dos oportunidades para cada señal.
 *
 * **De una a la vez.** Se encola en vez de largarse a correr: el ciclo de señales
 * ya tiene un Whisper andando cada tres segundos, y sumarle uno por cada toma que
 * se cierra pone dos modelos grandes a pelearse la GPU. Los dos tardan el doble y
 * el que importa es el del ciclo, porque de ese salen las tomas siguientes. Una
 * toma cerrada, en cambio, puede esperar: nadie va a mirar su texto en los
 * próximos segundos.
 */
function encolarToma(id) {
    if (!sesion) return;
    sesion.cola.push(id);
    // `rehaciendo` guarda la promesa de la pasada en curso, y no un booleano:
    // `terminar` la espera, para no soltar la sesión con tomas a medio releer.
    if (!sesion.rehaciendo) sesion.rehaciendo = atenderCola();
}

async function atenderCola() {
    try {
        while (sesion && sesion.cola.length) {
            await rehacerToma(sesion.cola.shift());
        }
    } finally {
        if (sesion) sesion.rehaciendo = null;
    }
}

async function rehacerToma(id) {
    const toma = sesion.estado.tomas.find(t => t.id === id);
    if (!toma || toma.inMs == null || toma.outMs == null) return;

    try {
        const leido = await leerToma(archivosDeLaSesion(), toma);
        if (!sesion || !leido) return;

        Object.assign(toma, leido);
        // La orilla de la derecha son segundos que, en el momento de cerrar la
        // toma, todavía se están grabando: nace vacía por fuerza. Queda anotado
        // para volver a buscarla cuando el audio la alcance (`releerOrillas`).
        toma.orillaCorta = grabadoHastaMs() < toma.outMs + ORILLA_MS;

        // Señales que el ciclo liviano no oyó. No se parte la toma sola: se avisa,
        // porque partir es una decisión de contenido y acá el editor está mirando.
        // Se busca solo ADENTRO: una "Pausa" que cae en una orilla es de la toma
        // de al lado o de nadie, y avisarla acá mandaría a cortar donde no va.
        const dentro = vivo.senales(toma.palabras).filter(s => s.tipo === 'cierra');
        toma.pausaAdentro = dentro.length ? toma.palabras[dentro[0].desde].t : null;

        // Lo que se mide de la toma con lo que ya está en memoria: sale acá
        // mismo, antes de escribir, así el panel tiene número en el mismo aviso
        // en que aparece el texto bueno (`engine/medir-toma.js`).
        //
        // Y va con las demás tomas al lado: cómo pega esta con la anterior no se
        // puede mirar teniendo una sola (`engine/empalme.js`). Este es también el
        // único momento en que tiene sentido mirarlo, y por eso la validación del
        // empalme es un medidor y no un disparador propio: acá las DOS tomas del
        // par ya están releídas con el modelo grande —la cola se atiende de a una
        // y en orden—, así que se mide sobre el texto que va a quedar y no sobre
        // el del ciclo liviano, que está declarado descartable.
        medirToma.medir(toma, { tomas: sesion.estado.tomas });

        escribir();
        sesion.avisar({ tipo: 'estado', estado: resumen() });
        // Y con el texto bueno ya puesto, se mide el temario. Este es el latido:
        // acá hay texto nuevo, estable y con sentido completo (ver `hayQueMedir`).
        pedirTemario();
        // Del mismo latido cuelga lo que la toma le pregunta a un modelo. No se
        // espera: esta fila es la que decide dónde arrancan las tomas siguientes,
        // y una consulta metida acá adentro retrasaría la clase entera.
        medirToma.conModelo({ toma, tomas: sesion.estado.tomas, avisar: avisarMedida });
    } catch (err) {
        if (sesion) sesion.avisar({ tipo: 'error', mensaje: err.message });
    }
}

/**
 * Una medida de toma que acaba de cambiar: se escribe y se dibuja.
 *
 * Se llama varias veces por toma —al salir a preguntar, y otra vez con lo que
 * conteste— porque el panel tiene que poder decir "estoy midiendo" y después el
 * resultado. Cuesta dos escrituras de unos kilobytes, que es lo mismo que cuesta
 * cualquier otro cambio de esta sesión (`escribir`).
 */
function avisarMedida() {
    if (!sesion) return;
    escribir();
    sesion.avisar({ tipo: 'estado', estado: resumen() });
}

/* ─── El temario del CD y su cobertura ───────────────────────────────────
 *
 * El director de contenido entrega una lista de temas que la clase tiene que
 * cubrir. Se pega en el panel de análisis y desde ahí se mide, mientras se
 * graba, contra lo que el profesor ya dijo. Lo que decide y lo que valida vive
 * en `engine/temario.js`, que no toca disco ni red; acá está lo que solo la
 * sesión puede tener: cuándo se dispara, contra qué tomas y dónde se guarda.
 */

/**
 * La lista de la clase anterior del mismo curso.
 *
 * El CD entrega UNA lista para el día o para el curso, no una por clase, y en un
 * día de rodaje se graban cuatro o cinco seguidas. Obligar a pegarla de nuevo en
 * cada una es garantizar que a la tercera nadie la pegue y la validación quede
 * apagada justo cuando ya se confiaba en ella.
 *
 * Se hereda de la carpeta y no de una preferencia global porque la carpeta ES el
 * curso (una carpeta de notas por curso): empezar a grabar otro curso es elegir
 * otra carpeta, y ahí no se hereda nada, que es lo correcto. Y sale del sidecar
 * de la clase anterior, que ya está en el disco, así que no hay un segundo sitio
 * donde la lista pueda quedar desactualizada.
 *
 * Se hereda la lista, NO la cobertura: lo medido es de la clase que se midió.
 */
function heredarTemario(dir) {
    const previa = listar([dir]).find(c => c.temario && (c.temario.objetivos || []).length);
    if (!previa) return null;
    return {
        texto: previa.temario.texto || '',
        objetivos: previa.temario.objetivos,
        origen: 'heredado',
        cobertura: null,
        fallo: null,
        abstenido: null
    };
}

/**
 * El temario que se pegó en la pantalla. Texto crudo: partirlo es de `temario.js`.
 *
 * Pegar una lista vacía es querer sacarla, y saca también la medición: dejar la
 * cobertura de una lista que ya no existe sería mostrar un resultado sin su vara.
 */
function ponerTemario(texto) {
    if (!sesion) return null;
    const objetivos = temario.partir(texto);
    sesion.estado.temario = objetivos.length
        ? {
            texto: String(texto || ''),
            objetivos,
            origen: 'pegado',
            cobertura: null,
            fallo: null,
            abstenido: null
        }
        : null;
    escribir();
    // Contra lo que ya haya grabado, sin esperar la toma siguiente: la lista se
    // pega con la clase empezada y el panel tiene que decir algo en el acto.
    pedirTemario();
    return resumen();
}

/**
 * Larga la medición si hace falta, y una sola a la vez.
 *
 * La promesa vive en la sesión —igual que `rehaciendo`— y no un booleano: así
 * `terminar` podría esperarla, y sobre todo así se sabe que hay una en vuelo sin
 * tener que acordarse de bajar una bandera en cada salida.
 */
function pedirTemario() {
    if (!sesion || sesion.midiendoTemario) return;
    const t = sesion.estado.temario;
    // Con la cobertura de la mano: sin ella la huella nunca coincide con la de lo
    // ya medido, y una clase con proveedor andando se pasaba la hora midiendo lo
    // mismo una y otra vez —el bucle de `atenderTemario` no encontraba salida—.
    if (!t || !temario.hayQueMedir({
        objetivos: t.objetivos,
        tomas: sesion.estado.tomas,
        cobertura: t.cobertura
    })) return;
    sesion.midiendoTemario = atenderTemario()
        .finally(() => { if (sesion) sesion.midiendoTemario = null; });
}

/**
 * Mide, y vuelve a mirar si mientras se medía apareció material nuevo.
 *
 * El bucle es lo que resuelve las llamadas encimadas sin encolar nada: una
 * consulta tarda unos segundos y en ese rato puede cerrarse otra toma. Con una
 * cola habría que decidir qué hacer con dos pedidos que piden lo mismo; acá se
 * vuelve a preguntar por la huella, y si se movió se mide una vez con TODO lo
 * que hay, que es una consulta en vez de dos y con la respuesta más completa.
 *
 * El proveedor se arma en cada pasada y no una vez por sesión: el editor puede
 * cambiarlo en Ajustes en medio de un rodaje, y `ia.armar` no falla nunca —sin
 * proveedor utilizable devuelve `cliente: null` y el motivo, que es justo lo que
 * hay que mostrar—.
 */
async function atenderTemario() {
    while (sesion && sesion.estado.temario) {
        const t = sesion.estado.temario;
        if (!temario.hayQueMedir({
            objetivos: t.objetivos,
            tomas: sesion.estado.tomas,
            cobertura: t.cobertura
        })) return;

        // Con el modelo local no se consulta mientras se graba: le pelearía la
        // GPU al Whisper de las señales, que es de donde salen las tomas. El
        // criterio entero y su porqué están en `engine/gpu.js`; acá se anota la
        // deuda y se corta, y se paga al cerrar la sesión (`cerrarSesion`).
        //
        // Se corta el bucle por lo mismo que lo corta un fallo: no se midió, así
        // que la huella no se movió y `hayQueMedir` volvería a decir que sí para
        // siempre. Se vuelve a intentar cuando cierre la toma que viene.
        if (!gpu.sePuedeConsultar()) {
            if (t.abstenido === gpu.PORQUE) return;
            t.abstenido = gpu.PORQUE;
            escribir();
            sesion.avisar({ tipo: 'estado', estado: resumen() });
            return;
        }

        let medida;
        try {
            const criterio = await ia.armar({});
            if (!sesion) return;
            medida = await temario.medir({
                objetivos: t.objetivos,
                tomas: sesion.estado.tomas,
                ai: criterio.cliente
            });
            if (!medida.cobertura && !criterio.cliente) medida.error = criterio.reason;
        } catch (err) {
            // Que no se pueda medir la cobertura no puede llevarse por delante la
            // grabación: se anota el motivo y la clase sigue.
            medida = { error: err.message };
        }
        if (!sesion) return;

        // La cobertura buena reemplaza a la anterior; el fallo se guarda al lado y
        // no en su lugar, así una consulta que se cayó no borra lo último medido.
        if (medida.cobertura) t.cobertura = medida.cobertura;
        t.fallo = medida.error || null;
        t.abstenido = null;

        escribir();
        sesion.avisar({ tipo: 'estado', estado: resumen() });

        // **Un fallo corta el bucle.** Sin esto la huella se queda quieta —nadie
        // la movió, porque no hubo medición— y `hayQueMedir` sigue diciendo que
        // sí: un proveedor caído se convertía en consultas en fila hasta que
        // terminara la clase. Se vuelve a intentar cuando cierre la toma
        // siguiente, que es el único momento en que la respuesta puede cambiar.
        if (!medida.cobertura) return;
    }
}

/**
 * Vuelve a la cola las tomas cuya orilla derecha ya tiene audio detrás.
 *
 * Una toma se relee apenas cierra, y en ese instante lo que viene después no
 * existe todavía: es lo que se está grabando. Así que sale con la orilla derecha
 * en una palabra, y el OUT se puede mover hacia adelante eso y nada más. Doce
 * segundos después el audio ya está, y una segunda lectura la completa.
 *
 * La segunda lectura no vuelve a pedir una tercera: para entonces el audio pasa
 * de sobra el final de la orilla y `orillaCorta` queda en falso.
 */
function releerOrillas() {
    const hasta = grabadoHastaMs();
    for (const toma of sesion.estado.tomas) {
        if (!toma.orillaCorta || toma.outMs == null) continue;
        if (hasta < toma.outMs + ORILLA_MS) continue;
        toma.orillaCorta = false;
        encolarToma(toma.id);
    }
}

/**
 * El texto de una toma, con un poco de lo que se dijo antes y después.
 *
 * **Una sola pasada de Whisper, no tres.** Partir el audio en la raya del IN le
 * quita el contexto de la frase justo en el único sitio donde importa: el borde
 * mal puesto. Se pide el tramo entero con orillas y se reparte después, así que
 * la frase que cruza el corte se transcribe una vez y entera.
 *
 * El tramo se recorta a lo que el archivo tiene. La primera toma de una clase
 * empieza a pocos segundos del principio del WAV, y `captura.recorte` no sirve
 * tramos que no existen: sin recortar, pedir doce segundos antes devolvía null y
 * la toma se quedaba con el texto del ciclo liviano, que es el descartable.
 *
 * @param {Array} archivos las sesiones de captura donde buscar (`captura.laQueContiene`)
 * @returns {Promise<{antes, palabras, despues, colapsadas}|null>}
 */
async function leerToma(archivos, toma) {
    const donde = captura.laQueContiene(archivos, toma.inMs);
    if (!donde || !fs.existsSync(donde.archivo)) return null;

    const finDelArchivo = donde.desdeMs + (donde.segundos || 0) * 1000;
    const oido = await oir.escuchar({
        sesion: donde,
        desdeMs: Math.max(donde.desdeMs, toma.inMs - ORILLA_MS),
        hastaMs: Math.min(finDelArchivo, toma.outMs + ORILLA_MS),
        liviano: false
    });
    if (!oido) return null;
    return { ...vivo.repartir(oido.palabras, toma), colapsadas: oido.colapsadas || 0 };
}

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
        if (grabadoHastaMs() < ms + MARGEN_CLAQUETA_MS) return;
        sesion.candidatas.shift();
        if (claquetaLista()) continue;

        const leida = await leerClaqueta(ms);
        if (!sesion) return;
        const elegida = vivo.elegirClaqueta(sesion.estado.claqueta, leida);
        if (elegida === sesion.estado.claqueta) continue;

        sesion.estado.claqueta = elegida;
        escribir();
        sesion.avisar({ tipo: 'estado', estado: resumen() });
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
    escribir();
    return resumen();
}

/**
 * Lo que el editor cambia a mano desde la pantalla.
 *
 * Un comando por gesto, con su `tipo`, y cada tipo con lo suyo:
 *
 *   vista             { vista }                       qué cámara usa la toma
 *   nota              { texto }                       la nota del director
 *   descartar         { descartada }                  fuera del XML, o de vuelta
 *   borde             { borde:'in'|'out', paredMs }   mover un borde a una palabra
 *   reabrir           —                               "Pausa" cerró de más
 *   comentar          { desdeMs, hastaMs, texto, comentario }  sobre un pedazo del texto
 *   borrar-comentario { indice }
 *   eliminar          —                               borrarla de la sesión
 *
 * Todo pasa por acá y todo escribe el XML: la pantalla no guarda nada por su
 * cuenta, así que lo que se ve y lo que está en el archivo son lo mismo siempre.
 *
 * Y todo queda anotado en el historial de la sesión, así que todo se puede
 * deshacer (`deshacer` más abajo). Es por la misma razón que el cambio pasa por
 * acá: el que puede volver atrás es el que escribió el archivo.
 */
function editar(cambio) {
    if (!sesion) return null;
    const c = cambio || {};
    const toma = sesion.estado.tomas.find(t => t.id === c.toma);
    if (!toma) return resumen();

    const antes = historial.foto(toma);
    let sigue = true;

    switch (c.tipo) {
        case 'borde': {
            // El texto de la toma ya no es el de este tramo: se relee. Mover un
            // borde es lo que se hace justamente cuando el conteo se comió una
            // palabra o cuando hay que cortar antes de algo, y en los dos casos
            // lo que hay que ver después es el texto nuevo.
            //
            // Un borde que cae donde ya estaba no es un cambio, y hay dos gestos
            // que llegan así: un arrastre que volvió al hueco de donde salió y un
            // clic derecho sobre la palabra que ya es la primera de la toma.
            // Releerla por eso serían dos segundos de GPU para dejarla igual, y
            // un paso en el historial que al deshacerse no se ve.
            const estaba = c.borde === 'in' ? toma.inMs : toma.outMs;
            if (c.paredMs != null && Number(c.paredMs) !== estaba &&
                vivo.moverBorde(toma, c.borde, Number(c.paredMs))) {
                encolarToma(toma.id);
            } else {
                sigue = false;
            }
            break;
        }
        case 'reabrir':
            reabrir(toma);
            break;
        case 'eliminar':
            sigue = eliminar(toma);
            break;
        // Los otros cinco se resuelven con lo que ya está escrito, así que son
        // los mismos que se hacen sobre una clase ya terminada (`editarGrabada`),
        // y de ahí que los aplique la misma función. `borde` también entra ahí,
        // pero acá va aparte: con la sesión viva se relee el tramo, así que el
        // borde no está atado a las orillas que había guardadas.
        default:
            vivo.aplicar(toma, c);
    }

    // Un cambio que no cambió nada no va al historial: un arrastre que volvió al
    // mismo hueco dejaría un paso que al deshacerse no se ve, y el editor
    // apretaría de nuevo pensando que no funcionó.
    if (sigue) {
        historial.anotar(sesion.historia, {
            que: comoSeLlama(c),
            tipo: c.tipo,
            id: toma.id,
            antes,
            despues: c.tipo === 'eliminar' ? null : historial.foto(toma)
        });
    }

    escribir();
    // Descartar una toma le saca a la clase lo que esa toma decía, así que un
    // objetivo que estaba cubierto por ella deja de estarlo. Es el otro momento
    // —además del cierre de una toma— en que la cobertura cambia de verdad.
    pedirTemario();
    return resumen();
}

/**
 * Cómo se llama lo que se acaba de hacer, para poder decirlo al deshacerlo.
 *
 * Se dice QUÉ se deshizo y no solo que algo pasó, igual que en la revisión de
 * cortes: con quince tomas en pantalla y el scroll donde lo dejó quien estaba
 * leyendo, un cambio que se revierte lejos de la vista es invisible.
 */
function comoSeLlama(c) {
    const cual = `la toma ${c.toma}`;
    switch (c.tipo) {
        case 'vista': return `poner ${cual} en ${c.vista}`;
        case 'nota': return `la nota de ${cual}`;
        case 'descartar': return `${c.descartada ? 'descartar' : 'recuperar'} ${cual}`;
        case 'comentar': return `comentar «${vivo.limpio(String(c.texto || '')).slice(0, 30)}»`;
        case 'borrar-comentario': return `quitar un comentario de ${cual}`;
        case 'descartar-ajuste': return `descartar el ajuste de corte de ${cual}`;
        case 'borde': return `mover el ${c.borde === 'in' ? 'IN' : 'OUT'} de ${cual}`;
        case 'reabrir': return `reabrir ${cual}`;
        case 'eliminar': return `eliminar ${cual}`;
        case 'cerrar': return `cerrar ${cual}`;
        default: return `el cambio en ${cual}`;
    }
}

/**
 * Eliminar una toma: sacarla de la sesión.
 *
 * No es lo mismo que descartarla y por eso son dos gestos. Descartar la deja
 * fuera del XML pero la conserva —su texto sigue contando para las repeticiones
 * y para la cobertura del temario, y se puede recuperar—; eliminar la borra, y
 * entonces lo que la toma decía deja de existir para el resto de la clase.
 *
 * **Es la única acción destructiva de esta pantalla, y no pregunta.** No hace
 * falta un cartel porque hay dos cosas puestas antes: solo se puede eliminar una
 * toma que YA está descartada —o sea que alguien decidió dos veces, y el botón
 * no aparece nunca al lado de una toma viva— y el gesto se deshace como todos los
 * demás. Un cartel de confirmación en medio de una clase que se está grabando es
 * un renglón que hay que leer con el profesor hablando: cuesta más que el error
 * que evita, y el error ya está cubierto.
 *
 * @returns {boolean} si se eliminó
 */
function eliminar(toma) {
    // Sin descartarla antes no se elimina. Se planta en silencio en vez de tirar
    // porque el camino honesto —el botón, que solo existe en una descartada— no
    // puede llegar acá: esto es la red de abajo, no un mensaje para nadie.
    if (!toma.descartada) return false;
    const tomas = sesion.estado.tomas;
    tomas.splice(tomas.indexOf(toma), 1);
    return true;
}

/* ─── Deshacer y rehacer ──────────────────────────────────────────────────
 *
 * El historial es del motor porque la verdad es del motor: cada cambio reescribe
 * el XML y el sidecar en el mismo gesto, así que volver atrás también tiene que
 * reescribirlos. El por qué está entero en `engine/deshacer.js`, junto con el
 * motivo de que la foto sea de una toma y no de la sesión.
 */

/**
 * @param {'atras'|'adelante'} hacia
 * @returns {{ok:boolean, que?:string, error?:string, estado:object|null}}
 */
function volver(hacia) {
    if (!sesion) return { ok: false, estado: null };
    const paso = historial.proximo(sesion.historia, hacia);
    if (!paso) return { ok: false, estado: resumen() };

    const foto = hacia === 'adelante' ? paso.despues : paso.antes;
    if (historial.dejariaDosAbiertas(sesion.estado.tomas, paso.id, foto)) {
        return {
            ok: false,
            error: `No puedo ${hacia === 'adelante' ? 'rehacer' : 'deshacer'} «${paso.que}»: ` +
                'mientras tanto se abrió otra toma, y dos tomas abiertas a la vez rompen ' +
                'el ciclo de señales. Cerrá la de ahora y volvé a intentar.',
            estado: resumen()
        };
    }

    historial.sacar(sesion.historia, hacia);
    historial.poner(sesion.estado.tomas, paso.id, foto);
    // Un borde repuesto pide el mismo texto que pidió el gesto original: acá el
    // reparto de palabras lo hace la relectura, no el borde (ver `editar`).
    if (paso.tipo === 'borde' || paso.tipo === 'cerrar') encolarToma(paso.id);

    escribir();
    pedirTemario();
    return { ok: true, que: paso.que, estado: resumen() };
}

function deshacer() {
    return volver('atras');
}

function rehacer() {
    return volver('adelante');
}

/**
 * Solo la última, y solo si no hay otra abierta.
 *
 * Dos tomas abiertas a la vez rompen todo lo demás: el ciclo de señales le mete
 * las palabras a "la abierta" y no hay tal cosa, y el conteo siguiente cerraría
 * una de las dos dejando la otra abierta para siempre.
 */
function reabrir(toma) {
    const tomas = sesion.estado.tomas;
    if (vivo.tomaAbierta(sesion.estado) || toma !== tomas[tomas.length - 1]) return;
    toma.outMs = null;
    toma.cerradaSola = false;
    // Lo que se dijo después del OUT deja de ser orilla: la toma sigue abierta y
    // esas palabras van a entrar en ella cuando se la relea al cerrar. Dejarlas
    // las mostraría dos veces, una en gris y otra dentro de la toma.
    toma.despues = [];
}

/**
 * Cierra a mano la toma que esté abierta. Es el botón, no la señal.
 *
 * Se aprieta apurado y en medio de una interrupción —alguien quiere decirle algo
 * al profesor y hay que parar la toma para invitarlo a retomar—, así que va al
 * historial como todo lo demás: apretarlo de más es el error más probable de esta
 * pantalla, y tiene que costar una tecla arreglarlo.
 */
function cerrarToma() {
    if (!sesion) return null;
    const toma = vivo.tomaAbierta(sesion.estado);
    if (!toma) return resumen();
    const antes = historial.foto(toma);
    toma.outMs = vivo.finDeToma(toma, grabadoHastaMs());
    encolarToma(toma.id);
    historial.anotar(sesion.historia, {
        que: comoSeLlama({ tipo: 'cerrar', toma: toma.id }),
        tipo: 'cerrar',
        id: toma.id,
        antes,
        despues: historial.foto(toma)
    });
    escribir();
    return resumen();
}

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
    if (pendiente != null) encolarToma(pendiente);
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
        await medirTemarioAlCerrar();
        if (!sesion) return null;

        // Y lo mismo con lo de cada toma: se mide lo que se había abstenido, se le
        // da un rato a lo que esté en el aire, y la medida que no llegue queda
        // dicha en vez de quedar en "midiendo" para siempre (`medirToma.cerrar`).
        await medirToma.cerrar(sesion.estado.tomas, { avisar: avisarMedida });
    } finally {
        gpu.soltar();
    }
    if (!sesion) return null;

    const final = escribir();
    const salida = { ...resumen(), archivos: final };
    sesion = null;
    return salida;
}

/**
 * La cobertura del temario que se había abstenido, ya sin Whisper delante.
 *
 * **Es el latido de siempre y no un mecanismo aparte**: `pedirTemario` con su
 * huella decidiendo si hace falta medir, igual que en el cierre de cada toma. Lo
 * único que cambió es que el veto ya no aplica, así que esta pasada sí consulta.
 * Si la clase se midió en vivo —proveedor remoto— la huella no se movió y esto
 * no cuesta nada.
 *
 * Se espera con techo por lo mismo que `medirToma.cerrar`: el editor apretó
 * "Terminar" porque quiere el XML en la mano, y lo que no llegue queda dicho.
 */
async function medirTemarioAlCerrar() {
    pedirTemario();
    if (!sesion || !sesion.midiendoTemario) return;
    await medirToma.conTecho(sesion.midiendoTemario, medirToma.CIERRE_MS);
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
        abierta.outMs = vivo.finDeToma(abierta, grabadoHastaMs());
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
        escribir();
        sesion = null;
    }
    // El reloj de las señales quedó parado en `cerrarLoAbierto`, así que no hay
    // ningún Whisper con el que pelearse. Sin esto, una app que se cierra en
    // medio de un rodaje dejaría el veto puesto para el resto del proceso.
    gpu.soltar();
    captura.cerrarTodo();
}

/** Las clases que se están regenerando ahora, por su archivo con la hora del día. */
const regenerando = new Set();

/**
 * Vuelve a leer todas las tomas de una clase ya grabada con el modelo grande, y
 * reescribe su XML y su archivo con la hora del día.
 *
 * Para qué: una clase puede haber quedado con texto del ciclo de señales —el
 * descartable— si la app se cerró de golpe, o haberse grabado sin el modelo
 * grande a mano. El audio está guardado (`xml/Audio/` en la carpeta de notas, o
 * la carpeta plana de antes: ver `dondeQuedoElWav`), así que se puede volver a
 * leer entero. No se toca nada más: ni los bordes, ni las vistas,
 * ni las notas del director, ni qué se descartó.
 *
 * Y hace una segunda cosa, que es la que importa cuando un borde se quedó sin
 * lugar: relee cada toma con orillas nuevas alrededor de los bordes de AHORA
 * (`leerToma`). Así, después de correr un OUT hasta el final de lo que había
 * guardado, esto le devuelve otros doce segundos de texto por delante y el
 * borde puede seguir. Es el único camino que hay para ir más lejos que lo
 * guardado, porque es el único que vuelve a oír.
 *
 * No corre mientras la GPU esté ocupada: el Whisper de las señales ya está
 * andando cada tres segundos, y otro modelo grande peleándosela pone en riesgo
 * la clase que se está grabando por mejorar una que ya está. Es el mismo
 * criterio con el que el panel se abstiene del modelo local y se pregunta en el
 * mismo sitio —`engine/gpu.js`—, pero acá se pregunta si la tiene CUALQUIERA y
 * no solo el Whisper, y no depende del proveedor: lo que esto levanta es Whisper
 * y Whisper es local siempre, así que también hay que dejar tranquila la
 * medición del cierre, que recién ahí llegó a hacerse.
 *
 * @param {string} json el archivo con la hora del día de la clase
 * @param {function} [avisar] recibe `{tipo:'regenerando', json, hechas, total}`
 */
async function regenerar(json, avisar) {
    if (gpu.ocupada()) throw new Error('Terminá la grabación en curso antes de regenerar una clase.');
    if (regenerando.has(json)) throw new Error('Esa clase ya se está regenerando.');
    regenerando.add(json);
    try {
        const estado = notasXml.estadoLeido(JSON.parse(fs.readFileSync(json, 'utf8')));
        const clase = workspace.notasDeClase(json);
        // El WAV se guardó con la ruta de entonces. Si la carpeta se movió —o si
        // la mudó la app al darle forma—, sigue en alguna de las carpetas de
        // audio de esta carpeta de notas.
        const archivos = (estado.sesiones || []).map(s => ({
            ...s,
            archivo: dondeQuedoElWav(clase, s.archivo)
        }));
        const tomas = (estado.tomas || []).filter(t => t.inMs != null && t.outMs != null);
        const aviso = typeof avisar === 'function' ? avisar : () => {};

        let sinAudio = 0;
        for (const [i, toma] of tomas.entries()) {
            const leido = await leerToma(archivos, toma);
            if (leido) Object.assign(toma, leido);
            else sinAudio++;
            aviso({ tipo: 'regenerando', json, hechas: i + 1, total: tomas.length });
        }

        workspace.writeAtomic(clase.xml, notasXml.xmlDeNotas(estado));
        workspace.writeJson(clase.json, notasXml.sidecar(estado));
        return { tomas: tomas.length, sinAudio, archivos: { xml: clase.xml, json: clase.json } };
    } finally {
        regenerando.delete(json);
    }
}

/**
 * Dónde está hoy un WAV que el sidecar anotó con la ruta de entonces.
 *
 * La ruta guardada manda si el archivo sigue ahí; si no, se lo busca por su
 * nombre en las carpetas de audio de esta carpeta de notas. Sin esto, darle
 * forma a la carpeta dejaría a "Regenerar" sin audio en todas las clases
 * viejas, y eso no se ve hasta que alguien la aprieta.
 */
function dondeQuedoElWav(clase, guardado) {
    if (guardado && fs.existsSync(guardado)) return guardado;
    const nombre = path.basename(guardado || '');
    const donde = clase.audios.find(dir => fs.existsSync(path.join(dir, nombre)));
    return path.join(donde || clase.audios[0], nombre);
}

/**
 * Cambia una clase que ya terminó, y reescribe su XML.
 *
 * Antes una clase generada se leía y nada más, y eso dejaba fuera el momento en
 * que uno de verdad tiene algo que decir: viendo el guion entero, con la clase ya
 * cerrada. El único camino era rehacer la clase.
 *
 * **El XML se reescribe acá mismo, en el mismo gesto.** Un cambio que se queda en
 * la pantalla no llega a Premiere, y tener un botón aparte de "guardar"
 * garantiza que alguna vez se haga lo primero sin lo segundo.
 *
 * **Qué se puede y qué no lo decide `vivo.aplicar`, y el criterio es si alcanza
 * con lo que ya está escrito.** Comentar, cambiar la vista, escribir la nota del
 * director y descartar una toma son escribir un campo. Mover un borde también
 * entra, que es lo que menos parece: las orillas de cada toma están guardadas en
 * el mismo archivo, así que correr el IN o el OUT dentro de ese rango es repartir
 * de nuevo las palabras que ya están (ver `moverBordeGuardado` allá). El texto no
 * se rehace y no hace falta el audio.
 *
 * Sí corre con una grabación en curso: no toca el audio ni pelea por Whisper,
 * escribe dos archivos de otra clase. Eso sigue siendo cierto con los bordes
 * adentro, y es justamente lo que se protege dejando fuera el borde que se pasa
 * de lo guardado: ese sí pediría Whisper, y para eso está `regenerar`.
 *
 * @param {string} json el archivo con la hora del día de la clase
 * @param {object} cambio uno de los de `editar` que no necesite el audio
 */
function editarGrabada(json, cambio) {
    const c = cambio || {};
    const estado = notasXml.estadoLeido(JSON.parse(fs.readFileSync(json, 'utf8')));
    const toma = (estado.tomas || []).find(t => t.id === c.toma);
    if (!toma) throw new Error(`Esa clase no tiene la toma ${c.toma}.`);
    vivo.aplicar(toma, c);

    // Se reescribe donde está, no donde iría hoy: una clase que quedó en la raíz
    // y no se pudo mudar se sigue editando ahí. Mudarla de contrabando en un
    // gesto que el editor pidió para cambiar una vista sería mover sus archivos
    // sin que nadie lo haya pedido.
    const clase = workspace.notasDeClase(json);
    workspace.writeAtomic(clase.xml, notasXml.xmlDeNotas(estado));
    workspace.writeJson(clase.json, notasXml.sidecar(estado));
    return { archivos: { xml: clase.xml, json: clase.json } };
}

/**
 * Dónde van a caer el XML y el sidecar de la clase que se está grabando.
 *
 * Se pregunta desde dos sitios: acá cerca, al escribirlos, y en el resumen que
 * mira la pantalla, que lo único que hace con ellos es decirle al editor dónde
 * está guardando. Ese cartel decía la carpeta a secas y quedó mintiendo cuando
 * el XML bajó a `xml/`, y la forma de repararlo NO es que la ventana sepa el
 * nombre de esa subcarpeta: la forma de la carpeta vive en `workspace.js` y
 * escribirla de nuevo en el renderer es el mismo error con otra ropa. Va la
 * ruta ya armada.
 */
function archivosDeLaClase() {
    return workspace.notasArchivos(
        sesion.dir, workspace.safeName(sesion.estado.secuencia));
}

/**
 * El XML y el archivo con la hora del día, los dos atómicos.
 *
 * Se escriben en cada cambio y no al terminar: lo que se está grabando no se
 * puede repetir, así que si la app se cae, lo que ya pasó tiene que estar en el
 * disco. Cuesta dos escrituras de unos kilobytes.
 */
function escribir() {
    if (!sesion) return null;
    const archivos = archivosDeLaClase();

    const conSesiones = {
        ...sesion.estado,
        sesiones: sesion.estado.sesiones.concat(
            sesion.captura ? [{ ...sesion.captura }] : [])
    };

    workspace.writeAtomic(archivos.xml, notasXml.xmlDeNotas(conSesiones));
    workspace.writeJson(archivos.json, notasXml.sidecar(conSesiones));
    return archivos;
}

/**
 * Las clases ya grabadas en las carpetas de notas, de la más nueva a la más vieja.
 *
 * Se leen del disco y no de la memoria: la lista SON las carpetas. Así la clase
 * de ayer aparece igual que la de hace un minuto, y cerrar la app no borra nada
 * de lo que se veía. Lo que hay es lo que quedó escrito —el archivo con la hora
 * del día que se escribe en cada cambio (`notas-xml.sidecar`)—, así que una
 * clase que se cortó por un cierre brusco aparece igual, con lo que había hasta
 * ahí. Cada clase dice de qué carpeta salió (`carpeta`), que es su curso.
 *
 * La que se está grabando ahora no va: la pantalla la dibuja aparte, con lo que
 * llega por los avisos, y sería verla dos veces.
 *
 * **Es el momento en que la carpeta toma forma.** Antes las clases caían sueltas
 * en la raíz y ahora bajan un piso (`workspace.migrarNotas`), y esta es la única
 * puerta por la que se pasa siempre antes de ver una clase: abrir la pantalla de
 * Grabar lista, y arrancar una grabación también (`parteQueSigue`). Mudar acá es
 * lo que hace que el editor no tenga que enterarse.
 *
 * Igual se sigue mirando la raíz. La mudanza puede no haber podido con algo —un
 * disco de solo lectura, un archivo abierto por otro programa—, y una clase que
 * no se pudo mover tiene que seguir apareciendo: que se "borren" trece clases es
 * lo peor que puede pasar acá, y cuesta un `readdir` evitarlo.
 *
 * @param {string[]} dirs las carpetas de notas (`ajustes.carpetasDeNotas`)
 */
function listar(dirs) {
    const enCurso = sesion ? sesion.estado.secuencia : null;
    const clases = [];
    for (const dir of dirs || []) {
        workspace.migrarNotas(dir);
        // Por secuencia y no por ruta: si la misma clase quedó en los dos pisos
        // —la mudanza no pisa nada, así que un choque de nombres deja las dos—,
        // se muestra una sola vez y gana la de adentro, que es la que se
        // reescribe al editarla.
        const vistas = new Set();
        for (const donde of workspace.notasConDatos(dir)) {
            for (const clase of sidecaresDe(donde, dir)) {
                if (clase.secuencia === enCurso || vistas.has(clase.secuencia)) continue;
                vistas.add(clase.secuencia);
                clases.push(clase);
            }
        }
    }
    return clases.sort((a, b) => (b.ceroMs || 0) - (a.ceroMs || 0));
}

/**
 * Las clases que hay en una carpeta concreta.
 *
 * `base` es la carpeta de notas que el editor eligió y `donde` el piso en el que
 * se está mirando: la clase dice de cuál salió con la primera, que es su curso y
 * lo que agrupa la lista en pantalla (`src/js/grabar/grabadas.js`).
 */
function sidecaresDe(donde, base) {
    let nombres = [];
    try {
        nombres = fs.readdirSync(donde);
    } catch (e) {
        return []; // una carpeta que no está no tiene clases
    }

    const clases = [];
    for (const nombre of nombres) {
        if (!nombre.endsWith(SUFIJO_SIDECAR)) continue;
        const json = path.join(donde, nombre);
        try {
            const leida = notasXml.estadoLeido(JSON.parse(fs.readFileSync(json, 'utf8')));
            if (!leida || !leida.secuencia) continue;
            const suyos = workspace.notasDeClase(json);
            clases.push({
                ...leida,
                carpeta: base,
                // El empalme de cada toma se rehace al leer, por lo mismo que el
                // agregado de abajo: lo que el archivo guarda es la respuesta del
                // modelo y el descarte del editor, y la sugerencia depende de
                // dónde están los bordes ahora — que se pueden mover sobre una
                // clase ya terminada (`editarGrabada`).
                tomas: (leida.tomas || []).map(t =>
                    ({ ...t, empalme: empalme.paraLaPantalla(t, leida.tomas) })),
                // El agregado se rehace al leer y no sale del archivo: lo que el
                // archivo guarda es la medida de cada toma, y qué tomas cuentan
                // depende de cuáles quedaron descartadas — que se puede cambiar
                // sobre una clase ya terminada (`editarGrabada`).
                lengua: lengua.agregado(leida.tomas),
                archivos: { xml: suyos.xml, json: suyos.json }
            });
        } catch (e) {
            // Un JSON a medio escribir o de otra cosa: no es una clase.
        }
    }
    return clases;
}

/**
 * Lo que la ventana necesita para dibujar.
 *
 * Va todo en cada aviso y no los cambios: una sesión tiene veinte tomas y unas
 * miles de palabras, que es nada, y mandar el estado entero evita que la pantalla
 * y el motor puedan discrepar.
 *
 * No toca el estado. Qué toma repite a cuál se calcula acá y no se guarda —el
 * texto de una toma cambia cuando se la relee o se le mueve un borde— y se lee
 * del resultado, no de las tomas.
 */
function resumen() {
    if (!sesion) return null;
    const e = sesion.estado;
    const abierta = vivo.tomaAbierta(e);
    const repite = vivo.repeticiones(e.tomas);
    return {
        secuencia: e.secuencia,
        clase: e.clase,
        parte: e.parte,
        curso: e.curso,
        ceroMs: e.ceroMs,
        claqueta: e.claqueta,
        vistas: vivo.VISTAS,
        dir: sesion.dir,
        // Dónde van a caer los dos archivos de esta clase. La pantalla lo muestra
        // para que el editor sepa dónde buscar el XML (ver `archivosDeLaClase`).
        archivos: archivosDeLaClase(),
        grabando: true,
        // El temario del CD con su última cobertura, y si hay una medición en
        // vuelo: el panel lo dice mientras tarda, que si no la lista pegada se
        // queda unos segundos sin ningún resultado y parece que no hizo nada.
        temario: e.temario || null,
        midiendoTemario: Boolean(sesion.midiendoTemario),
        // Cómo viene hablando, sobre la clase que va a quedar. Se calcula acá y
        // no se guarda, igual que `repiteA`: la medida de cada toma sí está
        // guardada, pero el agregado depende de cuáles siguen vivas y eso cambia
        // cada vez que alguien descarta una (`lengua.agregado`).
        lengua: lengua.agregado(e.tomas),
        // Cerrando: el audio ya está cerrado y se releen las últimas tomas.
        terminando: Boolean(sesion.terminando),
        segundos: sesion.captura ? sesion.captura.segundos : 0,
        abierta: abierta ? abierta.id : null,
        // Qué hay para deshacer y para rehacer, con el nombre del paso que toca:
        // es lo que deja que los dos botones se apaguen cuando no hay nada y
        // digan en su título qué van a revertir antes de apretarlos.
        historia: {
            ...historial.pasos(sesion.historia),
            queAtras: (historial.proximo(sesion.historia, 'atras') || {}).que || '',
            queAdelante: (historial.proximo(sesion.historia, 'adelante') || {}).que || ''
        },
        tomas: e.tomas.map(t => ({
            id: t.id,
            vista: t.vista,
            comentario: t.comentario || '',
            descartada: Boolean(t.descartada),
            cerradaSola: Boolean(t.cerradaSola),
            pausaAdentro: t.pausaAdentro || null,
            repiteA: repite.get(t.id) || null,
            cuenta: t.cuenta || '',
            inMs: t.inMs,
            outMs: t.outMs,
            palabras: t.palabras,
            // Lo medido de esta toma, tal cual: la tarjeta puede querer decir
            // cuál fue la toma que le movió el número al panel.
            lengua: t.lengua || null,
            // Cómo pega con la anterior, y qué hacen los dos botones si no pega.
            // Va rehecho y no tal como está guardado, igual que `repiteA`: la
            // sugerencia habla de una palabra concreta de la toma anterior, y esa
            // palabra se mueve cada vez que se relee una toma o se corre un borde
            // (ver `paraLaPantalla` en `engine/empalme.js`).
            empalme: empalme.paraLaPantalla(t, e.tomas),
            // Lo que se dijo pegado a cada borde, para poder moverlo mirando.
            antes: t.antes || [],
            despues: t.despues || [],
            comentarios: t.comentarios
        }))
    };
}

module.exports = {
    CICLO_MS,
    activa,
    iniciar,
    pcm,
    claqueta,
    ponerTemario,
    editar,
    editarGrabada,
    deshacer,
    rehacer,
    cerrarToma,
    terminar,
    apagar,
    resumen,
    listar,
    parteQueSigue,
    regenerar,
    // Para poder empujar el ciclo desde una prueba o desde el arnés, sin esperar
    // los tres segundos del reloj.
    buscarSenales
};
