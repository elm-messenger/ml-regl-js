let regl = null;
const readFileSync = require('fs').readFileSync;
const TM = require('./text.js');
const makeAudioRuntime = require('./audio.js');
const pb = require('./generated/mlregl_pb.js');

const BackendCommandBatchPb =
    pb.mlregl.transport.backend.BackendCommandBatch;
const BackendEventPb = pb.mlregl.transport.backend.BackendEvent;
const RenderablePb = pb.mlregl.transport.render.Renderable;
const EventPb = pb.mlregl.transport.backend.Event;

const loadedPrograms = {};

const loadedTextures = {};
const textureLoadTokens = {};
const fontLoadTokens = {};

// Browser-key -> SDL_GetKeyName mapping. The desktop bridge calls
// SDL_GetKeyName(ev.key.key) when encoding KeyboardEvent.code, so the OCaml
// app sees the SDL naming on desktop. To keep the JS backend identical, we
// translate the browser KeyboardEvent.code (layout-independent, e.g. "KeyA",
// "ArrowLeft", "ShiftLeft") into the same SDL names here. Anything missing
// falls through as the raw e.code with a console.warn — that surfaces gaps
// during development rather than silently disagreeing with the desktop host.
const DOM_CODE_TO_SDL_KEY_NAME = (() => {
    const m = {
        // Letters: "KeyA" -> "A" .. "KeyZ" -> "Z"
        // Digits:  "Digit0" -> "0" .. "Digit9" -> "9"
        // (filled in below in a loop)
        Space: 'Space',
        Enter: 'Return',
        NumpadEnter: 'Return',
        Escape: 'Escape',
        Tab: 'Tab',
        Backspace: 'Backspace',
        Delete: 'Delete',
        Insert: 'Insert',
        Home: 'Home',
        End: 'End',
        PageUp: 'PageUp',
        PageDown: 'PageDown',
        ArrowUp: 'Up',
        ArrowDown: 'Down',
        ArrowLeft: 'Left',
        ArrowRight: 'Right',
        ShiftLeft: 'Left Shift',
        ShiftRight: 'Right Shift',
        ControlLeft: 'Left Ctrl',
        ControlRight: 'Right Ctrl',
        AltLeft: 'Left Alt',
        AltRight: 'Right Alt',
        MetaLeft: 'Left GUI',
        MetaRight: 'Right GUI',
        CapsLock: 'CapsLock',
        Minus: '-',
        Equal: '=',
        BracketLeft: '[',
        BracketRight: ']',
        Backslash: '\\',
        Semicolon: ';',
        Quote: "'",
        Backquote: '`',
        Comma: ',',
        Period: '.',
        Slash: '/',
    };
    for (let i = 0; i < 26; i++) {
        m['Key' + String.fromCharCode(65 + i)] = String.fromCharCode(65 + i);
    }
    for (let i = 0; i < 10; i++) {
        m['Digit' + i] = String(i);
    }
    for (let i = 1; i <= 12; i++) {
        m['F' + i] = 'F' + i;
    }
    return m;
})();

const _warnedUnknownKeyCodes = {};
function domCodeToSdlKeyName(domCode) {
    const name = DOM_CODE_TO_SDL_KEY_NAME[domCode];
    if (name !== undefined) return name;
    if (!_warnedUnknownKeyCodes[domCode]) {
        _warnedUnknownKeyCodes[domCode] = true;
        console.warn(
            "ml-regl: no SDL keycode mapping for browser code '" + domCode +
            "'; passing through as-is. Add to DOM_CODE_TO_SDL_KEY_NAME if needed.");
    }
    return domCode;
}

// Browser MouseEvent.button uses 0=left/1=middle/2=right/3=back/4=forward,
// while SDL uses 1=left/2=middle/3=right/4=x1/5=x2 (SDL_BUTTON_*). The
// desktop bridge ships ev.button.button straight through, so OCaml apps see
// the SDL convention. Match it on the JS side by adding 1.
function domButtonToSdlButton(b) { return b + 1; }

let TextManager = null;

let MlApp = null;

let AudioRuntime = null;

let global_error = 0;

// X, Y, Scale, Rotation
let camera = [0.0, 0.0, 1.0, 0.0];

let userConfig = {
    interval: 0,
    virtWidth: 1920,
    virtHeight: 1080,
    fboNum: 10
};

let fbos = [];

let palettes = [];

let freePalette = [];

let drawPalette = null;

let loopStartTimeMs = null;
let loopStopRequested = false;
let pendingAnimationFrameId = null;
let pendingTimeoutId = null;

function monotonicNowMs() {
    if (window.performance && window.performance.now) {
        return window.performance.now();
    }
    return Date.now();
}

function loopElapsedMs() {
    if (loopStartTimeMs == null) {
        return 0;
    }
    return monotonicNowMs() - loopStartTimeMs;
}

function scheduleNextStep() {
    if (loopStopRequested) {
        return;
    }
    if (userConfig.interval > 0) {
        pendingTimeoutId = setTimeout(() => {
            pendingTimeoutId = null;
            step();
        }, userConfig.interval);
    } else {
        pendingAnimationFrameId = requestAnimationFrame(() => {
            pendingAnimationFrameId = null;
            step();
        });
    }
}

function requestQuit() {
    loopStopRequested = true;
    if (pendingAnimationFrameId != null) {
        cancelAnimationFrame(pendingAnimationFrameId);
        pendingAnimationFrameId = null;
    }
    if (pendingTimeoutId != null) {
        clearTimeout(pendingTimeoutId);
        pendingTimeoutId = null;
    }
    if (AudioRuntime && AudioRuntime.shutdown) {
        AudioRuntime.shutdown();
    }
}

const frags = {
    "palette": readFileSync('src/palette/frag.glsl', 'utf8'),
    "triangle": readFileSync('src/triangle/frag.glsl', 'utf8'),
    "rect": readFileSync('src/rect/frag.glsl', 'utf8'),
    "texture": readFileSync('src/texture/frag.glsl', 'utf8'),
    "texture-centered": readFileSync('src/texture-centered/frag.glsl', 'utf8'),
    "texture-cropped-centered": readFileSync('src/texture-cropped-centered/frag.glsl', 'utf8'),
    "text": readFileSync('src/text/frag.glsl', 'utf8'),
    "compositor": readFileSync('src/compositors/frag.glsl', 'utf8'),
    "compFade": readFileSync('src/compFade/frag.glsl', 'utf8'),
    "imgFade": readFileSync('src/imgFade/frag.glsl', 'utf8'),
    "blur1": readFileSync('src/blur/frag1.glsl', 'utf8'),
    "blur2": readFileSync('src/blur/frag2.glsl', 'utf8'),
    "gblur": readFileSync('src/gblur/frag.glsl', 'utf8'),
    "crt": readFileSync('src/crt/frag.glsl', 'utf8'),
    "fxaa": readFileSync('src/fxaa/frag.glsl', 'utf8'),
    "outline": readFileSync('src/outline/frag.glsl', 'utf8'),
    "alphamult": readFileSync('src/alphamult/frag.glsl', 'utf8'),
    "colormult": readFileSync('src/colormult/frag.glsl', 'utf8'),
    "pixilation": readFileSync('src/pixilation/frag.glsl', 'utf8'),
    "circle": readFileSync('src/circle/frag.glsl', 'utf8'),
    "rounded-rect": readFileSync('src/rounded-rect/frag.glsl', 'utf8')
}

const verts = {
    "triangle": readFileSync('src/triangle/vert.glsl', 'utf8'),
    "rect": readFileSync('src/rect/vert.glsl', 'utf8'),
    "texture": readFileSync('src/texture/vert.glsl', 'utf8'),
    "texture-centered": readFileSync('src/texture-centered/vert.glsl', 'utf8'),
    "texture-cropped-centered": readFileSync('src/texture-cropped-centered/vert.glsl', 'utf8'),
    "text": readFileSync('src/text/vert.glsl', 'utf8'),
    "fxaa": readFileSync('src/fxaa/vert.glsl', 'utf8'),
    "effect": readFileSync('src/effect/vert.glsl', 'utf8'),
    "circle": readFileSync('src/circle/vert.glsl', 'utf8'), // To world pos
}

function stopError(e) {
    global_error = 1;
    console.error(e);
    document.body.textContent = "Error: " + e.message + "\n\n" +
        "Please check the console for more details.";
}

const quad = () => [
    (x) => x
    , regl({
        frag: frags["triangle"],
        vert: verts["triangle"],
        attributes: {
            position: regl.prop('pos')
        },
        uniforms: {
            color: regl.prop('color')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })]

const rect = () => [
    (x) => x
    , regl({
        frag: frags["rect"],
        vert: verts["rect"],
        attributes: {
            position: [
                0, 1,
                1, 1,
                1, 0,
                0, 0,
            ]
        },
        uniforms: {
            posize: regl.prop('posize'),
            angle: regl.prop('angle'),
            color: regl.prop('color')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })]

const triangle = () => [
    (x) => x,
    regl({
        frag: frags["triangle"],
        vert: verts["triangle"],
        attributes: {
            position: regl.prop('pos')
        },
        uniforms: {
            color: regl.prop('color')
        },
        count: 3
    })]


const poly = () => [
    (x) => {
        if (!("prim" in x)) {
            x["prim"] = "triangles";
        }
        return x;
    },
    regl({
        frag: frags["triangle"],
        vert: verts["triangle"],
        attributes: {
            position: regl.prop('pos')
        },
        uniforms: {
            color: regl.prop('color')
        },
        elements: regl.prop('elem'),
        primitive: regl.prop('prim'),
    })]

const texture = () => [
    (x) => {
        const src = x["texture"];
        if (!x["alpha"]) {
            x["alpha"] = 1.0;
        }
        if (!loadedTextures[src]) {
            return null;
        }
        x["texture"] = loadedTextures[src];
        return x;
    },
    regl({
        frag: frags["texture"],
        vert: verts["texture"],
        attributes: {
            texc: [
                0, 1,
                1, 1,
                1, 0,
                0, 0,
            ],
            position: regl.prop('pos')
        },
        uniforms: {
            texture: regl.prop('texture'),
            alpha: regl.prop('alpha')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6,
    })]

const textureCropped = () => [
    (x) => {
        if (!x["alpha"]) {
            x["alpha"] = 1.0;
        }
        const src = x["texture"];
        if (!loadedTextures[src]) {
            return null;
        }
        x["texture"] = loadedTextures[src];
        return x;
    },
    regl({
        frag: frags["texture"],
        vert: verts["texture"],
        attributes: {
            texc: regl.prop('texc'),
            position: regl.prop('pos')
        },
        uniforms: {
            texture: regl.prop('texture'),
            alpha: regl.prop('alpha')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6,
    })]

const centeredTexture = () => [
    (x) => {
        if (!x["alpha"]) {
            x["alpha"] = 1.0;
        }
        const src = x["texture"];
        if (!loadedTextures[src]) {
            return null;
        }
        x["texture"] = loadedTextures[src];
        return x;
    },
    regl({
        frag: frags["texture-centered"],
        vert: verts["texture-centered"],
        attributes: {
            texc: [
                0, 1,
                1, 1,
                1, 0,
                0, 0,
            ]
        },
        uniforms: {
            texture: regl.prop('texture'),
            posize: regl.prop('posize'),
            angle: regl.prop('angle'),
            alpha: regl.prop('alpha')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6,
    })]

const centeredCroppedTexture = () => [
    (x) => {
        if (!x["alpha"]) {
            x["alpha"] = 1.0;
        }
        const src = x["texture"];
        if (!loadedTextures[src]) {
            return null;
        }
        x["texture"] = loadedTextures[src];
        const x1 = x["texc"][0];
        const y1 = x["texc"][1];
        const w = x["texc"][2];
        const h = x["texc"][3];
        x["texc"] = [
            x1, y1,
            x1 + w, y1,
            x1 + w, y1 + h,
            x1, y1 + h
        ];
        return x;
    },
    regl({
        frag: frags["texture-cropped-centered"],
        vert: verts["texture-cropped-centered"],
        attributes: {
            texc: regl.prop('texc'),
            texc2: [
                -0.5, 0.5,
                0.5, 0.5,
                0.5, -0.5,
                -0.5, -0.5,
            ]
        },
        uniforms: {
            texture: regl.prop('texture'),
            posize: regl.prop('posize'),
            angle: regl.prop('angle'),
            alpha: regl.prop('alpha')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6,
    })]

const textbox = () => [
    (x) => {
        if (x.font) {
            x.fonts = [x.font];
        }
        if (x["width"] && x["width"] <= 0) {
            x["width"] = Infinity;
        }
        const tmap = TextManager.getTexFromFont(x);
        if (tmap === null) {
            return null;
        }
        const res = TextManager.makeText(x);
        x.tMap = tmap;
        x.position = res.position;
        x.uv = res.uv;
        x.elem = res.index;
        x.thickness = x.thickness != undefined ? x.thickness : 0;
        x.unitRange = TextManager.getFont(x.fonts[0]).text.unitRange;
        return x;
    },
    regl({
        frag: frags["text"],
        vert: verts["text"],
        attributes: {
            position: regl.prop('position'),
            uv: regl.prop('uv')
        },
        uniforms: {
            tMap: regl.prop('tMap'),
            offset: regl.prop('offset'),
            color: regl.prop('color'),
            thickness: regl.prop('thickness'),
            unitRange: regl.prop('unitRange'),
        },
        elements: regl.prop('elem'),
        depth: { enable: false }
    })
]

const defaultCompositor = () => [
    x => x,
    regl({
        frag: frags["compositor"],
        vert: verts["effect"],
        attributes: {
            texc: [
                1, 1,
                1, 0,
                0, 0,
                0, 1,]
        },
        uniforms: {
            mode: regl.prop('mode'),
            t1: regl.prop('t1'),
            t2: regl.prop('t2')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })
]

const compFade = () => [
    x => x,
    regl({
        frag: frags["compFade"],
        vert: verts["effect"],
        attributes: {
            texc: [
                1, 1,
                1, 0,
                0, 0,
                0, 1,]
        },
        uniforms: {
            mode: regl.prop('mode'),
            t: regl.prop('t'),
            t1: regl.prop('t1'),
            t2: regl.prop('t2')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })
]

const imgFade = () => [
    x => {
        const src = x["mask"];
        if (!loadedTextures[src]) {
            return null;
        }
        x["mask"] = loadedTextures[src];
        return x;
    },
    regl({
        frag: frags["imgFade"],
        vert: verts["effect"],
        attributes: {
            texc: [
                1, 1,
                1, 0,
                0, 0,
                0, 1,]
        },
        uniforms: {
            mask: regl.prop('mask'),
            t: regl.prop('t'),
            t1: regl.prop('t1'),
            t2: regl.prop('t2'),
            invert_mask: regl.prop('invert_mask')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })
]

const blurh = () => [
    x => x,
    regl({
        frag: frags["blur1"],
        vert: verts["effect"],
        attributes: {
            texc: [
                1, 1,
                1, 0,
                0, 0,
                0, 1,]
        },
        uniforms: {
            radius: regl.prop('radius'),
            texture: regl.prop('texture')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })
]

const blurv = () => [
    x => x,
    regl({
        frag: frags["blur2"],
        vert: verts["effect"],
        attributes: {
            texc: [
                1, 1,
                1, 0,
                0, 0,
                0, 1,]
        },
        uniforms: {
            radius: regl.prop('radius'),
            texture: regl.prop('texture')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })
]


const gblurh = () => [
    x => x,
    regl({
        frag: frags["gblur"],
        vert: verts["effect"],
        attributes: {
            texc: [
                1, 1,
                1, 0,
                0, 0,
                0, 1,]
        },
        uniforms: {
            dir: [1, 0],
            texture: regl.prop('texture'),
            radius: regl.prop('radius')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })
]


const gblurv = () => [
    x => x,
    regl({
        frag: frags["gblur"],
        vert: verts["effect"],
        attributes: {
            texc: [
                1, 1,
                1, 0,
                0, 0,
                0, 1,]
        },
        uniforms: {
            dir: [0, 1],
            texture: regl.prop('texture'),
            radius: regl.prop('radius')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })
]

const crt = () => [
    x => x,
    regl({
        frag: frags["crt"],
        vert: verts["effect"],
        attributes: {
            texc: [
                1, 1,
                1, 0,
                0, 0,
                0, 1,]
        },
        uniforms: {
            texture: regl.prop('texture'),
            scanline_count: regl.prop('count')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })
]

const fxaa = () => [
    x => x,
    regl({
        frag: frags["fxaa"],
        vert: verts["fxaa"],
        attributes: {
            position: [
                -1, 1,
                -1, -1,
                1, -1,
                1, 1,]
        },
        uniforms: {
            texture: regl.prop('texture')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })
]

const alphamult = () => [
    x => x,
    regl({
        frag: frags["alphamult"],
        vert: verts["effect"],
        attributes: {
            texc: [
                1, 1,
                1, 0,
                0, 0,
                0, 1,]
        },
        uniforms: {
            texture: regl.prop('texture'),
            alpha: regl.prop('alpha')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })
]

const colormult = () => [
    x => x,
    regl({
        frag: frags["colormult"],
        vert: verts["effect"],
        attributes: {
            texc: [
                1, 1,
                1, 0,
                0, 0,
                0, 1,]
        },
        uniforms: {
            texture: regl.prop('texture'),
            color: regl.prop('color')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })
]

const outline = () => [
    x => x,
    regl({
        frag: frags["outline"],
        vert: verts["effect"],
        attributes: {
            texc: [
                1, 1,
                1, 0,
                0, 0,
                0, 1,]
        },
        uniforms: {
            texture: regl.prop('texture'),
            color: regl.prop('color'),
            outline: regl.prop('outline'),
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })
]

const pixilation = () => [
    x => x,
    regl({
        frag: frags["pixilation"],
        vert: verts["effect"],
        attributes: {
            texc: [
                1, 1,
                1, 0,
                0, 0,
                0, 1,]
        },
        uniforms: {
            texture: regl.prop('texture'),
            pixelSize: regl.prop('ps')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        count: 6
    })
]

const circle = () => [
    x => x,
    regl({
        frag: frags["circle"],
        vert: verts["circle"],
        attributes: {
            position: [
                -1, -1,
                1, -1,
                1, 1,
                -1, 1,
            ]
        },
        uniforms: {
            cr: regl.prop('cr'),
            color: regl.prop('color')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],

        count: 6
    })
]

const roundedRect = () => [
    x => x,
    regl({
        frag: frags["rounded-rect"],
        vert: verts["circle"],
        attributes: {
            position: [
                -1, -1,
                1, -1,
                1, 1,
                -1, 1,
            ]
        },
        uniforms: {
            cs: regl.prop('cs'),
            color: regl.prop('color'),
            radius: regl.prop('radius'),
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],

        count: 6
    })
]

const programs = {
    triangle,
    textbox,
    quad,
    rect,
    circle,
    roundedRect,
    poly,
    texture,
    textureCropped,
    centeredTexture,
    centeredCroppedTexture,
    // Effects
    blurh,
    blurv,
    gblurh,
    gblurv,
    crt,
    fxaa,
    alphamult,
    colormult,
    pixilation,
    outline,
    // Compositors
    defaultCompositor,
    compFade,
    imgFade,
}

function loadTextureREGL(texture_name, opts, w, h, token) {
    if (textureLoadTokens[texture_name] !== token) {
        if (opts.data && typeof opts.data.close === "function") {
            opts.data.close();
        }
        return;
    }
    unloadTexture(texture_name, { keepToken: true });
    loadedTextures[texture_name] = regl.texture(opts);
    MlApp.recvREGLCmdPb(
        BackendEventPb.encode(
            BackendEventPb.create({
                textureLoaded: {
                    name: texture_name,
                    width: w,
                    height: h,
                },
            })
        ).finish()
    );
}

function loadTexture(texture_name, opts) {
    // Initialize textures
    const token = (textureLoadTokens[texture_name] || 0) + 1;
    textureLoadTokens[texture_name] = token;
    const image = new Image();
    image.src = opts.data;
    image.onload = () => {
        if (textureLoadTokens[texture_name] !== token) {
            return;
        }
        if (opts["subimg"]) {
            const subimg = opts["subimg"];
            createImageBitmap(image, subimg[0], subimg[1], subimg[2], subimg[3], { imageOrientation: "flipY", premultiplyAlpha: 'none' }).then((sp) => {
                if (textureLoadTokens[texture_name] !== token) {
                    sp.close();
                    return;
                }
                opts.data = sp;
                loadTextureREGL(texture_name, opts, subimg[2], subimg[3], token);
            })
        } else {
            opts.data = image;
            opts.flipY = true;
            loadTextureREGL(texture_name, opts, image.width, image.height, token);
        }
    }
    image.onerror = () => {
        if (textureLoadTokens[texture_name] !== token) {
            return;
        }
        MlApp.recvREGLCmdPb(
            BackendEventPb.encode(
                BackendEventPb.create({
                    textureLoadfail: {
                        name: texture_name,
                    },
                })
            ).finish()
        );
    }
}

function unloadTexture(texture_name, options = {}) {
    const texture = loadedTextures[texture_name];
    if (texture && typeof texture.destroy === "function") {
        texture.destroy();
    }
    delete loadedTextures[texture_name];
    if (!options.keepToken) {
        textureLoadTokens[texture_name] = (textureLoadTokens[texture_name] || 0) + 1;
    }
}

function decodeValue(value) {
    if (!value) {
        return undefined;
    }
    if (value.numberValue != null) {
        return value.numberValue;
    }
    if (value.stringValue != null) {
        return value.stringValue;
    }
    if (value.numberArrayValue != null) {
        return value.numberArrayValue ? value.numberArrayValue.values : [];
    }
    if (value.boolValue != null) {
        return value.boolValue;
    }
    if (value.stringArrayValue != null) {
        return value.stringArrayValue ? value.stringArrayValue.values : [];
    }
    return undefined;
}

function decodeFields(fields) {
    const result = {};
    for (const field of fields || []) {
        result[field.key] = decodeValue(field.val);
    }
    return result;
}

function decodeProgramValue(value) {
    if (value.dynVal != null) {
        return regl.prop(value.dynVal);
    }
    if (value.staticVal != null) {
        return decodeValue(value.staticVal);
    }
    if (value.dynTextval != null) {
        return regl.prop(value.dynTextval);
    }
    return undefined;
}

function decodeProgramMapping(mapping) {
    if (!mapping) {
        return undefined;
    }
    return { value: decodeProgramValue(mapping.val), textureProp: mapping.val.dynTextval };
}


function createGLProgram(prog_name, program) {
    if (loadedPrograms[prog_name]) {
        throw new Error("Program already exists: " + prog_name);
    }

    const uniforms = {};
    const attributes = {};
    const texturePropNames = [];

    for (const mapping of program.uniforms || []) {
        if (!mapping || !mapping.key) {
            continue;
        }
        const resolved = decodeProgramMapping(mapping);
        if (!resolved) {
            continue;
        }
        uniforms[mapping.key] = resolved.value;
        if (resolved.textureProp) {
            texturePropNames.push(resolved.textureProp);
        }
    }

    for (const mapping of program.attributes || []) {
        if (!mapping || !mapping.key) {
            continue;
        }
        const resolved = decodeProgramMapping(mapping);
        if (!resolved) {
            continue;
        }
        attributes[mapping.key] = resolved.value;
    }

    const primitive = program.primitive != null ? decodeProgramValue(program.primitive) : undefined;
    const elements = program.elements != null ? decodeProgramValue(program.elements) : undefined;
    const count = program.count != null ? decodeProgramValue(program.count) : undefined;

    const initfunc = (args) => {
        for (let i = 0; i < texturePropNames.length; i++) {
            const propName = texturePropNames[i];
            if (!(propName in args)) {
                continue;
            }
            if (!(args[propName] in loadedTextures)) {
                return null;
            }
            args[propName] = loadedTextures[args[propName]];
        }
        return args;
    };

    const reglProgramConfig = {
        frag: program.frag,
        vert: program.vert
    };
    reglProgramConfig.attributes = attributes;
    reglProgramConfig.uniforms = uniforms;
    if (primitive) {
        reglProgramConfig.primitive = primitive.value;
    }
    if (elements) {
        reglProgramConfig.elements = elements.value;
    }
    if (count) {
        reglProgramConfig.count = count.value;
    }

    const compiledProgram = regl(reglProgramConfig);
    loadedPrograms[prog_name] = [initfunc, compiledProgram];

    MlApp.recvREGLCmdPb(
        BackendEventPb.encode(
            BackendEventPb.create({
                programCreated: { name: prog_name },
            })
        ).finish()
    );
}

function allocNewFBO() {
    const fb = regl.framebuffer({
        color: regl.texture({
            width: 1,
            height: 1
        }),
        depth: false
    });
    fbos.push(fb);

    palettes.push(regl({
        framebuffer: fb,
        uniforms: {
            view: [userConfig.virtWidth / 2, -userConfig.virtHeight / 2],
            camera: () => {
                return camera;
            }
        },
        depth: { enable: false },
        blend: {
            enable: true,
            func: {
                src: 'one',
                dst: 'one minus src alpha'
            }
        },
    }));
}

function getFreePalette() {
    for (let i = 0; i < userConfig.fboNum; i++) {
        if (freePalette[i]) {
            freePalette[i] = false;
            // console.log("Free palette found: " + i);
            return i;
        }
    }
    console.warn("No free palette found!");
    if (userConfig.fboNum > 1000) {
        throw new Error("Error: Exceeding maximum fbo number!");
    }
    // Acquire a new FBO
    allocNewFBO();
    const vpWidth = regl._gl.drawingBufferWidth;
    const vpHeight = regl._gl.drawingBufferHeight;
    fbos[userConfig.fboNum].resize(vpWidth, vpHeight);
    freePalette[userConfig.fboNum] = false;
    userConfig.fboNum++;
    return userConfig.fboNum - 1;
}

function drawAtomic(a) {
    if (!a) {
        return;
    }
    v = decodeFields(a.fields);
    if (a.program === "clear") {
        const ac = v.color[3];
        v.color[0] *= ac;
        v.color[1] *= ac;
        v.color[2] *= ac;
        regl.clear(v);
    } else {
        const p = loadedPrograms[a.program];
        execProg(p, v);
    }
}

function execProg(p, va) {
    if (p) {
        const args = p[0](va);
        if (args) {
            p[1](args);
        }
    }
}


function drawComp(v) {
    // v is a composition command
    // Return the id of the palette used
    if (!v) {
        return -1;
    }
    const r1pid = drawRenderable(v.left);
    const r2pid = drawRenderable(v.right);
    const npid = getFreePalette();
    const comp = v.compositor;
    const vo = decodeFields(comp.fields);
    palettes[npid]({}, () => {
        regl.clear({ color: [0, 0, 0, 0] });
        const p = loadedPrograms[comp.program];
        vo.t1 = fbos[r1pid];
        vo.t2 = fbos[r2pid];
        execProg(p, vo);
    });
    freePID(r1pid);
    freePID(r2pid);
    return npid;
}

function simpleCompose(oldp, newp) {
    if (oldp === -1) {
        return newp;
    }
    if (oldp === newp) {
        return oldp;
    }
    palettes[oldp]({}, () => {
        drawPalette({ fbo: fbos[newp] });
    });
    freePID(newp);
    return oldp;

}

function freePID(pid) {
    if (pid >= 0) {
        freePalette[pid] = true;
    }
}

function applyEffect(e, pid) {
    // Return the id of the palette used
    const npid = getFreePalette();
    const v = decodeFields(e.fields);
    palettes[npid]({}, () => {
        regl.clear({ color: [0, 0, 0, 0] });
        const p = loadedPrograms[e.program];
        v.texture = fbos[pid];
        execProg(p, v);
    });
    return npid;
}

// Draw a group of renderables
// prev is the palette id of the current palette
// Return the id of the palette used
function drawGroup(v, prev) {
    // Callee-save camera
    let prev_camera = camera;

    if (!v) {
        return prev;
    }
    const cmds = v.children;
    const effects = v.effects;

    if (cmds.length === 0) {
        return prev;
    }

    if (v.camera) {
        camera = [v.camera.x, v.camera.y, v.camera.zoom, v.camera.rotation];
    }
    let curPalette = prev;
    for (let i = 0; i < cmds.length; i++) {
        const c = cmds[i];
        if (!c) {
            continue;
        }
        let pid = -1;
        if (c.group) {
            if (c.group.effects.length === 0) {
                pid = drawGroup(c.group, curPalette);
            } else {
                pid = drawGroup(c.group, -1);
            }
            if (pid < 0) { // Empty group
                continue;
            }
        } else if (c.composite) {
            pid = drawComp(c.composite);
            if (pid < 0) { // Empty composition
                continue;
            }
        } else {
            // Atomic
            pid = curPalette >= 0 ? curPalette : getFreePalette();
            // console.log("draw single command:", pid);
            palettes[pid]({}, () => {
                if (curPalette < 0) {
                    // New palette, automatically clear the palette
                    regl.clear({ color: [0, 0, 0, 0] });
                }
                while (i < cmds.length) {
                    const lc = cmds[i];
                    if (!lc) {
                        i++;
                        continue;
                    }
                    if (lc.group || lc.composite) {
                        i--;
                        break;
                    } else {
                        drawAtomic(lc.atomic);
                    }
                    i++;
                }
            });
        }
        curPalette = simpleCompose(curPalette, pid);
    }

    // Apply effects

    for (let i = 0; i < effects.length; i++) {
        const e = effects[i];
        const npid = applyEffect(e, curPalette);
        // console.log("apply effect:", curPalette, " -> ", npid);
        freePID(curPalette);
        curPalette = npid;
    }

    camera = prev_camera;
    return curPalette;
}

// Draw renderable, return the id of the palette used
function drawRenderable(rd) {
    if (!rd) {
        return -1;
    }
    if (rd.atomic) {
        const pid = getFreePalette();
        palettes[pid]({}, () => {
            regl.clear({ color: [0, 0, 0, 0] });
            drawAtomic(rd.atomic);
        });
        return pid;
    } else if (rd.group) {
        return drawGroup(rd.group, -1);
    } else {
        // composite
        return drawComp(rd.composite);
    }
}

async function step() {
    if (global_error || loopStopRequested) {
        return;
    }

    try {
        scheduleNextStep();
        regl.poll();
        const vpWidth = regl._gl.drawingBufferWidth;
        const vpHeight = regl._gl.drawingBufferHeight;

        for (let i = 0; i < userConfig.fboNum; i++) {
            fbos[i].resize(vpWidth, vpHeight);
        }

        // const t1 = performance.now();

        const ts = loopElapsedMs();

        MlApp.event(
            EventPb.encode(
                EventPb.create({
                    updateTick: { ts: ts },
                })
            ).finish()
        );
        // const t2 = performance.now();
        // console.log("Time to update: " + (t2 - t1) + "ms");

        const gview = RenderablePb.decode(MlApp.view());

        for (let i = 0; i < userConfig.fboNum; i++) {
            freePalette[i] = true;
        }

        // console.log(gview);
        const pid = drawRenderable(gview);
        if (pid >= 0) {
            drawPalette({ fbo: fbos[pid] });
        }
        // const t3 = performance.now();
        // console.log("Time to render view: " + (t3 - t2) + "ms");
        regl._gl.flush();
    } catch (e) {
        stopError(e);
    }

}

async function start(v) {
    // const t0 = performance.now();
    loopStopRequested = false;
    if (v.virtWidth != null) {
        userConfig.virtWidth = v.virtWidth;
    }
    if (v.virtHeight != null) {
        userConfig.virtHeight = v.virtHeight;
    }
    if (v.fboNum != null) {
        userConfig.fboNum = v.fboNum;
    }
    let toloadprograms = Object.keys(programs);

    if (v.builtinPrograms != null) {
        toloadprograms = v.builtinPrograms.values;
    }

    // Init
    for (prog_name of toloadprograms) {
        loadBuiltinGLProgram(prog_name);
    }

    // Set camera initial value
    camera = [userConfig.virtWidth / 2, userConfig.virtHeight / 2, 1.0, 0.0];

    for (let i = 0; i < userConfig.fboNum; i++) {
        allocNewFBO();
    }

    drawPalette = regl({
        frag: frags["palette"],
        vert: verts["effect"],
        attributes: {
            texc: [
                1, 1,
                1, 0,
                0, 0,
                0, 1]
        },
        uniforms: {
            texture: regl.prop('fbo')
        },
        elements: [
            0, 1, 2,
            0, 2, 3
        ],
        depth: { enable: false },

        count: 6
    });

    loopStartTimeMs = monotonicNowMs();

    // const t1 = performance.now();
    // console.log("REGL initialized in " + (t1 - t0) + "ms");
    scheduleNextStep();
}

function loadGLProgram(prog_name, f) {
    // Initialize program from JS
    // Not intended to be used by App
    loadedPrograms[prog_name] = f(regl);
}

function loadBuiltinGLProgram(prog_name) {
    // Initialize program
    if (programs[prog_name]) {
        loadedPrograms[prog_name] = programs[prog_name]();
    } else {
        throw new Error("Program not found: " + prog_name);
    }
}

function init(canvas, app, override_conf) {
    // Initialize regl etc.
    // Called from JS
    MlApp = app;
    const defconfig = {
        canvas,
        extensions: ['OES_standard_derivatives'],
        attributes: {
            antialias: false,
            depth: false,
            premultipliedAlpha: true
        }
    }
    for (const key in override_conf) {
        defconfig[key] = override_conf[key];
    }
    regl = require('regl')(defconfig);
    TextManager = new TM(regl);
    AudioRuntime = makeAudioRuntime(MlApp, pb, loopElapsedMs);

    // Convert a DOM mouse event to virtual canvas coordinates, mirroring
    // the desktop bridge's mouse_to_virtual: raw * (virtual / actual).
    // Raw input is canvas-relative (clientX/Y minus the canvas bounding rect).
    function mouseEventToVirtual(e) {
        const rect = canvas.getBoundingClientRect();
        const cw = rect.width || canvas.clientWidth || canvas.width || 1;
        const ch = rect.height || canvas.clientHeight || canvas.height || 1;
        const localX = e.clientX - rect.left;
        const localY = e.clientY - rect.top;
        return {
            x: localX * (userConfig.virtWidth / cw),
            y: localY * (userConfig.virtHeight / ch),
        };
    }

    // Add event listener
    document.addEventListener('keydown', (e) => {
        MlApp.event(
            EventPb.encode(
                EventPb.create({
                    keyDown: { code: domCodeToSdlKeyName(e.code) },
                })
            ).finish()
        );
    });
    document.addEventListener('keyup', (e) => {
        MlApp.event(
            EventPb.encode(
                EventPb.create({
                    keyUp: { code: domCodeToSdlKeyName(e.code) },
                })
            ).finish()
        );
    });
    document.addEventListener('mousemove', (e) => {
        const p = mouseEventToVirtual(e);
        MlApp.event(
            EventPb.encode(
                EventPb.create({
                    mouseMove: { x: p.x, y: p.y },
                })
            ).finish()
        );
    });
    document.addEventListener('mousedown', (e) => {
        const p = mouseEventToVirtual(e);
        MlApp.event(
            EventPb.encode(
                EventPb.create({
                    mouseDown: { button: domButtonToSdlButton(e.button), x: p.x, y: p.y },
                })
            ).finish()
        );
    });
    document.addEventListener('mouseup', (e) => {
        const p = mouseEventToVirtual(e);
        MlApp.event(
            EventPb.encode(
                EventPb.create({
                    mouseUp: { button: domButtonToSdlButton(e.button), x: p.x, y: p.y },
                })
            ).finish()
        );
    });
}

function config(c) {
    if ("interval" in c) {
        userConfig.interval = c.interval;
    }
}

async function loadFont(v) {
    const token = (fontLoadTokens[v.name] || 0) + 1;
    fontLoadTokens[v.name] = token;
    try {
        await TextManager.loadFont(v.name, v.imageUrl, v.jsonUrl);
        if (fontLoadTokens[v.name] !== token) {
            TextManager.unloadFont(v.name, v.imageUrl);
            return;
        }
        MlApp.recvREGLCmdPb(
            BackendEventPb.encode(
                BackendEventPb.create({
                    fontLoaded: { name: v.name },
                })
            ).finish()
        );
    } catch (e) {
        MlApp.recvREGLCmdPb(
            BackendEventPb.encode(
                BackendEventPb.create({
                    fontLoadfail: { name: v.name },
                })
            ).finish()
        );
    }
}

function unloadFont(name) {
    fontLoadTokens[name] = (fontLoadTokens[name] || 0) + 1;
    TextManager.unloadFont(name);
}

function magOptionToString(v) {
    return v === 1 ? 'nearest' : 'linear';
}

function minOptionToString(v) {
    switch (v) {
        case 1:
            return 'nearest';
        case 2:
            return 'nearest mipmap nearest';
        case 3:
            return 'linear mipmap nearest';
        case 4:
            return 'nearest mipmap linear';
        case 5:
            return 'linear mipmap linear';
        default:
            return 'linear';
    }
}

function sendBackendEvent(event) {
    MlApp.recvREGLCmdPb(
        BackendEventPb.encode(BackendEventPb.create(event)).finish()
    );
}

function handleSaveValue(v) {
    try {
        globalThis.localStorage.setItem(v.key, v.value);
    } catch (e) {
        console.warn('[ml-regl] SaveValue failed for key', v.key, e);
    }
}

function handleReadValue(v) {
    try {
        const value = globalThis.localStorage.getItem(v.key);
        if (value === null) {
            sendBackendEvent({ valueReadMissing: { key: v.key } });
        } else {
            sendBackendEvent({ valueRead: { key: v.key, value } });
        }
    } catch (e) {
        console.warn('[ml-regl] ReadValue failed for key', v.key, e);
        sendBackendEvent({ valueReadMissing: { key: v.key } });
    }
}

async function handleLoadFile(v) {
    try {
        const res = await fetch(v.path);
        if (!res.ok) {
            sendBackendEvent({
                fileLoadFailed: {
                    path: v.path,
                    reason: `HTTP ${res.status} ${res.statusText}`,
                },
            });
            return;
        }
        const data = await res.text();
        sendBackendEvent({ fileLoaded: { path: v.path, data } });
    } catch (e) {
        sendBackendEvent({
            fileLoadFailed: {
                path: v.path,
                reason: String(e && e.message ? e.message : e),
            },
        });
    }
}

function execCmdPb(bytes) {
    try {
        const batch = BackendCommandBatchPb.decode(bytes);
        const commands = batch.commands || [];
        for (let i = 0; i < commands.length; i++) {
            const cmd = commands[i];
            if (cmd.loadFont != null) {
                loadFont(cmd.loadFont);
            } else if (cmd.loadTexture != null) {
                const opts = {
                    data: cmd.loadTexture.url,
                    mag: magOptionToString(
                        cmd.loadTexture.options
                            ? cmd.loadTexture.options.mag
                            : 0
                    ),
                    min: minOptionToString(
                        cmd.loadTexture.options
                            ? cmd.loadTexture.options.min
                            : 0
                    ),
                };
                if (cmd.loadTexture.options != null && cmd.loadTexture.options.crop != null) {
                    const c = cmd.loadTexture.options.crop;
                    opts.subimg = [c.x, c.y, c.width, c.height];
                }
                loadTexture(cmd.loadTexture.name, opts);
            } else if (cmd.configRegl != null) {
                // ConfigRegl is a oneof: either pacing (intervalMs) or
                // window flags. The JS host doesn't own the run loop
                // and can't natively change resizable / fullscreen
                // without a fresh canvas + container hookup, so window
                // flags are a no-op here. Pacing maps to the existing
                // `interval` knob.
                if (cmd.configRegl.intervalMs != null) {
                    config({ interval: cmd.configRegl.intervalMs });
                }
                // window-config oneof branch silently ignored.
            } else if (cmd.startRegl != null) {
                start(cmd.startRegl);
            } else if (cmd.quitRegl != null) {
                requestQuit();
            } else if (cmd.createProgram != null) {
                try {
                    createGLProgram(cmd.createProgram.name, cmd.createProgram.program);
                } catch (_) {
                    MlApp.recvREGLCmdPb(
                        BackendEventPb.encode(
                            BackendEventPb.create({
                                programCreatefail: { name: cmd.createProgram.name },
                            })
                        ).finish()
                    );
                }
            } else if (cmd.loadAudio != null) {
                AudioRuntime.loadAudio(cmd.loadAudio.audioUrl);
            } else if (cmd.unloadTexture != null) {
                unloadTexture(cmd.unloadTexture.name);
            } else if (cmd.unloadFont != null) {
                unloadFont(cmd.unloadFont.name);
            } else if (cmd.unloadAudio != null) {
                AudioRuntime.unloadAudio(cmd.unloadAudio.audioUrl);
            } else if (cmd.saveValue != null) {
                handleSaveValue(cmd.saveValue);
            } else if (cmd.readValue != null) {
                handleReadValue(cmd.readValue);
            } else if (cmd.loadFile != null) {
                handleLoadFile(cmd.loadFile);
            } else {
                throw new Error('Unknown protobuf backend command ' + cmd.kind);
            }
        }
    } catch (e) {
        stopError(e);
    }
}

function execAudioCmdPb(bytes) {
    if (!AudioRuntime) {
        return;
    }
    try {
        AudioRuntime.execAudioCmdPb(bytes);
    } catch (e) {
        stopError(e);
    }
}

globalThis.MlREGL = {
    loadGLProgram, // Called by user
    init, // Called by user
    execCmdPb, // Called from app
    execAudioCmdPb // Called from app
}
