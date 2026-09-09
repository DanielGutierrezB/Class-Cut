'use strict';
/**
 * grabar/index.js — El paso "Grabar", cableado.
 *
 * Lo que hace de verdad es poco, y es a propósito: abre el micrófono
 * (`oido.js`), le manda el audio al motor (`engine/grabacion.js`) y dibuja lo
 * que el motor conteste (`tomas.js`). Ninguna decisión sobre las tomas se toma
 * acá — ni cuándo se abren, ni dónde caen sus bordes, ni qué se escribe— porque
 * eso vive del lado que escribe el XML, y con dos dueños lo que se ve y lo que
 * se guarda podrían no ser lo mismo.
 *
 * La única decisión que sí es de acá es cuál es la entrada de audio, que es lo
 * único que la ventana puede saber.
 */

import { $, showView, toast, anotar, estaEscribiendo, recordar, recordado, olvidar } from '../chrome.js';
import { fmtHora, plural } from '../formato.js';
import { marcarPaso, PASOS } from '../pasos.js';
import * as oido from './oido.js';
import * as ojo from './ojo.js';
import * as tomas from './tomas.js';
import * as grabadas from './grabadas.js';
import * as pantallas from './pantallas.js';
import * as analisis from './analisis.js';
import * as pegado from './pegado.js';
import * as plegado from './plegado.js';
import * as margen from './margen.js';
import { comoSeLlama, dosDigitos, nombreDeCarpeta, numeroLeido } from './gestionar.js';
import { queHace, tomaDeLasTeclas, puedeElegirse } from './teclas.js';
import { mostrador, esDeLaQueTermino } from './turnos.js';

/**
 * Lo que la ventana recuerda por su cuenta: la última entrada de audio elegida,
 * que el id del dispositivo lo da el navegador. La carpeta de notas NO: esa la
 * necesita también el escáner de post, así que vive en los ajustes
 * (`ajustes.notasDir`) y tiene un solo dueño. Y cómo se quiere ver la lista de lo
 * grabado se guarda del lado de la lista, que es de quien es (`grabadas.js`).
 */
const ENTRADA_RECORDADA = 'cc.grabar.entrada';
/**
 * La clave de siempre, y se hereda.
 *
 * Hubo un momento en que este interruptor escondía el TEXTO ENTERO de cada toma,
 * y ahí se le puso una clave nueva (`cc.grabar.transcript`) con el argumento de
 * que quien dejó apagado el viejo no había pedido quedarse sin el guion. El
 * argumento era bueno y ya no aplica: el interruptor volvió a ser el que era
 * —esconde el gris de las orillas y nada más—, así que lo que alguien guardó
 * significa hoy exactamente lo que significaba cuando lo guardó, y no heredarlo
 * sería tirar su elección sin motivo.
 *
 * Se sigue llamando por lo que guarda y no por cómo se llama el botón: "Compact"
 * es la etiqueta de ahora, las orillas son la preferencia. Si mañana el botón se
 * llama de otro modo, la clave no se muda.
 */
const ORILLAS_RECORDADAS = 'cc.grabar.orillas';
/**
 * Y la clave de en medio se tira.
 *
 * Su "no" quería decir "sin transcript", que es otra pregunta: heredarla dejaría
 * sin guion a quien solo había pedido quedarse sin el gris. Se borra en vez de
 * ignorarse para que no quede dando vueltas.
 */
const TRANSCRIPT_VIEJO = 'cc.grabar.transcript';
// Si las tomas descartadas se ven. Esto SÍ se guarda entre sesiones, al contrario
// que el pliegue de una toma: es una forma de trabajar —"a mí las descartadas no
// me interesan"— y vale para todas las clases, mientras que plegar la toma 3 es
// una decisión sobre la toma 3 de esta clase (ver `plegado.js`).
const DESCARTADAS_RECORDADAS = 'cc.grabar.descartadas';

const vista = {
    estado: null,
    // Las vistas que se le pueden poner a una toma. Vienen con el estado mientras
    // se graba, pero una clase terminada también las cambia y ahí no hay estado.
    vistas: [],
    // Si el texto se ve compacto: sin las palabras de orilla, o sea sin el gris de
    // antes del IN y después del OUT. Apagado por defecto —las orillas se ven—
    // porque es contra ese gris que se arrastra un borde: sin él, correr el IN es
    // adivinar qué frase entra.
    compacto: recordado(ORILLAS_RECORDADAS) === 'no',
    // Cómo se está mirando la lista de la clase en curso. No va al motor: no es
    // algo que se le hizo a la clase (ver `tomas.js`).
    plegadas: new Set(),
    // La toma que se eligió con un clic, sobre la que caen P, R, S, M y X. `null`
    // es "ninguna", y entonces manda la abierta (ver `tomaDeLasTeclas`). Como el
    // pliegue, es cómo se está mirando la lista y no algo que se le hizo a la
    // clase: no va al motor ni se guarda entre sesiones.
    elegida: null,
    sinDescartadas: recordado(DESCARTADAS_RECORDADAS) === 'si',
    // El scroll pegado al fondo, cableado al entrar (`pegado.js`).
    fondo: null,
    // El golpe que se oyó y todavía no se leyó.
    aplauso: null,
    // "Terminar" apretado y esperando a que el motor relea las últimas tomas.
    terminando: false,
    // La secuencia de la clase que ya se cerró. Sirve para tirar los avisos que
    // llegan después de terminarla, que si no la resucitan (`esDeLaQueTermino`).
    terminada: null,
    // La lista del CD guardada para la carpeta elegida, `{dir, temario}`. Es lo
    // único que el bloque de cobertura tiene para mostrar cuando no hay sesión, y
    // sin sesión es como se entra a esta pantalla (ver `releerElTemario`).
    temario: null,
    cableado: false
};

/** El curso es la carpeta: una carpeta de notas por curso. */
function curso() {
    return nombreDeCarpeta(grabadas.carpeta());
}

/** El número que está escrito en el campo. */
function claseElegida() {
    return numeroLeido($('grabar-clase').value);
}

/**
 * Qué número proponer al entrar o al cambiar de carpeta: el que sigue al mayor
 * que haya en ella, o el 1 si está vacía.
 *
 * Es una propuesta y nada más — se escribe encima sin más—, así que se calcula
 * con la lista que la pantalla ya tiene en la mano en vez de preguntarle al
 * motor. Quién manda de verdad es el motor, que lo recalcula contra el disco al
 * arrancar (ver `parteQueSigue` en `engine/grabacion.js`).
 */
function proponerClase() {
    const numeros = grabadas.deLaCarpeta().map(c => Number(c.clase) || 0);
    $('grabar-clase').value = dosDigitos(numeros.length ? Math.max(...numeros) + 1 : 1);
    pintarParte();
}

/**
 * Si ese número ya se usó en esta carpeta, esto va a ser otra tanda de la misma
 * clase, y se dice mientras se escribe.
 *
 * Es lo que el editor necesita ver antes de apretar "Iniciar": que volver a
 * poner el 01 no pisa nada, abre la parte 2. El número que se muestra puede
 * quedar viejo si algo grabó por fuera; el que se escribe en el archivo lo
 * decide el motor.
 */
function pintarParte() {
    const cuantas = grabadas.deLaCarpeta().filter(c => Number(c.clase) === claseElegida()).length;
    const marca = $('grabar-parte');
    marca.hidden = cuantas === 0;
    marca.textContent = `parte ${cuantas + 1}`;
    marca.title = `Ya hay ${cuantas} grabación de esta clase en la carpeta: ` +
        'esta queda como una tanda más, con su propio XML.';
}

/**
 * Volver a la lista, y por qué no se puede todavía.
 *
 * El motivo va en el `title` y el botón queda apagado, que es la forma de esta
 * pantalla de decir "no ahora": el mismo par de "Cerrar acá" cuando no hay toma
 * abierta. Apagado y muDo sería lo único inaceptable — quien aprieta y no ve nada
 * no tiene de dónde deducir que le falta terminar (ver `pantallas.js`).
 */
function refrescarVolver() {
    const boton = $('grabar-volver');
    const porque = pantallas.porQueNoSeVuelve(vista.estado, vista.terminando);
    boton.disabled = Boolean(porque);
    boton.title = porque || 'Volver a la lista de clases de la carpeta';
}

/** Se puede arrancar cuando hay entrada abierta y carpeta elegida. */
function refrescarBotones() {
    const grabando = Boolean(vista.estado && vista.estado.grabando);
    refrescarVolver();
    // Cerrar la toma a mano: solo si hay una abierta que cerrar.
    $('grabar-cerrar-toma').hidden = !grabando;
    $('grabar-cerrar-toma').disabled = !(vista.estado && vista.estado.abierta) || vista.terminando;
    $('grabar-iniciar').disabled = grabando || !oido.escuchando() || !grabadas.carpeta();
    $('grabar-iniciar').hidden = grabando;
    $('grabar-terminar').hidden = !grabando;
    $('grabar-terminar').disabled = vista.terminando;
    $('grabar-terminar').textContent = vista.terminando ? 'Terminando…' : 'Terminar';
    // La claqueta a mano está desde el primer segundo de la grabación: no hay que
    // esperar a que el motor oiga nada. Antes de "Iniciar" no hay a qué referirla.
    $('grabar-claqueta-ahora').disabled = !grabando || vista.terminando;
    // Cambiar de clase o de carpeta a mitad de una grabación renombraría el
    // archivo que se está escribiendo.
    $('grabar-clase').disabled = grabando;
    // Sin entradas el selector solo tiene el cartel de "no hay": nada que elegir.
    // Refrescar tampoco es de mitad de grabación: reabriría la entrada.
    $('grabar-entrada').disabled = grabando || !$('grabar-entrada').value;
    $('grabar-entradas').disabled = grabando;
    $('grabar-curso').textContent = grabadas.carpeta() ? curso() : '—';
}

/**
 * Dónde caen las notas, con la ruta que el motor va a escribir de verdad.
 *
 * Esto decía la carpeta y el nombre del XML pelado, y quedó mintiendo cuando el
 * XML bajó un piso a `xml/`: el editor iba a buscarlo a la raíz de la carpeta y
 * no estaba. La ruta llega armada desde el motor (`archivos` en el resumen) y no
 * se compone acá a propósito — la forma de esa carpeta la decide `workspace.js`,
 * y escribir «xml» en la ventana sería tener el mismo dato en dos sitios que
 * pueden discrepar.
 *
 * De la ruta se muestra solo lo que le cuelga a la carpeta: repetida entera son
 * cuarenta caracteres dos veces en el mismo renglón, y un cartel de dos líneas
 * no lo lee nadie.
 */
function decirDonde() {
    const donde = $('grabar-donde');
    const carpeta = grabadas.carpeta();
    if (!carpeta) {
        donde.textContent = 'Volvé a la lista y elegí la carpeta del curso: ahí caen las notas. ' +
            'No puede ser la tarjeta del Rodecaster, que no está en la Mac hasta que la ' +
            'grabación termina.';
        donde.className = 'grabar-donde es-falta';
        return;
    }
    const xml = vista.estado && vista.estado.archivos ? vista.estado.archivos.xml : '';
    const archivo = xml ? ` · ${colgandoDe(carpeta, xml)}` : '';
    donde.textContent = `Se guarda en ${carpeta}${archivo}`;
    donde.className = 'grabar-donde';
}

/** Lo que le cuelga a la carpeta. Una ruta de otro sitio se muestra entera. */
function colgandoDe(carpeta, ruta) {
    return ruta.startsWith(`${carpeta}/`) ? ruta.slice(carpeta.length + 1) : ruta;
}

function pintarClaqueta() {
    const caja = $('grabar-claqueta');
    const que = $('grabar-claqueta-que');
    const c = vista.estado && vista.estado.claqueta;

    if (!vista.estado || !vista.estado.grabando) { caja.hidden = true; return; }
    caja.hidden = false;

    if (!c) {
        que.textContent = vista.aplauso
            ? `Se oyó un golpe a las ${fmtHora(vista.aplauso)}: estoy leyendo qué se dijo.`
            : 'Todavía no hay claqueta: apretá «Claqueta» cuando el director aplauda, o esperá a que la oiga.';
        caja.classList.remove('es-lista');
        return;
    }
    caja.classList.toggle('es-lista', Boolean(c.confirmada));
    const como = c.origen === 'editor' ? ' · puesta a mano' : (c.frase ? ` · «${c.frase}»` : '');
    que.textContent = c.confirmada
        ? `Claqueta a las ${fmtHora(c.ms)}${como}. En post se ajusta sola contra el audio.`
        : `Golpe a las ${fmtHora(c.ms)} sin confirmar: no se oyó "clase" alrededor${como}`;
}

/** La línea de arriba de la clase en curso: cuál es y desde cuándo. */
function pintarEnCurso() {
    const cabeza = $('grabar-en-curso-cabeza');
    const e = vista.estado;
    cabeza.hidden = !(e && e.grabando);
    if (cabeza.hidden) return;
    cabeza.textContent = '';
    const titulo = document.createElement('strong');
    titulo.textContent = comoSeLlama(e) + (e.curso ? ` · ${e.curso}` : '');
    const desde = document.createElement('span');
    desde.className = 'clase-dato';
    desde.textContent = `grabando desde ${fmtHora(e.ceroMs)} · ${plural(e.tomas.length, 'toma', 'tomas')}`;
    cabeza.append(titulo, desde);
}

/**
 * "Compact": apagar las palabras de orilla, para toda la pantalla de una vez.
 *
 * Apaga SOLO el pre y el post —el gris de antes del IN y después del OUT— y deja
 * el guion de la toma entero. Estuvo un rato escondiendo el texto completo y era
 * un error: de la toma quedaban la cabecera y la nota, o sea que la pantalla se
 * leía pero no se trabajaba, porque es sobre el texto que se comenta un pedazo y
 * se arrastra un borde. Compacto quiere decir "sin lo que no es de esta toma".
 *
 * Es una clase en la vista entera y no un cambio en lo que se dibuja: son las
 * mismas palabras dibujadas siempre, así que apagarlas es CSS y encenderlas de
 * nuevo no cuesta nada ni pide releer nada. Que las palabras sigan en el
 * documento es lo que deja que un tramo subrayado que cae en una orilla siga
 * existiendo mientras está escondido, y que al volver a encender esté donde
 * estaba.
 *
 * Vale igual para la clase en curso y para las ya grabadas: el interruptor habla
 * de las orillas, no de las orillas de esta clase.
 */
function pintarCompacto() {
    $('view-grabar').classList.toggle('es-compacto', vista.compacto);
    // Hay uno en cada barra, porque hay dos pantallas y las orillas se leen en las
    // dos. Es un interruptor con dos manijas, no dos interruptores: el estado y la
    // preferencia son los mismos, así que los dos se pintan juntos.
    for (const boton of document.querySelectorAll('.grabar-compact')) {
        boton.setAttribute('aria-pressed', String(vista.compacto));
        boton.classList.toggle('is-elegido', vista.compacto);
    }
}

/**
 * El interruptor de las descartadas, con la cuenta puesta.
 *
 * Escondidas dice cuántas son, por lo mismo que la lista de clases grabadas dice
 * cuántas tiene al plegarse: un botón que las saca sin decir cuántas sacó se lee
 * como que se perdieron.
 */
function pintarDescartadas() {
    const cuantas = vista.estado ? plegado.cuantasDescartadas(vista.estado.tomas) : 0;
    const boton = $('grabar-descartadas');
    boton.hidden = !cuantas && !vista.sinDescartadas;
    boton.setAttribute('aria-pressed', String(vista.sinDescartadas));
    boton.classList.toggle('is-elegido', vista.sinDescartadas);
    boton.textContent = vista.sinDescartadas
        ? `Descartadas escondidas (${cuantas})`
        : 'Ocultar descartadas';
}

/** Los dos botones de la barra que dicen qué van a revertir antes de apretarlos. */
function pintarHistoria() {
    const h = (vista.estado && vista.estado.historia) || { atras: 0, adelante: 0 };
    const atras = $('grabar-deshacer');
    const adelante = $('grabar-rehacer');
    atras.disabled = !h.atras;
    adelante.disabled = !h.adelante;
    atras.title = h.atras ? `Deshacer: ${h.queAtras} (Cmd-Z)` : 'No hay nada que deshacer';
    adelante.title = h.adelante ? `Rehacer: ${h.queAdelante} (Cmd-Shift-Z)` : 'No hay nada que rehacer';
}

/**
 * Plegar o desplegar una toma.
 *
 * En una función con nombre y no dentro de `mirada` porque se pide desde dos
 * sitios: el triangulito de su cabezal (`tomas.js`) y el clic en el cabezal
 * (`wireGrabar`). Es el mismo pliegue, así que tiene que ser el mismo camino.
 */
function plegar(id, plegada) {
    if (plegada) {
        // Un comentario abierto al margen de una toma que se pliega se iría con
        // ella y quedaría marcado como abierto para siempre.
        margen.cerrarTodos($('grabar-tomas'));
        vista.plegadas.add(id);
    } else {
        vista.plegadas.delete(id);
    }
    pintar();
}

/** Cómo se está mirando la lista, que es lo único que la lista guarda de su lado. */
function mirada() {
    return {
        plegadas: vista.plegadas,
        sinDescartadas: vista.sinDescartadas,
        alPlegar: plegar
    };
}

/* ─── La toma elegida ────────────────────────────────────────────────────
 *
 * Las teclas de vista actuaban siempre sobre la toma abierta, y "la toma activa"
 * quería decir dos cosas: la que está grabando y la que estoy mirando. Con
 * cuatro tomas en pantalla, hacer clic en la cabecera de la 1 y apretar M
 * cambiaba la 4, que es la sorpresa que esta pantalla no puede tener.
 *
 * Así que hay una elegida de verdad, y se elige como se elige cualquier cosa: con
 * un clic. Por defecto no hay ninguna y manda la abierta, o sea que quien no se
 * enteró de que esto existe sigue trabajando igual.
 *
 * **Y se ve cuál es.** Un atajo que actúa sobre algo invisible es el mismo
 * defecto de antes con otra ropa, así que la marca no es opcional: la tarjeta
 * sobre la que caen las teclas lleva un anillo y la palabra "teclas"
 * (`.toma.es-elegida` en `grabar-teclas.css`), la haya elegido alguien o sea la
 * abierta por defecto. Y cuando la tecla cae sobre una elegida a mano, un aviso
 * dice en qué toma cayó: la abierta la tiene a la vista el scroll pegado al
 * fondo, y una elegida hace veinte minutos puede estar arriba, fuera de la
 * pantalla.
 */

/**
 * Un clic en cualquier parte de una tarjeta elige su toma.
 *
 * En cualquier parte y no solo en la cabecera: lo que el gesto quiere decir es
 * "esta", y pedir un sitio exacto dentro de la ficha sería un atajo con
 * instrucciones. Vale también el clic que termina de seleccionar un pedazo de
 * texto para comentarlo: la toma que se está leyendo es justamente la toma sobre
 * la que se está trabajando, así que seleccionar no le quita el sentido al gesto.
 *
 * Un id que no puede elegirse —una descartada, una que ya no está— no se guarda:
 * deja de haber elegida y las teclas vuelven a la abierta.
 */
function elegir(id) {
    vista.elegida = puedeElegirse(vista.estado, id) ? id : null;
    marcarElegida();
}

/**
 * La toma del estado, para preguntarle si se puede plegar. Null si el clic cayó
 * sobre una tarjeta de un repintado que el estado ya dejó atrás.
 */
function laToma(id) {
    return ((vista.estado && vista.estado.tomas) || []).find(t => t.id === id) || null;
}

/* ─── El mismo clic dice dos cosas ───────────────────────────────────────
 *
 * Un clic en una tarjeta ya elegía su toma; ahora, en el cabezal, además la
 * pliega. O sea que el gesto quiere decir dos cosas a la vez, y **no se
 * reparten: las dos pasan.** El argumento es que no son dos intenciones sino una
 * dicha una vez. Elegir contesta "sobre esta toma", y plegarla es justamente
 * trabajar sobre esa toma: quien la pliega la acaba de mirar y decidir que ya no
 * necesita verla abierta. Repartir el clic —que el cabezal plegara y NO eligiera—
 * sería peor de las dos maneras posibles: dejaría el cabezal como el único sitio
 * de la ficha donde el clic no dice "esta", y le daría al mismo gesto dos
 * significados según en qué píxel cayó, que es lo que nadie puede aprender.
 *
 * Dónde molesta, porque hay un caso. Plegar sirve para ir limpiando la vista, y
 * limpiar son cinco pliegues seguidos: al terminar, las teclas quedan apuntando a
 * la última toma vieja que se plegó y no a la que está grabando. Apretar R ahí
 * cambia la vista de una toma de hace veinte minutos.
 *
 * Se aguanta, y no por descuido: es el mismo caso que ya existía —hacer clic en
 * cinco tarjetas para leerlas también dejaba la elección en la última—, se VE
 * —la ficha elegida lleva el anillo y el "· teclas", plegada incluida— y se
 * deshace con un clic en la que se quiera. Lo que no se puede hacer es lo
 * contrario: que plegar SUELTE la elección y la devuelva a la abierta. Sonaba
 * razonable —"plegar es decir 'con esta ya terminé'"— y convierte un gesto en dos
 * según el estado de la ficha: el mismo clic elegiría al desplegar y deselegiría
 * al plegar, y la marca se movería sola en una de las dos direcciones sin que
 * nadie la haya movido.
 *
 * Y la marca sobrevive al pliegue, que es la condición para todo lo anterior:
 * `es-elegida` cuelga de la ficha y el "· teclas" del número, los dos en el
 * cabezal, que es lo único que queda de una ficha plegada (`grabar-teclas.css`).
 * Una toma elegida y plegada sigue diciendo que ahí caen P, R, S, M y X — y tiene
 * que decirlo, porque sus cinco botones de vista siguen puestos en el cabezal:
 * plegada se le puede seguir cambiando la vista, con la tecla y con el botón.
 */

/**
 * Dónde cayó el clic, en lo que `elClicPliega` necesita saber.
 *
 * Los controles se preguntan por lo que SON y no por una lista de clases: en el
 * cabezal hay hasta seis botones —las cinco vistas, "Descartar" o "Cerrar acá",
 * "Reabrir", "Eliminar", "Recuperar"— y el que se agregue mañana tiene que quedar
 * cubierto sin que nadie se acuerde de venir a anotarlo acá. El grupo de vistas
 * va aparte de sus botones porque es un `<div>` con `role="radiogroup"`: un clic
 * en el filo entre dos celdas cae en el grupo y no en ninguna de las dos.
 */
function formaDelClic(e) {
    return {
        enCabezal: Boolean(e.target.closest('.toma-cabeza')),
        enControl: Boolean(e.target.closest('button, input, select, textarea, label, a, .toma-vistas'))
    };
}

/**
 * Marca la toma sobre la que caen las teclas, y suelta la elección que se quedó
 * sin toma.
 *
 * **La marca va sobre la toma que las teclas van a tocar de verdad, elegida a
 * mano o no.** Puesta solo cuando alguien hizo clic, la pantalla no diría nada
 * hasta que se descubriera que esto existe, y el caso más común —nadie eligió
 * nada, manda la abierta— seguiría siendo un atajo sin destino visible. Así, la
 * marca se lee siempre igual: "acá cae lo próximo que aprietes", y se aprende
 * sola al ver que se muda con el clic.
 *
 * Y solo mientras se graba, porque es cuando las teclas de vista hacen algo (ver
 * `queHace`): marcar una toma de una clase terminada prometería un atajo que no
 * va a contestar.
 *
 * Soltar la elección vieja va acá, junto con la marca, y no es de paso: la
 * elegida se puede haber descartado, eliminado o ido con la sesión que terminó, y
 * lo que la tecla toca y lo que la pantalla muestra tienen que dejar de apuntarle
 * en el mismo momento.
 *
 * La marca se pone desde acá y no en `tomas.js` porque es de la ventana y no de
 * la toma: la tarjeta se dibuja igual, y lo que se le agrega es una clase encima
 * de las que ya tiene.
 */
function marcarElegida() {
    if (!puedeElegirse(vista.estado, vista.elegida)) vista.elegida = null;
    const grabando = Boolean(vista.estado && vista.estado.grabando);
    const cual = grabando ? tomaDeLasTeclas(vista.estado, vista.elegida) : null;
    for (const tarjeta of $('grabar-tomas').querySelectorAll('.toma')) {
        const suya = cual != null && Number(tarjeta.dataset.toma) === cual;
        tarjeta.classList.toggle('es-elegida', suya);
        if (suya) tarjeta.setAttribute('aria-current', 'true');
        else tarjeta.removeAttribute('aria-current');
    }
}

function pintar() {
    pintarEnCurso();
    tomas.pintar($('grabar-tomas'), vista.estado, acciones, mirada());
    marcarElegida();
    pintarCompacto();
    pintarDescartadas();
    pintarHistoria();
    analisis.pintar($('grabar-analisis'), vista.estado, vista.temario);
    pintarClaqueta();
    decirDonde();
    refrescarBotones();
    // Lo último de todo: el salto al fondo se mide sobre la lista ya dibujada, y
    // esta pantalla repinta varias cosas que le cambian el alto.
    if (vista.fondo) vista.fondo.alPintar();
}

/**
 * Relee la lista del CD guardada para la carpeta elegida.
 *
 * **Es lo que el panel de cobertura muestra cuando no hay sesión**, que es como
 * se entra a la toma de notas: la lista se pega antes de "Iniciar grabación" —es
 * cuando el editor la tiene en la mano— y vive en la carpeta, porque la carpeta
 * es el curso y el CD entrega una lista por curso (`engine/temario-sesion.js`).
 *
 * Se relee al entrar al paso, al entrar a la toma de notas y al terminar una
 * clase, que son los tres momentos en que puede haber cambiado la carpeta o
 * haberse soltado la sesión que la tapaba.
 */
async function releerElTemario() {
    const dir = grabadas.carpeta();
    vista.temario = { dir, temario: dir ? await window.cc.grabarTemarioCarpeta(dir) : null };
}

/**
 * Relee la lista y deja propuesto el número que sigue.
 *
 * El número sale de lo que hay en la carpeta, así que se propone cuando se elige
 * una y cuando termina una clase; escribir uno a mano no se pisa.
 */
async function releerLaLista() {
    if (await grabadas.cargar()) proponerClase();
    else pintarParte();
}

/**
 * Clic derecho sobre una palabra: cuál de los dos bordes va ahí.
 *
 * **Pregunta, no adivina**, y eso es lo que tiene que seguir siendo cierto: los
 * dos gestos cuestan lo mismo, y el de abrir sirve justo cuando el conteo se comió
 * la primera palabra de la clase. Adivinar por la distancia al borde más cercano
 * fallaría exactamente ahí, que es el caso por el que esto existe.
 *
 * Está aparte de quien lo usa porque lo usan dos —la clase en curso y una ya
 * grabada— y la pregunta tiene que ser la misma: lo que cambia es a qué archivo va
 * el cambio, no el gesto. Y vale igual en la toma abierta y en las anteriores, con
 * una diferencia que sí hay que decir: la abierta todavía no tiene OUT, así que
 * poner uno ahí es cerrarla en esa palabra. Se lo dice el rótulo, porque "Cortar
 * el OUT acá" no deja ver que la toma se termina.
 *
 * @param {boolean} abierta si la toma todavía no tiene OUT
 * @returns {'in'|'out'|null} null si se canceló
 */
async function preguntarBorde(toma, paredMs, abierta) {
    const cual = await window.cc.preguntar({
        titulo: `Mover un borde de la toma ${toma}`,
        mensaje: `A las ${fmtHora(paredMs)}, que es donde está esa palabra.`,
        opciones: [
            abierta ? 'Cerrar la toma acá (el OUT)' : 'Cortar el OUT acá',
            'Abrir el IN acá'
        ]
    });
    if (cual < 0) return null;
    return cual === 0 ? 'out' : 'in';
}

/**
 * El mostrador de turnos de esta pantalla.
 *
 * Todo lo que le pide un cambio al motor saca turno antes de salir y, al volver,
 * pregunta si mientras tanto ya se guardó una respuesta más nueva. La de por qué
 * hace falta está en `turnos.js`; el resumen es que dos pedidos en vuelo pueden
 * contestar al revés y la respuesta vieja no trae el cambio de la nueva.
 */
const respuestas = mostrador();

/** Todo cambio pasa por el motor y se repinta con lo que conteste. */
const acciones = {
    alCambiar: async cambio => {
        const turno = respuestas.tomar();
        const estado = await window.cc.grabarEditar(cambio);
        // Eliminar es la única que saca algo de la pantalla, así que es la única
        // que necesita decir que se puede volver: el resto se ve. Se avisa antes
        // de mirar el turno porque el cambio se hizo igual: lo que puede estar
        // viejo es la foto que volvió, no lo que pasó.
        if (cambio.tipo === 'eliminar') toast(`Toma ${cambio.toma} eliminada. Cmd-Z la devuelve.`);
        if (respuestas.atrasada(turno)) return;
        vista.estado = estado;
        pintar();
    },
    alCerrar: async () => {
        const turno = respuestas.tomar();
        const estado = await window.cc.grabarCerrarToma();
        if (respuestas.atrasada(turno)) return;
        vista.estado = estado;
        pintar();
    },
    /** Clic derecho sobre una palabra de la clase en curso (`preguntarBorde`). */
    alBorde: async ({ toma, paredMs, abierta }) => {
        const borde = await preguntarBorde(toma, paredMs, abierta);
        if (!borde) return;
        const turno = respuestas.tomar();
        const estado = await window.cc.grabarEditar({ tipo: 'borde', toma, borde, paredMs });
        anotar('grabar.borde', { toma, borde });
        if (respuestas.atrasada(turno)) return;
        vista.estado = estado;
        pintar();
    }
};

/* ─── Deshacer y rehacer ──────────────────────────────────────────────────
 *
 * El historial NO está acá, y es la decisión más importante de esta tanda. Está
 * en el motor (`engine/deshacer.js`), porque cada cambio de esta pantalla
 * reescribe el XML y el sidecar en el mismo gesto: un deshacer que arreglara la
 * lista dejaría el archivo con el cambio puesto, y entonces lo que se ve y lo que
 * va a abrir Premiere dirían cosas distintas.
 *
 * O sea que el de la revisión de cortes (`src/js/visor/estado.js`) no se pudo
 * reusar tal cual, aunque la forma sea la misma —dos pilas, un rótulo de qué se
 * hizo, un tope de sesenta y el mismo atajo—: allá la verdad es la ventana hasta
 * que alguien aprieta "Guardar", así que copiar `rev.segments` alcanza. Lo que sí
 * se reusó es todo lo que se podía reusar sin mudar la verdad de sitio: el gesto,
 * el aviso que dice QUÉ se deshizo y no solo que algo pasó, y la regla de que
 * adentro de un campo de texto manda el deshacer del texto.
 */

/** @param {'atras'|'adelante'} hacia */
async function volverAtras(hacia) {
    const turno = respuestas.tomar();
    const r = hacia === 'adelante'
        ? await window.cc.grabarRehacer()
        : await window.cc.grabarDeshacer();
    // Dos Cmd-Z seguidos son dos pedidos en vuelo, igual que dos clics: la
    // respuesta que llega atrasada deja la pantalla un paso más adelante de lo
    // que el motor ya deshizo. Lo que se dice —qué se deshizo, o por qué no se
    // pudo— se dice igual: eso pasó, la que puede estar vieja es la foto.
    const vieja = respuestas.atrasada(turno);
    if (r.estado && !vieja) vista.estado = r.estado;

    if (r.error) { toast(r.error); pintar(); return; }
    if (!r.ok) {
        toast(hacia === 'adelante' ? 'No hay nada que rehacer.' : 'No hay nada que deshacer.');
        pintar();
        return;
    }
    // Un comentario abierto al margen puede ser el que se acaba de deshacer.
    margen.cerrarTodos($('grabar-tomas'));
    anotar(hacia === 'adelante' ? 'grabar.rehace' : 'grabar.deshace', { que: r.que });
    toast(`${hacia === 'adelante' ? 'Rehecho' : 'Deshecho'}: ${r.que}.`);
    pintar();
}

/**
 * Llena el selector con las entradas que haya y devuelve la lista.
 *
 * Deja elegida la que ya lo estaba si sigue apareciendo, y si no la que se usó
 * la última vez. Abrirla es de quien llama: volver a preguntar qué hay no tiene
 * por qué cortar el audio que ya está sonando.
 */
async function llenarEntradas() {
    const select = $('grabar-entrada');
    const puesta = select.value;
    const { ok, error, lista } = await oido.entradas();
    select.textContent = '';

    if (!ok || !lista.length) {
        const op = document.createElement('option');
        op.textContent = ok ? 'No hay entradas de audio' : error;
        select.append(op);
        return [];
    }

    for (const entrada of lista) {
        const op = document.createElement('option');
        op.value = entrada.id;
        op.textContent = entrada.nombre;
        select.append(op);
    }
    const sigue = [puesta, recordado(ENTRADA_RECORDADA)].find(id => id && lista.some(e => e.id === id));
    if (sigue) select.value = sigue;
    return lista;
}

/** Al entrar al paso: la lista, y sonando la entrada que se usó la última vez. */
async function cargarEntradas() {
    const lista = await llenarEntradas();
    if (lista.length) await abrirEntrada($('grabar-entrada').value);
    refrescarBotones();
}

/**
 * "Refrescar": volver a preguntar qué entradas hay.
 *
 * Los dispositivos se preguntan una sola vez, al entrar al paso, así que algo
 * enchufado después —el Rodecaster, minutos antes de grabar— no aparece solo.
 * Esto evita tener que cerrar la app por eso.
 *
 * La que está sonando no se toca si sigue estando: reabrirla cortaría el medidor
 * por un segundo sin ninguna razón. Se abre solo si no había ninguna o si la que
 * había se fue.
 */
async function refrescarEntradas() {
    const antes = new Set([...$('grabar-entrada').options].map(o => o.value));
    const lista = await llenarEntradas();
    const nuevas = lista.filter(e => !antes.has(e.id));
    const elegida = $('grabar-entrada').value;

    if (lista.length && (!oido.escuchando() || oido.comoSuena().dispositivo !== elegida)) {
        await abrirEntrada(elegida);
    }
    refrescarBotones();
    // El mismo botón vuelve a preguntar por las cámaras: es la misma pregunta
    // —qué se enchufó desde que abrimos— y dos botones "Refrescar" en la misma
    // barra obligarían a leer cuál es cuál.
    await ojo.refrescar();
    anotar('grabar.entradas', { cuantas: lista.length, nuevas: nuevas.length });
    toast(nuevas.length
        ? `Apareció ${nuevas.map(e => e.nombre).join(', ')}.`
        : `Sin novedad: ${plural(lista.length, 'entrada', 'entradas')}.`);
}

/**
 * Abre una entrada y la deja sonando en el medidor YA, sin esperar "Iniciar
 * grabación".
 *
 * Es para ver que el Rodecaster está llegando ANTES de comprometerse: descubrir
 * que el cable estaba en la entrada equivocada después de la primera toma es lo
 * que esto evita. El audio, en cambio, se escribe recién desde "Iniciar" —antes
 * no hay a qué referirlo— y la claqueta llega siempre después de ese botón
 * (ver `oido.js`).
 */
async function abrirEntrada(deviceId) {
    const r = await oido.abrir(deviceId, {
        alNivel: nivel => {
            $('grabar-nivel-barra').style.width = `${Math.min(100, Math.round(nivel * 140))}%`;
        },
        alCaerse: () => {
            toast('Se desconectó la entrada de audio. Lo grabado está a salvo.');
            $('grabar-nivel').classList.add('es-caido');
            refrescarBotones();
        }
    });
    if (!r.ok) { toast(r.error); return; }
    $('grabar-nivel').classList.remove('es-caido');
    recordar(ENTRADA_RECORDADA, deviceId || '');
    refrescarBotones();
}

async function iniciar() {
    const como = oido.comoSuena();
    const r = await window.cc.grabarIniciar({
        dir: grabadas.carpeta(),
        clase: claseElegida(),
        curso: curso(),
        sampleRate: como.sampleRate,
        canales: como.canales,
        dispositivo: $('grabar-entrada').selectedOptions[0]
            ? $('grabar-entrada').selectedOptions[0].textContent
            : como.dispositivo
    });
    if (!r.ok) { toast(r.error); return; }

    vista.estado = r.estado;
    // La clase anterior deja de importar: en un día de rodaje se graban varias
    // seguidas y la marca del cierre no puede callar a la que empieza.
    vista.terminada = null;
    oido.empezarAMandar();
    toast('Grabando. El XML ya está en la carpeta y se va escribiendo.');
    pintar();
}

/* ─── Entrar a la toma de notas, y volver ────────────────────────────────── */

/**
 * "Comenzar clase": entrar a la interfaz de toma de notas.
 *
 * **No arranca ninguna toma y no escribe nada.** Abre el micrófono para que el
 * medidor empiece a moverse y propone el número que sigue en la carpeta;
 * comprometer el archivo es "Iniciar grabación", ahí adentro. Que sean dos gestos
 * es lo que deja ver que el Rodecaster está llegando ANTES de empezar, que es
 * justo lo que el medidor existe para mostrar.
 *
 * El micrófono se pide acá y no al entrar al paso, y eso cambió con las dos
 * pantallas: mirar la lista de lo que hay en la carpeta no es motivo para
 * encender el micrófono de nadie, y antes entrar a "Grabar" lo pedía siempre.
 */
async function comenzar() {
    pantallas.mostrar(pantallas.TOMA);
    proponerClase();
    // La lista del CD de esta carpeta, antes del primer repintado: el bloque de
    // cobertura es lo primero que se mira acá y aparecer vacío sobre una lista ya
    // guardada se lee como haberla perdido.
    await releerElTemario();
    pintar();
    anotar('grabar.comienza', { carpeta: grabadas.carpeta() });
    if (!oido.escuchando()) await cargarEntradas();
    // Las cámaras se miran al entrar acá, pero no se abre ninguna salvo que la
    // vista hubiera quedado desplegada: pedir la cámara por entrar sería
    // encenderla sin que nadie la haya pedido.
    await ojo.alEntrar();
    pintar();
}

/**
 * Volver a la lista, con la clase que se acaba de grabar ya en ella.
 *
 * Se relee antes de mostrarla y no después: la lista es lo que se va a mirar, y
 * verla un instante sin la clase que se acaba de terminar —para que aparezca sola
 * medio segundo más tarde— es la clase de parpadeo que hace dudar de si se
 * guardó.
 */
async function volver() {
    if (pantallas.porQueNoSeVuelve(vista.estado, vista.terminando)) return;
    await releerLaLista();
    pantallas.mostrar(pantallas.LISTA);
}

async function terminar() {
    if (vista.terminando) return;
    const ok = await window.cc.confirmar({
        titulo: 'Terminar la toma de notas',
        mensaje: 'Se cierra el audio y el XML queda con lo que hay. La toma que esté ' +
            'abierta se cierra en su última palabra y se relee con el modelo grande.',
        ok: 'Terminar'
    });
    if (!ok) return;

    oido.dejarDeMandar();
    // Tarda uno o dos segundos por toma que quedó por releer: el botón lo dice y
    // no se puede volver a apretar mientras tanto.
    vista.terminando = true;
    refrescarBotones();
    // Qué clase es la que se está cerrando, antes de soltar el estado: las
    // relecturas del cierre siguen empujando avisos suyos y alguno llega después
    // de este renglón.
    const cerrada = vista.estado && vista.estado.secuencia;
    const final = await window.cc.grabarTerminar();
    vista.terminando = false;
    vista.estado = null;
    vista.terminada = cerrada || (final && final.secuencia) || null;
    vista.aplauso = null;
    // La clase que terminó pasa a la lista, y la siguiente ya tiene su número: en
    // un día de rodaje se graban varias seguidas. Sale de la carpeta, que ya
    // incluye la que se acaba de escribir.
    await grabadas.cargar();
    proponerClase();
    // Y la lista vuelve a salir de la carpeta: la sesión que la tenía ya no está,
    // y sin esto el bloque quedaría sin lista sobre una carpeta que sí la tiene.
    await releerElTemario();
    pintar();
    if (final && final.archivos) {
        // Y se dice que ya se puede volver, porque es el momento en que el botón de
        // arriba se enciende y nada más en la pantalla lo señala.
        toast(`Listo. El XML quedó en ${final.archivos.xml} y la clase ya está en la lista.`);
    }
}

/**
 * Los atajos de esta pantalla.
 *
 * Qué hace cada tecla lo decide `teclas.js`, que no toca el DOM y por eso se
 * puede probar; acá está lo que hay que hacer con la respuesta. El oyente va en
 * el documento por lo mismo que en el reproductor y en la pestaña de cortes: el
 * foco lo tiene lo último que se tocó, así que atarlo a un elemento sería pedirle
 * a quien graba que haga clic en la lista antes de poder apretar R.
 *
 * **La barra espaciadora sigue sin hacer nada**, y eso no cambió con el deshacer
 * puesto: una toma abierta o cerrada por error se deshace, pero el audio siguió
 * corriendo mientras tanto y el "3, 2, 1" del profesor ya pasó. Las tomas las
 * abren y las cierran sus palabras, que es de donde salen los tiempos buenos.
 */
function teclas(e) {
    if (!$('view-grabar').classList.contains('is-visible')) return;
    // Y solo en la toma de notas. Desde la lista no hay nada a qué apuntarlas: las
    // de vista actúan sobre una toma de la sesión, que allá no se ve; Cmd-Z
    // desharía un cambio de esa misma sesión sin que nadie pueda ver qué cambió; y
    // Escape no tiene ninguna caja de comentario que cerrar. Escribir en el
    // renombrado ya está cubierto por `estaEscribiendo`, que es la regla de
    // siempre y sirve igual acá.
    if (pantallas.cual() !== pantallas.TOMA) return;
    const gesto = queHace(e, {
        // El mismo `estaEscribiendo(evento.target)` del reproductor y de la
        // pestaña de cortes, sin agregarle nada: con el oyente en el documento, el
        // `target` de una tecla ES el campo que tiene el foco, así que mirar
        // además `activeElement` sería una segunda regla que dice lo mismo hasta el
        // día en que una de las dos se cambie.
        escribiendo: estaEscribiendo(e.target),
        grabando: Boolean(vista.estado && vista.estado.grabando),
        // La que se eligió con un clic, y si no hay ninguna la abierta.
        activa: tomaDeLasTeclas(vista.estado, vista.elegida),
        vistas: (vista.estado && vista.estado.vistas) || vista.vistas
    });
    if (!gesto) return;

    if (gesto.que === 'cerrar-caja') {
        const abierta = document.querySelector('.toma.es-comentando');
        if (abierta) { margen.cerrar(abierta); e.preventDefault(); }
        return;
    }
    e.preventDefault();
    if (gesto.que === 'vista') {
        // Sobre una elegida a mano se dice en qué toma cayó, y sobre la abierta
        // no: la abierta la tiene a la vista el scroll pegado al fondo, y una
        // elegida hace rato puede estar arriba, fuera de la pantalla. Un aviso en
        // cada tecla sería ruido; en el caso en que el cambio puede no verse, es
        // lo único que dice que pasó algo.
        if (puedeElegirse(vista.estado, vista.elegida)) {
            toast(`Toma ${gesto.toma} en ${gesto.vista}.`);
        }
        acciones.alCambiar({ tipo: 'vista', toma: gesto.toma, vista: gesto.vista });
        return;
    }
    volverAtras(gesto.que === 'rehacer' ? 'adelante' : 'atras');
}

/** Se cablea una vez; entrar y salir del paso no vuelve a pedir el micrófono. */
export function wireGrabar() {
    if (vista.cableado) return;
    vista.cableado = true;

    // La preferencia que quedó de cuando el interruptor escondía el texto entero.
    olvidar(TRANSCRIPT_VIEJO);
    // El scroll de la columna de la izquierda, pegado al final de la lista de
    // tomas mientras nadie suba a leer.
    vista.fondo = pegado.cablear($('grabar-izq'), $('grabar-tomas'));

    // Un clic en una tarjeta elige su toma (`elegir`), y si cayó en su cabezal
    // también la pliega (`elClicPliega`). El oyente va en la lista y no en cada
    // tarjeta porque las tarjetas se rehacen en cada repintado: atarlo a las de
    // ahora sería cablearlo de nuevo cada tres segundos. Y no estorba a nadie:
    // los botones de la tarjeta hacen lo suyo y el clic sigue subiendo.
    $('grabar-tomas').addEventListener('click', e => {
        const tarjeta = e.target.closest('.toma');
        if (!tarjeta) return;
        const id = Number(tarjeta.dataset.toma);
        // Elegir primero y plegar después: plegar repinta la lista, y elegir sobre
        // la tarjeta nueva es lo que deja la marca puesta donde el pliegue la dejó.
        elegir(id);
        if (plegado.elClicPliega(laToma(id), formaDelClic(e))) plegar(id, !vista.plegadas.has(id));
    });

    $('grabar-entrada').onchange = e => abrirEntrada(e.target.value);
    $('grabar-entradas').onclick = refrescarEntradas;
    // El monitor de video se cablea solo y no pasa por acá: no graba nada, no
    // habla con el motor y ninguna decisión de esta pantalla depende de él.
    ojo.cablear();
    // Al escribir se recalcula la parte, y al salir del campo se rellena a dos
    // dígitos: el número se escribe "01" en todos lados, empezando por la
    // carpeta del Rodecaster.
    $('grabar-clase').oninput = pintarParte;
    $('grabar-clase').onblur = () => {
        $('grabar-clase').value = dosDigitos(claseElegida());
        pintarParte();
    };
    // La pantalla de la lista se cablea sola y con lo suyo. Lo que necesita de acá
    // son tres cosas que no son de ella: las vistas que la ventana ya pidió una
    // vez, la pregunta de cuál de los dos bordes va donde se hizo clic derecho
    // —que tiene que ser la MISMA en las dos pantallas—, y adónde ir al apretar
    // "Comenzar clase".
    grabadas.cablear({
        vistas: () => vista.vistas,
        preguntarBorde,
        alComenzar: comenzar
    });
    $('grabar-volver').onclick = volver;
    for (const boton of document.querySelectorAll('.grabar-compact')) {
        boton.onclick = () => {
            vista.compacto = !vista.compacto;
            recordar(ORILLAS_RECORDADAS, vista.compacto ? 'no' : 'si');
            pintarCompacto();
        };
    }
    $('grabar-descartadas').onclick = () => {
        vista.sinDescartadas = !vista.sinDescartadas;
        recordar(DESCARTADAS_RECORDADAS, vista.sinDescartadas ? 'si' : 'no');
        pintar();
    };
    $('grabar-deshacer').onclick = () => volverAtras('atras');
    $('grabar-rehacer').onclick = () => volverAtras('adelante');
    // El mismo "Cerrar acá" que cuelga de la toma abierta, en un sitio fijo de la
    // barra. Hace falta los dos: el de la tarjeta es el preciso —dice en qué toma
    // cae— pero la tarjeta se mueve, y ahora que la lista va de la más vieja a la
    // más nueva y el scroll se puede haber subido a leer, puede no estar en
    // pantalla. Este se aprieta en medio de una interrupción, con el profesor
    // esperando, y para eso tiene que estar siempre en el mismo pixel: es el mismo
    // motivo por el que "Claqueta" está al lado y no dentro de una tarjeta.
    $('grabar-cerrar-toma').onclick = () => acciones.alCerrar();
    $('grabar-iniciar').onclick = iniciar;
    $('grabar-terminar').onclick = terminar;
    $('grabar-claqueta-ahora').onclick = async () => {
        // A mano, y es el camino principal: quien toma las notas ve al director
        // aplaudir y aprieta. La hora es ESTA y queda confirmada —la afirmó una
        // persona—; si el motor la oye solo, mejor, y si el aplauso se marcó unos
        // décimos tarde no importa: en post `align.js` la corre contra el audio.
        // Apretar de nuevo la mueve a ahora.
        const turno = respuestas.tomar();
        const estado = await window.cc.grabarClaqueta(Date.now());
        anotar('grabar.claqueta-a-mano', {});
        if (respuestas.atrasada(turno)) return;
        vista.estado = estado;
        pintar();
    };

    document.addEventListener('keydown', teclas);

    // El avance de armar el proyecto de un curso. Va por su propio canal y no
    // por `grabar-aviso` porque no es de la grabación: la clase que se está
    // grabando y el curso que se está empaquetando son dos relojes distintos, y
    // meterlos en el mismo canal obligaría a que cada uno se saltee al otro.
    window.cc.onPrprojAviso(aviso => grabadas.avanceDePrproj(aviso));

    window.cc.onGrabarAviso(aviso => {
        if (aviso.tipo === 'error') { toast(aviso.mensaje); return; }
        if (aviso.tipo === 'regenerando') {
            // Una clase terminada que se está releyendo: su tarjeta cuenta, y la
            // tarjeta es de la otra pantalla.
            grabadas.avanceDeRegenerado(aviso);
            return;
        }
        if (aviso.tipo === 'golpe') {
            // El motor oyó un golpe corto y fuerte y se fue a leer qué se dijo
            // alrededor. Se muestra ya, sin esperar: enterarse de que la claqueta
            // se oyó no puede tardar el segundo que tarda Whisper.
            vista.aplauso = aviso.ms;
            anotar('grabar.golpe', { ms: aviso.ms });
            pintarClaqueta();
            return;
        }
        if (aviso.oyendo !== undefined) {
            const linea = $('grabar-oyendo');
            linea.hidden = !aviso.oyendo;
            linea.textContent = aviso.oyendo ? `Oyendo: ${aviso.oyendo}` : '';
        }
        // Un aviso de la clase que ya se cerró no se dibuja: llega de las
        // relecturas del cierre y traería `grabando: true` sobre una clase cuyo XML
        // ya está escrito, dejando la pantalla trabada en la toma de notas.
        if (aviso.estado && !esDeLaQueTermino(aviso.estado, vista.terminada)) {
            vista.estado = aviso.estado;
            pintar();
        }
    });
}

/**
 * La puerta del arnés: dibujar la vista con un estado dado.
 *
 * Sin esto, mirar cómo queda una lista de veinte tomas obliga a grabar veinte
 * tomas, y comprobar que una toma descartada se ve descartada obliga a
 * descartarla a mano. El estado se lo puede sacar al sidecar que deja
 * `tools/simular-grabacion.js`, que sale de audio de verdad.
 *
 * Solo dibuja: no toca el motor ni el micrófono, así que desde acá no se puede
 * hacer nada que la pantalla no pueda hacer sola.
 *
 * Y muestra la toma de notas, porque un estado es una sesión: empujarlo con la
 * lista delante dibujaría la pantalla escondida y desde afuera se vería que no
 * pasó nada.
 */
export function pintarEstado(estado) {
    vista.estado = estado;
    pantallas.mostrar(pantallas.TOMA);
    pintar();
}

/**
 * Entrar al paso, que es entrar a la lista.
 *
 * Salvo que haya una grabación en curso: el motor la puede tener de antes de
 * cambiar de paso, y ahí se entra por la toma de notas, que es donde está pasando
 * algo. Es lo que hace que irse a Ajustes y volver no se sienta como haber
 * perdido la clase, y es también la puerta por la que la maqueta abre la pantalla
 * grabando (`?grabando`).
 *
 * Ya no pide el micrófono: eso pasó a "Comenzar clase" (ver `comenzar`).
 */
export async function abrirGrabar() {
    showView('grabar');
    marcarPaso(PASOS.grabar);
    // Se relee cada vez que se entra: es barato y así se ve lo que haya quedado
    // guardado, venga de esta sesión o de la anterior —las carpetas y las clases
    // que hay en ellas—.
    if (!vista.vistas.length) vista.vistas = await window.cc.grabarVistas();
    const enCurso = await window.cc.grabarEstado();
    if (enCurso) vista.estado = enCurso;
    await releerLaLista();
    await releerElTemario();

    if (vista.estado && vista.estado.grabando) {
        pantallas.mostrar(pantallas.TOMA);
        if (!oido.escuchando()) await cargarEntradas();
        await ojo.alEntrar();
    } else {
        pantallas.mostrar(pantallas.LISTA);
    }
    pintar();
}
