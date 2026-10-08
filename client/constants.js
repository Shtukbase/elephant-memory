/**
 * Names the browser half agrees with the server half on. The build writes the
 * two `@…@` values from lib/identity.js and package.json, so the name of the
 * package is spelled in no source file of this folder.
 */

/** The module id the harness loads this bundle under, and the key of the History tab's body. */
const PACKAGE_ID = '@PACKAGE_NAME@';
/** The text a memory's checkpoint carries as its compaction summary (lib/step-one.js). */
const NOTE_PREFIX = '@NOTE_PREFIX@';
/** The History tab's kind in the right sidebar. */
const TAB_KIND = 'memory-history';
/** The endpoint prefix of the server's page reads (lib/browser-routes.js). */
const UI_PREFIX = 'endless-ui.';
/** The memory's own tools, whose calls read as a look-back. */
const LOOK_BACK_TOOLS = ['zoom', 'date', 'recall_search'];
/** The harness's keyed seats this half draws into. */
const TOOL_SEAT = 'tool.call.toolview';
const CHAT_NODE_SEAT = 'conversation.chat.node';
/** The preset a chat runs when its header names none (lib/key.js, PRESET_ID). */
const DEFAULT_AGENT = 'endless';
/** How many turns one History page asks for. */
const PAGE_TURNS = 30;
