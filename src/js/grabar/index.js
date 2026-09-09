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

import { $, showView, toast, anotar, estaEscribiendo, recordar, recordado } from '../chrome.js';
import { fmtHora, plural } from '../formato.js';
import { marcarPaso, PASOS } from '../pasos.js';
import * as oido from './oido.js';
import * as ojo from './ojo.js';
import * as tomas from './tomas.js';
import * as grabadas from './grabadas.js';
import * as analisis from './analisis.js';

/**
 * Lo que la ventana recuerda por su cuenta: la última entrada de audio elegida
 * —el id del dispositivo lo da el navegador— y cómo se quiere ver la lista de
 * lo grabado. La carpeta de notas NO: esa la necesita también el escáner de
 * post, así que vive en los ajustes (`ajustes.notasDir`) y tiene un solo dueño.
 */
const ENTRADA_RECORDADA = 'cc.grabar.entrada';
const MODO_RECORDADO = 'cc.grabar.modo';
// Clave nueva y no la de antes (`cc.grabar.orillas`): ese interruptor escondía
// solo el gris de alrededor, y quien lo dejó apagado no pidió quedarse sin el
// texto entero. Lo guardado con el significado viejo se ignora y vale el default.
const TRANSCRIPT_RECORDADO = 'cc.grabar.transcript';

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
    // Si se ve el texto de cada toma. Encendido por defecto: es sobre el texto que
    // se comenta un pedazo y se arrastra un borde, así que apagado la pantalla se
    // lee pero no se trabaja.
    transcript: recordado(TRANSCRIPT_RECORDADO) !== 'no',
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
 * Ver o no el texto de las tomas, para toda la pantalla de una vez.
 *
 * Es una clase en la vista entera y no un cambio en lo que se dibuja: son las
 * mismas palabras dibujadas siempre, así que apagarlas es CSS y encenderlas de
 * nuevo no cuesta nada ni pide releer nada. Que la caja siga en el documento es
 * lo que deja que la selección y el arrastre de bordes sigan cableados: al
 * encender otra vez, el texto está donde estaba.
 *
 * Vale igual para la clase en curso y para las ya grabadas: el interruptor dice
 * "transcript", no "transcript de esta clase".
 */
function pintarTranscript() {
    $('view-grabar').classList.toggle('es-sin-transcript', !vista.transcript);
    const boton = $('grabar-transcript');
    boton.setAttribute('aria-pressed', String(vista.transcript));
    boton.classList.toggle('is-elegido', vista.transcript);
}

function pintar() {
    plegarSegunGrabe();
    pintarEnCurso();
    tomas.pintar($('grabar-tomas'), vista.estado, acciones);
    pintarGrabadas();
    pintarTranscript();
    analisis.pintar($('grabar-analisis'), vista.estado);
    pintarClaqueta();
    decirDonde();
    refrescarBotones();
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
    borde: 'el borde movido'
};

/**
 * Clic derecho sobre una palabra: cuál de los dos bordes va ahí.
 *
 * Se pregunta porque los dos gestos cuestan lo mismo y el de abrir sirve cuando
 * el conteo se comió la primera palabra de la clase. Está aparte de quien lo usa
 * porque lo usan dos: la clase en curso y una ya grabada, y la pregunta tiene que
 * ser la misma —lo que cambia es a qué archivo va el cambio, no el gesto—.
 *
 * @returns {'in'|'out'|null} null si se canceló
 */
async function preguntarBorde(toma, paredMs) {
    const cual = await window.cc.preguntar({
        titulo: `Mover un borde de la toma ${toma}`,
        mensaje: `A las ${fmtHora(paredMs)}, que es donde está esa palabra.`,
        opciones: ['Cortar el OUT acá', 'Abrir el IN acá']
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
async function bordeDeGrabada(clase, { toma, paredMs }) {
    const borde = await preguntarBorde(toma, paredMs);
    if (!borde) return;
    await editarGrabada(clase, { tipo: 'borde', toma, borde, paredMs });
}

/** Sacar una carpeta de la lista. No borra nada: solo deja de mostrarse acá. */
async function quitarCarpeta(ruta) {
    const r = await window.cc.ajustesGuardar({ notasDirs: vista.carpetas.filter(d => d !== ruta) });
    if (!r.ok) { toast(r.error); return; }
    await cargarGrabadas();
}

/** Todo cambio pasa por el motor y se repinta con lo que conteste. */
const acciones = {
    alCambiar: async cambio => {
        vista.estado = await window.cc.grabarEditar(cambio);
        pintar();
    },
    alCerrar: async () => {
        vista.estado = await window.cc.grabarCerrarToma();
        pintar();
    },
    /** Clic derecho sobre una palabra de la clase en curso (`preguntarBorde`). */
    alBorde: async ({ toma, paredMs }) => {
        const borde = await preguntarBorde(toma, paredMs);
        if (!borde) return;
        vista.estado = await window.cc.grabarEditar({ tipo: 'borde', toma, borde, paredMs });
        anotar('grabar.borde', { toma, borde });
        pintar();
    }
};

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
 * La barra espaciadora no puede abrir ni cerrar nada.
 *
 * Se pensó y se descartó: el editor está escribiendo comentarios mientras la
 * clase corre, y una tecla que cierre una toma por error no se deshace —el audio
 * siguió—. Las tomas las abren y las cierran las palabras del profesor, que es
 * de donde salen los tiempos buenos.
 */
function teclas(e) {
    if (estaEscribiendo(document.activeElement)) return;
    if (e.key === 'Escape') {
        const caja = document.querySelector('.toma-caja');
        if (caja) { caja.remove(); e.preventDefault(); }
    }
}

/** Se cablea una vez; entrar y salir del paso no vuelve a pedir el micrófono. */
export function wireGrabar() {
    if (vista.cableado) return;
    vista.cableado = true;

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
    $('grabar-transcript').onclick = () => {
        vista.transcript = !vista.transcript;
        recordar(TRANSCRIPT_RECORDADO, vista.transcript ? 'si' : 'no');
        pintarTranscript();
    };
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
        vista.estado = await window.cc.grabarClaqueta(Date.now());
        anotar('grabar.claqueta-a-mano', {});
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
