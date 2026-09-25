---
layout: ../layouts/Article.astro
kicker: Field notes on coding agents
title: I deleted slow, expensive LLM turns in coding agents with Jev
standfirst: Agents spin out a lot of slow, expensive LLM turns. I deleted some with Jev and measured what happened, with caveats.
description: 'DecisionKit pre-calibrates decisions per coding agent, deleting slow, expensive LLM turns: ↓2–11× input tokens, ↓4.6× output tokens, ↓61–85% session cost.'
date: 22 September 2026
---

![Bar graph comparing baseline vs DecisionKit sessions: input tokens ↓6.5×, output tokens ↓4.6×, LLM turns ↓3.4×, wall clock ↓3.2×, dollars per session ↓5.7×](/decisionkit/benchmark-graph.svg)

*Mean of 3 A/B runs on a real code-change prompt — everything normalized to baseline (lower is better).*

## It all started with hating, a week before Jev

I hate waiting and love shipping fast. Yet, coding agents' feedback loops excel at making you wait. 23 mins is almost the bare minimum for anything meaningful built with coding agents.

While writing the article, this is the coding agent going for 2m 41s at 77 t/s for just showing link preview and two options for sharing (one image and one for article) in this page:
![The coding agent going for 2m 41s at 77 t/s for just showing link preview and two options for sharing (one image and one for article) in this page](/decisionkit/LLMs-turn-for-share.webp)

Even with the wait, I'm able to ship faster, especially small tweaks. Good! But those need running tests and building, another 3 mins to 15 mins added per push.

I was in the process of optimizing CI / CD (target was the open source repo of Cal) a week ago to make the feedback loop faster.

Just while scratching the surface there, Jev came out.

## Jev as a router

A classifier or whatever, it was the call for me to try it on CI / CD pipeline optimization. As I was working on it, I realized it is "more" general, just like LLMs. And the pain in inference bothered me a lot, how about deleting it?

### 3 critical axes are affected
Deleting LLM turns affect: **accuracy, task time, and cost**. These are 3 big levers affected! That sparked an idea to shift my direction to try a small experiment for just 24 hours. The goal was to delete some LLM turns with Jev.

And hooray! That experiment failed, for me at least. It turns out deleting LLM turns is easy if you don't care about how you write prompts. That worked on literal prompts like: "read package/file.ext", just a bit smarter than if else statements and made me think that Jev is just this and almost gave up on it. Nevertheless, it was successfully routing to those files with zero llm calls using Jev calls instead (This feature is still available as you'll see later).

*"Amazing, but I never write prompts like that. I write naturally."* A simple realization that allowed me to pour more time into Jev + LLMs experiment.

## Jev as a decision layer for coding agents

I thought it would take a few hours, but here I'm after 6 days working non-stop on this.

To understand this, and how it can delete LLM turns in real workflows, let's get back to what coding agents are doing when you send a prompt: An agent loop.

### Current agent loop

Pi's loop is simple, and supposedly least bloated, that's why I picked it. The prompt comes in, the model sees the whole transcript, decides one step, the tools for that step run (read, bash, edit), the output appends to the transcript, and everything goes back in for the next turn. That's it. No planning phase, no hooks.

But look at where the judgments live: "is this `rm -rf` safe?", "which file holds the 3d map?", "did that tool call actually fail?". All inside LLM turns. The loop can't answer any of them without paying a frontier turn, and every turn re-sends the whole transcript. I measured it on the code-change prompt below:

![Diagram of the stock pi loop: prompt → LLM turn decides one step → tools run → results append and the transcript re-sends, measured 17/19/8 turns per session across 3 runs](/decisionkit/agent-loop-baseline.svg)

*Diagram of the stock pi loop: prompt → LLM turn decides one step → tools run → results append and the transcript re-sends, measured 17/19/8 turns per session across 3 runs*

*Baseline: 17 / 19 / 8 LLM turns, 50.9k / 57.7k / 26.6k input tokens, $0.0068 / 0.0088 / 0.0032 per session (3 runs, 2026-09-21).*

### With decision layer

Same loop, same prompt, same repo. I didn't replace anything, I just added four typed Jev calls (~100ms, fail-open) at four fixed points of the loop above, so four of those judgments stop being LLM turns:

1. **on input:** a mechanical prompt ("read package.json") routes straight to the tool and the LLM turn is deleted (pi only)
2. **after the prompt, before the first turn:** S0 sweeps the repo locally and makes one typed call, so the first LLM turn starts with the repo digest already drawn
3. **on each tool call:** the guardrail gates destructive `bash` instead of the LLM deciding
4. **on each tool result:** triage stubs irrelevant reads, the critic flags failed results

Every decision lands in a receipts ledger. And since the digest pre-answers discovery, the loop needs way fewer passes:

![Diagram of the same loop with four numbered typed-call intercepts: routing on input, S0 digest after the prompt before the first turn, guardrail on tool calls, triage and critic on results, measured 5/5/3 turns per session across 3 runs](/decisionkit/agent-loop-decision.svg)

*Diagram of the same loop with four numbered typed-call intercepts: routing on input, S0 digest after the prompt before the first turn, guardrail on tool calls, triage and critic on results, measured 5/5/3 turns per session across 3 runs*

*With DecisionKit: 5 / 5 / 3 LLM turns, 4.5k / 7.4k / 10.6k input tokens, $0.0010 / 0.0012 / 0.0011 per session, including 4–6 typed calls per session (p50 427–942ms, 0 fail-opens). Full numbers below.*

### Could work?!

I didn't just dream of this overnight, even I had a dream about weighting graph edges for important context when optimizing CI / CD pipeline, but I was experimenting heavily. From the start, I needed somehow to benchmark to see if this could work.

## Cherry-pick Benchmarking?

LLMs benchmarking sucks, so mine might be not that different. But I believe in this: "Benchmarks are trying their best to mimic real workflows.". That said, I created 3 different benchmarks, each for a different testing stage of the decision layer. But there are 2 simple things before that: Coding agent and model choice.

### Picking the least bloated coding agent: PI

I saw a few months ago a chart about how bloated other coding agents are compared to Pi, so I said, if I'm going to achieve something, it would be compared to the least bloated coding agent. LLM choice makes a difference, but a harness makes one as well. To my luck, routing in ext only worked in Pi, so testing it there didn't need to rewrite a complete harness with new loop.

At that time, Pi was at v0.85.1. Now, before publishing this article, it's updated to v0.87.0.

### LLM choice: GLM-5.3-Flash (low thinking)

I hated waiting, but I wanted a model good enough and isn't expensive. GLM-5.3-Flash with low thinking was perfect for the job I wanted.

### Benchmarking first phase

First created features in DecisionKit were, routing, guardrail, triage, and critic. So I tested those on Vite repo and got acceptable results. The goal of this wasn't reaching pure accuracy, it was to find out what Jev could do right out of the box. Here were the results (copied from DecisionKit repo):

#### Measured results (pi faux-provider bench, v0.1.1 — 2026-09-17)

| demo | baseline | with DecisionKit | headline |
|---|---|---|---|
| A routing | 2 LLM turns | **0 turns** | 2/2 turns deleted on routed prompts |
| B guardrail | ran `rm -rf ./build ../.env` | blocked, executed nothing | agent self-corrected |
| C triage | 2221 tok peak turn | **860 tok** | ~2.6× input-token divergence |
| D critic | 3 turns failure→fix | **1 turn** | critic flags failure in ~100ms |

Honest caveat: wall-clock claims aren't honest on this rig (the faux baseline pays no real API latency); turn/token deltas are the measured signal.

#### How to replicate this phase

To replicate, follow the instructions in bench/readme about [bench/demo-vite](https://github.com/tawfeks/decisionkit/tree/main/bench).

---

Each demo consisted of specific prompts to test the abilities of Jev for a specific task but using as less LLM calls as possible. As I said, results were amazing but the experiment failed to be useful enough due to being strict to certain prompts.

#### Calibration per repo

What happens if the questions pack were optimized for the repo?
what if I made up a skill for doing that?
Sounded new and exciting to me! So I implemented it...

And to my surprise, I got no gains.


### Benchmarking S0 with all the numbers (graph above)

I loved this benchmark the most, because it got almost everything needed for benchmarking (I missed t/s metric) and is very close to a real workflow. The results speak for themselves. It was the one that got me to these results shown in the graph:

![Bar graph comparing baseline vs DecisionKit sessions: input tokens ↓6.5×, output tokens ↓4.6×, LLM turns ↓3.4×, wall clock ↓3.2×, dollars per session ↓5.7×](/decisionkit/benchmark-graph.svg)

Here are the full results (copied from readme):

#### Measured field results, runs 4–6 — S0 on a focused code-change prompt (A/B, 2026-09-21)

Three more independent A/B sessions (runs 4–6) on the outbidlaunch Astro/Cloudflare leaderboard app, same repo both arms, one prompt in both arms: a focused code change — *"fix the issue of having greenland and some other countries not showing in 3d map (don't edit anything else like changing how ocean or water in earth)"*. Both arms ran on **pi**. Raw per-run metrics: `.bench-run/run{4,5,6}-{base,s0}-pA.json`. ↑ = session-cumulative input tokens.

| Metric | with DecisionKit | baseline | headline |
|---|---|---|---|
| ↑ input tokens | 4.5k / 7.4k / 10.6k | 50.9k / 57.7k / 26.6k | **↓ 2.5–11×** — the digest deletes discovery re-sends |
| LLM turns | 5 / 5 / 3 | 17 / 19 / 8 | **↓ 2.7–3.8×** |
| Wall clock | 27.9 / 23.6 / 23.8 s | 76.0 / 109.0 / 53.2 s | **↓ 2.2–4.6×** |
| $ per session (provider-reported) | 0.0010 / 0.0012 / 0.0011 | 0.0068 / 0.0088 / 0.0032 | **↓ 61–85%** incl. DecisionKit tax (frontier-only ↓ 2.9–7.0×) |
| Cache-read tokens | 15.7k / 12.8k / 0 | 47.9k / 139.5k / 6.9k | s0 arm reads cached digest-first context (~10× cheaper/token) |
| Output tokens (incl. reasoning) | 1.10k / 1.05k / 0.65k | 5.01k / 4.97k / 2.80k | **↓ 4.3–4.7×** |
| Max single-turn input | 2.1k / 3.8k / 4.4k | 8.4k / 10.8k / 5.2k | no per-turn context blowout in either arm |
| Tool calls | 1 read + 1 edit + 2 bash (all 3 runs) | run 4: 1r/6e/9b · run 5: 2r/1e/16b · run 6: 2r/1e/5b | s0 lands one focused edit every time |
| Verify gate (all 10 entries + no-collateral-edit) | **3/3 ok** — VisitMap diffs +2/-1, +1/-1, +1/-0 | 2/3 ok — diffs +15/-10, +1/-1, **+20/-1 (run 6 failed: missing TF→ATF, edits outside the table)** | s0 never violated the "don't edit anything else" constraint |
| DecisionKit (jev) tax | $0.00019 / 0.00016 / 0.00015 | — | 4–6 calls/session, p50 427–942ms/call, p95 1040–1581ms, **0 fail-opens** |
| S0 digest | injected, 1245 chars, `s0.wasted = 0` (vs 4–5 on the 2026-09-20 runs) | — | picked exactly `world.geo.json` + `VisitMap.tsx`; s0 latency 3.5–3.8s total across 3 calls (~1.2s each) |

Honest caveats: N=1 prompt × 3 runs, one fixture class, one model (`glm-5.3-flash:low`). Baseline is stock pi, and a heavier host would likely show a larger delta, not a smaller one; baseline's 2/3 verify-gate score is a single sample, not an accuracy claim.

#### How to replicate (and benchmark any repo if needed)

This is the most complete benchmark to test with, it has almost everything you need for a complete test except the UI. To replicate, follow the instructions in bench/readme about [bench folder overall](https://github.com/tawfeks/decisionkit/tree/main/bench).

#### Calibration per agent
That was not part of the benchmark, but the failed idea of per repo calibration made a good use case here. Each harness is a bit different than the others. So calibrating not just the questions (questions were mostly the same) but the setup to make it work best on each coding agent did improve Pi results a bit. It is like customization but focuses on decision layer optimization.

### Benchmarking a real coding agent workflow

I hated this the most while being the most important. Don't blame me, but I needed the numbers to optimize for and the only way to get them all is to build a different extension for Pi, and guess what? I didn't have time for that.

So I measured two real terminals with two real browsers. I prompted Pi on both for a real fix on my outbidlaunch repo website (public), and got the following (copied from DecisionKit repo):

#### Measured field results — S0 on real pi terminal (A/B, v0.1.2 — 2026-09-20)

Three independent A/B sessions on a real fixture (an Astro/Cloudflare leaderboard app), same repo both arms, same two prompts (launch audit + a code change). ↑ = session-cumulative input tokens.

| Metric | with DecisionKit | baseline | headline |
|---|---|---|---|
| ↑ input tokens | 23k / 19k / 19k | 75k / 81k / 31k | **↓ 2–4×** — the digest deletes discovery re-sends |
| $ per session | 0.013 / 0.006 / 0.007 | 0.015 / 0.011 / 0.011 | **↓ 13–45%** |
| DecisionKit tax | $0.0003–0.0008 / session, p50 544–617ms/call | — | ~3–7% of session cost; pays for itself every time |
| Accuracy | comparable, precise `file:line` anchors | comparable | no regression observed (single sample) |

Honest caveats: N=1 per prompt per arm × 3 runs, one fixture class — direction validated, the full protocol (N≥3, ≥2 fixture classes) is still the ship gate; multi-file edit prompts left `s0.wasted = 4–5` (the biggest remaining lever); one p95 outlier of 2102ms brushes the ≤2s added-latency budget.

---


## Caveats

Will this scale? Not tested yet, but it's promising enough to scale to everyday tasks.

Isn't this a small case use case? Maybe and maybe not.

Where are the output tokens in your real pi terminal benchmark? Replicate and see yourself, maybe that slipped.

What about longer tasks? Interesting to bench for a next release.

What about testing against agents benchmarks? like TB4.0? Maybe in a new release.

All are legitimate questions that need work to answer and I had limited time. The feedback loop I was optimizing was limited and wasn't short enough to get these answered in 6 days.

"Wasted" is an important metric to optimize for, but currently it's bad on half prompts. It's defined by this: prompts the digest should have pre-answered but didn't, i.e. discovery reads the S0 sweep failed to cover, counted per session as `s0.wasted`. Getting it to zero means taking the full advantage of Jev in that session on the 3 axes mentioned earlier.

## Quick Start: delete slow, expensive LLM turns with DecisionKit for your coding agent

One command in any repo, for pi, opencode, kilo, claude, or codex:

```sh
npx decisionkit-cli init
```

Restart your agent — guardrail, context assembly, triage, critic, and receipts are live. Pre-calibrated packs ship per coding agent; System 1 fails open, so if DecisionKit is slow or down, your agent behaves exactly like baseline.

I open sourced DecisionKit repo under MIT. Check it out here:
[https://github.com/tawfeks/decisionkit](https://github.com/tawfeks/decisionkit)


### Verify it

Check every tier against shipped eval sets, in your own repo:

```sh
npx decisionkit-cli test
```

### For Claude Code

Run `npx decisionkit-cli init --agent claude` — it installs hooks in `.claude/settings.json` plus MCP in `.mcp.json`, giving you the guardrail, S0 context injection via `UserPromptSubmit`, triage, critic, and `decisionkit_locate` (no turn routing, since no Claude hook can answer a prompt without the LLM).

### For Kilo Code

Run `npx decisionkit-cli init --agent kilo` — it adds the plugin entry to `kilo.json` (or drop-in `.kilo/plugin/`), giving you the guardrail, S0 digest injection via `chat.message`, triage, critic, and `decisionkit_locate` (no turn routing — `chat.message` can modify parts but can't skip the LLM).

### For Opencode

Run `npx decisionkit-cli init --agent opencode` — it adds the npm plugin entry to `opencode.json`, giving you the same feature set as Kilo: guardrail, S0 digest injection, triage, critic, and `decisionkit_locate`, without turn routing.

### For Codex

Run `npx decisionkit-cli init --agent codex` — it installs hooks in `.codex/hooks.json` plus MCP in `.codex/config.toml` (surfacing a one-time `/hooks` trust review at install), giving you the guardrail, S0 context injection, critic with result-replace, and `decisionkit_locate`, without turn routing.

### For Pi

Run `npx decisionkit-cli init --agent pi` — it drops the full adapter into `.pi/extensions/decisionkit/`, and pi is the only host with every tier including turn routing, where mechanical prompts like "read package.json" skip the LLM entirely.

## A future to explore

"Context routing" does sound exciting to experiment with using Jev & decision models. But for me, I think the entire architecture of harnesses should be restructured based on this. They just suck, in a lot of things. CI, speed, and security are the main ones to go after, so a new harness should combine the 3 among other crucial features in one harness to minimize the feedback loop to its minimal size (and I'm already thinking about doing so).

## Conclusion

If you want one takeaway from the entire article, it is this:

Decision models are a real shift worth spending time on, now.

Why? Because LLMs are kinda made for tokenmaxing. That's by design I guess. On the other hand, decision models kinda force you to not have tokens in the first place, so you'll rethink how to achieve stuff with way less tokens naturally. That leads to great cost reduction and faster feedback loop. But to keep accuracy, you would need LLMs with it, but less than before.

### Lastly, for Diogo: Thank you from the bottom of my heart.
I watched a video of Diogo, CEO of Typesafe, talking about how current LLMs are optimized for rewards, and he shared an embarrassing example. No matter the user, they will try to please them to stay and talk to them. That may or may not lead to true automation. That's why stuff like tokenmaxing exists and the general people don't complain about it much yet. With decision models, you don't deal with tokens, you deal with code but a bit smarter. And adding LLMs to that, you would have world-class power in your hands in terms of speed, accuracy, and efficiency.
So, clearly, this is a real shift that would work for automation tasks. And I strongly believe in it.