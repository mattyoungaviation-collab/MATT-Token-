(() => {
  "use strict";

  const ACKNOWLEDGMENT_KEY = "matt-slots-risk-ack-v1";
  const gate = document.querySelector("#access-gate");
  const checkbox = document.querySelector("#access-gate-checkbox");
  const acceptButton = document.querySelector("#access-gate-accept");
  const returnButton = document.querySelector("#access-gate-return");
  const noticeButton = document.createElement("button");
  noticeButton.id = "access-notice-button";
  noticeButton.type = "button";
  noticeButton.textContent = "Risk & 18+ notice";
  const footer = document.querySelector("body > footer");
  footer?.insertBefore(noticeButton, footer.querySelector("span"));
  const gatedContent = [
    document.querySelector("body > header"),
    document.querySelector("body > main"),
    document.querySelector("body > footer"),
  ].filter(Boolean);
  let gameLoaded = false;
  let reviewing = false;

  function hasAcknowledged() {
    try {
      return window.localStorage.getItem(ACKNOWLEDGMENT_KEY) === "accepted";
    } catch {
      return false;
    }
  }

  function rememberAcknowledgment() {
    try {
      window.localStorage.setItem(ACKNOWLEDGMENT_KEY, "accepted");
    } catch {
      // Storage can be unavailable in strict privacy modes; this visit still proceeds.
    }
  }

  function setPageLocked(locked) {
    document.body.classList.toggle("slots-gated", locked);
    gatedContent.forEach(element => { element.inert = locked; });
  }

  function loadGame() {
    if (gameLoaded) return;
    gameLoaded = true;
    const script = document.createElement("script");
    script.src = "/slots.js?v=7";
    script.async = false;
    document.body.appendChild(script);
  }

  function closeGate() {
    gate.hidden = true;
    setPageLocked(false);
    reviewing = false;
    loadGame();
  }

  function showGate({ review = false } = {}) {
    reviewing = review;
    checkbox.checked = false;
    acceptButton.disabled = true;
    returnButton.hidden = !review;
    gate.hidden = false;
    setPageLocked(true);
    window.setTimeout(() => checkbox.focus(), 0);
  }

  checkbox.addEventListener("change", () => {
    acceptButton.disabled = !checkbox.checked;
  });

  acceptButton.addEventListener("click", () => {
    if (!checkbox.checked) return;
    rememberAcknowledgment();
    closeGate();
  });

  returnButton.addEventListener("click", () => {
    if (reviewing && hasAcknowledged()) closeGate();
  });

  noticeButton.addEventListener("click", () => showGate({ review: true }));

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && reviewing && hasAcknowledged()) closeGate();
  });

  if (hasAcknowledged()) {
    closeGate();
  } else {
    showGate();
  }
})();
