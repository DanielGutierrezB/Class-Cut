'use strict';
/**
 * grabadas.js — La pantalla de la lista: qué clases hay en las carpetas y qué se
 * les puede hacer.
 *
 * Es por donde se entra al paso. Antes esto era una lista colgada debajo de la
 * clase en curso —"Ya grabadas", plegable— y se fue a su propia pantalla cuando
 * quedó claro que las dos mitades no cabían juntas (el por qué está en
 * `pantallas.js`). Al salir de abajo dejó de ser un apéndice y pasó a ser lo
 * primero que se ve, y eso trajo lo que le faltaba: **desde acá se gestiona la
 * carpeta.** Hasta ahora la app sabía crear clases y no sabía arreglarlas, y la
 * única salida para una clase con el número equivocado era entrar a la carpeta y
 * mover archivos a mano, que es exactamente donde el XML y su archivo de datos se
 * separan.
 *
 * Se ven de dos maneras. **Por carpeta**: una carpeta de notas es un curso, así
 * que agrupadas por carpeta son las clases de cada curso, con la carpeta en uso
 * primero. **Por fecha**: todas juntas, de la más nueva a la más vieja, que es lo
 * que sirve para ver qué se grabó hoy sin importar de qué curso.
 *
 * Lo que se muestra sale del archivo con la hora del día que cada clase dejó en
 * su carpeta (`grabacion.listar`), no de la memoria de la ventana: la lista son
 * las carpetas, así que la clase de ayer aparece igual que la de hace un minuto.
 *
 * Una clase terminada se edita como una en curso, y por un motivo: revisar el
 * guion entero es justo cuando uno se da cuenta de las cosas —que esa toma iba en
 * S, que sobra, que el conteo se comió la primera frase, qué hay que decirle a
 * quien edita—, y cerrar la clase no puede ser el momento en que todo eso deja de
 * poderse. Cada cambio reescribe su XML en el acto.
 *
 * Los bordes también se arrastran, que es lo que más parecía imposible: el texto
 * de un rango más ancho que cada toma quedó guardado al lado del XML, así que
 * correr el IN o el OUT ahí adentro es repartir de nuevo palabras que ya están
 * (ver `moverBordeGuardado` en `engine/notas-vivo.js`). Lo único que pide volver
 * a oír es irse más lejos que ese rango, y para eso está **regenerar**, que relee
 * las tomas con el modelo grande y deja orillas nuevas alrededor de los bordes de
 * ahora.
 *
 * Esta pantalla habla con el motor y las de al lado no, y es por dónde pasa la
 * frontera: las reglas de qué le pasa a una clase al renombrarla viven aparte y
 * sin pantalla (`gestionar.js`), el dibujo de una toma vive en `tomas.js`, y lo
 * que queda acá es el cableado — pedir, avisar y volver a leer.
 */

import { $, toast, anotar, recordar, recordado } from '../chrome.js';
import { fmtDur, fmtHora, plural } from '../formato.js';
import { pintarLeida } from './tomas.js';
import { tramosPorToma } from './empalme.js';
import {
    comoSeLlama, dosDigitos, horaDeCaptura, nombreDeCarpeta,
    numeroLeido, parteQueQueda, queSeBorra, queSeBorraElComentario
} from './gestionar.js';
import { mostrador } from './turnos.js';
import * as prproj from './prproj.js';

/** Cómo se puede ver la lista, y con qué clave se recuerda la elección. */
const MODOS = ['carpetas', 'fecha'];
const MODO_RECORDADO = 'cc.grabar.modo';

/**
 * Lo que la pantalla de la lista sabe.
 *
 * La carpeta en uso y las que se usaron NO se guardan acá: viven en los ajustes,
 * porque las necesita también el escáner de post cuando una clase llega sin su
 * XML adentro. Acá está la copia con la que se dibuja, releída en cada `cargar`.
 */
const suyo = {
    carpeta: null,
    carpetas: [],
    // Las clases de esas carpetas, de la más nueva a la más vieja.
    clases: [],
    modo: MODOS.includes(recordado(MODO_RECORDADO)) ? recordado(MODO_RECORDADO) : 'carpetas',
    // Las clases que se están regenerando: json → {hechas, total}.
    regenerando: new Map(),
    /**
     * La clase con el formulario de renombre abierto, y lo que se lleva escrito.
     *
     * Lo escrito se guarda acá y no solo en el campo porque la lista se puede
     * repintar por debajo —una clase terminando de regenerarse— y rehacer el
     * formulario con los valores del archivo tiraría el nombre a medio escribir.
     * Es la misma regla que protege la nota de una toma en `tomas.js`, en su
     * versión chica: lo que alguien escribió y todavía no guardó no se rehace.
     */
    renombrando: null,
    // Las vistas que se le pueden poner a una toma, y lo que hay que preguntar
    // antes de mover un borde: las dos las pone la ventana al cablear.
    vistas: () => [],
    preguntarBorde: null,
    alComenzar: null,
    cableada: false
};

/** La carpeta en uso, que es el curso donde va a caer la clase que se grabe. */
export function carpeta() {
    return suyo.carpeta;
}

/** Las clases de la carpeta en uso, que es contra las que se numera la próxima. */
export function deLaCarpeta() {
    return suyo.clases.filter(c => c.carpeta === suyo.carpeta);
}

/* ─── Las piezas de una tarjeta ───────────────────────────────────────────── */

/**
 * Hasta cuándo grabó una clase: el cierre del audio, y si no quedó escrito
 * (la app se cerró de golpe), el final de la última toma.
 */
function finDe(clase) {
    const cierres = (clase.sesiones || []).map(s => s.hastaMs).filter(Boolean);
    if (cierres.length) return Math.max(...cierres);
    const salidas = (clase.tomas || []).map(t => t.outMs).filter(Boolean);
    return salidas.length ? Math.max(...salidas) : null;
}

function dato(texto, clase) {
    const span = document.createElement('span');
    span.className = clase ? `clase-dato ${clase}` : 'clase-dato';
    span.textContent = texto;
    return span;
}

function botonChico(texto, titulo, alClic) {
    const boton = document.createElement('button');
    boton.className = 'btn btn-ghost btn-inline';
    boton.type = 'button';
    boton.textContent = texto;
    if (titulo) boton.title = titulo;
    boton.onclick = e => {
        // Un botón dentro de un `summary` abriría y cerraría la tarjeta además
        // de hacer lo suyo.
        e.preventDefault();
        e.stopPropagation();
        alClic();
    };
    return boton;
}

/** Lo que va en la cabecera de una clase, de un vistazo y sin abrirla. */
function datosDe(cabeza, clase) {
    const fin = finDe(clase);
    cabeza.append(dato(fin
        ? `${fmtHora(clase.ceroMs)} → ${fmtHora(fin)} · ${fmtDur((fin - clase.ceroMs) / 1000)}`
        : fmtHora(clase.ceroMs)));

    const tomas = clase.tomas || [];
    const quedan = tomas.filter(t => !t.descartada && t.outMs != null).length;
    cabeza.append(dato(quedan === tomas.length
        ? plural(tomas.length, 'toma', 'tomas')
        : `${plural(tomas.length, 'toma', 'tomas')} · quedan ${quedan}`));

    if (clase.claqueta) {
        cabeza.append(dato(`claqueta ${fmtHora(clase.claqueta.ms)}`, clase.claqueta.confirmada ? '' : 'es-duda'));
    } else {
        cabeza.append(dato('sin claqueta', 'es-duda'));
    }

    const xml = document.createElement('span');
    xml.className = 'clase-xml mono';
    xml.textContent = clase.archivos ? nombreDeCarpeta(clase.archivos.xml) : clase.secuencia;
    xml.title = clase.archivos ? clase.archivos.xml : '';
    cabeza.append(xml);
}

/**
 * Los tres botones de gestión, en el orden en que se usan: releer, arreglar el
 * nombre, y tirarla.
 *
 * "Borrar" va último y no primero por lo mismo por lo que va apagado y no rojo
 * pleno (ver `grabar-lista.css`): es el único de los tres que no tiene vuelta, y
 * el sitio de un botón es parte de lo difícil que es apretarlo sin querer.
 */
function botonesDe(cabeza, clase) {
    const marcha = suyo.regenerando.get(clase.archivos ? clase.archivos.json : '');
    if (marcha) {
        cabeza.append(dato(`Regenerando ${marcha.hechas} de ${marcha.total}…`, 'es-marcha'));
    } else if ((clase.tomas || []).length) {
        cabeza.append(botonChico('Regenerar',
            'Volver a leer todas las tomas del audio con el modelo grande y reescribir el XML',
            () => regenerar(clase)));
    }
    if (!clase.archivos) return;

    cabeza.append(botonChico('Renombrar',
        'Cambiar el número de clase y el nombre del curso. La hora de captura no se toca: ' +
        'es con la que post empareja esta clase con la carpeta del Rodecaster.',
        () => empezarRenombre(clase)));

    const borrar = botonChico('Borrar',
        'Borra del disco el XML, el archivo de datos y el audio. No va a la papelera y no se deshace.',
        () => borrarClase(clase));
    borrar.classList.add('btn-tirar');
    cabeza.append(borrar);
}

/**
 * @param {object} clase de `grabacion.listar`
 * @param {boolean} conCurso si hay que decir de qué curso es (el modo por fecha)
 */
function tarjeta(clase, conCurso) {
    const caja = document.createElement('details');
    caja.className = 'clase es-hecha';
    caja.dataset.json = clase.archivos ? clase.archivos.json : '';

    const cabeza = document.createElement('summary');
    cabeza.className = 'clase-cabeza';

    const titulo = document.createElement('strong');
    titulo.className = 'clase-titulo';
    titulo.textContent = comoSeLlama(clase) + (conCurso && clase.curso ? ` · ${clase.curso}` : '');
    cabeza.append(titulo);

    datosDe(cabeza, clase);
    botonesDe(cabeza, clase);

    const lista = document.createElement('div');
    lista.className = 'grabar-tomas';
    const tomas = clase.tomas || [];
    if (!tomas.length) {
        const vacio = document.createElement('p');
        vacio.className = 'toma-vacio';
        vacio.textContent = 'No se abrió ninguna toma.';
        lista.append(vacio);
    }
    // Cambiar una clase terminada reescribe su XML en el acto (`editarGrabada` en
    // `engine/grabacion.js`): quien revisa el guion entero no tiene que acordarse
    // después de regenerar nada. Los dos gestos son los mismos que en vivo —el
    // arrastre de una línea y el clic derecho sobre una palabra—, así que la
    // tarjeta ofrece los dos y no una versión recortada.
    const acciones = clase.archivos
        ? {
            alCambiar: cambio => editar(clase, cambio),
            alBorde: donde => bordeDe(clase, donde)
        }
        : null;
    // El empalme de una clase terminada se mira igual: `grabacion.listar` lo
    // rehace al leer el archivo, y los bordes de una clase cerrada se mueven, así
    // que el ajuste que se ofrece acá es tan aplicable como el de la que corre.
    // Los tramos se arman con las tomas EN ORDEN, antes de darlas vuelta para
    // dibujarlas: cuál es la anterior lo decide la clase, no la lista.
    const conVistas = { vistas: suyo.vistas() || [], repetidos: tramosPorToma(tomas) };
    for (const toma of [...tomas].reverse()) lista.append(pintarLeida(toma, conVistas, acciones));

    caja.append(cabeza, lista);
    return caja;
}

/* ─── Renombrar: el formulario ────────────────────────────────────────────── */

/**
 * La tarjeta de la clase que se está renombrando: la cabecera y el formulario, y
 * nada más.
 *
 * Sin sus tomas y sin el triangulito de abrir, o sea que deja de ser un
 * `<details>` mientras el formulario está puesto. Es a propósito: lo que se está
 * haciendo con esta clase ahora es ponerle nombre, y las veinte tomas debajo del
 * campo son la parte que no importa en este momento. Cancelar la devuelve tal
 * como estaba, abierta o cerrada, porque el pliegue se anota aparte (`pintar`).
 */
function tarjetaEnRenombre(clase, conCurso) {
    const caja = document.createElement('section');
    caja.className = 'clase es-hecha es-renombrando';
    caja.dataset.json = clase.archivos.json;

    const cabeza = document.createElement('header');
    cabeza.className = 'clase-cabeza';
    const titulo = document.createElement('strong');
    titulo.className = 'clase-titulo';
    titulo.textContent = comoSeLlama(clase) + (conCurso && clase.curso ? ` · ${clase.curso}` : '');
    cabeza.append(titulo);
    datosDe(cabeza, clase);

    caja.append(cabeza, formularioDeRenombre(clase));
    return caja;
}

/** Un campo con su rótulo, que es lo único que estos dos comparten. */
function campo(rotulo, valor, clase) {
    const caja = document.createElement('label');
    caja.className = 'clase-renombre-campo';
    const nombre = document.createElement('span');
    nombre.textContent = rotulo;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = clase;
    input.value = valor;
    input.autocomplete = 'off';
    caja.append(nombre, input);
    return { caja, input };
}

/**
 * El formulario: el número, el curso, y la hora que se muestra y no se toca.
 *
 * Los dos campos que se pueden cambiar son los dos que el editor se equivocó al
 * grabar —el rodaje se dio vuelta y la 7 salió antes que la 6, o el curso quedó
 * mal escrito—, y son exactamente los dos que el motor deja mover. La hora está
 * en el medio, escrita como dato, porque no alcanza con no ofrecerla: sin
 * mostrarla, "renombrar" parecería que rehace el nombre entero, y lo primero que
 * alguien haría es preguntarse dónde quedó la hora.
 *
 * Mientras se escribe el número, la marca de la parte dice qué va a pasar si ese
 * número ya está usado. Es la misma marca y el mismo aviso que la barra de la
 * toma de notas (`.grabar-parte`), y a propósito: es la misma regla —reusar un
 * número abre la tanda siguiente— y verla escrita igual en los dos sitios es lo
 * que la vuelve una sola regla en vez de dos coincidencias.
 */
function formularioDeRenombre(clase) {
    const escrito = suyo.renombrando;
    const forma = document.createElement('form');
    forma.className = 'clase-renombre';

    const campos = document.createElement('div');
    campos.className = 'clase-renombre-campos';
    const numero = campo('Clase', escrito.clase, 'grabar-num');
    numero.input.inputMode = 'numeric';
    numero.input.maxLength = 3;
    const parte = document.createElement('span');
    parte.className = 'grabar-parte';
    const curso = campo('Curso', escrito.curso, 'clase-renombre-curso');
    campos.append(numero.caja, parte, curso.caja);

    const { hora, aviso } = horaDeCaptura(clase);
    const cuando = document.createElement('p');
    cuando.className = aviso ? 'clase-renombre-hora es-duda' : 'clase-renombre-hora';
    cuando.textContent = aviso
        || `Se grabó a las ${hora}, y esa hora no se cambia: es con la que post encuentra ` +
            'a qué carpeta del Rodecaster corresponde esta clase.';

    // Lo que el motor contestó que no se pudo. Va acá y se queda: un aviso que se
    // va solo a los tres segundos no sirve cuando lo que hay que hacer es
    // corregir el campo que está justo arriba.
    const mal = document.createElement('p');
    mal.className = 'clase-renombre-mal';
    mal.hidden = true;

    const acciones = document.createElement('div');
    acciones.className = 'clase-renombre-acciones';
    const guardar = document.createElement('button');
    guardar.type = 'submit';
    guardar.className = 'btn btn-primary btn-inline';
    guardar.textContent = 'Guardar';
    const cancelar = document.createElement('button');
    cancelar.type = 'button';
    cancelar.className = 'btn btn-ghost btn-inline';
    cancelar.textContent = 'Cancelar';
    cancelar.onclick = () => { suyo.renombrando = null; pintar(); };
    acciones.append(guardar, cancelar);

    /** La marca de la parte, recalculada en el sitio y sin repintar la lista. */
    const decirLaParte = () => {
        const n = numeroLeido(numero.input.value);
        const cual = parteQueQueda(clase, deLaCarpeta(), n);
        const hoy = Number(clase.parte) || 1;
        parte.hidden = cual === hoy && n === Number(clase.clase);
        parte.textContent = `parte ${cual}`;
        parte.title = cual > 1
            ? `Ya hay ${cual - 1} grabación de la clase ${dosDigitos(n)} en esta carpeta: ` +
                'esta queda como una tanda más, con su propio XML.'
            : 'Es la primera grabación de esa clase en la carpeta.';
    };
    numero.input.oninput = () => {
        suyo.renombrando.clase = numero.input.value;
        decirLaParte();
    };
    curso.input.oninput = () => { suyo.renombrando.curso = curso.input.value; };
    decirLaParte();

    forma.onsubmit = e => {
        e.preventDefault();
        renombrar(clase, numero.input.value, curso.input.value, { guardar, mal });
    };
    forma.append(campos, cuando, mal, acciones);
    return forma;
}

/* ─── La carpeta ─────────────────────────────────────────────────────────── */

/**
 * La cabecera de una carpeta en el modo por carpeta: el curso, dónde está y
 * cuántas clases tiene. La que está en uso lo dice; las demás se pueden sacar de
 * la lista (no del disco).
 *
 * Acá vive también «Generar .prproj», que es la única acción de esta pantalla
 * cuya unidad es el curso y no la clase: arma un proyecto de Premiere con todas
 * las de la carpeta (`prproj.js`).
 *
 * @param {string} ruta
 * @param {object[]} suyas las clases de esa carpeta
 */
function cabeceraDeCarpeta(ruta, suyas) {
    const cabeza = document.createElement('header');
    cabeza.className = 'carpeta-cabeza';
    cabeza.classList.toggle('es-activa', ruta === suyo.carpeta);

    // Primero de la fila, antes del nombre: es lo que se le hace a este curso, y
    // lo de la derecha —«en uso», «Quitar de la lista»— es lo que se le hace a la
    // fila. Son dos cosas distintas y conviene que no se mezclen.
    const empaquetar = prproj.boton(ruta, suyas.filter(c => c.archivos).length);
    if (empaquetar) cabeza.append(empaquetar);

    const nombre = document.createElement('strong');
    nombre.textContent = nombreDeCarpeta(ruta);
    const donde = document.createElement('span');
    donde.className = 'clase-dato mono';
    donde.textContent = ruta;
    donde.title = ruta;
    cabeza.append(nombre, donde, dato(plural(suyas.length, 'clase', 'clases')));

    if (ruta === suyo.carpeta) {
        cabeza.append(dato('en uso', 'es-en-uso'));
    } else {
        const quitar = botonChico('Quitar de la lista',
            'Deja de mostrarla acá. No borra nada del disco.',
            () => quitarCarpeta(ruta));
        quitar.classList.add('carpeta-quitar');
        cabeza.append(quitar);
    }
    return cabeza;
}

/** Lo que se dice cuando no hay ninguna carpeta todavía, que es cómo se abre. */
function sinCarpetas() {
    const vacio = document.createElement('p');
    vacio.className = 'grabar-vacio';
    vacio.textContent = 'Todavía no hay ninguna carpeta de curso. Apretá «Elegir carpeta…»: ' +
        'ahí van a caer las notas de sus clases, y no puede ser la tarjeta del Rodecaster, ' +
        'que no está en la Mac hasta que la grabación termina.';
    return vacio;
}

/* ─── Dibujar ─────────────────────────────────────────────────────────────── */

/**
 * Si alguien está escribiendo en el formulario de renombre.
 *
 * El foco adentro del campo no alcanza para decidirlo: hay que preguntarle
 * también al estado si el formulario todavía tiene que estar abierto. Guardando
 * con la tecla Enter el foco no se mueve de donde se escribió —el submit sale del
 * campo mismo, no del botón—, así que sin la primera línea el repintado de después
 * de guardar se saltaba, el formulario se quedaba abierto sobre una clase que ya
 * se llamaba de otra manera y la lista seguía mostrando el nombre viejo hasta el
 * gesto siguiente. Con el botón «Guardar» no pasaba, porque el foco queda en un
 * BUTTON: el defecto solo aparecía con el teclado.
 */
function enElFormulario() {
    if (!suyo.renombrando) return false;
    const foco = document.activeElement;
    return Boolean(foco && foco.tagName === 'INPUT' && foco.closest('.clase-renombre'));
}

export function pintar() {
    $('grabadas-cuantas').textContent = suyo.carpetas.length
        ? plural(suyo.clases.length, 'clase', 'clases')
        : '';
    for (const boton of document.querySelectorAll('.grabadas-modo')) {
        const elegido = boton.dataset.modo === suyo.modo;
        boton.classList.toggle('is-elegido', elegido);
        boton.setAttribute('aria-checked', String(elegido));
    }
    // Sin carpeta no se puede empezar nada: la clase tiene que caer en alguna.
    $('grabar-comenzar').disabled = !suyo.carpeta;

    const donde = $('grabar-grabadas');
    // Con una línea de borde en la mano no se repinta, igual que en la lista de
    // la clase en curso (`tomas.pintar`): rehacerla en medio del gesto cambia la
    // línea por otra y el arrastre se corta solo. Y con el formulario de renombre
    // en uso tampoco, por lo mismo que allá no se rehace la tarjeta donde alguien
    // escribe: sacar el campo del documento se lleva el foco a media palabra.
    if (donde.querySelector('.toma-borde.es-arrastrando') || enElFormulario()) return;

    // Qué tarjetas estaban desplegadas, para volver a dejarlas así. Comentar una
    // clase reescribe su XML y relee la lista, y sin esto la tarjeta que se
    // estaba leyendo se cerraba justo al comentarla.
    const abiertas = new Set([...donde.querySelectorAll('details.clase[open]')]
        .map(d => d.dataset.json).filter(Boolean));
    donde.textContent = '';

    const conCurso = suyo.modo === 'fecha';
    const dibujar = clase => {
        const json = clase.archivos ? clase.archivos.json : '';
        if (suyo.renombrando && suyo.renombrando.json === json) {
            return tarjetaEnRenombre(clase, conCurso);
        }
        const caja = tarjeta(clase, conCurso);
        caja.open = abiertas.has(json);
        return caja;
    };

    if (!suyo.carpetas.length) {
        donde.append(sinCarpetas());
        return;
    }

    if (conCurso) {
        for (const clase of suyo.clases) donde.append(dibujar(clase));
        return;
    }

    for (const ruta of suyo.carpetas) {
        const suyas = suyo.clases.filter(c => c.carpeta === ruta);
        const grupo = document.createElement('section');
        grupo.className = 'carpeta';
        grupo.append(cabeceraDeCarpeta(ruta, suyas));
        if (!suyas.length) {
            const vacio = document.createElement('p');
            vacio.className = 'toma-vacio carpeta-vacia';
            vacio.textContent = ruta === suyo.carpeta
                ? 'Todavía no hay clases grabadas acá: la próxima cae en esta carpeta.'
                : 'No quedó ninguna clase en esta carpeta.';
            grupo.append(vacio);
        }
        for (const clase of suyas) grupo.append(dibujar(clase));
        donde.append(grupo);
    }
}

/* ─── Lo que se le pide al motor ─────────────────────────────────────────── */

/**
 * El mostrador de esta pantalla. Uno por pantalla, como dice `turnos.js`: los
 * turnos valen entre sí y no contra los de la toma de notas.
 */
const turnos = mostrador();

/**
 * Relee de los ajustes las carpetas, y del disco las clases que hay en ellas.
 *
 * **Con turno, porque son dos viajes y siete caminos la llaman.** Releer la lista
 * tarda lo que tarde el disco, y hay gestos que la piden con otro ya en vuelo:
 * regenerar una clase de veinte minutos avisa su avance mientras alguien borra
 * otra, y ahí las dos releídas pueden volver al revés. La que llega segunda es una
 * foto de antes, así que guardarla devuelve a la pantalla una clase que ya no está
 * en el disco, y de eso no se sale hasta el gesto siguiente.
 *
 * Y nada de `suyo` se toca antes del último `await`: escribir la carpeta y esperar
 * las clases después dejaba media pantalla de una respuesta y media de la otra,
 * que es peor que quedarse con la vieja entera.
 *
 * @returns {Promise<boolean>} si la carpeta en uso cambió, que es lo que decide
 *   si hay que proponer un número de clase nuevo del otro lado. Una respuesta
 *   atrasada contesta que no: no dejó nada en la pantalla que haya que seguir.
 */
export async function cargar() {
    const turno = turnos.tomar();
    const ajustes = await window.cc.ajustesLeer();
    const clases = await window.cc.grabarListar(ajustes.notasDirs || []);
    if (turnos.atrasada(turno)) return false;
    const cambioDeCarpeta = ajustes.notasDir !== suyo.carpeta;
    suyo.carpeta = ajustes.notasDir;
    suyo.carpetas = ajustes.notasDirs || [];
    suyo.clases = clases;
    pintar();
    return cambioDeCarpeta;
}

/** Lo que le pasó a la toma, para decirlo en el aviso. */
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
 * Lo único de esta pantalla que se pregunta antes de cambiar una clase terminada.
 *
 * Los otros cambios se deshacen apretando lo de al lado —«Descartar» tiene
 * «Recuperar», una vista se cambia por otra, un borde se vuelve a correr— y por
 * eso van directo. Borrar un comentario se lleva lo escrito y no deja nada en la
 * pantalla que lo traiga: la única vuelta atrás sería el historial, que es de la
 * clase que se está grabando. Ver `queSeBorraElComentario`.
 *
 * La pregunta va acá y no en el botón (`margen.js`) porque el botón es el mismo en
 * las dos pantallas y en la de la toma NO tiene que preguntar: lo que cambia no es
 * el gesto, es que de este lado no hay Cmd-Z. Este es el camino de una clase ya
 * cerrada, y por lo tanto el único sitio donde se sabe eso.
 */
async function seAnimaABorrarElComentario(clase, cambio) {
    const toma = (clase.tomas || []).find(t => t.id === cambio.toma);
    const comentario = toma ? (toma.comentarios || [])[cambio.indice] : null;
    return window.cc.confirmar(queSeBorraElComentario(clase, comentario));
}

/**
 * Cambiar una clase que ya terminó. El motor reescribe su XML en el mismo gesto,
 * así que acá solo hay que releer la lista para que la tarjeta muestre lo nuevo.
 */
async function editar(clase, cambio) {
    if (cambio.tipo === 'borrar-comentario' && !await seAnimaABorrarElComentario(clase, cambio)) {
        return;
    }
    const r = await window.cc.grabarEditarGrabada(clase.archivos.json, cambio);
    if (!r.ok) { toast(r.error); return; }
    anotar('grabar.edita-grabada', { clase: clase.clase, tipo: cambio.tipo });
    toast(`Clase ${clase.clase}: XML reescrito con ${DICHO[cambio.tipo] || 'el cambio'}.`);
    await cargar();
}

/** El clic derecho sobre una palabra de una clase ya grabada. */
async function bordeDe(clase, { toma, paredMs, abierta }) {
    const borde = await suyo.preguntarBorde(toma, paredMs, abierta);
    if (!borde) return;
    await editar(clase, { tipo: 'borde', toma, borde, paredMs });
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
    suyo.regenerando.set(json, { hechas: 0, total: (clase.tomas || []).length });
    pintar();
    const r = await window.cc.grabarRegenerar(json);
    suyo.regenerando.delete(json);
    if (!r.ok) {
        toast(r.error);
        pintar();
        return;
    }
    // Lo que no salió va en el mismo aviso y no se calla: una regeneración que
    // dejó tres tomas sin texto y contesta "8 tomas releídas" es la misma pérdida
    // silenciosa que la política de reintento vino a arreglar
    // (`engine/insistir.js`). Las que quedaron mal siguen marcadas en su tarjeta;
    // esto es para que alguien vaya a mirarlas.
    const leidas = r.tomas - r.sinAudio - r.sinLeer;
    const peros = [];
    if (r.sinAudio) peros.push(`${r.sinAudio} sin audio para releer`);
    if (r.sinLeer) peros.push(`${plural(r.sinLeer, 'quedó', 'quedaron')} sin releer`);
    if (r.degradadas) peros.push(`${plural(r.degradadas, 'salió', 'salieron')} con un modelo más liviano`);
    toast(`Clase ${clase.clase}: ${plural(leidas, 'toma releída', 'tomas releídas')}` +
        (peros.length ? `; ${peros.join(', ')}.` : ' y XML reescrito.'));
    await cargar();
}

/** El avance que manda el motor mientras arma el proyecto de un curso. */
export function avanceDePrproj(aviso) {
    prproj.avance(aviso);
}

/** El avance que manda el motor mientras relee una clase. */
export function avanceDeRegenerado(aviso) {
    if (!suyo.regenerando.has(aviso.json)) return;
    suyo.regenerando.set(aviso.json, { hechas: aviso.hechas, total: aviso.total });
    pintar();
}

/** Sacar una carpeta de la lista. No borra nada: solo deja de mostrarse acá. */
async function quitarCarpeta(ruta) {
    const r = await window.cc.ajustesGuardar({ notasDirs: suyo.carpetas.filter(d => d !== ruta) });
    if (!r.ok) { toast(r.error); return; }
    await cargar();
}

/** Abre el formulario, con lo que la clase dice hoy. */
function empezarRenombre(clase) {
    suyo.renombrando = {
        json: clase.archivos.json,
        clase: dosDigitos(Number(clase.clase) || 1),
        curso: clase.curso || nombreDeCarpeta(clase.carpeta)
    };
    pintar();
    const campo = $('grabar-grabadas').querySelector('.clase-renombre .grabar-num');
    if (campo) campo.select();
}

/**
 * Guardar el nombre nuevo.
 *
 * **Lo que el motor niega se muestra en el formulario y no en un aviso que se
 * va.** Se puede negar por tres cosas que solo él sabe —el nombre choca con otra
 * clase, la clase se está grabando ahora, no hay hora de captura recuperable— y
 * las tres piden hacer algo con el campo que está justo arriba. Un `toast` de dos
 * segundos y medio deja la pregunta "¿y ahora qué?" sin respuesta en pantalla.
 *
 * Y el formulario se queda con lo escrito: no se repinta la lista al fallar, así
 * que el cursor no se mueve y el nombre a medio corregir sigue ahí.
 */
async function renombrar(clase, numero, curso, donde) {
    donde.guardar.disabled = true;
    donde.guardar.textContent = 'Guardando…';
    donde.mal.hidden = true;
    const r = await window.cc.grabarRenombrar(clase.archivos.json, {
        clase: numeroLeido(numero),
        curso
    });
    if (!r.ok) {
        donde.guardar.disabled = false;
        donde.guardar.textContent = 'Guardar';
        donde.mal.textContent = r.error;
        donde.mal.hidden = false;
        anotar('grabar.renombrar-negado', { error: r.error });
        return;
    }
    anotar('grabar.renombra', { secuencia: r.secuencia, audios: r.audios });
    suyo.renombrando = null;
    toast(r.movida
        ? `Quedó como «${r.secuencia}»${r.audios ? `, con su audio` : ''}.`
        : 'El nombre quedó igual: no había nada que mover.');
    await cargar();
}

/**
 * Borrar una clase, con el cartel que dice qué se va a borrar.
 *
 * La confirmación es de acá y no del motor: cuando el gesto llega al motor ya
 * está decidido, y él borra. Lo que hace falta antes es que la pregunta nombre
 * los tres archivos, porque la respuesta a "¿seguro?" no significa nada y la
 * respuesta a "se van el XML, los datos y dos audios de la carpeta tal" sí.
 */
async function borrarClase(clase) {
    const ok = await window.cc.confirmar(queSeBorra(clase));
    if (!ok) return;
    const r = await window.cc.grabarBorrar(clase.archivos.json);
    if (!r.ok) { toast(r.error); return; }
    anotar('grabar.borra', { secuencia: r.secuencia, audios: r.audios });
    // Lo que se fue de verdad, que puede ser menos de lo que el cartel anunciaba:
    // un audio que alguien ya había movido a mano no estaba para borrar.
    const fue = [r.xml && 'el XML', r.sidecar && 'sus datos',
        r.audios && plural(r.audios, 'audio', 'audios')].filter(Boolean);
    toast(fue.length
        ? `Borrada: ${fue.join(', ')}.`
        : 'No quedaba ningún archivo de esa clase para borrar.');
    // Si la que se borró era la que se estaba renombrando, el formulario se va con
    // ella: apunta a un archivo que ya no está.
    if (suyo.renombrando && suyo.renombrando.json === clase.archivos.json) suyo.renombrando = null;
    await cargar();
}

/* ─── El cableado ────────────────────────────────────────────────────────── */

/**
 * @param {object} deps {
 *   vistas() — las que se le pueden poner a una toma, que las pide la ventana,
 *   preguntarBorde(toma, paredMs, abierta) — el diálogo de cuál de los dos bordes,
 *   alComenzar() — entrar a la toma de notas }
 */
export function cablear(deps) {
    if (suyo.cableada) return;
    suyo.cableada = true;
    suyo.vistas = deps.vistas;
    suyo.preguntarBorde = deps.preguntarBorde;
    suyo.alComenzar = deps.alComenzar;
    // El botón del curso guarda su propio avance porque el cabezal se rehace
    // entero en cada relectura; lo único que necesita de acá es poder pedir que
    // se redibuje (ver `prproj.js`).
    prproj.cablear({ pintar });

    for (const boton of document.querySelectorAll('.grabadas-modo')) {
        boton.onclick = () => {
            suyo.modo = boton.dataset.modo;
            recordar(MODO_RECORDADO, suyo.modo);
            pintar();
        };
    }
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
        await cargar();
    };
    $('grabar-comenzar').onclick = () => suyo.alComenzar();
}
