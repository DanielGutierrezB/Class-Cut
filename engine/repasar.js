'use strict';
/**
 * repasar.js — El repaso final: lo que no cierra, arreglado.
 *
 * `coherence.js` lee la clase cortada y dice qué no cierra. Hasta acá eso
 * terminaba en una lista para el editor, y una lista es trabajo que no se hizo:
 * "el bloque 7 arranca con un 'Entonces' apoyado en algo que se eliminó" no es
 * un hallazgo, es una tarea de veinte segundos que la máquina puede hacer sola.
 *
 * Así que antes de reportar, se intenta. No todo se puede: que dos temas estén
 * en el orden equivocado se arregla moviendo bloques, y eso es una decisión de
 * quien edita. Lo que sí se puede es lo mecánico, que resulta ser la mayoría:
 *
 *   - **el conector huérfano** — el bloque abre con "Y", "Entonces", "Pero"
 *     apoyándose en algo que quedó fuera. Se corre el IN detrás del conector y
 *     el bloque abre por la frase.
 *   - **la frase abierta** — el bloque termina a mitad de idea porque el OUT
 *     cayó antes de que cerrara. Se estira hasta que cierre, sin llegar al
 *     bloque siguiente.
 *   - **lo dicho dos veces** — de eso se ocupa `repeticiones.js`.
 *
 * Dos reglas que no se negocian. **Todo arreglo se comprueba**: si después de
 * moverlo el defecto sigue ahí, se deshace, porque un corte movido que además
 * no arregló nada es peor que no haberlo tocado. Y **después de arreglar se
 * vuelve a leer**: la clase que se leyó ya no existe, y un arreglo puede dejar
 * un empalme nuevo donde no lo había. Sin esa segunda lectura, lo que se le
 * entrega al editor es el informe de una clase que no es la suya.
 */

const speech = require('./speech-edges');
const borde = require('./borde');
const repeticiones = require('./repeticiones');
const coherence = require('./coherence');

const DEFAULTS = {
    fps: 30,
    // Cuánto se puede quitar del arranque para dejar atrás el conector. Un
    // conector es una o dos palabras; si hay que tirar más que esto, lo que
    // sobra no es un conector sino media idea, y eso ya no lo decide una regla.
    maximoDelConectorSec: 3,
    palabrasDeConector: 3,
    // Si el bloque de antes termina a menos de esto, no se tiró nada entre los
    // dos y el conector tiene su antecedente pegado delante.
    pegadoAlAnteriorSec: 2,
    // Cuánto se puede estirar un OUT para que la frase cierre. El alineado ya
    // probó con 4s; acá se abre la mano porque hay una señal de que la frase
    // sigue, pero no tanto como para meter el tema siguiente.
    maximoQueSeEstiraSec: 8,
    // Y nunca hasta pisar el bloque de después: si el estirón llega ahí, lo que
    // se estaría metiendo es lo que el bloque siguiente ya dice.
    margenAlSiguienteSec: 0.5,
    minimoQueQuedaSec: 3,
    // Un bloque más largo que esto ya no es un fragmento suelto: aunque repita
    // lo que viene después, tiene material propio y lo decide quien edita.
    maximoDelFragmentoSec: 8,
    parecidoDelFragmento: 0.8
};

// Qué se sabe arreglar de cada cosa que reporta la lectura. Lo que no está acá
// —`orden`, `otro`— se reporta y ya: mover un bloque de sitio cambia la clase,
// y esa es una decisión de quien edita, no de una regla.
const SE_ARREGLA = new Set(['repetido', 'conector', 'empalme', 'idea_colgando']);

function opt(options, key) {
    if (options && options[key] !== undefined && options[key] !== null) return options[key];
    return DEFAULTS[key];
}

/** El bloque vivo que va justo detrás de este en la clase cortada. */
function elSiguiente(blocks, block) {
    const vivos = blocks.filter(b => b.enabled !== false).sort((a, b) => a.startSec - b.startSec);
    const i = vivos.indexOf(block);
    return i === -1 ? null : (vivos[i + 1] || null);
}

function elAnterior(blocks, block) {
    const vivos = blocks.filter(b => b.enabled !== false).sort((a, b) => a.startSec - b.startSec);
    const i = vivos.indexOf(block);
    return i <= 0 ? null : vivos[i - 1];
}

/** ¿Este bloque abre con un conector que se apoya en algo que ya no está? */
function abreEnFalso(words, block) {
    const dentro = speech.wordsInside(words, block.startSec, block.endSec);
    return Boolean(dentro.length) && speech.esConector(dentro[0]);
}

/** ¿Este bloque termina a mitad de frase? El criterio vive en `speech-edges`. */
function quedaColgando(words, block) {
    return speech.quedaColgando(words, block.startSec, block.endSec);
}

/**
 * Corre el IN detrás del conector con el que abría.
 *
 * @returns {{hecho: string, quitadoSec: number}|null}
 */
function quitarElConector(block, ctx) {
    const { words, wav, options, blocks } = ctx;
    if (!block.in || !abreEnFalso(words, block)) return null;

    // Un conector solo sobra si perdió su antecedente. "Y en cuarto lugar,
    // tenemos…" abre perfecto cuando el bloque de antes viene pegado: el "en
    // tercero" está ahí y se lee de corrido. Lo que lo deja huérfano es que
    // entre los dos se haya tirado material.
    const previo = elAnterior(blocks || [], block);
    if (previo && block.startSec - previo.endSec < opt(options, 'pegadoAlAnteriorSec')) return null;

    const dentro = speech.wordsInside(words, block.startSec, block.endSec);
    let i = 0;
    while (i < dentro.length && i < opt(options, 'palabrasDeConector') && speech.esConector(dentro[i])) i++;
    if (!i || i >= dentro.length) return null;

    const destino = dentro[i].start;
    const quitado = destino - block.startSec;
    if (quitado <= 0 || quitado > opt(options, 'maximoDelConectorSec')) return null;
    if (block.endSec - destino < opt(options, 'minimoQueQuedaSec')) return null;

    const memoria = borde.recordar(block, 'IN');
    const quitadas = dentro.slice(0, i).map(speech.textOf).join(' ');
    borde.aplicar({ block, kind: 'IN', timeSec: destino, words, wav, options, decidedBy: 'repaso' });

    // La comprobación: el bloque tiene que abrir por la frase, no por otro
    // conector que estaba detrás del primero.
    if (abreEnFalso(words, block)) { borde.deshacer(memoria); return null; }

    return {
        hecho: `Se quitó «${quitadas}» del arranque, que se apoyaba en algo que no quedó en la clase.`,
        quitadoSec: Math.round((block.startSec - memoria.startSec) * 10) / 10
    };
}

/**
 * Estira el OUT hasta que la frase cierre.
 *
 * @returns {{hecho: string, agregadoSec: number}|null}
 */
function cerrarLaFrase(block, ctx) {
    const { words, wav, options, blocks } = ctx;
    if (!block.out || !quedaColgando(words, block)) return null;

    // Hasta dónde se puede llegar sin meterse en el bloque de después.
    const siguiente = elSiguiente(blocks, block);
    const tope = siguiente
        ? Math.min(block.endSec + opt(options, 'maximoQueSeEstiraSec'),
            siguiente.startSec - opt(options, 'margenAlSiguienteSec'))
        : block.endSec + opt(options, 'maximoQueSeEstiraSec');
    if (tope <= block.endSec) return null;

    // Solo el candidato de estirar. El de retraer también cierra la frase, pero
    // lo hace tirando lo que se dijo hasta acá: con la ventana grande que hace
    // falta para esto, retraer se llevaría por delante media explicación.
    const margen = { ...(options || {}), maxShiftSec: tope - block.endSec };
    const ajuste = speech.snapToSentence(words, block.endSec, 'OUT', margen);
    const destino = ajuste.candidates.extend;
    if (destino == null || destino <= block.endSec || destino > tope) return null;

    const memoria = borde.recordar(block, 'OUT');
    borde.aplicar({ block, kind: 'OUT', timeSec: destino, words, wav, options, decidedBy: 'repaso' });

    // La comprobación: que de verdad cierre, y que no se haya comido el arranque
    // del bloque siguiente.
    const pisa = siguiente && block.endSec > siguiente.startSec;
    if (pisa || quedaColgando(words, block)) { borde.deshacer(memoria); return null; }

    return {
        hecho: `Se estiró el final hasta que la frase cerrara: «…${speech.textInside(words, memoria.endSec, block.endSec).slice(0, 70)}».`,
        agregadoSec: Math.round((block.endSec - memoria.endSec) * 10) / 10
    };
}

/** ¿Este bloque arranca a mitad de una frase que empezó antes? */
function abreAMitad(words, block) {
    const lista = speech.spoken(words);
    const i = lista.findIndex(w => w.end > block.startSec + 0.02);
    if (i <= 0) return false;
    return !speech.endsSentence(lista[i - 1]);
}

/**
 * Retrae el IN hasta donde la frase empezaba.
 *
 * El espejo de `cerrarLaFrase`, y sale del mismo sitio: el bloque 11 de la clase
 * 13 abría en "promesa de valor de este curso no es el proyecto". Le faltaba
 * "La", una palabra, y el alumno oye un arranque en falso.
 *
 * @returns {{hecho: string, agregadoSec: number}|null}
 */
function abrirLaFrase(block, ctx) {
    const { words, wav, options, blocks } = ctx;
    if (!block.in || !abreAMitad(words, block)) return null;

    // Hasta dónde se puede retroceder sin entrar en el bloque de antes.
    const previo = elAnterior(blocks || [], block);
    const piso = previo
        ? Math.max(block.startSec - opt(options, 'maximoQueSeEstiraSec'),
            previo.endSec + opt(options, 'margenAlSiguienteSec'))
        : block.startSec - opt(options, 'maximoQueSeEstiraSec');
    if (piso >= block.startSec) return null;

    const margen = { ...(options || {}), maxShiftSec: block.startSec - piso };
    const ajuste = speech.snapToSentence(words, block.startSec, 'IN', margen);
    const destino = ajuste.candidates.retract;
    if (destino == null || destino >= block.startSec || destino < piso) return null;

    const memoria = borde.recordar(block, 'IN');
    borde.aplicar({ block, kind: 'IN', timeSec: destino, words, wav, options, decidedBy: 'repaso' });

    const pisa = previo && block.startSec < previo.endSec;
    if (pisa || abreAMitad(words, block)) { borde.deshacer(memoria); return null; }

    return {
        hecho: `Se abrió el bloque donde empezaba la frase: «${speech.textInside(words, block.startSec, memoria.startSec).slice(0, 70)}…».`,
        agregadoSec: Math.round((memoria.startSec - block.startSec) * 10) / 10
    };
}

/**
 * Apaga un bloque suelto que el siguiente vuelve a decir entero.
 *
 * El detector de repeticiones no lo ve porque necesita diez palabras de cabeza
 * para comparar, y esto son cuatro: el bloque 8 de la clase 13 dura UN segundo y
 * dice "contaminar y perder contexto", que es el final de la frase que el bloque
 * 9 dice completa. Es un arranque en falso que quedó marcado como bloque.
 *
 * @returns {{hecho: string}|null}
 */
function tirarElFragmento(block, ctx) {
    const { words, options, blocks } = ctx;
    const siguiente = elSiguiente(blocks || [], block);
    if (!siguiente) return null;

    const dura = block.endSec - block.startSec;
    if (dura > opt(options, 'maximoDelFragmentoSec')) return null;

    const propio = speech.textInside(words, block.startSec, block.endSec);
    if (!propio || propio.split(/\s+/).length < 2) return null;

    // El que sobrevive tiene que ser el que dice más, no el que dice lo mismo
    // más corto.
    if (siguiente.endSec - siguiente.startSec <= dura) return null;

    const parecido = repeticiones.seParecen(propio, speech.textInside(words, siguiente.startSec, siguiente.endSec));
    if (parecido < opt(options, 'parecidoDelFragmento')) return null;

    block.enabled = false;
    block.disabledBy = 'repaso';
    block.disabledReason = `Fragmento de ${dura.toFixed(1)}s que el bloque ${siguiente.index + 1} vuelve a decir entero.`;
    return {
        hecho: `Se quitó: eran ${dura.toFixed(1)}s sueltos («${propio.slice(0, 60)}») que el bloque siguiente dice completos.`
    };
}

/**
 * Lo que se intenta para cada cosa que reporta la lectura, en orden.
 *
 * Se prueban de la más barata y segura a la más invasiva, y se para en la
 * primera que funcione: el modelo dice QUÉ suena mal, no dónde está la causa, y
 * la causa casi nunca es una sola cosa posible.
 */
function intentos(tipo) {
    // Un `conector` señalado por el modelo no siempre es un conector: la mitad
    // de las veces el bloque abre a mitad de frase y lo que suena raro es eso.
    // Se prueban las dos formas de arreglar un arranque.
    if (tipo === 'conector') return [['propio', quitarElConector], ['propio', abrirLaFrase]];
    if (tipo === 'idea_colgando') return [['propio', cerrarLaFrase]];
    // Una repetición que el detector no supo ubicar todavía puede ser un pedazo
    // suelto que el bloque siguiente vuelve a decir entero.
    if (tipo === 'repetido') return [['propio', tirarElFragmento]];
    // Un `empalme` es lo que se nota AL SALTAR de un bloque al siguiente, así
    // que puede estar de los dos lados: o el de antes se cortó a mitad de frase,
    // o el de después abre mal, o el bloque entero es un fragmento suelto que ya
    // se vuelve a decir.
    if (tipo === 'empalme') {
        return [
            ['propio', tirarElFragmento],
            ['anterior', cerrarLaFrase],
            ['propio', abrirLaFrase],
            ['propio', quitarElConector]
        ];
    }
    return [];
}

/**
 * Arregla lo que se pueda de un hallazgo.
 * @returns {string|null} qué se hizo
 */
function arreglar(finding, ctx) {
    const { blocks, review } = ctx;
    const enGuion = review.blocks.find(b => b.n === finding.bloque);
    if (!enGuion) return null;
    const propio = blocks.find(b => b.index === enGuion.index);
    if (!propio || propio.enabled === false) return null;

    for (const [cual, arreglo] of intentos(finding.tipo)) {
        const block = cual === 'propio' ? propio : elAnterior(blocks, propio);
        if (!block) continue;
        const res = arreglo(block, ctx);
        if (res) return res.hecho;
    }
    return null;
}

/**
 * Le pone al hallazgo el número que su bloque tiene AHORA.
 *
 * El guion se numera 1, 2, 3… sobre los bloques que quedan vivos, así que apagar
 * uno corre a todos los de atrás. Un hallazgo arreglado que conserve el número
 * viejo termina mostrándose dentro de otro bloque —el que ahora ocupa ese
 * número—, y lo que se lee es "acá se quitó una repetición" en un sitio donde no
 * se tocó nada. El índice del bloque no se mueve, así que se renumera por ahí.
 *
 * Si el bloque desapareció (se apagó, que es justo lo que suele arreglarlo), el
 * hallazgo se cuelga del que ocupó su lugar: es donde el editor va a buscar qué
 * pasó con ese pedazo.
 */
function renumerar(finding, guion) {
    if (finding.indice == null) return finding;
    const vivo = guion.blocks.find(b => b.index === finding.indice);
    if (vivo) return { ...finding, bloque: vivo.n };
    const siguiente = guion.blocks.find(b => b.index > finding.indice);
    return { ...finding, bloque: siguiente ? siguiente.n : (guion.blocks.length || 1) };
}

/** Deja el informe hablando de la clase que quedó, no de la que se leyó. */
function refrescarGuion(review, blocks, words) {
    for (const entrada of review.blocks || []) {
        const block = blocks.find(b => b.index === entrada.index);
        if (!block) continue;
        entrada.startSec = block.startSec;
        entrada.endSec = block.endSec;
        entrada.durationSec = Math.round((block.endSec - block.startSec) * 100) / 100;
        entrada.text = speech.textInside(words, block.startSec, block.endSec);
    }
}

/**
 * El repaso: arreglar lo que se pueda y volver a leer para ver qué quedó.
 *
 * @param {object} params { alignResult, review, words, wav, options, ai, signal, onProgress }
 * @returns {Promise<{review: object, stats: object}>}
 */
async function repasar(params) {
    const { alignResult, words, wav, options, ai, signal } = params;
    let review = params.review;
    const blocks = alignResult.blocks || [];
    const stats = { intentados: 0, arreglados: 0, relectura: false, quedaban: 0, quedan: 0 };
    if (!review || !review.findings) return { review, stats };

    stats.quedaban = review.findings.filter(f => !f.corregido).length;

    // Primero las repeticiones, que tienen su propio detector y saben ubicarse
    // solas cuando el modelo las señala. Lo que arreglen cuenta como arreglado:
    // si no, una clase donde lo único que se movió fue un recorte de repetición
    // no se volvía a leer, que es justo cuando hace falta.
    stats.arreglados += repeticiones.segunElModelo({ alignResult, review, words, wav, options }).corregidos;

    const ctx = { blocks, words, wav, options, review };
    for (const finding of review.findings) {
        if (finding.corregido || !SE_ARREGLA.has(finding.tipo)) continue;
        stats.intentados++;
        const hecho = arreglar(finding, ctx);
        if (!hecho) continue;
        finding.corregido = hecho;
        stats.arreglados++;
    }

    if (!stats.arreglados) {
        stats.quedan = stats.quedaban;
        return { review, stats };
    }

    // Antes de releer, cada arreglado se queda con el índice de su bloque: es lo
    // único que sobrevive a la renumeración de la segunda lectura.
    for (const f of review.findings) {
        if (!f.corregido || f.indice != null) continue;
        const enGuion = review.blocks.find(b => b.n === f.bloque);
        if (enGuion) f.indice = enGuion.index;
    }

    refrescarGuion(review, blocks, words);

    // Y la segunda lectura. Es lo que convierte esto en una validación del
    // resultado y no en una tanda de retoques a ciegas: se lee la clase que
    // quedó, con lo que se movió ya movido, y lo que se reporta sale de ahí.
    // Cuesta una llamada más por clase —el guion entero entra en una— contra
    // las decenas que se hacen al afinar los bordes.
    let segunda = null;
    try {
        if (params.onProgress) params.onProgress({ fase: 'releer' });
        segunda = await coherence.reviewClass({ alignResult, words, ai, signal, options });
        stats.relectura = true;
    } catch (e) {
        // Si la relectura falla, lo que vale es la primera lectura con los
        // arreglos anotados: peor informe, pero no uno inventado.
        stats.quedan = review.findings.filter(f => !f.corregido).length;
        return { review, stats, error: e.message };
    }

    // El informe final es el de la segunda lectura, más el registro de lo que se
    // arregló. Los pendientes de la primera no se arrastran: hablaban de una
    // clase que ya no existe, y varios de ellos son justo los que se acaban de
    // arreglar.
    const arreglados = review.findings.filter(f => f.corregido).map(f => renumerar(f, segunda));
    segunda.findings = [...arreglados, ...segunda.findings].sort((a, b) => a.bloque - b.bloque);
    segunda.stats = { ...segunda.stats, primeraLectura: review.stats, arreglados: arreglados.length };
    stats.quedan = segunda.findings.filter(f => !f.corregido).length;
    review = segunda;

    return { review, stats };
}

module.exports = {
    repasar,
    quitarElConector,
    cerrarLaFrase,
    abrirLaFrase,
    tirarElFragmento,
    abreEnFalso,
    abreAMitad,
    quedaColgando,
    SE_ARREGLA,
    DEFAULTS
};
