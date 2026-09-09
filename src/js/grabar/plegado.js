'use strict';
/**
 * plegado.js — Una toma anterior plegada, y qué queda dicho de ella.
 *
 * Plegar es para ir limpiando la vista mientras la clase avanza: con doce tomas
 * abiertas, la que está pasando queda debajo del pliegue y hay que buscarla. Lo
 * que no puede pasar es que plegar esconda trabajo, así que una toma plegada
 * sigue diciendo lo que alguien dejó puesto encima.
 *
 * **El estado plegado no va al motor y no se guarda entre sesiones**, y las dos
 * cosas por el mismo motivo. No va al motor porque no es de la toma: es de cómo
 * se está mirando la lista hoy, y el XML es lo que se le hizo a la clase. Y no
 * sobrevive a cerrar la app porque las tomas se numeran por clase: "la toma 3
 * plegada" guardado el martes se aplicaría a la toma 3 de la clase del miércoles,
 * que es otra toma, con otro texto y otra decisión detrás. Entre repintados sí se
 * recuerda, y eso no es opcional: el estado del motor llega cada tres segundos y
 * si el pliegue se perdiera ahí, plegar no serviría para nada.
 *
 * La distinción es con "ocultar descartadas", que sí se guarda: eso es una forma
 * de trabajar y vale para todas las clases; esto es una decisión sobre una toma
 * concreta de esta clase.
 */

import { plural } from '../formato.js';

/** Cuántas palabras del arranque alcanzan para reconocer una toma. */
const PALABRAS_DEL_ASOMO = 12;

/**
 * Con qué empieza la toma.
 *
 * Es lo único que dice CUÁL es: la cabecera ya trae el número, la hora, el largo
 * y la vista, y ninguno de esos cuatro contesta "¿era esta la del ejercicio de
 * las reglas?". Del arranque y no del medio porque una toma empieza donde el
 * profesor anuncia de qué va, que es lo que la nombra.
 */
export function asomoDe(toma) {
    const dichas = (toma.palabras || []).map(w => w.texto);
    if (!dichas.length) return '';
    const corte = dichas.slice(0, PALABRAS_DEL_ASOMO).join(' ');
    return dichas.length > PALABRAS_DEL_ASOMO ? `${corte}…` : corte;
}

/**
 * Lo que hay puesto encima de la toma, en etiquetas cortas.
 *
 * Esto es la mitad que justifica que plegar exista: sin decir que la toma tiene
 * dos comentarios y una nota, plegarla es esconder el trabajo de quien los
 * escribió y nadie va a volver a abrirla. Lo que ya está en la cabecera —número,
 * horas, largo, vista— no se repite.
 *
 * Los avisos del motor entran también, y son los que más importan para decidir si
 * vale la pena volver a abrirla: que repita a otra toma o que tenga un "Pausa"
 * adentro son las dos cosas que obligan a mirar.
 *
 * @returns {string[]} vacío si no hay nada que decir
 */
export function marcasDe(toma) {
    const marcas = [];
    const cuantos = (toma.comentarios || []).length;
    if (cuantos) marcas.push(plural(cuantos, 'comentario', 'comentarios'));
    if (toma.comentario) marcas.push('con nota');
    if (toma.repiteA) marcas.push(`repite la ${toma.repiteA}`);
    // Una sugerencia de empalme es una decisión que todavía no tomó nadie, y
    // plegada es lo único que queda de ella: la tarjeta plegada no dibuja ni el
    // texto subrayado ni los dos botones. Sin esto, plegar sería la forma de
    // perderla.
    if (toma.empalme && toma.empalme.sugerencia) marcas.push('empalme por ajustar');
    if (toma.pausaAdentro) marcas.push('«Pausa» adentro');
    if (toma.cerradaSola) marcas.push('se cerró sola');
    return marcas;
}

/**
 * Cuánto se dijo, que es lo otro que decide si vale abrirla: una toma de tres
 * palabras se descarta sin leerla.
 *
 * En palabras y no en segundos porque los segundos ya están en la cabecera, y
 * porque no son lo mismo: una toma de un minuto con veinte palabras es una toma
 * en la que casi no se habló, y eso solo se ve contando palabras.
 */
export function cuantoSeDijo(toma) {
    const cuantas = (toma.palabras || []).length;
    return cuantas ? plural(cuantas, 'palabra', 'palabras') : 'sin texto';
}

/**
 * El resumen entero de una toma plegada.
 *
 * @returns {{asomo:string, cuanto:string, marcas:string[]}}
 */
export function resumenDe(toma) {
    return { asomo: asomoDe(toma), cuanto: cuantoSeDijo(toma), marcas: marcasDe(toma) };
}

/**
 * Qué tomas se pueden plegar.
 *
 * La abierta no: es lo que la persona está mirando, y un pliegue ahí escondería
 * lo que está pasando ahora mismo. Una descartada tampoco, y ese es el punto
 * donde plegar y "ocultar descartadas" podrían haber quedado compitiendo por lo
 * mismo: una descartada YA se dibuja plegada sobre su cabecera, así que plegarla
 * sería un gesto que no cambia nada de lo que se ve. Se esconden con el
 * interruptor de la barra, que las saca de la vista de una vez.
 *
 * Esto lo contesta dos veces y las dos tienen que ser la misma: si el cabezal se
 * dibuja como algo que se toca (`cabezalQueSePliega`) y si tocarlo pliega
 * (`elClicPliega`). Separadas, el cabezal de una descartada cambiaría de cursor
 * para después no hacer nada.
 */
export function sePuedePlegar(toma) {
    return toma.outMs != null && !toma.descartada;
}

/**
 * Si un clic sobre una tarjeta quiere decir "plegá esta toma".
 *
 * Plegar se pide tocando el cabezal y no apretando un botón, así que la decisión
 * es de un clic y no de un `onclick` colgado de algo: hay que mirar DÓNDE cayó.
 * Está separada del cableado por lo mismo que `queHace` en `teclas.js` —es lo
 * único que se puede comprobar sin una pantalla— y sobre todo porque los dos
 * casos que la hacen delicada son casos, no dibujos: un clic en un botón del
 * cabezal, y un cabezal que no se pliega.
 *
 * **Adentro del cabezal hay otros controles y ninguno puede plegar de rebote.**
 * Son las cinco vistas y "Descartar" en una toma anterior, y en la abierta
 * "Cerrar acá" —más "Reabrir" en la última, y "Eliminar" y "Recuperar" en una
 * descartada—. Apretar cualquiera de ellos es pedir eso y nada más: que la
 * tarjeta se plegara encima convertiría un cambio de vista en dos cosas, y la
 * segunda se llevaría de la pantalla el texto sobre el que se estaba decidiendo.
 * Por eso `enControl` no es una excepción de borde: es la mitad de la regla.
 *
 * Y no se pliega lo que no se puede plegar: la abierta —es lo que se está
 * mirando— y una descartada, que ya se dibuja plegada sobre su cabecera. Sin
 * esto, tocar el cabezal de una descartada sería un gesto que no hace nada, que
 * es peor que no tener gesto: se prueba, no pasa nada, y no se sabe si el gesto
 * no existe o si la app se colgó.
 *
 * @param {object} toma la del estado
 * @param {{enCabezal:boolean, enControl:boolean}} donde cómo fue el clic
 */
export function elClicPliega(toma, donde) {
    const d = donde || {};
    if (!d.enCabezal || d.enControl) return false;
    // Sin toma no se pliega nada: la tarjeta puede ser de un repintado que el
    // estado ya dejó atrás, y ahí el clic no tiene sobre qué contestar.
    return Boolean(toma) && sePuedePlegar(toma);
}

/**
 * Las tomas que quedan a la vista, según cómo se esté mirando la lista.
 *
 * @param {Array} tomas del estado, en el orden en que pasaron
 * @param {{sinDescartadas:boolean}} mirada
 */
export function alaVista(tomas, mirada) {
    const lista = tomas || [];
    return (mirada && mirada.sinDescartadas) ? lista.filter(t => !t.descartada) : lista;
}

/** Cuántas descartadas hay, para poder decir que se escondieron y no perdieron. */
export function cuantasDescartadas(tomas) {
    return (tomas || []).filter(t => t.descartada).length;
}
