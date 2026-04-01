const modeTabs = Array.from(document.querySelectorAll(".mode-tab"));
const modeForms = Array.from(document.querySelectorAll(".mode-form"));
const dailyForm = document.getElementById("daily-form");
const compatibilityForm = document.getElementById("compatibility-form");

function setMode(mode) {
  modeTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.mode === mode));
  modeForms.forEach((form) => form.classList.toggle("active", form.id === `${mode}-form`));
}

function openResultPage(mode, payload) {
  sessionStorage.setItem("read-life-mode", mode);
  sessionStorage.setItem("read-life-payload", JSON.stringify(payload));
  window.location.href = `/result?mode=${encodeURIComponent(mode)}`;
}

modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => setMode(tab.dataset.mode));
});

dailyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(dailyForm);
  const payload = Object.fromEntries(data.entries());
  openResultPage("daily", payload);
});

compatibilityForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(compatibilityForm);
  const payload = Object.fromEntries(data.entries());
  openResultPage("compatibility", payload);
});
