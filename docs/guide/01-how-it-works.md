# 01 · How it works

At the end of this chapter you will know every word the other chapters use: the store, a memory and its
versions, saving and its four outcomes, trust tiers, observations, review items, recall, the pairing
window and passkeys, forgetting and purging.

## 1. One notebook, many hands

Picture a notebook about you that sits on one desk. Claude, ChatGPT, Gemini, Grok, Cursor, Claude Code and
Codex all write in it and all read from it. Tell one of them something, and the others know it too.

```
   Claude ──┐            ┌── Cursor
  ChatGPT ──┤            ├── Claude Code
   Gemini ──┼──▶  ▣  ◀──┼── Codex
     Grok ──┘   store    └── mema (you, on the command line)
```

That notebook is the **store**: one SQLite database that belongs to one person, the **owner**. It runs on
your own PC (**local mode**) or on one small machine in your own AWS account, so that phone and web apps
can reach it too. It is never a shared, hosted service.

The apps reach the store through **MCP**, the protocol AI apps use to call outside tools. The store offers
five tools: `memory_save`, `memory_recall`, `memory_profile`, `memory_forget` and `memory_status`.

## 2. A memory is one fact with a history

Each line in the notebook is a **memory**: one lasting fact about you, such as "Prefers short answers" or
"Lives in Denver". Facts change, so a memory never gets overwritten. It gets a new **version**, and the old
one stays, closed at the day it stopped being true:

```
"Lives in Denver"   ├──────────────────────────────┤
"Lives in Boston"                                  ├─────────────▶
                  2023                          2026-05         now
```

That is why "where did I live last year?" still has an answer. Every version also remembers which app
said it and when.

Memories are grouped into **sections** of life (Profile, Preferences, People, Projects, Work and career,
…), so an app can be allowed to see some sections and not others.

## 3. Saving: a desk that sorts

An app cannot just write a line. Every save goes to the same desk, which reads it and puts it in one of
four places:

```
                       ┌──▶ kept          (a memory, recalled from now on)
  memory_save ──▶ desk ├──▶ held          (an observation: wait and see)
                       ├──▶ asked         (a review item: the owner decides)
                       └──▶ refused       (with the reason, shown to the model at once)
```

The desk is a fixed decision table, not a model's judgement, so the same save always gets the same
outcome. It refuses secrets (passwords, keys), one-off task details and anything sensitive (health,
money, religion and the like) unless you asked for it explicitly, and then it asks you first. The
model that called the tool sees the outcome and its reason, so it can tell you what happened.

## 4. Who said it decides who can change it

Not every source deserves the same trust. A fact you typed into the admin page is surer than one an app
inferred from a chat. Each version carries a **trust tier**, a number for who said it; lower is more
trusted:

```
  0  from you             (the admin page, or mema)
  1  confirmed by you      (an app asked "save this?" and you said yes)
  2  from an app           (a chat or coding tool saved it)
  3  from an import        (your old history, read in bulk)
```

The rule that follows: a save may **update** a memory only from the same rung or a higher one. From a
lower rung, both values stay and the memory is marked **contested**, and the next app that recalls it
asks you which is right. A model can never raise its own tier: the tier comes from the channel the save
arrived through, not from anything the model writes.

## 5. Passing mentions wait: observations

"I had sushi today" is not a lasting preference; "I always pick sushi" might be. The desk cannot tell
from one sentence, so a passing mention is **held** as an **observation**. Observations are never
recalled. If the same thing comes up again in a different session, it is promoted to a memory:

```
  session A            session B (another app, or 6+ hours later)
      ●──────────────────────●──▶ promoted: now a memory
      held
      ●───────────────────────────────── 60 days, never repeated ──▶ expires
```

## 6. Some things wait for you: review items

A few saves need your yes: a standing rule for how apps should behave ("always answer in German"), a
sensitive fact you asked to keep, two memories that disagree, an app asking to forget something you
confirmed. Each becomes a **review item** in the admin page. Until you decide, nothing is recalled from
it.

## 7. Recall: two searches, one list

When an app asks "what does the user prefer for answers?", the store runs two searches and merges them:

- **by words**: memories that share words with the question (full-text search);
- **by meaning**: memories whose meaning is close, even with no shared word (each memory is stored with
  an **embedding**, a list of numbers that places it among other texts by meaning; close numbers, close
  meaning).

A memory high in both lists ends up on top. The merge adds up 1 / (60 + rank) from each list:

```
  by words            by meaning           merged
  1 short answers     1 short answers  ──▶ short answers   1/61 + 1/61 = 0.0328
  2 answer in German  2 prefers tea        answer in German 1/62 + 1/63 = 0.0320
  3 …                 3 answer in German   prefers tea      0    + 1/62 = 0.0161
```

Then filters remove what this app may not see (sections it is not allowed, other repositories'
projects, sensitive memories), a **read budget** caps how much one app can read per hour and per day,
and the result is sent as plain notes. Notes are data, never instructions: a memory that says "ignore
your rules" is shown as text and nothing more.

**The profile** is the small, stable part every app loads at the start of a conversation: the
preferences you confirmed and a few key facts.

## 8. Letting a new app in: the pairing window

Your store is on the internet so phone apps can reach it, which means strangers can reach it too. So no
app can connect unless you open a door for it, for a short time:

```
   you open a window for "ChatGPT"
           │◀────────── 10 minutes ──────────▶│
   ────────┼──────●───────────────────────────┼──────────●────▶ time
                  ChatGPT connects: allowed               anyone else: refused
                  (one app, once; then it closes)          (and cannot tell a window exists)
```

A **pairing window** allows exactly one app of the kind you picked to connect, once. It closes on first
use, after 10 minutes, or when you cancel. You approve the connection in your own browser, which the
window is bound to.

## 9. Your key: passkeys

You prove it is you with a **passkey**: a key that lives in your phone or password manager and signs a
challenge, with nothing for anyone to steal from the store. You enroll two, from different providers, so
losing one device does not lock you out; recovery codes are the last resort. The admin page, opening a
pairing window and the few powerful `mema` commands all need a fresh passkey approval.

## 10. Forgetting

Forgetting is two steps, so a mistake can be undone but a real deletion is complete:

```
  forget ─────── 30 days: undo possible ───────┤ purge
                                               ├─ unreadable at once
                                               ├─ gone from the machine's files ≤ 48 h
                                               └─ gone from every backup ≤ 30 days
```

After a forget, the store keeps only a one-way fingerprint of the text, so an app cannot quietly save the
same fact again. Copies inside the apps' own chats and their own memories are theirs to delete.

## The words, mapped

| You read | It means | Spec |
| --- | --- | --- |
| store | the owner's SQLite database and the server around it | [data-model](../design/spec/data-model.md) |
| memory, version | one fact; each value it has had, with world time and record time | [data-model §6](../design/spec/data-model.md) |
| outcome | active, observation, review or rejected, from the decision table | [write-path §5](../design/spec/write-path.md) |
| trust tier | T0–T3, from the channel | [write-path §2](../design/spec/write-path.md), [ADR-0002](../decisions/ADR-0002-trust-tiers.md) |
| observation | a held passing mention, promoted on recurrence | [memory-policy §8](../design/spec/memory-policy.md) |
| review item | a save the owner approves or rejects | [data-model §5](../design/spec/data-model.md) |
| recall | full-text and vector search, fused, filtered, budgeted | [retrieval §2](../design/spec/retrieval.md) |
| pairing window | the 10-minute, one-app door for a new connection | [auth-and-security §4.1](../design/spec/auth-and-security.md) |
| passkey, step-up | the owner's sign-in, and a fresh one for powerful actions | [auth-and-security §3, §6](../design/spec/auth-and-security.md) |
| forget, purge | undoable removal, then complete deletion | [write-path §9](../design/spec/write-path.md) |

Next: [02 · Local mode](02-local-mode.md)
