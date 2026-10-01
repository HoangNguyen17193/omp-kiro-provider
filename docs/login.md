# Signing in to Kiro from OMP

This guide gets you from a fresh OMP install to chatting with your Kiro models.
It takes about five minutes.

## Before you start

- **OMP 18.2.6 or newer.** Check with `omp --version`.
- **A Kiro account**, one of:
  - your company's **IAM Identity Center** account (use this if your company pays
    for Kiro — you get the paid model list), or
  - a personal **AWS Builder ID** (free plan, smaller model list).
- If you sign in through your company, have two things ready (your AWS
  administrator or the Kiro invite email has them):
  - the **start URL**, which looks like `https://<your-org>.awsapps.com/start`;
  - the **region** that hosts your Identity Center directory, e.g. `us-east-1`.

## 1. Install the plugin

```sh
omp plugin marketplace add HoangNguyen17193/omp-kiro-provider
omp plugin install omp-kiro-provider@omp-kiro-provider
```

Restart `omp` so it loads the plugin.

> Only one Kiro plugin can be loaded at a time. If you have `omp-kiro`,
> `pi-provider-kiro`, or another Kiro provider installed, uninstall it first —
> they all claim the same `kiro` provider name.

## 2. Log in

Start `omp`, then type:

```text
/login
```

Choose **Kiro (AWS Builder ID / IAM Identity Center)** from the list.

You will see up to two questions.

### Question 1 — start URL

```text
IAM Identity Center start URL (leave blank for AWS Builder ID)
```

| You want to use… | Type |
|---|---|
| Your company account | your start URL, e.g. `https://<your-org>.awsapps.com/start` |
| A personal Builder ID | nothing — just press Enter |

### Question 2 — region (company accounts only)

```text
Identity Center region (leave blank to detect)
```

Type your directory's region, e.g. `us-east-1`. If you leave it blank, the plugin
tries the common regions one by one; typing it is faster and avoids picking the
wrong one. Builder ID logins skip this question.

### Approve in the browser

OMP prints a link and a short code:

```text
Approve the request in your browser. Code: ABCD-EFGH
Waiting for approval…
```

1. Open the link (OMP may open it for you).
2. Check that the code on the page matches the one in OMP.
3. Sign in — with your company credentials for Identity Center, or your Builder
   ID email for a personal account.
4. Click **Allow access**.

Back in OMP the login finishes on its own. The code expires after about ten
minutes; if it does, run `/login` again.

OMP saves the login in its own credential store and refreshes it automatically.
The plugin never writes your token anywhere else.

## 3. Check your models

```sh
omp models refresh
omp models kiro
```

What you should see depends on your plan:

- **Paid plan (Pro, Pro Max, company account):** around 20 models, including
  `claude-opus-5.5`, `claude-sonnet-5`, and `gpt-5.6-sol`, with thinking levels
  such as `low,medium,high,xhigh,max`.
- **Free Builder ID:** about 9 older models (`claude-sonnet-4.5`,
  `claude-haiku-4.5`, `deepseek-3.2`, …) with no thinking levels.

If you expected the paid list and got the free one, see
[Troubleshooting](#troubleshooting).

## 4. Use a model

Inside a session:

```text
/model
```

Search for `kiro` and pick one. Or start OMP with a model directly:

```sh
omp --model kiro/claude-sonnet-5
```

## Switching or removing accounts

OMP builds the Kiro model list from **one** saved Kiro login, and it can rotate
requests across all of them. So keep only the account you want:

1. In `omp`, type `/logout`.
2. Choose **Kiro** and remove the logins you no longer want.
3. Run `/login` for the account you do want, if it isn't saved already.
4. Run `omp models refresh`.

## Check your credits

Inside a session, run `/usage` to see your plan, credits used and remaining, and
when they reset. (The standalone `omp usage` command doesn't load plugins on OMP
18.2.x, so it shows "no usage data" for Kiro.)

## Troubleshooting

**Only the old models show up.**
You are signed in with a free Builder ID, or a Builder ID login is still saved
next to your company login. Remove every Kiro login except your company one with
`/logout`, then `omp models refresh`.

**"No Kiro profile is available for this account".**
Your Identity Center user exists but has no Kiro subscription. Ask your AWS
administrator to assign you Kiro access.

**"Not a valid start URL" or "Not an AWS region".**
Check for typos. The start URL must be a full `https://…` address; the region
looks like `us-east-1`.

**"Kiro login timed out before the device code was approved".**
The browser step took longer than the code's lifetime. Run `/login` again and
approve promptly.

**The Kiro models disappeared.**
Run `omp models refresh`. Choosing a Kiro model also refreshes an expired token,
after which the list comes back.

**Strange errors right after installing.**
Another Kiro plugin is probably loaded too. Run `omp plugin list` and keep only
`omp-kiro-provider`.
