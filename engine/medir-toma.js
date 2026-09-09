'use strict';
/**
 * medir-toma.js — Todo lo que hay que medir DE UNA TOMA, cuando queda cerrada.
 *
 * El panel de análisis tiene un bloque por cosa que se mira, y hay dos formas
 * distintas de medir según qué se pregunte. La cobertura del temario se pregunta
 * sobre la clase entera y se vuelve a preguntar cuando hay material nuevo, así
 * que su disparador vive en `grabacion.js` al lado del temario (`pedirTemario`).
 * Esto es la otra: lo que se mide de CADA toma y queda guardado en ella.
 *
 * **Por qué por toma y no por clase.** Una toma se puede descartar, y el número
 * que ve el profesor tiene que ser el de la clase que va a quedar. Con la medida
 * viviendo en la toma, descartar es filtrar y no volver a medir: el agregado
 * cambia en el acto, volver a incluirla la trae de vuelta intacta, y ninguna
 * consulta se paga dos veces. Con una medida por clase habría que remedirla
 * entera cada vez que alguien descarta algo. La metodología —ejemplos,
 * ejercicios, preguntas al alumno— es de esta misma familia y va a entrar acá.
 *
 * **Dos fases, y la separación es el punto.** `medir` es sincrónico, no falla y
 * no pide nada: son cuentas sobre las palabras que ya están en memoria, así que
 * el panel tiene número apenas la toma cierra. `conModelo` cuesta una consulta,
 * tarda segundos y puede volver mal. Si fueran una sola fase, una consulta lenta
 * dejaría el panel en blanco mientras se graba y una que falle lo dejaría en
 * blanco del todo.
 *
 * **Cuándo se puede preguntar no se decide acá.** Con el modelo local, consultar
 * mientras se graba es pelearle la GPU al Whisper que decide dónde arrancan las
 * tomas; ese criterio vive entero en `engine/gpu.js` y acá solo se lo consulta,
 * una vez, en `conModelo`. Lo que sí es de este archivo es la otra mitad: la
 * deuda que deja la abstención se paga en `cerrar`, cuando la GPU queda libre.
 *
 * Sin DOM y sin disco: quien escribe es `grabacion.js`, con sus escrituras
 * atómicas de siempre.
 */

const ia = require('./ia');
const gpu = require('./gpu');

/**
 * Los medidores dados de alta, en orden de alta.
 *
 * Cada uno es `{ clave, medir(toma), conModelo({toma, cliente, signal}) }`:
 *
 *   clave      dónde queda el resultado dentro de la toma (`toma[clave]`)
 *   medir      sincrónico; devuelve el objeto determinista, o null si no aplica
 *   conModelo  opcional; async, devuelve `{hallazgos}` o `{error}`
 *
 * La lista es global y no de la sesión a propósito: los medidores son código, no
 * datos de una grabación, y darlos de alta al cargar el módulo evita que una
 * sesión arranque con la mitad enganchada.
 */
const medidores = [];

function registrar(medidor) {
    if (!medidor || !medidor.clave) throw new Error('Un medidor de tomas necesita su clave.');
    if (medidores.some(m => m.clave === medidor.clave)) return;
    medidores.push(medidor);
}

/** Con qué se está midiendo, mientras dure la sesión. Ver `cliente`. */
let proveedor = null;

/** La consulta en vuelo y la que espera turno. Ver `carril`. */
let enVuelo = null;
let esperando = null;

/**
 * La medida determinista de una toma: instantánea y sin fallar.
 *
 * Se recalcula entera cada vez, y por eso mover un borde no deja un número
 * viejo: `grabacion.js` vuelve a encolar la toma cuando el borde se mueve, se
 * relee el tramo y esto corre de nuevo sobre las palabras nuevas.
 *
 * Un medidor que se caiga no puede llevarse a los demás: son bloques
 * independientes de un panel, y que uno tenga un bug no es motivo para que el
 * profesor pierda los números de los otros.
 *
 * @returns {Array<string>} las claves que quedaron con medida nueva
 */
function medir(toma) {
    const puestas = [];
    for (const medidor of medidores) {
        let det = null;
        try {
            det = medidor.medir(toma);
        } catch (err) {
            det = null;
        }
        if (!det) continue;
        toma[medidor.clave] = { ...(toma[medidor.clave] || {}), det };
        puestas.push(medidor.clave);
    }
    return puestas;
}

/**
 * El cliente con el que se consulta, armado una vez por sesión.
 *
 * Se arma una sola vez y el motivo se recuerda: `ia.estado()` es barato pero
 * `armar` no siempre lo es, y preguntarlo en cada toma sería lanzar el Cursor
 * CLI veinte veces por clase para que conteste lo mismo. El temario lo arma en
 * cada pasada porque las suyas son pocas y espaciadas; acá son una por toma.
 *
 * Acá NO se decide si se puede consultar: eso es `gpu.sePuedeConsultar`, y se
 * pregunta en `conModelo`, antes de llegar hasta acá. Con el proveedor local y
 * una grabación en curso esta función no se llama nunca, que es lo que evita
 * que armarla levante Ollama al lado del Whisper de las señales.
 *
 * @returns {Promise<{cliente:object|null, porque:string, modelo:string|null}>}
 */
async function cliente() {
    if (proveedor) return proveedor;

    let estado = null;
    try {
        estado = ia.estado();
    } catch (err) {
        proveedor = { cliente: null, porque: err.message, modelo: null };
        return proveedor;
    }

    if (estado.estado !== 'listo') {
        proveedor = { cliente: null, porque: estado.reason, modelo: null };
        return proveedor;
    }

    const armado = await ia.armar({});
    proveedor = armado.cliente
        ? { cliente: armado.cliente, porque: armado.reason, modelo: armado.model || null }
        : { cliente: null, porque: armado.reason, modelo: null };
    return proveedor;
}

/**
 * Olvida con qué se estaba midiendo y deja el carril libre.
 *
 * Lo llama `grabacion.iniciar`: entre dos clases el editor puede haber cambiado
 * de proveedor en Ajustes, y una sesión nueva tiene que preguntarlo de nuevo.
 */
function olvidar() {
    proveedor = null;
    enVuelo = null;
    if (esperando) esperando.resolver({ desplazada: true });
    esperando = null;
}

/**
 * De a una consulta, y en la cola espera solo la última toma.
 *
 * Lo primero es la protección obvia: dos tomas pueden cerrar en pocos segundos
 * —el profesor arranca, se equivoca y vuelve a arrancar— y con dos consultas en
 * el aire el proveedor las cobra las dos, el CLI compite consigo mismo y la
 * segunda respuesta puede llegar antes que la primera.
 *
 * **Lo segundo se aprendió midiendo, y es lo que hace que esto sirva.** Con el
 * modelo que está configurado en esta Mac —un "thinking" por el Cursor CLI— una
 * toma de un minuto y medio se contesta en unos dos minutos. O sea que las tomas
 * cierran más rápido de lo que se contestan, y una fila que las guarde todas se
 * atrasa sola: a la media hora de clase estaría leyendo la toma de hace veinte
 * minutos y cobrando cada una de las del medio. En un informe eso da igual; en un
 * panel en vivo es exactamente lo contrario de lo que se pidió.
 *
 * Así que la que espera es siempre la más nueva y la anterior se cae. Lo que se
 * pierde es el hallazgo de una toma del medio, y no es gran cosa: el panel muestra
 * la última de todos modos, y lo que la toma del medio tenga para decir del hábito
 * del profesor lo va a volver a decir la que viene. Lo que NO se pierde son las
 * tres tasas, que se calculan sobre todas las tomas y sin modelo.
 *
 * La desplazada queda sin resultado a propósito y no como falla: no falló nada,
 * no se preguntó. Y como no queda en 'listo', la próxima relectura la reintenta.
 */
function carril(tarea) {
    return new Promise(resolver => {
        if (esperando) esperando.resolver({ desplazada: true });
        esperando = { tarea, resolver };
        bombear();
    });
}

function bombear() {
    if (enVuelo || !esperando) return;
    const turno = esperando;
    esperando = null;
    enVuelo = (async () => {
        try {
            turno.resolver(await turno.tarea());
        } catch (err) {
            turno.resolver({ error: err.message });
        }
        enVuelo = null;
        bombear();
    })();
}

/**
 * La parte que pide modelo, de todos los medidores que la tengan.
 *
 * No se espera desde la fila que rehace el texto de las tomas: esa fila es la que
 * decide dónde arrancan las siguientes, y una consulta de treinta segundos metida
 * ahí retrasaría la clase entera. Se larga y avisa cuando llega.
 *
 * Nunca lanza y nunca deja un medidor sin estado: el panel tiene que poder decir
 * la verdad —"no se pudo medir", y por qué— en vez de quedarse en un guion que se
 * lee como "todavía estoy pensando" para siempre.
 *
 * **Una toma se consulta una sola vez.** Un resultado bueno no se vuelve a pedir
 * ni cuando se mueve un borde: correr un OUT una frase no cambia si una idea
 * quedó colgando, y una consulta por cada arrastre de borde es cómo un panel en
 * vivo se convierte en una factura. Lo que falló sí se reintenta en la próxima
 * relectura, que es cuando puede haber cambiado algo.
 *
 * @param {object} params { toma, avisar, signal, cliente, proveedor } — los dos
 *   últimos son para las pruebas y para el arnés: con un cliente puesto no se
 *   lee la configuración, y con un proveedor puesto no se lee Ajustes.
 */
async function conModelo(params) {
    const p = params || {};
    const toma = p.toma;
    const pendientes = (toma ? medidores : []).filter(m => m.conModelo && !yaEsta(toma, m.clave));
    if (!pendientes.length) return;

    const avisar = typeof p.avisar === 'function' ? p.avisar : () => {};

    // **El veto vive en el mecanismo y no en cada medidor**, y esa es la única
    // forma de que sirva: un medidor nuevo lo hereda sin tener que acordarse de
    // él. La cobertura del temario se escribió en paralelo con la del lenguaje y
    // terminó midiendo en vivo contra el modelo local justamente porque cada una
    // resolvió el peligro por su cuenta (ver `engine/gpu.js`).
    //
    // Antes de mirar el cliente puesto a mano: lo que se está preguntando no es
    // con qué se mide sino si se puede medir ahora.
    if (!gpu.sePuedeConsultar(p.proveedor)) {
        for (const m of pendientes) guardar(toma, m.clave, abstenido(gpu.PORQUE));
        avisar();
        return;
    }

    const puesto = p.cliente !== undefined
        ? { cliente: p.cliente, porque: 'Cliente puesto a mano.', modelo: null }
        : await cliente();

    if (!puesto.cliente) {
        for (const m of pendientes) guardar(toma, m.clave, sinModelo(puesto.porque));
        avisar();
        return;
    }

    for (const m of pendientes) guardar(toma, m.clave, { estado: 'midiendo', porque: '', hallazgos: [] });
    avisar();

    for (const medidor of pendientes) {
        const salida = await carril(() => pedir(medidor, toma, puesto, p.signal));
        // La desplazada se borra en vez de escribirse: dejar "midiendo" sería
        // mentir —no se está midiendo— y dejar una falla sería acusar de un error
        // que no hubo. Sin estado, el panel simplemente no la muestra.
        if (salida.desplazada) borrar(toma, medidor.clave);
        else guardar(toma, medidor.clave, salida);
        avisar();
    }
}

/** Una consulta de un medidor, con todo lo que puede salir mal ya contestado. */
async function pedir(medidor, toma, puesto, signal) {
    try {
        const salida = await medidor.conModelo({ toma, cliente: puesto.cliente, signal });
        if (salida && salida.error) return { estado: 'falla', porque: salida.error, hallazgos: [] };
        return {
            estado: 'listo',
            porque: '',
            modelo: puesto.modelo,
            hallazgos: (salida && salida.hallazgos) || []
        };
    } catch (err) {
        // `ask` no lanza, pero un medidor puede tener un bug al leer la respuesta.
        // Que el bloque diga "no se pudo" es mejor que tumbar la grabación.
        return { estado: 'falla', porque: err.message, hallazgos: [] };
    }
}

function sinModelo(porque) {
    return { estado: 'sin-modelo', porque, hallazgos: [] };
}

/**
 * Abstenido: hay modelo, no se lo consulta ahora, y se dice cuándo sí.
 *
 * Es un estado propio y no un 'sin-modelo' con otro texto porque no es lo mismo
 * y el panel lo dibuja distinto: 'sin-modelo' es una falta de configuración y se
 * pinta como falla, esto es una decisión de la app y se pinta como lo que es.
 * Además es lo que marca la deuda: `cerrar` busca justo este estado para saber
 * qué le quedó por medir cuando la GPU se libera.
 */
function abstenido(porque) {
    return { estado: 'abstenido', porque, hallazgos: [] };
}

function yaEsta(toma, clave) {
    return Boolean(toma[clave] && toma[clave].ia && toma[clave].ia.estado === 'listo');
}

function guardar(toma, clave, estadoIa) {
    toma[clave] = { ...(toma[clave] || {}), ia: estadoIa };
}

/** Saca el estado del modelo y deja lo determinista, que no tiene nada que ver. */
function borrar(toma, clave) {
    if (!toma[clave]) return;
    const { ia: _ia, ...resto } = toma[clave];
    toma[clave] = resto;
}

/**
 * Cuánto se le da a lo que esté en el aire cuando se aprieta "Terminar".
 *
 * Esperar lo que tarde no va: el editor apretó "Terminar" porque quiere el XML en
 * la mano, y retenerlo cuarenta y cinco segundos por un renglón del panel es la
 * decisión equivocada. Ocho segundos alcanzan para la consulta que ya venía
 * volviendo, y lo que no llegue queda dicho —no en "midiendo", que sobre una
 * clase terminada se leería como que sigue pensando para siempre—.
 */
const GRACIA_MS = 8000;

/**
 * Cuánto se le da a lo que se había abstenido, ya con la GPU libre.
 *
 * Es otro techo que el de arriba porque mide otra cosa. `GRACIA_MS` es lo que se
 * le espera a una consulta que YA venía volviendo; esto es lo que el editor paga
 * por una medición que la app decidió no hacer antes y que el panel prometió
 * —"se mide en cuanto termine la grabación"—. Tirarla a los ocho segundos sería
 * no haberla hecho nunca, con el agregado de haberla anunciado.
 *
 * Treinta segundos es una decisión y no una medida: es del orden de lo que el
 * editor ya espera mientras se drena la cola de relecturas —uno o dos segundos
 * por toma pendiente—, la pantalla lo está diciendo mientras tanto
 * ("Terminando…"), y no llega a ser el minuto largo que haría dudar de si la app
 * se colgó. Lo que no entre en ese rato queda dicho, no en "midiendo".
 */
const CIERRE_MS = 30000;

/**
 * Cierra la medición de una sesión: mide lo que se había abstenido, espera un
 * rato lo que esté en el aire y deja dicho lo que no llegó.
 *
 * **Se llama cuando el Whisper de las señales ya soltó la GPU** y no antes: la
 * cola de relecturas quedó drenada y el audio está cerrado (ver `cerrarSesion`
 * en `grabacion.js`). Ese es el único momento en que lo que se abstuvo por no
 * pelearle la máquina puede preguntarse sin pelearle nada, y es el último en que
 * la sesión todavía existe para escribir la respuesta.
 *
 * @param {Array} tomas las de la sesión que se está cerrando
 * @param {object} [params] { avisar, cliente, proveedor } — los mismos que
 *   `conModelo`, y se le pasan tal cual a la deuda que quede por cobrar
 * @returns {Promise<boolean>} si quedó algo sin medir
 */
async function cerrar(tomas, params) {
    // La que espera turno se cae sin más: si la que está en vuelo apenas entra en
    // la gracia, la de atrás no tiene ninguna posibilidad de llegar.
    if (esperando) { esperando.resolver({ desplazada: true }); esperando = null; }
    if (enVuelo) await conTecho(enVuelo, GRACIA_MS);

    // El proveedor de la sesión se olvida antes de cobrar la deuda: se armó —o se
    // dejó de armar— cuando la regla era otra, y con el local ni siquiera se
    // había levantado.
    olvidar();
    await pagarLoAbstenido(tomas, params || {});

    let colgadas = 0;
    for (const toma of tomas || []) {
        for (const m of medidores) {
            const estado = toma[m.clave] && toma[m.clave].ia && toma[m.clave].ia.estado;
            if (estado === 'midiendo') {
                guardar(toma, m.clave, {
                    estado: 'falla',
                    porque: 'la clase terminó antes de que el modelo contestara',
                    hallazgos: []
                });
            } else if (estado === 'abstenido') {
                // El texto de la abstención promete que se mide al terminar, y
                // sobre una clase terminada esa promesa ya no se puede leer como
                // una espera. Se dice en pasado lo que de verdad pasó.
                guardar(toma, m.clave, abstenido('No se midió con el modelo local: mientras se ' +
                    'graba le pelearía la GPU al Whisper, y al terminar no le llegó el turno.'));
            } else {
                continue;
            }
            colgadas++;
        }
    }
    olvidar();
    return colgadas > 0;
}

/**
 * Las medidas que se habían abstenido, ahora que la máquina está libre.
 *
 * **De la más nueva a la más vieja, y con un techo.** Las dos cosas son la misma
 * decisión que ya tomó el carril mientras se graba: el panel muestra la última
 * toma que el modelo leyó, así que la toma de recién es la que tiene algo que
 * decir y la de hace veinte minutos no le mueve un número a nadie. Medirlas
 * todas serían veinte consultas para un renglón, cobradas mientras el editor
 * espera el XML.
 *
 * Se reusa `conModelo` entera y no se escribe una segunda forma de preguntar:
 * el carril, el "una toma se consulta una sola vez" y el nunca-lanzar ya están
 * ahí, y una copia de todo eso para el cierre se desincronizaría con la primera
 * corrección que se le hiciera a alguna de las dos.
 */
async function pagarLoAbstenido(tomas, params) {
    const hasta = Date.now() + CIERRE_MS;
    const pendientes = (tomas || []).filter(seAbstuvo).reverse();

    for (const toma of pendientes) {
        const queda = hasta - Date.now();
        if (queda <= 0) return;
        // La consulta que se pase del techo queda huérfana a propósito: cortarla
        // no la haría llegar antes, y lo que escriba después no lo va a mirar
        // nadie —el aviso se cae solo cuando la sesión ya no está—.
        await conTecho(conModelo({ ...params, toma }), queda);
    }
}

function seAbstuvo(toma) {
    return medidores.some(m =>
        toma[m.clave] && toma[m.clave].ia && toma[m.clave].ia.estado === 'abstenido');
}

/**
 * Lo que llegue primero: la tarea o el techo. Y el reloj se apaga siempre.
 *
 * Lo de apagarlo no es prolijidad. Un `setTimeout` suelto mantiene vivo el
 * proceso hasta que suene, así que un techo de treinta segundos que se resolvió
 * en uno deja la app sin poder cerrarse durante los veintinueve restantes —y la
 * suite de pruebas colgada el mismo rato, que es cómo apareció—.
 *
 * Lo usa también `grabacion.js` para esperar la cobertura del temario: es el
 * mismo techo del mismo cierre, y el mismo error de olvidarse de apagarlo.
 */
function conTecho(tarea, ms) {
    let reloj = null;
    const techo = new Promise(listo => { reloj = setTimeout(listo, ms); });
    return Promise.race([tarea, techo]).finally(() => clearTimeout(reloj));
}

/**
 * Corre algo con otra lista de medidores y devuelve la de antes.
 *
 * Es para las pruebas, y devuelve en vez de vaciar por una razón concreta: el
 * alta es global y se hace al cargar `grabacion.js`, así que una prueba que
 * vaciara la lista dejaría sin medición a todas las pruebas que corran después
 * en el mismo proceso. Y el síntoma sería una prueba de otro archivo fallando
 * según el orden de `tests/run.js`, que es lo peor que puede pasarle a una suite.
 */
async function conEstos(lista, tarea) {
    const antes = medidores.slice();
    medidores.length = 0;
    for (const m of lista) medidores.push(m);
    olvidar();
    try {
        return await tarea();
    } finally {
        medidores.length = 0;
        for (const m of antes) medidores.push(m);
        olvidar();
    }
}

module.exports = {
    GRACIA_MS,
    CIERRE_MS,
    conTecho,
    registrar,
    medidores,
    medir,
    conModelo,
    cerrar,
    olvidar,
    conEstos
};
