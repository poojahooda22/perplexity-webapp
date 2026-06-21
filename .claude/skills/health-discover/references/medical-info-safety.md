# Medical-Information Safety — the no-harm contract for health prose

> The rules for any health text Lumina generates or surfaces: how to be *useful* without crossing
> into diagnosis, dosage, or personalized treatment; how to name authoritative sources; how to
> express uncertainty; how to frame emergencies; and how age/condition sensitivity changes the
> answer. This is a **generic-domain** ref (reusable knowledge — applies to any health surface),
> grounded in our live `WORKFLOWS` prompts where the framing already lives. Read it when writing a
> workflow prompt, a system/persona for a health agent, a disclaimer, or reviewing health output.
> Sibling refs cover adjacent ground: `health-news-sourcing.md` (where content comes from + display
> licensing), `health-domain-coverage.md` (which topics + source-quality tiers), and
> `health-workflows-and-upload.md` (the lab-report upload + PHI handling). For the legal "can we
> display it" question, that's licensing — see `health-news-sourcing.md`, not this file.

---

## 1. The one line that governs everything

**Lumina health output is informational and educational — it is NOT medical advice, diagnosis, or
treatment, and it never replaces a qualified clinician.** Every other rule in this doc is a
consequence of that line. The product makes this concrete in code: the workflow prompts in
[`frontend/src/components/discover/health-view.tsx`](../../../../frontend/src/components/discover/health-view.tsx)
are deliberately phrased as *guidance* ("Explain how to read…", "evidence-based ways to…", "Note
anything I should discuss with a doctor") — never "tell me what I have" or "what should I take."
The upload prompt is the model case: *"Summarize this health report and explain the key findings in
plain language. **Note anything I should discuss with a doctor.**"* — explain + route to a
clinician, do not adjudicate.

---

## 2. The safety register — six dimensions

Every health answer is scored on six axes. The job is to land in the **safe** column on all six.

| Dimension | ❌ Unsafe (do NOT) | ✅ Safe (do instead) |
|---|---|---|
| **Advice vs. info** | "You should start metformin." / "Stop taking your statin." | "Metformin is a common first-line option for type-2 diabetes; whether it's right for *you* is a conversation with your doctor." |
| **Diagnosis** | "Based on your symptoms you have appendicitis." | "Right-lower-quadrant pain with fever has several possible causes, some urgent. A clinician needs to examine you to tell them apart." |
| **Dosage** | "Take 800 mg ibuprofen every 4 hours." | "Ibuprofen dosing depends on age, weight, and kidney/stomach history — follow the label or your pharmacist/doctor." |
| **Certainty** | Stating a contested or evolving claim as settled fact. | Calibrated language + name the evidence level (§5). |
| **Source** | An unattributed health assertion from model memory. | Live-searched + cited, or attributed to a named authority (WHO/CDC/NIH/ICMR, §4). |
| **Urgency** | Burying a red-flag symptom in a calm paragraph. | Lead with the emergency framing (§6) before anything else. |

---

## 3. The diagnosis / dosage line — where "useful" stops

The two hardest temptations are **naming the condition** and **naming the number**. Both feel
helpful; both are where medical-info products cause real harm. The line:

| You MAY | You MAY NOT |
|---|---|
| Explain what a condition *is*, its typical symptoms, and general causes. | Conclude that *this user* has it ("you have X"). |
| List the **differential** — the range of things a symptom *could* mean — and which are urgent. | Pick one as the answer. |
| Describe **typical** reference ranges for a lab marker ("fasting glucose is usually reported normal under ~100 mg/dL"). | Interpret *this user's* value as a verdict on their health ("your 105 means you're diabetic"). |
| Explain how a drug class works and common side-effects. | Prescribe a drug, a dose, a frequency, or tell them to start/stop/change one. |
| Help the user **prepare questions** for their clinician (the "Visit prep assistant" workflow). | Substitute for the visit. |

**The reference-range nuance:** the "Lab results interpreter" workflow is allowed precisely because
its prompt says *"Explain how to read common blood-test and lab markers in plain language, and
what's typically normal vs. flagged"* — general education about ranges, not a verdict on the user's
specific numbers. When a real uploaded report is involved, summarize and **flag what to discuss
with a doctor** (the upload prompt), never "your result means you have…". This is the difference
between teaching someone to read a map and telling them they're lost.

---

## 4. Authoritative sources — the trust ladder

A health claim is only as good as where it's grounded. Prefer the highest tier available, and
**name the source** in the answer (full source-quality tiers live in `health-domain-coverage.md`;
this is the safety-facing summary).

| Tier | Sources | Use for |
|---|---|---|
| **Apex (global)** | WHO, Cochrane systematic reviews, peer-reviewed meta-analyses | Established consensus, contested-claim arbitration |
| **National public-health** | CDC, NIH/MedlinePlus, NICE (UK), ICMR / MoHFW / PIB (India) | Guidelines, screening, prevention, dosing *frameworks* (not personalized) |
| **Professional bodies** | AHA, ADA, ACOG, IAP, specialist societies | Condition-specific clinical guidance |
| **Reputable clinical reference** | Mayo Clinic, Cleveland Clinic, NHS, UpToDate-class | Plain-language explanations |
| **Avoid as authority** | Forums, anecdote, supplement-seller blogs, unattributed AI memory, single small studies stated as fact | Never the basis for a health claim |

**Geography matters:** for India-market answers, prefer ICMR/MoHFW/PIB and Indian professional
bodies — drug availability, naming, and guidelines differ (this mirrors the `INDIA_HEALTH_DOMAINS`
split in [`backend/discover/health.ts`](../../../../backend/discover/health.ts)). Don't quote a
US-only brand name or a US screening schedule to an Indian user as universal.

**Grounding, not memory:** for anything time-sensitive or specific (an outbreak, "latest
guidance," a current drug recall), the claim must come from a **live web search** with `[n]`
citations — not the model's training memory. That routing belongs to the research pipeline
(`onAsk` → `/perplexity_ask`); see **research-agent**. Health facts fabricated from memory are the
worst failure mode here, exactly as fabricated prices are in finance.

---

## 5. Expressing uncertainty — calibrated language

Health knowledge is probabilistic and evolving. Match the words to the actual evidence strength;
never launder a weak signal into a confident sentence.

| Evidence reality | Say | Don't say |
|---|---|---|
| Strong consensus / multiple RCTs | "Robust evidence shows…" / "Established guidance is…" | (fine as-is) |
| Mixed or limited studies | "Some studies suggest…, but evidence is limited / mixed." | "Research proves…" |
| Mechanism plausible, outcomes unproven | "It's biologically plausible, but not shown to improve outcomes." | "It works." |
| Individual variation dominates | "This varies a lot by person — your clinician can advise on your case." | A single number/answer for everyone |
| You don't know / it's outside scope | "I don't have reliable information on that — please ask a clinician." | A confident guess |

Pair uncertainty with a **next step** ("…discuss with your doctor / pharmacist"). Honest
uncertainty + a route to a real clinician is the safe answer — not a confident wrong one, and not a
useless non-answer.

---

## 6. Emergency framing — surface it FIRST, then explain

When input contains red-flag symptoms, the urgent guidance leads the answer — before any
explanation, differential, or context. Burying "this could be a stroke" under three calm paragraphs
is a safety failure even if the paragraphs are correct.

**Red-flag triggers (non-exhaustive):** chest pain/pressure, difficulty breathing, sudden severe
headache, face/arm/leg weakness or slurred speech (stroke), suicidal/self-harm ideation, severe
allergic reaction / anaphylaxis, uncontrolled bleeding, signs of sepsis, severe abdominal pain,
poisoning/overdose, sudden vision loss, seizure, pregnancy complications, infant high fever.

**The pattern:**

```
[IF red-flag present]
  → Lead with: "This may be a medical emergency. Call your local emergency number
     (e.g. 911 in the US, 112 in the EU, 112/108 in India) or go to the nearest
     emergency department now."
  → THEN (optionally) brief context, but do not delay the call with explanation.
[crisis/self-harm]
  → Surface a crisis line (e.g. 988 in the US) + urge contacting someone now;
     stay supportive, do not diagnose.
```

**Don't hardcode one country's number.** Say "your local emergency number" with examples, since the
audience spans US and India (and beyond). Never tell someone in an emergency to "wait and see" or
to "try X first."

---

## 7. Age / condition sensitivity — the answer changes by who's asking

A generically-correct health statement can be wrong or dangerous for a specific population. When the
context reveals one of these, adjust — and when it's *unknown but relevant*, ask or caveat rather
than assume an average adult.

| Population | What changes |
|---|---|
| **Infants / children** | Dosing is weight-based; many adult OTC drugs are unsafe; fever thresholds differ; default to pediatric care fast. |
| **Pregnancy / breastfeeding** | Huge list of contraindicated drugs/foods/activities; "ask your obstetrician" is almost always part of the answer. |
| **Older adults** | Polypharmacy + interactions, renal/hepatic clearance, fall/fracture risk; "normal" ranges shift. |
| **Chronic conditions** (diabetes, kidney/liver disease, immunocompromised, cardiac) | General advice (e.g. "drink lots of fluid," "take NSAIDs") can be actively harmful. |
| **Drug interactions** | A safe drug becomes unsafe with the user's other meds — never green-light without acknowledging this. |
| **Mental-health context** | Extra care, non-judgmental, crisis-aware (§6). |

**Rule:** if a population-sensitive factor is plausibly relevant and unknown, the safe move is to
*ask* (the better workflows already do — "ask me about my goals, fitness level… first") or to
*caveat* ("this is general adult guidance; for a child / during pregnancy / with kidney disease,
the answer differs — check with a clinician").

---

## 8. The disclaimer — necessary, not sufficient

A not-advice disclaimer is required, but it is the floor, not the ceiling. A correct disclaimer
stapled onto unsafe content (a diagnosis, a dose) does **not** make it safe.

- **Placement:** brief and present. In finance, `withGuard` staples a `_disclaimer` onto every tool
  result (see [`backend/finance/hooks.ts`](../../../../backend/finance/hooks.ts)) — health prose
  should likewise carry a short closing line ("This is general information, not medical advice —
  consult a clinician.").
- **Don't let it do the heavy lifting.** The disclaimer is not a license to then diagnose. Fix the
  *content* (§3), then add the disclaimer.
- **Don't drown the answer in legalese.** One clear sentence beats a paragraph nobody reads.

---

## 9. Decision framework — "is this health output safe to ship?"

Run this gate on any health prose (workflow prompt, persona output, generated summary, answer):

```
1. Does it tell a specific person they HAVE a condition?            → NO. Rewrite to differential + "see a clinician".
2. Does it give a dose / drug / start-stop-change instruction?      → NO. Rewrite to "follow label / ask pharmacist-doctor".
3. Are red-flag symptoms present?                                   → YES → emergency framing FIRST (§6).
4. Is a claim stated with more certainty than the evidence?         → Recalibrate language (§5).
5. Is a specific/time-sensitive claim grounded + cited?             → If not, route to live search; don't answer from memory.
6. Is a population-sensitive factor relevant but unknown?           → Ask or caveat (§7).
7. Is an authoritative source named where it matters?               → Add it (§4); India market → Indian bodies.
8. Is the not-advice framing present (and the content already safe)?→ Add the line (§8).
ALL pass → ship.   ANY fail → fix that axis, re-run.
```

---

## 10. Anti-patterns → do instead

| ❌ Anti-pattern | ✅ Do instead |
|---|---|
| "Based on what you described, you have X." | Give the differential, flag the urgent possibilities, send to a clinician for the actual call. |
| "Take 500 mg of Y twice a day." | Explain the drug class generally; dosing = label / pharmacist / doctor. |
| Telling a user to start/stop/switch a prescribed medication. | "That's a decision to make with the prescribing clinician — here's what to ask." |
| Interpreting an uploaded lab value as a personal verdict. | Summarize in plain language + "flag this to discuss with your doctor" (the live upload prompt). |
| Stating a mixed-evidence or evolving claim as settled fact. | Calibrate ("some studies suggest… evidence is limited") + name the source. |
| Answering a "latest outbreak / current guidance" question from memory. | Route to live web search with `[n]` citations; never fabricate health facts or dates. |
| Burying a stroke/heart-attack red flag mid-paragraph. | Lead with the emergency line + local emergency number, THEN context. |
| Hardcoding "call 911" for a global/India audience. | "Your local emergency number (e.g. 911 US / 112 EU / 112/108 India)." |
| Giving average-adult advice to a child/pregnant/chronic-condition user. | Ask the population factor or caveat that the answer differs for that group. |
| A scary disclaimer stapled onto a diagnosis/dose. | Fix the content first; the disclaimer never rescues unsafe substance. |
| Quoting US-only drug brands/screening schedules to an Indian user as universal. | Prefer ICMR/MoHFW guidance; note availability/naming differs by country. |
| A workflow prompt phrased "tell me what's wrong with me." | Phrase as guidance ("explain how to assess… note anything to discuss with a doctor"), mirroring the live `WORKFLOWS`. |

---

## 11. Cross-references

- **Where content comes from + whether we can display it** (the licensing/`commercialOk` gate,
  transformative synthesis, link-out-only) → `health-news-sourcing.md`. *That* is the legal layer;
  *this* is the harm layer — both must pass.
- **Which topics to cover + the full source-quality tiers** → `health-domain-coverage.md`.
- **The lab-report upload + PHI-adjacent handling (no persistence, no cache, per-request only)** →
  `health-workflows-and-upload.md`.
- **The live-search/citation pipeline that grounds time-sensitive health facts** → **research-agent**.
- **The not-advice disclaimer-stapling pattern that finance already implements** (`withGuard` +
  `_disclaimer`, the `FINANCE_PERSONA` no-advice contract) → finance-markets
  `data-licensing-and-compliance.md` / `ai-sdk-finance-agent.md`; the mechanism is identical, only
  the domain changes.
