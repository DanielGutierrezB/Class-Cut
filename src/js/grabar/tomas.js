'use strict';
/**
 * tomas.js — La tarjeta de una toma y la lista que las contiene.
 *
 * Lo que se ve es el estado que manda el motor, sin copia local: la vista no
 * guarda nada suyo, así que lo que está en pantalla y lo que se acaba de
 * escribir en el XML son la misma cosa. Cambiar algo es pedirle el cambio al
 * motor y volver a dibujar con lo que conteste.
 *
 * La única excepción es cómo se está MIRANDO la lista —qué tomas están plegadas,
 * si las descartadas se ven— y eso no va al motor a propósito: no es algo que se
 * le hizo a la clase, es algo que se le hizo a la pantalla, y el XML es lo
 * primero. Vive en `index.js` y llega acá como `mirada`.
 *
 * El texto de cada toma —sus palabras, sus dos bordes y el subrayado de lo
 * comentado— se fue a `palabras.js`, y los comentarios al margen a `margen.js`,
 * cuando este archivo pasó los seiscientos renglones. La frontera es la que el
 * DOM ya tenía: acá lo que rodea al texto, allá lo que está dentro de él.
 */

import { fmtDur, fmtHora } from '../formato.js';
import { textoDe, bordeConElDerecho, seleccion } from './palabras.js';
import * as margen from './margen.js';
import * as plegado from './plegado.js';
import * as empalme from './empalme.js';

/* ─── Las piezas de una toma ─────────────────────────────────────────────
 *
 * Separadas porque una toma se dibuja de dos maneras: la de la clase que se está
 * grabando (`pintarToma`) y la de una que ya terminó (`pintarLeida`). Muestran lo
 * mismo y se les puede hacer lo mismo; lo que cambia son los botones que solo
 * tienen sentido con el ciclo de señales corriendo —"Cerrar acá", "Reabrir"— y
 * "Eliminar", que borra de una sesión y una sesión terminada ya no existe.
 */

function tarjetaDe(toma) {
    const caja = document.createElement('article');
    caja.className = 'toma';
    caja.classList.toggle('es-descartada', Boolean(toma.descartada));
    caja.classList.toggle('es-abierta', toma.outMs == null);
    caja.dataset.vista = toma.vista;
    caja.dataset.toma = toma.id;
    return caja;
}

function cabezaDe(toma) {
    const cabeza = document.createElement('header');
    cabeza.className = 'toma-cabeza';

    const n = document.createElement('span');
    n.className = 'toma-n';
    n.textContent = `Toma ${toma.id}`;

    const cuando = document.createElement('span');
    cuando.className = 'toma-cuando';
    cuando.textContent = toma.outMs == null
        ? `${fmtHora(toma.inMs)} → grabando`
        : `${fmtHora(toma.inMs)} → ${fmtHora(toma.outMs)} · ${fmtDur((toma.outMs - toma.inMs) / 1000)}`;

    cabeza.append(n, cuando);
    return cabeza;
}

/**
 * La marca de "descartada" en la cabecera. Una toma descartada se pliega sobre
 * sí misma —solo la cabecera, sin texto ni nota—: sigue en la lista porque se
 * puede recuperar, pero no puede ocupar el sitio de las que sí van.
 */
function marcaDeDescartada() {
    const marca = document.createElement('span');
    marca.className = 'toma-descartada';
    marca.textContent = 'descartada';
    return marca;
}

/**
 * Los avisos que el motor dejó sobre la toma, como texto y clase.
 *
 * Aparte del dibujo para poder probarlo: los que no vienen no se dibujan, y cuál
 * viene es una decisión que se puede equivocar sola. Es la misma separación que
 * `queDecir` en `grabar/empalme.js`.
 *
 * **Ninguno es un cartel.** Son renglones de doce píxeles adentro de la tarjeta
 * de su toma, que es la convención que esta pantalla ya tenía para todo lo que
 * hay que saber de una toma concreta. Un diálogo o una franja arriba, en medio de
 * una clase que se está grabando, se cierra sin leer — y con veinte tomas por
 * clase se convierte en algo que se aprende a cerrar.
 */
export function avisos(toma) {
    const lista = [];
    if (toma.cerradaSola) {
        lista.push({ texto: 'Se cerró sola: nadie dijo "Pausa" antes de la toma siguiente o de terminar.' });
    }
    if (toma.repiteA) {
        lista.push({
            texto: `Empieza igual que la toma ${toma.repiteA}: probablemente la repite.`,
            clase: 'es-repite'
        });
    }
    if (toma.pausaAdentro) {
        lista.push({
            texto: `Hay un "Pausa" adentro, a las ${fmtHora(toma.pausaAdentro)}. ` +
                'Con clic derecho sobre esa palabra se corta el OUT ahí.'
        });
    }

    // Lo que le pasó a la relectura, con el texto tal como lo escribió el motor
    // (`engine/insistir.js`): la explicación es una sola y no se reescribe acá,
    // que es lo mismo que hace el panel con el porqué de la abstención.
    //
    // **Los dos estados no se pintan igual, y la diferencia es la que ya está
    // resuelta entre `es-abstenido` y `es-falla` en el panel de análisis.**
    // `degradada` es la app haciendo lo que decidió hacer, y salió bien: la toma
    // tiene texto. Va con la barra del acento —lo que la app usa para hablar de
    // sí misma— y no en ámbar, porque en ámbar se leería como que algo se rompió
    // en medio de la clase. `sin-leer` sí es una falta: esa toma no tiene el texto
    // bueno, y va en el ámbar de los demás avisos, que es el peso que le
    // corresponde en una tarjeta y no arriba de todo.
    const r = toma.relectura;
    if (r && r.estado === 'degradada') lista.push({ texto: r.porque, clase: 'es-degradada' });
    if (r && r.estado === 'sin-leer') lista.push({ texto: r.porque, clase: 'es-sin-leer' });

    return lista;
}

function avisosDe(toma) {
    return avisos(toma).map(({ texto, clase }) => {
        const p = document.createElement('p');
        p.className = clase ? `toma-aviso ${clase}` : 'toma-aviso';
        p.textContent = texto;
        return p;
    });
}

function botonChico(texto, titulo, alClic) {
    const boton = document.createElement('button');
    boton.className = 'btn btn-ghost btn-inline';
    boton.type = 'button';
    boton.textContent = texto;
    if (titulo) boton.title = titulo;
    boton.onclick = alClic;
    return boton;
}

/**
 * Las vistas como botones y no como desplegable: la elegida se ve sin abrir
 * nada, que es lo que hace falta cuando hay veinte tomas y hay que encontrar
 * las del screen recorder de un vistazo. Cada botón lleva el color de su vista,
 * el mismo del borde de la toma.
 *
 * Las teclas P, R, S, M y X hacen lo mismo sobre la toma activa (`teclas.js`), y
 * salen de la inicial de estos mismos rótulos: es lo que las hace adivinables sin
 * tener que enseñarlas.
 */
function selectorDeVistas(toma, vistas, acciones) {
    const grupo = document.createElement('div');
    grupo.className = 'toma-vistas';
    grupo.setAttribute('role', 'radiogroup');
    grupo.setAttribute('aria-label', 'Qué vista se usa en esta toma');
    for (const v of vistas) {
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = 'toma-vista-btn';
        boton.classList.toggle('is-elegida', v.nombre === toma.vista);
        boton.dataset.vista = v.nombre;
        boton.textContent = v.nombre;
        boton.title = `${v.titulo} · tecla ${v.nombre.charAt(0)}`;
        boton.setAttribute('role', 'radio');
        boton.setAttribute('aria-checked', String(v.nombre === toma.vista));
        boton.onclick = () => acciones.alCambiar({ tipo: 'vista', toma: toma.id, vista: v.nombre });
        grupo.append(boton);
    }
    return grupo;
}

/**
 * El botón de plegar, y lo que queda dicho de una toma plegada.
 *
 * Qué se dice y por qué eso vive en `plegado.js`; acá está solo el dibujo. Lo que
 * importa del resumen es que no repite nada de la cabecera —número, horas, largo
 * y vista ya están ahí— y que no esconde el trabajo de nadie: si la toma tiene
 * comentarios o una nota, plegada lo sigue diciendo.
 */
function resumenPlegado(toma) {
    const { asomo, cuanto, marcas } = plegado.resumenDe(toma);
    const caja = document.createElement('div');
    caja.className = 'toma-resumen';

    if (asomo) {
        const dice = document.createElement('p');
        dice.className = 'toma-resumen-dice';
        dice.textContent = asomo;
        caja.append(dice);
    }

    const datos = document.createElement('p');
    datos.className = 'toma-resumen-datos';
    const cuantas = document.createElement('span');
    cuantas.textContent = cuanto;
    datos.append(cuantas);
    for (const marca of marcas) {
        const etiqueta = document.createElement('span');
        etiqueta.className = 'toma-resumen-marca';
        etiqueta.textContent = marca;
        datos.append(etiqueta);
    }
    caja.append(datos);
    return caja;
}

/**
 * El cabezal de una toma que se puede plegar: tocarlo la pliega.
 *
 * Antes había un botón que decía "Plegar", uno más de la fila de la cabecera. El
 * gesto es ahora el cabezal entero, que es lo que ya venía queriendo decir "esta
 * toma": la fila de botones de la cabecera es para lo que se le HACE a la toma
 * —su vista, descartarla, cerrarla— y plegar no se le hace a la toma, se le hace
 * a la pantalla. Un botón ahí ponía las dos cosas en la misma fila y a la misma
 * altura, así que "Plegar" se leía como un hermano de "Descartar", que va al XML.
 *
 * Quién decide si un clic pliega está en `plegado.elClicPliega`, y quién lo
 * escucha en `index.js`: el oyente es uno para la lista entera, porque las
 * tarjetas se rehacen cada tres segundos. Acá queda solo lo que se ve.
 *
 * **Y se ve, que es la mitad del cambio.** Al irse el botón se iba la única señal
 * de que plegar existe, así que el cabezal lo dice de tres maneras, ninguna
 * nueva: el cursor de mano, el aclarado al pasar por encima —el mismo que ya
 * tienen los botones de esta banda— y el triangulito `▸`/`▾`, que es como esta app
 * dibuja "esto se despliega" en la lista de clases grabadas, en el temario y en
 * Ajustes (ver `grabar-lista.css` y `grabar-analisis.css`).
 *
 * El triangulito es un botón de verdad y no un adorno de CSS, y no es el botón
 * que se fue: no tiene rótulo ni sitio en la fila. Es el mando accesible del
 * pliegue —lo que le da su `aria-expanded` y lo deja alcanzable con el teclado,
 * como el `<summary>` de los otros tres desplegables— mientras el cabezal es el
 * blanco cómodo para el mouse. Sin él, plegar existiría solo para quien usa el
 * mouse y un lector de pantalla no tendría nada que anunciar: el `<header>` no
 * puede decir que es un botón teniendo seis botones adentro.
 *
 * Y no es un `<details>` como los otros tres porque el estado no vive en el DOM:
 * la ficha se redibuja cada tres segundos y el `[open]` se perdería en cada
 * repintado. Lo de adentro tampoco se esconde con CSS —se pinta o no se pinta—,
 * así que `<details>` no tendría nada que abrir.
 */
function cabezalQueSePliega(cabeza, toma, plegada, mirada) {
    cabeza.classList.add('es-plegable');
    cabeza.title = plegada
        ? 'Clic en el cabezal para volver a ver el texto de esta toma'
        : 'Clic en el cabezal para dejar solo un resumen, e ir limpiando la vista';

    const marca = document.createElement('button');
    marca.type = 'button';
    marca.className = 'toma-pliegue';
    marca.textContent = plegada ? '▸' : '▾';
    marca.setAttribute('aria-expanded', String(!plegada));
    marca.setAttribute('aria-label', plegada ? `Desplegar la toma ${toma.id}` : `Plegar la toma ${toma.id}`);
    marca.onclick = () => mirada.alPlegar(toma.id, !plegada);
    // Primero de la cabecera, a la izquierda del número, que es donde los otros
    // tres desplegables de la app ponen el suyo.
    cabeza.prepend(marca);
}

/**
 * Una toma de una clase que ya terminó.
 *
 * Se le puede hacer lo mismo que a una en curso, líneas de IN y OUT incluidas. Es
 * la misma línea que traza `vivo.aplicar` del lado del motor, y de ahí sale que
 * todo funcione igual con la clase abierta que cerrada: darse cuenta de que una
 * toma iba en S, o de que el conteo se comió la primera frase, pasa mirando el
 * guion entero, que es justo cuando la clase ya terminó. Lo que se guardó al lado
 * del XML es un rango más ancho que cada toma, así que correr un borde ahí adentro
 * no relee nada.
 *
 * Lo que queda afuera es "Reabrir" —sin el ciclo de señales dejaría la toma sin
 * OUT y por lo tanto fuera del XML— y "Eliminar", que saca una toma de la sesión
 * que se está grabando y de una clase cerrada no hay sesión de la que sacarla: lo
 * que hay es un archivo, y borrarle una toma de abajo no se puede deshacer con la
 * misma tecla que todo lo demás.
 *
 * @param {object} toma como quedó en el archivo con la hora del día (`sidecar`)
 * @param {object} estado por `vistas` y `repetidos`; lo demás no hace falta con
 *   la clase cerrada
 * @param {object|null} [acciones] { alCambiar(comando), alBorde({toma, paredMs}) };
 *   sin esto se lee y nada más
 */
export function pintarLeida(toma, estado, acciones) {
    return dibujar(toma, estado, acciones || null, false, null);
}

/**
 * Una toma de la clase que se está grabando, con todo lo que se le puede hacer.
 *
 * @param {object} toma del estado del motor
 * @param {object} estado el resumen entero, por `vistas`, `tomas` y `abierta`
 * @param {object} acciones { alCambiar(comando), alCerrar(), alBorde({toma, paredMs}) };
 *   los comandos son los de `editar` en `engine/grabacion.js`
 * @param {object} mirada { plegadas: Set<number>, alPlegar(id, plegada) }
 */
function pintarToma(toma, estado, acciones, mirada) {
    return dibujar(toma, estado, acciones, true, mirada);
}

/**
 * @param {boolean} enVivo si la clase se está grabando ahora
 * @param {object|null} mirada cómo se está mirando la lista; sin esto no hay
 *   pliegue, que es de la lista de la clase en curso y no de una tarjeta suelta
 */
function dibujar(toma, estado, acciones, enVivo, mirada) {
    const caja = tarjetaDe(toma);
    const cabeza = cabezaDe(toma);
    // Los tramos que esta toma tiene que subrayar como aviso. Se arman una vez
    // por lista y llegan repartidos, porque un empalme habla de dos tomas y
    // cuelga de una sola: la tarjeta no puede saberlo mirándose a sí misma.
    const repetidos = (estado.repetidos && estado.repetidos.get(toma.id)) || [];

    // Sin nada que hacerle —una clase terminada que solo se lee— se dibuja lo que
    // dice y se acaba: los botones y el campo no pueden estar ahí sin funcionar.
    if (!acciones) {
        if (toma.descartada) {
            cabeza.append(marcaDeDescartada());
            caja.append(cabeza);
            return caja;
        }
        caja.append(cabeza, ...avisosDe(toma), ...conEmpalme(toma, null));
        if (toma.comentario) {
            const nota = document.createElement('p');
            nota.className = 'toma-nota-leida';
            nota.textContent = toma.comentario;
            caja.append(nota);
        }
        caja.append(cuerpoDe(toma, null, null, repetidos));
        return caja;
    }

    const tirar = botonChico(toma.descartada ? 'Recuperar' : 'Descartar',
        toma.descartada
            ? 'Vuelve al XML con la vista que tenía'
            : 'La deja fuera del XML, pero la conserva',
        // Descartar es explícito: "Retomamos" no descarta la anterior sola,
        // porque a veces se retoma para agregar y no para repetir.
        () => acciones.alCambiar({ tipo: 'descartar', toma: toma.id, descartada: !toma.descartada }));
    // Una clase propia, para que quien lo busque no lo busque por su sitio en la
    // fila: el orden de estos botones acaba de cambiar, y un selector que decía
    // "el primer botón de la cabecera" pasó de recuperar una toma a eliminarla sin
    // que nada se rompiera. Eso vale para el arnés y vale para el que lea.
    tirar.classList.add('toma-descartar');

    if (toma.descartada) {
        // **Eliminar a la izquierda y Recuperar a la derecha**, al revés de como
        // estaban. Los dos son la respuesta a la misma pregunta —"esta toma no va,
        // ¿la guardo o la tiro?"— y de las dos, la que se aprieta casi siempre es
        // Recuperar; Eliminar es la excepción. Con Recuperar primero, el gesto
        // frecuente y el irreversible caían uno al lado del otro en el orden en
        // que la mano los encuentra, y el irreversible quedaba al final, que es
        // donde el dedo va cuando ya dejó de leer.
        //
        // Eliminar solo acá, colgando de una toma que ya está descartada: son dos
        // decisiones y no una, y por eso esto no pregunta nada. La otra mitad de
        // por qué no hay cartel es que se deshace con Cmd-Z como todo lo demás
        // (ver `eliminar` en `engine/grabacion.js`) — y es lo que lo separa del
        // "Borrar" de la lista, que se lleva archivos del disco y sí pregunta.
        cabeza.append(marcaDeDescartada());
        if (enVivo) {
            const eliminar = botonChico('Eliminar',
                'La borra de la sesión: no queda ni descartada. Se deshace con Cmd-Z.',
                () => acciones.alCambiar({ tipo: 'eliminar', toma: toma.id }));
            // El rojo apagado vive en `grabar-lista.css`, junto al del "Borrar" de
            // una clase: son la misma promesa —"esto saca algo"— y no pueden verse
            // de dos maneras. Por qué es un relleno y no la letra, y contra qué
            // fondos se midió, está allá.
            eliminar.classList.add('btn-tirar');
            cabeza.append(eliminar);
        }
        cabeza.append(tirar);
        caja.append(cabeza);
        return caja;
    }

    cabeza.append(selectorDeVistas(toma, estado.vistas || [], acciones));

    if (enVivo && toma.outMs == null) {
        cabeza.append(botonChico('Cerrar acá',
            'Cierra la toma en su última palabra, sin esperar el "Pausa"',
            () => acciones.alCerrar()));
    } else {
        cabeza.append(tirar);

        // Reabrir solo la última, y solo si no hay otra abierta: es lo único que
        // el motor honra, porque dos tomas abiertas a la vez rompen el ciclo de
        // señales (ver `editar` en `engine/grabacion.js`). Ofrecer el botón donde
        // no va a hacer nada es peor que no ofrecerlo.
        const ultima = estado.tomas ? estado.tomas[estado.tomas.length - 1] : null;
        if (enVivo && toma === ultima && !estado.abierta) {
            cabeza.append(botonChico('Reabrir', 'Si "Pausa" cerró de más, la toma sigue',
                () => acciones.alCambiar({ tipo: 'reabrir', toma: toma.id })));
        }
    }

    // La abierta no se pliega: es lo que la persona está mirando.
    const plegada = Boolean(mirada && mirada.plegadas.has(toma.id));
    if (mirada && plegado.sePuedePlegar(toma)) {
        cabezalQueSePliega(cabeza, toma, plegada, mirada);
    }

    caja.append(cabeza, ...avisosDe(toma));

    if (plegada) {
        caja.classList.add('es-plegada');
        caja.append(resumenPlegado(toma));
        return caja;
    }

    caja.append(...conEmpalme(toma, acciones), cuerpoDe(toma, acciones, caja, repetidos));
    return caja;
}

/**
 * El aviso de empalme, si hay alguno que dar.
 *
 * Devuelve una lista para poder no devolver nada: es lo que pasa en casi todas
 * las tomas —la primera de la clase, las que no repiten, y las tres situaciones
 * en que no hay modelo con qué mirarlo— y ahí la tarjeta tiene que quedar
 * exactamente como estaba (ver `queDecir` en `grabar/empalme.js`).
 */
function conEmpalme(toma, acciones) {
    const bloque = empalme.bloqueDe(toma, acciones);
    return bloque ? [bloque] : [];
}

/**
 * La nota, el texto y la columna del margen, que van juntos.
 *
 * En una caja propia y no sueltos en la tarjeta porque el margen los reparte en
 * dos columnas cuando hay un comentario abierto: la cabecera se queda de punta a
 * punta y lo que se angosta es el texto, que es lo que tiene al lado la tarjeta
 * del comentario.
 */
function cuerpoDe(toma, acciones, tarjeta, repetidos) {
    const cuerpo = document.createElement('div');
    cuerpo.className = 'toma-cuerpo';

    const columna = document.createElement('div');
    columna.className = 'toma-columna';

    if (acciones) {
        const nota = document.createElement('input');
        nota.className = 'toma-nota';
        nota.type = 'text';
        // "Comentar" a secas quedó ambiguo cuando aparecieron los comentarios
        // sobre un tramo del texto, que se piden con el mismo verbo y con un
        // botón que dice justo eso (`abrirCaja` en `margen.js`). Este campo es la
        // otra cosa: una nota sobre la toma entera, y el rótulo tiene que decir
        // sobre qué es antes de que alguien escriba en el sitio equivocado.
        nota.placeholder = 'Nota de toda la toma';
        nota.value = toma.comentario || '';
        // Al salir del campo y no en cada tecla: cada cambio reescribe el XML.
        nota.onchange = () => acciones.alCambiar({ tipo: 'nota', toma: toma.id, texto: nota.value });
        columna.append(nota);
    }

    // Los bordes se mueven igual con la clase abierta que cerrada: correrlos
    // dentro de las orillas guardadas es repartir de nuevo palabras que ya están,
    // no volver a oír (ver `moverBordeGuardado` en `engine/notas-vivo.js`).
    const texto = textoDe(toma, acciones);
    if (acciones) {
        bordeConElDerecho(texto, toma, acciones);
        comentarSeleccion(tarjeta, texto, acciones, toma.id);
    }
    // El clic sobre un tramo subrayado abre su comentario también en una clase
    // leída: mirar lo que alguien anotó no necesita poder escribir.
    margen.cablearTramos(texto, toma, acciones);
    // Y el aviso de repetición encima, después de los comentarios: una palabra
    // puede llevar las dos marcas y la de acá se suma a la que ya esté.
    empalme.marcarRepetidos(texto, repetidos);

    columna.append(texto);
    const alMargen = document.createElement('div');
    alMargen.className = 'toma-margen';
    cuerpo.append(columna, alMargen);
    return cuerpo;
}

/**
 * Seleccionar un pedazo del texto abre la caja para comentarlo, al margen.
 *
 * Se mira en el turno siguiente porque durante el `mouseup` la selección todavía
 * no está cerrada y sale vacía.
 */
function comentarSeleccion(tarjeta, texto, acciones, tomaId) {
    texto.onmouseup = () => {
        setTimeout(() => {
            const elegido = seleccion(texto);
            if (elegido) margen.abrirCaja(tarjeta, elegido, acciones, tomaId);
        }, 0);
    };
}

/* ─── La lista ───────────────────────────────────────────────────────────── */

/**
 * Las tarjetas que no se pueden rehacer, por id.
 *
 * Son dos cosas y las dos son **trabajo a medio hacer**, que es la regla entera:
 * lo que se rehace le cuesta a alguien algo que no puede recuperar. Una es el
 * campo donde se está escribiendo —la nota de la toma o el comentario nuevo—:
 * sacarlo del documento se lleva puesto el foco, y con el estado del motor
 * llegando cada tres segundos, comentar mientras la clase seguía era imposible,
 * porque a media frase el cursor se iba solo. La otra es la caja de un comentario
 * nuevo aunque el foco ya no esté en ella: lo escrito y el tramo subrayado que
 * dice sobre qué es siguen siendo trabajo que nadie guardó.
 *
 * Son varias y no una: se puede tener un comentario a medio escribir en la toma 2
 * y estar escribiendo la nota de la 5 al mismo tiempo.
 *
 * **Un botón con el foco no ocupa la tarjeta**, y esa distinción no es cosmética:
 * antes se miraba si la tarjeta contenía a `document.activeElement`, y Chromium le
 * da el foco al botón que se acaba de apretar. O sea que apretar "Descartar", una
 * vista o el triangulito del pliegue dejaba a su propia tarjeta marcada como
 * ocupada, y la tarjeta no se rehacía nunca: el cambio se escribía en el XML y en
 * la pantalla no pasaba nada hasta que alguien hiciera clic en otra parte. Perder
 * el foco de un botón que ya se apretó, en cambio, no se ve.
 *
 * **Y mirar un comentario viejo tampoco la ocupa**, que es el mismo defecto en
 * versión angosta: se miraba la clase `es-comentando`, y esa clase cubre las dos
 * maneras de tener el margen abierto —escribir uno nuevo y mostrar los que ya
 * están—. Solo la primera es trabajo a medio hacer; la segunda se rehace y se
 * vuelve a abrir encima (ver `reabrir` en `margen.js`), que cuesta un repintado
 * y no cuesta nada de nadie.
 */
function tarjetasOcupadas(donde) {
    const foco = document.activeElement;
    const escribiendo = foco && /^(INPUT|TEXTAREA)$/.test(foco.tagName) ? foco : null;
    const ocupadas = new Map();
    for (const tarjeta of donde.children) {
        if (!tarjeta.dataset || !tarjeta.dataset.toma) continue;
        if ((escribiendo && tarjeta.contains(escribiendo)) || margen.escribiendoEn(tarjeta)) {
            ocupadas.set(Number(tarjeta.dataset.toma), tarjeta);
        }
    }
    return ocupadas;
}

/**
 * Los comentarios que están abiertos al margen de las tarjetas que SÍ se rehacen.
 *
 * Se anotan antes de rehacer la lista y se vuelven a abrir después, sobre las
 * tarjetas nuevas: es lo que deja que un comentario siga abierto mientras su
 * toma se refresca. Las ocupadas no entran porque no se rehacen, así que su
 * margen sigue puesto y volver a abrirlo lo tiraría.
 *
 * @returns {Map<number, number[]>} id de toma → índices de sus comentarios
 */
function margenesAbiertos(donde, ocupadas) {
    const abiertos = new Map();
    for (const tarjeta of donde.children) {
        if (!tarjeta.dataset || !tarjeta.dataset.toma) continue;
        const id = Number(tarjeta.dataset.toma);
        if (ocupadas.has(id)) continue;
        const cuales = margen.abiertosDe(tarjeta);
        if (cuales.length) abiertos.set(id, cuales);
    }
    return abiertos;
}

/**
 * Deja la lista igual a `nuevas` sin sacar del documento lo que ya está bien.
 *
 * Rehacerla entera es una línea —`donde.textContent = ''`, que es lo que había—
 * y el problema es que sacar del documento el campo donde alguien está
 * escribiendo le quita el foco.
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

/**
 * Dibuja la lista entera de la clase en curso.
 *
 * **De la más vieja a la más nueva**, que es el orden en que la clase pasó: una
 * clase se lee como se dio, y mientras se graba lo que importa es lo último que se
 * dijo, o sea el final. Estuvo al revés y el argumento era que la que importa
 * mirar quedara arriba sin usar la barra; el precio era leer la clase de abajo
 * hacia arriba, que es lo que nadie hace con un texto. Que lo último quede a la
 * vista lo resuelve el scroll, que se pega al fondo solo (`pegado.js`).
 *
 * La tarjeta donde se está escribiendo —la nota, o un comentario nuevo— se queda
 * como está hasta que la suelten. O sea que su texto deja de crecer un rato: es a
 * propósito, porque quien está escribiendo está mirando lo que escribe, y a
 * cambio no se le mueve el suelo. Lo que se está oyendo sigue a la vista arriba,
 * en "Oyendo:".
 *
 * La que solo tiene un comentario viejo abierto al margen, en cambio, se rehace
 * como cualquiera y el margen se vuelve a abrir encima: mirar no es escribir, y
 * congelarla era lo que dejaba un cambio de vista invisible hasta cerrarla.
 *
 * @param {object|null} mirada { plegadas: Set<number>, sinDescartadas: boolean,
 *   alPlegar(id, plegada) }
 */
export function pintar(donde, estado, acciones, mirada) {
    vigilarElPulso(donde);
    // Con un gesto del mouse a medio hacer sobre la lista no se repinta.
    if (enMitadDeUnGesto(donde)) return;

    if (!estado || !estado.tomas.length) {
        const vacio = document.createElement('p');
        vacio.className = 'grabar-vacio';
        vacio.textContent = estado
            ? 'Todavía no hay tomas. La primera se abre cuando el profesor cuenta "3, 2, 1" o dice "Retomamos".'
            : 'Elegí la entrada de audio y la carpeta donde guardar, y apretá "Iniciar grabación".';
        acomodar(donde, [vacio]);
        return;
    }

    // Los tramos a subrayar salen de la lista entera y no de cada toma: el
    // empalme de la toma 3 subraya también el final de la 2, así que la tarjeta
    // de la 2 no puede armarlo sola. Se cuelgan del estado en una copia para no
    // escribirle encima al que mandó el motor.
    const conTramos = { ...estado, repetidos: empalme.tramosPorToma(estado.tomas) };
    const ocupadas = tarjetasOcupadas(donde);
    const abiertos = margenesAbiertos(donde, ocupadas);
    const alaVista = plegado.alaVista(estado.tomas, mirada);
    const tarjetas = alaVista.map(toma =>
        ocupadas.get(toma.id) || pintarToma(toma, conTramos, acciones, mirada));
    acomodar(donde, tarjetas);

    // Con las tarjetas ya colgadas del documento, y no antes: el margen pone cada
    // comentario a la altura de su tramo, y eso se mide; sin dibujar, todo mide
    // cero y las tarjetas se apilarían en el mismo alto.
    for (const [id, cuales] of abiertos) {
        const i = alaVista.findIndex(toma => toma.id === id);
        if (i >= 0) margen.reabrir(tarjetas[i], cuales, alaVista[i], acciones);
    }
}

/* ─── El pulso: nada se rehace debajo del puntero ─────────────────────────
 *
 * Un botón de vista apretado con la nota a medio escribir perdía el clic. El
 * `change` del campo sale del propio `mousedown` —al apretar, el campo pierde el
 * foco— y la respuesta del motor vuelve enseguida, así que el repintado caía
 * ENTRE el `mousedown` y el `mouseup`: el botón que recibió el primero ya no
 * estaba en el documento cuando llegó el segundo, y el navegador no dispara
 * ningún `click` si los dos no cayeron en el mismo nodo. La pantalla no mentía
 * —cada tarjeta seguía mostrando lo que decía el motor— y aun así el editor
 * apretaba y no pasaba nada.
 *
 * Es el mismo problema que ya tenía el arrastre de un borde con otro gesto: una
 * lista que se rehace debajo de la mano. Así que la respuesta es la que ya
 * estaba —no repintar mientras el gesto dure— y no un mecanismo nuevo que
 * intente conservar los nodos de abajo del puntero.
 *
 * Lo que se pierde es un repintado, no un cambio: el motor ya lo escribió, y lo
 * que se ve queda al día en el gesto siguiente o, como mucho, en el empujón que
 * llega tres segundos después. Es exactamente el precio que la guarda del
 * arrastre venía pagando.
 */

/** Si hay un botón del mouse apretado sobre la lista. */
let apretado = false;
const vigiladas = new WeakSet();

/**
 * Las dos maneras de preguntar lo mismo, y la segunda sigue haciendo falta.
 *
 * Un arrastre de borde ES un botón apretado, así que `apretado` lo cubre; pero
 * dura segundos y no milisegundos, y en el medio la ventana puede perder el foco
 * —un diálogo del sistema— y soltar el pulso sin que nadie haya soltado nada. La
 * línea en la mano lo dice por sí misma y no depende de eso.
 */
function enMitadDeUnGesto(donde) {
    return apretado || Boolean(donde.querySelector('.toma-borde.es-arrastrando'));
}

function vigilarElPulso(donde) {
    if (vigiladas.has(donde)) return;
    vigiladas.add(donde);
    // En captura, para que el pulso se encienda aunque el gesto lo atienda algo
    // de adentro; y solo el botón principal, porque el clic derecho abre un
    // diálogo del sistema y su `pointerup` puede no volver nunca.
    donde.addEventListener('pointerdown', e => { if (e.button === 0) apretado = true; }, true);
    // El final se escucha en la ventana y no en la lista por lo mismo que el del
    // arrastre (`empezarAMover` en `palabras.js`): se puede soltar afuera, y un
    // gesto que nunca se diera por terminado congelaría la lista para siempre.
    const soltar = () => { apretado = false; };
    for (const fin of ['pointerup', 'pointercancel']) window.addEventListener(fin, soltar);
    window.addEventListener('blur', soltar);
}
