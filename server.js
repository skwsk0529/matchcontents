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

function validateTimeDigits(timeDigits) {
  if (!/^\d{2}:\d{2}$/.test(timeDigits)) {
    return "出生時刻は HH:mm 形式で入力してください。";
  }

  const hour = Number(timeDigits.slice(0, 2));
  const minute = Number(timeDigits.slice(3, 5));
  if (hour > 23 || minute > 59) {
    return "出生時刻の値が不正です。";
  }

  return null;
}

function validatePerson(person, label) {
  const dateError = validateDateDigits(person.birthDate);
  if (dateError) return `${label}: ${dateError}`;

  const timeError = validateTimeDigits(person.birthTime);
  if (timeError) return `${label}: ${timeError}`;

  if (!person.location || !String(person.location).trim()) {
    return `${label}: 出生地を入力してください。`;
  }

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
  const unavailable = [];

  for (const result of results) {
    if (!result.ok) {
      unavailable.push(result.label);
      continue;
    }

    if (result.label === "western") facts.push(...extractNatalFacts(result.data), ...extractTransitFacts(result.data));
    if (result.label === "sukuyo") facts.push(...extractSukuyoFortuneFacts(result.data));
    if (result.label === "kyusei") facts.push(...extractKyuseiFacts(result.data));
    if (result.label === "qimen") facts.push(...extractQimenFacts(result.data));
  }

  const uniqueFacts = [...new Set(facts)].slice(0, 8);

  const transitHit = uniqueFacts.find((fact) => fact.startsWith("西洋占星術では"));
  const sukuyoWarning = uniqueFacts.find((fact) => fact.startsWith("宿曜の注意"));
  const qimenDirection = uniqueFacts.find((fact) => fact.startsWith("奇門遁甲の吉方位候補"));
  const kyuseiAdvice = uniqueFacts.find((fact) => fact.startsWith("九星気学の示唆"));
  const dominantElement = uniqueFacts.find((fact) => fact.includes("元素バランス"));

  if (transitHit) {
    lines.push(`西洋占星術では強い動きとして「${transitHit.replace("西洋占星術では ", "")}」が出ています。今日は広げすぎず、1件ずつ処理を進める方が噛み合いやすいです。`);
  }
  if (dominantElement) {
    lines.push(`${dominantElement}。この傾向に合わせて、今日は自分に合う動き方を優先してください。`);
  }
  if (kyuseiAdvice) {
    lines.push(kyuseiAdvice.replace("九星気学の示唆: ", "九星気学の観点では "));
  } else {
    lines.push("九星気学の結果は、今日の判断を急ぎすぎず流れを見ながら合わせる使い方が向いています。");
  }
  if (qimenDirection) {
    lines.push(`${qimenDirection}。外出や打ち合わせを入れるなら、この方向を候補に入れてください。`);
  } else {
    lines.push("奇門遁甲では、移動や面談は時間と場所を固定してから再確認する使い方が適しています。");
  }
  if (sukuyoWarning) {
    lines.push(sukuyoWarning.replace("宿曜の注意: ", "宿曜では "));
  } else {
    lines.push("宿曜の観点では、今日は一気に結論を出すより、相手の出方を見ながら動く方が安定します。");
  }

  lines.push(`今日の一歩: ${input.name} さんは、今日中に1つだけ優先行動を決めて、連絡・移動・判断のどれかを先に実行してください。`);

  if (unavailable.length > 0) {
    lines.push(`取得できなかった系統: ${unavailable.join("、")}`);
  }

  return { message: lines.join("\n"), facts: uniqueFacts };
}

function buildCompatibilityAdvice(results, personA, personB) {
  const lines = ["二人の相性"];
  const facts = [];
  const unavailable = [];

  for (const result of results) {
    if (!result.ok) {
      unavailable.push(result.label);
      continue;
    }

    if (result.label === "synastry") facts.push(...extractSynastryFacts(result.data, personA.name, personB.name));
    if (result.label === "sukuyo") facts.push(...extractSukuyoCompatibilityFacts(result.data, personA.name, personB.name));
    if (result.label === "kyusei") facts.push(...extractKyuseiCompatibilityFacts(result.data));
  }

  const uniqueFacts = [...new Set(facts)].slice(0, 8);
  const westernScore = uniqueFacts.find((fact) => fact.startsWith("西洋占星術の相性スコア"));
  const sukuyoPair = uniqueFacts.find((fact) => fact.startsWith("宿曜の組み合わせ"));
  const sukuyoQuality = uniqueFacts.find((fact) => fact.startsWith("宿曜の質感"));
  const kyuseiAdvice = uniqueFacts.find((fact) => fact.startsWith("九星気学の助言"));

  if (westernScore) {
    lines.push(`${westernScore}。会話のテンポや役割分担を合わせると、相性の良さが表に出やすい組み合わせです。`);
  } else {
    lines.push("西洋占星術では、二人の相性は行動のタイミングと会話の運び方で見極めるのが良さそうです。");
  }
  if (sukuyoPair) {
    lines.push(`${sukuyoPair}。${sukuyoQuality ? sukuyoQuality.replace("宿曜の質感は ", "") : "関係の距離感に一定の傾向があります。"}。`);
  }
  if (kyuseiAdvice) {
    lines.push(kyuseiAdvice.replace("九星気学の助言: ", "九星気学では "));
  } else {
    lines.push("九星気学では、相手のペースを尊重しながら役割をはっきりさせると関係が安定しやすいです。");
  }

  lines.push(`二人への一歩: ${personA.name} さんと ${personB.name} さんは、まず短いやり取りを1回入れて反応を見る形が安全です。重い話は段階を分けてください。`);

  if (unavailable.length > 0) {
    lines.push(`取得できなかった系統: ${unavailable.join("、")}`);
  }

  return { message: lines.join("\n"), facts: uniqueFacts };
}

async function handleDailyAdvice(req, res, body) {
  const input = {
    name: String(body.name || "User"),
    birthDate: String(body.birthDate || ""),
    birthTime: String(body.birthTime || ""),
    location: String(body.location || "").trim()
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
    callTimeqlSettled("kyusei", "/api/v1/kyusei", {
      datetime,
      location: input.location
    }),
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
    birthTime: String(body.personABirthTime || ""),
    location: String(body.personALocation || "").trim()
  };
  const personB = {
    name: String(body.personBName || "B"),
    birthDate: String(body.personBBirthDate || ""),
    birthTime: String(body.personBBirthTime || ""),
    location: String(body.personBLocation || "").trim()
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
    callTimeqlSettled("kyusei", "/api/v1/kyusei/compatibility", {
      person1_datetime: person1Datetime,
      person2_datetime: person2Datetime
    })
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
