/**
 * verbal-gen.mjs — PROCEDURAL verbal item generator for the mass-gen pipeline.
 *
 * Scales the three verbal tiers to hundreds of unique, single-answer, Grade-5,
 * dash-free items so the bank can reach ~100 rounds. Single-answer is guaranteed
 * BY CONSTRUCTION; the AI-judge pass is the safety net on top:
 *
 *  ODD ONE OUT   — 3 words from one clean category + 1 outsider from a category
 *                  in a DIFFERENT super-group (so the outsider is unmistakable).
 *  VERBAL ANALOGY— two pairs from the same functional relation (opposite, home,
 *                  baby, sound, tool, material, part, workplace, use). Each C has
 *                  exactly one D, so distractors drawn from OTHER pairs' answers
 *                  are always wrong -> exactly one correct option.
 *  SENTENCE      — context-clue frames with subject variants; the clue fixes the
 *                  answer regardless of subject, and distractors are clearly wrong.
 *
 * makeVerbalGen(rng) returns { oddoneout, analogy, sentence } as large shuffled
 * arrays of { q, correct, distractors[3], explanation, fontSize? } (UPPERCASE
 * options), consumed exactly like the curated verbal-bank.
 */

const UP = (s) => String(s).toUpperCase();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const artOf = (w) => (/^[aeiou]/i.test(w) ? "an" : "a");

// ---- ODD ONE OUT: clean, mutually-exclusive categories, grouped by domain ----
const CATS = {
  fruits:      { group: "food",     name: "fruits",      one: "a fruit",              words: ["apple","banana","grape","orange","peach","pear","plum","cherry","lemon","mango","melon","kiwi"] },
  vegetables:  { group: "food",     name: "vegetables",  one: "a vegetable",          words: ["carrot","potato","onion","celery","spinach","cabbage","cucumber","pumpkin","radish","lettuce","broccoli","pea"] },
  drinks:      { group: "food",     name: "drinks",      one: "a drink",              words: ["milk","juice","tea","coffee","lemonade","soda","cocoa","cider"] },
  mammals:     { group: "animals",  name: "mammals",     one: "a mammal",             words: ["dog","cat","horse","cow","lion","tiger","bear","rabbit","wolf","deer","fox","sheep"] },
  birds:       { group: "animals",  name: "birds",       one: "a bird",               words: ["robin","sparrow","owl","hawk","crow","duck","eagle","swan","parrot","pigeon","finch","wren"] },
  fish:        { group: "animals",  name: "fish",        one: "a fish",               words: ["trout","salmon","shark","tuna","cod","bass","carp","eel","goldfish","catfish"] },
  insects:     { group: "animals",  name: "insects",     one: "an insect",            words: ["ant","bee","fly","beetle","moth","wasp","ladybug","grasshopper","dragonfly","flea"] },
  cars:        { group: "vehicles", name: "road vehicles", one: "a road vehicle",     words: ["car","bus","truck","van","motorcycle","scooter","tractor","jeep","taxi","wagon"] },
  boats:       { group: "vehicles", name: "boats",       one: "a boat",               words: ["boat","ship","canoe","kayak","ferry","yacht","raft","sailboat"] },
  aircraft:    { group: "vehicles", name: "aircraft",    one: "an aircraft",          words: ["plane","jet","helicopter","glider","blimp","rocket"] },
  tools:       { group: "objects",  name: "tools",       one: "a tool",               words: ["hammer","saw","wrench","drill","screwdriver","pliers","chisel","axe","shovel","rake"] },
  furniture:   { group: "objects",  name: "furniture",   one: "a piece of furniture", words: ["chair","table","bed","desk","sofa","shelf","stool","bench","dresser","cabinet"] },
  clothing:    { group: "objects",  name: "clothing",    one: "a piece of clothing",  words: ["shirt","pants","jacket","hat","sock","dress","coat","scarf","glove","sweater","skirt"] },
  instruments: { group: "objects",  name: "instruments", one: "an instrument",        words: ["piano","guitar","drum","violin","flute","trumpet","harp","cello","banjo","clarinet"] },
  colors:      { group: "abstract", name: "colors",      one: "a color",              words: ["red","blue","green","yellow","purple","pink","brown","black","white","gray"] },
  shapes:      { group: "abstract", name: "shapes",      one: "a shape",              words: ["circle","square","triangle","rectangle","oval","pentagon","hexagon","cube"] },
  numbers:     { group: "abstract", name: "numbers",     one: "a number",             words: ["three","seven","twelve","twenty","forty","fifteen","ninety","fifty"] },
  metals:      { group: "nature",   name: "metals",      one: "a metal",              words: ["gold","silver","iron","copper","steel","tin","bronze","brass","nickel","zinc"] },
  planets:     { group: "nature",   name: "planets",     one: "a planet",             words: ["mercury","venus","mars","jupiter","saturn","neptune","uranus"] },
  trees:       { group: "nature",   name: "trees",       one: "a tree",               words: ["oak","pine","maple","birch","elm","willow","cedar","spruce","redwood"] },
  weather:     { group: "nature",   name: "kinds of weather", one: "a kind of weather", words: ["rain","snow","wind","fog","hail","sleet","thunder","drizzle"] },
  bodyparts:   { group: "body",     name: "body parts",  one: "a body part",          words: ["arm","leg","hand","foot","elbow","knee","shoulder","wrist","ankle","chin"] },
  sports:      { group: "body",     name: "sports",      one: "a sport",              words: ["soccer","tennis","baseball","hockey","golf","rugby","cricket","volleyball","boxing"] },
};

// ---- VERBAL ANALOGY: functional relations (each C has exactly one D) ----------
const REL = {
  opposite: {
    // "loud" omitted: it has two common antonyms (quiet AND soft), so it would
    // clash with the "soft" answer from the hard/soft pair. Every kept word has a
    // single canonical opposite -> distractors from other pairs are always wrong.
    pairs: [["hot","cold"],["big","small"],["up","down"],["fast","slow"],["happy","sad"],["open","closed"],["wet","dry"],["hard","soft"],["light","dark"],["full","empty"],["high","low"],["old","new"],["clean","dirty"],["near","far"],["rich","poor"],["win","lose"],["day","night"],["left","right"],["early","late"],["tall","short"],["strong","weak"],["thick","thin"],["deep","shallow"],["wide","narrow"],["give","take"],["push","pull"],["begin","end"],["float","sink"],["buy","sell"]],
    exp: (a, b, c, d) => `${cap(a)} and ${b} are opposites, so the opposite of ${c} is ${d}.`,
  },
  home: {
    pairs: [["dog","kennel"],["horse","stable"],["cow","barn"],["pig","pen"],["bird","nest"],["bee","hive"],["spider","web"],["rabbit","burrow"],["ant","anthill"],["fox","den"],["fish","pond"],["sheep","fold"]],
    exp: (a, b, c, d) => `${cap(a)} lives in ${artOf(b)} ${b}, so ${artOf(c)} ${c} lives in ${artOf(d)} ${d}.`,
  },
  baby: {
    pairs: [["cat","kitten"],["dog","puppy"],["cow","calf"],["horse","foal"],["sheep","lamb"],["frog","tadpole"],["hen","chick"],["duck","duckling"],["kangaroo","joey"],["goat","kid"],["deer","fawn"],["bear","cub"]],
    exp: (a, b, c, d) => `${cap(a)} baby is called a ${b}, so ${artOf(c)} ${c} baby is called a ${d}.`,
  },
  sound: {
    pairs: [["dog","bark"],["cat","meow"],["cow","moo"],["duck","quack"],["lion","roar"],["horse","neigh"],["sheep","baa"],["snake","hiss"],["bird","chirp"],["bee","buzz"],["wolf","howl"],["frog","croak"],["pig","oink"],["owl","hoot"]],
    exp: (a, b, c, d) => `${cap(a)} says ${b}, so ${artOf(c)} ${c} says ${d}.`,
  },
  tool: {
    pairs: [["painter","brush"],["farmer","plow"],["chef","knife"],["writer","pen"],["gardener","spade"],["carpenter","hammer"],["tailor","needle"],["barber","scissors"],["fisherman","net"],["miner","pickaxe"]],
    exp: (a, b, c, d) => `${cap(a)} uses ${artOf(b)} ${b}, so ${artOf(c)} ${c} uses ${artOf(d)} ${d}.`,
  },
  material: {
    // "bottle" omitted: bottles are commonly glass OR plastic, so it would clash
    // with the "glass" answer from window/glass. Every kept object has a single
    // canonical material.
    pairs: [["window","glass"],["book","paper"],["tire","rubber"],["ring","gold"],["shirt","cotton"],["spoon","metal"],["candle","wax"],["table","wood"],["brick","clay"]],
    exp: (a, b, c, d) => `${cap(a)} is made of ${b}, so ${artOf(c)} ${c} is made of ${d}.`,
  },
  part: {
    pairs: [["finger","hand"],["toe","foot"],["petal","flower"],["page","book"],["wheel","car"],["sail","boat"],["room","house"],["leaf","plant"],["key","piano"],["tooth","mouth"]],
    exp: (a, b, c, d) => `${cap(a)} is part of ${artOf(b)} ${b}, so ${artOf(c)} ${c} is part of ${artOf(d)} ${d}.`,
  },
  workplace: {
    pairs: [["teacher","school"],["doctor","hospital"],["chef","kitchen"],["judge","court"],["pilot","airplane"],["sailor","ship"],["actor","stage"],["baker","bakery"],["farmer","farm"],["librarian","library"]],
    exp: (a, b, c, d) => `${cap(a)} works in ${artOf(b)} ${b}, so ${artOf(c)} ${c} works in ${artOf(d)} ${d}.`,
  },
  use: {
    pairs: [["knife","cut"],["broom","sweep"],["pen","write"],["eye","see"],["ear","hear"],["lamp","light"],["oven","heat"],["clock","time"],["scale","weigh"],["ruler","measure"]],
    exp: (a, b, c, d) => `${cap(a)} is used to ${b}, so ${artOf(c)} ${c} is used to ${d}.`,
  },
  habitat: {
    pairs: [["fish","water"],["camel","desert"],["whale","ocean"],["monkey","jungle"],["lion","savanna"],["penguin","ice"],["bat","cave"],["duck","pond"]],
    exp: (a, b, c, d) => `${cap(a)} lives in the ${b}, so ${artOf(c)} ${c} lives in the ${d}.`,
  },
};

// ---- SENTENCE COMPLETION: context-clue frames + subject variants -------------
const CLUES = [
  { subs: ["soil","ground","grass","field"], frame: (s) => `BECAUSE IT HAD NOT RAINED FOR WEEKS, THE\n${UP(s)} IN THE GARDEN WAS VERY ______.`, correct: "DRY", distr: ["WET", "GREEN", "COLD"], exp: "With no rain for weeks, the ground is dry." },
  { subs: ["soup","tea","stew","cocoa"], frame: (s) => `THE ${UP(s)} WAS FAR TOO ______ TO DRINK, SO WE\nWAITED FOR IT TO COOL DOWN FIRST.`, correct: "HOT", distr: ["COLD", "SWEET", "EMPTY"], exp: "Waiting for it to cool means it was hot." },
  { subs: ["runner","player","swimmer","hiker"], frame: (s) => `AFTER THE LONG RACE, THE ${UP(s)}\nFELT VERY ______ AND SAT DOWN TO REST.`, correct: "TIRED", distr: ["HAPPY", "FAST", "EARLY"], exp: "Needing to rest after a race means tired." },
  { subs: ["room","hallway","closet","cellar"], frame: (s) => `SINCE THE ${UP(s)} WAS COMPLETELY ______,\nWE TURNED ON A LAMP SO WE COULD SEE.`, correct: "DARK", distr: ["BRIGHT", "WARM", "LARGE"], exp: "You turn on a lamp when it is dark." },
  { subs: ["street","market","stadium","hall"], frame: (s) => `WE COULD NOT HEAR EACH OTHER BECAUSE\nTHE ${UP(s)} WAS FAR TOO ______.`, correct: "NOISY", distr: ["QUIET", "EMPTY", "CLEAN"], exp: "Not being able to hear means noisy." },
  { subs: ["ice cream","snow","butter","chocolate"], frame: (s) => `THE ${UP(s)} STARTED TO ______ QUICKLY\nBECAUSE THE DAY WAS SO HOT.`, correct: "MELT", distr: ["FREEZE", "GROW", "SHINE"], exp: "Heat makes it melt." },
  { subs: ["boy","girl","child","kid"], frame: (s) => `THE ${UP(s)} WAS ______ WHEN THE GIFT WAS\nOPENED AND THE NEW BIKE APPEARED.`, correct: "EXCITED", distr: ["BORED", "SLEEPY", "HUNGRY"], exp: "A wanted gift makes you excited." },
  { subs: ["vase","glass","plate","mirror"], frame: (s) => `PLEASE BE ______ WITH THE ${UP(s)} SO THAT\nIT DOES NOT FALL AND BREAK.`, correct: "CAREFUL", distr: ["QUICK", "LOUD", "SILLY"], exp: "You must be careful so it does not break." },
  { subs: ["garden","meadow","park","yard"], frame: (s) => `THE ${UP(s)} WAS FULL OF ______ FLOWERS\nIN RED, YELLOW, AND PURPLE.`, correct: "COLORFUL", distr: ["PLAIN", "EMPTY", "TINY"], exp: "Many colors means colorful." },
  { subs: ["box","crate","suitcase","barrel"], frame: (s) => `THE ${UP(s)} WAS TOO ______ TO LIFT ALONE,\nSO TWO PEOPLE CARRIED IT TOGETHER.`, correct: "HEAVY", distr: ["LIGHT", "OPEN", "EMPTY"], exp: "Needing two people means heavy." },
  { subs: ["story","book","movie","tale"], frame: (s) => `THE ${UP(s)} WAS SO ______ THAT I COULD\nNOT STOP UNTIL I REACHED THE END.`, correct: "INTERESTING", distr: ["BORING", "SHORT", "QUIET"], exp: "Not wanting to stop means interesting." },
  { subs: ["desk","room","garage","shelf"], frame: (s) => `HE COULD NOT FIND HIS KEYS BECAUSE THE\n${UP(s)} WAS SO ______ AND CLUTTERED.`, correct: "MESSY", distr: ["CLEAN", "EMPTY", "BRIGHT"], exp: "Cluttered means messy." },
  { subs: ["cake","pie","cookie","muffin"], frame: (s) => `THE ${UP(s)} TASTED VERY ______ BECAUSE\nMY AUNT ADDED LOTS OF SUGAR.`, correct: "SWEET", distr: ["SALTY", "SOUR", "BITTER"], exp: "Lots of sugar makes it sweet." },
  { subs: ["morning","day","wind","air"], frame: (s) => `WE WORE THICK COATS AND GLOVES BECAUSE\nTHE WINTER ${UP(s)} WAS SO ______.`, correct: "COLD", distr: ["HOT", "SUNNY", "LOUD"], exp: "Coats and gloves mean cold." },
  { subs: ["baby","kitten","puppy","toddler"], frame: (s) => `THE ${UP(s)} WAS SLEEPING, SO WE ALL TRIED\nTO STAY ______ AND NOT WAKE IT UP.`, correct: "QUIET", distr: ["LOUD", "BUSY", "AWAKE"], exp: "You stay quiet near a sleeper." },
  { subs: ["plant","flower","seedling","vine"], frame: (s) => `THE ${UP(s)} ON THE WINDOWSILL GREW TALL\nBECAUSE IT GOT PLENTY OF ______ AND WATER.`, correct: "SUNLIGHT", distr: ["DARKNESS", "NOISE", "PAPER"], exp: "Plants need sunlight and water." },
  { subs: ["lake","pond","river","pool"], frame: (s) => `THE ${UP(s)} FROZE SOLID IN JANUARY, SO THE\nCHILDREN COULD ______ ACROSS THE TOP.`, correct: "SKATE", distr: ["SWIM", "DIVE", "SAIL"], exp: "Frozen water lets you skate." },
  { subs: ["knight","soldier","guard","hero"], frame: (s) => `THE ${UP(s)} WAS VERY ______ AND STOOD\nHIS GROUND EVEN WHEN HE WAS AFRAID.`, correct: "BRAVE", distr: ["SHY", "LAZY", "TIRED"], exp: "Standing ground despite fear is brave." },
  { subs: ["path","road","trail","hallway"], frame: (s) => `THE ${UP(s)} WAS SO ______ THAT ONLY ONE\nPERSON COULD SQUEEZE THROUGH AT A TIME.`, correct: "NARROW", distr: ["WIDE", "SHORT", "SMOOTH"], exp: "Only one at a time means narrow." },
  { subs: ["puzzle","riddle","test","maze"], frame: (s) => `THE ${UP(s)} WAS SO ______ THAT IT TOOK\nHER ALL AFTERNOON TO SOLVE IT.`, correct: "DIFFICULT", distr: ["EASY", "SHORT", "SILLY"], exp: "Taking all afternoon means difficult." },
  { subs: ["turtle","snail","sloth","tortoise"], frame: (s) => `THE ${UP(s)} MOVED SO ______ THAT IT TOOK\nAN HOUR TO CROSS THE SMALL YARD.`, correct: "SLOWLY", distr: ["QUICKLY", "LOUDLY", "NEATLY"], exp: "An hour to cross means slowly." },
  { subs: ["water","juice","stream","spring"], frame: (s) => `THE ${UP(s)} FROM THE MOUNTAIN WAS SO\n______ THAT WE COULD SEE THE BOTTOM.`, correct: "CLEAR", distr: ["MUDDY", "WARM", "SWEET"], exp: "Seeing the bottom means clear." },
  { subs: ["joke","clown","story","cartoon"], frame: (s) => `THE ${UP(s)} WAS SO ______ THAT EVERYONE\nIN THE ROOM BURST OUT LAUGHING.`, correct: "FUNNY", distr: ["SAD", "SCARY", "BORING"], exp: "Bursting out laughing means funny." },
  { subs: ["rope","thread","string","wire"], frame: (s) => `THE ${UP(s)} WAS TOO ______, SO IT SNAPPED\nAS SOON AS WE PULLED ON IT.`, correct: "WEAK", distr: ["STRONG", "LONG", "NEW"], exp: "Snapping when pulled means weak." },
  { subs: ["gift","surprise","letter","call"], frame: (s) => `THE ${UP(s)} WAS COMPLETELY ______, SO SHE\nGASPED WHEN SHE FINALLY SAW IT.`, correct: "UNEXPECTED", distr: ["PLANNED", "BORING", "USUAL"], exp: "A gasp means it was unexpected." },
  { subs: ["blanket","sweater","scarf","rug"], frame: (s) => `THE WOOL ${UP(s)} FELT VERY ______ AND KEPT\nUS WARM ON THE COLD NIGHT.`, correct: "COZY", distr: ["ROUGH", "COLD", "WET"], exp: "Wool that keeps you warm feels cozy." },
  { subs: ["room","kitchen","floor","window"], frame: (s) => `AFTER AN HOUR OF SCRUBBING, THE ${UP(s)}\nWAS FINALLY SPARKLING ______.`, correct: "CLEAN", distr: ["DIRTY", "DARK", "BROKEN"], exp: "Scrubbing until sparkling means clean." },
  { subs: ["dog","pony","parrot","seal"], frame: (s) => `THE ${UP(s)} WAS SO ______ THAT IT LEARNED\nTHE NEW TRICK IN JUST ONE TRY.`, correct: "CLEVER", distr: ["SLEEPY", "GRUMPY", "HUNGRY"], exp: "Learning in one try means clever." },
  { subs: ["hill","stairs","slope","ramp"], frame: (s) => `THE ${UP(s)} WAS SO ______ THAT WE HAD TO\nREST HALFWAY UP TO CATCH OUR BREATH.`, correct: "STEEP", distr: ["FLAT", "SHORT", "WIDE"], exp: "Resting to catch breath means steep." },
  { subs: ["bell","alarm","siren","whistle"], frame: (s) => `THE ${UP(s)} WAS SO ______ THAT WE COVERED\nOUR EARS UNTIL IT FINALLY STOPPED.`, correct: "LOUD", distr: ["SOFT", "QUIET", "SLOW"], exp: "Covering ears means loud." },
];

export function makeVerbalGen(rng) {
  const rand = () => rng();
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const shuffle = (a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
  const sampleN = (a, n) => shuffle(a).slice(0, n);

  // ---- odd-one-out ----
  const catKeys = Object.keys(CATS);
  const oddSeen = new Set();
  const oddoneout = [];
  for (let tries = 0; tries < 6000 && oddoneout.length < 500; tries++) {
    const aKey = pick(catKeys);
    const A = CATS[aKey];
    const bKey = pick(catKeys.filter((k) => CATS[k].group !== A.group));
    const B = CATS[bKey];
    if (A.words.length < 3) continue;
    const three = sampleN(A.words, 3);
    const outsider = pick(B.words);
    const setKey = [...three, outsider].map((w) => w.toLowerCase()).sort().join("|");
    if (oddSeen.has(setKey)) continue;
    oddSeen.add(setKey);
    oddoneout.push({
      q: "WHICH ONE DOES NOT BELONG?",
      correct: UP(outsider),
      distractors: three.map(UP),
      explanation: `${cap(three[0])}, ${three[1]}, and ${three[2]} are all ${A.name}. ${cap(outsider)} is ${B.one}, so it does not belong.`,
      fontSize: 96,
    });
  }

  // ---- verbal analogy ----
  const analogy = [];
  const anaSeen = new Set();
  for (const rkey of Object.keys(REL)) {
    const R = REL[rkey];
    const combos = shuffle(R.pairs.flatMap((p1, i) => R.pairs.map((p2, j) => (i !== j ? [i, j] : null)).filter(Boolean)));
    for (const [i, j] of combos) {
      const [a, b] = R.pairs[i];
      const [c, d] = R.pairs[j];
      const key = `${rkey}:${a}:${c}`;
      if (anaSeen.has(key)) continue;
      anaSeen.add(key);
      const answerPool = R.pairs.map((p) => p[1]).filter((x) => x !== d && x !== b);
      if (answerPool.length < 3) continue;
      analogy.push({
        q: `${UP(a)} IS TO ${UP(b)} AS\n${UP(c)} IS TO ?`,
        correct: UP(d),
        distractors: sampleN([...new Set(answerPool)], 3).map(UP),
        explanation: R.exp(a, b, c, d),
        fontSize: 82,
      });
    }
  }

  // ---- sentence completion ----
  const sentence = [];
  for (const clue of CLUES) {
    for (const s of clue.subs) {
      sentence.push({
        q: clue.frame(s),
        correct: clue.correct,
        distractors: [...clue.distr],
        explanation: clue.exp,
        fontSize: 56,
      });
    }
  }

  return { oddoneout: shuffle(oddoneout), analogy: shuffle(analogy), sentence: shuffle(sentence) };
}
