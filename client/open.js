/**
 * WHERE THE HISTORY VIEW LIVES, AND HOW A PERSON OPENS IT.
 *
 * The harness's right sidebar is a docking column of tabs, and a tab type is
 * registered in two stages (`dsh-client-ui-sidebar-right`, "Extension seats"):
 * the type through `ctx.sidebarRightTabs.register`, whose `guide` entry is a
 * door on the sidebar's start page, and its body and chip title through the
 * keyed slots `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title`.
 * The harness's own Files and Terminal tabs are registered the same way.
 * A slash command, `/history`, opens the tab from the composer
 * (`ctx.commandUi.register`, an action contribution like the composer's File).
 */

const HISTORY_WORDS = {
  title: 'History',
  description: 'Everything this agent remembers, by day',
};

/** @param {any} ctx the harness's client root context */
function installHistoryTab(ctx) {
  ctx.inject(['sidebarRightTabs'], (scope) => {
    scope.effect(() => scope.sidebarRightTabs.register({
      id: PACKAGE_ID,
      kind: TAB_KIND,
      title: () => HISTORY_WORDS.title,
      keepMounted: true,
      guide: [{ id: 'history', order: 60, title: () => HISTORY_WORDS.title, description: () => HISTORY_WORDS.description, icon: primitives.IconClockOutlineRegular }],
    }), `${PACKAGE_ID}: history tab type`);
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () =>
      scope.slots.register({ name: 'sidebar.right.pane.tab', key: PACKAGE_ID }, HistoryBody)), `${PACKAGE_ID}: history tab body`);
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () =>
      scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: PACKAGE_ID }, HistoryTitle)), `${PACKAGE_ID}: history tab title`);
  });
}

/** @param {any} ctx the harness's client root context */
function installHistoryCommand(ctx) {
  ctx.inject(['commandUi', 'sidebarRight'], (scope) => {
    try {
      scope.effect(() => scope.commandUi.register({
        name: 'history',
        label: () => HISTORY_WORDS.title,
        description: () => HISTORY_WORDS.description,
        icon: primitives.IconClockOutlineRegular,
        available: () => true,
        ui: { kind: 'action', run: () => { scope.sidebarRight.openTab(TAB_KIND); } },
      }), `${PACKAGE_ID}: history command`);
    } catch (error) {
      // A command of this name is already the harness's, or another plugin's: the tab stays reachable from the sidebar.
      console.warn(`[ENDLESS_CLIENT] /history is taken: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
