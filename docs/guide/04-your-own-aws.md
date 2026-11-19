# 04 · Your own AWS

At the end of this chapter your store runs on one small server in your own AWS account, at your own
address, so phone and web apps can connect to it.

> **Came here from an error?** Find its words below and jump to the step it is about.
> `the CDK bootstrap … is missing` or `the account IMDS default is not IMDSv2`: [§4 The one-time bootstrap](#4-the-one-time-bootstrap). `checking the SSO sign-in` or `not signed in with the memory-anywhere-deploy permission set`: [§5 Sign in on the PC](#5-sign-in-on-the-pc).
> `Next, in CloudShell as ma-operator`: [§8 First-time setup](#8-first-time-setup). `release.pub is missing`: reinstall with `npm install -g memory-anywhere`.

## 1. Why a server, and why its own account

Chat apps call your store from their own servers on the internet ([03 §1](03-connect-apps.md)), so the
store must be reachable there. `mema deploy aws` builds that: one small machine (an EC2 `t4g.small`)
with the store on an encrypted disk and a continuous backup to S3.

Where it lives matters as much. Picture your AWS account as a house that already holds other things. You
would not give the builder of a new shed a key to the whole house. So the store gets an apartment of its
own: a separate **member account** in an **AWS Organization**, with its own lock and its own bill.
Nothing in it can touch your other workloads, and its bill is the store's whole cost
([ADR-0025](../decisions/ADR-0025-dedicated-member-account.md)):

```
 AWS Organization
 ┌─ management account (your existing one) ──┐      ┌─ member account "memory-anywhere" ──┐
 │                                           │      │                                     │
 │  your other workloads: untouched          │      │  the server, its disk, its backups, │
 │                                           │      │  its keys and settings              │
 │  Identity Center: the two users ──────────┼─────▶│  the users' rights land here only   │
 └───────────────────────────────────────────┘      └─────────────────────────────────────┘
```

**IAM Identity Center** is AWS's sign-in service for people: it holds users, and **permission sets**
(named bundles of rights) that you assign to a user in one account.

## 2. Two users, two places

The rights split in two. One user, `ma-deploy`, may build and change the server but never read your
memories. The other, `ma-operator`, may do the few things that touch data (the setup link, the model
key, a restore) but never change the server. Each signs in from one place only:

```
                         on your PC                       in AWS CloudShell (a browser tab)
 ma-deploy               ● builds and updates the server   ✕
 ma-operator             ✕ never set up here               ● setup link, model key, restore,
                                                             owner reset
 a hijacked agent        reaches the left column only:     ✕
 on your PC              it can change the server, and
                         every change emails you
```

Why two users and not two roles for one user: the AWS command line keeps a user's sign-in on the PC and
can turn it into credentials for **every** permission set that user holds. Two sets on one user would
put the operator's rights on the PC too. Separate users, with the operator used only in **CloudShell**
(a terminal AWS runs for you inside the console), keep them apart
([ADR-0113](../decisions/ADR-0113-identity-center-separation-and-operator-path.md),
[ADR-0020](../decisions/ADR-0020-aws-operator-separation.md)).

The steps happen once, in this order, and only updates repeat:

```
 once, in order                                                                 then, when needed
 ──●──────────────●──────────────●──────────────●────────────────●──────────────┼──●─────●─────▶
   organization   AWS CLI        bootstrap      deploy           passkeys,      │  update update
   and users      profile        (2 scripts)    and DNS          model key      │
   §3 console     §3 PC          §4 CloudShell  §5–§7 PC         §8 CloudShell  │  §9 PC
```

## 3. The one-time AWS steps

You need: an AWS account you sign in to as its root user or an administrator; an email inbox that
accepts plus addresses (`you+ma-deploy@example.com` arriving at `you@example.com`); a domain whose DNS you
control, under which the store gets a subdomain such as `memory.example.com`.

**A. In the console of your existing account** (it becomes the management account):

1. **AWS Organizations → Create an organization** (all features). Your existing workloads do not change.
2. **AWS Organizations → Add an AWS account → Create an AWS account**: name `memory-anywhere`, email
   `you+ma-aws@example.com`. Leave its root user without a password; it is only for emergencies.
3. **IAM Identity Center → Enable**, in the region where you want to sign in. Note this region: it is
   the **Identity Center region**. It must say **organization instance**. In its settings: identity
   source "Identity Center directory", MFA (a second proof besides the password, such as a passkey or
   an authenticator code) required at every sign-in, session duration 1 hour.
4. **Identity Center → Users**: add `ma-deploy` (`you+ma-deploy@example.com`) and `ma-operator`
   (`you+ma-operator@example.com`). Each accepts its invitation, sets a password and registers its own
   MFA device (for example this PC's Windows Hello for `ma-deploy`, your phone or a hardware key for
   `ma-operator`).
5. **Identity Center → Permission sets → Create permission set → Predefined permission set →
   AdministratorAccess**, session 1 hour. It is needed only for §4, which removes its assignment again.
6. **Identity Center → AWS accounts →** `memory-anywhere` **→ Assign users or groups →** `ma-operator`
   **→** `AdministratorAccess`.

**B. On your PC:** install AWS CLI v2, `minisign` (it checks the signature of each server release) and
`mema` (`npm install -g memory-anywhere`, Node 24 or newer). Then add this to `~/.aws/config`
(Windows: `%USERPROFILE%\.aws\config`), with your access portal URL, your Identity Center region, the
member account's 12-digit id and the region the server will run in:

```ini
[sso-session ma-deploy]
sso_start_url = https://<your-identity-center>.awsapps.com/start
sso_region = <identity-center-region>
sso_registration_scopes = sso:account:access

[profile memory-anywhere-deploy]
sso_session = ma-deploy
sso_account_id = 111122223333
sso_role_name = memory-anywhere-deploy
region = us-east-1
output = json
```

Nothing for `ma-operator` goes on the PC.

## 4. The one-time bootstrap

`ma-deploy` cannot write IAM policies (AWS's written rules of who may do what) or change account
defaults, by design, so two reviewed scripts do that once. Each prints what it will do and waits until you type `yes`; each is safe to run again.

1. **The member account.** Sign in to the access portal as `ma-operator`, choose the `memory-anywhere`
   account with **AdministratorAccess**, open the console, then **CloudShell** (top bar). Get the
   scripts from the release you reviewed, and run the first one with the member account id and the
   server's region:

   ```bash
   git clone https://github.com/<repo>.git memory-anywhere
   cd memory-anywhere
   git checkout v<version>
   bash deploy/aws/bootstrap-member.sh 111122223333 us-east-1
   ```

   It creates the policies `memory-anywhere-cfn-exec`, `memory-anywhere-cfn-exec-services` and
   `memory-anywhere-boundary` (the most that anything the deploy creates may ever do), prepares the
   account for the deploy tool (`cdk bootstrap` with those policies), requires the safer metadata service (IMDSv2) for
   every new machine, and blocks public S3 access for the whole account. It ends with
   `Done. Next: bootstrap-identity.sh in the management account`.

2. **The management account.** Sign in to the management account's console as its root user or an
   administrator, open CloudShell there, clone and check out the same version, and run:

   ```bash
   bash deploy/aws/bootstrap-identity.sh 111122223333 <identity-center-region>
   ```

   It shows the Identity Center region and instance it found; check them, type `yes`. It creates the
   permission sets `memory-anywhere-deploy` and `memory-anywhere-operator` (1-hour sessions), gives each
   to its user in the member account only, removes the temporary AdministratorAccess, and ends with
   `OK: exactly the two expected assignments.`

## 5. Sign in on the PC

Each deploy starts with a sign-in as `ma-deploy`, valid for one hour:

```shell
aws sso login --sso-session ma-deploy --use-device-code
```

It prints a URL and a code. Open the URL in a browser window that is **not** signed in to the access
portal as `ma-operator` (a normal window, or another browser), check the code, and sign in as
`ma-deploy`. Approving in the operator's window would give the PC an operator sign-in, which `mema`
refuses with `not signed in with the memory-anywhere-deploy permission set`.

## 6. Deploy

1. Tell `mema` your address and where alerts go. They stay on your PC and are never written into any
   repository.

   ```powershell
   $env:MA_DOMAIN = "memory.example.com"
   $env:MA_ALERT_EMAIL = "you@example.com"
   ```

   ```bash
   export MA_DOMAIN=memory.example.com
   export MA_ALERT_EMAIL=you@example.com
   ```

2. Deploy, naming the server release to run. Use the version `mema --version` prints: the server
   refuses a client of a different major.minor version.

   ```shell
   mema deploy aws --stage prod --release <version>
   ```

   You see, in order: the sign-in and bootstrap checks; the deploy tool's list of every resource it will
   create; the question `Deploy MemoryAnywhere-prod with the changes above? [y/N]`. Answer `y`. Building
   takes several minutes. Then the release is downloaded, its signature checked against the committed
   release key, and uploaded: `Release <version> … uploaded and set as desired`.

3. The deploy now prints the DNS records to add and waits for them (§7). Once both names resolve, it
   waits for the server to answer (up to 15 minutes; the first certificate takes a minute) and prints
   `Healthy: <version>`.

4. It ends with what is left for you, and signs the PC out of AWS:

   ```
   Next, in CloudShell as ma-operator (…04-your-own-aws.md):
     ./ma-operator.sh setup-link --stage prod
     ./ma-operator.sh set-llm-key --stage prod
   Confirm the SNS subscription email AWS sent to the alert address.
   Signed out of the deploy SSO session.
   ```

## 7. DNS records

Your domain's DNS points the two names at the server's fixed address (its **Elastic IP**, kept for as
long as the server exists). The deploy prints them with that address, for example:

```
  A    memory.example.com        ->  203.0.113.10   DNS only (grey cloud), TTL Auto
  A    admin.memory.example.com  ->  203.0.113.10   DNS only (grey cloud), TTL Auto
  CAA  memory.example.com  0 issue "letsencrypt.org"   (once; keep it when stacks are destroyed)
```

Add all three at your DNS provider. The deploy checks every 30 seconds and goes on once both names point
at the server (it gives up after 60 minutes; run it again with `--update`).

- **DNS only, never proxied.** "Proxied" (Cloudflare's orange cloud) puts the provider in the middle:

  ```
  DNS only:  the app ════════════ encrypted ═════════════▶ your server
  proxied:   the app ═══ encrypted ═══▶ provider ═══ encrypted ═══▶ your server
                                        ▲ reads every token and memory; cuts long requests at 100 s
  ```

  The deploy notices a proxied record and says so: `the record is proxied; set it to DNS only (grey
  cloud)`.
- **Two names.** The admin page lives on its own name, `admin.`, so a page on one can never act as the
  other ([ADR-0024](../decisions/ADR-0024-dns-at-cloudflare.md)).
- **CAA** names the only certificate authority allowed to issue certificates for your names. The server
  gets its certificates from Let's Encrypt by itself; the record stops anyone else from getting one.
  Every deploy warns while it is missing.

## 8. First-time setup

The new store has no owner yet. You claim it with a one-time link that only `ma-operator` can read.

1. Open a private browser window, sign in to the access portal as `ma-operator`, choose `memory-anywhere`
   and `memory-anywhere-operator`, open the console, then **CloudShell**.

2. Get the operator script of your version and check it against the release's checksums. CloudShell
   keeps your home folder, so this is once per version.

   ```bash
   curl -fsSLO https://github.com/<repo>/releases/download/v<version>/ma-operator.sh
   curl -fsSLO https://github.com/<repo>/releases/download/v<version>/SHA256SUMS
   sha256sum -c --ignore-missing SHA256SUMS
   chmod +x ma-operator.sh
   ```

   The check prints `ma-operator.sh: OK`.

3. Get the setup link:

   ```bash
   ./ma-operator.sh setup-link
   ```

   It prints `Open this link in a private window (valid until …)` and a link to
   `https://admin.memory.example.com/setup#…`. If the link expired, run the command again; it issues a
   fresh one.

4. Open the link in a private window and follow the page:
   - **First passkey.** Create it with your phone, password manager or security key.
   - **Second passkey, from a different provider** (for example a hardware key and your PC's Windows
     Hello, or iCloud Keychain and Google Password Manager). One provider losing your account must not
     lock you out. Do not keep both in the Google account you use for Gemini.
   - **Ten recovery codes**, shown once. Store them offline, and type one back to show you did.

5. Give the store its language model key (an Anthropic API key). The store uses the model for a few
   decisions while saving and for reading imported history ([05](05-import-history.md)). The key is
   read without echo and never appears on a command line:

   ```bash
   ./ma-operator.sh set-llm-key
   ```

6. Confirm the subscription email AWS sent to your alert address, so alerts reach you.

7. Sign out of the portal. Connect your apps and this PC: chapter [03](03-connect-apps.md).

If you lose a passkey, sign in with the other one. To replace it, use a recovery code at
`https://admin.memory.example.com/recover`: it removes every passkey and lets you add two new ones,
and connected apps keep working. The **System** tab makes a new set of codes. If you lose the codes too,
`./ma-operator.sh reset-owner` starts a reset that takes effect after 24 hours, emails you at once, and
can be cancelled with `./ma-operator.sh reset-owner --cancel` or from the admin page; afterwards run
`setup-link` again.

## 9. Updates

Sign in (§5), then:

```shell
mema deploy aws --stage prod --update --release <version>
```

The server fetches the release within 2 minutes, checks its signature, copies the store aside, applies
any schema change and checks its own health; if the check fails it puts the old version back and emails
you (`update_failed`). Update `mema` on the PC to the same version, then run `mema init` again to update
the plugins:

```shell
npm install -g memory-anywhere@<version>
```

Every change to the server sends you an email, deploys included. An email you did not expect means
someone else changed it.

If an update would rebuild the server machine, the deploy stops with `this change replaces prod's
instance; nothing deployed`. A rebuilt machine restores the store from its backup
([06](06-restore-drill.md)); pass `--allow-replace` only when that is what you want.

## 10. Cost and alerts

Measured on a running store in `us-east-1`, per month:

```
 instance (t4g.small) ████████████▎                   $12.26  (free under AWS's t4g trial until 2026-12-31)
 public IPv4          ███▋                            $ 3.65
 S3 requests          ██▍                             $ 2.37  (an upper bound: the backup's uploads)
 EBS volume           █▋                              $ 1.60
 KMS key              █                               $ 1.00
 snapshots            ▌                               $ 0.46
 the month            █████████████████████▍          $21.40
 forecast alert       ────────────────────────┤       $25.00
 actual alert         ─────────────────────────────┤  $30.00
```

The stack sets up three alerts by email: when the month's forecast passes $25, when the actual bill
passes $30, and when AWS's anomaly detection sees more than $5 of unexpected spend in a day (an unusual
change shows up within a day, not at the end of the month). See the bill so far, per service:

```shell
mema cost aws
```

`--month 2026-11` shows another month. It signs you out afterwards, like a deploy.

## 11. Removing it

```shell
mema destroy aws --stage prod
```

It asks `Destroy MemoryAnywhere-prod (instance, Elastic IP)? [y/N]`, then prints the DNS records to
delete and waits until no name points at the server's address any more (checked every 30 seconds). Only
then does it release the address and delete the server. The order matters: a record left pointing at a
released address would let whoever gets that address next receive the traffic your apps send.

It keeps the backups, the release and audit buckets, the encryption key and the locked manifest bucket
(locked for 90 days, [06 §2](06-restore-drill.md)). Deleting the backups is deliberately hard: only the
member account's root user may do it, and `./ma-operator.sh delete-data --stage prod` prints the steps.
Keep the CAA record if you will deploy again.

Next: [05 · Import history](05-import-history.md)
