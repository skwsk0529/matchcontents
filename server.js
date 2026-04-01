const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const TIMEQL_API_KEY = loadEnv(".env").TIMEQL_API_KEY || process.env.TIMEQL_API_KEY;
const PUBLIC_DIR = path.join(__dirname, "public");
const rateLimitWindowMs = 60 * 1000;
const rateLimitMaxRequests = 10;
const ipHits = new Map();
const JST_TIMEZONE = "Asia/Tokyo";
const DEFAULT_BIRTH_TIME = "12:00";
const DEFAULT_LOCATION = "Tokyo";

function loadEnv(filename) {
  const envPath = path.join(__dirname, filename);
  if (!fs.existsSync(envPath)) return {};

  const env = {};
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(payload);
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const contentTypeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
  };

  res.writeHead(200, {
    "Content-Type": contentTypeMap[ext] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff"
  });
  fs.createReadStream(filePath).pipe(res);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function enforceRateLimit(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = ipHits.get(ip);

  if (!entry || now - entry.windowStart >= rateLimitWindowMs) {
    ipHits.set(ip, { count: 1, windowStart: now });
    return null;
  }

  if (entry.count >= rateLimitMaxRequests) {
    return Math.ceil((entry.windowStart + rateLimitWindowMs - now) / 1000);
  }

  entry.count += 1;
  return null;
}

function validateDateDigits(dateDigits) {
  if (!/^\d{8}$/.test(dateDigits)) {
    return "生年月日は YYYYMMDD の8桁で入力してください。";
  }

  const year = Number(dateDigits.slice(0, 4));
  const month = Number(dateDigits.slice(4, 6));
  const day = Number(dateDigits.slice(6, 8));
  const isoLike = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00`;

  if (month < 1 || month > 12 || day < 1 || day > 31 || Number.isNaN(new Date(isoLike).getTime())) {
    return "生年月日の値が不正です。";
  }

  return null;
}

function validatePerson(person, label) {
  const dateError = validateDateDigits(person.birthDate);
  if (dateError) return `${label}: ${dateError}`;

  return null;
}

function toIsoDatetime(dateDigits, timeDigits) {
  return `${dateDigits.slice(0, 4)}-${dateDigits.slice(4, 6)}-${dateDigits.slice(6, 8)}T${timeDigits}:00`;
}

function getCurrentJstDate() {
  const now = new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: JST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

function getCurrentJstDateTime() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`;
}

async function callTimeql(endpoint, payload) {
  if (!TIMEQL_API_KEY) {
    throw new Error("TIMEQL_API_KEY is not configured.");
  }

  const response = await fetch(`https://api.timeql.com${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": TIMEQL_API_KEY
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `TimeQL API request failed: ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function callTimeqlSettled(label, endpoint, payload) {
  try {
    const data = await callTimeql(endpoint, payload);
    return { label, ok: true, data };
  } catch (error) {
    return { label, ok: false, error: error.message || "Unknown error" };
  }
}

async function callKyuseiDailyWithFallback(datetime, location) {
  const primary = await callTimeqlSettled("kyusei", "/api/v1/kyusei", {
    datetime,
    location
  });
  if (primary.ok) return primary;

  const fallback = await callTimeqlSettled("kyusei", "/api/v1/kyusei/guidance", {
    datetime,
    location
  });
  if (fallback.ok) return fallback;

  return primary;
}

async function callKyuseiCompatibilityWithFallback(person1Datetime, person2Datetime) {
  const primary = await callTimeqlSettled("kyusei", "/api/v1/kyusei/compatibility", {
    person1_datetime: person1Datetime,
    person2_datetime: person2Datetime
  });
  if (primary.ok) return primary;

  return { label: "kyusei", ok: true, data: {} };
}

function topKeyByNumericValue(source) {
  if (!source || typeof source !== "object") return null;
  const entries = Object.entries(source).filter(([, value]) => typeof value === "number");
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0];
}

function safePush(list, value) {
  if (value) list.push(value);
}

function extractNatalFacts(natal) {
  const facts = [];
  safePush(facts, natal.planets?.sun?.sign ? `太陽星座は ${natal.planets.sun.sign}` : null);
  safePush(facts, natal.planets?.moon?.sign ? `月星座は ${natal.planets.moon.sign}` : null);
  safePush(facts, natal.planets?.sun?.house ? `太陽は ${natal.planets.sun.house} ハウス` : null);

  const topElement = topKeyByNumericValue(natal.elements);
  if (topElement) safePush(facts, `元素バランスでは ${topElement[0]} が優勢`);

  const topMode = topKeyByNumericValue(natal.modalities);
  if (topMode) safePush(facts, `活動区分では ${topMode[0]} が優勢`);

  return facts;
}

function extractTransitFacts(transits) {
  const facts = [];
  const aspects = Array.isArray(transits.aspects) ? transits.aspects : [];
  if (aspects.length > 0) {
    const sorted = [...aspects]
      .sort((a, b) => (Number(b?.strength) || 0) - (Number(a?.strength) || 0))
      .slice(0, 3);

    for (const aspect of sorted) {
      const parts = [
        aspect.transit_planet || aspect.transiting_planet,
        aspect.aspect,
        aspect.natal_planet
      ].filter(Boolean);
      safePush(facts, parts.length > 0 ? `西洋占星術では ${parts.join(" ")}` : null);
    }
  }

  safePush(facts, transits.transit_date ? `判定対象日は ${transits.transit_date}` : null);
  return facts;
}

function extractSukuyoFortuneFacts(result) {
  const facts = [];
  safePush(facts, result.birth_sukuyo?.name_japanese ? `本命宿は ${result.birth_sukuyo.name_japanese}` : null);
  safePush(facts, result.target_sukuyo?.name_japanese ? `対象日の宿は ${result.target_sukuyo.name_japanese}` : null);
  safePush(facts, result.sanku_label ? `宿曜の日運ラベルは ${result.sanku_label}` : null);
  safePush(facts, typeof result.fortune_score === "number" ? `宿曜の日運スコアは ${result.fortune_score}` : null);
  safePush(facts, result.warning ? `宿曜の注意: ${result.warning}` : null);
  return facts;
}

function extractKyuseiFacts(result) {
  const facts = [];
  safePush(facts, result.honmeisei?.name ? `本命星は ${result.honmeisei.name}` : null);
  safePush(facts, result.getsumeisei?.name ? `月命星は ${result.getsumeisei.name}` : null);
  safePush(facts, result.nichimeisei?.name ? `日命星は ${result.nichimeisei.name}` : null);
  safePush(facts, result.advice ? `九星気学の示唆: ${result.advice}` : null);
  return facts;
}

function extractQimenFacts(result) {
  const facts = [];
  const goodDirections = result.good_directions || result.auspicious_directions || result.favorable_directions;
  if (Array.isArray(goodDirections) && goodDirections.length > 0) {
    safePush(facts, `奇門遁甲の吉方位候補は ${goodDirections.slice(0, 3).join("、")}`);
  }
  safePush(facts, result.summary ? `奇門遁甲の概要: ${result.summary}` : null);
  safePush(facts, result.recommendation ? `奇門遁甲の推奨: ${result.recommendation}` : null);
  return facts;
}

function extractSynastryFacts(result, personAName, personBName) {
  const facts = [];
  const harmony = result.harmony_score || result.compatibility_score || result.total_score;
  if (typeof harmony === "number") {
    safePush(facts, `西洋占星術の相性スコアは ${harmony}`);
  }
  if (Array.isArray(result.aspects) && result.aspects.length > 0) {
    const aspect = result.aspects[0];
    const parts = [
      aspect.person1_planet || aspect.planet1,
      aspect.aspect,
      aspect.person2_planet || aspect.planet2
    ].filter(Boolean);
    safePush(facts, parts.length > 0 ? `${personAName} と ${personBName} の主要アスペクトは ${parts.join(" ")}` : null);
  }
  return facts;
}

function extractSukuyoCompatibilityFacts(result, personAName, personBName) {
  const facts = [];
  safePush(facts, result.person1?.sukuyo_name ? `${personAName} の本命宿は ${result.person1.sukuyo_name}` : null);
  safePush(facts, result.person2?.sukuyo_name ? `${personBName} の本命宿は ${result.person2.sukuyo_name}` : null);
  safePush(
    facts,
    typeof result.average_compatibility_score === "number"
      ? `宿曜の平均相性スコアは ${result.average_compatibility_score}`
      : null
  );
  safePush(facts, result.details?.pair ? `宿曜の組み合わせは ${result.details.pair}` : null);
  safePush(facts, result.details?.quality ? `宿曜の質感は ${result.details.quality}` : null);
  return facts;
}

function extractKyuseiCompatibilityFacts(result) {
  const facts = [];
  safePush(facts, result.relationship ? `九星気学の関係性は ${result.relationship}` : null);
  safePush(facts, result.advice ? `九星気学の助言: ${result.advice}` : null);
  safePush(
    facts,
    typeof result.compatibility_score === "number" ? `九星気学の相性スコアは ${result.compatibility_score}` : null
  );
  return facts;
}

function buildDailyAdvice(results, input) {
  const lines = ["今日の自分向け助言"];
  const facts = [];
  for (const result of results) {
    if (!result.ok) continue;

    if (result.label === "western") facts.push(...extractNatalFacts(result.data), ...extractTransitFacts(result.data));
    if (result.label === "sukuyo") facts.push(...extractSukuyoFortuneFacts(result.data));
    if (result.label === "kyusei") facts.push(...extractKyuseiFacts(result.data));
    if (result.label === "qimen") facts.push(...extractQimenFacts(result.data));
  }

  const uniqueFacts = [...new Set(facts)].slice(0, 8);

  const transitHit = uniqueFacts.find((fact) => fact.startsWith("西洋占星術では"));
  const sukuyoWarning = uniqueFacts.find((fact) => fact.startsWith("宿曜の注意"));
  const sukuyoLabel = uniqueFacts.find((fact) => fact.startsWith("宿曜の日運ラベル"));
  const sukuyoScore = uniqueFacts.find((fact) => fact.startsWith("宿曜の日運スコア"));
  const qimenDirection = uniqueFacts.find((fact) => fact.startsWith("奇門遁甲の吉方位候補"));
  const kyuseiAdvice = uniqueFacts.find((fact) => fact.startsWith("九星気学の示唆"));
  const honmeisei = uniqueFacts.find((fact) => fact.startsWith("本命星"));
  const dominantElement = uniqueFacts.find((fact) => fact.includes("元素バランス"));

  lines.push(
    `${input.name} さんの今日は、勢いだけで押し切るよりも、今どこに流れが向いているのかを確かめながら進む方が納得感を持ちやすい日です。` +
      `全体としては「今すぐ大きく変える」より「小さく整えて、合っているものを残す」動き方が合いやすく、目の前のことに丁寧に手を入れるほど感触が良くなりやすい流れが出ています。`
  );

  if (transitHit || dominantElement) {
    lines.push(
      `まず今日の基調として、${transitHit ? transitHit.replace("西洋占星術では ", "") : "西洋側の動き"}が目立っています。` +
        `${dominantElement ? `${dominantElement}ため、` : ""}` +
        `やるべきことを増やすより、優先順位を少し絞って、自分が今ほんとうに手をつけるべきものに集中すると、気持ちのブレが減っていきます。` +
        `焦って答えを出し切ろうとするより、ひとつ終わらせてから次に進むくらいの速度感の方が、結果的には深く前へ進めます。`
    );
  }

  if (kyuseiAdvice || honmeisei) {
    lines.push(
      `九星気学の観点では、${honmeisei ? `${honmeisei.replace("本命星は ", "")}の性質も踏まえて、` : ""}` +
        `${kyuseiAdvice ? kyuseiAdvice.replace("九星気学の示唆: ", "") : "流れに逆らわず、無理に結論を急がない姿勢"}` +
        `が大切です。今日は白黒を一気につけるよりも、まず場の空気を読み、自分の立ち位置を整えてから一歩出る方が自然です。` +
        `自分から全部を動かすというより、動くべき瞬間を見逃さないことが強さになります。`
    );
  }

  if (qimenDirection) {
    lines.push(
      `奇門遁甲では、${qimenDirection.replace("奇門遁甲の吉方位候補は ", "")}が良い候補として出ています。` +
        `もし今日、外出、面談、買い物、誰かに会いに行く予定があるなら、移動の方向や立ち寄る場所を少し意識するだけでも体感が変わる可能性があります。` +
        `大きく予定を変えなくても、「どちらへ向かうか」を丁寧に選ぶことが、気持ちの落ち着きや手応えにつながりやすい日です。`
    );
  } else {
    lines.push(
      "奇門遁甲の観点では、今日は無理に動き回るより、行く場所や会う相手を絞って動く方がまとまりやすい流れです。" +
        "予定を増やしすぎず、必要な移動だけを選ぶことで、気持ちも結果も散らばりにくくなります。"
    );
  }

  if (sukuyoLabel || sukuyoScore || sukuyoWarning) {
    lines.push(
      `宿曜では、${sukuyoLabel ? sukuyoLabel.replace("宿曜の日運ラベルは ", "") : "今日の巡り"}${sukuyoScore ? `、スコアは${sukuyoScore.replace("宿曜の日運スコアは ", "")}` : ""}という形で出ています。` +
        `${sukuyoWarning ? sukuyoWarning.replace("宿曜の注意: ", "") : "人とのやり取りは、先に空気を読み取ってから言葉を置く方が安定しやすい流れです。"} ` +
        `感情のままに踏み込むより、少し余白を持って距離感を見ることで、あとから「この進め方で良かった」と思える着地になりやすいです。`
    );
  }

  lines.push(
    `今日の一歩としては、${input.name} さんはまず「いちばん気になっていること」をひとつだけ選び、それに対して具体的な行動を一回だけ起こしてみてください。` +
      `誰かに連絡する、予定を一本決める、行く先を選ぶ、保留していた判断を小さく進める。そのどれでも構いません。` +
      `今日は大きな突破よりも、「静かに合っている方へ寄せる」ことが後押しになります。`
  );
  return { message: lines.join("\n"), facts: uniqueFacts };
}

function buildCompatibilityAdvice(results, personA, personB) {
  const lines = ["二人の相性"];
  const facts = [];

  for (const result of results) {
    if (!result.ok) continue;

    if (result.label === "synastry") facts.push(...extractSynastryFacts(result.data, personA.name, personB.name));
    if (result.label === "sukuyo") facts.push(...extractSukuyoCompatibilityFacts(result.data, personA.name, personB.name));
    if (result.label === "kyusei") facts.push(...extractKyuseiCompatibilityFacts(result.data));
  }

  const uniqueFacts = [...new Set(facts)].slice(0, 8);
  const westernScore = uniqueFacts.find((fact) => fact.startsWith("西洋占星術の相性スコア"));
  const westernAspect = uniqueFacts.find((fact) => fact.includes("主要アスペクト"));
  const sukuyoPair = uniqueFacts.find((fact) => fact.startsWith("宿曜の組み合わせ"));
  const sukuyoQuality = uniqueFacts.find((fact) => fact.startsWith("宿曜の質感"));
  const sukuyoScore = uniqueFacts.find((fact) => fact.startsWith("宿曜の平均相性スコア"));
  const kyuseiAdvice = uniqueFacts.find((fact) => fact.startsWith("九星気学の助言"));
  const kyuseiRelation = uniqueFacts.find((fact) => fact.startsWith("九星気学の関係性"));

  lines.push(
    `${personA.name} さんと ${personB.name} さんの相性は、強く引き合うかどうかだけでなく、どの距離感で関わると心地よさが保たれるかを見ると輪郭がはっきりしてきます。` +
      `今回の読み取りでは、相手を変えようとするよりも、それぞれのテンポの違いを理解した上で関わる方が関係の良さが出やすい印象です。`
  );

  if (westernScore || westernAspect) {
    lines.push(
      `西洋占星術では、${westernScore ? westernScore.replace("西洋占星術の相性スコアは ", "相性スコアが") : "二人のつながり方に特徴があり"}、` +
        `${westernAspect ? `${westernAspect.replace(`${personA.name} と ${personB.name} の主要アスペクトは `, "")}という接点も見えています。` : ""}` +
        `この組み合わせは、感覚がぴったり重なる瞬間と、少しズレを感じる瞬間の両方が出やすいぶん、会話の持っていき方ひとつで印象がかなり変わりやすい関係です。` +
        `気持ちを決めつけて断定するより、「今はこう感じている」とその時点の温度を言葉にした方が、関係が柔らかく進みやすくなります。`
    );
  } else {
    lines.push(
      "西洋占星術の観点では、二人は結論を急ぐより、会話のテンポと気分の波を知っていくことで相性の良さが見えやすい組み合わせです。"
    );
  }

  if (sukuyoPair || sukuyoQuality || sukuyoScore) {
    lines.push(
      `宿曜では、${sukuyoPair ? sukuyoPair.replace("宿曜の組み合わせは ", "") : "二人の組み合わせ"}${sukuyoScore ? `、平均相性スコアは${sukuyoScore.replace("宿曜の平均相性スコアは ", "")}` : ""}と出ています。` +
        `${sukuyoQuality ? `${sukuyoQuality.replace("宿曜の質感は ", "")}。` : ""}` +
        `つまり、関係の手触りにはすでに一定の方向性があり、無理に形を決めようとしなくても、自然に心地よい距離へ寄っていける余地があります。` +
        `近づくときも離れるときも、急な強さより、相手が受け取りやすい速度を選ぶことが大切です。`
    );
  }

  if (kyuseiAdvice || kyuseiRelation) {
    lines.push(
      `九星気学では、${kyuseiRelation ? kyuseiRelation.replace("九星気学の関係性は ", "") : "二人の関係の相性"}が示されており、` +
        `${kyuseiAdvice ? kyuseiAdvice.replace("九星気学の助言: ", "") : "相手のペースを尊重しながら役割を急いで決めすぎないこと"}が鍵になります。` +
        `どちらが主導するかを早く決めるより、その場その場で自然に前に出る側を入れ替えられる関係の方が、長く安定しやすい流れです。`
    );
  }

  lines.push(
    `二人への一歩としては、${personA.name} さんと ${personB.name} さんは、まず短いやり取りを一度入れて、今の温度感を確かめるところから始めるのが良さそうです。` +
      `重たい話や結論を求める話題は一気に進めず、ひとつずつ段階を分けて置いていく方が、相手の反応も見えやすくなります。` +
      `この関係は、言葉の強さよりも、差し出し方のやわらかさが結果を大きく左右します。`
  );
  return { message: lines.join("\n"), facts: uniqueFacts };
}

async function handleDailyAdvice(req, res, body) {
  const input = {
    name: String(body.name || "User"),
    birthDate: String(body.birthDate || ""),
    birthTime: DEFAULT_BIRTH_TIME,
    location: DEFAULT_LOCATION
  };

  const validationError = validatePerson(input, "本人");
  if (validationError) {
    sendJson(res, 400, { error: validationError });
    return;
  }

  const datetime = toIsoDatetime(input.birthDate, input.birthTime);
  const currentDate = getCurrentJstDate();
  const currentDateTime = getCurrentJstDateTime();

  const results = await Promise.all([
    callTimeqlSettled("western", "/api/v1/transits", {
      name: input.name,
      datetime,
      location: input.location,
      transit_date: currentDate
    }),
    callTimeqlSettled("sukuyo", "/api/v1/sukuyo/fortune", {
      name: input.name,
      birth_datetime: datetime,
      target_date: `${currentDate}T00:00:00`,
      include_ryohan: true,
      include_rokugai: true
    }),
    callKyuseiDailyWithFallback(datetime, input.location),
    callTimeqlSettled("qimen", "/api/v1/qimen", {
      datetime: currentDateTime,
      location: input.location
    })
  ]);

  const advice = buildDailyAdvice(results, input);
  sendJson(res, 200, {
    mode: "daily",
    input: { ...input, datetime, currentDate },
    advice
  });
}

async function handleCompatibility(req, res, body) {
  const personA = {
    name: String(body.personAName || "A"),
    birthDate: String(body.personABirthDate || ""),
    birthTime: DEFAULT_BIRTH_TIME,
    location: DEFAULT_LOCATION
  };
  const personB = {
    name: String(body.personBName || "B"),
    birthDate: String(body.personBBirthDate || ""),
    birthTime: DEFAULT_BIRTH_TIME,
    location: DEFAULT_LOCATION
  };

  const errorA = validatePerson(personA, "1人目");
  if (errorA) {
    sendJson(res, 400, { error: errorA });
    return;
  }
  const errorB = validatePerson(personB, "2人目");
  if (errorB) {
    sendJson(res, 400, { error: errorB });
    return;
  }

  const person1Datetime = toIsoDatetime(personA.birthDate, personA.birthTime);
  const person2Datetime = toIsoDatetime(personB.birthDate, personB.birthTime);

  const results = await Promise.all([
    callTimeqlSettled("synastry", "/api/v1/synastry", {
      person1: { name: personA.name, datetime: person1Datetime, location: personA.location },
      person2: { name: personB.name, datetime: person2Datetime, location: personB.location }
    }),
    callTimeqlSettled("sukuyo", "/api/v1/sukuyo/compatibility", {
      person1_name: personA.name,
      person1_datetime: person1Datetime,
      person2_name: personB.name,
      person2_datetime: person2Datetime,
      include_details: true
    }),
    callKyuseiCompatibilityWithFallback(person1Datetime, person2Datetime)
  ]);

  const advice = buildCompatibilityAdvice(results, personA, personB);
  sendJson(res, 200, {
    mode: "compatibility",
    input: {
      personA: { ...personA, datetime: person1Datetime },
      personB: { ...personB, datetime: person2Datetime }
    },
    advice
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "read-life",
      hasTimeqlKey: Boolean(TIMEQL_API_KEY)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    sendFile(res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }
  if (req.method === "GET" && url.pathname === "/app.js") {
    sendFile(res, path.join(PUBLIC_DIR, "app.js"));
    return;
  }
  if (req.method === "GET" && url.pathname === "/styles.css") {
    sendFile(res, path.join(PUBLIC_DIR, "styles.css"));
    return;
  }

  if (req.method === "POST" && (url.pathname === "/api/daily-advice" || url.pathname === "/api/compatibility")) {
    try {
      const retryAfterSeconds = enforceRateLimit(req);
      if (retryAfterSeconds !== null) {
        sendJson(
          res,
          429,
          { error: "アクセスが集中しています。少し待って再試行してください。" },
          { "Retry-After": String(retryAfterSeconds) }
        );
        return;
      }

      const body = await parseJsonBody(req);
      if (url.pathname === "/api/daily-advice") {
        await handleDailyAdvice(req, res, body);
        return;
      }
      await handleCompatibility(req, res, body);
      return;
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Unexpected server error" });
      return;
    }
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
