# 0016 Sensitive saves: an explicit request is a request for owner confirmation

Status: accepted
Date: 2026-11-07

## Context
Owner decision: sensitive categories blocked by default, stored only on explicit request. Reviewers: the server cannot verify an explicit request from a chat app (review2-architecture N25; review2-security D-3, privacy §5). The architecture review proposed a remember-intent lexicon on `user_words`; the security review showed `user_words` is model-written.

## Decision
A sensitive save about the user becomes active only at T0 or after a verified elicitation (T1). A claimed explicit request (flag or remember-intent words) stores it as pending_review, never recalled until the owner approves. Without a claim it is rejected. Sensitive facts about other people are always rejected. The check also runs at render time. Spec: memory-policy.md §7, write-path.md §5 rows D3–D6.

## Consequences
The owner's explicit request is honoured with one confirmation step, and a hijacked model cannot store or plant sensitive facts without the owner seeing them.
