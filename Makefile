NODE_BIN_DIR ?= /Users/bytedance/.local/share/nvm/v24.15.0/bin
PNPM := $(NODE_BIN_DIR)/pnpm
RUN := PATH="$(NODE_BIN_DIR):$$PATH"

SHARED_PROTO_DIR := ../lib/proto
PROTO_DIR := proto
GENERATED_DIR := src/generated
SHARED_PROTO_FILES := $(SHARED_PROTO_DIR)/transport_audio.proto $(SHARED_PROTO_DIR)/transport_backend.proto $(SHARED_PROTO_DIR)/transport_render.proto
PROTO_FILES := $(PROTO_DIR)/transport_audio.proto $(PROTO_DIR)/transport_backend.proto $(PROTO_DIR)/transport_render.proto
GENERATED_PROTO_JS := $(GENERATED_DIR)/transport_audio_pb.js

$(GENERATED_DIR):
	mkdir -p $(GENERATED_DIR)

$(PROTO_DIR):
	mkdir -p $(PROTO_DIR)

sync-proto: $(PROTO_DIR)
	cp $(SHARED_PROTO_FILES) $(PROTO_DIR)/

proto-gen: $(GENERATED_DIR) sync-proto
	$(RUN) $(PNPM) exec pbjs -t static-module -w commonjs --dependency protobufjs/minimal --force-number -o $(GENERATED_PROTO_JS) $(PROTO_DIR)/transport_audio.proto

debug: proto-gen
	mkdir -p build
	$(RUN) $(PNPM) exec browserify -t brfs src/app.js > build/regl.js

build: proto-gen
	mkdir -p build
	$(RUN) $(PNPM) exec browserify -t brfs src/app.js > build/regl.js
	$(RUN) $(PNPM) exec uglifyjs build/regl.js -c -m --in-situ

.PHONY: build debug proto-gen sync-proto
