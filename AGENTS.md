# AGENTS.md

## Purpose and scope

`ml-regl-js` is the browser host for the OCaml `ml-regl` frontend in the parent
repository. It decodes protobuf commands from the Js_of_ocaml application,
renders declarative trees through REGL/WebGL, performs browser asset I/O, runs
Web Audio voices, translates DOM input into the shared backend vocabulary, and
drives the animation loop.

Keep declarative state, diffing, and public constructors in the parent
`../lib/`. This repository should execute wire commands faithfully; it should
not duplicate the OCaml model or add framework-specific behavior.

## Repository map

- `src/app.js`: browser lifecycle, protobuf command/event dispatch, render-tree
  walker, resources, frame pacing, DOM input normalization, persistence, and
  optional JSON control channel.
- `src/audio.js`: Web Audio buffer loading and live voice actions.
- `src/text.js`: MSDF text geometry and layout support.
- `src/<program>/`: built-in vertex and fragment shader sources.
- `proto/`: shared `declgl-pb` schema checkout.
- `src/generated/mlregl_pb.js`: ignored, generated protobuf bindings.
- `build/regl.js`: ignored browser bundle produced by Make.
- `test/control_protocol.test.js`: lightweight host test using a fake browser
  environment and WebSocket.

The browser harnesses and OCaml test applications live in the parent
repository's `html/` and `test/` directories.

## Host contracts

- `MlApp` is exported by the Js_of_ocaml adapter. Send serialized events back
  through its `event`, `recvREGLCmdPb`, and `recvAudioMsgPb` callbacks using the
  exact generated protobuf types.
- `MlREGL` is the browser-facing host surface. Keep startup, shutdown, debug,
  and command dispatch compatible with the parent adapter.
- Input uses SDL-style key names and 1-based mouse buttons so the same OCaml
  application behaves like the desktop backend.
- Tick and audio times use milliseconds elapsed from the host loop's start.
  Web Audio context seconds must be converted at the boundary.
- Keep the render tree recursive semantics aligned with
  `declgl-desktop/src/renderer/renderable_walker.cc`: atomic calls, ordered
  group children/effects, camera state, and compositor left/right inputs.
- FBO and palette entries are pooled. Every temporary acquired while walking a
  tree must be released on all supported paths; growth must preserve existing
  buffers and viewport sizing.
- Resource loads are asynchronous. Emit the matching success or failure event,
  and make unload/reload behavior idempotent.
- Audio `nodeGroupId` identifies a live voice. Start, stop, volume, timeline,
  loop, and playback-rate actions must mutate only that voice. Unloading a
  buffer must stop every voice referencing it before discarding it.
- Browser autoplay can suspend `AudioContext`; retain the cheap resume attempt
  when applying audio commands.
- The optional WebSocket control channel queues commands for frame-boundary
  application. It must remain disabled unless selected by URL/debug settings.

## Protocol workflow

`proto/` is a checkout of the shared schema repository. The OCaml core and the
desktop host have sibling checkouts of the same schema.

- Do not edit `src/generated/mlregl_pb.js`; run `make proto-gen`.
- Keep schema field numbers, units, enum values, and `oneof` cases compatible.
- A protocol change is incomplete until the parent OCaml encoder/decoder and
  the desktop host are updated and all schema checkouts point to the same
  commit.
- `protobufjs` is configured with `--force-number`; account for JavaScript
  numeric limits before adding integer fields that can exceed safe integers.

## Build and verification

Run from this repository root:

```sh
pnpm install
make debug
make build
make test-control
```

`make debug` creates an unminified `build/regl.js`; `make build` minifies the
same output. Both regenerate protobuf bindings first. The control test is the
only automated host-level test currently present.

For rendering, resources, audio, or input, also compile the matching parent
OCaml `.bc.js` target, serve the parent repository over HTTP, and open the
matching `html/test_*.html` harness. Do not claim visual, input, or audio
behavior from bundle compilation alone. Use browser developer-console errors
as test failures.

## Style and change discipline

- Match the existing plain CommonJS style and four-space indentation. There is
  no transpilation step; keep syntax supported by the project's browser
  targets and Browserify.
- Use generated protobuf decoders rather than parsing binary payloads by hand.
- Keep built-in shader names and uniform keys synchronized with the OCaml
  constructors and desktop registry. Shader parity requires testing both
  hosts.
- Do not edit `node_modules/`, `build/`, `src/generated/`, or files under a
  parent repository's build directory.
- Avoid broad formatting of `src/app.js`; it is large and unrelated churn
  obscures behavioral changes.
- Inspect this repository's own status and diff before finishing. A parent
  repository status is not a substitute for checking this nested checkout.
