const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildHtml } = require('../modules/ui-v2');
const { enhanceHtml } = require('../modules/ui-v2-fixes');

function model(content = 'first line\nsecond <line>') {
  return {
    sms: { messages: [{ id: '7', phone: '+123', date: 'now', content }] },
    errors: {}, network: {}, battery: {}, traffic: {}, cellularDiagnostics: {}
  };
}

test('initial and refreshed SMS markup exposes an accessible expansion control', () => {
  const html = buildHtml(model());
  assert.match(html, /class="sms-row"[^>]*aria-expanded="false"/);
  assert.match(html, /class="row-menu" type="button"[^>]*aria-expanded="false" aria-label="Expand message"/);
  assert.match(html, /function applySms[\s\S]*class="sms-row"[\s\S]*aria-expanded="false"/);
  assert.match(html, /function applySms[\s\S]*class="row-menu" type="button"[\s\S]*aria-label="Expand message"/);
  assert.match(html, /first line\nsecond &lt;line&gt;/);
});

test('enhancement expands rows inline, safely preserves full text, and toggles closed', () => {
  const html = enhanceHtml(buildHtml(model()), model());
  assert.doesNotMatch(html, /sms-detail-sheet/);
  assert.match(html, /full\.textContent=row\.dataset\.text/);
  assert.match(html, /detail\.append\(full,actions\)/);
  assert.match(html, /classList\.toggle\('sms-expanded',expanded\)/);
  assert.match(html, /const expanded=!row\.classList\.contains\('sms-expanded'\)/);
  assert.match(html, /setMessageExpanded\(row,expanded\)/);
  assert.match(html, /\.sms-full-text\{white-space:pre-wrap;overflow-wrap:anywhere/);
  assert.match(html, /\.sms-expanded \.sms-main p\{display:none\}/);
  assert.doesNotMatch(html, /\.sms-full-text\{[^}]*display:none/);
  assert.match(html, /\.sms-expanded \.row-menu\{transform:rotate\(90deg\)\}/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)\{\.row-menu\{transition:none\}\}/);
});

test('inline Copy, Share, and Delete retain existing command dispatch', () => {
  const html = enhanceHtml(buildHtml(model()), model());
  assert.match(html, /\[\['copy','Copy'\],\['share','Share'\],\['delete','Delete'\]\]/);
  assert.match(html, /window\.zmiSmsAction\)window\.zmiSmsAction\(row,action\.dataset\.smsAction\)/);
  assert.match(html, /command\('copySms',\{text\}\)/);
  assert.match(html, /command\('shareSms',\{text\}\)/);
  assert.match(html, /command\('deleteSms',\{id,confirmed:true\}\)/);
  assert.match(html, /document\.addEventListener\('click',[\s\S]*},true\)/);

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 2);
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script));
});
