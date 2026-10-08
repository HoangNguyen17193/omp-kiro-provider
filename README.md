# omp-kiro-provider

Use your [Kiro](https://kiro.dev) account's models inside [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`).
The plugin adds a `kiro` provider: device-code `/login` (AWS Builder ID or IAM
Identity Center), account-scoped model discovery, and streaming with tool calls
and thinking.

Requires OMP 18.2.6 or newer.

## Install

```sh
omp plugin marketplace add HoangNguyen17193/omp-kiro-provider
omp plugin install omp-kiro-provider@omp-kiro-provider
```

Restart `omp` after installing.

> **Do not** load this alongside another Kiro provider plugin (for example
> `omp-kiro` or `pi-provider-kiro`). They all register the same `kiro` provider
> id and will conflict.

## Log in

Step-by-step walkthrough of each prompt, plus troubleshooting:
[docs/login.md](docs/login.md). Short version, inside `omp`:

1. Run `/login` and choose **Kiro (AWS Builder ID / IAM Identity Center)**.
2. **Start URL**
   - Leave blank for a personal **AWS Builder ID** (free plan).
   - Or paste your organisation's IAM Identity Center start URL, e.g.
     `https://<your-org>.awsapps.com/start`. Use this if your company pays for Kiro.
3. **Region** (Identity Center only): the region that hosts your Identity
   Center directory, e.g. `us-east-1`. Leave blank to auto-detect.
4. Approve the code in the browser page that opens.

OMP stores and refreshes the credential in its own login store. The plugin never
writes tokens anywhere else.

## Pick a model

```sh
omp models refresh        # fetch the model list for your account
omp models kiro           # list your Kiro models
omp --model kiro/<model-id>
```

Inside a session, `/model` and search for `kiro`.

The model list comes from Kiro and depends on your plan: a free Builder ID
account sees a small set of older models, while paid plans (Pro, Pro Max) add
the newer Claude and GPT models with thinking controls.

## Check your credits

Inside an `omp` session, run `/usage`. The Kiro section shows your plan, credits
used out of your monthly allowance, credits remaining, and the reset date (plus
bonus credits when your account has them). With several Kiro logins saved, each
account is listed under its own email.

> The standalone `omp usage` command on OMP 18.2.x does not load plugins, so it
> prints "no usage data" for Kiro. Use `/usage` inside a session instead.

## Troubleshooting

- **Only old models show up.** You are probably signed in with a free Builder ID,
  or you have several Kiro logins saved. OMP builds the model list from one of
  them, so run `/logout`, remove every Kiro login except the one you want, then
  `omp models refresh`.
- **"No Kiro profile is available for this account".** Your Identity Center user
  has no Kiro subscription yet. Ask your AWS administrator.
- **Models disappear after a day.** Run `omp models refresh`; selecting a model
  also refreshes an expired token.

## Not built yet

- Reusing an existing `kiro-cli` login
- Google / GitHub social login
- Mapping tool names that Opus-class models sometimes invent
- Images inside tool results (sent as an `[image omitted]` marker)
- Thinking controls for models whose catalog entry carries no reasoning schema

## Development

```sh
bun install
bun run check     # typecheck + build dist/extension.js + tests
```

`dist/extension.js` is committed on purpose: marketplace installs clone the
repository without installing dependencies, so the bundle carries `zod` and
leaves `@oh-my-pi/*` to the host. Run `bun run check` before every commit so the
bundle matches `src/`.

Tests never touch the network; they use fake transports.

## How it works

- **Login:** AWS SSO-OIDC device authorization (RFC 8628) against
  `oidc.<region>.amazonaws.com`.
- **Profile:** `List-Available-Profiles` on `management.<region>.kiro.dev`; Builder
  ID accounts fall back to Kiro's public Builder ID profile.
- **Models:** `List-Available-Models`, scoped to the profile. Discovery fails
  rather than returning an empty list when the token is missing or expired, so
  OMP keeps its cached catalog.
- **Identity:** `Get-Usage-Limits` (with `isEmailRequired=true`) names the
  signed-in user. The plugin stores the user id as the credential's `accountId`
  and the email beside it, at login and on the first refresh of an older login,
  so OMP tells accounts apart and replaces the row when the same user signs in
  again. Usage reports carry the same `email`/`accountId`.
- **Streaming:** `runtime.<profile region>.kiro.dev/generateAssistantResponse`,
  AWS EventStream frames with CRC checks, first-event (180 s) and idle (300 s)
  stall timeouts. History is normalized to Kiro's turn, pairing, and unique-id
  rules before sending.

The wire behaviour was reimplemented from the open-source
[omp-kiro](https://github.com/fanbaoyu1024/omp-kiro) and
[pi-provider-kiro](https://github.com/mikeyobrien/pi-provider-kiro) clients; no
code was copied.

## License

MIT
