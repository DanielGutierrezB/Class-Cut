'use strict';
/**
 * ver-guion.js — Pinta el guion final con datos puestos a mano.
 *
 * Sirve para mirar cómo queda la pantalla sin tener que reprocesar un curso
 * entero, que son horas, y sobre todo sin escribir en las carpetas de nadie. Lo
 * que imprime es el JS que hay que inyectarle a la ventana:
 *
 *   npx electron . --shot=/tmp/guion.png --js="$(node tools/ver-guion.js)"
 */

// El caso real de la clase 1: el bloque 13 seguía de largo hasta donde el
// profesor rehizo la frase, y el 14 la decía otra vez. Ahora está recortado.
const datos = {
    repeticiones: {
        stats: { encontradas: 2, recortadas: 2, descartadas: 0, avisadas: 0, deshechas: 0, segundos: 24.5 },
        hallazgos: [{
            bloque: 12,
            contra: 13,
            accion: 'recortar',
            aplicado: true,
            recorteSec: 11.44,
            texto: 'y es justamente es el problema por el que ByCoin no escala, porque la ' +
                'inteligencia artificial se va a encontrar con un montón de contradicciones.'
        }]
    },
    coherence: {
        wordCount: 1840,
        blocks: [
            {
                n: 12, index: 11, durationSec: 41, note: '',
                text: 'Entonces, lo que hicimos fue pedirle a CloudCode que hiciera el cambio ' +
                    'en la aplicación, y lo hizo sobre el código directamente.'
            },
            {
                n: 13, index: 12, durationSec: 24.3, note: 'OUT ANTES DE: "¡Ya nos entregó la aplicación"',
                text: 'En resumen, lo que sucedió es que identificamos un cambio en la aplicación ' +
                    'que debíamos hacer y simplemente fuimos a CloudCode con Bycoin y se lo ' +
                    'solicitamos. CloudCode lo que hizo es que nos hizo las modificaciones en el ' +
                    'código y nos entregó el cambio en la aplicación. El problema que estamos ' +
                    'evidenciando acá es que una cosa dice el código y la aplicación y otra cosa ' +
                    'muy distinta dice la especificación. Aquí ya tenemos dos fuentes de verdad.'
            },
            {
                n: 14, index: 13, durationSec: 12.1, note: '',
                text: 'Y justo ese es el problema por el que el Bycoin no escala, porque la ' +
                    'inteligencia artificial se va a encontrar con algo que dice el código y con ' +
                    'otra cosa muy distinta y contradictoria que dice la especificación.'
            }
        ],
        findings: [{
            bloque: 14,
            tipo: 'repetido',
            gravedad: 'alta',
            fuente: 'ia',
            detalle: 'El bloque 14 repite la segunda mitad del bloque 13.',
            corregido: 'Se recortaron 11.4s del bloque 13, que ya decía esto mismo.'
        }]
    }
};

process.stdout.write(
    `(async () => {
        const g = await import('./js/visor/guion.js');
        const e = await import('./js/visor/estado.js');
        Object.assign(e.rev, { data: ${JSON.stringify(datos)}, segments: [], tab: 'guion' });
        for (const v of document.querySelectorAll('.view')) v.classList.remove('is-visible');
        document.getElementById('view-review').classList.add('is-visible');
        document.getElementById('rev-cuts').hidden = true;
        document.getElementById('rev-script').hidden = false;
        g.renderScript();
        return 'guion pintado';
    })()`.replace(/\s+/g, ' ')
);
