GO ?= go
VERSION ?= dev
.PHONY: dev build test lint frontend clean integration docker-test browser-test dist
frontend:
	cd web && npm ci --legacy-peer-deps && npm run build
build: frontend
	mkdir -p bin
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o bin/localdesk ./cmd/localdesk
dev:
	bash scripts/dev.sh
test: frontend
	$(GO) test -race ./...
	cd web && npm test
lint: frontend
	$(GO) vet ./...
	@test -z "$$($(GO) fmt ./...)" || (echo 'Go files were reformatted; review changes.'; exit 1)
	cd web && npm run lint
integration: build
	python3 scripts/integration.py
docker-test: build
	python3 scripts/docker-integration.py
browser-test: build
	cd web && npx playwright install chromium && npm run test:e2e
dist: frontend
	mkdir -p dist
	@for os in darwin linux; do for arch in arm64 amd64; do \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch $(GO) build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o dist/localdesk-$$os-$$arch ./cmd/localdesk || exit 1; \
	done; done
clean:
	rm -rf bin dist
