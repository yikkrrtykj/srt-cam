.PHONY: test test-legacy test-go web-build build demo clean

test: test-legacy test-go

test-legacy:
	bash -n install.sh
	bash -n scripts/init-v2-node.sh
	python3 -m py_compile srt-status
	python3 -m unittest discover -s tests -v
	python3 tests/check_compose.py

test-go:
	go test -v ./...

web-build:
	cd web && npm install && npm run build

build: web-build
	mkdir -p bin
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/srt-camd ./cmd/srt-camd
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/srt-passd ./cmd/srt-passd
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/srt-relayd ./cmd/srt-relayd
	@echo "PASS: built zero-CGO binaries -> bin/srt-camd, bin/srt-passd, bin/srt-relayd"

demo: build
	./bin/srt-camd --demo --events deploy/event-sheet.example.json --listen 127.0.0.1:8080

clean:
	rm -rf bin
