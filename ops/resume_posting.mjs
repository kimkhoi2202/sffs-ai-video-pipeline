#!/usr/bin/env node
/**
 * resume_posting.mjs — the CONTROLLED path that puts videos back on the calendar.
 *
 * This is deliberately NOT the daily loop. hermes-nous-loop.timer stays disabled; this
 * is a script a human runs, that renders a fixed number of videos, gates them, and
 * schedules them on Instagram through Metricool. Everything it creates is recorded in
 * a ledger so `--stop` can cancel the whole batch in one command.
 *
 *   node resume_posting.mjs --count 12 --day 2026-07-27       # render + schedule
 *   node resume_posting.mjs --stop                            # cancel everything it made
 *   node resume_posting.mjs --list                            # what is on the calendar
 *
 * ALL QUESTION KINDS. The shape-only restriction is lifted: the raw-text re-import has
 * landed, so text and numseries carry their authored prompts, options and punctuation
 * again instead of normalized dedup keys.
 *
 * SELECTION IS EXPLANATION-AWARE. 143 authored explanations are shared by more than one
 * question (10 shaded questions can share a line that varies only by shape name), and
 * the publish gate refuses a video that repeats one inside its 30-post novelty window.
 * Picking questions blindly meant rendering videos that were then thrown away — a 79%
 * rejection rate on the shape-only pool. The picker below skips any question whose
 * explanation is already claimed by this video or still inside the window, so the pool
 * is spent on videos that can actually ship and the gate goes back to being a safety
 * net rather than the thing shaping the batch.
 *
 * The batch alternates the two opening arms so the skip-rate experiment accumulates
 * evenly from the first day.
 */
const REPO = "/home/ec2-user/sffs-ai-video-pipeline";
const Q = await import(`${REPO}/hermes/src/questions.ts`);
const R = await import(`${REPO}/hermes/src/render.ts`);
const M = await import(`${REPO}/hermes/src/metricool.ts`);
const P = await import(`${REPO}/hermes/src/postingPolicy.ts`);
const G = await import(`${REPO}/hermes/src/publishGate.ts`);
const A = await import(`${REPO}/hermes/src/attribution.ts`);
const { CONFIG } = await import(`${REPO}/hermes/src/config.ts`);
const { uploadToS3 } = await import(`${REPO}/hermes/src/s3.ts`);
const { readJSON, writeJSONAtomic } = await import(`${REPO}/hermes/src/state.ts`);
const { join } = await import("node:path");

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const LEDGER = join(CONFIG.DATA_DIR, "metricool-scheduled.json");
const SHAPE_KINDS = ["shaded", "polygon", "dot", "fold", "matrix", "analogy2", "figure-odd"];
const ALL_KINDS = ["text", "numseries", ...SHAPE_KINDS];
const PER_VIDEO = 3;

/**
 * On-brand captions. The publish gate refuses an exact duplicate inside 30 posts, so
 * this list has to be longer than the window — at 12/day the window is 2.5 days.
 */
const CAPTIONS = [
  "are you a SMART fella or a FART smella? 🧠💨 comment your score",
  "bet you get this one wrong 🧠 prove me wrong in the comments",
  "3 questions. how fast can you spot it? 👀",
  "SMART or FART? 🧠💨 no calculator, no cheating, comment below",
  "most people miss the last one 👀 can you get all three?",
  "these look easy until they aren't 🧠 drop your score",
  "if you get all 3 you're officially a SMART fella 🧠",
  "pattern check 👀 comment how many you got",
  "this one separates the SMART fellas from the FART smellas 💨",
  "quick brain test 👀 all three in under 15 seconds?",
  "your brain vs three puzzles. who wins? 👀",
  "nobody is getting all three 🧠 prove me wrong",
  "how many did you get? be honest 👀",
  "3 in a row or you're a FART smella 💨",
  "the last one gets everybody 🧠",
  "speedrun this 👀 comment your time",
  "harder than it looks. comment your score 🧠",
  "SMART or FART? 🧠💨 you get one guess each",
  "genuinely curious how many people get 3/3 👀",
  "brain warmup 🧠 all three, go",
  "if this is easy for you, say so in the comments 👀",
  "one of these three trips almost everyone 🧠",
  "no googling 👀 comment what you got",
  "rate your brain out of 3 🧠",
  "this is your daily SMART or FART check 💨",
  "three puzzles, fifteen seconds, go 👀",
  "comment 3/3 if you're built different 🧠",
  "be honest, how many? 👀",
  "the answer is obvious after you see it 🧠",
  "SMART fella energy or FART smella energy? 💨 comment",
];
const TAG_SETS = ["A", "B", "C"];

/**
 * Pick `n` questions whose explanations are all distinct from each other AND from
 * everything still inside the novelty window. Returns fewer than `n` if the pool
 * cannot satisfy that, and the caller skips the video rather than rendering one the
 * gate will refuse.
 */
function pickQuestions(pool, cursor, n, claimedExplanations) {
  const picked = [];
  const local = new Set();
  let i = cursor;
  while (i < pool.length && picked.length < n) {
    const q = pool[i++];
    const e = String(q.explanation ?? "").trim();
    if (!e) continue; // the gate requires one; skip rather than render a reject
    if (local.has(e) || claimedExplanations.has(e)) continue;
    local.add(e);
    picked.push(q);
  }
  return { picked, cursor: i };
}

async function list() {
  const rows = await M.listPosts("2026-07-01T00:00:00", "2026-12-31T23:59:59");
  console.log(`scheduled posts on the calendar: ${rows.length}`);
  for (const p of rows) {
    const nets = (p.providers ?? []).map((x) => `${x.network}:${x.status}`).join(",");
    console.log(`  ${p.publicationDate?.dateTime}  uuid=${p.uuid}  ${nets}  draft=${p.draft}  ${String(p.text ?? "").slice(0, 44).replace(/\n/g, " ")}`);
  }
  return rows;
}

async function stop() {
  const led = readJSON(LEDGER, { posts: [] });
  console.log(`ledger holds ${led.posts.length} post(s) created by this script`);
  let n = 0;
  for (const rec of led.posts) {
    try {
      const r = await M.deletePost(rec.uuid);
      console.log(`  ${r.deleted ? "cancelled" : "already gone"}  ${rec.videoId}  uuid=${rec.uuid}`);
      if (r.deleted) n++;
    } catch (e) {
      console.log(`  FAILED  ${rec.videoId} uuid=${rec.uuid}: ${e.message}`);
    }
  }
  led.posts = [];
  led.stopped_at = new Date().toISOString();
  writeJSONAtomic(LEDGER, led);
  console.log(`cancelled ${n}. Delete is SOFT — everything is restorable from the Metricool recycle bin.`);
}

async function run() {
  const count = Number(flag("--count", "12"));
  const day = flag("--day", new Date(Date.now() + 864e5).toISOString().slice(0, 10));
  // Slots to skip at the front, so a day that already has posts can be topped up to
  // the daily target without disturbing or duplicating what is already scheduled.
  const from = Number(flag("--from", "0"));
  const endHour = Number(flag("--end-hour", "22"));
  const dry = argv.includes("--dry");

  console.log(`=== resume posting: ${count} videos for ${day} (${dry ? "DRY RUN" : "LIVE"}) ===\n`);

  // 1. Volume guard FIRST — Fair Use breach freezes all posting behind a human review.
  const budget = await M.budget();
  console.log(`budget: ${budget.used}/${budget.budget} used this month (hard cap ${budget.hardCap}), remaining ${budget.remaining}`);
  if (budget.blocked) { console.error("ABORT: monthly publication budget exhausted"); process.exit(2); }
  if (budget.alert) console.log("  !! over 80% of the Fair Use base threshold");

  // 2. Which networks may post right now.
  const decisions = P.decide(budget.remaining);
  for (const d of decisions) console.log(`policy: ${d.network} -> ${d.slots} slot(s); ${d.reason}`);
  const ig = decisions.find((d) => d.network === "instagram");
  if (!ig?.allowed) { console.error("ABORT: Instagram not allowed to post"); process.exit(2); }
  const n = Math.min(count, ig.slots);

  // 3. Slot times across the posting window.
  const allTimes = P.slotTimes(n, { dayISO: day, startHour: 7, endHour: endHour, minGapMinutes: ig.minGapMinutes });
  const times = allTimes.slice(from);
  console.log(`\nslot grid (${allTimes.length}): ${allTimes.join("  ")}`);
  if (from) console.log(`skipping the first ${from} (already scheduled)`);
  console.log(`filling: ${times.join("  ")}\n`);

  // 4. Fresh questions, every kind, 3 per video.
  const pool = Q.candidateQuestions({ kinds: ALL_KINDS, seed: `resume-${day}` });
  console.log(`fresh question pool: ${pool.length} (need ${n * PER_VIDEO})`);
  if (pool.length < n * PER_VIDEO) { console.error("ABORT: not enough fresh questions"); process.exit(2); }

  // 5. Recent posts, for the publish gate's novelty window.
  const led = readJSON(LEDGER, { posts: [] });
  const recent = led.posts.map((p) => ({ caption: p.caption, hashtag_set: p.hashtag_set, explanations: p.explanations }));
  // Explanations still inside the window, so selection can avoid them up front.
  const claimed = new Set(recent.slice(-G.NOVELTY_WINDOW).flatMap((p) => p.explanations ?? []).filter(Boolean));

  const made = [];
  let cursor = 0;
  for (let i = 0; i < times.length; i++) {
    const videoId = `${day}-r${String(from + i + 1).padStart(2, "0")}`;
    // Alternate the arms so the experiment fills evenly from day one.
    const opening = (from + i) % 2 === 0 ? "cold-plate" : "motion-hook";
    const sel = pickQuestions(pool, cursor, PER_VIDEO, claimed);
    cursor = sel.cursor;
    const questions = sel.picked;
    if (questions.length < PER_VIDEO) {
      console.log(`\n--- ${videoId} SKIPPED: pool exhausted of explanation-distinct questions ---`);
      continue;
    }
    for (const q of questions) claimed.add(String(q.explanation ?? "").trim());
    const hashtag_set = TAG_SETS[(from + i) % TAG_SETS.length];
    const rawCaption = `${CAPTIONS[(from + i) % CAPTIONS.length]}\n\n${CONFIG.HASHTAG_SETS[hashtag_set].join(" ")}`;
    const caption = A.withAttribution(rawCaption, videoId);

    console.log(`\n--- ${videoId}  arm=${opening}  tags=${hashtag_set} ---`);
    console.log(`    questions: ${questions.map((q) => q.kind).join(", ")}`);
    console.log(`    prompts  : ${questions.map((q) => JSON.stringify(String(q.prompt).slice(0, 34))).join(" ")}`);

    const props = {
      questions: questions.map((q) => ({
        kind: q.kind, tier: q.tier, prompt: q.prompt, options: q.options,
        seq: q.seq, answer: q.answer, explanation: q.explanation, figure: q.figure,
      })),
      reveal: "last",
      narration: { mode: "full" },
      music: CONFIG.MUSIC_TRACKS[(from + i) % CONFIG.MUSIC_TRACKS.length],
      showProgress: true,
      progressStyle: "full",
      mascot: "standard",
      opening,
    };

    // 6. Render. TikTok's safe box is the tightest and is a subset of Instagram's, so
    //    one render is safe on both networks.
    const res = R.renderVideo(videoId, props, {});
    console.log(`    rendered ${res.frames}f -> ${res.path}`);

    // 7. The deterministic publish gate, on what will ACTUALLY render.
    const mapped = R.mapProps(props);
    const explanations = mapped.questions.map((q) => q.explanation);
    // ansLabel is the answer AS DISPLAYED; q.answer is an internal code on shapes.
    const answerLabels = mapped.questions.map((q) => q.ansLabel);
    const gate = G.publishGate({ id: videoId, caption, hashtag_set, questions, explanations, answerLabels }, recent);
    console.log(`    publish-gate: ${gate.pass ? "PASS" : "FAIL"} — ${gate.reason}`);
    if (!gate.pass) { console.log("    SKIPPED (not scheduled)"); continue; }

    if (dry) { console.log("    dry run, not scheduling"); recent.push({ caption, hashtag_set, explanations }); continue; }

    // 8. Upload + schedule on Instagram only.
    const mediaUrl = uploadToS3(res.path, `hermes/${day}/${videoId}.mp4`);
    const post = await M.createPost({
      text: caption,
      mediaUrl,
      publicationDate: { dateTime: times[i], timezone: CONFIG.METRICOOL_TZ },
      networks: ["instagram"],
      draft: false,
      autoPublish: true,
      showReelOnFeed: true,
    });
    console.log(`    SCHEDULED ${times[i]} ${CONFIG.METRICOOL_TZ}  uuid=${post.uuid}`);

    const rec = { videoId, uuid: String(post.uuid), id: post.id, at: times[i], opening, caption, hashtag_set, explanations, network: "instagram" };
    made.push(rec);
    recent.push({ caption, hashtag_set, explanations });
    // Persist after EVERY create so a crash never loses track of a live post.
    led.posts = [...(led.posts ?? []), rec];
    led.updated_at = new Date().toISOString();
    writeJSONAtomic(LEDGER, led);
  }

  console.log(`\n=== scheduled ${made.length} of ${times.length} attempted (day target ${n}) ===`);
  for (const m of made) console.log(`  ${m.at}  ${m.videoId}  arm=${m.opening}  uuid=${m.uuid}`);
  console.log(`\nledger: ${LEDGER}`);
  console.log("stop everything with:  node ops/resume_posting.mjs --stop");
}

if (argv.includes("--stop")) await stop();
else if (argv.includes("--list")) await list();
else await run();
