/**
 * THE HISTORY VIEW'S READINGS, as pure derivations: which day a turn falls on,
 * where the feed names a day or a chat, and which words a search lights. A
 * day is the reader's own calendar day; its words are written out rather than
 * left to the runner's locale.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The reader's calendar day of an instant, as `YYYY-MM-DD`; null for an unreadable one. @param {string} at */
function dayKey(at) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
}

/** "Today", "Yesterday", or "Monday 5 October", with the year only when it is not this one. @param {string} at @param {Date} now */
function dayWords(at, now) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return 'Earlier';
  const key = dayKey(at);
  if (key === dayKey(now.toISOString())) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === dayKey(yesterday.toISOString())) return 'Yesterday';
  const words = `${WEEKDAYS[when.getDay()]} ${when.getDate()} ${MONTHS[when.getMonth()]}`;
  return when.getFullYear() === now.getFullYear() ? words : `${words} ${when.getFullYear()}`;
}

/** The short form a Remembers row ends with: "Today", "Yesterday", "3 Oct", or "3 Oct 2025". @param {string} at @param {Date} now */
function shortDayWords(at, now) {
  const long = dayWords(at, now);
  if (long === 'Today' || long === 'Yesterday' || long === 'Earlier') return long;
  const when = new Date(at);
  const words = `${when.getDate()} ${MONTHS[when.getMonth()].slice(0, 3)}`;
  return when.getFullYear() === now.getFullYear() ? words : `${words} ${when.getFullYear()}`;
}

/** The time of day of an instant, `13:07`. @param {string} at */
function timeWords(at) {
  const when = new Date(at);
  return Number.isNaN(when.getTime()) ? '' : `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
}

/**
 * The feed, oldest first: a day's heading where the day changes, and a chat's
 * one-line label where the chat changes, again at the start of each day, so a
 * day read alone still says which chat it is in.
 * @param {{ at: string, sessionId: string, sessionTitle: string }[]} turns @param {Date} now
 * @returns {({ kind: 'day', key: string, words: string } | { kind: 'chat', key: string, title: string } | { kind: 'turn', key: string, turn: any })[]}
 */
function historyFeed(turns, now) {
  const ordered = [...turns].sort((left, right) => left.at.localeCompare(right.at));
  const items = [];
  let day = null;
  let chat = null;
  for (const turn of ordered) {
    const key = dayKey(turn.at) || 'earlier';
    if (key !== day) {
      items.push({ kind: 'day', key: `day:${key}`, words: dayWords(turn.at, now) });
      day = key;
      chat = null;
    }
    if (turn.sessionId !== chat) {
      items.push({ kind: 'chat', key: `chat:${turn.sessionId}:${turn.at}`, title: turn.sessionTitle });
      chat = turn.sessionId;
    }
    items.push({ kind: 'turn', key: `turn:${turn.sessionId}:${turn.at}`, turn });
  }
  return items;
}

/** @param {string} word */
function escapedWord(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The text cut where any of the query's words stands, case aside. @param {string} text @param {string} query @returns {{ text: string, lit: boolean }[]} */
function litParts(text, query) {
  const words = query.trim().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [{ text, lit: false }];
  const pattern = new RegExp(`(${words.map(escapedWord).join('|')})`, 'gi');
  return text
    .split(pattern)
    .filter((part) => part !== '')
    .map((part) => ({ text: part, lit: words.some((word) => word.toLowerCase() === part.toLowerCase()) }));
}

/** The base name of a folder path, for a heading; the whole text when it has none. @param {string} project */
function projectName(project) {
  const parts = project.split(/[\\/]+/).filter((part) => part !== '');
  return parts.length === 0 ? project : parts[parts.length - 1];
}
