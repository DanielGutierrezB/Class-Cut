'use strict';
/**
 * analisis.js — El panel de análisis: lo que se mide mientras la clase se graba.
 *
 * El primer bloque es real y es el que importa: la COBERTURA DEL TEMARIO. El CD
 * entrega una lista de temas que la clase tiene que cubrir, se pega acá, y a
 * medida que las tomas se cierran el panel dice cuáles quedaron dichos y cuáles
 * faltan. Lo que faltan es la información valiosa: es lo que el profesor todavía
 * tiene que decir, y verlo con la clase en curso es la única oportunidad de
 * arreglarlo — descubrirlo sobre la clase terminada es volver a grabar.
 *
 * El segundo también mide: la CALIDAD DEL LENGUAJE, toma por toma y en vivo. Su
 * vara no es una lista pegada sino unas bandas medidas sobre las clases reales
 * del curso (`engine/lengua.js`), y la mitad de lo que muestra no necesita
 * modelo, así que ese medio bloque anda siempre.
 *
 * El tercero sigue siendo una maqueta con guioncitos, y es a propósito y está
 * dicho en la pantalla: los números son de relleno hasta que se defina CONTRA
 * QUÉ se mide cada uno. Ponerlos ahora inventaría un criterio, y un número
 * inventado en una pantalla de validación es peor que un espacio vacío: nadie
 * sabe que no hay que creerle. Los dos primeros dejaron de ser maquetas porque
 * ahora tienen su vara.
 *
 * **Acá no se decide nada de la medición**: ni cuándo se llama al modelo, ni qué
 * se le pregunta, ni qué se hace con lo que contesta. Eso vive en
 * `engine/temario.js` y lo dispara `engine/grabacion.js`, que es quien escribe
 * el archivo; el panel manda el texto pegado y dibuja lo que el motor conteste.
 */

import { fmtDur, plural } from '../formato.js';

const BLOQUES = [
    {
        titulo: 'Metodología',
        pendiente: 'Falta definir qué cuenta como ejemplo y como ejercicio.',
        filas: [
            ['Ejemplos', '—'],
            ['Ejercicios propuestos', '—'],
            ['Preguntas al alumno', '—']
        ]
    }
];

/**
 * Lo último que se dibujó, para poder repintar cuando el motor contesta.
 *
 * Pegar la lista es lo único de este panel que le pide algo al motor, y la
 * respuesta trae el estado nuevo. Sin esto habría que esperar el aviso que llega
 * cada tres segundos para ver la lista cargada, y pegar algo y que no pase nada
 * durante tres segundos se lee como que no se pegó.
 */
const ultimo = { donde: null, estado: null, rehacerTemario: false };

/**
 * Los números de la sesión, contra un instante.
 *
 * `ahoraMs` llega por parámetro y no se lee acá adentro: la mitad de esto es un
 * reloj, y un reloj que se mira la hora solo no se puede probar.
 *
 * @param {object|null} estado el resumen del motor (`resumen` en `engine/grabacion.js`)
 * @param {number} ahoraMs la hora del día de este repintado
 */
export function cuentas(estado, ahoraMs) {
    const tomas = estado ? estado.tomas : [];
    const grabando = Boolean(estado && estado.grabando);
    const quedan = tomas.filter(t => !t.descartada && t.outMs != null);

    // La toma abierta suma hasta AHORA, y es lo que hace que la duración se
    // mueva mientras el profesor habla. Sin ella el número se quedaba quieto
    // hasta que alguien dijera "Pausa", o sea que dejaba de moverse justo
    // durante lo único que está pasando. Al cerrarse puede achicarse unos
    // segundos —el OUT cae en la última palabra y no en el silencio de atrás—,
    // y eso es mejor que tenerlo mintiendo hacia abajo toda la toma.
    //
    // En "Quedan" no entra: esa fila cuenta lo que ya se puede escribir en el
    // XML, y una toma sin cerrar todavía no va (`tomasQueQuedan`).
    const enElAire = grabando
        ? tomas.filter(t => !t.descartada && t.outMs == null && t.inMs != null)
        : [];
    const clase = quedan.concat(enElAire);
    const segundos = clase.reduce((suma, t) => suma + ((t.outMs == null ? ahoraMs : t.outMs) - t.inMs) / 1000, 0);
    const palabras = clase.reduce((suma, t) => suma + (t.palabras || []).length, 0);
    const minutos = segundos / 60;

    // Desde "Iniciar grabación" y no desde el aplauso. La claqueta es el cero de
    // los timecodes —de ella cuelga la clase entera en post— pero llega cuando
    // el director se acuerda, minutos después del botón; y lo que se pregunta
    // acá es hace cuánto que el profesor está frente al micrófono, que es el
    // mismo momento en que se puso a grabar el Rodecaster.
    const grabadoSeg = grabando && estado.ceroMs ? Math.max(0, (ahoraMs - estado.ceroMs) / 1000) : null;

    return [
        ['Tomas', String(tomas.length)],
        ['Quedan', String(quedan.length)],
        ['Descartadas', String(tomas.filter(t => t.descartada).length)],
        ['Duración de la clase', fmtDur(segundos)],
        ['Grabando hace', grabadoSeg == null ? '—' : fmtDur(grabadoSeg)],
        ['Sobrevive', sobrevive(segundos, grabadoSeg)],
        // Cuánto habla, que es el único indicador de ritmo que se puede calcular
        // sin decidir nada: son palabras contadas contra minutos contados.
        ['Palabras por minuto', minutos > 0.5 ? String(Math.round(palabras / minutos)) : '—']
    ];
}

/**
 * Qué parte de lo grabado va a sobrevivir al corte.
 *
 * Sale gratis de los dos relojes de arriba y dice algo que ninguno de los dos
 * solo dice: cuarenta minutos de micrófono para veintidós de clase es una
 * sesión que se está yendo en repeticiones, y eso se sabe mientras todavía se
 * puede hacer algo. Debajo del minuto no se muestra: en el primer minuto no hay
 * ninguna toma abierta todavía y el porcentaje salta entre 0 y 90 sin querer
 * decir nada.
 */
function sobrevive(segundos, grabadoSeg) {
    if (grabadoSeg == null || grabadoSeg < 60) return '—';
    return `${Math.round((segundos / grabadoSeg) * 100)}%`;
}

/* ─── El reloj de la sesión ──────────────────────────────────────────────
 *
 * El estado del motor llega cada tres segundos, así que con eso solo los dos
 * relojes avanzarían a los saltos. El tic corre aparte, cada segundo, y no
 * repinta el panel: reescribe el texto de las filas de "La sesión" y nada más.
 *
 * **Esa es la diferencia que importa.** Repintar más seguido es exactamente lo
 * que le sacaba el foco a quien estaba escribiendo, que es el bug del que se
 * defienden `ocupado` acá abajo y `tarjetaOcupada` en `tomas.js`. Un `<dd>` no
 * puede tener el foco de nadie ni ser un campo a medio llenar, así que
 * escribirle el texto no le cuesta nada al que está tipeando.
 */

const TIC_MS = 1000;

/** Las filas dibujadas y con qué estado, mientras el tic corre. */
let reloj = null;
let tic = null;

function apagarTic() {
    if (tic) clearInterval(tic);
    tic = null;
    reloj = null;
}

/**
 * Deja el tic corriendo sobre las filas recién dibujadas, o lo apaga.
 *
 * Mientras se relee lo último ("Terminando…") no corre: el audio ya está
 * cerrado y un reloj andando ahí diría que se sigue grabando.
 */
function marcarTic(filas, estado) {
    apagarTic();
    if (!estado || !estado.grabando || estado.terminando) return;
    reloj = { filas, estado };
    tic = setInterval(latir, TIC_MS);
}

function latir() {
    // Salir del paso no vuelve a llamar a `pintar`, así que el tic se corta
    // solo: un intervalo huérfano repintando para siempre no avisa nunca.
    if (!reloj || !seVe(reloj.filas)) { apagarTic(); return; }
    const valores = reloj.filas.querySelectorAll('dd');
    cuentas(reloj.estado, Date.now()).forEach(([, cuanto], i) => {
        if (valores[i] && valores[i].textContent !== cuanto) valores[i].textContent = cuanto;
    });
}

/** Si el paso "Grabar" sigue a la vista (`showView` en `chrome.js`). */
function seVe(nodo) {
    const paso = nodo.isConnected ? nodo.closest('.view') : null;
    return Boolean(paso && paso.classList.contains('is-visible'));
}

/**
 * Una tabla de filas del panel.
 *
 * Cada fila es `[qué, cuánto]` y puede traer un tercero, `{zona, porque}`: la
 * zona es lo que convierte un número en una señal —"168" no le dice nada a nadie
 * y "168, en zona" sí— y el porqué es contra qué se lo está comparando. La zona
 * va como clase y no como color escrito acá: quien elige el color es la hoja.
 */
function tabla(filas) {
    const dl = document.createElement('dl');
    dl.className = 'analisis-filas';
    for (const [que, cuanto, señal] of filas) {
        const dt = document.createElement('dt');
        dt.textContent = que;
        const dd = document.createElement('dd');
        dd.textContent = cuanto;
        if (señal && señal.zona) dd.classList.add(`es-${señal.zona}`);
        if (señal && señal.porque) { dt.title = señal.porque; dd.title = señal.porque; }
        dl.append(dt, dd);
    }
    return dl;
}

function bloque(titulo, clave) {
    const caja = document.createElement('section');
    caja.className = 'analisis-bloque';
    caja.dataset.bloque = clave;
    const h3 = document.createElement('h3');
    h3.textContent = titulo;
    caja.append(h3);
    return caja;
}

function pendiente(texto, clase) {
    const p = document.createElement('p');
    p.className = clase ? `analisis-pendiente ${clase}` : 'analisis-pendiente';
    p.textContent = texto;
    return p;
}

/* ─── La cobertura del temario ───────────────────────────────────────────── */

const SIN_LISTA = 'Falta la lista de objetivos de la clase para medir contra ella. ' +
    'Pegala acá y se mide sola cada vez que se cierra una toma.';

const PEGAR_ACA = 'Pegá acá los temas que pidió el director de contenido, uno por ' +
    'renglón o con viñetas. También sirve pegar el párrafo tal como llegó.';

/**
 * Cuánto tiempo de clase lleva cada objetivo cubierto.
 *
 * Es el reparto y nada más —los segundos que quedan divididos por los temas que
 * se dieron—, así que no dice qué objetivo llevó más: para eso habría que saber
 * qué tramo cubre a cuál, y el modelo contesta la toma, no el tramo. Sirve para
 * lo que se usa en vivo: darse cuenta de que van cuarenta minutos y dos temas.
 */
function tiempoPorObjetivo(estado, cobertura) {
    if (!cobertura || !cobertura.cubiertos) return '—';
    const quedan = (estado.tomas || []).filter(t => !t.descartada && t.outMs != null);
    const segundos = quedan.reduce((suma, t) => suma + (t.outMs - t.inMs) / 1000, 0);
    return fmtDur(segundos / cobertura.cubiertos);
}

/**
 * El desplegable donde se pega la lista.
 *
 * Es un `<details>` como los de las clases ya grabadas y el de la clave de
 * Ajustes, por coherencia y porque resuelve solo lo que hay que resolver: la
 * caja de texto ocupa media columna mientras se pega y desaparece después, sin
 * un interruptor propio que haya que recordar. Plegado sigue diciendo cuántos
 * temas hay cargados — si no, plegarlo parece haberlos perdido, que es
 * exactamente el problema que ya tuvo la lista de clases grabadas.
 *
 * Arranca abierto cuando no hay lista y plegado cuando sí: lo primero que hay
 * que hacer con el bloque vacío es pegar, y una vez pegada la lista lo que se
 * mira son los resultados.
 */
function desplegable(temario, abierto) {
    const objetivos = temario ? temario.objetivos : [];

    const caja = document.createElement('details');
    caja.className = 'temario-caja';
    caja.open = abierto == null ? !objetivos.length : abierto;

    const cabeza = document.createElement('summary');
    cabeza.className = 'temario-summary';
    cabeza.textContent = objetivos.length
        ? `${plural(objetivos.length, 'tema cargado', 'temas cargados')}`
        : 'Pegar la lista de temas del CD';

    // De dónde salió la lista, plegado y todo: una lista que apareció sola —la
    // de la clase anterior del mismo curso— tiene que decir que no la pegó nadie
    // acá, porque puede no ser la de esta clase.
    if (temario && temario.origen === 'heredado' && objetivos.length) {
        const de = document.createElement('span');
        de.className = 'temario-origen';
        de.textContent = 'de la clase anterior';
        cabeza.append(de);
    }

    const campo = document.createElement('textarea');
    campo.className = 'temario-campo';
    campo.rows = 7;
    campo.placeholder = PEGAR_ACA;
    campo.spellcheck = false;
    campo.value = temario ? (temario.texto || objetivos.map(o => o.texto).join('\n')) : '';
    // Lo que estaba guardado cuando se dibujó el campo. Es contra esto que se
    // compara para saber si hay algo escrito sin guardar, que es lo que impide
    // repintar encima (`ocupada`).
    campo.dataset.guardado = campo.value;

    const acciones = document.createElement('div');
    acciones.className = 'temario-acciones';

    const guardar = document.createElement('button');
    guardar.className = 'btn btn-primary btn-inline';
    guardar.type = 'button';
    guardar.textContent = 'Medir contra esta lista';
    guardar.onclick = () => {
        // Y se pliega en el mismo gesto: es lo que se pidió —pegar y que deje de
        // ocupar espacio— y ahorra el segundo clic.
        caja.open = false;
        aplicar(campo.value);
    };

    // La red de seguridad: salir del campo con algo escrito y sin apretar el
    // botón también guarda. `onchange` en un textarea salta al perder el foco y
    // solo si el texto cambió, que es la misma convención que la nota de una
    // toma (`tomas.js`).
    campo.onchange = () => aplicar(campo.value);

    acciones.append(guardar);
    caja.append(cabeza, campo, acciones);
    return caja;
}

/**
 * Manda la lista al motor y dibuja lo que conteste.
 *
 * El motor la parte, la guarda en el sidecar de la clase y arranca la medición;
 * la cobertura llega unos segundos después, por el aviso de siempre. Acá solo se
 * refresca lo que ya se sabe: que la lista quedó cargada y con cuántos temas.
 */
async function aplicar(texto) {
    const estado = await window.cc.grabarTemario(texto);
    if (!estado || !ultimo.donde) return;
    // El estado que tiene la pantalla es el mismo objeto que dibuja todo lo demás
    // (`vista.estado` en `index.js`), así que se le copia el temario nuevo en vez
    // de guardarse una copia acá: el motor sigue siendo el único dueño, y el
    // repintado que venga —el del aviso, tres segundos después— trae lo mismo.
    if (ultimo.estado) ultimo.estado.temario = estado.temario;
    // Y este repintado sí rehace el bloque, aunque el foco siga adentro.
    //
    // Hace falta decirlo porque el foco SIGUE adentro: apretar el botón lo deja
    // en el botón, que es parte del bloque, y el campo todavía tiene texto que no
    // coincide con lo guardado. O sea que las dos condiciones de `ocupado` dan
    // que sí justo después de guardar, y el bloque se quedaba con la lista sin
    // cargar y el resumen diciendo "Pegar la lista de temas del CD" para
    // siempre. La protección es contra los repintados que llegan de AFUERA
    // —el estado del motor, cada tres segundos—, no contra el que pide el propio
    // gesto de guardar.
    ultimo.rehacerTemario = true;
    pintar(ultimo.donde, ultimo.estado || estado);
}

/**
 * Los objetivos, los que faltan primero.
 *
 * En dos grupos y no en una sola lista ordenada por estado: dentro de cada grupo
 * se conserva el orden en que el CD escribió la lista, que es el orden en que
 * espera que la clase avance. Mezclarlos por estado le sacaría ese dato.
 *
 * El número de toma va pegado al objetivo cubierto porque es lo que lo vuelve
 * accionable: se puede ir a mirar esa toma, y si después se descarta, se sabe
 * qué se perdió con ella.
 */
function listaDeObjetivos(cobertura) {
    const caja = document.createElement('div');
    caja.className = 'temario-objetivos';

    const grupo = (titulo, cuales, clase) => {
        if (!cuales.length) return;
        const rotulo = document.createElement('p');
        rotulo.className = 'temario-grupo';
        rotulo.textContent = titulo;
        const ul = document.createElement('ul');
        ul.className = `temario-lista ${clase}`;
        for (const o of cuales) {
            const li = document.createElement('li');
            const que = document.createElement('span');
            que.className = 'temario-tema';
            que.textContent = o.texto;
            // El por qué en el `title` y no en la línea: son veinte objetivos en
            // una columna angosta, y con una frase debajo de cada uno la lista
            // deja de leerse de un vistazo, que es todo lo que se le pide.
            if (o.porque) li.title = o.porque;
            li.append(que);
            if (o.toma) {
                const donde = document.createElement('span');
                donde.className = 'temario-toma';
                donde.textContent = `toma ${o.toma}`;
                li.append(donde);
            }
            ul.append(li);
        }
        caja.append(rotulo, ul);
    };

    grupo('Falta decir', cobertura.objetivos.filter(o => !o.cubierto), 'es-falta');
    grupo('Ya dicho', cobertura.objetivos.filter(o => o.cubierto), 'es-cubierto');
    return caja;
}

/**
 * El bloque entero.
 *
 * Pierde `es-pendiente` cuando hay lista y hay medición: la clase apagada dice
 * "esto no mide nada todavía", y dejarla puesta sobre una cobertura de verdad
 * sería enseñarle a quien mira a no creerle al único bloque que sí mide.
 */
function bloqueDeTemario(estado) {
    const t = estado ? estado.temario : null;
    const cobertura = t ? t.cobertura : null;
    const objetivos = t ? t.objetivos : [];

    const caja = bloque('Cobertura del temario', 'temario');
    caja.classList.toggle('es-pendiente', !(objetivos.length && cobertura));

    caja.append(tabla([
        ['Objetivos cubiertos', cobertura ? `${cobertura.cubiertos} de ${objetivos.length}` : '—'],
        ['Objetivos sin tocar', cobertura ? String(cobertura.faltan) : '—'],
        ['Tiempo por objetivo', tiempoPorObjetivo(estado, cobertura)]
    ]));

    // Sin sesión no hay dónde pegar nada: la lista es de una clase, y la clase
    // empieza con "Iniciar grabación".
    if (!estado) {
        caja.append(pendiente(SIN_LISTA));
        return caja;
    }

    caja.append(desplegable(t, abiertoDe(caja.dataset.bloque)));

    // Sin lista no hay nada más que decir: el desplegable ya está para pegarla.
    if (!objetivos.length) {
        caja.append(pendiente(SIN_LISTA));
        return caja;
    }

    if (cobertura) caja.append(listaDeObjetivos(cobertura));

    // **Abstenerse no es fallar, y no puede leerse como una falla.** Con el
    // modelo local no se consulta mientras se graba porque le pelearía la GPU al
    // Whisper que decide dónde arrancan las tomas (`engine/gpu.js`), y eso es una
    // decisión de la app: va sin `es-falla` y diciendo cuándo sí se va a medir.
    // El texto llega del motor y no se escribe acá, que es lo mismo que hace el
    // bloque de al lado con el suyo — la explicación es una sola.
    if (t.abstenido) {
        caja.append(pendiente(t.abstenido, 'es-abstenido'));
    } else if (!cobertura) {
        caja.append(pendiente(estado.midiendoTemario
            ? 'Midiendo la cobertura…'
            : 'Se mide cuando cierre la primera toma: hasta entonces no hay texto ' +
              'estable contra el que comparar.'));
    }

    // La verdad antes que un número: si la consulta falló o no hay proveedor, se
    // dice y se dice por qué. Y si lo que se está mostrando salió del respaldo
    // por coincidencia de palabras, se avisa que es una aproximación — un
    // objetivo dicho con otras palabras ahí sale como faltante.
    if (t.fallo) caja.append(pendiente(`No se pudo medir: ${t.fallo}`, 'es-falla'));
    if (cobertura && cobertura.como === 'palabras') {
        caja.append(pendiente('Es una aproximación por coincidencia de palabras, no una ' +
            'medición: un tema explicado con otras palabras aparece como faltante.', 'es-falla'));
    }

    return caja;
}

/* ─── La calidad del lenguaje ────────────────────────────────────────────────
 *
 * Cómo viene hablando el profesor, medido cada vez que queda cerrada una toma.
 * Dejó de ser un informe sobre el transcript final —que es lo que decía la
 * maqueta— porque un informe sobre el transcript final llega cuando ya no se
 * puede hacer nada: lo único que sirve es enterarse entre dos tomas, para
 * corregir en la siguiente.
 *
 * **Las tres de arriba y las tres de abajo no son lo mismo, y por eso se ven
 * separadas.** Las de arriba son tasas de la clase que va a quedar y se calculan
 * sobre las palabras que ya están en memoria: están siempre, con proveedor de IA
 * o sin él. Las de abajo son hechos de la última toma y las contesta un modelo:
 * pueden faltar, y cuando faltan lo dicen. Mostrarlas mezcladas haría que una
 * consulta caída se leyera como "el profesor habla perfecto".
 *
 * Quién decide y quién mide es `engine/lengua.js`; las bandas y la zona en la
 * que cae cada número llegan calculadas desde allá (ver `zonasDe`), así que acá
 * no hay ningún umbral escrito. El panel dibuja.
 */

/** Cómo se llama cada tipo de hallazgo en la pantalla. Las claves, en el motor. */
const HALLAZGOS = [
    ['sin_cerrar', 'Frases sin cerrar'],
    ['repetida', 'La misma idea dos veces'],
    ['jerga', 'Jerga sin explicar']
];

const LENGUA_SIN_MEDIR = 'Se mide cuando queda cerrada una toma, sobre el texto que se ' +
    'relee con el modelo grande. La toma abierta todavía no cuenta: su texto es el del ' +
    'ciclo de señales, que se descarta.';

/** Un número con coma decimal, que es como se escribe acá. */
function conComa(n) {
    return n == null ? '—' : n.toFixed(1).replace('.', ',');
}

/** Contra qué está en zona ese número, para que el número diga algo. */
function contraQue(banda, unidad) {
    if (!banda) return '';
    return banda.desde != null
        ? `En zona: de ${banda.desde} a ${banda.hasta} ${unidad}.`
        : `En zona: hasta ${banda.hasta} ${unidad}.`;
}

/**
 * Las tres tasas de la clase que va a quedar.
 *
 * Van agregadas y no por toma porque son tasas: juntar las palabras y los
 * segundos de todas las tomas da un número más firme que el de una toma suelta,
 * donde una sola muletilla ya se lee como tres por minuto.
 *
 * El ritmo se mide contra el tiempo HABLANDO y no contra el reloj, y el aire
 * muerto es el otro lado de esa misma resta. Medidos contra el reloj, hablar
 * rapidísimo y callarse medio minuto se promedian entre sí y las dos cosas
 * desaparecen.
 */
function filasDeTasas(l) {
    const b = l.bandas || {};
    return [
        ['Muletillas por minuto', conComa(l.muletillasPorMin), {
            zona: l.zonas.muletillasPorMin,
            porque: `${contraQue(b.muletillasPorMin, 'por minuto')} En el curso, tres cuartos ` +
                'de las tomas no tienen ninguna.'
        }],
        ['Palabras por minuto', l.ppm == null ? '—' : String(l.ppm), {
            zona: l.zonas.ppm,
            porque: `${contraQue(b.ppm, 'palabras por minuto de habla')} Es lo que da el ` +
                'material del curso que llegó al corte final.'
        }],
        ['Aire muerto', l.airePct == null ? '—' : `${conComa(l.airePct)}%`, {
            zona: l.zonas.airePct,
            porque: `${contraQue(b.airePct, '% de la clase')} Son ${l.aireSec} s en silencio, ` +
                'en huecos de 2,5 s o más.'
        }]
    ];
}

/**
 * Los tres hechos de la última toma que queda.
 *
 * **De la última toma y no de la clase, y eso resuelve lo del ruido.** Una frase
 * que quedó colgando es un hecho de una toma concreta; sumarlas todas daría un
 * contador que solo sube y que a la media hora está siempre en rojo, o sea que
 * se ignora. Mirando la última, el aviso se apaga solo cuando la toma siguiente
 * sale bien, que es exactamente lo que hay que saber.
 *
 * La zona acá no sale de una banda medida y no puede salir: no es una tasa, es
 * un recuento de cosas que pasaron o no pasaron. Cero está bien y uno ya es algo
 * para mirar.
 */
function filasDeHallazgos(ultima) {
    const ia = ultima ? ultima.ia : null;
    const listo = Boolean(ia && ia.estado === 'listo');
    const cuenta = {};
    for (const h of (ia && ia.hallazgos) || []) cuenta[h.tipo] = (cuenta[h.tipo] || 0) + 1;

    return HALLAZGOS.map(([tipo, titulo]) => {
        const cuantos = cuenta[tipo] || 0;
        const suyos = ((ia && ia.hallazgos) || []).filter(h => h.tipo === tipo);
        return [titulo, listo ? String(cuantos) : '—', {
            zona: listo ? (cuantos ? 'ojo' : 'bien') : null,
            // El detalle de cada uno en el `title`: son seis filas en una columna
            // angosta, y con una frase debajo de cada una el bloque deja de
            // leerse de un vistazo, que es todo lo que se le pide.
            porque: suyos.map(h => `«${h.que}» — ${h.detalle}`).join('\n')
        }];
    });
}

/** Las muletillas que de verdad se dijeron, que es la primera pregunta de quien mira. */
function cualesFueron(masDichas) {
    const p = document.createElement('p');
    p.className = 'lengua-cuales';
    p.textContent = masDichas.map(m => `${m.cual} ×${m.veces}`).join(' · ');
    return p;
}

/**
 * Lo que el modelo encontró, dicho con palabras.
 *
 * Se muestra uno solo —el primero de la toma— y no la lista entera: el resto
 * está en el `title` de su fila. Con la clase corriendo, una cosa concreta que
 * arreglar en la toma que viene sirve; cinco no se leen.
 */
function detalleDelHallazgo(hallazgos) {
    const primero = hallazgos[0];
    const p = document.createElement('p');
    p.className = 'lengua-detalle';
    const cita = document.createElement('span');
    cita.className = 'lengua-cita';
    cita.textContent = `«${primero.que}»`;
    p.append(cita, document.createTextNode(` ${primero.detalle}`));
    return p;
}

/**
 * El bloque entero.
 *
 * Pierde `es-pendiente` en cuanto hay una toma medida: la clase apagada dice
 * "esto no mide nada todavía", y dejarla sobre números de verdad sería enseñarle
 * a quien mira a no creerle a lo que sí mide.
 */
function bloqueDeLengua(estado) {
    const l = estado ? estado.lengua : null;
    const medido = Boolean(l && l.tomas);

    const caja = bloque('Calidad del lenguaje', 'lengua');
    caja.classList.toggle('es-pendiente', !medido);

    if (!medido) {
        caja.append(tabla([
            ['Muletillas por minuto', '—'],
            ['Palabras por minuto', '—'],
            ['Aire muerto', '—'],
            ...HALLAZGOS.map(([, titulo]) => [titulo, '—'])
        ]));
        // Con tomas cerradas y todavía sin medida no está pendiente: está
        // esperando el segundo que tarda la relectura, y decirlo evita que se
        // lea como roto.
        caja.append(pendiente(l && l.sinMedir
            ? `${plural(l.sinMedir, 'toma cerrada', 'tomas cerradas')} sin medir: se mide en ` +
                'cuanto se le rehaga el texto con el modelo grande.'
            : LENGUA_SIN_MEDIR));
        return caja;
    }

    caja.append(tabla(filasDeTasas(l)));
    if (l.masDichas.length) caja.append(cualesFueron(l.masDichas));

    const ultima = l.ultima;
    const ia = ultima ? ultima.ia : null;
    // "La que leyó el modelo" solo cuando de verdad la leyó: la última toma
    // puede estar acá porque no se pudo medir o porque se decidió no medirla
    // todavía, y en esos dos casos el rótulo estaría diciendo que un modelo miró
    // algo que nadie miró.
    caja.append(rotulo(!ultima ? 'Lo que pide el modelo'
        : ia && ia.estado === 'listo' ? `De la toma ${ultima.toma}, la última que leyó el modelo`
            : `De la toma ${ultima.toma}, la última que cerró`));
    caja.append(tabla(filasDeHallazgos(ultima)));

    if (ia && ia.estado === 'listo' && ia.hallazgos.length) {
        caja.append(detalleDelHallazgo(ia.hallazgos));
    }
    // Que se está midiendo se dice aunque haya un resultado viejo arriba: con el
    // modelo de esta máquina la lectura tarda un par de minutos, y sin este
    // renglón el panel se queda quieto y parece que ya terminó de mirar.
    if (l.midiendo) caja.append(pendiente(`Leyendo la toma ${l.midiendo} con el modelo…`));
    // La verdad antes que un número: sin proveedor o con la consulta caída se
    // dice qué pasó. Las tres tasas de arriba siguen ahí, que es el sentido de
    // haberlas separado.
    //
    // Lo abstenido va aparte y sin `es-falla` por lo mismo que en el bloque del
    // temario: hay proveedor y anda, y no se lo consulta ahora a propósito.
    if (ia && ia.estado === 'abstenido') caja.append(pendiente(ia.porque, 'es-abstenido'));
    if (ia && ia.estado === 'sin-modelo') caja.append(pendiente(ia.porque, 'es-falla'));
    if (ia && ia.estado === 'falla') {
        caja.append(pendiente(`No se pudo medir: ${ia.porque}`, 'es-falla'));
    }

    caja.append(pendiente(`Las tasas son de ${plural(l.tomas, 'toma que queda', 'tomas que quedan')}` +
        `, sobre ${fmtDur(l.hablandoSec)} de habla.` +
        (l.abierta ? ' La toma abierta se mide cuando cierre.' : '')));

    return caja;
}

/** Un rótulo que separa dos grupos de filas dentro de un bloque. */
function rotulo(texto) {
    const p = document.createElement('p');
    p.className = 'analisis-rotulo';
    p.textContent = texto;
    return p;
}

/* ─── Repintar sin sacarle el suelo a quien escribe ──────────────────────── */

/**
 * ¿Se puede rehacer este bloque, o alguien está trabajando en él?
 *
 * **Esto ya rompió esta pantalla antes.** `pintar()` corre cada tres segundos
 * mientras se graba, y rehacer el bloque saca del documento el campo donde
 * alguien está escribiendo: el cursor se va solo a media frase y lo escrito se
 * pierde. Es el mismo problema que resolvió `tarjetaOcupada` en `tomas.js` y se
 * resuelve igual —el nodo ocupado no se toca—, pero con una condición más: acá
 * el texto se guarda apretando un botón, así que un campo con algo escrito y sin
 * guardar sigue ocupado aunque el foco ya se haya ido a otra parte.
 */
function ocupado(seccion) {
    if (!seccion) return false;
    if (seccion.contains(document.activeElement)) return true;
    const campo = seccion.querySelector('.temario-campo');
    return Boolean(campo && campo.value !== campo.dataset.guardado);
}

/** Si el desplegable de ese bloque está abierto ahora mismo, para dejarlo igual. */
function abiertoDe(clave) {
    if (!ultimo.donde) return null;
    const previo = ultimo.donde.querySelector(`[data-bloque="${clave}"] .temario-caja`);
    return previo ? previo.open : null;
}

/**
 * Deja el panel igual a `nuevas` sin sacar del documento lo que ya está bien.
 *
 * Es `acomodar` de `tomas.js` con la misma idea y por el mismo motivo, pero
 * comparando por nodo: acá los bloques son siempre los mismos y en el mismo
 * orden, así que quien decide qué se reusa es el que arma la lista.
 */
function acomodar(donde, nuevas) {
    for (const vieja of [...donde.children]) {
        if (!nuevas.includes(vieja)) vieja.remove();
    }
    let ref = donde.firstElementChild;
    for (const nodo of nuevas) {
        if (nodo === ref) { ref = ref.nextElementSibling; continue; }
        donde.insertBefore(nodo, ref);
    }
}

export function pintar(donde, estado) {
    // Antes de armar nada: `abiertoDe` y `ocupado` leen lo que hay dibujado, y lo
    // que hay dibujado se sabe por acá.
    ultimo.donde = donde;
    ultimo.estado = estado;

    const ahora = bloque('La sesión', 'sesion');
    const filas = tabla(cuentas(estado, Date.now()));
    ahora.append(filas);

    // El del temario se reusa tal cual si alguien está escribiendo en él. O sea
    // que sus números dejan de refrescarse un rato: es a propósito, porque quien
    // está pegando la lista está mirando la lista, y a cambio no se le mueve el
    // suelo. Al guardar se repinta con lo que el motor conteste.
    const previo = donde.querySelector('[data-bloque="temario"]');
    const rehacer = ultimo.rehacerTemario;
    ultimo.rehacerTemario = false;
    const temario = !rehacer && ocupado(previo) ? previo : bloqueDeTemario(estado);

    const restantes = BLOQUES.map(b => {
        const caja = bloque(b.titulo, b.titulo);
        caja.classList.add('es-pendiente');
        caja.append(tabla(b.filas), pendiente(b.pendiente));
        return caja;
    });

    acomodar(donde, [ahora, temario, bloqueDeLengua(estado), ...restantes]);
    // Después de acomodar: el tic mira si sus filas siguen en el documento para
    // saber si todavía hace falta, y antes de esta línea no lo están.
    marcarTic(filas, estado);
}
