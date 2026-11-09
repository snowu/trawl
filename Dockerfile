# trawl serve: the hosted review site + MCP server. See deploy/aws/README.md.
# Build: docker build -t trawl:0.3.0 .            (add --platform linux/arm64 for Graviton)
# The result is one static-ish binary (glibc only) on distroless: no shell, no package manager, non-root.
# Base images are pinned by digest; bump them deliberately (the tag is kept for readability).

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /src
COPY package.json bun.lock tsconfig.json ./
COPY stubs ./stubs
RUN bun install --frozen-lockfile
COPY src ./src
COPY fonts ./fonts
RUN bun build --compile --minify src/cli.ts --outfile /out/trawl

FROM gcr.io/distroless/base-debian12:nonroot@sha256:7f0c72cd138b442ae0deeb69c08b1acf5525439ba251a49ad93c320a061567e5
COPY --from=build /out/trawl /usr/local/bin/trawl
# The root filesystem is read-only in the task definition; the GitHub sync writes under /tmp (an ephemeral volume).
ENV TMPDIR=/tmp TRAWL_PORT=8080
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/trawl", "serve"]
