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
import * as analisis from './analisis.js';
import * as pegado from './pegado.js';
import * as plegado from './plegado.js';
import * as margen from './margen.js';
import { queHace, tomaDeLasTeclas, puedeElegirse } from './teclas.js';
import { mostrador } from './turnos.js';

/**
 * Lo que la ventana recuerda por su cuenta: la última entrada de audio elegida
 * —el id del dispositivo lo da el navegador— y cómo se quiere ver la lista de
 * lo grabado. La carpeta de notas NO: esa la necesita también el escáner de
 * post, así que vive en los ajustes (`ajustes.notasDir`) y tiene un solo dueño.
 */
const ENTRADA_RECORDADA = 'cc.grabar.entrada';
const MODO_RECORDADO = 'cc.grabar.modo';
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
    // La carpeta en uso y todas las que se usaron, la activa primera (ajustes).
    carpeta: null,
    carpetas: [],
    estado: null,
    // Las clases ya grabadas en esas carpetas, de la más nueva a la más vieja.
    grabadas: [],
    // Las vistas que se le pueden poner a una toma. Vienen con el estado mientras
    // se graba, pero una clase terminada también las cambia y ahí no hay estado.
    vistas: [],
    // Cómo se ve la lista: 'carpetas' o 'fecha'.
    modo: grabadas.MODOS.includes(recordado(MODO_RECORDADO)) ? recordado(MODO_RECORDADO) : 'carpetas',
    // Si la lista de lo ya grabado está desplegada, y si se estaba grabando la
    // última vez que se miró: la lista se pliega sola al empezar (`plegarSegunGrabe`).
    grabadasAbiertas: true,
    grababa: false,
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
    // Las clases que se están regenerando: json → {hechas, total}.
    regenerando: new Map(),
    // El golpe que se oyó y todavía no se leyó.
    aplauso: null,
    // "Terminar" apretado y esperando a que el motor relea las últimas tomas.
    terminando: false,
    cableado: false
};

/** El curso es la carpeta: una carpeta de notas por curso. */
function curso() {
    return grabadas.nombreDeCarpeta(vista.carpeta);
}

/** Las clases ya grabadas en la carpeta en uso, que es contra las que se numera. */
function lasDeLaCarpeta() {
    return vista.grabadas.filter(c => c.carpeta === vista.carpeta);
}

/** El número que está escrito en el campo. */
function claseElegida() {
    return Number(String($('grabar-clase').value).replace(/\D/g, '')) || 1;
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
    const numeros = lasDeLaCarpeta().map(c => Number(c.clase) || 0);
    $('grabar-clase').value = dosDigitos(numeros.length ? Math.max(...numeros) + 1 : 1);
    pintarParte();
}

function dosDigitos(n) {
    return String(Math.max(1, Math.min(999, Math.round(n)))).padStart(2, '0');
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
    const cuantas = lasDeLaCarpeta().filter(c => Number(c.clase) === claseElegida()).length;
    const marca = $('grabar-parte');
    marca.hidden = cuantas === 0;
    marca.textContent = `parte ${cuantas + 1}`;
    marca.title = `Ya hay ${cuantas} grabación de esta clase en la carpeta: ` +
        'esta queda como una tanda más, con su propio XML.';
}

/** Se puede arrancar cuando hay entrada abierta y carpeta elegida. */
function refrescarBotones() {
    const grabando = Boolean(vista.estado && vista.estado.grabando);
    // Cerrar la toma a mano: solo si hay una abierta que cerrar.
    $('grabar-cerrar-toma').hidden = !grabando;
    $('grabar-cerrar-toma').disabled = !(vista.estado && vista.estado.abierta) || vista.terminando;
    $('grabar-iniciar').disabled = grabando || !oido.escuchando() || !vista.carpeta;
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
    $('grabar-carpeta').disabled = grabando;
    $('grabar-curso').textContent = vista.carpeta ? curso() : '—';
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
    if (!vista.carpeta) {
        donde.textContent = 'Elegí la carpeta del curso: ahí caen las notas. No puede ser la tarjeta ' +
            'del Rodecaster, que no está en la Mac hasta que la grabación termina.';
        donde.className = 'grabar-donde es-falta';
        return;
    }
    const xml = vista.estado && vista.estado.archivos ? vista.estado.archivos.xml : '';
    const archivo = xml ? ` · ${colgandoDe(vista.carpeta, xml)}` : '';
    donde.textContent = `Se guarda en ${vista.carpeta}${archivo}`;
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
    titulo.textContent = grabadas.comoSeLlama(e) + (e.curso ? ` · ${e.curso}` : '');
    const desde = document.createElement('span');
    desde.className = 'clase-dato';
    desde.textContent = `grabando desde ${fmtHora(e.ceroMs)} · ${plural(e.tomas.length, 'toma', 'tomas')}`;
    cabeza.append(titulo, desde);
}

/**
 * Mientras se graba, lo de antes se pliega.
 *
 * Lo que importa con una clase en curso es la clase en curso, y con seis clases
 * viejas desplegadas la toma que está pasando queda debajo del pliegue. Se pliega
 * al empezar y se despliega al terminar, y SOLO en esos dos momentos: el estado
 * llega cada tres segundos y repintar no puede volver a cerrar lo que alguien
 * acaba de abrir a mano.
 */
function plegarSegunGrabe() {
    const grabando = Boolean(vista.estado && vista.estado.grabando);
    if (grabando === vista.grababa) return;
    vista.grababa = grabando;
    vista.grabadasAbiertas = !grabando;
}

function pintarGrabadas() {
    $('grabadas-barra').hidden = !vista.carpetas.length;

    const abierta = vista.grabadasAbiertas;
    const plegar = $('grabadas-plegar');
    plegar.setAttribute('aria-expanded', String(abierta));
    plegar.classList.toggle('es-plegada', !abierta);
    // Plegada dice cuántas hay: si no, plegarla parece haberlas perdido.
    $('grabadas-cuantas').textContent = abierta ? '' : plural(vista.grabadas.length, 'clase', 'clases');
    $('grabadas-modos').hidden = !abierta;
    $('grabar-grabadas').hidden = !abierta;
    if (!abierta) return;

    for (const boton of document.querySelectorAll('.grabadas-modo')) {
        const elegido = boton.dataset.modo === vista.modo;
        boton.classList.toggle('is-elegido', elegido);
        boton.setAttribute('aria-checked', String(elegido));
    }
    grabadas.pintar($('grabar-grabadas'), vista.grabadas, {
        modo: vista.modo,
        carpetas: vista.carpetas,
        carpetaActiva: vista.carpeta,
        regenerando: vista.regenerando,
        vistas: vista.vistas,
        alRegenerar: regenerar,
        alEditar: editarGrabada,
        alBorde: bordeDeGrabada,
        alQuitarCarpeta: quitarCarpeta
    });
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
    const boton = $('grabar-compact');
    boton.setAttribute('aria-pressed', String(vista.compacto));
    boton.classList.toggle('is-elegido', vista.compacto);
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

/** Cómo se está mirando la lista, que es lo único que la lista guarda de su lado. */
function mirada() {
    return {
        plegadas: vista.plegadas,
        sinDescartadas: vista.sinDescartadas,
        alPlegar: (id, plegada) => {
            if (plegada) {
                // Un comentario abierto al margen de una toma que se pliega se
                // iría con ella y quedaría marcado como abierto para siempre.
                margen.cerrarTodos($('grabar-tomas'));
                vista.plegadas.add(id);
            } else {
                vista.plegadas.delete(id);
            }
            pintar();
        }
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
    plegarSegunGrabe();
    pintarEnCurso();
    tomas.pintar($('grabar-tomas'), vista.estado, acciones, mirada());
    marcarElegida();
    pintarGrabadas();
    pintarCompacto();
    pintarDescartadas();
    pintarHistoria();
    analisis.pintar($('grabar-analisis'), vista.estado);
    pintarClaqueta();
    decirDonde();
    refrescarBotones();
    // Lo último de todo: el salto al fondo se mide sobre la lista ya dibujada, y
    // esta pantalla repinta varias cosas que le cambian el alto.
    if (vista.fondo) vista.fondo.alPintar();
}

/** Relee de los ajustes las carpetas, y del disco las clases que hay en ellas. */
async function cargarGrabadas() {
    const ajustes = await window.cc.ajustesLeer();
    const cambioDeCarpeta = ajustes.notasDir !== vista.carpeta;
    vista.carpeta = ajustes.notasDir;
    vista.carpetas = ajustes.notasDirs || [];
    vista.grabadas = await window.cc.grabarListar(vista.carpetas);
    pintarGrabadas();
    // El número sale de lo que hay en la carpeta, así que se propone cuando se
    // elige una y cuando termina una clase; escribir uno a mano no se pisa.
    if (cambioDeCarpeta) proponerClase();
    else pintarParte();
}

/**
 * Releer las tomas de una clase terminada con el modelo grande.
 *
 * No decide nada: mejora el texto y no toca ningún borde. Y es lo que hay que
 * apretar cuando un borde se quedó sin lugar, porque relee cada toma con orillas
 * nuevas alrededor de los bordes de ahora: después de eso el IN y el OUT vuelven
 * a tener segundos de texto por delante para seguir corriéndose.
 */
async function regenerar(clase) {
    const json = clase.archivos.json;
    vista.regenerando.set(json, { hechas: 0, total: (clase.tomas || []).length });
    pintarGrabadas();
    const r = await window.cc.grabarRegenerar(json);
    vista.regenerando.delete(json);
    if (!r.ok) {
        toast(r.error);
        pintarGrabadas();
        return;
    }
    toast(r.sinAudio
        ? `Clase ${clase.clase}: ${plural(r.tomas - r.sinAudio, 'toma releída', 'tomas releídas')}; ` +
            `${r.sinAudio} sin audio para releer.`
        : `Clase ${clase.clase}: ${plural(r.tomas, 'toma releída', 'tomas releídas')} y XML reescrito.`);
    await cargarGrabadas();
}

/** Lo que se le hizo a la toma, para decirlo en el aviso. */
const DICHO = {
    vista: 'la vista',
    nota: 'la nota',
    descartar: 'el descarte',
    comentar: 'el comentario',
    'borrar-comentario': 'el comentario quitado',
    'descartar-ajuste': 'el ajuste de empalme descartado',
    borde: 'el borde movido'
};

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
 * Cambiar una clase que ya terminó. El motor reescribe su XML en el mismo gesto,
 * así que acá solo hay que releer la lista para que la tarjeta muestre lo nuevo.
 */
async function editarGrabada(clase, cambio) {
    const r = await window.cc.grabarEditarGrabada(clase.archivos.json, cambio);
    if (!r.ok) { toast(r.error); return; }
    anotar('grabar.edita-grabada', { clase: clase.clase, tipo: cambio.tipo });
    toast(`Clase ${clase.clase}: XML reescrito con ${DICHO[cambio.tipo] || 'el cambio'}.`);
    await cargarGrabadas();
}

/** El clic derecho sobre una palabra de una clase ya grabada. */
async function bordeDeGrabada(clase, { toma, paredMs, abierta }) {
    const borde = await preguntarBorde(toma, paredMs, abierta);
    if (!borde) return;
    await editarGrabada(clase, { tipo: 'borde', toma, borde, paredMs });
}

/** Sacar una carpeta de la lista. No borra nada: solo deja de mostrarse acá. */
async function quitarCarpeta(ruta) {
    const r = await window.cc.ajustesGuardar({ notasDirs: vista.carpetas.filter(d => d !== ruta) });
    if (!r.ok) { toast(r.error); return; }
    await cargarGrabadas();
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
        dir: vista.carpeta,
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
    oido.empezarAMandar();
    toast('Grabando. El XML ya está en la carpeta y se va escribiendo.');
    pintar();
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
    const final = await window.cc.grabarTerminar();
    vista.terminando = false;
    vista.estado = null;
    vista.aplauso = null;
    // La clase que terminó pasa a la lista de abajo, y la siguiente ya tiene su
    // número: en un día de rodaje se graban varias seguidas. Sale de la carpeta,
    // que ya incluye la que se acaba de escribir.
    await cargarGrabadas();
    proponerClase();
    pintar();
    if (final && final.archivos) {
        toast(`Listo. El XML quedó en ${final.archivos.xml}`);
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

    // Un clic en una tarjeta elige su toma (`elegir`). El oyente va en la lista y
    // no en cada tarjeta porque las tarjetas se rehacen en cada repintado: atarlo
    // a las de ahora sería cablearlo de nuevo cada tres segundos. Y no estorba a
    // nadie: los botones de la tarjeta hacen lo suyo y el clic sigue subiendo.
    $('grabar-tomas').addEventListener('click', e => {
        const tarjeta = e.target.closest('.toma');
        if (tarjeta) elegir(Number(tarjeta.dataset.toma));
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
    $('grabar-carpeta').onclick = async () => {
        const elegida = await window.cc.pickFolder({
            titulo: 'Elegí la carpeta del curso: ahí caen las notas de sus clases',
            boton: 'Usar esta carpeta'
        });
        if (!elegida) return;
        // A los ajustes, que es donde la va a buscar el escáner cuando la clase
        // llegue sin su XML adentro: las notas y el material nacen en carpetas
        // distintas, y alguien tiene que recordar dónde quedó cada mitad. Los
        // ajustes la suman solos a la lista de carpetas usadas.
        const r = await window.cc.ajustesGuardar({ notasDir: elegida });
        if (!r.ok) { toast(r.error); return; }
        await cargarGrabadas();
        pintar();
    };
    $('grabadas-plegar').onclick = () => {
        vista.grabadasAbiertas = !vista.grabadasAbiertas;
        pintarGrabadas();
    };
    $('grabar-compact').onclick = () => {
        vista.compacto = !vista.compacto;
        recordar(ORILLAS_RECORDADAS, vista.compacto ? 'no' : 'si');
        pintarCompacto();
    };
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
    for (const boton of document.querySelectorAll('.grabadas-modo')) {
        boton.onclick = () => {
            vista.modo = boton.dataset.modo;
            recordar(MODO_RECORDADO, vista.modo);
            pintarGrabadas();
        };
    }
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

    window.cc.onGrabarAviso(aviso => {
        if (aviso.tipo === 'error') { toast(aviso.mensaje); return; }
        if (aviso.tipo === 'regenerando') {
            // Una clase terminada que se está releyendo: su tarjeta cuenta.
            if (vista.regenerando.has(aviso.json)) {
                vista.regenerando.set(aviso.json, { hechas: aviso.hechas, total: aviso.total });
                pintarGrabadas();
            }
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
        if (aviso.estado) {
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
 */
export function pintarEstado(estado) {
    vista.estado = estado;
    pintar();
}

/** Entrar al paso. Pide el micrófono la primera vez. */
export async function abrirGrabar() {
    showView('grabar');
    marcarPaso(PASOS.grabar);
    // Se relee cada vez que se entra: es barato y así se ve lo que haya quedado
    // guardado, venga de esta sesión o de la anterior —las carpetas y las clases
    // que hay en ellas—.
    if (!vista.vistas.length) vista.vistas = await window.cc.grabarVistas();
    await cargarGrabadas();
    pintar();
    if (!oido.escuchando()) await cargarEntradas();
    // Las cámaras se miran cada vez que se entra, pero no se abre ninguna salvo
    // que la vista hubiera quedado desplegada: pedir la cámara por entrar acá
    // sería encenderla sin que nadie la haya pedido.
    await ojo.alEntrar();
    // El motor puede tener una grabación en curso de antes de cambiar de paso.
    const enCurso = await window.cc.grabarEstado();
    if (enCurso) { vista.estado = enCurso; }
    pintar();
}
