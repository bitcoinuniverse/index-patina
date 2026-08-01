# PATINA indexer image.
#
# The dependency on @bitcoinuniverse/patina resolves from a tarball vendored
# inside this repository (vendor/bitcoinuniverse-patina-1.0.0.tgz), so the build
# context is this repository and nothing else.
#
# Build from the repository root:
#   docker build -t index-patina .
#
# better-sqlite3 is a native module. The build stage installs a compiler for it
# and the runtime stage carries only the compiled result.

FROM node:24-bookworm-slim AS build
WORKDIR /srv/index-patina

RUN apt-get update \
 && apt-get install --yes --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY vendor ./vendor
COPY scripts ./scripts
COPY SOURCE-PROVENANCE.json ./SOURCE-PROVENANCE.json
RUN npm install --omit=dev --no-audit --no-fund && cp -r node_modules /tmp/node_modules_prod
RUN npm install --no-audit --no-fund
RUN node scripts/verify-vendor.mjs

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY bin ./bin
RUN npm run build


FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /srv/index-patina

RUN groupadd --system --gid 10001 patina \
 && useradd --system --uid 10001 --gid patina --home /srv patina \
 && mkdir -p /var/lib/patina && chown patina:patina /var/lib/patina

COPY --from=build /tmp/node_modules_prod ./node_modules
COPY --from=build /srv/index-patina/dist ./dist
COPY --from=build /srv/index-patina/package.json ./package.json
COPY --from=build /srv/index-patina/bin ./bin

ENV PATINA_DATA_DIR=/var/lib/patina
ENV PATINA_API_HOST=0.0.0.0
ENV PATINA_API_PORT=4180
EXPOSE 4180
VOLUME ["/var/lib/patina"]

USER patina
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PATINA_API_PORT||4180)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "bin/index-patina.mjs"]
CMD ["serve"]
