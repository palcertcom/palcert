# CI-only MinIO and mc, built from the exact upstream releases previously used.
# The community registry images are no longer anonymously pullable. Keep these
# source pins aligned with the release-test topology; this image is never deployed.
FROM golang:1.26-alpine3.23@sha256:0525c952defebc693cdaf62cdf43afa32be5a7f377e99260642ea19c240c708e AS build
RUN apk add --no-cache git
ENV CGO_ENABLED=0 GOTOOLCHAIN=local

WORKDIR /src/minio
RUN git init . \
    && git remote add origin https://github.com/minio/minio.git \
    && git fetch --depth=1 origin 0d7408fc9969caf07de6a8c3a84f9fbb10a6739e \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = 0d7408fc9969caf07de6a8c3a84f9fbb10a6739e
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags "$(go run buildscripts/gen-ldflags.go)" -o /out/minio .

WORKDIR /src/mc
RUN git init . \
    && git remote add origin https://github.com/minio/mc.git \
    && git fetch --depth=1 origin b00526b153a31b36767991a4f5ce2cced435ee8e \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = b00526b153a31b36767991a4f5ce2cced435ee8e
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -ldflags "$(go run buildscripts/gen-ldflags.go)" -o /out/mc .

FROM alpine:3.23@sha256:ff7f0c727dd796aa36787bfcd9a64bf35a6ce72a73451b3359fde849b6703d63
# The release topology uses curl for its TLS health probe and a shell for mc.
RUN apk add --no-cache ca-certificates curl
COPY --from=build /out/minio /out/mc /usr/local/bin/
COPY --from=build /src/minio/LICENSE /usr/share/licenses/minio/LICENSE
COPY --from=build /src/mc/LICENSE /usr/share/licenses/mc/LICENSE
LABEL org.opencontainers.image.title="PalCert CI storage fixture" \
    io.palcert.minio.source="0d7408fc9969caf07de6a8c3a84f9fbb10a6739e" \
    io.palcert.mc.source="b00526b153a31b36767991a4f5ce2cced435ee8e"
ENTRYPOINT ["minio"]
CMD ["server", "/data"]
