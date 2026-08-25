'use strict';
/**
 * reproductor.js — Ver la clase ya cortada, sin exportar ni abrir Premiere.
 *
 * Reproduce los bloques uno detrás de otro saltándose lo que queda afuera, así
 * que lo que se ve acá es lo que va a salir del XML. Es la única manera de
 * juzgar un corte de verdad: en la lista de bloques un borde es un número, y
 * escuchando segundo y medio no se sabe si la clase se entiende de punta a punta.
 *
 * Hay un `<video>` por cámara, no uno solo al que se le cambia el archivo:
 * cambiar `src` obliga a Chromium a volver a abrir un archivo de 15 GB y el
 * corte se nota como un parpadeo. Con un elemento por cámara, cambiar de plano
 * es esconder uno y mostrar el otro, y además se puede dejar al siguiente ya
 * posicionado en su bloque mientras el actual todavía está sonando.
 *
 * El límite del bloque se vigila con `requestAnimationFrame` y no con
 * `timeupdate`: ese avisa unas cuatro veces por segundo, y llegar tarde
 * doscientos milisegundos significa colar en cada corte un pedazo de lo que
 * justamente se decidió sacar.
 */

import { $, toast } from '../chrome.js';
import { esc, fmtClock } from '../formato.js';
import { rev, cambio } from './estado.js';
import { COLORES_DE_CAMARA, comentariosEn, construir, enPosicion, posicionDeBloque, seTermino, siguiente } from './pista.js';
import { abrirLetra, cerrarLetra, seguir } from './panel-letra.js';

/**
 * Cuánto puede separarse el recuadro de la imagen principal antes de reacomodarlo.
 *
 * Son dos `<video>` distintos andando en paralelo: el navegador no los mantiene
 * pegados y con los minutos se corren. Un cuarto de segundo no se nota en un
 * plano del profesor escuchándose a sí mismo, y corregir por menos que eso hace
 * que el recuadro dé saltitos todo el tiempo.
 */
const DESFASE_TOLERADO_SEC = 0.25;

/**
 * Qué vista es "el profesor de frente", la que va en el recuadro.
 *
 * Sale de los marcadores del director de contenido —`PV` es su plano— y no de
 * un número de cámara, porque el mapa de vistas puede apuntar a otra cámara
 * según la clase.
 */
const VISTA_DEL_PROFESOR = 'PV';

const estado = {
    pista: null,
    videos: [],
    // La imagen que se ve grande y la que va en el recuadro, si el bloque lleva.
    principal: null,
    inset: null,
    tramo: null,
    reproduciendo: false,
    rafId: null,
    // Cuánto llevamos del corte final, en segundos. Se guarda acá porque el
    // `<video>` solo conoce su propio archivo, no el resultado montado.
    posicionSec: 0
};

function frame() { return $('player-frame'); }

/** Los que están sonando o mostrándose ahora. */
function enUso() {
    return [estado.principal, estado.inset].filter(Boolean);
}

/** Un `<video>` por cámara, creados una sola vez por clase. */
function montarVideos(camaras) {
    for (const v of estado.videos) v.remove();
    estado.videos = camaras.map((camara, i) => {
        const video = document.createElement('video');
        video.className = 'player-video';
        video.src = camara.url;
        video.preload = 'auto';
        video.playsInline = true;
        // Solo suena el que se está viendo: si no, se escuchan las dos cámaras
        // encimadas, que en una sala con un solo micro es un eco raro.
        video.muted = true;
        video.hidden = true;
        video.addEventListener('error', () => {
            toast(`No se pudo abrir ${camara.name}.`);
        });
        frame().appendChild(video);
        return video;
    });
    estado.principal = null;
    estado.inset = null;
}

/**
 * Arma lo que se ve en un bloque: la imagen principal y, si lleva, el recuadro.
 *
 * Suena una sola: las dos cámaras del Rodecaster traen el mismo mix, y dejar
 * las dos abiertas es escuchar la clase encimada consigo misma.
 */
function componer(tramo) {
    const principal = estado.videos[tramo.camara] || null;
    const inset = tramo.inset == null ? null : (estado.videos[tramo.inset] || null);
    if (principal === estado.principal && inset === estado.inset) return principal;

    for (const video of estado.videos) {
        if (video === principal || video === inset) continue;
        video.hidden = true;
        video.muted = true;
        video.classList.remove('is-inset');
        video.pause();
    }

    if (principal) {
        principal.hidden = false;
        principal.muted = false;
        principal.classList.remove('is-inset');
    }
    if (inset) {
        inset.hidden = false;
        inset.muted = true;
        inset.classList.add('is-inset');
    }

    estado.principal = principal;
    estado.inset = inset;
    return principal;
}

/**
 * Deja al siguiente bloque listo mientras el actual todavía suena.
 *
 * Buscar cuesta poco pero no es gratis, y hacerlo justo en el corte es un
 * tirón visible. Si el bloque que sigue es de otra cámara, ese elemento está
 * libre y se puede posicionar sin que se note.
 */
function prepararSiguiente(tramo) {
    const próximo = siguiente(estado.pista, tramo);
    if (!próximo) return;
    for (const indice of [próximo.camara, próximo.inset]) {
        if (indice == null) continue;
        const video = estado.videos[indice];
        // Los que ya se están viendo no se tocan: moverles el tiempo sería
        // cortar la imagen que está al aire para adelantar la que viene.
        if (!video || video === estado.principal || video === estado.inset) continue;
        if (Math.abs(video.currentTime - próximo.origenDesdeSec) > 0.5) {
            video.currentTime = próximo.origenDesdeSec;
        }
    }
}

/** Pone la aguja en un momento del corte final. */
function ir(segundo, seguirReproduciendo) {
    const donde = enPosicion(estado.pista, segundo);
    if (!donde) return;

    estado.posicionSec = Math.max(0, Math.min(segundo, estado.pista.duracionSec));
    estado.tramo = donde.tramo;

    const principal = componer(donde.tramo);
    if (!principal) return;
    // Las dos van al mismo segundo: son la misma grabación desde dos cámaras y
    // duran exactamente lo mismo, así que el tiempo de origen es el mismo.
    for (const video of enUso()) video.currentTime = donde.origenSec;
    prepararSiguiente(donde.tramo);

    if (seguirReproduciendo) {
        for (const video of enUso()) video.play().catch(() => { /* lo dirá el botón */ });
    }
    pintarEstado();
}

/** El latido: vigila el borde del bloque y encadena con el siguiente. */
function latir() {
    estado.rafId = null;
    if (!estado.reproduciendo) return;

    const video = estado.principal;
    const tramo = estado.tramo;
    if (video && tramo) {
        const origen = video.currentTime;
        if (seTermino(tramo, origen)) {
            const próximo = siguiente(estado.pista, tramo);
            if (!próximo) { pausar(); estado.posicionSec = estado.pista.duracionSec; pintarEstado(); return; }
            ir(próximo.desdeSec, true);
        } else {
            estado.posicionSec = tramo.desdeSec + (origen - tramo.origenDesdeSec);
            // El recuadro manda el mismo momento que la imagen grande: si se
            // corre, se ve al profesor diciendo algo distinto de lo que suena.
            if (estado.inset && Math.abs(estado.inset.currentTime - origen) > DESFASE_TOLERADO_SEC) {
                estado.inset.currentTime = origen;
            }
        }
    }

    pintarAguja();
    seguir(estado.posicionSec);
    estado.rafId = requestAnimationFrame(latir);
}

function reproducir() {
    if (!estado.pista || !estado.pista.tramos.length) return;
    // Volver a darle al final vuelve a empezar, en vez de no hacer nada.
    if (estado.posicionSec >= estado.pista.duracionSec - 0.05) ir(0, false);

    estado.reproduciendo = true;
    if (!estado.principal && estado.tramo) componer(estado.tramo);
    for (const video of enUso()) {
        video.play().catch(err => {
            // `AbortError` es lo que devuelve Chromium cuando el pedido de
            // reproducir quedó atrás de una pausa —pasa al saltar de bloque— y
            // no es algo que el editor tenga que leer en un aviso.
            if (err.name === 'AbortError') return;
            pausar();
            toast(`No se pudo reproducir: ${err.message}`);
        });
    }
    pintarEstado();
    if (!estado.rafId) estado.rafId = requestAnimationFrame(latir);
}

export function pausar() {
    estado.reproduciendo = false;
    for (const video of estado.videos) video.pause();
    if (estado.rafId) { cancelAnimationFrame(estado.rafId); estado.rafId = null; }
    pintarEstado();
}

function alternar() {
    if (estado.reproduciendo) pausar(); else reproducir();
}

/** Adelante o atrás sin salirse de la clase. */
function correr(segundos) {
    if (!estado.pista) return;
    const destino = Math.max(0, Math.min(estado.pista.duracionSec - 0.05, estado.posicionSec + segundos));
    ir(destino, estado.reproduciendo);
}

/** Al bloque anterior o al siguiente. */
function saltarBloque(direccion) {
    if (!estado.tramo) return;
    const destino = estado.pista.tramos[estado.tramo.indice + direccion];
    // Estando ya adentro de un bloque, "anterior" primero vuelve a su principio.
    if (direccion < 0 && estado.posicionSec - estado.tramo.desdeSec > 1.5) {
        ir(estado.tramo.desdeSec, estado.reproduciendo);
        return;
    }
    if (!destino) return;
    ir(destino.desdeSec, estado.reproduciendo);
}

// ─── Dibujo ───────────────────────────────────────────────────────────

function pintarAguja() {
    const total = estado.pista ? estado.pista.duracionSec : 0;
    const fraccion = total ? (estado.posicionSec / total) * 100 : 0;
    $('player-head').style.left = `${fraccion}%`;
    $('player-time').textContent = `${fmtClock(estado.posicionSec)} / ${fmtClock(total)}`;
}

function pintarEstado() {
    $('player-play').textContent = estado.reproduciendo ? 'Pausa' : 'Reproducir';
    pintarAguja();

    const tramo = estado.tramo;
    $('player-now').innerHTML = tramo
        ? `<span class="player-badge conf-${esc(tramo.confidence)}">Bloque ${tramo.blockIndex + 1}</span>
           <span class="player-view">${esc(tramo.view)}</span>
           <span class="player-note">${esc(tramo.nota)}</span>
           <span class="cell-dim">${fmtClock(tramo.origenDesdeSec)} del original</span>`
        : '';

    for (const el of document.querySelectorAll('.player-block')) {
        el.classList.toggle('is-on', tramo && Number(el.dataset.indice) === tramo.indice);
    }

    // También en pausa: saltar a un bloque tiene que dejar el texto donde
    // corresponde sin obligar a darle play para verlo.
    seguir(estado.posicionSec);
}

/**
 * La tira de bloques: cada uno puesto donde cae y con el ancho que dura.
 *
 * Van posicionados y no en fila porque la tira es la misma línea de tiempo por
 * la que corre la aguja: tienen que coincidir.
 *
 * Y se arman elemento por elemento, no con una plantilla de HTML, porque la
 * política de seguridad de la ventana (`style-src 'self'`) descarta los
 * atributos `style` escritos en el marcado. Quedan en el DOM y no se aplican
 * nunca: los bloques salen todos de dos píxeles amontonados a la izquierda.
 * Tocar `.style` desde acá sí vale, y así la política sigue estricta.
 */
function pintarBloques() {
    const total = estado.pista.duracionSec || 1;
    const contenedor = $('player-blocks');
    contenedor.replaceChildren();

    const comentarios = (rev.notas && rev.notas.comentarios) || [];

    for (const tramo of estado.pista.tramos) {
        const conNota = comentariosEn(tramo, comentarios).length;
        const revisar = tramo.confidence !== 'alta';

        const boton = document.createElement('button');
        // El fondo dice con qué se ve; las líneas, qué le falta. Son cosas
        // distintas y antes competían por el mismo color.
        boton.className = `player-block cam-${tramo.camara % COLORES_DE_CAMARA}`
            + (revisar ? ` is-revisar conf-${tramo.confidence}` : '')
            + (conNota ? ' con-nota' : '');
        boton.dataset.indice = String(tramo.indice);
        boton.title = [
            `Bloque ${tramo.blockIndex + 1}`,
            nombreDeCamara(tramo),
            revisar ? `confianza ${tramo.confidence}, conviene revisarlo` : null,
            conNota ? `${conNota} comentario${conNota > 1 ? 's' : ''}` : 'sin comentarios',
            tramo.nota
        ].filter(Boolean).join(' · ');
        boton.style.left = `${(tramo.desdeSec / total) * 100}%`;
        boton.style.width = `${(tramo.duracionSec / total) * 100}%`;
        // Se redibuja también al guardar un comentario, y en pausa nadie vuelve
        // a marcar cuál es el bloque de la aguja.
        if (estado.tramo && estado.tramo.indice === tramo.indice) boton.classList.add('is-on');
        contenedor.appendChild(boton);
    }

    pintarLeyenda();
}

/** Volver a dibujar la tira, para cuando cambia algo que ella marca. */
export function refrescarBloques() {
    if (estado.pista) pintarBloques();
}

/** Con qué se ve un bloque, dicho como lo diría alguien. */
function nombreDeCamara(tramo) {
    const camaras = (rev.data && rev.data.cameras) || [];
    const camara = camaras[tramo.camara];
    // Sin la extensión: en la leyenda lo que importa es reconocer el archivo,
    // y "1_CAMERA 1.mp4" ocupa el doble sin decir nada más que "1_CAMERA 1".
    const nombre = camara && camara.name
        ? camara.name.replace(/\.[^.]+$/, '')
        : `cámara ${tramo.camara + 1}`;
    return tramo.view ? `${nombre} (${tramo.view})` : nombre;
}

/**
 * Qué significa cada color, armada con lo que esta clase usa de verdad.
 *
 * Una tira de colores sin nada que los explique se lee como decoración. Se
 * listan solo las cámaras que aparecen en el corte, así una clase grabada con
 * una sola no muestra media docena de colores que no va a ver nunca.
 */
function pintarLeyenda() {
    const caja = $('player-leyenda');
    caja.replaceChildren();

    const vistos = new Map();
    for (const tramo of estado.pista.tramos) {
        if (!vistos.has(tramo.camara)) vistos.set(tramo.camara, nombreDeCamara(tramo));
    }

    for (const [camara, nombre] of vistos) {
        const chip = document.createElement('span');
        chip.className = 'leyenda-item';
        const muestra = document.createElement('i');
        muestra.className = `leyenda-color cam-${camara % COLORES_DE_CAMARA}`;
        chip.append(muestra, document.createTextNode(nombre));
        caja.appendChild(chip);
    }

    for (const [clase, texto] of [['leyenda-revisar', 'conviene revisarlo'], ['leyenda-nota', 'tiene comentario']]) {
        const chip = document.createElement('span');
        chip.className = 'leyenda-item';
        const muestra = document.createElement('i');
        muestra.className = `leyenda-color ${clase}`;
        chip.append(muestra, document.createTextNode(texto));
        caja.appendChild(chip);
    }
}

// ─── Entrada ──────────────────────────────────────────────────────────

/**
 * Arma el reproductor con lo que hay en pantalla ahora.
 *
 * Se llama cada vez que se entra a la pestaña, no una sola vez por clase: entre
 * una visita y otra el editor pudo mover bordes o sacar bloques, y el sentido
 * de esto es ver el corte que tiene, no el que tenía.
 */
export function abrirReproductor() {
    const camaras = (rev.data && rev.data.cameras) || [];
    estado.pista = construir(rev.segments, {
        viewMap: rev.data && rev.data.cutplan ? rev.data.cutplan.viewMap : null,
        camaras: camaras.length,
        vistaDelProfesor: VISTA_DEL_PROFESOR
    });

    // El panel de al lado lee la misma pista: así el texto que se alumbra es
    // exactamente el del corte que se está viendo, bordes movidos incluidos.
    rev.pista = estado.pista;
    abrirLetra(estado.pista, segundo => ir(segundo, estado.reproduciendo));

    const vacio = !estado.pista.tramos.length || !camaras.length;
    $('player-empty').hidden = !vacio;
    $('player-empty').textContent = camaras.length
        ? 'No hay bloques para ver.'
        : 'Esta clase no tiene cámaras.';
    if (vacio) { estado.videos.forEach(v => v.remove()); estado.videos = []; return; }

    montarVideos(camaras);
    pintarBloques();

    // Si venía de la lista de cortes, se arranca en el bloque que estaba mirando.
    const seleccionado = rev.segments[rev.selected];
    const desde = seleccionado ? posicionDeBloque(estado.pista, seleccionado.blockIndex) : 0;
    ir(desde == null ? 0 : desde, false);
}

/** Al salir de la pestaña o de la clase: nada sigue sonando por detrás. */
export function cerrarReproductor() {
    pausar();
    cerrarLetra();
    for (const video of estado.videos) { video.removeAttribute('src'); video.load(); video.remove(); }
    estado.videos = [];
    estado.principal = null;
    estado.inset = null;
    estado.tramo = null;
    estado.posicionSec = 0;
}

/**
 * Los atajos del reproductor.
 *
 * Van en el documento y no en el reproductor porque para que un elemento reciba
 * teclas tiene que tener el foco, y acá el foco lo va a tener lo último que se
 * tocó: un botón, la nota de un bloque, nada. Pidiéndole al editor que haga clic
 * en el video antes de poder darle a la barra, el atajo no sirve para nada.
 *
 * Escribiendo no se dispara ninguno: la nota del marcador y la caja de
 * comentarios son campos de texto, y ahí la barra es un espacio.
 */
function estaEscribiendo(donde) {
    return Boolean(donde)
        && (donde.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(donde.tagName));
}

function teclas(evento) {
    if (rev.tab !== 'clase' || !estado.pista) return;
    if (evento.metaKey || evento.ctrlKey || evento.altKey) return;

    const donde = evento.target;
    if (estaEscribiendo(donde)) return;

    // La barra reproduce y pausa siempre, sin importar qué quedó con el foco. Es
    // el atajo que más se usa y, si además hay que acordarse de dónde se hizo el
    // último clic para saber si va a funcionar, deja de ser un atajo: lo que
    // pasaba con el divisor era exactamente eso, la barra se perdía y la página
    // hacía scroll. Las demás teclas sí le ceden el paso a lo que tenga el foco,
    // porque las flechas ahí significan otra cosa.
    if (evento.key !== ' ' && donde && donde.id === 'player-split') return;

    const paso = evento.shiftKey ? 1 : 5;
    const acciones = {
        ' ': alternar,
        ArrowLeft: () => correr(-paso),
        ArrowRight: () => correr(paso),
        ArrowUp: () => saltarBloque(-1),
        ArrowDown: () => saltarBloque(1),
        Home: () => ir(0, estado.reproduciendo)
    };

    const hacer = acciones[evento.key];
    if (!hacer) return;
    // Sin esto la barra baja la página y las flechas mueven el scroll del panel.
    evento.preventDefault();
    hacer();
}

export function wireReproductor() {
    $('player-play').onclick = alternar;
    $('player-prev').onclick = () => saltarBloque(-1);
    $('player-next').onclick = () => saltarBloque(1);

    $('player-blocks').addEventListener('click', e => {
        const boton = e.target.closest('.player-block');
        if (!boton || !estado.pista) return;
        const tramo = estado.pista.tramos[Number(boton.dataset.indice)];
        if (!tramo) return;
        ir(tramo.desdeSec, estado.reproduciendo);
        // Mover la selección deja el resto del visor mirando el mismo bloque:
        // se ve algo raro acá y se arregla en la pestaña de al lado sin buscarlo.
        const indice = rev.segments.findIndex(s => s.blockIndex === tramo.blockIndex);
        if (indice >= 0) { rev.selected = indice; cambio(); }
    });

    $('player-track').addEventListener('click', e => {
        if (e.target.closest('.player-block') || !estado.pista) return;
        const caja = $('player-track').getBoundingClientRect();
        const fraccion = Math.max(0, Math.min(1, (e.clientX - caja.left) / caja.width));
        ir(fraccion * estado.pista.duracionSec, estado.reproduciendo);
    });

    document.addEventListener('keydown', teclas);
}
