/**
 * audio-onset.js — Dónde arranca y dónde termina el SONIDO, medido en el audio.
 *
 * Por qué existe: los tiempos del transcript no sirven para decidir el frame del
 * corte. Whisper estira la primera palabra de cada toma hacia atrás, hacia el
 * silencio — medido en una clase real, "Y" empezaba según el transcript en 181.44
 * cuando el sonido no arranca hasta 181.99 (550 ms, 14 frames); en otro bloque la
 * diferencia era de 1.02 s. Con ese error, el colchón de 10 frames o se convierte
 * en un segundo de silencio muerto, o desaparece y el corte se mete en el ataque
 * de la palabra. El editor lo ve en el waveform al instante.
 *
 * Reparto de responsabilidades: el transcript y la nota del CD dicen QUÉ palabras
 * entran al bloque; el audio dice DÓNDE cae el corte exacto.
 *
 * El WAV se lee directo (`fs`, sin ffmpeg): es PCM, así que basta la cabecera y un
 * seek al byte de la ventana que interesa (unos cientos de KB por borde).
 *
 * Doble export: window.EPAudioOnset + module.exports (Node).
 */
(function(global) {
    "use strict";

    var fs = null, pathMod = null;
    try {
        if (typeof require === "function") { fs = require("fs"); pathMod = require("path"); }
    } catch (e) {}

    var DEFAULTS = {
        hopMs: 5,             // resolución de la envolvente (0.005s = 1/8 de frame)
        searchSec: 2.0,       // cuánto se busca el borde del sonido alrededor del corte
        quietMs: 200,         // silencio que tiene que haber al otro lado del borde
        voiceMs: 60,          // sonido sostenido para no confundir un chasquido
        quietTolerance: 0.1,  // fracción del silencio que puede pasarse (respiraciones)
        floorPct: 0.15,       // percentil que se toma como piso de ruido
        peakPct: 0.95,
        // El umbral se ancla a los dos lados: bastante sobre el ruido de sala, pero
        // sin acercarse a la voz. Barridos sobre una clase real dan el mismo arranque
        // al milisegundo entre peak-6dB y peak-15dB (el ataque es abrupto); lo que
        // cambia es cuántas fronteras se pueden medir, y con peak-10/piso+18 una
        // respiración deja de contar como voz (28 → 43 de 60 fronteras medidas).
        overFloorDb: 18,
        underPeakDb: 10,
        maxShiftSec: 2.0,     // un borde más lejos que esto no se cree
        // Límites que el borde no puede cruzar (los pone quien llama, a partir del
        // transcript): el audio ajusta el frame DENTRO del contenido del bloque, no
        // añade palabras que el bloque deja fuera.
        minTime: null,        // para el IN: final de la palabra anterior
        maxTime: null,        // para el OUT: principio de la palabra siguiente
        // Hasta dónde se busca el borde. Es otro límite: los de arriba dicen qué
        // contenido es del bloque (y el colchón los respeta), estos dicen hasta
        // dónde es creíble que el ataque de esta palabra sea el sonido que se oye.
        // Sin ellos, un golpe en el silencio de antes pasa por arranque de frase.
        edgeMinTime: null,
        edgeMaxTime: null,
        padFrames: 10,        // colchón (el mismo de marker-precision)
        fps: 25,
        // El riesgo no es simétrico: quedarse corto de aire se oye, pasarse solo deja
        // silencio muerto. Con colchón de 10 frames se acepta la banda [4, 22].
        hardAirFrames: 2,     // menos aire que esto se oye como corte seco
        airTightFrames: 6,    // por debajo del colchón menos esto, se gana aire
        airSlackFrames: 12,   // por encima del colchón más esto, sobra silencio
        // Alineación del transcript completo (alignWords):
        alignMinGapSec: 0.35, // silencio mínimo para que haya un borde que medir
        alignMinWordSec: 0.06,// ninguna palabra queda más corta que esto
        // Cuánto puede el sonido caer ANTES de lo que dice el transcript. El sesgo
        // medido va al otro lado (el sonido llega después), así que un borde muy
        // anterior a la palabra es un ruido de sala, no su ataque.
        alignGraceSec: 0.4,
        // Hasta dónde puede irse a buscar el ataque cuando en el sitio del transcript
        // no suena nada: el STT llega a adelantarse más de dos segundos.
        alignWideShiftSec: 3.5,
        alignIsolationSec: 2.0,// silencio a los dos lados para mirar si una palabra suena
        // Cada pasada solo alcanza lo que cabe en su ventana de búsqueda, y la ventana
        // se abre alrededor de los tiempos del transcript. Cuando el STT se pasa de
        // largo, la primera pasada acerca la palabra y la siguiente ya ve el borde de
        // verdad: por eso se repite hasta que deje de mover.
        alignPasses: 3,
        // Fracción del nivel de habla de la clase por debajo de la cual una palabra
        // aislada no suena. Un cue dicho de lejos ("Va.") baja bastante del nivel
        // normal, así que el corte va holgado: solo cae lo que es silencio de verdad.
        alignSilentRatio: 0.08
    };

    var CODE_LABELS = {
        "audio-clip": "el corte se mete en el sonido",
        "audio-air": "el aire del corte no es el del colchón"
    };

    function opt(opts, key) {
        if (opts && opts[key] !== undefined && opts[key] !== null) return opts[key];
        return DEFAULTS[key];
    }

    function frameRate(opts) {
        var fps = Number(opt(opts, "fps"));
        return (isFinite(fps) && fps > 0) ? fps : DEFAULTS.fps;
    }

    function round(x) { return Math.round(x * 1000) / 1000; }

    // ─── Envolvente y umbral ─────────────────────────────────

    /**
     * Envolvente RMS de una señal mono.
     * @param {Array|Float32Array} samples muestras en [-1, 1] (o magnitudes ≥ 0)
     * @returns {{env: Array<number>, hopSec: number}}
     */
    function envelope(samples, sampleRate, opts) {
        var hop = Math.max(1, Math.round(sampleRate * opt(opts, "hopMs") / 1000));
        var env = [];
        var n = samples.length;
        for (var i = 0; i + hop <= n; i += hop) {
            var sum = 0;
            for (var k = 0; k < hop; k++) { var v = samples[i + k]; sum += v * v; }
            env.push(Math.sqrt(sum / hop));
        }
        return { env: env, hopSec: hop / sampleRate };
    }

    function percentile(sorted, p) {
        if (sorted.length === 0) return 0;
        var idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
        return sorted[idx];
    }

    /**
     * Piso de ruido, nivel de voz y el umbral que los separa. El umbral se ancla a
     * los dos lados: bastante sobre el ruido de sala, pero sin acercarse a la voz —
     * si solo se mirara el ruido, una sala silenciosa dispararía con una respiración.
     */
    function stats(env, opts) {
        var sorted = env.slice().sort(function(a, b) { return a - b; });
        var floor = percentile(sorted, opt(opts, "floorPct"));
        var peak = percentile(sorted, opt(opts, "peakPct"));
        var overFloor = floor * Math.pow(10, opt(opts, "overFloorDb") / 20);
        var underPeak = peak * Math.pow(10, -opt(opts, "underPeakDb") / 20);
        var threshold = Math.min(overFloor, Math.max(underPeak, floor * 2));
        return { floor: floor, peak: peak, threshold: threshold };
    }

    /** Tramos con sonido sostenido: [{from, to}] en índices de la envolvente. */
    function voiceRuns(env, threshold, minRun) {
        var runs = [];
        var i = 0;
        while (i < env.length) {
            if (env[i] < threshold) { i++; continue; }
            var j = i;
            while (j < env.length && env[j] >= threshold) j++;
            if (j - i >= minRun) runs.push({ from: i, to: j });
            i = j;
        }
        return runs;
    }

    /** ¿Los `count` hops que terminan en `end` están en silencio? */
    function quietBefore(env, end, count, threshold, tolerance) {
        var start = end - count;
        if (start < 0) return false;
        var loud = 0;
        for (var i = start; i < end; i++) if (env[i] >= threshold) loud++;
        return loud <= Math.floor(count * tolerance);
    }

    function quietAfter(env, start, count, threshold, tolerance) {
        if (start + count > env.length) return false;
        var loud = 0;
        for (var i = start; i < start + count; i++) if (env[i] >= threshold) loud++;
        return loud <= Math.floor(count * tolerance);
    }

    /**
     * Borde del sonido dentro de una ventana ya medida: el arranque de voz (IN) o
     * el final de voz (OUT) **más cercano al corte**, exigiendo silencio de verdad
     * al otro lado.
     *
     * Lo de "más cercano" no es un detalle: el audio ajusta el frame de una
     * decisión que ya está tomada, no elige qué palabras entran. Buscando el último
     * final de voz de la ventana, un OUT quería abrirse hasta el final de un
     * "pausa" dicho al editor 1.8 s después — justo la palabra que el bloque tiene
     * que dejar fuera.
     *
     * Devuelve null cuando no se puede afirmar (ventana sin contraste, habla
     * continua, o un borde tan lejos del corte que sería otra frase).
     * @returns {{time, shiftSec, floor, peak, threshold}|null}
     */
    /** El más restrictivo de dos límites (cualquiera puede faltar). */
    function tighter(a, b, isFloor) {
        if (a == null) return b == null ? null : b;
        if (b == null) return a;
        return isFloor ? Math.max(a, b) : Math.min(a, b);
    }

    function refine(probe, reference, kind, opts) {
        var env = probe.env, hopSec = probe.hopSec, t0 = probe.windowStart;
        if (!env || env.length < 10) return null;

        var st = stats(env, opts);
        if (!(st.peak > st.floor * 3)) return null;   // todo silencio o todo voz

        var minRun = Math.max(1, Math.round(opt(opts, "voiceMs") / (hopSec * 1000)));
        var quietRun = Math.max(1, Math.round(opt(opts, "quietMs") / (hopSec * 1000)));
        var tol = opt(opts, "quietTolerance");
        var runs = voiceRuns(env, st.threshold, minRun);
        if (runs.length === 0) return null;

        var refIdx = (reference - t0) / hopSec;
        var lo = tighter(opt(opts, "minTime"), opt(opts, "edgeMinTime"), true);
        var hi = tighter(opt(opts, "maxTime"), opt(opts, "edgeMaxTime"), false);
        var idx = -1, bestDist = Infinity;

        // El borde no es el final del tramo sostenido, es **el último hop con sonido
        // antes de que se haga el silencio**. Las palabras se apagan a saltos: tras el
        // tramo sostenido quedan chispazos demasiado cortos para contar como voz, y
        // tomando el final del tramo el corte caía 200 ms antes de que la frase
        // acabara de sonar — encima de la onda. Peor todavía: el chequeo de silencio
        // sí veía esos chispazos, así que descartaba el borde y el audio se callaba.
        for (var i = 1; i < env.length; i++) {
            var loud = kind === "IN" ? env[i] >= st.threshold : env[i - 1] >= st.threshold;
            if (!loud) continue;
            var at = t0 + i * hopSec;
            // Un borde que cruza el límite cambiaría qué palabras entran al bloque:
            // el caso real es un "pausa" dicho al editor 200 ms después de la última
            // frase, pegado al mismo tramo de voz — el OUT se abría hasta el final del
            // cue. Si ningún borde cabe, el audio se calla y manda el transcript.
            if (lo != null && at < lo) continue;
            if (hi != null && at > hi) continue;
            var dist = Math.abs(i - refIdx);
            if (dist >= bestDist) continue;
            var quiet = kind === "IN"
                ? quietBefore(env, i, quietRun, st.threshold, tol)
                : quietAfter(env, i, quietRun, st.threshold, tol);
            if (!quiet) continue;
            bestDist = dist;
            idx = i;
        }
        if (idx < 0) return null;

        // El silencio disponible se mide contra los tramos de voz, no contra los
        // chispazos: un clic aislado no acorta el colchón.
        var bestRun = nearestRun(runs, idx, kind);

        var time = t0 + idx * hopSec;
        var shift = time - reference;
        if (Math.abs(shift) > opt(opts, "maxShiftSec")) return null;

        return {
            time: round(time),
            shiftSec: round(shift),
            quietSec: round(quietSpan(runs, bestRun, idx, env.length, kind) * hopSec),
            floor: st.floor,
            peak: st.peak,
            threshold: st.threshold
        };
    }

    /**
     * Tramo de voz al que pertenece un borde: el que lo precede (OUT) o el que lo
     * sigue (IN). Es la referencia para medir el silencio del otro lado.
     */
    function nearestRun(runs, idx, kind) {
        var i;
        if (kind === "IN") {
            for (i = 0; i < runs.length; i++) {
                if (runs[i].to > idx) return i;
            }
            return runs.length - 1;
        }
        var best = 0;
        for (i = 0; i < runs.length; i++) {
            if (runs[i].from < idx) best = i;
            else break;
        }
        return best;
    }

    /**
     * Hops de silencio disponibles al otro lado del borde: hasta dónde puede llegar
     * el colchón sin meterse en el sonido vecino (la cola de la toma anterior, o el
     * "pausa" que el profesor le dice al editor justo después).
     */
    function quietSpan(runs, runIdx, edgeIdx, total, kind) {
        if (kind === "IN") {
            var prev = runIdx > 0 ? runs[runIdx - 1].to : 0;
            return Math.max(0, edgeIdx - prev);
        }
        var next = runIdx < runs.length - 1 ? runs[runIdx + 1].from : total;
        return Math.max(0, next - edgeIdx);
    }

    /**
     * ¿Hay voz sonando en este instante de una ventana ya medida?
     *
     * Existe porque `airFrames` no contesta esta pregunta y se venía leyendo como
     * si la contestara. `airFrames` mide la distancia entre el borde del sonido y
     * el tiempo que traía el TRANSCRIPT; el corte que se aplica es otro, porque
     * `evaluate` le resta el colchón. Así que un `airFrames` negativo dice "el
     * transcript ponía el corte adentro del sonido", no "el corte quedó adentro":
     * medido sobre los dos bordes del curso que estaban en negativo, el corte
     * aplicado tenía 5,4 y 7,8 frames de aire.
     *
     * Esto sí es la pregunta del editor: en el frame donde va a caer el corte,
     * ¿se oye alguien? Se contesta con el mismo umbral local y los mismos tramos
     * de voz con los que se eligió el borde, así que no puede discrepar de la
     * decisión que se acaba de tomar.
     *
     * @returns {boolean|null} null cuando la ventana no alcanza a ese instante
     */
    function insideVoice(probeData, threshold, at, opts) {
        if (!probeData || !probeData.env || threshold == null || at == null) return null;
        var env = probeData.env, hopSec = probeData.hopSec;
        var idx = (at - probeData.windowStart) / hopSec;
        if (!(idx >= 0 && idx <= env.length)) return null;
        var minRun = Math.max(1, Math.round(opt(opts, "voiceMs") / (hopSec * 1000)));
        var runs = voiceRuns(env, threshold, minRun);
        // Un frame de margen a cada lado: el corte se escribe en frames, así que
        // pegarse al borde del sonido no es meterse dentro de él.
        var margin = (1 / frameRate(opts)) / hopSec;
        for (var i = 0; i < runs.length; i++) {
            if (idx > runs[i].from + margin && idx < runs[i].to - margin) return true;
        }
        return false;
    }

    /**
     * Lo mismo, para un tiempo suelto y sin haber medido nada antes.
     *
     * Hace falta para el caso peor: cuando `measure` no puede afirmar nada y el
     * corte sale con el tiempo del transcript sin corregir. Ahí es donde es más
     * probable que caiga encima de una palabra, y es justo donde hasta ahora no
     * había ninguna medición que lo dijera.
     *
     * @returns {boolean|null}
     */
    function voiceAt(wav, timeSec, opts) {
        var probeData = probe(wav, timeSec - 1.5, 3.0, opts);
        if (!probeData || !probeData.env || probeData.env.length < 10) return null;
        var st = stats(probeData.env, opts);
        // Sin contraste no se afirma nada: o está todo callado o está todo
        // sonando, y en los dos casos el umbral sería una invención.
        if (!(st.peak > st.floor * 3)) return null;
        return insideVoice(probeData, st.threshold, timeSec, opts);
    }

    /**
     * Aire real del corte y a dónde debería irse. El corte se alinea a frame
     * SIEMPRE hacia el silencio (el IN al frame anterior, el OUT al siguiente):
     * redondear hacia el sonido es justo el error que se oye.
     *
     * `airFrames` mide contra `markerTime`, o sea contra el tiempo que traía el
     * transcript: es cuánto se equivocaba la propuesta, no cuánto aire le queda
     * al corte que sale de acá. El corte que sale siempre está del lado del
     * silencio, porque es `edge.time` menos el colchón. Para saber si de verdad
     * cae encima de alguien hablando está `insideVoice`.
     *
     * @returns {{airFrames, applyTime, code, message}}
     */
    function evaluate(edge, markerTime, kind, opts) {
        var fps = frameRate(opts);
        var pad = Number(opt(opts, "padFrames"));
        if (!isFinite(pad) || pad < 0) pad = DEFAULTS.padFrames;
        var air = (kind === "IN" ? (edge.time - markerTime) : (markerTime - edge.time)) * fps;

        // El colchón no puede pasarse al sonido vecino ni cruzar el límite del
        // bloque: se recorta a lo que haya, dejando un frame de margen.
        var padSec = pad / fps;
        if (edge.quietSec != null && isFinite(edge.quietSec)) {
            padSec = Math.min(padSec, Math.max(0, edge.quietSec - 1 / fps));
        }
        var bound = kind === "IN" ? opt(opts, "minTime") : opt(opts, "maxTime");
        if (bound != null) {
            var room = kind === "IN" ? (edge.time - bound) : (bound - edge.time);
            padSec = Math.min(padSec, Math.max(0, room - 1 / fps));
        }
        var cut = kind === "IN" ? edge.time - padSec : edge.time + padSec;
        var frames = kind === "IN" ? Math.floor(cut * fps) : Math.ceil(cut * fps);
        var applyTime = round(Math.max(0, frames / fps));

        // El colchón que de verdad cabe: donde el silencio es corto, pedir los 10
        // frames completos dejaría el aviso puesto para siempre.
        var target = Math.round(padSec * fps);
        var code = "", message = "";
        var where = kind === "IN" ? "El IN abre" : "El OUT cierra";
        var edgeIs = kind === "IN" ? "la frase arranca" : "la frase termina";
        if (air < opt(opts, "hardAirFrames")) {
            code = "audio-clip";
            message = where + " " + Math.abs(air).toFixed(1) + " frames " +
                (air < 0 ? "DENTRO del sonido" : "del sonido") + ": " +
                edgeIs + " en " + edge.time.toFixed(2) + "s.";
        } else if (air < target - opt(opts, "airTightFrames")) {
            code = "audio-air";
            message = where + " solo " + air.toFixed(0) + " frames del sonido (caben " +
                target + "): " + edgeIs + " en " + edge.time.toFixed(2) + "s.";
        } else if (air > target + opt(opts, "airSlackFrames")) {
            code = "audio-air";
            message = where + " " + air.toFixed(0) + " frames del sonido (el colchón pide " +
                target + "): sobra silencio.";
        }
        return { airFrames: air, applyTime: applyTime, code: code, message: message };
    }

    // ─── Lectura del WAV ─────────────────────────────────────

    function available() { return !!fs; }

    /**
     * Cabecera de un WAV PCM. Se recorren los chunks porque Premiere mete un `bext`
     * antes del `data`.
     * @returns {{sampleRate, channels, bits, format, dataOffset, dataBytes, durationSec}|null}
     */
    function wavInfo(file) {
        if (!fs) return null;
        var fd = null;
        try {
            fd = fs.openSync(file, "r");
            var head = Buffer.alloc(4096);
            var read = fs.readSync(fd, head, 0, 4096, 0);
            if (read < 44 || head.toString("ascii", 0, 4) !== "RIFF" ||
                head.toString("ascii", 8, 12) !== "WAVE") return null;

            var size = fs.fstatSync(fd).size;
            var pos = 12, fmt = null, dataOffset = 0, dataBytes = 0;
            while (pos + 8 <= read) {
                var id = head.toString("ascii", pos, pos + 4);
                var len = head.readUInt32LE(pos + 4);
                if (id === "fmt ") {
                    fmt = {
                        format: head.readUInt16LE(pos + 8),
                        channels: head.readUInt16LE(pos + 10),
                        sampleRate: head.readUInt32LE(pos + 12),
                        bits: head.readUInt16LE(pos + 22)
                    };
                } else if (id === "data") {
                    dataOffset = pos + 8;
                    dataBytes = Math.min(len || (size - dataOffset), size - dataOffset);
                    break;
                }
                pos += 8 + len + (len % 2);
            }
            if (!fmt || !dataOffset || !fmt.sampleRate || !fmt.channels) return null;
            var bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
            return {
                format: fmt.format,
                channels: fmt.channels,
                sampleRate: fmt.sampleRate,
                bits: fmt.bits,
                dataOffset: dataOffset,
                dataBytes: dataBytes,
                durationSec: bytesPerSec ? dataBytes / bytesPerSec : 0
            };
        } catch (e) {
            return null;
        } finally {
            if (fd !== null) { try { fs.closeSync(fd); } catch (e2) {} }
        }
    }

    /** Magnitud de una muestra según el formato, ya en [0, 1]. */
    function sampleAt(buf, offset, info) {
        if (info.format === 3 && info.bits === 32) return Math.abs(buf.readFloatLE(offset));
        if (info.bits === 16) return Math.abs(buf.readInt16LE(offset)) / 32768;
        if (info.bits === 24) {
            var v = buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 24 >> 8);
            return Math.abs(v) / 8388608;
        }
        if (info.bits === 32) return Math.abs(buf.readInt32LE(offset)) / 2147483648;
        if (info.bits === 8) return Math.abs(buf[offset] - 128) / 128;
        return 0;
    }

    /**
     * Envolvente de una ventana del WAV. Los canales se combinan por RMS: si el
     * micro del profesor está en un solo canal, mirar solo el izquierdo daría
     * silencio donde hay voz.
     * @returns {{env, hopSec, windowStart}|null}
     */
    function probe(wav, from, dur, opts) {
        if (!fs || !wav || !wav.file || !wav.info) return null;
        var info = wav.info;
        var bytesPerSample = info.bits / 8;
        var block = info.channels * bytesPerSample;
        if (!block) return null;

        var start = Math.max(0, from);
        var offset = info.dataOffset + Math.floor(start * info.sampleRate) * block;
        var length = Math.floor(dur * info.sampleRate) * block;
        var end = info.dataOffset + info.dataBytes;
        if (offset >= end) return null;
        length = Math.min(length, end - offset);
        if (length < block * 100) return null;

        var fd = null, buf;
        try {
            fd = fs.openSync(wav.file, "r");
            buf = Buffer.alloc(length);
            var got = fs.readSync(fd, buf, 0, length, offset);
            if (got < block * 100) return null;
            if (got < length) buf = buf.slice(0, got);
        } catch (e) {
            return null;
        } finally {
            if (fd !== null) { try { fs.closeSync(fd); } catch (e2) {} }
        }

        var frames = Math.floor(buf.length / block);
        var mono = new Float32Array(frames);
        for (var i = 0; i < frames; i++) {
            var base = i * block, sum = 0;
            for (var c = 0; c < info.channels; c++) {
                var v = sampleAt(buf, base + c * bytesPerSample, info);
                sum += v * v;
            }
            mono[i] = Math.sqrt(sum / info.channels);
        }
        var env = envelope(mono, info.sampleRate, opts);
        return { env: env.env, hopSec: env.hopSec, windowStart: start };
    }

    /**
     * Mide un borde contra el audio: ventana alrededor del corte, borde del sonido
     * y veredicto. null cuando el audio no puede afirmar nada — entonces manda lo
     * que dijo el transcript.
     * @returns {{edge, airFrames, applyTime, insideVoice, code, message}|null}
     */
    function measure(wav, markerTime, kind, opts) {
        var search = opt(opts, "searchSec");
        var probeData = probe(wav, markerTime - search - 0.3, 2 * search + 0.6, opts);
        if (!probeData) return null;
        var edge = refine(probeData, markerTime, kind, opts);
        if (!edge) return null;
        var res = evaluate(edge, markerTime, kind, opts);
        res.edge = edge;
        // Con la ventana y el umbral ya en la mano, preguntar si el corte cae
        // encima de alguien hablando no cuesta otra lectura del WAV.
        res.insideVoice = insideVoice(probeData, edge.threshold, res.applyTime, opts);
        return res;
    }

    /**
     * El borde del sonido más cercano a un tiempo, sin colchón ni veredicto.
     * @returns {{time, shiftSec, quietSec}|null}
     */
    function edgeAt(wav, time, kind, opts) {
        var search = opt(opts, "searchSec");
        var probeData = probe(wav, time - search - 0.3, 2 * search + 0.6, opts);
        if (!probeData) return null;
        return refine(probeData, time, kind, opts);
    }

    // ─── Alinear el transcript con el audio ──────────────────

    /**
     * Los tiempos del STT medidos contra el WAV, en las fronteras que importan: los
     * bordes de cada silencio. Medido sobre cuatro clases reales del mismo proyecto,
     * el STT (whisper large-v3-turbo) acierta los FINALES de palabra (sesgo mediano 0
     * frames, error mediano 2) y **adelanta los ARRANQUES tras un silencio** (sesgo
     * mediano +8.5 frames, hasta +43): le atribuye a la primera palabra el silencio
     * que la precede, y cuanto más largo el silencio, más estira (+5 frames tras 1s,
     * +12 tras 8s). Por eso un IN colocado con los tiempos del transcript deja aire
     * muerto —o, en el peor caso, arranca dos segundos antes de que hable nadie— y el
     * OUT sale bien casi siempre.
     *
     * Aquí se arregla **una vez, al guardar**, en vez de en cada borde que alguien
     * mire después: el transcript guardado lleva ya los tiempos del sonido y de ellos
     * viven los cortes, el buscador de repeticiones, el editor y los SRT. En una clase
     * de 26 min son ~135 fronteras y cuesta menos de un segundo.
     *
     * Se trabaja por **tramos** (palabras seguidas entre dos silencios), no palabra a
     * palabra: se miden los dos bordes del tramo y las palabras de dentro se reparten
     * proporcionalmente en el hueco medido. Dentro de un tramo los tiempos relativos
     * del STT son buenos —el error se concentra en los bordes—, así que el reparto los
     * mueve un 1-2% y a cambio nunca queda una palabra invertida, ni pisando a la
     * vecina, ni un final correcto empujado por la corrección de un arranque (que es
     * lo que pasaba empujando la cadena hacia adelante: cinco palabras desplazadas
     * 0.8s y el final del tramo 0.7s después de que el sonido acabara).
     *
     * Solo se toca lo que el audio puede afirmar; donde no hay borde limpio, manda el
     * transcript.
     *
     * Una pasada no basta. La ventana en la que se busca cada borde se abre alrededor
     * del tiempo que trae el transcript, así que un error más grande que la ventana
     * solo se corrige en parte: la palabra queda más cerca y la pasada siguiente ya ve
     * el borde de verdad. En la clase 15 eso dejó `"conecte."` acabando 0.78s después
     * del sonido en un transcript que ya constaba como alineado, y con ese final de más
     * el cierre correcto del bloque 3 se leía como corte a mitad de palabra. Se repite
     * hasta que una pasada no mueve nada (tope `alignPasses`): en las clases medidas
     * son dos pasadas, tres las que venían sin alinear.
     *
     * @param {{file, info}} wav
     * @param {Array} words words[] del STT (no se muta: se devuelve una copia)
     * @returns {{words, stats}} stats = {runs, movedStarts, movedEnds,
     *          medianStartShift, maxStartShift}, medido contra los tiempos de entrada
     */
    function alignWords(wav, words, opts) {
        var cur = words || [];
        var passes = Math.max(1, opt(opts, "alignPasses"));
        for (var p = 0; p < passes; p++) {
            var res = alignPass(wav, cur, opts);
            cur = res.words;
            if (!res.stats.movedStarts && !res.stats.movedEnds) break;
        }
        return { words: cur, stats: alignStats(words || [], cur, opts) };
    }

    /**
     * Lo que cambió entre los tiempos que entraron y los que salieron, contado por
     * tramos como lo cuenta una pasada suelta. Sumar las pasadas contaría dos veces la
     * palabra que se movió en las dos.
     */
    function alignStats(before, after, opts) {
        var st = { runs: 0, movedStarts: 0, movedEnds: 0,
            medianStartShift: 0, maxStartShift: 0 };
        var frame = 1 / frameRate(opts);
        var runs = wordRuns(before, opt(opts, "alignMinGapSec"));
        var shifts = [];
        for (var r = 0; r < runs.length; r++) {
            var run = runs[r];
            var head = run[0], tail = run[run.length - 1];
            if (!after[head] || !after[tail]) continue;
            st.runs++;
            var ds = after[head].start - before[head].start;
            var de = after[tail].end - before[tail].end;
            if (Math.abs(ds) >= frame) {
                st.movedStarts++;
                shifts.push(ds);
                if (Math.abs(ds) > Math.abs(st.maxStartShift)) st.maxStartShift = round(ds);
            }
            if (Math.abs(de) >= frame) st.movedEnds++;
        }
        if (shifts.length) {
            shifts.sort(function(a, b) { return a - b; });
            st.medianStartShift = round(shifts[Math.floor(shifts.length / 2)]);
        }
        return st;
    }

    /** Una pasada de alineación: mide los bordes de cada tramo y reparte lo de dentro. */
    function alignPass(wav, words, opts) {
        var out = [], i;
        for (i = 0; i < (words || []).length; i++) {
            var src = words[i], copy = {};
            for (var k in src) if (src.hasOwnProperty(k)) copy[k] = src[k];
            out.push(copy);
        }
        var st = { runs: 0, movedStarts: 0, movedEnds: 0,
            medianStartShift: 0, maxStartShift: 0 };
        if (!wav || !wav.info || out.length === 0) return { words: out, stats: st };

        var minDur = opt(opts, "alignMinWordSec");
        var grace = opt(opts, "alignGraceSec");
        var frame = 1 / frameRate(opts);
        var runs = wordRuns(out, opt(opts, "alignMinGapSec"));
        var speech = classThreshold(wav, out, opts);
        var shifts = [];

        for (var r = 0; r < runs.length; r++) {
            var run = runs[r];
            var first = out[run[0]], last = out[run[run.length - 1]];
            var s0 = first.start, e0 = last.end;
            if (!(e0 > s0)) continue;
            st.runs++;

            // Ningún borde puede confundirse con el del tramo vecino.
            var floor = r > 0 ? out[runs[r - 1][runs[r - 1].length - 1]].end : 0;
            var ceil = r < runs.length - 1 ? out[runs[r + 1][0]].start : Infinity;

            var s1 = s0, e1 = e0;
            // El arranque no se busca más de `grace` antes de donde el transcript pone
            // la palabra (por ahí solo hay ruido de sala), pero hacia adelante puede
            // pasar del final nominal de la palabra: cuando el STT se adelanta más de
            // lo que la palabra dura, ahí es donde está el sonido. Y si en el sitio del
            // transcript no habla nadie —nivel por debajo del habla de la clase— se le
            // deja buscar bastante más lejos: no hay ningún ataque audible que se pueda
            // comer por buscarlo. Si ahí SÍ suena algo, el borde es ese.
            var inOpts = withBounds(opts, Math.max(floor, s0 - grace), ceil);
            if (speech != null) {
                var lvl = loudest(wav, s0, grace, opts);
                if (lvl != null && lvl < speech) inOpts.maxShiftSec = opt(opts, "alignWideShiftSec");
            }
            var on = edgeAt(wav, s0, "IN", inOpts);
            if (on && on.time > floor && Math.abs(on.time - s0) >= frame) s1 = on.time;

            // El final, igual pero al revés: si en el último tramo de la palabra ya no
            // suena nadie, el STT estiró la palabra sobre el silencio y hay que buscar
            // el final más atrás. La última palabra de una toma es donde más pasa —la
            // voz se apaga y el STT la alarga— y es justo la que decide dónde cierra el
            // bloque (clase 15, bloque 3: "conecte." acababa 0.7s después del sonido, y
            // el corte quedaba a mitad de palabra según el transcript).
            var outOpts = withBounds(opts, e0 - grace,
                Math.min(e0 + grace, isFinite(ceil) ? ceil + grace : Infinity));
            if (speech != null) {
                var tail = loudest(wav, Math.max(s0, e0 - grace), Math.min(grace, e0 - s0), opts);
                if (tail != null && tail < speech) {
                    var wide = opt(opts, "alignWideShiftSec");
                    outOpts.edgeMinTime = Math.max(s0, e0 - wide);
                    outOpts.maxShiftSec = wide;
                }
            }
            var off = edgeAt(wav, e0, "OUT", outOpts);
            if (off && off.time < ceil && Math.abs(off.time - e0) >= frame) e1 = off.time;

            if (s1 === s0 && e1 === e0) continue;
            if (!(e1 - s1 >= minDur * run.length)) continue;   // no cabe: mejor no tocar

            if (s1 !== s0) {
                st.movedStarts++;
                shifts.push(s1 - s0);
                if (Math.abs(s1 - s0) > Math.abs(st.maxStartShift)) st.maxStartShift = round(s1 - s0);
            }
            if (e1 !== e0) st.movedEnds++;
            applyRun(out, run, s0, e0, s1, e1, minDur);
        }

        if (shifts.length) {
            shifts.sort(function(a, b) { return a - b; });
            st.medianStartShift = round(shifts[Math.floor(shifts.length / 2)]);
        }
        return { words: out, stats: st };
    }

    /** Palabras seguidas sin un silencio de `minGap` en medio, por índices. */
    function wordRuns(words, minGap) {
        var idx = spokenIdx(words), runs = [], cur = [];
        for (var s = 0; s < idx.length; s++) {
            if (cur.length && words[idx[s]].start - words[idx[s - 1]].end >= minGap) {
                runs.push(cur);
                cur = [];
            }
            cur.push(idx[s]);
        }
        if (cur.length) runs.push(cur);
        return runs;
    }

    /**
     * Lleva el tramo a lo medido. El error del STT vive en la palabra del borde —la
     * primera, que empieza antes de que se oiga nada, y la última, que se estira sobre
     * el silencio—, así que lo normal es que la absorba ella sola y las de en medio ni
     * se enteren: repartir la corrección por todo el tramo movía palabras interiores
     * medio segundo que ya estaban donde tenían que estar. Solo si la palabra del borde
     * se quedaría sin duración se reparte entre todas.
     */
    function applyRun(words, run, s0, e0, s1, e1, minDur) {
        var first = words[run[0]], last = words[run[run.length - 1]];
        var fits = run.length === 1
            ? (e1 - s1 >= minDur)
            : (s1 <= first.end - minDur && e1 >= last.start + minDur);
        if (fits) {
            first.start = round(s1);
            last.end = round(e1);
            return;
        }
        rescaleRun(words, run, s0, e0, s1, e1);
    }

    /** Reparte las palabras de un tramo en el hueco medido, guardando proporciones. */
    function rescaleRun(words, run, s0, e0, s1, e1) {
        var scale = (e1 - s1) / (e0 - s0);
        for (var i = 0; i < run.length; i++) {
            var w = words[run[i]];
            w.start = round(s1 + (w.start - s0) * scale);
            w.end = round(s1 + (w.end - s0) * scale);
        }
        // Los extremos, exactos: el reparto es para lo de dentro.
        words[run[0]].start = round(s1);
        words[run[run.length - 1]].end = round(e1);
    }

    /** Copia de las opciones con los límites de búsqueda del borde puestos. */
    function withBounds(opts, lo, hi) {
        var o = {};
        if (opts) for (var k in opts) if (opts.hasOwnProperty(k)) o[k] = opts[k];
        if (lo != null) o.edgeMinTime = lo;
        if (hi != null) o.edgeMaxTime = hi;
        return o;
    }

    /** Índices de las palabras habladas (sin marcas de espaciado del STT). */
    function spokenIdx(words) {
        var idx = [];
        for (var i = 0; i < words.length; i++) {
            if (!words[i].type || words[i].type === "word") idx.push(i);
        }
        return idx;
    }

    /**
     * Palabras que el STT oyó donde no suena nada. Whisper alucina frases sueltas en
     * los silencios ("Gracias." en el segundo 0 y en el 30 de una clase real): no
     * estorban al cortar, pero ensucian el texto y las búsquedas de frases del CD.
     *
     * El umbral tiene que ser el de la CLASE, no el de la ventana: en un silencio de
     * medio minuto no hay contraste, el umbral local se pega al ruido de sala y
     * cualquier crujido pasa por voz — o al contrario, un "Va." dicho al editor no
     * llega al umbral de su propia ventana y se descarta una palabra real (pasó con
     * "Voy.", "Va." y "Ok." en la clase 14). Y se mira **toda la ventana de la
     * palabra con margen**, no su punto medio, porque el sonido llega más tarde de lo
     * que el transcript dice: en el punto medio de una palabra real muchas veces
     * todavía hay silencio.
     *
     * @returns {{words, dropped}} dropped = [{text, start}]
     */
    function dropSilentWords(wav, words, opts) {
        var dropped = [];
        if (!wav || !wav.info) return { words: words || [], dropped: dropped };
        var isolation = opt(opts, "alignIsolationSec");
        var idx = spokenIdx(words);
        var candidates = [];

        for (var s = 0; s < idx.length; s++) {
            var w = words[idx[s]];
            var prev = s > 0 ? words[idx[s - 1]] : null;
            var next = s < idx.length - 1 ? words[idx[s + 1]] : null;
            if (prev && w.start - prev.end < isolation) continue;
            if (next && next.start - w.end < isolation) continue;
            candidates.push(idx[s]);
        }
        if (candidates.length === 0) return { words: words, dropped: dropped };

        var speech = classThreshold(wav, words, opts);
        if (speech == null) return { words: words, dropped: dropped };

        var kill = {};
        for (var c = 0; c < candidates.length; c++) {
            var word = words[candidates[c]];
            var grace = opt(opts, "alignGraceSec");
            var lvl = loudest(wav, word.start - grace,
                (word.end - word.start) + 2 * grace + 0.6, opts);
            if (lvl != null && lvl < speech) {
                kill[candidates[c]] = true;
                dropped.push({ text: word.text || word.word || "", start: word.start });
            }
        }

        if (dropped.length === 0) return { words: words, dropped: dropped };
        var out = [];
        for (var k = 0; k < words.length; k++) if (!kill[k]) out.push(words[k]);
        return { words: out, dropped: dropped };
    }

    /**
     * Nivel a partir del cual, en esta clase, hay voz. Se muestrea el medio de unas
     * cuantas palabras largas repartidas por la clase (habla segura) y se toma una
     * fracción de la mediana: por debajo de eso no hay nadie hablando.
     */
    /** El nivel más alto que suena en una ventana (null si no se puede leer). */
    function loudest(wav, from, span, opts) {
        var p = probe(wav, from, span, opts);
        if (!p) return null;
        var max = 0;
        for (var i = 0; i < p.env.length; i++) if (p.env[i] > max) max = p.env[i];
        return max;
    }

    function classThreshold(wav, words, opts) {
        var idx = spokenIdx(words), levels = [];
        var solid = [];
        for (var i = 0; i < idx.length; i++) {
            var w = words[idx[i]];
            if ((w.end - w.start) >= 0.25) solid.push(w);
        }
        if (solid.length < 10) return null;

        var step = Math.max(1, Math.floor(solid.length / 24));
        for (var s = 0; s < solid.length; s += step) {
            var w2 = solid[s];
            var lvl = loudest(wav, w2.start, (w2.end - w2.start) + 0.4, opts);
            if (lvl) levels.push(lvl);
        }
        if (levels.length < 6) return null;
        levels.sort(function(a, b) { return a - b; });
        var median = levels[Math.floor(levels.length / 2)];
        return median * opt(opts, "alignSilentRatio");
    }

    /**
     * ¿Suena algo justo en el corte? Es lo único que se puede contestar cuando no hay
     * un borde limpio que medir (la frase y el cue del profesor van pegados, o la
     * sala tiene demasiado ruido de fondo): no dice a dónde mover el marcador, pero
     * sí si está encima del sonido. Sirve para dejarlo dicho en el log en vez de que
     * el borde pase en silencio.
     * @returns {{level, threshold, onSound}|null}
     */
    function levelAt(wav, time, opts) {
        var search = opt(opts, "searchSec");
        var from = time - search - 0.3;
        var probeData = probe(wav, from, 2 * search + 0.6, opts);
        if (!probeData) return null;
        var st = stats(probeData.env, opts);
        if (!st) return null;
        var i = Math.round((time - probeData.windowStart) / probeData.hopSec);
        if (i < 0 || i >= probeData.env.length) return null;
        return {
            level: probeData.env[i],
            threshold: st.threshold,
            onSound: probeData.env[i] >= st.threshold
        };
    }

    /**
     * WAV de una secuencia en la carpeta de transcripción. Los nombres llevan la
     * hora del export (`<base>_26-07-24_19-26-27.wav`), así que se toma el más
     * reciente cuya duración cuadre con la secuencia: sin ese filtro se colaría el
     * WAV de la secuencia ya cortada, que es la misma trampa que con el transcript.
     * @returns {{file, info}|null}
     */
    function findWav(folder, base, expectedSec) {
        if (!fs || !folder || !base) return null;
        var names;
        try { names = fs.readdirSync(folder); } catch (e) { return null; }

        var best = null, bestTime = -1;
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            if (name.indexOf(base) !== 0) continue;
            if (!/\.wav$/i.test(name)) continue;
            var file = pathMod ? pathMod.join(folder, name) : (folder + "/" + name);
            var info = wavInfo(file);
            if (!info) continue;
            if (expectedSec > 0) {
                var slack = Math.max(2, expectedSec * 0.01);
                if (Math.abs(info.durationSec - expectedSec) > slack) continue;
            }
            var mtime = 0;
            try { mtime = fs.statSync(file).mtimeMs || 0; } catch (e2) {}
            if (mtime > bestTime) { best = { file: file, info: info }; bestTime = mtime; }
        }
        return best;
    }

    var EPAudioOnset = {
        DEFAULTS: DEFAULTS,
        CODE_LABELS: CODE_LABELS,
        available: available,
        envelope: envelope,
        stats: stats,
        voiceRuns: voiceRuns,
        refine: refine,
        evaluate: evaluate,
        insideVoice: insideVoice,
        voiceAt: voiceAt,
        wavInfo: wavInfo,
        probe: probe,
        measure: measure,
        edgeAt: edgeAt,
        alignWords: alignWords,
        dropSilentWords: dropSilentWords,
        levelAt: levelAt,
        findWav: findWav
    };

    if (typeof module !== "undefined" && module.exports) module.exports = EPAudioOnset;
    if (global) global.EPAudioOnset = EPAudioOnset;
})(typeof window !== "undefined" ? window : (typeof global !== "undefined" ? global : this));
