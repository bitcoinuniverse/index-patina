# PATINA indexer image.
#
# The dependency on @bitcoinuniverse/patina resolves from a tarball vendored
# inside this repository (vendor/bitcoinuniverse-patina-1.0.0.tgz), so the
# build context only needs to hold this repository, not a sibling checkout of
# the protocol repository.
#
# Build from the repository root:
#   docker build -f indexers/index-patina/Dockerfile -t index-patina .
#
# docker-compose.yml already sets the context correctly.

FROM node:24-bookworm-slim AS build
WORKDIR /srv/indexers/index-patina

COPY indexers/index-patina/package.json indexers/index-patina/package-lock.json* ./
COPY indexers/index-patina/vendor ./vendor
COPY indexers/index-patina/scripts ./scripts
COPY indexers/index-patina/SOURCE-PROVENANCE.json ./SOURCE-PROVENANCE.json
RUN npm install --omit=dev --no-audit --no-fund && cp -r node_modules /tmp/node_modules_prod
RUN npm install --no-audit --no-fund
RUN node scripts/verify-vendor.mjs

COPY indexers/index-patina/tsconfig.json indexers/index-patina/tsconfig.build.json ./
COPY indexers/index-patina/src ./src
COPY indexers/index-patina/bin ./bin
RUN npm run build


FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /srv/indexers/index-patina

RUN groupadd --system --gid 10001 patina \
 && useradd --system --uid 10001 --gid patina --home /srv patina \
 && mkdir -p /var/lib/patina && chown patina:patina /var/lib/patina

COPY --from=build /tmp/node_modules_prod ./node_modules
COPY --from=build /srv/indexers/index-patina/dist ./dist
COPY --from=build /srv/indexers/index-patina/package.json ./package.json
COPY --from=build /srv/indexers/index-patina/bin ./bin

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
