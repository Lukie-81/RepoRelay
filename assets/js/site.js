(() => {
  const root = document.documentElement;
  const themeButton = document.querySelector("[data-theme-toggle]");
  const navButton = document.querySelector("[data-nav-toggle]");
  const nav = document.querySelector("[data-nav]");

  document.querySelectorAll('.site-header .nav-controls > a[href^="https://github.com/"]').forEach((link) => {
    link.setAttribute("aria-label", "GitHub");
  });

  try {
    const savedTheme = window.localStorage.getItem("reporelay-theme");
    if (savedTheme === "light" || savedTheme === "dark") root.dataset.theme = savedTheme;
  } catch (_) {
    // The CSS media preference remains the fallback when storage is unavailable.
  }

  if (themeButton) {
    themeButton.addEventListener("click", () => {
      const isDark = root.dataset.theme === "dark"
        || (!root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
      const nextTheme = isDark ? "light" : "dark";
      root.dataset.theme = nextTheme;
      try { window.localStorage.setItem("reporelay-theme", nextTheme); } catch (_) { /* no-op */ }
      themeButton.setAttribute("aria-pressed", String(nextTheme === "dark"));
    });
  }

  if (navButton && nav) {
    navButton.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      navButton.setAttribute("aria-expanded", String(open));
    });
    nav.addEventListener("click", (event) => {
      if (event.target instanceof HTMLAnchorElement) {
        nav.classList.remove("open");
        navButton.setAttribute("aria-expanded", "false");
      }
    });
  }

  document.querySelectorAll("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.getAttribute("data-copy-target"));
      if (!target) return;
      const text = target.textContent || "";
      try {
        await navigator.clipboard.writeText(text);
        const original = button.textContent;
        button.textContent = "Copied";
        window.setTimeout(() => { button.textContent = original; }, 1400);
      } catch (_) {
        button.textContent = "Select manually";
        window.setTimeout(() => { button.textContent = "Copy"; }, 1800);
      }
    });
  });
})();
