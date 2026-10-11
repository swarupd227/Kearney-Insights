'use strict';
// Slide export: one 16:9 PowerPoint slide per answer (question, finding, chart image, supporting table, lineage footer).
const express = require('express');
const PptxGenJS = require('pptxgenjs');
const config = require('../config');
const personas = require('../personas');
const { fmt } = require('../agents/util');

const router = express.Router();
const C = { ink: '1B1F2A', muted: '5A6172', accent: '6B55E6', line: 'D9DCE6', bg: 'FFFFFF', panel: 'F5F6FA' };

function cellText(v, format) {
  if (v === null || v === undefined) return '–';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : '';
  if (format === 'pts') return (v > 0 ? '+' : '') + (v * 100).toFixed(1) + ' pts';
  if (format) return fmt(v, format);
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
  return String(v).slice(0, 60);
}

router.post('/slide', async (req, res) => {
  try {
    const { question, headline, image, table, lineage, persona, agents, model } = req.body || {};
    const p = personas.byId[persona] || personas.byId.mp;
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
    pptx.author = 'Astra Insights for Kearney'; pptx.company = 'Artizent'; pptx.title = question || 'Astra Insights';
    const s = pptx.addSlide();
    s.background = { color: C.bg };
    // header band
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.12, fill: { color: C.accent }, line: { color: C.accent } });
    s.addText('Astra Insights for Kearney', { x: 0.5, y: 0.25, w: 6, h: 0.35, fontSize: 11, color: C.accent, bold: true, fontFace: 'Segoe UI' });
    s.addText(`${p.title} · ${config.demoToday}`, { x: 6.8, y: 0.25, w: 6.0, h: 0.35, fontSize: 10, color: C.muted, align: 'right', fontFace: 'Segoe UI' });
    // title = the question; subtitle = the finding
    s.addText(question || 'Insight', { x: 0.5, y: 0.65, w: 12.3, h: 0.7, fontSize: 24, bold: true, color: C.ink, fontFace: 'Segoe UI', fit: 'shrink' });
    s.addText(headline || '', { x: 0.5, y: 1.35, w: 12.3, h: 1.0, fontSize: 13, color: C.ink, fontFace: 'Segoe UI', valign: 'top', fit: 'shrink' });
    const hasTable = table && table.columns && table.rows && table.rows.length;
    const chartW = hasTable ? 7.4 : 12.3;
    if (image && /^data:image\/(png|jpeg);base64,/.test(image)) {
      s.addShape(pptx.ShapeType.rect, { x: 0.5, y: 2.45, w: chartW, h: 4.2, fill: { color: C.panel }, line: { color: C.line, width: 0.75 } });
      s.addImage({ data: image, x: 0.65, y: 2.6, w: chartW - 0.3, h: 3.9, sizing: { type: 'contain', w: chartW - 0.3, h: 3.9 } });
    } else if (!hasTable) {
      s.addText('No visual for this answer.', { x: 0.5, y: 2.6, w: 12.3, h: 0.5, fontSize: 12, color: C.muted, fontFace: 'Segoe UI' });
    }
    if (hasTable) {
      const cols = table.columns.slice(0, 6); const rows = table.rows.slice(0, 9);
      const head = cols.map(c => ({ text: c[1], options: { bold: true, color: C.muted, fill: { color: C.panel }, fontSize: 8.5, fontFace: 'Segoe UI', border: { type: 'solid', pt: 0.5, color: C.line } } }));
      const body = rows.map(r => cols.map(c => ({ text: cellText(r[c[0]], c[2]), options: { fontSize: 8.5, color: C.ink, fontFace: 'Segoe UI', align: c[2] ? 'right' : 'left', border: { type: 'solid', pt: 0.5, color: C.line } } })));
      const tx = image ? 0.5 + chartW + 0.2 : 0.5; const tw = image ? 12.8 - tx : 12.3;
      s.addText(table.title || 'Detail', { x: tx, y: 2.45, w: tw, h: 0.3, fontSize: 11, bold: true, color: C.ink, fontFace: 'Segoe UI' });
      s.addTable([head, ...body], { x: tx, y: 2.8, w: tw, colW: cols.map((c, i) => i === 0 ? tw * 0.34 : (tw * 0.66) / (cols.length - 1)), rowH: 0.28, autoPage: false });
    }
    // footer: lineage and agents
    const src = lineage ? `Source: ${lineage.source_system || 'firm systems'}${lineage.formula ? ' · ' + lineage.name + ' = ' + lineage.formula : ''}${lineage.model ? ' · Model: ' + lineage.model : ''}${lineage.period && lineage.period.label ? ' · ' + lineage.period.label : ''}` : '';
    const who = agents && agents.length ? 'Agents: ' + [...new Set(agents.map(a => a.agent))].join(' › ') : '';
    s.addShape(pptx.ShapeType.line, { x: 0.5, y: 6.8, w: 12.3, h: 0, line: { color: C.line, width: 0.75 } });
    s.addText([{ text: src, options: { breakLine: true } }, { text: who + (model ? ' · Narrative: ' + model : '') }], { x: 0.5, y: 6.85, w: 12.3, h: 0.55, fontSize: 8, color: C.muted, fontFace: 'Segoe UI', valign: 'top', fit: 'shrink' });
    const buf = await pptx.write({ outputType: 'nodebuffer' });
    const name = 'Astra_' + (question || 'insight').replace(/[^a-z0-9]+/gi, '_').slice(0, 60) + '.pptx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buf);
  } catch (e) { console.error('slide export', e); res.status(500).json({ error: e.message }); }
});
module.exports = router;
