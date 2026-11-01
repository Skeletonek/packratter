function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function errorPage(status: number, code: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status} — Packratter</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f8f9fa; color: #212529; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  .card { background: #fff; border: 1px solid #dee2e6; border-radius: .5rem; padding: 2rem 2.5rem; max-width: 28rem; text-align: center; box-shadow: 0 .125rem .25rem rgba(0, 0, 0, .075); }
  h1 { font-size: 3rem; margin: 0 0 .25rem; }
  code { color: #6c757d; }
  a { color: #0d6efd; text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <h1>${status}</h1>
  <p><code>${escapeHtml(code)}</code></p>
  <p>${escapeHtml(message)}</p>
  <p><a href="/app/">Back to Packratter</a></p>
</div>
</body>
</html>`;
}
