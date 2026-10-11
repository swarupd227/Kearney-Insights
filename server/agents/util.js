'use strict';
// Shared formatting for narratives. Every number in a narrative is inserted from a result, never typed.
function money(v, opts = {}) {
  if (v === null || v === undefined || isNaN(v)) return 'n/a';
  const abs = Math.abs(v); const sign = v < 0 ? '−' : '';
  if (abs >= 1e9) return `${sign}US$${(abs / 1e9).toFixed(opts.digits ?? 2)} billion`;
  if (abs >= 1e6) return `${sign}US$${(abs / 1e6).toFixed(opts.digits ?? 1)} million`;
  if (abs >= 1e3) return `${sign}US$${(abs / 1e3).toFixed(0)} thousand`;
  if (abs < 10) return `${sign}US$${abs.toFixed(2)}`;
  return `${sign}US$${abs.toFixed(0)}`;
}
function pct(v, digits = 1) { if (v === null || v === undefined || isNaN(v)) return 'n/a'; return (v * 100).toFixed(digits) + '%'; }
function pts(v, digits = 1) { if (v === null || v === undefined || isNaN(v)) return 'n/a'; const s = (v * 100).toFixed(digits); return (v > 0 ? '+' : '') + s + ' points'; }
function num(v, digits = 0) { if (v === null || v === undefined || isNaN(v)) return 'n/a'; return Number(v).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }); }
function fmt(v, format, digits) {
  switch (format) {
    case 'money': return money(v, { digits });
    case 'pct': return pct(v, digits ?? 1);
    case 'days': return num(v, 0) + ' days';
    case 'months': return num(v, 0) + ' months';
    case 'hours': return num(v, 1) + ' hours';
    case 'ratio': return num(v, 1) + 'x';
    case 'score': return num(v, 1);
    default: return num(v, digits ?? 0);
  }
}
function direction(delta, higherIsBetter = true) { if (delta === null || delta === undefined || isNaN(delta)) return 'unchanged'; if (Math.abs(delta) < 1e-9) return 'flat'; const up = delta > 0; return up ? 'up' : 'down'; }
function tone(delta, higherIsBetter = true) { if (delta === null || isNaN(delta) || Math.abs(delta) < 1e-9) return 'neutral'; return (delta > 0) === higherIsBetter ? 'good' : 'bad'; }
function listWords(items) { if (!items.length) return ''; if (items.length === 1) return items[0]; return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]; }
function monthLabel(s) { const d = new Date(s + 'T00:00:00Z'); return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
function dateLabel(s) { if (!s) return 'n/a'; const d = new Date(s + (s.length === 10 ? 'T00:00:00Z' : '')); return d.getUTCDate() + ' ' + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
// Small counts as words at the start of a sentence ("Two engagements", "No actions"); larger counts stay numeric.
function countWord(n, singular, plural, { cap = true, zero = 'No' } = {}) { const w = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']; let s = n === 0 ? zero.toLowerCase() : n < 10 ? w[n] : String(n); if (cap) s = s.charAt(0).toUpperCase() + s.slice(1); return s + ' ' + (n === 1 ? singular : (plural || singular + 's')); }
module.exports = { money, pct, pts, num, fmt, direction, tone, listWords, monthLabel, dateLabel, countWord };
