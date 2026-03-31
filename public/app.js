const form = document.getElementById("advice-form");
const messages = document.getElementById("messages");
const template = document.getElementById("message-template");

function appendMessage(role, body, facts = []) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  node.querySelector(".message-role").textContent = role === "user" ? "Input" : "Advice";
  node.querySelector(".message-body").textContent = body;

  if (facts.length > 0) {
    const factBox = document.createElement("div");
    factBox.className = "facts";
    factBox.textContent = `参照した事実:\n- ${facts.join("\n- ")}`;
    node.appendChild(factBox);
  }

  messages.appendChild(node);
  node.scrollIntoView({ behavior: "smooth", block: "end" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const data = new FormData(form);
  const payload = Object.fromEntries(data.entries());

  appendMessage(
    "user",
    `生年月日: ${payload.birthDate}\n出生時刻: ${payload.birthTime}\n出生地: ${payload.location || "Tokyo"}`
  );

  appendMessage("bot", "TimeQL API に問い合わせています...");

  try {
    const response = await fetch("/api/advice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    messages.lastElementChild.remove();

    if (!response.ok) {
      appendMessage("bot", result.error || "取得に失敗しました。");
      return;
    }

    appendMessage("bot", result.advice.message, result.advice.facts);
  } catch (error) {
    messages.lastElementChild.remove();
    appendMessage("bot", error.message || "通信に失敗しました。");
  }
});
