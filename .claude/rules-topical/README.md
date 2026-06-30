# Topical Rules (portable)

> Deep-dive operating guidance, loaded **on demand** by topic — distinct from the
> always-on rules in [`../rules/`](../rules/README.md). These are part of the
> portable agentic harness (they travel across projects); the `file-dispatch`
> hook and the `prompt-intelligence` recall menu point here when a task touches a
> matching surface. They are **project-agnostic** — methodology, not domain.

## When to read which

| Topic | Read when the task is… |
|---|---|
| [`skill-dispatch.md`](skill-dispatch.md) | choosing/authoring skills; understanding how auto-dispatch matches prompts to skills |
| [`deep-research.md`](deep-research.md) | a multi-source, cross-verified research task (≥3 independent sources, surface contradictions, cite everything) |
| [`research-and-plan.md`](research-and-plan.md) | turning research into an actionable plan |
| [`making-plans.md`](making-plans.md) | writing an implementation plan / decomposing a feature |
| [`problem-solving-protocol.md`](problem-solving-protocol.md) | debugging or root-causing — diagnosis before fix |
| [`implementation.md`](implementation.md) | writing the code — engineering conduct, no-hacks discipline |
| [`performance.md`](performance.md) | latency/throughput/memory/bundle work — measure before optimizing |
| [`scalability.md`](scalability.md) | a scale surface (lists, search, contested writes, spikes, pipelines) — which tier it survives |
| [`red-team-negation-loop.md`](red-team-negation-loop.md) | adversarially proving an artifact is NOT junior before declaring it done |
| [`accepting-audits.md`](accepting-audits.md) | receiving/acting on a critical review without defensiveness |
| [`ai-discipline.md`](ai-discipline.md) | guarding against the AI failure modes (hallucinated APIs, fluent-but-wrong, summary≠diff) |
| [`communication-with-other-agents.md`](communication-with-other-agents.md) | one agent handing structured work/results to another |
| [`section-zero.md`](section-zero.md) | the first-principles framing pass before a hard decision |
| [`learned-preferences-detail.md`](learned-preferences-detail.md) | the detailed operator-preference reference (the long form of the feedback memories) |

## Relationship to the rest of the harness

- **Rules** ([`../rules/`](../rules/)) = always-on constraints (this project's +
  the portable `agentic-discipline` / `cynical-charter` / `learned-preferences` /
  `git-ip`).
- **Topical rules** (here) = on-demand deep dives by topic.
- **Skills** ([`../skills/`](../skills/)) = how to build a specific thing.
- **Memory** ([`../memory/`](../memory/)) = durable facts + operator preferences.
- The **agentic hooks** ([`../hooks/agentic/`](../hooks/agentic/)) tie them
  together: on each prompt they surface the right skills + memories and point at
  the matching rule.
