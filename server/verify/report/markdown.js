/**
 * The markdown summary.
 *
 * Deliberately terse: this is what gets pasted into Linear or Slack, where a wall of evidence
 * is noise. It states the verdict, lists the problems worst-first, and stops. The HTML report
 * is where the request and response payloads live.
 */
import { sortFindings, summarise } from '../findings.js';

const MARK = { blocker: '🛑', major: '⚠️', minor: '·', info: 'ℹ️' };

export function renderMarkdown({ findings, target, startedAt }) {
  const sorted = sortFindings(findings);
  const summary = summarise(findings);

  const lines = [
    `**API verification — ${target}**`,
    '',
    summary.passed
      ? '✅ No blocking problems found.'
      : `Found ${summary.total} problem${summary.total === 1 ? '' : 's'}: ` +
        ['blocker', 'major', 'minor', 'info']
          .filter((s) => summary[s] > 0)
          .map((s) => `${summary[s]} ${s}`)
          .join(', '),
    '',
  ];

  for (const f of sorted) {
    lines.push(`${MARK[f.severity]} **${f.title}**`);
    lines.push(`   ${f.whatHappened}`);
    if (f.expected !== null && f.actual !== null) {
      lines.push(`   Expected \`${f.expected}\`, got \`${f.actual}\`.`);
    }
    lines.push('');
  }

  lines.push(`_Run ${new Date(startedAt).toLocaleString()} · full report with request and`);
  lines.push('response evidence available as HTML._');

  return lines.join('\n');
}
