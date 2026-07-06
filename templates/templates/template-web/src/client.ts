const app = document.querySelector<HTMLElement>("#app");

if (app) {
  const message = app.dataset.message ?? "template-web is running.";
  app.textContent = message;
  app.dataset.ready = "true";
}
