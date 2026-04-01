const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") || sessionStorage.getItem("read-life-mode");
const rawPayload = sessionStorage.getItem("read-life-payload");

const title = document.getElementById("result-title");
const lead = document.getElementById("result-lead");
const role = document.getElementById("result-role");
const body = document.getElementById("result-body");
const facts = document.getElementById("result-facts");

function setCopy(currentMode) {
  if (currentMode === "compatibility") {
    title.textContent = "二人の相性";
    lead.textContent = "関係の流れを落ち着いて読み取っています。";
    role.textContent = "Compatibility";
    return;
  }

  title.textContent = "今日の自分向け助言";
  lead.textContent = "今日の流れを落ち着いて読み取っています。";
  role.textContent = "Daily";
}

async function loadResult() {
  setCopy(mode);

  if (!mode || !rawPayload) {
    body.textContent = "入力情報が見つかりませんでした。入力画面からやり直してください。";
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    body.textContent = "入力情報を読み取れませんでした。入力画面からやり直してください。";
    return;
  }

  const endpoint = mode === "compatibility" ? "/api/compatibility" : "/api/daily-advice";

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (!response.ok) {
      body.textContent = result.error || "取得に失敗しました。";
      return;
    }

    body.textContent = result.advice.message;
    if (Array.isArray(result.advice.facts) && result.advice.facts.length > 0) {
      facts.hidden = false;
      facts.textContent = `読み取りの要点:\n- ${result.advice.facts.join("\n- ")}`;
    }
  } catch (error) {
    body.textContent = error.message || "通信に失敗しました。";
  }
}

loadResult();
