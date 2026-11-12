import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./web/index.html', import.meta.url), 'utf8');
const head = html.slice(0, html.indexOf('</head>'));
function meta(attribute, name) {
  const match = head.match(new RegExp(`<meta ${attribute}="${name}" content="([^"]*)">`));
  assert.ok(match, `missing ${attribute} ${name}`);
  return match[1];
}

test('static audit metadata uses a primary canonical and the approved project image', () => {
  const canonical = 'https://studio-check.wlkr.si/';
  const image = 'https://wlkr.si/social/studio-check.png';
  const description = "Audit a GitHub organisation's public repositories and compare saved audit reports locally.";
  assert.match(head, /<title>studio-check — WLKR\.SI<\/title>/);
  assert.ok(head.includes(`<link rel="canonical" href="${canonical}">`));
  assert.equal(meta('name', 'description'), description);
  assert.equal(meta('property', 'og:type'), 'website');
  assert.equal(meta('property', 'og:site_name'), 'WLKR.SI');
  assert.equal(meta('property', 'og:title'), 'studio-check — WLKR.SI');
  assert.equal(meta('property', 'og:description'), description);
  assert.equal(meta('property', 'og:url'), canonical);
  assert.equal(meta('property', 'og:image'), image);
  assert.equal(meta('property', 'og:image:type'), 'image/png');
  assert.equal(meta('property', 'og:image:width'), '1200');
  assert.equal(meta('property', 'og:image:height'), '630');
  assert.equal(meta('property', 'og:image:alt'), 'studio-check — Audit the public entry points of a GitHub organisation, without credentials.');
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.equal(meta('name', 'twitter:title'), 'studio-check — WLKR.SI');
  assert.equal(meta('name', 'twitter:description'), description);
  assert.equal(meta('name', 'twitter:image'), image);
  assert.equal(meta('name', 'twitter:image:alt'), 'studio-check — Audit the public entry points of a GitHub organisation, without credentials.');
  assert.doesNotMatch(head, /[?&](?:org|archived)=/);
});
