'use strict';
/**
 * notas-vivo.js — Las notas de rodaje, mientras la clase se está grabando.
 *
 * Hoy el director de contenido abre y cierra cada toma a mano en otra
 * herramienta, y de ahí sale el XML de marcadores que el resto de Class Cut lee
 * (`rodecaster-xml.js`). Acá se hace lo mismo escuchando: el profesor dice
 * "3, 2, 1" y la toma se abre, dice "Pausa" y se cierra.
 *
 * **Todo va con la HORA DEL DÍA en milisegundos.** Es lo que permite parar de
 * escuchar y seguir sin que nada se corra: el reloj de pared siguió andando y el
 * Rodecaster siguió grabando, así que la distancia entre dos palabras es la que
 * van a tener en la grabación. Pasarlo a los cuadros que entiende Premiere es
 * trabajo de `notas-xml.js`, que es lo único que conoce el formato.
 *
 * **La latencia no perjudica la precisión**, y es lo que hace que todo esto
 * funcione. Cuando el profesor dice "Pausa", el OUT no se pone donde la
 * herramienta se dio cuenta: se pone en el timecode de esa palabra, que Whisper
 * devuelve junto con el texto. Un segundo de demora en enterarse no mueve el
 * corte ni un cuadro.
 *
 * **Sin estado y sin DOM**: todo lo de acá se prueba solo (`tests/notas-vivo.test.js`).
 * Los números que deciden —cuántos segundos de silencio confirman un "Pausa",
 * cuánto tienen que parecerse dos arranques— salen de medir las trece clases del
 * curso con `tools/simular-grabacion.js`, no de estimarlos.
 */

const { norm } = require('./texto');

/**
 * Las dos fuentes que graba el Rodecaster, en el orden en que las numera.
 *
 * Son índices y no nombres porque es lo que el resto de la cadena maneja: el
 * plan de cortes elige la cámara por número (`cameraIndex`), el XML le pone a
 * cada fuente la etiqueta de color que le toca por posición (`CLIP_LABELS` en
 * `fcp-xml.js`) y el reproductor monta un `<video>` por índice. El orden es
 * estable clase a clase porque el aparato numera siempre igual.
 */
const CAMARA = 0;
const PANTALLA = 1;

/**
 * Los colores con los que la app dice de qué fuente es algo.
 *
 * Son los de `.cam-0` y `.cam-1` en `src/css/visor.css`, que a su vez son las dos
 * primeras etiquetas de clip del XML (`CLIP_LABELS` en `fcp-xml.js`): la cámara
 * llega a Premiere en Cerulean y el grabador de pantalla en Rose. La tira del
 * reproductor, los bloques del guion y ahora las tomas de esta pantalla usan los
 * mismos dos, porque son la misma pregunta en tres sitios.
 *
 * Escritos acá además de en la hoja de estilo porque el CSS no se puede leer
 * desde el motor y esta lista es la que la pantalla consulta;
 * `tests/colores.test.js` falla si los dos lados se separan.
 */
const CERULEO = '#3f7fb5';
const ROSA = '#b1567c';

/**
 * Las vistas que se pueden elegir: con qué se ve cada una y de qué color va.
 *
 * **Cada vista tiene DOS colores y son dos cosas distintas a propósito.** Si esto
 * parece un error y da ganas de dejar uno solo, es lo que hay que leer antes:
 *
 * - `colorDeMarcador` es el entero nativo de Premiere (`pproColor`) y es lo que
 *   se escribe en el XML. Sale de un XML de verdad del director de contenido, no
 *   de elegirlo: si acá se escribiera otro, el mismo tipo de toma llegaría a la
 *   secuencia de un color distinto según quién tomó las notas. Quien lo escribe
 *   es `notas-xml.js`.
 *
 * - `colorEnLaApp` es de qué color se ve la toma EN LA PANTALLA DE GRABAR. No es
 *   una traducción del de arriba: son dos preguntas diferentes. El marcador
 *   contesta "de qué color va a aparecer esto en Premiere"; la lista de tomas
 *   contesta **qué vista eligió el director en esta toma**, que son cinco cosas
 *   y no dos.
 *
 *   Con qué se ve cada vista es otra pregunta y tiene su propio campo acá al
 *   lado (`fuente`). No se pueden mezclar: `R`, `S`, `MG` y `X2` se resuelven
 *   todas con el grabador de pantalla —así se previsualizan— y aun así se pintan
 *   distinto, porque quien está grabando necesita reconocer de un golpe de vista
 *   cuál de las cinco puso en cada toma, que es lo que después va a tener que
 *   revisar y lo que decide el color del marcador. De qué entrada salió la
 *   imagen ya lo está viendo en el monitor.
 *
 * `PV` y `R` llevan además los colores de las dos fuentes —cerúleo y rosa— y eso
 * también es a propósito: son las dos primeras etiquetas de clip del XML
 * (`CLIP_LABELS` en `fcp-xml.js`) y los dos `.cam-N` de `src/css/visor.css`, así
 * que en la tira del reproductor y en los bloques del guion esos dos colores ya
 * están diciendo eso, y quien graba mirando esta lista es el mismo que después
 * abre el reproductor. `R` es donde los dos campos chocan de frente: su marcador
 * es naranja y así se queda, porque es el que el CD viene usando, pero en la app
 * va rosa.
 *
 * Las otras tres coinciden con su marcador, y también por elección: no tienen un
 * color propio en el reproductor con el que pelear, así que el de Premiere es el
 * que más dice.
 *
 * Antes eran un solo campo, y no se notaba porque todas coincidían por
 * casualidad. El único sitio que los mezclaba era la hoja de estilo, que sacaba
 * su hexadecimal del entero del marcador; ahora saca cada uno de su campo y
 * `tests/colores.test.js` fija cuáles coinciden a propósito y cuáles no.
 *
 * **La `fuente` vive acá y en ningún otro lado.** Antes estaba escrita dos veces
 * y en desacuerdo: `cutplan.js` solo conocía `PV` y `R` —así que una toma en
 * `MG` caía en la primera cámara con un aviso de "vista desconocida"— y la
 * maqueta tenía su propia tabla donde sí sabía a dónde iban las otras cuatro. O
 * sea que el diseño se miraba con un mapeo que la app no tenía.
 */
const VISTAS = [
    { nombre: 'PV', titulo: 'Profesor', fuente: CAMARA, colorDeMarcador: 4281740498, colorEnLaApp: CERULEO },
    { nombre: 'R', titulo: 'Pantalla', fuente: PANTALLA, colorDeMarcador: 4280578025, colorEnLaApp: ROSA },
    { nombre: 'S', titulo: 'Slides', fuente: PANTALLA, colorDeMarcador: 4281828977, colorEnLaApp: '#718637' },
    { nombre: 'MG', titulo: 'Multi', fuente: PANTALLA, colorDeMarcador: 4292277273, colorEnLaApp: '#19f4d6' },
    { nombre: 'X2', titulo: 'Doble', fuente: PANTALLA, colorDeMarcador: 4289825711, colorEnLaApp: '#af8bb1' }
];

const VISTA_POR_DEFECTO = 'PV';

/** Nombre de vista → con qué fuente se ve. Es el `viewMap` de todo el pipeline. */
const MAPA_DE_VISTAS = Object.fromEntries(VISTAS.map(v => [v.nombre, v.fuente]));

/**
 * Nombres de vista que ya no se ofrecen pero que hay que seguir entendiendo.
 *
 * `SL` y `SR` eran las slides encuadradas a izquierda y a derecha, y llegaban a
 * la secuencia del mismo verde porque son la misma fuente: la distinción era de
 * encuadre y no de material, así que en el corte no cambiaba nada. Ahora son una
 * sola, `S`.
 *
 * Dejar de ofrecerlas no es lo mismo que dejar de entenderlas, y hay dos sitios
 * donde siguen llegando: las clases que ya se grabaron las tienen escritas en su
 * sidecar y en su XML, y el XML que entra de afuera trae el nombre que el
 * director de contenido le puso al marcador, que puede ser cualquiera de los que
 * la herramienta ofrecía el día que tomó esas notas. Si no se tradujeran, esas
 * tomas quedarían con una vista que no existe: el selector no marcaría ninguna,
 * el color caería al de `PV` y el mapeo las mandaría a la cámara equivocada.
 */
const VISTAS_RENOMBRADAS = { SL: 'S', SR: 'S' };

/**
 * El nombre de hoy de una vista que se acaba de leer de un archivo.
 *
 * Se traduce al LEER y no se reescribe el disco al pasar: un camino de lectura
 * que escribe es lo que vuelve irreproducible el próximo error, y además una
 * clase se lista sin que nadie la haya pedido. Igual el archivo se cura solo, y
 * en el primer gesto: cada cambio sobre una clase grabada reescribe el sidecar y
 * el XML enteros desde el estado ya traducido (`editarGrabada` en
 * `grabacion.js`), así que la primera vez que alguien la toca queda con `S`.
 */
function vistaLeida(nombre) {
    const n = limpio(nombre);
    return VISTAS_RENOMBRADAS[n] || n;
}

/**
 * Un estado recién iniciado: la forma entera, declarada una vez.
 *
 * Todo lo que la sesión y `aplicarSenales` van a escribir está acá desde el
 * principio, con su valor vacío. Antes `ultimaSenal` y `ultimaPalabraMs`
 * aparecían en el primer uso, y quien leía cómo arranca una sesión no podía
 * saber la forma completa sin leer también este archivo.
 *
 * @param {object} params { secuencia, clase, parte, curso, ceroMs, dispositivo }
 */
function estadoNuevo(params) {
    const p = params || {};
    return {
        secuencia: p.secuencia || null,
        clase: p.clase || null,
        // Cuál de las tandas de esa clase es esta: 1 salvo que la clase se haya
        // grabado en varias (ver `parteQueSigue` en `grabacion.js`).
        parte: p.parte || 1,
        curso: p.curso || null,
        // El momento de "Iniciar grabación", del que cuelgan los cuadros del XML.
        ceroMs: p.ceroMs != null ? p.ceroMs : null,
        dispositivo: p.dispositivo || null,
        claqueta: null,
        // Los temas que el CD pidió que esta clase cubra y la última medición de
        // su cobertura, con la forma de `engine/temario.js`. Viene por parámetro
        // porque una clase nueva hereda la lista de la anterior del mismo curso:
        // el CD entrega una sola para el día (ver `heredarTemario` en `grabacion.js`).
        temario: p.temario || null,
        // Los archivos de audio que la sesión fue cerrando.
        sesiones: [],
        tomas: [],
        proximaToma: 0,
        // Hasta dónde se oyó y cuándo sonó la última señal de cada tipo: lo que
        // deja pasar la ventana entera del ciclo, con su solape, sin repetir nada.
        ultimaPalabraMs: 0,
        ultimaSenal: {}
    };
}

/**
 * Las palabras con las que el profesor abre y cierra.
 *
 * El conteo no se busca con la expresión de `rodecaster-xml.COUNT_RUN` porque esa
 * está anclada al principio de un comentario ya escrito; acá hay que encontrarlo
 * en el medio de un río de palabras. Tampoco con `speech-edges.conteosEn`, que
 * también busca conteos sueltos, porque en vivo hacen falta dos cosas que en post
 * no: que la cuenta TERMINE en uno (ver `senales`) y tolerar los puntos
 * suspensivos con que Whisper cierra un "1...". Lo que se busca es lo mismo: dos
 * o más números seguidos hacia abajo, que es lo que nadie dice por casualidad.
 *
 * La puntuación de atrás no cuenta, y va con `*` y no con `?` porque Whisper
 * escribe puntos suspensivos: en el curso salió "3, 2, 1..." y con un solo signo
 * permitido el "1..." no era un número, el conteo se quedaba en "3, 2" y la toma
 * no se abría. Lo encontró la simulación sobre el audio de verdad.
 */
const CUENTA = /^(?:3|2|1|tres|dos|uno)[.,…!?]*$/i;
const RETOMAR = /^retomamos[.,…!?]*$/i;
const PAUSA = /^pausa[.,…!?]*$/i;
/** "Ok" delante del conteo es parte de la señal, no de la clase. */
const OK = /^ok[.,…!?]*$/i;

/** Cuántos números seguidos hacen una cuenta. Uno solo es habla. */
const MINIMO_DE_CUENTA = 2;

/** Cuánto vale cada palabra de la cuenta, para saber si va hacia abajo. */
const VALOR = { 3: 3, tres: 3, 2: 2, dos: 2, 1: 1, uno: 1 };

function valorDeCuenta(texto) {
    const limpia = String(texto).toLowerCase().replace(/[.,…!?]+$/, '');
    return VALOR[limpia];
}

/**
 * Dos señales del mismo tipo más cerca que esto son la misma señal oída dos veces.
 *
 * El ciclo de señales escucha ventanas que se solapan, así que un conteo que caiga
 * en el borde aparece en dos pasadas seguidas — eso es a propósito, es lo que
 * evita perderlo partido. Lo que hace falta es no abrir dos tomas con él, y no se
 * puede comparar el tiempo exacto porque Whisper no devuelve el mismo número en
 * las dos pasadas (unas décimas de diferencia). Dos segundos separan de sobra dos
 * conteos de verdad: entre uno y el siguiente hay una toma entera.
 */
const MISMA_SENAL_MS = 2000;

/**
 * Cuánto silencio tiene que seguir a "Pausa" para creerle.
 *
 * El profesor puede decir "pausa" hablando de otra cosa —"acá hacemos una pausa
 * en el flujo"— y cerrar la toma ahí partiría la clase al medio. Lo que
 * distingue la señal es que después no se dice nada: el profesor para. Un segundo
 * alcanza y no obliga a esperar.
 */
const SILENCIO_TRAS_PAUSA_SEC = 1;

function limpio(texto) {
    return String(texto == null ? '' : texto).trim();
}

/** El texto de una palabra, sin signos, para comparar contra las señales. */
function palabra(w) {
    return limpio(w && w.texto).replace(/^[¿¡"'(]+/, '');
}

/**
 * Las señales que hay en una tirada de palabras, en orden.
 *
 * Devuelve rangos de índices y no tiempos porque quien decide qué hacer con una
 * señal necesita saber qué palabras la forman: el IN va DESPUÉS de la última
 * palabra del conteo y el OUT ANTES de "Pausa", así que la señal misma nunca
 * queda adentro de la toma. Es lo mismo que el motor hace en post
 * (`speech-edges.trimChatter`), y por las mismas razones.
 *
 * @param {Array} palabras [{t, texto}] con `t` en hora del día (ms)
 * @returns {Array} [{tipo:'abre'|'cierra', desde:number, hasta:number}]
 */
function senales(palabras) {
    const lista = palabras || [];
    const salida = [];

    for (let i = 0; i < lista.length; i++) {
        const p = palabra(lista[i]);

        if (RETOMAR.test(p)) {
            salida.push({ tipo: 'abre', desde: i, hasta: i, por: 'retomamos' });
            continue;
        }

        if (PAUSA.test(p)) {
            // Sin lo que sigue no se puede saber si es la señal o una palabra de
            // la clase: se pide silencio detrás. La última palabra de la tirada
            // se resuelve con el silencio que venga después, así que quien llama
            // decide (ver `cierraDeVerdad`).
            const siguiente = lista[i + 1];
            const hueco = siguiente ? (siguiente.t - lista[i].t) / 1000 : Infinity;
            if (hueco >= SILENCIO_TRAS_PAUSA_SEC) {
                salida.push({ tipo: 'cierra', desde: i, hasta: i, por: 'pausa' });
            }
            continue;
        }

        // El conteo: se mira si desde acá arranca una tirada de números.
        let j = i;
        if (OK.test(p) && lista[i + 1] && CUENTA.test(palabra(lista[i + 1]))) j = i + 1;
        // La tirada de números, cortada en el PRIMER uno: ahí termina la cuenta.
        // Sin ese corte, una clase que arranca diciendo "uno de los problemas…"
        // se comía su propia primera palabra, porque "uno" también es número.
        let fin = j;
        while (fin < lista.length && CUENTA.test(palabra(lista[fin]))) {
            fin++;
            if (valorDeCuenta(palabra(lista[fin - 1])) === 1) break;
        }

        // Y tiene que terminar en uno, no solo tener dos números: "tenemos uno,
        // dos, tres opciones" es habla, y con la regla de "dos seguidos" abría una
        // toma en medio de la clase. Se pide el final y no que baje monótona
        // porque el falso arranque existe: en el curso real está escrito "3 2 3 2 1.".
        const cierraEnUno = fin > j && valorDeCuenta(palabra(lista[fin - 1])) === 1;
        if (fin - j >= MINIMO_DE_CUENTA && cierraEnUno) {
            salida.push({ tipo: 'abre', desde: i, hasta: fin - 1, por: 'cuenta' });
            i = fin - 1;
        }
    }

    return salida;
}

/**
 * El texto de una señal, tal como va al comentario del marcador.
 *
 * El parser de post busca el conteo justo detrás del separador para saber dónde
 * termina la nota del editor y empieza lo que se dijo, así que el conteo tiene
 * que llegar escrito. Con "Retomamos" no hay conteo y el parser cae en su
 * convención vieja, que también funciona.
 */
function textoDe(palabras, desde, hasta) {
    return (palabras || []).slice(desde, hasta + 1).map(w => limpio(w.texto)).join(' ').trim();
}

/** Cuántas palabras del arranque se citan en el comentario del IN. */
const PALABRAS_DEL_CUE = 8;

/**
 * El cue de una toma: el conteo y las primeras palabras de lo que se dijo.
 *
 * El conteo se escribe con un punto y nada más al final. Viene como lo escribió
 * Whisper, que a veces pone puntos suspensivos ("3, 2, 1..."), y el parser de post
 * come el conteo pero no los signos de sobra: el cue quedaba empezando en ".. Uno,
 * un PROM sirve…". Ese cue es lo que `align.js` busca en el Live-Mix para reanclar
 * el borde, así que conviene que sean palabras y no basura.
 */
function cueDeEntrada(toma) {
    const cuenta = limpio(toma.cuenta).replace(/[.,…!?]+$/, '.');
    const primeras = textoDe(toma.palabras, 0, PALABRAS_DEL_CUE - 1);
    return [cuenta, primeras].filter(Boolean).join(' ').trim();
}

/**
 * El comentario del marcador de entrada: la nota, el separador y lo que se dijo.
 *
 * **El separador va con sus dos espacios y el resultado NO se recorta.** Parece
 * detalle y no lo es: el parser de post busca literalmente " - " para saber dónde
 * termina la nota del director y empieza el habla, y una toma sin nota deja el
 * comentario empezando en " - 3, 2, 1…". Recortarlo lo dejaba en "- 3, 2, 1…",
 * sin separador que encontrar, y de ahí en adelante el conteo pasaba a ser parte
 * del cue: `hasCount` en falso y el motor de cortes sin saber dónde arranca la
 * clase. Salió en la simulación —las once tomas de una clase entera con
 * `conteo:false`— porque las pruebas de antes usaban una toma CON nota, que es el
 * caso raro. La herramienta del director escribe " - " igual, con su espacio.
 */
function comentarioDeEntrada(toma) {
    return `${limpio(toma.comentario)} - ${cueDeEntrada(toma)}`;
}

/** El cue de salida: las últimas palabras dichas, que es lo que el CD escribe. */
function cueDeSalida(toma) {
    const palabras = toma.palabras || [];
    const desde = Math.max(0, palabras.length - PALABRAS_DEL_CUE);
    return textoDe(palabras, desde, palabras.length - 1);
}

/**
 * Las tomas que van al XML: las que se quedaron y tienen los dos bordes.
 *
 * Una toma descartada no se escribe, que es el sentido de descartarla. Una sin
 * cerrar tampoco: el parser la aceptaría y avisaría `bloque_sin_out`, pero acá
 * todavía se puede cerrar a mano, así que es mejor no escribirla que escribir un
 * bloque que el editor va a tener que arreglar en post.
 */
function tomasQueQuedan(estado) {
    return (estado.tomas || []).filter(t => !t.descartada && t.inMs != null && t.outMs != null);
}

function tomaAbierta(estado) {
    return (estado.tomas || []).find(t => t.outMs == null) || null;
}

/**
 * Dónde termina una toma que se cierra ahora: el FINAL de su última palabra.
 *
 * Es una función porque son cuatro los sitios que cierran —"Pausa", el botón,
 * la toma siguiente que llega sin "Pausa", y "Terminar"— y cuando cada uno hacía
 * la cuenta a su manera, uno usaba el arranque de la palabra: la toma que el
 * profesor olvidó cerrar perdía su última palabra en el XML. Si no dijo ninguna,
 * termina donde diga quien llama.
 */
function finDeToma(toma, siNoDijoNada) {
    const palabras = toma.palabras || [];
    const ultima = palabras[palabras.length - 1];
    return ultima ? (ultima.hasta || ultima.t) : siNoDijoNada;
}

/**
 * Cuál claqueta queda, entre la que hay y una recién leída.
 *
 * Una confirmada no se mueve. Una confirmada le gana a una que no lo está, venga
 * antes o después. Entre dos sin confirmar, la primera: en una clase se aplaude
 * una vez y al principio, así que ante la duda el primer golpe es el bueno. Lo
 * encontró la simulación: con la regla contraria ("reemplazá mientras no haya
 * una confirmada") cada portazo corría la claqueta más adelante, y en la clase 2
 * el aplauso de los 11 s había quedado a las 3:27 para el minuto tres.
 *
 * @param {object|null} actual la que está en el estado
 * @param {object|null} leida la que se acaba de leer, con `confirmada`
 * @returns {object|null} la que va al estado (puede ser la misma `actual`)
 */
function elegirClaqueta(actual, leida) {
    if (!leida) return actual || null;
    if (!actual) return leida;
    if (actual.confirmada) return actual;
    if (leida.confirmada) return leida;
    return actual;
}

/**
 * Mete palabras nuevas y abre o cierra tomas según lo que se dijo.
 *
 * Las palabras llegan del ciclo de señales, que es rápido y de calidad mediana:
 * lo único que se le cree es que una señal SONÓ y a qué hora. El texto de la
 * toma no se arma con esto — se rehace entero al cerrar, con el modelo grande
 * (`oir.escuchar`) — así que acá las palabras se guardan para poder mostrar algo
 * mientras se habla y se reemplazan después.
 *
 * **Se le pasa la ventana ENTERA, con lo que ya se había oído.** Antes quien
 * llamaba recortaba las palabras viejas antes de entrar, y eso deshacía el solape
 * justo cuando servía: un conteo a caballo entre dos pasadas llegaba completo en
 * la segunda, el recorte le sacaba el "3" y el "2" por viejos, quedaba "uno"
 * suelto y la toma no se abría. En el audio del curso eso perdió dos tomas del
 * primer minuto. Ahora los duplicados se descartan acá, donde se sabe qué es una
 * palabra repetida y qué es una señal repetida.
 *
 * @param {object} estado el de la sesión (de `estadoNuevo`), se muta
 * @param {Array} palabras [{t, texto}] la ventana entera, en orden
 * @returns {Array} qué pasó, para poder contarlo en la pantalla y en el registro
 */
function aplicarSenales(estado, palabras) {
    const nuevas = (palabras || []).filter(w => w && w.t != null);
    if (!nuevas.length) return [];

    const yaVista = marca => {
        const previa = estado.ultimaSenal[marca.tipo];
        return previa != null && Math.abs(nuevas[marca.hasta].t - previa) < MISMA_SENAL_MS;
    };

    const marcas = senales(nuevas).filter(m => !yaVista(m));
    const desdePalabra = estado.ultimaPalabraMs;
    const eventos = [];
    let cursor = 0;

    const guardar = (hasta) => {
        const toma = tomaAbierta(estado);
        if (!toma) { cursor = hasta; return; }
        for (let i = cursor; i < hasta; i++) {
            if (nuevas[i].t > desdePalabra) toma.palabras.push(nuevas[i]);
        }
        cursor = hasta;
    };

    for (const marca of marcas) {
        estado.ultimaSenal[marca.tipo] = nuevas[marca.hasta].t;
        guardar(marca.desde);

        if (marca.tipo === 'abre') {
            const previa = tomaAbierta(estado);
            if (previa) {
                // Nadie la cerró. Se cierra en su última palabra y queda dicho:
                // es lo mismo que hace el parser en post con `bloque_sin_out`,
                // pero acá todavía se puede arreglar antes de escribir el XML.
                previa.outMs = finDeToma(previa, nuevas[marca.desde].t);
                previa.cerradaSola = true;
                eventos.push({ tipo: 'cerrada-sola', toma: previa.id });
            }
            const toma = {
                id: (estado.proximaToma = estado.proximaToma + 1),
                vista: VISTA_POR_DEFECTO,
                comentario: '',
                cuenta: textoDe(nuevas, marca.desde, marca.hasta),
                // El IN cae en la palabra que sigue a la señal, no en la señal:
                // el conteo no es clase. Si la señal fue lo último que llegó,
                // queda en su final y la primera palabra que venga lo corrige.
                inMs: nuevas[marca.hasta + 1] ? nuevas[marca.hasta + 1].t : nuevas[marca.hasta].t,
                outMs: null,
                descartada: false,
                cerradaSola: false,
                palabras: [],
                comentarios: []
            };
            estado.tomas.push(toma);
            eventos.push({ tipo: 'abierta', toma: toma.id, por: marca.por });
            cursor = marca.hasta + 1;
            continue;
        }

        // Cierra. El OUT va ANTES de "Pausa": la señal tampoco es clase.
        const toma = tomaAbierta(estado);
        if (toma) {
            toma.outMs = finDeToma(toma, nuevas[marca.desde].t);
            eventos.push({ tipo: 'cerrada', toma: toma.id });
        }
        cursor = marca.hasta + 1;
    }

    guardar(nuevas.length);
    // Hasta acá se oyó, haya o no toma abierta: una palabra que se dijo entre dos
    // tomas no es de nadie, pero tampoco puede volver a aparecer en la siguiente
    // ventana como si fuera nueva.
    estado.ultimaPalabraMs = Math.max(desdePalabra, nuevas[nuevas.length - 1].t);
    return eventos;
}

/** Cuántas palabras del arranque se comparan para ver si una toma repite otra. */
const PALABRAS_DEL_ARRANQUE = 8;

/**
 * Cuánto tienen que compartir dos arranques para decir que uno repite al otro.
 *
 * **No se comparan iguales, se comparan parecidos**, y eso lo decidió el material
 * real. Los tres intentos del mismo arranque en la clase 2 salieron así:
 *
 *   "1. Quiero que hagas un ejercicio mental. Piensa en el…"
 *   "que hagas un ejercicio piensa en el prom que utilizaste…"
 *   "Uno, quiero que hagas un ejercicio. Piensa en el PROM que…"
 *
 * Son el mismo arranque y ninguno empieza igual que otro: el conteo le deja
 * pegado un "1." o un "Uno," al primero, y a veces se come la primera palabra.
 * Comparando prefijos exactos no se reconocía ninguno.
 *
 * Con seis de ocho palabras compartidas los tres se reconocen entre sí, y el
 * arranque de otro tema del mismo profesor ("Peor aún, qué sucede si algún
 * desarrollador…") comparte una sola.
 */
const PARECIDO_MINIMO = 0.6;

/**
 * Qué tomas repiten el arranque de otra anterior.
 *
 * No descarta nada — descartar es del editor y es explícito, porque a veces se
 * retoma para AGREGAR y no para repetir. Esto solo lo deja dicho.
 *
 * Hace falta por lo que se ve en el material real: en la clase 2 del curso el
 * profesor empezó "Quiero que hagas un ejercicio…" SIETE veces seguidas, y el
 * director de contenido se quedó con una. Sin esta marca, decidir eso obliga a
 * leer once transcripciones parecidas para descubrir que diez dicen lo mismo; con
 * ella es mirar una línea.
 *
 * Se comparan las primeras palabras y no todo el texto porque un ensayo se corta
 * a la mitad: lo que dos intentos del mismo arranque tienen en común es
 * justamente el arranque.
 *
 * Devuelve el resultado en vez de escribirlo sobre las tomas: se recalcula cada
 * vez que se mira el estado, porque el texto de una toma cambia cuando se la
 * relee o se le mueve un borde, y un camino de lectura que escribe es lo que
 * vuelve irreproducible el próximo error.
 *
 * @returns {Map<number, number>} id de la toma → id de la que repite
 */
function repeticiones(tomas) {
    const repite = new Map();
    const vistos = [];

    for (const toma of tomas || []) {
        const arranque = new Set((toma.palabras || [])
            .slice(0, PALABRAS_DEL_ARRANQUE)
            .map(w => norm(w.texto))
            .filter(Boolean));

        // Con dos o tres palabras cualquier cosa se parece a cualquier cosa, y
        // decir "repite" donde no se sabe es peor que no decir nada.
        if (arranque.size < 5) continue;

        // Al primero que se le parezca, no al último: si el tercer intento
        // apuntara al segundo, habría que seguir el hilo para llegar al original.
        const previo = vistos.find(v => parecido(arranque, v.arranque) >= PARECIDO_MINIMO);
        if (previo) repite.set(toma.id, previo.id);
        else vistos.push({ id: toma.id, arranque });
    }
    return repite;
}

/** Qué parte de las palabras de un arranque están también en el otro. */
function parecido(a, b) {
    let juntas = 0;
    for (const palabra of a) if (b.has(palabra)) juntas++;
    return juntas / Math.max(a.size, b.size);
}

/**
 * Una lectura con orillas, repartida por los bordes de la toma.
 *
 * Lo que se lee al cerrar una toma es un poco más ancho que la toma: unos segundos
 * de cada lado, para que el editor pueda mover un borde viendo la frase que quedó
 * afuera (ver `ORILLA_MS` en `grabacion.js`). Acá se decide qué es de la toma y qué
 * es orilla, que es la misma frontera que mueve `moverBorde` y por eso vive al lado.
 *
 * El OUT es exclusivo, como en todo lo demás: una palabra que empieza justo en el
 * OUT ya no es de la toma. Lo que queda en `palabras` es exactamente lo que había
 * antes de que existieran las orillas —lo que va al XML y lo que se compara para
 * ver si una toma repite a otra—, así que nada de lo que se escribe cambia.
 */
function repartir(palabras, toma) {
    const lista = palabras || [];
    return {
        antes: lista.filter(w => w.t < toma.inMs),
        palabras: lista.filter(w => w.t >= toma.inMs && w.t < toma.outMs),
        despues: lista.filter(w => w.t >= toma.outMs)
    };
}

/**
 * Mueve un borde a la hora de una palabra.
 *
 * Son las dos líneas del texto —la azul del IN y la roja del OUT— arrastradas
 * hasta el hueco entre dos palabras, y el clic derecho ("cortar el OUT acá") para
 * los saltos largos. Hace falta porque se retoma muchas veces con lo último que se
 * dijo, así que el final bueno es una palabra concreta y no el momento en que
 * alguien dijo "Pausa".
 *
 * @returns {boolean} si se pudo mover
 */
function moverBorde(toma, cual, paredMs) {
    if (!toma || paredMs == null) return false;
    if (cual === 'in') {
        if (toma.outMs != null && paredMs >= toma.outMs) return false;
        toma.inMs = paredMs;
        return true;
    }
    if (toma.inMs != null && paredMs <= toma.inMs) return false;
    toma.outMs = paredMs;
    return true;
}

/* ─── Los cambios que se resuelven con lo que ya está escrito ────────────
 *
 * Acá y no en `grabacion.js` porque estos cambios se hacen sobre la clase que se
 * está grabando y también sobre una que ya terminó, y las dos tienen que
 * escribir exactamente lo mismo: si divergieran, el mismo gesto daría un XML
 * distinto según cuándo se hizo.
 */

/** @param {object} c { desdeMs, hastaMs, texto, comentario } */
function comentar(toma, c) {
    toma.comentarios = (toma.comentarios || []).concat([{
        desdeMs: Number(c.desdeMs),
        hastaMs: Number(c.hastaMs),
        texto: String(c.texto || ''),
        comentario: String(c.comentario || '')
    }]);
}

function descomentar(toma, indice) {
    toma.comentarios = (toma.comentarios || []).filter((_x, i) => i !== indice);
}

/**
 * Un borde corrido sin volver a oír: se reparten otra vez las palabras que hay.
 *
 * **Mover un borde no necesita el audio, y esa es la razón de que las orillas
 * existan.** Al cerrar una toma se lee un tramo MÁS ANCHO que ella y lo que
 * sobra de cada lado se guarda al lado del XML (`repartir` acá, `sidecar` en
 * `notas-xml.js`). O sea que el texto de un rango más ancho que la toma ya está
 * en el disco: correr el borde dentro de ese rango es unir las tres listas,
 * mover la frontera y volver a repartir. Sale al instante y da exactamente lo
 * mismo que daría releer, porque son las mismas palabras.
 *
 * Fuera de ese rango no hay texto que respalde el borde. Escribirlo igual sería
 * peor que no dejarlo: el transcript y el cue de salida seguirían diciendo lo de
 * antes mientras el marcador dice otra cosa, y ese cue es lo que `align.js` busca
 * en el Live-Mix para reanclar el bloque. Así que se planta, y el camino para ir
 * más lejos es "Regenerar": relee cada toma con orillas nuevas alrededor de los
 * bordes de ahora, y el borde vuelve a tener doce segundos por delante.
 *
 * Un borde que cruza al otro no es un error de quien llama sino un arrastre que
 * se pasó, así que no explota: no se mueve y la línea vuelve a su sitio sola al
 * repintar, igual que en la clase en curso.
 */
function moverBordeGuardado(toma, cual, paredMs) {
    const guardadas = (toma.antes || []).concat(toma.palabras || [], toma.despues || []);
    const ultima = guardadas[guardadas.length - 1];
    if (!guardadas.length || !Number.isFinite(paredMs) ||
        paredMs < guardadas[0].t || paredMs > ultima.t) {
        throw new Error('Ese borde cae fuera del texto que quedó guardado. ' +
            'Corrilo hasta donde llega el gris y usá "Regenerar": relee la toma ' +
            'del audio y deja otros segundos de contexto para seguir.');
    }
    if (!moverBorde(toma, cual, paredMs)) return;
    Object.assign(toma, repartir(guardadas, toma));
}

/**
 * Aplica un cambio que se resuelve con lo que ya está escrito, sin volver a oír.
 *
 * **Esta función es la línea que separa lo que se puede hacer sobre una clase ya
 * terminada de lo que no**, y por eso es una sola: si hubiera dos listas de tipos
 * en dos archivos, el mismo gesto daría un XML distinto según cuándo se hizo.
 *
 * Antes contestaba un booleano y quien llamaba inventaba el mensaje, porque el
 * motivo era siempre el mismo: "eso necesita el audio". Dejó de serlo. Mover un
 * borde entró —las orillas están guardadas, así que es repartir de nuevo lo
 * mismo—, y lo que queda afuera queda afuera por motivos distintos entre sí:
 * `reabrir` no tiene sentido sin el ciclo de señales, un borde puede caer donde
 * no hay texto, y un tipo que no existe es un error de programa. Así que lo que
 * contesta es una excepción con el motivo, que vive donde vive la regla.
 *
 * @throws si el cambio no se puede hacer sin volver a oír el audio
 */
function aplicar(toma, cambio) {
    const c = cambio || {};
    switch (c.tipo) {
        case 'vista':
            toma.vista = c.vista;
            return;
        case 'nota':
            toma.comentario = String(c.texto || '');
            return;
        case 'descartar':
            toma.descartada = Boolean(c.descartada);
            return;
        case 'comentar':
            comentar(toma, c);
            return;
        case 'borrar-comentario':
            descomentar(toma, c.indice);
            return;
        case 'borde':
            moverBordeGuardado(toma, c.borde, Number(c.paredMs));
            return;
        case 'reabrir':
            // Reabrir es dejar la toma sin OUT para que el ciclo de señales le
            // siga metiendo palabras. Con la clase cerrada no hay ciclo, y una
            // toma sin OUT no se escribe (`tomasQueQuedan`): el gesto la haría
            // desaparecer del XML, que es lo último que espera quien lo pide.
            // Lo que quiere decir es "que la toma siga un poco más", y eso ahora
            // es correr el OUT.
            throw new Error('Reabrir es de la clase que se está grabando. Con la ' +
                'clase cerrada, una toma sin OUT no llega al XML: para que termine ' +
                'más adelante, arrastrá la línea roja.');
        default:
            throw new Error(`Cambio sin definir: ${c.tipo}`);
    }
}

module.exports = {
    CAMARA,
    PANTALLA,
    VISTAS,
    VISTA_POR_DEFECTO,
    MAPA_DE_VISTAS,
    vistaLeida,
    aplicar,
    estadoNuevo,
    senales,
    aplicarSenales,
    repeticiones,
    tomaAbierta,
    finDeToma,
    elegirClaqueta,
    repartir,
    moverBorde,
    tomasQueQuedan,
    limpio,
    comentarioDeEntrada,
    cueDeSalida
};
