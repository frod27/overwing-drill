# overwing-drill: the fire drill runner. Build from this directory:
#   docker build -t overwing-drill .
# and run it from the directory that holds your scope file:
#   docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD":/work -w /work -e OVERWING_API_KEY overwing-drill check --scope scope.signed.json
# Node runs the TypeScript sources directly (type stripping, Node 22.18 or later).
#
# The base image is pinned by digest, so every build starts from the same bytes whatever the tag is
# moved to later. The tag it was read from:
#   node:22-alpine
# This is the multi-architecture index that tag named on 2026-11-21, the same one as
# node:22.23.5-alpine3.24. To move it on purpose, read the new digest with
#   docker buildx imagetools inspect node:22-alpine
# and change it below.
FROM node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /drill
COPY package.json package-lock.json ./
# The only dependency is optional: the model SDK, needed for a model-driven fleet and not for a scripted one.
# It is installed exactly as package-lock.json records it, each package checked against its hash there,
# and no package's install script is run: none in the lockfile has one, and one added later stays unrun.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY sample ./sample
# No root, and nothing in the image but the runner: no shell tools are given to the fleet either way.
# The entry point is absolute, so the runner starts from whatever directory holds the scope file.
USER node
ENTRYPOINT ["node", "/drill/src/cli.ts"]
CMD ["help"]
