const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const TIMEQL_API_KEY = loadEnv(".env").TIMEQL_API_KEY || process.env.TIMEQL_API_KEY;
const PUBLIC_DIR = path.join(__dirname, "public");
const rateLimitWindowMs = 60 * 1000;
const rateLimitMaxRequests = 10;
const ipHits = new Map();

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

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
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

function validateInput(dateDigits, timeDigits) {
  if (!/^\d{8}$/.test(dateDigits)) {
    return "生年月日は YYYYMMDD の8桁で入力してください。";
  }
  if (!/^\d{2}:\d{2}$/.test(timeDigits)) {
    return "出生時刻は HH:mm 形式で入力してください。";
  }

  const year = Number(dateDigits.slice(0, 4));
  const month = Number(dateDigits.slice(4, 6));
  const day = Number(dateDigits.slice(6, 8));
  const hour = Number(timeDigits.slice(0, 2));
  const minute = Number(timeDigits.slice(3, 5));

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return "生年月日の値が不正です。";
  }
  if (hour > 23 || minute > 59) {
    return "出生時刻の値が不正です。";
  }

  const isoLike = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${timeDigits}:00`;
  if (Number.isNaN(new Date(isoLike).getTime())) {
    return "日時として解釈できませんでした。";
  }

  return null;
}

function toIsoDatetime(dateDigits, timeDigits) {
  return `${dateDigits.slice(0, 4)}-${dateDigits.slice(4, 6)}-${dateDigits.slice(6, 8)}T${timeDigits}:00`;
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
    const retryAfterSeconds = Math.ceil((entry.windowStart + rateLimitWindowMs - now) / 1000);
    return retryAfterSeconds;
  }

  entry.count += 1;
  return null;
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

function summarizeFact(label, value) {
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value)) return `${label}: ${value.join(", ")}`;
  if (typeof value === "object") return `${label}: ${JSON.stringify(value)}`;
  return `${label}: ${value}`;
}

function extractNatalFacts(natal) {
  const facts = [];

  if (natal.planets?.sun?.sign) {
    facts.push(`太陽星座は ${natal.planets.sun.sign}`);
  }
  if (natal.planets?.moon?.sign) {
    facts.push(`月星座は ${natal.planets.moon.sign}`);
  }
  if (natal.planets?.sun?.house) {
    facts.push(`太陽は ${natal.planets.sun.house} ハウス`);
  }
  if (natal.elements) {
    const topElement = Object.entries(natal.elements).sort((a, b) => b[1] - a[1])[0];
    if (topElement) {
      facts.push(`元素バランスでは ${topElement[0]} が優勢`);
    }
  }
  if (natal.modalities) {
    const topMode = Object.entries(natal.modalities).sort((a, b) => b[1] - a[1])[0];
    if (topMode) {
      facts.push(`活動区分では ${topMode[0]} が優勢`);
    }
  }

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
      if (parts.length > 0) {
        facts.push(`直近で強いトランジット: ${parts.join(" ")}`);
      }
    }
  }

  if (transits.transit_date) {
    facts.push(`判定対象日は ${transits.transit_date}`);
  }

  return facts;
}

function buildAdvice(natal, transits) {
  const natalFacts = extractNatalFacts(natal);
  const transitFacts = extractTransitFacts(transits);
  const symbolicNotes = [
    natal.reading_note,
    natal.notes?.personality,
    natal.notes?.career,
    natal.notes?.love
  ].filter(Boolean);

  const factualSummary = [...natalFacts, ...transitFacts].slice(0, 6);

  const adviceLines = [];
  adviceLines.push("直近の行動アドバイス");

  if (transitFacts.length > 0) {
    adviceLines.push("今は動き方を小さく具体化するのが良いタイミングです。");
  } else {
    adviceLines.push("まずは今日中に1つだけ明確な行動を決めて、実行まで進めるのが適しています。");
  }

  if (natal.elements?.fire >= 4) {
    adviceLines.push("着手を先延ばしせず、短時間で最初の一歩を切る行動が合いやすいです。");
  } else if (natal.elements?.earth >= 4) {
    adviceLines.push("抽象的に悩むより、手順を3つに分けて安定的に進める行動が向いています。");
  } else if (natal.elements?.air >= 4) {
    adviceLines.push("一人で抱え込まず、言語化して相談や共有に出す行動が効果的です。");
  } else if (natal.elements?.water >= 4) {
    adviceLines.push("無理に拡大せず、違和感のある予定を整理して感情の負荷を軽くする行動が有効です。");
  }

  if (symbolicNotes.length > 0) {
    adviceLines.push(`APIメモ: ${symbolicNotes[0]}`);
  }

  return {
    message: adviceLines.join("\n"),
    facts: factualSummary
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "timeql-advice-bot",
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

  if (req.method === "POST" && url.pathname === "/api/advice") {
    try {
      const retryAfterSeconds = enforceRateLimit(req);
      if (retryAfterSeconds !== null) {
        res.writeHead(429, {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(retryAfterSeconds),
          "X-Content-Type-Options": "nosniff"
        });
        res.end(JSON.stringify({ error: "アクセスが集中しています。少し待って再試行してください。" }));
        return;
      }

      const body = await parseJsonBody(req);
      const { birthDate, birthTime, location = "Tokyo", name = "User" } = body;

      const validationError = validateInput(birthDate, birthTime);
      if (validationError) {
        sendJson(res, 400, { error: validationError });
        return;
      }

      const datetime = toIsoDatetime(birthDate, birthTime);
      const natalPayload = { name, datetime, location };
      const transitPayload = {
        name,
        datetime,
        location,
        transit_date: new Date().toISOString().slice(0, 10)
      };

      const [natal, transits] = await Promise.all([
        callTimeql("/api/v1/natal_chart", natalPayload),
        callTimeql("/api/v1/transits", transitPayload)
      ]);

      const advice = buildAdvice(natal, transits);

      sendJson(res, 200, {
        input: { birthDate, birthTime, location, datetime },
        advice
      });
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Unexpected server error" });
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
