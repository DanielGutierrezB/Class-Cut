'use strict';
/**
 * Lo que la ventana calcula de una corrida: el estimado, cómo se leen los
 * números y qué carpetas están plegadas.
 *
 * El estimado es lo que más se prueba, y por una razón: es la única parte de la
 * interfaz que puede MENTIR. Una duración mal formateada se ve fea; un "faltan
 * 4 min" que termina siendo cuarenta hace que nadie vuelva a mirar el cartel.
 * Casi todas las pruebas de acá son de cuándo NO hay que decir un número.
 */

const path = require('path');
const { pathToFileURL } = require('url');

/** Los módulos son ESM porque viven en la ventana; desde acá se importan a mano. */
async function cargar(archivo) {
    return import(pathToFileURL(path.join(__dirname, '..', 'src', 'js', archivo)).href);
}

module.exports = async t => {
    const estimar = await cargar('estimar.js');
    const formato = await cargar('formato.js');
    const estado = await cargar('estado.js');
    const progreso = await cargar('progreso.js');

    t.group('el estimado · lo que falta de una etapa');

    t.test('sale de la regla de tres sobre lo transcurrido', () => {
        // Whisper al 25% después de un minuto: faltan tres.
        t.eq(estimar.faltaDeEtapa(60000, 25), 180000);
    });

    t.test('al principio no se dice nada', () => {
        // Al 1%, el segundo y medio de arranque se proyectaría como dos minutos
        // y medio. Es el número que hace que el cartel pierda credibilidad.
        t.eq(estimar.faltaDeEtapa(1500, 1), null);
    });

    t.test('sin porcentaje no hay estimado', () => {
        t.eq(estimar.faltaDeEtapa(60000, null), null);
        t.eq(estimar.faltaDeEtapa(0, 50), null, 'ni sin tiempo transcurrido');
    });

    t.test('al 100% ya no falta nada que estimar', () => {
        t.eq(estimar.faltaDeEtapa(60000, 100), null);
    });

    t.group('el estimado · el ritmo medido');

    t.test('sale de los totales, así que una clase larga pesa más que una corta', () => {
        const muestras = [
            { materialSec: 3600, ms: 1800000, transcribio: true },
            { materialSec: 1800, ms: 1200000, transcribio: true }
        ];
        // (1800000 + 1200000) / (3600 + 1800) = 555,5… ms por segundo.
        t.near(estimar.ritmo(muestras, true), 555.55, 0.1);
    });

    t.test('las que reusaron y las que transcribieron no se promedian juntas', () => {
        const muestras = [
            { materialSec: 3600, ms: 1800000, transcribio: true },
            { materialSec: 3600, ms: 9000, transcribio: false }
        ];
        t.eq(estimar.ritmo(muestras, true), 500);
        t.eq(estimar.ritmo(muestras, false), 2.5, 'reusar es tres órdenes de magnitud más barato');
    });

    t.test('sin muestras de esa bolsa no hay ritmo', () => {
        t.eq(estimar.ritmo([{ materialSec: 3600, ms: 1800000, transcribio: true }], false), null);
        t.eq(estimar.ritmo([], true), null);
    });

    t.test('una muestra rota no cuenta', () => {
        t.eq(estimar.ritmo([{ materialSec: 0, ms: 5000, transcribio: true }], true), null);
        t.eq(estimar.ritmo([{ materialSec: 3600, ms: 0, transcribio: true }], true), null);
    });

    t.group('el estimado · lo que falta de la clase que corre');

    t.test('con ritmo medido, del ritmo', () => {
        // 500 ms por segundo de material, clase de 3600 s = 30 min de proceso;
        // lleva 10, faltan 20.
        t.eq(estimar.faltaDeClase({
            ritmoMs: 500, materialSec: 3600, msTranscurridos: 600000, faltaEtapaMs: null
        }), 1200000);
    });

    t.test('nunca promete menos que lo que la etapa ya sabe que le falta', () => {
        // El ritmo dice "ya termina" pero Whisper va por el 40%: gana Whisper.
        const falta = estimar.faltaDeClase({
            ritmoMs: 500, materialSec: 3600, msTranscurridos: 1790000, faltaEtapaMs: 900000
        });
        t.eq(falta, 900000, 'entre dos medidas gana la que no promete de más');
    });

    t.test('sin ritmo queda lo que diga la etapa, que es mejor que nada', () => {
        t.eq(estimar.faltaDeClase({ ritmoMs: null, materialSec: 3600, faltaEtapaMs: 180000 }), 180000);
    });

    t.test('sin ritmo y sin etapa que informe, no se dice nada', () => {
        t.eq(estimar.faltaDeClase({ ritmoMs: null, materialSec: 3600, faltaEtapaMs: null }), null);
    });

    t.test('un ritmo que se quedó corto no da un número negativo', () => {
        const falta = estimar.faltaDeClase({
            ritmoMs: 100, materialSec: 60, msTranscurridos: 600000, faltaEtapaMs: null
        });
        t.eq(falta, 0, 'cero es "ya casi", y menos que cero no existe');
    });

    t.group('el estimado · lo que falta de la corrida');

    t.test('la que corre más las que esperan, cada una a su ritmo', () => {
        const falta = estimar.faltaDeCorrida({
            faltaClaseMs: 600000,
            pendientes: [
                { materialSec: 3600, transcribira: true },
                { materialSec: 3600, transcribira: false }
            ],
            ritmoDesdeCero: 500,
            ritmoReusando: 2
        });
        // 600000 + (3600 * 500) + (3600 * 2)
        t.eq(falta, 2407200);
    });

    t.test('una sola pendiente sin ritmo para su bolsa invalida el total', () => {
        // El caso que importa: falta una clase de una hora que nunca se midió.
        // Decir "faltan 10 min" ahí es peor que no decir nada.
        t.eq(estimar.faltaDeCorrida({
            faltaClaseMs: 600000,
            pendientes: [{ materialSec: 3600, transcribira: true }],
            ritmoDesdeCero: null,
            ritmoReusando: 2
        }), null);
    });

    t.test('la última clase de la corrida estima sola', () => {
        t.eq(estimar.faltaDeCorrida({
            faltaClaseMs: 600000, pendientes: [], ritmoDesdeCero: null, ritmoReusando: null
        }), 600000);
    });

    t.test('sin nada que estimar, null', () => {
        t.eq(estimar.faltaDeCorrida({
            faltaClaseMs: null, pendientes: [], ritmoDesdeCero: null, ritmoReusando: null
        }), null);
    });

    t.group('la barra · cuánto pesa cada etapa');

    t.test('el peso sale del costo, no de repartir en nueve', () => {
        const w = progreso.pesos(true);
        t.ok(w.revisar > 0.35, 'leer la clase entera es el 41% del tiempo medido');
        t.ok(w.alinear < 0.01, 'alinear son 130 ms y no puede valer un noveno');
        t.near(progreso.ORDEN.reduce((s, e) => s + w[e], 0), 1, 1e-9, 'suman uno');
    });

    t.test('ninguna etapa pesa cero, aunque dure 20 ms', () => {
        // Una etapa sin peso no mueve la barra al pasarla, y entonces hay
        // tramos del proceso en los que nada pasa en pantalla.
        const w = progreso.pesos(true);
        for (const etapa of progreso.ORDEN) t.ok(w[etapa] > 0, `${etapa} tiene peso`);
    });

    t.test('si no se transcribe, transcribir no ocupa lugar', () => {
        const w = progreso.pesos(false);
        t.eq(w.transcribir, 0);
        t.near(progreso.ORDEN.reduce((s, e) => s + w[e], 0), 1, 1e-9);
    });

    t.test('lo medido en esta máquina corre a la tabla', () => {
        // Una máquina donde transcribir se lleva casi todo: la barra tiene que
        // irse para ese lado.
        const w = progreso.pesos(true, { transcribir: 900000, revisar: 10000 }, 4);
        t.ok(w.transcribir > progreso.pesos(true).transcribir * 2, 'la medición manda');
    });

    t.test('una sola medición no puede dejar una etapa sin lugar', () => {
        // El defecto que se vio en una corrida: la primera clase no necesitó
        // arreglar nada (repasar, 7 ms) y con eso la etapa quedó valiendo cero
        // para la segunda, que sí tuvo que arreglar y se tomó 92 segundos con
        // la barra clavada. Una muestra no distingue "es barata" de "esta vez
        // no le tocó".
        const medidos = { transcribir: 24000, afinar: 20000, revisar: 100000, repasar: 6 };
        const w = progreso.pesos(true, medidos, 1);
        t.ok(w.repasar > 0.04, `repasar conserva lugar (quedó en ${(w.repasar * 100).toFixed(1)}%)`);
    });

    t.test('con más clases medidas, la tabla pesa cada vez menos', () => {
        const medidos = { transcribir: 24000, afinar: 20000, revisar: 100000, repasar: 6 };
        const conUna = progreso.pesos(true, medidos, 1).repasar;
        const conDiez = progreso.pesos(true, medidos, 10).repasar;
        t.ok(conDiez < conUna, 'la medición va ganando');
        t.ok(conDiez > 0, 'pero nunca la borra del todo');
    });

    t.test('sin clases detrás, lo medido no cuenta', () => {
        t.eq(progreso.pesos(true, { transcribir: 999999 }, 0).transcribir,
            progreso.pesos(true).transcribir);
    });

    t.group('la barra · avanzar dentro de una etapa callada');

    t.test('avanza sola cuando la etapa no informa nada', () => {
        // Leer la clase entera son casi dos minutos en UNA llamada: avisa una
        // sola vez, al final. Sin esto la barra se congela en el 61%.
        const alMedio = progreso.avance(50000, 100000);
        const casiAlFinal = progreso.avance(90000, 100000);
        t.near(alMedio, 0.45, 0.001);
        t.ok(casiAlFinal > alMedio, 'sigue subiendo');
    });

    t.test('nunca llega a 1 por su cuenta', () => {
        // Que la barra dé una etapa por terminada antes de que el motor lo diga
        // es la manera más rápida de que deje de creerse.
        t.ok(progreso.avance(100000, 100000) < 1);
        t.ok(progreso.avance(10000000, 100000) < 1, 'ni tardando cien veces más');
    });

    t.test('si la estimación se quedó corta, sigue moviéndose igual', () => {
        // El caso que importa: la etapa tardó el triple de lo previsto. Quedarse
        // clavado ahí es exactamente lo que se está arreglando.
        const aTiempo = progreso.avance(100000, 100000);
        const alDoble = progreso.avance(200000, 100000);
        const alTriple = progreso.avance(300000, 100000);
        t.ok(alDoble > aTiempo && alTriple > alDoble, 'nunca se detiene');
    });

    t.test('sin esperado no se inventa avance', () => {
        t.eq(progreso.avance(50000, null), 0);
        t.eq(progreso.avance(50000, 0), 0);
    });

    t.group('la barra · cuánto va de una clase');

    t.test('las etapas anteriores cuentan enteras', () => {
        const enRevisar = progreso.fraccionDeClase({ etapa: 'revisar', percent: 0, transcribe: true });
        const w = progreso.pesos(true);
        t.near(enRevisar, w.reusar + w.transcribir + w.alinear + w.releer + w.afinar + w.despegar, 1e-9);
    });

    t.test('una etapa que no corrió se da por cumplida al pasarla', () => {
        // Sin transcript no hay nada que afinar ni que despegar, y esperar un
        // aviso que no va a llegar dejaría la barra corta hasta un salto final.
        const enCortar = progreso.fraccionDeClase({ etapa: 'cortar', percent: 100, transcribe: false });
        t.ok(enCortar > 0.97);
    });

    t.test('el reloj sigue desde el último aviso, no compitiendo con él', () => {
        // Afinar informa de a tirones: dos avisos juntos y después dieciséis
        // segundos de nada. Si el reloj tuviera que ALCANZAR al aviso viejo, la
        // barra se quedaría quieta todo ese rato.
        const base = { etapa: 'afinar', transcribe: true, esperadoClaseMs: 185000 };
        const reciénAvisado = progreso.fraccionDeClase({ ...base, percent: 40, msDesdeAviso: 0 });
        const enElSilencio = progreso.fraccionDeClase({ ...base, percent: 40, msDesdeAviso: 8000 });
        t.ok(enElSilencio > reciénAvisado, 'se mueve sin que llegue nada');
        const avisoNuevo = progreso.fraccionDeClase({ ...base, percent: 80, msDesdeAviso: 0 });
        t.ok(avisoNuevo > enElSilencio, 'y un dato real corrige la posición');
    });

    t.test('una clase que trabaja nunca llega al 100%', () => {
        // El defecto que se vio en una corrida de verdad: "Arreglando lo que no
        // cierra" tardó 94,8 s donde se esperaban 7 ms, la cuenta se fue al
        // tope y la barra quedó llena dos minutos y medio con el proceso
        // andando. Terminar lo dice el motor, no una estimación.
        const pegado = progreso.fraccionDeClase({
            etapa: 'repasar', transcribe: true, esperadoClaseMs: 120000,
            percent: 100, msDesdeAviso: 99999999
        });
        t.ok(pegado < 1, 'nunca 1');
        t.eq(Math.floor(pegado * 100) < 100, true, 'y nunca se lee "100%"');
    });

    t.test('arreglar lo que no cierra tiene lugar reservado en la barra', () => {
        // Corrió 94,8 s en una de seis clases: con el 0,3% que le daba la
        // primera medición, la barra no tenía por dónde moverse mientras tanto.
        t.ok(progreso.pesos(true).repasar > 0.05);
    });

    t.test('el reloj nunca empuja la barra más allá de su etapa', () => {
        // Que se pase a la etapa siguiente sin que el motor lo haya dicho es la
        // manera de que la barra llegue al 100% con el proceso todavía andando.
        const w = progreso.pesos(true);
        const tope = progreso.fraccionDeClase({
            etapa: 'afinar', transcribe: true, esperadoClaseMs: 185000,
            percent: 40, msDesdeAviso: 99999999
        });
        t.ok(tope < w.reusar + w.transcribir + w.alinear + w.releer + w.afinar);
    });

    t.test('una etapa desconocida no rompe la barra', () => {
        t.eq(progreso.fraccionDeClase({ etapa: 'inventada', percent: 50 }), 0);
        t.eq(progreso.fraccionDeClase({}), 0);
    });

    t.group('la barra · cuánto va de la corrida');

    t.test('pesa por costo y no por cantidad de clases', () => {
        // Doce que reusan y una que se transcribe entera: "1 de 13" no dice
        // nada de cuánto falta.
        const filas = [
            { estado: 'listo', costo: progreso.costoDeClase(3600, true), fraccion: 1 },
            { estado: 'espera', costo: progreso.costoDeClase(3600, false), fraccion: 0 }
        ];
        const va = progreso.fraccionDeCorrida(filas);
        t.ok(va > 0.5, 'la cara ya hecha vale más que la barata que falta');
    });

    t.test('la clase en curso aporta su pedazo', () => {
        const filas = [
            { estado: 'listo', costo: 100, fraccion: 1 },
            { estado: 'trabajando', costo: 100, fraccion: 0.5 },
            { estado: 'espera', costo: 200, fraccion: 0 }
        ];
        t.near(progreso.fraccionDeCorrida(filas), 150 / 400, 1e-9);
    });

    t.test('sin filas no explota', () => {
        t.eq(progreso.fraccionDeCorrida([]), 0);
        t.eq(progreso.fraccionDeCorrida(null), 0);
    });

    t.test('una clase sin duración conocida igual ocupa lugar en la barra', () => {
        // Con costo cero desaparecería de la cuenta y terminarla no movería
        // nada, que es peor que estimarla mal.
        t.ok(progreso.costoDeClase(null, true) > 0);
        t.ok(progreso.costoDeClase(0, false) > 0);
    });

    t.group('la barra · la primera clase, sin nada medido');

    t.test('la semilla le da con qué moverse antes de la primera medición', () => {
        // Es cuando más se mira la pantalla y cuando no hay una sola muestra.
        t.ok(progreso.esperadoDeClase(1022, true) > 0);
        t.ok(progreso.esperadoDeClase(1022, true) > progreso.esperadoDeClase(1022, false),
            'transcribir de cero cuesta más que reusar');
    });

    t.test('con ritmo medido se usa el medido y no la semilla', () => {
        t.eq(progreso.esperadoDeClase(1000, true, 50), 50000);
    });

    t.test('sin material no hay esperado que valga', () => {
        t.eq(progreso.esperadoDeClase(0, true), null);
        t.eq(progreso.esperadoDeClase(null, true), null);
    });

    t.group('la barra · juntar lo medido');

    t.test('suma totales, así que una clase larga pesa lo que pesa', () => {
        const suma = progreso.medir([
            [{ etapa: 'transcribir', ms: 1000 }, { etapa: 'revisar', ms: 5000 }],
            [{ etapa: 'transcribir', ms: 3000 }]
        ]);
        t.eq(suma.transcribir, 4000);
        t.eq(suma.revisar, 5000);
    });

    t.test('una etapa que no existe se ignora', () => {
        t.eq(progreso.medir([[{ etapa: 'inventada', ms: 999 }]]).inventada, undefined);
        t.eq(Object.keys(progreso.medir(null)).length, 0);
    });

    t.group('cómo se leen los números');

    t.test('un tiempo corto no se redondea a un segundo entero', () => {
        t.eq(formato.fmtMs(820), '820 ms');
        t.eq(formato.fmtMs(8420), '8,4 s');
        t.eq(formato.fmtMs(252000), '4:12');
        t.eq(formato.fmtMs(4323000), '1:12:03');
        t.eq(formato.fmtMs(null), '—');
    });

    t.test('los tokens se abrevian porque los de verdad son grandes', () => {
        t.eq(formato.fmtTokens(812), '812');
        t.eq(formato.fmtTokens(31365), '31,4k');
        t.eq(formato.fmtTokens(2400000), '2,40M');
        t.eq(formato.fmtTokens(null), '—');
    });

    t.test('un estimado se dice redondeado y con "~"', () => {
        t.eq(formato.fmtFalta(30000), 'menos de 1 min');
        t.eq(formato.fmtFalta(252000), '~4 min');
        t.eq(formato.fmtFalta(4800000), '~1 h 20 min');
        t.eq(formato.fmtFalta(7200000), '~2 h');
    });

    t.test('sin estimado no hay texto que mostrar', () => {
        t.eq(formato.fmtFalta(null), null, 'null y no "—": quien dibuja no pone nada');
        t.eq(formato.fmtFalta(-1), null);
    });

    t.group('la tabla · qué carpetas están plegadas');

    t.test('una carpeta nueva se ve abierta sin que nadie la anote', () => {
        estado.state.colapsadas.clear();
        t.eq(estado.estaColapsada('/cursos/uno'), false);
    });

    t.test('plegar y desplegar es el mismo clic', () => {
        estado.state.colapsadas.clear();
        t.eq(estado.alternarCarpeta('/cursos/uno'), true, 'devuelve cómo quedó');
        t.eq(estado.estaColapsada('/cursos/uno'), true);
        t.eq(estado.alternarCarpeta('/cursos/uno'), false);
        t.eq(estado.estaColapsada('/cursos/uno'), false);
    });

    t.test('cada carpeta va por su cuenta', () => {
        estado.state.colapsadas.clear();
        estado.alternarCarpeta('/cursos/uno');
        t.eq(estado.estaColapsada('/cursos/uno'), true);
        t.eq(estado.estaColapsada('/cursos/dos'), false);
    });

    t.test('quitar una carpeta se lleva su pliegue', () => {
        // Sin esto, quitarla y volver a agregarla la devolvía cerrada, que se
        // lee como que no cargó nada.
        estado.state.colapsadas.clear();
        estado.state.carpetas = [{ root: '/cursos/uno', classes: [] }];
        estado.alternarCarpeta('/cursos/uno');
        estado.quitarCarpeta('/cursos/uno');
        t.eq(estado.estaColapsada('/cursos/uno'), false);
        estado.state.carpetas = [];
    });
};
