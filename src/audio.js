// Audio runtime for ml-regl. Ported from elm-audio's audio.js
// (https://github.com/MartinSStewart/elm-audio).
//
// Public surface (called from app.js / OCaml):
//   AudioRuntime.execAudioCmd({ actions: [...], loads: [...] })
//
// Each action is one of:
//   { action: "startSound", nodeGroupId, bufferId, startTime, startAt,
//     volume, volumeTimelines, loop, playbackRate }
//   { action: "stopSound", nodeGroupId }
//   { action: "setVolume", nodeGroupId, volume }
//   { action: "setVolumeAt", nodeGroupId, volumeAt }
//   { action: "setLoopConfig", nodeGroupId, loop }
//   { action: "setPlaybackRate", nodeGroupId, playbackRate }
//
// Each load is { requestId, audioUrl }.
//
// Results are reported back through MlApp.recvAudioMsg(...) with shapes:
//   { _c: "audioContextReady", sampleRate }
//   { _c: "audioLoadSuccess", requestId, bufferId, duration }
//   { _c: "audioLoadFailed",  requestId, error }
//
// Times are absolute milliseconds (matching the OCaml Tick/`Date.now()`
// scale). Loop start/end and start_at are durations in milliseconds.

function makeAudioRuntime(MlApp) {
    const AudioCtor =
        window.AudioContext || window.webkitAudioContext || null;
    if (!AudioCtor) {
        console.warn("Web Audio API not supported");
        return {
            execAudioCmd: () => {},
            resume: () => {},
        };
    }

    let context = null;
    /** @type {AudioBuffer[]} */
    const audioBuffers = [];
    /** @type {{ [k: number]: { bufferId: number; nodes: { sourceNode: AudioBufferSourceNode; gainNode: GainNode; volumeAtGainNodes: GainNode[] } } }} */
    const audioPlaying = {};

    function ensureContext() {
        if (context) return context;
        context = new AudioCtor();
        MlApp.recvAudioMsg({
            _c: "audioContextReady",
            sampleRate: context.sampleRate,
        });
        return context;
    }

    function posixToContextTime(posix, now) {
        return (posix - now) / 1000 + context.currentTime;
    }

    function setLoop(sourceNode, loop) {
        if (loop) {
            sourceNode.loopStart = loop.loopStart / 1000;
            sourceNode.loopEnd = loop.loopEnd / 1000;
            sourceNode.loop = true;
        } else {
            sourceNode.loop = false;
        }
    }

    function interpolate(startAt, startValue, endAt, endValue, time) {
        const t = (time - startAt) / (endAt - startAt);
        return Number.isFinite(t)
            ? t * (endValue - startValue) + startValue
            : startValue;
    }

    function createVolumeTimelineGainNodes(volumeAt, now) {
        return volumeAt.map((timeline) => {
            const gainNode = context.createGain();
            gainNode.gain.setValueAtTime(timeline[0].volume, 0);
            gainNode.gain.linearRampToValueAtTime(timeline[0].volume, 0);
            const ctxNow = posixToContextTime(now, now);

            for (let j = 1; j < timeline.length; j++) {
                const prev = timeline[j - 1];
                const prevTime = posixToContextTime(prev.time, now);
                const next = timeline[j];
                const nextTime = posixToContextTime(next.time, now);

                if (nextTime > ctxNow && ctxNow >= prevTime) {
                    const cur = interpolate(
                        prevTime,
                        prev.volume,
                        nextTime,
                        next.volume,
                        ctxNow
                    );
                    gainNode.gain.setValueAtTime(cur, 0);
                    gainNode.gain.linearRampToValueAtTime(next.volume, nextTime);
                } else if (nextTime > ctxNow) {
                    gainNode.gain.linearRampToValueAtTime(next.volume, nextTime);
                } else {
                    gainNode.gain.setValueAtTime(next.volume, 0);
                }
            }
            return gainNode;
        });
    }

    function connectChain(nodes) {
        for (let j = 1; j < nodes.length; j++) {
            nodes[j - 1].connect(nodes[j]);
        }
    }

    function playSound(
        buffer,
        volume,
        volumeTimelines,
        startTime,
        startAt,
        now,
        loop,
        playbackRate
    ) {
        const source = context.createBufferSource();
        if (loop) {
            const extraSeconds =
                10 + loop.loopEnd / 1000 - buffer.length / buffer.sampleRate;
            if (extraSeconds > 0) {
                const sampleCount =
                    buffer.getChannelData(0).length +
                    Math.ceil(extraSeconds * buffer.sampleRate);
                const newBuffer = context.createBuffer(
                    buffer.numberOfChannels,
                    sampleCount,
                    context.sampleRate
                );
                for (let i = 0; i < buffer.numberOfChannels; i++) {
                    newBuffer.copyToChannel(buffer.getChannelData(i), i);
                }
                source.buffer = newBuffer;
            } else {
                source.buffer = buffer;
            }
        } else {
            source.buffer = buffer;
        }

        source.playbackRate.value = playbackRate;
        setLoop(source, loop);

        const timelineGainNodes = createVolumeTimelineGainNodes(
            volumeTimelines,
            now
        );
        const gainNode = context.createGain();
        gainNode.gain.setValueAtTime(volume, 0);

        connectChain([source, gainNode, ...timelineGainNodes, context.destination]);

        if (startTime >= now) {
            source.start(posixToContextTime(startTime, now), startAt / 1000);
        } else {
            const offset = (now - startTime) / 1000;
            source.start(0, offset + startAt / 1000);
        }
        return {
            sourceNode: source,
            gainNode,
            volumeAtGainNodes: timelineGainNodes,
        };
    }

    async function loadAudio(req) {
        ensureContext();
        let buf;
        try {
            const resp = await fetch(req.audioUrl);
            buf = await resp.arrayBuffer();
        } catch (_e) {
            MlApp.recvAudioMsg({
                _c: "audioLoadFailed",
                requestId: req.requestId,
                error: "NetworkError",
            });
            return;
        }
        try {
            const decoded = await context.decodeAudioData(buf);
            const bufferId = audioBuffers.length;
            audioBuffers.push(decoded);
            MlApp.recvAudioMsg({
                _c: "audioLoadSuccess",
                requestId: req.requestId,
                bufferId,
                duration: decoded.length / decoded.sampleRate,
            });
        } catch (e) {
            MlApp.recvAudioMsg({
                _c: "audioLoadFailed",
                requestId: req.requestId,
                error: "FailedToDecode",
            });
        }
    }

    function applyAction(a, now) {
        switch (a.action) {
            case "stopSound": {
                const v = audioPlaying[a.nodeGroupId];
                if (!v) return;
                delete audioPlaying[a.nodeGroupId];
                v.nodes.sourceNode.stop();
                v.nodes.sourceNode.disconnect();
                v.nodes.gainNode.disconnect();
                v.nodes.volumeAtGainNodes.forEach((n) => n.disconnect());
                return;
            }
            case "setVolume": {
                const v = audioPlaying[a.nodeGroupId];
                if (!v) return;
                v.nodes.gainNode.gain.setValueAtTime(a.volume, 0);
                return;
            }
            case "setVolumeAt": {
                const v = audioPlaying[a.nodeGroupId];
                if (!v) return;
                v.nodes.volumeAtGainNodes.forEach((n) => n.disconnect());
                v.nodes.gainNode.disconnect();
                const newGains = createVolumeTimelineGainNodes(a.volumeAt, now);
                connectChain([
                    v.nodes.gainNode,
                    ...newGains,
                    context.destination,
                ]);
                v.nodes.volumeAtGainNodes = newGains;
                return;
            }
            case "setLoopConfig": {
                const v = audioPlaying[a.nodeGroupId];
                if (!v) return;
                setLoop(v.nodes.sourceNode, a.loop);
                return;
            }
            case "setPlaybackRate": {
                const v = audioPlaying[a.nodeGroupId];
                if (!v) return;
                v.nodes.sourceNode.playbackRate.setValueAtTime(
                    a.playbackRate,
                    0
                );
                return;
            }
            case "startSound": {
                const buf = audioBuffers[a.bufferId];
                if (!buf) return;
                const nodes = playSound(
                    buf,
                    a.volume,
                    a.volumeTimelines,
                    a.startTime,
                    a.startAt,
                    now,
                    a.loop,
                    a.playbackRate
                );
                audioPlaying[a.nodeGroupId] = {
                    bufferId: a.bufferId,
                    nodes,
                };
                return;
            }
            default:
                console.warn("Unknown audio action:", a.action);
        }
    }

    function execAudioCmd(payload) {
        ensureContext();
        // Browsers block audio until a user gesture; cheaply attempt to
        // resume on every call. No-op if the context is already running.
        if (context && context.state === "suspended") {
            context.resume();
        }
        const now = Date.now();
        const actions = payload.actions || [];
        const loads = payload.loads || [];
        for (let i = 0; i < actions.length; i++) {
            applyAction(actions[i], now);
        }
        for (let i = 0; i < loads.length; i++) {
            loadAudio(loads[i]);
        }
    }

    function resume() {
        if (context && context.state === "suspended") {
            context.resume();
        }
    }

    return { execAudioCmd, resume };
}

module.exports = makeAudioRuntime;
