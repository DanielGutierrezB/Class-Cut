'use strict';
/**
 * empalme.js — El aviso de que la toma que cerró vuelve a decir lo que la
 * anterior ya decía, y el ajuste de un clic que lo saca.
 *
 * El profesor dice "Pausa", respira, y al retomar repite lo último que ya había
 * dicho para agarrar impulso. Pegadas una atrás de la otra, las dos tomas lo
 * dicen dos veces, y hoy eso se descubre en la mesa de edición, cuando la clase
 * ya pasó. Quién se da cuenta, dónde se corta y si ese corte se puede hacer es
 * entero de `engine/empalme.js`, que llega medido y probado: acá está solo cómo
 * se ve y qué mandan los dos botones.
 *
 * **Los dos botones no traducen nada, y esa es la regla del archivo.**
 * `sugerencia.ajuste` es literalmente el mismo `{tipo:'borde'}` que la pantalla
 * manda cuando alguien arrastra la línea roja, y `sugerencia.descartar` el que
 * deja constancia de que no. Los dos salen tal cual por `acciones.alCambiar`,
 * que es el camino de todo lo demás —la vista, la nota, los comentarios— y el
 * mismo en la clase en curso que en una ya grabada: lo que cambia es a qué
 * archivo va, no el gesto. Si acá hubiera que interpretar prosa no habría botón,
 * y alcanzaría con que una versión del prompt contestara distinto para que
 * dejara de andar sin que nadie se entere hasta apretarlo en medio de una clase.
 *
 * **Nada de esto se recuerda entre repintados, y no puede.** El estado del motor
 * llega cada tres segundos y la sugerencia se rehace en cada lectura contra las
 * palabras de ese momento (`paraLaPantalla` allá). O sea que aceptar el ajuste
 * la hace desaparecer sola —la palabra del corte ya no está en la toma
 * anterior— y de este lado no hay nada que limpiar ni ningún estado que se
 * pueda quedar viejo.
 */

import { fmtMs, plural } from '../formato.js';
import { unirVecinas } from './palabras.js';

/* ─── Qué se dibuja para cada estado ─────────────────────────────────────── */

/**
 * De lo que puede traer el motor, dos cosas se dibujan y el resto no.
 *
 * Los seis estados, y por qué:
 *
 * - `listo` **con sugerencia**: el bloque entero, que es para lo que existe todo
 *   esto. Da igual si la encontró la regla gratis o si se pagó una consulta —el
 *   `porque` lo dice con sus palabras— porque lo que se ofrece es el mismo
 *   cambio ya armado.
 * - `listo` **sin sugerencia**: nada. Se miró y las dos tomas no repiten nada.
 *   Un "todo bien" por cada toma que cierra son veinte carteles por clase para
 *   no decir nada, y así es como un aviso se vuelve ruido y se apaga.
 * - `descartado`: una línea apagada, sin botones. Es la única prueba de que el
 *   clic en "Descartar ajuste" quedó escrito y de que la sugerencia no va a
 *   volver en el repintado de dentro de tres segundos; sin ella, descartar se ve
 *   igual que no haber apretado nada. Se deshace con Cmd-Z, como todo.
 * - `midiendo`: una línea apagada. La consulta puede tardar hasta dos minutos y
 *   medio, así que es lo único que explica por qué una sugerencia aparece sola
 *   un rato después de que la toma cerró.
 * - `falla`, `sin-modelo`, `abstenido`: nada. No hay proveedor, o la llamada se
 *   cayó, o el medidor se abstuvo porque el Whisper local está usando la GPU
 *   para decidir dónde arrancan las tomas. Los tres son la misma situación para
 *   quien está grabando: no hay nada que apretar. Un cartel de error en medio de
 *   una clase, sobre algo que no se puede accionar, es puro ruido — y lo que la
 *   regla ve gratis se sigue viendo igual, que es el caso más frecuente.
 *
 * @param {object|null} empalme el de la toma, tal como lo manda el motor
 * @returns {{que:'sugerencia', sugerencia:object, contra:number}
 *   |{que:'nota', texto:string}|null}
 */
export function queDecir(empalme) {
    if (!empalme) return null;

    // Con sugerencia se dibuja, venga el estado que venga: lo que se puede
    // accionar se muestra. La aduana de si el corte es ejecutable ya la pasó
    // (`armarSugerencia`), así que un botón que llegó hasta acá anda.
    if (empalme.sugerencia) {
        return { que: 'sugerencia', sugerencia: empalme.sugerencia, contra: empalme.contra };
    }
    if (empalme.estado === 'descartado') {
        return { que: 'nota', texto: empalme.porque || 'Descartaste el ajuste de este empalme.' };
    }
    if (empalme.estado === 'midiendo') {
        return {
            que: 'nota',
            texto: `Mirando si esta toma vuelve a decir el final de la ${empalme.contra}…`
        };
    }
    return null;
}

/* ─── Los dos tramos subrayados ──────────────────────────────────────────── */

/**
 * Qué palabras se subrayan como aviso, en qué toma.
 *
 * Un empalme habla de DOS tomas —el final de la anterior y el arranque de esta—
 * y vive colgado de una sola, la que cerró. Así que quién subraya qué no lo
 * puede decidir una tarjeta mirándose a sí misma: se arma una vez por lista y se
 * reparte, que es también lo que evita recorrer las veinte tomas por cada
 * tarjeta que se dibuja.
 *
 * Los tramos vienen en horas de palabra y no en índices de caracteres, igual que
 * los comentarios y los bordes: un índice se rompe apenas la toma se relee con
 * el modelo grande y el texto cambia, y la hora de una palabra es la misma antes
 * y después.
 *
 * @param {Array} tomas las del estado, en el orden en que pasaron
 * @returns {Map<number, Array<{desdeMs:number, hastaMs:number, titulo:string}>>}
 */
export function tramosPorToma(tomas) {
    const mapa = new Map();
    const poner = (tramo, titulo) => {
        if (!tramo) return;
        const suyos = mapa.get(tramo.toma) || [];
        suyos.push({ desdeMs: Number(tramo.desdeMs), hastaMs: Number(tramo.hastaMs), titulo });
        mapa.set(tramo.toma, suyos);
    };

    for (const toma of tomas || []) {
        const visto = queDecir(toma.empalme);
        if (!visto || visto.que !== 'sugerencia') continue;
        // Cada tramo dice de qué lado del par está, y nombra la otra toma en vez
        // de señalar hacia dónde mirar: las dos tarjetas se ven iguales, solo una
        // tiene los botones, y la clase en curso va de la más vieja a la más nueva
        // mientras que la lista de lo ya grabado va al revés.
        poner(visto.sugerencia.enLaAnterior,
            `Esto se vuelve a decir al arrancar la toma ${toma.id}. ` +
            `El botón «Ajustar corte», en esa toma, lo saca de acá.`);
        poner(visto.sugerencia.enEsta,
            `Esto ya lo decía el final de la toma ${visto.contra}.`);
    }
    return mapa;
}

/**
 * Subraya como aviso las palabras que caen en un tramo.
 *
 * Por la hora de cada palabra, igual que `marcarComentados`, y después que él:
 * una palabra puede estar comentada Y repetida —es de esperar que alguien
 * comente justo la frase que el profesor volvió a decir— y las dos marcas se
 * dibujan encima sin mezclarse (ver el porqué en `grabar.css`).
 *
 * El globito se suma al que ya hubiera en vez de pisarlo: el de una palabra
 * comentada dice que se puede apretar para ver el comentario, y esconder eso
 * detrás del aviso sería tapar el trabajo de alguien con el de un modelo.
 *
 * @param {Element} texto el `.toma-texto` ya dibujado
 * @param {Array} tramos los de esta toma (`tramosPorToma`)
 */
export function marcarRepetidos(texto, tramos) {
    if (!tramos || !tramos.length) return;
    for (const span of texto.querySelectorAll('.toma-palabra')) {
        const t = Number(span.dataset.t);
        const dentro = tramos.find(r => t >= r.desdeMs && t <= r.hastaMs);
        if (!dentro) continue;
        span.classList.add('es-repetida');
        span.title = [span.title, dentro.titulo].filter(Boolean).join(' · ');
    }
    // Y el espacio entre dos palabras marcadas se mete adentro, para que la línea
    // corra por debajo de la frase y no de cada palabra. Si el paso de los
    // comentarios ya se lo llevó, acá no queda nada que absorber y tampoco hace
    // falta: la marca de allá ya lo cubre.
    unirVecinas(texto, 'es-repetida');
}

/* ─── El bloque con el porqué y los dos botones ──────────────────────────── */

/** Qué va a hacer el botón, dicho antes de apretarlo. */
function cuantoQuita(ajuste, contra) {
    return `Le corre el OUT de la toma ${contra} hasta donde arranca lo repetido: ` +
        `${fmtMs(ajuste.quitaSec * 1000)} y ${plural(ajuste.palabras, 'palabra', 'palabras')} menos.`;
}

function boton(clase, texto, titulo, alClic) {
    const b = document.createElement('button');
    b.className = `btn ${clase} btn-inline`;
    b.type = 'button';
    b.textContent = texto;
    b.title = titulo;
    b.onclick = alClic;
    return b;
}

/**
 * El bloque que cuelga de la toma que cerró: el porqué, qué va a pasar y los dos
 * botones debajo.
 *
 * Va con los demás avisos de la tarjeta —arriba del texto y no al pie— porque el
 * tramo del que habla es el ARRANQUE de esta toma, o sea las primeras palabras
 * que hay justo debajo: se lee el porqué y se ve subrayado lo que dice.
 *
 * Sin `acciones` van el porqué y el subrayado y no van los botones, que es la
 * misma regla de toda la pantalla: una clase leída de una carpeta ajena no tiene
 * dónde escribir, y un botón que no puede hacer nada no puede aparentarlo.
 *
 * @param {object} toma la del estado, con su `empalme`
 * @param {object|null} acciones { alCambiar(comando) }
 * @returns {Element|null} null cuando no hay nada que decir
 */
export function bloqueDe(toma, acciones) {
    const visto = queDecir(toma.empalme);
    if (!visto) return null;

    if (visto.que === 'nota') {
        const p = document.createElement('p');
        p.className = 'toma-empalme-nota';
        p.textContent = visto.texto;
        return p;
    }

    const { sugerencia, contra } = visto;
    const caja = document.createElement('section');
    caja.className = 'toma-empalme';
    caja.dataset.contra = String(contra);

    const porque = document.createElement('p');
    porque.className = 'toma-empalme-porque';
    porque.textContent = sugerencia.porque;

    const cuanto = document.createElement('p');
    cuanto.className = 'toma-empalme-cuanto';
    cuanto.textContent = cuantoQuita(sugerencia.ajuste, contra);

    caja.append(porque, cuanto);
    if (!acciones) return caja;

    const fila = document.createElement('div');
    fila.className = 'toma-empalme-acciones';
    fila.append(
        // Tal cual, sin tocarle un campo: es el mismo cambio que arrastrar la
        // línea roja hasta ahí, y esa equivalencia es a propósito.
        boton('btn-primary', 'Ajustar corte',
            'Mueve el OUT de la toma anterior hasta donde arranca lo repetido. Se deshace con Cmd-Z.',
            () => acciones.alCambiar(sugerencia.ajuste)),
        boton('btn-ghost', 'Descartar ajuste',
            'Deja el corte como está. La sugerencia no vuelve a aparecer para este empalme.',
            () => acciones.alCambiar(sugerencia.descartar))
    );
    caja.append(fila);
    return caja;
}
