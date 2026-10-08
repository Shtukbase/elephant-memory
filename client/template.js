/**
 * The browser half of the memory plugin, in the harness's own client-bundle
 * form: a classic script that only REGISTERS a factory, whose body runs when
 * the module system materializes it. scripts/build-client.js composes the
 * fragments named below into lib/client.js, the one file the harness serves at
 * /plugins/<package>/client.js. The generated file is never edited by hand;
 * `node scripts/build-client.js --check` (and test/package.test.js) refuses a
 * stale one.
 *
 * What it adds, each through a seat the harness offers to a client plugin and
 * none by changing harness code:
 *
 * 1. a look-back row for the memory's tools (client/lookback-row.js);
 * 2. no "Context compacted" row for a memory's checkpoint (client/compaction.js);
 * 3. a History tab in the right sidebar and the /history command
 *    (client/history-view.js, client/open.js).
 */
window.__ModuleLoader__.load({
  id: '@PACKAGE_NAME@',
  // The parameter the loader hands in is the harness's synchronous resolver
  // for the modules every client bundle shares.
  factory: (resolve) => {
    const react = resolve('react');
    const primitives = resolve('@deepseek-ai/dsh-client-ui-primitives');
    const jsxRuntime = resolve('react/jsx-runtime');
    const h = react.createElement;
    /* @memory-constants */
    /* @memory-words */
    /* @memory-days */
    /* @memory-api */
    /* @memory-styles */
    /* @memory-lookback-row */
    /* @memory-compaction */
    /* @memory-history-parts */
    /* @memory-history-view */
    /* @memory-open */

    return {
      // Every other service is asked for where it is used, so a harness that
      // lacks one loses that one feature and nothing else.
      inject: ['slots'],
      apply(ctx) {
        readConnection = () => ctx.get('connection');
        installStyles();
        installLookBackRows(ctx);
        installQuietCompaction(ctx);
        installHistoryTab(ctx);
        installHistoryCommand(ctx);
      },
    };
  },
});
