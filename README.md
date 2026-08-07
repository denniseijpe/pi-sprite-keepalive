# pi-sprite-keepalive

A [pi](https://github.com/earendil-works/pi-mono) extension that prevents a
[Sprite](https://sprites.dev/) from going to sleep while pi is actively working.

The extension creates a short-lived Sprite task when an agent run starts,
refreshes it once per minute, and removes it after the agent settles. Each pi
process uses a unique task name, so concurrent sessions do not release one
another's keepalive tasks.

Outside a Sprite, where `/.sprite/api.sock` is absent, the extension does
nothing.

## Install

```sh
pi install npm:pi-sprite-keepalive
```

To try it for one invocation without installing it:

```sh
pi -e npm:pi-sprite-keepalive
```

After the repository is pushed to a Git host, it can also be installed from
that repository with `pi install git:<repository-url>`.

## Behavior

- Starts a task with a five-minute expiry on `agent_start`.
- Refreshes the task every minute while pi is working.
- Deletes the task on `agent_settled` or `session_shutdown`.
- Shows `sprite: awake` in pi's status line while active.
- Warns once if heartbeats fail; failed cleanup is left to expire naturally.

The extension communicates only with the local Sprite Tasks API through
`/.sprite/api.sock`.

## Development

```sh
npm install
npm run check
npm pack --dry-run
```

The package ships its TypeScript entry point directly; pi loads TypeScript
extensions without a build step.

## Publishing

1. Confirm that the package name and metadata in `package.json` are correct.
2. Authenticate with npm using `npm login`.
3. Run `npm publish`.

## License

MIT
