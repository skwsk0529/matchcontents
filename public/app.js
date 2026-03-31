const messages = document.getElementById("messages");
const template = document.getElementById("message-template");
const modeTabs = Array.from(document.querySelectorAll(".mode-tab"));
const modeForms = Array.from(document.querySelectorAll(".mode-form"));
const dailyForm = document.getElementById("daily-form");
const compatibilityForm = document.getElementById("compatibility-form");

function appendMessage(role, body, facts = [], label = null) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  node.querySelector(".message-role").textContent = label || (role === "user" ? "Input" : "Advice");
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

function setMode(mode) {
  modeTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === mode));
  modeForms.forEach((form) => form.classList.toggle("active", form.id === `${mode}-form`));
}

modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => setMode(tab.dataset.mode));
});

async function submitForm({ form, endpoint, inputSummary, roleLabel }) {
  const data = new FormData(form);
  const payload = Object.fromEntries(data.entries());

  appendMessage("user", inputSummary(payload), [], roleLabel);
  appendMessage("bot", "TimeQL API に問い合わせています...", [], roleLabel);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    messages.lastElementChild.remove();

    if (!response.ok) {
      appendMessage("bot", result.error || "取得に失敗しました。", [], roleLabel);
      return;
    }

    appendMessage("bot", result.advice.message, result.advice.facts, roleLabel);
  } catch (error) {
    messages.lastElementChild.remove();
    appendMessage("bot", error.message || "通信に失敗しました。", [], roleLabel);
  }
}

dailyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitForm({
    form: dailyForm,
    endpoint: "/api/daily-advice",
    roleLabel: "Daily",
    inputSummary: (payload) =>
      `名前: ${payload.name}\n生年月日: ${payload.birthDate}\n出生時刻: ${payload.birthTime}\n出生地: ${payload.location}`
  });
});

compatibilityForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitForm({
    form: compatibilityForm,
    endpoint: "/api/compatibility",
    roleLabel: "Compatibility",
    inputSummary: (payload) =>
      `1人目: ${payload.personAName} / ${payload.personABirthDate} / ${payload.personABirthTime} / ${payload.personALocation}\n2人目: ${payload.personBName} / ${payload.personBBirthDate} / ${payload.personBBirthTime} / ${payload.personBLocation}`
  });
});
