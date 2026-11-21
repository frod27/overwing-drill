# overwing-drill: the fire drill runner. Build from this directory:
#   docker build -t overwing-drill .
# and run it from the directory that holds your scope file:
#   docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD":/work -w /work -e OVERWING_API_KEY overwing-drill check --scope scope.signed.json
# Node runs the TypeScript sources directly (type stripping, Node 22.18 or later).
FROM node:22-alpine
WORKDIR /drill
COPY package.json ./
# The only dependency is optional: the model SDK, needed for a model-driven fleet and not for a scripted one.
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY sample ./sample
# No root, and nothing in the image but the runner: no shell tools are given to the fleet either way.
# The entry point is absolute, so the runner starts from whatever directory holds the scope file.
USER node
ENTRYPOINT ["node", "/drill/src/cli.ts"]
CMD ["help"]
