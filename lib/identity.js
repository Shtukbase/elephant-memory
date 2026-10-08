// The package's name in code, in one place. `package.json` and the preset patch
// carry it too (JSON and YAML cannot import); `test/package.test.js` holds
// all three equal, so a rename is this line, `package.json`, the memory row of
// `presets/endless.patch.yml` and the prose of the documents.

/** The npm name, which is also the module id of the browser half. */
export const PACKAGE_NAME = 'dsh-elephant-memory';

/** What a person calls the product. */
export const DISPLAY_NAME = 'Elephant Memory';

/**
 * What the compaction summary of a memory's checkpoint starts with. The
 * browser half reads it to hide the harness's "Context compacted" row for a
 * checkpoint that is this memory's, and for no other (client/compaction.js).
 */
export const COMPACTION_NOTE_PREFIX = 'Endless memory:';
