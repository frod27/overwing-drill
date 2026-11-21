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

The image is built from a base image named by its digest, and installs its one dependency exactly
as `package-lock.json` records it, with `npm ci --ignore-scripts`: no package's install script runs.
To run the same image every time yourself, note the digest `docker pull` prints and use it in place
of the name: `ghcr.io/frod27/overwing-drill@sha256:...`.

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

### Where the key goes

The runner sends `OVERWING_API_KEY`, and everything else it sends, to one address: the one given
with `--overwing-url`, else the `OVERWING_URL` environment variable, else `https://overwing.ai`. It
never takes that address from the scope file. The scope's `overwing_url` is only compared with it:
if the scope names another address, `check` and `run` refuse, name both addresses, and send nothing.
The key that a scope's signature is checked against comes from the same address, so a scope file
that somebody edited cannot point the runner at a server that vouches for it.

Most drills need neither the flag nor the variable. If your Overwing is at another address:

```
overwing-drill check --scope scope.signed.json --overwing-url https://overwing.example
OVERWING_API_KEY=... overwing-drill run --scope scope.signed.json --overwing-url https://overwing.example
```

The address must be `https`. Plain `http` is accepted only for `localhost`, `127.0.0.1` and `[::1]`.
The container alias above does not pass `OVERWING_URL` through: give the flag, or add
`-e OVERWING_URL` to the alias.

## What stops a drill

- No scope, an unsigned one, one changed after signing, one signed with another key, or an expired
  one: the drill does not start.
- A scope that names another Overwing address than the runner's own, or an address for Overwing
  that is not `https`: the drill does not start, and nothing is sent.
- Anything that looks like production (the environment's name, a host's name, a public host the
  scope does not acknowledge, or `NODE_ENV=production` and its relatives in the runner's own
  process): the drill does not start.
- A host that is neither a name nor an address written out in full. `2130706433`, `0x7f000001`,
  `0177.0.0.1` and `127.1` are numbers that stand for an address they do not show: each is refused as
  not a host name, in `hosts` and in a surface's address. Write `127.0.0.1`. A name with no dot, like
  `kv`, starts with a letter.
- A surface that does not answer when the runner opens it: the drill does not start.
- The kill switch: Ctrl-C or a container stop, the stop file, or stopping the drill on Overwing.
  The fleet is reported stopped within five seconds. If Overwing cannot be reached for ten seconds,
  the runner stops by itself.
- The scope's limits on agents, tokens and wall-clock time, each under a ceiling no scope can raise
  (100 agents, 5,000,000 tokens, one hour).
- No call waits forever: a surface has ten seconds to answer and Overwing has twenty.

`npm test` covers the scope refusals, the address the key is sent to, links in a directory surface,
the limits and the kill switch.

## A directory surface stays in its directory

A key is a path under the surface's directory. One with a `..` part, or one that starts with `/`,
is refused. A symbolic link does not lead out either. The directory's real path is found once for
the whole drill, when the runner first opens the surface, and after that:

- a listing skips every link, so the fleet is never shown one or what is behind it;
- an entry is read through a link only if it ends inside the directory;
- nothing is written or deleted through a link, wherever it points.

If your scratch directory relies on links, the fleet does not see what is behind them.

## What leaves your environment

Events: the name of a surface, the name of an entry, the name of an agent, the operation, a time, a
SHA-256 hash and a size. Never the contents of anything. Your alert log, if you pass one, is read
here and is not sent: only a count, and for each incident whether an alert matched.

## A model-driven fleet

Run `npm ci --ignore-scripts` first: a model-driven fleet uses `@anthropic-ai/sdk`, and that installs
the version `package-lock.json` records without running any package's install script. Set `fleet.mode` to
`"model"`, give `limits.max_tokens`, and name the model API's host in `model_host`
(`api.anthropic.com`). The agents run on `claude-opus-5-5` at low effort unless `fleet.model` names
another model. Each agent gets a ticket of its own that leans on something it was not handed, as
real tickets do; nothing tells it where to look or to work with the others. Your model key is read
from your environment by the SDK and is never sent to Overwing. A response the model declines ends that one worker; nothing is retried.

## License

MIT.
