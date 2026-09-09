'use strict';
/**
 * cambios-toma.js — Lo que el editor le hace a una toma a mano, y cómo se vuelve.
 *
 * Del otro lado de la pared está el ciclo de señales, que abre y cierra tomas
 * oyendo al profesor. Acá está lo otro: los gestos de una persona que está
 * mirando la pantalla. Van juntos con el historial y no en dos archivos porque
 * son la misma decisión tomada dos veces — el que puede volver atrás un cambio
 * es el que lo escribió, y todo lo de acá escribe el XML en el mismo gesto.
 *
 * Nada de acá toca el audio ni levanta un Whisper. Lo más que hace es pedirle a
 * la cola que relea una toma (`relecturas.encolar`), que es lo que pasa cuando
 * un borde se mueve y el texto de ese tramo ya no es el que estaba.
 */

const espejo = require('./espejo');
const relecturas = require('./relecturas');
const temarioSesion = require('./temario-sesion');
const historial = require('./deshacer');
const vivo = require('./notas-vivo');

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
 * deshacer (`volver` más abajo). Es por la misma razón que el cambio pasa por
 * acá: el que puede volver atrás es el que escribió el archivo.
 */
function editar(sesion, cambio) {
    if (!sesion) return null;
    const c = cambio || {};
    const toma = sesion.estado.tomas.find(t => t.id === c.toma);
    if (!toma) return espejo.resumen(sesion);

    const antes = historial.foto(toma);

    switch (c.tipo) {
        case 'borde': {
            // El texto de la toma ya no es el de este tramo: se relee. Mover un
            // borde es lo que se hace justamente cuando el conteo se comió una
            // palabra o cuando hay que cortar antes de algo, y en los dos casos
            // lo que hay que ver después es el texto nuevo.
            //
            // Un borde que cae donde ya estaba no se relee, y hay dos gestos que
            // llegan así: un arrastre que volvió al hueco de donde salió y un
            // clic derecho sobre la palabra que ya es la primera de la toma.
            // Serían dos segundos de GPU para dejar la toma igual. Del historial
            // se ocupa el portero de más abajo, que ve que la toma no se movió.
            const estaba = c.borde === 'in' ? toma.inMs : toma.outMs;
            if (c.paredMs != null && Number(c.paredMs) !== estaba &&
                vivo.moverBorde(toma, c.borde, Number(c.paredMs))) {
                relecturas.encolar(sesion, toma.id);
            }
            break;
        }
        case 'reabrir':
            reabrir(sesion, toma);
            break;
        case 'eliminar':
            eliminar(sesion, toma);
            break;
        // Los otros cinco se resuelven con lo que ya está escrito, así que son
        // los mismos que se hacen sobre una clase ya terminada (`editarGrabada`
        // en `clases-grabadas.js`), y de ahí que los aplique la misma función.
        // `borde` también entra ahí, pero acá va aparte: con la sesión viva se
        // relee el tramo, así que el borde no está atado a las orillas guardadas.
        default:
            vivo.aplicar(toma, c);
    }

    // Al historial entra lo que cambió la toma, y nada más. Quien decide eso es
    // `historial.anotar`, comparando las dos fotos: está de aquel lado para que
    // no haya un gesto que se olvide de preguntar (ver `anotar`).
    //
    // Lo único que se decide acá es qué es la foto de después, y es null cuando
    // la toma ya no está en la sesión. Se mira en la LISTA y no en el tipo del
    // cambio: un `eliminar` que se plantó —la toma no estaba descartada— deja la
    // toma donde estaba, así que su foto es la de antes y no hay paso que anotar.
    historial.anotar(sesion.historia, {
        que: comoSeLlama(c),
        tipo: c.tipo,
        id: toma.id,
        antes,
        despues: sesion.estado.tomas.includes(toma) ? historial.foto(toma) : null
    });

    espejo.escribir(sesion);
    // Descartar una toma le saca a la clase lo que esa toma decía, así que un
    // objetivo que estaba cubierto por ella deja de estarlo. Es el otro momento
    // —además del cierre de una toma— en que la cobertura cambia de verdad.
    temarioSesion.pedir(sesion);
    return espejo.resumen(sesion);
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
        // Los dos que no son de ninguna toma, así que no la nombran. Están acá y
        // no donde se hacen por lo mismo que los otros: si cada gesto redactara
        // su rótulo, el botón de deshacer diría las cosas de nueve maneras.
        case 'claqueta': return 'poner la claqueta';
        case 'temario': return `${vivo.limpio(c.texto) ? 'pegar' : 'sacar'} el temario`;
        default: return `el cambio en ${cual}`;
    }
}

/**
 * El paso de un campo de la sesión: la claqueta puesta a mano y el temario pegado.
 *
 * Están acá, con los de las tomas, porque son el mismo historial y la misma pila
 * —el orden de deshacer tiene que ser el orden de los gestos— y porque el rótulo
 * sale del mismo sitio. Lo que los distingue es qué se repone: un campo del
 * estado en vez de una toma, y por eso el paso lleva `campo` en lugar de `id`
 * (ver `engine/deshacer.js`).
 *
 * Quien los llama es `grabacion.js`, que es el único que sabe cuál es la sesión.
 * La foto de antes la toma él, antes de tocar nada; la de después se saca acá,
 * que es lo que garantiza que las dos se saquen igual.
 *
 * @param {'claqueta'|'temario'} campo qué campo de `sesion.estado` se tocó
 * @param {object|null} antes de `historial.fotoDeCampo`, sacada antes del cambio
 */
function anotarDeLaSesion(sesion, campo, antes, cambio) {
    if (!sesion) return;
    historial.anotar(sesion.historia, {
        que: comoSeLlama(cambio || {}),
        tipo: (cambio || {}).tipo,
        campo,
        antes,
        despues: historial.fotoDeCampo(sesion.estado[campo])
    });
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
 */
function eliminar(sesion, toma) {
    // Sin descartarla antes no se elimina. Se planta en silencio en vez de tirar
    // porque el camino honesto —el botón, que solo existe en una descartada— no
    // puede llegar acá: esto es la red de abajo, no un mensaje para nadie.
    //
    // Y no contesta si pudo: quien anota mira si la toma quedó en la sesión, que
    // es la misma pregunta hecha una sola vez para todos los gestos (ver `editar`).
    if (!toma.descartada) return;
    const tomas = sesion.estado.tomas;
    tomas.splice(tomas.indexOf(toma), 1);
}

/**
 * Solo la última, y solo si no hay otra abierta.
 *
 * Dos tomas abiertas a la vez rompen todo lo demás: el ciclo de señales le mete
 * las palabras a "la abierta" y no hay tal cosa, y el conteo siguiente cerraría
 * una de las dos dejando la otra abierta para siempre.
 *
 * **Plantarse es un caso que llega solo**, y de ahí que importe que no deje paso
 * en el historial: el botón se ofrece mirando el estado que está en pantalla, y
 * entre ese repintado y el clic el ciclo de señales pudo abrir la toma siguiente
 * —tres segundos—. El clic sale con el botón que la pantalla mostraba y acá ya no
 * se puede hacer nada. Como no toca la toma, la foto de después es igual a la de
 * antes y `editar` no anota nada.
 */
function reabrir(sesion, toma) {
    const tomas = sesion.estado.tomas;
    if (vivo.tomaAbierta(sesion.estado) || toma !== tomas[tomas.length - 1]) return;
    toma.outMs = null;
    toma.cerradaSola = false;
    // Lo que se dijo después del OUT deja de ser orilla: la toma sigue abierta y
    // esas palabras van a entrar en ella cuando se la relea al cerrar. Dejarlas
    // las mostraría dos veces, una en gris y otra dentro de la toma.
    toma.despues = [];
}

/* ─── Deshacer y rehacer ──────────────────────────────────────────────────
 *
 * El historial es del motor porque la verdad es del motor: cada cambio reescribe
 * el XML y el sidecar en el mismo gesto, así que volver atrás también tiene que
 * reescribirlos. El por qué está entero en `engine/deshacer.js`, junto con el
 * motivo de que la foto sea de una toma —o de un campo— y nunca de la sesión.
 */

/**
 * @param {'atras'|'adelante'} hacia
 * @returns {{ok:boolean, que?:string, error?:string, estado:object|null}}
 */
function volver(sesion, hacia) {
    if (!sesion) return { ok: false, estado: null };
    const paso = historial.proximo(sesion.historia, hacia);
    if (!paso) return { ok: false, estado: espejo.resumen(sesion) };

    const foto = hacia === 'adelante' ? paso.despues : paso.antes;
    // La única cosa que no se puede deshacer, y es de las tomas: un paso de la
    // sesión no repone ninguna, así que no puede dejar dos abiertas. Preguntarle
    // igual lo plantaría siempre, porque su `id` es undefined y entonces
    // cualquier toma abierta contaría como "la otra".
    if (!paso.campo && historial.dejariaDosAbiertas(sesion.estado.tomas, paso.id, foto)) {
        return {
            ok: false,
            error: `No puedo ${hacia === 'adelante' ? 'rehacer' : 'deshacer'} «${paso.que}»: ` +
                'mientras tanto se abrió otra toma, y dos tomas abiertas a la vez rompen ' +
                'el ciclo de señales. Cerrá la de ahora y volvé a intentar.',
            estado: espejo.resumen(sesion)
        };
    }

    historial.sacar(sesion.historia, hacia);
    if (paso.campo) historial.ponerCampo(sesion.estado, paso.campo, foto);
    else historial.poner(sesion.estado.tomas, paso.id, foto);
    // Un borde repuesto pide el mismo texto que pidió el gesto original: acá el
    // reparto de palabras lo hace la relectura, no el borde (ver `editar`).
    if (paso.tipo === 'borde' || paso.tipo === 'cerrar') relecturas.encolar(sesion, paso.id);

    espejo.escribir(sesion);
    // Y un temario repuesto vuelve con la cobertura que se había medido CONTRA
    // ESA lista, así que esto no vuelve a preguntar nada si nada se movió: la
    // huella que trae la foto es la que `hayQueMedir` compara. Lo que sí dispara
    // es el caso en que mientras tanto cerraron tomas, que es cuando la medición
    // vieja dejó de valer.
    temarioSesion.pedir(sesion);
    return { ok: true, que: paso.que, estado: espejo.resumen(sesion) };
}

/**
 * Cierra a mano la toma que esté abierta. Es el botón, no la señal.
 *
 * Se aprieta apurado y en medio de una interrupción —alguien quiere decirle algo
 * al profesor y hay que parar la toma para invitarlo a retomar—, así que va al
 * historial como todo lo demás: apretarlo de más es el error más probable de esta
 * pantalla, y tiene que costar una tecla arreglarlo.
 */
function cerrarToma(sesion) {
    if (!sesion) return null;
    const toma = vivo.tomaAbierta(sesion.estado);
    if (!toma) return espejo.resumen(sesion);
    const antes = historial.foto(toma);
    toma.outMs = vivo.finDeToma(toma, espejo.grabadoHastaMs(sesion));
    relecturas.encolar(sesion, toma.id);
    historial.anotar(sesion.historia, {
        que: comoSeLlama({ tipo: 'cerrar', toma: toma.id }),
        tipo: 'cerrar',
        id: toma.id,
        antes,
        despues: historial.foto(toma)
    });
    espejo.escribir(sesion);
    return espejo.resumen(sesion);
}

module.exports = { editar, comoSeLlama, anotarDeLaSesion, volver, cerrarToma };
