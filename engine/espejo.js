'use strict';
/**
 * espejo.js — La sesión mirada desde afuera.
 *
 * Todo lo de acá recibe la sesión y no la cambia: hasta dónde llegó el audio, en
 * qué archivos está, dónde van a caer sus dos archivos, qué dibuja la ventana y
 * qué queda en el disco. Son cinco preguntas distintas con una sola cosa en
 * común, y es la que importa: ninguna decide nada.
 *
 * Están juntas porque son la misma frontera. El resto del motor —el ciclo de
 * señales, la cola de relecturas, el temario, los cambios a mano— toca el estado
 * de la sesión; para contarlo afuera pasa por acá, y así hay UN solo sitio donde
 * se decide qué se ve de una grabación. Cuando la pantalla y el XML discrepan,
 * el que miente está en este archivo y en ninguno más.
 *
 * `escribir` es la única que sale del proceso, y sigue siendo un espejo: deja en
 * el disco exactamente el estado que las otras cuatro cuentan.
 */

const historial = require('./deshacer');
const notasXml = require('./notas-xml');
const vivo = require('./notas-vivo');
const workspace = require('./workspace');
const lengua = require('./lengua');
const empalme = require('./empalme');

/**
 * Hasta dónde llega el audio escrito, en hora del día.
 *
 * No se puede pedir hasta "ahora": el audio de ahora todavía no está en el
 * archivo. Se pide hasta donde el archivo llega, que es lo que `captura` sabe.
 */
function grabadoHastaMs(sesion) {
    if (!sesion || !sesion.captura) return 0;
    return sesion.captura.desdeMs + sesion.captura.segundos * 1000;
}

/** Los WAV de esta sesión: el que se está escribiendo y los que ya se cerraron. */
function archivosDeLaSesion(sesion) {
    return (sesion.captura ? [sesion.captura] : []).concat(sesion.estado.sesiones);
}

/**
 * Dónde van a caer el XML y el sidecar de la clase que se está grabando.
 *
 * Se pregunta desde dos sitios: al escribirlos, y en el resumen que mira la
 * pantalla, que lo único que hace con ellos es decirle al editor dónde está
 * guardando. Ese cartel decía la carpeta a secas y quedó mintiendo cuando el XML
 * bajó a `xml/`, y la forma de repararlo NO es que la ventana sepa el nombre de
 * esa subcarpeta: la forma de la carpeta vive en `workspace.js` y escribirla de
 * nuevo en el renderer es el mismo error con otra ropa. Va la ruta ya armada.
 */
function archivosDeLaClase(sesion) {
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
function escribir(sesion) {
    if (!sesion) return null;
    const archivos = archivosDeLaClase(sesion);

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
function resumen(sesion) {
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
        archivos: archivosDeLaClase(sesion),
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
            // Y qué le pasó a su relectura, si le pasó algo: es lo que la tarjeta
            // dibuja como aviso (`engine/insistir.js`).
            relectura: t.relectura || null,
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

/**
 * El estado, y de paso el aviso a la ventana. Es el par que se repite en cada
 * cambio del motor, y escribirlo suelto en veinte sitios es la forma de que
 * alguna vez uno de los dos falte.
 *
 * **Es también el portero de la sesión que ya se cerró.** Lo llaman cosas que
 * tardan: una medida que salió a preguntarle a un modelo vuelve medio minuto
 * después, y para entonces el editor puede haber apretado "Terminar". Escribir
 * ahí sería resucitar el XML de una clase cerrada —o peor, escribirlo mientras
 * la clase siguiente ya está grabando—. Se mira `viva` y no si hay una sesión en
 * curso, porque la que hay puede ser otra.
 */
function fijar(sesion) {
    if (!sesion || !sesion.viva) return null;
    escribir(sesion);
    const estado = resumen(sesion);
    sesion.avisar({ tipo: 'estado', estado });
    return estado;
}

module.exports = {
    grabadoHastaMs,
    archivosDeLaSesion,
    archivosDeLaClase,
    escribir,
    resumen,
    fijar
};
