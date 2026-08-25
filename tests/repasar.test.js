'use strict';
/**
 * Que el repaso arregle lo que dice arreglar, y que no toque lo demás.
 *
 * Estas funciones MUEVEN cortes de una clase que ya estaba decidida, y lo hacen
 * sobre una pista del modelo, que no siempre acierta. El riesgo no es dejar
 * pasar un empalme —eso lo ve el editor al revisar—, es mover un borde que
 * estaba bien y que el editor ya no va a mirar porque figura como arreglado. Por
 * eso la mitad de estos casos son de lo que NO debe tocar.
 */

const repasar = require('../engine/repasar');
const speech = require('../engine/speech-edges');

/** Palabras con tiempo, una cada 0.4s, a partir de `desde`. */
function decir(texto, desde) {
    return texto.split(/\s+/).map((palabra, i) => ({
        text: palabra,
        start: Math.round((desde + i * 0.4) * 1000) / 1000,
        end: Math.round((desde + i * 0.4 + 0.38) * 1000) / 1000
    }));
}

function bloque(index, startSec, endSec, extra) {
    return {
        index,
        startSec,
        endSec,
        in: { kind: 'IN', originalSec: startSec, alignedSec: startSec, timeSec: startSec },
        out: { kind: 'OUT', originalSec: endSec, alignedSec: endSec, timeSec: endSec },
        ...(extra || {})
    };
}

const opciones = { fps: 30 };

module.exports = t => {
    t.group('el conector huérfano');

    // "Entonces" abriendo un bloque cuando lo de antes se tiró: el alumno oye
    // que se apoya en algo que nunca vio.
    function claseQueAbreEnFalso() {
        const words = [
            ...decir('Esto que acabamos de ver es el primer componente.', 0),
            ...decir('Entonces el segundo componente es el de los contratos.', 20)
        ];
        return { words, blocks: [bloque(0, 0, 5), bloque(1, 20, 24)] };
    }

    t.test('corre el arranque detrás del conector', () => {
        const { words, blocks } = claseQueAbreEnFalso();
        const res = repasar.quitarElConector(blocks[1], { words, wav: null, options: opciones, blocks });
        t.ok(res, 'lo arregló');
        t.ok(/Entonces/.test(res.hecho), 'dice qué quitó');
        t.ok(!repasar.abreEnFalso(words, blocks[1]), 'ya no abre con conector');
        t.eq(speech.textInside(words, blocks[1].startSec, blocks[1].endSec).split(/\s+/)[0], 'el');
    });

    t.test('si el bloque de antes viene pegado, el conector no está huérfano', () => {
        // "Y el segundo componente…" se lee de corrido cuando lo de antes sigue
        // ahí: el antecedente no se tiró, está justo delante.
        const words = [
            ...decir('Esto que acabamos de ver es el primer componente.', 0),
            ...decir('Entonces el segundo componente es el de los contratos.', 5)
        ];
        const blocks = [bloque(0, 0, 4.8), bloque(1, 5, 9)];
        t.eq(repasar.quitarElConector(blocks[1], { words, wav: null, options: opciones, blocks }), null);
        t.eq(blocks[1].startSec, 5, 'no se movió');
    });

    t.test('un bloque que ya abre bien no se toca', () => {
        const words = [...decir('El segundo componente es el de los contratos.', 0)];
        const blocks = [bloque(0, 0, 4)];
        t.eq(repasar.quitarElConector(blocks[0], { words, wav: null, options: opciones, blocks }), null);
    });

    t.test('no se come medio bloque para quitar el conector', () => {
        // El conector está, pero lo que sigue tarda una eternidad en llegar: eso
        // ya no es quitar una palabra, es tirar contenido.
        const words = [
            { text: 'Entonces', start: 20, end: 20.4 },
            ...decir('el segundo componente es el de los contratos.', 26)
        ];
        const blocks = [bloque(0, 20, 30)];
        t.eq(repasar.quitarElConector(blocks[0], { words, wav: null, options: opciones, blocks }), null);
    });

    t.test('si detrás del conector hay otro conector, se deshace', () => {
        // Con el límite en una sola palabra, quitar "Entonces" deja "pero"
        // abriendo: peor que antes. La comprobación tiene que verlo.
        const words = [...decir('Entonces pero eso es otra cosa distinta.', 0)];
        const blocks = [bloque(0, 0, 3.2)];
        const res = repasar.quitarElConector(blocks[0], {
            words, wav: null, blocks, options: { ...opciones, palabrasDeConector: 1 }
        });
        t.eq(res, null);
        t.eq(blocks[0].startSec, 0, 'quedó donde estaba');
    });

    t.group('la frase que quedó abierta');

    function claseQueQuedaColgando() {
        const words = [
            ...decir('El contrato define qué recibe y qué devuelve cada parte.', 0),
            ...decir('Y eso es lo que hace que el sistema entero sea predecible.', 5),
            ...decir('Vamos a ver el tercer componente.', 30)
        ];
        // El OUT cayó a mitad de la segunda frase.
        return { words, blocks: [bloque(0, 0, 7), bloque(1, 30, 34)] };
    }

    t.test('estira el final hasta que la frase cierre', () => {
        const { words, blocks } = claseQueQuedaColgando();
        t.ok(repasar.quedaColgando(words, blocks[0]), 'antes colgaba');
        const res = repasar.cerrarLaFrase(blocks[0], { words, wav: null, options: opciones, blocks });
        t.ok(res, 'lo arregló');
        t.ok(!repasar.quedaColgando(words, blocks[0]), 'ahora cierra');
        t.ok(blocks[0].endSec > 7, 'se estiró');
        t.ok(res.agregadoSec > 0);
    });

    t.test('no se mete en el bloque siguiente', () => {
        const { words, blocks } = claseQueQuedaColgando();
        // El bloque de después arranca casi pegado: no hay sitio para estirar.
        blocks[1].startSec = 7.4;
        blocks[1].endSec = 12;
        t.eq(repasar.cerrarLaFrase(blocks[0], { words, wav: null, options: opciones, blocks }), null);
        t.eq(blocks[0].endSec, 7, 'quedó donde estaba');
    });

    t.test('un bloque que ya cierra no se toca', () => {
        const words = [...decir('El contrato define qué recibe cada parte.', 0)];
        const blocks = [bloque(0, 0, 3)];
        t.eq(repasar.cerrarLaFrase(blocks[0], { words, wav: null, options: opciones, blocks }), null);
    });

    t.test('si la frase no cierra en toda la ventana, no se estira a medias', () => {
        const words = decir('esto sigue y sigue sin cerrar nunca jamás de los jamases y sigue', 0);
        const blocks = [bloque(0, 0, 2)];
        t.eq(repasar.cerrarLaFrase(blocks[0], {
            words, wav: null, blocks, options: { ...opciones, maximoQueSeEstiraSec: 1 }
        }), null);
    });

    t.group('el bloque que abre a mitad de frase');

    t.test('retrae el arranque hasta donde empezaba la frase', () => {
        const words = [
            ...decir('Bueno, sigamos con lo nuestro.', 0),
            ...decir('La promesa de valor de este curso no es el proyecto.', 3)
        ];
        // El IN cayó una palabra tarde: abre en "promesa".
        const blocks = [bloque(0, 3.4, 7.2)];
        t.ok(repasar.abreAMitad(words, blocks[0]), 'antes abría a mitad');
        const res = repasar.abrirLaFrase(blocks[0], { words, wav: null, options: opciones, blocks });
        t.ok(res, 'lo arregló');
        t.ok(!repasar.abreAMitad(words, blocks[0]), 'ahora abre la frase');
        t.eq(speech.textInside(words, blocks[0].startSec, blocks[0].endSec).split(/\s+/)[0], 'La');
    });

    t.test('no se mete en el bloque anterior para abrir la frase', () => {
        const words = [
            ...decir('Bueno, sigamos con lo nuestro.', 0),
            ...decir('La promesa de valor de este curso no es el proyecto.', 3)
        ];
        // El bloque de antes llega hasta justo delante: no hay dónde retroceder.
        const blocks = [bloque(0, 0, 3.35), bloque(1, 3.4, 7.2)];
        t.eq(repasar.abrirLaFrase(blocks[1], { words, wav: null, options: opciones, blocks }), null);
        t.eq(blocks[1].startSec, 3.4, 'quedó donde estaba');
    });

    t.test('un bloque que ya abre una frase no se toca', () => {
        const words = [...decir('Bueno, sigamos. La promesa de valor no es el proyecto.', 0)];
        // Arranca justo en "La", que es donde la frase empieza.
        const blocks = [bloque(0, 0.8, 4)];
        t.eq(repasar.abrirLaFrase(blocks[0], { words, wav: null, options: opciones, blocks }), null);
    });

    t.group('el fragmento suelto');

    function claseConFragmento() {
        const words = [
            ...decir('contaminar y perder contexto.', 0),
            ...decir('El historial de chat se puede contaminar y perder contexto.', 6)
        ];
        return { words, blocks: [bloque(0, 0, 1.2), bloque(1, 6, 10)] };
    }

    t.test('apaga el pedazo que el siguiente dice entero', () => {
        const { words, blocks } = claseConFragmento();
        const res = repasar.tirarElFragmento(blocks[0], { words, options: opciones, blocks });
        t.ok(res, 'lo quitó');
        t.eq(blocks[0].enabled, false);
        t.eq(blocks[0].disabledBy, 'repaso');
        t.ok(blocks[0].disabledReason, 'y deja dicho por qué');
    });

    t.test('no tira un bloque largo aunque se parezca', () => {
        const { words, blocks } = claseConFragmento();
        t.eq(repasar.tirarElFragmento(blocks[0], {
            words, blocks, options: { ...opciones, maximoDelFragmentoSec: 0.5 }
        }), null);
        t.ok(blocks[0].enabled !== false, 'sigue vivo');
    });

    t.test('no tira el fragmento si el siguiente no lo dice', () => {
        const words = [
            ...decir('esto es una cosa distinta.', 0),
            ...decir('El historial de chat se puede contaminar y perder contexto.', 6)
        ];
        const blocks = [bloque(0, 0, 1.6), bloque(1, 6, 10)];
        t.eq(repasar.tirarElFragmento(blocks[0], { words, options: opciones, blocks }), null);
    });

    t.test('no tira el fragmento si el que lo repite es más corto', () => {
        const { words, blocks } = claseConFragmento();
        blocks[1].endSec = 6.8;
        t.eq(repasar.tirarElFragmento(blocks[0], { words, options: opciones, blocks }), null);
    });

    t.group('el repaso entero');

    /** Un modelo de mentira que contesta lo que se le diga. */
    function modelo(respuestas) {
        let i = 0;
        return { ask: async () => respuestas[Math.min(i++, respuestas.length - 1)] };
    }

    t.test('arregla lo señalado y vuelve a leer', async () => {
        const { words, blocks } = claseQueAbreEnFalso();
        const alignResult = { blocks };
        const review = {
            blocks: [
                { n: 1, index: 0, startSec: 0, endSec: 5, text: '' },
                { n: 2, index: 1, startSec: 20, endSec: 24, text: '' }
            ],
            findings: [{ bloque: 2, tipo: 'conector', gravedad: 'baja', detalle: 'Arranca con "Entonces".', fuente: 'ia' }],
            stats: {}
        };

        // La segunda lectura ya no ve nada: es la clase arreglada.
        const res = await repasar.repasar({
            alignResult, review, words, wav: null, options: opciones,
            ai: modelo([{ hallazgos: [] }])
        });

        t.eq(res.stats.arreglados, 1);
        t.ok(res.stats.relectura, 'volvió a leer');
        t.eq(res.stats.quedan, 0, 'no queda nada pendiente');
        t.eq(res.review.findings.length, 1);
        t.ok(res.review.findings[0].corregido, 'y el hallazgo queda como registro de lo hecho');
    });

    t.test('lo que no se sabe arreglar se reporta', async () => {
        const { words, blocks } = claseQueAbreEnFalso();
        const review = {
            blocks: [{ n: 1, index: 0, startSec: 0, endSec: 5, text: '' }],
            findings: [{ bloque: 1, tipo: 'orden', gravedad: 'alta', detalle: 'Va antes de lo que lo explica.', fuente: 'ia' }],
            stats: {}
        };
        const res = await repasar.repasar({
            alignResult: { blocks }, review, words, wav: null, options: opciones, ai: null
        });
        t.eq(res.stats.arreglados, 0);
        t.ok(!res.stats.relectura, 'sin arreglos no hace falta releer');
        t.eq(res.stats.quedan, 1);
        t.ok(!res.review.findings[0].corregido);
    });

    t.test('si la relectura encuentra algo nuevo, eso es lo que se reporta', async () => {
        const { words, blocks } = claseQueAbreEnFalso();
        const review = {
            blocks: [
                { n: 1, index: 0, startSec: 0, endSec: 5, text: '' },
                { n: 2, index: 1, startSec: 20, endSec: 24, text: '' }
            ],
            findings: [{ bloque: 2, tipo: 'conector', gravedad: 'baja', detalle: 'Arranca con "Entonces".', fuente: 'ia' }],
            stats: {}
        };
        const res = await repasar.repasar({
            alignResult: { blocks }, review, words, wav: null, options: opciones,
            ai: modelo([{ hallazgos: [{ bloque: 2, tipo: 'empalme', gravedad: 'media', detalle: 'El salto se nota.' }] }])
        });

        t.eq(res.stats.arreglados, 1);
        t.eq(res.stats.quedan, 1, 'lo nuevo cuenta como pendiente');
        t.eq(res.review.findings.filter(f => f.corregido).length, 1);
        t.eq(res.review.findings.filter(f => !f.corregido).length, 1);
    });

    t.test('un arreglo que apaga un bloque renumera lo ya arreglado', async () => {
        // Apagar el bloque 1 corre a todos los de atrás: el hallazgo que quedó
        // como registro tiene que seguir señalando su bloque, no el número que
        // ahora ocupa otro.
        const words = [
            ...decir('Bueno, empecemos por acá.', 0),
            ...decir('contaminar y perder contexto.', 6),
            ...decir('El historial de chat se puede contaminar y perder contexto.', 12)
        ];
        const blocks = [bloque(0, 0, 2), bloque(1, 6, 7.2), bloque(2, 12, 16)];
        const review = {
            blocks: [
                { n: 1, index: 0, startSec: 0, endSec: 2, text: '' },
                { n: 2, index: 1, startSec: 6, endSec: 7.2, text: '' },
                { n: 3, index: 2, startSec: 12, endSec: 16, text: '' }
            ],
            findings: [{ bloque: 2, tipo: 'empalme', gravedad: 'alta', detalle: 'Fragmento suelto.', fuente: 'ia' }],
            stats: {}
        };
        const res = await repasar.repasar({
            alignResult: { blocks }, review, words, wav: null, options: opciones,
            ai: modelo([{ hallazgos: [] }])
        });

        t.eq(res.stats.arreglados, 1);
        t.eq(blocks[1].enabled, false, 'apagó el fragmento');
        t.eq(res.review.blocks.length, 2, 'el guion quedó con dos bloques');
        // El bloque 2 ya no existe: el hallazgo se cuelga del que ocupó su sitio,
        // que ahora es el número 2.
        t.eq(res.review.findings[0].bloque, 2);
        t.eq(res.review.blocks.find(b => b.n === 2).index, 2, 'y ese es el bloque de índice 2');
    });

    t.test('si el modelo nombra al que sobrevive, el fragmento igual se apaga', async () => {
        // «Eliminar el bloque 8 y conservar solo el 9» llegó como hallazgo DEL
        // 9: el modelo nombra un bloque sin decir de qué lado está la copia, y
        // mirando solo al nombrado este caso quedaba como pendiente.
        const words = [
            ...decir('contaminar y perder contexto.', 0),
            ...decir('El historial de chat se puede contaminar y perder contexto.', 6)
        ];
        const blocks = [bloque(0, 0, 1.2), bloque(1, 6, 10)];
        const review = {
            blocks: [
                { n: 1, index: 0, startSec: 0, endSec: 1.2, text: '' },
                { n: 2, index: 1, startSec: 6, endSec: 10, text: '' }
            ],
            findings: [{ bloque: 2, tipo: 'repetido', gravedad: 'media', detalle: 'Quedaron dos tomas.', fuente: 'ia' }],
            stats: {}
        };
        const res = await repasar.repasar({
            alignResult: { blocks }, review, words, wav: null, options: opciones,
            ai: modelo([{ hallazgos: [] }])
        });
        t.eq(blocks[0].enabled, false, 'apagó el fragmento aunque el hallazgo nombraba al otro');
        t.eq(res.stats.arreglados, 1);
    });

    t.test('una repetición arreglada también manda a releer', async () => {
        // El recorte por repetición cambia la clase igual que cualquier otro
        // arreglo: si eso no cuenta, el informe se queda hablando de la clase de
        // antes justo cuando más se movió.
        const words = [
            ...decir('La especificación es la fuente de verdad de la aplicación.', 0),
            ...decir('Y es justamente ese el problema por el que esto no escala nunca.', 4),
            ...decir('Y justo ese es el problema por el que esto no escala.', 12)
        ];
        const blocks = [bloque(0, 0, 10), bloque(1, 12, 17)];
        const review = {
            blocks: [
                { n: 1, index: 0, startSec: 0, endSec: 10, text: '' },
                { n: 2, index: 1, startSec: 12, endSec: 17, text: '' }
            ],
            findings: [{ bloque: 2, tipo: 'repetido', gravedad: 'alta', detalle: 'Ya se dijo.', fuente: 'ia' }],
            stats: {}
        };
        const res = await repasar.repasar({
            alignResult: { blocks }, review, words, wav: null, options: opciones,
            ai: modelo([{ hallazgos: [] }])
        });
        t.eq(res.stats.arreglados, 1);
        t.ok(res.stats.relectura, 'volvió a leer');
        t.ok(blocks[0].endSec < 10, 'y el recorte se aplicó');
    });

    t.test('sin hallazgos no hace nada ni gasta una llamada', async () => {
        const { words, blocks } = claseQueAbreEnFalso();
        let llamadas = 0;
        const res = await repasar.repasar({
            alignResult: { blocks },
            review: { blocks: [], findings: [], stats: {} },
            words, wav: null, options: opciones,
            ai: { ask: async () => { llamadas++; return { hallazgos: [] }; } }
        });
        t.eq(llamadas, 0);
        t.eq(res.stats.arreglados, 0);
    });
};
