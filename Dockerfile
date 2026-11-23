# trawl serve: the hosted review site + MCP server. See deploy/aws/README.md.
# Build: docker build -t trawl:0.3.0 .            (add --platform linux/arm64 for Graviton)
# The result is one static-ish binary (glibc only) on distroless: no shell, no package manager, non-root.
# Base images are pinned by digest; bump them deliberately (the tag is kept for readability).

FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS build
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
