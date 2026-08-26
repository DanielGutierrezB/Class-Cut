'use strict';
/**
 * retimeo.js — Las palabras del transcript puestas sobre el sonido que de verdad
 * hay, para que el panel alumbre la que se está oyendo.
 *
 * **El problema, medido.** Whisper corre con `-ml 1 -sow`, o sea una palabra por
 * segmento, y los segmentos se pegan uno al otro: el "final" de una palabra no
 * es donde el sonido para, es donde arranca el segmento siguiente. Cuando el
 * modelo no sabe repartir los tiempos de adentro de una ventana, hace las dos
 * cosas que rompen el karaoke:
 *
 *   - Amontona las primeras palabras de la tirada en un mismo instante. En el
 *     curso de spec-driven son 3.735 palabras de 45.182 (8,3%) durando cero;
 *     "Y el código es" figuran las cuatro empezando en 271,51.
 *   - Reparte una tirada corta a lo largo de todo el hueco que le tocó. En el
 *     bloque 3 de la clase 1 la cuenta "3, 2, 1." figura del 253,66 al 262,36
 *     —8,7 s— cuando en la onda esas tres palabras suenan del 261,00 al 262,38.
 *     Los 7,3 s de adelante son silencio.
 *
 * Con eso, el resaltado se clava tres segundos en una palabra mientras el audio
 * sigue, y después salta doce de golpe. El texto está bien; los tiempos no.
 *
 * **La idea.** El transcript sabe QUÉ se dijo y en qué ORDEN, y eso no se toca.
 * Lo que no sabe es cuándo, así que el cuándo se saca de la onda: las palabras
 * rotas se reparten sobre los tramos donde el micrófono registró algo
 * (`voz.js`), no sobre el reloj. El silencio no reparte —el reparto lo salta
 * entero—, así que ninguna palabra puede quedar alumbrándose sobre el aire, y
 * como a cada una le toca sonido, ninguna queda durando cero.
 *
 * **Solo lo roto.** Whisper acierta la mayor parte del tiempo: medido contra el
 * render del corte de la clase 1, el error mediano de sus tiempos es de 0,13 s y
 * el 91% de las palabras caen a menos de medio segundo. La primera versión
 * repartía todas las tiradas y arreglaba los extremos rompiendo lo sano: la
 * mediana se iba a 0,31 s y las palabras dentro de 0,3 s bajaban del 75% al 49%.
 * Así que se toca palabra por palabra, y solo donde el defecto se ve: una
 * palabra que dice durar tres segundos y adentro de esos tres segundos el
 * micrófono no registró nada. Lo demás queda como vino.
 *
 * **Anclado al final.** Cada grupo roto se cuelga de su FINAL y el principio se
 * va a buscar contando sonido hacia atrás, porque ese es el sesgo del modelo y
 * ya estaba medido acá: Whisper acierta los finales de palabra y estira los
 * arranques hacia atrás sobre el silencio que los precede (`audio-onset.js`).
 *
 * **El peso de cada palabra** es cuánto se tarda en decirla, y sale de sus
 * letras. Ajustado sobre las 35.070 palabras sanas del curso (las que Whisper no
 * rompió), `duración ≈ 0,092 + 0,054 · letras` explica el 42% de la varianza con
 * un error mediano de 87 ms; contando sílabas en vez de letras explica el 38%
 * con 100 ms de error, así que se cuentan letras. No es una alineación fonética
 * —para eso haría falta otro modelo— pero el error que deja es de una fracción
 * de palabra, contra los siete segundos de antes.
 *
 * **Qué se descartó.** Transcribir el render del corte (que daría tiempos del
 * corte medidos sobre el audio real) no arregla nada: es el mismo Whisper con
 * las mismas banderas y trae el mismo defecto. Medido sobre el render de la
 * clase 1, 84 de sus 1.194 palabras (7,0%) salen durando cero, con las mismas
 * tiradas amontonadas ("El"/"Bitcoin" las dos en 15,14). El problema nunca fue
 * la traducción entre el tiempo de la grabación y el del corte —eso `letra.js`
 * ya lo hace bien—, era que los tiempos están mal en el reloj de la grabación.
 *
 * **Por qué esto no decide los cortes.** La pregunta se hizo y se midió: si el
 * motor sabe dónde suena de verdad cada palabra, ¿corta mejor? Se corrió el
 * curso entero por duplicado con `tools/medir-repaso.js --retimeo` —mismo
 * transcript, mismo criterio, lo único distinto el reloj— y la respuesta fue que
 * no. Con la vara medida sobre los tiempos corregidos, que es la única lectura
 * honesta de los dos planes, los defectos de borde van de 30 a 32 sobre 172
 * bloques: 4 bloques mejoran y 9 empeoran.
 *
 * Y mejora justo donde se esperaba —el conteo de toma que se colaba baja de 1 a
 * 0, el chatter de 3 a 2, los finales colgando de 9 a 8, y 13 IN se corren más
 * tarde con una mediana de 3,2 s, hasta 27,8 s— pero lo paga en el peor defecto
 * que hay: los cortes que entran en el sonido pasan de 3 a 8.
 *
 * El motivo de eso no es el reparto, es una interacción con
 * `speech-edges.wordLimits`. Los límites con los que `borde.aplicar` encierra la
 * búsqueda de onda salen de la palabra vecina, y mientras la palabra rota ocupa
 * un tramo enorme de reloj, ese tramo hace de barandilla sin querer. Al
 * corregirla, la barandilla desaparece: en el bloque 4 de la clase 2, "anterior"
 * pasa de ocupar 793,53-801,02 a 800,63-801,02, el límite de abajo se afloja de
 * 793,53 a 774,40, y la medición de onda se va a buscar más lejos y se agarra de
 * un ruido en 798,18 en vez del "¿Te" de 798,86. El corte queda 0,4 s adentro.
 *
 * O sea que el defecto que quedó por arreglar no está acá: está en que los
 * límites de la búsqueda de onda se apoyan en una duración de palabra en la que
 * este mismo archivo demuestra que no se puede confiar. Hasta que eso se
 * resuelva, el reparto se queda sirviendo el panel.
 *
 * Sin estado y sin audio: acá entra un mapa de voz ya medido, así que esto se
 * prueba solo (`tests/retimeo.test.js`).
 */

/**
 * Un hueco del transcript a partir del cual se corta la tirada.
 *
 * Es el mismo con el que `audio-onset.alignWords` separa tramos, y por la misma
 * razón: por debajo de eso Whisper no está diciendo que hubo un silencio, está
 * pegando un segmento con el siguiente.
 */
const HUECO_SEC = 0.35;

/** El ajuste medido: cuánto tarda una palabra según sus letras. */
const PESO_BASE = 0.092;
const PESO_POR_LETRA = 0.054;

/**
 * Cuánto silencio puede tener una palabra adentro antes de no creerle.
 *
 * Esto es lo que decide qué tiradas se tocan, y es lo único que separa el
 * defecto de lo normal. Whisper es BUENO la mayor parte del tiempo: medido
 * contra el render del corte de la clase 1, el error mediano de sus tiempos es
 * de 0,13 s y el 91% de las palabras caen a menos de medio segundo. Repartir
 * todas las tiradas sobre la onda arreglaba los extremos pero empujaba la
 * mediana a 0,31 s y bajaba del 75% al 49% las que caen dentro de 0,3 s: se
 * arreglaba lo roto rompiendo lo sano.
 *
 * El defecto, en cambio, se reconoce solo: una palabra que dice durar tres
 * segundos y adentro de esos tres segundos el micrófono no registró nada es una
 * palabra a la que Whisper le colgó un silencio. Es lo que pasa en las dos
 * formas del defecto —"3," ocupando 3,33 s de silencio, "aplicación" ocupando
 * 10,63 s— y no pasa nunca en habla normal, donde los huecos entre sílabas son
 * de menos de 100 ms.
 *
 * El valor es el mismo `HUECO_SEC` y por la misma razón: por debajo de eso el
 * hueco no es un silencio, es cómo Whisper pega un segmento con el siguiente.
 */
const MUDO_SEC = 0.35;

/**
 * Cuánto sonido tiene que haber en la ventana de una tirada para creerle.
 *
 * Por debajo de esto la ventana está callada para el micrófono y el mapa no
 * puede decir nada: pasa cuando el que habla está lejos —el director diciendo
 * "Va." desde el fondo de la sala mide igual que el silencio— o cuando Whisper
 * alucinó una frase sobre el aire. Ahí manda el transcript, que es lo único que
 * oyó algo.
 */
const MINIMO_VOZ_SEC = 0.06;

/**
 * Cuántos segundos de SONIDO consume una palabra por unidad de peso.
 *
 * El peso está ajustado contra la duración de reloj, que incluye los huequitos
 * entre sílabas; el mapa de voz no los cuenta, así que hace falta la conversión
 * para saber cuánto sonido necesita un grupo de palabras. Medido sobre las 246
 * tiradas sanas de las trece clases del curso: mediana 0,738, con el 50% central
 * entre 0,67 y 0,85. Es lo que decide dónde arranca un grupo roto.
 */
const SONIDO_POR_PESO = 0.738;

function redondo(n) {
    return Math.round(n * 1000) / 1000;
}

/** Cuánto se tarda en decir una palabra, según sus letras. */
function peso(texto) {
    const letras = String(texto == null ? '' : texto)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .match(/[\p{L}\p{N}]/gu);
    return PESO_BASE + PESO_POR_LETRA * (letras ? letras.length : 1);
}

/** Palabras seguidas sin un hueco declarado en medio, por índices. */
function tiradas(palabras, huecoSec) {
    const salida = [];
    let actual = [];
    for (let i = 0; i < palabras.length; i++) {
        if (actual.length && palabras[i].start - palabras[i - 1].end >= huecoSec) {
            salida.push(actual);
            actual = [];
        }
        actual.push(i);
    }
    if (actual.length) salida.push(actual);
    return salida;
}

/**
 * Los pedazos con sonido que caen dentro de una ventana, recortados a ella.
 *
 * Recortar y no extender es lo que mantiene el resultado ordenado: cada tirada
 * se queda adentro de su propia ventana, así que ninguna palabra puede terminar
 * pisando a la tirada de al lado ni volviendo hacia atrás.
 */
function sonidoEn(tramos, desde, hasta, cursor) {
    const pedazos = [];
    let i = cursor;
    while (i < tramos.length && tramos[i][1] <= desde) i++;
    const primero = i;
    for (; i < tramos.length; i++) {
        if (tramos[i][0] >= hasta) break;
        const a = Math.max(tramos[i][0], desde);
        const b = Math.min(tramos[i][1], hasta);
        if (b > a) pedazos.push([a, b]);
    }
    return { pedazos, cursor: primero };
}

/** Cuánto de un tramo tiene sonido, dados los pedazos de su ventana. */
function sonidoEntre(pedazos, desde, hasta) {
    let suma = 0;
    for (const [a, b] of pedazos) {
        const comun = Math.min(b, hasta) - Math.max(a, desde);
        if (comun > 0) suma += comun;
    }
    return suma;
}

/**
 * ¿Whisper le colgó un silencio a esta palabra?
 *
 * Son las dos caras del mismo defecto: la palabra que no dura nada y la que dura
 * mucho más de lo que suena. En el bloque 8 de la clase 1 ninguna dura cero
 * —"Es una aplicación web" ocupa 18 de los 31 segundos del bloque porque el
 * audio arranca con un "3, 2, 1." que el plan no contempla— así que mirar solo
 * las duraciones cero dejaría sin tocar justo el bloque que el editor describe
 * como "dura la mitad del corte sin decir nada".
 */
function esRota(palabra, pedazos) {
    const dura = palabra.end - palabra.start;
    if (dura <= 0.001) return true;
    return dura - sonidoEntre(pedazos, palabra.start, palabra.end) > MUDO_SEC;
}

/** Cuánto sonido necesitan, juntas, unas cuantas palabras. */
function necesita(palabras, tirada, desde, hasta) {
    let total = 0;
    for (let k = desde; k <= hasta; k++) total += peso(palabras[tirada[k]].text);
    return total * SONIDO_POR_PESO;
}

/**
 * Los pedazos de una tirada que hay que rehacer, por posición dentro de ella.
 *
 * Se rehace lo roto y nada más. Whisper es bueno la mayor parte del tiempo:
 * medido contra el render del corte de la clase 1, el error mediano de sus
 * tiempos es de 0,13 s y el 91% de las palabras caen a menos de medio segundo.
 * Rehacer la tirada entera porque una palabra está mal arreglaba los extremos
 * rompiendo lo sano — la mediana se iba a 0,31 s y las palabras dentro de 0,3 s
 * bajaban del 75% al 49%.
 *
 * Al grupo se le suma la palabra de la derecha SOLO cuando en su propia ventana
 * no hay sonido para lo que dice. Es el caso de la tirada amontonada: cuatro
 * palabras metidas en 0,08 s no tienen dónde repartirse, y los segundos que les
 * faltan se los quedó la quinta. Sumarla siempre sería peor —en una tirada
 * estirada la ventana ya sobra, y el vecino solo correría el final, que es el
 * único dato de Whisper del que hay que fiarse.
 */
function gruposRotos(palabras, tirada, pedazos) {
    const rotas = tirada.map(i => esRota(palabras[i], pedazos));
    const grupos = [];
    let k = 0;
    while (k < tirada.length) {
        if (!rotas[k]) { k++; continue; }
        let j = k;
        while (j + 1 < tirada.length && rotas[j + 1]) j++;

        let hasta = j;
        const propio = sonidoEntre(pedazos, palabras[tirada[k]].start, palabras[tirada[j]].end);
        if (propio < necesita(palabras, tirada, k, j) && j + 1 < tirada.length) hasta = j + 1;

        const previo = grupos[grupos.length - 1];
        // Dos grupos separados por una sola palabra sana se pisan al sumarle el
        // vecino al primero: van juntos, que si no la palabra del medio se
        // repartiría dos veces y la segunda pisaría a la primera.
        if (previo && k <= previo[1]) previo[1] = Math.max(previo[1], hasta);
        else grupos.push([k, hasta]);
        k = j + 1;
    }
    return grupos;
}

/**
 * El instante en el que el sonido acumulado de una ventana llega a `cuanto`.
 *
 * Es la inversa de "cuánto sonido hubo hasta acá", y es todo el truco: pedirle
 * la mitad del sonido de la ventana devuelve el momento en que se dijo la mitad
 * de lo que se dijo, sin importar cuánto silencio haya en el medio.
 */
function cuando(pedazos, cuanto) {
    let resta = cuanto;
    for (const [a, b] of pedazos) {
        const dura = b - a;
        if (resta <= dura) return a + resta;
        resta -= dura;
    }
    const ultimo = pedazos[pedazos.length - 1];
    return ultimo ? ultimo[1] : 0;
}

/**
 * Yendo para atrás desde `fin`, dónde queda `cuanto` de sonido.
 *
 * El grupo roto se ancla en su FINAL y no en su principio, y eso no es una
 * preferencia: es el sesgo del modelo, ya medido en este proyecto. Whisper
 * acierta los finales de palabra —sesgo mediano de 0 frames— y estira los
 * arranques hacia atrás sobre el silencio que los precede. En el bloque 8 se ve
 * puro: "web" termina en 1121,48 y en la onda el sonido termina en 1121,47, un
 * frame; el arranque de "Es", en cambio, figura 17 segundos antes de que se oiga
 * nada. Así que el final se respeta y el principio se va a buscar contando
 * sonido hacia atrás.
 */
function retroceder(pedazos, fin, cuanto) {
    let resta = cuanto;
    for (let i = pedazos.length - 1; i >= 0; i--) {
        const [a, b] = pedazos[i];
        const hasta = Math.min(b, fin);
        if (hasta <= a) continue;
        const dura = hasta - a;
        if (resta <= dura) return hasta - resta;
        resta -= dura;
    }
    return pedazos.length ? pedazos[0][0] : fin;
}

/**
 * Las palabras con los tiempos del sonido.
 *
 * No muta lo que entra: devuelve copias, porque las mismas palabras las lee
 * después el anclaje de los comentarios y el reparto en bloques.
 *
 * @param {Array} palabras [{start, end, text}] en tiempo de la grabación
 * @param {object} voz el mapa de `voz.js` ({tramos: [[desde, hasta], …]})
 * @returns {{palabras: Array, stats: object}}
 */
function retimear(palabras, voz) {
    const entrada = palabras || [];
    const salida = entrada.map(p => ({ ...p }));
    const stats = { tiradas: 0, rotas: 0, movidas: 0, sinSonido: 0, ceroAntes: 0, ceroDespues: 0 };

    for (const p of entrada) if (p.end - p.start <= 0.001) stats.ceroAntes++;

    const tramos = (voz && voz.tramos) || [];
    if (!tramos.length || !salida.length) {
        stats.ceroDespues = stats.ceroAntes;
        return { palabras: salida, stats };
    }

    // Ni la palabra más corta puede quedar sin duración: una que empieza y
    // termina en el mismo instante es una que el panel no alumbra nunca, y eso
    // es la mitad del defecto que se vino a arreglar.
    const minima = (voz && voz.hopSec) || 0.02;

    let cursor = 0;
    for (const tirada of tiradas(entrada, HUECO_SEC)) {
        stats.tiradas++;
        const desde = entrada[tirada[0]].start;
        const hasta = entrada[tirada[tirada.length - 1]].end;
        if (!(hasta > desde)) continue;

        const hallado = sonidoEn(tramos, desde, hasta, cursor);
        cursor = hallado.cursor;
        const pedazos = hallado.pedazos;

        for (const [a, b] of gruposRotos(entrada, tirada, pedazos)) {
            stats.rotas++;
            const primera = entrada[tirada[a]];
            const ultima = entrada[tirada[b]];

            const pesos = [];
            for (let k = a; k <= b; k++) pesos.push(peso(entrada[tirada[k]].text));
            const total = pesos.reduce((x, y) => x + y, 0);

            // El final es de Whisper; el principio se busca contando hacia atrás
            // el sonido que estas palabras necesitan. Nunca antes de donde ya
            // estaban: el defecto es que arrancan demasiado temprano, así que
            // moverlas más atrás todavía sería empeorarlo.
            const fin = ultima.end;
            const inicio = Math.max(primera.start,
                Math.min(retroceder(pedazos, fin, total * SONIDO_POR_PESO), fin));

            let propios = pedazos
                .map(([x, y]) => [Math.max(x, inicio), Math.min(y, fin)])
                .filter(([x, y]) => y > x);
            let conSonido = propios.reduce((n, [x, y]) => n + (y - x), 0);

            if (conSonido < MINIMO_VOZ_SEC) {
                stats.sinSonido++;
                // El micrófono no registró nada donde Whisper oyó algo: pasa con
                // el director hablando desde el fondo de la sala, que mide igual
                // que el silencio. No hay a dónde mover estas palabras y no se
                // las mueve. Pero si vienen amontonadas en un instante hay que
                // separarlas igual: amontonadas no se alumbran nunca, y una
                // palabra que no se alumbra nunca es texto que el editor no
                // puede seguir. Se reparten sobre su propia ventana, que es lo
                // único que se sabe de ellas.
                let amontonadas = false;
                for (let k = a; k <= b; k++) {
                    const p = entrada[tirada[k]];
                    if (p.end - p.start <= 0.001) { amontonadas = true; break; }
                }
                if (!amontonadas || !(fin > primera.start)) continue;
                propios = [[primera.start, fin]];
                conSonido = fin - primera.start;
            }

            let acumulado = 0;
            for (let k = a; k <= b; k++) {
                const arranca = cuando(propios, (acumulado / total) * conSonido);
                acumulado += pesos[k - a];
                const termina = cuando(propios, (acumulado / total) * conSonido);
                const palabra = salida[tirada[k]];
                palabra.start = redondo(arranca);
                palabra.end = redondo(Math.max(termina, arranca + minima));
            }
            stats.movidas++;
        }
    }

    for (const p of salida) if (p.end - p.start <= 0.001) stats.ceroDespues++;
    return { palabras: salida, stats };
}

module.exports = {
    retimear, peso, tiradas, sonidoEn, sonidoEntre, cuando, retroceder, gruposRotos,
    HUECO_SEC, MUDO_SEC, PESO_BASE, PESO_POR_LETRA, MINIMO_VOZ_SEC, SONIDO_POR_PESO
};
