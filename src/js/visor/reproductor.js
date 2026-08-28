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

import { $, toast, estaEscribiendo } from '../chrome.js';
import { esc, fmtClock } from '../formato.js';
import { rev, cambio } from './estado.js';
import { COLORES_DE_CAMARA, comentariosEn, construir, tramoEn, posicionDeBloque, seTermino, siguiente } from './pista.js';
import { abrirLetra, cerrarLetra, seguir } from './panel-letra.js';
import { aplicarVolumen, despertarAudio, estadoDelAudio, wireVolumen } from './volumen.js';
import {
    abrirOndas, cerrarOndas, moverAgujaDeOnda, pintarOndaDeLaTira, pintarOndaDelBloque, wireOndas
} from './onda-clase.js';

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
    posicionSec: 0,
    // A qué velocidad va. No se recuerda entre clases a propósito: es algo que se
    // usa para pasar por arriba de un tramo, no una preferencia, y abrir una
    // clase a 4× sin haberlo pedido se lee como que algo se rompió.
    velocidad: 1
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
        // ANTES del `src`, y no es un detalle de orden: sin el permiso pedido en
        // la petición, el elemento queda "contaminado" y conectarlo a Web Audio
        // —lo que hace falta para pasar del 100% de volumen— devuelve silencio
        // sin fallar. Si el archivo ya estuviera en memoria sin permiso habría
        // que volver a llamar a `load()`; acá el elemento se crea recién ahora,
        // así que alcanza con ponerlo primero.
        video.crossOrigin = 'anonymous';
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
    // El nivel se pone acá y no una sola vez al abrir: quién tiene que sonar
    // cambia en cada bloque, y arriba del 100% el volumen ya no vive en el
    // elemento sino en un nodo por elemento (ver `volumen.js`).
    aplicarVolumen(estado.videos, principal);
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
    const donde = tramoEn(estado.pista, segundo);
    if (!donde) return;

    estado.posicionSec = Math.max(0, Math.min(segundo, estado.pista.duracionSec));
    const anterior = estado.tramo;
    estado.tramo = donde.tramo;
    // La onda de abajo y sus subtítulos son de UN bloque: se rearman al saltar
    // de bloque y no en cada cuadro, que es lo que las hace baratas.
    if (!anterior || anterior.indice !== donde.tramo.indice) pintarOndaDelBloque(donde.tramo);

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
    // El `AudioContext` arranca suspendido hasta que hay un gesto del usuario, y
    // suspendido no sale audio por el grafo. Acá se llega por el botón o por la
    // barra espaciadora, así que el gesto ya está hecho.
    despertarAudio();
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

/**
 * Las velocidades de la L, y por qué son estas.
 *
 * Revisar una clase de cuarenta minutos es en buena parte pasar por arriba de lo
 * que ya se sabe que está bien. Chromium mantiene el tono al acelerar, así que a
 * 2× la voz se sigue entendiendo y a 4× ya no —pero a 4× lo que se busca es la
 * imagen, no lo que dice—. Más arriba no sirve para ninguna de las dos cosas.
 */
const VELOCIDADES = [1, 1.5, 2, 4];

/** Cuánto retrocede la J cuando ya está en velocidad normal. */
const RETROCESO_SEC = 2;

/**
 * La velocidad, aplicada a todos los videos del bloque.
 *
 * A los DOS: si el recuadro corriera a otra velocidad que la imagen grande, se
 * separarían solos y se vería al profesor diciendo algo distinto de lo que suena.
 */
function ponerVelocidad(cual) {
    estado.velocidad = cual;
    for (const video of estado.videos) {
        video.playbackRate = cual;
        // Sin esto la voz sube de tono al acelerar y deja de entenderse, que es
        // justamente para lo que uno acelera. En Chromium ya viene así, pero
        // dicho acá no depende de que el día de mañana siga siendo el valor por
        // defecto.
        video.preservesPitch = true;
    }
    pintarEstado();
}

/**
 * La L: arranca, y si ya está andando, más rápido.
 *
 * Los tres controles son los del montaje —J, K, L— con una diferencia que vale
 * la pena decir: acá la J no es marcha atrás. Reproducir hacia atrás no existe en
 * video HTML (`playbackRate` no acepta negativos), y lo único que se puede hacer
 * es simularlo saltando muchas veces por segundo, que sobre archivos de varios GB
 * se ve a los tirones y no se parece en nada al retroceso de Premiere. Así que la
 * J hace lo que uno de verdad usa la J para hacer: primero frena —4× → 2× → 1×—
 * y una vez en velocidad normal manda para atrás de a saltos cortos.
 */
function masRapido() {
    if (!estado.reproduciendo) { reproducir(); return; }
    const i = VELOCIDADES.indexOf(estado.velocidad);
    ponerVelocidad(VELOCIDADES[Math.min(i + 1, VELOCIDADES.length - 1)]);
}

/** La J: frena, y ya en velocidad normal, retrocede. */
function masLento() {
    const i = VELOCIDADES.indexOf(estado.velocidad);
    if (i > 0) { ponerVelocidad(VELOCIDADES[i - 1]); return; }
    correr(-RETROCESO_SEC);
}

/** La K: parar. Y deja la velocidad en normal, que es de donde se sigue. */
function parar() {
    ponerVelocidad(1);
    pausar();
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
    // La velocidad va acá y solo cuando no es la normal: acelerado, el reloj es
    // lo único que se está mirando, y sin decirlo la clase pasa rápido sin que
    // quede claro por qué.
    const rapido = estado.velocidad !== 1 ? ` · ${String(estado.velocidad).replace('.', ',')}×` : '';
    $('player-time').textContent = `${fmtClock(estado.posicionSec)} / ${fmtClock(total)}${rapido}`;
    // La otra aguja: la misma posición, pero medida contra el bloque.
    moverAgujaDeOnda(estado.posicionSec);
}

function pintarEstado() {
    // El botón dice el estado con un símbolo, así que lo que hace tiene que
    // decirlo el `title` —y el `aria-label`, que es lo único que le queda a un
    // lector de pantalla cuando el texto es un ▶—. Los dos se actualizan en los
    // dos estados: un botón que dice "Reproducir" mientras pausa es peor que uno
    // sin texto. El atajo va adentro porque el botón es donde se lo descubre.
    const boton = $('player-play');
    const que = estado.reproduciendo ? 'Pausa' : 'Reproducir';
    boton.textContent = estado.reproduciendo ? '⏸' : '▶';
    boton.title = `${que} (barra espaciadora)`;
    boton.setAttribute('aria-label', boton.title);
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
        const conNota = comentariosEn(tramo.origenDesdeSec, tramo.origenHastaSec, comentarios).length;
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

    // La onda va después de los botones, en su propio canvas encima: la tira es
    // una sola línea de tiempo y las dos cosas se miden con los mismos
    // porcentajes, así que tienen que dibujarse en el mismo pase.
    pintarOndaDeLaTira(estado.pista);
    pintarLeyenda();
}

/** Volver a dibujar la tira, para cuando cambia algo que ella marca. */
export function refrescarBloques() {
    if (!estado.pista) return;
    pintarBloques();
    // La nota del bloque también aparece en el overlay: si el editor la acaba
    // de corregir en el panel, lo que se lee arriba del video tiene que ser eso.
    pintarEstado();
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
    abrirOndas();
    estado.pista = construir(rev.segments, {
        viewMap: rev.data && rev.data.cutplan ? rev.data.cutplan.viewMap : null,
        camaras: camaras.length,
        vistaDelProfesor: VISTA_DEL_PROFESOR,
        notas: rev.notas ? rev.notas.bloques : null
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

/**
 * El audio como quedó armado, con los videos de este bloque.
 *
 * Es lo que deja comprobar desde el arnés que subir el volumen no destapó el
 * recuadro: en pantalla no se ve, y la única alternativa es escuchar y opinar.
 */
export function audioDelReproductor() {
    return { ...estadoDelAudio(estado.videos), principal: estado.principal, inset: estado.inset };
}

/** Al salir de la pestaña o de la clase: nada sigue sonando por detrás. */
export function cerrarReproductor() {
    pausar();
    cerrarLetra();
    cerrarOndas();
    for (const video of estado.videos) { video.removeAttribute('src'); video.load(); video.remove(); }
    estado.videos = [];
    estado.principal = null;
    estado.inset = null;
    estado.tramo = null;
    estado.posicionSec = 0;
    // Los `<video>` de la clase que viene nacen en velocidad normal: dejar el
    // número viejo acá haría que el reloj dijera 4× sobre un video que va a 1.
    estado.velocidad = 1;
}

/**
 * Los atajos del reproductor.
 *
 * Van en el documento y no en el reproductor porque para que un elemento reciba
 * teclas tiene que tener el foco, y acá el foco lo va a tener lo último que se
 * tocó: un botón, la nota de un bloque, nada. Pidiéndole al editor que haga clic
 * en el video antes de poder darle a la barra, el atajo no sirve para nada.
 *
 * Escribiendo no se dispara ninguno: la regla de qué cuenta como escribir está
 * en `chrome.js`, compartida con los atajos de la pestaña de cortes.
 */
function teclas(evento) {
    if (rev.tab !== 'clase' || !estado.pista) return;
    if (evento.metaKey || evento.ctrlKey || evento.altKey) return;

    const donde = evento.target;
    if (estaEscribiendo(donde)) return;

    // Quien quiera quedarse una tecla, que la pare: el divisor hace
    // `stopPropagation` con las flechas que reparten el espacio y este oyente
    // ni las ve. Así el reproductor no tiene que conocer a nadie por su id.
    const paso = evento.shiftKey ? 1 : 5;
    const acciones = {
        ' ': alternar,
        ArrowLeft: () => correr(-paso),
        ArrowRight: () => correr(paso),
        ArrowUp: () => saltarBloque(-1),
        ArrowDown: () => saltarBloque(1),
        Home: () => ir(0, estado.reproduciendo),
        j: masLento,
        k: parar,
        l: masRapido
    };

    const hacer = acciones[evento.key.toLowerCase()] || acciones[evento.key];
    if (!hacer) return;
    // Sin esto la barra baja la página y las flechas mueven el scroll del panel.
    evento.preventDefault();
    hacer();
}

export function wireReproductor() {
    $('player-play').onclick = alternar;
    $('player-prev').onclick = () => saltarBloque(-1);
    $('player-next').onclick = () => saltarBloque(1);

    // Quién tiene que sonar lo sabe el reproductor; cuánto, el control.
    wireVolumen(() => aplicarVolumen(estado.videos, estado.principal));
    wireOndas(segundo => ir(segundo, estado.reproduciendo));

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
