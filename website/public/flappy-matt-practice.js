(() => {
  "use strict";

  const engine = window.FlappyMattEngine;
  const canvas = document.querySelector("#practice-canvas");
  const startButton = document.querySelector("#practice-start");
  const scoreNode = document.querySelector("#practice-score");
  const bestNode = document.querySelector("#practice-best");
  const statusNode = document.querySelector("#practice-status");
  if (!engine || !canvas || !startButton) return;

  const context = canvas.getContext("2d");
  const storageKey = "flappyMattStandalonePracticeBest";
  let runtime = null;
  let running = false;
  let lastFrameAt = 0;
  let animationFrame = null;
  let best = Number(localStorage.getItem(storageKey) || 0);
  bestNode.textContent = best.toLocaleString();

  function begin() {
    if (running) return;
    runtime = engine.createRuntime((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
    running = true;
    lastFrameAt = performance.now();
    scoreNode.textContent = "0";
    startButton.textContent = "PRACTICE IN PROGRESS";
    startButton.disabled = true;
    statusNode.textContent = "Tap, click, or press Space to fly. Practice flights never charge MATT.";
    flap();
    cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(frame);
  }

  function frame(now) {
    if (!running || !runtime) return;
    const delta = Math.min(80, Math.max(0, now - lastFrameAt));
    lastFrameAt = now;
    const snapshot = runtime.advance(delta);
    draw(snapshot);
    scoreNode.textContent = snapshot.score.toLocaleString();
    if (!snapshot.alive) {
      running = false;
      cancelAnimationFrame(animationFrame);
      best = Math.max(best, snapshot.score);
      localStorage.setItem(storageKey, String(best));
      bestNode.textContent = best.toLocaleString();
      startButton.textContent = "PRACTICE AGAIN";
      startButton.disabled = false;
      statusNode.textContent = `Practice complete. Score ${snapshot.score}. No MATT was charged.`;
      return;
    }
    animationFrame = requestAnimationFrame(frame);
  }

  function flap() {
    if (!running || !runtime) return;
    runtime.flap();
  }

  function handleInput(event) {
    if (!running) return;
    if (event.type === "keydown" && !["Space", "ArrowUp"].includes(event.code)) return;
    event.preventDefault();
    flap();
  }

  function draw(snapshot) {
    const width = canvas.width;
    const height = canvas.height;
    const floorY = height - engine.CONFIG.floorHeight;
    const sky = context.createLinearGradient(0, 0, 0, floorY);
    sky.addColorStop(0, "#5fd7ff");
    sky.addColorStop(1, "#c7f3ff");
    context.fillStyle = sky;
    context.fillRect(0, 0, width, height);

    context.fillStyle = "rgba(255,255,255,.55)";
    for (let index = 0; index < 6; index += 1) {
      const x = (index * 93 - snapshot.timeMs * 0.012) % (width + 120) - 50;
      const y = 70 + (index % 3) * 82;
      context.beginPath();
      context.ellipse(x, y, 32, 13, 0, 0, Math.PI * 2);
      context.ellipse(x + 26, y + 2, 24, 10, 0, 0, Math.PI * 2);
      context.fill();
    }

    for (const pipe of snapshot.pipes) drawPipe(pipe.x, pipe.gapCenter);
    context.fillStyle = "#e7b735";
    context.fillRect(0, floorY, width, engine.CONFIG.floorHeight);
    context.fillStyle = "#7ccb4e";
    context.fillRect(0, floorY, width, 10);
    drawBird(engine.CONFIG.birdX, snapshot.birdY, snapshot.velocityY);
  }

  function drawPipe(x, center) {
    const gapTop = center - engine.CONFIG.pipeGap / 2;
    const gapBottom = center + engine.CONFIG.pipeGap / 2;
    const width = engine.CONFIG.pipeWidth;
    context.fillStyle = "#32b96d";
    context.fillRect(x, 0, width, gapTop);
    context.fillRect(x, gapBottom, width, canvas.height - gapBottom - engine.CONFIG.floorHeight);
    context.fillStyle = "#48e38b";
    context.fillRect(x + 7, 0, 10, gapTop);
    context.fillRect(x + 7, gapBottom, 10, canvas.height - gapBottom - engine.CONFIG.floorHeight);
    context.fillStyle = "#16874b";
    context.fillRect(x + width - 9, 0, 9, gapTop);
    context.fillRect(x + width - 9, gapBottom, 9, canvas.height - gapBottom - engine.CONFIG.floorHeight);
  }

  function drawBird(x, y, velocity) {
    context.save();
    context.translate(x, y);
    context.rotate(Math.max(-0.45, Math.min(0.65, velocity / 800)));
    context.fillStyle = "#ffc93d";
    context.beginPath();
    context.arc(0, 0, 19, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#fff";
    context.beginPath();
    context.arc(7, -6, 7, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#08111b";
    context.beginPath();
    context.arc(9, -6, 3, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#ff7b3d";
    context.beginPath();
    context.moveTo(16, 1);
    context.lineTo(31, 6);
    context.lineTo(16, 10);
    context.closePath();
    context.fill();
    context.fillStyle = "#0b1624";
    context.font = "1000 17px system-ui";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("M", -4, 3);
    context.restore();
  }

  const idle = engine.createRuntime(424242);
  idle.flap();
  draw(idle.snapshot());

  startButton.addEventListener("click", begin);
  canvas.addEventListener("pointerdown", handleInput);
  window.addEventListener("keydown", handleInput, { passive: false });
})();
