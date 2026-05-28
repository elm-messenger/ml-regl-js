
PROTO_DIR := proto
GENERATED_DIR := src/generated
PROTO_FILES := $(wildcard $(PROTO_DIR)/*.proto)
GENERATED_PROTO_JS := $(GENERATED_DIR)/mlregl_pb.js

$(GENERATED_DIR):
	mkdir -p $(GENERATED_DIR)

proto-gen: $(PROTO_FILES) $(GENERATED_DIR)
	pnpm exec pbjs -t static-module -w commonjs --dependency protobufjs/minimal --force-number -o $(GENERATED_PROTO_JS) $(PROTO_FILES)

debug: proto-gen
	mkdir -p build
	pnpm exec browserify -t brfs src/app.js > build/regl.js

build: proto-gen
	mkdir -p build
	pnpm exec browserify -t brfs src/app.js > build/regl.js
	pnpm exec uglifyjs build/regl.js -c -m --in-situ

.PHONY: build debug proto-gen sync-proto
