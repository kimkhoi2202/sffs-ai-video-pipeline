# Compliance Playbook — COPPA + CARU (Kid Loop)

The hard gate for every Kid Loop riddle/quiz video and its capture funnel. If a concept, script,
asset, or page can't satisfy **every** rule here, **it does not ship.**

> **Read with:** [`riddle-video-style-spec.md`](riddle-video-style-spec.md) §0 (the same rules baked
> into the format) · [`prizes.md`](prizes.md) (prize legal) · [`prompts/asset-prompt-library.md`](prompts/asset-prompt-library.md).
>
> **Not legal advice.** This is an operational playbook. A qualified attorney and a formal **CARU
> review** must sign off before publishing. Requirements change — re-verify against current FTC COPPA
> and CARU guidance at each launch.

---

## 0. Why this is a hard gate

These videos are **child-directed** (kid audience, kid subject matter). That triggers:

- **COPPA** — the U.S. Children's Online Privacy Protection Act + the FTC COPPA Rule. Governs
  collecting **personal information** from children **under 13** online. Requires **verifiable
  parental consent** *before* collecting a child's personal info — and imposes real penalties.
- **CARU** — the Children's Advertising Review Unit (BBB National Programs) self-regulatory
  **Guidelines for Advertising & the Kids' Privacy Program**. Governs how you *advertise to* and
  *collect data from* children.
- **Platform kids' rules** — YouTube "Made for Kids" (no personalized ads, limited features),
  plus TikTok/Meta minor-safety and ad policies.

**Our strategy that satisfies all three: collect NO child data at all.** We capture a **parent's
email only**, the child is never asked for personal information, and every asset is CARU-reviewed and
brandless.

---

## 1. The four non-negotiable rules

1. **Parent-email capture ONLY.** The single conversion is a **parent** entering **their own email**.
   The gate collects a **parent email address and nothing else at entry.**
2. **Zero child PII.** Collect **no** child name, age, birthday, grade/school, city/location, photo,
   voice, contacts, or persistent identifier — anywhere in the flow (video, gate, or follow-up).
3. **CARU-reviewed.** Every script, on-screen claim, prize framing, and the gate flow passes CARU
   review **before publishing.** Truthful, age-appropriate, non-manipulative.
4. **No Alpha branding.** Carry **no Alpha School / Alpha AI** names, logos, mascots, colors, or URLs.
   Ship under the neutral **Closer** visual system only. Do not imply school affiliation.

---

## 2. The parent-email capture flow (the ONLY funnel)

The video points to a gate; the gate is a **parent** action. That's the whole flow.

```
VIDEO (kid watching)                    GATE PAGE (parent acting)              AFTER
─────────────────────                   ────────────────────────              ─────
End card: "Ask a grown-up   ──────►     "Grown-ups: enter your email    ──►   Confirmation +
to enter their email to                  to unlock your child's brain           results/score
unlock your results."                    score."                                (no child PII stored)
Link/URL on screen                       [ parent email ]  [ Unlock ]
(parent-facing)                          Consent line + links to Privacy,
                                         Prize Rules. Nothing else asked.
```

### 2.1 On-screen CTA copy (pick one; all are parent actions)

- "Ask a grown-up to enter **their** email to unlock your results."
- "Grown-ups: pop your email in to see the full brain score."
- "Parents — unlock the score (and prize entry) with your email."

**Banned on-screen copy (never use):**
- ❌ "Enter **your** email" (kid-directed data ask).
- ❌ "Type your name / age / school."
- ❌ "Tell your friends or you'll lose your prize" (pressure / nag factor).
- ❌ "Only 10 spots left — hurry!" (false scarcity / dark pattern).

### 2.2 Gate page copy + rules

- **Headline (parent-facing):** "Grown-ups: enter your email to unlock the results."
- **One field only:** parent email. **No** child fields. No "child's name" field, no age gate that
  stores age, no optional child info.
- **Consent line (plain language):** "By entering your email you confirm you're the parent/guardian,
  you're 18+, and you agree to the [Privacy Policy] and [Prize Rules]."
- **No "kid enters their own email" shortcut.** Do **not** offer a "I'm the kid" path, a child login,
  or a way for the child to self-submit. The action is a parent's, full stop.
- **Privacy-safe page:** no third-party ad SDKs, no behavioral-tracking pixels, no social login on
  the gate (IP + persistent identifiers can count as personal information under COPPA). Use
  privacy-respecting, non-personalized analytics only.
- **Double opt-in recommended** for the parent's email (confirms it's a real adult inbox and gives a
  clean consent record).

### 2.3 What we NEVER collect (child PII blocklist)

Name · age / birthday / age-range · grade or school · city / address / geolocation · photo or video
of the child · child's voice recording · phone number · email of the child · contacts / friends ·
device ID, advertising ID, or any persistent identifier tied to the child · quiz answers linked to
an identifiable child. **The child's score exists only to display back on the results page; do not
store it against a child identity.**

---

## 3. CARU child-directed advertising checklist

Run this on **every** video script, asset, and the gate before CARU submission.

**Truthfulness & fairness**

> **The rule turns on WHAT THE CLAIM IS ABOUT, not on whether it contains a number.**
> A claim about the puzzle is puffery. A claim about the product is an efficacy claim.
> An earlier version of this checklist collapsed those into one prohibition, which banned
> the format's native idiom while doing nothing to stop the claim that would actually cause
> trouble. (Amended 2026-07-31.)

- [ ] **Puzzle-difficulty framing is PERMITTED as puffery.** "97% get this wrong", "only 3%
      can solve this", "9 out of 10 people pick B" are claims about how hard one specific
      puzzle is. They are the native idiom of the quiz-short format, no viewer parses them as
      research, and they promise the child nothing. Keep them about the puzzle and keep them
      playful. No substantiation is required, and none is implied.
- [ ] **Claims about the PRODUCT, the app, or the child's OUTCOME are forbidden**, with or
      without a number. This is the class that is genuinely actionable and it is the one to
      police. Forbidden, non-exhaustively:
      - "97% of users gain 20 IQ points" · "players raise their score by X" · "N% improvement"
      - "watch daily and get smarter" · "improves memory / focus / grades / test scores"
      - "scientifically proven" · "clinically shown" · "backed by research" · "guaranteed"
      - "your child will ___" in any measurable form

      An efficacy claim requires competent and reliable substantiation before it ships, which
      in practice means **we do not make one.**
- [ ] **Never dress a product claim as difficulty framing.** "Only 3% solve this before taking
      our course" is a product claim wearing a puzzle's clothes. The tell is whether the
      sentence would still be true if the app did not exist.
- [ ] Prize benefits not exaggerated; **odds stated honestly** (§5); no unrealistic expectations.
- [ ] Nothing misleading about **what the child or parent actually gets** for the email.

> **Where this rule is enforced.** Changing it here is not enough; these must agree or a hook
> that reads as legal in the doc gets silently rejected at publish time.
>
> | Enforcement point | What it does |
> |---|---|
> | `hermes/src/brand.ts` → `ruleCheckCopy()` | Deterministic gate. Rejects product-efficacy phrasing. |
> | `hermes/src/brand.ts` → `HARD_RULES` | The rule text handed to every LLM copy prompt. |
> | `hermes/src/gates.ts` → `gateCopy()` | LLM brand-voice judge that runs on captions + on-screen copy. |
> | `hermes/src/design.ts` → `makeCaption()` | Caption generation system prompt. |
> | `brand/brand-voice.md` §3 | The human-facing voice rules. |
> | `ab-testing/hook-bank.json` → `claim_rules` | Per-line `claim_class` tagging for the hook bank. |
> | `templates/script-template.md` §3.1 | Cold-open hook guidance. |
> | `riddle-video-style-spec.md` §3 | The format spine that specifies the "X% fail" beat. |

**Age-appropriateness & pressure**
- [ ] Language, difficulty, and tone suit the target age; non-scary, non-violent, non-shaming.
- [ ] **No undue pressure / "nag factor"** — never urge kids to pester parents to act, buy, or enter.
- [ ] **No false urgency / scarcity / countdown-to-buy** dark patterns. (The in-puzzle think-timer is
      gameplay, not a purchase countdown — keep it clearly a puzzle timer.)
- [ ] Doesn't exploit a child's imagination or inexperience to manipulate.

**Ad / content clarity**
- [ ] The video is clearly entertainment; any sponsorship/endorsement is **disclosed** in kid-clear
      terms. Don't blur ads and editorial.
- [ ] Any influencer/creator promotion carries a clear, child-understandable disclosure.

**Privacy (CARU + COPPA aligned)**
- [ ] **No personal info is requested from the child** at any point.
- [ ] Data collection (parent email) happens **only** on the parent-facing gate with consent.
- [ ] Privacy disclosures are clear, conspicuous, and understandable.

**Prizes / sweepstakes (if shown)**
- [ ] Prize framing is **parent-facing**; entry requires the **parent**.
- [ ] Odds/selection, eligibility, deadlines, and **public official rules** are linked and clear.
- [ ] No implying a child will "definitely win" or that winning is easy.

**Safety**
- [ ] No unsafe acts, no scary/inappropriate imagery, no contact-with-strangers prompts.

---

## 4. The no-Alpha-branding rule

- **Zero** Alpha School / Alpha AI names, logos, wordmarks, mascots, brand colors, slogans, staff, or
  URLs — in-video, in thumbnails, on the gate, in descriptions, in music, or in metadata.
- **Do not imply school affiliation, accreditation, or endorsement.** No "an Alpha company,"
  "powered by Alpha," etc.
- The **only** brand present is the neutral **Closer** visual system (`DESIGN.md`).
- Applies to **all** surfaces and repurposed cuts (Shorts, carousel, blog — see
  [`repurposing.md`](repurposing.md)) and to channel art, handles, and bios.

---

## 5. Prize legal notes (summary — full detail in `prizes.md`)

Two publicly-documented tiers: **$500 input/participation** and **$2,000 spotlight**.

- **Parent is the named recipient/custodian.** The prize is awarded to the **parent/guardian** (18+ /
  age of majority) who entered, **on behalf of** the child. The child is never the contracting party
  and is never required to give PII to claim.
- **W-9 + 1099 for prizes ≥ $600.** For any prize with a value **≥ $600 to one household in a
  calendar year**, collect a **Form W-9** (TIN) from the **parent** before payout and issue a **Form
  1099-MISC**. The **$2,000 spotlight always triggers** this; **stacked $500 inputs** to one
  household can cross $600 in a year — track per household. Taxes are the winner's responsibility.
- **Public official rules** (linked from the gate + any prize mention): sponsor identity (neutral,
  **not Alpha**), eligibility, **no purchase necessary**, **void where prohibited**, entry method
  (parent email), selection method + **odds**, **ARV** (approximate retail value), key dates, winner
  notification/claim, and publicity/consent terms.
- **CARU-safe prize copy:** parent-facing, honest odds, no pressure, no "win for sure."

See [`prizes.md`](prizes.md) for the mechanic, announcement, and winner-documentation flow.

---

## 6. On-screen compliance checklist (per video)

- [ ] CTA is a **parent-email** action, plainly worded ("ask a grown-up…") — **no child data asked on screen.**
- [ ] **No child PII** requested or shown anywhere in the video.
- [ ] Script + claims + prize framing **submitted to CARU and cleared.**
- [ ] **No Alpha** name/logo/color/URL anywhere (incl. thumbnail, end card, description, metadata).
- [ ] Prize tiers ($500 input / $2,000 spotlight), if shown, link to **public rules** (parent-facing).
- [ ] No dark patterns, no false urgency/scarcity, no "nag your parents," no shaming.
- [ ] Puzzles/copy/music **original** (or licensed) and age-appropriate; nothing scary.
- [ ] Marked **"Made for Kids"** where required (YouTube) and compliant with platform kids' policies.

## 7. Capture-page compliance checklist (per gate)

- [ ] **Parent email is the ONLY field.** No child fields; no "child's name/age/school."
- [ ] Headline + consent line are **parent-facing** and plain-language.
- [ ] **No "kid enters their own email"** path, child login, or child self-submit.
- [ ] Links present and working: **Privacy Policy** + **Prize Official Rules**.
- [ ] **No ad/tracking SDKs, no behavioral pixels, no social login**; privacy-safe analytics only.
- [ ] Double opt-in for the parent email (recommended); clean consent + timestamp stored.
- [ ] Child's score is displayed only — **not stored against any child identity.**
- [ ] Data retention + deletion path documented; parent can request deletion.

---

## 8. Approval log (fill in before publishing — keep a record)

| Check | Owner | Date | Status / notes |
|---|---|---|---|
| Script CARU review | | | |
| Assets/thumbnail CARU review | | | |
| Gate page privacy review | | | |
| Prize official rules posted + linked | | | |
| Legal sign-off (COPPA + prizes) | | | |
| No-Alpha-branding audit (all surfaces) | | | |
| Platform "Made for Kids" flags set | | | |

> **Rule of thumb:** when unsure whether something counts as child PII or as a dark pattern, **treat
> it as if it does** and cut it. The funnel works with a parent email and nothing else.

---

### Related docs
[`README.md`](README.md) · [`riddle-video-style-spec.md`](riddle-video-style-spec.md) ·
[`prizes.md`](prizes.md) · [`repurposing.md`](repurposing.md) ·
[`prompts/asset-prompt-library.md`](prompts/asset-prompt-library.md)
