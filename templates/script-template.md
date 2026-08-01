# Voiceover Script Template — "Smart Fella" Game-Show Host

A reusable **voiceover (VO) script** template for a Kid Loop round, written for the **ElevenLabs
host persona**. Fill the `{{slots}}`, keep the backbone order (spec §3), and hand the finished script
to the storyboard (`storyboard-shotlist.md`) so beats line up 1:1.

> **Pairs with:** `../riddle-video-style-spec.md` (backbone, pacing) · `../production-brief.md`
> (funnel, compliance, tiers) · `../content/starter-quiz-bank.md` (puzzles) ·
> `storyboard-shotlist.md` (on-screen beats).
> **Compliance:** the **only** CTA is the **parent-email** gate; it lives in the **outro**, never
> inside a puzzle. No child-data asks anywhere. Keep every claim truthful and CARU-safe (spec §0).

---

## 1. Host persona (ElevenLabs voice direction)

**Who:** "Smart Fella" — an upbeat **game-show host**. Warm, high-energy, a little cheeky, always
on the kid's side. Celebrates every viewer; **never** mocks a wrong answer ("no worries — that one's
tricky!").

**Voice profile / ElevenLabs settings (starting point — tune per voice):**
- **Style:** expressive, animated game-show energy; **Stability ~40–55%** (lively but consistent),
  **Style/exaggeration ~35–55%**, **Speed ~1.0** (drop to ~0.9 on reveals).
- **Diction:** crisp, kid-clear; simple words; short sentences.
- **Range:** big lift on the hook and reveal; **soft + slow** on the "think" beat.

**Pacing targets:**
- Narration/patter: **~140–160 wpm**. Question read: **~110–120 wpm** (slower, clearer).
- Reveal line: **slow**, land the ✓. Explanation: **one calm line**, then move on.
- Total per round (baseline): **~30–45 s** (spec §5).

---

## 2. Delivery & notation key

Use these markers consistently — they drive both the VO performance and the on-screen sync.

| Marker | Meaning (delivery) |
|---|---|
| `...` | **Micro-pause / suspense beat.** Also cues ElevenLabs to slow and breathe. Stack for a longer hang: `......` |
| `[PAUSE 2s]` | **Hard timed pause** (no VO) — usually the countdown "think" window. |
| **ALL-CAPS** | **Emphasis / energy spike.** Punch the word. (Also matches the on-screen Anton word.) Use sparingly — 1–2 per beat. |
| `[COUNTDOWN 7s]` | Timer is live on screen for N seconds; VO either goes silent or does a light tease (see round block). |
| `(SFX: …)` | Sound effect cue — punchy click / thock / slam / ding (spec §10). |
| `(MUSIC: …)` | Music-bed cue — e.g. `bed up`, `duck under VO`, `sting`. |
| `[ON-SCREEN: …]` | What the graphic shows at that line (mirror of the storyboard). |
| `{{slot}}` | Fill-in placeholder. |

**Delivery notes**
- ElevenLabs reads **punctuation**, not formatting — so write pauses as `...`, commas, and line
  breaks; treat **ALL-CAPS** and `[PAUSE]` as **stage directions** (punch the caps word in your read;
  render `[PAUSE]` as a real silence in the edit). For long silences, insert a period line or split
  the take.
- Read numbers/answers **slowly and clearly**. Spell tricky answers if needed ("Q-U-E-U-E").
- Keep questions to **one idea, ≤ ~8 words on screen** (spec §11.2), even if the VO says a little more.

---

## 3. The script (fill the slots)

### 3.0 Metadata
```
Round set:   {{video title}}
Variant:     {{a MC quiz-board | b open riddle | c animated}}   Pacing: {{baseline | slow-deep | fast-long | short-form}}
Puzzles:     {{Q-numbers from starter-quiz-bank.md}}   Count: {{N}}
Score tiers: Rookie Riddler ({{0–x}}) · Sharp Cookie ({{x–y}}) · Certified Smart Fella ({{y–N}})
```

### 3.1 Cold-open hook  *(0:00–~0:12)*
> Dare them in the first seconds. **"X% fail / only Y% can solve this" hooks are fine** — they are
> difficulty puffery about the puzzle and need no substantiation. What is NOT fine is any claim about
> the product or the viewer's outcome ("97% of users gain 20 IQ points", "watch daily and get
> smarter"). See `compliance.md` §3 for the line and the full forbidden list.

```
(MUSIC: bed up, bright)  (SFX: slam)
[ON-SCREEN: HOOK CARD — "{{HOOK LINE, ≤6 WORDS}}"]

"{{Only the sharpest brains finish all N of these}}... can YOU?
{{N}} puzzles. One timer each. Ready?"
(SFX: ding)
```

### 3.2 Title / promise card  *(~0:12–0:18)*
```
[ON-SCREEN: TITLE CARD — "{{N}} {{RIDDLES | BRAIN-BENDERS | QUESTIONS}}"]
"Here's how it works... question pops up, the timer starts, you shout your answer before it runs out.
Keep score. Let's GO!"
(SFX: thock)  (MUSIC: duck under)
```

### 3.3 Round block  *(repeat ×N — escalate difficulty, vary type)*
> One reusable beat set. The `options` line only applies to **variant (a)**.

```
── ROUND {{n}} / {{N}} ──  [ON-SCREEN: EYEBROW PILL "RIDDLE {{n}} / {{N}}", stage block color {{accent}}]

SETUP        "{{One-line tee-up / theme}}..."
             [ON-SCREEN: media in sticker frame / text band]
QUESTION     "{{Question read, ~≤8 words on screen}}"     (slow, clear)
             [ON-SCREEN: question card — ANTON UPPERCASE]
OPTIONS (a)  "Is it... A, {{opt A}}... B, {{opt B}}... C, {{opt C}}... or D, {{opt D}}?"
             [ON-SCREEN: 4 option tiles — blue / mint / coral / yellow]
COUNTDOWN    "Clock's on... [COUNTDOWN {{s}}s]"   (VO silent or light tease: "tick... tick...")
             [ON-SCREEN: yellow timer bar OR Anton number-flex]
SUSPENSE     "......"   (MUSIC: sting)   (SFX: rising tick)
REVEAL       "The answer is... {{ANSWER}}!"   (slow — land it)
             [ON-SCREEN: mint ✓ on correct ( coral ✗ on wrong ) + big Anton answer]  (SFX: ding + slam)
EXPLAIN      "{{One-line why — the explanation from the bank}}."
SCORE PATTER "{{Got it? +1! / Missed it? No worries — that one's sneaky.}} Score check: {{running note}}."
             [ON-SCREEN: score chip updates]
BUMPER       "Next one's {{tougher / a classic / my favorite}}..."   (SFX: color-block slam)
             [ON-SCREEN: hard color-block wipe → Round {{n+1}}]
```

**Optional interlude** (after rounds 2, 4, 6 in baseline; spec §5):
```
[ON-SCREEN: stat / fun-fact card]
"Quick brain-break... {{light, true fun fact or encouragement}}. Okay — back to it!"
```

### 3.4 Score reveal + tiers  *(last ~0:20–0:25)*
```
(MUSIC: bed up)  [ON-SCREEN: tiered SCORE CARD — big Anton number]
"Time to tally it up... how many did you get?
{{0–x}}? You're a ROOKIE RIDDLER — nice start.
{{x–y}}? SHARP COOKIE. Very nice.
{{y–N}}? You are a CERTIFIED SMART FELLA. Take a bow!"
(SFX: ding)
```

### 3.5 Parent-email CTA outro  *(the one CTA — parent action)*
> **Compliance-critical.** Parent action, plainly worded; **no** child data; prize is parent-facing
> and links to **public rules** (spec §0, §11.10; brief §8–§9).

```
[ON-SCREEN: OUTRO CTA CARD — "ASK A PARENT TO UNLOCK YOUR RESULTS"]
"Want your full results and to see how you rank?
Grab a grown-up... ask a PARENT to pop their email in at {{gate URL / on-screen link}} —
they'll unlock your score, and they can enter you for our prizes.
[ON-SCREEN: prize pill — "$500 + $2,000 prizes · parents: see full rules {{rules URL}}"]
(Parents — full rules are right there on the link.)"
```

### 3.6 End screen  *(last ~0:05–0:10)*
```
[ON-SCREEN: END SCREEN — bordered Subscribe / Watch-next / Playlist cards + 150×150 watermark]
"Hit subscribe for a new brain-buster every week...
and tap here for the next round. See you there!"
(MUSIC: button)  (SFX: slam-out)
```

---

## 4. Fully-written EXAMPLE round

**Puzzle:** Q2 "Keys but no locks" (Riddle · Brain-Bender · variant **(b)** open riddle · 8 s) from
`../content/starter-quiz-bank.md`. This is Round 3 of a 7-round baseline; stage block = **blue**.

```
── ROUND 3 / 7 ──  [ON-SCREEN: EYEBROW PILL "RIDDLE 3 / 7", stage block BLUE]

SETUP      "Round three... this one trips up the grown-ups."
           [ON-SCREEN: bordered sticker frame, empty, waiting]
QUESTION   "I have KEYS... but no locks.
            A space bar... but nothing to drink.
            And letters... but I send no mail.
            What am I?"                              (slow, playful)
           [ON-SCREEN: question in ANTON UPPERCASE on an ink card over the frame]
COUNTDOWN  "Clock's on... [COUNTDOWN 8s]"            (VO drops out; light "tick... tick...")
           [ON-SCREEN: yellow timer bar draining, black border + hard shadow, bottom-center]
SUSPENSE   "......"                                  (MUSIC: sting)  (SFX: rising tick)
REVEAL     "It's a... KEYBOARD!"                     (slow — land it)
           [ON-SCREEN: sticker frame slams to a KEYBOARD; mint ✓ badge pops; big ANTON "KEYBOARD"]
           (SFX: ding + slam)
EXPLAIN    "A keyboard's got keys, a space bar, and letters... just not the everyday kind."
SCORE      "Nailed it? That's a point! Missed it? Ohh, so close — I told you it was sneaky.
            That's three down, four to go."
           [ON-SCREEN: score chip ticks up]
BUMPER     "Next one... is my FAVORITE."            (SFX: coral color-block slam)
           [ON-SCREEN: hard wipe BLUE → CORAL, "ROUND 4"]
```

**Mini cold-open + outro for this set (illustrative):**
```
COLD-OPEN  (MUSIC: bed up)(SFX: slam)  [ON-SCREEN: HOOK — "7 RIDDLES. CAN YOU FINISH?"]
           "Only the sharpest brains finish all seven of these... can YOU?
            Seven riddles. One timer each. Ready?" (SFX: ding)

OUTRO      [ON-SCREEN: "ASK A PARENT TO UNLOCK YOUR RESULTS"]
           "Want your full score and your rank? Grab a grown-up...
            ask a PARENT to enter their email at smartfella.example/results —
            they'll unlock your results and can enter you for our prizes.
            [ON-SCREEN: pill — "$500 + $2,000 prizes · parents: full rules smartfella.example/rules"]
            Parents — full rules are on the link. Subscribe for a new one every week... see you next round!"
```

---

## 5. Do / Don't (script)

**DO**
- Keep the **backbone order** (spec §3): hook → title → question(+options) → timer → **mint ✓
  reveal** → one-line explain → tiered score → parent-email CTA → end screen.
- Use `...` and `[PAUSE]` for suspense; **ALL-CAPS** to punch 1–2 words per beat.
- Celebrate wins **and** misses kindly; keep tiers non-shaming (Rookie Riddler / Sharp Cookie /
  Certified Smart Fella).
- Read answers slowly; keep one calm explanation line.

**DON'T**
- ❌ Put the email CTA (or any data ask) inside a puzzle — outro only, **parent** action.
- ❌ Invent fake stats ("99% fail"), fake scarcity, or "tell your friends or lose your prize."
- ❌ Mock wrong answers or use "dumb/genius" shaming language.
- ❌ Mention Alpha School / Alpha AI or imply school affiliation.
- ❌ Overwrite the question card (> ~8 words) or stack more than one idea per screen.
