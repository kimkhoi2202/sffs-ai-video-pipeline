# SFFS brand voice - example library

> **229 real, verbatim examples across 32 surfaces**, mined from the SFFS website and video pipeline. This is the training corpus the auto-replier and the caption / variant generators learn from. Companion to `brand-voice.md` (the principles + hard rules). Machine-readable mirror: `brand-voice-examples.json`.

Everything below is REAL copy pulled from the repos, labeled by surface. Prefer copying / recombining these over inventing new phrasing. A few legacy website strings contain em dashes (preserved verbatim as mined); do NOT reproduce em dashes in generated social copy - see `brand-voice.md`.

**Handles:** IG + TikTok `@smartfellafartsmellatest` · **Site:** smartfellaorfartsmella.com

## Surfaces (count)

- **brand-name-taglines** (7) - The name, taglines, and one-line descriptions of the product.
- **headline** (9) - Big hero / share-card headlines.
- **subhead** (3) - Supporting lines under a headline or section title.
- **eyebrow-badge** (4) - Small tracked labels / sticker badges above titles or on CTAs.
- **cta** (2) - Call-to-action button text.
- **cta-microcopy** (3) - Tiny microcopy near CTAs and scroll cues.
- **section-heading** (7) - Section titles down the landing page.
- **step-howitworks** (3) - The 'how it works' steps: label, title, body.
- **checklist-smart** (4) - The 'Smart Fella' side of the 'Which one are you, really?' checklist.
- **checklist-fart** (4) - The 'Fart Smella' side of the checklist.
- **feature-whatyouget** (6) - 'What you actually get' report features: title + body.
- **testimonial** (6) - Fake-but-funny social proof quotes with name + role.
- **pricing** (6) - Pricing copy for the single one-time test.
- **faq-q** (5) - FAQ questions, written in the voice of a nervous / defensive fella.
- **faq-a** (5) - FAQ answers.
- **caption** (20) - REAL social post captions (TikTok + Instagram).
- **caption-template** (3) - Canonical caption templates the poster tooling uses.
- **hashtag-set** (8) - Rotating hashtag sets used in the live A/B test, plus historical sets seen on posts.
- **on-screen** (8) - Burned-in on-screen text on the video plates (intro, score, reveal, prompts framing).
- **question-onscreen** (11) - Verbatim printed quiz prompts (the puzzle question text shown on screen).
- **category-label** (9) - On-screen quiz category / topic pills.
- **explanation-onscreen** (10) - On-screen answer explanations.
- **endcard** (23) - Endcard / brand-promo on-screen lines (outro + self-contained brand intro + reply short).
- **verdict** (6) - The Smart Fella / Fart Smella verdict device: score tiers, the verdict endcard, and the rubber-stamp reward.
- **hook** (6) - The hook TYPES used across posts (the opening promise + which CTA the post leans on).
- **vo-host** (10) - Game-show host narration (voice-over).
- **vo-question** (5) - Question-read narration.
- **vo-reveal** (6) - Answer-reveal narration.
- **signature-phrase** (24) - Recurring phrases + vocabulary that ARE the brand.
- **comment-reply-correct** (1) - Approved replies to a CORRECT guess.
- **comment-reply-wrong** (1) - Approved replies to a WRONG / 'idk' guess.
- **comment-reply-nudge** (4) - The follow / come-back nudges that MUST close every reply (pick one, keep it casual).

---

## brand-name-taglines  ·  7

_The name, taglines, and one-line descriptions of the product._

- `Smart Fella or Fart Smella?`  
  <sub>app/layout.tsx (site title)</sub>
- `The Fella Test - Smart Fella or Fart Smella?`  
  <sub>app/page.tsx (page title)</sub>
- `A brutally honest 60-second diagnostic that scores your fella-ness and reveals whether you're a Smart Fella or a Fart Smella. Backed by vibes and questionable science.`  
  <sub>app/layout.tsx + app/page.tsx (meta description)</sub>
- `Take the 60-second Fella Test and find out whether you're a Smart Fella or a Fart Smella.`  
  <sub>app/layout.tsx (OG/Twitter description)</sub>
- `Smart Fella or Fart Smella? - take the brutally honest 60-second Fella Test.`  
  <sub>app/_og/card.tsx (ogAlt)</sub>
- `The brutally honest 60-second Fella diagnostic.`  
  <sub>app/_og/card.tsx (OG tagline)</sub>
- `© 2026 Smart Fella or Fart Smella`  
  <sub>components/sections/site-footer.tsx</sub>

## headline  ·  9

_Big hero / share-card headlines. The SMART FELLA vs FART SMELLA binary front and center._

- `Are you a`  
  <sub>hero lead (smart-fart-hero.tsx)</sub>
- `Smart Fella`  
  <sub>hero smartWord</sub>
- `or`  
  <sub>hero orWord</sub>
- `Fart Smella?`  
  <sub>hero fartWord</sub>
- `ARE YOU A`  
  <sub>app/_og/card.tsx (share card)</sub>
- `SMART FELLA`  
  <sub>app/_og/card.tsx (share card)</sub>
- `OR`  
  <sub>app/_og/card.tsx (share card)</sub>
- `FART SMELLA?`  
  <sub>app/_og/card.tsx (share card)</sub>
- `So... smart fella or fart smella?`  
  <sub>CtaBand title (app/page.tsx)</sub>

## subhead  ·  3

_Supporting lines under a headline or section title._

- `A brutally honest 27-question diagnostic that scores your fella-ness and tells you exactly which one you are. Backed by vibes, peer pressure, and questionable science.`  
  <sub>hero subtitle</sub>
- `Every test unlocks a full breakdown you can screenshot, share, and argue about for weeks.`  
  <sub>FeatureGrid intro (app/page.tsx)</sub>
- `for more brain-teasers`  
  <sub>FollowUs subtitle</sub>

## eyebrow-badge  ·  4

_Small tracked labels / sticker badges above titles or on CTAs._

- `The 60-second fella diagnostic`  
  <sub>hero eyebrow badge</sub>
- `Takes 5 minutes`  
  <sub>CtaBand badge (app/page.tsx)</sub>
- `TikTok integration`  
  <sub>app/tiktok/page.tsx eyebrow</sub>
- `Recommended`  
  <sub>Comparison badge (smart column)</sub>

## cta  ·  2

_Call-to-action button text._

- `Take the test`  
  <sub>hero + nav + steps + pricing + CtaBand (app/page.tsx, quiz-nav.tsx)</sub>
- `Back to the test`  
  <sub>app/tiktok/page.tsx</sub>

## cta-microcopy  ·  3

_Tiny microcopy near CTAs and scroll cues._

- `Press T anytime to take the test`  
  <sub>hero (smart-fart-hero.tsx)</sub>
- `Scroll`  
  <sub>hero scroll cue</sub>
- `Skip to content`  
  <sub>app/layout.tsx skip link</sub>

## section-heading  ·  7

_Section titles down the landing page. Punchy, curiosity/verdict framed._

- `Three steps to the truth`  
  <sub>Steps section</sub>
- `Which one are you, really?`  
  <sub>Comparison section</sub>
- `What you actually get`  
  <sub>FeatureGrid section</sub>
- `Lives have been changed`  
  <sub>Testimonials section</sub>
- `Settle it for the price of a coffee`  
  <sub>Pricing section</sub>
- `Questions from concerned fellas`  
  <sub>FAQ section</sub>
- `Follow us`  
  <sub>FollowUs section</sub>

## step-howitworks  ·  3

_The 'how it works' steps: label, title, body. Cheeky, self-deprecating about the 'science'._

- `Step 1 - Answer 27 questions: Rapid-fire scenarios about your daily choices, group-chat conduct, and snack ethics. Takes about five minutes and roughly zero brain cells.`  
  <sub>Steps (app/page.tsx)</sub>
- `Step 2 - The Fella Engine scores you: Our deeply unscientific algorithm weighs your answers across six fella dimensions and computes your official Fella Score.`  
  <sub>Steps (app/page.tsx)</sub>
- `Step 3 - Get your diagnosis: Receive the verdict, Smart Fella or Fart Smella, plus a shareable report you can wave triumphantly in your friends' faces.`  
  <sub>Steps (app/page.tsx)</sub>

## checklist-smart  ·  4

_The 'Smart Fella' side of the 'Which one are you, really?' checklist. Aspirational-but-dry._

- `Reads the whole thread before replying`  
  <sub>Comparison ourPoints</sub>
- `Owns a water bottle and, crucially, uses it`  
  <sub>Comparison ourPoints</sub>
- `Inbox at zero, mind mysteriously clear`  
  <sub>Comparison ourPoints</sub>
- `Says “I don't know” like an absolute legend`  
  <sub>Comparison ourPoints</sub>

## checklist-fart  ·  4

_The 'Fart Smella' side of the checklist. Roasty, specific, relatable-cringe._

- `Replies “lol” to genuinely serious questions`  
  <sub>Comparison theirPoints</sub>
- `Microwaves fish in a shared office kitchen`  
  <sub>Comparison theirPoints</sub>
- `Has 47 unread “urgent” emails and zero concern`  
  <sub>Comparison theirPoints</sub>
- `Confidently, cheerfully wrong about everything`  
  <sub>Comparison theirPoints</sub>

## feature-whatyouget  ·  6

_'What you actually get' report features: title + body. Bragging rights + gentle roasting._

- `Your Fella Score: A single 0-100 number that settles the debate once and for all. No appeals.`  
  <sub>FeatureGrid REPORT</sub>
- `Six-dimension breakdown: See exactly where you lean smart, and where you lean, regrettably, fart.`  
  <sub>FeatureGrid REPORT</sub>
- `Red-flag detector: The three habits quietly dragging your score into the danger zone.`  
  <sub>FeatureGrid REPORT</sub>
- `Shareable result card: A bordered, brag-worthy card engineered specifically for the group chat.`  
  <sub>FeatureGrid REPORT</sub>
- `Improvement plan: Five concrete moves to climb from certified fart to respectable smart.`  
  <sub>FeatureGrid REPORT</sub>
- `Official certificate: Frame-ready proof of your fella status. Mostly a joke. Mostly.`  
  <sub>FeatureGrid REPORT</sub>

## testimonial  ·  6

_Fake-but-funny social proof quotes with name + role. Deadpan, self-aware, roast-friendly._

- `I put 'Smart Fella, verified' on my résumé and got two callbacks. - Leo M., Job seeker`  
  <sub>Testimonials</sub>
- `I made my whole team take it. Morale is at an all-time low and I've never been happier. - Dana R., Manager`  
  <sub>Testimonials</sub>
- `Finally, science confirms what my wife has been saying for years. - Marcus T., Smart Fella (barely)`  
  <sub>Testimonials</sub>
- `The red-flag detector called me out for microwaving fish at the office. Accurate and cruel. - Priya S., Reformed`  
  <sub>Testimonials</sub>
- `Scored a 12. Absolutely devastating. I hate this quiz - Greg P., Certified Fart Smella`  
  <sub>Testimonials</sub>
- `Took it six times hoping for a better score. The engine is incorruptible. - Sam K., Persistent`  
  <sub>Testimonials</sub>

## pricing  ·  6

_Pricing copy for the single one-time test._

- `The Fella Test - $67 one-time`  
  <sub>Pricing TIERS</sub>
- `One full diagnostic, your complete report, and a shareable result card.`  
  <sub>Pricing description</sub>
- `The full 27-question test`  
  <sub>Pricing feature</sub>
- `Your Fella Score + report`  
  <sub>Pricing feature</sub>
- `Shareable result card`  
  <sub>Pricing feature</sub>
- `Personal improvement plan`  
  <sub>Pricing feature</sub>

## faq-q  ·  5

_FAQ questions, written in the voice of a nervous / defensive fella._

- `Is this scientifically valid?`  
  <sub>FAQ (app/page.tsx)</sub>
- `Is it rigged to call me a Fart Smella?`  
  <sub>FAQ (app/page.tsx)</sub>
- `How long does it take?`  
  <sub>FAQ (app/page.tsx)</sub>
- `Can I get a refund if I hate my score?`  
  <sub>FAQ (app/page.tsx)</sub>
- `Can my whole team take it?`  
  <sub>FAQ (app/page.tsx)</sub>

## faq-a  ·  5

_FAQ answers. Honest, funny, never over-earnest. (Legacy site copy; a couple contain em dashes preserved verbatim.)_

- `Absolutely not. The Fella Engine runs on vibes, stereotypes, and one very opinionated spreadsheet. It's for entertainment only.`  
  <sub>FAQ (app/page.tsx)</sub>
- `It is not, but the questions are designed to expose your worst habits, so a low score is entirely your own doing.`  
  <sub>FAQ (app/page.tsx)</sub>
- `About five minutes. Twenty-seven quick questions, no essays, and no account required to start.`  
  <sub>FAQ (app/page.tsx)</sub>
- `You can get a refund if the test won't load. You cannot get a refund simply because the truth stings.`  
  <sub>FAQ (app/page.tsx)</sub>
- `Please do - everyone grabs their own test and compares Fella Scores. Nothing bonds a team like collective public humiliation.`  
  <sub>FAQ (app/page.tsx) [legacy em dash in source]</sub>

## caption  ·  20

_REAL social post captions (TikTok + Instagram). Note the hook + emoji glyph + comment CTA + follow nudge + hashtags._

- `SMART or FART? 🧠💨 Odd one out, figure analogy & a tricky number series. Can you get all 3? Comment your score 👇 #smartorfart #iqtest #brainteaser #quiz #trivia #braintest #puzzle`  
  <sub>ready-to-post/01 caption.txt</sub>
- `SMART or FART? 🧠💨 Word analogy, number series & figure series. Can you get all 3? Comment your score 👇 #smartorfart #iqtest #brainteaser #quiz #trivia #braintest #puzzle`  
  <sub>ready-to-post/02 caption.txt</sub>
- `SMART or FART? 🧠💨 Word analogy, dot position & number analogy. Can you get all 3? Comment your score 👇 #smartorfart #iqtest #brainteaser #quiz #trivia #braintest #puzzle`  
  <sub>ready-to-post/03 caption.txt</sub>
- `SMART or FART? 🧠💨 Number series, odd one out & a sneaky puzzle. Can you get all 3? Comment your score 👇 #smartorfart #iqtest #brainteaser #quiz #trivia #braintest #puzzle`  
  <sub>ready-to-post/04 caption.txt</sub>
- `SMART or FART? 🧠💨 Number series, word analogy & fill in the blank. Can you get all 3? Comment your score 👇 #smartorfart #iqtest #brainteaser #quiz #trivia #braintest #puzzle`  
  <sub>ready-to-post/05 caption.txt</sub>
- `Are you a SMART fella… or a FART smella? 🧠💨 /  / Only one way to find out. /  / 🔥 Brand new challenges EVERY day. / 👉 Follow so you don’t miss one /  / #brainteaser #iqtest #riddles #puzzles #smartfellaorfartsmella`  
  <sub>ab-database.json (brand intro post, multiline)</sub>
- `Are you a SMART fella… or a FART smella? 🧠💨 Only one way to find out. 🔥 Brand new challenges EVERY day. 👉 Follow so you don't miss one #brainteaser #iqtest #riddles #puzzles #smartfellaorfartsmella`  
  <sub>ab-database.json (brand intro post, single line)</sub>
- `SMART or FART? 🧠💨 Word analogy, dot position & number analogy. Can you get all 3? Comment your score 👇 #smartorfart #iqtest #brainteaser #quiz #trivia`  
  <sub>ab-database.json</sub>
- `SMART or FART? 🧠💨 Odd one out, figure analogy & a tricky number series. Can you get all 3? Comment your score 👇 #smartorfart #iqtest #brainteaser #quiz #trivia`  
  <sub>ab-database.json</sub>
- `SMART or FART? 🧠💨 Word analogy, number series & figure series. Can you get all 3? Comment your score 👇 #smartfellaorfartsmella #iqtest #brainteaser #quiz #puzzle`  
  <sub>ab-database.json</sub>
- `SMART or FART? 🧠💨 Number series, word analogy & fill in the blank. Can you get all 3? Comment your score 👇 #smartorfart #iqtest #brainteaser #quiz #trivia`  
  <sub>ab-database.json</sub>
- `SMART or FART? 🧠💨 Word analogy, dot position & number analogy. Can you get all 3? Comment your score 👇 #riddlefun #brainteaser #puzzletok #mindgames #riddles`  
  <sub>ab-database.json</sub>
- `The last one is tricky! Comment your answer below👇 #quiz #trivia #braintest #puzzle #logic`  
  <sub>ab-database.json (cliffhanger)</sub>
- `This one’s tricky! Comment your answer below👇 #quiz #trivia #braintest #puzzle #logic`  
  <sub>ab-database.json (cliffhanger)</sub>
- `Did you get the last question? Comment your answer below 👇 #quiz #logic #smart #challenge #brainteaser`  
  <sub>ab-database.json (cliffhanger)</sub>
- `Are you SMART or FART? 🧠💨 Comment your answer below 👇 and follow for more!! #smartorfart #iqtest #puzzletok #riddles #mindgames`  
  <sub>ab-database.json (no-answer variant)</sub>
- `Are you SMART or FART? 🧠💨 Comment your answer below 👇 and follow for more!! #fyp #foryou #quiz #trivia #brainteaser`  
  <sub>ab-database.json (no-answer variant)</sub>
- `Are you SMART or FART? 🧠💨 Comment your score below 👇 and follow for more!! #fyp #foryou #quiz #trivia #brainteaser`  
  <sub>ab-database.json (score-CTA)</sub>
- `Are you SMART or FART? 🧠💨 Comment your score below 👇 and follow for more!! #quiztime #braintest #canyoupass #puzzle #trivianight`  
  <sub>ab-database.json (score-CTA)</sub>
- `Are you SMART or FART? 🧠💨 Comment your score below 👇 and follow for more!! #smartorfart #iqtest #puzzletok #riddles #mindgames`  
  <sub>ab-database.json (score-CTA)</sub>

## caption-template  ·  3

_Canonical caption templates the poster tooling uses. Hashtags are appended per-post from a rotating hashtag_set (A/B/C)._

- `Are you SMART or FART? 🧠💨 Comment your score below 👇 and follow for more!!`  
  <sub>tools/post-variant.ts CAPTION_SCORE_CTA</sub>
- `Are you SMART or FART? 🧠💨 Comment your answer below 👇 and follow for more!!`  
  <sub>tools/post-variant.ts CAPTION_NO_ANSWER (no-reveal variant)</sub>
- `Are you SMART or FART? Comment your score/answer below and follow for more!`  
  <sub>learnings.json decisions_log (standardized hook)</sub>

## hashtag-set  ·  8

_Rotating hashtag sets used in the live A/B test, plus historical sets seen on posts._

- `#fyp #foryou #quiz #trivia #brainteaser`  
  <sub>learnings.json set A</sub>
- `#smartorfart #iqtest #puzzletok #riddles #mindgames`  
  <sub>learnings.json set B</sub>
- `#quiztime #braintest #canyoupass #puzzle #trivianight`  
  <sub>learnings.json set C</sub>
- `#smartorfart #iqtest #brainteaser #quiz #trivia #braintest #puzzle`  
  <sub>ready-to-post caption.txt</sub>
- `#brainteaser #iqtest #riddles #puzzles #smartfellaorfartsmella`  
  <sub>ab-database.json (brand post)</sub>
- `#riddlefun #brainteaser #puzzletok #mindgames #riddles`  
  <sub>ab-database.json</sub>
- `#quiz #trivia #braintest #puzzle #logic`  
  <sub>ab-database.json (cliffhanger)</sub>
- `#quiz #logic #smart #challenge #brainteaser`  
  <sub>ab-database.json (cliffhanger)</sub>

## on-screen  ·  8

_Burned-in on-screen text on the video plates (intro, score, reveal, prompts framing). All-caps Anton._

- `SMART FELLA`  
  <sub>remotion Intro.tsx</sub>
- `OR`  
  <sub>remotion Intro.tsx (pill)</sub>
- `FART SMELLA?`  
  <sub>remotion Intro.tsx</sub>
- `ARE YOU SMART OR FART?`  
  <sub>remotion Score.tsx (banner)</sub>
- `SCORE YOURSELF`  
  <sub>remotion Score.tsx (heading)</sub>
- `CORRECT ANSWER`  
  <sub>remotion Reveal.tsx (banner)</sub>
- `QUESTION 1 OF 15`  
  <sub>remotion HeaderPills.tsx (count pill; hidden on 1-question cuts)</sub>
- `TIME'S UP!`  
  <sub>remotion (timesup plate / VO)</sub>

## question-onscreen  ·  11

_Verbatim printed quiz prompts (the puzzle question text shown on screen)._

- `WHICH ONE DOES NOT BELONG?`  
  <sub>questions.ts idx 1 / 10</sub>
- `WHAT COMES NEXT?`  
  <sub>questions.ts number-series prompt</sub>
- `WHICH SHAPE COMPLETES THE PATTERN?`  
  <sub>questions.ts idx 3</sub>
- `GIANT IS TO TINY AS WIDE IS TO ?`  
  <sub>questions.ts idx 4</sub>
- `OCEAN IS TO PUDDLE AS MOUNTAIN IS TO ?`  
  <sub>questions.ts idx 6</sub>
- `PAINTER IS TO BRUSH AS CARPENTER IS TO ?`  
  <sub>questions.ts idx 8</sub>
- `WHICH SHAPE COMES NEXT?`  
  <sub>questions.ts idx 11</sub>
- `THE BRIDGE WAS TOO WEAK TO HOLD THE HEAVY TRUCK, SO WORKERS HAD TO ______ IT BEFORE OPENING THE ROAD.`  
  <sub>questions.ts idx 12</sub>
- `WHERE DOES THE DOT MOVE NEXT?`  
  <sub>questions.ts idx 13</sub>
- `WHICH NUMBER FITS? 2 -> 5, 3 -> 7, 4 -> 9, 5 -> ?`  
  <sub>questions.ts idx 14</sub>
- `IF 4+5=20, 3+6=18, 2+7=14 THEN 5+4 = ?`  
  <sub>questions.ts idx 15</sub>

## category-label  ·  9

_On-screen quiz category / topic pills._

- `ODD ONE OUT`  
  <sub>questions.ts tier</sub>
- `NUMBER SERIES`  
  <sub>questions.ts tier</sub>
- `FIGURE ANALOGY`  
  <sub>questions.ts tier</sub>
- `VERBAL ANALOGY`  
  <sub>questions.ts tier</sub>
- `FIGURE SERIES`  
  <sub>questions.ts tier</sub>
- `SENTENCE COMPLETION`  
  <sub>questions.ts tier</sub>
- `POSITION`  
  <sub>questions.ts tier</sub>
- `NUMBER ANALOGY`  
  <sub>questions.ts tier</sub>
- `NUMBER PUZZLE`  
  <sub>questions.ts tier</sub>

## explanation-onscreen  ·  10

_On-screen answer explanations. Clear, kid-friendly teaching. (This teaching tone is for VIDEO reveals ONLY, never for comment replies.)_

- `A robin, sparrow, and eagle are all birds. A salmon is a fish, so it does not belong.`  
  <sub>questions.ts idx 1</sub>
- `Each number doubles (x2): 3, 6, 12, 24, so the next is 24 x 2 = 48.`  
  <sub>questions.ts idx 2</sub>
- `The relation is 'get filled in' while the shape stays the same, so the empty square becomes a filled square.`  
  <sub>questions.ts idx 3</sub>
- `Giant and tiny are opposites, so the opposite of wide is narrow. It's the same relationship, flipped.`  
  <sub>questions.ts idx 4</sub>
- `An ocean shrinks to a puddle, so a mountain shrinks to a hill. It's the tiny version of the same thing.`  
  <sub>questions.ts idx 6</sub>
- `The gaps grow +4, +6, +8, +10, so the next gap is +12. That makes 30 + 12 = 42.`  
  <sub>questions.ts idx 7</sub>
- `Each number is the sum of the two before it: 3 + 5 = 8, so 5 + 8 = 13. It's the Fibonacci pattern.`  
  <sub>questions.ts idx 9</sub>
- `The sides count up by one: triangle 3, square 4, pentagon 5, so next is the hexagon with 6 sides.`  
  <sub>questions.ts idx 11</sub>
- `The dot steps clockwise corner to corner: top-left, top-right, bottom-right, then the next corner is bottom-left.`  
  <sub>questions.ts idx 13</sub>
- `The + secretly means multiply: 4x5=20, 3x6=18, 2x7=14, so 5x4 = 20.`  
  <sub>questions.ts idx 15</sub>

## endcard  ·  23

_Endcard / brand-promo on-screen lines (outro + self-contained brand intro + reply short). Loud, positive, always ends on a follow/come-back beat._

- `HOW DID YOU DO?`  
  <sub>remotion Outro.tsx (standard)</sub>
- `COMMENT YOUR SCORE BELOW`  
  <sub>remotion Outro.tsx (standard)</sub>
- `WHAT'S YOUR ANSWER?`  
  <sub>remotion Outro.tsx (no-answer variant)</sub>
- `COMMENT YOUR ANSWER BELOW`  
  <sub>remotion Outro.tsx (no-answer variant)</sub>
- `FOLLOW FOR MORE`  
  <sub>remotion Outro.tsx / IntroBrand / ReplyBrand (IG/TikTok CTA)</sub>
- `SUBSCRIBE FOR MORE`  
  <sub>remotion Outro.tsx (YouTube CTA)</sub>
- `SCROLL FOR MORE`  
  <sub>remotion Outro.tsx / IntroBrand.tsx (swipe cue)</sub>
- `WHAT IS IT?`  
  <sub>remotion IntroBrand.tsx</sub>
- `A REAL IQ TEST`  
  <sub>remotion IntroBrand.tsx</sub>
- `THAT'S ACTUALLY`  
  <sub>remotion IntroBrand.tsx</sub>
- `FUN!`  
  <sub>remotion IntroBrand.tsx</sub>
- `FUN BRAIN CHALLENGES, K-12`  
  <sub>remotion IntroBrand.tsx</sub>
- `TESTS SO FUN`  
  <sub>remotion IntroBrand.tsx (mission)</sub>
- `YOU CAN'T STOP`  
  <sub>remotion IntroBrand.tsx (mission)</sub>
- `LEARNING`  
  <sub>remotion IntroBrand.tsx (mission)</sub>
- `NEW CHALLENGES`  
  <sub>remotion IntroBrand.tsx (CTA)</sub>
- `EVERY DAY`  
  <sub>remotion IntroBrand.tsx / ReplyBrand.tsx</sub>
- `YAYYY!`  
  <sub>remotion ReplyBrand.tsx (first-comment celebration)</sub>
- `OUR FIRST COMMENT!`  
  <sub>remotion ReplyBrand.tsx</sub>
- `JUST THE START`  
  <sub>remotion ReplyBrand.tsx</sub>
- `NEW CHALLENGE`  
  <sub>remotion ReplyBrand.tsx</sub>
- `DON'T MISS`  
  <sub>remotion ReplyBrand.tsx</sub>
- `TOMORROW'S!`  
  <sub>remotion ReplyBrand.tsx</sub>

## verdict  ·  6

_The Smart Fella / Fart Smella verdict device: score tiers, the verdict endcard, and the rubber-stamp reward._

- `CERTIFIED SMART FELLA`  
  <sub>remotion Score.tsx (top tier)</sub>
- `SHARP COOKIE`  
  <sub>remotion Score.tsx (middle tier)</sub>
- `CERTIFIED FART SMELLA`  
  <sub>remotion Score.tsx (bottom tier)</sub>
- `SMART FELLA OR FART SMELLA?`  
  <sub>remotion Outro.tsx (verdict variant)</sub>
- `COMMENT YOUR VERDICT`  
  <sub>remotion Outro.tsx (verdict variant)</sub>
- `CERTIFIED SMART FELLA (rubber stamp thunked onto the winning commenter)`  
  <sub>remotion ReplyBrand.tsx StampBadge</sub>

## hook  ·  6

_The hook TYPES used across posts (the opening promise + which CTA the post leans on)._

- `score-CTA ('Comment your score')`  
  <sub>ab-database.json variant.hook</sub>
- `comment-CTA ('Comment your answer')`  
  <sub>ab-database.json variant.hook</sub>
- `brand ('Follow so you don't miss one')`  
  <sub>ab-database.json variant.hook</sub>
- `Are you SMART or FART?`  
  <sub>primary opening hook across captions + score plate</sub>
- `Can you get all 3?`  
  <sub>quiz caption hook (ready-to-post)</sub>
- `The last one is tricky!`  
  <sub>cliffhanger hook (ab-database.json)</sub>

## vo-host  ·  10

_Game-show host narration (voice-over). High energy, warm, encouraging, always keeps the smart/fart frame._

- `Are you a SMART fella... or a FART smella? Let's find OUT!`  
  <sub>captions.json intro</sub>
- `So, are you smart or fart? Count up your correct answers to find your rank!`  
  <sub>captions.json score</sub>
- `Take a bow, you are a certified smart fella!`  
  <sub>phrases.ts / score VO (top tier)</sub>
- `You're one seriously sharp cookie.`  
  <sub>phrases.ts / score VO (middle tier)</sub>
- `Hey, every champion starts out a certified fart smella!`  
  <sub>phrases.ts / score VO (bottom tier)</sub>
- `So, how did you do? Comment your score below, and follow for more!`  
  <sub>captions.json outro-follow</sub>
- `So, how did you do? Comment your score below, and subscribe for more!`  
  <sub>captions.json outro-youtube</sub>
- `TIME'S UP!`  
  <sub>captions.json timesup</sub>
- `Five seconds, go!`  
  <sub>captions.json q1 / q4</sub>
- `Five seconds on the clock!`  
  <sub>captions.json q7</sub>

## vo-question  ·  5

_Question-read narration. Names the category, reads options A-D, calls the timer. Adds spice on hard ones._

- `Question one! Which one does NOT belong? Robin... sparrow... salmon... eagle. Is it A, robin... B, sparrow... C, salmon... or D, eagle? Five seconds, go!`  
  <sub>captions.json q1</sub>
- `Question two, a number series! Three, six, twelve, twenty-four, and then... what comes next? A, thirty-six... B, forty-eight... C, thirty... or D, forty-two? Five seconds!`  
  <sub>captions.json q2</sub>
- `Question seven, and this one is tricky! Two, six, twelve, twenty, thirty, and then... what comes next? A, thirty-six... B, forty... C, forty-two... or D, forty-four? Five seconds on the clock!`  
  <sub>captions.json q7</sub>
- `Question eleven, a shape puzzle! Watch them grow, gaining one side each step: a triangle, then a square, then a pentagon. Which shape comes next?`  
  <sub>captions.json q11</sub>
- `Last one, question fifteen, a number puzzle, and it's sneaky! If four plus five makes twenty, three plus six makes eighteen, and two plus seven makes fourteen... then five plus four makes... what?`  
  <sub>captions.json q15</sub>

## vo-reveal  ·  6

_Answer-reveal narration. Warm 'the answer is...' payoff + a one-beat memorable why._

- `The answer is... C, salmon! A robin, a sparrow, and an eagle all soar through the sky as birds. But a salmon? That one swims. It's a fish!`  
  <sub>captions.json r1</sub>
- `It's... B, forty-eight! Each number simply doubles: three, six, twelve, twenty-four... and twenty-four times two is forty-eight!`  
  <sub>captions.json r2</sub>
- `The answer is... B, hexagon! Count the sides: triangle three, square four, pentagon five... so next up is the six-sided hexagon!`  
  <sub>captions.json r11</sub>
- `The answer is... B, thirteen! Add the two numbers before it: five plus eight is thirteen. That's the famous Fibonacci pattern!`  
  <sub>captions.json r9</sub>
- `The answer is... C, twenty! Here's the trick: that plus sign secretly means multiply. Four times five is twenty, so five times four is twenty too!`  
  <sub>captions.json r15</sub>
- `It's... B, hill! An ocean shrinks down to a tiny puddle, so a mountain shrinks down to a little hill. Same thing, pocket-sized!`  
  <sub>captions.json r6</sub>

## signature-phrase  ·  24

_Recurring phrases + vocabulary that ARE the brand. Reuse these._

- `Smart Fella`  
  <sub>everywhere (the praise half of the binary)</sub>
- `Fart Smella`  
  <sub>everywhere (the miss half of the binary)</sub>
- `Are you SMART or FART?`  
  <sub>captions + score plate</sub>
- `SMART or FART?`  
  <sub>captions</sub>
- `certified SMART FELLA`  
  <sub>comment replies + score tier + reply stamp</sub>
- `certified Fart Smella (for now)`  
  <sub>comment replies (wrong-answer redemption)</sub>
- `for now`  
  <sub>the redemption softener after a Fart Smella call</sub>
- `SHARP COOKIE / seriously sharp cookie`  
  <sub>score middle tier + VO</sub>
- `Fella Score`  
  <sub>website</sub>
- `The Fella Engine`  
  <sub>website (the 'unscientific algorithm')</sub>
- `fella-ness`  
  <sub>website meta + hero</sub>
- `six fella dimensions`  
  <sub>website steps</sub>
- `brutally honest`  
  <sub>website taglines</sub>
- `Backed by vibes, peer pressure, and questionable science`  
  <sub>hero subtitle</sub>
- `Can you get all 3?`  
  <sub>quiz captions</sub>
- `Comment your score`  
  <sub>caption + endcard CTA</sub>
- `Comment your answer below`  
  <sub>caption + endcard CTA (no-reveal)</sub>
- `follow for more`  
  <sub>captions + endcards</sub>
- `follow so you don't miss one`  
  <sub>brand caption</sub>
- `Brand new challenges EVERY day`  
  <sub>brand caption + endcard</sub>
- `come back tomorrow and redeem yourself`  
  <sub>comment-reply-guide.md</sub>
- `follow for a new one every day`  
  <sub>comment-reply-guide.md</sub>
- `Let's find OUT!`  
  <sub>intro VO</sub>
- `🧠💨 (brain + wind = SMART/FART glyph)`  
  <sub>captions</sub>

## comment-reply-correct  ·  1

_Approved replies to a CORRECT guess. Hype them as a Smart Fella, one emoji max, end on a follow nudge. Never explain the solution._

- `39 first try?? certified SMART FELLA 🫡. follow for a new one every day.`  
  <sub>comment-reply-guide.md (approved example)</sub>

## comment-reply-wrong  ·  1

_Approved replies to a WRONG / 'idk' guess. Playful Fart Smella jab + 'for now' redemption + come-back nudge. Reveal the answer only, never a lecture._

- `it was 39. certified Fart Smella 😭 (for now). come back tomorrow and redeem yourself.`  
  <sub>comment-reply-guide.md (approved example)</sub>

## comment-reply-nudge  ·  4

_The follow / come-back nudges that MUST close every reply (pick one, keep it casual)._

- `follow for a new one every day`  
  <sub>comment-reply-guide.md</sub>
- `come back tomorrow and redeem yourself`  
  <sub>comment-reply-guide.md</sub>
- `follow for more`  
  <sub>captions/endcards</sub>
- `follow so you don't miss one`  
  <sub>brand caption</sub>
