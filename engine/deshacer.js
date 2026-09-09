'use strict';
/**
 * deshacer.js — El historial de lo que se le hizo a las tomas, para poder volver.
 *
 * Vive en el motor y no en la ventana, y eso NO es una elección de estilo: cada
 * cambio de esta pantalla reescribe el XML y el sidecar en el mismo gesto
 * (`escribir` en `grabacion.js`). Un deshacer que arreglara la pantalla dejaría
 * el archivo con el cambio puesto, o sea que lo que se ve y lo que va a abrir
 * Premiere dirían cosas distintas — que es exactamente lo que esta pantalla se
 * propuso no permitir.
 *
 * Por eso tampoco se pudo reusar el de la revisión de cortes (`src/js/visor/
 * estado.js`), aunque la forma sea la misma —dos pilas, un rótulo de qué se hizo
 * y un tope—: allá la verdad ES la ventana hasta que alguien aprieta "Guardar",
 * así que copiar `rev.segments` alcanza. Acá la verdad está en Node.
 *
 * Y hay una segunda diferencia que obliga a cambiar QUÉ se guarda. El visor
 * guarda el estado ENTERO porque los bloques de una clase ya procesada no cambian
 * solos. Acá llegan tomas nuevas cada tres segundos: una foto de la sesión entera,
 * repuesta cinco minutos después, borraría las tres tomas que entraron mientras
 * tanto. Así que la foto es de LA TOMA que el cambio tocó, y nada más. Deshacer
 * algo viejo no puede tocar lo que pasó después porque no lo tiene en la mano.
 *
 * ─── Dos clases de paso en una sola pila ──────────────────────────────────
 *
 * Hay dos gestos del editor que no son de ninguna toma: poner la claqueta a mano
 * y pegar el temario del CD. También reescriben el XML y el sidecar en el acto,
 * así que también tienen que poder volver — si no, el Cmd-Z que se da después de
 * uno de los dos se lleva puesto el cambio ANTERIOR, que es el mismo defecto que
 * un paso fantasma pero al revés y peor: el editor ve moverse algo que no había
 * pedido tocar.
 *
 * **Y eso no rompe la regla de arriba, porque la regla no era "no fotografiar la
 * sesión": era no fotografiar nada que se llene solo.** Lo único que crece sin
 * que nadie lo toque es la lista de tomas —el ciclo de señales le agrega una cada
 * vez que el profesor cuenta hasta uno—, y eso es exactamente lo que estos dos
 * pasos NO tienen en la mano. `estado.claqueta` es un campo que solo cambia
 * cuando alguien aprieta el botón o cuando se confirma un golpe; `estado.temario`
 * es la lista pegada con su última medición, y también. Reponer cualquiera de los
 * dos cinco minutos después deja las tomas donde estén, porque no las toca.
 *
 * Por eso el paso lleva `id` —de qué toma es— o `campo` —de qué campo de la
 * sesión—, y nunca los dos. Van en la MISMA pila y no en una segunda, que es lo
 * que hace que el orden de deshacer sea el orden real de los gestos: con dos
 * pilas habría que inventar cuál de las dos toca primero, y la respuesta correcta
 * ("la que se tocó al final") es justamente lo que una sola pila ya sabe.
 */

/**
 * Cuántos pasos atrás se pueden dar.
 *
 * El mismo número que el visor de cortes, y por el mismo motivo: es más de lo que
 * nadie deshace de a uno y el tope está para que una sesión de tres horas no
 * junte memoria sin techo. Acá cada foto pesa lo que pesa una toma —unas cientos
 * de palabras—, así que sesenta son unos pocos cientos de kilobytes.
 */
const TOPE = 60;

function nueva() {
    return { atras: [], adelante: [] };
}

/**
 * La copia de una toma que se guarda en el historial.
 *
 * Las listas se copian y lo que hay dentro de ellas no: ni las palabras ni los
 * comentarios se modifican nunca en su sitio —`repartir` arma listas nuevas,
 * `comentar` concatena y `descomentar` filtra—, así que compartir esos objetos
 * entre la foto y la toma no puede hacer que la foto cambie sola.
 *
 * @returns {object|null} null es "esta toma no existía", que es lo que deja que
 *   eliminar y volver a meter usen el mismo camino que cambiar un campo
 */
function foto(toma) {
    if (!toma) return null;
    const copia = { ...toma };
    for (const clave of ['antes', 'palabras', 'despues', 'comentarios']) {
        if (Array.isArray(copia[clave])) copia[clave] = copia[clave].slice();
    }
    return copia;
}

/**
 * La copia de un campo de la sesión —la claqueta, el temario— que se guarda.
 *
 * Es `foto` para lo que no es una toma, y con el mismo criterio: se copia el
 * objeto y sus listas, y lo que hay dentro de las listas no. Hace falta copiar y
 * no guardar la referencia porque estos dos campos SÍ se escriben en su sitio
 * mientras la foto espera: la medición de cobertura le deja el resultado encima
 * al mismo objeto de temario (`atender` en `temario-sesion.js`), así que una foto
 * por referencia cambiaría sola y deshacer no devolvería nada.
 *
 * Y por eso mismo la foto de un temario es lo que hace falta y nada más: la lista
 * pegada, y lo que ya se midió CONTRA esa lista. No hay nada de las tomas ahí
 * adentro.
 */
function fotoDeCampo(valor) {
    if (!valor) return null;
    const copia = { ...valor };
    for (const clave of Object.keys(copia)) {
        if (Array.isArray(copia[clave])) copia[clave] = copia[clave].slice();
    }
    return copia;
}

/**
 * Si dos fotos de la misma toma dicen lo mismo, o sea: si el cambio cambió algo.
 *
 * Vive acá y no en quien edita porque se contesta sobre las fotos, que es lo que
 * quien edita ya tiene en la mano —una de antes y otra de después— y porque así
 * hay UNA definición de qué es un cambio. Antes cada gesto traía la suya: mover
 * un borde al hueco donde ya estaba no dejaba paso, y reabrir una toma que el
 * motor se negaba a reabrir sí lo dejaba, que es el mismo paso fantasma con otro
 * nombre. Un paso que al deshacerse no se ve hace apretar de nuevo pensando que
 * el botón no funciona, y encima se come el Cmd-Z que iba para el cambio de
 * verdad.
 *
 * Las listas se comparan elemento a elemento y por referencia, que es lo mismo
 * que asume `foto` al copiarlas: ni las palabras ni los comentarios se modifican
 * nunca en su sitio. Sin eso, borrar un comentario que no existe pasaría por
 * cambio, porque `descomentar` filtra y devuelve una lista nueva con lo mismo
 * adentro.
 *
 * `null` es "esta toma no está", así que una foto contra null nunca son iguales:
 * es exactamente lo que hace eliminar, y lo que distingue eliminar de veras de
 * un eliminar que se plantó.
 */
function mismaFoto(a, b) {
    if (!a || !b) return !a && !b;
    const claves = Object.keys(a);
    if (claves.length !== Object.keys(b).length) return false;
    return claves.every(clave => {
        const x = a[clave];
        const y = b[clave];
        if (Array.isArray(x) || Array.isArray(y)) {
            return Array.isArray(x) && Array.isArray(y) &&
                x.length === y.length && x.every((cosa, i) => cosa === y[i]);
        }
        return x === y;
    });
}

/**
 * Anota un paso ya hecho, si es que hizo algo.
 *
 * **El portero está acá y no en quien edita**, y esa es toda la diferencia: así
 * no hay forma de que un gesto nuevo se olvide de preguntar. Cuando la pregunta
 * estaba del otro lado, el borde la hacía y reabrir no; el día que entraron la
 * claqueta y el temario habrían sido dos sitios más donde acordarse.
 *
 * Lo que no entra es un paso que al deshacerse no se ve: hace apretar de nuevo
 * pensando que el botón no funciona, y encima se come el Cmd-Z que iba para el
 * cambio de verdad.
 *
 * @param {object} historia de `nueva()`
 * @param {{que:string, tipo:string, id?:number, campo?:string,
 *   antes:object|null, despues:object|null}} paso — `id` si es de una toma,
 *   `campo` si es de un campo de la sesión. Uno de los dos, nunca los dos.
 */
function anotar(historia, paso) {
    if (mismaFoto(paso.antes, paso.despues)) return;
    historia.atras.push(paso);
    if (historia.atras.length > TOPE) historia.atras.shift();
    // Rehacer solo tiene sentido sobre lo que se deshizo: si después de deshacer
    // se edita otra cosa, ese futuro dejó de existir. Igual que en el visor.
    historia.adelante.length = 0;
}

/**
 * Deja los campos de la foto encima de la toma que ya está en la lista, sin
 * cambiar el objeto de sitio.
 *
 * Se copia ENCIMA y no se reemplaza el objeto porque hay dos cosas que se quedan
 * con la referencia mientras esperan: la cola de relecturas y la consulta al
 * modelo que mide la toma (`medirToma.conModelo`), que puede contestar medio
 * minuto después. Reemplazando el objeto, esa respuesta caería en una toma que ya
 * no está en la sesión y la medida se perdería sin que nada lo diga.
 */
function copiarEncima(destino, origen) {
    for (const clave of Object.keys(destino)) delete destino[clave];
    Object.assign(destino, origen);
}

/** Dónde entra una toma que se está devolviendo. Los ids van en orden creciente. */
function dondeEntra(tomas, id) {
    const despues = tomas.findIndex(t => t.id > id);
    return despues === -1 ? tomas.length : despues;
}

/**
 * Deja la toma `id` como dice la foto: le copia los campos, la saca de la lista
 * (`foto` en null) o la devuelve a su sitio por número.
 *
 * Mutando la lista que le pasan y no armando otra, por lo mismo que
 * `copiarEncima`: la sesión reparte esa lista por todas partes.
 */
function poner(tomas, id, cual) {
    const donde = tomas.findIndex(t => t.id === id);
    if (!cual) {
        if (donde >= 0) tomas.splice(donde, 1);
        return;
    }
    if (donde >= 0) copiarEncima(tomas[donde], cual);
    else tomas.splice(dondeEntra(tomas, id), 0, { ...cual });
}

/**
 * Deja un campo de la sesión como dice la foto. `poner` para lo que no es toma.
 *
 * **Toca el campo y nada más**, que es lo que hace que estos pasos convivan con
 * una clase que se sigue grabando: la lista de tomas ni se nombra acá, así que
 * deshacer una claqueta de hace cinco minutos no puede llevarse por delante las
 * tomas que entraron mientras tanto.
 *
 * Se copia al salir por lo mismo que se copió al entrar: quien reciba el objeto
 * le va a escribir encima —la cobertura del temario se deja ahí— y la foto tiene
 * que poder reponerse dos veces, que es lo que pasa al deshacer, rehacer y volver
 * a deshacer.
 */
function ponerCampo(estado, campo, cual) {
    estado[campo] = fotoDeCampo(cual);
}

/**
 * Si reponer esta foto dejaría dos tomas abiertas a la vez.
 *
 * Es el caso que aparece por grabar mientras se deshace, y no es raro: se cierra
 * una toma a mano, el profesor sigue hablando, el ciclo de señales abre la toma
 * siguiente, y entonces alguien se arrepiente del cierre. Devolver esa toma a
 * "abierta" dejaría dos sin OUT, y de ahí en adelante el ciclo le mete las
 * palabras a "la abierta" cuando ya no hay tal cosa: el conteo siguiente cerraría
 * una de las dos y la otra se quedaría abierta para siempre, o sea fuera del XML
 * (ver `reabrir` y `tomasQueQuedan`).
 *
 * Así que no se hace y se dice por qué, que es mejor que hacerlo y romper la
 * sesión en silencio. Lo demás —descartar, comentar, la vista, un borde, incluso
 * eliminar— no depende de nada que haya pasado después, y se deshace siempre.
 */
function dejariaDosAbiertas(tomas, id, cual) {
    if (!cual || cual.outMs != null) return false;
    return tomas.some(t => t.id !== id && t.outMs == null);
}

/**
 * El paso que habría que deshacer, sin sacarlo del historial. Para poder mirar
 * si se puede antes de comprometerse.
 */
function proximo(historia, hacia) {
    const pila = hacia === 'adelante' ? historia.adelante : historia.atras;
    return pila[pila.length - 1] || null;
}

/**
 * Saca el paso de una pila y lo pone en la otra, ya dado vuelta.
 *
 * @param {'atras'|'adelante'} hacia de qué pila se saca
 * @returns {{que:string, id:number, campo:string, foto:object|null}|null} qué hay
 *   que reponer, y dónde: en la toma `id` o en el campo `campo` de la sesión
 */
function sacar(historia, hacia) {
    const desde = hacia === 'adelante' ? historia.adelante : historia.atras;
    const a = hacia === 'adelante' ? historia.atras : historia.adelante;
    const paso = desde.pop();
    if (!paso) return null;
    a.push(paso);
    // Deshacer repone el "antes" y rehacer el "después": es el mismo paso leído
    // en las dos direcciones, así que no hay dos listas de inversas que puedan
    // separarse una de la otra.
    return {
        que: paso.que,
        id: paso.id,
        campo: paso.campo,
        foto: hacia === 'adelante' ? paso.despues : paso.antes
    };
}

/** Cuántos pasos hay para cada lado, sin tocar el historial. */
function pasos(historia) {
    return { atras: historia.atras.length, adelante: historia.adelante.length };
}

module.exports = {
    TOPE,
    nueva,
    foto,
    fotoDeCampo,
    mismaFoto,
    anotar,
    poner,
    ponerCampo,
    dondeEntra,
    dejariaDosAbiertas,
    proximo,
    sacar,
    pasos
};
