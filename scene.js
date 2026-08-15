(() => {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia?.("(pointer: fine)").matches;
  if (reduced || !finePointer) return;

  const canvas = document.createElement("canvas");
  canvas.className = "scene-canvas";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  const context = canvas.getContext("2d", { alpha: true, desynchronized: true });
  if (!context) return;

  let width = 1;
  let height = 1;
  let dpr = 1;
  let frame = 0;
  let previous = performance.now();
  let nextAmbientRipple = previous + 900;
  const trail = [];
  const ripples = [];

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    width = Math.max(1, document.documentElement.clientWidth || window.innerWidth);
    height = Math.max(1, window.innerHeight);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function ripple(x, y, strength = 1) {
    if (ripples.length >= 12) ripples.shift();
    ripples.push({ x, y, radius: 2, life: 1, strength });
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("pointermove", (event) => {
    if (event.pointerType && event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    const last = trail[trail.length - 1];
    if (last && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 4) return;
    trail.push({ x: event.clientX, y: event.clientY, life: 1 });
    if (trail.length > 34) trail.shift();
    if (!last || Math.hypot(event.clientX - last.x, event.clientY - last.y) > 46) {
      ripple(event.clientX, event.clientY, 0.72);
    }
  }, { passive: true });
  window.addEventListener("pointerdown", (event) => {
    if (event.pointerType && event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    ripple(event.clientX, event.clientY, 1.25);
  }, { passive: true });

  function draw(now) {
    const delta = Math.min(48, now - previous);
    previous = now;
    context.clearRect(0, 0, width, height);
    context.save();
    context.globalCompositeOperation = "screen";

    if (now >= nextAmbientRipple) {
      ripple(Math.random() * width, height * (0.18 + Math.random() * 0.72), 0.34);
      nextAmbientRipple = now + 1400 + Math.random() * 1500;
    }

    for (let index = ripples.length - 1; index >= 0; index--) {
      const item = ripples[index];
      item.radius += delta * 0.065 * item.strength;
      item.life -= delta * 0.00056;
      if (item.life <= 0) {
        ripples.splice(index, 1);
        continue;
      }
      for (let ring = 0; ring < 3; ring++) {
        context.strokeStyle = `rgba(${ring === 1 ? "156,255,56" : "101,209,255"}, ${item.life * item.strength * (0.2 - ring * 0.045)})`;
        context.lineWidth = 1.2;
        context.beginPath();
        context.ellipse(item.x, item.y, item.radius + ring * 12, (item.radius + ring * 12) * 0.46, 0, 0, Math.PI * 2);
        context.stroke();
      }
    }

    for (let index = trail.length - 1; index >= 0; index--) {
      trail[index].life -= delta * 0.0027;
      if (trail[index].life <= 0) trail.splice(index, 1);
    }
    if (trail.length > 1) {
      context.lineCap = "round";
      for (let index = 1; index < trail.length; index++) {
        const from = trail[index - 1];
        const to = trail[index];
        context.strokeStyle = `rgba(101,209,255, ${Math.min(from.life, to.life) * 0.62})`;
        context.lineWidth = 1 + to.life * 5;
        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
      }
      const tip = trail[trail.length - 1];
      const glow = context.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, 32);
      glow.addColorStop(0, `rgba(156,255,56, ${tip.life * 0.7})`);
      glow.addColorStop(1, "rgba(156,255,56,0)");
      context.fillStyle = glow;
      context.fillRect(tip.x - 32, tip.y - 32, 64, 64);
    }

    context.restore();
    frame = requestAnimationFrame(draw);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      return;
    }
    if (!frame) {
      previous = performance.now();
      frame = requestAnimationFrame(draw);
    }
  });

  resize();
  frame = requestAnimationFrame(draw);
})();
