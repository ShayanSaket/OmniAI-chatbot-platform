// Minimal robots.txt support (RFC 9309 subset): groups by user-agent, Allow/Disallow with
// longest-match precedence, "*" wildcards and "$" anchors. Pure.

interface Rule {
  allow: boolean;
  pattern: string;
}

const AGENT = 'omniai-knowledgebot';

function toRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export function parseRobots(text: string): { rules: Rule[] } {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'disallow' && value) current.rules.push({ allow: false, pattern: value });
    if (key === 'allow' && value) current.rules.push({ allow: true, pattern: value });
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && AGENT.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return { rules: chosen.flatMap((g) => g.rules) };
}

/** True when the path (with query) may be fetched. */
export function isAllowed(robots: { rules: Rule[] }, pathWithQuery: string): boolean {
  let best: Rule | null = null;
  for (const rule of robots.rules) {
    if (!toRegex(rule.pattern).test(pathWithQuery)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}
