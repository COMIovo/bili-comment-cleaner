document.addEventListener("DOMContentLoaded", () => {
  const button = document.getElementById("openDashboard");
  if (!button) return;
  button.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    window.close();
  });
});
