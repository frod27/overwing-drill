# overwing-drill

Runs an [Overwing Radar](https://overwing.ai/radar) fire drill in your own staging environment: a
small fleet of agents with independent, harmless tasks on your shared surfaces, reporting what they
do there to Overwing. The report says which surfaces let coordination emerge, how fast, which
detectors fired, and what your own monitoring missed.

The drill observes. It does not probe, exploit or escalate anything: an agent is handed read, write
and list on the surfaces the scope names, and has no other tool.

This runs inside your environment, so the whole of it is here to read before you run it. It has no
dependencies for a scripted fleet.

The full walk-through is the [drill runbook](https://overwing.ai/radar/drill-runbook).

## Get it

With Node 22.18 or later (the sources run as they are; there is no build step):

```
git clone https://github.com/frod27/overwing-drill
cd overwing-drill
alias overwing-drill="node $PWD/src/cli.ts"
```

Or as a container:

```
docker pull ghcr.io/frod27/overwing-drill
alias overwing-drill='docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD":/work -w /work -e OVERWING_API_KEY ghcr.io/frod27/overwing-drill'
```

To build the image from this source instead: `docker build -t overwing-drill https://github.com/frod27/overwing-drill.git`.
In the container the runner sees only what you mount: a directory surface must be mounted too, at
the path the scope names.

## Run a drill

```
overwing-drill keygen --out keys            # once; keep drill-private.pem away from the runner
#   create the drill on Overwing with keys/drill-public.pem; put its id in your scope file
overwing-drill sign  --scope scope.json --key keys/drill-private.pem
overwing-drill check --scope scope.signed.json
OVERWING_API_KEY=... overwing-drill run --scope scope.signed.json --alerts alerts.jsonl
overwing-drill stop                         # the kill switch, from another shell
```

`sample/` holds a scope to start from, and a staging stack to try a first drill on: a scratch
directory every agent can read in full, and a key-value service that shows each agent only its own
entries (`sample/docker-compose.yml`). A drill against both shows coordination emerging on the first
and not on the second.

## What stops a drill

- No scope, an unsigned one, one changed after signing, one signed with another key, or an expired
  one: the drill does not start.
- Anything that looks like production (the environment's name, a host's name, a public host the
  scope does not acknowledge, or `NODE_ENV=production` and its relatives in the runner's own
  process): the drill does not start.
- A surface that does not answer when the runner opens it: the drill does not start.
- The kill switch: Ctrl-C or a container stop, the stop file, or stopping the drill on Overwing.
  The fleet is reported stopped within five seconds. If Overwing cannot be reached for ten seconds,
  the runner stops by itself.
- The scope's limits on agents, tokens and wall-clock time, each under a ceiling no scope can raise
  (100 agents, 5,000,000 tokens, one hour).
- No call waits forever: a surface has ten seconds to answer and Overwing has twenty.

`npm test` covers the scope refusals, the limits and the kill switch.

## What leaves your environment

Events: the name of a surface, the name of an entry, the name of an agent, the operation, a time, a
SHA-256 hash and a size. Never the contents of anything. Your alert log, if you pass one, is read
here and is not sent: only a count, and for each incident whether an alert matched.

## A model-driven fleet

Run `npm install` first: a model-driven fleet uses `@anthropic-ai/sdk`. Set `fleet.mode` to
`"model"`, give `limits.max_tokens`, and name the model API's host in `model_host`
(`api.anthropic.com`). The agents run on `claude-opus-5-5` at low effort unless `fleet.model` names
another model. Your model key is read from your environment by the SDK and is never sent to
Overwing. A response the model declines ends that one worker; nothing is retried.

## License

MIT.
