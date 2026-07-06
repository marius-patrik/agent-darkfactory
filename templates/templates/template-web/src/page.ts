export interface PageViewModel {
  title: string;
  message: string;
}

export function createPageViewModel(appName = "template-web"): PageViewModel {
  const title = appName.trim() || "template-web";

  return {
    title,
    message: `${title} is running.`
  };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderHtml(viewModel: PageViewModel): string {
  const title = escapeHtml(viewModel.title);
  const message = escapeHtml(viewModel.message);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
  </head>
  <body>
    <main id="app" data-message="${message}">${message}</main>
    <script type="module" src="/client.js"></script>
  </body>
</html>`;
}
