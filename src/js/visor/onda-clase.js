'use strict';
/**
 * onda-clase.js — El audio dibujado en «Ver la clase»: dentro de cada clip de
 * la tira y, en grande, el del bloque que está sonando con sus subtítulos.
 *
 * Para qué: la tira de colores dice CON QUÉ se ve cada bloque, pero nada de lo
 * que se oye. Mirando la silueta se ve de un vistazo si un bloque entra sobre
 * una palabra empezada, si termina cortando una frase o si hay diez segundos de
 * nada en el medio — y eso es lo que se está juzgando al aprobar un corte.
 *
 * De dónde salen los picos, que es la decisión de fondo acá:
 *
 * - En la tira, del recorte de lo que ya está medido (`rev.data.waveform`, 1200
 *   cubos de la clase entera). Medido en la clase 1 del curso real: cada bloque
 *   se lleva entre 5 y 22 cubos y ocupa unos 7 px por cubo, que a 25 px de alto
 *   es una silueta legible. Volver a leer disco para eso sería regalar plata.
 *
 * - En el panel de abajo del video, del disco. Ahí UN bloque ocupa los ~945 px
 *   del ancho, así que esos mismos 22 cubos serían 43 px cada uno: una escalera,
 *   no un audio. Se pide el detalle con `waveformWindow`, una vez por bloque y
 *   guardado.
 *
 * Que una llamada por bloque se pague sola, medido con el arnés sobre la clase 1
 * mientras la clase se reproducía: las quince lecturas seguidas tardaron 536 ms
 * en total (~36 ms cada una) y el peor hueco entre cuadros durante esas lecturas
 * fue de 9,4 ms — exactamente el mismo que reproduciendo sin hacer nada. La
 * lectura es sincrónica pero pasa en el proceso principal y no en el latido, así
 * que no se le cae un cuadro a nadie. Los saltos de bloque cuestan 34 ms cuando
 * cambia la cámara, y eso ya era así antes de esto (medido contra el código sin
 * el panel: 36 ms el peor, 11 ms la mediana; con el panel, 38 y 12).
 *
 * Mientras el detalle viaja se dibuja el recorte, así que nunca hay un hueco
 * esperando al disco: la silueta gruesa aparece en el acto y se afina.
 *
 * Las dos se apagan juntas con el interruptor de la barra, y los subtítulos no:
 * el por qué está en `aplicarMostrar`.
 */

import { $, toast } from '../chrome.js';
import { rev } from './estado.js';
// Con otro nombre: acá ya hay un `guardar`, el que recuerda el interruptor.
import { notas, guardar as guardarNotas } from './comentarios.js';
import { medidaDelCanvas } from './onda.js';
import { porColumna, recortarPicos, techoDePicos } from './picos.js';
import { frasesEn } from './pista.js';

/**
 * Cómo se reparte el alto de un clip de la tira.
 *
 * Los primeros píxeles quedan con el color de la cámara solo, y abajo va la
 * onda sobre un fondo más oscuro: es la forma en que Premiere dibuja un clip
 * con audio y video, así que no hay nada nuevo que aprender. Los últimos se
 * dejan libres a propósito: ahí abajo la tira dibuja la línea de "conviene
 * revisarlo" (`.player-block.is-revisar::after`) y el canvas va por encima de
 * los bloques, así que pintar hasta el borde la taparía.
 */
const ALTO_DEL_COLOR = 15;
const AIRE_PARA_LAS_LINEAS = 5;

/**
 * Que las ondas estén prendidas se recuerda, igual que el volumen y el ancho
 * del panel: quien revisa en limpio no tiene que apagarlas en cada clase.
 * Mismo `try/catch` que `division.js` por si el modo privado no deja guardar.
 */
const RECORDADO = 'cc.ondas-de-la-clase';

const estado = {
    /**
     * El detalle de cada bloque, por su tramo de la grabación.
     *
     * La clave es el pedazo de archivo y no el índice del tramo porque la pista
     * se rearma cada vez que se entra a la pestaña: con el índice, volver a
     * entrar tiraría a la basura quince lecturas de disco que siguen valiendo.
     */
    detalle: new Map(),
    clase: null,
    // El pico contra el que se mide la silueta. Se calcula al abrir la clase y
    // no cambia: si se recalculara por bloque, la onda cambiaría de tamaño al
    // saltar y el editor leería un cambio de volumen que no existe.
    techo: null,
    // Los bloques que están viajando, para no pedir dos veces el mismo al
    // saltar de ida y de vuelta entre dos bloques.
    pidiendo: new Set(),
    tramo: null,
    frases: [],
    fraseActiva: -1,
    alSaltar: null,
    // Si se dibuja el audio. Lo pone el interruptor de la barra y lo miran las
    // dos funciones que pintan: apagado, ninguna toca su canvas.
    mostrar: true
};

function claveDe(tramo) {
    return `${tramo.origenDesdeSec.toFixed(3)}-${tramo.origenHastaSec.toFixed(3)}`;
}

/**
 * Un canvas con el búfer que le corresponde a la pantalla.
 *
 * La cuenta es la de `onda.js` —y su prueba— a propósito: acá vivía un
 * desperfecto que dejaba el canvas en blanco por leerle el alto al búfer en vez
 * de al CSS, y no hay razón para tener dos versiones de esa cuenta.
 */
function lienzo(canvas) {
    const medida = medidaDelCanvas(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio);
    canvas.width = medida.bufferWidth;
    canvas.height = medida.bufferHeight;
    const ctx = canvas.getContext('2d');
    const ratio = medida.bufferHeight / medida.height;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, medida.width, medida.height);
    return { ctx, width: medida.width, height: medida.height };
}

/**
 * Contra qué pico se mide el alto, calculado una vez por clase.
 *
 * Lo comparten la tira y el panel de abajo del video: con dos escalas, el mismo
 * bloque se vería con dos siluetas distintas en la misma pantalla.
 */
function techo() {
    const onda = rev.data && rev.data.waveform;
    if (estado.techo == null) estado.techo = techoDePicos(onda ? onda.peaks : []);
    return estado.techo;
}

/** La silueta, simétrica sobre el medio de la banda que se le da. */
function dibujarPicos(ctx, picos, x0, x1, arriba, abajo, color) {
    const ancho = Math.max(1, Math.round(x1 - x0));
    const alto = Math.max(1, abajo - arriba);
    const medio = arriba + alto / 2;
    const limite = techo();
    ctx.fillStyle = color;
    const columnas = porColumna(picos, ancho);
    for (let x = 0; x < columnas.length; x++) {
        // Se recorta en 1 porque el detalle pedido al disco puede pasar el techo
        // de la clase: con cubos más finos se ven ataques que el resumen aplana
        // (medido en el primer bloque: 0,086 en el detalle contra 0,048 en el
        // recorte). Sin el recorte, esa onda se sale de su banda.
        const relativo = Math.min(1, columnas[x] / limite);
        // Mínimo un píxel: sin esto el silencio no se dibuja y la onda se corta,
        // que se lee como que faltan datos en vez de como que no se dice nada.
        const h = Math.max(1, relativo * alto);
        ctx.fillRect(x0 + x, medio - h / 2, 1, h);
    }
}

/** Lo que hay medido de un tramo, del disco si ya llegó y del recorte si no. */
function picosDe(tramo) {
    const fino = estado.detalle.get(claveDe(tramo));
    if (fino) return fino;
    const onda = rev.data && rev.data.waveform;
    if (!onda || !onda.peaks) return [];
    return recortarPicos(onda.peaks, rev.data.durationSec, tramo.origenDesdeSec, tramo.origenHastaSec);
}

// ─── La onda adentro de cada clip de la tira ──────────────────────────

/**
 * Un solo canvas para los quince bloques, no uno por bloque.
 *
 * La tira es una sola línea de tiempo y el canvas la cubre entera, así que la
 * cuenta de dónde va cada bloque es la misma que ya hace `pintarBloques` con
 * los porcentajes. Con un canvas por bloque habría quince búferes de dibujo
 * para una franja de 25 px de alto, y encima habría que sincronizar quince
 * medidas cada vez que la ventana cambia de ancho.
 *
 * Va POR ENCIMA de los botones y sin recibir clics: los bloques siguen siendo
 * botones de verdad, con su `title` y su hover. Lo que el canvas no pinta se ve
 * a través, que es lo que deja intactas las dos líneas de la tira.
 */
export function pintarOndaDeLaTira(pista) {
    const canvas = $('player-tira-onda');
    if (!canvas) return;
    // Apagado no se mide ni se dibuja: el canvas está en `display: none` y ahí
    // sus medidas son cero, así que `lienzo` armaría el búfer de respaldo de
    // 800 px y `dibujarPicos` recorrería quince bloques para nadie.
    if (!estado.mostrar) return;
    const { ctx, width, height } = lienzo(canvas);
    if (!pista || !pista.tramos.length) return;
    // Una clase sin Live-Mix no tiene onda, y ahí la tira vuelve a ser lo que
    // era: clips de color. Dibujar la banda oscura con una línea al medio sería
    // decir que en toda la clase no se dice nada.
    const onda = rev.data && rev.data.waveform;
    if (!onda || !onda.peaks || !onda.peaks.length) return;

    const total = pista.duracionSec || 1;
    const abajo = Math.max(ALTO_DEL_COLOR + 4, height - AIRE_PARA_LAS_LINEAS);

    for (const tramo of pista.tramos) {
        const x0 = (tramo.desdeSec / total) * width;
        const x1 = (tramo.hastaSec / total) * width;
        // El fondo de la parte de audio, más oscuro que el color de la cámara:
        // sin él la silueta clara sobre el celeste de la cámara 1 se pierde.
        ctx.fillStyle = 'rgba(9, 11, 15, .34)';
        ctx.fillRect(x0, ALTO_DEL_COLOR, Math.max(1, x1 - x0), abajo - ALTO_DEL_COLOR);
        dibujarPicos(ctx, picosDe(tramo), x0, x1, ALTO_DEL_COLOR + 1, abajo - 1, 'rgba(240, 243, 248, .72)');
    }
}

// ─── La onda del bloque que se está reproduciendo ─────────────────────

function pintarLaGrande() {
    const canvas = $('onda-canvas');
    const tramo = estado.tramo;
    if (!estado.mostrar) return;
    const { ctx, width, height } = lienzo(canvas);

    const picos = tramo ? picosDe(tramo) : [];
    // Una clase sin Live-Mix no tiene con qué dibujar, y un cuadro vacío sin
    // explicación se lee como que el panel se rompió.
    $('onda-vacia').hidden = !tramo || picos.length > 0;
    if (!picos.length) return;

    dibujarPicos(ctx, picos, 0, width, 2, height - 2, 'rgba(200, 207, 222, .85)');
}

/**
 * Los subtítulos como clips sobre la onda.
 *
 * Es lo que vuelve útil al panel: sobre la silueta se ve dónde hay sonido, y
 * con las frases encima se ve QUÉ es ese sonido y en qué parte del bloque cae.
 * Hacer clic lleva la reproducción ahí, que es el gesto que se pide solo en
 * cuanto se ven.
 *
 * Se arman elemento por elemento y con `.style`: la política de seguridad de la
 * ventana (`style-src 'self'`) descarta los atributos `style` escritos en el
 * marcado sin avisar, y con quince frases posicionadas por porcentaje eso
 * significa quince clips amontonados a la izquierda.
 */
function pintarLasFrases() {
    const caja = $('onda-frases');
    caja.replaceChildren();
    estado.fraseActiva = -1;
    if (!estado.tramo) return;

    estado.frases.forEach((frase, i) => {
        const yaComentada = comentarioDe(frase);
        const clip = document.createElement('button');
        clip.className = 'onda-frase'
            + (frase.cortadaAlEntrar ? ' es-cortada-antes' : '')
            + (frase.cortadaAlSalir ? ' es-cortada-despues' : '')
            + (yaComentada ? ' es-comentada' : '');
        clip.dataset.frase = String(i);
        clip.style.left = `${frase.fraccionDesde * 100}%`;
        clip.style.width = `${Math.max(0, frase.fraccionHasta - frase.fraccionDesde) * 100}%`;
        clip.textContent = frase.texto;
        const aclaracion = (frase.cortadaAlEntrar || frase.cortadaAlSalir)
            ? '\n\n(el bloque la corta: se oye solo el pedazo que se ve)' : '';
        clip.title = `${frase.texto}${aclaracion}\n\n`
            + (yaComentada ? `Comentado: ${yaComentada.comentario}` : 'Clic derecho para comentar');
        caja.appendChild(clip);
    });
}

/* ─── Comentar una frase ────────────────────────────────────────────────── */

/**
 * El comentario que ya cubre a una frase, si hay.
 *
 * Se busca por el ARRANQUE, que es donde queda anclado el comentario: dos frases
 * seguidas no comparten arranque, así que no hay forma de que una se lleve el
 * comentario de la de al lado.
 */
function comentarioDe(frase) {
    return ((notas().comentarios) || []).find(c =>
        c.sourceStartSec >= frase.origenDesdeSec - 0.01
        && c.sourceStartSec < frase.origenHastaSec) || null;
}

/**
 * Comentar la frase con el botón derecho.
 *
 * Es el mismo comentario que se escribe seleccionando texto en el panel de al
 * lado o en el guion —mismo almacén, mismo ancla al tiempo de la grabación, mismo
 * marcador en el XML—, solo que acá la selección ya está hecha: la frase ES el
 * tramo. Mirando la clase, que es cuando se nota que algo sobra, esto ahorra
 * tener que ir a buscar ese mismo texto al panel para poder marcarlo.
 *
 * Con el derecho y no con el izquierdo porque el izquierdo ya tiene trabajo:
 * lleva la reproducción ahí, que es el gesto que se pide solo al ver los clips.
 */
function abrirComentario(indice, cerca) {
    const frase = estado.frases[indice];
    if (!frase) return;
    cerrarComentario();

    const existente = comentarioDe(frase);
    const caja = document.createElement('div');
    caja.className = 'onda-comentario';
    caja.id = 'onda-comentario';

    const cita = document.createElement('div');
    cita.className = 'onda-comentario-cita';
    cita.textContent = frase.texto;

    const campo = document.createElement('textarea');
    campo.className = 'onda-comentario-campo';
    campo.rows = 2;
    campo.placeholder = 'Tu comentario para el editor…';
    campo.value = existente ? existente.comentario : '';

    const acciones = document.createElement('div');
    acciones.className = 'onda-comentario-acciones';
    const ok = document.createElement('button');
    ok.className = 'btn btn-primary btn-inline';
    ok.textContent = existente ? 'Guardar' : 'Comentar';
    ok.onclick = () => confirmar(frase, existente, campo.value);
    acciones.append(ok);
    if (existente) {
        const borrar = document.createElement('button');
        borrar.className = 'btn btn-ghost btn-inline';
        borrar.textContent = 'Borrar';
        borrar.onclick = () => quitar(existente);
        acciones.append(borrar);
    }
    const no = document.createElement('button');
    no.className = 'btn btn-ghost btn-inline';
    no.textContent = 'Cancelar';
    no.onclick = cerrarComentario;
    acciones.append(no);

    caja.append(cita, campo, acciones);
    // Cuelga de la columna y no del panel de la onda: ese recorta lo que se sale
    // (`overflow: hidden`, que es lo que mantiene la onda adentro del cuadro), y
    // la caja va justo por ARRIBA de los clips, o sea afuera.
    const columna = $('player-onda').parentElement;
    columna.appendChild(caja);
    // Centrada en la frase y sin salirse de la columna: puesta en el puntero a
    // secas, una frase del final abre la caja medio afuera de la ventana.
    const marco = columna.getBoundingClientRect();
    const ancho = caja.offsetWidth;
    caja.style.left = `${Math.max(4, Math.min(marco.width - ancho - 4, cerca - marco.left - ancho / 2))}px`;
    campo.focus();
}

function cerrarComentario() {
    const caja = document.getElementById('onda-comentario');
    if (caja) caja.remove();
}

async function confirmar(frase, existente, texto) {
    const limpio = String(texto || '').trim();
    if (!limpio) { toast('El comentario está vacío.'); return; }

    if (existente) {
        existente.comentario = limpio;
    } else {
        // Sin id: lo acuña `engine/notas.js` al guardar, que es el único que los
        // reparte.
        notas().comentarios.push({
            sourceStartSec: frase.origenDesdeSec,
            sourceEndSec: frase.origenHastaSec,
            texto: frase.texto,
            comentario: limpio
        });
    }
    cerrarComentario();
    if (await guardarNotas()) {
        pintarLasFrases();
        toast('Comentario guardado. Va a salir como marcador en el XML.');
    }
}

async function quitar(comentario) {
    notas().comentarios = notas().comentarios.filter(c => c.id !== comentario.id);
    cerrarComentario();
    if (await guardarNotas()) pintarLasFrases();
}

/**
 * El bloque cambió: onda nueva, frases nuevas.
 *
 * Se llama en cada salto de bloque, así que lo primero que dibuja es el recorte
 * —que no cuesta nada— y el detalle se pide aparte.
 */
export function pintarOndaDelBloque(tramo) {
    estado.tramo = tramo || null;
    estado.frases = tramo ? frasesEn(tramo, (rev.data && rev.data.segments) || []) : [];
    $('player-onda').classList.toggle('sin-bloque', !tramo);
    // Lo mira el CSS para esconder el panel entero cuando además está apagada la
    // onda: sin las dos cosas no queda nada adentro.
    $('player-onda').classList.toggle('sin-frases', !estado.frases.length);
    pintarLaGrande();
    pintarLasFrases();
    // Leer disco para una onda apagada es pagar por algo que nadie mira. Si el
    // interruptor se prende después, el detalle se pide ahí (`aplicarMostrar`).
    if (tramo && estado.mostrar) pedirDetalle(tramo);
}

/** La aguja sobre la onda grande, y qué frase está sonando. */
export function moverAgujaDeOnda(posicionSec) {
    const tramo = estado.tramo;
    if (!tramo || !tramo.duracionSec) {
        $('onda-head').hidden = true;
        return;
    }
    const adentro = (posicionSec - tramo.desdeSec) / tramo.duracionSec;
    $('onda-head').hidden = false;
    $('onda-head').style.left = `${Math.max(0, Math.min(1, adentro)) * 100}%`;

    // Esto corre una vez por cuadro: solo se toca el DOM cuando la frase cambió
    // de verdad, por lo mismo que el panel de texto no repinta sesenta veces por
    // segundo (ver `panel-letra.seguir`).
    const activa = estado.frases.findIndex(f => adentro >= f.fraccionDesde && adentro < f.fraccionHasta);
    if (activa === estado.fraseActiva) return;
    const antes = $('onda-frases').querySelector('.onda-frase.is-on');
    if (antes) antes.classList.remove('is-on');
    if (activa >= 0) {
        const clip = $('onda-frases').querySelector(`.onda-frase[data-frase="${activa}"]`);
        if (clip) clip.classList.add('is-on');
    }
    estado.fraseActiva = activa;
}

async function pedirDetalle(tramo) {
    const clave = claveDe(tramo);
    if (estado.detalle.has(clave) || estado.pidiendo.has(clave)) return;
    if (!rev.data || !rev.data.liveMixPath) return;

    estado.pidiendo.add(clave);
    const detalle = await window.cc.waveformWindow({
        path: rev.data.liveMixPath,
        fromSec: tramo.origenDesdeSec,
        toSec: tramo.origenHastaSec,
        // Un punto por píxel de panel y no más: `porColumna` junta todo lo que
        // caiga en la misma columna, así que pedir el doble es leer disco para
        // tirarlo. Con el bloque más largo de la clase 1 (45 s) quedan 27 puntos
        // por segundo, de sobra para ver dónde arranca una palabra.
        buckets: 1200
    });
    estado.pidiendo.delete(clave);
    if (!detalle || !detalle.peaks) return;
    estado.detalle.set(clave, detalle.peaks);
    // Mientras se leía el disco el editor pudo saltar a otro bloque: el detalle
    // se guarda igual —ya está pagado— pero repintar sería dibujar el bloque
    // anterior sobre el que está sonando.
    if (!estado.tramo || claveDe(estado.tramo) !== clave) return;
    pintarLaGrande();
    // La tira también mejora con el detalle del bloque que se acaba de pisar.
    pintarOndaDeLaTira(rev.pista);
}

// ─── El interruptor ───────────────────────────────────────────────────

/**
 * Uno solo para las dos ondas, y sin llevarse los subtítulos.
 *
 * Uno para las dos porque lo que se pidió es "interfaz limpia": son la misma
 * cosa mirada de cerca y de lejos —el mismo audio, el mismo techo, los mismos
 * picos— así que dos interruptores serían dos preguntas para una decisión.
 *
 * Y los clips de subtítulos se quedan porque no son lo mismo: la onda es
 * referencia visual (dónde hay sonido) y las frases son el índice del bloque
 * (qué se dice y dónde). Construido, además, se ve que separarlos no queda
 * raro: apagada la onda, el panel se encoge a la fila de frases con la aguja
 * cruzándola, y eso queda como una línea de tiempo del texto, que es
 * exactamente para lo que sirve. Lo único que hubo que arreglar fue el borde de
 * abajo, que sin la onda debajo pasaba a ser un doble borde (ver `visor.css`).
 *
 * Lo que se apaga se apaga en el CSS y no borrando los canvas: así el alto de la
 * tira y del panel también se acomodan, que es de dónde salen los píxeles que
 * gana la imagen.
 */
function aplicarMostrar() {
    $('rev-player').classList.toggle('sin-ondas', !estado.mostrar);
    // Al arrancar la app esto corre con el reproductor cerrado y sin pista: no
    // hay nada que dibujar y las medidas de todo son cero.
    if (!estado.mostrar || $('rev-player').hidden) return;
    pintarOndaDeLaTira(rev.pista);
    pintarLaGrande();
    // Prendiéndola, el detalle del bloque que suena puede no haberse pedido
    // nunca: se dibuja el recorte y se afina cuando llega, igual que en un salto.
    if (estado.tramo) pedirDetalle(estado.tramo);
}

function guardar() {
    try { localStorage.setItem(RECORDADO, estado.mostrar ? '1' : '0'); } catch { /* modo privado */ }
}

/** Prendidas salvo que se hayan apagado a mano: es el modo con más información. */
function recordado() {
    try { return localStorage.getItem(RECORDADO) !== '0'; } catch { return true; }
}

// ─── Ciclo de vida ────────────────────────────────────────────────────

export function abrirOndas() {
    // Otra clase, otro Live-Mix: el detalle guardado es de un archivo que ya no
    // es el que se está mirando.
    if (estado.clase !== rev.id) {
        estado.detalle.clear();
        estado.pidiendo.clear();
        estado.techo = null;
        estado.clase = rev.id;
    }
}

/**
 * Al salir de la pestaña o de la clase.
 *
 * Deja el panel en blanco de verdad, canvas incluido: una clase sin bloques
 * nunca llega a pedir su onda (el reproductor se corta antes), así que sin
 * borrar acá quedaría dibujada la del audio de la clase anterior debajo de un
 * cartel que dice que no hay nada para ver.
 */
export function cerrarOndas() {
    pintarOndaDelBloque(null);
    $('onda-head').hidden = true;
}

/**
 * @param {Function} alSaltar adónde llevar la reproducción, en tiempo del corte
 *   final: lo resuelve el reproductor, que es el único que sabe reproducir.
 */
export function wireOndas(alSaltar) {
    estado.alSaltar = alSaltar;

    const interruptor = $('player-ondas');
    estado.mostrar = recordado();
    interruptor.checked = estado.mostrar;
    aplicarMostrar();
    interruptor.addEventListener('change', () => {
        estado.mostrar = interruptor.checked;
        guardar();
        aplicarMostrar();
    });

    /**
     * Después de apagarlas con el mouse, el foco se va.
     *
     * Es por la barra espaciadora, que en esta pestaña es reproducir y pausar.
     * Una casilla SÍ usa la barra —es su tecla de activación— así que con el foco
     * acá el atajo deja de reproducir y prende y apaga las ondas: comprobado con
     * el arnés, `Space` con el foco en la casilla la destildó y el botón se quedó
     * en ▶. Y no se puede pisar la tecla sin dejar la casilla inservible para
     * quien no usa mouse.
     *
     * Así que se suelta el foco solo cuando vino del mouse, que es cuando nadie
     * lo pidió. `detail` en 0 es un clic que no salió del mouse —la barra o Enter
     * sobre el foco—, y ahí el foco se queda donde estaba: tabulando llega, la
     * barra la prende y la apaga, y el atajo de reproducir es lo que se cede a
     * cambio, que es lo que quiso quien tabuló hasta acá.
     */
    interruptor.addEventListener('click', evento => {
        if (evento.detail > 0) interruptor.blur();
    });

    $('onda-frases').addEventListener('click', evento => {
        const clip = evento.target.closest('.onda-frase');
        if (!clip || !estado.alSaltar) return;
        const frase = estado.frases[Number(clip.dataset.frase)];
        if (frase) estado.alSaltar(frase.desdeSec);
    });

    $('onda-frases').addEventListener('contextmenu', evento => {
        const clip = evento.target.closest('.onda-frase');
        if (!clip) return;
        // Sin esto sale el menú del sistema encima de la caja recién abierta.
        evento.preventDefault();
        abrirComentario(Number(clip.dataset.frase), evento.clientX);
    });

    // Fuera de la caja se cierra, como cualquier cosa que se abre sobre lo demás.
    // Con `Escape` también, que es lo que la mano hace primero.
    document.addEventListener('pointerdown', evento => {
        const caja = document.getElementById('onda-comentario');
        if (caja && !caja.contains(evento.target)) cerrarComentario();
    });
    document.addEventListener('keydown', evento => {
        if (evento.key === 'Escape') cerrarComentario();
    });

    // Clic en la onda: la aguja va ahí. Es la misma cuenta que la tira de
    // bloques, pero adentro de un solo bloque, que es la escala en la que se
    // busca "justo antes de que diga eso".
    $('onda-canvas').addEventListener('click', evento => {
        const tramo = estado.tramo;
        if (!tramo || !estado.alSaltar) return;
        const caja = $('onda-canvas').getBoundingClientRect();
        if (!caja.width) return;
        const fraccion = Math.max(0, Math.min(1, (evento.clientX - caja.left) / caja.width));
        estado.alSaltar(tramo.desdeSec + fraccion * tramo.duracionSec);
    });

    /**
     * Los canvas se dibujan en píxeles, así que hay que repintarlos cada vez que
     * cambian de tamaño o la silueta queda estirada.
     *
     * Se vigila el tamaño de los elementos y no `window.resize` porque el ancho
     * del panel cambia también sin que la ventana se mueva: arrastrando el
     * divisor del panel de texto (`division.js`) el panel se angostó 24 px y la
     * onda quedó dibujada con el búfer del ancho anterior, estirada un 2,5%.
     * Y al volver a la pestaña, donde antes medían cero.
     *
     * No se realimenta —que es el riesgo de repintar desde acá— porque el tamaño
     * en pantalla de los dos canvas lo fija el CSS y no depende del búfer: es la
     * misma razón por la que el alto del panel está escrito en `visor.css`.
     */
    const vigilar = new ResizeObserver(() => {
        if ($('rev-player').hidden) return;
        pintarOndaDeLaTira(rev.pista);
        pintarLaGrande();
    });
    vigilar.observe($('player-onda'));
    vigilar.observe($('player-track'));
}
