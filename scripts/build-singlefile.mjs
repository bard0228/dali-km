import fs from 'node:fs';
import path from 'node:path';

const distDir = path.resolve('dist');
const outPath = path.resolve('_preview.html');

let html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');

// Inline CSS
html = html.replace(
  /<link\s+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g,
  (_m, href) => {
    const file = path.join(distDir, href.replace(/^\.\//, ''));
    const css = fs.readFileSync(file, 'utf8');
    return `<style>\n${css}\n</style>`;
  }
);

// Inline JS
html = html.replace(
  /<script\s+type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g,
  (_m, src) => {
    const file = path.join(distDir, src.replace(/^\.\//, ''));
    const js = fs.readFileSync(file, 'utf8');
    // Escape </script> inside bundle if any
    const safeJs = js.replace(/<\/script>/gi, '<\\/script>');
    return `<script type="module">\n${safeJs}\n</script>`;
  }
);

// Inline icon.svg & remove manifest link in standalone preview to avoid 404
const iconPath = path.join(distDir, 'icon.svg');
if (fs.existsSync(iconPath)) {
  const svgB64 = fs.readFileSync(iconPath).toString('base64');
  html = html.replace(
    /href="\.\/icon\.svg"/g,
    `href="data:image/svg+xml;base64,${svgB64}"`
  );
}
html = html.replace(/<link\s+rel="manifest"[^>]*>\s*/g, '');

fs.writeFileSync(outPath, html, 'utf8');
console.log(`Built single-file preview: ${outPath} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
