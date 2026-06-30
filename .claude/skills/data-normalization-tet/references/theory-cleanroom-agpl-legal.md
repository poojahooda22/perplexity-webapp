# Theory — Clean-Room & the AGPL: the legal discipline that gates this skill

> **Skill:** `data-normalization-tet` · **Product line:** JPM-Markets re-engineering **data-analytics
> service** (re-engineers DataQuery + Fusion). **This is NOT Lumina.** Lumina is the renamed-Perplexity
> repo that merely hosts this research on disk; nothing here is wired into Lumina's app code.
> **Reference type:** `theory-*` — generic, reusable legal knowledge. No codebase `file:line` yet
> (greenfield). The concrete write-path recipe lives in the `patterns-*` references.
>
> **Standard:** [`cto-rules.md`](../../../rules/cto-rules.md) — verify-never-assert. Every load-bearing
> license/legal claim below carries a primary citation (the LICENSE file, the PyPI license field, the
> license text itself, or a named legal commentary). Where the law is **unsettled**, this doc says so in
> those words rather than asserting a verdict the courts have not reached.
>
> **One-sentence thesis.** OpenBB is the best public reference for the **Transform–Extract–Transform
> (TET) normalization pattern**, but OpenBB relicensed to **AGPL-3.0-only on 2024-05-15** and that
> copyleft reaches **every `openbb-*` package** including provider extensions; because our product is a
> **hosted Data-as-a-Service** — exactly the "network service" AGPL §13 was written to catch — vendoring
> *any* `openbb-*` code would make our service a derivative work obligated to disclose **our entire
> Corresponding Source** (or buy a commercial license). The escape is the **idea/expression dichotomy**:
> the *pattern* and the *field-intersection idea* are uncopyrightable; only OpenBB's *source expression*
> is encumbered. So we **clean-room reimplement the pattern from the public docs/blog/behavior — a
> specification — and vendor zero `openbb-*` code.** This doc is that discipline, stated precisely
> enough to defend in an audit.

---

## 0. Why this is the FIRST reference in the skill, not an appendix

This skill teaches Claude-the-builder how to write the TET normalization layer. The single most natural
way to write it would be to read OpenBB's `openbb_core/provider/abstract/fetcher.py`, copy its
`Fetcher[Q,R]` shape, lift its `__alias_dict__` mechanism, and paraphrase its provider modules. **That
is the one thing that must never happen**, and it is so tempting that it has to be the first rule
internalized — before any provider code is written, before the `Fetcher` base class is sketched, before a
single `__alias_dict__` is typed.

The failure is invisible at build time. The code compiles, the tests pass, the normalized series come out
clean. The license violation only surfaces when (a) we host the service publicly — which is the entire
product — and (b) someone notices the lineage. By then it is not a code review comment; it is a
source-disclosure demand or a commercial-license invoice, and unwinding it means re-deriving the whole
write path. This is why the project's own pre-mortem lists "a license surprise" as a top-six failure mode
([`02-skills-and-pipeline.md`](../../../../.agents/jpm-markets-reengineering/financial-data-analytics-service/02-skills-and-pipeline.md),
pre-mortem item 3) and why the build order puts "the AGPL trap must be internalized before any provider
code" on the `openbb-tet-normalization` skill (same doc, build-order item 4).

The discipline reduces to one ledger row, defended over the next ~2,000 lines:

> **`OpenBB = pattern-reference-only, AGPL-3.0-only, never vendored.`**

---

## 1. The fact pattern — OpenBB's MIT → AGPL relicense, verified

### 1.1 The change, the date, the reason

OpenBB relicensed the OpenBB **Platform** from **MIT** to the **GNU Affero General Public License v3** on
**2024-05-15**, announced on their own blog. The blog states the mechanism plainly:

> "AGPL comes with the option of a commercial license. **Anyone who modifies the OpenBB Platform code and
> distributes it in applications or hosts it for SaaS needs a commercial license unless they provide the
> source code.**"
> — [openbb.co/blog/license-change-openbb-platform-goes-agpl](https://openbb.co/blog/license-change-openbb-platform-goes-agpl/),
> dated **May 15, 2024**

The stated rationale was that OpenBB had grown "from a simple terminal app … to a powerful framework for
developing complex web apps, AI, and data services," and AGPL "protects the community's investment …
ensures it stays open and free for everyone" — explicitly aligning with "GitLab, Mattermost, Nextcloud,
Grafana, and many others who have adopted AGPL" (same blog).

**Read that quote against our product.** We are building a hosted financial DaaS. We *will* "host it for
SaaS." The only question the blog leaves open is whether we are also "modifying the OpenBB Platform code"
— and **vendoring any of it and adapting it is exactly that.** (§3 below nails the "modify" definition.)

### 1.2 The LICENSE file — verified verbatim

The repository's root `LICENSE` on the active branch is the AGPL v3, title line and all:

> "GNU AFFERO GENERAL PUBLIC LICENSE / Version 3, 19 November 2007 … specifically designed to ensure
> cooperation with the community **in the case of network server software**."
> — [github.com/OpenBB-finance/OpenBB/blob/develop/LICENSE](https://github.com/OpenBB-finance/OpenBB/blob/develop/LICENSE)
> (raw confirmed: title = "GNU AFFERO GENERAL PUBLIC LICENSE Version 3, 19 November 2007")

"Specifically designed … in the case of network server software" is the AGPL's own self-description. It
is not an accident that this is the license a DaaS-builder hits.

### 1.3 The copyleft reaches the WHOLE package family — not just "the core"

A common (wrong) hope is "the core is AGPL but the provider extensions are permissive, so I can lift
`openbb-yfinance`." **Verified false.** Every `openbb-*` distribution carries the same AGPL-3.0-only
license field on PyPI:

| PyPI package | License field (verbatim) | Latest version | Released | Source |
|---|---|---|---|---|
| `openbb-core` | "GNU Affero General Public License v3 (AGPL-3.0-only)"; classifier "OSI Approved :: GNU Affero General Public License v3" | **1.6.13** | **2026-06-17** | [pypi.org/project/openbb-core](https://pypi.org/project/openbb-core/) |
| `openbb-yfinance` (a **provider extension**) | "GNU Affero General Public License v3 (AGPL-3.0-only)" | **1.6.3** | **2026-05-26** | [pypi.org/project/openbb-yfinance](https://pypi.org/project/openbb-yfinance/) |
| `openbb-mcp-server` | "GNU Affero General Public License v3 (AGPL-3.0-only)" | **1.4.1** | **2026-05-26** | [pypi.org/project/openbb-mcp-server](https://pypi.org/project/openbb-mcp-server/) |

The takeaway: **`openbb-yfinance` is AGPL too.** The provider extension you'd be most tempted to grab —
because it's "just a thin yfinance wrapper" — carries the same copyleft as the core. There is no
permissive corner of the `openbb-*` namespace to hide in. **All of it is `avoid` for vendoring.**

> **Pin discipline (cto-rules).** Versions/dates above are pinned as of **2026-06-24**. They will drift;
> the *license* will not (a relicense to permissive is vanishingly unlikely and would be headline news).
> When you re-verify, re-read the PyPI **License** field and the repo `LICENSE` — not a blog summary.

---

## 2. AGPL §13 — the network/SaaS clause, read precisely

This is the clause that turns "OpenBB is copyleft" into "vendoring it disclosures *our* source." Most
engineers know GPL ("distribute a binary → ship the source"). Most do **not** know that GPL has a
SaaS-shaped hole, and that AGPL exists to close it.

### 2.1 The verbatim text of §13 (first paragraph)

> "Notwithstanding any other provision of this License, **if you modify the Program, your modified version
> must prominently offer all users interacting with it remotely through a computer network (if your
> version supports such interaction) an opportunity to receive the Corresponding Source of your version**
> by providing access to the Corresponding Source from a network server at no charge, through some
> standard or customary means of facilitating copying of software."
> — AGPL v3 §13, "Remote Network Interaction" ([opensource.org/license/agpl-v3](https://opensource.org/license/agpl-v3))

### 2.2 The two definitions that make §13 bite

**"To modify":**

> "To 'modify' a work means to **copy from or adapt all or part of the work in a fashion requiring
> copyright permission, other than the making of an exact copy.**"
> — AGPL v3 §0 ([opensource.org/license/agpl-v3](https://opensource.org/license/agpl-v3))

Note what this catches: **adapting all or part** of the work. Lifting `fetcher.py` and editing it to fit
our schema is "adapting part of the work." Paraphrasing it line-by-line is "adapting" too (the law looks
at substantial similarity of *expression*, not at whether you retyped it — see §5). "Other than the making
of an exact copy" means even a *verbatim* copy is a "use"; *modification* is the broader, adapted case.

**"Corresponding Source":**

> "The 'Corresponding Source' for a work in object code form means **all the source code needed to
> generate, install, and (for an executable work) run the object code and to modify the work**, including
> scripts to control those activities."
> — AGPL v3 §1 ([opensource.org/license/agpl-v3](https://opensource.org/license/agpl-v3))

"All the source code needed to … run … and to modify the work" is the explosive part. If our DaaS's
running object includes a modified `openbb-core`, the Corresponding Source we must "prominently offer" to
**every remote user of the API** is not just the OpenBB diff — it is everything needed to build and run
the work, i.e. **our service.**

### 2.3 Kyle Mitchell's plain reading — the trigger has TWO conditions

The clearest lay reading is Kyle Mitchell's. He reduces §13 to "one very wordy `if` statement. If you do
this-and-that, then you must do such-and-such," and isolates the trigger:

> The condition has two parts: "**you modify the Program**" AND "**your [modified] version supports such
> interaction [remotely through a computer network].**" Without both conditions met, section 13 doesn't
> activate.
> — paraphrase of [writing.kemitchell.com/2021/01/24/Reading-AGPL](https://writing.kemitchell.com/2021/01/24/Reading-AGPL)

And the GPL-vs-AGPL gap this closes:

> "GPL doesn't actually require sharing and licensing source code if you run it for people as a network
> service, rather than providing it for them to run on their own computers. **AGPL was written to close
> that loophole.**" — Mitchell, ibid.

The consequent, once triggered:

> "You must make an offer. You must make it 'prominently'. You must make it to **'all users interacting
> with [your modified version of the Program] remotely through a computer network'.**" — Mitchell, ibid.

**Mitchell's own escape-hatch example (load-bearing for us):**

> "Say it's a blog platform. We download it, put it on a server, run it, and open the ports … Meanwhile,
> we're operating a network server, but **we don't have to offer any source code. We didn't modify the
> program.**" — Mitchell, ibid.

This is the crucial nuance, and it is double-edged:

- **It does NOT save us.** Running OpenBB *unmodified* behind a network would not trigger §13 — but
  building a DaaS means *adapting* the fetcher pattern, the schema, the providers to our security master
  and our store. That is modification. The moment we touch it, both conditions are met.
- **It DOES tell us the boundary.** §13 keys on **modify**, and "modify" keys on **copyright permission**
  (§0 above). If we never use anything that *requires copyright permission* from OpenBB — i.e. we use
  only the **uncopyrightable idea/pattern** and write all expression ourselves — there is no "modify,"
  no §13, no disclosure. **That is the entire legal basis of the clean-room route.** §4–§5 operationalize
  it.

### 2.4 The §13 truth table for our product

| Scenario | "Modify"? | Network service? | §13 fires? | Verdict |
|---|---|---|---|---|
| Import `openbb-core`, call its `Fetcher`, host the DaaS | **Yes** (adapt/extend its work) | Yes | **Yes** | ❌ Must disclose our full source or buy commercial license |
| Fork `openbb-yfinance`, edit it, host the DaaS | **Yes** | Yes | **Yes** | ❌ Same — provider extensions are AGPL too (§1.3) |
| Read `fetcher.py`, paraphrase it line-by-line into our codebase | **Yes** (adapting expression = derivative; §5) | Yes | **Yes (likely)** | ❌ The AI-paraphrase trap — still a derivative |
| Reimplement the TET *pattern* from the public docs/behavior, zero OpenBB code read into our files | **No** (idea, not expression) | Yes | **No** | ✅ Clean-room — the route we take |
| Run a private internal copy of OpenBB, no network users | n/a | No public users | No | (irrelevant — our product is public) |

The first three rows are all the same disaster wearing different clothes. The fourth is the build. Row 3
is the one that *feels* clean and is not — §5 is dedicated to it.

### 2.5 The separate-works carve-out OpenBB itself documents — and why it doesn't help us

OpenBB's own licensing FAQ grants a real carve-out, and it's worth quoting because misreading it is a
classic trap:

> "If you are integrating proprietary datasets and creating **extensions that do not modify the OpenBB
> Platform code, these extensions are considered separate works.** You do not need to disclose these
> proprietary integrations under the AGPL, **provided these do not form part of the OpenBB Platform
> distributed to others or used to provide a network-based service.**"
> — [docs.openbb.co/platform/faqs/license](https://docs.openbb.co/platform/faqs/license) (via OpenBB FAQ)

And on when the commercial license is needed:

> "A commercial license is suitable for companies that wish to use OpenBB Platform **in a proprietary
> product or service**, or who do not wish to disclose their modifications … To inquire … contact
> licensing@openbb.co." — ibid.

**Why the carve-out is a trap for us, not an exit.** The carve-out protects *your extension* from having
to be disclosed **when the extension is a separate work plugged into an otherwise-unmodified OpenBB.**
But the carve-out's own proviso — "*provided these do not form part of the OpenBB Platform … used to
provide a network-based service*" — is exactly our situation: a hosted DaaS **is** a network-based
service, and an extension that runs **inside** an OpenBB process we host **does** form part of the
network-served platform. The carve-out keeps your *separate* code separate; it does not let you host the
*combined* work without §13. The only clean way to be "separate" is to share **no OpenBB code at all** —
which is just the clean-room route again, arrived at from the FAQ's own direction.

> **Plain version:** the FAQ says "your separate plugin is yours." It does **not** say "you may host a
> modified OpenBB as a SaaS without disclosure." Our product needs the second permission, which the FAQ
> explicitly withholds → commercial license or clean-room. We choose clean-room.

---

## 3. The escape — the idea/expression dichotomy

The clean-room route is not a loophole or a gray hack; it rests on the most settled principle in
copyright law. **Copyright protects the *expression* of an idea, never the idea, method, system, or
functionality itself.**

### 3.1 The statute and the founding case

**17 U.S.C. § 102(b)** codifies it:

> "In no case does copyright protection for an original work of authorship extend to any idea, procedure,
> process, system, method of operation, concept, principle, or discovery, regardless of the form in which
> it is described, explained, illustrated, or embodied in such work."
> — 17 U.S.C. §102(b), as summarized at
> [pressbooks.uiowa.edu/intro-ip — The Idea/Expression Dichotomy](https://pressbooks.uiowa.edu/intro-ip/part/the-idea-expression-dichotomy/)

The doctrine traces to **Baker v. Selden, 101 U.S. 99 (1879)**:

> The Supreme Court "held that a bookkeeping system created by Selden and described in his book was a
> **method or process that fell outside the scope of copyright protection.** … while Selden's book
> explaining the system was protected, **the system (the 'idea') itself was not.**"
> — [casemine — Baker v. Selden](https://www.casemine.com/commentary/us/baker-v.-selden-(1879):-establishing-the-idea-expression-dichotomy-in-copyright-law/view)

Baker copied Selden's *bookkeeping system* using *differently arranged* columns and headings, and won.
Map that onto us: OpenBB's *TET normalization system* (fetch → standard model → transform; field
intersection across providers; alias-dict mapping) is the "method/process." OpenBB's *book explaining it*
— the actual `fetcher.py`, `data.py`, `registry.py` source — is the protected expression. **We may freely
reimplement the system with our own arrangement; we may not copy the source.**

### 3.2 Software specifically — what's filtered out as idea

Courts apply the abstraction-filtration-comparison test to software and **filter out** the
non-copyrightable layer:

> Courts "filter out non-copyrightable elements (ideas, procedures, **algorithms, standard code
> sequences, or elements dictated by efficiency or external compatibility**)."
> — [pressbooks.uiowa.edu — Idea/Expression Dichotomy](https://pressbooks.uiowa.edu/intro-ip/part/the-idea-expression-dichotomy/)

And restated for reverse-engineering practice:

> "Copyright protects expression, not ideas, and **it protects the specific implementation of code, not
> the behavior that code produces.** This distinction is fundamental to why clean room design works."
> — practitioner summary,
> [replay.build — Replay vs. Clean Room Design](https://www.replay.build/blog/replay-vs-clean-room-design-the-definitive-guide-to-accelerating-legal-compliant-reverse-engineering)

### 3.3 What this makes free vs encumbered, for THIS skill

| Element of OpenBB | Idea or expression? | Free to reuse? |
|---|---|---|
| **The TET pattern itself** — Transform query → Extract from provider → Transform to standard model | **Idea / method** (§102(b)) | ✅ **Free.** Reimplement with our own classes. |
| **The field-intersection idea** — a "standard model" is the *intersection* of fields common across providers | **Idea / system** | ✅ **Free.** Design our own standard models this way. |
| The `Fetcher[Q,R]` generic shape (a typed query in, a typed response out) | **Idea / interface concept** | ✅ Free as a *concept*; ❌ do not copy OpenBB's actual class source. |
| The alias-dict concept (map provider field name → standard field name) | **Idea / method** | ✅ Free as a *technique*; write our own implementation. |
| OpenBB's actual `fetcher.py` / `data.py` / `registry.py` **source code** | **Expression** | ❌ **Encumbered.** Never read it into our files; never paraphrase it. |
| OpenBB's specific provider modules (the body of `openbb-yfinance`, etc.) | **Expression** | ❌ Encumbered. |
| OpenBB's specific `__alias_dict__` field-name *choices* for a given provider | Mostly facts/short phrases (provider's own field names) but the *compilation* may carry thin protection | ⚠️ Re-derive from the **provider's own docs**, not from OpenBB's mapping file. |

> **The line, in one sentence:** the **shape of the solution** (TET, field-intersection, query-in/
> response-out) is ours to take; **OpenBB's typed-out solution** is theirs to keep.

---

## 4. The clean-room method — how we actually take the idea without the expression

Knowing the idea is free is not enough; we have to be able to **prove** our implementation is independent.
Clean-room design is the governance process that produces that proof.

### 4.1 What clean-room design is

> "Clean-room design (also known as the **Chinese wall technique**) is the method of copying a design by
> reverse engineering and then **recreating it without infringing any of the copyrights** associated with
> the original design. … It is useful as a defense against copyright infringement because **it relies on
> independent creation.**"
> — [en.wikipedia.org/wiki/Clean-room_design](https://en.wikipedia.org/wiki/Clean-room_design)

The canonical two-team structure:

> "Typically, a clean-room design is done by **having someone examine the system to be reimplemented and
> having this person write a specification.** This specification is then **reviewed by a lawyer to ensure
> that no copyrighted material is included.** The specification is then **implemented by a team with no
> connection to the original examiners.**" — ibid.

Restated as governance:

> "A robust clean-room model uses two role partitions: an **Analysis Team** that lawfully observes target
> behavior and produces a functional specification, and an **Implementation Team** that writes new code
> **from approved specs and public references only.**"
> — [replay.build](https://www.replay.build/blog/replay-vs-clean-room-design-the-definitive-guide-to-accelerating-legal-compliant-reverse-engineering)

### 4.2 The case law that validates it

> "The **NEC v. Intel** case (1990) was significant because it was the first time that the clean-room
> argument was accepted in a US court trial."
> — [en.wikipedia.org/wiki/Clean-room_design](https://en.wikipedia.org/wiki/Clean-room_design)

> Phoenix Technologies built a clean-room IBM-PC-compatible BIOS, emphasizing that "**their BIOS code had
> been written by a programmer who did not even have prior exposure**" to the original — and sold it to PC
> clone makers, launching the entire PC-clone industry. — ibid.

This is not an exotic theory. The PC-compatible industry, and large parts of every reverse-engineered
standard since, stand on it.

### 4.3 Our clean-room procedure for the TET pattern (the concrete, runnable discipline)

We are not litigating Intel; we are a small team taking a *published, documented* pattern. We don't need
a hermetically sealed two-building Chinese wall — OpenBB **publishes** the specification themselves in
blog posts and docs, which is a far cleaner starting point than reverse-engineering a closed binary. But
we keep the spirit: **build from the spec, never from the source.**

**Step 1 — Source only from the public *specification*, never the code.**
The permitted inputs are OpenBB's **prose** descriptions of the architecture, not their repository:

- OpenBB's architecture blog: ["Exploring the architecture behind the OpenBB
  Platform"](https://openbb.co/blog/exploring-the-architecture-behind-the-openbb-platform/) — describes
  the Fetcher/standard-model/provider-registry shape in **prose**.
- OpenBB's public **docs** (provider docs, the contributor guide's *description* of how a provider is
  structured).
- **Observable behavior**: call the public OpenBB API / SDK, observe that `obb.equity.price.historical`
  returns OHLCV with standard field names, and write down *what it does*, not *how it's coded*.

**Step 2 — Write our own specification document.**
Produce `patterns-*` references (in this very skill) and the project's `02-skills-and-pipeline.md` that
describe **our** TET shape in our words: our `Fetcher` ABC, our `transform_query` / `extract_data` /
`transform_data` method names, our standard-model design rule (field intersection), our `__alias_dict__`
mechanism. **This is the spec.** It cites the *idea* (TET, field-intersection) and never reproduces
OpenBB expression.

**Step 3 — Implement only from our spec.**
The actual Python — the `Fetcher` base class, the Pydantic standard models, each provider's
`transform_query/extract_data/transform_data` — is typed from **our** spec and the **provider's own API
docs** (e.g. SEC EDGAR's field names come from SEC's docs, not from `openbb-sec`'s source). No
contributor opens `openbb-core` source while writing our fetcher.

**Step 4 — Re-derive field mappings from the upstream provider, not from OpenBB.**
The `__alias_dict__` for, say, EDGAR maps `{ "us-gaap:Revenues": "revenue" }`. We learn EDGAR's left-hand
side from **EDGAR's XBRL taxonomy docs**; we choose our right-hand side (`revenue`) as **our** standard
field name. We do **not** copy OpenBB's `openbb-sec` alias file. The mapping that results may *coincide*
with OpenBB's in places (both of us read the same EDGAR docs) — that is fine and expected; coincidence
from a common public source is independent creation, not copying.

**Step 5 — Keep the audit trail.**
The whole point of clean-room is *provable* independence:

> "Clean-room reverse engineering is **a governance system that produces a defensible claim of independent
> implementation.** … CRRE exists to **create evidence** that your implementation reproduces behavior, not
> protected expression."
> — [replay.build](https://www.replay.build/blog/replay-vs-clean-room-design-the-definitive-guide-to-accelerating-legal-compliant-reverse-engineering)

Our audit trail is light but real:
- The `patterns-*` reference docs cite **OpenBB's blog/docs (the spec)**, **never** `openbb-*` source
  files, as the basis for the pattern.
- Commit history shows the pattern was written from the spec docs.
- The ledger row (§7) records "pattern-reference-only, AGPL, never vendored."
- `requirements.txt` / `pyproject.toml` / `uv.lock` contain **zero `openbb-*` packages** — a mechanical,
  greppable proof we never imported the encumbered code. (§6 CI lint enforces this.)

---

## 5. The AI-paraphrase caveat — the one way clean-room silently fails

This is the subtlest and most important section, because the failure mode it describes is *exactly* the
one an AI coding agent (this skill's user) will reach for by reflex.

### 5.1 The trap

"Clean-room" tempts a shortcut: *read* `fetcher.py`, then have the model **rewrite it in different words**
— rename variables, reorder methods, restructure slightly — and call the result "clean-room, independent
implementation." **It is not.** A line-by-line rewrite of read AGPL source is still a derivative work. The
law looks at substantial similarity of **expression**, and paraphrase preserves expression — it is
translation, not independent creation.

### 5.2 Why it fails — the structural-contamination argument

The clearest statement is the "death of clean-room" critique of AI rewrites:

> "Traditional clean-room design requires two **isolated** teams—one studying the original, one building
> fresh. Here, the contamination is **structural**: 'The model has seen the code during training. The
> developer has seen the code during years of maintenance.'"
> — [shiftmag.dev — License Laundering and the Death of Clean Room](https://shiftmag.dev/license-laundering-and-the-death-of-clean-room-8528/)

> "The fact that a plagiarism detector can't find matching tokens doesn't mean the work is independent.
> **It means the laundering was effective.**" — ibid.

And the analogy that settles intuition:

> "Take a leaked Windows source code dump, run it through an LLM, and release the output as open source.
> Is that acceptable? If not, explain why [the AGPL rewrite] is different." — ibid.

The IP-practitioner framing of the same point:

> "Unlike a human engineer who can **abstract a problem into a pure architectural spec**, an AI **directly
> transforms the protected syntax into new syntax, functioning more like a sophisticated obfuscator than a
> clean-room developer.**"
> — practitioner summary via [marks-clerk.com — "Can AI Legally Clone Open Source?"](https://www.marks-clerk.com/insights/latest-insights/102mp7s-can-ai-legally-clone-open-source-unpacking-clean-room-as-a-service/)
> and [dev.to — AI License Laundering](https://dev.to/pickuma/ai-license-laundering-how-code-generators-strip-open-source-obligations-2i0m)

The core distinction (memorize this): **a legitimate clean-room separates *reading* from *writing* across
an isolation boundary, and the boundary is a human-authored *specification of behavior* with zero
protected expression in it.** An AI (or a human) who reads the source and then emits "different-looking"
code has **carried the expression across the boundary in its head/weights.** No isolation = no independent
creation = derivative.

### 5.3 The law here is UNSETTLED — say so

Per cto-rules ("an honest 'I could not verify this' outranks a confident guess"), the honest verdict:

> "No court has ruled definitively on whether AI-trained-on-copyleft-code produces derivative works,
> whether AI-assisted 'clean room' development is valid, or even whether purely AI-generated code can be
> copyrighted at all."
> — [dev.to — AI License Laundering](https://dev.to/pickuma/ai-license-laundering-how-code-generators-strip-open-source-obligations-2i0m)

> The "Clean Room as a Service" concept (e.g. the MALUS tool) "**has not actually been tested in court and
> may … nonetheless be found to infringe copyright.**"
> — [marks-clerk.com](https://www.marks-clerk.com/insights/latest-insights/102mp7s-can-ai-legally-clone-open-source-unpacking-clean-room-as-a-service/)

`[unsettled — flagged]` Whether an AI-mediated paraphrase of AGPL source is a derivative is **legally
open**. Our discipline does **not** rely on that openness — we don't paraphrase at all. We work from the
spec (the prose blog/docs), which is unambiguously safe, rather than gambling on an untested theory.
**When the safe path and the gamble both exist, take the safe path** — that is the entire point of being
conservative about a copyleft a regulator-grade financial product is hosting.

### 5.4 The operational rule that prevents it

> **Never let OpenBB source code enter the context window of the agent that writes our fetcher.** The
> permitted inputs to the implementation step are: (a) our own spec docs, (b) the upstream **provider's**
> API docs, (c) OpenBB's **prose** blog/docs describing the *architecture*. The forbidden input is any
> file under an `openbb-*` package or the OpenBB repo's `*.py` source. If you find yourself with
> `fetcher.py` open "just to check the method signature," **stop** — you have crossed the wall, and the
> code you write next is contaminated.

This is the AI-specific corollary of the structural-contamination point: a human can *try* to forget;
an agent's clean-room integrity is enforced purely by **what you put in its context.** Keep the source out
and the wall holds; let it in and there is no wall.

---

## 6. Enforcement — making the discipline mechanical, not aspirational

A rule that lives only in prose drifts. Three mechanical guards, mirroring the repo's existing
`/sources-lint` + PreToolUse-licensing pattern:

### 6.1 Dependency lint — zero `openbb-*` packages

The strongest single proof of non-vendoring is that **no `openbb-*` package is installed.** CI greps the
lockfiles:

```bash
# ci/check-no-openbb.sh — fails the build if any openbb-* dependency is declared.
# Run in CI on the Python data-plane package (the JPM-Markets data-analytics service, NOT Lumina).
set -euo pipefail

# 1) Declared deps (pyproject + uv lock) must not mention openbb-*.
if grep -RInE '(^|[^a-z])openbb[-_][a-z]' \
      pyproject.toml uv.lock requirements*.txt 2>/dev/null; then
  echo "FAIL: an openbb-* package is declared. OpenBB is pattern-reference-only, AGPL, never vendored."
  echo "      Reimplement the TET pattern from the public spec; do not import openbb code."
  exit 1
fi

# 2) Installed site-packages must not contain an openbb distribution (defense in depth).
if python - <<'PY'
import importlib.util, sys
names = ["openbb", "openbb_core"]
hit = [n for n in names if importlib.util.find_spec(n) is not None]
sys.exit(1 if hit else 0)
PY
then :; else
  echo "FAIL: an openbb package is importable in the environment."
  exit 1
fi

echo "OK: no openbb-* dependency present (clean-room invariant holds)."
```

### 6.2 Source-import lint — no `import openbb` anywhere

```bash
# Belt-and-suspenders: no source file imports openbb, even transitively in a test or script.
if grep -RInE '^\s*(from|import)\s+openbb' --include='*.py' src/ tests/ scripts/ 2>/dev/null; then
  echo "FAIL: a source file imports openbb. The clean-room wall is breached."
  exit 1
fi
```

### 6.3 The ledger row — the durable record

The project keeps a sources-ledger (the same discipline as Lumina's
[`.claude/memory/sources-ledger.md`](../../../memory/sources-ledger.md), reused for this product line).
Add and never remove:

```markdown
| Source | Fetch/use path | License | commercialOk | Verdict | Notes |
|---|---|---|---|---|---|
| OpenBB Platform (openbb-core, openbb-* providers, openbb-mcp-server) | **PATTERN REFERENCE ONLY** — read the public blog/docs for the TET architecture; observe public API behavior | **AGPL-3.0-only** (verified pypi.org/project/openbb-core, openbb-yfinance, openbb-mcp-server; repo LICENSE = AGPL v3) | n/a (no code vendored) | **NEVER VENDORED** | Relicensed MIT→AGPL 2024-05-15. §13 network-copyleft → vendoring into our hosted DaaS would force full Corresponding-Source disclosure or a commercial license. Clean-room reimplement the TET *pattern* (idea, §102(b)) from the spec; never read/paraphrase openbb source (AI-paraphrase = derivative, §5). |
```

---

## 7. Decision tree — "may I use this from OpenBB?"

```
Is the thing I want to use from OpenBB...

├─ The PATTERN / METHOD / INTERFACE CONCEPT?
│   (TET shape, field-intersection idea, "typed query in / typed response out",
│    the *technique* of an alias dict)
│   → IDEA. Uncopyrightable (17 USC §102(b), Baker v. Selden).
│   → ✅ FREE. Reimplement from OUR spec. Cite OpenBB's *blog/docs* as the spec source, not their code.
│
├─ OpenBB's actual SOURCE CODE? (fetcher.py, data.py, registry.py, any openbb-* provider module)
│   → EXPRESSION. AGPL-encumbered.
│   → ❌ FORBIDDEN to read into our files, copy, OR paraphrase.
│     Paraphrasing read source = derivative (§5; law unsettled but we don't gamble).
│     Importing/vendoring it = §13 disclosure of OUR full source.
│
├─ An `openbb-*` PACKAGE as a dependency (even "just openbb-yfinance, it's thin")?
│   → AGPL-3.0-only (verified, §1.3). Hosting a modified version = §13.
│   → ❌ FORBIDDEN. Zero openbb-* in the lockfile (CI-enforced, §6).
│
├─ A FIELD MAPPING (provider field name → standard name)?
│   → The provider's field NAMES are facts; OUR standard names are our choice.
│   → ⚠️ Re-derive from the UPSTREAM PROVIDER's docs (EDGAR/Treasury/etc.), NOT from openbb-sec's alias file.
│     Coincidental overlap from a shared public source = independent creation. OK.
│
└─ The COMMERCIAL LICENSE (pay OpenBB, then vendor freely)?
    → A real, legal option (licensing@openbb.co). But it imports a runtime dependency + an
      AGPL-shaped relationship we don't need: the pattern is free; only the expression is sold.
    → ⏸ DEFER / DECLINE for v1. We need the idea, which is free. Revisit only if we ever decide to
      ship OpenBB's actual provider catalog wholesale (we don't — GREEN-source scope is net-new anyway).
```

---

## 8. Summary — the discipline in five lines

1. **OpenBB is AGPL-3.0-only since 2024-05-15, all `openbb-*` packages included** (core, providers,
   mcp-server — all verified). [openbb.co/blog](https://openbb.co/blog/license-change-openbb-platform-goes-agpl/),
   [pypi.org/project/openbb-core](https://pypi.org/project/openbb-core/).
2. **§13 makes a hosted DaaS the worst case**: modify + serve over a network → disclose our **entire**
   Corresponding Source, or buy a commercial license. [AGPL §13](https://opensource.org/license/agpl-v3).
3. **The pattern is free, the source is not** — idea/expression dichotomy, 17 USC §102(b), Baker v.
   Selden. Take the TET *idea*; leave the *code*.
4. **Clean-room = build from the spec (the public blog/docs/behavior), never from the source**; keep a
   light audit trail and a zero-`openbb-*` lockfile. [Clean-room design](https://en.wikipedia.org/wiki/Clean-room_design),
   NEC v. Intel.
5. **The AI-paraphrase trap is the silent killer**: rewriting read AGPL source in different words is a
   derivative (carried expression across the wall), not clean-room — and the law on it is **unsettled**,
   so we don't gamble; we never read the source into the writing agent's context.
   [shiftmag.dev](https://shiftmag.dev/license-laundering-and-the-death-of-clean-room-8528/),
   [marks-clerk.com](https://www.marks-clerk.com/insights/latest-insights/102mp7s-can-ai-legally-clone-open-source-unpacking-clean-room-as-a-service/).

**The one ledger row that encodes all of it:**
> `OpenBB = pattern-reference-only, AGPL-3.0-only, never vendored.`

---

## Appendix — confidence & open items (cto-rules §6 output discipline)

| Claim | Confidence | Basis |
|---|---|---|
| OpenBB relicensed MIT→AGPL on 2024-05-15 | **High** | OpenBB's own dated blog post, quoted verbatim. |
| All `openbb-*` packages (incl. provider extensions, mcp-server) are AGPL-3.0-only | **High** | PyPI License field read verbatim for openbb-core/openbb-yfinance/openbb-mcp-server; repo LICENSE = AGPL v3. |
| §13 obligates Corresponding-Source disclosure to remote users of a *modified* version | **High** | AGPL §13 text quoted verbatim + Kyle Mitchell's plain reading. |
| Idea/expression dichotomy makes the TET *pattern* free to reimplement | **High** | 17 USC §102(b) + Baker v. Selden, both primary/settled. |
| Clean-room (build-from-spec) defeats a derivative-work claim | **High (as doctrine)** | Wikipedia + NEC v. Intel (1990, accepted in US court); standard practice. |
| An AI line-by-line paraphrase of read AGPL source is a derivative | **Medium — law UNSETTLED** | No court has ruled; multiple practitioner sources flag it as untested. We avoid the gamble entirely. |
| Hosting an *unmodified* OpenBB would not trigger §13 | **High (as written)** | Mitchell's two-condition reading + §13 text — but moot for us, since a DaaS modifies. |
| The separate-works carve-out does NOT cover a hosted modified platform | **High** | OpenBB FAQ's own proviso ("…or used to provide a network-based service") quoted verbatim. |

**Open items for the operator (not blocking the build):**
- Whether to ever buy the OpenBB commercial license to ship their provider catalog wholesale — current
  answer **no** (our v1 scope is net-new GREEN public-domain providers; the pattern is all we need from
  OpenBB, and the pattern is free).
- Whether the EOD-vs-tick decision (a separate open-Q in the project plan) changes any provider's fetch
  path enough to need a fresh per-series license verdict — handled by the per-fetch-path ledger, not by
  this doc.
