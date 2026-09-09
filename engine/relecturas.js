'use strict';
/**
 * relecturas.js — La cola que le rehace el texto a cada toma cerrada.
 *
 * Es el segundo de los dos ciclos de una grabación, y la separación entre los
 * dos es lo que protege el transcript. El de señales (`grabacion.js`) corre
 * seguido con un modelo liviano y su texto es descartable: solo sirve para saber
 * si alguien dijo "3, 2, 1" o "Pausa", y de eso solo se le cree la hora. Este
 * corre una vez por toma, al cerrarla, con el modelo grande, y ESE texto es el
 * que queda.
 *
 * Está en su archivo porque es una máquina con estado propio —una fila, una
 * pasada en vuelo, y la regla de que nunca haya dos— y porque de él cuelga todo
 * lo que se mide de una toma: la lengua, el empalme y el latido del temario. Lo
 * llaman el ciclo de señales, los cambios a mano y el cierre de la sesión, o sea
 * los tres sitios donde una toma puede quedar con el texto viejo.
 */

const espejo = require('./espejo');
const oirToma = require('./oir-toma');
const medirToma = require('./medir-toma');
const temarioSesion = require('./temario-sesion');
const vivo = require('./notas-vivo');

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
function encolar(sesion, id) {
    if (!sesion || !sesion.viva) return;
    sesion.cola.push(id);
    // `rehaciendo` guarda la promesa de la pasada en curso, y no un booleano:
    // `terminar` la espera, para no soltar la sesión con tomas a medio releer.
    if (!sesion.rehaciendo) sesion.rehaciendo = atenderCola(sesion);
}

async function atenderCola(sesion) {
    try {
        while (sesion.viva && sesion.cola.length) {
            await rehacer(sesion, sesion.cola.shift());
        }
    } finally {
        if (sesion.viva) sesion.rehaciendo = null;
    }
}

async function rehacer(sesion, id) {
    const toma = sesion.estado.tomas.find(t => t.id === id);
    if (!toma || toma.inMs == null || toma.outMs == null) return;

    try {
        const leido = await oirToma.leer(espejo.archivosDeLaSesion(sesion), toma);
        if (!sesion.viva || !leido) return;

        Object.assign(toma, leido);
        // La orilla de la derecha son segundos que, en el momento de cerrar la
        // toma, todavía se están grabando: nace vacía por fuerza. Queda anotado
        // para volver a buscarla cuando el audio la alcance (`releerOrillas`).
        toma.orillaCorta = espejo.grabadoHastaMs(sesion) < toma.outMs + oirToma.ORILLA_MS;

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

        espejo.fijar(sesion);
        // Y con el texto bueno ya puesto, se mide el temario. Este es el latido:
        // acá hay texto nuevo, estable y con sentido completo (ver `hayQueMedir`).
        temarioSesion.pedir(sesion);
        // Del mismo latido cuelga lo que la toma le pregunta a un modelo. No se
        // espera: esta fila es la que decide dónde arrancan las tomas siguientes,
        // y una consulta metida acá adentro retrasaría la clase entera.
        medirToma.conModelo({ toma, tomas: sesion.estado.tomas, avisar: avisador(sesion) });
    } catch (err) {
        if (sesion.viva) sesion.avisar({ tipo: 'error', mensaje: err.message });
    }
}

/**
 * Una medida de toma que acaba de cambiar: se escribe y se dibuja.
 *
 * Se llama varias veces por toma —al salir a preguntar, y otra vez con lo que
 * conteste— porque el panel tiene que poder decir "estoy midiendo" y después el
 * resultado. Cuesta dos escrituras de unos kilobytes, que es lo mismo que cuesta
 * cualquier otro cambio de esta sesión (`espejo.escribir`).
 *
 * Va como fábrica y no como función suelta porque quien la recibe —`medir-toma`—
 * la llama minutos después, cuando el proveedor conteste: para entonces la sesión
 * puede haberse cerrado, y `espejo.fijar` es el que sabe no escribir sobre una
 * sesión que ya no está.
 */
function avisador(sesion) {
    return () => { espejo.fijar(sesion); };
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
function releerOrillas(sesion) {
    const hasta = espejo.grabadoHastaMs(sesion);
    for (const toma of sesion.estado.tomas) {
        if (!toma.orillaCorta || toma.outMs == null) continue;
        if (hasta < toma.outMs + oirToma.ORILLA_MS) continue;
        toma.orillaCorta = false;
        encolar(sesion, toma.id);
    }
}

module.exports = { encolar, avisador, releerOrillas };
