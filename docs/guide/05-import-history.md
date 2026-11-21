# 05 · Import history

At the end of this chapter your store knows what your apps already knew about you: their saved
memories, your instruction files and, if you want, your old chats.

## 1. Moving house, one box at a time

When you move, you do not tip every drawer into the new place. You open each box, keep what is yours and
still true, and leave the rest. An import does the same with what other apps hold about you:

- each item goes through the same desk as any save ([01 §3](01-how-it-works.md)), so it is kept, held,
  asked about or refused by the same rules;
- each kept item gets [trust tier](01-how-it-works.md) 3, the lowest: anything you or an app says later
  wins over it, and tier-3 memories are recalled but never enter your profile;
- the reading happens on your PC first. Only what survives the reading is uploaded.

## 2. What you can import

| Kind | `--source` | Where you get it | Lands as |
| --- | --- | --- | --- |
| An app's memory list | `claude-memory`, `chatgpt-memory`, `gemini-saved-info`; any other app: `paste --vendor <name>` | copy the list from the app's memory settings into a text file | one item per line, kept as memories |
| An app's memory summary | `chatgpt-memory-summary`, `gemini-memory-summary` | copy the summary page into a text file | split into facts by the model, kept as memories |
| Your instruction files | `claude-user-md` (`~/.claude/CLAUDE.md` and `~/.claude/rules/`), `codex-user-md` (`~/.codex/AGENTS.md`) | read from their usual place; give no file | one item per bullet or sentence, kept as memories |
| Coding tools' own notes | `claude-code-auto-memory`, `codex-memories` | read from their usual place | held as observations |
| Chat history | `chatgpt-history`, `claude-history` (the app's data export ZIP), `gemini-history` (Google Takeout of My Activity → Gemini Apps, JSON) | the app's export | facts found by the model, held as observations |

Why the last two rows only wait as [observations](01-how-it-works.md): coding tools write their notes
after reading web pages and tool output, so a planted instruction could hide in them; an old chat is
one passing mention. Either becomes a memory only if the same fact comes up again elsewhere.

An imported preference also creates a review item, so you can lift it into your profile with one tap.
Cursor keeps its user rules in its settings, not a file: copy them and use `paste --vendor cursor`.

## 3. Two passes: a count, then the real thing

Reading old chats costs money, because a language model reads them. So every import runs twice: once to
count and price it, once to do it.

```
 dry run                              commit (within 24 hours)
 ──●──────────────────────────────────────●──────────────●──────────────●──────────▶ time
   read and redact on this PC;            approval page: you type        upload; the model    report
   only counts go to the store,           the price in whole dollars     reads, the desk
   which returns the price                and approve with a passkey     sorts
```

1. Dry run. For example, a ChatGPT export:

   ```shell
   mema import chatgpt-export.zip --source chatgpt-history --dry-run
   ```

   It prints what it read and skipped, then the price (your numbers will differ):

   ```
   estimate: $3.12 (≈ 512,400 input + 61,800 output tokens; 0 cached); import budget left $50.00
   dry run recorded; within 24 hours, run the same command with --commit instead of --dry-run
   ```

   Only counts leave your PC in this pass. Lists and instruction files cost nothing: no model reads them.

2. Commit, with the same file:

   ```shell
   mema import chatgpt-export.zip --source chatgpt-history --commit
   ```

   `mema` prints a code and opens an approval page. The page shows the source, the file's fingerprint,
   the item count and the store's own price (worked out on the server, never taken from the PC). Type
   that price rounded up to whole dollars, and approve with your passkey. (Local mode has no approval
   page: the local token is already the owner's key, so the import starts at once.)

3. Watch it run. It uploads in parts (`uploaded 300/1,204 …`), then shows `extracting: 412 items left
   (cost so far $1.05)` until the model is done, and ends with the batch's status, its cost and what
   happened to each item.

Narrow a history with `--since <date>`, `--until <date>` and `--conversation-min-user-turns <n>`
(conversations with fewer of your messages are skipped; default 2). For a file in its usual place, leave
the file out: `mema import --source claude-user-md --dry-run`.

The model is the one you gave the store in [04 §8](04-your-own-aws.md). A store without one (local mode
starts without one) imports lists and instruction files; a history import there stops as `failed`.

## 4. The spending cap

Two limits stop an import, whichever comes first:

```
 $0        $10       $20       $30       $40       $50
 ├─────────┼─────────┼─────────┼─────────┼─────────┤   all imports together: never past $50
 ███▏┤                                                 this import: never past the $4 you typed
```

- **This batch** stops at the whole dollars you typed on the approval page.
- **All imports together** stop at $50, the store's `import_usd_cap` (in the `[llm]` part of
  `server.toml`).

The store counts the calls still waiting for the model as if they cost their worst case, so even calls
running side by side cannot pass either limit. A batch that reaches one stops as `aborted_budget`; what
it already read stays. To continue, approve a new amount:

```shell
mema import chatgpt-export.zip --source chatgpt-history --commit --resume <batch>
```

The same command continues an import cut off for any other reason (a closed laptop, an expired
approval); items already recorded are skipped.

## 5. What is kept and what is dropped

One message from an old chat, at each step of its way:

```
 the export     you:  "I moved to Boston last spring. My key is sk-ant-…"
                      > (a long pasted email)
                app:  "Congratulations on the move!"
 only yours     you:  "I moved to Boston last spring. My key is sk-ant-…"     the app's replies dropped;
                                                                              quoted text in long messages too
 redacted       you:  "I moved to Boston last spring. My key is [REDACTED:anthropic_key]"
 extracted      fact: "Lives in Boston"   from the words "moved to Boston"    a fact must quote your words
 the desk       → an observation: kept as a memory if it comes up again
```

What else is dropped or held:

- **Repository files are never read.** A cloned repository's `CLAUDE.md` or `.cursor/rules` was written by
  someone else; only your user-level files count.
- **memory-anywhere's own output** (anything marked `generated by memory-anywhere`) is skipped, so the
  store never re-imports itself.
- **Secrets** are redacted on your PC and again on the server.
- **Other people's private details** are refused. **Your own sensitive facts** (health, money, religion
  and the like) are held for your review; the review page can approve all of one import's at once.
- **Anything you forgot** is refused (`previously_forgotten`), so an app's old memory cannot bring it
  back.

## 6. Importing again

Every item gets a fingerprint from its source and its content. Run the same import twice, and the second
run changes nothing and costs nothing:

```
 first import        ● ● ● ● ● ● ● ● ● ●   10 new
 the same, again     ○ ○ ○ ○ ○ ○ ○ ○ ○ ○   10 already there: no change, no cost
 the list, edited    ○ ○ ○ ○ ○ ○ ○ ○ ○ ●   9 already there, 1 new
```

So keep the apps' own memories on, and re-import their lists now and then. The same fact, word for
word, from two apps adds a second source to one memory instead of a duplicate.

Next: [06 · Restore drill](06-restore-drill.md)
