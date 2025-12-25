/*
 * Copyright (c) 2025 Yiming Xiang
 * Copyright (c) 2020 Martin Stewart
 *
 * This file is derived from the elm-audio project:
 * https://github.com/MartinSStewart/elm-audio
 *
 * Licensed under the MIT License.
 * See NOTICES for details.
 */

/** @type {AudioBuffer[]} */

let audioBuffers = [];
let context = null;

/** @type {{ [key: number]: { bufferId: any; nodes: {sourceNode: AudioBufferSourceNode; gainNode: GainNode; volumeAtGainNodes: GainNode[] } } }} */
let audioPlaying = {};


/**
 * @param {{ audioUrl: string; requestId: number }} audio
 */
async function loadAudio(audioUrl, requestId) {
    let responseBuffer;
    try {
        const response = await fetch(audioUrl);
        responseBuffer = await response.arrayBuffer();
    } catch {
        app.updateaudio({
            type: 0,
            requestId: requestId,
            error: "NetworkError",
        });
        return;
    }

    try {
        const buffer = await context.decodeAudioData(responseBuffer);

        let bufferId = audioBuffers.length;
        audioBuffers.push(buffer);

        app.updateaudio({
            type: 1,
            requestId: requestId,
            bufferId: bufferId,
            durationInSeconds: buffer.length / buffer.sampleRate,
        });
    } catch (error) {
        app.updateaudio({
            type: 0,
            requestId: requestId,
            error: error.message,
        });
    }
}


/**
 * @param {{ ports: { audioPortFromJS: { send: (arg: { type: number; samplesPerSecond?: number; requestId?: number; error?: any; bufferId?: number; durationInSeconds?: number; }) => void; }; audioPortToJS: { subscribe: (arg: (message: any) => void) => void; }; }; }} app
 */
function init(app) {
    window.AudioContext =
        window.AudioContext || window.webkitAudioContext || false;
    if (window.AudioContext) {
        context = new AudioContext()
        app.updateaudio({
            type: 2,
            samplesPerSecond: context.sampleRate,
        });
    } else {
        console.error("Web audio is not supported in your browser.");
    }
}


/**
 * @param {number} posix
 * @param {number} currentTimePosix
 */
function posixToContextTime(posix, currentTimePosix) {
    return (posix - currentTimePosix) / 1000 + context.currentTime;
}

/**
 * @param {AudioBufferSourceNode} sourceNode
 * @param {{ loopStart: number; loopEnd: number; } | null} loop
 */
function setLoop(sourceNode, loopStart, loopEnd) {
    if (loopStart != null && loopEnd != null) {
        sourceNode.loopStart = loopStart / 1000;
        sourceNode.loopEnd = loopEnd / 1000;
        sourceNode.loop = true;
    } else {
        sourceNode.loop = false;
    }
}

/**
 * @param {number} startAt
 * @param {number} startValue
 * @param {number} endAt
 * @param {number} endValue
 * @param {number} time
 */
function interpolate(startAt, startValue, endAt, endValue, time) {
    let t = (time - startAt) / (endAt - startAt);
    if (Number.isFinite(t)) {
        return t * (endValue - startValue) + startValue;
    } else {
        return startValue;
    }
}

/**
 * @param {{ volume: number; time: number; }[][]} volumeAt
 * @param {number} currentTime
 */
function createVolumeTimelineGainNodes(volumeAt, currentTime) {
    return volumeAt.map((volumeTimeline) => {
        let gainNode = context.createGain();

        gainNode.gain.setValueAtTime(volumeTimeline[0].volume, 0);
        gainNode.gain.linearRampToValueAtTime(
            volumeTimeline[0].volume,
            0
        );
        let currentTime_ = posixToContextTime(currentTime, currentTime);

        for (let j = 1; j < volumeTimeline.length; j++) {
            let previous = volumeTimeline[j - 1];
            let previousTime = posixToContextTime(
                previous.time,
                currentTime
            );
            let next = volumeTimeline[j];
            let nextTime = posixToContextTime(next.time, currentTime);

            if (
                nextTime > currentTime_ &&
                currentTime_ >= previousTime
            ) {
                let currentVolume = interpolate(
                    previousTime,
                    previous.volume,
                    nextTime,
                    next.volume,
                    currentTime_
                );
                gainNode.gain.setValueAtTime(currentVolume, 0);
                gainNode.gain.linearRampToValueAtTime(
                    next.volume,
                    nextTime
                );
            } else if (nextTime > currentTime_) {
                gainNode.gain.linearRampToValueAtTime(
                    next.volume,
                    nextTime
                );
            } else {
                gainNode.gain.setValueAtTime(next.volume, 0);
            }
        }

        return gainNode;
    });
}

/**
 * @param {AudioNode[]} nodes
 */
function connectNodes(nodes) {
    for (let j = 1; j < nodes.length; j++) {
        nodes[j - 1].connect(nodes[j]);
    }
}

/**
 * @param {AudioBuffer} buffer
 * @param {number} volume
 * @param {{ volume: number; time: number; }[][]} volumeTimelines
 * @param {number} startTime
 * @param {number} startAt
 * @param {number} currentTime
 * @param {{ loopEnd: number; loopStart: number; } | null} loop
 * @param {number} playbackRate
 * @returns {{ sourceNode: AudioBufferSourceNode; gainNode: GainNode; volumeAtGainNodes: GainNode[] }}
 */
function playSound(
    buffer,
    volume,
    volumeTimelines,
    startTime,
    startAt,
    currentTime,
    loopStart,
    loopEnd,
    playbackRate
) {
    let source = context.createBufferSource();

    if (loopStart != null && loopEnd != null) {
        // Add an extra 10 seconds so there's some room if the loopEnd gets moved back later
        let durationInSeconds =
            10 +
            loopEnd / 1000 -
            buffer.length / buffer.sampleRate;
        if (durationInSeconds > 0) {
            let sampleCount =
                buffer.getChannelData(0).length +
                Math.ceil(durationInSeconds * buffer.sampleRate);
            let newBuffer = context.createBuffer(
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
    setLoop(source, loopStart, loopEnd);

    let timelineGainNodes = createVolumeTimelineGainNodes(
        volumeTimelines,
        currentTime
    );

    let gainNode = context.createGain();
    gainNode.gain.setValueAtTime(volume, 0);

    connectNodes([
        source,
        gainNode,
        ...timelineGainNodes,
        context.destination,
    ]);

    if (startTime >= currentTime) {
        source.start(
            posixToContextTime(startTime, currentTime),
            startAt / 1000
        );
    } else {
        // TODO: offset should account for looping
        let offset = (currentTime - startTime) / 1000;
        source.start(0, offset + startAt / 1000);
    }

    return {
        sourceNode: source,
        gainNode: gainNode,
        volumeAtGainNodes: timelineGainNodes,
    };
}

async function execCmd(message) {
    let currentTime = new Date().getTime();
    for (let i = 0; i < message.audio.length; i++) {
        let audio = message.audio[i];
        switch (audio.action) {
            case "stopSound": {
                let value = audioPlaying[audio.nodeGroupId];
                delete audioPlaying[audio.nodeGroupId];
                value.nodes.sourceNode.stop();
                value.nodes.sourceNode.disconnect();
                value.nodes.gainNode.disconnect();
                value.nodes.volumeAtGainNodes.map((node) =>
                    node.disconnect()
                );
                break;
            }
            case "setVolume": {
                let value = audioPlaying[audio.nodeGroupId];
                value.nodes.gainNode.gain.setValueAtTime(
                    audio.volume,
                    0
                );
                break;
            }
            case "setVolumeAt": {
                let value = audioPlaying[audio.nodeGroupId];
                value.nodes.volumeAtGainNodes.map((node) =>
                    node.disconnect()
                );
                value.nodes.gainNode.disconnect();

                let newGainNodes = createVolumeTimelineGainNodes(
                    audio.volumeAt,
                    currentTime
                );

                connectNodes([
                    value.nodes.gainNode,
                    ...newGainNodes,
                    context.destination,
                ]);

                value.nodes.volumeAtGainNodes = newGainNodes;
                break;
            }
            case "setLoopConfig": {
                let value = audioPlaying[audio.nodeGroupId];

                /* TODO: Resizing the buffer if the loopEnd value is past the end of the buffer.
                This might not be possible to do so the alternative is to create a new audio
                node (this will probably cause a popping sound and audio that is slightly out of sync).
                */

                setLoop(value.nodes.sourceNode, audio.loopStart, audio.loopEnd);
                break;
            }
            case "setPlaybackRate": {
                let value = audioPlaying[audio.nodeGroupId];
                value.nodes.sourceNode.playbackRate.setValueAtTime(
                    audio.playbackRate,
                    0
                );
                break;
            }
            case "startSound": {
                let nodes = playSound(
                    audioBuffers[audio.bufferId],
                    audio.volume,
                    audio.volumeTimelines,
                    audio.startTime,
                    audio.startAt,
                    currentTime,
                    audio.loopStart,
                    audio.loopEnd,
                    audio.playbackRate
                );
                audioPlaying[audio.nodeGroupId] = {
                    bufferId: audio.bufferId,
                    nodes: nodes,
                };
                break;
            }
        }
    }

    // Load all audio commands
    const loads = message.audio.map((audio) =>
        loadAudio(audio.audioUrl, audio.requestId)
    );
    await Promise.all(loads);
}

globalThis.MlDeclAudio = {
    init,
    execCmd
}
